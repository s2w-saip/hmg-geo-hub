// worker — 슬롯이 빌 때만 큐에서 티켓을 당긴다(pull). 1초 poll, 리스 TTL + 하트비트,
// 아웃박스 콜백, 리퍼(리더 election). 측정 lane `worker/main.py` 의 검증된 단순함을 그대로 가져온다.
//
// ⚠️ **doorbell push 를 두지 않는다.** 측정 워커도 1초 poll 이고(`worker/main.py:492`·`:535`)
//    그 단순함이 라이브에서 검증됐다. 코어→lane 방향 doorbell 은 lane 이 아니라 코어 아웃박스
//    submitter 의 관심사다(스펙 §7.1).
//
// ── 이 루프가 지켜야 하는 것
//
//   G1 내구성   — 트리거가 DB(`analysis_tickets`)에 있다. 프로세스가 죽어도 사라지지 않는다.
//                 09-08 실측: 인메모리 풀은 배포 직전 queued 645 를 통째로 잃었다.
//   G2 독립성   — 측정 태스크 수·Browserless 세마포어와 무관하다. 불변식 10 × 8 ≤ 80 무변경.
//   G3 DB 경계  — **코어 DB 에 접속하지 않는다.** 이 파일에 코어 DSN 이 등장하면 안 된다
//                 (`tests/boundary.test.ts` 가 리포 전수로 감시한다).
//   G6 콜 상한  — in-flight LLM 콜에 전역 상한이 있고 정본이 lane 안에 있다.
import { createPostgresDb, type Db } from "../app/db.ts";
import { errorFields, log } from "../app/log.ts";
import { migrate } from "../app/migrate.ts";
import { settings } from "../app/settings.ts";
import * as T from "../app/tickets.ts";
import {
  AnalysisReplySchema,
  AnalysisTicketRequestSchema,
  toReplyUsage,
  type AnalysisCallUsage,
  type AnalysisReply,
} from "../contracts/index.ts";
import { CallbackPump } from "./callbacks.ts";
import { cacheBustReplyMark } from "./cache-bust.ts";
import { Semaphore, CapacityTimeoutError, computeWorkerCallSlots } from "./concurrency.ts";
import { ContextCache, trimContextTable } from "./context-cache.ts";
import { AnalysisContractError, AnalysisDeferrable, type AnalysisEngine, type AnalysisEngineOutput, type LlmInvoker } from "./engine.ts";
import { configureHttpKeepAlive } from "./http-agent.ts";
import { checkTokenWiring, tokenWiringSummary } from "./internal-token.ts";
import { createLaneInvokerFactory } from "./invoker.ts";
import { assertTaskModelParity } from "./llm-pools.ts";
import { resolveEngine } from "./registry.ts";

const POLL_INTERVAL_MS = 1_000;

let stopping = false;
/** SIGTERM 이후: **새 리스를 멈추고 보유분만 끝낸 뒤** 죽는다(측정 lane 의 graceful drain 과 같은 형태). */
let drainDeadline: number | null = null;
const DRAIN_GRACE_MS = Number(process.env.ANALYSIS_DRAIN_GRACE_SECONDS ?? 600) * 1000;

const inflight = new Map<string, { token: string; abort: AbortController }>();

export interface WorkerDeps {
  db: Db;
  engine: AnalysisEngine;
  llmSemaphore: Semaphore;
  contextCache: ContextCache;
  /**
   * 라이브에서는 `createLaneInvokerFactory`(공급자 풀 라우팅 + 콜 상한 + 타임아웃)다.
   * 스텁 엔진은 이것을 부르지 않는다.
   * ⚠️ **티켓마다 새로 부르는 것은 invoker 뿐이고 팩토리는 프로세스당 1개다** — 팩토리를
   *    티켓마다 만들면 `PoolHealth` 의 5분 창이 매번 비어 헬스 게이팅이 영영 발화하지 않는다.
   */
  makeInvoker: (ticketId: string) => LlmInvoker;
}

// ── 성공 위장 차단 (엔진 출력 후 게이트) ──────────────────────────────────────────
//
// 벤더 `llm.ts` 는 invoker 예외를 **삼켜서** `failed: true` 결과로 바꾼다
// (`llm.ts:316~334`·`:598~`·`:818~`). 그래서 invoker 가 통째로 죽어 있어도 — 미배선이든,
// 활성 풀 0 이든, 업스트림 전량 5xx 든 — 순수 코드는 멀쩡히 **빈 분석**을 돌려주고 티켓은
// `completed` 로 정산된다. 화면에는 "분석은 됐는데 멘션 0건" 으로 보인다. 이 lane 이 가장
// 경계하는 실패 모드이고(`registry.ts` 머리말), 실제로 3일 늦게 발견된 전례가 있다.
//
// ── 구분선: **그 태스크에 성공한 업스트림 콜이 하나라도 있었나**
//
//   · 모델이 깨진 JSON 을 최대 시도만큼 돌려줘 `failed` → 원장에 `outcome='completed'` 행이
//     남는다. 이건 콘텐츠 실패이고 **코어 인라인 경로도 그대로 persist 한다** → lane 도
//     completed. 여기서 갈라지면 "lane 경로와 인라인 경로의 차이는 직렬화뿐"이 거짓이 된다.
//   · invoker 미배선 · 풀 0 · 전량 5xx/타임아웃 → 그 태스크의 `completed` 행이 **0** 이다.
//     인프라 실패이므로 `deferred(transient)` — 재시도하면 풀린다. 실비는 이미 원장에 있다.
//
// ⚠️ "게이트 on 인데 콜 0" 을 그대로 조건으로 쓰지 않는 이유: 순수 코드는 extract 를
//    `qualityState === "valid_answer"` 일 때만 부르고(`pure/analyze-turn.ts:195~197`),
//    resolve 는 pending 이 없으면, semantics 는 멘션이 없으면 부르지 않는다. 그 정상 경로가
//    전부 "콜 0" 이라 조건으로 쓰면 빈 답변마다 deferred 가 쌓인다. `failed === true` 와
//    **함께** 봐야 인프라 실패만 걸린다.
// ⚠️ **export 인 이유**: `tests/semantics-shadow.test.ts` 가 이 목록의 *모양*을 단언한다 —
//    "섀도 축(`…_shadow_…`)은 어떤 항목에도 들어오지 않는다". 행동 단언만으로는 부족했다:
//    섀도를 `task: "semantics"` 로 끼워 넣은 변이가 (V0 의 성공한 semantics 콜이 있으면
//    `upstreamOk` 가 참이라) 행동 테스트를 통과했다. 목록 자체를 보게 해야 그 변이가 죽는다.
export const GATED_LLM_LAYERS = [
  { task: "extract", enabledKey: "llm_mention_enabled", failedKey: "llm_mention_failed" },
  { task: "resolve", enabledKey: "llm_pending_resolver_enabled", failedKey: "llm_pending_resolver_failed" },
  { task: "semantics", enabledKey: "llm_mention_semantics_enabled", failedKey: "llm_mention_semantics_failed" },
  // 감성 판별 V2 는 semantics 패스를 **대체**한다(V2 on 턴은 `llm_mention_semantics_failed` 가 항상
  // false). 여기 없으면 V2 의 업스트림 전멸이 regex_line 폴백 completed 로 조용히 묻힌다.
  // task 는 현행과 같은 `semantics` 원장 행이다(벤더 요청 task 가 mention_semantics).
  { task: "semantics", enabledKey: "llm_mention_semantics_v2_enabled", failedKey: "llm_mention_semantics_v2_failed" },
] as const;

/** 인프라 실패로 판정되면 사람이 읽을 사유를, 아니면 `null`. */
export function detectSilentLlmFailure(out: Pick<AnalysisEngineOutput, "turn" | "llmUsage">): string | null {
  const meta = (out.turn.extractionMetadata ?? {}) as Record<string, unknown>;
  for (const layer of GATED_LLM_LAYERS) {
    if (meta[layer.enabledKey] !== true || meta[layer.failedKey] !== true) continue;
    // ⚠️ `normalizeCallUsage` 를 쓰지 않는다 — 그쪽은 **모르는 outcome 을 `completed` 로**
    //    떨어뜨린다(적재 기본값). 여기서 그 관대함을 쓰면 outcome 이 빠진 행 하나가
    //    "성공한 콜" 로 읽혀 게이트가 통째로 무력화된다. 원문 그대로 본다.
    const upstreamOk = out.llmUsage.some((u) => u.task === layer.task && u.outcome === "completed");
    if (!upstreamOk) {
      return (
        `${layer.failedKey}=true 인데 ${layer.task} 태스크의 성공한 업스트림 콜이 0 이다 ` +
        `(원장 행 ${out.llmUsage.length}개) — 모델 응답 실패가 아니라 invoker/풀 실패다`
      );
    }
  }
  return null;
}

/**
 * 스탠스 패스의 실패 **관측**(WU6 F4). 판정이 아니라 계수다.
 *
 * ⚠️ **`GATED_LLM_LAYERS` 에 넣지 않는다.** 그 목록에 들어가면 `detectSilentLlmFailure` 가
 *    `deferred(transient)` 를 던져 **턴 전체가 재시도로 돌아간다** — FR6(스탠스 실패는 턴을
 *    실패시키지 않는다)의 정반대다. 스탠스는 부가 패스이고, 그것 하나 때문에 완주한 멘션·
 *    감성 분석을 다시 돌리는 것은 실비만 두 배로 쓰는 일이다.
 *
 * 그렇다고 조용히 두면 **켰는데 데이터가 안 쌓이는 상태**를 아무도 못 본다(WU6 의 task 매핑
 * 사본 결함이 정확히 그 모양이었다: 티켓 completed · 스탠스 0건 · 원장 0행). 그래서
 * **로그 한 줄 + 메트릭 필터**로만 표면화한다 — 목적지는 잔디가 아니라 **GitHub Issue** 다
 * (룰 alert-routing: "사람이 코드를 고쳐야 해소된다" = 코드 경로).
 *
 * 두 축을 따로 센다. 하나는 "게이트가 켜졌는데 패스가 실패했다"(콘텐츠·매칭 실패 포함),
 * 다른 하나는 "업스트림 콜 자체가 실패했다"(인프라). 둘이 갈리는 지점이 진단이다 —
 * `stanceFailed=1` 인데 `stanceCallsFailed=0` 이면 모델이 답은 했는데 파싱·매칭이 깨진 것이고,
 * 둘 다 >0 이면 공급자 쪽이다.
 */
export function stanceObservation(
  out: Pick<AnalysisEngineOutput, "turn" | "llmUsage">,
): { stanceEnabled: 1; stanceFailed: number; stanceCallsFailed: number; stances: number } | null {
  const meta = (out.turn.extractionMetadata ?? {}) as Record<string, unknown>;
  // 게이트가 꺼진 턴은 아예 세지 않는다 — 분모가 "켜진 턴" 이어야 비율이 뜻을 갖는다.
  if (meta.llm_answer_brand_stance_enabled !== true) return null;
  return {
    stanceEnabled: 1,
    stanceFailed: meta.llm_answer_brand_stance_failed === true ? 1 : 0,
    stanceCallsFailed: out.llmUsage.filter((u) => u.task === "stance" && u.outcome === "failed").length,
    stances: typeof meta.llm_answer_brand_stance_count === "number" ? meta.llm_answer_brand_stance_count : 0,
  };
}

/**
 * 감성 V2 **섀도 병행** 패스의 실패 **관측**(PR-L1). 판정이 아니라 계수다.
 * 정본: `(내부 설계 문서)` §3.2·§5-2.
 *
 * ⚠️ **`GATED_LLM_LAYERS` 에 넣지 않는다.** 위 `stanceObservation` 과 **같은 이유이고, 섀도에서는
 *    더 강하다**: 섀도는 정의상 부가 패스라 그것이 전멸해도 V0 감성은 이미 나와 있다. 게이트에
 *    넣으면 `detectSilentLlmFailure` 가 `deferred(transient)` 를 던져 **턴 전체가 재시도로 돌아가고**,
 *    완주한 V0 분석을 다시 돌려 실비를 두 배로 쓴다 — 플랜 §2 원칙 2("섀도는 실패해도 V0 결과로
 *    completed 가 나간다")의 정반대다. `tests/semantics-shadow.test.ts` 가 그 명제를
 *    `detectSilentLlmFailure(out) === null` 로 고정한다.
 *
 *    ⚠️ 기존 **대체 모드** V2 항목(`llm_mention_semantics_v2_*`)은 게이트에 그대로 둔다. 그쪽은
 *       semantics 패스를 대체하므로 전멸이 곧 감성 데이터 전멸이다. 두 축은 키 이름이 다르고
 *       (`…_v2_enabled` vs `…_v2_shadow_enabled`) 의미도 반대다.
 *
 * 그렇다고 조용히 두면 **켰는데 데이터가 안 쌓이는 상태**를 아무도 못 본다(스탠스 WU6 의 전례).
 * 그래서 **로그 한 줄 + 메트릭 필터**로만 표면화한다 — 목적지는 잔디가 아니라 **GitHub Issue** 다
 * (룰 alert-routing: "사람이 코드를 고쳐야 해소된다" = 코드 경로). **알람은 만들지 않는다.**
 *
 * 두 축을 따로 센다(스탠스와 같은 진단 구조). `semanticsShadowFailed=1` 인데
 * `semanticsShadowCallsFailed=0` 이면 모델이 답은 했는데 파싱·인덱스 매칭이 깨진 것이고,
 * 둘 다 >0 이면 공급자 쪽이다.
 *
 * ⚠️ **필드 이름이 CloudWatch 메트릭 필터의 계약이다**(`infra/lib/analysis-stack.ts`
 *    `SemanticsShadow*Filter`). 바꾸면 필터가 영영 매칭되지 않고 지표가 **조용히 0 으로 굳는다**
 *    (F2 의 `InflightCalls` 전례). 턴 메타 키 이름은 코어 PR-C1 이 기록하는 것과 같아야 한다.
 *
 * 키가 아직 없는 현재 창(코어 PR-C1 미배포)에서는 `null` 을 돌려주고 아무 로그도 남기지 않는다 —
 * 안 켠 기능이 매 턴 지표를 만들면 분모가 오염된다.
 */
export function semanticsV2ShadowObservation(
  out: Pick<AnalysisEngineOutput, "turn" | "llmUsage">,
): { semanticsShadowEnabled: 1; semanticsShadowFailed: number; semanticsShadowCallsFailed: number } | null {
  const meta = (out.turn.extractionMetadata ?? {}) as Record<string, unknown>;
  if (meta.llm_mention_semantics_v2_shadow_enabled !== true) return null;
  return {
    semanticsShadowEnabled: 1,
    semanticsShadowFailed: meta.llm_mention_semantics_v2_shadow_failed === true ? 1 : 0,
    // 원장 태스크는 `semantics_shadow` 다(`worker/llm-pools.ts` `CORE_TASK_TO_LANE_TASK`) — V0
    // 감성 콜(`semantics`)과 섞이지 않는다. 그 분리가 플랜 §5 수용 기준 6 의 근거이기도 하다.
    semanticsShadowCallsFailed: out.llmUsage.filter((u) => u.task === "semantics_shadow" && u.outcome === "failed").length,
  };
}

/**
 * 재시도가 풀어 줄 종류의 실패다 — 짧게 물러난다(`replyForError` ③ 경로가 이 값을 쓴다).
 *
 * 왜 30s 인가, 그리고 **지속 장애에서 무슨 일이 일어나는가**: `maxAttempts` 는 lane 전체가
 * 3 이므로 이 티켓은 30s 간격으로 3회 시도한 뒤 리퍼가 `cap_exhausted` 로 종결한다(~1분).
 * 장애가 길면 티켓이 큐에서 버티는 게 아니라 **종결되고 코어가 재발행**한다 — 그게 D5 의
 * 설계다(안전망이 무한 재시도로 실비를 태우는 경로를 만들지 않는다). 기존 미분류 transient
 * (④, 5s·10s·20s)보다 느리고 `capacity`(②, 15s)보다 느리게 잡은 것은 의도다: 공급자 장애는
 * 슬롯 경합보다 회복이 느리므로 같은 3회를 더 넓게 쓴다.
 */
const SILENT_LLM_RETRY_AFTER_MS = 30_000;

/**
 * ⚠️ **소스에 날 바이트를 두지 않는다** — 파일이 바이너리로 취급돼 git diff·grep 이 침묵하고,
 *    리뷰에서 안 보이는 문자가 코드에 앉는다. 제어문자·서로게이트는 **이스케이프로만** 쓴다.
 *
 * 짝 없는 서로게이트: 뒤에 low 가 없는 high, 또는 앞에 high 가 없는 low.
 * **코어 `lib/db/jsonb-param.ts` 의 `LONE_SURROGATE_RE` 와 글자 그대로 같다** — 두 경로가 같은
 * 문자열에 같은 결론을 내야 "lane 경로와 인라인 경로의 차이는 직렬화뿐" 이 참이다.
 */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * 저장 불가(U+0000)하거나 의미 없는 C0 제어문자 + DEL. **U+0009(탭)·U+000A(개행)·U+000D(복귀)는
 * 의도적으로 뺐다** — 답변 서식이라 지우면 내용이 상한다(코어 `UNSTORABLE_CONTROL_RE` 와 같은 정책).
 */
const UNSTORABLE_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** U+FFFD(REPLACEMENT CHARACTER). text 파라미터가 이미 넣고 있는 그 문자다. */
const REPLACEMENT = "\uFFFD";

/**
 * 문자열 하나를 **jsonb·text 어느 컬럼에 넣어도 안전한** 모양으로 만든다. 순수·멱등.
 *
 * ⚠️ 초판(`stripNulChars`)은 U+0000 만 털었다. 이름이 곧 범위였고, **짝 없는 서로게이트라는
 *    두 번째 갈래가 그대로 남아 있었다.** 코어는 둘을 같이 다룬다(`lib/db/jsonb-param.ts` —
 *    2026-08-18 서로게이트 · 2026-08-22 제어문자). lane 만 절반을 하면 같은 답변이 코어 인라인
 *    경로에서는 통과하고 lane 경로에서만 죽는다 = 두 팔 비교(shadow A/B)가 거짓이 된다.
 *
 * ── 왜 서로게이트가 NUL 과 **같은 급의** 사고인가
 *
 *   JS 문자열은 UTF-16 이라 짝 없는 서로게이트를 담을 수 있고, 그것을 PostgreSQL 로 보낼 때
 *   컬럼 타입이 동작을 가른다:
 *     · text  — 드라이버가 UTF-8 인코딩에서 U+FFFD 로 **조용히 치환**한다(쿼리는 성공).
 *     · jsonb — `JSON.stringify` 가 `\ud83d` 같은 **이스케이프로 출력**하고(ES2019 well-formed
 *               stringify) 그 ASCII 는 인코딩을 그대로 통과해 서버 json 파서가 거부한다:
 *                   ERROR: invalid input syntax for type json   (SQLSTATE 22P02)
 *   실측(2026-09-13, 이 리포): 실 PG 17.7(`tests/live-pg-sanitize.test.ts`)과
 *   PGlite(`tests/jsonb-params.test.ts`) 둘 다 `22P02` 로 거부했고, **같은 값이 text 컬럼에는
 *   U+FFFD 로 조용히 들어갔다.** 즉 NUL 과 완전히 같은 실패 경로다:
 *     ① lane `settle` 의 `reply=$n::jsonb` → 정산 실패 → 티켓 `running` 잔존 → 리스 만료 →
 *        리퍼 → **유료 LLM 재실행 ×3** → `cap_exhausted`.
 *     ② 코어 shadow INSERT → lane 은 completed 인데 코어엔 결과가 없다(무음 유실).
 *
 * 정책(코어와 동일 — 정보 손실 최소화):
 *   · U+0000 제거 · 나머지 C0·DEL 제거 · 탭·개행·복귀 보존
 *   · 짝 없는 서로게이트 → U+FFFD **치환**(제거가 아니다). text 파라미터가 이미 하는 것과
 *     정확히 같은 손실이라 두 컬럼 타입의 동작이 일치한다.
 */
export function toStorableText(value: string): string {
  // 빠른 경로: 서로게이트가 아예 없으면(대부분) 제어문자 replace 한 번으로 끝난다.
  const stripped = value.replace(UNSTORABLE_CONTROL_RE, "");
  if (!/[\uD800-\uDFFF]/.test(stripped)) return stripped;
  return stripped.replace(LONE_SURROGATE_RE, REPLACEMENT);
}

/**
 * 답장에 실릴 **모든 문자열**을 `toStorableText` 로 통과시킨 새 값(키 이름 포함, 깊은 순회).
 * 코어 `toStorableJson` 의 동형이다.
 *
 * ⚠️ 원본을 **변형하지 않는다** — `out.turn` 은 원장 적재·로그에서도 쓰인다.
 */
export function sanitizeStorableStrings<T>(value: T): T {
  if (typeof value === "string") return toStorableText(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeStorableStrings(v)) as T;
  if (value === null || typeof value !== "object") return value;
  // Date 등 특수 객체는 답장 계약에 없다(전부 JSON 값) — 일반 객체로만 순회한다.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[toStorableText(k)] = sanitizeStorableStrings(v);
  }
  return out as T;
}

/**
 * 답장 조립의 **유일한 출구**. 정화를 파싱 **앞**에 두는 이유가 둘이다:
 *   ① 한 자리에서 끝난다 — `result`·`evidence` 만 감싸던 초판은 `failureReason`·
 *      `deferred.detail` 을 빠뜨렸다. 그 둘도 같은 `reply` jsonb 안으로 들어간다.
 *   ② 파싱이 **정화된 값**을 검증한다 — 정화를 뒤에 두면 "검증을 통과한 것" 과 "DB 로 가는 것" 이
 *      다른 값이 된다. 정화는 길이를 늘리지 않으므로(제거 또는 1:1 치환) `.max(512)` 같은
 *      상한 검증은 정화 뒤에도 그대로 성립한다.
 */
function parseReply(body: unknown): AnalysisReply {
  return AnalysisReplySchema.parse(sanitizeStorableStrings(body));
}

/**
 * 자유문 사유 — **정화 + 512 절단**(계약 상한). 이 문자열도 `settle` 이 `reply` 를 `jsonb` 로
 * 쓸 때 함께 들어가므로, 예외 메시지에 섞인 NUL·서로게이트 하나가 정산 자체를 죽일 수 있다
 * (`toStorableText` 머리말 ①). 절단은 **정화 뒤에** 한다 — 순서를 바꾸면 경계에서 잘린
 * 서로게이트 쌍이 새로 생긴다(그게 애초에 코어를 물었던 `contextSnippet` 창 절단의 결함이다).
 */
const reason = (s: string): string => toStorableText(s).slice(0, 512);

/** 예외 → 답장. **분류가 재시도 정책을 결정하므로 여기가 정책의 한 축이다.** */
export function replyForError(args: {
  ticketId: string;
  traceId: string;
  analysisVersion: string;
  attempt: number;
  error: unknown;
}): AnalysisReply {
  const { error } = args;
  const base = {
    version: 1 as const,
    ticketId: args.ticketId,
    traceId: args.traceId,
    analysisVersion: args.analysisVersion,
    finishedAt: new Date().toISOString(),
    result: null,
    evidence: null,
  };
  // ① 계약 위반은 **결정적 실패** — 재시도해도 같은 결과다. attempt 를 올리지 않고 1회로 종결(D5).
  if (error instanceof AnalysisContractError) {
    return parseReply({
      ...base,
      status: "failed",
      deferred: null,
      failureReason: reason(error.message),
      terminalReason: "permanent",
    });
  }
  // ② 콜 상한 대기 초과 — 부하 신호이지 결함이 아니다. 짧게 물러난다.
  if (error instanceof CapacityTimeoutError) {
    return parseReply({
      ...base,
      status: "deferred",
      deferred: { failureClass: "capacity", retryAfterMs: 15_000, detail: reason(error.message) },
      failureReason: null,
      terminalReason: null,
    });
  }
  // ③ 엔진이 명시적으로 "재시도로 풀린다" 고 말한 경우.
  if (error instanceof AnalysisDeferrable) {
    return parseReply({
      ...base,
      status: "deferred",
      deferred: {
        failureClass: error.failureClass,
        retryAfterMs: error.retryAfterMs,
        detail: reason(error.message),
      },
      failureReason: null,
      terminalReason: null,
    });
  }
  // ④ 그 외는 transient. 지수 백오프(측정 lane 과 같은 형태), 상한 10분.
  const backoffMs = Math.min(600_000, 5_000 * 2 ** Math.max(0, args.attempt - 1));
  const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return parseReply({
    ...base,
    status: "deferred",
    deferred: { failureClass: "transient", retryAfterMs: backoffMs, detail: reason(msg) },
    failureReason: null,
    terminalReason: null,
  });
}

/**
 * **답장 조립이 실패해도 반드시 답장이 나온다.**
 *
 * `replyForError` 는 마지막에 `parseReply`(= 정화 + `AnalysisReplySchema.parse`)를 탄다 — 즉
 * **이 함수 자신이 던질 수 있다.** 던지는 경로가 실제로 있다: `traceId`·`analysisVersion` 은 티켓 파싱이 실패하면 DB 행
 * 값(`row.trace_id`·`row.analysis_version`)으로 남는데 계약은 각각 `z.guid()`·`min(1)` 이고,
 * `AnalysisDeferrable.retryAfterMs` 가 NaN/음수여도 parse 가 던진다.
 *
 * 그때 초판은 `processTicket` 의 `catch` 안에서 **두 번째 예외**가 나면서 `settle` 을 통째로
 * 건너뛰었다. 그 티켓은 `running` 으로 남아 리스 TTL 까지 방치되고 → 리퍼가 회수 → **같은 턴을
 * 처음부터 다시 돌린다**. 즉 조립 버그 하나가 **유료 LLM 을 두 벌 태운다**(이 lane 이 재시도마다
 * 실비를 쓰는 이유가 정확히 그것이다 — `maxAttempts` 주석).
 *
 * 그래서 여기서 감싼다. 대체 답장은 **정보를 지어내지 않는다**: 되살릴 수 없는 축(traceId 등)은
 * 원 티켓 행의 값을 쓰되 계약을 통과하지 못하면 그 사실이 `failureReason` 에 남고, 최후에는
 * `terminalReason: "permanent"` 로 **1회 종결**한다(재시도해도 같은 조립이 또 실패한다 — D5 의
 * 결정적 실패와 같은 판정).
 */
export function safeReplyForError(args: {
  ticketId: string;
  traceId: string;
  analysisVersion: string;
  attempt: number;
  error: unknown;
}): AnalysisReply {
  try {
    return replyForError(args);
  } catch (buildError) {
    log.error("analysis_lane.reply_build_failed", {
      ticketId: args.ticketId,
      attempt: args.attempt,
      // 원 예외도 함께 — 조립 실패만 남으면 "무엇을 처리하다 실패했나" 가 사라진다.
      originalError: (args.error instanceof Error ? `${args.error.name}: ${args.error.message}` : String(args.error)).slice(0, 256),
      ...errorFields(buildError),
    });
    return minimalFailureReply(args, buildError);
  }
}

/** 조립조차 실패했을 때의 최후 답장. 계약을 통과할 때까지 **축을 하나씩 포기한다.** */
function minimalFailureReply(
  args: { ticketId: string; traceId: string; analysisVersion: string; error: unknown },
  buildError: unknown,
): AnalysisReply {
  const reason = (
    `reply build failed: ${buildError instanceof Error ? `${buildError.name}: ${buildError.message}` : String(buildError)}`
  ).slice(0, 512);
  const base = {
    version: 1 as const,
    ticketId: args.ticketId,
    status: "failed" as const,
    finishedAt: new Date().toISOString(),
    result: null,
    evidence: null,
    deferred: null,
    failureReason: reason,
    terminalReason: "permanent" as const,
  };
  // 1차: 원 티켓의 traceId·analysisVersion 을 그대로. 이 둘이 정상이면 상관관계가 보존된다.
  try {
    return parseReply({ ...base, traceId: args.traceId, analysisVersion: args.analysisVersion });
  } catch {
    /* 2차로 */
  }
  // 2차: 계약을 못 통과한 축을 **자리표시자로 바꾼다.** 지어낸 값임이 드러나야 하므로
  //      traceId 는 nil uuid, analysisVersion 은 고정 문자열이다 — 코어가 "이 답장은 lane 이
  //      조립에 실패해 낸 것" 임을 값만 보고도 안다. 정산 자체를 포기하는 것(= 리스 만료 →
  //      리퍼 → 유료 재실행)보다 이쪽이 싸다.
  // ⚠️ 표식을 **앞에** 둔다. 뒤에 붙이면 `.max(512)` 절단에 먹혀 사라진다 — ZodError 메시지가
  //    수백 자라 실제로 잘렸다(이 주석이 그 회귀의 흔적이고 테스트가 그것을 고정한다).
  return parseReply({
    ...base,
    traceId: NIL_UUID,
    analysisVersion: UNKNOWN_ANALYSIS_VERSION,
    failureReason: `traceId/analysisVersion replaced (contract rejected the ticket row values): ${reason}`.slice(0, 512),
  });
}

const NIL_UUID = "00000000-0000-4000-8000-000000000000";
const UNKNOWN_ANALYSIS_VERSION = "unknown";

/** 티켓 1건 처리. 실행·정산·하트비트가 전부 여기 안에서 끝난다. */
export async function processTicket(deps: WorkerDeps, row: T.LeasedTicket): Promise<"completed" | "deferred" | "failed"> {
  const ticketId = row.ticket_id;
  const token = row.lease_token;
  const attempt = Number(row.attempt_count);
  const abort = new AbortController();
  inflight.set(ticketId, { token, abort });

  const heartbeat = setInterval(() => {
    void deps.db
      .begin((tx) =>
        // ⚠️ 누적에 더하는 값은 **하트비트 간격**이다 — TTL 을 더하면 60초마다 1,200s 를 적립해
        //    2분 만에 상한에 닿는다(app/tickets.ts heartbeat 주석).
        T.heartbeat(
          tx,
          ticketId,
          token,
          settings.leaseTtlSeconds,
          settings.leaseCumulativeCapSeconds,
          settings.leaseHeartbeatSeconds,
        ),
      )
      .then((ok) => {
        if (!ok) {
          // 다른 주인이거나 취소됐거나 **누적 상한을 넘겼다** — 어느 쪽이든 실행을 중단해야 한다.
          log.warn("analysis_lane.heartbeat_lost", { ticketId, attempt });
          abort.abort(new Error("lease lost or cumulative cap exceeded"));
        }
      })
      .catch((e) => log.error("analysis_lane.heartbeat_error", { ticketId, ...errorFields(e) }));
  }, settings.leaseHeartbeatSeconds * 1000);
  heartbeat.unref?.();

  let rep: AnalysisReply;
  let traceId = row.trace_id;
  let analysisVersion = row.analysis_version;
  try {
    await deps.db.begin((tx) => T.markRunning(tx, ticketId, token));
    // ⚠️ zod **strict** 검증. 원장에 든 request 라도 그냥 믿지 않는다 — 측정 lane 8/25 사고
    //    (타입 캐스트 한 줄이 리스 43% 를 태웠다)의 같은 봉인이다.
    const ticket = AnalysisTicketRequestSchema.parse(row.request);
    traceId = ticket.traceId;
    analysisVersion = ticket.analysisVersion;

    const context = await deps.contextCache.get(deps.db, ticket.context.contextVersion, ticket.context.ref);
    const out = await deps.engine.analyzeTurn({
      ticket,
      context,
      llm: deps.makeInvoker(ticketId),
      log,
      signal: abort.signal,
    });

    // **엔진 출력 후 게이트.** 엔진 안에서 던지지 않는 이유: 순수 산출물은 코어와 바이트
    // 동일해야 하고(골든 13), 그 판정은 `completed/deferred` 결정과 다른 축이다. 여기서
    // 던지면 아래 catch 가 실비 원장까지 같이 처리한다 — 행을 예외에 실어 보내는 이유.
    const silent = detectSilentLlmFailure(out);
    if (silent) {
      log.error("analysis_lane.silent_llm_failure", { ticketId, attempt, callRows: out.llmUsage.length, detail: silent });
      throw Object.assign(new AnalysisDeferrable("transient", SILENT_LLM_RETRY_AFTER_MS, silent), {
        // `usageFromError` 가 읽는 이름이다(엔진 실패 경로와 같은 계약) — 안 붙이면 이미 나간
        // 콜의 실비가 통째로 사라져 "실패한 턴은 공짜" 가 된다.
        llmUsage: [...out.llmUsage],
      });
    }

    // WU6 F4 — 스탠스 관측. **던지지 않는다**(위 `stanceObservation` 머리말: FR6).
    //    필드 이름이 CloudWatch 메트릭 필터의 계약이다(`infra/lib/analysis-stack.ts`) — 바꾸면
    //    지표가 조용히 0 이 된다.
    const stanceObs = stanceObservation(out);
    if (stanceObs) log.info("analysis_lane.stance_observed", { ticketId, attempt, ...stanceObs });

    // PR-L1 — 감성 V2 섀도 관측. 스탠스와 **같은 계약**이다: 던지지 않고, 게이트 켜진 턴에서만
    //    한 줄 찍고, 필드 이름이 메트릭 필터의 계약이다.
    const shadowObs = semanticsV2ShadowObservation(out);
    if (shadowObs) log.info("analysis_lane.semantics_v2_shadow_observed", { ticketId, attempt, ...shadowObs });

    // ⚠️ **`parseReply` 가 답장 전체를 정화한다**(U+0000 · 짝 없는 서로게이트 · C0/DEL).
    //    답변 본문에서 온 그 문자 하나가 완주한 분석을 버리게 만드는 자리가 둘이다 —
    //    `toStorableText` 머리말 참조. 초판은 `result`·`evidence` 만 감쌌고 `failureReason`·
    //    `deferred.detail` 이 같은 jsonb 안으로 정화 없이 들어가고 있었다.
    rep = parseReply({
      version: 1,
      ticketId,
      traceId,
      status: "completed",
      finishedAt: new Date().toISOString(),
      analysisVersion,
      result: { turn: out.turn, citationClassifications: out.citationClassifications },
      evidence: {
        // ⚠️ **코어 모양으로 투영한다.** lane 원장 행(`AnalysisCallUsage`)에는 `outcome`·
        //    `costSource`·`httpStatus`·`errorClass`·`startedAt`·`finishedAt` 이 붙어 있는데,
        //    코어 정본 `AnalysisLlmUsageSchema` 는 8필드 `.strict()` 다 — 그대로 올리면 코어가
        //    reply 를 통째로 거부하고(`AnalysisTicketApiError("contract")`) 완주한 분석이
        //    `output_contract` 로 버려진다. 운영 축은 아래 `recordCallUsage` 가 원장에 남긴다.
        llmUsage: out.llmUsage.map(toReplyUsage),
        runtime: {
          laneRevision: deps.engine.revision,
          contextVersionUsed: context.contextVersion,
          parallelFlags: out.parallelFlags ?? {},
          // ⚠️ **게이트③ 표기(운영 결정 2026-09-13).** 코어 gate3(#661)가 shadow 행의
          //    `runtime->>'cacheBust'` 를 읽는다. off 면 `cacheBustReplyMark` 가 **키를 아예
          //    안 싣는다** — 코어 `evidence.runtime` 은 `.strict()` 라 이 필드를 모르는 코어
          //    (측정 워커 TD 240)가 받으면 답장을 통째로 거부한다(완주한 분석이 버려진다).
          //    배포 순서: **코어 PR-h 머지 + 워커 재배포 → lane 배포.**
          ...cacheBustReplyMark(settings.llmCacheBust),
        },
      },
      deferred: null,
      failureReason: null,
      terminalReason: null,
    });
    await recordCallUsage(deps.db, { ticketId, attempt, workerId: settings.workerId, usage: out.llmUsage, laneRevision: deps.engine.revision });
  } catch (e) {
    // ⚠️ `replyForError` 가 아니라 **`safeReplyForError`** 다. 조립이 던지면 이 catch 안에서
    //    두 번째 예외가 나 `settle` 이 통째로 누락되고, 그 티켓은 리스 만료 → 리퍼 → **유료
    //    LLM 재실행**이 된다(그 함수 주석 참조). 여기서 이름을 되돌리면 그 경로가 되살아난다.
    rep = safeReplyForError({ ticketId, traceId, analysisVersion, attempt, error: e });
    // 실패해도 **이미 나간 콜의 실비**는 원장에 남긴다(F15). 안 적으면 실패 턴이 공짜로 보인다.
    await recordCallUsage(deps.db, {
      ticketId,
      attempt,
      workerId: settings.workerId,
      usage: usageFromError(e),
      laneRevision: deps.engine.revision,
    });
    log.warn("analysis_lane.turn_failed", { ticketId, attempt, status: rep.status, ...errorFields(e) });
  } finally {
    clearInterval(heartbeat);
    inflight.delete(ticketId);
  }

  const settled = await deps.db.begin((tx) => T.settle(tx, ticketId, token, rep));
  if (!settled) {
    // 리스를 잃은 뒤의 정산 — 결과를 버린다. 덮어쓰면 **오래된 결과가 이긴다**.
    log.warn("analysis_lane.settle_lost_lease", { ticketId, attempt, status: rep.status });
  }
  return rep.status === "completed" ? "completed" : rep.status === "deferred" ? "deferred" : "failed";
}

/**
 * lane 원장(`analysis_call_usage`) 적재 — **행 1개 = LLM 콜 1회** (마이그레이션 0003 의 설계).
 *
 * ⚠️ 초판은 그 설계를 지키지 않았다(F15). `outcome='completed'`·`cost_source='vendor_reported'`
 *    를 SQL 에 **하드코딩**했고, 실패 경로(타임아웃·429·풀 페일오버·파싱 실패)에서는 아예
 *    호출되지 않았다. 결과가 셋이다:
 *      ① 원장의 `outcome` 컬럼에 `completed` 말고는 영영 안 들어간다 — 5값 CHECK 가 장식이 되고
 *         `v_analysis_ticket_cost.wasted_cost_usd`(= 완주에 기여하지 않은 콜의 실비)가 **항상 0** 이다.
 *         낭비를 보라고 만든 뷰가 낭비가 없다고 말한다.
 *      ② `v_analysis_pool_activity.rate_limited_calls`(429 비율)도 항상 0 — 헬스 게이팅(§8.3)의
 *         사후 검산이 통째로 무력화된다.
 *      ③ 직결 풀은 벤더가 비용을 안 주므로 레이트 테이블로 **계산**한 값인데 그것을
 *         `vendor_reported` 로 적으면, 나중에 단가가 틀렸을 때 어느 행이 추정치였는지 구분 불가다.
 *
 *    그래서 값의 주인을 엔진이 내는 usage 항목으로 돌린다. G3-2 가 콜 1회당 1 항목(풀·모델·지연·
 *    비용·outcome 포함)을 만들고, 이 함수는 **그대로 적재**한다. 모르는 것은 NULL 이다 — 0003 의
 *    "NULL = 미계측이지 0 이 아니다" 와 같은 규율이고, `cost_source` 도 같다.
 *
 * **분석을 죽이지 않는다** — 실패해도 삼키고 로그만(0003 헤더의 "행 자체가 없을 수도 있다").
 */
const CALL_OUTCOMES = new Set(["completed", "retried", "failed", "failed_over", "drained"]);
const COST_SOURCES = new Set(["vendor_reported", "rate_table"]);

/**
 * 엔진이 내는 usage 항목 = **lane 원장 행**(`AnalysisCallUsage`). 코어가 받는
 * `evidence.llmUsage[]`(`AnalysisLlmUsage`, 8필드)와 **다른 타입**이다 — 여기 있는
 * `outcome`·`costSource`·`httpStatus`·`errorClass`·콜 창은 lane 밖으로 나가지 않고
 * (`toReplyUsage` 가 떨군다) `analysis_call_usage` 에만 남는다. 아래 `Partial<…>` 는
 * 손으로 만든 행·구버전 스텁이 축을 빠뜨렸을 때를 위한 **구조적 관용**이다.
 */
export type CallUsageEntry = AnalysisCallUsage &
  Partial<{
    outcome: string;
    costSource: string | null;
    httpStatus: number | null;
    errorClass: string | null;
    cacheBust: boolean;
  }>;

/**
 * ⚠️ 계약(`AnalysisCallUsageSchema.errorClass`)이 `.max(64)` 다. 원장만 더 길게 받으면
 * **같은 값이 원장 적재에서는 통과하고 행 검증에서는 튕기는** 비대칭이 생긴다(길이 65~128 구간).
 * 자르는 길이는 한 곳에서만 정한다 — 계약이 정본이고 `worker/invoker.ts` `failureRow` 도 같은 값이다.
 */
export const ERROR_CLASS_MAX_CHARS = 64;

/** ISO 8601 만 통과시킨다. 쓰레기 값이 `timestamptz` 캐스팅에서 트랜잭션을 죽이지 않게. */
function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function normalizeCallUsage(u: CallUsageEntry): {
  outcome: string;
  costSource: string | null;
  httpStatus: number | null;
  errorClass: string | null;
  cacheBust: boolean;
  costUsd: number | null;
  startedAt: string | null;
  finishedAt: string | null;
} {
  const outcome = typeof u.outcome === "string" && CALL_OUTCOMES.has(u.outcome) ? u.outcome : "completed";
  const costSource = typeof u.costSource === "string" && COST_SOURCES.has(u.costSource) ? u.costSource : null;
  return {
    outcome,
    costSource,
    httpStatus: typeof u.httpStatus === "number" && Number.isInteger(u.httpStatus) ? u.httpStatus : null,
    errorClass: typeof u.errorClass === "string" && u.errorClass.length > 0 ? u.errorClass.slice(0, ERROR_CLASS_MAX_CHARS) : null,
    // 게이트③(0008). **없으면 false** — 축이 없던 시절의 행·손으로 만든 행은 "캐시 켜짐" 이
    // 사실이다. 0003 의 "NULL = 미계측" 과 달리 여기서는 미기록과 false 가 같은 명제다
    // (스위치가 없었다 = 무효화하지 않았다). 그래서 NULL 을 만들지 않는다.
    cacheBust: u.cacheBust === true,
    // 비용을 못 받은 콜(실패·타임아웃)은 0 이 아니라 **미계측**이다.
    costUsd: typeof u.costUsd === "number" && Number.isFinite(u.costUsd) ? u.costUsd : null,
    // 엔진이 실측한 콜 창(`worker/invoker.ts` 가 `now()` 두 번으로 잰다). 없으면 적재 시점에
    // `now() - latencyMs` 로 합성한다 — 아래 SQL 의 `COALESCE`.
    startedAt: isoOrNull(u.startedAt),
    finishedAt: isoOrNull(u.finishedAt),
  };
}

export async function recordCallUsage(
  db: Db,
  args: { ticketId: string; attempt: number; workerId: string; usage: readonly CallUsageEntry[]; laneRevision: string },
): Promise<void> {
  if (args.usage.length === 0) return;
  try {
    let runIndex = 0;
    for (const u of args.usage) {
      runIndex += 1;
      const n = normalizeCallUsage(u);
      // ⚠️ 콜 창은 **엔진이 잰 값을 먼저 쓴다**(`startedAt`/`finishedAt`). 적재 시점의
      //    `now()` 로 합성하면 배치 적재·재시도 지연만큼 창이 통째로 밀려, `v_analysis_pool_daily`
      //    의 일자 버킷(`started_at AT TIME ZONE 'UTC'`)이 자정 근처에서 하루씩 어긋난다.
      //    없을 때만 `now() - latencyMs` 로 합성한다 — 0003 의 NOT NULL 을 채우기 위해서다.
      await db.query(
        `INSERT INTO analysis_call_usage
           (ticket_id, attempt, run_index, worker_id, task, pool_key, model_id, outcome,
            started_at, finished_at, latency_ms, input_tokens, output_tokens, cost_usd, cost_source,
            http_status, error_class, lane_revision, cache_bust)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
                 COALESCE($9::timestamptz, now() - make_interval(secs => $10)),
                 COALESCE($11::timestamptz, now()), $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          args.ticketId,
          args.attempt,
          runIndex,
          args.workerId,
          u.task,
          u.poolKey,
          u.modelId,
          n.outcome,
          n.startedAt,
          u.latencyMs / 1000,
          n.finishedAt,
          u.latencyMs,
          u.inputTokens,
          u.outputTokens,
          n.costUsd,
          n.costSource,
          n.httpStatus,
          n.errorClass,
          args.laneRevision,
          n.cacheBust,
        ],
      );
    }
  } catch (e) {
    log.error("analysis_lane.call_usage_write_failed", { ticketId: args.ticketId, ...errorFields(e) });
  }
}

/**
 * 실패한 턴에서도 **이미 나간 콜은 원장에 남긴다.** 엔진이 중간까지 돌다 죽으면 그때까지의 콜
 * 실비는 되돌아오지 않는다 — 그것을 안 적으면 "실패한 턴은 공짜" 라는 잘못된 그림이 된다.
 * 엔진은 부분 usage 를 예외에 실어 보낸다(`error.llmUsage`). 없으면 빈 배열이다.
 */
export function usageFromError(e: unknown): CallUsageEntry[] {
  const carried = (e as { llmUsage?: unknown } | null)?.llmUsage;
  return Array.isArray(carried) ? (carried as CallUsageEntry[]) : [];
}

async function reapOnce(db: Db): Promise<void> {
  // 락 획득과 쓸이가 **같은 트랜잭션**이어야 한다: 락은 커밋에서 풀리므로 그 사이에 다른 워커가
  // 같은 행을 중복으로 쓰지 못한다. 순서(expired → chronic)는 `T.sweep` 이 소유한다 — 그 순서가
  // `terminal_reason` 을, 나아가 코어의 재발행 여부를 바꾸기 때문이다(F13, tickets.ts sweep 주석).
  const counts = await db.begin((tx) =>
    T.sweep(tx, {
      reapIntervalSeconds: settings.reapIntervalSeconds,
      deadlineGraceSeconds: settings.deadlineGraceSeconds,
      maxAttempts: settings.maxAttempts,
      // ⚠️ 상한이 없으면 큰 적체 한 번이 **이 워커의 리스를 통째로 멈춘다**(B7) — 아래 poll
      //    루프가 `await reapOnce()` 이기 때문이다. 남은 것은 다음 틱이 가져간다.
      batchLimit: settings.sweepBatch,
    }),
  );
  if (counts && (counts.leases || counts.deadlines || counts.chronic || counts.expired)) {
    log.info("analysis_lane.reaper", { ...counts });
  }
}

/**
 * **용량 회수 주기**(B9 · D6) — 터미널 티켓 보존 배치 + 2차 컨텍스트 캐시 LRU 절단.
 *
 * 리퍼와 **다른 락·다른 주기**다:
 *   · 락  — `RETENTION_LEADER_LOCK`. 보존 배치가 리퍼를 막으면 안 되고 그 반대도 마찬가지다.
 *   · 주기 — 기본 300s. 리퍼(15s)와 달리 급할 일이 아니고, 한 틱에 **한 배치만** 민다.
 *
 * ⚠️ **한 트랜잭션**이다. 락은 커밋에서 풀리므로 그 사이 다른 워커가 같은 행을 두 번 지우지
 *    못한다(리퍼가 같은 형태를 쓰는 이유와 같다).
 * ⚠️ 실패해도 분석을 죽이지 않는다 — 호출부가 삼키고 로그만 남긴다.
 */
export async function maintenanceOnce(db: Db): Promise<(T.RetentionCounts & { contextsTrimmed: number }) | null> {
  return db.begin(async (tx) => {
    if (!(await T.claimRetention(tx))) return null; // 이번 주기는 남의 것
    const purged = await T.purgeTerminalTickets(tx, {
      retentionDays: settings.ticketRetentionDays,
      batchLimit: settings.retentionBatch,
    });
    // ⚠️ 2차 캐시는 **정확성이 아니라 용량**이다 — 지워도 다음 미스가 코어에서 다시 가져온다.
    //    스냅샷 1행이 14.4 MB 라(§14-1) 절단이 없으면 이 테이블만으로 디스크가 찬다.
    const contextsTrimmed = settings.contextDbCacheEnabled
      ? await trimContextTable(tx, settings.contextTableKeepRows, settings.contextTableTrimBatch)
      : 0;
    return { ...purged, contextsTrimmed };
  });
}

/**
 * **manual 예약 슬롯의 집행점**(F5).
 *
 * `reservedManualUnits` 는 설정에 있고 `/v1/capacity` 로 보고까지 되는데 **아무도 읽지 않았다** —
 * 워커가 `allowScheduled: true` 를 하드코딩해서, 빈 슬롯이 1개든 40개든 항상 scheduled 를 집었다.
 * 그러면 케이던스가 함대를 가득 채운 순간 사람이 누른 재분석(manual)은 **앞 유닛이 끝날 때까지**
 * 대기한다(턴 최악 p95 ~256s × 큐). 예약이라는 이름의 필드가 예약을 하나도 안 하고 있었다.
 *
 * 측정 lane 과 같은 술어다: **남은 슬롯이 예약분보다 많을 때만** scheduled 를 집는다. 즉 마지막
 * `reservedManualUnits` 칸은 manual 전용이고, manual 이 없으면 그 칸은 그냥 비어 있는다 —
 * 지연을 사는 대신 유휴를 지불하는 쪽이 옳은 거래다(재분석은 사람이 기다리는 작업이다).
 */
export function allowScheduledLease(free: number, reservedManualUnits: number): boolean {
  return free > Math.max(0, reservedManualUnits);
}

export async function runWorker(deps: WorkerDeps): Promise<void> {
  const pump = new CallbackPump();
  let lastReapAt = 0;
  let lastGaugeAt = 0;
  // ⚠️ **0 이 아니라 지금**에서 출발한다. 0 이면 함대 16대가 기동 직후 **동시에** 보존 배치를
  //    시도하고, 리더 락 때문에 15대는 그냥 왕복 한 번을 버린다(급할 일이 아니다).
  let lastMaintenanceAt = Date.now();
  log.info("analysis_lane.worker_start", {
    workerId: settings.workerId,
    engine: deps.engine.kind,
    revision: deps.engine.revision,
    unitConcurrency: settings.unitConcurrency,
    llmCallSlots: deps.llmSemaphore.stats.limit,
  });

  const running = new Set<Promise<unknown>>();
  while (!stopping || running.size > 0) {
    const now = Date.now();
    if (drainDeadline !== null && now > drainDeadline) {
      // 상한을 넘긴 건은 연장하지 않고 반납한다 — 그 시점의 잔여는 정상 분포 밖이라 더
      // 기다려도 안 끝난다(측정 lane 의 드레인 상한 근거와 같은 논리).
      log.warn("analysis_lane.drain_deadline_exceeded", { inflight: inflight.size });
      for (const { abort } of inflight.values()) abort.abort(new Error("drain deadline"));
      break;
    }

    if (now - lastReapAt > settings.reapIntervalSeconds * 1000) {
      lastReapAt = now;
      await reapOnce(deps.db).catch((e) => log.error("analysis_lane.reaper_failed", errorFields(e)));
    }
    await pump.maybePump(deps.db).catch((e) => log.error("analysis_lane.callback_pump_failed", errorFields(e)));

    // 용량 회수(B9 · D6). 드레인 중에는 돌리지 않는다 — 종료 예산을 GC 에 쓰지 않는다.
    if (!stopping && now - lastMaintenanceAt > settings.maintenanceIntervalSeconds * 1000) {
      lastMaintenanceAt = now;
      const m = await maintenanceOnce(deps.db).catch((e) => {
        log.error("analysis_lane.maintenance_failed", errorFields(e));
        return null;
      });
      if (m && (m.tickets || m.contextsTrimmed)) log.info("analysis_lane.maintenance", { ...m });
    }

    const free = settings.unitConcurrency - running.size;

    // F2 — api 는 이 프로세스의 세마포어를 볼 수 없다. 원장에 적어 두는 것이 유일한 경로다.
    // 실패해도 삼킨다: 게이지가 분석을 죽이면 안 된다.
    if (now - lastGaugeAt > settings.workerGaugeIntervalSeconds * 1000) {
      lastGaugeAt = now;
      await T.reportWorkerGauges(deps.db, {
        workerId: settings.workerId,
        inflightCalls: deps.llmSemaphore.stats.inflight,
        callSlots: deps.llmSemaphore.stats.limit,
        leasedUnits: running.size,
        laneRevision: deps.engine.revision,
      }).catch((e) => log.error("analysis_lane.worker_gauge_failed", errorFields(e)));
    }

    if (!stopping && free > 0) {
      const rows = await deps.db
        .begin((tx) =>
          T.leaseBatch(tx, {
            workerId: settings.workerId,
            ttlSeconds: settings.leaseTtlSeconds,
            // 마지막 `reservedManualUnits` 칸은 manual 전용이다(F5).
            allowScheduled: allowScheduledLease(free, settings.reservedManualUnits),
            limit: Math.min(free, 20),
            minRunwaySeconds: settings.minRunwaySeconds,
            maxAttempts: settings.maxAttempts,
          }),
        )
        .catch((e) => {
          log.error("analysis_lane.lease_failed", errorFields(e));
          return [] as T.LeasedTicket[];
        });
      for (const row of rows) {
        const p = processTicket(deps, row)
          .then((outcome) => {
            if (outcome !== "deferred") pump.nudge(); // 아웃박스에 방금 넣었다 — 즉시 민다
          })
          .catch((e) => log.error("analysis_lane.process_crashed", { ticketId: row.ticket_id, ...errorFields(e) }))
          .finally(() => running.delete(p));
        running.add(p);
      }
      if (rows.length > 0) continue; // 큐가 있으면 쉬지 않는다
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  await Promise.allSettled([...running]);
  // 정상 종료한 워커는 자기 게이지 행을 지운다 — 스케일인된 태스크가 영원히 stale 로 남아
  // `known=false` 를 고정시키면, 살아 있는 함대의 in-flight 까지 "미상" 으로 가려진다.
  await T.clearWorkerGauge(deps.db, settings.workerId).catch((e) =>
    log.error("analysis_lane.worker_gauge_clear_failed", errorFields(e)),
  );
  log.info("analysis_lane.worker_stop", {});
}

async function main(): Promise<void> {
  if (!settings.storeDsn) {
    log.error("analysis_lane.missing_dsn", { hint: "ANALYSIS_STORE_DSN required" });
    process.exit(2);
  }
  // 코어 내부 토큰 배선 — **참조가 있는데 값이 없으면 기동하지 않는다.** 부수효과 0 인
  // 검사이므로 DSN 단언과 나란히 가장 앞에 둔다(아래 인보커 팩토리·DB·마이그레이션보다 먼저 —
  // 같은 이유다: 실패할 기동이 커넥션·마이그레이션 락을 먼저 잡았다 죽는 순서를 만들지 않는다).
  // 왜 기동을 세우는가: 토큰 없이 돌면 코어가 404 로 숨겨(라우트 은닉) 아웃박스가 배달 실패로
  // 재시도하고, 로그엔 `http 404` 만 남아 **"코어 라우트 미배포"로 오진**된다
  // (`worker/internal-token.ts` checkTokenWiring).
  const tokenProblems = checkTokenWiring();
  if (tokenProblems.length > 0) {
    log.error("analysis_lane.internal_token_unwired", {
      // 값은 없다 — env 이름과 지문만.
      problems: tokenProblems,
      ...tokenWiringSummary(),
    });
    process.exit(2);
  }
  log.info("analysis_lane.internal_token", tokenWiringSummary());

  // ⚠️ **keep-alive 값을 암묵 기본값에 맡기지 않는다**(D-8). `applied:false` 면 이유가 함께
  //    찍힌다 — 배선이 없는데 있는 것처럼 보이는 상태를 만들지 않는다(이 파일 성공 위장 머리말).
  log.info("analysis_lane.http_dispatcher", {
    ...configureHttpKeepAlive({
      keepAliveTimeoutMs: settings.httpKeepAliveMs,
      keepAliveMaxTimeoutMs: settings.httpKeepAliveMaxMs,
      connections: settings.httpConnections,
    }),
  });

  const slots = computeWorkerCallSlots({
    total: settings.llmTotalConcurrency,
    // Hosting 인라인 2경로의 고정 몫(스펙 §7.2). Hosting 동시 인스턴스 수는 미확인(§14-4)이라
    // 확정 전까지 보수적 가정치로 lane 가용분을 깎는다.
    hostingInflight: Number(process.env.ANALYSIS_LLM_HOSTING_INFLIGHT ?? 32),
    workerCount: process.env.ANALYSIS_WORKER_COUNT ? Number(process.env.ANALYSIS_WORKER_COUNT) : null,
    maxWorkerCount: settings.workerMaxCount,
  });
  const llmSemaphore = new Semaphore(slots);

  // ⚠️ **모델 정합은 풀 조립보다 먼저 단언한다 — `pools_ready` 를 찍기 전에.** (B2)
  //    `LLM_TASK_MODEL_*` 가 비면 alias 기본값(haiku/sonnet)으로 접혀 **코어와 다른 모델**로
  //    돈다. 라이브 TD rev 9 가 정확히 그 상태였다: extract·semantics=haiku-4.5,
  //    resolve=sonnet-4.6 (코어는 gpt-5.6-luna · gemini-3.1-flash-lite). 콜은 전부 200 이라
  //    실패로 안 보이고, 턴 체류 2.3배·단가 17배·shadow A/B 무효만 남는다.
  //    부수효과 0 인 검사이므로 토큰 단언과 같은 자리에 둔다(DB·마이그레이션 락보다 먼저).
  const taskModels = assertTaskModelParity({ engine: settings.engine });
  if (taskModels.length > 0) {
    // **라이브에서 무엇으로 도는지 로그 한 줄로 보이게 한다** — B2 가 발견된 경로가 정확히
    // 이 관측이었고(턴 로그의 모델 문자열), 기동 요약에 없어서 아무도 먼저 보지 못했다.
    log.info("analysis_lane.task_models", {
      engine: settings.engine,
      // 게이트③ 태세. **기동 요약에 없으면 아무도 먼저 보지 못한다** — `task_models` 자신이
      // 정확히 그 이유로(라이브가 무슨 모델로 도는지 안 보였다) 생긴 로그다.
      cacheBust: settings.llmCacheBust,
      cacheBustMode: settings.llmCacheBustMode,
      models: Object.fromEntries(taskModels.map((m) => [m.laneTask, m.canonicalId])),
      // 단가표에 없는 모델은 `costUsd=null`(미계측)로 올라간다 — 장부 구멍의 조기 지문.
      unregisteredRates: taskModels.filter((m) => !m.rated).map((m) => m.canonicalId),
    });
  }

  // ⚠️ **DB·마이그레이션보다 먼저 조립한다.** `createLaneInvokerFactory` 는
  //    `ANALYSIS_ENGINE=core` 인데 활성 풀이 0 이면 여기서 던지고, 이 파일 맨 아래의
  //    `main().catch` 가 `process.exit(1)` 로 끝낸다 — **기동 시점 사망**이 설계다.
  //    (키 없이 뜨면 큐를 끌어다 전부 실패시키고 재시도 예산만 태운다.) 순서가 뒤면
  //    실패한 기동이 DB 커넥션·마이그레이션 락을 먼저 잡았다 죽는다.
  //    래퍼 순서(세마포어 → 타임아웃 → 풀 라우팅)는 팩토리가 소유한다 — `worker/invoker.ts` 상단 주석.
  const engine = resolveEngine(settings.engine, settings.laneRevision);
  const makeInvoker = createLaneInvokerFactory({
    semaphore: llmSemaphore,
    acquireTimeoutMs: settings.llmSlotAcquireTimeoutMs,
    requestTimeoutMs: Number(process.env.ANALYSIS_LLM_REQUEST_TIMEOUT_MS ?? 180_000),
    log,
    engine: settings.engine,
  });

  // ⚠️ 풀 크기는 **배선된 값**이다(`ANALYSIS_DB_POOL_MAX`, 스택이 워커에 5 를 준다). 10 하드코딩
  //    이었고, 함대 48 × 10 = 480 은 lane RDS(db.t4g.medium) `max_connections` 400 을 넘어 뒤쪽
  //    워커가 **기동에서** 죽는다. 부등식은 `infra/lib/analysis-stack.ts` 가 synth 에서 강제한다.
  const db = createPostgresDb(settings.storeDsn, { max: settings.dbPoolMax });
  await migrate(db);

  const deps: WorkerDeps = {
    db,
    engine,
    llmSemaphore,
    contextCache: new ContextCache({
      maxEntries: settings.contextCacheMaxEntries,
      maxBytes: settings.contextCacheMaxBytes,
      fetchTimeoutMs: settings.contextFetchTimeoutMs,
      dbCacheEnabled: settings.contextDbCacheEnabled,
      internalToken: settings.internalContextToken,
    }),
    makeInvoker,
  };

  const onSignal = (sig: string) => {
    if (stopping) return;
    stopping = true;
    drainDeadline = Date.now() + DRAIN_GRACE_MS;
    log.info("analysis_lane.drain_start", { signal: sig, inflight: inflight.size, graceMs: DRAIN_GRACE_MS });
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  try {
    await runWorker(deps);
  } finally {
    await db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    log.error("analysis_lane.worker_crashed", errorFields(e));
    process.exit(1);
  });
}
