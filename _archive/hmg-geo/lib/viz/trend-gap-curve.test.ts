import { describe, expect, it } from "vitest";
// ⚠️ 원본 대조용 — **테스트에서만** 쓴다. `victory-vendor/d3-shape` 는 package.json 에
// 선언되지 않은 **recharts 3.x 의 전이 의존**(recharts 가 곡선을 그릴 때 실제로 쓰는
// d3-shape 벤더 사본)이다. 그래서:
//   · 앱 코드는 절대 import 하지 않는다(선언 없는 의존에 기대면 안 된다).
//   · 여기서 **해석(import)이 실패하면 그것 자체가 신호다** — recharts 의 곡선 구현
//     또는 벤더링 방식이 바뀌었다는 뜻이고, 그러면 이 포팅의 전제도 같이 무너지므로
//     테스트가 실패하는 것이 맞다(조용히 스킵하지 않는다).
import { curveMonotoneX, line as d3Line } from "victory-vendor/d3-shape";
import {
  monotoneEndTangent,
  monotoneStartTangent,
  trendBandCubics,
  trendBandPath,
  trendBridgeCubic,
  trendCubicPath,
  trendBridgePath,
  trendCubicYExtent,
  type TrendBandBoundary,
  type TrendCurvePoint,
} from "./trend-gap-curve";

type P = TrendCurvePoint;

/** 픽셀 좌표 — 주 간격 40px, 값은 아래로 갈수록 커지는 SVG y. */
const px = (i: number, y: number): P => ({ x: 40 * i, y });

/** 실측 픽스처용 — x 를 화면 픽셀 그대로 쓴다(주 간격 98px). */
const px2 = (x: number, y: number): P => ({ x, y });

/**
 * d3 의 곡선 출력을 **반올림 없이** 받아 적는 컨텍스트.
 * (`d3-path` 는 문자열로 낼 때 소수 3자리로 반올림한다 — 그 오차에 가려지면
 * "정확히 같다"를 주장할 수 없다. 그래서 path 문자열이 아니라 콜백을 본다.)
 */
interface Seg {
  cmd: "M" | "L" | "C";
  args: number[];
}
function recordMonotone(points: ReadonlyArray<P | null>): Seg[] {
  const segs: Seg[] = [];
  const ctx = {
    moveTo: (x: number, y: number) => segs.push({ cmd: "M", args: [x, y] }),
    lineTo: (x: number, y: number) => segs.push({ cmd: "L", args: [x, y] }),
    closePath: () => {},
    bezierCurveTo: (...a: number[]) => segs.push({ cmd: "C", args: a }),
  };
  const gen = d3Line<P | null>()
    .x((p) => p!.x)
    .y((p) => p!.y)
    .defined((p) => p != null)
    .curve(curveMonotoneX)
    // @ts-expect-error 최소 CanvasPathMethods 구현 — d3 는 이 4개만 부른다.
    .context(ctx);
  gen(points as P[]);
  return segs;
}

/** 런의 마지막 세그먼트의 두 번째 제어점(= 런 끝 접선의 관측치). */
function lastControl2(segs: Seg[]): P {
  const last = segs[segs.length - 1];
  if (last.cmd !== "C") throw new Error(`직선으로 끝났다(${last.cmd})`);
  return { x: last.args[2], y: last.args[3] };
}

/** 첫 곡선 세그먼트의 첫 제어점(= 런 시작 접선의 관측치). */
function firstControl1(segs: Seg[]): P {
  const first = segs.find((s) => s.cmd === "C");
  if (!first) throw new Error("곡선 세그먼트가 없다");
  return { x: first.args[0], y: first.args[1] };
}

describe("d3 curveMonotoneX 포팅 충실도", () => {
  // 본선: 0..2 실측 → 3 결측(갭) → 4..6 실측.
  const LEFT: P[] = [px(0, 200), px(1, 150), px(2, 140)];
  const RIGHT: P[] = [px(4, 90), px(5, 60), px(6, 58)];

  it("런 끝 접선이 d3 가 실제로 그린 제어점과 일치한다", () => {
    const c2 = lastControl2(recordMonotone(LEFT));
    const p0 = LEFT[LEFT.length - 1];
    const p1 = LEFT[LEFT.length - 2];
    const dx = (p0.x - p1.x) / 3;
    // d3: c2 = (x1 - dx, y1 - dx * t_end)
    const observed = (p0.y - c2.y) / dx;
    expect(monotoneEndTangent(LEFT, NaN)).toBeCloseTo(observed, 12);
  });

  it("런 시작 접선이 d3 가 실제로 그린 제어점과 일치한다", () => {
    const c1 = firstControl1(recordMonotone(RIGHT));
    const p0 = RIGHT[0];
    const dx = (RIGHT[1].x - p0.x) / 3;
    // d3: c1 = (x0 + dx, y0 + dx * t_start)
    const observed = (c1.y - p0.y) / dx;
    expect(monotoneStartTangent(RIGHT, NaN)).toBeCloseTo(observed, 12);
  });

  it("2점 런은 d3 가 직선(lineTo)으로 그린다 — 접선은 시컨트", () => {
    const two: P[] = [px(0, 100), px(1, 60)];
    expect(recordMonotone(two).map((s) => s.cmd)).toEqual(["M", "L"]);
    expect(monotoneEndTangent(two, NaN)).toBeCloseTo((60 - 100) / 40, 12);
    expect(monotoneStartTangent(two, NaN)).toBeCloseTo((60 - 100) / 40, 12);
  });

  it("1점 런에는 방향이 없다 — fallback 을 쓴다", () => {
    expect(monotoneEndTangent([px(0, 10)], 0.25)).toBe(0.25);
    expect(monotoneStartTangent([], 0.25)).toBe(0.25);
  });

  it("보조선의 이음매 접선이 본선의 끝 접선과 **정확히** 같다 (꺾임 0)", () => {
    const cubic = trendBridgeCubic(LEFT, RIGHT)!;
    expect(cubic.tangentScale).toBe(1); // 갭 1칸 — 리미터 미개입

    // 왼쪽: 본선이 prev 에서 끝날 때의 접선.
    const c2 = lastControl2(recordMonotone(LEFT));
    const dxL = (LEFT[2].x - LEFT[1].x) / 3;
    const mainEnd = (LEFT[2].y - c2.y) / dxL;
    expect(cubic.m0).toBeCloseTo(mainEnd, 12);

    // 오른쪽: 본선이 next 에서 시작할 때의 접선.
    const c1 = firstControl1(recordMonotone(RIGHT));
    const dxR = (RIGHT[1].x - RIGHT[0].x) / 3;
    const mainStart = (c1.y - RIGHT[0].y) / dxR;
    expect(cubic.m1).toBeCloseTo(mainStart, 12);
  });

  it('"connectNulls 였다면" 곡선(A 접근)과는 다르다 — 그쪽은 이음매가 튄다', () => {
    // 같은 데이터를 이어 붙여 d3 에게 통째로 그리게 하면(=A 접근), 갭 창의 시작
    // 접선은 slope3 라 본선의 slope2 와 다르다. 그 차이가 이 수정의 이유다.
    const joined = recordMonotone([...LEFT, ...RIGHT]);
    // LEFT 3점 + RIGHT 3점 → M + C×5. 갭 구간은 3번째 C.
    const gapSeg = joined.filter((s) => s.cmd === "C")[2];
    const dx = (RIGHT[0].x - LEFT[2].x) / 3;
    const joinedTangent = (gapSeg.args[1] - LEFT[2].y) / dx;
    const cubic = trendBridgeCubic(LEFT, RIGHT)!;
    // 이음매에서의 접선 차이(픽셀/픽셀). 제어점으로 환산하면 아래 px 만큼 벌어진다.
    const kinkPx = Math.abs(joinedTangent - cubic.m0) * dx;
    expect(kinkPx).toBeGreaterThan(1);
  });
});

describe("trendBridgeCubic / trendBridgePath", () => {
  const LEFT: P[] = [px(0, 200), px(1, 150), px(2, 140)];
  const RIGHT: P[] = [px(4, 90), px(5, 60), px(6, 58)];

  it("직선이 아니다 — 제어점이 끝점을 잇는 직선 위에 있지 않다", () => {
    const c = trendBridgeCubic(LEFT, RIGHT)!;
    const onLine = (p: P) =>
      c.p0.y + ((p.x - c.p0.x) * (c.p1.y - c.p0.y)) / (c.p1.x - c.p0.x);
    expect(Math.abs(c.c1.y - onLine(c.c1))).toBeGreaterThan(1);
    expect(Math.abs(c.c2.y - onLine(c.c2))).toBeGreaterThan(1);
  });

  it("양 끝점은 이웃 실측 좌표와 **정확히** 같다", () => {
    const c = trendBridgeCubic(LEFT, RIGHT)!;
    expect(c.p0).toEqual({ x: 80, y: 140 });
    expect(c.p1).toEqual({ x: 160, y: 90 });
    const path = trendBridgePath(LEFT, RIGHT)!;
    expect(path.startsWith("M80,140")).toBe(true);
    expect(path.endsWith(",160,90")).toBe(true);
    expect(path).toContain("C");
  });

  it("제어점 x 는 구간을 3등분한다(d3 와 같은 배치)", () => {
    const c = trendBridgeCubic(LEFT, RIGHT)!;
    expect(c.c1.x).toBeCloseTo(80 + 80 / 3, 9);
    expect(c.c2.x).toBeCloseTo(160 - 80 / 3, 9);
  });

  it("양쪽이 완전히 평평하면 직선이 된다 — 없던 굴곡을 만들지 않는다", () => {
    const flatL: P[] = [px(0, 100), px(1, 100), px(2, 100)];
    const flatR: P[] = [px(4, 100), px(5, 100), px(6, 100)];
    const c = trendBridgeCubic(flatL, flatR)!;
    expect(c.c1.y).toBe(100);
    expect(c.c2.y).toBe(100);
  });

  it("이웃이 하나뿐이면(양옆 1점) 시컨트 직선으로 물러선다", () => {
    const c = trendBridgeCubic([px(2, 140)], [px(4, 90)])!;
    const s = (90 - 140) / 80;
    expect(c.m0).toBeCloseTo(s, 12);
    expect(c.m1).toBeCloseTo(s, 12);
  });

  it("이을 이웃이 없으면 null — 축 끝 갭은 종전대로 끊어 둔다", () => {
    expect(trendBridgeCubic([], RIGHT)).toBeNull();
    expect(trendBridgeCubic(LEFT, [])).toBeNull();
    expect(trendBridgePath([], [])).toBeNull();
  });

  it("갭이 넓으면 리미터가 부풀기를 막는다 — 좁은 갭에서는 개입하지 않는다", () => {
    // 갭 1칸(x 2칸 폭) — 개입 없음.
    expect(trendBridgeCubic(LEFT, RIGHT)!.tangentScale).toBe(1);
    // 갭 2칸(x 3칸 폭) — 여기까지도 개입 없음(본선 접선 그대로).
    expect(trendBridgeCubic(LEFT, [px(5, 90), px(6, 60), px(7, 58)])!.tangentScale).toBe(1);
    // 갭 4칸(x 5칸 폭) — 같은 접선이면 제어점이 2.5배로 벌어진다 → 축소.
    const farRight: P[] = [px(7, 90), px(8, 60), px(9, 58)];
    const wide = trendBridgeCubic(LEFT, farRight)!;
    expect(wide.tangentScale).toBeLessThan(1);
    // 축소해도 방향(부호)은 그대로 — 이음매가 반대로 꺾이지 않는다.
    const narrow = trendBridgeCubic(LEFT, RIGHT)!;
    expect(Math.sign(wide.m0)).toBe(Math.sign(narrow.m0));
    expect(Math.sign(wide.m1)).toBe(Math.sign(narrow.m1));
  });
});

describe("오버슛 리미터 — 없던 봉우리를 만들지 않는다", () => {
  /**
   * 실데이터 재현(2026-09-11 프리뷰 실측, 인용 차트 `genesis.com`):
   * 8/17 ≈10,000 → 8/31 ≈5,300 인데 갭 안에서 ≈12,000 봉우리가 솟았다.
   * 픽셀로 옮기면 "왼쪽 런이 가파르게 올라오다가(=y 급감) 오른쪽은 낮고 평평" 이다.
   */
  const STEEP_L: P[] = [px(0, 190), px(1, 150), px(2, 40)];
  const FLAT_R: P[] = [px(4, 120), px(5, 125), px(6, 128)];
  /** 무영향 대조군 — 위 describe 들과 같은 단조 픽스처. */
  const MONO_L: P[] = [px(0, 200), px(1, 150), px(2, 140)];
  const MONO_R: P[] = [px(4, 90), px(5, 60), px(6, 58)];

  /** 3차 베지어 y(t) 를 촘촘히 훑어 얻은 극값 — 해석해의 독립 검산용. */
  function sampledExtent(c: {
    p0: P;
    c1: P;
    c2: P;
    p1: P;
  }): { min: number; max: number } {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i <= 20000; i += 1) {
      const t = i / 20000;
      const u = 1 - t;
      const y =
        u * u * u * c.p0.y +
        3 * u * u * t * c.c1.y +
        3 * u * t * t * c.c2.y +
        t * t * t * c.p1.y;
      if (y < min) min = y;
      if (y > max) max = y;
    }
    return { min, max };
  }

  it("해석적 극값이 촘촘한 샘플링과 일치한다", () => {
    const c = trendBridgeCubic(STEEP_L, FLAT_R)!;
    const a = trendCubicYExtent(c.p0.y, c.c1.y, c.c2.y, c.p1.y);
    const s = sampledExtent(c);
    expect(a.min).toBeCloseTo(s.min, 4);
    expect(a.max).toBeCloseTo(s.max, 4);
  });

  it("genesis 케이스: 곡선이 양 끝점 y 범위(±스팬 5%) 안에 머문다", () => {
    const c = trendBridgeCubic(STEEP_L, FLAT_R)!;
    const lo = Math.min(c.p0.y, c.p1.y);
    const hi = Math.max(c.p0.y, c.p1.y);
    const tol = 0.05 * (hi - lo);
    const e = trendCubicYExtent(c.p0.y, c.c1.y, c.c2.y, c.p1.y);
    expect(e.min).toBeGreaterThanOrEqual(lo - tol - 1e-6);
    expect(e.max).toBeLessThanOrEqual(hi + tol + 1e-6);
    // 개입했다는 사실 자체도 고정한다 — 종전(리미터 전)에는 `1` 이었다.
    expect(c.tangentScale).toBeLessThan(1);
    expect(c.tangentScale).toBeGreaterThan(0);
  });

  it("양쪽 접선을 **같은 비율**로 줄인다 — 이음매 방향은 안 뒤집힌다", () => {
    const c = trendBridgeCubic(STEEP_L, FLAT_R)!;
    const rawM0 = monotoneEndTangent(STEEP_L, NaN);
    const rawM1 = monotoneStartTangent(FLAT_R, NaN);
    expect(c.m0 / rawM0).toBeCloseTo(c.tangentScale, 12);
    expect(c.m1 / rawM1).toBeCloseTo(c.tangentScale, 12);
    expect(Math.sign(c.m0)).toBe(Math.sign(rawM0));
    expect(Math.sign(c.m1)).toBe(Math.sign(rawM1));
  });

  it("단조 구간은 손대지 않는다 — tangentScale 1, 접선 오차 0", () => {
    const c = trendBridgeCubic(MONO_L, MONO_R)!;
    expect(c.tangentScale).toBe(1);
    expect(c.m0).toBe(monotoneEndTangent(MONO_L, NaN));
    expect(c.m1).toBe(monotoneStartTangent(MONO_R, NaN));
  });

  it("대칭 꺾임: 플롯 높이를 알면 그 5% 까지만 허용한다", () => {
    // p0 · p1 이 같은 높이라 끝점 스팬은 0 — 플롯 높이가 유일한 여유의 근거다.
    const downL: P[] = [px(0, 20), px(1, 60), px(2, 100)];
    const upR: P[] = [px(4, 100), px(5, 60), px(6, 20)];
    const c = trendBridgeCubic(downL, upR, { plotSpan: 200 })!;
    const e = trendCubicYExtent(c.p0.y, c.c1.y, c.c2.y, c.p1.y);
    expect(e.max).toBeLessThanOrEqual(100 + 0.05 * 200 + 1e-6);
    expect(e.min).toBeGreaterThanOrEqual(100 - 0.05 * 200 - 1e-6);
    expect(c.tangentScale).toBeLessThan(1);
    // 같은 배율로 줄었는지(대칭이므로 |m0| == |m1|).
    expect(Math.abs(c.m0)).toBeCloseTo(Math.abs(c.m1), 12);
  });

  it("플롯 높이를 주면 여유가 늘어 개입이 줄어든다", () => {
    const tight = trendBridgeCubic(STEEP_L, FLAT_R)!;
    const loose = trendBridgeCubic(STEEP_L, FLAT_R, { plotSpan: 2000 })!;
    expect(loose.tangentScale).toBeGreaterThan(tight.tangentScale);
    expect(loose.tangentScale).toBe(1);
  });

  it("path 도 같은 리미터를 통과한다", () => {
    const d = trendBridgePath(STEEP_L, FLAT_R)!;
    const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const e = trendCubicYExtent(n[1], n[3], n[5], n[7]);
    const lo = Math.min(n[1], n[7]);
    const hi = Math.max(n[1], n[7]);
    const tol = 0.05 * (hi - lo);
    expect(e.min).toBeGreaterThanOrEqual(lo - tol - 0.01);
    expect(e.max).toBeLessThanOrEqual(hi + tol + 0.01);
  });
});

// ── 누적 영역용 밴드 (상단·하단 두 경계 사이를 채운 닫힌 도형) ──────────────

describe("trendBandCubics / trendBandPath — 갭 창을 채우는 닫힌 밴드", () => {
  // 아래→위 3개 경계. 완만해서 리미터·사다리 어디에도 안 걸린다.
  const base: P[] = [px(0, 200), px(1, 200), px(2, 200)];
  const baseR: P[] = [px(4, 200), px(5, 200), px(6, 200)];
  const midL: P[] = [px(0, 180), px(1, 170), px(2, 160)];
  const midR: P[] = [px(4, 150), px(5, 140), px(6, 130)];
  const topL: P[] = [px(0, 120), px(1, 100), px(2, 90)];
  const topR: P[] = [px(4, 70), px(5, 60), px(6, 55)];
  const BOUNDS = [
    { left: base, right: baseR },
    { left: midL, right: midR },
    { left: topL, right: topR },
  ];

  it("경계 수만큼 곡선이 나오고, 완만한 구성비에서는 본선 접선을 그대로 쓴다", () => {
    const cs = trendBandCubics(BOUNDS)!;
    expect(cs).toHaveLength(3);
    // 리미터가 안 걸린 경계는 `trendBridgeCubic` 과 완전히 같다.
    expect(cs[1]).toEqual(trendBridgeCubic(midL, midR));
    expect(cs[2]).toEqual(trendBridgeCubic(topL, topR));
  });

  it("path 는 상단 곡선 → 하단 끝점 → 하단 곡선 역방향 → Z", () => {
    const cs = trendBandCubics(BOUNDS)!;
    const d = trendBandPath(cs[2], cs[1]);
    expect(d).toMatch(/^M[-\d.,]+C[-\d.,]+L[-\d.,]+C[-\d.,]+Z$/);
    const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    expect(n).toHaveLength(16);
    const up = cs[2];
    const lo = cs[1];
    // path 문자열은 소수 3자리로 반올림된다(round) — 비교도 같은 자리에서.
    const r = (v: number) => Math.round(v * 1000) / 1000;
    const at = (i: number) => [n[i], n[i + 1]];
    expect(at(0)).toEqual([r(up.p0.x), r(up.p0.y)]);
    expect(at(6)).toEqual([r(up.p1.x), r(up.p1.y)]);
    // 하단은 **역방향**: p1 → c2 → c1 → p0
    expect(at(8)).toEqual([r(lo.p1.x), r(lo.p1.y)]);
    expect(at(10)).toEqual([r(lo.c2.x), r(lo.c2.y)]);
    expect(at(12)).toEqual([r(lo.c1.x), r(lo.c1.y)]);
    expect(at(14)).toEqual([r(lo.p0.x), r(lo.p0.y)]);
  });

  it("밴드의 상단 조각은 그 경계 본선 곡선과 문자 그대로 같다", () => {
    const cs = trendBandCubics(BOUNDS)!;
    expect(trendBandPath(cs[2], cs[1]).startsWith(trendCubicPath(cs[2]))).toBe(true);
  });

  it("경계가 겹쳐도(높이 0 밴드) 닫힌 path 를 낸다", () => {
    const cs = trendBandCubics(BOUNDS)!;
    expect(trendBandPath(cs[1], cs[1]).endsWith("Z")).toBe(true);
  });

  it("한쪽 이웃이 없으면 밴드가 없다 (축 끝 갭)", () => {
    expect(trendBandCubics([{ left: base, right: [] }, { left: midL, right: midR }])).toBeNull();
    expect(trendBandCubics([{ left: [], right: baseR }, { left: midL, right: midR }])).toBeNull();
    expect(trendBandCubics([{ left: base, right: baseR }])).toBeNull();
  });

  it("경계가 갭 창 안에서 교차하려 하면 접선을 조여 순서를 지킨다", () => {
    // 아래 경계가 V 자로 되돌아오는 적대 케이스 — 본선 접선(slope2)을 그대로 쓰면
    // 제어점이 위 경계(수평)를 뚫고 올라간다.
    const flat: P[] = [px(0, 40), px(1, 40)];
    const flatR: P[] = [px(3, 40), px(4, 40)];
    const vL: P[] = [px(0, 120), px(1, 40)];
    const vR: P[] = [px(3, 120), px(4, 40)];
    const naive = trendBridgeCubic(vL, vR)!;
    expect(naive.c1.y).toBeLessThan(40); // 위 경계(y=40)를 넘어간다 = 교차
    const cs = trendBandCubics([
      { left: vL, right: vR },
      { left: flat, right: flatR },
    ])!;
    const y = (c: (typeof cs)[number], t: number) => {
      const u = 1 - t;
      return u * u * u * c.p0.y + 3 * u * u * t * c.c1.y + 3 * u * t * t * c.c2.y + t * t * t * c.p1.y;
    };
    for (let i = 0; i <= 40; i += 1) {
      const t = i / 40;
      expect(y(cs[0], t)).toBeGreaterThanOrEqual(y(cs[1], t) - 1e-6);
    }
  });
});

// ── 밴드 접선 정책 (보조선과 통일 — C1 우선, 리미터는 필요할 때만) ────────────

describe("trendBandCubics — 본선 접선(C1)을 지키고 리미터는 필요할 때만 개입한다", () => {
  /**
   * **실측 픽스처.** 2026-09-11 프리뷰 실측 — 인용 > 출처 카테고리 구성 추이(글로벌·ko),
   * 13 카테고리 × 11주, 8/24 주가 수집 오류 갭. 값은 화면 픽셀(축 스케일 통과 후)이고
   * 갭에 맞닿은 부분만 잘라 왔다: 왼쪽 런 꼬리 3점(x 534·632·730) + 오른쪽 런 머리
   * 2점(x 926·1024). 첫 줄은 스택 바닥(값 0 → y 258 고정)이고 플롯 높이는 250px(y 8~258).
   * 출처: `(내부 작업 파일)` 의 `geo.areas[].d`.
   */
  const REAL_STACK_Y: number[][] = [
    [258, 258, 258, 258, 258], // 스택 바닥
    [222.881, 213.961, 212.536, 181.698, 171.797],
    [179.662, 164.552, 154.603, 134.773, 127.086],
    [136.304, 122.377, 114.497, 100.514, 93.52],
    [91.617, 87.838, 80.598, 65.327, 61.53],
    [74.359, 50.66, 45.721, 43.453, 41.472],
    [47.741, 39.621, 36.535, 31.712, 30.716],
    [35.995, 30.084, 29.881, 24.371, 22.306],
    [29.619, 23.161, 22.716, 18.345, 17.411],
    [26.001, 18.75, 17.438, 14.251, 13.651],
    [20.674, 12.616, 12.083, 10.774, 10.653],
    [19.988, 11.087, 9.201, 9.255, 9.199],
    [8.179, 8.362, 8.482, 8.353, 8.326],
    [8, 8, 8, 8, 8],
  ];
  const REAL_PLOT_SPAN = 250;
  const REAL_OPTS = { plotSpan: REAL_PLOT_SPAN, yTop: 8, yBottom: 258 };
  const REAL: TrendBandBoundary[] = REAL_STACK_Y.map((ys) => ({
    left: [px2(534, ys[0]), px2(632, ys[1]), px2(730, ys[2])],
    right: [px2(926, ys[3]), px2(1024, ys[4])],
  }));

  const deg = (m: number) => (Math.atan(m) * 180) / Math.PI;

  it("실측 13밴드: 리미터 개입 0 — 경계마다 보조선과 **같은** 곡선이 나온다", () => {
    const cs = trendBandCubics(REAL, REAL_OPTS)!;
    expect(cs).toHaveLength(REAL.length);
    expect(cs.map((c) => c.tangentScale)).toEqual(REAL.map(() => 1));
    // 경계 하나만 따로 이은 것(=라인 차트 보조선)과 문자 그대로 같다.
    cs.forEach((c, i) => {
      expect(c).toEqual(trendBridgeCubic(REAL[i].left, REAL[i].right, REAL_OPTS));
    });
  });

  it("실측 13밴드: 이음매가 C1 — 본선 접선이 한 치도 안 깎인다", () => {
    const cs = trendBandCubics(REAL, REAL_OPTS)!;
    cs.forEach((c, i) => {
      expect(c.m0).toBe(monotoneEndTangent(REAL[i].left, NaN));
      expect(c.m1).toBe(monotoneStartTangent(REAL[i].right, NaN));
    });
    // 종전 규칙(monotoneClamped 선적용)이 꺾었던 두 경계 — 프리뷰 실측 각도차 0.55°·0.06°
    // (`geo.seams[].angStart`). 지금은 정확히 0 이어야 한다.
    for (const i of [11, 12]) {
      const raw = monotoneEndTangent(REAL[i].left, NaN);
      expect(Math.abs(deg(cs[i].m0) - deg(raw))).toBeLessThan(1e-9);
    }
  });

  it("실측 13밴드: 갭 창 안에서 경계가 교차하지 않는다 (1,001 표본 + 해석적 판정)", () => {
    const cs = trendBandCubics(REAL, REAL_OPTS)!;
    const yAt = (c: (typeof cs)[number], t: number) => {
      const u = 1 - t;
      return u * u * u * c.p0.y + 3 * u * u * t * c.c1.y + 3 * u * t * t * c.c2.y + t * t * t * c.p1.y;
    };
    let worst = -Infinity;
    for (let k = 0; k + 1 < cs.length; k += 1) {
      // 두 곡선은 같은 t 로 매개화되므로 **차도 3차 베지어** — 극값을 해석적으로 본다.
      const e = trendCubicYExtent(
        cs[k].p0.y - cs[k + 1].p0.y,
        cs[k].c1.y - cs[k + 1].c1.y,
        cs[k].c2.y - cs[k + 1].c2.y,
        cs[k].p1.y - cs[k + 1].p1.y,
      );
      expect(e.min).toBeGreaterThanOrEqual(0); // SVG y: 아래 경계가 위 경계보다 크거나 같다
      for (let i = 0; i <= 1000; i += 1) {
        const t = i / 1000;
        worst = Math.max(worst, yAt(cs[k + 1], t) - yAt(cs[k], t));
      }
    }
    expect(worst).toBeLessThanOrEqual(0);
  });

  /**
   * **단일 카테고리 absolute 모드**(`?source=Official (HMG)`) 재현.
   * `single-Official_HMG_.png` 판독: 8/03 ≈9,000 · 8/10 ≈16,000 · 8/17 ≈33,000 →
   * 8/24 갭 → 8/31 ≈34,000 · 9/07 ≈31,500. y 축 0~36,000 을 플롯 250px(8~258)에 실었다.
   */
  const V = (v: number) => 258 - 250 * (v / 36000);
  const STEEP: TrendBandBoundary[] = [
    { left: [px2(534, 258), px2(632, 258), px2(730, 258)], right: [px2(926, 258), px2(1024, 258)] },
    {
      left: [px2(534, V(9000)), px2(632, V(16000)), px2(730, V(33000))],
      right: [px2(926, V(34000)), px2(1024, V(31500))],
    },
  ];

  it("단일 카테고리 급경사: 이음매를 꺾는 것은 **오버슛 리미터뿐**이고 종전보다 절반 이하다", () => {
    const cs = trendBandCubics(STEEP, REAL_OPTS)!;
    const raw = monotoneEndTangent(STEEP[1].left, NaN);
    const seam = Math.abs(deg(cs[1].m0) - deg(raw));
    // 종전(monotoneClamped 선적용)은 접선을 통째로 0 으로 눌러 **48.04°** 를 꺾었다
    // (프리뷰 실측 46.9°). 이제 꺾임은 오버슛 리미터가 필요한 만큼만 낸다 — 25.09°.
    // ⚠️ 여기서 0° 가 못 되는 것은 정상이다: 이 기하는 C1 을 지키면 갭 안에서 값 ≈39,500
    // (양 끝 33,000·34,000 을 5,500 넘는, 축 밖의 봉우리)을 주장하게 된다. 보조선도
    // 같은 상황에서 같은 선택을 한다(`fix(trend): 보조선 오버슛 리미터`).
    expect(seam).toBeLessThan(48.04);
    expect(seam).toBeCloseTo(25.09, 1);
    // 그리고 그 개입은 **양쪽 접선 동일 배율**이라 방향이 뒤집히지 않는다.
    expect(cs[1].tangentScale).toBeGreaterThan(0);
    expect(cs[1].tangentScale).toBeLessThan(1);
    expect(Math.sign(cs[1].m0)).toBe(Math.sign(raw));
    // 리미터가 잡는 것: 리미터 없는 C1 은 y 축 위(값 ≈39,500)로 솟는다 — 없던 봉우리.
    const e = trendCubicYExtent(cs[1].p0.y, cs[1].c1.y, cs[1].c2.y, cs[1].p1.y);
    const lo = Math.min(cs[1].p0.y, cs[1].p1.y);
    const hi = Math.max(cs[1].p0.y, cs[1].p1.y);
    const tol = 0.05 * Math.max(hi - lo, REAL_PLOT_SPAN);
    expect(e.min).toBeGreaterThanOrEqual(lo - tol - 1e-6);
    expect(e.max).toBeLessThanOrEqual(hi + tol + 1e-6);
  });

  it("급경사라도 이웃이 방향을 이으면 접선은 그대로다 — 가파름 자체는 개입 사유가 아니다", () => {
    const cont: TrendBandBoundary[] = [
      { left: [px2(534, 258), px2(632, 258), px2(730, 258)], right: [px2(926, 258), px2(1024, 258)] },
      {
        left: [px2(534, V(9000)), px2(632, V(16000)), px2(730, V(24000))],
        right: [px2(926, V(31000)), px2(1024, V(33000))],
      },
    ];
    const cs = trendBandCubics(cont, REAL_OPTS)!;
    expect(cs[1].tangentScale).toBe(1);
    expect(cs[1].m0).toBe(monotoneEndTangent(cont[1].left, NaN));
    expect(cs[1].m1).toBe(monotoneStartTangent(cont[1].right, NaN));
  });

  it("정규화 축 상한(=1)·바닥(=0)을 넘지 않는다 — 같은 리미터가 함께 본다", () => {
    // 갭 직전 주의 합이 0 이라 맨 위 경계가 바닥까지 내려왔다 → C1 이면 갭 안에서
    // 축 상단(y 8)을 뚫고 올라간다.
    const top = { left: [px2(534, 200), px2(632, 100), px2(730, 20)], right: [px2(926, 12), px2(1024, 60)] };
    const bounds: TrendBandBoundary[] = [
      { left: [px2(534, 258), px2(632, 258), px2(730, 258)], right: [px2(926, 258), px2(1024, 258)] },
      top,
    ];
    const naive = trendBridgeCubic(top.left, top.right, { plotSpan: 250 })!;
    const naiveE = trendCubicYExtent(naive.p0.y, naive.c1.y, naive.c2.y, naive.p1.y);
    expect(naiveE.min).toBeLessThan(8); // 축 상단을 넘는다 = 구성비 > 100%
    const cs = trendBandCubics(bounds, { plotSpan: 250, yTop: 8, yBottom: 258 })!;
    const e = trendCubicYExtent(cs[1].p0.y, cs[1].c1.y, cs[1].c2.y, cs[1].p1.y);
    // 허용 오차는 리미터의 서브픽셀 여유(BAND_EPS = 0.01px)와 같다.
    expect(e.min).toBeGreaterThanOrEqual(8 - 0.011);
    expect(e.max).toBeLessThanOrEqual(258 + 0.011);
    expect(cs[1].tangentScale).toBeLessThan(1);
  });
});
