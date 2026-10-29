import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KpiGauge } from "./kpi-gauge";
import { SPARK_BOX, SparkLine, sparkPoints, sparkSegments, sparkYScale } from "./spark-line";

// 게이지·스파크라인은 "값 없음"과 "0" 을 눈으로 구분시키는 것이 유일한 임무다.
// 그 규칙이 깨져도 화면은 그럴듯하게 보이므로(0% 게이지 = 정상적인 그림) 테스트로 고정한다.

describe("KpiGauge", () => {
  it("draws only the track when the value is null", () => {
    const html = renderToStaticMarkup(<KpiGauge pct={null} label="exposure" valueText="—" />);
    expect(html.match(/<path/g) ?? []).toHaveLength(1);
    expect(html).toContain("var(--color-ink-100)");
    expect(html).not.toContain("var(--color-brand-700)");
  });

  it("draws a zero-length fill for 0% (distinct from no measurement)", () => {
    const html = renderToStaticMarkup(<KpiGauge pct={0} label="exposure" valueText="0.0%" />);
    expect(html.match(/<path/g) ?? []).toHaveLength(2);
    expect(html).toContain("var(--color-brand-700)");
  });

  it("clamps out-of-range values instead of overdrawing the arc", () => {
    const over = renderToStaticMarkup(<KpiGauge pct={140} label="x" valueText="140%" />);
    const full = renderToStaticMarkup(<KpiGauge pct={100} label="x" valueText="100%" />);
    const dash = (h: string) => /stroke-dasharray="([^"]+)"/.exec(h)?.[1];
    expect(dash(over)).toBe(dash(full));
  });

  // 팔레트 정본은 globals.css `@theme` — 컴포넌트에 hex 가 있으면 재도색이 깨진다.
  it("uses theme tokens, never hex literals", () => {
    const html = renderToStaticMarkup(<KpiGauge pct={50} label="x" valueText="50%" />);
    expect(html).not.toMatch(/#[0-9A-Fa-f]{6}/);
  });
});

describe("sparkSegments", () => {
  // 스펙 SHALL: 결측 회차는 갭. 하나의 polyline 으로 이으면 직전값 연결과 같아진다.
  it("splits the line at every missing cycle", () => {
    expect(sparkSegments([1, 2, null, 4, 5])).toEqual([
      [
        [0, 1],
        [1, 2],
      ],
      [
        [3, 4],
        [4, 5],
      ],
    ]);
  });

  it("keeps a lone measured cycle as its own segment", () => {
    expect(sparkSegments([null, 7, null])).toEqual([[[1, 7]]]);
  });

  it("returns nothing when every cycle is missing", () => {
    expect(sparkSegments([null, null])).toEqual([]);
  });
});

describe("SparkLine", () => {
  it("renders one polyline per measured run, not one across the gap", () => {
    const html = renderToStaticMarkup(
      <SparkLine values={[10, 20, null, 40]} color="var(--color-brand-700)" label="Kia trend" />,
    );
    expect(html.match(/<polyline/g) ?? []).toHaveLength(1); // [10,20] 구간
    expect(html.match(/<circle/g) ?? []).toHaveLength(1); // [40] 단독 회차
  });

  it("falls back to an em dash when nothing was measured", () => {
    const html = renderToStaticMarkup(
      <SparkLine values={[null, null]} color="var(--color-brand-700)" label="Ghost trend" />,
    );
    expect(html).not.toContain("<svg");
    expect(html).toContain("—");
  });
});

// ── y 축 도메인 (2026-09-11 hmg-geo-verifier 지적) ────────────────────────────
// "AI 우선 노출도" 표가 `worst + 1 - v` 로 순위를 뒤집어 넘겼는데, `worst` 는 **최신
// 스냅샷**의 최악 순위라 그보다 나빴던 **과거 회차**가 음수로 들어왔다. 그 점의 y 가
// H-PAD(32)를 넘어 viewBox 아래로 잘렸고(프로덕션·프리뷰 10행 전부 4점 중 1점),
// 보이는 구간이 y 20.2~34 뿐이라 선이 행 아래에 눌려 보였다.
//
// 검증자 실측 재현 — BMW: 표시 y = [27.0, 46.6]. 종전 매핑(zero, top=worst=21)에서
// avgPosition 18.5 → 27.0, 32.2 → 46.57. 32.2 는 최신 worst 21 보다 나쁜 과거 회차다.
const H = SPARK_BOX.h;
const PAD = SPARK_BOX.pad;
const BMW_PAST = [null, null, 18.5, 32.2] as (number | null)[];
const flat = (segs: Array<Array<[number, number]>>) => segs.flat();
const ys = (segs: Array<Array<[number, number]>>) => flat(segs).map(([, y]) => Math.round(y * 100) / 100);

describe("sparkYScale · sparkPoints — viewBox 이탈 금지", () => {
  it("종전 매핑(zero · worst 기준)이 실제로 viewBox 밖을 찍었다 — 결함 재현", () => {
    // 회귀 대비 기준선: 이 값이 곧 검증자가 실측한 잘린 좌표다.
    const legacy = BMW_PAST.map((v) => (v == null ? null : 21 + 1 - v));
    const y = sparkYScale(legacy.filter((v): v is number => v != null), { max: 21 });
    // clamp 를 걷어낸 원식 — 이것이 종전에 SVG 로 나가던 값.
    const raw = (v: number) => H - PAD - ((H - 2 * PAD) * v) / 21;
    expect(Math.round(raw(21 + 1 - 18.5) * 10) / 10).toBe(27.0);
    expect(Math.round(raw(21 + 1 - 32.2) * 10) / 10).toBe(46.6);
    expect(raw(21 + 1 - 32.2)).toBeGreaterThan(H - PAD); // 하단 밖
    // 이제는 같은 입력이라도 clamp 가 마지막 방어선으로 잡는다.
    expect(y(21 + 1 - 32.2)).toBe(H - PAD);
  });

  it("공유 도메인 + invert 에서는 모든 점이 [PAD, H-PAD] 안에 있다", () => {
    const segs = sparkPoints(BMW_PAST, { domain: [18.5, 32.2], invert: true });
    const all = ys(segs);
    expect(all).toHaveLength(2);
    for (const y of all) {
      expect(y).toBeGreaterThanOrEqual(PAD);
      expect(y).toBeLessThanOrEqual(H - PAD);
    }
    // 도메인 양 끝값이 정확히 트랙 양 끝.
    expect(all).toEqual([PAD, H - PAD]);
  });

  it("순위는 낮을수록 위 — invert 방향 가드", () => {
    // 1위(좋음) → 위(작은 y), 30위(나쁨) → 아래(큰 y).
    const [seg] = sparkPoints([1, 12, 30], { domain: [1, 30], invert: true });
    expect(seg[0][1]).toBeLessThan(seg[1][1]);
    expect(seg[1][1]).toBeLessThan(seg[2][1]);
    // invert 없으면 반대(비율 지표: 클수록 위).
    const [asc] = sparkPoints([1, 12, 30], { domain: [1, 30] });
    expect(asc[0][1]).toBeGreaterThan(asc[2][1]);
  });

  it("도메인 폭이 0 이면 0 으로 나누지 않고 중앙 수평선", () => {
    // 표시 행 전체가 같은 값 → RankSection 이 [v, v] 를 준다.
    const [seg] = sparkPoints([19.4, 19.4, 19.4], { domain: [19.4, 19.4], invert: true });
    expect(seg.map(([, y]) => y)).toEqual([H / 2, H / 2, H / 2]);
  });

  it("공유 도메인은 행의 진폭 차이를 보존한다 — 행별 정규화 금지", () => {
    // 2026-09-11 검증자 2차 지적: 행마다 자기 [min,max] 로 정규화하면 **모든 행이**
    // 트랙을 꽉 채워(2↔32) 누가 더 많이 움직였는지가 사라진다.
    const shared = { domain: [16.7, 31.5] as const, invert: true };
    const wide = sparkPoints([16.7, 31.5, 19.4, 18.3], shared)[0].map(([, y]) => y);
    const narrow = sparkPoints([20.1, 20.4, 20.1, 19.7], shared)[0].map(([, y]) => y);
    const amp = (a: number[]) => Math.max(...a) - Math.min(...a);
    expect(amp(wide)).toBeCloseTo(H - 2 * PAD, 6); // 도메인 전폭을 쓰는 행
    expect(amp(narrow)).toBeLessThan(2); // 0.7위 변동은 납작하다
    // 같은 값은 어느 행에 있든 같은 y 로 간다(축이 하나라는 뜻).
    expect(sparkPoints([19.4], shared)[0][0][1]).toBe(wide[2]);
  });

  it("도메인 밖 값도 방어적으로 clamp 한다", () => {
    const yd = sparkYScale([], { domain: [10, 20], invert: true });
    expect(yd(5)).toBe(PAD); // 도메인보다 좋음 → 꼭대기
    expect(yd(99)).toBe(H - PAD); // 도메인보다 나쁨 → 바닥
  });

  it("기본(zero) 축은 옛 산식 그대로 — 0 기준 비율 지표의 계약 무변경", () => {
    // 경쟁사 표(점유율)는 max 없이 호출한다: 관측 최대가 꼭대기, 0 이 바닥.
    const [seg] = sparkPoints([0, 25, 50]);
    expect(seg[0][1]).toBe(H - PAD); // 0% = 바닥
    expect(seg[2][1]).toBe(PAD); // 최대 = 꼭대기
    // 연산 순서까지 원문과 같아야 한다 — 재배열하면 ULP 차이가 생긴다(검증자 지적 ③).
    const legacyY = (v: number, top: number) => H - PAD - ((H - 2 * PAD) * v) / top;
    const vals = [0, 7.3, 12.9, 25, 33.333333, 50];
    const y = sparkYScale(vals);
    for (const v of vals) expect(y(v)).toBe(legacyY(v, 50)); // toBe = 비트 동일
  });

  it("음수·초과값이 들어와도 방어적으로 clamp 한다", () => {
    const yz = sparkYScale([5], { max: 10 });
    expect(yz(-100)).toBe(H - PAD);
    expect(yz(1e6)).toBe(PAD);
  });
});
