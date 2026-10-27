import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { BrandTrendChartData } from "../../_data/mention-screen";
import { BrandTrendChart, brandLineProps } from "./brand-trend-chart";

// 히어로 우측 다중 브랜드 라인(디자인 327:550)의 계약.
//
// ⚠️ recharts 는 `renderToStaticMarkup` 에서 SVG 를 내지 않는다(2026-09-02 실측:
// ResponsiveContainer 가 wrapper div 만 남긴다 — 폭 측정이 브라우저에만 있다).
// 따라서 "라인이 몇 개인가·갭을 잇는가·색이 무엇인가"는 마크업으로 볼 수 없어,
// 컴포넌트가 실제로 map 하는 순수 함수(`brandLineProps`)로 고정한다. 마크업으로는
// 캡션·커버리지가 나오는지(= 이 차트가 그려졌는지)만 본다.

const DATA: BrandTrendChartData = {
  series: [
    { brand: "Hyundai", isTracked: true, colorIndex: 0 },
    { brand: "Kia", isTracked: true, colorIndex: 1 },
    { brand: "BMW", isTracked: false, colorIndex: 3 },
  ],
  points: [
    { bucketStart: "2026-07-06", Hyundai: 10, Kia: 5, BMW: 4 },
    // 결측 회차 — 전 시리즈가 null 이라 선이 끊긴다(보간 금지).
    { bucketStart: "2026-07-13", Hyundai: null, Kia: null, BMW: null },
    { bucketStart: "2026-07-20", Hyundai: 15, Kia: 6, BMW: 3 },
  ],
  coverage: [
    { bucketStart: "2026-07-06", measuredDays: 7 },
    { bucketStart: "2026-07-20", measuredDays: 3 },
  ],
};

describe("brandLineProps", () => {
  it("emits one line per brand — not a single own-brand line", () => {
    expect(brandLineProps(DATA).map((p) => p.dataKey)).toEqual(["Hyundai", "Kia", "BMW"]);
  });

  it("never connects across a missing cycle", () => {
    for (const p of brandLineProps(DATA)) expect(p.connectNulls).toBe(false);
  });

  it("uses the entity colour for our brands and the series scale for the rest", () => {
    const [hyundai, kia, bmw] = brandLineProps(DATA);
    expect(hyundai.stroke).toBe("var(--color-own-hyundai)");
    expect(kia.stroke).toBe("var(--color-own-kia)");
    // 경쟁사는 표의 행 인덱스로 순환색 — 표와 차트가 같은 색을 쓴다.
    expect(bmw.stroke).toBe("var(--color-series-4)");
    // 토큰만 참조한다(컴포넌트에 hex 리터럴 금지).
    for (const p of brandLineProps(DATA)) expect(p.stroke.startsWith("var(--")).toBe(true);
  });

  it("draws our lines heavier so the baseline stays readable", () => {
    const [hyundai, , bmw] = brandLineProps(DATA);
    expect(hyundai.strokeWidth).toBeGreaterThan(bmw.strokeWidth);
  });
});

describe("BrandTrendChart", () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <BrandTrendChart metric="sov" data={DATA} />
    </NextIntlClientProvider>,
  );

  it("renders without throwing and captions the measure", () => {
    expect(html).toContain(ko.answerAnalysis.mentions.kpi.hero.brandTrendNote.sov);
    expect(html).not.toContain("answerAnalysis.mentions.kpi");
  });

  it("lists only measured cycles in the coverage label", () => {
    expect(html.match(/일 측정/g) ?? []).toHaveLength(2);
  });
});
