/**
 * 추이 차트의 **결측 회차(수집 오류) 표시 규약** — 순수 계산부.
 *
 * 배경(2026-09-10 운영): 글로벌 8/25 앵커 회차가 정원의 1/4 만 수집된 채로 집계에
 * 들어가, 인용 화면 "주별 상위 10개 도메인 인용 수" 에서 8/24 주가 **골짜기**로 찍혔다.
 * 값이 낮은 게 아니라 그 주의 수집이 깨진 것인데, 차트는 둘을 구분해 주지 못한다.
 *
 * 규약(데이터 쪽과 공유하는 계약):
 *   · 버킷/포인트에 `gap?: { reason: "collection_error" }` 가 붙는다.
 *   · gap 버킷은 **x축 슬롯(라벨)은 그대로 두고 측정값 필드를 전부 `null`** 로 둔다.
 *     → 값이 없으니 점(dot)도 없고, 툴팁 숫자도 없다.
 *   · 화면은 `gap` 유무로만 분기한다 — 값의 크기로 추측하지 않는다.
 *
 * 왜 `connectNulls` 를 켜지 않고 **보조선(bridge)** 으로 잇는가:
 *   기존 규약은 "측정 없는 회차는 선이 끊긴다(보간 금지, 스펙 SHALL)" 이고, 그건
 *   여전히 옳다. `connectNulls={true}` 는 시리즈의 **모든** null 을 이어버려서
 *   "측정은 있었지만 이 브랜드가 안 나온 주"까지 붙여버린다. 그래서 갭 런의
 *   **양옆 실측만** 근거로 삼는 보조선을 따로 그린다 — 갭 슬롯에 값을 만들지 않으므로
 *   보간이 아니고(툴팁·점 어디에도 가짜 숫자가 없다), 눈에는 이웃끼리 이어진다.
 *
 * 2026-09-11: 그 보조선이 **합성 시리즈(`<Line>`)에서 곡선 path 로** 바뀌었다.
 *   2점짜리 시리즈는 d3 가 `lineTo` 로 그려 무조건 직선이었다(운영: "부드럽게 연결").
 *   이제 여기서는 접선 계산에 필요한 이웃 좌표(`TrendGapBridge.left/right`)만 내고,
 *   곡선 자체는 `lib/viz/trend-gap-curve.ts` 가 픽셀 좌표에서 만든다.
 *   → 행(row)에는 아무것도 심지 않는다. 계산 결과의 `rows` 는 항상 입력 배열 그대로다.
 */

export type TrendGapReason = "collection_error";

/**
 * 갭의 **범위**(0071) — 원장 `summary_cycles.hidden_scope` 의 화면쪽 계약.
 *
 *   `"all"`       회차 전체가 내려갔다. 5 KPI 전부 갭이다(0071 이전의 유일한 형태).
 *   `"citations"` 인용 계열만 내려갔다. **언급 계열 값은 살아 있다** — 인용 카드·인용
 *                 차트에서만 음영·툴팁을 그리고, 나머지에서는 갭이 아예 없는 것처럼 군다.
 *
 * `undefined` = `"all"`. 0071 이전에 만들어진 마커·직렬화된 행이 그대로 통과한다.
 */
export type TrendGapScope = "all" | "citations";

export interface TrendGap {
  reason: TrendGapReason;
  /** 생략 = `"all"`(종전 동작). */
  scope?: TrendGapScope;
}

/** 마커의 범위. 없으면 `"all"` — "모르면 넓게 숨긴다". */
export function trendGapScopeOf(gap: TrendGap): TrendGapScope {
  return gap.scope ?? "all";
}

/**
 * 이 계열의 소비자가 이 갭을 **갭으로 보는가**.
 *
 *   인용 계열 → 범위와 무관하게 전부 갭
 *   언급 계열 → `"all"` 만 갭 (`"citations"` 는 값이 살아 있으므로 갭이 아니다)
 */
export function trendGapApplies(
  gap: TrendGap | undefined | null,
  family: TrendGapFamily,
): boolean {
  if (!gap) return false;
  return family === "citation" || trendGapScopeOf(gap) === "all";
}

/** 계열 어휘 — 데이터 쪽 `HiddenCycleFamily` 와 같은 두 값이다. */
export type TrendGapFamily = "mention" | "citation";

/** 갭 마커가 실릴 수 있는 recharts 행 — 측정값은 문자/숫자/null, `gap` 만 객체다. */
export type TrendGapRowValue = string | number | null | TrendGap | undefined;
export type TrendGapRow = { [key: string]: TrendGapRowValue };

/** 행의 예약 키. 시리즈 키(브랜드명·도메인·KPI 키)와 겹치지 않는다. */
export const TREND_GAP_FIELD = "gap";

/**
 * 보조선 식별자 접두사. 2026-09-11 이전에는 실제 recharts `dataKey`(합성 시리즈)였고,
 * 지금은 **React key** 로만 쓴다 — 행에 값을 심지 않으므로 시리즈 키와 겹칠 일도 없다.
 */
export const TREND_GAP_BRIDGE_PREFIX = "__gapBridge:";

export function trendGapBridgeKey(runIndex: number, seriesKey: string): string {
  return `${TREND_GAP_BRIDGE_PREFIX}${runIndex}:${seriesKey}`;
}

export function isTrendGap(value: unknown): value is TrendGap {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { reason?: unknown }).reason === "collection_error"
  );
}

/** 행(또는 recharts 툴팁 payload 의 `payload`)에서 갭 마커를 읽는다. */
export function rowTrendGap(row: unknown): TrendGap | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const g = (row as Record<string, unknown>)[TREND_GAP_FIELD];
  return isTrendGap(g) ? g : undefined;
}

/** 음영 슬롯 하나 — recharts `<ReferenceArea x1 x2>` 에 그대로 넘긴다. */
export interface TrendGapArea {
  key: string;
  /** 카테고리 축 값. 축 끝의 갭이면 한쪽이 갭 자신이라 반 칸만 덮인다. */
  x1?: string | number;
  x2?: string | number;
}

/** 보조선이 참조하는 실측 점 하나 — x 는 축 값(라벨), y 는 그 시리즈의 값. */
export interface TrendGapAnchor {
  x: string | number;
  y: number;
}

/**
 * 이웃 연결용 보조선 하나. `seriesKey` 로 원래 시리즈의 색·굵기·축을 찾는다.
 *
 * `left`/`right` 는 **본선의 접선을 이어받기 위한** 이웃 점들이다(2026-09-11):
 *   · `left`  — 갭 왼쪽 런의 꼬리. 오름차순이고 **마지막 원소가 갭 직전 점**.
 *   · `right` — 갭 오른쪽 런의 머리. 오름차순이고 **첫 원소가 갭 직후 점**.
 * d3 `curveMonotoneX` 의 끝 접선은 런의 마지막 3점만 보므로 각 3점이면 충분하다.
 * 이웃이 결측이면 배열이 비고, 그러면 보조선 자체가 안 생긴다(축 끝 갭과 같은 처리).
 */
export interface TrendGapBridge {
  dataKey: string;
  seriesKey: string;
  /**
   * 이 보조선이 속한 **갭 런의 순번**(0부터). 라인 차트는 안 쓰지만, 누적 영역 차트는
   * 같은 런의 경계 보조선들을 묶어 하나의 띠로 채워야 하므로 필요하다.
   */
  runIndex: number;
  left: TrendGapAnchor[];
  right: TrendGapAnchor[];
}

/** 접선 계산에 필요한 이웃 점 수 — d3 `slope2(…, slope3(…))` 가 보는 최대치. */
const TANGENT_ANCHORS = 3;

export interface TrendGapPlan<T> {
  hasGap: boolean;
  areas: TrendGapArea[];
  bridges: TrendGapBridge[];
  /**
   * 차트가 그릴 행 배열. 2026-09-11 부터는 갭이 있든 없든 **입력 배열 그대로**다
   * (참조 동일). 호출부는 계속 `data={plan.rows}` 를 쓰면 된다.
   */
  rows: readonly T[];
}

const EMPTY_PLAN_AREAS: TrendGapArea[] = [];
const EMPTY_PLAN_BRIDGES: TrendGapBridge[] = [];

function cellOf(row: unknown, key: string): unknown {
  if (typeof row !== "object" || row === null) return undefined;
  return (row as Record<string, unknown>)[key];
}

function axisValue(row: unknown, xKey: string): string | number | undefined {
  const v = cellOf(row, xKey);
  return typeof v === "string" || typeof v === "number" ? v : undefined;
}

/**
 * 갭 슬롯 목록(음영)과 보조선 계획을 한 번에 계산한다.
 *
 * `seriesKeys` 는 **그릴 수 있는 시리즈 전부**를 넘긴다(토글로 숨겨진 것 포함).
 * 숨김 여부는 렌더 시점에 `styleOf` 가 판단한다 — 그래야 이 계산이 토글마다
 * 다시 돌지 않는다.
 */
export function planTrendGaps<T extends object>(
  rows: readonly T[],
  opts: {
    xKey: string;
    seriesKeys: readonly string[];
    /**
     * 이 차트가 그리는 **계열**(0071). 생략하면 종전 동작(범위 무시 = 전부 갭)이라
     * 기존 콜사이트는 한 글자도 안 고쳐도 값이 같다. 언급 계열 차트가 이 값을 넘기면
     * `scope:"citations"` 마커가 붙은 행을 **갭으로 보지 않는다** — 음영·보조 라인이
     * 안 생기고 그 행의 값이 그대로 그려진다.
     */
    family?: TrendGapFamily;
  },
): TrendGapPlan<T> {
  const { family } = opts;
  const gapAt = rows.map((r) => {
    const g = rowTrendGap(r);
    return family ? trendGapApplies(g, family) : g != null;
  });
  if (!gapAt.some(Boolean)) {
    return { hasGap: false, areas: EMPTY_PLAN_AREAS, bridges: EMPTY_PLAN_BRIDGES, rows };
  }

  // 연속 갭은 한 덩어리로 — 겹친 ReferenceArea 가 음영을 두 배로 진하게 만들지 않게.
  const runs: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (!gapAt[i]) continue;
    const last = runs[runs.length - 1];
    if (last && last.end === i - 1) last.end = i;
    else runs.push({ start: i, end: i });
  }

  const areas: TrendGapArea[] = runs.map((run, idx) => ({
    key: `trend-gap-${idx}-${String(axisValue(rows[run.start], opts.xKey) ?? idx)}`,
    // 음영은 **이웃 점의 중심에서 중심까지**. 카테고리 축에서 그게 갭 슬롯을 가운데
    // 둔 한 칸이고, 동시에 보조 라인이 잇는 구간과 정확히 일치한다.
    x1: axisValue(rows[run.start - 1], opts.xKey) ?? axisValue(rows[run.start], opts.xKey),
    x2: axisValue(rows[run.end + 1], opts.xKey) ?? axisValue(rows[run.end], opts.xKey),
  }));

  /**
   * `from` 에서 `step` 방향으로, 그 시리즈의 **연속 실측 구간**을 최대 3점 모은다.
   * 본선(`connectNulls={false}`)이 끊기는 자리에서 같이 멈춰야 접선이 본선과 같아진다.
   */
  function anchorsFrom(from: number, step: 1 | -1, s: string): TrendGapAnchor[] {
    const out: TrendGapAnchor[] = [];
    for (let i = from; i >= 0 && i < rows.length && out.length < TANGENT_ANCHORS; i += step) {
      const v = cellOf(rows[i], s);
      const x = axisValue(rows[i], opts.xKey);
      if (typeof v !== "number" || !Number.isFinite(v) || x === undefined) break;
      out.push({ x, y: v });
    }
    return out;
  }

  const bridges: TrendGapBridge[] = [];
  runs.forEach((run, idx) => {
    const left = run.start - 1;
    const right = run.end + 1;
    // 축 끝의 갭은 이을 이웃이 없다 — 음영만 남기고 선은 그대로 끊어 둔다.
    if (left < 0 || right >= rows.length) return;
    for (const s of opts.seriesKeys) {
      // 바로 옆 이웃이 결측이면 잇지 않는다 — 없는 측정을 이어 붙이는 게 되기 때문.
      const l = anchorsFrom(left, -1, s);
      const r = anchorsFrom(right, 1, s);
      if (l.length === 0 || r.length === 0) continue;
      bridges.push({
        dataKey: trendGapBridgeKey(idx, s),
        seriesKey: s,
        runIndex: idx,
        left: l.reverse(), // 왼쪽은 안쪽→바깥쪽으로 모았으므로 오름차순으로 뒤집는다.
        right: r,
      });
    }
  });

  // 행은 손대지 않는다 — 보조선은 이제 합성 시리즈가 아니라 그림(path)이라
  // `__gapBridge:` 값을 데이터에 심을 이유가 없다(참조 동일 = 회귀 표면 0).
  return { hasGap: true, areas, bridges, rows };
}

// ── 갭 슬롯을 축에 얹는 두 가지 방식 (데이터 쪽 순수 계산부) ─────────────────
//
// 숨긴 회차(0070 `summary_cycles.hidden_reason`)의 자리는 축에 **있을 수도, 없을 수도**
// 있다. 두 경우를 한 함수로 뭉개면 조용히 틀린다:
//
//   · **슬롯이 이미 있다** — 미러 주 격자 경로. `fillTrendGaps`(live.ts·kpi-view.ts)가
//     측정 없는 주를 이미 빈 점으로 채워 두었다. 할 일은 그 점에 **마커만 얹는 것**이고,
//     새 점을 만들면 같은 주가 두 개가 된다.
//   · **슬롯이 없다** — 집계층 회차 축 경로(`cycleAnchorAt`). 그 축은 회차가 없는 자리를
//     **일부러 안 만든다**(주 격자로 채우면 없던 점이 생긴다). 여기서는 갭 슬롯을
//     직접 끼워 넣어야 한다.
//
// 두 경우에 공통인 규칙 둘:
//   ① **축을 넓히지 않는다.** 첫 점 앞·마지막 점 뒤의 갭은 그리지 않는다 — 이을 이웃이
//      없어 음영만 뜨고, 축 끝이 늘어나 "측정이 더 있었던 것처럼" 보인다.
//   ② **측정이 남아 있는 슬롯에는 마커를 얹지 않는다.** 숨긴 회차의 주에 **다른** 회차의
//      측정이 남아 있으면 그 주는 구멍이 아니다(값이 줄었을 뿐 — 그건 사실이다).
//      값이 있는데 갭이라고 말하면 계약("갭 슬롯의 측정값은 전부 null")이 깨진다.

/**
 * 규칙 ①의 판정부 — 갭 키가 축 **안쪽**인가. 키는 사전순 비교 가능한 형식
 * (`YYYY-MM-DD`)이어야 한다.
 */
export function trendGapKeyInAxis(
  key: string,
  firstKey: string | undefined,
  lastKey: string | undefined,
): boolean {
  if (firstKey === undefined || lastKey === undefined) return false;
  return key > firstKey && key < lastKey;
}

/**
 * 슬롯이 **없을 때** — 갭 행을 만들어 끼워 넣는다(집계층 회차 축).
 * 입력은 키 오름차순이어야 하고, 출력도 그렇다. 끼울 것이 없으면 입력 배열을 그대로
 * 돌려준다(참조 동일 — 상위가 "변한 것이 없다"를 싸게 판정한다).
 */
export function insertTrendGapSlots<T>(
  rows: readonly T[],
  gapKeys: readonly string[],
  keyOf: (row: T) => string,
  make: (key: string) => T,
): readonly T[] {
  if (rows.length < 2 || gapKeys.length === 0) return rows;
  const present = new Set(rows.map(keyOf));
  const first = keyOf(rows[0]);
  const last = keyOf(rows[rows.length - 1]);
  const add = [...new Set(gapKeys)]
    .filter((k) => !present.has(k) && trendGapKeyInAxis(k, first, last))
    .sort();
  if (add.length === 0) return rows;
  const out: T[] = [];
  let i = 0;
  for (const row of rows) {
    const k = keyOf(row);
    while (i < add.length && add[i] < k) {
      out.push(make(add[i]));
      i += 1;
    }
    out.push(row);
  }
  // 마지막 점보다 큰 키는 규칙 ①에서 이미 걸러졌으므로 잔여는 없다.
  return out;
}

/**
 * 슬롯이 **이미 있을 때** — 어느 키에 마커를 얹을지 판정한다(미러 주 격자).
 *
 * `hasValue` 는 그 슬롯에 측정이 남아 있는지다(규칙 ②). 남아 있으면 갭이 아니다.
 * 반환은 마커를 얹을 키 집합이고, 행을 만드는 것은 호출부다 — 행 모양이 경로마다
 * 다르기 때문(`LiveTrendPoint` · recharts row · `KpiTrendPoint`).
 */
export function trendGapKeysToMark(
  axisKeys: readonly string[],
  gapKeys: readonly string[],
  hasValue: (key: string) => boolean,
): ReadonlySet<string> {
  const out = new Set<string>();
  if (axisKeys.length < 2 || gapKeys.length === 0) return out;
  const first = axisKeys[0];
  const last = axisKeys[axisKeys.length - 1];
  const axis = new Set(axisKeys);
  for (const k of new Set(gapKeys)) {
    if (!axis.has(k)) continue;
    if (!trendGapKeyInAxis(k, first, last)) continue;
    if (hasValue(k)) continue;
    out.add(k);
  }
  return out;
}

/** 갭 마커 하나 — 사유는 오늘 하나뿐이지만, 만드는 자리를 한 곳으로 모아 둔다. */
export const COLLECTION_ERROR_GAP: TrendGap = { reason: "collection_error" };

/** 인용 계열만 내려간 갭(0071). 언급 계열 소비자는 이 마커를 갭으로 보지 않는다. */
export const CITATIONS_COLLECTION_ERROR_GAP: TrendGap = {
  reason: "collection_error",
  scope: "citations",
};

/** 범위로 마커를 고른다 — 만드는 자리를 늘리지 않으려고 한 함수로 모은다. */
export function collectionErrorGap(scope: TrendGapScope): TrendGap {
  return scope === "citations" ? CITATIONS_COLLECTION_ERROR_GAP : COLLECTION_ERROR_GAP;
}
