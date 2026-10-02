/**
 * **기간 모드 판정의 단일 리졸버.**
 *
 * "이 요청은 기간을 건 것인가 / 그 기간을 누적으로 읽는가"라는 한 명제가 네 벌로
 * 흩어져 있었다:
 *
 * | 자리 | 식 |
 * | --- | --- |
 * | `scope-aggregates::cumulativeMode(f, allRuns)` | `cumulative && allRuns!==true && (from‖to)` |
 * | `summary/read/gate::mirrorCumulative(f)` | `cumulative && (from‖to)` (allRuns 항 없음) |
 * | `summary/read/period-route-flag::hasPeriod(f)` | `Boolean(from ‖ to)` |
 * | `app/…/website/page.tsx` | `cumulative: Boolean(from ‖ to)` (페이지가 직접 모드를 정함) |
 *
 * 넷이 갈라져 있었던 것이 2026-09-15 이노션 신고("기간을 걸어도 인용이 안 뜬다")의
 * 구조적 원인이다 — 상세 술어만 `cumulative` 를 안 읽어 항상 스냅샷이었다.
 *
 * 이 모듈은 값을 바꾸지 않는다: 네 자리 전부 여기로 위임하되 **각자의 현행 인자**를
 * 그대로 넘긴다(`allRuns` 를 넘기는 자리 / 안 넘기는 자리가 그대로 유지된다).
 */

export interface PeriodFilterLike {
  /** 화면이 선언한 누적 표면 여부. 기간이 없으면 의미가 없다. */
  cumulative?: boolean;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export type PeriodMode =
  /** 최신 1회차(셀당 최신 1건 배치 선택). 기본값. */
  | "snapshot"
  /** 기간에 걸치는 회차 전부 누적. */
  | "cumulative"
  /** 추이 읽기 — 자기 창(TREND_WINDOW_DAYS 등)을 쓰므로 위 둘과 다른 규칙이다. */
  | "trend"
  /**
   * **앵커 축의 기간 모드**(계약 §3) — 기간이 걸린 요청은 `f.cumulative` 선언과
   * 무관하게 이 모드다.
   *
   * 종전 축에서 `cumulative` 와 `snapshot` 이 갈렸던 이유는 "기간 안 최신 배치
   * 하나"(스냅샷)와 "기간 안 전부"(누적)가 서로 다른 값이었기 때문이다. 앵커 축은
   * 그 선택지를 없앤다 — **회차는 통째로 들어오거나 나가고**, 여럿이면 회차마다
   * 셀당 대표 1건을 고른 뒤 합산한다. 즉 두 모드가 한 규칙으로 합쳐진다.
   *
   * 기간이 **없으면** 종전과 같이 `snapshot`(최신 회차 하나)이다.
   */
  | "anchor_period";

/**
 * 이 요청이 **기간을 건 것인가**. 모드 선택 규칙의 원자 — `dateFrom || dateTo` 하나다.
 *
 * ⚠️ 기간 없는 요청을 기간 모드로 보내면 회차 집합이 무경계로 풀린다(전 이력 스캔).
 */
export function hasPeriod(f: PeriodFilterLike): boolean {
  return Boolean(f.dateFrom || f.dateTo);
}

/**
 * 기간 모드 리졸버.
 *
 * · `allRuns` 는 **추이 읽기 표시자**다. 추이는 자기 창을 갖고 버킷이 따로 있어
 *   누적으로 취급하면 주별 그래프가 한 점으로 접힌다(2026-09-04 실증).
 * · 누적은 **기간이 실제로 걸렸을 때만**이다. 답변분석 페이지 12곳이 기간 유무와
 *   무관하게 `cumulative: true` 를 상시로 넘기므로 여기서 가른다(페이지 무수정).
 */
export function resolvePeriodMode(
  f: PeriodFilterLike,
  opts: { allRuns?: boolean; anchorAxis?: boolean } = {},
): PeriodMode {
  if (opts.allRuns === true) return "trend";
  // 앵커 축: 기간이 걸렸으면 `cumulative` 선언과 무관하게 회차 집합 모드다.
  // `allRuns`(추이)가 먼저 이기는 순서는 종전과 같다 — 추이는 자기 창과 버킷을 갖는다.
  if (opts.anchorAxis === true) return hasPeriod(f) ? "anchor_period" : "snapshot";
  return f.cumulative === true && hasPeriod(f) ? "cumulative" : "snapshot";
}

/**
 * "기간 안 여러 회차를 **함께** 읽는 모드인가" — 종전 축의 `cumulative` 와 앵커 축의
 * `anchor_period` 를 한 이름으로 묶는다.
 *
 * ⚠️ 종전 호출부는 `opts.anchorAxis` 를 넘기지 않으므로 진리표가 **그대로**다
 * (`anchor_period` 가 만들어지지 않는다).
 */
export function isCumulativePeriod(
  f: PeriodFilterLike,
  opts: { allRuns?: boolean; anchorAxis?: boolean } = {},
): boolean {
  const mode = resolvePeriodMode(f, opts);
  return mode === "cumulative" || mode === "anchor_period";
}
