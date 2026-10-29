// 전역 HTTP 디스패처(undici) 명시 — **keep-alive 값을 암묵 기본값에 맡기지 않는다** (D-8).
//
// ── 무엇을 고치려는 것인가
//
//   2026-09-13 라이브 25분: `analysis_lane.llm_call_failed` 171건이 전부
//   `status:null · errorClass:"network_error"` 였다(luna 118 · flash-lite 51 · haiku 2).
//   재시도로 전량 회복했으므로 데이터 손실은 없었지만 **왜 끊겼는지가 남지 않았다.**
//   원인 코드 관측은 `worker/invoker.ts`(`describeFetchError`)가 맡고, 이 파일은 그중 한
//   가설 — **유휴 소켓 재사용(stale keep-alive)** — 을 싸게 줄이는 쪽이다.
//
//   ⚠️ **이 가설은 관측과 부분적으로 어긋난다는 것을 먼저 적어 둔다.** 실패 지연이 1.4~15s
//      (중앙 5.8s)였다 = 요청이 나간 뒤 **응답을 기다리는 중** 끊겼다는 뜻이다. 죽은 소켓을
//      재사용했다면 실패는 요청 쓰기 시점(수십 ms)에 났어야 한다. 그러므로 이 파일은 원인
//      규명이 아니라 **가설 하나를 제거하는 장치**이고, 판정은 다음 관측이 한다.
//
// ── 왜 `import { Agent, setGlobalDispatcher } from "undici"` 가 아닌가 (기각한 대안)
//
//   `undici` 는 이 리포의 의존성이 아니고 Node 는 그것을 **공개 모듈로 노출하지 않는다**
//   (`import("undici")` → `ERR_MODULE_NOT_FOUND`, node 20.20.2·26.8.1 실측). npm 패키지를
//   새로 넣으면 런타임(node 20)과 로컬 개발(node 26)의 내장 undici 메이저가 서로 달라
//   **디스패처 계약이 어긋나면 `fetch` 전체가 깨진다.** 값 하나를 세우려고 그 위험을 사지 않는다.
//
//   대신 **런타임이 이미 쓰고 있는 바로 그 Agent 클래스**를 재사용한다. `setGlobalDispatcher`
//   가 하는 일이 정확히 `globalThis[<전역 디스패처 심볼>] = dispatcher` 이고, 현재 값의
//   `constructor` 가 곧 그 런타임의 `Agent` 다. 버전 스큐가 **구조적으로 불가능**해진다.
//
// ── ⚠️ 심볼이 **둘**이다 (2026-09-13 실측 — 이걸 모르면 node 26 에서 조용히 실패한다)
//
//   | node     | `undici.globalDispatcher.1` | `undici.globalDispatcher.2` |
//   |----------|-----------------------------|-----------------------------|
//   | 20.20.2  | `Agent`                     | (없음)                      |
//   | 26.8.1   | `Dispatcher1Wrapper`(구버전 호환 래퍼) | `Agent`          |
//
//   node 26 에서 `.1` 의 `constructor` 로 만들면 `Dispatcher1Wrapper` 가 되고 그 생성자는
//   `InvalidArgumentError: Argument dispatcher must implement dispatch` 로 **던진다.**
//   그래서 **`.2` 가 있으면 그쪽을 먼저** 본다. 읽은 심볼에 그대로 되쓴다.
//
//   ⚠️ 두 심볼 모두 **게으르다** — 최초 fetch 계열 사용 전까지 `undefined` 다(실측).
//      `new Request(…)` 한 번이면 초기화된다(네트워크 0 · DNS 0). 그래서 아래에서 먼저 만든다.
//
// ── 실패하면 조용히 넘어가지 않는다
//
//   심볼이 없거나 생성자가 다른 모양이면 **기본값 그대로 두고 `applied:false` 와 이유를**
//   돌려준다. 워커 기동 로그가 그 사실을 찍는다 — 이 lane 이 가장 경계하는 실패 모드가
//   "배선이 없는데 있는 것처럼 보이는 것" 이다(`worker/main.ts` 성공 위장 차단 머리말).

/** 구버전(≤ node 20 내장 undici 6) 및 npm `undici` 의 전역 디스패처 자리. */
const GLOBAL_DISPATCHER_V1 = Symbol.for("undici.globalDispatcher.1");
/** 신버전(node 26 내장 undici) 의 자리. 있으면 **이쪽이 실물**이다. */
const GLOBAL_DISPATCHER_V2 = Symbol.for("undici.globalDispatcher.2");

export interface HttpKeepAliveOptions {
  /**
   * 유휴 소켓을 붙들고 있는 시간(ms). **업스트림이 먼저 끊는 시간보다 짧아야** 죽은 소켓을
   * 다시 쓰지 않는다. 기본 4,000 은 Node 내장 undici 의 기본값과 같은 값이다 — 즉 기본 상태의
   * 이 호출은 **동작을 바꾸지 않고 값을 명시적·관측 가능하게만** 만든다. 더 조이려면 env 로 내린다.
   */
  keepAliveTimeoutMs: number;
  /**
   * 서버가 `keep-alive: timeout=N` 으로 더 긴 값을 광고해도 **여기까지만** 받아들인다.
   * ⚠️ 내장 기본값은 600,000ms(10분)다 — 게이트웨이가 긴 값을 광고해 놓고 실제로는 먼저 끊는
   *    조합에서 유휴 소켓이 10분까지 남을 수 있고, 그게 stale 재사용 가설의 실체다. 기본 10s.
   */
  keepAliveMaxTimeoutMs: number;
  /**
   * 오리진당 커넥션 상한. **기본은 `null`(무제한) = 현행 동작이다.**
   * ⚠️ 유한 값을 주면 그 수를 넘는 요청이 undici 큐에서 대기한다 — 콜 세마포어(최대 640)보다
   *    작게 잡으면 **lane 처리량이 조용히 여기서 막힌다.** 근거 없이 채우지 않는다.
   */
  connections: number | null;
}

export interface HttpKeepAliveSummary extends HttpKeepAliveOptions {
  applied: boolean;
  /** 못 적용했을 때의 이유(기동 로그에 남는다). 적용했으면 `null`. */
  reason: string | null;
  /** 교체 후 디스패처 클래스 이름 — 실제로 바뀌었는지의 증거. */
  dispatcher: string | null;
  /** 어느 심볼을 썼는가(`1` | `2`). 런타임 판별의 흔적. */
  slot: 1 | 2 | null;
}

/**
 * 전역 디스패처를 **명시된 옵션으로** 교체한다. 순수하지 않다(프로세스 전역) — 기동 1회만 부른다.
 * 테스트를 위해 전역 객체를 주입받는다. 기본값은 `globalThis`.
 */
export function configureHttpKeepAlive(
  opts: HttpKeepAliveOptions,
  scope: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>,
): HttpKeepAliveSummary {
  const base: HttpKeepAliveSummary = { ...opts, applied: false, reason: null, dispatcher: null, slot: null };
  if (!(opts.keepAliveTimeoutMs > 0) || !(opts.keepAliveMaxTimeoutMs >= opts.keepAliveTimeoutMs)) {
    return { ...base, reason: "invalid_keepalive_values" };
  }
  try {
    // 게으른 심볼을 깨운다 — **네트워크를 타지 않는다**(URL 파싱만 한다).
    if (scope[GLOBAL_DISPATCHER_V2] === undefined && scope[GLOBAL_DISPATCHER_V1] === undefined && typeof Request === "function") {
      new Request("http://analysis-lane.invalid/");
    }
  } catch {
    /* Request 가 없거나 던지면 아래 분기가 잡는다 */
  }
  const slot: 1 | 2 = scope[GLOBAL_DISPATCHER_V2] === undefined ? 1 : 2;
  const key = slot === 2 ? GLOBAL_DISPATCHER_V2 : GLOBAL_DISPATCHER_V1;
  const current = scope[key] as { constructor?: unknown } | undefined | null;
  if (current === undefined || current === null) {
    return { ...base, reason: "global_dispatcher_absent" };
  }
  const Ctor = current.constructor as (new (o: Record<string, unknown>) => unknown) | undefined;
  if (typeof Ctor !== "function") {
    return { ...base, reason: "dispatcher_ctor_unavailable" };
  }
  try {
    const next = new Ctor({
      keepAliveTimeout: opts.keepAliveTimeoutMs,
      keepAliveMaxTimeout: opts.keepAliveMaxTimeoutMs,
      // 파이프라이닝은 **끈다**(=1). 한 소켓에 요청을 겹쳐 보내면 그 소켓이 끊길 때 무관한
      // 요청까지 같이 죽어, 지금 규명하려는 `network_error` 의 원인을 더 흐린다.
      pipelining: 1,
      ...(opts.connections === null ? {} : { connections: opts.connections }),
    });
    scope[key] = next;
    return { ...base, applied: true, slot, dispatcher: (next as object).constructor.name };
  } catch (e) {
    return { ...base, slot, reason: `dispatcher_construct_failed:${e instanceof Error ? e.name : "unknown"}` };
  }
}
