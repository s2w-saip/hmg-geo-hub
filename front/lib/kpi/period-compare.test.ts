import { describe, expect, it } from "vitest";
import {
  addDays,
  appliesMissingShare,
  clampWindowLo,
  computeCompare,
  COMPARE_METRIC_FAMILY,
  COMPARE_METRIC_UNITS,
  diffDays,
  graceDays,
  judgeStartMonth,
  judgeStartWindow,
  MISSING_SHARE_MAX,
  MISSING_SHARE_MIN_WINDOW_DAYS,
  missingShare,
  PERIOD_COMPARE_EPOCH,
  periodCompareApplies,
  resolveWindows,
  suppressionOf,
  SUPPRESSION_PRECEDENCE,
  windowKey,
  windowLength,
  windowsFromRange,
  type CompareLedger,
  type CompareMetricKey,
  type ComparePeriod,
  type CompareResult,
} from "./period-compare";

// ════════════════════════════════════════════════════════════════════════════
// 기간 비교 Δ 산식 — 순수 단위 테스트 + **뮤턴트 그물**
// ════════════════════════════════════════════════════════════════════════════
//
// 골든은 전부 **2026-09-18 라이브 미러 실측**이다(읽기 전용, `mcp__supabase-hmg`).
// 합성 수를 만들지 않은 이유: 산식이 틀렸을 때 죽는 것은 "그럴듯한 수" 가 아니라
// **그 화면에 실제로 찍히는 수**여야 한다.
//
// ── 이 파일이 죽여야 하는 뮤턴트 (tasks 1.4) ───────────────────────────────
//
//   ① 비율을 회차별로 먼저 나눠 평균낸다        → `골든 G2` 의 77.2044 가 통과하면 실패
//   ② 건수형을 **회차 수**로 나눈다             → `건수형 정규화` 가 잡는다
//   ③ 억제 경계를 `>` 로 완화한다               → `정확히 30%` 가 잡는다
//   ④ 직전 창에도 `minDay` 클램프를 건다        → `클램프는 현재 창에만` 이 잡는다
//   ⑤ 억제 우선순위를 뒤집는다                  → `우선순위 전수` 가 잡는다
//   ⑥ `hidden_scope='citations'` 회차를 언급 계열에서도 뺀다 → `숨김 회차 계열 규약` 이 잡는다
//   ⑦ 7·14일 창에 누락 30% 를 적용한다          → `7·14일 창은 누락 임계를 안 쓴다` 가 잡는다
//   ⑧ `start_window` 의 `F` 를 창 안 첫 회차로 읽는다 → `F 는 전 이력 첫 발행` 이 잡는다

const LEDGER = (o: Partial<CompareLedger> = {}): CompareLedger => ({
  plannedUnits: 0,
  missingUnits: 0,
  publishedCycles: 1,
  dataCycles: 1,
  firstPublishedAnchor: "2026-06-07",
  ...o,
});

const PERIOD = (
  key: string,
  lo: string,
  hi: string,
  measures: ComparePeriod["measures"],
  ledger: Partial<CompareLedger> = {},
): ComparePeriod => ({ key, lo, hi, measures, ledger: LEDGER(ledger) });

const ALL_METRICS: readonly CompareMetricKey[] = [
  "visibility",
  "share",
  "favorability",
  "position",
  "mentionsPerAnswer",
  "citationsPerAnswer",
];

const pick = (rs: CompareResult[], m: CompareMetricKey) => rs.find((r) => r.metric === m)!;

// ── 날짜 산술 ───────────────────────────────────────────────────────────────

describe("일 산술", () => {
  it("월·연 경계를 넘는다", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29"); // 윤년
    expect(diffDays("2026-08-31", "2026-09-13")).toBe(13);
  });

  it("잘못된 날짜는 던진다(조용히 NaN 을 흘리지 않는다)", () => {
    expect(() => addDays("2026-9-1", 1)).toThrow(/invalid/);
    expect(() => addDays("2026-13-01", 1)).toThrow(/invalid/);
  });
});

// ── 창 수식 ─────────────────────────────────────────────────────────────────

describe("resolveWindows — 창 수식", () => {
  it("끝점이 오늘이 아니라 최신 노출 회차일이다 (spec 시나리오)", () => {
    const { cur, prev } = resolveWindows("2026-09-13", 7);
    expect(cur).toEqual({ lo: "2026-09-07", hi: "2026-09-13" });
    expect(prev).toEqual({ lo: "2026-08-31", hi: "2026-09-06" });
  });

  it("두 창은 길이가 같고 겹치지 않으며 맞닿는다", () => {
    for (const n of [7, 14, 30, 365]) {
      const { cur, prev } = resolveWindows("2026-09-13", n);
      expect(windowLength(cur)).toBe(n);
      expect(windowLength(prev)).toBe(n);
      expect(addDays(cur.lo, -1)).toBe(prev.hi);
      expect(prev.hi < cur.lo).toBe(true);
    }
  });

  it("14·30·365일 창의 경계 (골든과 같은 끝점)", () => {
    expect(resolveWindows("2026-09-13", 14)).toEqual({
      cur: { lo: "2026-08-31", hi: "2026-09-13" },
      prev: { lo: "2026-08-17", hi: "2026-08-30" },
    });
    expect(resolveWindows("2026-09-13", 30)).toEqual({
      cur: { lo: "2026-08-15", hi: "2026-09-13" },
      prev: { lo: "2026-07-16", hi: "2026-08-14" },
    });
    // ⚠️ design §9 G4 는 prev 를 `[2024-09-15, 2025-09-13]` 로 적었는데 그것은 **364일**이다.
    // 수식(`E − (2N−1)`)이 내는 365일 창은 `2024-09-14` 에서 시작한다. 판정(no_prev)은
    // 같지만 스펙의 날짜가 하루 틀렸다 — 코드가 이긴다.
    expect(resolveWindows("2026-09-13", 365).prev).toEqual({
      lo: "2024-09-14",
      hi: "2025-09-13",
    });
    expect(windowLength(resolveWindows("2026-09-13", 365).prev)).toBe(365);
  });

  it("경계를 하루 밀면 창이 달라진다(뮤턴트 감지용 고정)", () => {
    expect(resolveWindows("2026-09-13", 7).cur.lo).not.toBe("2026-09-06");
    expect(resolveWindows("2026-09-13", 7).cur.lo).not.toBe("2026-09-08");
  });

  it("창 길이는 정수 1 이상이어야 한다", () => {
    expect(() => resolveWindows("2026-09-13", 0)).toThrow(/invalid window length/);
    expect(() => resolveWindows("2026-09-13", 1.5)).toThrow(/invalid window length/);
  });

  it("임의 날짜쌍도 같은 규칙을 탄다(달력 월 프리셋이 얹힐 자리)", () => {
    // 2026-09 달력 월(30일)을 그대로 넣으면 직전 창은 바로 앞 30일이다.
    const r = windowsFromRange("2026-09-01", "2026-09-30");
    expect(r.days).toBe(30);
    expect(r.cur).toEqual({ lo: "2026-09-01", hi: "2026-09-30" });
    expect(r.prev).toEqual({ lo: "2026-08-02", hi: "2026-08-31" });
  });

  it("창 키는 `lo..hi`", () => {
    expect(windowKey({ lo: "2026-09-07", hi: "2026-09-13" })).toBe("2026-09-07..2026-09-13");
  });
});

describe("minDay 클램프", () => {
  const { cur, prev } = resolveWindows("2026-09-13", 30);

  it("**현재 창에만** 건다 — 직전 창에 걸면 길이가 달라져 비교가 깨진다", () => {
    const min = "2026-08-20";
    expect(clampWindowLo(cur, min)).toEqual({ lo: min, hi: "2026-09-13" });
    // 뮤턴트 ④: prev 에도 클램프하면 길이가 30 → 0 이 된다.
    const clampedPrev = clampWindowLo(prev, min);
    expect(clampedPrev).toEqual(prev);
    expect(windowLength(clampedPrev)).toBe(30);
  });

  it("창 밖의 minDay 는 무시한다", () => {
    expect(clampWindowLo(cur, "2026-01-01")).toEqual(cur);
    expect(clampWindowLo(cur, "2026-12-01")).toEqual(cur);
    expect(clampWindowLo(cur, null)).toEqual(cur);
  });
});

// ── 억제 임계·유예 ──────────────────────────────────────────────────────────

describe("graceDays", () => {
  it("ceil(N/4) — 4값 고정", () => {
    expect(graceDays(7)).toBe(2);
    expect(graceDays(14)).toBe(4);
    expect(graceDays(30)).toBe(8);
    expect(graceDays(365)).toBe(92);
  });
});

describe("missingShare", () => {
  it("미발행 계획 단위 ÷ 전체 계획 단위", () => {
    expect(missingShare(LEDGER({ plannedUnits: 35264, missingUnits: 14404 }))).toBeCloseTo(
      0.40846,
      5,
    );
  });
  it("계획 단위 0 이면 0 (0 나눗셈으로 NaN 을 흘리지 않는다)", () => {
    expect(missingShare(LEDGER({ plannedUnits: 0, missingUnits: 0 }))).toBe(0);
  });
});

describe("누락 30% 임계의 적용 범위", () => {
  it("7·14일 창에는 적용하지 않는다 (제품 책임자 방향 2)", () => {
    expect(appliesMissingShare({ kind: "window", days: 7 })).toBe(false);
    expect(appliesMissingShare({ kind: "window", days: 14 })).toBe(false);
  });
  it("30일·1년 창에는 적용한다", () => {
    expect(appliesMissingShare({ kind: "window", days: 30 })).toBe(true);
    expect(appliesMissingShare({ kind: "window", days: 365 })).toBe(true);
    expect(MISSING_SHARE_MIN_WINDOW_DAYS).toBe(30);
  });
  it("달력 월은 길이와 무관하게 적용한다 (MoM 정책 그대로)", () => {
    expect(appliesMissingShare({ kind: "calendarMonth", days: 28 })).toBe(true);
  });
});

describe("start_window", () => {
  it("창 시작 직후 인입은 온전한 창이다 (spec 시나리오)", () => {
    expect(
      judgeStartWindow({ firstPublishedAnchor: "2026-07-22", prevLo: "2026-07-16", days: 30 }),
    ).toBe(false); // grace(30)=8 → 07-24 까지 허용
  });
  it("창 중반 인입은 시작 구간이다 (spec 시나리오)", () => {
    expect(
      judgeStartWindow({ firstPublishedAnchor: "2026-07-30", prevLo: "2026-07-16", days: 30 }),
    ).toBe(true);
  });
  it("경계일(prev.lo + grace)은 시작 구간이 **아니다**", () => {
    expect(
      judgeStartWindow({ firstPublishedAnchor: "2026-07-24", prevLo: "2026-07-16", days: 30 }),
    ).toBe(false);
  });
  it("모르면(null) 억제하지 않는다", () => {
    expect(judgeStartWindow({ firstPublishedAnchor: null, prevLo: "2026-07-16", days: 30 })).toBe(
      false,
    );
  });
  it("`F` 는 **전 이력** 첫 발행이다 — 창 안 첫 회차로 읽으면 라이브가 오분류된다", () => {
    // 웹사이트 7일 직전 창(2026-08-29~09-04)의 창 내 첫 발행은 09-04(= lo+6 > grace 2)지만,
    // 전 이력 첫 발행은 2026-07-02 라 시작 구간이 아니다(2026-09-18 라이브 실측).
    expect(
      judgeStartWindow({ firstPublishedAnchor: "2026-07-02", prevLo: "2026-08-29", days: 7 }),
    ).toBe(false);
    expect(
      judgeStartWindow({ firstPublishedAnchor: "2026-09-04", prevLo: "2026-08-29", days: 7 }),
    ).toBe(true); // 뮤턴트 ⑧ 이 만드는 상태
  });
});

describe("start_month (달력 월 전용)", () => {
  const base = { prevLo: "2026-07-01", prevHi: "2026-07-31" };
  it("전전월에 데이터가 있으면 시작 월이 아니다", () => {
    expect(
      judgeStartMonth({ ...base, firstPublishedAnchor: "2026-07-20", beforeDataCycles: 3 }),
    ).toBe(false);
  });
  it("그 달 첫째 주(7일) 안에 시작했으면 온전한 달이다", () => {
    expect(
      judgeStartMonth({ ...base, firstPublishedAnchor: "2026-07-02", beforeDataCycles: 0 }),
    ).toBe(false);
    expect(
      judgeStartMonth({ ...base, firstPublishedAnchor: "2026-07-07", beforeDataCycles: 0 }),
    ).toBe(false);
  });
  it("달 중간 인입이면 시작 월이다", () => {
    expect(
      judgeStartMonth({ ...base, firstPublishedAnchor: "2026-07-08", beforeDataCycles: 0 }),
    ).toBe(true);
  });
  it("첫 발행이 그 달 밖이면(더 과거) 시작 월이 아니다", () => {
    expect(
      judgeStartMonth({ ...base, firstPublishedAnchor: "2026-06-07", beforeDataCycles: 0 }),
    ).toBe(false);
  });
});

describe("적용일 게이트 (Q6=b)", () => {
  it("상수는 이 파일 한 곳", () => {
    expect(PERIOD_COMPARE_EPOCH).toBe("2026-09-08");
  });
  it("cur.hi 가 적용일 이상일 때만 적용한다 (경계 포함)", () => {
    expect(periodCompareApplies("2026-09-07")).toBe(false);
    expect(periodCompareApplies("2026-09-08")).toBe(true);
    expect(periodCompareApplies("2026-09-13")).toBe(true);
  });
});

// ── 억제 우선순위 ───────────────────────────────────────────────────────────

describe("억제 우선순위", () => {
  it("순서가 고정돼 있다", () => {
    expect([...SUPPRESSION_PRECEDENCE]).toEqual([
      "unsupported",
      "no_prev",
      "no_data",
      "missing_share",
      "start_window",
      "start_month",
    ]);
  });

  it("unsupported 가 이긴다 — 누락 45% 와 동시에 참이어도 (spec 시나리오)", () => {
    const prev = PERIOD("p", "2026-07-16", "2026-08-14", {}, {
      plannedUnits: 100,
      missingUnits: 45,
      publishedCycles: 0,
      dataCycles: 0,
      firstPublishedAnchor: "2026-08-10",
    });
    const cur = PERIOD("c", "2026-08-15", "2026-09-13", {});
    expect(suppressionOf(prev, cur, { kind: "window", days: 30, metrics: [], unsupported: true }))
      .toBe("unsupported");
  });

  it("no_prev > no_data > missing_share > start_window 전수", () => {
    const worst = (o: Partial<CompareLedger>) =>
      PERIOD("p", "2026-07-16", "2026-08-14", {}, {
        plannedUnits: 100,
        missingUnits: 45,
        publishedCycles: 2,
        dataCycles: 2,
        firstPublishedAnchor: "2026-08-10", // > 07-16 + 8 → start_window
        ...o,
      });
    const cur = PERIOD("c", "2026-08-15", "2026-09-13", {});
    const opts = { kind: "window" as const, days: 30, metrics: [] };
    expect(suppressionOf(worst({ publishedCycles: 0 }), cur, opts)).toBe("no_prev");
    expect(suppressionOf(worst({ dataCycles: 0 }), cur, opts)).toBe("no_data");
    expect(suppressionOf(worst({}), cur, opts)).toBe("missing_share");
    expect(suppressionOf(worst({ missingUnits: 0 }), cur, opts)).toBe("start_window");
    expect(
      suppressionOf(worst({ missingUnits: 0, firstPublishedAnchor: "2026-06-07" }), cur, opts),
    ).toBe(null);
  });

  it("start_window 는 창 비교 전용, start_month 는 달력 월 전용", () => {
    const prev = PERIOD("2026-07", "2026-07-01", "2026-07-31", {}, {
      plannedUnits: 100,
      missingUnits: 0,
      firstPublishedAnchor: "2026-07-20",
    });
    const cur = PERIOD("2026-08", "2026-08-01", "2026-08-31", {});
    expect(suppressionOf(prev, cur, { kind: "calendarMonth", days: 31, metrics: [] })).toBe(
      "start_month",
    );
    // 같은 입력이 창 비교면 `start_window` 다(사유가 섞이지 않는다).
    expect(suppressionOf(prev, cur, { kind: "window", days: 31, metrics: [] })).toBe(
      "start_window",
    );
  });
});

// ── 산식: 골든 (글로벌, E=2026-09-13, 무필터, own_variant='ALL') ────────────

describe("골든 G1 — 7일 창 (글로벌 실측)", () => {
  const prev = PERIOD(
    "2026-08-31..2026-09-06",
    "2026-08-31",
    "2026-09-06",
    { visibility: { numerator: 24336, denominator: 37570 } },
    { plannedUnits: 38748, missingUnits: 0, publishedCycles: 1, dataCycles: 1 },
  );
  const cur = PERIOD(
    "2026-09-07..2026-09-13",
    "2026-09-07",
    "2026-09-13",
    { visibility: { numerator: 56033, denominator: 75138 } },
    { plannedUnits: 77496, missingUnits: 0, publishedCycles: 2, dataCycles: 2 },
  );

  it("분자합÷분모합으로 +9.7984 %p", () => {
    const [r] = computeCompare(prev, cur, {
      kind: "window",
      days: 7,
      metrics: ["visibility"],
    });
    expect(r!.prev! * 100).toBeCloseTo(64.7751, 4);
    expect(r!.cur! * 100).toBeCloseTo(74.5735, 4);
    expect(r!.delta!).toBeCloseTo(9.7984, 4);
    expect(r!.unit).toBe("pp");
    expect(r!.suppressed).toBe(false);
    expect(r!.reason).toBe(null);
  });

  it("억제되지 않아도 회차 수·계획 단위를 캡션용으로 채운다", () => {
    const [r] = computeCompare(prev, cur, { kind: "window", days: 7, metrics: ["visibility"] });
    expect(r!.cyclesPrev).toBe(1);
    expect(r!.cyclesCur).toBe(2);
    expect(r!.plannedPrev).toBe(38748);
    expect(r!.plannedCur).toBe(77496);
  });
});

describe("골든 G2 — 14일 창 + 숨김 회차 계열 규약 (글로벌 실측)", () => {
  const cur = PERIOD(
    "2026-08-31..2026-09-13",
    "2026-08-31",
    "2026-09-13",
    {
      visibility: { numerator: 80369, denominator: 112708 },
      citationsPerAnswer: { numerator: 603635, denominator: 112708 },
    },
    { plannedUnits: 116244, missingUnits: 0, publishedCycles: 3, dataCycles: 3 },
  );
  const prevWithHidden = PERIOD(
    "2026-08-17..2026-08-30",
    "2026-08-17",
    "2026-08-30",
    { visibility: { numerator: 14234, denominator: 19536 } },
    { plannedUnits: 19629, missingUnits: 0, publishedCycles: 3, dataCycles: 3 },
  );

  it("08-25(hidden_scope='citations')를 **언급 계열에 포함**해 −1.5531 %p", () => {
    const [r] = computeCompare(prevWithHidden, cur, {
      kind: "window",
      days: 14,
      metrics: ["visibility"],
    });
    expect(r!.prev! * 100).toBeCloseTo(72.8604, 4);
    expect(r!.delta!).toBeCloseTo(-1.5531, 4);
  });

  it("뮤턴트 ⑥ — 언급 계열에서 그 회차를 빼면 Δ 가 4.18 %p 틀어진다", () => {
    const without = PERIOD(
      "2026-08-17..2026-08-30",
      "2026-08-17",
      "2026-08-30",
      { visibility: { numerator: 7616, denominator: 9886 } },
      { plannedUnits: 19629, missingUnits: 0, publishedCycles: 2, dataCycles: 2 },
    );
    const [bad] = computeCompare(without, cur, {
      kind: "window",
      days: 14,
      metrics: ["visibility"],
    });
    expect(bad!.prev! * 100).toBeCloseTo(77.0382, 4);
    expect(bad!.delta!).toBeCloseTo(-5.7309, 3);
    expect(Math.abs(bad!.delta! - -1.5531)).toBeGreaterThan(4.1);
  });

  it("뮤턴트 ① — 회차별 비율의 평균은 72.8604 가 아니라 77.2044 다", () => {
    const perCycle = [6856 / 9012, 760 / 874, 6618 / 9650];
    const mean = (perCycle.reduce((a, b) => a + b, 0) / perCycle.length) * 100;
    const pooled = ((6856 + 760 + 6618) / (9012 + 874 + 9650)) * 100;
    expect(pooled).toBeCloseTo(72.8604, 4);
    expect(mean).toBeCloseTo(77.2044, 4);
    // 산식이 평균으로 바뀌면 G2 의 prev 가 이 값이 되어 위 테스트가 죽는다.
    expect(Math.abs(mean - pooled)).toBeGreaterThan(4.3);
  });

  it("인용 계열은 그 회차를 **뺀** 모수를 쓴다 (cur 5.3553 / prev 14.8635)", () => {
    const prevCit = PERIOD(
      "2026-08-17..2026-08-30",
      "2026-08-17",
      "2026-08-30",
      { citationsPerAnswer: { numerator: 146942, denominator: 9886 } },
      { plannedUnits: 19629, missingUnits: 0, publishedCycles: 3, dataCycles: 2 },
    );
    const [r] = computeCompare(prevCit, cur, {
      kind: "window",
      days: 14,
      metrics: ["citationsPerAnswer"],
    });
    expect(r!.prev!).toBeCloseTo(14.8635, 3);
    expect(r!.cur!).toBeCloseTo(5.3553, 3);
    expect(r!.unit).toBe("pct");
    expect(r!.delta!).toBeCloseTo(((5.3553 - 14.8635) / 14.8635) * 100, 1);
  });
});

describe("골든 G3 — 30일 창은 누락 40.846% 로 억제 (글로벌 실측)", () => {
  const prev = PERIOD(
    "2026-07-16..2026-08-14",
    "2026-07-16",
    "2026-08-14",
    { visibility: { numerator: 3753, denominator: 4735 } },
    { plannedUnits: 35264, missingUnits: 14404, publishedCycles: 5, dataCycles: 5 },
  );
  const cur = PERIOD(
    "2026-08-15..2026-09-13",
    "2026-08-15",
    "2026-09-13",
    { visibility: { numerator: 94603, denominator: 132244 } },
    { plannedUnits: 135873, missingUnits: 0, publishedCycles: 6, dataCycles: 6 },
  );

  it("missing_share 로 억제하고 delta 만 null 이 된다", () => {
    const [r] = computeCompare(prev, cur, { kind: "window", days: 30, metrics: ["visibility"] });
    expect(missingShare(prev.ledger)).toBeCloseTo(0.40846, 5);
    expect(r!.reason).toBe("missing_share");
    expect(r!.suppressed).toBe(true);
    expect(r!.delta).toBe(null);
    // 값 자체는 살아 있다(화면이 "―" 를 그리면서 회차 수를 함께 적는다).
    expect(r!.prev! * 100).toBeCloseTo(79.2608, 4);
    expect(r!.cur! * 100).toBeCloseTo(71.5367, 4);
  });

  it("억제를 끄면 Δ 는 −7.7241 %p (회귀 대조값)", () => {
    const [r] = computeCompare(
      { ...prev, ledger: { ...prev.ledger, missingUnits: 0 } },
      cur,
      { kind: "window", days: 30, metrics: ["visibility"] },
    );
    expect(r!.delta!).toBeCloseTo(-7.7241, 4);
  });

  it("뮤턴트 ⑦ — 같은 누락이 14일 창이면 억제하지 않는다", () => {
    const [r] = computeCompare(prev, cur, { kind: "window", days: 14, metrics: ["visibility"] });
    expect(r!.reason).toBe(null);
    expect(r!.delta).not.toBe(null);
  });
});

describe("골든 G4 — 1년 창은 직전 창 회차 0 → no_prev", () => {
  it("no_prev 로 억제한다", () => {
    const prev = PERIOD("2024-09-15..2025-09-13", "2024-09-15", "2025-09-13", {}, {
      plannedUnits: 0,
      missingUnits: 0,
      publishedCycles: 0,
      dataCycles: 0,
      firstPublishedAnchor: "2026-06-07",
    });
    const cur = PERIOD(
      "2025-09-14..2026-09-13",
      "2025-09-14",
      "2026-09-13",
      { visibility: { numerator: 100431, denominator: 139837 } },
      { plannedUnits: 188368, missingUnits: 22179, publishedCycles: 12, dataCycles: 12 },
    );
    const [r] = computeCompare(prev, cur, { kind: "window", days: 365, metrics: ["visibility"] });
    expect(r!.reason).toBe("no_prev");
    expect(r!.delta).toBe(null);
  });
});

// ── 골든 (웹사이트 함대, E=2026-09-11, 무필터, 유닛 게이트 on, 제외 [71,94,97]) ──

describe("골든 W1~W3 — 웹사이트 함대 (2026-09-18 실측, 신규)", () => {
  const w = (
    key: string,
    lo: string,
    hi: string,
    tracked: number,
    monitored: number,
    ledger: Partial<CompareLedger>,
  ) =>
    PERIOD(key, lo, hi, { visibility: { numerator: tracked, denominator: monitored } }, {
      firstPublishedAnchor: "2026-07-02",
      ...ledger,
    });

  it("W1 7일: 92.7445% → 97.1944% = +4.4499 %p", () => {
    const prev = w("p", "2026-08-29", "2026-09-04", 18113, 19530, {
      plannedUnits: 19594,
      missingUnits: 0,
      publishedCycles: 92,
      dataCycles: 92,
    });
    const cur = w("c", "2026-09-05", "2026-09-11", 18811, 19354, {
      plannedUnits: 19402,
      missingUnits: 0,
      publishedCycles: 91,
      dataCycles: 91,
    });
    const [r] = computeCompare(prev, cur, { kind: "window", days: 7, metrics: ["visibility"] });
    expect(r!.prev! * 100).toBeCloseTo(92.7445, 4);
    expect(r!.cur! * 100).toBeCloseTo(97.1944, 4);
    expect(r!.delta!).toBeCloseTo(4.4499, 4);
    expect(r!.reason).toBe(null);
  });

  it("W2 14일: 96.7845% → 94.9594% = −1.8252 %p (직전 창 누락 0.685% 는 억제 대상 아님)", () => {
    const prev = w("p", "2026-08-15", "2026-08-28", 38046, 39310, {
      plannedUnits: 39722,
      missingUnits: 272,
      publishedCycles: 184,
      dataCycles: 184,
    });
    const cur = w("c", "2026-08-29", "2026-09-11", 36924, 38884, {
      plannedUnits: 38996,
      missingUnits: 0,
      publishedCycles: 183,
      dataCycles: 183,
    });
    const [r] = computeCompare(prev, cur, { kind: "window", days: 14, metrics: ["visibility"] });
    expect(missingShare(prev.ledger)).toBeCloseTo(0.00685, 5);
    expect(r!.delta!).toBeCloseTo(-1.8252, 4);
    expect(r!.reason).toBe(null);
  });

  it("W3 30일: 회차 수가 116 : 367 로 3.2배 달라도 비율은 모수로 비교한다", () => {
    const prev = w("p", "2026-07-14", "2026-08-12", 24311, 24850, {
      plannedUnits: 26122,
      missingUnits: 236,
      publishedCycles: 116,
      dataCycles: 116,
    });
    const cur = w("c", "2026-08-13", "2026-09-11", 74970, 78194, {
      plannedUnits: 78718,
      missingUnits: 272,
      publishedCycles: 367,
      dataCycles: 367,
    });
    const [r] = computeCompare(prev, cur, { kind: "window", days: 30, metrics: ["visibility"] });
    expect(r!.prev! * 100).toBeCloseTo(97.831, 3);
    expect(r!.cur! * 100).toBeCloseTo(95.8769, 4);
    expect(r!.delta!).toBeCloseTo(-1.9541, 4);
    expect(r!.reason).toBe(null); // 누락 0.9% / 0.3% → 30% 미만
  });
});

// ── 단위·유형 ───────────────────────────────────────────────────────────────

describe("지표 유형", () => {
  it("단위 표가 고정돼 있다", () => {
    expect(COMPARE_METRIC_UNITS).toEqual({
      visibility: "pp",
      share: "pp",
      favorability: "pp",
      position: "rank",
      mentionsPerAnswer: "pct",
      citationsPerAnswer: "pct",
    });
  });

  it("계열 표는 Record 라 지표를 빠뜨릴 수 없다", () => {
    expect(Object.keys(COMPARE_METRIC_FAMILY).sort()).toEqual([...ALL_METRICS].sort());
    expect(COMPARE_METRIC_FAMILY.citationsPerAnswer).toBe("citation");
    expect(COMPARE_METRIC_FAMILY.mentionsPerAnswer).toBe("mention");
  });

  it("순위형은 절대 차이고 %p 가 아니다", () => {
    const prev = PERIOD("p", "2026-08-31", "2026-09-06", {
      position: { numerator: 500, denominator: 200 }, // 2.5
    });
    const cur = PERIOD("c", "2026-09-07", "2026-09-13", {
      position: { numerator: 420, denominator: 200 }, // 2.1
    });
    const [r] = computeCompare(prev, cur, { kind: "window", days: 7, metrics: ["position"] });
    expect(r!.unit).toBe("rank");
    expect(r!.delta!).toBeCloseTo(-0.4, 10); // %p 였다면 −40 이다
  });

  it("뮤턴트 ② — 건수형의 분모는 monitored 이지 회차 수가 아니다", () => {
    // 같은 데이터로 분모만 회차 수(2·1)로 바꾸면 값이 4~5자리로 튄다.
    const prev = PERIOD("p", "2026-08-31", "2026-09-06", {
      mentionsPerAnswer: { numerator: 100000, denominator: 37570 },
    });
    const cur = PERIOD("c", "2026-09-07", "2026-09-13", {
      mentionsPerAnswer: { numerator: 210000, denominator: 75138 },
    });
    const [ok] = computeCompare(prev, cur, {
      kind: "window",
      days: 7,
      metrics: ["mentionsPerAnswer"],
    });
    expect(ok!.prev!).toBeCloseTo(2.6617, 4);
    expect(ok!.cur!).toBeCloseTo(2.7949, 4);
    expect(ok!.delta!).toBeCloseTo(5.0028, 3);

    const perCycle = [
      computeCompare(
        PERIOD("p", "2026-08-31", "2026-09-06", {
          mentionsPerAnswer: { numerator: 100000, denominator: 1 },
        }),
        PERIOD("c", "2026-09-07", "2026-09-13", {
          mentionsPerAnswer: { numerator: 210000, denominator: 2 },
        }),
        { kind: "window", days: 7, metrics: ["mentionsPerAnswer"] },
      )[0]!,
    ][0];
    expect(perCycle.delta!).toBeCloseTo(5.0, 1);
    // 회차 수 분모는 회차 **크기** 변동을 그대로 먹는다: 크기가 10% 커지면 값도 10% 커진다.
    const skewed = computeCompare(
      PERIOD("p", "2026-08-31", "2026-09-06", {
        mentionsPerAnswer: { numerator: 100000, denominator: 1 },
      }),
      PERIOD("c", "2026-09-07", "2026-09-13", {
        mentionsPerAnswer: { numerator: 231000, denominator: 2 },
      }),
      { kind: "window", days: 7, metrics: ["mentionsPerAnswer"] },
    )[0]!;
    expect(skewed.delta!).toBeCloseTo(15.5, 1);
    expect(Math.abs(skewed.delta! - ok!.delta!)).toBeGreaterThan(10);
  });

  it("건수형의 직전 값이 0 이면 증감률이 정의되지 않는다(null)", () => {
    const prev = PERIOD("p", "2026-08-31", "2026-09-06", {
      mentionsPerAnswer: { numerator: 0, denominator: 100 },
    });
    const cur = PERIOD("c", "2026-09-07", "2026-09-13", {
      mentionsPerAnswer: { numerator: 10, denominator: 100 },
    });
    expect(
      computeCompare(prev, cur, { kind: "window", days: 7, metrics: ["mentionsPerAnswer"] })[0]!
        .delta,
    ).toBe(null);
  });

  it("분모 0 은 값 자체가 null 이고 Δ 도 null 이다", () => {
    const prev = PERIOD("p", "2026-08-31", "2026-09-06", {
      share: { numerator: 10, denominator: 0 },
    });
    const cur = PERIOD("c", "2026-09-07", "2026-09-13", {
      share: { numerator: 10, denominator: 20 },
    });
    const [r] = computeCompare(prev, cur, { kind: "window", days: 7, metrics: ["share"] });
    expect(r!.prev).toBe(null);
    expect(r!.delta).toBe(null);
  });
});

describe("computeCompare 의 계약", () => {
  it("요청한 지표만·요청한 순서로 돌려준다", () => {
    const prev = PERIOD("p", "2026-08-31", "2026-09-06", {
      visibility: { numerator: 1, denominator: 2 },
      share: { numerator: 1, denominator: 2 },
    });
    const cur = PERIOD("c", "2026-09-07", "2026-09-13", {
      visibility: { numerator: 3, denominator: 4 },
      share: { numerator: 3, denominator: 4 },
    });
    const rs = computeCompare(prev, cur, {
      kind: "window",
      days: 7,
      metrics: ["share", "visibility"],
    });
    expect(rs.map((r) => r.metric)).toEqual(["share", "visibility"]);
    expect(pick(rs, "visibility").delta).toBeCloseTo(25, 10);
  });

  it("억제되면 모든 지표의 delta 가 null 이고 사유가 같다", () => {
    const prev = PERIOD("p", "2026-08-31", "2026-09-06", {
      visibility: { numerator: 1, denominator: 2 },
      share: { numerator: 1, denominator: 2 },
    }, { publishedCycles: 0, dataCycles: 0 });
    const cur = PERIOD("c", "2026-09-07", "2026-09-13", {
      visibility: { numerator: 3, denominator: 4 },
      share: { numerator: 3, denominator: 4 },
    });
    const rs = computeCompare(prev, cur, {
      kind: "window",
      days: 7,
      metrics: ["visibility", "share"],
    });
    expect(rs.every((r) => r.delta === null && r.suppressed && r.reason === "no_prev")).toBe(true);
  });

  it("days 를 안 주면 cur 의 길이에서 읽는다", () => {
    const prev = PERIOD("p", "2026-08-31", "2026-09-06", {});
    const cur = PERIOD("c", "2026-09-07", "2026-09-13", {});
    expect(suppressionOf(prev, cur, { kind: "window", metrics: [] })).toBe(null);
  });

  it("MISSING_SHARE_MAX 는 0.30 (경계 포함)", () => {
    expect(MISSING_SHARE_MAX).toBe(0.3);
    const mk = (missing: number) =>
      suppressionOf(
        PERIOD("p", "2026-07-16", "2026-08-14", {}, { plannedUnits: 10000, missingUnits: missing }),
        PERIOD("c", "2026-08-15", "2026-09-13", {}),
        { kind: "window", days: 30, metrics: [] },
      );
    // 뮤턴트 ③ — `>=` 를 `>` 로 바꾸면 정확히 30% 가 통과한다.
    expect(mk(3000)).toBe("missing_share");
    expect(mk(2999)).toBe(null);
  });
});

// ── GGMD-107 통합(2026-09-19) — 결과가 누락 비중을 싣는다 ────────────────────
//
// 왜 결과에 있어야 하나: 게이트웨이가 화면에 돌려주는 것은 `CompareResult[]` 뿐이고
// `ComparePeriod.ledger` 는 넘어가지 않는다. `periodCompare.reason.missingShare` 문구가
// "계획의 {pct}% 에 그쳐" 라서 수집 비율이 필요한데 `plannedPrev` 만으로는 못 만든다.
describe("computeCompare — 누락 비중을 결과에 싣는다", () => {
  it("두 구간의 missingShare(ledger) 와 같은 값이다 (골든 G3)", () => {
    const mk = (planned: number, missing: number): ComparePeriod => ({
      key: "w",
      lo: "2026-07-16",
      hi: "2026-08-14",
      measures: { visibility: { numerator: 1, denominator: 2 } },
      ledger: {
        plannedUnits: planned,
        missingUnits: missing,
        publishedCycles: 5,
        dataCycles: 5,
        firstPublishedAnchor: "2026-06-07",
      },
    });
    const prev = mk(35264, 14404); // 40.846 %
    const cur = { ...mk(135873, 0), lo: "2026-08-15", hi: "2026-09-13" };
    const [r] = computeCompare(prev, cur, {
      kind: "window",
      days: 30,
      metrics: ["visibility"],
    });
    expect(r.missingSharePrev).toBeCloseTo(missingShare(prev.ledger), 12);
    expect(r.missingShareCur).toBeCloseTo(missingShare(cur.ledger), 12);
    expect(r.missingSharePrev).toBeCloseTo(0.40846, 5);
    expect(r.missingShareCur).toBe(0);
  });
});
