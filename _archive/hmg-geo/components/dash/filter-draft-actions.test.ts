/**
 * 필터 패널의 **드래프트 계약** 회귀 가드 — "적용 전에는 URL 왕복이 0" (QA 2차 #5).
 *
 * 2026-09-11 검증에서 이 계약을 지키는 테스트가 **하나도 없다**는 것이 뮤테이션으로
 * 드러났다: `toggleValue` 안에 `commit()` 을 심어 칩 시절 회귀(클릭 수 = 서버 왕복 수,
 * 고객 리포트 "선택이 안 된다"·"경쟁사 선택 시 느림")를 재현했는데도 필터 패널·인용
 * 테스트 **37/37 이 전부 통과**했다. 기존 테스트는 전부 `renderToStaticMarkup` 이라
 * 클릭 상호작용이 없고, 이 리포에는 jsdom·testing-library 가 없다.
 *
 * 그래서 핸들러 본문을 렌더러 없이 돌릴 수 있는 순수 팩토리(`createFilterDraftActions`)로
 * 떼어내고, 여기서 **호출 횟수**로 계약을 고정한다. 팩토리 밖(패널 배선)으로 commit 이
 * 새는 경로는 아래 §소스 대조가 막는다 — sticky-layer.test.ts·trend-gap-wiring.test.ts 와
 * 같은 관례(렌더러가 못 보는 계약은 소스로 고정).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createFilterDraftActions,
  type FilterDraft,
  type FilterDynDraft,
} from "./filter-draft-actions";

/** 팩토리를 렌더러 없이 구동하는 최소 스토어 — setState 업데이터 계약만 흉내낸다. */
function harness(init: FilterDraft = {}, initDyn: FilterDynDraft = {}) {
  let draft = init;
  let dyn = initDyn;
  const commit = vi.fn<(d: FilterDraft, y: FilterDynDraft) => void>();
  const normalizeDraft = vi.fn((next: FilterDraft) => next);
  const actions = createFilterDraftActions({
    setDraft: (u) => {
      draft = u(draft);
    },
    setDynDraft: (u) => {
      dyn = u(dyn);
    },
    normalizeDraft,
    readDraft: () => ({ draft, dyn }),
    commit,
  });
  return {
    actions,
    commit,
    normalizeDraft,
    get draft() {
      return draft;
    },
    get dyn() {
      return dyn;
    },
  };
}

describe("드래프트 토글은 URL 을 건드리지 않는다 (검증 B3)", () => {
  it("토글 N회 — commit 호출 0, draft 만 바뀐다", () => {
    const h = harness();
    h.actions.toggleValue("source", "Official (Competitor)");
    h.actions.toggleValue("competitor", "bmw.com");
    h.actions.toggleValue("competitor", "mercedes-benz.com");
    h.actions.toggleValue("geography", "KR");
    expect(h.commit).toHaveBeenCalledTimes(0);
    expect(h.draft).toEqual({
      source: ["Official (Competitor)"],
      competitor: ["bmw.com", "mercedes-benz.com"],
      geography: ["KR"],
    });
  });

  it("같은 값을 다시 토글하면 선택에서 빠진다 (여전히 commit 0)", () => {
    const h = harness({ competitor: ["bmw.com", "audi.com"] });
    h.actions.toggleValue("competitor", "bmw.com");
    expect(h.draft.competitor).toEqual(["audi.com"]);
    expect(h.commit).toHaveBeenCalledTimes(0);
  });

  it("축 지우기·동적 축 토글도 commit 0", () => {
    const h = harness({ competitor: ["bmw.com"] });
    h.actions.clearGroup("competitor");
    h.actions.toggleDyn("tag:seg", "A");
    h.actions.toggleDyn("tag:seg", "B");
    h.actions.clearDyn("tag:seg");
    expect(h.draft.competitor).toEqual([]);
    expect(h.dyn["tag:seg"]).toEqual([]);
    expect(h.commit).toHaveBeenCalledTimes(0);
  });

  it("적용 1회 = commit 1회, 그때까지 쌓인 draft 를 통째로 싣는다", () => {
    const h = harness();
    h.actions.toggleValue("source", "Official (Competitor)");
    h.actions.toggleValue("competitor", "bmw.com");
    h.actions.toggleDyn("tag:seg", "A");
    expect(h.commit).toHaveBeenCalledTimes(0); // ← 왕복은 아직 0
    h.actions.apply();
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(h.commit).toHaveBeenCalledWith(
      { source: ["Official (Competitor)"], competitor: ["bmw.com"] },
      { "tag:seg": ["A"] },
    );
  });

  it("적용을 두 번 누르면 두 번 — 토글이 왕복을 만들지 않는다는 뜻이지 apply 가 막힌다는 뜻이 아니다", () => {
    const h = harness();
    h.actions.apply();
    h.actions.apply();
    expect(h.commit).toHaveBeenCalledTimes(2);
  });

  it("정규화(캐스케이드 prune·비활성 축 정리)는 축 단위로 위임된다", () => {
    const h = harness();
    h.actions.toggleValue("source", "Automotive Media");
    expect(h.normalizeDraft).toHaveBeenCalledWith({ source: ["Automotive Media"] }, "source");
  });
});

// ── 소스 대조 — commit 이 팩토리 밖으로 새는 경로 차단 ────────────────────────
// 위 계약은 팩토리 안에서만 유효하다. 패널이 `onToggle` 배선에서 직접 commit 하면
// 같은 회귀가 되살아나므로, 패널 소스에서 commit 호출 지점을 못 박는다.

const PANEL = readFileSync("components/dash/dimension-filter-panel.tsx", "utf-8");

describe("패널 배선 — commit 지점은 `적용` 하나뿐", () => {
  it("핸들러 본문은 패널이 아니라 팩토리가 갖는다", () => {
    expect(/createFilterDraftActions</.test(PANEL), "패널이 팩토리를 안 쓴다").toBe(true);
    for (const fn of ["toggleValue", "clearGroup", "toggleDyn", "clearDyn"]) {
      expect(PANEL.includes(`function ${fn}(`), `${fn} 본문이 패널로 되돌아왔다`).toBe(false);
    }
  });

  it("패널은 commit 을 **정의만** 하고 직접 부르지 않는다 (호출권은 팩토리의 apply)", () => {
    // `function commit(` 하나뿐 = 패널 어디에서도 `commit(...)` 을 실행하지 않는다.
    expect(PANEL.match(/\bcommit\(/g) ?? []).toHaveLength(1);
    expect(PANEL).toMatch(/createFilterDraftActions<[^>]*>\(\{[\s\S]*?\n\s*commit,\n/);
  });

  it("URL 을 쓰는 지점은 commit 과 `초기화` 둘뿐이다", () => {
    // resetAll 은 URL 파라미터를 통째로 지우는 별개 경로라 패널이 직접 소유한다.
    expect(PANEL.match(/router\.replace\(/g) ?? []).toHaveLength(2);
    // MUT-C 봉합(재검증): 토글 핸들러가 `apply()` 를 직접 불러 "클릭 = 서버 왕복"으로 되돌리는 변조.
    // 패널은 apply 를 버튼 onClick 에 **참조로 한 번** 넘길 뿐, 어디서도 호출하지 않는다.
    expect(PANEL.match(/\bapply\(\)/g) ?? [], "apply() 직접 호출이 패널에 생겼다").toHaveLength(0);
    expect(PANEL.match(/onClick=\{apply\}/g) ?? []).toHaveLength(1);
  });

  it("도넛 조각 클릭의 즉시 커밋은 패널 밖(useSourceToggle)이라 이 규칙과 무관하다", () => {
    // 명시적 예외 기록 — 그 토글은 draft 가 아니라 URL 축을 직접 쓰는 별도 훅이고,
    // 공유 전이를 타므로 흐림·"재조회 중" 피드백이 붙는다(citation-url-axes.ts).
    expect(PANEL).not.toContain("useSourceToggle");
  });
});
