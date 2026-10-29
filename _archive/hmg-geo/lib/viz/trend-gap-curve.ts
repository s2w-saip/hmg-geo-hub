/**
 * 결측 회차 보조선(bridge)의 **곡선 기하** — 순수 계산부.
 *
 * 배경(2026-09-11 운영): "직선으로 연결하는게 아니라 부드럽게 연결 됐으면 좋겠는데".
 * 종전 보조선은 갭 런 양옆 2점만 실은 합성 시리즈였다 — 점이 둘뿐이면 recharts 에
 * 어떤 `type` 을 줘도 d3 는 `lineTo` 를 내므로 **무조건 직선**이었다.
 *
 * 여기서 고른 것은 "본선이 `connectNulls` 였다면 그렸을 곡선"이 아니라
 * **본선의 끝 접선을 그대로 이어받는 곡선**이다. 이유는 기하다:
 *
 *   · d3 `curveMonotoneX` 는 세그먼트가 **끊기는 지점에서 한쪽 기울기(`slope2`)** 를 쓴다.
 *     본선은 `connectNulls={false}` 라(스펙 SHALL — 측정 없는 주는 선이 끊긴다) 갭 직전
 *     점 `prev` 가 왼쪽 런의 **마지막 점**이고, 거기서의 접선은 `slope2` 다.
 *   · 반면 "connectNulls 였다면" 곡선은 그 자리에서 **3점 기울기(`slope3`)** 를 쓴다.
 *     두 값은 일반적으로 다르다 — 즉 그 곡선을 갭 창에 끼워 넣으면 이음매에서 접선이
 *     튄다(꺾임이 그대로 남는다). 실제로 일정 증가 구간에서는 `slope3` 가 시컨트와
 *     같아져서 **오늘의 직선과 이음매 꺾임이 동일**했다 — 곡선만 되고 문제는 안 고쳐진다.
 *   · 접선을 본선의 `slope2` 로 맞추면 이음매가 C1 연속이 되어 꺾임이 **0** 이 된다.
 *
 * 알고리즘은 d3-shape `monotone.js`(Steffen 1990 / Fritsch–Carlson) 를 그대로 포팅했다.
 * recharts 가 내부적으로 `victory-vendor/d3-shape` 를 쓰지만 이 리포에 의존성 선언이
 * 없으므로 직접 import 하지 않는다(테스트에서만 원본과 대조한다).
 *
 *   출처: d3-shape (https://github.com/d3/d3-shape) — ISC/BSD-3 계열 라이선스,
 *         Copyright 2010-2022 Mike Bostock. `src/curve/monotone.js` 의 slope2/slope3/point.
 *
 * 좌표는 **픽셀**이다(축 스케일을 통과한 뒤). d3 도 픽셀 좌표에서 접선을 계산하므로
 * 데이터 좌표에서 계산하면 축이 비선형(log·reversed 조합)일 때 어긋난다.
 */

/** 픽셀 좌표 한 점. */
export interface TrendCurvePoint {
  x: number;
  y: number;
}

/** 3차 베지어 한 구간 — `p0`에서 `p1`까지, 제어점 `c1`·`c2`. */
export interface TrendBridgeCubic {
  p0: TrendCurvePoint;
  c1: TrendCurvePoint;
  c2: TrendCurvePoint;
  p1: TrendCurvePoint;
  /** 실제로 쓴 접선(픽셀 y / 픽셀 x). 리미터가 걸리면 축소된 값이다. */
  m0: number;
  m1: number;
  /** 리미터가 걸렸으면 그 배율(1 이면 본선 접선을 그대로 썼다). */
  tangentScale: number;
}

/** d3 `monotone.js` 의 `sign` — 0 은 양수로 친다(원본 그대로). */
function sign(x: number): number {
  return x < 0 ? -1 : 1;
}

/**
 * d3 `slope3` — 가운데 점 `p1` 의 3점 접선.
 * 원본의 `h0 || h1 < 0 && -0` 관용구까지 그대로 옮겼다(x 가 겹칠 때의 부호 처리).
 */
export function slope3(p0: TrendCurvePoint, p1: TrendCurvePoint, p2: TrendCurvePoint): number {
  const h0 = p1.x - p0.x;
  const h1 = p2.x - p1.x;
  const s0 = (p1.y - p0.y) / (h0 || (h1 < 0 ? -0 : 0));
  const s1 = (p2.y - p1.y) / (h1 || (h0 < 0 ? -0 : 0));
  const p = (s0 * h1 + s1 * h0) / (h0 + h1);
  return (
    (sign(s0) + sign(s1)) *
      Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0
  );
}

/** d3 `slope2` — 런의 끝에서 쓰는 한쪽 기울기. `t` 는 이웃 점의 접선. */
export function slope2(p0: TrendCurvePoint, p1: TrendCurvePoint, t: number): number {
  const h = p1.x - p0.x;
  return h ? (3 * (p1.y - p0.y) / h - t) / 2 : t;
}

function secant(p0: TrendCurvePoint, p1: TrendCurvePoint): number {
  const h = p1.x - p0.x;
  return h ? (p1.y - p0.y) / h : 0;
}

/**
 * 런의 **마지막 점**에서 d3 `curveMonotoneX` 가 쓰는 접선.
 *
 * d3 `lineEnd` 의 분기를 그대로 따른다:
 *   · 2점 런 → `lineTo`(직선) 이므로 방향은 시컨트.
 *   · 3점 이상 → `slope2(p[n-2], p[n-1], slope3(p[n-3], p[n-2], p[n-1]))`.
 *
 * 점이 하나뿐인 런(양옆이 전부 결측)에는 방향이 없다 — `fallback` 을 쓴다.
 */
export function monotoneEndTangent(run: readonly TrendCurvePoint[], fallback: number): number {
  const n = run.length;
  if (n < 2) return fallback;
  if (n === 2) return secant(run[0], run[1]);
  const t = slope3(run[n - 3], run[n - 2], run[n - 1]);
  return slope2(run[n - 2], run[n - 1], t);
}

/**
 * 런의 **첫 점**에서 d3 `curveMonotoneX` 가 쓰는 접선.
 * d3 `point()` 의 `case 2` — `slope2(p[0], p[1], slope3(p[0], p[1], p[2]))`.
 */
export function monotoneStartTangent(run: readonly TrendCurvePoint[], fallback: number): number {
  const n = run.length;
  if (n < 2) return fallback;
  if (n === 2) return secant(run[0], run[1]);
  const t = slope3(run[0], run[1], run[2]);
  return slope2(run[0], run[1], t);
}

/**
 * 접선 크기 상한 배율 — 제어점이 끝점에서 벗어나는 거리를 **이웃 구간 높이의 몇 배까지**
 * 허용할지. 갭이 넓을수록 `dx` 가 커져 부풀기가 선형으로 자라기 때문에 둔 안전장치다.
 *
 * ⚠️ 이 리미터는 **넓은 갭에서 제어점이 멀리 날아가는 것**만 막는다. 개입 조건은
 * `|dx·m| > max(1.5·Δ, |dx·s|)` 이고 `dx = (갭칸수+1)·step/3` 이므로, 실제 데이터에서
 * 흔한 **갭 1~3칸에서는 사실상 개입하지 않는다**(2026-09-11 프리뷰 실측 35개 보조선
 * 전부 `tangentScale=1`). 종전 주석은 "3칸 이상부터 개입"이라고 적었지만 그것은
 * `|m| = 1.5·|s_adj|` 라는 최악만 가정한 값이고, `Δ`(이웃 구간 높이)가 클수록 상한도
 * 같이 커져 개입은 더 늦어진다.
 *
 * 즉 **"없던 봉우리"는 이 리미터가 못 잡는다** — 그 몫은 아래 오버슛 리미터다.
 */
const MAX_OFFSET_RATIO = 1.5;

/**
 * 오버슛 허용치 — 보조선이 **양 끝점 y 범위 밖으로** 나가도 되는 여유(기준값의 비율).
 *
 * 왜 필요한가: C1 연속(본선 접선 그대로)을 지키면, 진입이 가파르고 방향이 뒤집히는
 * 구간에서 곡선이 양 끝점보다 훨씬 위/아래로 솟는다. 2026-09-11 프리뷰 실측
 * (인용 차트 `genesis.com`) 8/17 ≈10,000 → 8/31 ≈5,300 사이에 ≈12,000 봉우리가
 * 생겼다 — 플롯 높이의 18%(≈2,155 인용). **측정이 없는 주에 없던 피크를 주장**하는
 * 것이라 보조선의 존재 이유(이웃을 잇는 안내선)와 정면으로 어긋난다.
 */
const OVERSHOOT_TOL_RATIO = 0.05;

/** 부동소수 knife-edge 방지용 여유(픽셀). */
const OVERSHOOT_EPS = 1e-9;

/** 이분법 반복 횟수 — 2^-60 이면 픽셀 단위로 완전히 수렴한다. */
const OVERSHOOT_BISECT_STEPS = 60;

/** `trendBridgeCubic` 의 선택 인자. */
export interface TrendBridgeOptions {
  /**
   * 플롯 영역 높이(px). 오버슛 허용치의 기준을 **끝점 스팬 대신 플롯 높이**로 올린다.
   *
   * 끝점 스팬만 쓰면 거의 평평한 시리즈(스팬 1~3px)에서 허용치가 0.05px 로 쪼그라들어
   * 눈에 보이지도 않는 굴곡까지 직선으로 펴 버린다 — 2026-09-11 실측 35개 중 **13개**가
   * 그렇게 걸렸다. 사람이 "없던 피크"로 읽는 것은 화면에서 차지하는 높이이므로 플롯
   * 높이를 기준으로 잡는다(같은 실측에서 개입은 genesis 1개뿐).
   *
   * 없으면(차트 밖·레이아웃 전) 끝점 스팬으로 물러선다 — 보수적인 쪽이다.
   */
  plotSpan?: number;
}

/**
 * 3차 베지어 y(t) 의 `t∈[0,1]` 최소·최대.
 *
 * y'(t) 는 2차식이므로 근을 **해석적으로** 구한다(샘플링하면 뾰족한 봉우리를 놓친다).
 * 반환값은 끝점 두 개와 구간 안 임계점들을 함께 본 결과다.
 */
export function trendCubicYExtent(
  y0: number,
  y1: number,
  y2: number,
  y3: number,
): { min: number; max: number } {
  const at = (t: number): number => {
    const u = 1 - t;
    return u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
  };
  // y'(t)/3 = a·t² + b·t + c
  const a = -y0 + 3 * y1 - 3 * y2 + y3;
  const b = 2 * (y0 - 2 * y1 + y2);
  const c = y1 - y0;
  const ts: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const r = Math.sqrt(disc);
      ts.push((-b + r) / (2 * a), (-b - r) / (2 * a));
    }
  }
  let min = Math.min(y0, y3);
  let max = Math.max(y0, y3);
  for (const t of ts) {
    if (!(t > 0 && t < 1)) continue;
    const y = at(t);
    if (y < min) min = y;
    if (y > max) max = y;
  }
  return { min, max };
}

/**
 * 갭 창 한 구간의 3차 베지어를 만든다.
 *
 * `left` 는 본선 왼쪽 런의 **꼬리**(마지막 원소가 갭 직전 점 `prev`), `right` 는 오른쪽
 * 런의 **머리**(첫 원소가 갭 직후 점 `next`). 접선 계산에 필요한 만큼(각 3점)만 있으면 된다.
 *
 * 이을 수 없으면 `null` — 한쪽 이웃이 없거나(축 끝 갭) x 가 뒤집힌 경우.
 */
export function trendBridgeCubic(
  left: readonly TrendCurvePoint[],
  right: readonly TrendCurvePoint[],
  opts: TrendBridgeOptions = {},
): TrendBridgeCubic | null {
  if (left.length === 0 || right.length === 0) return null;
  const p0 = left[left.length - 1];
  const p1 = right[0];
  const h = p1.x - p0.x;
  if (!Number.isFinite(h) || h <= 0) return null;

  const s = (p1.y - p0.y) / h;
  let m0 = monotoneEndTangent(left, s);
  let m1 = monotoneStartTangent(right, s);
  if (!Number.isFinite(m0)) m0 = s;
  if (!Number.isFinite(m1)) m1 = s;

  const dx = h / 3;
  // "이 근방에서 한 칸이 만드는 세로 크기" = 갭에 맞닿은 실측 구간의 높이.
  // 부풀기를 그 1.5배로 묶으면 갭이 아무리 넓어도 곡선이 **이웃 한 구간 남짓**만
  // 벗어난다. 시컨트만큼(=직선)은 언제나 허용해 직선 폴백을 굽히지 않는다.
  const spanAdj = Math.max(
    left.length >= 2 ? Math.abs(p0.y - left[left.length - 2].y) : 0,
    right.length >= 2 ? Math.abs(right[1].y - p1.y) : 0,
  );
  const maxOffset = Math.max(MAX_OFFSET_RATIO * spanAdj, Math.abs(dx * s));
  const worst = Math.max(Math.abs(dx * m0), Math.abs(dx * m1));
  let tangentScale = 1;
  if (maxOffset > 0 && worst > maxOffset) {
    tangentScale = maxOffset / worst;
    m0 *= tangentScale;
    m1 *= tangentScale;
  }

  // ── 오버슛 리미터 ────────────────────────────────────────────────────────
  // 곡선이 양 끝점 y 범위(+여유)를 벗어나면 **양쪽 접선을 같은 비율로** 줄인다.
  // 같은 비율이라야 이음매의 방향(부호)이 뒤집히지 않고, C1 은 깨지되 그 깨짐이
  // 양쪽에 고르게 나뉜다.
  //
  // 배율 `k` 에 대해 곡선은 **아핀**이다(y = 스무스스텝 + k·(접선 항)). 따라서
  //   · `k = 0` 이면 곡선은 끝점 사이에 갇힌다(스무스스텝은 단조) → 항상 만족,
  //   · 만족 집합은 `max_t(아핀)` 가 볼록이라 **0 을 품는 구간**이다.
  // 그래서 `[0, 1]` 이분법이 "만족하는 최대 배율"을 정확히 찾는다.
  const lo = Math.min(p0.y, p1.y);
  const hi = Math.max(p0.y, p1.y);
  const plotSpan =
    typeof opts.plotSpan === "number" && Number.isFinite(opts.plotSpan) && opts.plotSpan > 0
      ? opts.plotSpan
      : 0;
  const tol = OVERSHOOT_TOL_RATIO * Math.max(hi - lo, plotSpan);
  const fits = (k: number): boolean => {
    const e = trendCubicYExtent(p0.y, p0.y + dx * m0 * k, p1.y - dx * m1 * k, p1.y);
    return e.min >= lo - tol - OVERSHOOT_EPS && e.max <= hi + tol + OVERSHOOT_EPS;
  };
  if (!fits(1)) {
    let ok = 0;
    let bad = 1;
    for (let i = 0; i < OVERSHOOT_BISECT_STEPS; i += 1) {
      const mid = (ok + bad) / 2;
      if (fits(mid)) ok = mid;
      else bad = mid;
    }
    m0 *= ok;
    m1 *= ok;
    tangentScale *= ok;
  }

  // d3 `point()` 와 같은 식: Hermite → Bézier (p0, p0 + m0/3, p1 - m1/3, p1).
  return {
    p0: { x: p0.x, y: p0.y },
    c1: { x: p0.x + dx, y: p0.y + dx * m0 },
    c2: { x: p1.x - dx, y: p1.y - dx * m1 },
    p1: { x: p1.x, y: p1.y },
    m0,
    m1,
    tangentScale,
  };
}

function round(n: number): number {
  // 소수 3자리면 서브픽셀보다 훨씬 촘촘하다 — path 문자열을 짧고 안정적으로 유지한다.
  return Math.round(n * 1000) / 1000;
}

function pt(p: TrendCurvePoint): string {
  return `${round(p.x)},${round(p.y)}`;
}

/** 3차 베지어 하나를 여는 path 조각 — `M p0 C c1,c2,p1`. */
export function trendCubicPath(c: TrendBridgeCubic): string {
  return `M${pt(c.p0)}C${pt(c.c1)},${pt(c.c2)},${pt(c.p1)}`;
}

/** `trendBridgeCubic` 결과를 SVG path 로. 이을 수 없으면 `null`. */
export function trendBridgePath(
  left: readonly TrendCurvePoint[],
  right: readonly TrendCurvePoint[],
  opts: TrendBridgeOptions = {},
): string | null {
  const c = trendBridgeCubic(left, right, opts);
  return c ? trendCubicPath(c) : null;
}

// ── 누적(스택) 영역용 — 두 경계 곡선 사이를 채운 닫힌 밴드 ────────────────────
//
// 라인 차트의 보조선은 곡선 **하나**면 되지만, 100% 누적 영역 차트에서 한 카테고리는
// **연속한 두 누적 경계 사이의 띠**다. 그래서 갭 창에서도 위·아래 두 경계를 각각
// 곡선으로 잇고 그 사이를 닫아 채운다.
//
// 접선 정책은 보조선과 **같다**: 본선 접선을 그대로 이어받아(C1) 이음매를 안 꺾고,
// 아래 세 조건 중 하나라도 깨질 때만 **모든 경계의 접선을 같은 배율로** 줄인다.
//   ① 오버슛 — 곡선이 양 끝점 y 범위 ± tol 밖으로 나간다(`trendBridgeCubic` 이 경계마다
//      먼저 본다. tol = 5% × max(끝점 스팬, 플롯 높이) — 보조선과 같은 식).
//   ② 순서 역전 — 누적 경계는 절대 서로를 넘지 않는다(칸 값이 음수가 아니므로 단조).
//      그런데 경계마다 따로 계산한 곡선은 갭 창 **안쪽**에서 서로를 넘을 수 있다.
//      띠가 뒤집히면 "구성비가 음수"라는, 데이터에 없는 말을 화면이 하게 된다.
//   ③ 축 범위 — 정규화 축이면 맨 위 경계가 100% 를, 바닥이 0% 를 넘어선 안 된다.
//
// ⚠️ 종전에는 각 경계에 **모양 보존 리미터**(Fritsch–Carlson: 시컨트와 부호가 다르면 0,
// 같으면 `3·|시컨트|` 상한)를 **무조건 선적용**했다. 그것은 보조선 정책과 다르고, 순서
// 보존에 필요하지도 않았다 — 2026-09-11 프리뷰 실측(13 카테고리 × 11주)에서 그 규칙은
// 접선 28개 중 3개를 바꿨고(각도차 0.55°·0.06°·0.03°), 같은 데이터에서 ①~③ 은 **하나도
// 개입하지 않는다**(최악 역전량 -0.353px = 교차 없음). 단일 카테고리 absolute 모드
// (`?source=Official (HMG)`)에서는 8/17 이음매를 **48.04°** 꺾었다(프리뷰 실측 46.9°).
//
// 배율 사다리 대신 **이분법**을 쓰는 것도 보조선과 같다. 곡선은 배율 `k` 에 대해 아핀
// (`y = 스무스스텝 + k·(접선 항)`)이므로 `max_t(…) ≤ 한계` 꼴 제약의 만족 집합은 전부
// **0 을 품는 볼록 구간**이고 — `k = 0` 이면 모든 경계가 양 끝 값의 볼록결합이라 끝점
// 순서·범위가 그대로 유지된다 — `[0, 1]` 이분법이 "만족하는 최대 배율"을 정확히 찾는다.

/** 접선을 `scale` 배로 줄인 같은 구간의 베지어. */
function scaleTangents(c: TrendBridgeCubic, scale: number): TrendBridgeCubic {
  if (scale === 1) return c;
  const dx = (c.p1.x - c.p0.x) / 3;
  const m0 = c.m0 * scale;
  const m1 = c.m1 * scale;
  return {
    p0: c.p0,
    c1: { x: c.p0.x + dx, y: c.p0.y + dx * m0 },
    c2: { x: c.p1.x - dx, y: c.p1.y - dx * m1 },
    p1: c.p1,
    m0,
    m1,
    tangentScale: c.tangentScale * scale,
  };
}

/** 서브픽셀 이하의 겹침·비어져 나감은 위반으로 치지 않는다(맞닿는 0 높이 밴드가 정상이다). */
const BAND_EPS = 0.01;

/** 이분법 반복 횟수 — 오버슛 리미터와 같은 정밀도(2^-60). */
const BAND_BISECT_STEPS = 60;

/**
 * SVG y 는 아래로 커진다 — 배열 순서(아래→위)대로면 `y` 는 **비증가**여야 한다.
 *
 * 두 경계는 같은 `t` 로 매개화된 같은 x 구간의 베지어이므로 **차도 3차 베지어**다
 * (제어점의 차가 곧 차곡선의 제어점). 그래서 표본이 아니라 `trendCubicYExtent` 로
 * 극값을 해석적으로 본다 — 표본은 뾰족한 교차를 그냥 지나친다.
 */
function keepsOrder(cubics: readonly TrendBridgeCubic[]): boolean {
  for (let k = 0; k + 1 < cubics.length; k += 1) {
    const lower = cubics[k];
    const upper = cubics[k + 1];
    const e = trendCubicYExtent(
      lower.p0.y - upper.p0.y,
      lower.c1.y - upper.c1.y,
      lower.c2.y - upper.c2.y,
      lower.p1.y - upper.p1.y,
    );
    if (e.min < -BAND_EPS) return false;
  }
  return true;
}

/** 축 범위(정규화 100% 상단·스택 바닥) 안에 머무는가. */
function withinAxis(cubics: readonly TrendBridgeCubic[], opts: TrendBandOptions): boolean {
  const { yTop, yBottom } = opts;
  if (yTop === undefined && yBottom === undefined) return true;
  for (const c of cubics) {
    const e = trendCubicYExtent(c.p0.y, c.c1.y, c.c2.y, c.p1.y);
    if (yTop !== undefined && e.min < yTop - BAND_EPS) return false;
    if (yBottom !== undefined && e.max > yBottom + BAND_EPS) return false;
  }
  return true;
}

/** 누적 경계 하나가 참조하는 양옆 이웃 점들(픽셀). */
export interface TrendBandBoundary {
  left: readonly TrendCurvePoint[];
  right: readonly TrendCurvePoint[];
}

/** `trendBandCubics` 의 선택 인자 — 보조선 인자에 축 범위를 더한 것. */
export interface TrendBandOptions extends TrendBridgeOptions {
  /**
   * 픽셀 y 의 **상한선**(작은 y = 화면 위). 정규화 축이면 구성비 100% 의 픽셀이다.
   * 없으면 위쪽 범위를 안 본다(absolute 모드처럼 데이터상 상한이 없는 경우).
   */
  yTop?: number;
  /** 픽셀 y 의 **하한선**(큰 y = 화면 아래). 스택 바닥(값 0)의 픽셀. */
  yBottom?: number;
}

/**
 * 누적 경계들을 **아래에서 위 순서로** 받아 갭 창의 곡선을 한꺼번에 만든다.
 * 하나라도 이을 수 없으면(축 끝 갭·이웃 결측) 전체가 `null` — 띠는 두 경계가
 * 모두 있어야만 성립하기 때문이다.
 */
export function trendBandCubics(
  boundaries: readonly TrendBandBoundary[],
  opts: TrendBandOptions = {},
): TrendBridgeCubic[] | null {
  if (boundaries.length < 2) return null;
  const raw: TrendBridgeCubic[] = [];
  for (const b of boundaries) {
    const c = trendBridgeCubic(b.left, b.right, opts);
    if (!c) return null;
    raw.push(c);
  }
  const fits = (k: number): boolean => {
    const out = k === 1 ? raw : raw.map((c) => scaleTangents(c, k));
    return keepsOrder(out) && withinAxis(out, opts);
  };
  // 흔한 경우(실제 구성비)는 여기서 끝난다 — 본선 접선이 그대로 남는다.
  if (fits(1)) return raw;
  let ok = 0;
  let bad = 1;
  for (let i = 0; i < BAND_BISECT_STEPS; i += 1) {
    const mid = (ok + bad) / 2;
    if (fits(mid)) ok = mid;
    else bad = mid;
  }
  return raw.map((c) => scaleTangents(c, ok));
}

/**
 * 두 경계 곡선 사이를 채운 **닫힌** path.
 * `M 상단p0 C … 상단p1 L 하단p1 C(역방향) … 하단p0 Z` — 역방향 3차 베지어는
 * 제어점 순서만 뒤집으면 같은 곡선이다.
 */
export function trendBandPath(upper: TrendBridgeCubic, lower: TrendBridgeCubic): string {
  return (
    `${trendCubicPath(upper)}` +
    `L${pt(lower.p1)}` +
    `C${pt(lower.c2)},${pt(lower.c1)},${pt(lower.p0)}` +
    `Z`
  );
}
