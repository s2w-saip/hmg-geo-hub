"use client";

// 추이 차트 공용 **결측 회차(수집 오류) 오버레이**.
//
// 계약·설계 근거는 lib/viz/trend-gap.ts 헤더 참고. 이 파일은 그 계산 결과를
// recharts 엘리먼트로 옮기는 얇은 층이다.
//
// recharts 제약(promptChangeMarkerLines 와 동일):
//   · ReferenceArea 등은 차트의 children 이어야 하므로 컴포넌트가 아니라
//     **엘리먼트 배열**을 반환한다.
//   · YAxis 에 id 가 있는 차트(LiveTrendChart 의 pct/rank)는 yAxisId 지정 필수.
//
// 보조선(bridge)은 2026-09-11 부터 recharts 시리즈가 아니라 **직접 그리는 `<path>`** 다.
// 좌표는 recharts 3.8 의 축 스케일 훅(`useXAxisScale`/`useYAxisScale`)에서 받는다 —
// 차트 children 으로 렌더되므로 스토어 컨텍스트 안이고, 레이아웃 전이면 훅이 undefined
// 를 주므로 그때는 아무것도 안 그린다(SSR 포함).
//
// ⚠️ 직접 그리는 요소는 **반드시 `TrendGapLayer` 로 감싼다**. SVG 에는 CSS z-index 가
// 없어서 recharts 3.4+ 는 zIndex 마다 별도 `<g>` 포털을 만들고 그래픽 아이템을 거기로
// 옮긴다(`ZIndexLayer`). 층 밖에 남은 raw path 는 차트 children 위치에 그대로 그려져
// **음영(`ReferenceArea` = `DefaultZIndexes.area`)보다 아래**로 내려간다 — 2026-09-11
// 프리뷰 실측에서 보조선 색이 rgb(0,44,95) → rgb(76,101,130) 으로 덧칠됐다(경쟁사
// 보조선은 strokeOpacity 0.55 라 한 번 더 흐려졌다).

import type { ReactElement, ReactNode } from "react";
import {
  ReferenceArea,
  DefaultTooltipContent,
  DefaultZIndexes,
  ZIndexLayer,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
} from "recharts";
import type {
  DefaultTooltipContentProps,
  ScaleFunction,
  TooltipContentProps,
} from "recharts";
import { rowTrendGap, type TrendGapArea, type TrendGapBridge } from "@/lib/viz/trend-gap";
import {
  trendBandCubics,
  trendBandPath,
  trendBridgePath,
  trendCubicPath,
  type TrendBandOptions,
  type TrendBridgeOptions,
  type TrendCurvePoint,
} from "@/lib/viz/trend-gap-curve";

/** 음영 톤 — 컴포넌트에 hex 리터럴 금지, app/globals.css 토큰만 참조한다. */
const GAP_FILL = "var(--color-ink-300)";
const GAP_FILL_OPACITY = 0.38;

/** 갭 슬롯 음영. 라인보다 **먼저** 선언해 뒤에 깔리게 한다. */
export function trendGapAreas(
  areas: readonly TrendGapArea[],
  opts: { yAxisId?: string } = {},
): ReactElement[] {
  return areas.map((a) => (
    <ReferenceArea
      key={a.key}
      {...(opts.yAxisId ? { yAxisId: opts.yAxisId } : {})}
      x1={a.x1}
      x2={a.x2}
      fill={GAP_FILL}
      fillOpacity={GAP_FILL_OPACITY}
      stroke="none"
      ifOverflow="extendDomain"
    />
  ));
}

/**
 * 갭 오버레이가 직접 그리는 요소를 recharts 의 **층(zIndex 포털) 안**에 얹는 래퍼.
 *
 * 기본값은 본선과 같은 층(`DefaultZIndexes.line` = 400)이다 — 종전 보조선이
 * `<Line>` 이었을 때와 같은 자리이고, 음영(`area` = 100)·격자(`grid` = -100) 위다.
 * 층 관계를 바꾸고 싶으면 `zIndex` 로 넘긴다(누적 밴드처럼 음영 위·본선 아래에
 * 깔아야 하는 것은 `DefaultZIndexes.area`~`line` 사이 값을 쓰면 된다).
 *
 * 차트 밖에서는 `ZIndexLayer` 가 포털 없이 children 을 그대로 낸다.
 */
export function TrendGapLayer({
  zIndex = DefaultZIndexes.line,
  children,
}: {
  zIndex?: number;
  children: ReactNode;
}) {
  return <ZIndexLayer zIndex={zIndex}>{children}</ZIndexLayer>;
}

export interface TrendGapBridgeStyle {
  stroke: string;
  strokeWidth?: number;
  strokeDasharray?: string;
  strokeOpacity?: number;
  yAxisId?: string;
}

/**
 * 갭 창의 보조선 path 를 만든다 — 축 스케일을 주입받는 **순수 함수**(테스트 seam).
 *
 * 데이터 좌표(주 라벨·값)를 recharts 가 본선을 그릴 때 쓰는 것과 **같은 식**으로
 * 픽셀로 옮긴다:
 *   · x = `scale(값, { position: "middle" })` — `getCateCoordinateOfLine` 의
 *     `tick.coordinate + bandSize/2` 와 같다(point 스케일이면 bandwidth 0 이라 무보정,
 *     band 스케일이면 반 칸, 숫자 축이면 스케일 값 그대로).
 *   · y = `scale(값)`.
 * 그래야 보조선 끝점이 본선 끝점과 **정확히** 맞물린다.
 *
 * 축 밖 값·미준비 스케일 등으로 옮길 수 없는 이웃은 바깥쪽부터 잘라낸다 —
 * 접선 정밀도만 떨어지고(3점→2점→시컨트) 이음매 자체는 유지된다.
 */
function bridgeToPx(
  bridge: TrendGapBridge,
  xScale: ScaleFunction,
  yScale: ScaleFunction,
): { left: TrendCurvePoint[]; right: TrendCurvePoint[] } {
  const toPx = (a: { x: string | number; y: number }): TrendCurvePoint | null => {
    const x = xScale(a.x, { position: "middle" });
    const y = yScale(a.y);
    return typeof x === "number" &&
      Number.isFinite(x) &&
      typeof y === "number" &&
      Number.isFinite(y)
      ? { x, y }
      : null;
  };
  // 왼쪽 꼬리는 **안쪽(prev)부터** 세어 나가다 처음 실패하는 곳에서 끊는다.
  const left: TrendCurvePoint[] = [];
  for (let i = bridge.left.length - 1; i >= 0; i -= 1) {
    const p = toPx(bridge.left[i]);
    if (!p) break;
    left.unshift(p);
  }
  const right: TrendCurvePoint[] = [];
  for (const a of bridge.right) {
    const p = toPx(a);
    if (!p) break;
    right.push(p);
  }
  return { left, right };
}

export function trendGapBridgePath(
  bridge: TrendGapBridge,
  xScale: ScaleFunction,
  yScale: ScaleFunction,
  opts: TrendBridgeOptions = {},
): string | null {
  const { left, right } = bridgeToPx(bridge, xScale, yScale);
  return trendBridgePath(left, right, opts);
}

/** 보조선 하나. 축 스케일이 아직 없으면(차트 밖·레이아웃 전) 아무것도 안 그린다. */
export function TrendGapBridgeCurve({
  bridge,
  style,
}: {
  bridge: TrendGapBridge;
  style: TrendGapBridgeStyle;
}) {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale(style.yAxisId);
  // 오버슛 허용치의 기준(`lib/viz/trend-gap-curve.ts` `TrendBridgeOptions.plotSpan`).
  // 축 스케일과 같은 레이아웃 상태에서 나오므로 스케일이 있으면 대개 같이 있다.
  const plotArea = usePlotArea();
  if (!xScale || !yScale) return null;
  const d = trendGapBridgePath(bridge, xScale, yScale, { plotSpan: plotArea?.height });
  if (!d) return null;
  return (
    <TrendGapLayer>
      <path
        className="recharts-trend-gap-bridge"
        d={d}
        fill="none"
        stroke={style.stroke}
        strokeWidth={style.strokeWidth ?? 2}
        strokeDasharray={style.strokeDasharray}
        strokeOpacity={style.strokeOpacity}
        pointerEvents="none"
      />
    </TrendGapLayer>
  );
}

/**
 * 이웃 연결용 보조선. 갭 슬롯에는 값이 없으므로 점도 툴팁 항목도 생기지 않는다 —
 * 이제는 아예 **데이터가 아니라 그림**이다(합성 시리즈가 없으니 범례·툴팁·도메인
 * 어디에도 안 걸린다).
 *
 * 곡선은 본선의 끝 접선을 그대로 이어받는다(`lib/viz/trend-gap-curve.ts` 헤더 —
 * 2026-09-11 운영 "부드럽게 연결"). 종전에는 갭 양옆 2점짜리 `<Line type="linear">`
 * 였고, 점이 둘이면 어떤 curve type 을 줘도 d3 가 직선을 그렸다.
 *
 * `styleOf` 가 null 을 돌려주면 그 시리즈는 지금 숨겨진 것이므로 보조선도 안 그린다.
 */
export function trendGapBridgeLines(
  bridges: readonly TrendGapBridge[],
  styleOf: (seriesKey: string) => TrendGapBridgeStyle | null,
): ReactElement[] {
  const out: ReactElement[] = [];
  for (const b of bridges) {
    const s = styleOf(b.seriesKey);
    if (!s) continue;
    out.push(<TrendGapBridgeCurve key={b.dataKey} bridge={b} style={s} />);
  }
  return out;
}

// ── 누적(스택) 영역 차트용 — 이웃 연결이 선이 아니라 **띠**다 ─────────────────

export interface TrendGapBandStyle {
  /** 본 영역과 같은 카테고리 색. */
  fill: string;
  /** 본 영역과 같은 채움 투명도. */
  fillOpacity?: number;
  /** 카테고리 상단 경계선(본 영역의 `stroke`). 없으면 경계선을 안 그린다. */
  stroke?: string;
  strokeWidth?: number;
  yAxisId?: string;
}

/** 밴드가 넘어서면 안 되는 **데이터** 범위. 픽셀 변환은 컴포넌트가 y 축 스케일로 한다. */
export interface TrendGapBandBounds {
  /** 스택 바닥. 누적 값은 음수가 없으므로 사실상 항상 0 이다. */
  min?: number;
  /** 정규화(100% 누적) 축의 상한 = 1. absolute 모드에는 상한이 없다 — 생략한다. */
  max?: number;
}

/**
 * 갭 런 하나의 누적 밴드 전부. 경계는 **아래에서 위로** 정렬된 `boundaries`
 * (`boundaries[i]` ~ `boundaries[i + 1]` 이 카테고리 `i` 의 띠)이고,
 * 스타일은 카테고리 순서와 같은 길이의 배열이다.
 *
 * 경계 곡선은 한 번에 계산한다(`trendBandCubics`) — 경계마다 따로 계산하면 갭 창
 * 안에서 서로를 넘어 띠가 뒤집힐 수 있기 때문(그 헤더 참고).
 * 그래서 밴드 채움과 경계선이 **같은 곡선**을 쓴다.
 */
export function TrendGapStackBand({
  boundaries,
  styles,
  valueBounds,
}: {
  boundaries: readonly TrendGapBridge[];
  styles: ReadonlyArray<TrendGapBandStyle | null>;
  valueBounds?: TrendGapBandBounds;
}) {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale(styles.find((s) => s)?.yAxisId);
  // 오버슛 허용치의 기준 — 보조선과 같은 값을 쓴다(`TrendBridgeOptions.plotSpan`).
  const plotArea = usePlotArea();
  if (!xScale || !yScale) return null;
  if (boundaries.length !== styles.length + 1) return null;
  const toY = (v: number | undefined): number | undefined => {
    if (v === undefined) return undefined;
    const y = yScale(v);
    return typeof y === "number" && Number.isFinite(y) ? y : undefined;
  };
  const opts: TrendBandOptions = {
    plotSpan: plotArea?.height,
    // SVG y 는 아래로 커진다 — 데이터 상한이 픽셀 **상한선**(작은 y)이다.
    //
    // 축 값 경계가 없으면(absolute 모드는 데이터 상한이 없다) **플롯 영역**으로
    // 물러선다. 경계를 통째로 비우면 `withinAxis` 가 그쪽 검사를 건너뛰어, 남는
    // 상한이 축이 아니라 **양 끝점 ±(플롯 높이 5%)** 인 오버슛 리미터뿐이다 —
    // 이웃 주가 축 꼭대기 근처면 밴드가 플롯 밖으로 솟고 SVG 상단에서 잘린다
    // (2026-09-11 프리뷰 실측: 단일 카테고리 13개 중 6개 이탈, 최대 12.275px).
    // 밴드는 어떤 모드에서도 플롯 밖을 주장할 수 없으므로 이 폴백은 안전하다.
    yTop: toY(valueBounds?.max) ?? plotArea?.y,
    yBottom:
      toY(valueBounds?.min) ?? (plotArea ? plotArea.y + plotArea.height : undefined),
  };
  const cubics = trendBandCubics(
    boundaries.map((b) => bridgeToPx(b, xScale, yScale)),
    opts,
  );
  if (!cubics) return null;
  const out: ReactElement[] = [];
  styles.forEach((style, i) => {
    if (!style) return;
    const lower = cubics[i];
    const upper = cubics[i + 1];
    out.push(
      <path
        key={`band-${boundaries[i + 1].dataKey}`}
        className="recharts-trend-gap-band"
        d={trendBandPath(upper, lower)}
        fill={style.fill}
        fillOpacity={style.fillOpacity ?? 1}
        stroke="none"
        pointerEvents="none"
      />,
    );
    // 본 영역은 **상단 경계에만** stroke 를 그린다(recharts `recharts-area-curve`).
    // 밴드를 통째로 stroke 하면 바닥·양옆 닫는 변까지 그어지므로 따로 얹는다.
    if (style.stroke) {
      out.push(
        <path
          key={`band-curve-${boundaries[i + 1].dataKey}`}
          className="recharts-trend-gap-band-curve"
          d={trendCubicPath(upper)}
          fill="none"
          stroke={style.stroke}
          strokeWidth={style.strokeWidth ?? 1}
          pointerEvents="none"
        />,
      );
    }
  });
  // 본 영역(`Area`)·갭 음영(`ReferenceArea`)과 **같은 층**(`DefaultZIndexes.area`)에 얹는다.
  // 왜 층이 필요한가: SVG 에는 CSS z-index 가 없어 recharts 3.4+ 는 zIndex 마다 별도 `<g>`
  // 포털을 만들고 그래픽 아이템을 거기로 옮긴다 — 층 밖에 남은 raw path 는 차트 children
  // 자리에 그대로 그려져 **포털 전체보다 아래**로 내려간다(2026-09-11 프리뷰 실측: 밴드
  // domIdx 26 < 음영 54 < 본 영역 57 → 갭 창 색이 ink-300 @0.38 로 바랬다).
  // 왜 `line`(400)이 아니라 `area`(100)인가: 밴드는 **영역의 연장**이라 본 영역과 같은
  // 높이여야 하고, 보조선·본선(line)·점(scatter)을 덮으면 안 되기 때문이다. 같은 층
  // 안에서는 삽입 순서가 위아래를 정하므로 밴드는 `<Area>` **뒤에** 선언한다.
  return <TrendGapLayer zIndex={DefaultZIndexes.area}>{out}</TrendGapLayer>;
}

/**
 * 계획의 경계 보조선들을 **갭 런별로 묶어** 누적 밴드를 그린다.
 *
 * `bridges` 는 `planTrendGaps(누적 경계 행)` 의 결과이고, `boundaryKeys` 는
 * `trendStackBoundaryRows` 가 준 아래→위 경계 키다. 한 런에서 경계가 하나라도
 * 빠지면(이웃 결측) 그 런은 통째로 안 그린다 — 띠는 양쪽 경계가 다 있어야 성립한다.
 */
export function trendGapStackBands(
  bridges: readonly TrendGapBridge[],
  boundaryKeys: readonly string[],
  styleOf: (seriesIndex: number) => TrendGapBandStyle | null,
  valueBounds?: TrendGapBandBounds,
): ReactElement[] {
  if (boundaryKeys.length < 2) return [];
  const byRun = new Map<number, Map<string, TrendGapBridge>>();
  for (const b of bridges) {
    let m = byRun.get(b.runIndex);
    if (!m) byRun.set(b.runIndex, (m = new Map()));
    m.set(b.seriesKey, b);
  }
  const styles = boundaryKeys.slice(1).map((_, i) => styleOf(i));
  const out: ReactElement[] = [];
  for (const [runIndex, m] of [...byRun.entries()].sort((a, b) => a[0] - b[0])) {
    const boundaries = boundaryKeys.map((k) => m.get(k));
    if (boundaries.some((b) => !b)) continue;
    out.push(
      <TrendGapStackBand
        key={`trend-gap-band-${runIndex}`}
        boundaries={boundaries as TrendGapBridge[]}
        styles={styles}
        valueBounds={valueBounds}
      />,
    );
  }
  return out;
}

type AnyTooltipProps = Partial<TooltipContentProps>;

/**
 * 갭 슬롯인가 — **툴팁을 통째로 숨겨야 하는 행**인지 한 자리에서 판정한다.
 *
 * 2026-09-11 운영 "다른 차트에도 갭 툴팁 지워줘"(선행 지시: "이거, 오류로 인해
 * 수집되지 않음 호버 지워줘") 이후 갭 슬롯의 툴팁은 **문구가 아니라 없음**이다.
 * 자기 툴팁 본문을 가진 차트는 본문 맨 앞에서 이걸 보고 `null` 을 돌려준다 —
 * 그냥 두면 본문이 값 없는 행을 받아 브랜드마다 "—" 가 찍힌 **빈 박스**를 그린다
 * (`brand-trend-chart`·`rank-trend-chart` 의 가드는 `if (!p)` 뿐이라 갭 행을 통과시킨다).
 *
 * 음영(`ReferenceArea`)·보조선·누적 밴드는 툴팁과 무관하게 그대로다.
 */
export function trendGapHidesTooltip(
  payload: ReadonlyArray<{ payload?: unknown }> | undefined,
): boolean {
  return rowTrendGap(payload?.[0]?.payload) != null;
}

/**
 * recharts 기본 툴팁을 쓰던 차트용 래퍼 — 갭 슬롯이면 **아무것도 안 내고**,
 * 아니면 기본 내용을 그대로 낸다.
 *
 * content 가 null 을 돌려주면 recharts 는 툴팁 래퍼 `<div>` 만 내는데, 그 div 는
 * 위치·`wrapperStyle` 뿐이고 배경·테두리는 `contentStyle` 을 받는 본문
 * (`DefaultTooltipContent`)에만 있다 — 즉 빈 박스도 안 보인다(recharts 3.8.1
 * `es6/component/TooltipBoundingBox.js` 의 `outerStyle`, `Tooltip.js` 의 `renderContent`).
 *
 * ⚠️ 이 래퍼를 쓰는 차트는 `<Tooltip filterNull={false}>` 이어야 한다.
 * recharts 는 기본값(`filterNull=true`)에서 값이 null 인 payload 항목을 **content 에
 * 넘기기 전에** 걷어내므로(Tooltip.js), 전 시리즈가 null 인 갭 슬롯은 payload 가 비어
 * 갭 마커까지 같이 사라진다. 대신 null 걷어내기를 여기서 그대로 재현한다 —
 * 갭이 아닌 슬롯의 표시는 종전과 동일하다.
 */
export function GapAwareTooltip(props: AnyTooltipProps) {
  const payload = props.payload ?? [];
  if (trendGapHidesTooltip(payload)) return null;
  const shown = payload.filter(
    (e) => e.value != null && e.hide !== true && e.type !== "none",
  );
  if (shown.length === 0) return null;
  return (
    <DefaultTooltipContent
      {...(props as DefaultTooltipContentProps)}
      payload={shown}
    />
  );
}
