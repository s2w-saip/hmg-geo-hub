"use client";

// 경쟁사 테이블의 회차 스파크라인 — 순수 SVG. recharts 를 행마다 마운트하면
// 100행에서 INP 가 무너지고, ResponsiveContainer 가 행 높이를 재계산하며 표가
// 흔들린다. 여기서 필요한 건 "모양"뿐이라 폴리라인 하나로 충분하다.
//
// ⚠️ 결측 회차는 **선을 끊는다**(스펙 SHALL — 직전값 연결 금지). 그래서 하나의
// polyline 이 아니라 연속 구간마다 polyline 을 나눠 그린다.
//
// 2026-09-11 (hmg-geo-verifier 지적): y 가 viewBox 밖으로 나가 선이 잘렸다.
// "AI 우선 노출도" 표가 `worst + 1 - v` 로 순위를 뒤집어 넘겼는데, `worst` 는
// **최신 스냅샷**의 최악 순위라 그보다 나빴던 **과거 회차**가 들어오면 음수가 됐다
// (프로덕션 10행 전부 4점 중 1점이 viewBox 밖 — 예: BMW y=46.6 > H-PAD=32).
// = 축의 모수(최신 스냅샷)와 그리는 값의 모수(과거 회차)가 달랐다.
//
// 축 선택지는 둘이다:
//   · max     — 0 에 고정된 축(비율 지표. **기존 계약이자 기본값**, 산식도 원문 그대로)
//   · domain  — **호출부가 준 명시 도메인** `[from, to]`. `invert` 로 작은 값이 위.
//
// 왜 행별 자동 range 가 아니라 명시 domain 인가 (2026-09-11 2차 검증에서 설계 변경):
// 행마다 자기 관측 범위로 정규화하면 **모든 행이 [PAD, H-PAD] 를 꽉 채워** 진폭
// 정보가 사라진다(실브라우저 10행 전부 y 가 2 와 32 에서 시작·끝나고 모양이 비슷해졌다).
// 순위 표는 행 간 진폭 비교가 의미 있는 지면이므로, 호출부가 **표시 행 전체**의 값에서
// 도메인을 한 번 잡아 모든 행에 같은 축을 준다. 도메인이 실제로 그리는 값에서 나오므로
// 모수 불일치(음수·이탈)가 원천적으로 불가능하고, 0.1위짜리 잡음은 자연히 납작해진다.
// 그래도 방어적으로 [PAD, H-PAD] 로 clamp 한다.

export interface SparkScaleOptions {
  /** 0 기준 축의 상한(기본 = 관측 최대). `domain` 이 있으면 쓰이지 않는다. */
  max?: number;
  /**
   * 명시 y 도메인 `[from, to]` — 여러 스파크가 **같은 축**을 써야 할 때 호출부가 준다.
   * 폭이 0 이하면(표시 값이 전부 같음) 중앙 수평선.
   */
  domain?: readonly [number, number];
  /** 값이 작을수록 위로(순위 등). `domain` 모드에서만 의미가 있다. */
  invert?: boolean;
}

export interface SparkLineProps extends SparkScaleOptions {
  /** 회차 순서대로. null = 그 회차에 측정 없음. */
  values: (number | null)[];
  color: string;
  label: string;
  /** 선 아래 영역 채움(피그마 경쟁사 표 스파크라인). 결측 구간은 채우지 않는다. */
  area?: boolean;
}

// 피그마 327:116 경쟁사 표 스파크라인 실측 86×34.
const W = 86;
const H = 34;
const PAD = 2;
export const SPARK_BOX = { w: W, h: H, pad: PAD } as const;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 연속(non-null) 구간으로 자른다 — 각 구간이 하나의 polyline. */
export function sparkSegments(values: (number | null)[]): Array<Array<[number, number]>> {
  const segs: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (cur.length) segs.push(cur);
      cur = [];
      return;
    }
    cur.push([i, v]);
  });
  if (cur.length) segs.push(cur);
  return segs;
}

/**
 * 값 → y(px) 변환기. **반환값은 항상 [PAD, H-PAD] 안**이다.
 * `measured` 는 그릴 점들(결측 제외) — 도메인은 이것만 보고 정한다.
 */
export function sparkYScale(
  measured: number[],
  { max, domain, invert = false }: SparkScaleOptions = {},
): (v: number) => number {
  if (domain) {
    const inner = H - 2 * PAD;
    const [from, to] = domain;
    const span = to - from;
    // 폭 0 이하(표시 값이 전부 같음) — 나눗셈 대신 **중앙 수평선**.
    if (!(span > 0)) return () => H / 2;
    return (v: number) => {
      const frac = (v - from) / span;
      return clamp(invert ? PAD + frac * inner : H - PAD - frac * inner, PAD, H - PAD);
    };
  }
  if (measured.length === 0) return () => H / 2;
  // ⚠️ 원문 산식을 **연산 순서까지 그대로** 둔다 — 재배열하면 ULP 수준이라도 값이
  // 달라져 "기존 계약 무변경"이 참이 아니게 된다(2026-09-11 검증자 지적 ③).
  const top = Math.max(max ?? 0, ...measured, 1);
  return (v: number) => clamp(H - PAD - ((H - 2 * PAD) * v) / top, PAD, H - PAD);
}

/** 그릴 점들의 좌표 — 구간마다 [x, y] 배열. 테스트가 SVG 파싱 없이 검사한다. */
export function sparkPoints(
  values: (number | null)[],
  opts: SparkScaleOptions = {},
): Array<Array<[number, number]>> {
  const measured = values.filter((v): v is number => v != null);
  const y = sparkYScale(measured, opts);
  const stepX = values.length > 1 ? (W - 2 * PAD) / (values.length - 1) : 0;
  return sparkSegments(values).map((seg) => seg.map(([i, v]) => [PAD + i * stepX, y(v)] as [number, number]));
}

export function SparkLine({ values, color, max, domain, invert, label, area = true }: SparkLineProps) {
  const measured = values.filter((v): v is number => v != null);
  if (measured.length === 0) {
    return <span className="text-[11px] text-muted-foreground">—</span>;
  }
  const segs = sparkPoints(values, { max, domain, invert });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[34px] w-[86px]" role="img" aria-label={label}>
      {segs.map((seg, i) =>
        seg.length === 1 ? (
          <circle key={i} cx={seg[0][0]} cy={seg[0][1]} r={1.6} fill={color} />
        ) : (
          <g key={i}>
            {area ? (
              <polygon
                fill={color}
                fillOpacity={0.12}
                points={[
                  `${seg[0][0]},${H - PAD}`,
                  ...seg.map(([x, y]) => `${x},${y}`),
                  `${seg[seg.length - 1][0]},${H - PAD}`,
                ].join(" ")}
              />
            ) : null}
            <polyline
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              points={seg.map(([x, y]) => `${x},${y}`).join(" ")}
            />
          </g>
        ),
      )}
    </svg>
  );
}
