import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { RnAcrInput } from "../_data/screen-types";
import fixture from "./acr-body.fixture.json";

// ════════════════════════════════════════════════════════════════════════════
// Renewal ACR body — static render
// ════════════════════════════════════════════════════════════════════════════
// The fixture is the BFF's own output (back/bff/screens/acr.py renewal over the reader answer of
// back/bff/tests/test_screens_acr.py; test_front_fixture_is_current keeps it in step): a snapshot and a
// period of two rounds.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => "/ko/renewal/standard/ai-funnel/acr",
  useSearchParams: () => new URLSearchParams(""),
}));

const { RnFilterRuntime } = await import("@/app/[locale]/(renewal)/renewal/_components/filter-runtime");
const { RnOverviewFilters } = await import("@/app/[locale]/(renewal)/renewal/_components/overview-filters");
const { RnAcrBody } = await import("./acr-body");

const bodies = fixture as unknown as Record<"snapshot" | "period", RnAcrInput>;
const T = ko.renewal.acr;

function render(input: RnAcrInput): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnFilterRuntime>
        <RnOverviewFilters props={{ stage: "acr", scope: { all: true } }} savedFilters={{ page: "acr", userId: "test", initial: [] }}>
          <RnAcrBody input={input} />
        </RnOverviewFilters>
      </RnFilterRuntime>
    </NextIntlClientProvider>,
  );
}

describe("renewal ACR body: 후보 → 선택 전환 and 결선 맞대결", () => {
  it("the conversion card counts every market's questions by our state, the not-picked count first", () => {
    const html = render(bodies.snapshot);
    const conv = bodies.snapshot.view!.conversion.views.all;
    expect(html).toContain(T.conv.title);
    expect(html).toContain(`질문 × 시장 ${conv.n}개`);
    expect(html).toContain(`aria-label="${T.conv.open.replace("{country}", "—")}"`);
    expect(html).toContain(`>${T.conv.sortListed}<`);
  });
  it("the head-to-head card shows each rival's wins and says it is a sample", () => {
    const html = render(bodies.snapshot);
    expect(html).toContain(T.duel.title);
    expect(html).toContain(T.duel.chip);
    expect(html).toContain("셀당 반복 1개를 표본으로 계산합니다(반복 20회 중 8회, 셀 8개)");
    expect(html).toMatch(/data-rn-b="Toyota"[^>]*title="Toyota와 함께 후보에 오른 반복 8회 — 당사 승 2 \(25\.0%\) · Toyota 승 3 \(37\.5%\) · 그 외 3 \(37\.5%\)"/);
  });
});

describe("renewal ACR body: what the page counts, and when", () => {
  it("a snapshot names its round in the summary chip and the footer", () => {
    const html = render(bodies.snapshot);
    expect(html).toContain(">2026-09-14 기준 · 직전 회차 대비<");
    expect(html).toContain("최신 회차(2026-09-14) 스냅샷 — 프롬프트 3개");
  });
  it("the engine card counts the prompts with a pick, of the prompts measured", () => {
    const html = render(bodies.snapshot);
    expect(html).toContain(">선택이 나온 프롬프트 1개(측정 3개) × 엔진 2개<");
  });
  it("an empty period says the period may hold no ACR round; other filters keep the scope reason", () => {
    const empty = (b: RnAcrInput): RnAcrInput => ({ ...b, measured: false, filtered: true, view: null });
    expect(render(empty(bodies.period))).toContain("이 기간에는 ACR 측정 회차가 없거나");
    const filtered = render(empty(bodies.snapshot));
    expect(filtered).toContain(T.states.noResultDesc);
    expect(filtered).not.toContain("이 기간에는 ACR 측정 회차가 없거나");
  });
});

describe("renewal ACR body: rounds compared", () => {
  it("a snapshot draws the trend, the Δ column and its sort", () => {
    const html = render(bodies.snapshot);
    expect(html).toContain(`aria-label="${T.hero.trendAria}"`);
    expect(html).toContain(`>${T.board.colTrend}</span>`);
    expect(html).toContain(`>${T.board.colDelta}</span>`);
    expect(html).toContain(`>${T.board.sortDelta}<`);
  });
  it("a period of several rounds shows their sums and its trend", () => {
    const html = render(bodies.period);
    expect(html).toContain(T.summary.titlePeriod);
    expect(html).toContain(`aria-label="${T.hero.trendAria}"`);
  });
});

describe("renewal ACR body: the summary restates the page's numbers (renewal audit 11-1)", () => {
  const withFindings = (findings: NonNullable<RnAcrInput["view"]>["findings"]): RnAcrInput => ({ ...bodies.snapshot, view: { ...bodies.snapshot.view!, findings } });
  it("the leak names the rival shortlisted most alike and the Top1 difference either way", () => {
    expect(render(bodies.snapshot)).toContain("Hyundai, 후보군 포함율이 가장 가까운 Toyota보다 Top1 ACR 30.0pp 높음");
    const leak = bodies.snapshot.view!.findings[1];
    const less = render(withFindings([{ ...leak, tone: "warn", params: { ...leak.params, gap: 2, dir: "less" } }]));
    expect(less).toContain("Hyundai, 후보군 포함율이 가장 가까운 Toyota보다 Top1 ACR 2.0pp 낮음");
    const same = render(withFindings([{ ...leak, tone: "info", params: { ...leak.params, gap: 0, dir: "same" } }]));
    expect(same).toContain("Hyundai, 후보군 포함율이 가장 가까운 Toyota와 Top1 ACR 같음");
    expect(same).not.toContain("비슷하지만");
  });
  it("an engine gap of none says so, and a sweep names no content to add", () => {
    const engine = bodies.snapshot.view!.findings[2];
    expect(render(withFindings([{ ...engine, params: { ...engine.params, wins: 1, diff: 0 } }]))).toContain("엔진마다 당사 1위 프롬프트 1/1로 같음");
    const sweep = render(withFindings([{ kind: "sweep", tone: "info", pri: 4, target: "sec-prompt", brand: "Toyota", params: { rival: "Toyota", count: 1 } }]));
    expect(sweep).toContain("Toyota가 모든 엔진에서 1위인 프롬프트 1개");
    expect(sweep).not.toContain("보강");
  });
  // renewal audit 15 (W6): a gap change shown as 0.0 is no change, not 'widened' or 'narrowed'
  it("a gap change of 0.0 is told as no change", () => {
    const standing = { kind: "standing", tone: "warn", pri: 7, target: "sec-comp", brand: "Toyota", params: { rival: "Toyota", gap: 10, first: 0, own: 20, rivalShare: 30 } } as const;
    const same = render(withFindings([{ ...standing, params: { ...standing.params, move: 0, widened: "same" } }]));
    expect(same).toContain("직전 회차 대비 격차 변화 없음");
    expect(same).not.toContain("벌어졌습니다");
    expect(same).not.toContain("좁혀졌습니다");
    expect(render(withFindings([{ ...standing, params: { ...standing.params, move: 1.2, widened: 1 } }]))).toContain("격차가 직전 회차보다 1.2pp 벌어졌습니다");
  });
  it("the how-to names the fixed order and no importance", () => {
    expect(T.summary.how).not.toContain("중요도를 매겨");
    expect(T.summary.how).toContain("정해진 순서");
  });
});

describe("renewal ACR body: 후보 → 최종 선택 (renewal audit 15, ⛔L)", () => {
  it("draws each brand's two values as a dot, without a brand average line or a distance to it", () => {
    const html = render(bodies.snapshot);
    expect(html).toContain(T.map.title);
    expect(html).toContain(`>브랜드 ${bodies.snapshot.view!.brands.length}개<`);
    expect(html).not.toContain("평균선");
    expect(html).not.toContain("평균보다");
  });
});

describe("renewal ACR body: the brand board (renewal audit 11-4 · 11-5)", () => {
  it("sorts by the original table's name, final picks and mentions too", () => {
    const html = render(bodies.snapshot);
    for (const label of [T.board.sortTop1, T.board.sortCoverage, T.board.sortDelta, T.board.sortChoices, T.board.sortMentions, T.board.sortBrand]) {
      expect(html).toContain(`>${label}<`);
    }
  });
  it("keeps the 당사 = … 합산 chip in the dense layout", () => {
    const multi: RnAcrInput = { ...bodies.snapshot, view: { ...bodies.snapshot.view!, ownBrands: ["Hyundai", "Kia"], multiOwn: true } };
    const html = render(multi);
    const chip = T.hero.ownSum.replace("{brands}", "Hyundai+Kia");
    expect(html).toContain(`>${chip}<`);
    const box = html.slice(html.lastIndexOf("<div", html.indexOf(`>${chip}<`)), html.indexOf(`>${chip}<`));
    expect(box).not.toContain("rn-dense_&amp;]:hidden");
    expect(box).not.toContain("rn-dense_&]:hidden");
  });
});
