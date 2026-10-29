// ╔══════════════════════════════════════════════════════════════════════════════════════╗
// ║  G3-2 가 채우는 자리. 이 파일의 인터페이스는 계약이고, 구현은 여기 없다.                ║
// ╚══════════════════════════════════════════════════════════════════════════════════════╝
//
// G3-1(이 커밋)은 **골격만** 만든다 — 큐·리스·계약·인프라·CI. 순수 분석 코드 이식과 공급자 풀은
// G3-2 의 일이고, 그 사이 자리를 비워 두는 대신 **인터페이스 + 스텁**을 꽂는다.
//
// ── 왜 인터페이스가 이 모양인가
//
//   순수 분석 코드는 `@scope/analysis-core`(코어 리포 `packages/analysis-core/`)가 소유한다 —
//   **소스가 한 벌**이어야 재구현 드리프트가 애초에 생기지 않는다(스펙 §6.1 G5). lane 은 그
//   패키지의 **태그된 버전을 핀**하고, 버전 스큐는 CI 게이트가 배포를 막아 차단한다(A24).
//   따라서 lane 쪽 엔진이 할 일은 실행 자체가 아니라 **주입**이다:
//
//       analyzeTurnPure(input, deps: { llm, log })   ← 코어 패키지 (G3-2 가 연결)
//                          ↑
//       AnalysisEngine     └─ lane 이 공급자 풀·상한·재시도를 주입한다
//
//   그래서 `deps` 에 **`clock` 이 없다**: 이동 대상 전 구간에 비결정 원천이 0건이다
//   (`Date.now`·`new Date`·`Math.random`·`randomUUID`·`performance.now`·`process.hrtime` 전수
//   grep — 추출 리팩터 플랜 §1.4). 시계를 넣으면 영원히 쓰이지 않는 죽은 파라미터가 계약에 남는다.
//
// ── G3-2 가 실제로 할 일 (이 파일 기준)
//
//   1. `AnalysisEngine` 구현체를 `worker/engines/core-engine.ts` 로 추가
//   2. `createLlmInvoker` 를 공급자 풀 라우팅(가중 랜덤 + 헬스 게이팅)으로 구현
//   3. `registry.ts` 의 `"core"` 분기를 그 구현체로 연결
//   4. `AnalysisResultTurn` 의 불투명 레코드를 패키지 타입으로 좁힌다(`contracts/v1.ts`)
//
//   **이 파일의 시그니처를 바꾸지 않는 것이 목표다.** 바뀌어야 한다면 그 자체가 설계 신호다.
import type {
  AnalysisCallUsage,
  AnalysisResultTurn,
  AnalysisTask,
  AnalysisTicketRequest,
  CitationClassificationSchema,
} from "../contracts/index.ts";
import type { z } from "zod";

export type CitationClassification = z.infer<typeof CitationClassificationSchema>;

/**
 * 컨텍스트 스냅샷 — `{catalog, rels, grouping, trackedAugmentTargets}`.
 * 코어 `loadSharedAnalysisContext` 의 5종에서 **`entityNames` 만 뺀 것**이다(그것은 persist
 * 전용이라 lane 에 갈 이유가 없다 — 스펙 §5.2 실측). 경계가 정확히 떨어진다.
 *
 * ⚠️ `grouping` 은 코어에서 **함수를 가진 인덱스 객체**(`GroupingIndex`)다. 함수는 직렬화되지
 * 않으므로 코어가 **원시 규칙 배열로 직렬화하고 lane 이 재구성**한다(스펙 §5.4). 재구성은
 * G3-2 가 `@scope/analysis-core` 의 빌더를 불러 한다 — 여기서는 원시 형태로 둔다.
 */
export interface AnalysisContextSnapshot {
  contextVersion: string;
  catalog: unknown;
  rels: unknown;
  grouping: unknown;
  trackedAugmentTargets: unknown;
}

/** OpenAI 호환 `response_format.json_schema` 객체. 벤더 `ChatResponseFormat` 의 json_schema 갈래와 같은 모양. */
export interface LlmJsonSchema {
  name: string;
  strict?: boolean;
  schema: unknown;
}

export interface LlmInvokeRequest {
  task: AnalysisTask;
  /** 모델은 **lane 이 정한다**(태스크별 고정). 티켓이 모델을 지정하는 경로는 계약이 거부한다. */
  prompt: string;
  systemPrompt?: string;
  responseFormat?: "json" | "text";
  /**
   * 벤더 코드가 `responseFormat: { type: "json_schema", json_schema }` 를 보냈을 때의 스키마 객체.
   * 있으면 `responseFormat` 도 `"json"` 으로 함께 채운다: 방언이 json_schema 를 못 받는 풀에서
   * invoker 가 json_object 로 강등할 때 그 값이 그대로 기준이 된다.
   *
   * 별도 필드로 둔 이유: `responseFormat === "json"` 을 보는 기존 경로(json_object 바디)를 한
   * 바이트도 바꾸지 않기 위해서다. 스키마가 없는 요청의 바디는 이 필드 도입 전과 같다.
   */
  jsonSchema?: LlmJsonSchema;
  /** 호출자(순수 코드)가 재시도를 세지 않는다 — 재시도·풀 전환은 전부 invoker 안이다. */
  maxOutputTokens?: number;

  // ── G3-2 에서 **더한** 필드들 (기존 필드·`analyzeTurn` 시그니처는 무변경) ────────────
  //
  // 왜 더했나: 벤더된 순수 코드가 보내는 `ClaudeRequest`(코어 `lib/llm/invoke.ts:284`)에는
  // `temperature`·`reasoning`·모델 alias·**코어 태스크 이름**이 들어 있다. 그것을 G3-1 의
  // 5필드에 접어 넣으면 값이 **조용히 사라진다**:
  //   · `temperature: 0` 이 빠지면 분석 4태스크의 결정성 전제가 깨진다(스펙 §6.3 — 넷 다 0)
  //   · `reasoning.max_tokens` 이 빠지면 같은 프롬프트가 다른 비용·다른 출력을 낸다
  //   · 코어 태스크 이름이 빠지면 `LLM_TASK_MODEL_<task>` 가 코어와 다른 키를 보게 되어
  //     "코어와 같은 모델" 이라는 A/B 근거의 전제가 깨진다
  // 전부 optional 이라 스텁 엔진·기존 테스트는 그대로 통과한다 — **빼는 변경이 아니라 더하는 변경**이다.

  /**
   * 코어 태스크 이름 그대로(`measurement.analysis.extract_mentions` 등).
   * 모델 해석(`LLM_TASK_MODEL_*`)·비용 귀속이 이 이름을 쓴다 — 축약한 `task` 로는 코어와
   * 같은 env 키를 만들 수 없다.
   */
  sourceTask?: string;
  /** 코어 alias(`haiku`/`sonnet`) 또는 provider-prefixed id. env override 가 없을 때의 기본값. */
  modelAlias?: string;
  temperature?: number;
  reasoning?: { effort?: string; max_tokens?: number; exclude?: boolean; enabled?: boolean };
}

export interface LlmInvokeResult {
  text: string;
  usage: AnalysisCallUsage;
  /** 공급자 trace. 순수 코드가 `extractionMetadata.analysis_llm_trace_id` 로 흘려보낸다. */
  traceId?: string;
  /** 실제로 쓴 풀·모델의 표시 id(`<poolKey>/<vendor>/<model>`) — 코어 `displayId` 자리. */
  displayModelId?: string;
  /**
   * 이 호출 **1회를 처리하는 동안 일어난 업스트림 콜 전부**(재시도·풀 페일오버 포함).
   * 마지막 원소가 `usage` 다.
   *
   * ⚠️ `usage` 하나만 올리면 **성공한 마지막 콜만 장부에 남는다** — 429 로 버린 콜의 실비와
   *    페일오버 낭비가 통째로 사라진다. 마이그레이션 0003 이 행 단위를 attempt 가 아니라
   *    "LLM 콜 1회" 로 잡은 이유가 정확히 그것이다(합치면 단가가 잘못 배정된다).
   */
  usageRows?: AnalysisCallUsage[];
}

/**
 * 순수 코드에 주입되는 LLM 호출기. **풀 라우팅·전역 콜 상한·타임아웃·재시도가 전부 이 뒤에 있다.**
 *
 * 순수 코드는 이미 invoker 주입 seam 을 갖고 있다(`llm.ts` 4함수 + `citation-classify.ts` 2함수) —
 * 끊는 변경은 "기본값 `?? invoke` 제거" 하나다(추출 리팩터 플랜 PR-D). 그 기본값이 살아 있으면
 * import 만으로 `@/lib/db` 가 따라 들어와 **lane 이 코어 DB 를 보게 되고 G3 가 깨진다.**
 */
export type LlmInvoker = (req: LlmInvokeRequest, signal: AbortSignal) => Promise<LlmInvokeResult>;

export interface LaneLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface AnalysisEngineInput {
  ticket: AnalysisTicketRequest;
  context: AnalysisContextSnapshot;
  llm: LlmInvoker;
  log: LaneLogger;
  /** 리스 만료·드레인·마감 초과로 끊는다. 엔진은 이 신호에서 **즉시 포기해야 한다**. */
  signal: AbortSignal;
}

export interface AnalysisEngineOutput {
  turn: AnalysisResultTurn;
  citationClassifications: CitationClassification[];
  /**
   * 콜당 1행 = **lane 원장(`analysis_call_usage`) 행**. 코어 `cost_ledger` 로도 가지만 그때는
   * `toReplyUsage` 가 코어 8필드로 투영한다 — 운영 축(outcome·costSource·httpStatus·
   * errorClass·콜 창)은 lane 밖으로 나가지 않는다(코어 계약이 `.strict()` 라 나갈 수도 없다).
   */
  llmUsage: AnalysisCallUsage[];
  /** 어느 병렬 경로를 탔는가(P3-A 턴 내 병렬 등). reply `evidence.runtime.parallelFlags`. */
  parallelFlags?: Record<string, boolean>;
}

export interface AnalysisEngine {
  /** `@scope/analysis-core` 버전. reply `evidence.runtime.laneRevision` 으로 나가 스큐 관측에 쓰인다. */
  readonly revision: string;
  readonly kind: string;
  analyzeTurn(input: AnalysisEngineInput): Promise<AnalysisEngineOutput>;
}

/**
 * 엔진이 "이건 재시도로 풀린다"고 말하는 방법. lane 이 `deferred` 로 옮기고 백오프한다.
 * 그 외 예외는 `transient` 로 취급하되, **`output_contract` 는 결정적 실패라 attempt 를
 * 올리지 않고 1회로 종결한다**(스펙 D5).
 */
export class AnalysisDeferrable extends Error {
  constructor(
    readonly failureClass: "transient" | "capacity" | "drain",
    readonly retryAfterMs: number,
    message: string,
  ) {
    super(message);
    this.name = "AnalysisDeferrable";
  }
}

export class AnalysisContractError extends Error {
  readonly failureClass = "output_contract" as const;
  constructor(message: string) {
    super(message);
    this.name = "AnalysisContractError";
  }
}

/**
 * **스텁 엔진 — G3-1 의 자리 표시자.**
 *
 * LLM 을 한 번도 부르지 않고 **빈 분석**을 돌려준다. 목적은 둘:
 *   ① 골격(접수 → 리스 → 실행 → 정산 → 콜백 → 되읽기)이 끝까지 도는 것을 LLM 실비 0 으로 증명
 *   ② G3-2 가 채울 때 **바꿔 끼우기만 하면 되는 형태**를 고정
 *
 * ⚠️ 산출물에 `stub: true` 를 박는다 — 스텁 결과가 실수로 라이브 persist 에 섞이면 코어가
 *    그것을 분석 결과로 받아들인다. 마커가 없으면 조용히 "멘션 0건" 으로 보인다.
 *    코어 쪽 수신 경로가 이 키를 거부하게 하는 것은 코어 워크유닛의 일이다.
 * ⚠️ `sourceTurnHash` 는 요청값을 **에코**한다(D4) — lane 은 그 해시를 계산할 수 없다
 *    (`rawResponse` 를 안 싣기 때문). persist 에 쓰이는 값은 코어가 계산한 것이다.
 */
export function createStubAnalysisEngine(revision = "stub-0"): AnalysisEngine {
  return {
    revision,
    kind: "stub",
    async analyzeTurn(input: AnalysisEngineInput): Promise<AnalysisEngineOutput> {
      input.signal.throwIfAborted();
      const t = input.ticket.turn;
      // 계약이 코어와 같아지면서 `answerText` 가 nullable 이 됐다(코어 DB 컬럼이 NULL 허용).
      const answerChars = (t.answerText ?? "").length;
      return {
        turn: {
          turnRunId: t.turnRunId,
          // ⚠️ G3-2 에서 `quality` 가 코어 `AnswerQualityResult` 로 좁혀졌다 — 스텁도 그 모양을
          //    따라야 한다. **`valid_answer` 를 쓰지 않는다**: 스텁 결과가 라이브 persist 에
          //    섞이면 "정상 분석인데 멘션 0건"으로 보이고, 그게 가장 나쁜 실패 모드다
          //    (아래 `extractionMetadata.stub` 마커와 짝으로 이중 표시한다).
          quality: { qualityState: "failed_answer", reason: "stub engine — no analysis performed", answerChars },
          mentions: [],
          candidates: [],
          // 스텁은 LLM 을 안 부른다 — 스탠스도 없다. 계약이 `.default([])` 라 키는 있어야 한다.
          answerStances: [],
          // 버전 4종은 **계약에서 빠졌다** — 코어 정본이 그 넷을 빼고 `.strict()` 이기 때문이다
          // (persist 는 코어가 보낸 `options` 값을 쓴다). 스텁도 싣지 않는다.
          modelSlug: null,
          extractionMetadata: {
            stub: true,
            engine: "stub",
            revision,
            contextVersion: input.context.contextVersion,
            answerChars,
            citationHostsRequested: input.ticket.citationHostsToClassify.length,
          },
          sourceTurnHash: t.sourceTurnHash,
          failed: false,
          failureDetail: null,
        },
        citationClassifications: [],
        llmUsage: [],
        parallelFlags: { stub: true },
      };
    },
  };
}
