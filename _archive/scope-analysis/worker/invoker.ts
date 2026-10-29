// LLM 호출기 조립 — **상한이 라우팅보다 바깥에 있다.**
//
// G3-2 가 채우는 것은 `inner`(공급자 풀 라우팅: 가중 랜덤 + 헬스 게이팅 + 페일오버)이고,
// 이 파일의 래퍼는 그 안팎을 정한다:
//
//     withCallSlot( 전역 콜 세마포어 )        ← 여기 (G3-1)
//        └─ withCallTimeout( AbortSignal )    ← 여기 (G3-1)
//             └─ poolRouting( 429 → 다른 풀 ) ← G3-2
//                  └─ fetch(provider)
//
// **순서가 설계다.** 세마포어가 라우팅보다 바깥이라 "풀을 바꿔 가며 재시도하는 동안 슬롯 1개를
// 쥔다" 가 성립한다. 안쪽에 두면 재시도마다 슬롯을 다시 잡아 전역 상한이 조용히 초과된다.
//
// ⚠️ **fetch 타임아웃은 신설이다.** 현행 코어 `openrouter.ts:159`·`:260` 의 fetch 에는
//    `AbortSignal` 이 **없어** 요청 상한이 undici 기본값에 맡겨져 있다 — 한 콜의 행업이 유닛
//    슬롯을 무기한 점유한다(스펙 §8.4). 공급자 분산은 그런 콜을 **다른 풀로 흘려보낼 수 있을
//    때만** 의미가 있으므로, 타임아웃 없는 페일오버는 페일오버가 아니다.
import type { LlmInvokeRequest, LlmInvokeResult, LlmInvoker } from "./engine.ts";
import type { Semaphore } from "./concurrency.ts";

/** 전역 in-flight 콜 상한을 집행한다. 슬롯 획득 실패는 typed `capacity` 실패로 올라간다. */
export function withCallSlot(semaphore: Semaphore, acquireTimeoutMs: number, inner: LlmInvoker): LlmInvoker {
  return async (req: LlmInvokeRequest, signal: AbortSignal): Promise<LlmInvokeResult> => {
    const release = await semaphore.acquire(acquireTimeoutMs);
    try {
      return await inner(req, signal);
    } finally {
      release();
    }
  };
}

/**
 * 마감 신호 — **`AbortSignal.timeout` 을 쓰지 않는다.**
 *
 * ⚠️ `AbortSignal.timeout(ms)` 의 타이머는 **unref 다**: 이벤트 루프에 다른 할 일이 없으면
 *    루프가 먼저 비어 **타임아웃이 아예 안 걸린다.** 2026-09-12 CI 가 이것을 잡았다 —
 *    행업 fetch 하나만 매달린 테스트가 node 20 에서 `Promise resolution is still pending but
 *    the event loop has already resolved` 로 통째로 죽었고(로컬 node 26 에서는 통과했다),
 *    같은 함정을 `worker/concurrency.ts` 가 이미 세마포어 대기에서 겪었다:
 *    **"건너뛸 수 있는 타임아웃은 타임아웃이 아니다."**
 *
 *    라이브 워커는 poll·하트비트 타이머가 늘 떠 있어 증상이 안 보이지만, 그건 상관없는 코드가
 *    루프를 붙잡아 준 덕일 뿐이다 — 그 우연에 콜 상한을 맡기지 않는다.
 *
 * 타이머는 **ref 로 두고 `finally` 에서 반드시 clear** 한다(대기보다 오래 살지 않는다).
 * 바깥 신호 리스너도 걷어낸다 — in-flight 640 규모에서 콜마다 리스너가 쌓이면 그 자체가 누수다.
 */
export async function withDeadline<T>(
  timeoutMs: number,
  outer: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort(outer.reason);
  if (outer.aborted) controller.abort(outer.reason);
  else outer.addEventListener("abort", onOuterAbort, { once: true });
  // ⚠️ `unref()` 하지 않는다. 이름을 `TimeoutError` 로 두는 것도 계약이다 — 호출부가 그 이름으로
  //    `fetch_timeout` 을 분류한다(네트워크 오류와 구분해야 풀 헬스 판정이 맞는다).
  const timer = setTimeout(() => {
    const e = new Error(`operation timed out after ${timeoutMs}ms`);
    e.name = "TimeoutError";
    controller.abort(e);
  }, timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    outer.removeEventListener("abort", onOuterAbort);
  }
}

/**
 * 콜 1회의 벽시계 상한. 기본 180s(`ANALYSIS_LLM_REQUEST_TIMEOUT_MS`).
 * 바깥 신호(리스 만료·드레인)와 **둘 중 먼저 오는 쪽**으로 끊는다.
 */
export function withCallTimeout(timeoutMs: number, inner: LlmInvoker): LlmInvoker {
  return async (req: LlmInvokeRequest, signal: AbortSignal): Promise<LlmInvokeResult> =>
    withDeadline(timeoutMs, signal, (combined) => inner(req, combined));
}

export interface InvokerOptions {
  semaphore: Semaphore;
  acquireTimeoutMs: number;
  requestTimeoutMs: number;
}

/** 래퍼 두 겹을 순서대로 씌운다. G3-2 는 `inner` 만 바꿔 끼운다. */
export function buildInvoker(opts: InvokerOptions, inner: LlmInvoker): LlmInvoker {
  return withCallSlot(opts.semaphore, opts.acquireTimeoutMs, withCallTimeout(opts.requestTimeoutMs, inner));
}

// ╔══════════════════════════════════════════════════════════════════════════════════════╗
// ║  G3-2 — 가장 **안쪽**(`inner`): 공급자 풀 라우팅 + fetch 타임아웃 + 페일오버 + 콜 원장  ║
// ╚══════════════════════════════════════════════════════════════════════════════════════╝
//
//     withCallSlot( 전역 콜 세마포어 )        ← G3-1
//        └─ withCallTimeout( AbortSignal )    ← G3-1 (콜 **전체** 예산, 기본 180s)
//             └─ createPoolInvoker            ← 여기 (G3-2)
//                  ├─ 가중 랜덤 + 헬스 게이팅
//                  ├─ fetch AbortSignal 타임아웃 (**요청 1회** 예산, 기본 90s — 태스크별)
//                  ├─ 429/5xx → 다른 풀로 1회 페일오버, 그 뒤는 backoff
//                  └─ 콜 1회마다 usage 행 1개 (outcome 포함)
//
// ── 두 타임아웃이 왜 둘인가
//
//   바깥(180s)은 "이 콜에 쓸 수 있는 전체 시간"이고 안쪽(90s)은 "업스트림 요청 한 번의
//   상한"이다. 안쪽이 없으면 한 요청의 행업이 바깥 예산을 통째로 먹어 **페일오버할 시간이
//   남지 않는다** — 공급자 분산은 그런 콜을 다른 풀로 흘려보낼 수 있을 때만 의미가 있다
//   (스펙 §8.4). 현행 코어 `openrouter.ts:159`·`:260` 의 fetch 에는 `AbortSignal` 이 아예 없다.
//
// ── resolve 재시도 보강은 **여기서** 한다 (스펙 §8.4)
//
//   코어 `llm.ts:800` 은 resolve 를 `for (attempt = 1; attempt <= 2)` 로 돌리고 **백오프가 없다**
//   (extract·semantics 는 고쳤는데 resolve 에만 적용되지 않았다 — `llm.ts:432~437` 주석이 그
//   결함을 스스로 규정한다). 벤더 파일은 **바이트 무수정**이 계약이므로 그 줄을 고칠 수 없다.
//   대신 invoker 가 resolve 태스크의 재시도 상한을 올리고 백오프를 넣는다.
//
// ── ⚠️ 재시도는 **중첩 곱**이다 — 태스크마다 다르고, 모르면 실비 추정이 몇 배 틀린다
//
//   바깥(벤더 `llm.ts`)이 파싱 실패에 재시도하고, 안쪽(invoker)이 전송 실패에 재시도한다.
//   두 층은 서로를 모르므로 **업스트림 요청 수는 둘의 곱**이다. 실측(핀 aee0b9b1):
//
//     | 태스크    | 벤더 상한                                         | invoker 기본 | 곱 |
//     | extract   | 4 (`EXTRACT_MAX_ATTEMPTS`, `llm.ts:457~460`)      | 2            | **8** |
//     | semantics | 4 (`SEMANTICS_MAX_ATTEMPTS`, `llm.ts:438~441`)    | 2            | **8** |
//     | resolve   | 2 (하드코딩, `llm.ts:800`)                        | 2            | **4** |
//     | citation  | 1 (재시도 없음, `citation-classify.ts:297~309`)   | 2            | **2** |
//
//   (벤더 상한 4는 env `MEASUREMENT_ANALYSIS_{EXTRACT,SEMANTICS}_MAX_ATTEMPTS` 로 바뀐다.
//    invoker 상한은 `ANALYSIS_LLM_INVOKER_MAX_ATTEMPTS[_TASK]`.)
//
//   초판 주석은 이 표 자리에 "바깥 2 × 안쪽 2 = 최대 4" 하나만 적었다 — resolve 값을 전 태스크에
//   일반화한 것이라 extract·semantics 가 **2배 과소**였다. 재시도 상한을 만질 때는 이 표를 먼저 고친다.
//
//   ⚠️ D-7 이후 **200 응답도 이 곱에 들어온다.** `provider_mid_generation_error` 는 재시도 가능이라
//      안쪽 2가 실제로 소비된다 — 전에는 200 이면 무조건 비재시도라 extract 가 4콜에서 멈췄다.
//      늘어난 것은 "성공할 수 있었는데 안 한 콜" 의 회수분이고(다른 풀이면 산다), 결정적 실패
//      (`truncated_empty`·`reasoning_only_empty`·`empty_content`)는 그대로 비재시도로 둔다.
import { randomUUID } from "node:crypto";

import type { AnalysisCallUsage, AnalysisTask } from "../contracts/index.ts";
import {
  cacheBustNonce,
  cacheBustParams,
  loadCacheBustConfig,
  modeUsesNonce,
  modeUsesParams,
  prefixWithNonce,
  type CacheBustConfig,
} from "./cache-bust.ts";
import type { LaneLogger } from "./engine.ts";
import {
  compatiblePoolWeights,
  displayModelId,
  isStandbyPool,
  laneTaskFor,
  loadPools,
  pickPool,
  poolApiKey,
  poolWireFields,
  PoolHealth,
  summarizeTaskStandby,
  resolveLaneCost,
  resolveLaneModel,
  routingTaskFor,
  taskPoolWeights,
  taskPoolsEnvKey,
  wireModelId,
  type PoolConfig,
  type ResolvedLaneModel,
} from "./llm-pools.ts";

/**
 * fetch 가 던진 예외에서 **원인 코드를 건져낸 것**(D-8).
 *
 * ⚠️ 초판은 `err.name` 하나만 보고 `fetch_timeout` / `network_error` 로 접었다. 그래서 2026-09-13
 *    라이브 25분 관측 171건이 전부 `status:null, errorClass:"network_error"` 였고 — luna 118 ·
 *    flash-lite 51 · haiku 2, 지연 1.4~15s(중앙 5.8s) — **그 뒤에 무엇이 있었는지 남은 것이 없다.**
 *    `err.message` 만 남겨도 소용없다: Node fetch 의 최상위 메시지는 `fetch failed` 또는
 *    `terminated` 둘뿐이다(아래 실측표). 원인은 항상 `err.cause` 안에 있다.
 *
 * ── 실측 모양 (2026-09-13, node 20.20.2 · 26.8.1 동일 — `tests/invoker-pool.test.ts`)
 *
 *   | 상황                         | err.name     | err.message | cause.name  | cause.code        |
 *   |------------------------------|--------------|-------------|-------------|-------------------|
 *   | 응답 바디 도중 소켓 파괴      | TypeError    | terminated  | SocketError | UND_ERR_SOCKET    |
 *   | 응답 전 소켓 파괴            | TypeError    | fetch failed| SocketError | UND_ERR_SOCKET    |
 *   | DNS 실패                     | TypeError    | fetch failed| Error       | ENOTFOUND         |
 *   | 연결 거부                    | TypeError    | fetch failed| Error       | ECONNREFUSED      |
 *   | AbortSignal.timeout          | TimeoutError | …aborted…   | (없음)      | (없음)            |
 *
 *   즉 관측 가치가 있는 축은 **`cause.code` · `cause.name` · `cause.message`** 다.
 *
 * ⚠️ `message` 는 **답변 텍스트가 아니다** — undici/Node 가 만든 문구(`other side closed` 등)다.
 *    본문을 로그로 흘리지 않는다는 이 파일의 규율(`maskedBodyHead`)과 어긋나지 않고, 이미
 *    리포 전역이 쓰는 `errorFields`(`app/log.ts`)의 `errorMessage` 와 같은 성격이자 **더 짧다**
 *    (160자 vs 512자).
 */
export interface FetchErrorDetail {
  errorName: string | null;
  /** 최상위에 `code` 가 붙는 경우(드물다). */
  errorCode: string | null;
  causeName: string | null;
  /** **원인은 대부분 여기 있다.** 여러 주소를 시도한 경우 `cause.errors[0].code` 까지 본다. */
  causeCode: string | null;
  /** cause 메시지(없으면 err 메시지) 앞 160자. */
  message: string | null;
}

const codeOf = (v: unknown): string | null => {
  const c = (v as { code?: unknown } | null)?.code;
  return typeof c === "string" && c.length > 0 ? c : null;
};
const nameOf = (v: unknown): string | null => {
  const n = (v as { name?: unknown } | null)?.name;
  return typeof n === "string" && n.length > 0 ? n : null;
};

/** 예외 → `FetchErrorDetail`. **절대 던지지 않는다** — 관측이 실패 경로를 새로 만들면 안 된다. */
export function describeFetchError(error: unknown): FetchErrorDetail {
  const err = error as { name?: unknown; message?: unknown; cause?: unknown } | null;
  const cause = err?.cause ?? null;
  // `AggregateError`(주소 여러 개를 시도한 경우) — 첫 하위 오류가 실질 원인이다.
  const subs = (cause as { errors?: unknown } | null)?.errors;
  const first = Array.isArray(subs) && subs.length > 0 ? subs[0] : null;
  const rawMessage =
    (typeof (cause as { message?: unknown } | null)?.message === "string" &&
      ((cause as { message: string }).message as string)) ||
    (typeof err?.message === "string" ? (err.message as string) : "");
  return {
    errorName: nameOf(err),
    errorCode: codeOf(err),
    causeName: nameOf(cause) ?? nameOf(first),
    causeCode: codeOf(cause) ?? codeOf(first),
    message: rawMessage.length > 0 ? rawMessage.slice(0, 160) : null,
  };
}

/**
 * `analysis_call_usage.error_class` 에 들어갈 이름(D-8). `network_error` 하나로 접지 않고
 * **원인 코드까지** 붙인다 — `network_error:UND_ERR_SOCKET` · `network_error:ECONNRESET`.
 *
 * ⚠️ 계약이 `.max(64)` 다(`ERROR_CLASS_MAX_CHARS`). 코드는 대문자·숫자·밑줄만 남기고 40자로
 *    자른다 — 공급자가 이상한 문자열을 code 에 넣어도 원장 컬럼이 오염되지 않게.
 * ⚠️ 접두사를 `network_error` 로 **유지**하는 것이 중요하다: `PoolCallError.retriable` 이
 *    `status === null` 이면 `missing_api_key`·`malformed_response` 만 빼고 재시도로 보내므로
 *    세분화가 재시도 정책을 바꾸지 않는다(관측만 늘린다).
 */
export function networkErrorClass(detail: FetchErrorDetail): string {
  const raw = detail.causeCode ?? detail.errorCode;
  if (!raw) return "network_error";
  const code = raw.toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 40);
  return code.length > 0 ? `network_error:${code}` : "network_error";
}

/** 업스트림이 준 실패. `retriable` 이 페일오버·백오프 여부를 결정한다(코어 `OpenRouterError` 동형). */
export class PoolCallError extends Error {
  /**
   * 이 호출에서 발생한 콜 원장 행 전부. **예외에 실어 보내는 이유**: 벤더 `llm.ts` 는 invoker
   * 예외를 잡아 `failed: true` 결과로 바꾼다(`llm.ts:316~334` 등) — 즉 티켓은 대개 completed 로
   * 끝난다. 그때 실패한 콜의 실비를 반환값으로 올릴 길이 없으므로 예외가 들고 간다.
   * 안 하면 **낭비 비용이 장부에서 조용히 사라진다**.
   */
  usageRows: AnalysisCallUsage[] = [];

  constructor(
    readonly status: number | null,
    readonly errorClass: string,
    readonly poolKey: string,
    /**
     * 네트워크 실패의 **원인 코드**(D-8). 업스트림이 HTTP 로 답한 실패(4xx/5xx·본문 실패)에는
     * 없다 — 그쪽은 `status`·본문 분류가 이미 원인을 말한다.
     */
    readonly detail: FetchErrorDetail | null = null,
  ) {
    super(`PoolCallError[pool=${poolKey} status=${status ?? "network"} class=${errorClass}]`);
    this.name = "PoolCallError";
  }

  /** 코어 `openrouter.ts:103~117` 과 같은 판정. 4xx(인증·검증·모델부재)는 재시도가 무의미하다. */
  get retriable(): boolean {
    // ⚠️ **상태 코드보다 본문이 먼저다**(D-7). OpenRouter 는 공급자가 요청을 받아들이는 순간
    //    200 헤더를 보내고 그 뒤의 실패는 전부 본문에 적는다 — "an HTTP status is final once
    //    sent"(API 레퍼런스 Errors). 그래서 `status === 200` 만 보고 판정하면 **공급자가 생성
    //    도중에 죽은 콜이 "재시도 불가" 로 분류된다.** 2026-09-13 라이브에서 실제로 그랬다:
    //    32건 전부 status 200 · retriable=false · willRetry=false 로 페일오버가 한 번도 안 돌았다.
    if (RETRIABLE_BODY_ERROR_CLASSES.has(this.errorClass)) return true;
    if (this.status === null) return this.errorClass !== "missing_api_key" && this.errorClass !== "malformed_response";
    if (this.status >= 500) return true;
    return this.status === 429;
  }
}

/**
 * **200 인데 쓸 수 없는 본문**의 분류(D-7). 값은 `analysis_call_usage.error_class` 에 그대로
 * 들어간다(계약 `.max(64)` — 전부 그보다 짧다).
 *
 * 초판은 이 넷을 전부 `malformed_response` 하나로 접었다. 그 이름은 "응답이 JSON 이 아니다" 를
 * 뜻하는데 실제로 온 것은 **정상 JSON 안에 담긴 공급자 실패**였다 — 이름이 원인을 가렸고,
 * 비재시도 판정까지 같이 따라와 페일오버가 죽었다. 그래서 `malformed_response` 는 이제
 * **진짜 파싱 불능(JSON 이 아님)** 에만 남는다.
 */
export const BODY_ERROR_CLASS = {
  /**
   * 공급자가 **생성 도중** 죽었다. 문서가 비스트리밍 형태를 그대로 적어 뒀다 —
   * `choices[0].error` + `finish_reason: "error"`, 또는 `error` 만 있고 `choices` 가 없는 본문
   * ("you receive a `200 OK` whose JSON body holds only an `error` object and no `choices`").
   * **다른 풀이면 성공할 수 있다** → 재시도 가능 · 헬스에는 transient 로 기록된다.
   */
  providerMidGeneration: "provider_mid_generation_error",
  /** `finish_reason: "length"` 인데 content 가 비었다 = max_tokens 를 추론에 다 썼다. 같은 요청을 다시 보내도 같다. */
  truncatedEmpty: "truncated_empty",
  /** `reasoning` 만 오고 content 가 비었다(`reasoning.exclude` 가 무시된 경우 포함). 역시 결정적이다. */
  reasoningOnlyEmpty: "reasoning_only_empty",
  /** 아무 신호 없이 content 만 비었다 — 문서 "No Content Generated"(웜업·스케일링). 관측만 하고 판정은 보수적으로 둔다. */
  emptyContent: "empty_content",
} as const;

/**
 * 이 클래스들만 200 응답에서 재시도로 넘긴다. **여기 이름을 더하는 것은 돈을 쓰는 결정이다** —
 * 결정적 실패(같은 요청 → 같은 응답)를 넣으면 실비만 배로 태우고 같은 자리에서 죽는다.
 */
const RETRIABLE_BODY_ERROR_CLASSES = new Set<string>([BODY_ERROR_CLASS.providerMidGeneration]);

/**
 * 예외에 실려 온 콜 원장 행. 엔진이 실패 경로에서도 장부를 모을 수 있게 한다 —
 * 엔진이 `PoolCallError` 를 알 필요 없이 이 함수만 부르면 된다.
 */
export function usageRowsFromError(error: unknown): AnalysisCallUsage[] {
  if (error instanceof PoolCallError) return error.usageRows;
  const rows = (error as { usageRows?: unknown } | null)?.usageRows;
  return Array.isArray(rows) ? (rows as AnalysisCallUsage[]) : [];
}

/** 코어 `openrouter.ts:120~134` 과 같은 분류. */
function inferErrorClass(status: number, body: unknown): string {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 404) return "model_not_found";
  if (status >= 500) return `http_${status}`;
  if (status === 400) {
    const msg = (body as { error?: { message?: string } } | undefined)?.error?.message ?? "";
    return msg.toLowerCase().includes("model") ? "model_not_found" : "validation";
  }
  return `http_${status}`;
}

/** 공급자가 본문에 싣는 실패. 최상위(`json.error`)와 선택지별(`choices[0].error`) 둘 다 온다. */
interface ChatUpstreamError {
  code?: number | string;
  message?: string;
}

/** 콘텐츠 파트. 코어 측정 lane 이 이미 아는 형태다(`lib/llm-query-claude/client.ts:18~27`). */
interface ChatContentPart {
  type?: string;
  text?: string;
}

interface ChatChoice {
  /** `"stop" | "length" | "error" | ...`. **`"error"` 는 200 안에 담긴 실패 신호다**(D-7). */
  finish_reason?: string | null;
  /** 공급자 원문 사유. OpenRouter 가 표준화 전 값을 그대로 얹어 준다 — 진단에 쓴다. */
  native_finish_reason?: string | null;
  error?: ChatUpstreamError;
  message?: { role?: string; content?: string | ChatContentPart[] | null; reasoning?: string | null };
  reasoning?: string | null;
}

/**
 * ⚠️ **초판은 `choices[0].message.content` **하나만** 알았다** — `finish_reason`·
 * `native_finish_reason`·`error`·`reasoning`·`provider` 를 읽지 않았다. 그래서 200 응답이
 * 실패였을 때 남는 것이 "content 가 문자열이 아니다" 뿐이었고, 원인(공급자 중도 사망 /
 * 토큰 소진 / 추론만 반환)이 전부 같은 한 글자로 접혔다. 타입을 넓히는 것이 관측의 절반이다.
 */
interface ChatResponseBody {
  id?: string;
  model?: string;
  provider?: string;
  error?: ChatUpstreamError;
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_cost?: number;
    cost?: number;
    is_byok?: boolean;
    cost_details?: { upstream_inference_cost?: number };
  };
}

export interface PoolInvokerOptions {
  /** 활성 풀만(키가 있는 것). 비어 있으면 기동이 아니라 **첫 콜**에서 죽는다 — 아래 참고. */
  pools: PoolConfig[];
  health: PoolHealth;
  log: LaneLogger;
  /** 콜 1회 = 행 1개. 엔진이 모아 `reply.evidence.llmUsage[]` 로 올린다(스펙 §8.5). */
  sink: (row: AnalysisCallUsage) => void;
  /** 테스트가 **녹화 응답**을 주입하는 자리 — 그래서 `pnpm test` 의 LLM 실비가 0 이다. */
  fetchImpl?: typeof fetch;
  rand?: () => number;
  now?: () => number;
  /** 요청 1회 벽시계 상한. 태스크별(기본 90s). */
  fetchTimeoutMs?: (task: AnalysisTask) => number;
  /** 이 invoker 층의 재시도 상한. 기본 2(resolve 도 2 — 벤더의 2회와 곱해 4가 된다). */
  maxAttempts?: (task: AnalysisTask) => number;
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * 프롬프트 캐시 무효화 태세(게이트③ · 운영 결정 2026-09-13). 생략하면 이 invoker 조립
   * 시점에 **프로세스 env** 를 읽는다 — 라이브 정본은 `ANALYSIS_LLM_CACHE_BUST` 다.
   *
   * ⚠️ 라이브에서는 `createLaneInvokerFactory` 가 **프로세스 1회** 읽어 여기로 내려준다.
   *    이 함수는 티켓마다 불리므로 그 자리에서 env 를 읽게 두면 창 중간의 env 변화가
   *    티켓 사이에 섞이고, 한 게이트 창 안에 캐시 유무가 혼재해 **측정 자체가 무효**가 된다
   *    (`app/settings.ts` 가 기동 1회 읽는 값과도 갈린다 — 답장 표기는 그쪽을 쓴다).
   *    태세를 바꾸려면 재기동이다.
   */
  cacheBust?: CacheBustConfig;
}

/**
 * `analysis_lane.pool_vendor_mismatch` 중복 억제. **프로세스 스코프**여야 한다 —
 * `createPoolInvoker` 는 티켓마다 불리므로 그 안에 두면 억제가 안 된다.
 */
const warnedIncompatiblePool = new Set<string>();

function envTimeoutMs(task: AnalysisTask): number {
  const perTask = process.env[`ANALYSIS_LLM_FETCH_TIMEOUT_MS_${task.toUpperCase()}`];
  const generic = process.env.ANALYSIS_LLM_FETCH_TIMEOUT_MS;
  const raw = perTask ?? generic;
  const n = raw === undefined || raw === "" ? 90_000 : Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`ANALYSIS_LLM_FETCH_TIMEOUT_MS* must be a positive number, got ${JSON.stringify(raw)}`);
  return n;
}

function envMaxAttempts(task: AnalysisTask): number {
  const raw = process.env[`ANALYSIS_LLM_INVOKER_MAX_ATTEMPTS_${task.toUpperCase()}`] ?? process.env.ANALYSIS_LLM_INVOKER_MAX_ATTEMPTS;
  const n = raw === undefined || raw === "" ? 2 : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`ANALYSIS_LLM_INVOKER_MAX_ATTEMPTS* must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * 공급자 풀 라우팅 invoker. `buildInvoker(opts, createPoolInvoker(...))` 로 안쪽에 끼운다.
 *
 * ⚠️ **조용한 성공을 만들지 않는다.** 풀이 하나도 없거나 키가 없으면 typed 실패로 올라가고,
 *    그 티켓은 `deferred`(transient) 가 된다 — 빈 분석을 completed 로 올리지 않는다.
 *    "분석은 도는데 멘션이 0건" 이 이 lane 이 가장 경계하는 실패 모드다(registry.ts 머리말).
 */
export function createPoolInvoker(opts: PoolInvokerOptions): LlmInvoker {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const rand = opts.rand ?? Math.random;
  const timeoutFor = opts.fetchTimeoutMs ?? envTimeoutMs;
  const attemptsFor = opts.maxAttempts ?? envMaxAttempts;
  const backoffFor = opts.backoffMs ?? ((attempt: number) => Math.min(8_000, 500 * 2 ** Math.max(0, attempt - 1)));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const byKey = new Map(opts.pools.map((p) => [p.key, p]));
  // 라이브에서는 팩토리가 프로세스 1회 읽어 넘긴다(위 주석). 폴백은 직접 조립하는 테스트용이다.
  const cacheBust = opts.cacheBust ?? loadCacheBustConfig();

  return async (req: LlmInvokeRequest, signal: AbortSignal): Promise<LlmInvokeResult> => {
    const coreTask = req.sourceTask ?? req.task;
    // `sourceTask` 가 코어 태스크 문자열이면 어휘 검증을 태운다 — 모르는 태스크는 조용히 기본
    // 모델로 도는 것이 아니라 **명시적으로 죽는다**.
    const laneTask = req.sourceTask ? laneTaskFor(req.sourceTask) : req.task;
    const model = resolveLaneModel(coreTask, req.modelAlias);
    // ⚠️ **풀이 바뀌어도 모델은 안 바뀐다**(스펙 §8.3) — 그래서 모델을 못 받는 풀은 라우팅에서
    //    뺀다. 안 빼면 standby 로 넘어간 그 콜이 404("no such model")로 죽는데, 그 실패는
    //    **OpenRouter 가 아플 때만** 나타나서 평시에 한 번도 안 보인다.
    const declared = taskPoolWeights(coreTask, opts.pools);
    const compat = compatiblePoolWeights(declared, model, opts.pools);
    const weights = compat.weights;
    for (const d of compat.dropped) {
      // 프로세스당 (태스크, 풀) 1회 — 배선 오류는 매 콜 반복되므로 그대로 찍으면 로그가 잠긴다.
      const dedupe = `${coreTask}|${d.poolKey}|${d.modelVendor}`;
      if (warnedIncompatiblePool.has(dedupe)) continue;
      warnedIncompatiblePool.add(dedupe);
      opts.log.warn("analysis_lane.pool_vendor_mismatch", {
        task: coreTask,
        poolKey: d.poolKey,
        poolVendors: d.poolVendors,
        modelId: model.slug,
        modelVendor: d.modelVendor,
        // routed 키다 — 별칭 태스크(semantics_shadow)에는 자기 env 가 없으므로 그 이름을 찍으면
        // 존재하지 않는 키를 고치라고 말하게 된다.
        detail: `${taskPoolsEnvKey(routingTaskFor(coreTask))} 가 ${d.poolKey} 를 지목했지만 그 풀은 ${d.poolVendors.join("|") || "(제약 없음)"} 벤더만 받는다 — 라우팅에서 뺐다`,
      });
    }
    if (weights.length === 0) {
      // 선언 자체가 없었나(배선 미설정), 선언은 있는데 전부 벤더 불일치인가(오배선)를 구분한다.
      throw new PoolCallError(null, declared.length === 0 ? "no_pool_configured" : "no_compatible_pool", "-");
    }
    const maxAttempts = attemptsFor(laneTask);
    const timeoutMs = timeoutFor(laneTask);
    const tried = new Set<string>();
    let lastError: unknown;
    /**
     * F1 — **다음 시도를 이 풀로 못박는다.** standby 가 비재시도 실패(배선·키·모델)를 냈을 때
     * 아직 안 써 본 primary 로 1회 넘기는 자리다. `pickPool` 에 맡기면 게이팅된 primary 대신
     * 게이팅 안 된 **다른 standby** 가 골릴 수 있는데(②가 ③보다 먼저), 지금 필요한 것은
     * "아프지만 90% 는 정상인 primary" 다.
     */
    let forcedPoolKey: string | null = null;
    // 이 호출 1회의 행들. 성공하면 결과에 싣고, 실패하면 예외에 실어 보낸다.
    const rows: AnalysisCallUsage[] = [];
    const emit = (row: AnalysisCallUsage): void => {
      rows.push(row);
      opts.sink(row);
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      signal.throwIfAborted();
      // 페일오버: 직전에 실패한 풀을 **피해서** 고른다. 후보가 없으면 원래 가중치로 돌아간다.
      const candidates = weights.filter((w) => !tried.has(w.poolKey));
      const poolKey = forcedPoolKey ?? pickPool(candidates.length > 0 ? candidates : weights, opts.health, rand);
      forcedPoolKey = null;
      const pool = poolKey ? byKey.get(poolKey) : undefined;
      if (!pool) throw new PoolCallError(null, "no_pool_configured", poolKey ?? "-");
      // ── standby 발화 관측 ───────────────────────────────────────────────────────
      //
      // 평시 트래픽이 0 인 풀이 골렸다 = **primary 가 못 받고 있다**. 원장(`analysis_call_usage`)
      // 의 `poolKey` 가 이미 같은 사실을 담지만(standby 는 평시에 행이 0 이므로 행의 존재
      // 자체가 발화다), 원장은 티켓이 끝나야 적재된다 — 진행 중인 장애는 로그에서 봐야 한다.
      // `standbyCall` 은 CloudWatch 메트릭 필터(`PoolStandbyCalls`)가 세는 **숫자 필드**다.
      const wasStandby = isStandbyPool(weights, pool.key);
      if (wasStandby) {
        opts.log.warn("analysis_lane.pool_standby", {
          task: coreTask,
          poolKey: pool.key,
          modelId: model.slug,
          attempt,
          standbyCall: 1,
          primaryPools: weights.filter((w) => w.weight > 0).map((w) => w.poolKey),
          gatedPools: weights.filter((w) => opts.health.isGated(w.poolKey)).map((w) => w.poolKey),
          triedPools: [...tried],
        });
      }
      tried.add(pool.key);

      const startedAt = new Date(now());
      let status: number | null = null;
      try {
        const out = await callPool({ pool, model, req, signal, timeoutMs, fetchImpl, log: opts.log, cacheBust });
        status = 200;
        const finishedAt = new Date(now());
        const cost = resolveLaneCost({
          canonicalId: model.canonicalId,
          inputTokens: out.inputTokens ?? 0,
          outputTokens: out.outputTokens ?? 0,
          totalCostUsd: out.totalCostUsd,
          upstreamInferenceCostUsd: out.upstreamInferenceCostUsd,
        });
        if (cost.unregisteredModelId) {
          // 장부 사각지대. 코어 `cost.ts:llm.cost.unregistered_model` 과 같은 이름을 쓴다 —
          // 두 lane 의 메트릭 필터가 같은 문자열을 보게 하는 것이 값보다 크다.
          opts.log.warn("llm.cost.unregistered_model", { modelId: cost.unregisteredModelId, task: coreTask, poolKey: pool.key });
        }
        const usage: AnalysisCallUsage = {
          task: laneTask,
          poolKey: pool.key,
          modelId: model.slug,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
          latencyMs: Math.max(0, Math.round(finishedAt.getTime() - startedAt.getTime())),
          costUsd: cost.costUsd,
          attempts: 1,
          outcome: "completed",
          // 게이트③ 판정의 **행 단위 근거**. 없으면 "이 콜이 무캐시였나" 를 사후에 알 길이 없고,
          // 캐시가 섞인 창의 실비·일치율이 조용히 근거로 쓰인다.
          cacheBust: cacheBust.enabled,
          costSource: cost.source,
          httpStatus: 200,
          errorClass: null,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
        };
        opts.health.record(pool.key, false);
        emit(usage);
        return { text: out.text, usage, usageRows: [...rows], traceId: out.traceId, displayModelId: displayModelId(pool.key, model) };
      } catch (e) {
        if (signal.aborted) {
          // 드레인·리스 만료·마감 초과. **실비는 이미 나갔을 수 있다** → 행은 남긴다.
          emit(
            failureRow({ laneTask, pool, model, startedAt, now, outcome: "drained", status: null, errorClass: "aborted", cacheBust: cacheBust.enabled }),
          );
          throw attachRows(e, rows);
        }
        lastError = e;
        // ⚠️ `PoolCallError` 가 아닌 예외도 여기로 온다(우리 코드의 버그·zod 실패 포함). 초판은
        //    그것까지 전부 `network_error` 로 접어서 **코드 결함이 네트워크 장애로 위장**됐다.
        //    이제 `errorName` 이 남으므로 `TypeError` 와 `SocketError` 가 로그에서 갈린다.
        const err =
          e instanceof PoolCallError
            ? e
            : (() => {
                const d = describeFetchError(e);
                return new PoolCallError(null, networkErrorClass(d), pool.key, d);
              })();
        status = err.status;
        // ── F1(b) — **standby 의 실패는 전부 bad 로 센다** ────────────────────────────
        //
        // 기존 규칙은 4xx 를 bad 로 안 센다(요청 자체의 문제일 수 있다 — 스펙 §8.3). 그 규칙이
        // standby 에 그대로 적용되면 **배선이 틀린 standby 가 영원히 게이팅되지 않는다**:
        // 장애마다 골려서 같은 400/401/404 를 내는데 헬스 창의 `badCalls` 는 0 인 채로 남고,
        // 쿨다운이 한 번도 안 걸려 다음 장애에서도 똑같이 그 풀로 간다.
        // primary 의 4xx 취급은 **바꾸지 않는다**(스펙 §8.3 그대로).
        opts.health.record(pool.key, wasStandby ? true : err.retriable);
        const hasUntriedPool = weights.some((w) => !tried.has(w.poolKey));
        // ── F1(a) — standby 의 **비재시도 실패**는 primary 로 1회 폴백 ──────────────────
        //
        // 400(validation)·401(auth)·404(model_not_found)는 "이 풀로는 이 요청이 영영 안 된다" 는
        // 뜻이다. 그런데 standby 가 골린 상황은 정의상 **primary 가 게이팅된 때**이고, 게이팅은
        // "5분 창 실패율 10% 초과" 이지 "primary 가 죽었다" 가 아니다 — 90% 는 아직 답한다.
        // 그대로 죽이면 멀쩡한 primary 를 **한 번도 안 써 보고** 콜이 끝난다.
        const untriedPrimary = weights.filter((w) => w.weight > 0 && !tried.has(w.poolKey));
        const standbyFallback = wasStandby && !err.retriable && untriedPrimary.length > 0;
        const willRetry = (err.retriable || standbyFallback) && attempt < maxAttempts;
        emit(
          failureRow({
            laneTask,
            pool,
            model,
            startedAt,
            now,
            outcome: !willRetry ? "failed" : hasUntriedPool ? "failed_over" : "retried",
            status,
            errorClass: err.errorClass,
            cacheBust: cacheBust.enabled,
          }),
        );
        opts.log.warn("analysis_lane.llm_call_failed", {
          task: coreTask,
          poolKey: pool.key,
          modelId: model.slug,
          attempt,
          status,
          errorClass: err.errorClass,
          // D-8 — 이 넷이 없으면 `status:null · network_error` 만 남고 원인이 사라진다.
          errorName: err.detail?.errorName ?? null,
          errorCode: err.detail?.errorCode ?? null,
          causeName: err.detail?.causeName ?? null,
          causeCode: err.detail?.causeCode ?? null,
          detail: err.detail?.message ?? null,
          latencyMs: Math.max(0, Math.round(now() - startedAt.getTime())),
          retriable: err.retriable,
          willRetry,
          // 무캐시 창에서 난 실패인지가 게이트③ 판정에 들어간다(실비·지연 분포가 달라진다).
          cacheBust: cacheBust.enabled,
        });
        if (standbyFallback) {
          // **게이팅을 무시하고** 아직 안 써 본 primary 로 넘긴다(`pickPool` ③ 경로).
          forcedPoolKey = pickPool(untriedPrimary, opts.health, rand);
          opts.log.warn("analysis_lane.pool_standby_wiring_failed", {
            task: coreTask,
            poolKey: pool.key,
            modelId: model.slug,
            status,
            errorClass: err.errorClass,
            fallbackPoolKey: forcedPoolKey,
            detail:
              "standby 가 비재시도 실패(배선·키·모델 형식)를 냈다 — 게이팅된 primary 로 1회 폴백한다. " +
              "이 standby 는 헬스에 bad 로 기록돼 스스로 게이팅된다.",
          });
        }
        if (!willRetry) throw attachRows(err, rows);
        // 스펙 §8.3: **429/5xx → 다른 풀로 1회 페일오버 후 backoff.** 아직 안 써 본 풀이
        // 남아 있으면 즉시 그쪽으로 넘긴다(대기 없이) — 대기부터 하면 분산의 의미가 없다.
        if (!hasUntriedPool) await sleep(backoffFor(attempt));
      }
    }
    throw attachRows(lastError instanceof Error ? lastError : new PoolCallError(null, "exhausted", "-"), rows);
  };
}

/** 예외에 콜 원장 행을 붙인다. `PoolCallError` 가 아닌 예외(취소 등)에도 붙는다. */
function attachRows(error: unknown, rows: AnalysisCallUsage[]): unknown {
  if (error instanceof PoolCallError) {
    error.usageRows = [...rows];
    return error;
  }
  if (error !== null && typeof error === "object") {
    (error as { usageRows?: AnalysisCallUsage[] }).usageRows = [...rows];
  }
  return error;
}

function failureRow(args: {
  laneTask: AnalysisTask;
  pool: PoolConfig;
  model: ResolvedLaneModel;
  startedAt: Date;
  now: () => number;
  outcome: "retried" | "failed_over" | "failed" | "drained";
  status: number | null;
  errorClass: string;
  cacheBust: boolean;
}): AnalysisCallUsage {
  const finishedAt = new Date(args.now());
  return {
    task: args.laneTask,
    poolKey: args.pool.key,
    modelId: args.model.slug,
    // ⚠️ 실패한 콜의 토큰·비용은 **미계측(null)** 이다. 0 이 아니다 — 업스트림이 이미 프롬프트를
    //    읽었을 수 있고(429 는 아니지만 5xx·타임아웃은 그렇다), 0 으로 쓰면 낭비 비용이 사라진다.
    inputTokens: null,
    outputTokens: null,
    latencyMs: Math.max(0, Math.round(finishedAt.getTime() - args.startedAt.getTime())),
    costUsd: null,
    attempts: 1,
    outcome: args.outcome,
    cacheBust: args.cacheBust,
    costSource: null,
    httpStatus: args.status,
    errorClass: args.errorClass.slice(0, 64),
    startedAt: args.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
  };
}

/**
 * 공급자가 보고한 토큰 수 → **정수 또는 null(미계측)**.
 *
 * 초판은 `typeof === "number"` 만 봤다. 그 값은 우리가 정하는 것이 아니라 업스트림 JSON 이
 * 주는 것이고(집계·캐시 할인·가중 토큰을 소수로 보고하는 공급자가 있다), 소수가 그대로 흐르면
 * 답장 조립의 `toReplyUsage`(`z.number().int()`)가 던져 **완주한 분석이 deferred 로 뒤집힌다**
 * — 실비를 다 쓰고 결과를 버린 뒤 같은 턴을 또 유료로 돌린다. 0003 컬럼도 정수이므로
 * 어차피 정수로 좁혀야 하고, 반올림 오차는 토큰 1개 미만이다.
 */
function tokenCount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
}

interface PoolCallResult {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalCostUsd: number | undefined;
  upstreamInferenceCostUsd: number | undefined;
  traceId: string;
}

/** 업스트림 실패 메시지의 로그 상한. 공급자가 본문을 통째로 실어 보내는 경우가 있다. */
const UPSTREAM_MESSAGE_MAX_CHARS = 200;
/** JSON 이 아닌 본문에서 남기는 앞머리 길이. */
const BODY_HEAD_MAX_CHARS = 120;

function upstreamMessage(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, UPSTREAM_MESSAGE_MAX_CHARS) : null;
}

/**
 * **JSON 이 아닌 본문의 앞머리 — 모양만 남긴다.**
 *
 * ASCII 인쇄 가능 문자(영숫자·구두점·공백)만 통과시키고 나머지는 `*` 로 덮는다. 여기 오는 본문은
 * 대개 게이트웨이 HTML·프록시 에러 문자열이라 `<html><title>504 Gateway Time-out` 같은
 * **원인 문자열은 그대로 읽히고**, 답변 본문이 섞여 있을 경우의 한글·CJK 는 통째로 마스킹된다.
 * (`app/log.ts` 머리말: 답변 텍스트는 길이·해시까지만.)
 */
function maskedBodyHead(raw: string): string {
  // 제어문자(`\n` 포함)도 여기서 같이 덮인다 — 안 덮으면 한 줄 JSON 로그가 깨진다.
  return raw.slice(0, BODY_HEAD_MAX_CHARS).replace(/[^\x20-\x7E]/g, "*");
}

/** 콘텐츠 파트 배열 → 텍스트. `type` 이 없거나 `"text"` 인 파트만 이어붙인다(thinking 블록 제외). */
function contentPartsToText(parts: ChatContentPart[]): string {
  let out = "";
  for (const p of parts) {
    if (p !== null && typeof p === "object" && typeof p.text === "string" && (p.type === undefined || p.type === "text")) out += p.text;
  }
  return out;
}

interface BodyVerdict {
  /** 쓸 수 있는 본문이면 텍스트. 실패면 `null` 이고 `errorClass` 가 채워진다. */
  text: string | null;
  errorClass: string | null;
  /** 콘텐츠 파트 배열을 이어붙여 수용한 경우의 파트 수. 문자열 content 면 `null`. */
  contentPartCount: number | null;
  /** `analysis_lane.llm_malformed_body` 에 실을 **모양만**의 필드. 답변 텍스트·프롬프트는 없다. */
  shape: Record<string, unknown>;
}

/**
 * **200 응답 본문의 판정.** 상태 코드가 아니라 본문이 결론을 낸다(D-7).
 *
 * 순서가 설계다 — **공급자 실패 신호를 content 보다 먼저 본다.** 문서의 비스트리밍 중도 실패
 * 예시는 `content: "partial output..."` 과 `finish_reason: "error"` 를 **함께** 싣는다. content 를
 * 먼저 받아들이면 그 반쪽짜리 출력이 "성공" 으로 올라가고, `response_format: json_object` 를 건
 * 태스크에서는 파싱 실패로 **벤더 층 재시도 예산**만 태운다(페일오버는 여기서만 가능하다).
 *
 * ⚠️ `finish_reason: "length"` 인데 **content 가 있는** 정상 절단은 건드리지 않는다 — 지금까지처럼
 *    그대로 통과시키고 잘린 JSON 의 처리는 벤더 코드에 맡긴다(이 PR 은 분류만 고친다).
 */
function classifyResponseBody(json: ChatResponseBody, bytes: number): BodyVerdict {
  const choice = json.choices?.[0];
  const content = choice?.message?.content;
  const reasoning = choice?.message?.reasoning ?? choice?.reasoning;
  const parts = Array.isArray(content) ? (content as ChatContentPart[]) : null;
  const text = typeof content === "string" ? content : parts ? contentPartsToText(parts) : "";
  const shape: Record<string, unknown> = {
    provider: json.provider ?? null,
    id: json.id ?? null,
    finishReason: choice?.finish_reason ?? null,
    nativeFinishReason: choice?.native_finish_reason ?? null,
    choicesLength: Array.isArray(json.choices) ? json.choices.length : 0,
    // 자료형만. 값은 싣지 않는다.
    contentType: content === null ? "null" : parts ? "array" : typeof content,
    contentLength: text.length,
    reasoningLength: typeof reasoning === "string" ? reasoning.length : 0,
    errorCode: json.error?.code ?? null,
    errorMessage: upstreamMessage(json.error?.message),
    choiceErrorCode: choice?.error?.code ?? null,
    choiceErrorMessage: upstreamMessage(choice?.error?.message),
    completionTokens: json.usage?.completion_tokens ?? null,
    bytes,
  };
  const fail = (errorClass: string): BodyVerdict => ({ text: null, errorClass, contentPartCount: null, shape });

  if (json.error !== undefined || choice?.error !== undefined || choice?.finish_reason === "error") {
    return fail(BODY_ERROR_CLASS.providerMidGeneration);
  }
  if (text.length > 0) return { text, errorClass: null, contentPartCount: parts ? parts.length : null, shape };
  if (choice?.finish_reason === "length") return fail(BODY_ERROR_CLASS.truncatedEmpty);
  if ((shape.reasoningLength as number) > 0) return fail(BODY_ERROR_CLASS.reasoningOnlyEmpty);
  return fail(BODY_ERROR_CLASS.emptyContent);
}

/**
 * OpenAI 호환 `/chat/completions` 한 번. 요청 바디는 코어 `invoke.ts:487~512` +
 * `openrouter.ts:159~180` 과 **같은 필드**다:
 *   messages = [system?] + user · max_tokens · temperature · response_format ·
 *   reasoning · usage:{include:true}(OpenRouter 전용)
 *
 * ⚠️ **lane 이 기본값을 발명하지 않는다.** 값의 주인은 벤더 코드이고, 오지 않은 필드는
 *    보내지 않는다 — 그래야 "코어가 보낸 바디 = lane 이 보낸 바디" 가 필드 단위로 참이고,
 *    매핑이 값을 떨어뜨렸을 때 그 사실이 업스트림 기본값으로 **가려지지 않는다**.
 */
async function callPool(args: {
  pool: PoolConfig;
  model: ResolvedLaneModel;
  req: LlmInvokeRequest;
  signal: AbortSignal;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  /** 200 인데 못 쓰는 본문의 **모양**을 남기는 자리(D-7). 본문 값은 여기 밖으로 나가지 않는다. */
  log: LaneLogger;
  /** 게이트③ 무캐시 측정 태세. `enabled=false` 면 아래 조립은 **한 바이트도 달라지지 않는다**. */
  cacheBust: CacheBustConfig;
}): Promise<PoolCallResult> {
  const { pool, model, req, timeoutMs, fetchImpl, log, cacheBust } = args;
  const apiKey = poolApiKey(pool);
  if (!apiKey) throw new PoolCallError(null, "missing_api_key", pool.key);

  // ── 풀 방언 — **직결 풀에 OpenRouter 전용 필드를 보내지 않는다** ──────────────────
  //
  // `usage.include` · `reasoning` 은 OpenRouter 통합 확장이고, 벤더 직결은 모르는 파라미터에
  // **400(validation)** 으로 답한다. 400 은 재시도 불가(`PoolCallError.retriable`)라 페일오버가
  // 필요한 바로 그 순간에 standby 가 한 번도 답을 못 내고 죽는다.
  const wire = poolWireFields(pool);

  // ── 캐시 무효화 (게이트③, 운영 결정 2026-09-13) ────────────────────────────────────
  //
  // ⚠️ **콜 1회마다 새 uuid 다** — 티켓·태스크 단위로 재사용하면 재시도·페일오버가 같은 접두를
  //    다시 보내 두 번째 콜이 **자기 첫 콜의 캐시에 맞는다**(OpenAI TTL 기본 30분). 게이트 창
  //    안에서 그 히트가 섞이면 측정이 조용히 오염된다. 수단 선택 근거는 `cache-bust.ts` 머리말.
  const bustToken = cacheBust.enabled ? randomUUID() : null;
  // 게이트③ `params` 모드를 못 받는 풀에서는 **nonce 로 내려앉는다.** 그냥 빼면 그 콜만
  // 공급자 캐시에 맞아 게이트 창이 조용히 오염된다(실패가 아니라 오답) — 무효화 자체를
  // 포기하지는 않는다. 접두 nonce 는 공급자 무관하게 성립한다(`cache-bust.ts` 머리말).
  const paramsWanted = bustToken !== null && modeUsesParams(cacheBust.mode);
  const paramsSent = paramsWanted && wire.promptCacheParams;
  const nonce =
    bustToken !== null && (modeUsesNonce(cacheBust.mode) || (paramsWanted && !wire.promptCacheParams))
      ? cacheBustNonce(bustToken)
      : null;
  if (paramsWanted && !paramsSent) {
    log.warn("analysis_lane.cache_bust_degraded", {
      task: req.sourceTask ?? req.task,
      poolKey: pool.key,
      dialect: pool.dialect,
      mode: cacheBust.mode,
      appliedMode: "nonce",
    });
  }

  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });
  messages.push({ role: "user", content: req.prompt });
  if (nonce !== null) {
    // **렌더된 접두의 맨 앞**이어야 한다. system 이 있으면 거기가 맨 앞이고, 없으면 user 가
    // 맨 앞이다 — 그래서 "system 에 넣는다" 가 아니라 **첫 메시지에 넣는다**. system 이 없는
    // 태스크에 system 메시지를 새로 만들어 끼우지 않는 이유는 요청 **모양**을 바꾸지 않기
    // 위해서다(모양이 바뀌면 캐시가 아니라 프롬프트가 달라진 A/B 가 된다).
    messages[0] = { ...messages[0]!, content: prefixWithNonce(messages[0]!.content, nonce) };
  }

  // ── response_format ──────────────────────────────────────────────────────────────
  //
  // 스키마가 없는 요청은 기존과 **같은 바디**다(json_object 또는 미전송). 스키마가 있으면 방언이
  // 받는 풀에만 json_schema 객체를 그대로 싣고, 못 받는 풀에서는 json_object 로 강등한다.
  // 강등은 실패가 아니라 품질 차이(스키마 보장 없음)라 콜은 성공한다. 그래서 로그를 남긴다:
  // 안 남기면 "켰는데 스키마가 안 걸린 콜" 이 원장에서 구분되지 않는다.
  let responseFormatField: Record<string, unknown> = {};
  if (req.jsonSchema !== undefined && wire.jsonSchema) {
    responseFormatField = { response_format: { type: "json_schema", json_schema: req.jsonSchema } };
  } else if (req.jsonSchema !== undefined || req.responseFormat === "json") {
    responseFormatField = { response_format: { type: "json_object" } };
    if (req.jsonSchema !== undefined) {
      log.warn("analysis_lane.json_schema_degraded", {
        task: req.sourceTask ?? req.task,
        poolKey: pool.key,
        dialect: pool.dialect,
        schemaName: req.jsonSchema.name,
        appliedFormat: "json_object",
      });
    }
  }

  const body: Record<string, unknown> = {
    model: wireModelId(pool, model),
    messages,
    // ⚠️ **기본값을 두지 않는다.** 초판은 `?? 1024` · `?? 0.2` 였다. 벤더 4 호출부가 전부
    //    `maxTokens`·`temperature: 0` 을 명시하므로(`llm.ts:304~305`·`:591~592`·`:806~807`,
    //    `citation-classify.ts:300~301`) 그 기본값은 **닿지 않는 죽은 코드**이고, 닿는 날이
    //    온다면 그건 매핑이 값을 떨어뜨린 날이다 — 그때 `temperature: 0.2` 를 몰래 끼워 넣으면
    //    결정성 전제(스펙 §6.3: 분석 4태스크 전부 0)가 **조용히** 깨진다. 없으면 안 보낸다.
    // ⚠️ **필드 이름이 풀마다 다르다**(2026-09-13 라이브 실측). OpenAI 직결의 luna 는
    //    `max_tokens` 를 400 으로 거부하고 `max_completion_tokens` 를 요구한다.
    ...(req.maxOutputTokens === undefined ? {} : { [wire.maxTokensField]: req.maxOutputTokens }),
    // ⚠️ **openai 직결에는 안 보낸다** — 같은 실측에서 luna 가 `temperature: 0` 을 400 으로
    //    거부했다("Only the default (1) value is supported"). 스펙 §6.3 의 결정성 전제가 그
    //    콜에서만 깨지지만, 선택지가 없다: 보내면 **답이 아예 없다**. 품질 각주는 README.
    ...(req.temperature === undefined || !wire.temperature ? {} : { temperature: req.temperature }),
    ...responseFormatField,
    // ⚠️ `reasoning` 은 **OpenRouter 통합 파라미터**다(코어 `openrouter.ts`). 벤더 직결에는
    //    같은 이름의 필드가 없어 400 이다. 그래서 방언이 안 받는 풀에서는 **안 보낸다** —
    //    "코어가 보낸 바디 = lane 이 보낸 바디" 는 OpenRouter 축에서 유지되고(그 풀은 그대로),
    //    직결은 **애초에 다른 API** 다. 대가는 그 콜의 reasoning 예산이 공급자 기본값이 되는
    //    것이고, 그건 standby(=장애 중)에서만 일어난다. 400 으로 못 답하는 것보다 낫다.
    ...(req.reasoning && wire.reasoning ? { reasoning: req.reasoning } : {}),
    // ⚠️ 공급자 파라미터 opt-out 은 **기본값이 아니다**(`params`/`both` 에서만). OpenAI 계열
    //    전용이고 OpenRouter 통과가 문서로 보장되지 않아, 미지원이면 400(validation)으로
    //    돌아와 게이트 창 전체를 죽일 수 있다 — `cache-bust.ts` 머리말의 인용 참조.
    ...(paramsSent && bustToken !== null ? cacheBustParams(bustToken) : {}),
  };
  // `usage.include` 는 OpenRouter 전용 확장이다. 직결 풀에 보내면 400(validation) 이 날 수 있다.
  // ⚠️ 판정축이 `vendorReportsCost`(= 비용 출처) 에서 **방언**으로 옮겼다. 두 값은 지금 내장
  //    3풀에서 일치하지만 뜻이 다르다 — "실비를 보고하나" 와 "이 필드를 받나" 는 별개이고,
  //    커스텀 풀이 한쪽만 켜는 순간 갈린다.
  if (wire.usageInclude) body.usage = { include: true };

  // 바깥 신호(리스 만료·드레인·콜 전체 예산)와 **둘 중 먼저 오는 쪽**으로 끊는다.
  // ⚠️ `AbortSignal.timeout` 이 아니라 `withDeadline` 이다 — 그쪽 타이머는 unref 라 루프가
  //    비면 건너뛴다(위 주석 참고). 요청 상한이 조용히 사라지면 한 콜이 슬롯을 무한 점유한다.
  let response: Response;
  try {
    response = await withDeadline(timeoutMs, args.signal, (combined) =>
      fetchImpl(`${pool.baseUrl}/chat/completions`, {
        method: "POST",
        signal: combined,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...pool.extraHeaders },
        body: JSON.stringify(body),
      }),
    );
  } catch (err) {
    if (args.signal.aborted) throw err; // 바깥 신호 — 상위가 drained 로 처리한다
    // ⚠️ **원인 코드를 버리지 않는다**(D-8). 여기서 접으면 `network_error` 171건처럼 사후에
    //    "제공자 리셋인가 NAT 인가 stale 소켓인가" 를 가를 근거가 통째로 사라진다.
    const detail = describeFetchError(err);
    const timedOut = detail.errorName === "TimeoutError";
    throw new PoolCallError(null, timedOut ? "fetch_timeout" : networkErrorClass(detail), pool.key, detail);
  }

  if (!response.ok) {
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    throw new PoolCallError(response.status, inferErrorClass(response.status, parsed), pool.key);
  }

  // ⚠️ `response.json()` 이 아니라 `text()` + `JSON.parse` 다 — **파싱이 실패했을 때 남길 것이
  //    있어야 한다.** `json()` 은 실패하면 본문을 통째로 삼키므로 "왜 못 읽었나" 가 사라진다.
  //    바이트 수도 여기서만 정확히 센다(응답 크기는 절단·게이트웨이 개입의 지문이다).
  const task = req.sourceTask ?? req.task;
  const stamp = { task, poolKey: pool.key, modelId: model.slug, status: response.status, cacheBust: cacheBust.enabled };
  let raw: string;
  try {
    raw = await response.text();
  } catch (e) {
    // 헤더는 왔는데 **바디를 받다가 끊긴** 자리다 — 라이브 관측의 중앙 지연 5.8s 가 정확히 이
    // 모양이다(`TypeError: terminated` / `cause.code = UND_ERR_SOCKET`).
    if (args.signal.aborted) throw e; // 바깥 신호 — 상위가 drained 로 처리한다
    const detail = describeFetchError(e);
    throw new PoolCallError(null, networkErrorClass(detail), pool.key, detail);
  }
  const bytes = Buffer.byteLength(raw, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // 여기가 `malformed_response` 의 **유일한** 자리다(D-7) — 본문이 JSON 응답 객체가 아니다.
    log.warn("analysis_lane.llm_malformed_body", { ...stamp, errorClass: "malformed_response", bytes, bodyHead: maskedBodyHead(raw) });
    throw new PoolCallError(response.status, "malformed_response", pool.key);
  }
  const json = parsed as ChatResponseBody;
  const verdict = classifyResponseBody(json, bytes);
  if (verdict.errorClass !== null || verdict.text === null) {
    const errorClass = verdict.errorClass ?? BODY_ERROR_CLASS.emptyContent;
    log.warn("analysis_lane.llm_malformed_body", { ...stamp, errorClass, ...verdict.shape });
    throw new PoolCallError(response.status, errorClass, pool.key);
  }
  if (verdict.contentPartCount !== null) {
    // 배열 content 는 수용한다 — 다만 **조용히** 수용하지 않는다. 어느 공급자가 언제부터
    // 파트로 답하기 시작했는지가 안 보이면, 다음에 파트 모양이 또 바뀔 때 같은 눈을 감는다.
    log.info("analysis_lane.llm_content_parts", { ...stamp, parts: verdict.contentPartCount, contentLength: verdict.text.length, provider: json.provider ?? null });
  }
  return {
    text: verdict.text,
    // ⚠️ usage 가 없으면 **null(미계측)** 이다 — 0 으로 위조하지 않는다(0003 NULL 규율).
    // ⚠️ 값이 있으면 **정수로 접는다**(`tokenCount`). 공급자가 소수·비유한 값을 보고하는 것은
    //    우리가 막을 수 없고, 그것이 그대로 흐르면 답장 조립(`toReplyUsage`)이 던져 **완주한
    //    분석이 버려진다**(그 함수 머리말의 경로). 0003 컬럼도 정수다.
    inputTokens: tokenCount(json.usage?.prompt_tokens),
    outputTokens: tokenCount(json.usage?.completion_tokens),
    totalCostUsd: json.usage?.total_cost ?? json.usage?.cost,
    upstreamInferenceCostUsd: json.usage?.cost_details?.upstream_inference_cost,
    traceId: json.id ?? randomUUID(),
  };
}

/**
 * **프로덕션 배선.** `worker/main.ts` `main()` 이 이것을 부른다 — **DB 접속·마이그레이션보다
 * 먼저**. 순서가 설계다:
 *
 * ⚠️ **`engine === "core"` 인데 활성 풀이 0 이면 여기서 던진다 — 첫 티켓이 아니라 기동 시점에.**
 *    키 없이 뜨면 큐를 끌어다 전부 실패시키고, 그 실패는 `deferred` 로 쌓여 재시도 예산만 태운다.
 *    던진 예외는 `main().catch` 가 `process.exit(1)` 로 받는다. 호출 지점이 DB 뒤로 밀리면
 *    실패할 기동이 매번 커넥션·마이그레이션 락을 먼저 잡는다.
 *    스텁 엔진일 때는 풀을 요구하지 않는다(LLM 을 안 부른다).
 * ⚠️ `PoolHealth` 는 **팩토리 1개당 1개**다 — 티켓마다 새로 만들면 5분 창이 매번 비어
 *    헬스 게이팅이 영원히 발화하지 않는다. 그래서 팩토리는 프로세스당 1회만 만든다.
 *
 * 배선 여부 자체는 `tests/silent-failure-gate.test.ts` (a) 가 **워커를 자식 프로세스로 띄워**
 * 판정한다 — 이 함수를 직접 부르는 단위 테스트는 "가드가 있다"만 증명하고 "배선돼 있다"는
 * 증명하지 못한다(실제로 그 간극으로 스텁 invoker 가 꽂힌 채 통과했다).
 */
export function createLaneInvokerFactory(args: {
  semaphore: Semaphore;
  acquireTimeoutMs: number;
  requestTimeoutMs: number;
  log: LaneLogger;
  engine: string;
  /** 콜 원장 후처리 훅(선택). 기본은 no-op — 행은 `LlmInvokeResult.usageRows` 로도 올라간다. */
  sink?: (row: AnalysisCallUsage) => void;
  /**
   * **테스트 전용 소켓 교체.** `createPoolInvoker.fetchImpl` 과 같은 자리이고, 여기 있는 이유는
   * "라이브 배선 그대로 재현" 을 테스트가 할 수 있게 하기 위해서다 — 워커가 실제로 조립하는
   * 것은 이 팩토리이므로, 안쪽 `createPoolInvoker` 를 테스트가 손으로 다시 조립하면
   * **팩토리 자신의 결함(래퍼 순서·헬스 공유·풀 필터)은 영영 안 잡힌다**.
   * ⚠️ `worker/main.ts` 는 이것을 넘기지 않는다 — 넘기는 순간 라이브가 가짜 소켓으로 돈다.
   */
  fetchImpl?: typeof fetch;
  /** 게이트③ 태세. 생략하면 **여기서 프로세스 env 를 1회** 읽는다(라이브 경로). */
  cacheBust?: CacheBustConfig;
}): (ticketId: string) => LlmInvoker {
  const pools = loadPools().filter((p) => poolApiKey(p) !== null);
  if (args.engine === "core" && pools.length === 0) {
    throw new Error(
      "ANALYSIS_ENGINE=core requires at least one provider pool with an API key " +
        `(tried: ${loadPools().map((p) => `${p.key}<-${p.apiKeyEnv}`).join(", ") || "none"}). ` +
        "키 없이 기동하면 큐를 끌어다 전부 실패시킨다 — 여기서 죽는 것이 맞다.",
    );
  }
  // ⚠️ standby 요약을 **여기서 함께** 낸다. CDK 가드는 "context 에 키 필드 이름이 있나" 까지만
  //    보므로, 시크릿의 그 JSON 필드가 빈 값이면 TD 는 정상이고 env 도 들어오는데 풀만 비활성이다
  //    — 선언만 남고 페일오버는 영영 안 일어난다. 배포는 성공하고 아무 알람도 안 운다.
  const standby = summarizeTaskStandby(pools);
  args.log.info("analysis_lane.pools_ready", {
    engine: args.engine,
    pools: pools.map((p) => p.key),
    disabled: loadPools().filter((p) => poolApiKey(p) === null).map((p) => p.key),
    taskStandby: standby.map((s) => ({ task: s.coreTask, primary: s.primary, standby: s.standby })),
  });
  // F3 — **primary 가 0 인데 standby 가 있다** = 평시 트래픽이 통째로 직결로 간다.
  // `OPENROUTER_API_KEY` 가 비면 정확히 이 모양이 된다(키 없는 풀은 `taskPoolWeights` 가
  // 조용히 뺀다). 콜마다 `pool_standby` 가 찍히므로 시끄럽기는 하지만, 그 로그는 "장애 중"
  // 을 뜻하는데 여기서는 **상시**다 — 기동에서 한 번 이름을 붙여 둬야 오독하지 않는다.
  for (const s of standby.filter((x) => x.primary.length === 0 && x.standby.length > 0)) {
    args.log.warn("analysis_lane.pool_primary_missing", {
      task: s.coreTask,
      envKey: s.envKey,
      standby: s.standby,
      detail:
        "평시 트래픽을 받을 풀(weight>0)이 하나도 활성이 아니다 — 이 태스크는 **직결 100%** 로 돈다. " +
        "OPENROUTER_API_KEY 가 비었는지 먼저 확인하라.",
    });
  }
  for (const s of standby.filter((x) => x.declaredButInactive.length > 0)) {
    args.log.warn("analysis_lane.pool_standby_unwired", {
      task: s.coreTask,
      envKey: s.envKey,
      declaredButInactive: s.declaredButInactive,
      detail:
        "standby 로 선언됐는데 활성 풀이 아니다(키 없음) — 그 태스크는 페일오버 없이 돈다. " +
        "시크릿의 해당 JSON 필드가 비었는지 확인하라.",
    });
  }
  const health = new PoolHealth();
  // ⚠️ **프로세스 1회.** `createPoolInvoker` 는 티켓마다 불리므로 그 안에서 읽으면 게이트 창
  //    중간의 env 변화가 티켓 사이에 섞인다. 여기서 한 번 읽어 전 티켓이 같은 태세로 돈다.
  //    (모르는 모드 값이면 이 호출이 던져 **기동에서** 죽는다 — 첫 티켓이 아니라.)
  const cacheBust = args.cacheBust ?? loadCacheBustConfig();
  const sink = args.sink ?? ((): void => {});
  return (ticketId: string): LlmInvoker => {
    const inner = createPoolInvoker({
      pools,
      health,
      log: {
        info: (e, f) => args.log.info(e, { ...f, ticketId }),
        warn: (e, f) => args.log.warn(e, { ...f, ticketId }),
        error: (e, f) => args.log.error(e, { ...f, ticketId }),
      },
      sink,
      cacheBust,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    });
    return buildInvoker(
      { semaphore: args.semaphore, acquireTimeoutMs: args.acquireTimeoutMs, requestTimeoutMs: args.requestTimeoutMs },
      inner,
    );
  };
}
