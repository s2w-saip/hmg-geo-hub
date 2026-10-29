/**
 * 갭 **범위**(0071)의 화면쪽 계약 — 유닛 2.
 *
 * 지시(운영 2026-09-11): "8/24 인용만 누락된거라 멘션에 대한 부분은 살려줘야해."
 * 데이터층(유닛 1)이 목록을 계열별로 갈라 주므로 단일 계열 차트는 값이 안 바뀐다.
 * **혼합 화면 둘** 만 소비자가 갈라야 한다:
 *
 *   · 오버뷰 5 KPI 카드 — 한 추이에서 5장이 갈라진다. 인용 점유율 카드만 음영.
 *   · `LiveTrendChart` — 한 플롯에 두 계열이 함께 그려진다. 음영은 플롯 전체를
 *     덮으므로 언급 라인이 관통하는 슬롯에 음영을 깔면 화면이 스스로 모순된다.
 *
 * recharts 는 `renderToStaticMarkup` 에서 SVG 를 내지 않는다(trend-gap-wiring.test
 * 헤더). 그래서 ① 순수 매핑은 실행으로 ② 차트 배선은 소스 대조로 고정한다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planTrendGaps, type TrendGap } from "@/lib/viz/trend-gap";
import { sparkPoints } from "./overview-kpi-cards";
import { mixedTrendGapFamily, trendKpiFamily } from "../_data/trend-kpi-family";
import type { LiveTrend } from "../_data/live";

const CITATIONS_GAP: TrendGap = { reason: "collection_error", scope: "citations" };
const ALL_GAP: TrendGap = { reason: "collection_error" };

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

// ── ② 카드 스파크라인 — 계열별로 마커를 떨군다 ─────────────────────────────

const trendWith = (gap: TrendGap): LiveTrend => ({
  unit: "week",
  lastMeasuredAt: "2026-08-31T00:00:00.000Z",
  totalAnswers: 3,
  points: [
    {
      bucketStart: "2026-08-17",
      firstAt: null,
      lastAt: null,
      measuredDays: 7,
      answers: 10,
      values: { visibility: 40, citationShare: 20 },
    },
    // 인용만 깨진 주 — 언급 값은 **살아 있고** 인용 값만 없다.
    {
      bucketStart: "2026-08-24",
      firstAt: null,
      lastAt: null,
      measuredDays: 7,
      answers: 12,
      values: { visibility: 44 },
      gap,
    },
    {
      bucketStart: "2026-08-31",
      firstAt: null,
      lastAt: null,
      measuredDays: 7,
      answers: 12,
      values: { visibility: 46, citationShare: 26 },
    },
  ],
});

describe("sparkPoints — `scope:\"citations\"`", () => {
  it("언급 카드 4장은 마커를 안 받는다 — 값이 그대로 그려진다", () => {
    for (const k of ["visibility", "shareOfVoice", "sentiment", "position"] as const) {
      const pts = sparkPoints(trendWith(CITATIONS_GAP), k);
      expect(pts[1].gap, `${k} 카드에 인용 갭 마커가 샜다`).toBeUndefined();
    }
    // 언급 값은 살아 있어야 한다(이 유닛의 목적).
    expect(sparkPoints(trendWith(CITATIONS_GAP), "visibility")[1].value).toBe(44);
  });

  it("인용 점유율 카드만 마커를 받는다", () => {
    const pts = sparkPoints(trendWith(CITATIONS_GAP), "citationShare");
    expect(pts[1].gap).toEqual(CITATIONS_GAP);
    expect(pts[1].value).toBeNull();
  });

  it("음영·보조선도 인용 카드에서만 계획된다", () => {
    const mention = planTrendGaps(sparkPoints(trendWith(CITATIONS_GAP), "visibility"), {
      xKey: "bucketStart",
      seriesKeys: ["value"],
      family: "mention",
    });
    expect(mention.hasGap).toBe(false);
    expect(mention.areas).toHaveLength(0);
    expect(mention.bridges).toHaveLength(0);

    const citation = planTrendGaps(sparkPoints(trendWith(CITATIONS_GAP), "citationShare"), {
      xKey: "bucketStart",
      seriesKeys: ["value"],
      family: "citation",
    });
    expect(citation.hasGap).toBe(true);
    expect(citation.areas).toHaveLength(1);
    expect(citation.bridges).toHaveLength(1);
  });
});

describe("sparkPoints — 회귀: `scope` 없는 갭은 5장 전부", () => {
  it("언급 카드도 마커를 받는다(종전 동작)", () => {
    for (const k of ["visibility", "shareOfVoice", "sentiment", "position", "citationShare"] as const) {
      const pts = sparkPoints(trendWith(ALL_GAP), k);
      expect(pts[1].gap, `${k} 카드에서 종전 갭이 사라졌다`).toEqual(ALL_GAP);
    }
  });

  it("`scope:\"all\"` 명시도 같다", () => {
    const g: TrendGap = { reason: "collection_error", scope: "all" };
    expect(sparkPoints(trendWith(g), "visibility")[1].gap).toEqual(g);
  });

  it("갭 없는 추이는 마커가 아예 없다", () => {
    const t = trendWith(ALL_GAP);
    delete t.points[1].gap;
    expect(sparkPoints(t, "visibility").every((p) => p.gap === undefined)).toBe(true);
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

describe("혼합 소비자 — 마커를 계열로 거른다(소스 대조)", () => {
  it("카드 스파크라인 매핑이 `trendGapApplies` 로 거른다", () => {
    const src = fs.readFileSync(
      path.join(REPO, "app/[locale]/(dash)/dashboard/_components/overview-kpi-cards.tsx"),
      "utf8",
    );
    // 툴팁(`GapAwareTooltip`)은 plan 이 아니라 **행** 에서 마커를 읽는다. 행에
    // 남겨두면 값이 살아 있는 언급 카드의 그 칸이 음영에 덮이고 툴팁도 사라진다
    // (갭 행이면 툴팁을 안 낸다 — 2026-09-11 운영).
    expect(src).toContain("trendGapApplies(");
  });

  it("LiveTrendChart 행 매핑도 `trendGapApplies` 로 거른다", () => {
    const src = fs.readFileSync(
      path.join(REPO, "app/[locale]/(dash)/dashboard/_components/live-trend-chart.tsx"),
      "utf8",
    );
    expect(src).toContain("trendGapApplies(");
    expect(src).toContain("mixedTrendGapFamily(");
  });
});
