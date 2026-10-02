import { describe, expect, it, vi } from "vitest";
import {
  applySearchEvent,
  buildSubpageHref,
  commitSearch,
  initSearchSync,
  isNoopCommit,
  receiveServerQuery,
  reduceSearchEvent,
  settleSearch,
  settleWithServerQuery,
  typeSearch,
  type SearchSync,
} from "./subpage-search";

// 2026-09-16 GGMD QA 회귀 가드 — "url 검색 후 검색어 삭제 시 바로 반영이 되지 않음".
// 두 결함을 각각 고정한다: ① 빈 검색어를 falsy 로 흘려 아무 일도 안 하던 것,
// ② 먼저 발행된 옛 검색이 나중에 도착해 최신 입력을 덮던 것.
// 2026-09-17 제품 결정: 검색은 Enter·검색 버튼에서만 나가고, 다 지운 순간만 즉시 반영한다.

describe("buildSubpageHref — 빈 값은 '필터 없음'", () => {
  it("검색어를 지우면 q 파라미터가 URL 에서 빠진다(값이 남아 있지 않다)", () => {
    const href = buildSubpageHref(
      "/ko/standard/answer-analysis/citation/tone-urls",
      "tone=positive&q=youtube&page=3",
      { q: "", page: "1" },
    );
    expect(href).toBe("/ko/standard/answer-analysis/citation/tone-urls?tone=positive&page=1");
    expect(href).not.toContain("q=");
  });

  it("검색어를 고치면 그 값으로 바뀌고 페이지는 1로 돌아간다", () => {
    expect(
      buildSubpageHref("/p", "tone=negative&q=youtube&page=3", { q: "vimeo", page: "1" }),
    ).toBe("/p?tone=negative&q=vimeo&page=1");
  });

  it("파라미터가 하나도 없으면 물음표를 붙이지 않는다", () => {
    expect(buildSubpageHref("/p", "q=youtube", { q: "" })).toBe("/p");
  });
});

/**
 * 컴포넌트 onChange 와 똑같이 적용한다: 리듀서 결과의 state 를 반영하고 commit 이 있으면 push.
 * (컴포넌트가 리듀서만 쓴다는 배선은 citations-standard-view.render.test.tsx 가 고정.)
 */
function input(s: SearchSync, value: string, commits: string[]): SearchSync {
  const r = reduceSearchEvent(s, { kind: "input", value });
  if (r.commit !== null) commits.push(r.commit);
  return r.state;
}
/** Enter 또는 검색 버튼(폼 submit) — 컴포넌트 onSubmit 과 같은 적용. */
function submit(s: SearchSync, commits: string[]): SearchSync {
  const r = reduceSearchEvent(s, { kind: "submit" });
  if (r.commit !== null) commits.push(r.commit);
  return r.state;
}

/** 컴포넌트가 넘기는 deps 의 가짜: ref 는 평범한 객체, setSync·push 는 spy. */
function fakeDeps(initial: SearchSync) {
  const ref = { current: initial };
  const setSync = vi.fn<(next: SearchSync) => void>();
  const push = vi.fn<(extra: Record<string, string>) => void>();
  return { ref, setSync, push };
}

describe("applySearchEvent — 컴포넌트 핸들러의 실제 행동(검증자 D-a·D-b)", () => {
  it("(1) 입력 이벤트는 ref 와 setSync 를 새 draft 로 갱신하고 push 는 없다", () => {
    // 회귀 MY4: setSync 를 빼면 제어 입력이라 타이핑이 화면에 안 보인다.
    const d = fakeDeps(initSearchSync(""));
    applySearchEvent({ kind: "input", value: "you" }, d);
    const want = { draft: "you", committed: "", inFlight: false };
    expect(d.ref.current).toEqual(want);
    expect(d.setSync).toHaveBeenCalledTimes(1);
    expect(d.setSync).toHaveBeenCalledWith(want);
    expect(d.push).not.toHaveBeenCalled();
  });

  it("(2) 전부 지우면 push 가 page 1·q 없음으로 1회 나가고 입력창도 비워진다", () => {
    // 회귀 MY7: 빈 입력을 상태만 반영하고 끝내면 2026-09-16 QA("지워도 반영 안 됨") 재발.
    const d = fakeDeps(initSearchSync("youtube"));
    applySearchEvent({ kind: "input", value: "" }, d);
    expect(d.push).toHaveBeenCalledTimes(1);
    expect(d.push).toHaveBeenCalledWith({ q: "", page: "1" });
    const href = buildSubpageHref("/p", "tone=positive&q=youtube&page=3", d.push.mock.calls[0][0]);
    expect(href).toBe("/p?tone=positive&page=1");
    expect(d.ref.current).toEqual({ draft: "", committed: "", inFlight: true });
    expect(d.setSync).toHaveBeenLastCalledWith({ draft: "", committed: "", inFlight: true });
  });

  it("(3) 커밋 없는 submit 은 setSync·push 를 부르지 않고 ref 도 같은 객체다 (D-b)", () => {
    // setSync 를 부르면 뒤로가기 직후 effect 가 큐에 넣은 서버 q 채택을 낡은 값으로 덮는다.
    const start = { draft: "you", committed: "you", inFlight: true };
    const d = fakeDeps(start);
    for (let i = 0; i < 5; i++) applySearchEvent({ kind: "submit" }, d);
    expect(d.setSync).not.toHaveBeenCalled();
    expect(d.push).not.toHaveBeenCalled();
    expect(d.ref.current).toBe(start);
  });

  it("(4) 새 값 submit 은 push 1회 + ref 가 in-flight", () => {
    const d = fakeDeps({ draft: "kia", committed: "you", inFlight: false });
    applySearchEvent({ kind: "submit" }, d);
    expect(d.push).toHaveBeenCalledTimes(1);
    expect(d.push).toHaveBeenCalledWith({ q: "kia", page: "1" });
    expect(d.ref.current).toEqual({ draft: "kia", committed: "kia", inFlight: true });
    expect(d.setSync).toHaveBeenCalledTimes(1);
    expect(d.setSync).toHaveBeenCalledWith(d.ref.current);
  });

  it("값이 그대로인 입력 이벤트도 setSync 를 부르지 않는다", () => {
    const d = fakeDeps(initSearchSync("you"));
    applySearchEvent({ kind: "input", value: "you" }, d);
    expect(d.setSync).not.toHaveBeenCalled();
    expect(d.push).not.toHaveBeenCalled();
  });
});

describe("reduceSearchEvent — 핸들러 본문 규약(검증자 D2)", () => {
  it("입력 중(비어 있지 않은 값)은 커밋이 없고 입력창만 바뀐다", () => {
    // 회귀 M3: '커밋 값과 다르면 커밋' 으로 바꾸면 타이핑마다 검색이 나간다.
    const r = reduceSearchEvent(initSearchSync("youtube"), { kind: "input", value: "yo" });
    expect(r.commit).toBeNull();
    expect(r.state).toEqual({ draft: "yo", committed: "youtube", inFlight: false });
  });

  it("다 지우면 그 이벤트 자체가 빈 값 커밋을 돌려주고 in-flight 가 된다", () => {
    // 회귀 M2b: 입력 경로의 커밋을 빼면 지워도 필터가 풀리지 않는다(2026-09-16 QA 재발).
    const r = reduceSearchEvent(initSearchSync("youtube"), { kind: "input", value: "" });
    expect(r.commit).toBe("");
    expect(r.state).toEqual({ draft: "", committed: "", inFlight: true });
  });

  it("이미 빈 검색에서 지워지면 커밋이 없다", () => {
    const s = { draft: "y", committed: "", inFlight: false };
    const r = reduceSearchEvent(s, { kind: "input", value: "" });
    expect(r.commit).toBeNull();
    expect(r.state).toEqual({ draft: "", committed: "", inFlight: false });
  });

  it("submit 은 입력창 값을 커밋하고, 같은 값 재submit 은 커밋이 없다", () => {
    const s = { draft: "you", committed: "", inFlight: false };
    const r1 = reduceSearchEvent(s, { kind: "submit" });
    expect(r1).toEqual({ state: { draft: "you", committed: "you", inFlight: true }, commit: "you" });
    const r2 = reduceSearchEvent(r1.state, { kind: "submit" });
    expect(r2.commit).toBeNull();
    expect(r2.state).toBe(r1.state);
  });

  it("값이 그대로인 입력 이벤트는 상태 객체를 새로 만들지 않는다", () => {
    const s = initSearchSync("you");
    const r = reduceSearchEvent(s, { kind: "input", value: "you" });
    expect(r.commit).toBeNull();
    expect(r.state).toBe(s);
  });
});

describe("planSearchCommit — Enter·버튼에서만 검색, 다 지우면 즉시 해제", () => {
  it("타이핑만으로는 커밋하지 않는다(디바운스 폐지)", () => {
    const commits: string[] = [];
    let s = initSearchSync("");
    for (const v of ["y", "yo", "you"]) s = input(s, v, commits);
    expect(commits).toEqual([]);
    expect(s).toEqual({ draft: "you", committed: "", inFlight: false });
  });

  it("Enter·버튼(submit)은 입력창 값을 즉시 커밋한다", () => {
    const commits: string[] = [];
    let s = initSearchSync("");
    s = input(s, "you", commits);
    s = submit(s, commits);
    expect(commits).toEqual(["you"]);
    expect(s).toEqual({ draft: "you", committed: "you", inFlight: true });
  });

  it("검색어를 다 지우면 Enter 없이 즉시 빈 값을 커밋한다(2026-09-16 QA 재발 방지)", () => {
    const commits: string[] = [];
    let s = initSearchSync("youtube"); // URL q=youtube 로 들어온 화면
    s = input(s, "youtub", commits);
    expect(commits).toEqual([]); // 줄이는 중엔 아직 아무것도 안 나간다
    s = input(s, "", commits);
    expect(commits).toEqual([""]);
    expect(s).toEqual({ draft: "", committed: "", inFlight: true });
  });

  it("이미 빈 검색이면 지워도 요청을 만들지 않는다", () => {
    const commits: string[] = [];
    let s = initSearchSync("");
    s = input(s, "y", commits);
    s = input(s, "", commits);
    s = submit(s, commits); // 빈 채로 Enter 도 무왕복
    expect(commits).toEqual([]);
    expect(s.inFlight).toBe(false);
  });

  it("왕복 중 같은 값으로 버튼을 또 눌러도 중복 요청이 없다", () => {
    const commits: string[] = [];
    let s = input(initSearchSync(""), "you", commits);
    s = submit(s, commits);
    s = submit(s, commits);
    s = submit(s, commits);
    expect(commits).toEqual(["you"]);
    expect(s).toEqual({ draft: "you", committed: "you", inFlight: true });
  });

  it("왕복 중 값을 바꿔 다시 누르면 새 값이 나간다(최신값이 이긴다)", () => {
    const commits: string[] = [];
    let s = input(initSearchSync(""), "you", commits);
    s = submit(s, commits);
    s = input(s, "youtube", commits);
    s = submit(s, commits);
    expect(commits).toEqual(["you", "youtube"]);
    // 첫 왕복(q=you)의 렌더가 늦게 와도 입력창은 youtube 를 지킨다.
    s = receiveServerQuery(s, "you");
    expect(s.draft).toBe("youtube");
  });

  it("빈 값 submit 도 정상 커밋이다(스킵하지 않는다)", () => {
    const commits: string[] = [];
    let s = initSearchSync("youtube");
    s = typeSearch(s, ""); // 예: 입력 이벤트 없이 값이 비워진 채 Enter
    s = submit(s, commits);
    expect(commits).toEqual([""]);
    expect(s.committed).toBe("");
  });

  it("전부 선택 후 다른 글자로 덮어쓰면(빈 값을 거치지 않음) 커밋하지 않는다", () => {
    const commits: string[] = [];
    let s = initSearchSync("youtube");
    s = input(s, "v", commits);
    expect(commits).toEqual([]);
    expect(s.committed).toBe("youtube");
  });
});

describe("receiveServerQuery — 늦게 온 옛 응답이 최신 입력을 덮지 않는다", () => {
  it("'youtube' 검색 중 지웠는데 옛 응답이 늦게 와도 입력창은 빈 채로 남는다", () => {
    const commits: string[] = [];
    let s = initSearchSync("");
    s = input(s, "youtube", commits);
    s = submit(s, commits); // → URL q=youtube (왕복 시작)
    s = input(s, "", commits); // 사용자가 그 사이 지웠다 → 즉시 URL q 제거 (두 번째 왕복)
    expect(commits).toEqual(["youtube", ""]);

    // 첫 왕복(q=youtube)의 서버 렌더가 **나중에** 도착한다.
    s = receiveServerQuery(s, "youtube");
    expect(s.draft).toBe("");
    expect(s.committed).toBe("");

    // 최신 왕복이 도착하면 in-flight 만 풀린다.
    s = receiveServerQuery(s, "");
    expect(s.draft).toBe("");
    expect(s.inFlight).toBe(false);
  });

  it("왕복이 끝난 뒤 사용자가 더 친 값은 서버 응답이 되돌리지 않는다", () => {
    let s = initSearchSync("");
    s = typeSearch(s, "you");
    s = commitSearch(s, "you");
    s = typeSearch(s, "youtube"); // 응답 도착 전에 이어서 타이핑
    s = receiveServerQuery(s, "you");
    expect(s.draft).toBe("youtube");
    expect(s.inFlight).toBe(false);
  });

  it("외부 내비게이션(뒤로가기·탭 이동)의 q 는 입력창에 채택한다", () => {
    let s = initSearchSync("youtube");
    s = receiveServerQuery(s, ""); // 탭 이동으로 q 가 사라진 URL
    expect(s).toEqual({ draft: "", committed: "", inFlight: false });
  });

  it("같은 값이 다시 와도 상태 객체를 새로 만들지 않는다(불필요한 리렌더 방지)", () => {
    const s = initSearchSync("youtube");
    expect(receiveServerQuery(s, "youtube")).toBe(s);
    expect(typeSearch(s, "youtube")).toBe(s);
  });
});

describe("in-flight 표식이 끼이지 않는다", () => {
  it("입력했다 되돌리면 왕복이 없다(URL 이 이미 그 값)", () => {
    const s = initSearchSync("youtube");
    expect(isNoopCommit(s, "youtube")).toBe(true);
    expect(isNoopCommit(s, "vimeo")).toBe(false);
    // 왕복 중 같은 값 = 이미 가는 중 → 중복 요청 없음(버튼 연타 무해).
    expect(isNoopCommit(commitSearch(s, "vimeo"), "vimeo")).toBe(true);
  });

  it("왕복 중 같은 값 무시 + 뒤로가기가 겹쳐도 전이 종료 시 입력창이 URL 로 돌아온다", () => {
    const commits: string[] = [];
    let s = input(initSearchSync(""), "youtube", commits);
    s = submit(s, commits); // 왕복 시작
    s = receiveServerQuery(s, ""); // 뒤로가기 렌더 — in-flight 가드가 무시
    s = submit(s, commits); // 같은 값 재클릭은 무왕복
    expect(commits).toEqual(["youtube"]);
    s = settleWithServerQuery(s, ""); // 전이 종료 → 서버 q 채택
    expect(s).toEqual({ draft: "", committed: "", inFlight: false });
    s = input(s, "youtube", commits);
    s = submit(s, commits); // 이제 다시 누르면 나간다
    expect(commits).toEqual(["youtube", "youtube"]);
  });

  it("in-flight 중에 들어온 뒤로가기를 전이 종료 시점에 회수한다 (F2)", () => {
    // 검증자 F2: 종전 settle 은 in-flight 만 풀고 그때의 서버 q 를 재채택하지
    // 않아, 뒤로가기가 in-flight 창에 겹치면 입력창이 URL 과 영구히 어긋났다.
    let s = initSearchSync("");
    s = typeSearch(s, "youtube");
    s = commitSearch(s, "youtube"); // 왕복 시작 (URL q=youtube)

    // 왕복 중 사용자가 뒤로가기 → URL q 가 사라진 렌더가 도착한다.
    s = receiveServerQuery(s, ""); // in-flight 가드가 "늦게 온 옛 응답"으로 보고 무시
    expect(s.draft).toBe("youtube");

    // 전이가 끝났다 = 우리 커밋은 더는 진행 중이 아니다 → 그 시점의 서버 q 가 정본.
    s = settleWithServerQuery(s, "");
    expect(s).toEqual({ draft: "", committed: "", inFlight: false });
  });

  it("정산 시점에 우리 커밋이 그대로 반영돼 있으면 사용자가 더 친 값을 지킨다", () => {
    let s = initSearchSync("");
    s = commitSearch(s, "you");
    s = typeSearch(s, "youtube"); // 응답 도착 전에 이어서 타이핑
    s = settleWithServerQuery(s, "you"); // 우리 커밋이 반영된 채 전이 종료
    expect(s.draft).toBe("youtube");
    expect(s.committed).toBe("you");
    expect(s.inFlight).toBe(false);
  });

  it("전이가 끝나면 in-flight 가 풀려 다음 외부 내비게이션이 반영된다", () => {
    let s = commitSearch(initSearchSync(""), "youtube");
    expect(s.inFlight).toBe(true);
    s = settleSearch(s); // 응답이 q 를 바꾸지 않은 채 전이만 끝난 경우
    expect(s.inFlight).toBe(false);
    s = receiveServerQuery(s, "vimeo");
    expect(s.draft).toBe("vimeo");
    expect(settleSearch(s)).toBe(s); // 풀린 상태는 새 객체를 만들지 않는다
  });
});
