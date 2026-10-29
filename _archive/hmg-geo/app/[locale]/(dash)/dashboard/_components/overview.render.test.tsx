import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { MentionsBrandLive } from "@/lib/scope/result-adapter";
import type { KpiSummary } from "../_data/sample";
import type { LiveGeo, LiveTrend } from "../_data/live";
import { OverviewKpiCards, competitorMinis, detailHref } from "./overview-kpi-cards";
import {
  GeoOverview,
  countryMenuAllChecked,
  isCountryChecked,
  realPickedCount,
  regionCheckState,
  toggleAllCountries,
  toggleRegionCountries,
  toggleSingleCountry,
} from "./geo-overview";

// 지도는 dynamic(ssr:false) — 정적 렌더에서는 로딩 자리표시자만 나온다.

const kpi = (key: KpiSummary["key"], value: number | null, delta: number | null): KpiSummary => ({
  key, value, delta, direction: delta == null || delta === 0 ? "flat" : delta > 0 ? "up" : "down",
});
const KPIS: KpiSummary[] = [
  kpi("visibility", 73.1, -4.4), kpi("shareOfVoice", 12.5, 0.6), kpi("sentiment", 55.2, null),
  kpi("position", 12.2, -1.1), kpi("citationShare", 9.6, 1.3),
];
const TREND: LiveTrend = {
  unit: "week", lastMeasuredAt: null, totalAnswers: 0,
  points: [
    { bucketStart: "2026-08-03", firstAt: null, lastAt: null, measuredDays: 7, answers: 100, values: { visibility: 70, shareOfVoice: 12, position: 13 } },
    { bucketStart: "2026-08-10", firstAt: null, lastAt: null, measuredDays: 7, answers: 100, values: { visibility: 73.1, shareOfVoice: 12.5, position: 12.2 } },
  ],
};
const brand = (b: string, isTracked: boolean, over: Partial<MentionsBrandLive>): MentionsBrandLive => ({
  brand: b, mentions: 10, prompts: 1, share: 1, mentionRate: 1, avgPosition: null, isTracked, ...over,
});
const BRANDS = [
  brand("Hyundai", true, { mentionRate: 60, share: 30 }),
  brand("Tesla", false, { mentionRate: 40, share: 20, avgPosition: 3.1, sentiment: { positive: 8, neutral: 1, negative: 1, mixed: 0 } }),
  brand("BMW", false, { mentionRate: 35, share: 15, avgPosition: 5.2 }),
  brand("Toyota", false, { mentionRate: 30, share: 10, avgPosition: 4.4, mentions: 0 }),
];
const GEO: LiveGeo = {
  ourLabel: "HMG", pending: ["hyundai-africa"],
  markets: [{
    region: "hyundai-europe", hmgSov: 42.2, hmgRank: 1, fieldSize: 5, topBrand: null, topRival: { name: "BMW", sov: 7.3 },
    metrics: {
      visibility: { ours: 42.2, rival: { name: "BMW", value: 7.3 } }, shareOfVoice: { ours: 42.2, rival: { name: "BMW", value: 7.3 } },
      sentiment: { ours: 60, rival: { name: "BMW", value: 50 } }, position: { ours: 9.5, rival: { name: "BMW", value: 11 } }, citationShare: { ours: 8, rival: null },
    },
    countries: [{
      code: "DE", country: "Germany", hmgSov: 40, hmgRank: 1, fieldSize: 4, topBrand: null, topRival: { name: "BMW", sov: 9 },
      metrics: { visibility: { ours: 40, rival: { name: "BMW", value: 9 } }, shareOfVoice: { ours: 40, rival: { name: "BMW", value: 9 } }, sentiment: { ours: 55, rival: null }, position: { ours: 10, rival: null }, citationShare: { ours: 5, rival: null } },
    }],
  }],
};

function render(node: React.ReactNode, locale: "ko" | "en" = "ko") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      <TooltipProvider>{node}</TooltipProvider>
    </NextIntlClientProvider>,
  );
}

describe("competitorMinis / detailHref", () => {
  it("ranks competitors per KPI and hides brands without a value", () => {
    // 후보 선정 = 언급 수 상위(소수 브랜드 100% 방지 가드 유지). Toyota 는 mentions 0
    // → 노출률/점유율 값 null 로 제외. **표시 순서는 지표 값 기준**(QA #15):
    // 노출률 = 내림차순(Tesla 40, BMW 35), 우선 노출도 = 오름차순(3.1, 4.4, 5.2).
    expect(competitorMinis(BRANDS, "visibility").map((c) => c.brand)).toEqual(["Tesla", "BMW"]);
    expect(competitorMinis(BRANDS, "position").map((c) => c.brand)).toEqual(["Tesla", "Toyota", "BMW"]);
    expect(competitorMinis(BRANDS, "sentiment")).toEqual([{ brand: "Tesla", value: 80 }]);
    expect(competitorMinis(BRANDS, "citationShare")).toEqual([]);
  });
  it("links each card to its detail tab, carrying the filter query", () => {
    expect(detailHref("visibility", "ko", "brand=Hyundai")).toBe("/ko/standard/answer-analysis/mention?kpi=exposure&brand=Hyundai");
    expect(detailHref("citationShare", "en", "")).toBe("/en/standard/answer-analysis/citation");
  });
});

describe("OverviewKpiCards", () => {
  it.each(["ko", "en"] as const)("renders 5 cards with values · deltas · competitors without raw keys (%s)", (locale) => {
    const html = render(<OverviewKpiCards kpis={KPIS} trend={TREND} brands={BRANDS} locale={locale} qs="brand=Hyundai" />, locale);
    expect(html).not.toMatch(/dashboard\.(overview|kpi)\./);
    expect((html.match(/data-overview-card=/g) ?? []).length).toBe(5);
    expect(html).toContain("73.1%");
    expect(html).toContain("4.4pp");
    expect(html).toContain(locale === "ko" ? "12.2위" : "#12.2");
    expect(html).toContain("Tesla");
    expect(html).toContain('href="/' + locale + '/standard/answer-analysis/mention?kpi=exposure&amp;brand=Hyundai"');
  });
  it("shows the pending label for a null value and drops the competitor row with it", () => {
    // QA #23 — 값이 "측정 대기"면 Δ·스파크라인·경쟁사 행을 함께 내린다. 종전에는
    // 경쟁사 안내문("경쟁사 값을 제공하지 않는 지표입니다")이 그대로 남았다.
    const html = render(<OverviewKpiCards kpis={[kpi("visibility", null, null)]} trend={null} brands={[]} locale="ko" />);
    expect(html).toContain(ko.dashboard.overview.cardEmpty);
    expect(html).not.toContain(ko.dashboard.overview.noCompetitorData);
  });
  it("hides the delta when the card is pending or the value collapsed to 0 (QA #23)", () => {
    // 값 null + Δ -44.4 → Δ 를 찍지 않는다 (이미지의 'AI 우호도 측정 대기 ↘44.4pp').
    const pending = render(<OverviewKpiCards kpis={[kpi("sentiment", null, -44.4)]} trend={null} brands={[]} locale="ko" />);
    expect(pending).not.toContain("44.4pp");
    // 값 0 + 분모 0 + Δ -100 (이미지의 'AI 노출률 0.0% ↘100.0pp') → 분모 부재 = 측정 대기.
    const collapsed = render(<OverviewKpiCards kpis={[{ ...kpi("visibility", 0, -100), ratio: { numerator: 0, denominator: 0 } }]} trend={null} brands={[]} locale="ko" />);
    expect(collapsed).not.toContain("100.0pp");
    expect(collapsed).toContain(ko.dashboard.overview.cardEmpty);
    // 값 0 + 분모 120 + Δ -100 → 측정된 진짜 0 의 실제 하락. Δ 를 가리지 않는다 (verifier 2026-09-08).
    const realZero = render(<OverviewKpiCards kpis={[{ ...kpi("visibility", 0, -100), ratio: { numerator: 0, denominator: 120 } }]} trend={null} brands={[]} locale="ko" />);
    expect(realZero).toContain("100.0pp");
    expect(realZero).toContain("0.0%");
  });
});

describe("GeoOverview", () => {
  it("renders KPI chips · tree table with region and country rows · rival column", () => {
    const html = render(<GeoOverview geo={GEO} />);
    expect(html).not.toMatch(/dashboard\.overview\./);
    expect((html.match(/role="tab"/g) ?? []).length).toBe(5);
    expect(html).toContain("42.2%");
    expect(html).toContain('data-geo-country="DE"');
    expect(html).toContain("BMW");
    expect(html).toContain("7.3%");
  });
  it("formats the position KPI as a rank", () => {
    const html = render(<GeoOverview geo={GEO} initialMetric="position" />);
    expect(html).toContain("9.5위");
    expect(html).toContain("10.0위"); // 국가 행
  });
  it("narrows to the picked countries — a region with no picked country disappears", () => {
    expect(render(<GeoOverview geo={GEO} initialCountries={["DE"]} />)).toContain('data-geo-country="DE"');
    expect(render(<GeoOverview geo={GEO} initialCountries={["FR"]} />)).not.toContain('data-geo-country="DE"');
  });
  it("explains the brand requirement when there are no markets", () => {
    const html = render(<GeoOverview geo={{ ourLabel: "HMG", pending: [], markets: [] }} />);
    expect(html).toContain(ko.dashboard.overview.geo.brandRequired);
  });
});

// 국가 드롭다운 상단 트리거는 static markup 으로 보이지만(위 describe), 항목 자체는
// shadcn DropdownMenuContent → Radix Portal 안에 있다. Portal 은 client mount 시점의
// useLayoutEffect 로만 열려(node_modules/@radix-ui/react-portal) renderToStaticMarkup
// 에서는 항상 null 을 반환한다 — 즉 체크박스 UI·권역 헤더는 이 하네스로 직접 볼 수
// 없다. 컴포넌트가 실제로 쓰는 정본 함수(11·12)를 export 해 여기서 직접 검증한다.
describe("GeoOverview country menu logic (11·12)", () => {
  const COUNTRIES = [{ code: "DE" }, { code: "FR" }, { code: "KR" }];
  const EU_REGION = ["DE", "FR"];

  it("renders a checked/indeterminate/unchecked tri-state for the region header (11)", () => {
    // 기본값(빈 집합=전체) — 권역 전부 체크.
    expect(regionCheckState(new Set(), EU_REGION)).toBe(true);
    // 권역 국가 중 하나만 명시적으로 선택 — indeterminate.
    expect(regionCheckState(new Set(["DE"]), EU_REGION)).toBe("indeterminate");
    // 권역 국가를 전부 선택 — checked.
    expect(regionCheckState(new Set(["DE", "FR"]), EU_REGION)).toBe(true);
    // 다른 권역만 선택(이 권역은 0개) — unchecked.
    expect(regionCheckState(new Set(["KR"]), EU_REGION)).toBe(false);
  });

  it("checks each country item visibly, materializing the implicit 'empty = all' set on toggle (11)", () => {
    // 기본값에서도 개별 항목은 전부 체크로 보인다(QA #9 유지).
    expect(isCountryChecked(new Set(), "DE")).toBe(true);
    // 기본값에서 DE 하나만 해제하면 나머지는 명시적으로 남는다.
    const afterUncheckDe = toggleSingleCountry(new Set(), COUNTRIES, "DE", false);
    expect(afterUncheckDe).toEqual(new Set(["FR", "KR"]));
    // 권역 헤더 클릭으로 EU 전체(DE·FR)를 해제해도 같은 방식으로 구체화된다.
    const afterUncheckEu = toggleRegionCountries(new Set(), COUNTRIES, EU_REGION, false);
    expect(afterUncheckEu).toEqual(new Set(["KR"]));
  });

  it("전부 선택 상태(빈 집합·전체 명시) 모두에서 상단 항목이 '전체 선택 해제'로 보이고, 누르면 실제로 전부 해제된다 (12)", () => {
    // 경로 1 — 화면 기본값(빈 집합=전체).
    const empty = new Set<string>();
    expect(countryMenuAllChecked(empty, COUNTRIES)).toBe(true); // → t("geo.deselectAll") 라벨
    const afterEmpty = toggleAllCountries(empty, COUNTRIES);
    expect(countryMenuAllChecked(afterEmpty, COUNTRIES)).toBe(false); // → t("geo.selectAll") 로 되돌아옴
    expect(realPickedCount(afterEmpty)).toBe(0);
    COUNTRIES.forEach((c) => expect(isCountryChecked(afterEmpty, c.code)).toBe(false));

    // 경로 2 — 국가를 하나씩 눌러 전부 명시적으로 선택한 경우(빈 집합이 아님).
    const explicitAll = new Set(COUNTRIES.map((c) => c.code));
    expect(countryMenuAllChecked(explicitAll, COUNTRIES)).toBe(true); // → deselectAll 도 여기서 보여야 한다
    const afterExplicit = toggleAllCountries(explicitAll, COUNTRIES);
    expect(countryMenuAllChecked(afterExplicit, COUNTRIES)).toBe(false);
    expect(realPickedCount(afterExplicit)).toBe(0);
  });
});
