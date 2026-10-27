/**
 * 0070 갭 오버레이 **배선 가드** — 미배선으로 남아 있던 두 차트(2026-09-10 실측).
 *
 * 지문: 8/25 회차를 숨긴 뒤 인용·언급 주별 차트와 오버뷰 헤드라인 추이는 음영·툴팁이
 * 정상인데, **오버뷰 KPI 카드의 스파크라인**과 **4-KPI 탭 히어로(`KpiTrendChart`)** 만
 * 8/25 자리에 점 없이 선이 끊겨 보였다. 화면에 보이던 줄무늬는 갭 음영이 아니라
 * recharts 통상 격자(`recharts-cartesian-grid-bg`)다 — 즉 "표시가 있는 것처럼" 보여
 * 눈으로는 더 찾기 어려운 형태였다.
 *
 * 원인은 두 층이 각각 하나씩이었다:
 *   ① 스파크라인 — 점 매핑이 `gap` 마커를 **떨어뜨렸다**(값만 옮겼다). 점과 마커는 이제
 *      overview/card-trend 화면(back/bff/screens/overview.py)이 만든다.
 *   ② KpiTrendChart — 데이터에는 마커가 있는데 차트가 오버레이를 **안 그렸다**.
 *
 * recharts 는 `renderToStaticMarkup` 에서 SVG 를 내지 않으므로(brand-trend-chart
 * 테스트 헤더 참고) 마크업으로는 음영·보조선을 볼 수 없다. 그래서 차트 배선은 소스 대조로
 * 고정한다(실제 렌더는 trend-gap-bridge.render.test.tsx).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planTrendGaps, type TrendGap } from "@/lib/viz/trend-gap";

const GAP: TrendGap = { reason: "collection_error" };

// ── 차트 입력이 **문자 그대로 종전과 같다** ─────────────────────────────────
//
// 두 차트 모두 `data={gapPlan.rows}` 로 바뀌었다. 2026-09-11 부터 그 값은 갭이 있든
// 없든 입력 배열 **그 자체**(참조 동일)다 — 보조선이 합성 시리즈에서 곡선 path 로
// 바뀌면서 행에 값을 심을 이유가 없어졌기 때문. recharts 가 받는 데이터 props 는
// 한 글자도 안 달라진다.
describe("갭 없는 데이터 → 오버레이는 아무것도 더하지 않는다", () => {
  const rows = [
    { bucketStart: "2026-08-17", pct: 40 },
    { bucketStart: "2026-08-24", pct: null },
    { bucketStart: "2026-08-31", pct: 46 },
  ];

  it("rows 는 입력 배열 그대로다(참조 동일)", () => {
    const plan = planTrendGaps(rows, { xKey: "bucketStart", seriesKeys: ["pct"] });
    expect(plan.rows).toBe(rows);
    expect(plan.hasGap).toBe(false);
    expect(plan.areas).toEqual([]);
    expect(plan.bridges).toEqual([]);
  });

  it("측정 없는 회차(null)만으로는 갭이 되지 않는다 — 마커가 있어야 한다", () => {
    // 이 구분이 이 기능의 전부다: 미측정은 끊긴 선, 수집 오류는 음영 + 사유.
    const plan = planTrendGaps(rows, { xKey: "bucketStart", seriesKeys: ["pct"] });
    expect(plan.hasGap).toBe(false);
  });

  it("마커가 붙으면 음영 1개 + 이웃 연결 1개가 생긴다", () => {
    const withGap = rows.map((r, i) => (i === 1 ? { ...r, gap: GAP } : r));
    const plan = planTrendGaps(withGap, { xKey: "bucketStart", seriesKeys: ["pct"] });
    expect(plan.hasGap).toBe(true);
    expect(plan.areas).toHaveLength(1);
    expect(plan.areas[0]).toMatchObject({ x1: "2026-08-17", x2: "2026-08-31" });
    expect(plan.bridges).toHaveLength(1);
  });
});

// ── ② 두 차트가 오버레이를 실제로 그린다 (소스 대조) ────────────────────────

const REPO = path.resolve(__dirname, "..", "..");
const TARGETS: Array<
  [label: string, rel: string, seriesKey: string, tooltip: "gapAware" | "own"]
> = [
  [
    "오버뷰 KPI 카드 스파크라인",
    "app/[locale]/(dash)/dashboard/_components/overview-kpi-cards.tsx",
    '"value"',
    "gapAware",
  ],
  [
    "4-KPI 탭 히어로(KpiTrendChart)",
    "app/[locale]/(dash)/standard/answer-analysis/_components/kpi/kpi-trend-chart.tsx",
    '"pct"',
    "own",
  ],
];

describe.each(TARGETS)("%s — 갭 오버레이 배선", (_label, rel, seriesKey, tooltip) => {
  const src = fs.readFileSync(path.join(REPO, rel), "utf8");

  it("planTrendGaps 로 계획을 세운다", () => {
    expect(src).toContain("planTrendGaps(");
    expect(src).toContain(`seriesKeys: [${seriesKey}]`);
  });

  // `gapPlan.rows` 는 이제 입력 배열과 같은 참조지만, 호출부를 한 형태로 묶어 두면
  // 나중에 계획이 행을 다시 만지게 돼도 이 두 차트만 빠지는 일이 없다.
  it("차트가 계획이 내준 행을 받는다 — 호출부 형태를 통일해 둔다", () => {
    expect(src).toMatch(/<LineChart\s+data=\{gapPlan\.rows\}/);
  });

  it("음영과 이웃 연결을 둘 다 그린다", () => {
    expect(src).toContain("trendGapAreas(gapPlan.areas)");
    expect(src).toContain("trendGapBridgeLines(gapPlan.bridges");
  });


  it("음영은 라인보다 **먼저** 선언된다 — 뒤에 깔려야 값을 가리지 않는다", () => {
    const iLine = src.search(/<Line\b/);
    expect(iLine, "값 라인(<Line>)을 못 찾았다").toBeGreaterThan(0);
    expect(src.indexOf("trendGapAreas(")).toBeLessThan(iLine);
  });

  // 2026-09-11 제품 책임자 "이거, 오류로 인해 수집되지 않음 호버 지워줘" → 같은 날
  // "다른 차트에도 갭 툴팁 지워줘". 갭 슬롯의 계약은 **툴팁 없음**이다.
  it("갭 슬롯에는 툴팁이 안 뜬다 — 문구를 되살리면 여기서 걸린다", () => {
    expect(src).toContain("filterNull={false}");
    if (tooltip === "gapAware") {
      expect(src).toContain("content={<GapAwareTooltip />}");
    } else {
      expect(src).toMatch(/if \(trendGapHidesTooltip\(payload\)\) return null;/);
    }
    // 문구 키는 사전에서 사라졌다 — 되살아나면 죽은 문자열이 다시 생긴다.
    expect(src).not.toContain('useTranslations("trend.gap")');
    expect(src).not.toContain('tGap("collectionError")');
  });

  it("갭이 아닌 결측 슬롯은 여전히 아무것도 안 낸다 — filterNull={false} 가 표시를 바꾸면 안 된다", () => {
    // 이 둘이 `filterNull={false}` 를 무해하게 만든다. 없어지면 "측정 없는 주"에
    // 빈 툴팁이 뜨기 시작한다(갭 없는 데이터에서 렌더가 달라진다).
    //   · KpiTrendChart — 자기 툴팁 본문의 null 가드
    //   · 스파크라인    — GapAwareTooltip 이 recharts 의 filterNull 을 재현(overlay 테스트)
    const guarded =
      /p\.pct == null\) return null/.test(src) || src.includes("GapAwareTooltip");
    expect(guarded, "null 슬롯 가드가 사라졌다").toBe(true);
  });

  it("보조선 색은 globals.css 토큰이다 — 컴포넌트에 hex 리터럴 금지", () => {
    const bridge = /trendGapBridgeLines\(gapPlan\.bridges,[\s\S]{0,240}?\}\)\)/.exec(src)?.[0] ?? "";
    expect(bridge, "보조선 스타일 블록을 못 찾았다").not.toBe("");
    expect(bridge).toContain("var(--color-brand-700)");
    expect(bridge).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});

// ── ③ 오버뷰 순위 카드 y 축 배선 (QA 2차 #1) — 순수 함수 테스트는 배선을 못 지킨다 ──────
describe("오버뷰 순위 카드 y 축 — 화면의 도메인 배선", () => {
  const src = fs.readFileSync(path.join(REPO, TARGETS[0][1]), "utf8");
  // 순위 카드의 도메인 [1, max(5, ⌈관측최대⌉)] 은 card-trend 화면이 계산해 보낸다.
  it('YAxis 가 화면이 보낸 domain 을 탄다 — ["auto","auto"] 로 되돌리면 0.5위 변동이 플롯을 다 먹는다', () => {
    expect(src).toContain("<YAxis hide domain={domain} reversed={isRank} />");
    expect(src).not.toContain('["auto", "auto"]');
  });
});

// ── ④ KPI 탭 추이 3종 배선 (2026-09-11 전수 감사) ───────────────────────────
//
// 제품 책임자 스크린샷: 언급 화면 "AI 엔진별 노출" 추이의 8/24 자리가 그냥 끊긴 선이었다.
// 같은 미배선이 우호도 추이·유형별 콤보에도 있었다. 렌더 개수는
// `kpi/trend-gap-kpi-charts.render.test.tsx`(recharts 스텁)가 세고, 여기서는
// **어떤 API 로 배선했는지**를 고정한다 — 오버레이 API 를 우회한 자체 구현이
// 들어오면 렌더 수는 맞아도 다른 차트와 표시가 갈린다.
const KPI_DIR = "app/[locale]/(dash)/standard/answer-analysis/_components/kpi";
const KPI_TARGETS: Array<{
  label: string;
  rel: string;
  seriesKeys: string;
  chartTag: RegExp;
  tooltip: "gapAware" | "own";
}> = [
  {
    label: "AI 엔진별 노출/점유율(EngineKpiSection)",
    rel: `${KPI_DIR}/engine-kpi-section.tsx`,
    seriesKeys: "seriesKeys: series.engines",
    chartTag: /<LineChart\s+data=\{gapPlan\.rows\}/,
    tooltip: "gapAware",
  },
  {
    label: "우호도 추이(FavorabilityTrendChart)",
    rel: `${KPI_DIR}/favorability-trend-chart.tsx`,
    seriesKeys: "seriesKeys: FAVORABILITY_LINES.map((l) => l.dataKey)",
    chartTag: /<LineChart\s+data=\{gapPlan\.rows\}/,
    tooltip: "own",
  },
  {
    label: "유형별 콤보(TypeKpiTrend)",
    rel: `${KPI_DIR}/type-kpi-section.tsx`,
    seriesKeys: "seriesKeys: MENTION_TYPE_KEYS_UI",
    chartTag: /<ComposedChart\s+data=\{gapPlan\.rows\}/,
    tooltip: "gapAware",
  },
];

describe.each(KPI_TARGETS)("$label — 갭 오버레이 배선", (t) => {
  const src = fs.readFileSync(path.join(REPO, t.rel), "utf8");

  it("planTrendGaps 로 계획을 세운다 (그릴 수 있는 시리즈 전부)", () => {
    expect(src).toContain("planTrendGaps(");
    expect(src).toContain(t.seriesKeys);
  });

  it("차트가 **증강된 행**을 받는다 — 원본 배열을 넘기면 보조 라인이 빈다", () => {
    expect(src).toMatch(t.chartTag);
  });

  it("음영과 이웃 연결을 둘 다 그린다 — 공용 오버레이 API 로만", () => {
    expect(src).toContain("trendGapAreas(gapPlan.areas");
    expect(src).toContain("trendGapBridgeLines(gapPlan.bridges");
  });

  it("음영은 값 마크(<Line>/<Bar>)보다 **먼저** 선언된다", () => {
    const iMark = src.search(/<(Line|Bar)\b/);
    expect(iMark, "값 마크를 못 찾았다").toBeGreaterThan(0);
    expect(src.indexOf("trendGapAreas(")).toBeLessThan(iMark);
  });

  it("갭 슬롯에는 툴팁이 안 뜬다 — 문구를 되살리면 여기서 걸린다(2026-09-11 제품 책임자)", () => {
    expect(src).toContain("filterNull={false}");
    if (t.tooltip === "gapAware") {
      expect(src).toContain("content={<GapAwareTooltip />}");
    } else {
      expect(src).toMatch(/if \(trendGapHidesTooltip\(payload\)\) return null;/);
    }
    expect(src).not.toContain('useTranslations("trend.gap")');
    expect(src).not.toContain('tGap("collectionError")');
  });

  it("갭이 아닌 결측 슬롯의 표시는 종전 그대로 — null 가드가 있다", () => {
    // filterNull={false} 를 무해하게 만드는 장치. 없어지면 "측정 없는 회차"에
    // 빈 툴팁이 뜨기 시작한다(갭 없는 데이터에서 렌더가 달라진다).
    const guarded =
      t.tooltip === "gapAware"
        ? src.includes("GapAwareTooltip")
        : /p\.total == null\) return null/.test(src);
    expect(guarded, "null 슬롯 가드가 사라졌다").toBe(true);
  });

  it("보조선 색은 globals.css 토큰이다 — 컴포넌트에 hex 리터럴 금지", () => {
    const bridge =
      /trendGapBridgeLines\(gapPlan\.bridges,[\s\S]{0,400}?\n\s*\}\)\}/.exec(src)?.[0] ?? "";
    expect(bridge, "보조선 스타일 블록을 못 찾았다").not.toBe("");
    expect(bridge).not.toMatch(/#[0-9a-f]{3,6}/i);
    expect(/var\(--|seriesColor\(|l\.stroke/.test(bridge)).toBe(true);
  });
});

// 유형 콤보는 YAxis 에 id 가 있다 — 음영·보조선에 yAxisId 를 안 주면 recharts 가
// 축을 못 찾아 **아무것도 안 그린다**(오버레이 헤더의 recharts 제약).
describe("TypeKpiTrend — 축 id 배선", () => {
  const src = fs.readFileSync(path.join(REPO, `${KPI_DIR}/type-kpi-section.tsx`), "utf8");
  it("음영·보조선이 비율 축(pct)에 붙는다", () => {
    expect(src).toContain('trendGapAreas(gapPlan.areas, { yAxisId: "pct" })');
    expect(src).toMatch(/trendGapBridgeLines\(gapPlan\.bridges,[\s\S]{0,400}?yAxisId: "pct"/);
  });
});
