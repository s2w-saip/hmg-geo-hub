/**
 * 갭 **범위**(0071)의 화면쪽 계약 — 유닛 2.
 *
 * 지시(제품 책임자 2026-09-11): "8/24 인용만 누락된거라 멘션에 대한 부분은 살려줘야해."
 * 데이터층(유닛 1)이 목록을 계열별로 갈라 주므로 단일 계열 차트는 값이 안 바뀐다.
 * **혼합 화면 둘** 만 소비자가 갈라야 한다:
 *
 *   · 오버뷰 5 KPI 카드 — 한 추이에서 5장이 갈라진다. 인용 점유율 카드만 음영.
 *   · `LiveTrendChart` — 한 플롯에 두 계열이 함께 그려진다. 음영은 플롯 전체를
 *     덮으므로 언급 라인이 관통하는 슬롯에 음영을 깔면 화면이 스스로 모순된다.
 *
 * 카드마다 어느 마커를 싣는가(인용 점유율 카드만 `scope:"citations"` 갭)는 overview/card-trend
 * 화면(back/bff/screens/overview.py)이 정하고, 웹사이트 추이 행은 계열별 마커를 둘 다 싣는다.
 * 여기서는 ① KPI 키 → 계열 표 ② 받은 점으로 그리는 음영·보조선 계획 ③ 차트 배선을 고정한다.
 * recharts 는 `renderToStaticMarkup` 에서 SVG 를 내지 않는다(trend-gap-wiring.test 헤더).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planTrendGaps, type TrendGap } from "@/lib/viz/trend-gap";
import { mixedTrendGapFamily, trendKpiFamily } from "../_data/trend-kpi-family";
import type { SparkPointView } from "../_data/screen-types";

const CITATIONS_GAP: TrendGap = { reason: "collection_error", scope: "citations" };

// ── ① KPI 키 → 계열 ────────────────────────────────────────────────────────

describe("trendKpiFamily", () => {
  it("인용 계열은 둘뿐이다", () => {
    expect(trendKpiFamily("citationShare")).toBe("citation");
    expect(trendKpiFamily("citationAccuracy")).toBe("citation");
  });

  it("언급 계열 4종", () => {
    for (const k of ["visibility", "shareOfVoice", "sentiment", "position"]) {
      expect(trendKpiFamily(k)).toBe("mention");
    }
  });

  it("모르는 키는 언급으로 접는다 — 인용으로 접으면 새 KPI 가 조용히 음영에 덮인다", () => {
    expect(trendKpiFamily("conversionRate")).toBe("mention");
  });
});

describe("mixedTrendGapFamily — 혼합 플롯의 계열", () => {
  it("그리는 시리즈가 전부 인용일 때만 인용이다", () => {
    expect(mixedTrendGapFamily(["citationShare"])).toBe("citation");
    expect(mixedTrendGapFamily(["citationShare", "citationAccuracy"])).toBe("citation");
  });

  it("언급이 하나라도 섞이면 언급 — 음영이 관통하는 라인을 덮으면 안 된다", () => {
    expect(mixedTrendGapFamily(["citationShare", "visibility"])).toBe("mention");
    expect(mixedTrendGapFamily(["visibility", "shareOfVoice"])).toBe("mention");
  });

  it("빈 목록은 언급 — 기본값은 넓게 숨기지 않는 쪽", () => {
    expect(mixedTrendGapFamily([])).toBe("mention");
  });
});

// ── ② 카드 스파크라인 — 받은 점으로 음영·보조선을 계획한다 ───────────────────
//
// 인용만 깨진 주: 언급 카드의 점에는 마커가 없고(값이 살아 있다), 인용 점유율 카드의 점에만
// 마커가 있다(card-trend 화면이 카드 계열로 거른 결과).
const mentionCard: SparkPointView[] = [
  { bucketStart: "2026-08-17", value: 40, wow: null },
  { bucketStart: "2026-08-24", value: 44, wow: 4 },
  { bucketStart: "2026-08-31", value: 46, wow: 2 },
];
const citationCard: SparkPointView[] = [
  { bucketStart: "2026-08-17", value: 20, wow: null },
  { bucketStart: "2026-08-24", value: null, wow: null, gap: CITATIONS_GAP },
  { bucketStart: "2026-08-31", value: 26, wow: null },
];

describe("카드 스파크라인 — `scope:\"citations\"`", () => {
  it("음영·보조선은 인용 카드에서만 계획된다", () => {
    const mention = planTrendGaps(mentionCard, { xKey: "bucketStart", seriesKeys: ["value"], family: "mention" });
    expect(mention.hasGap).toBe(false);
    expect(mention.areas).toHaveLength(0);
    expect(mention.bridges).toHaveLength(0);

    const citation = planTrendGaps(citationCard, { xKey: "bucketStart", seriesKeys: ["value"], family: "citation" });
    expect(citation.hasGap).toBe(true);
    expect(citation.areas).toHaveLength(1);
    expect(citation.bridges).toHaveLength(1);
  });

  it("인용 갭 마커가 언급 계열 차트로 새도 음영을 깔지 않는다 (계열 판정은 차트에서도 한다)", () => {
    const leaked = planTrendGaps(citationCard, { xKey: "bucketStart", seriesKeys: ["value"], family: "mention" });
    expect(leaked.areas).toHaveLength(0);
  });
});

// ── ③ 차트 배선 소스 대조 ──────────────────────────────────────────────────
//
// `planTrendGaps` 의 `family` 는 **선택 인자**라 안 넘겨도 컴파일된다(유닛 1 단독
// 머지를 안전하게 하려고 그렇게 설계했다). 즉 타입이 못 잡는다 — 여기서 잡는다.

const REPO = path.resolve(__dirname, "..", "..", "..", "..", "..");
const CHARTS: Array<[label: string, rel: string, family: string]> = [
  [
    "오버뷰 KPI 카드 스파크라인",
    "app/[locale]/(dash)/dashboard/_components/overview-kpi-cards.tsx",
    "trendKpiFamily(kpiKey)",
  ],
  [
    "오버뷰 확대 추이(LiveTrendChart, 혼합)",
    "app/[locale]/(dash)/dashboard/_components/live-trend-chart.tsx",
    "gapFamily",
  ],
  [
    "인용 화면 주별 도메인 추이",
    "app/[locale]/(dash)/standard/answer-analysis/_components/citations-view.tsx",
    '"citation"',
  ],
  [
    "언급 화면 주별 브랜드 추이",
    "app/[locale]/(dash)/standard/answer-analysis/_components/mentions-view.tsx",
    '"mention"',
  ],
  [
    "4-KPI 탭 히어로",
    "app/[locale]/(dash)/standard/answer-analysis/_components/kpi/kpi-trend-chart.tsx",
    '"mention"',
  ],
  [
    "4-KPI 탭 브랜드 추이",
    "app/[locale]/(dash)/standard/answer-analysis/_components/kpi/brand-trend-chart.tsx",
    '"mention"',
  ],
  [
    "4-KPI 탭 우선 노출도",
    "app/[locale]/(dash)/standard/answer-analysis/_components/kpi/rank-trend-chart.tsx",
    '"mention"',
  ],
];

describe.each(CHARTS)("%s — planTrendGaps 에 계열을 박는다", (_label, rel, family) => {
  const src = fs.readFileSync(path.join(REPO, rel), "utf8");

  it("`family:` 를 넘긴다 — 안 넘기면 종전(전부 갭) 동작으로 조용히 돌아간다", () => {
    const call = src.slice(src.indexOf("planTrendGaps("));
    expect(call).toContain(`family: ${family}`);
  });
});

describe("혼합 소비자 — 마커를 계열로 고른다(소스 대조)", () => {
  it("웹사이트 추이 차트는 보이는 시리즈의 계열 마커만 행에 싣는다", () => {
    const src = fs.readFileSync(
      path.join(REPO, "app/[locale]/(dash)/dashboard/_components/live-trend-chart.tsx"),
      "utf8",
    );
    // 툴팁(`GapAwareTooltip`)은 plan 이 아니라 **행** 에서 마커를 읽는다. 계열이 안 맞는 마커를
    // 행에 남기면 값이 살아 있는 라인의 그 칸이 음영에 덮이고 툴팁도 사라진다.
    expect(src).toContain("mixedTrendGapFamily(");
    expect(src).toContain("p.gap[gapFamily]");
  });
});
