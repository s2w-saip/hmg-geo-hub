// 인용 하위 페이지(프롬프트 목록 · 긍정/부정 URL)의 검색창 상태 — 렌더러 없이
// 테스트로 고정하기 위해 순수 함수로 분리한다.
//
// 배경(2026-09-16 GGMD QA): "url 검색 후 검색어 삭제 시 바로 반영이 되지 않음".
// 종전 구현은 검색값을 **form submit(Enter)에서만** URL 에 밀어 넣었고, 적용 중
// 표시가 없었다 — 지우기만 하면 아무 일도 안 일어나고, Enter 를 쳐도 서버 왕복이
// 끝날 때까지 화면은 옛 결과 그대로라 "데이터 오류"로 읽혔다. 그리고 Enter 를
// 먼저 친 뒤 값을 지우면 **먼저 예약된 옛 검색이 나중에 도착해 최신 입력을 덮는다**.
//
// 여기서 고정하는 규약은 셋이다.
//  1) 빈 문자열은 정상 상태다 — "검색 없음"으로 커밋되지, 스킵되지 않는다.
//  2) 최신값만 이긴다 — 늦게 도착한 옛 서버 응답은 입력창을 덮지 않는다.
//  3) (2026-09-17 제품 결정) 검색은 **Enter 또는 검색 버튼**에서만 나간다. 타이핑만으로는
//     왕복하지 않는다. 예외는 입력을 **다 지운 순간** — 필터 해제는 즉시 반영한다
//     (위 QA 지적이 재발하지 않게). 종전 250ms 디바운스 커밋은 폐지.

export type SearchSync = {
  /** 입력창에 보이는 값. */
  draft: string;
  /** 우리가 마지막으로 URL 에 밀어 넣은 값. */
  committed: string;
  /** 그 커밋에 대한 서버 응답을 아직 못 받았다. */
  inFlight: boolean;
};

export const initSearchSync = (serverQuery: string): SearchSync => ({
  draft: serverQuery,
  committed: serverQuery,
  inFlight: false,
});

/** 사용자가 입력했다(삭제 포함 — 빈 문자열도 값이다). */
export function typeSearch(state: SearchSync, next: string): SearchSync {
  return next === state.draft ? state : { ...state, draft: next };
}

/** Enter·검색 버튼·전체 삭제로 URL 에 밀어 넣었다. */
export function commitSearch(state: SearchSync, value: string): SearchSync {
  return { draft: state.draft, committed: value, inFlight: true };
}

/**
 * 서버 렌더가 도착했다(`props.q`).
 * - 우리가 보낸 값이 돌아왔으면 in-flight 해제. draft 는 건드리지 않는다 —
 *   그 사이 사용자가 더 쳤을 수 있다.
 * - 아직 in-flight 인데 **다른** 값이 왔으면 늦게 온 옛 응답이다 → 무시.
 * - in-flight 가 아닌데 값이 다르면 외부 내비게이션(뒤로가기·탭 이동)이다 → 채택.
 */
export function receiveServerQuery(state: SearchSync, serverQuery: string): SearchSync {
  if (serverQuery === state.committed) {
    return state.inFlight ? { ...state, inFlight: false } : state;
  }
  if (state.inFlight) return state;
  return { draft: serverQuery, committed: serverQuery, inFlight: false };
}

/**
 * 전이가 끝났다(`useTransition` 의 pending 해제). 응답이 q 를 바꾸지 않는 경우까지
 * 포함해 in-flight 를 확실히 푼다 — 안 풀면 이후 외부 내비게이션의 q 를 영영
 * 무시하게 된다.
 */
export function settleSearch(state: SearchSync): SearchSync {
  return state.inFlight ? { ...state, inFlight: false } : state;
}

/**
 * 전이가 끝난 시점의 정산 — in-flight 를 풀고 **그때의 서버 q 를 다시 채택**한다.
 *
 * 왜 두 단계인가: in-flight 중에 외부 내비게이션(뒤로가기)이 오면 `receiveServerQuery`
 * 가 그것을 "늦게 온 옛 응답"과 구분하지 못해 무시한다. 무시한 채 in-flight 만 풀면
 * 입력창이 URL 과 **영구히 어긋난 채** 남는다(2026-09-16 검증자 F2). 전이가 끝났다는
 * 것은 우리 커밋이 더는 진행 중이 아니라는 뜻이므로, 그 시점의 서버 q 가 정본이다.
 */
export function settleWithServerQuery(state: SearchSync, serverQuery: string): SearchSync {
  return receiveServerQuery(settleSearch(state), serverQuery);
}

/**
 * 이미 그 값을 URL 에 밀어 넣었다면 왕복이 필요 없다 — 입력했다 되돌린 경우, 이미 빈
 * 검색에서 또 지운 경우, 왕복 중 같은 값으로 버튼을 또 누른 경우(중복 클릭 무해).
 *
 * 왕복 중(in-flight)에도 같은 값이면 무시한다. 그 사이 뒤로가기가 겹쳐 URL 이 바뀌었더라도
 * 전이 종료 시 `settleWithServerQuery` 가 서버 q 를 입력창에 되돌려 놓으므로 어긋난 채
 * 남지 않는다.
 */
export function isNoopCommit(state: SearchSync, value: string): boolean {
  return value === state.committed;
}

export type SearchTrigger =
  /** 입력창 값이 바뀌었다(`typeSearch` 를 적용한 **뒤**의 상태와 함께 부른다). */
  | { kind: "input"; value: string }
  /** Enter(폼 submit) 또는 검색 버튼 클릭 — 입력창에 보이는 값을 커밋한다. */
  | { kind: "submit" };

/**
 * 이 트리거가 URL 커밋을 만드는가 — 만들면 커밋할 값, 아니면 `null`.
 * - submit: 입력창 값(`draft`)을 커밋한다. 빈 값도 커밋한다(규약 1).
 * - input: **빈 문자열이 된 순간만** 즉시 커밋한다(규약 3 예외). 그 외 타이핑은 커밋 없음.
 * - 어느 쪽이든 이미 커밋된 값이면 `null`(요청을 만들지 않는다).
 */
export function planSearchCommit(state: SearchSync, trigger: SearchTrigger): string | null {
  const value = trigger.kind === "submit" ? state.draft : trigger.value;
  if (trigger.kind === "input" && value !== "") return null;
  return isNoopCommit(state, value) ? null : value;
}

/**
 * 검색창 이벤트 리듀서 — 컴포넌트의 onChange·onSubmit 은 **이 함수의 결과만 적용**한다
 * (`state` 를 반영하고, `commit` 이 null 이 아니면 그 값을 URL 에 push).
 *
 * 렌더러에 이벤트를 흘릴 수 없는(jsdom 없음) 이 리포에서 트리거 규약의 배선까지 테스트로
 * 고정하려고 핸들러 본문 전체를 여기로 옮겼다(2026-09-17 검증자 D2).
 * - input: `typeSearch` 로 입력창 반영 → 다 지운 순간만 커밋(`planSearchCommit`).
 * - submit(Enter·검색 버튼): 입력창 값 커밋. 이미 커밋된 값이면 커밋 없음.
 * - 커밋이 있으면 반환 상태는 `commitSearch` 까지 적용된 것(in-flight).
 */
export function reduceSearchEvent(
  state: SearchSync,
  event: SearchTrigger,
): { state: SearchSync; commit: string | null } {
  const typed = event.kind === "input" ? typeSearch(state, event.value) : state;
  const commit = planSearchCommit(typed, event);
  return { state: commit === null ? typed : commitSearch(typed, commit), commit };
}

export type SearchEventDeps = {
  /** 이벤트 핸들러가 같은 틱에 연달아 읽는 최신 상태(React ref). */
  ref: { current: SearchSync };
  /** 입력창 상태 반영(React setState). */
  setSync: (next: SearchSync) => void;
  /** URL 반영(`useSubpageNav().push`). */
  push: (extra: Record<string, string>) => void;
};

/**
 * 검색창 이벤트 적용 — 컴포넌트 onChange·onSubmit 은 **이것만** 부른다(2026-09-17 검증자 D-a).
 * 리듀서 결과를 반영하고, 커밋이 있으면 `{ q, page: "1" }` 로 push 한다(빈 q = 파라미터 삭제).
 *
 * 상태가 그대로면(리듀서가 같은 객체를 돌려주면) **setSync 를 부르지 않는다**(검증자 D-b).
 * 불렀다면 뒤로가기 직후 effect 가 큐에 넣은 updater(서버 q 채택) 결과를 낡은 ref 값으로
 * 덮고, [q, pending] 이 그대로라 effect 가 다시 돌지 않아 입력창이 URL 과 어긋난 채 남는다.
 */
export function applySearchEvent(event: SearchTrigger, deps: SearchEventDeps): void {
  const { state: next, commit } = reduceSearchEvent(deps.ref.current, event);
  if (next !== deps.ref.current) {
    deps.ref.current = next;
    deps.setSync(next);
  }
  if (commit !== null) deps.push({ q: commit, page: "1" });
}

/**
 * 하위 페이지 URL 조립 — 빈 값은 파라미터 **삭제**(= 필터 없음)다.
 * `useSubpageNav` 가 쓰던 인라인 로직을 그대로 옮긴 것(동작 동일, 테스트 가능).
 */
export function buildSubpageHref(
  pathname: string,
  search: string,
  extra: Record<string, string>,
): string {
  const params = new URLSearchParams(search);
  for (const [k, v] of Object.entries(extra)) {
    if (v) params.set(k, v);
    else params.delete(k);
  }
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
