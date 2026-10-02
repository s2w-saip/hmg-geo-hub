/**
 * KPI 탭 추이 차트 3종의 **갭 오버레이 렌더 가드** (2026-09-11 전수 감사).
 *
 * 지문(제품 책임자 스크린샷): 언급 화면 "AI 엔진별 노출" 추이가 8/24 자리에서 그냥
 * 끊겨 보였다 — 음영도, 갭 툴팁도, 이웃 연결도 없었다. 같은 미배선이
 * 우호도 추이·유형별 콤보에도 있었다.
 *
 * ⚠️ recharts 는 `renderToStaticMarkup` 에서 SVG 를 내지 않는다(폭을 브라우저에서만
 * 잰다). 그래서 **recharts 를 스텁으로 갈아끼워** 차트가 실제로 어떤 자식 엘리먼트를
 * 선언했는지 마크업으로 센다. 소스 대조(trend-gap-wiring.test.ts)와 달리 이 가드는
 * "그리는 순서·개수"가 틀리면 잡는다 — 예: 갭이 없는데 음영이 생기거나, 보조선이
 * 숨긴 시리즈까지 그려지는 것.
 *
 * 2026-09-11 개정: 보조선이 recharts `<Line>` 합성 시리즈에서 **직접 그리는 곡선
 * `<path>`**(`TrendGapBridgeCurve` — 축 스케일 훅 + `ZIndexLayer`)로 바뀌었다.
 * 그래서 세는 대상이 `dataKey="__gapBridge:…"` 가 아니라 `.recharts-trend-gap-bridge`
 * path 다. 스텁은 `components/dash/trend-gap-bridge.render.test.tsx` 와 같은 것을
 * 공유한다(`test/recharts-stub.tsx`) — 축 스케일이 있어야 path 가 실제로 렌더된다.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { type ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import type { TrendGap } from "@/lib/viz/trend-gap";
import {
  bridgeLayers,
  bridgePaths,
  type RechartsStubState,
} from "@/test/recharts-stub";

/** 스텁이 읽는 가변 상태 — x 축 카테고리는 세 차트 모두 `bucketStart` 원값이다. */
const axis = vi.hoisted(
  () => ({ xs: [] as Array<string | number> }) as RechartsStubState,
);

// ── recharts 스텁 ──────────────────────────────────────────────────────────
// 각 엘리먼트를 `data-rc` 가 붙은 `<g>` 로 낸다. props 중 판정에 쓰는 것만 흘린다.
vi.mock("recharts", async () => {
  const { makeRechartsStub } = await import("@/test/recharts-stub");
  return makeRechartsStub({
    actual: await vi.importActual<Record<string, unknown>>("recharts"),
    state: axis,
    keep: {
      dataKey: "data-key",
      x1: "data-x1",
      x2: "data-x2",
      legendType: "data-legend",
      yAxisId: "data-yaxis",
      stroke: "data-stroke",
    },
  });
});

const { DefaultZIndexes } = await import("recharts");
const { EngineKpiSection } = await import("./engine-kpi-section");
const { FavorabilityTrendChart } = await import("./favorability-trend-chart");
const { TypeKpiTrend } = await import("./type-kpi-section");

const GAP: TrendGap = { reason: "collection_error" };

/** 세 차트 공통 버킷 — 가운데(8/24)가 갭이다. */
const BUCKETS = ["2026-08-17", "2026-08-24", "2026-08-31"];

function wrap(node: ReactNode): string {
  axis.xs = BUCKETS;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>,
  );
}

const count = (html: string, needle: string) => html.split(needle).length - 1;
const areas = (html: string) => count(html, 'data-rc="ReferenceArea"');
/** 보조선 = 직접 그린 곡선 path 의 개수(종전에는 합성 `<Line>` 시리즈였다). */
const bridges = (html: string) => bridgePaths(html).length;

/**
 * 보조선이 **그림이지 데이터가 아님**을 고정한다 — 합성 시리즈로 되돌아가면
 * 범례·툴팁·점이 같이 살아나므로, 그 흔적이 하나도 없어야 한다.
 */
function expectBridgesAreNotSeries(html: string, expected: number) {
  const drawn = bridgePaths(html);
  expect(drawn).toHaveLength(expected);
  // 합성 시리즈였다면 범례·툴팁에 실렸을 dataKey 가 마크업 어디에도 없다.
  expect(html).not.toContain("__gapBridge");
  for (const b of drawn) {
    // 면도 점도 만들지 않고(fill none), 호버·툴팁 대상도 아니다.
    expect(b.fill).toBe("none");
    expect(b["pointer-events"]).toBe("none");
  }
  // 본선과 같은 recharts 층 안에 있다 = 갭 음영 위에 그려진다.
  expect(bridgeLayers(html)).toEqual(
    Array.from({ length: expected }, () => String(DefaultZIndexes.line)),
  );
}

// ── ① AI 엔진별 노출/점유율 (스크린샷 대상) ────────────────────────────────

describe("EngineKpiSection — AI 엔진별 노출 추이", () => {
  const bars = [{ engine: "chatgpt", pct: 60, numerator: 60, denominator: 100 }];
  const clean = [
    { bucketStart: "2026-08-17", chatgpt: 60, gemini: 40 },
    { bucketStart: "2026-08-31", chatgpt: 62, gemini: 41 },
  ];
  const gapped = [
    clean[0],
    { bucketStart: "2026-08-24", chatgpt: null, gemini: null, gap: GAP },
    clean[1],
  ];
  const engines = ["chatgpt", "gemini"];
  const coverage = [
    { bucketStart: "2026-08-17", measuredDays: 7 },
    { bucketStart: "2026-08-31", measuredDays: 7 },
  ];

  it("갭이 있으면 음영 1 + 엔진마다 보조선 1", () => {
    const html = wrap(
      <EngineKpiSection
        metric="exposure"
        bars={bars}
        series={{ engines, points: gapped }}
        coverage={coverage}
      />,
    );
    expect(areas(html)).toBe(1);
    expect(bridges(html)).toBe(engines.length);
    expect(html).toContain('data-x1="2026-08-17"');
    expect(html).toContain('data-x2="2026-08-31"');
  });

  it("보조선은 범례에 안 나오고 점도 없다 (그림이지 데이터가 아니다)", () => {
    const html = wrap(
      <EngineKpiSection
        metric="exposure"
        bars={bars}
        series={{ engines, points: gapped }}
        coverage={coverage}
      />,
    );
    expectBridgesAreNotSeries(html, engines.length);
  });

  it("갭이 없으면 음영·보조선 0 (종전 렌더와 동일)", () => {
    const html = wrap(
      <EngineKpiSection
        metric="exposure"
        bars={bars}
        series={{ engines, points: clean }}
        coverage={coverage}
      />,
    );
    expect(areas(html)).toBe(0);
    expect(bridges(html)).toBe(0);
    expect(html).not.toContain("recharts-trend-gap-bridge");
  });

  it("i18n 키가 새지 않는다", () => {
    const html = wrap(
      <EngineKpiSection
        metric="sov"
        bars={bars}
        series={{ engines, points: gapped }}
        coverage={coverage}
      />,
    );
    expect(html).not.toContain("trend.gap");
  });
});

// ── ② 우호도 추이 ─────────────────────────────────────────────────────────

describe("FavorabilityTrendChart — 우호도 추이", () => {
  const pt = (bucketStart: string, on: boolean) => ({
    bucketStart,
    positivePct: on ? 62 : null,
    negativePct: on ? 8 : null,
    positive: on ? 31 : null,
    negative: on ? 4 : null,
    total: on ? 50 : null,
    positiveWow: null,
    totalWow: null,
    measuredDays: on ? 7 : 0,
    firstAt: null,
    lastAt: null,
  });
  const clean = [pt("2026-08-17", true), pt("2026-08-31", true)];
  const gapped = [clean[0], { ...pt("2026-08-24", false), gap: GAP }, clean[1]];

  it("갭이 있으면 음영 1 + 긍정·부정 보조선 2", () => {
    const html = wrap(<FavorabilityTrendChart points={gapped} />);
    expect(areas(html)).toBe(1);
    expect(bridges(html)).toBe(2);
    expectBridgesAreNotSeries(html, 2);
  });

  it("갭이 없으면 0/0", () => {
    const html = wrap(<FavorabilityTrendChart points={clean} />);
    expect(areas(html)).toBe(0);
    expect(bridges(html)).toBe(0);
  });
});

// ── ③ 유형별 콤보 ─────────────────────────────────────────────────────────

describe("TypeKpiTrend — 유형별 노출률 콤보", () => {
  const byType = (on: boolean) => ({
    mention: on ? 30 : null,
    recommendation: on ? 12 : null,
    comparison: on ? 8 : null,
    definition: on ? 5 : null,
    final_choice: on ? 3 : null,
  });
  const pt = (bucketStart: string, on: boolean) => ({
    bucketStart,
    answers: on ? 100 : null,
    exposurePct: on ? 60 : null,
    sovPct: on ? 40 : null,
    byType: byType(on),
    favorabilityPct: on ? 62 : null,
    avgPosition: on ? 2 : null,
  });
  const clean = [pt("2026-08-17", true), pt("2026-08-31", true)];
  const gapped = [clean[0], { ...pt("2026-08-24", false), gap: GAP }, clean[1]];
  const coverage = [{ bucketStart: "2026-08-17", measuredDays: 7 }];

  it("갭이 있으면 음영 1 + 유형 5종 보조선 5", () => {
    const html = wrap(<TypeKpiTrend combo={gapped} coverage={coverage} />);
    expect(areas(html)).toBe(1);
    expect(bridges(html)).toBe(5);
    expectBridgesAreNotSeries(html, 5);
  });

  it("음영은 비율 축(pct)에 붙는다 — 축 id 를 빠뜨리면 recharts 가 못 그린다", () => {
    const html = wrap(<TypeKpiTrend combo={gapped} coverage={coverage} />);
    expect(html).toMatch(/<g data-rc="ReferenceArea"[^>]*data-yaxis="pct"/);
  });

  it("갭이 없으면 0/0", () => {
    const html = wrap(<TypeKpiTrend combo={clean} coverage={coverage} />);
    expect(areas(html)).toBe(0);
    expect(bridges(html)).toBe(0);
  });
});
