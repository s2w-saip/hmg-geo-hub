// 분석 lane 티켓/답장 계약 v1.
//
// ⚠️ **정본은 코어다** — `Kongventures/scope` `lib/measurement-analysis-ticket/contracts.ts`.
//    여기 있는 **공유 스키마는 그 사본**이고, 갈리면 라이브가 통째로 400 이다. 2026-09-13 에
//    실제로 그랬다: 스펙 문서 §4.3 표의 **축약 표기**(`industry: {id, name}`)를 스키마로 옮겨
//    놓아서 코어가 보낸 모든 티켓이 거부됐다. 스펙 표가 아니라 **코어 파일**이 모수다.
//
//    lane 전용 스키마(Capacity·Coordination·상태 뷰·원장 행 `AnalysisCallUsage`)는 여기가 정본이다.
//    코어에 없는 좁힘은 **두 개뿐**이고, 둘 다 "코어가 만들 수 있는 값을 거부하지 않는다" 를
//    근거와 함께 아래에 박아 뒀다.
//
// 측정 lane 은 "정본 = Python pydantic, TS 는 미러" 였고 CI 가 JSON Schema 왕복으로 드리프트를
// 잡았다(scope-measurement `contracts/README.md`). 분석은 양쪽 다 TS 라 그 왕복 대신
// **코어 픽스처의 바이트 사본**(`fixtures/core-mirror/`)이 드리프트를 잡는다 — lane 안에서만
// 도는 fixture 왕복은 "lane 이 자기 자신과 일치한다" 만 증명해서 이 사고를 못 봤다.
// 근거: 분석 lane 스펙 §3.3 · §4.4.
//
// 원칙(측정과 동일): 티켓에는 "어떻게"(모델·공급자·풀·동시성·재시도)가 없다 — lane 이 400 으로 거부한다.
import { z } from "zod";
// 결과 어휘는 **벤더된 순수 코드에서 가져온다**(아래 "G3-2 가 좁힌 자리" 참고).
import {
  AnswerQualityStateSchema,
  CandidateKindSchema,
  CitationCategorySchema,
  EntityTypeSchema,
  MentionAssertionSchema,
  MentionRoleSchema,
  MentionSentimentSchema,
  ResolutionMethodSchema,
  ResolutionStatusSchema,
  STANCE_ASPECT_CAP,
  STANCE_ASPECT_LABEL_CAP,
} from "../packages/analysis-core/vendor/lib/measurement-analysis/schema.ts";

export const ANALYSIS_CONTRACT_VERSION = 1 as const;

// ---- 어휘 -------------------------------------------------------------------
// 측정 lane 과 **어휘를 동일하게 유지한다**(스펙 §3.1). 분석에 자연스럽지 않은 값
// (captcha·challenge·drain)도 지우지 않는다 — 두 lane 의 운영 도구·대시보드·알람 술어가
// 같은 문자열을 쓰게 하는 것이 값보다 크다. 의미 매핑은 아래 주석.

export const AnalysisPrioritySchema = z.enum(["manual", "scheduled"]);
export type AnalysisPriority = z.infer<typeof AnalysisPrioritySchema>;

export const AnalysisTicketStatusSchema = z.enum([
  "queued",
  "leased",
  "running",
  "completed",
  "deferred",
  "failed",
  "cancelled",
]);
export type AnalysisTicketStatus = z.infer<typeof AnalysisTicketStatusSchema>;

/**
 * 측정과 같은 7값. 분석에서의 의미:
 *   transient       = LLM 5xx·네트워크·파싱 실패 등 재시도로 풀리는 것
 *   captcha         = (분석에 없음 — 어휘 보존용. lane 이 발행하지 않는다)
 *   challenge       = (분석에 없음 — 어휘 보존용)
 *   output_contract = LLM 이 계약 밖 출력을 냈다 / reply 가 스키마를 어겼다 →
 *                     **결정적 실패라 attempt 를 올리지 않고 1회로 종결**(스펙 D5)
 *   drain           = 태스크 축소로 중단·반납. 재시도 예산은 환불되지만 LLM 실비는 이미 나갔다
 *   deadline        = deadlineAt 초과
 *   capacity        = 전역 LLM 콜 상한(ANALYSIS_LLM_TOTAL_CONCURRENCY) 대기 타임아웃
 */
export const AnalysisFailureClassSchema = z.enum([
  "transient",
  "captcha",
  "challenge",
  "output_contract",
  "drain",
  "deadline",
  "capacity",
]);
export type AnalysisFailureClass = z.infer<typeof AnalysisFailureClassSchema>;

/**
 * terminal(failed/cancelled) 의 **기계 판독 사유**. 자유문 failureReason 과 달리 값이 유한하다.
 * 측정 lane 의 같은 어휘(`lib/measurement-ticket/contracts.ts`) — 2026-09-01 실증에서
 * "재제출하면 되는 실패"와 "영구 불능"이 `ticket_failed:failed` 로 뭉개진 것이 도입 계기다.
 */
export const AnalysisTerminalReasonSchema = z.enum([
  "cap_exhausted", // lane maxAttempts 소진 — 코어가 재발행하면 성공할 수 있다(원장 attempt ≤ 3)
  "deadline_exceeded",
  "permanent", // 계약 위반·명시 취소 등 재시도가 무의미
]);
export type AnalysisTerminalReason = z.infer<typeof AnalysisTerminalReasonSchema>;

/**
 * ⚠️ **DB 와 짝이다.** `analysis_call_usage.task` 에 같은 어휘의 CHECK 제약이 있다
 * (`migrations/0003_analysis_call_usage.sql:35` → `migrations/0009_call_usage_stance_task.sql`).
 * 여기만 넓히면 그 태스크의 콜 원장 INSERT 가 라이브에서 check violation 으로 죽는다 —
 * `tests/stance-contract.test.ts` 의 "task 어휘의 두 사본이 같다" 가 그것을 게이트한다.
 *
 * `stance` = `measurement.analysis.answer_brand_stance`(답변 단위 브랜드 스탠스).
 * **이 PR(WU2) 에서는 어휘만 넓힌다** — lane 이 그 태스크를 부르지 않는다(벤더 순수 코드에
 * 스탠스 패스가 아직 없다). 호출 배선은 WU6(벤더 재동기 + 송신).
 *
 * `semantics_shadow` = `measurement.analysis.mention_semantics_shadow`(감성 V2 섀도 병행 패스).
 * 앞의 넷과 성격이 다르다 — **코어에 없는, lane 이 만든 태스크 문자열**이다. 섀도 V2 호출의
 * 벤더 요청 task 는 현행과 같은 `mention_semantics` 인데(벤더 `llm.ts` 가 그렇게 보낸다),
 * 그대로 두면 V0 감성 비용과 섀도 비용이 **같은 원장 행 종류로 뭉개져** 수용 기준 6
 * ("섀도 비용이 따로 집계된다")을 판정할 수 없다. 그래서 PR-L2 에서 `withTaskOverride`
 * (`worker/engines/core-engine.ts`)로 원장 태스크만 갈아끼운다.
 * **모델·풀은 갈지 않는다** — `TASK_ROUTING_ALIAS`(`worker/llm-pools.ts`)가 `mention_semantics`
 * 라우팅을 그대로 태운다. 즉 "원장은 따로, 라우팅은 같이" 다.
 * 정본: `(내부 설계 문서)` §3.2.
 *
 * ⚠️ **PR-L1 에서는 어휘만 넓힌다** — seam 배선이 없어 lane 이 이 태스크를 아직 부르지 않는다
 *    (stance 가 WU2 에서 그랬던 것과 같은 자리). 그래도 지금 넓히는 이유는 0009 헤더와 같다:
 *    CHECK 와 zod 가 갈린 채로 배선이 붙으면 **LLM 실비가 나간 뒤** 원장 INSERT 가 죽는다.
 */
export const AnalysisTaskSchema = z.enum(["extract", "resolve", "semantics", "citation", "stance", "semantics_shadow"]);
export type AnalysisTask = z.infer<typeof AnalysisTaskSchema>;

// ---- 요청 -------------------------------------------------------------------

/**
 * 결과를 되찾는 좌표계. **`turnRunId` 가 원장 행의 키**다(스펙 §4.1 D1 — 티켓 1건 = 턴 1건).
 * `projectId` 는 컨텍스트 **캐시 네임스페이스** 힌트이지 정확성 근거가 아니다(§4.5).
 *
 * ⚠️ `projectId` 는 **nullable 이다.** 코어 발행부는 bare query_run(프로젝트 없는 측정)에서
 *    `null` 을 싣고 컨텍스트 네임스페이스로 `unscoped` 를 쓴다
 *    (코어 `analysis-ticket-submitter.ts:470` `projectId ?? "unscoped"`,
 *     `context-snapshot.ts:100`). 초판은 `z.guid()` 필수라 그 티켓을 400 으로 거부했다.
 * ⚠️ `attemptNumber` 상한 3 은 코어 원장의 재발행 상한(`ANALYSIS_TICKET_MAX_ATTEMPT`)이다 —
 *    4 이상이 오면 발행 측 결함이므로 계약이 먼저 막는다.
 */
export const AnalysisLineageSchema = z
  .object({
    workspaceId: z.guid(),
    projectId: z.guid().nullable().default(null),
    queryRunId: z.guid(),
    promptRunId: z.guid().nullable().default(null), // bare query_run = null (G9)
    turnRunId: z.guid(),
    turnIndex: z.number().int().min(1),
    attemptNumber: z.number().int().min(1).max(3).default(1),
  })
  .strict();
export type AnalysisLineage = z.infer<typeof AnalysisLineageSchema>;

/**
 * `store.ts` `context.catalog?.industry ?? UNSCOPED_INDUSTRY` 를 **실물 형태 그대로** 싣는다.
 *
 * ⚠️ 초판은 스펙 §4.3 표의 축약 표기 `{id|null, name}` 을 그대로 스키마로 옮겼다. 실제 타입
 *    `IndustryScopeContext`(벤더 `industry-context.ts:21`)는 `ids: string[]`(tracked-brand
 *    휴리스틱이 복수를 낼 수 있다) + `name: string|null` + `source` 다. 그 불일치가
 *    2026-09-13 라이브 400 의 직접 원인이었다:
 *      {"loc":["industry","id"],"msg":"expected string, received undefined"}
 *      {"loc":["industry"],"msg":"Unrecognized keys: \"ids\", \"source\""}
 *    lane 은 이 값을 순수 코드의 `AnalysisTurnContext.industry` 로 **그대로** 넘긴다 —
 *    합성하면(`ids[0]` 만 쓰거나 `source` 를 추론하면) 코어 인라인 경로와 입력이 갈린다.
 */
export const AnalysisIndustrySchema = z
  .object({
    ids: z.array(z.string()).default([]),
    name: z.string().nullable().default(null),
    source: z.enum(["project", "env", "tracked_brands", "none"]),
  })
  .strict();
export type AnalysisIndustry = z.infer<typeof AnalysisIndustrySchema>;

/**
 * 턴 1건. **배열이 아니다**(D1).
 *
 * ⚠️ 필드명 매핑: `promptText`/`answerText` 는 **턴 단위** 값이고 코어 DB 행의 필드명은
 * `turnPromptText`/`turnAnswerText` 다. 같은 행에 **쿼리 단위** `promptText` 가 따로 있으므로
 * 코어 어댑터가 `turnPromptText → promptText` 로 매핑한다. 빠뜨리면 멀티턴에서 1턴 프롬프트가
 * 전 턴에 실리는 **조용한 품질 저하**가 된다(스펙 §4.3).
 *
 * ⚠️ `rawResponse` 는 싣지 않는다 — 순수 코드의 유일한 소비처가 `turnHash` 이고 그 산출물이
 * `sourceTurnHash` 다. **코어가 계산해 실어 보내고 persist 에도 자기 값만 쓴다**(D4).
 * ⚠️ `citations[]` 도 싣지 않는다 — 순수 구간이 읽지 않고 `citationHostsToClassify[]` 와 중복이다.
 * `target`·`region` 은 **관측 전용**(순수 구간에서 로그 필드로만 쓰인다) — 동치성 판정 대상이 아니다.
 *
 * ⚠️ `answerText`·`region` 은 **nullable 이다.** 코어 발행부가 DB 행(`turn_answer_text`·
 *    `region`)을 그대로 싣고 그 컬럼은 NULL 을 허용한다(코어 `analysis-ticket-submitter.ts:497`).
 *    벤더된 순수 코드도 `answerText: string | null`·`region: string | null` 로 받는다
 *    (`pure/analyze-turn.ts:41,47`) — 초판의 `z.string()`/`.min(1)` 은 코어보다 좁아 400 을 만든다.
 */
export const AnalysisTurnSchema = z
  .object({
    turnRunId: z.guid(),
    turnIndex: z.number().int().min(1),
    promptText: z.string(),
    answerText: z.string().nullable().default(null),
    sourceTurnHash: z.string().min(1),
    target: z.string(),
    region: z.string().nullable().default(null),
  })
  .strict();
export type AnalysisTurn = z.infer<typeof AnalysisTurnSchema>;

/**
 * `<projectId|"unscoped">:<sha256(canonical JSON of {catalog, rels, grouping, trackedAugmentTargets})[:16]>`
 * **버전은 내용 해시다**(스펙 §4.5) — 네 소스 중 무엇이 바뀌어도 버전이 바뀐다.
 * stale 판정은 코어가 한다: lane 은 실린 버전을 그대로 쓰고 캐시에 없으면 `ref` 로 가져온다.
 *
 * ⚠️ **접두사는 uuid 가 아닐 수 있다.** 초판 정규식(`^[0-9a-fA-F-]{36}:…`)은 bare query_run 의
 *    `unscoped:<hash>` 를 거부했다(코어 `context-snapshot.ts:100` `${projectId ?? "unscoped"}`).
 *    코어 계약은 `z.string().min(1)` 이므로 여기서도 같은 폭으로 받는다. 모양 판정이 필요한
 *    자리(캐시 네임스페이스 파생)는 `parseContextVersionProjectId` 가 맡는다 —
 *    **계약이 아니라 저장 계층의 책임**이다. 초판의 `ANALYSIS_CONTEXT_VERSION_RE` 는
 *    **지웠다**: 쓰이지 않는 채로 남으면 다음 사람이 그것을 다시 스키마에 붙인다.
 *
 * ── `parseContextVersionProjectId`
 *
 * `contextVersion` 접두사에서 프로젝트 id 를 뽑는다 — **uuid 일 때만.**
 * `unscoped:<hash>` 처럼 uuid 가 아니면 `null`(= 프로젝트 네임스페이스 없음)이다.
 * 이 값이 그대로 `analysis_contexts.project_id`(uuid) 에 들어가므로, 문자열을 그대로 넣으면
 * `invalid input syntax for type uuid` 로 캐시 적재 트랜잭션이 죽는다.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseContextVersionProjectId(contextVersion: string): string | null {
  const head = contextVersion.split(":")[0] ?? "";
  return UUID_RE.test(head) ? head : null;
}

/**
 * `https` 이거나 루프백 호스트의 `http` 뿐. **`callbackUrl` 과 같은 좁힘이고 같은 이유다.**
 *
 * ⚠️ 이쪽이 더 급하다: lane 은 이 주소로 요청을 보낼 때 **내부 토큰**
 * (`x-scope-internal-token`, `worker/context-cache.ts` `#fetch`)을 헤더에 붙인다. 즉 `ref` 가
 * `http://10.0.0.5/…` 나 임의 외부 호스트면 **워크스페이스 전체 카탈로그를 여는 열쇠가 평문으로
 * 그 주소에 배달된다** — 콜백(doorbell, 본문 없음)보다 노출이 크다. 초판은 `z.url()` 이라
 * `http://`·`ftp://`·`file://` 가 전부 통과했다.
 *
 * 정상 트래픽을 거부하지 않는다: 코어 발행부는 `analysisContextRef(cfg.contextBaseUrl, …)` 로
 * 자기 env 베이스에 경로만 붙이고(코어 `lib/measurement-analysis-ticket/context-snapshot.ts:116`),
 * 그 베이스는 `ANALYSIS_LANE_CONTEXT_BASE_URL`(미설정 시 `APP_BASE_URL`) = https CloudFront 다
 * (코어 `infra/stacks/measurement-worker-stack.ts:636`). 코어 픽스처가 통과하는지는
 * `tests/contracts.test.ts` 의 교차 픽스처 가드가 매 CI 마다 재확인한다.
 *
 * ⚠️ `callbackUrl` 과 마찬가지로 **이 좁힘은 코어 env 를 검사하지 못한다** — 아래
 * `callbackUrl` 주석의 "env 가드 의존" 을 함께 읽을 것.
 */
/** compose 로컬 스택용. `analysis-api`·`host.docker.internal` 은 컨테이너 네트워크의 루프백이다. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1", "analysis-api", "host.docker.internal"];
export function isLaneSafeUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  if (u.protocol !== "http:") return false;
  return LOOPBACK_HOSTS.includes(u.hostname);
}

export const AnalysisContextRefSchema = z
  .object({
    ref: z.url().refine(isLaneSafeUrl, "context.ref must be https (http only on a loopback host)"),
    contextVersion: z.string().min(1),
  })
  .strict();
export type AnalysisContextRef = z.infer<typeof AnalysisContextRefSchema>;

/**
 * 경계 원칙: "어떻게"는 티켓에 없다. `options` 에 숨겨 넣는 것도 막는다.
 * 측정 lane `contracts/v1.py` `_no_execution_fields` 의 동형 — 거기서는 프록시·계정·엔진이고,
 * 여기서는 모델·공급자 풀·동시성·재시도다. 있으면 경계가 샌다(스펙 §4.3 "없는 것").
 */
export const BANNED_OPTION_KEYS = [
  "apiKey",
  "baseUrl",
  "concurrency",
  "maxAttempts",
  "maxInflight",
  "model",
  "modelId",
  "modelSlug",
  "pool",
  "poolKey",
  "poolWeights",
  "provider",
  "retryPolicy",
  "temperature",
  "timeoutMs",
] as const;

/**
 * `ResolvedAnalysisOptions` — `resolveAnalysisOptions` 산출물 전체를 **코어가 확정해 보낸다**.
 * 라이브에서 unknown_discovery 를 끄는 게이트가 코어에 남아야 lane 이 정책을 바꿀 수 없다.
 *
 * ⚠️ 초판은 `z.record(z.string(), z.unknown())` + `BANNED_OPTION_KEYS` superRefine 이었다.
 *    코어 정본은 **11필드 `.strict()` 객체**이고, 그쪽이 더 좁다 — 실행 필드는 물론이고
 *    오타난 옵션 키까지 거부한다. 즉 `BANNED_OPTION_KEYS` 는 `.strict()` 에 흡수됐다
 *    (상수는 경계 문서·테스트 모수로 남긴다). 필드 이름이 코어와 갈리면 lane 이 400 을
 *    내므로 드리프트가 조용히 지나가지 않는다.
 */
export const ResolvedAnalysisOptionsSchema = z
  .object({
    analysisVersion: z.string().min(1),
    promptVersion: z.string().min(1),
    parserVersion: z.string().min(1),
    resolverVersion: z.string().min(1),
    enableLlmMentionExtraction: z.boolean(),
    enableLlmPendingResolver: z.boolean(),
    enableLlmUnknownDiscovery: z.boolean(),
    enableLlmMentionSemantics: z.boolean(),
    enableShortAliasLlmGate: z.boolean(),
    enableTrackedBrandAugment: z.boolean(),
    followUpMode: z.string().min(1),
    /**
     * 답변 단위 브랜드 스탠스 패스 게이트(스펙 §4.1 · 12번째 필드).
     * 정본: `(내부 설계 문서)`
     *
     * ⚠️ **`.default(false)` 다 — 다른 11필드처럼 required 로 두면 안 된다.** §8.0 이 강제하는
     *    순서가 "요청 `options` 는 **lane 이 먼저** 넓힌다" 이기 때문이다: 코어 WU1/WU3 이
     *    머지되기 전까지 라이브 코어는 **11필드만** 보낸다. required 로 두면 그 창의 모든
     *    티켓이 `options.enableLlmAnswerBrandStance: Required` 로 **400** 이 된다 — 넓히려다
     *    lane 을 통째로 세우는, 2026-09-13 `industry` 전량 400 과 같은 모양의 사고다.
     *
     * 값이 true 로 들어와도 **이 PR 에서는 아무 동작도 하지 않는다**: 벤더 순수 코드에 스탠스
     * 패스가 없고, `core-engine.ts` 가 이 객체를 벤더 `AnalysisOptionsSchema`(strict 아님 →
     * 모르는 키는 strip)로 한 번 더 파싱해 넘기므로 순수 코드까지 닿지도 않는다. 켜지는 것은
     * WU3(코어 순수 구현) + WU6(벤더 재동기) 뒤다.
     *
     * ⚠️ 코어가 이 필드를 **실제로 보내기 시작하면**(WU3) `.default(false)` 를 걷어내고
     *    `z.boolean()` 으로 좁혀라 — 그래야 발행부가 필드를 떨어뜨린 것이 드러난다
     *    (`tests/contracts.test.ts` "코어에 있는 키가 빠져도 거부된다" 의 취지).
     */
    enableLlmAnswerBrandStance: z.boolean().default(false),
    /**
     * 발생 단위 감성 V2 게이트(13번째 필드). 코어 `ResolvedAnalysisOptionsSchema` 와 같은 이름·타입.
     *
     * ⚠️ **`.optional()` 이다. `.default(false)` 가 아니다.** 코어 제출기는 이 키를 값이 true 일
     *    때만 싣는다(off 면 키 자체 생략). 그래서 라이브 티켓의 대부분은 키가 없고, lane 이 기본값을
     *    주입하면 파싱 결과에만 키가 생겨 코어 픽스처와의 키 집합 비교(`stance-contract.test.ts`
     *    "키 집합이 정확히 같다")가 깨진다. 부재는 부재로 둔다.
     *
     * 배포 순서상 이 수용이 코어 발행보다 **먼저** 나가야 한다: `.strict()` 라 lane 이 모르는 키를
     * 코어가 싣는 순간 그 티켓은 400 이다. 값은 엔진 옵션으로 넘기지만(`core-engine.ts`), 벤더
     * 순수 코드에 V2 경로가 들어오는 것은 코어 머지 후 벤더 재동기 PR 이다.
     */
    enableLlmMentionSemanticsV2: z.boolean().optional(),
    /**
     * 발생 단위 감성 **V2 섀도 병행** 게이트(14번째 필드). 코어 `ResolvedAnalysisOptionsSchema` 와
     * 같은 이름·타입으로 추가된다(코어 PR-C1).
     * 정본: `(내부 설계 문서)` §3.1·§3.2.
     *
     * 위 13번째 필드(`enableLlmMentionSemanticsV2`)와 **다른 축이다.** 그쪽은 semantics 패스를
     * **대체**하고(V2 값이 `sentiment` 를 치환한다), 이쪽은 V0 패스를 그대로 둔 채 V2 를 **추가로**
     * 돌려 `extractionMetadata` 의 shadow 키로만 병기한다. 둘이 동시에 true 면 대체가 이기고
     * 섀도는 무의미하다(그 규칙의 정본은 코어 순수 계층이다 — lane 은 판정하지 않는다).
     *
     * ⚠️ **`.optional()` 이다. `.default(false)` 가 아니다.** 13번째 필드와 같은 이유 그대로:
     *    코어 제출기는 이 키를 값이 true 일 때만 싣는다(off 면 키 자체 생략). lane 이 기본값을
     *    주입하면 파싱 결과에만 키가 생겨 코어 픽스처와의 키 집합 비교
     *    (`stance-contract.test.ts` "키 집합이 정확히 같다")가 깨진다. 부재는 부재로 둔다.
     *
     * 배포 순서상 이 수용이 코어 발행보다 **먼저** 나가야 한다: `.strict()` 라 lane 이 모르는 키를
     * 코어가 싣는 순간 그 티켓은 400 이다(플랜 §4 의 PR-L1 이 1번인 이유). 값이 true 로 들어와도
     * **PR-L1 에서는 아무 동작도 하지 않는다**: 벤더 순수 코드에 섀도 분기가 없고,
     * `core-engine.ts` 가 이 객체를 벤더 `AnalysisOptionsSchema`(strict 아님 → 모르는 키는 strip)로
     * 한 번 더 파싱해 넘기므로 순수 코드까지 닿지도 않는다. 켜지는 것은 코어 PR-C1 + PR-L2(벤더 재동기) 뒤다.
     */
    enableLlmMentionSemanticsV2Shadow: z.boolean().optional(),
  })
  .strict();
export type ResolvedAnalysisOptions = z.infer<typeof ResolvedAnalysisOptionsSchema>;

export const AnalysisTicketRequestSchema = z
  .object({
    version: z.literal(1).default(1),
    ticketId: z.guid(), // §4.2 uuid5. Idempotency-Key 헤더와 동일값
    traceId: z.guid(),
    lineage: AnalysisLineageSchema,
    analysisVersion: z.string().min(1), // 코어 소유. lane 은 그대로 에코한다
    industry: AnalysisIndustrySchema,
    options: ResolvedAnalysisOptionsSchema,
    turn: AnalysisTurnSchema,
    context: AnalysisContextRefSchema,
    // 코어가 **미분류 호스트만** 선별해 보낸다. 그 query_run 의 호스트 전량을 `turnIndex` 가
    // 가장 작은 턴의 티켓에만 싣고 나머지 턴 티켓은 빈 배열이다(§4.3) — 없으면 같은 호스트를
    // 턴 수만큼 LLM 으로 분류한다.
    citationHostsToClassify: z.array(z.string().min(1)).default([]),
    deadlineAt: z.iso.datetime(), // 이 시각까지 못 끝내면 deferred. 기본 6h
    priority: AnalysisPrioritySchema.default("scheduled"),
    // doorbell 신호용. 본문은 GET reply 로 되읽는다.
    // ⚠️ **스킴을 좁힌다**(측정 lane 정본): `https` 이거나, 루프백 호스트의 `http` 뿐이다.
    //    `z.url()` 만으로는 `http://10.0.0.5/...`·`file://`·`ftp://` 가 전부 통과하고, lane 은 그
    //    URL 로 **실제 요청을 보내는 주체**다(콜백 펌프). 즉 티켓 하나로 lane 을 임의 평문 호출의
    //    발신자로 쓸 수 있다 — 티켓은 코어만 보내지만, 계약이 막을 수 있는 것을 운영 신뢰로
    //    미루지 않는다. http 루프백을 남기는 것은 compose 로컬 스택 때문이다.
    //
    // ⚠️ **이 좁힘이 막는 것은 "lane 이 평문으로 나가는 것" 이지 "코어가 평문을 설정하는 것" 이
    //    아니다.** 코어 `analysisCallbackUrl(base, workspaceId)`(context-snapshot.ts:131)은
    //    `new URL(base)` 에 `?w=` 만 붙여 돌려준다 — **스킴을 검사하지 않고 그대로 전파한다.**
    //    즉 누가 `ANALYSIS_LANE_CALLBACK_URL=http://internal-host/...` 로 배선하면 코어는 아무
    //    말 없이 그 URL 을 티켓에 싣고, lane 은 여기서 400 으로 거부한다 → **접수 전량 실패**가
    //    되고 로그에는 계약 위반만 남는다(원인은 코어 env 오타인데 "lane 이 티켓을 거부한다" 로
    //    읽힌다). 같은 말이 `context.ref` 에도 그대로다(`ANALYSIS_LANE_CONTEXT_BASE_URL`).
    //    → 스킴의 정본 가드는 **코어 env** 다. 이 계약은 그 가드가 틀렸을 때의 안전망이고,
    //      막았다는 사실이 400 으로 시끄럽게 드러나는 것이 설계의 일부다(조용한 평문 송신보다 낫다).
    callbackUrl: z
      .url()
      .refine(isLaneSafeUrl, "callbackUrl must be https (http only on a loopback host)")
      .nullable()
      .default(null),
  })
  .strict()
  // ── 코어 계약에 **없는** lane 전용 좁힘 세 가지. 유지하는 근거를 여기 박아 둔다.
  //
  //   ① `callbackUrl` 스킴 좁힘(위) — lane 이 그 URL 로 실제 요청을 보내는 주체다(SSRF 면).
  //      코어 발행부는 `analysisCallbackUrl(cfg.callbackUrl, workspaceId)` 로 자기 env 의
  //      https 베이스만 쓴다 → 정상 트래픽을 거부하지 않는다.
  //   ①' `context.ref` 스킴 좁힘(`AnalysisContextRefSchema`) — 같은 면이고 **노출은 더 크다**:
  //      lane 이 그 주소로 갈 때 내부 토큰을 헤더에 싣는다. 코어 발행부는
  //      `analysisContextRef(cfg.contextBaseUrl, …)` 로 같은 성격의 env 베이스만 쓴다.
  //   ② 아래 턴 좌표 일치 — 코어 발행부가 **같은 행**에서 둘을 만든다
  //      (`analysis-ticket-submitter.ts:492`(`ticketTurn`)·`:528`(`lineage`) 둘 다
  //      `turn.turn_index`/`row.turnRunId`) → 정상 트래픽에서 어긋날 수 없다.
  //
  //   즉 둘 다 **코어가 만들 수 있는 값을 거부하지 않는다**. 그래서 계약 드리프트가 아니라
  //   lane 쪽 안전망으로 남긴다 — 교차 픽스처 가드(`tests/contracts.test.ts`)가 이 전제를
  //   코어 픽스처로 매 CI 마다 재확인한다.
  .superRefine((r, ctx) => {
    // 티켓 1건 = 턴 1건이므로 lineage 와 turn 의 턴 좌표가 갈리면 안 된다.
    if (r.turn.turnRunId !== r.lineage.turnRunId) {
      ctx.addIssue({ code: "custom", path: ["turn", "turnRunId"], message: "turn.turnRunId must equal lineage.turnRunId" });
    }
    if (r.turn.turnIndex !== r.lineage.turnIndex) {
      ctx.addIssue({ code: "custom", path: ["turn", "turnIndex"], message: "turn.turnIndex must equal lineage.turnIndex" });
    }
  });
export type AnalysisTicketRequest = z.infer<typeof AnalysisTicketRequestSchema>;

/** API 층이 호출하는 단독 검증 진입점. 실패 → 400 (측정 `parse_ticket_request_v1` 동형). */
export function parseAnalysisTicketRequestV1(payload: unknown): AnalysisTicketRequest {
  return AnalysisTicketRequestSchema.parse(payload);
}

// ---- 응답 -------------------------------------------------------------------

export const AnalysisTicketAcceptedSchema = z
  .object({
    ticketId: z.guid(),
    status: z.literal("queued"),
    acceptedAt: z.iso.datetime(),
    idempotentReplay: z.boolean().default(false), // 같은 ticketId 재전송이면 true (실행은 1회)
  })
  .strict();
export type AnalysisTicketAccepted = z.infer<typeof AnalysisTicketAcceptedSchema>;

/**
 * 상태 조회용 deferred 뷰 — **절대 시각**(`nextEligibleAt`)을 준다.
 * 답장(reply)의 deferred 는 **상대 시각**(`retryAfterMs`)이다(스펙 §4.4 필드 표). 두 곳의
 * 자료형이 다른 것은 의도다: 답장은 워커가 "얼마나 뒤에" 를 판정한 값이고, 상태는 원장이
 * 계산해 둔 "언제부터" 다.
 */
export const AnalysisDeferredViewSchema = z
  .object({
    failureClass: AnalysisFailureClassSchema,
    nextEligibleAt: z.iso.datetime(),
    attemptCount: z.number().int().min(1),
    detail: z.string().max(512).nullable().default(null), // 시크릿·답변 본문 금지
  })
  .strict();

export const AnalysisTicketStatusViewSchema = z
  .object({
    ticketId: z.guid(),
    status: AnalysisTicketStatusSchema,
    updatedAt: z.iso.datetime(),
    deferred: AnalysisDeferredViewSchema.nullable().default(null),
  })
  .strict();
export type AnalysisTicketStatusView = z.infer<typeof AnalysisTicketStatusViewSchema>;

// ---- 답장 -------------------------------------------------------------------

/**
 * ⚠️ **G3-2 가 좁힌다.** `quality`·`mentions[]`·`candidates[]`·`extractionMetadata` 의 실제 모양은
 * 순수 분석 코드(`@scope/analysis-core`)가 소유한다. 그 패키지가 생기기 전까지는 불투명 레코드로
 * 둔다 — 여기에 추측한 필드를 박으면 엔진 이식 때 계약이 두 번 바뀐다.
 * 단 `extractionMetadata` 는 **패키지화 이후에도 자유 JSON 으로 남는다**(스펙 §5.4).
 */
const OpaqueRecord = z.record(z.string(), z.unknown());

// ── G3-2 가 좁힌 자리 ────────────────────────────────────────────────────────
//
// G3-1 은 `quality`·`mentions[]`·`candidates[]` 를 불투명 레코드로 뒀다 — 실제 모양을 가진
// 순수 패키지가 아직 lane 에 없었기 때문이다("지금 추측한 필드를 박으면 계약이 두 번 바뀐다").
// 이제 그 패키지가 `packages/analysis-core/vendor` 에 있으므로 **추측이 아니라 소스에서** 좁힌다.
//
// ⚠️ **어휘는 손으로 다시 적지 않고 벤더 스키마에서 가져온다.** enum 값을 여기 복사하면
//    그 순간 어휘가 두 벌이 되고, 코어가 `mentionRole` 을 하나 늘릴 때 lane 이 조용히 거부한다
//    (= 분석 전멸). 벤더는 sha256 으로 핀돼 있으니 이 import 가 곧 "코어 어휘 그대로" 다.
//
// 좁힘의 모수는 **`persistTurnAnalysis` 가 실제로 읽는 것 전부**다(코어 `store.ts:3057~`,
// `persistTurnResult:787~`): quality(3필드) · mentions[] · candidates[] · modelSlug ·
// extractionMetadata · sourceTurnHash · 버전 4종. 버전 4종은 G3-1 계약에 **없었다** —
// `measurement_turn_analysis` 의 `analysis_version`·`prompt_version`·`parser_version`·
// `resolver_version` 컬럼이 그 값을 받으므로, 빠지면 코어가 채울 값이 없다.
//
// `extractionMetadata`(턴·멘션·후보 셋 다)와 `metricImpact` 는 **자유 JSON 으로 남는다**
// (스펙 §5.4) — 코어 `store.ts:896~952` 가 자유 키를 채우는 자리다.
/** 코어 `AnswerQualityResult`(schema.ts:266~270). persist 가 3필드를 컬럼으로 쓴다. */
export const AnalysisQualitySchema = z
  .object({
    qualityState: AnswerQualityStateSchema,
    reason: z.string(),
    answerChars: z.number().int().min(0),
  })
  .strict();

/**
 * 코어 `MeasurementMention`(schema.ts:272~295). **오프셋은 이미 `finalizeMentionOffsets` 를
 * 통과한 값**이다(`OFFSET_BASIS = "codepoint"`, offsets.ts:35) — lane 이 다시 손대지 않는다.
 */
export const AnalysisMentionSchema = z
  .object({
    entityId: z.string().nullable(),
    entityType: EntityTypeSchema.nullable(),
    surfaceText: z.string(),
    surfaceLanguage: z.string().optional(),
    surfaceNormalized: z.string(),
    surfaceHash: z.string(),
    sourceStart: z.number().int().min(0).optional(),
    sourceEnd: z.number().int().min(0).optional(),
    resolutionStatus: ResolutionStatusSchema,
    resolutionMethod: ResolutionMethodSchema,
    resolutionConfidence: z.number(),
    mentionPosition: z.number().int(),
    mentionRole: MentionRoleSchema,
    assertion: MentionAssertionSchema,
    sentiment: MentionSentimentSchema,
    rank: z.number().int().optional(),
    rankGroup: z.string().optional(),
    contextSnippet: z.string(),
    descriptors: z.array(z.string()),
    criteria: z.array(z.string()),
    extractionMetadata: OpaqueRecord,
  })
  .strict();

/** 코어 `MeasurementCandidate`(schema.ts:296~310). */
export const AnalysisCandidateSchema = z
  .object({
    candidateKind: CandidateKindSchema,
    signature: z.string(),
    surfaceText: z.string(),
    surfaceNormalized: z.string(),
    surfaceVariants: z.array(z.string()),
    suggestedEntityType: EntityTypeSchema.optional(),
    suggestedEntityId: z.string().optional(),
    suggestedRelationshipType: z.string().optional(),
    suggestedTargetEntityId: z.string().optional(),
    confidence: z.number().optional(),
    conflictReason: z.string().optional(),
    answerSnippets: z.array(z.string()),
    metricImpact: OpaqueRecord,
  })
  .strict();

/**
 * 브랜드별 **속성** 스탠스 1건 (운영 결정 2026-09-15). 코어
 * `AnalysisReplyStanceAspectSchema` 의 사본이고 상한 상수도 **같은 출처**(벤더 `schema.ts`)를
 * 쓴다 — 숫자를 손으로 옮겨 적으면 코어가 상한을 바꿀 때 조용히 갈린다.
 *
 * ⚠️ 키가 **snake_case** 다(다른 계약 필드는 camelCase). 코어 주석의 근거를 그대로 옮기면:
 *    관계형 컬럼이 아니라 **jsonb 블롭 원소**라 이 코드베이스의 jsonb 관례를 따른다.
 *    camelCase 로 "정리" 하면 코어 `.strict()` 가 전량 튕긴다.
 */
export const AnalysisAnswerBrandStanceAspectSchema = z
  .object({
    aspect: z.string().min(1).max(STANCE_ASPECT_LABEL_CAP),
    stance: MentionSentimentSchema,
    evidence_text: z.string().nullable().default(null),
    evidence_start: z.number().int().min(0).nullable().default(null),
    evidence_end: z.number().int().min(0).nullable().default(null),
    evidence_verified: z.boolean(),
  })
  .strict()
  // 브랜드 evidence 와 **같은 불변식**(FR4). 순수 계층 `verifyEvidence` 가 이미 이 규칙으로
  // 만들지만(0회·2회 매치면 둘 다 null), 여기서 한 번 더 막는 것은 마지막 방어선이다.
  .refine(
    (a) =>
      (a.evidence_start == null && a.evidence_end == null) ||
      (a.evidence_start != null && a.evidence_end != null && a.evidence_end > a.evidence_start),
    {
      message: "evidence_start/evidence_end 는 **둘 다 null 이거나** end > start 여야 한다",
      path: ["evidence_start"],
    },
  );
export type AnalysisAnswerBrandStanceAspect = z.infer<typeof AnalysisAnswerBrandStanceAspectSchema>;

/**
 * 답변 단위 브랜드 스탠스 1건 = **(턴 × 브랜드 롤업 엔티티)**. 발생 단위 감성
 * (`AnalysisMentionSchema.sentiment`)과 **어휘는 같고 단위가 다르다**(스펙 FR2 · R6).
 * 필드 목록의 정본은 코어 `AnalysisReplyStanceSchema`(스펙 §8.2 WU1) 이고 여기는 사본이다.
 *
 * ⚠️ **코어보다 넓으면 안 된다.** 코어 `AnalysisReplyTurnSchema` 는 `.strict()` 라, lane 이
 *    코어가 모르는 필드를 하나라도 실으면 그 티켓은 `output_contract` 로 종결된다 —
 *    완주한 분석이 통째로 버려진다(`modelSlug` 위 주석의 버전 4종 사고와 같은 경로).
 *
 * ⚠️ **WU6(2026-09-15)에서 `modelSlug`·`aspects` 를 더했다.** 코어가 WU1 에서 먼저 넓혀 두고
 *    (`modelSlug` optional · `aspects` default([])) lane 이 지금 채운다 — §8.0 의 "답장은 받는
 *    쪽을 먼저 넓힌다" 순서를 지킨 결과다. 대조 기준은 코어 `AnalysisReplyStanceSchema`
 *    @ Kongventures/scope `6a5e67a9`(= 벤더 핀과 같은 커밋).
 */
export const AnalysisAnswerBrandStanceSchema = z
  .object({
    /** 브랜드 **롤업** 엔티티. 멘션 엔티티가 아니다(스펙 §3.1 — 제품 멘션 5건이 같은 브랜드면 1행) */
    entityId: z.guid(),
    /** 프롬프트에 실제로 넘긴 이름 — 모델이 돌려준 키를 되짚는 축 */
    brandLabel: z.string().min(1),
    isTracked: z.boolean(),
    stance: MentionSentimentSchema,
    /**
     * ⚠️ **범위를 코어와 같게 좁힌다.** 초판은 `z.number()` 무제한이었다 — lane 이 코어보다
     *    **넓은** 유일한 자리였고, 그 방향이 정확히 위험한 쪽이다: WU6 에서 모델이 `1.5` 를
     *    돌려주면 lane 은 통과시키고 코어 `AnalysisReplyStanceSchema`(`.min(0).max(1)`)가
     *    **답장 전체를 `output_contract` 로 거부**한다 — 스탠스 하나 때문에 완주한 턴 분석을
     *    통째로 버린다. 코어 WU1 정본 실측: `contracts.ts` @ Kongventures/scope `8ee0f619`
     *    `confidence: z.number().min(0).max(1).nullable().default(null)`.
     */
    confidence: z.number().min(0).max(1).nullable().default(null),
    evidenceText: z.string().nullable().default(null),
    /** 코드포인트 오프셋. 0회·2회 이상 매치면 **둘 다 null**(FR4 — 지어내지 않는다) */
    evidenceStart: z.number().int().min(0).nullable().default(null),
    evidenceEnd: z.number().int().min(0).nullable().default(null),
    reason: z.string().nullable().default(null),
    /** 그 스탠스를 만든 모델 slug (FR3). 코어가 `.optional()` 로 받는다(WU2 하위호환). */
    modelSlug: z.string().nullable().optional(),
    extractionMetadata: OpaqueRecord.default({}),
    /** 브랜드별 속성 스탠스 0~8개. 부재는 `.default([])` 가 흡수한다(코어와 같은 모양). */
    aspects: z.array(AnalysisAnswerBrandStanceAspectSchema).max(STANCE_ASPECT_CAP).default([]),
  })
  .strict()
  // ⚠️ **오프셋 쌍 불변식 — 코어와 같은 refine 이어야 한다.**
  //    FR4 는 "원문에서 정확히 1회 찾히면 둘 다 적고, 아니면 **둘 다 null**" 이다. 즉
  //    `{5, null}`·`{null, 5}` 같은 **반쪽 쌍**과 `{5,5}`·`{5,4}` 같은 빈/역전 구간은
  //    계약상 존재할 수 없는 값이다. lane 이 그것을 통과시키면 코어
  //    `AnalysisReplyStanceSchema`(`.refine`, Kongventures/scope `9d24950b`
  //    `contracts.ts:363-375`)가 **답장 전체를 `output_contract` 로 거부**한다 —
  //    스탠스 하나 때문에 완주한 턴 분석을 통째로 버린다(confidence 범위와 같은 경로).
  //
  //    `end > start`(≥ 가 아니다): 빈 구간은 인용이 아니고, 하이라이트가 0폭이 된다.
  .refine(
    (s) =>
      (s.evidenceStart == null && s.evidenceEnd == null) ||
      (s.evidenceStart != null && s.evidenceEnd != null && s.evidenceEnd > s.evidenceStart),
    {
      message: "evidenceStart/evidenceEnd 는 **둘 다 null 이거나** end > start 여야 한다",
      path: ["evidenceStart"],
    },
  );
export type AnalysisAnswerBrandStance = z.infer<typeof AnalysisAnswerBrandStanceSchema>;

export const AnalysisResultTurnSchema = z
  .object({
    turnRunId: z.guid(),
    quality: AnalysisQualitySchema,
    // 오프셋이 이미 `finalizeMentionOffsets` 를 통과한 값(OFFSET_BASIS = "codepoint")
    mentions: z.array(AnalysisMentionSchema).default([]),
    candidates: z.array(AnalysisCandidateSchema).default([]),
    // 답변 단위 브랜드 스탠스. **WU6(2026-09-15)에서 `.optional()` → `.default([])`.**
    //
    // WU2 가 `.optional()` 이었던 이유는 코어가 그 키를 몰랐기 때문이다: `worker/main.ts:201
    // parseReply` 가 **나가는 본문**을 이 스키마로 통과시키므로 default 면 zod 가 빈 배열을
    // 주입해 모든 답장에 키가 붙고, 코어 `.strict()` 가 전량 `output_contract` 로 튕겼다(RK1).
    // 이제 코어 `AnalysisReplyTurnSchema` 가 `answerStances: z.array(...).default([])` 로 받으므로
    // (Kongventures/scope `6a5e67a9`) 키가 실려도 안전하고, `.default([])` 쪽이 낫다 —
    // "안 실은 것" 과 "빈 것" 이 같은 값이 되어 소비 측에 `undefined` 분기가 사라진다.
    answerStances: z.array(AnalysisAnswerBrandStanceSchema).default([]),
    // ⚠️ **버전 4종은 여기 없다.** G3-2 가 "persist 가 읽는 값" 이라며 넣었는데, 코어 정본
    //    (`AnalysisReplyTurnSchema`)은 그 넷을 **의도적으로 뺐고** `.strict()` 다 — 즉 lane 이
    //    실어 보내면 코어 클라이언트가 reply 파싱에서 `Unrecognized key` 로 튕기고, 그 티켓은
    //    `output_contract` 로 종결된다(완주한 분석이 통째로 버려진다). 코어 persist 는 자기가
    //    보낸 `options` 값을 쓴다(`store.ts:1136~1143` `analysisVersion: options.analysisVersion`).
    //    lane 이 되돌려 보낸 값을 믿으면 버전이 lane 쪽에서 드리프트할 수 있기 때문이다.
    // 코어 타입은 `modelSlug?: string` 이다 — JSON 경계에서 `undefined` 는 사라지므로
    // null 로 받는다(persist 는 둘 다 NULL 컬럼으로 쓴다).
    modelSlug: z.string().nullable().default(null),
    extractionMetadata: OpaqueRecord.default({}),
    // **요청값 에코**(D4). persist 에 쓰이는 값이 아니다 — 코어는 자기가 계산한 값을 쓰고,
    // 불일치는 `log.warn("analysis_lane.hash_echo_mismatch")` + 카운터로만 처리한다.
    sourceTurnHash: z.string().min(1),
    failed: z.boolean().default(false),
    // ⚠️ 코어 정본은 **자유 JSON**(`z.record(z.string(), z.unknown())`)이다. 초판의
    //    `z.string().max(512)` 로 문자열을 보내면 코어가 `Invalid input: expected record` 로 튕긴다.
    failureDetail: OpaqueRecord.nullable().default(null),
  })
  .strict();
export type AnalysisResultTurn = z.infer<typeof AnalysisResultTurnSchema>;

export const CitationClassificationSchema = z
  .object({
    host: z.string().min(1),
    // ⚠️ **카테고리도 좁혔다.** G3-1 은 `z.string().min(1)` 이었고 픽스처가 `"government"`·
    //    `"media"` 로 적혀 있었는데, 코어 어휘는 `"Government"`·`"Auto media"` 다
    //    (`CitationCategorySchema`). 자유 문자열로 두면 대소문자·오탈자가 코어 캐시에 그대로
    //    적재되고, 그 캐시는 `ON CONFLICT (workspace_id, host) DO NOTHING` 이라 **한 번 잘못
    //    들어가면 안 고쳐진다**.
    category: CitationCategorySchema,
    subcategory: z.string().nullable().default(null),
    // ⚠️ `"default"` 는 G3-1 에 **없었다.** 코어 `resolveCitationDomain` 은 LLM 호출·파싱이
    //    실패하면 `method: "default"` 로 `Other` 를 돌려준다(citation-classify.ts:308·:329) —
    //    던지지 않는다. 어휘에서 빼 두면 그 정상 경로가 reply 검증에서 죽어 **티켓 전체가
    //    output_contract 로 종결**된다(인용 분류 하나 때문에 턴 분석을 통째로 버린다).
    method: z.enum(["table", "llm", "default"]),
    modelSlug: z.string().nullable().default(null),
  })
  .strict();

export const AnalysisResultSchema = z
  .object({
    turn: AnalysisResultTurnSchema,
    // 코어가 `ON CONFLICT DO NOTHING` 으로 적재한다 — **캐시의 주인은 코어**(스펙 §5.3)
    citationClassifications: z.array(CitationClassificationSchema).default([]),
  })
  .strict();

/**
 * **행 1개 = 업스트림 LLM 콜 1회.** 태스크별 집계가 아니다 — 한 태스크 안에서 `withRetry`
 * 재시도와 **풀 페일오버**(429 → 다른 풀)가 콜 단위로 일어나고, 합치면 GB 가 엉뚱한 풀에
 * 붙어 단가가 잘못 배정된다(마이그레이션 0003 머리말 — 측정 lane 0014 의 교훈 이식).
 *
 * ⚠️ **이것은 lane 원장(`analysis_call_usage`) 전용이다. 답장에 이 모양으로 싣지 않는다.**
 *    G3-2 는 한 스키마로 둘을 겸했는데, 코어 정본 `AnalysisLlmUsageSchema` 는 8필드
 *    `.strict()` 라 `outcome`·`costSource`·`httpStatus`·`errorClass`·`startedAt`·`finishedAt`
 *    가 붙어 있으면 reply 파싱이 통째로 튕긴다(= 완주한 분석이 `output_contract` 로 버려진다).
 *    답장으로 나갈 때는 `toReplyUsage()` 가 코어 모양으로 투영한다. 운영 장부(풀별 낭비·
 *    429 비율·단가 출처)는 여기 남는 값이 정본이고, 그 축들은 lane 밖으로 나가지 않는다.
 */
/**
 * "정수여야 하지만 **비정수를 거부하지는 않는** 축" — 들어오기 전에 반올림한다.
 * 최종 검사는 그대로 `.int().min(min)` 이라 **의도(정수)는 스키마에 남는다**.
 * 왜 거부가 아니라 반올림인가는 `toReplyUsage` 머리말 참조(완주한 분석을 버리지 않는다).
 */
const intish = (min: number) =>
  z.preprocess(
    (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : v),
    z.number().int().min(min),
  );

export const AnalysisCallUsageSchema = z
  .object({
    task: AnalysisTaskSchema,
    poolKey: z.string().min(1), // `cost_ledger.model_id` 에 풀을 포함시키기 위한 축
    modelId: z.string().min(1),
    // ⚠️ **null = 미계측이다. 0 이 아니다.** 응답이 usage 를 안 주는 경우가 있고, 그때 0 을
    //    넣으면 비용·토큰이 조용히 과소 집계된다(0003 의 NULL 규율·측정 `EvidenceV1` 과 동일).
    // ⚠️ 정수 축은 **비정수를 거부하지 않고 반올림한다**(`intish`). 여기서 던지면 완주한
    //    분석이 버려지는데(위 `toReplyUsage` 주석의 경로), 공급자가 소수 토큰을 보고했다는
    //    것은 그럴 만한 사유가 못 된다. 0003 컬럼이 정수라 어차피 정수로 좁혀야 한다.
    inputTokens: intish(0).nullable(),
    outputTokens: intish(0).nullable(),
    latencyMs: intish(0),
    costUsd: z.number().min(0).nullable(),
    attempts: intish(1),
    // ── G3-2 추가: 0003 이 이미 요구하는데 G3-1 계약에 없던 축들 ────────────────────
    // 없으면 적재하는 쪽이 값을 **지어내야** 한다(실제로 `outcome='completed'`·
    // `cost_source='vendor_reported'` 가 하드코딩돼 있었다 — 페일오버·재시도·단가표 추정이
    // 전부 "성공한 벤더 보고" 로 기록된다는 뜻이다).
    outcome: z.enum(["completed", "retried", "failed_over", "failed", "drained"]),
    // ⚠️ 아래 다섯은 **`.optional()` 이지 `.default()` 가 아니다.** zod 의 `.default()` 는 입력에서만
    //    선택이고 **출력 타입에서는 필수**가 된다 — 그러면 원장 행을 손으로 만드는 쪽(워커 테스트·
    //    스텁)이 의미 없는 자리표시자를 채워야 하고, 그 자리표시자가 장부에 들어간다.
    //    적재하는 쪽(`worker/main.ts` `normalizeCallUsage`)이 이미 "모르면 NULL" 로 정규화한다.
    /**
     * **이 콜이 무캐시 태세에서 나갔는가**(게이트③ · 운영 결정 2026-09-13). 0008 컬럼
     * `analysis_call_usage.cache_bust` 의 입력이다.
     *
     * ⚠️ 답장으로는 **나가지 않는다** — 코어 `AnalysisLlmUsageSchema` 는 8필드 `.strict()` 라
     *    그대로 올리면 완주한 분석이 `output_contract` 로 버려진다(`toReplyUsage` 가 투영하며
     *    떨어뜨린다). 답장 쪽 표기는 **`evidence.runtime.cacheBust`** 가 담당한다
     *    (아래 `AnalysisRuntimeSchema` — 코어 gate3 가 읽는 축).
     * ⚠️ `.default(false)` 가 아니라 `.optional()` 인 이유는 아래 다섯과 같다 — 행을 손으로
     *    만드는 쪽이 자리표시자를 채우게 하지 않는다. 적재가 "없으면 false" 로 정규화한다.
     */
    cacheBust: z.boolean().optional(),
    costSource: z.enum(["vendor_reported", "rate_table"]).nullable().optional(),
    httpStatus: z.number().int().nullable().optional(),
    errorClass: z.string().max(64).nullable().optional(),
    // 콜 창의 **정본**이다 — 워커가 이 값을 그대로 0003 의 `started_at`/`finished_at` 에 적재하고
    // (`worker/main.ts` `recordCallUsage` 의 `COALESCE`), 없을 때만 `now() - latencyMs` 로 합성한다.
    // 적재 시점 `now()` 로만 쓰면 배치 적재 지연만큼 창이 밀려 일자 버킷이 어긋난다.
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
  })
  .strict();
export type AnalysisCallUsage = z.infer<typeof AnalysisCallUsageSchema>;

/**
 * **코어 정본과 글자 그대로 같은 8필드**(`lib/measurement-analysis-ticket/contracts.ts`
 * `AnalysisLlmUsageSchema`). 코어 `cost_ledger` 의 입력이고, 코어 클라이언트가 GET reply 를
 * 이 스키마로 파싱한다 — 한 필드라도 남거나 자료형이 다르면 `AnalysisTicketApiError("contract")`.
 *
 * ⚠️ **코어는 `null`(미계측)을 표현하지 못한다** — `inputTokens`/`outputTokens`/`costUsd` 가
 *    `z.number().default(0)` 라 `null` 을 보내면 튕기고, 키를 빼면 0 이 된다. 그래서
 *    `toReplyUsage` 는 null 을 **키 누락**으로 접는다(0 을 명시적으로 보내지 않는다는 뜻이 아니라,
 *    코어가 0 으로 채운다는 뜻이다). 미계측/0 구분은 lane 원장에만 남는다 —
 *    코어 계약이 nullable 을 받도록 넓히는 것이 정공법이고, 그건 코어 쪽 후속이다.
 */
export const AnalysisLlmUsageSchema = z
  .object({
    // 코어는 자유 문자열이다(픽스처 값 `"measurement.analysis.extract_mentions"`).
    // lane 은 축약 태스크명(`extract` 등)을 싣는다 — 둘 다 통과한다.
    task: z.string().min(1),
    poolKey: z.string().nullable().default(null),
    modelId: z.string().nullable().default(null),
    inputTokens: z.number().int().min(0).default(0),
    outputTokens: z.number().int().min(0).default(0),
    latencyMs: z.number().int().min(0).default(0),
    costUsd: z.number().min(0).default(0),
    attempts: z.number().int().min(0).default(0),
  })
  .strict();
export type AnalysisLlmUsage = z.infer<typeof AnalysisLlmUsageSchema>;

/**
 * 정수 축의 방어적 정규화 — **거부가 아니라 반올림**이다.
 *
 * ⚠️ 왜 반올림인가: 이 함수가 던지면 **완주한 분석이 통째로 버려진다.** `worker/main.ts`
 *    `processTicket` 은 `evidence.llmUsage` 를 `AnalysisReplySchema.parse` **안에서** 만들고,
 *    거기서 나온 ZodError 는 그 catch 가 `transient deferred` 로 바꾼다 — 즉 LLM 실비를 다
 *    쓰고 얻은 결과를 버리고 **같은 턴을 다시 유료로 돌린다**(3회 뒤 `cap_exhausted`).
 *    토큰 수 하나가 소수점이라는 이유로 치르기에는 터무니없이 비싼 값이다.
 *    공급자 usage 는 우리가 정하는 값이 아니다 — `worker/invoker.ts` 는 `typeof === "number"`
 *    만 보고 넘긴다. 반올림은 원장 정밀도를 1 미만으로만 움직인다(=무해).
 *    못 쓰는 값(NaN·Infinity·비수치)은 **키 누락**으로 접어 코어의 `.default(0)` 에 맡긴다 —
 *    0 을 지어내는 것이 아니라 "미계측" 과 같은 취급이다.
 */
function roundedOrOmitted(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : undefined;
}

/** 비정수 허용 축(비용). 반올림하지 않고 유한성만 본다 — 센트 이하가 의미 있는 값이다. */
function finiteOrOmitted(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : undefined;
}

/**
 * lane 원장 행 → 코어가 받는 `evidence.llmUsage[]` 항목. 여분 축은 여기서 떨어진다.
 *
 * ⚠️ `AnalysisLlmUsageSchema` 는 **코어 정본의 글자 그대로의 사본**이라 손대지 않는다(드리프트
 *    감지의 기준이 그 동일성이다). 비정수·비유한 값의 흡수는 **투영 함수인 여기**가 한다.
 */
export function toReplyUsage(u: AnalysisCallUsage): AnalysisLlmUsage {
  const inputTokens = u.inputTokens === null ? undefined : roundedOrOmitted(u.inputTokens);
  const outputTokens = u.outputTokens === null ? undefined : roundedOrOmitted(u.outputTokens);
  const latencyMs = roundedOrOmitted(u.latencyMs);
  const costUsd = u.costUsd === null ? undefined : finiteOrOmitted(u.costUsd);
  const attempts = roundedOrOmitted(u.attempts);
  return AnalysisLlmUsageSchema.parse({
    task: u.task,
    poolKey: u.poolKey,
    modelId: u.modelId,
    // null(미계측) → 키 누락 → 코어의 `.default(0)`. `null` 을 그대로 보내면 코어가 튕긴다.
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(attempts === undefined ? {} : { attempts }),
  });
}

export const AnalysisRuntimeSchema = z
  .object({
    // 패키지화(스펙 §9 단계 2) 이후 `@scope/analysis-core` 버전. 코어가 자기 버전과 다르면
    // **경고 로그 + 메트릭**(비차단 — 롤링 배포 창에는 정상적으로 발생한다, §6.1).
    laneRevision: z.string().min(1),
    contextVersionUsed: z.string().min(1),
    // 코어 정본이 `z.unknown()` 이다 — boolean 으로 좁히면 코어가 받아들이는 값을 lane 이
    // 거부하게 되고, 그 비대칭은 계약 드리프트로 자란다.
    parallelFlags: z.record(z.string(), z.unknown()).default({}),
    /**
     * **게이트③ 무캐시 표기**(운영 결정 2026-09-13). 코어 gate3 스크립트(#661)가 shadow 행의
     * `runtime->>'cacheBust'` 를 읽는다.
     *
     * ⚠️ **코어 PR-h 와 바이트 동일해야 한다** — 이 줄은 코어
     *    `lib/measurement-analysis-ticket/contracts.ts` `AnalysisReplyEvidenceSchema.runtime`
     *    의 사본이다. `runtime` 은 `.strict()` 이므로 **코어가 이 필드를 모르는 동안 lane 이
     *    보내면 답장이 통째로 거부된다**(완주한 분석이 `output_contract` 로 버려진다).
     *    그래서 배포 순서가 고정이다: **코어 PR-h 머지 + 측정 워커 재배포 → lane 배포**.
     * ⚠️ `.optional()` 이지 `.default(false)` 가 아니다 — off 일 때 lane 은 키를 **아예 싣지
     *    않는다**. 기본값을 두면 구버전 코어에 `false` 를 보내게 되고 같은 거부가 난다.
     */
    cacheBust: z.boolean().optional(),
  })
  .strict();

export const AnalysisEvidenceSchema = z
  .object({
    llmUsage: z.array(AnalysisLlmUsageSchema).default([]),
    runtime: AnalysisRuntimeSchema,
  })
  .strict();

/**
 * 답장의 deferred — **상대 시각**(`retryAfterMs`). 상태 뷰(`AnalysisDeferredViewSchema`)의
 * 절대 시각과 갈리는 지점이다.
 *
 * ⚠️ `attemptCount` 는 **여기 없다**(코어 `AnalysisDeferredInfoSchema` 3필드 `.strict()`).
 *    초판은 넣었고, 그 필드 하나 때문에 `deferred` 답장이 전부 코어에서 파싱 실패했을 것이다.
 *    시도 횟수의 주인은 lane 원장(`analysis_tickets.attempt_count`)과 코어 원장이지 답장이 아니다.
 */
export const AnalysisDeferredSchema = z
  .object({
    failureClass: AnalysisFailureClassSchema,
    retryAfterMs: z.number().int().min(0),
    detail: z.string().max(512).nullable().default(null),
  })
  .strict();

export const AnalysisReplySchema = z
  .object({
    version: z.literal(1).default(1),
    ticketId: z.guid(),
    traceId: z.guid(),
    status: z.enum(["completed", "deferred", "failed", "cancelled"]),
    finishedAt: z.iso.datetime(),
    // 요청값 **에코**. 불일치면 코어가 `output_contract` 로 즉시 종결한다(재발행 아님).
    analysisVersion: z.string().min(1),
    result: AnalysisResultSchema.nullable().default(null),
    evidence: AnalysisEvidenceSchema.nullable().default(null),
    deferred: AnalysisDeferredSchema.nullable().default(null),
    failureReason: z.string().max(512).nullable().default(null),
    terminalReason: AnalysisTerminalReasonSchema.nullable().default(null),
  })
  .strict()
  // 측정 `CallbackReplySchema` 와 같은 형태의 교차검증(`contracts.ts:97~101`).
  .superRefine((r, ctx) => {
    if (r.status === "completed" && (!r.result || !r.evidence)) {
      ctx.addIssue({ code: "custom", message: "completed reply requires result and evidence" });
    }
    if (r.status === "deferred" && !r.deferred) {
      ctx.addIssue({ code: "custom", message: "deferred reply requires deferred info" });
    }
    if (r.terminalReason && r.status !== "failed" && r.status !== "cancelled") {
      ctx.addIssue({ code: "custom", message: "terminalReason only for failed/cancelled" });
    }
    // ── 코어 계약에 없는 lane 전용 좁힘. 답장은 **lane 이 만드는 쪽**이므로 이 검사는
    //    코어가 보내는 무엇도 거부하지 않는다(코어는 답장을 만들지 않는다). 자기 산출물이
    //    completed/deferred 인데 실패 사유를 달고 나가는 것을 발행 시점에 잡는 자기 가드다.
    if (r.failureReason && (r.status === "completed" || r.status === "deferred")) {
      ctx.addIssue({ code: "custom", message: "failureReason only for failed/cancelled" });
    }
  });
export type AnalysisReply = z.infer<typeof AnalysisReplySchema>;

export function parseAnalysisReplyV1(payload: unknown): AnalysisReply {
  return AnalysisReplySchema.parse(payload);
}

// ---- 용량 -------------------------------------------------------------------

/**
 * **D13 — 측정 lane 과의 유기적 조율** (운영 추가 요구 2026-09-12, 스펙 미반영).
 *
 * 분석 수요는 측정 완료에서 나온다. 그래서 오토스케일 신호를 lane 큐 깊이 **하나로** 두면
 * 항상 한 박자 늦는다 — 측정이 막 완주한 순간에는 아직 분석 티켓이 없기 때문이다.
 * 세 가지를 함께 노출한다(구현은 훅·설정, **값은 스테이징 실측 후** 확정):
 *
 *   1. 측정 lane 의 `/v1/capacity` 를 샘플링한 큐 깊이·리스 슬롯 = **선행 지표**
 *   2. `prewarmDesiredWorkers` = 웨이브 게이트가 측정 함대를 깨울 때 분석 함대도 예열(웜풀)
 *   3. `vcpuBudget` = 측정 + 분석 ≤ 쿼터 − 여유 (쿼터는 ~300 vCPU 로 상향됨)
 *
 * 정본 계산은 `worker/coordination.ts`.
 */
export const AnalysisVcpuBudgetSchema = z
  .object({
    quota: z.number().int().min(0),
    reserve: z.number().int().min(0),
    measurementAssumed: z.number().int().min(0),
    analysisMaxVcpu: z.number().int().min(0),
    analysisMaxWorkers: z.number().int().min(0),
  })
  .strict();

export const AnalysisCoordinationSchema = z
  .object({
    measurementQueueDepth: z.number().int().min(0).nullable().default(null),
    measurementLeasedSlots: z.number().int().min(0).nullable().default(null),
    // 측정 완료율의 프록시. 샘플이 없으면 null — **0 으로 위조하지 않는다**(측정 lane 의
    // "미측정은 null" 규율과 같은 원칙). null 을 0 으로 읽으면 예열이 영원히 안 걸린다.
    measurementCompletedPerMin: z.number().min(0).nullable().default(null),
    measurementSampledAt: z.iso.datetime().nullable().default(null),
    measurementSampleError: z.string().max(256).nullable().default(null),
    prewarmDesiredWorkers: z.number().int().min(0),
    vcpuBudget: AnalysisVcpuBudgetSchema,
  })
  .strict();
export type AnalysisCoordination = z.infer<typeof AnalysisCoordinationSchema>;

/**
 * 측정의 `CapacityV1` 동형이되 **세는 단위가 둘**이다(스펙 §8.2):
 * 정본은 **in-flight LLM 콜**(`totalCallSlots`/`inflightCalls`)이고, 턴 유닛은 파생이다.
 * 유닛으로만 세면 턴 내 병렬을 켤 때마다 상한을 재보정해야 한다.
 */
export const AnalysisCapacitySchema = z
  .object({
    totalCallSlots: z.number().int().min(0),
    inflightCalls: z.number().int().min(0),
    unitSlots: z.number().int().min(0),
    leasedUnits: z.number().int().min(0),
    reservedManualUnits: z.number().int().min(0),
    queueDepth: z.number().int().min(0),
    oldestQueuedAgeSeconds: z.number().nullable().default(null),
    workerCount: z.number().int().min(0),
    coordination: AnalysisCoordinationSchema,
  })
  .strict();
export type AnalysisCapacity = z.infer<typeof AnalysisCapacitySchema>;
