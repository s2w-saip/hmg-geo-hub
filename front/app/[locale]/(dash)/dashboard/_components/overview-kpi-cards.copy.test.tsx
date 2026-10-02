import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { TooltipProvider } from "@/components/ui/tooltip";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import type { CompetitorBrandValue } from "@/lib/scope/result-adapter";
import type { KpiSummary } from "../_data/sample";
import { OverviewKpiCards } from "./overview-kpi-cards";

// PR④ B4 — **값 정의 변경의 화면 노출**. PR③ 이후 카드 ①~⑤ 의 Δ 는 주 버킷이 아니라
// 회차 축(값 있는 마지막 두 점 = 직전 회차 대비)이고, 측정 기준일도 회차 앵커
// (`CYCLE_AS_OF_SQL = max(COALESCE(r.cycle_anchor_at, a.measured_at))`,
// scope-aggregates.ts:1305)다. 문구가 종전의 "이전 동일 기간"·"최근 측정일" 로
// 되돌아가면 화면이 산식과 다른 말을 하게 되므로 여기서 고정한다.
//
// 지표 **정의문**(`dashboard.kpi.definition.*`)은 이 PR 의 대상이 아니다 — 우선노출도
// 축 정합은 PR④-b 소관이라, 여기서 정의가 바뀌지 않았다는 것도 함께 고정한다.

const kpi = (key: KpiSummary["key"], value: number | null, delta: number | null): KpiSummary => ({
  key, value, delta, direction: delta == null || delta === 0 ? "flat" : delta > 0 ? "up" : "down",
  ratio: { numerator: 1, denominator: 100 },
});
const brand = (b: string, over: Partial<CompetitorBrandValue>): CompetitorBrandValue => ({
  brand: b, mentions: 10, share: 1, mentionRate: 1, avgPosition: null, isTracked: false, ...over,
});
const BRANDS: CompetitorBrandValue[] = [
  brand("Hyundai", { isTracked: true, mentionRate: 60, share: 30 }),
  brand("Tesla", { mentionRate: 40, share: 20 }),
];

function render(node: React.ReactNode, locale: "ko" | "en" = "ko") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ko" ? ko : en} timeZone="Asia/Seoul">
      <TooltipProvider>{node}</TooltipProvider>
    </NextIntlClientProvider>,
  );
}

describe("오버뷰 문안 — 회차 축 (PR④ B4)", () => {
  it("ko·en 이 짝을 이루고, 측정 기준일은 여전히 {date} 를 받는다", () => {
    const k = ko.dashboard.overview;
    const e = en.dashboard.overview;
    expect(Object.keys(k).sort()).toEqual(Object.keys(e).sort());
    // pill 이 날짜를 못 받으면 "측정 회차 기준" 만 남는다 — 자리표시자를 고정한다.
    expect(k.lastMeasured).toContain("{date}");
    expect(e.lastMeasured).toContain("{date}");
  });

  it("카드 Δ 라벨이 회차 축을 말한다 — '기간'·'period' 로 돌아가지 않는다", () => {
    expect(ko.dashboard.overview.compare).toBe("직전 회차 대비");
    expect(en.dashboard.overview.compare).toBe("vs. previous cycle");
    expect(ko.dashboard.overview.lastMeasured).not.toContain("최근 측정일");
    expect(en.dashboard.overview.compare).not.toMatch(/period/i);

    const html = render(<OverviewKpiCards kpis={[kpi("visibility", 73.1, -4.4)]} trend={null} brands={BRANDS} locale="ko" />);
    expect(html).toContain(ko.dashboard.overview.compare);
    expect(html).not.toContain("이전 동일 기간 대비");
  });

  it("지표 정의문은 그대로다 — 우선노출도는 답변 안 경쟁 순위 (PR④-b 소관)", () => {
    expect(ko.dashboard.kpi.definition.position).toBe(
      "당사 브랜드가 등장한 각 답변에서, 답변에 언급된 브랜드 가운데 당사 브랜드의 순위(1 = 가장 먼저)의 평균값 (비경쟁·노이즈 브랜드 제외, 당사 미언급 답변은 계산에서 제외)",
    );
    expect(ko.dashboard.kpi.formula.position).toBe(
      "Σ(답변 내 브랜드 중 당사 순위 = 당사보다 먼저 언급된 비노이즈 브랜드 수 + 1) ÷ 당사 브랜드가 1회 이상 언급된 답변 수 (단위: 위)",
    );
    expect(ko.dashboard.kpi.ratio.position).toEqual({
      num: "최초 등장 순위의 합",
      den: "언급된 답변 수 (순위 미진입 제외)",
    });
  });
});

describe("경쟁사 행 Δ 기준 안내 (PR④ B4)", () => {
  it.each(["ko", "en"] as const)("경쟁사 값이 있으면 Δ 기준 안내를 함께 낸다 (%s)", (locale) => {
    const msg = (locale === "ko" ? ko : en).dashboard.overview.competitorDeltaBasis;
    const html = render(<OverviewKpiCards kpis={[kpi("visibility", 73.1, -4.4)]} trend={null} brands={BRANDS} locale={locale} />, locale);
    expect(html).toContain("Tesla");
    expect(html).toContain(msg);
    // 안내는 sr-only 문단 — 보이는 흐름에 줄을 추가하지 않는다(레이아웃 회귀 0).
    expect(html).toContain(`<p class="sr-only">${msg}</p>`);
    expect(html).not.toMatch(/dashboard\.overview\./);
  });

  it("경쟁사 값이 없는 지표에는 안내를 내지 않는다 — 설명할 Δ 가 없다", () => {
    // citationShare 는 동기 경로(brands)에서 값 원천이 없어 안내문만 나온다.
    const html = render(<OverviewKpiCards kpis={[kpi("citationShare", 9.6, 1.3)]} trend={null} brands={BRANDS} locale="ko" />);
    expect(html).toContain(ko.dashboard.overview.noCompetitorData);
    expect(html).not.toContain(ko.dashboard.overview.competitorDeltaBasis);
  });

  it("레이아웃 회귀 0 — 경쟁사 그리드·셀·Δ 칩의 클래스가 그대로다", () => {
    const html = render(<OverviewKpiCards kpis={[kpi("visibility", 73.1, -4.4)]} trend={null} brands={BRANDS} locale="ko" />);
    expect(html).toContain('<ul class="grid grid-cols-4 gap-4">');
    expect(html).toContain('<li class="flex min-w-0 flex-col gap-3">');
    expect(html).toContain('<div class="flex items-baseline gap-1.5">');
    // Δ 가 없으면 '−'(QA #22). 툴팁은 `asChild` 라 **같은 span** 에 Radix 속성만
    // 얹는다 — 엘리먼트도 클래스도 그대로이므로 자리·크기가 움직이지 않는다.
    expect(html).toContain(
      '<span class="text-[11px] tabular-nums text-muted-foreground" data-state="closed" data-slot="tooltip-trigger">−</span>',
    );
  });
});
