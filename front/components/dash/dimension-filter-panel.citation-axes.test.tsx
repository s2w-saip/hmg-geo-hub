import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import {
  DimensionFilterPanel,
  FILTER_SECTIONS,
  buildCommitParams,
  competitorAxisEnabled,
  clearAxesDisabledBy,
  type DimensionGroup,
} from "./dimension-filter-panel";

// QA 2차 #2 · #5-(a)(b) — 인용 화면의 출처 카테고리·경쟁사를 **필터 패널 축**으로
// 되돌린다(2026-09-02 칩 결정 원복). 칩은 클릭 즉시 `router.replace` 를 때려
// 서버 왕복이 끝나야 선택 표시가 바뀌었고(= "선택이 안 된다"), 그 사이 공유 전이
// 밖이라 흐림·"재조회 중" 피드백도 없었다. 패널 축은 draft(로컬 state)라 체크가
// 즉시 반영되고 서버 왕복은 `적용` 1회뿐이다.

let SEARCH = "";
vi.mock("next/navigation", () => ({
  usePathname: () => "/ko/standard/answer-analysis/citation",
  useSearchParams: () => new URLSearchParams(SEARCH),
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));

const ONLY: DimensionGroup[] = ["geography", "engine", "time", "promptContext", "source", "competitor"];

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

function panel(props: Partial<React.ComponentProps<typeof DimensionFilterPanel>> = {}) {
  return render(
    <DimensionFilterPanel
      stage="citations"
      onlyGroups={ONLY}
      primaryGroups={["geography", "engine", "time", "promptContext"]}
      sections={FILTER_SECTIONS}
      geographyOptions={["KR"]}
      competitorOptions={["bmw.com", "toyota.com"]}
      compact
      {...props}
    />,
  );
}

/** 라벨을 품은 facet 버튼 하나를 잘라낸다. */
function facet(html: string, label: string): string {
  const i = html.indexOf(`>${label}</span>`);
  expect(i, `facet not rendered: ${label}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", i);
  return html.slice(start, html.indexOf("</button>", i) + 9);
}

describe("인용 필터 패널 — 출처 카테고리·경쟁사 드롭다운 (QA 2차 #2)", () => {
  it("`답변 필터` 행에 출처 카테고리·경쟁사 드롭다운이 뜬다", () => {
    SEARCH = "";
    const html = panel();
    expect(html).toContain(ko.dashboard.filters.section.citation);
    expect(facet(html, ko.dashboard.filters.group.source)).toContain("facet-chip");
    expect(facet(html, ko.dashboard.filters.group.competitor)).toContain("facet-chip");
  });

  it("기본값 = 전체(선택 0) — 카운트 배지가 없다", () => {
    SEARCH = "";
    const btn = facet(panel(), ko.dashboard.filters.group.source);
    expect(btn).not.toMatch(/rounded-full bg-brand-700/);
  });

  it("선택한 항목 수가 카운트 배지로 뜬다 (제품 결정 D2)", () => {
    SEARCH = "source=Official+%28HMG%29~Official+%28Competitor%29";
    const btn = facet(panel(), ko.dashboard.filters.group.source);
    expect(btn).toMatch(/rounded-full bg-brand-700[^>]*>2</);
  });

  it("공식(경쟁사)가 제외되면 경쟁사 축이 비활성 (제품 결정 D4 — 현행 규칙 보존)", () => {
    SEARCH = "source=Automotive+Media";
    const btn = facet(panel(), ko.dashboard.filters.group.competitor);
    expect(btn).toContain("disabled");
  });

  it("공식(경쟁사)가 포함되거나 미선택이면 경쟁사 축이 활성", () => {
    SEARCH = "source=Official+%28Competitor%29";
    expect(facet(panel(), ko.dashboard.filters.group.competitor)).not.toContain("disabled");
    SEARCH = "";
    expect(facet(panel(), ko.dashboard.filters.group.competitor)).not.toContain("disabled");
  });

  // "빈 옵션 → 축 제거" 는 **적용된 출처 카테고리가 경쟁사 도메인을 허용할 때만**
  // 죽은 필터 판정이다. 아래 두 케이스가 그 경계를 양쪽에서 고정한다(QA 2차 검증 B1).
  it("적용 출처가 경쟁사를 허용하는데도 옵션이 비면 축이 사라진다 (진짜 죽은 필터)", () => {
    SEARCH = "";
    const html = panel({ competitorOptions: [] });
    expect(html).not.toContain(`>${ko.dashboard.filters.group.competitor}</span>`);
    expect(html).toContain(`>${ko.dashboard.filters.group.source}</span>`);
  });

  it("공식(경쟁사)를 뺀 `?source=` 로 진입해도 경쟁사 축은 비활성으로 남는다 (검증 B1)", () => {
    // 옵션은 같은 `?source=` 를 탄 인용 집계에서 오므로 이때 **빈 배열**로 도착한다.
    // 그대로 축을 지우면 D4 의 비활성+힌트가 드래프트 창에서만 보이고, 적용·새로고침
    // 후에는 "경쟁사 축이 통째로 사라졌다"가 된다(검증자 실측).
    SEARCH = "source=Automotive+Media";
    const btn = facet(panel({ competitorOptions: [] }), ko.dashboard.filters.group.competitor);
    expect(btn).toContain("disabled");
    expect(btn).toContain("opacity-50");
    expect(btn).toContain(ko.dashboard.filters.competitorNeedsOfficialCompetitor);
  });
});

describe("안내 문구는 필터 박스 최하단 (QA 2차 #5-(b))", () => {
  it("footerSlot 이 있어도 defaultScopeHint 가 DOM 마지막 요소다", () => {
    SEARCH = "";
    const html = panel({ footerSlot: <span data-testid="footer">FOOT</span> });
    const hint = html.indexOf(ko.dashboard.filters.defaultScopeHint);
    expect(hint).toBeGreaterThan(-1);
    expect(hint).toBeGreaterThan(html.indexOf("FOOT"));
    // 힌트 <p> 뒤에는 래퍼 닫는 태그만 남는다 = 박스의 마지막 자식.
    expect(html.trimEnd().endsWith("</p></div>")).toBe(true);
  });
});

describe("적용 1회 = URL 왕복 1회 (QA 2차 #5-(b))", () => {
  it("한 번의 commit 이 출처 카테고리·경쟁사를 함께 실어 나른다", () => {
    const qs = buildCommitParams(
      new URLSearchParams("geography=KR"),
      ["geography", "source", "competitor"],
      { geography: ["KR"], source: ["Official (Competitor)"], competitor: ["bmw.com"] },
      [],
      {},
    );
    const out = new URLSearchParams(qs);
    expect(out.get("geography")).toBe("KR");
    expect(out.get("source")).toBe("Official (Competitor)");
    expect(out.get("competitor")).toBe("bmw.com");
  });
  it("빈 축은 URL 에서 지워진다", () => {
    const qs = buildCommitParams(
      new URLSearchParams("geography=KR&competitor=bmw.com"),
      ["geography", "competitor"],
      { geography: ["KR"] },
      [],
      {},
    );
    expect(new URLSearchParams(qs).has("competitor")).toBe(false);
  });
});

describe("축 활성 규칙 (순수 함수)", () => {
  it("competitorAxisEnabled — 미선택(전체)·포함이면 활성, 명시 제외면 비활성", () => {
    expect(competitorAxisEnabled(undefined)).toBe(true);
    expect(competitorAxisEnabled([])).toBe(true);
    expect(competitorAxisEnabled(["Official (Competitor)", "Other"])).toBe(true);
    expect(competitorAxisEnabled(["Other"])).toBe(false);
  });
  it("clearAxesDisabledBy — 비활성이 된 축의 선택을 걷어낸다", () => {
    expect(clearAxesDisabledBy({ source: ["Other"], competitor: ["bmw.com"] })).toEqual({
      source: ["Other"],
    });
    const keep = { source: ["Official (Competitor)"], competitor: ["bmw.com"] };
    expect(clearAxesDisabledBy(keep)).toBe(keep); // 지울 것이 없으면 같은 객체
  });
});
