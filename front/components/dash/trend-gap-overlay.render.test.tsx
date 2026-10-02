import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReferenceArea } from "recharts";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import {
  GapAwareTooltip,
  TrendGapBridgeCurve,
  trendGapAreas,
  trendGapBridgeLines,
  trendGapBridgePath,
  trendGapHidesTooltip,
} from "./trend-gap-overlay";
import { planTrendGaps, type TrendGap, type TrendGapRow } from "@/lib/viz/trend-gap";

// ⚠️ recharts 는 `renderToStaticMarkup` 에서 SVG 를 내지 않는다(ResponsiveContainer 가
// 폭을 브라우저에서만 잰다 — brand-trend-chart.render.test.tsx 헤더 참고). 그래서
// 음영·보조 라인은 **엘리먼트의 props** 로 고정하고, 툴팁만 실제 마크업으로 본다.

const GAP: TrendGap = { reason: "collection_error" };
const ROWS: TrendGapRow[] = [
  { week: "2026-08-17", "hyundai.com": 44 },
  { week: "2026-08-24", "hyundai.com": null, gap: GAP },
  { week: "2026-08-31", "hyundai.com": 46 },
];

// 접선이 살아 있는(=곡률이 있는) 5주 픽스처. 가운데 8/24 가 갭.
const CURVE_ROWS: TrendGapRow[] = [
  { week: "w1", a: 10 },
  { week: "w2", a: 30 },
  { week: "w3", a: 34 },
  { week: "w4", a: null, gap: GAP },
  { week: "w5", a: 70 },
  { week: "w6", a: 76 },
];

/** 축 스케일 스텁 — 주 간격 40px, 값 1당 2px(위로 갈수록 y 작아짐). */
const X_STUB = (v: unknown) => {
  const i = ["w1", "w2", "w3", "w4", "w5", "w6"].indexOf(String(v));
  return i < 0 ? undefined : 40 * i;
};
const Y_STUB = (v: unknown) => (typeof v === "number" ? 200 - 2 * v : undefined);

describe("trendGapAreas", () => {
  const plan = planTrendGaps(ROWS, { xKey: "week", seriesKeys: ["hyundai.com"] });

  it("emits one ReferenceArea per gap run, spanning the neighbouring slots", () => {
    const els = trendGapAreas(plan.areas);
    expect(els).toHaveLength(1);
    expect(els[0].type).toBe(ReferenceArea);
    const p = els[0].props as Record<string, unknown>;
    expect(p.x1).toBe("2026-08-17");
    expect(p.x2).toBe("2026-08-31");
    expect(p.stroke).toBe("none");
  });

  it("paints from a globals.css token — no hex literal in the component", () => {
    const p = trendGapAreas(plan.areas)[0].props as Record<string, unknown>;
    expect(String(p.fill).startsWith("var(--")).toBe(true);
    expect(String(p.fill)).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it("carries yAxisId only when the chart has named axes", () => {
    expect((trendGapAreas(plan.areas)[0].props as Record<string, unknown>).yAxisId).toBeUndefined();
    const withAxis = trendGapAreas(plan.areas, { yAxisId: "pct" })[0].props as Record<string, unknown>;
    expect(withAxis.yAxisId).toBe("pct");
  });

  it("draws nothing when the data has no gap", () => {
    const clean = planTrendGaps(ROWS.slice(0, 1), { xKey: "week", seriesKeys: ["hyundai.com"] });
    expect(trendGapAreas(clean.areas)).toEqual([]);
    expect(trendGapBridgeLines(clean.bridges, () => ({ stroke: "var(--color-brand-700)" }))).toEqual([]);
  });
});

describe("trendGapBridgeLines", () => {
  const plan = planTrendGaps(ROWS, { xKey: "week", seriesKeys: ["hyundai.com"] });

  it("joins the neighbours with a curve element, not a synthetic series", () => {
    const els = trendGapBridgeLines(plan.bridges, () => ({
      stroke: "var(--color-own-hyundai)",
      strokeWidth: 2,
    }));
    expect(els).toHaveLength(1);
    // 2026-09-11 — 종전에는 `<Line type="linear">` 2점짜리 합성 시리즈였고, 점이 둘이면
    // d3 가 `lineTo` 로 그려 **무조건 직선**이었다(제품 책임자: "부드럽게 연결").
    expect(els[0].type).toBe(TrendGapBridgeCurve);
    const p = els[0].props as Record<string, unknown>;
    expect(p.bridge).toBe(plan.bridges[0]);
    expect((p.style as Record<string, unknown>).stroke).toBe("var(--color-own-hyundai)");
    expect(els[0].key).toBe(plan.bridges[0].dataKey);
  });

  it("skips series the chart is currently hiding", () => {
    expect(trendGapBridgeLines(plan.bridges, () => null)).toEqual([]);
  });
});

describe("trendGapBridgePath — 본선과 이어지는 곡선", () => {
  const plan = planTrendGaps(CURVE_ROWS, { xKey: "week", seriesKeys: ["a"] });
  const d = trendGapBridgePath(plan.bridges[0], X_STUB, Y_STUB)!;

  it("3차 베지어를 낸다 — 직선(L)이 아니다", () => {
    expect(d).toMatch(/^M[-\d.,]+C/);
    expect(d).not.toContain("L");
  });

  it("양 끝점이 이웃 실측 좌표와 정확히 맞물린다", () => {
    // w3 = 인덱스 2 → x 80, 값 34 → y 132. w5 = 인덱스 4 → x 160, 값 70 → y 60.
    expect(d.startsWith("M80,132")).toBe(true);
    expect(d.endsWith(",160,60")).toBe(true);
  });

  it("제어점이 끝점 직선 위에 있지 않다(= 곡률이 있다)", () => {
    const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const [x0, y0, c1x, c1y, c2x, c2y, x1, y1] = n;
    const on = (x: number) => y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
    expect(Math.abs(c1y - on(c1x))).toBeGreaterThan(1);
    expect(Math.abs(c2y - on(c2x))).toBeGreaterThan(1);
  });

  it("스케일이 값을 못 옮기면 그리지 않는다 — 반쪽 path 를 내지 않는다", () => {
    expect(trendGapBridgePath(plan.bridges[0], () => undefined, Y_STUB)).toBeNull();
    expect(trendGapBridgePath(plan.bridges[0], X_STUB, () => undefined)).toBeNull();
  });

  it("갭이 둘이면 보조선도 둘이고, 서로 다른 창을 잇는다", () => {
    const rows: TrendGapRow[] = [
      { week: "w1", a: 10 },
      { week: "w2", a: null, gap: GAP },
      { week: "w3", a: 34 },
      { week: "w4", a: null, gap: GAP },
      { week: "w5", a: 70 },
    ];
    const two = planTrendGaps(rows, { xKey: "week", seriesKeys: ["a"] });
    expect(two.bridges).toHaveLength(2);
    const paths = two.bridges.map((b) => trendGapBridgePath(b, X_STUB, Y_STUB));
    expect(paths[0]!.startsWith("M0,180")).toBe(true); // w1
    expect(paths[0]!.endsWith(",80,132")).toBe(true); // w3
    expect(paths[1]!.startsWith("M80,132")).toBe(true); // w3
    expect(paths[1]!.endsWith(",160,60")).toBe(true); // w5
  });

  it("갭 밖의 진짜 결측은 잇지 않는다 — 보조선이 그 자리를 넘어가지 않는다", () => {
    const rows: TrendGapRow[] = [
      { week: "w1", a: 10 },
      { week: "w2", a: null }, // 갭 아님(측정 없음) — 본선은 여기서 끊긴 채로 둔다
      { week: "w3", a: 34 },
      { week: "w4", a: null, gap: GAP },
      { week: "w5", a: 70 },
    ];
    const one = planTrendGaps(rows, { xKey: "week", seriesKeys: ["a"] });
    expect(one.bridges).toHaveLength(1);
    const path = trendGapBridgePath(one.bridges[0], X_STUB, Y_STUB)!;
    // w3(x 80) 에서 시작한다 — w2 자리(x 40)를 건드리지 않는다.
    expect(path.startsWith("M80,132")).toBe(true);
    expect(one.bridges[0].left).toEqual([{ x: "w3", y: 34 }]);
  });

  it("축 끝의 갭은 종전대로 보조선이 없다", () => {
    const rows: TrendGapRow[] = [
      { week: "w1", a: null, gap: GAP },
      { week: "w2", a: 30 },
      { week: "w3", a: 34 },
    ];
    expect(planTrendGaps(rows, { xKey: "week", seriesKeys: ["a"] }).bridges).toEqual([]);
  });

  it("경쟁사 스타일(점선·투명도)이 보조선 요소에 그대로 실린다", () => {
    const html = renderToStaticMarkup(
      <svg>
        <TrendGapBridgeCurve
          bridge={plan.bridges[0]}
          style={{ stroke: "var(--color-ink-500)", strokeWidth: 1.5, strokeDasharray: "4 3", strokeOpacity: 0.55 }}
        />
      </svg>,
    );
    // 차트 밖이라 스케일이 없다 → 아무것도 안 그린다(던지지 않는 것이 요구사항).
    expect(html).toBe("<svg></svg>");
  });
});

describe("GapAwareTooltip", () => {
  const entry = (value: number | null, extra: Record<string, unknown> = {}) =>
    ({ value, name: "hyundai.com", dataKey: "hyundai.com", payload: {}, graphicalItemId: "g", ...extra }) as never;

  // 2026-09-11 제품 책임자 "이거, 오류로 인해 수집되지 않음 호버 지워줘" → 같은 날
  // "다른 차트에도 갭 툴팁 지워줘". 갭 슬롯의 계약은 **문구가 아니라 없음**이다.
  it("renders nothing at all on a gap slot — not even an empty box", () => {
    const html = renderToStaticMarkup(
      <GapAwareTooltip payload={[entry(null, { payload: { week: "2026-08-24", gap: GAP } })]} />,
    );
    expect(html).toBe("");
  });

  // 갭 슬롯에 값이 남아 있어도(계약 위반 데이터) 마커가 이긴다 — 숫자가 새지 않는다.
  it("a gap marker wins over a surviving value", () => {
    const html = renderToStaticMarkup(
      <GapAwareTooltip payload={[entry(44, { payload: { week: "2026-08-24", gap: GAP } })]} />,
    );
    expect(html).toBe("");
  });

  it("갭 문구 키는 사전에서 사라졌다 — 되살리면 죽은 문자열이 다시 생긴다", () => {
    expect("trend" in ko).toBe(false);
    expect("trend" in en).toBe(false);
  });

  it("falls through to the default content on a measured week", () => {
    const html = renderToStaticMarkup(
      <GapAwareTooltip payload={[entry(44, { payload: { week: "2026-08-17" } })]} />,
    );
    expect(html).toContain("hyundai.com");
    expect(html).toContain("44");
  });

  it("reproduces recharts' filterNull so a normal week looks unchanged", () => {
    // filterNull={false} 로 받은 payload 에서 null·숨김·tooltipType=none 을 걷어낸다.
    const html = renderToStaticMarkup(
      <GapAwareTooltip
        payload={[
          entry(44, { payload: { week: "2026-08-17" } }),
          entry(null, { name: "kia.com", dataKey: "kia.com" }),
          entry(1, { name: "bridge", dataKey: "__gapBridge:0:x", type: "none" }),
        ]}
      />,
    );
    expect(html).toContain("hyundai.com");
    expect(html).not.toContain("kia.com");
    expect(html).not.toContain("bridge");
  });

  it("renders nothing when every series is empty and there is no gap marker", () => {
    const html = renderToStaticMarkup(<GapAwareTooltip payload={[entry(null)]} />);
    expect(html).toBe("");
  });
});

describe("trendGapHidesTooltip", () => {
  it("자기 툴팁 본문을 가진 차트가 갭 행을 알아본다", () => {
    expect(trendGapHidesTooltip([{ payload: { gap: GAP } }])).toBe(true);
  });

  it("측정된 슬롯·빈 payload 에는 관여하지 않는다", () => {
    expect(trendGapHidesTooltip([{ payload: { week: "2026-08-17" } }])).toBe(false);
    expect(trendGapHidesTooltip(undefined)).toBe(false);
    expect(trendGapHidesTooltip([])).toBe(false);
  });
});
