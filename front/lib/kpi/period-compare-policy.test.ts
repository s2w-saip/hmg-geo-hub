import { describe, expect, it } from "vitest";
import {
  appliesMissingShare,
  computeCompare,
  missingShare,
  missingShareKnown,
  MISSING_SHARE_MAX,
  type CompareLedger,
  type ComparePeriod,
} from "./period-compare";
import {
  periodCaption,
  periodChipText,
  periodChip,
  type PeriodCaptionKey,
  type PeriodLabelKey,
} from "./period-compare-view";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

// ════════════════════════════════════════════════════════════════════════════
// 확정 MoM 정책(A안) 다섯 조항의 **설명용 예시**를 그 숫자 그대로 고정한다.
// ════════════════════════════════════════════════════════════════════════════
//
// 정본: `internal-kb/hmg-geo-mom-missing-week-formula-proposal-2026-09-16.md`
// §5-1(조항 ①②③)·§5-3(화면 표기) · 확정 메모(임계 **30%**, 2026-09-17) ·
// 적용 플랜 §5 수용 기준 A2.
//
// 골든(G1~G4·W1~W3, `period-compare.test.ts`)은 **라이브 실측**을 고정한다. 이 파일은
// 그것과 성격이 다르다 — 고객·이노션과 합의한 **문서의 예시 수**를 고정한다. 둘을 한
// 파일에 섞으면 "정책이 바뀌어 다시 합의해야 하는 수" 와 "데이터가 움직이면 갱신하는 수"
// 가 구분되지 않는다.
//
// ⚠️ 기대값은 전부 **손계산 리터럴**이다. 구현과 같은 함수로 기대값을 만들지 않는다.

/** 억제가 걸리지 않는 기본 원장 — 조항 ①②를 볼 때 ③⑤가 끼어들지 않게 한다. */
const OK_LEDGER = (over: Partial<CompareLedger> = {}): CompareLedger => ({
  plannedUnits: 4_500,
  missingUnits: 0,
  publishedCycles: 4,
  dataCycles: 4,
  // 전 이력 첫 발행이 한참 과거 → `start_month` 는 발화하지 않는다.
  firstPublishedAnchor: "2026-01-05",
  ...over,
});

const MONTH = (
  key: string,
  lo: string,
  hi: string,
  m: { monitored: number; tracked: number; mentions: number },
  ledger: CompareLedger,
): ComparePeriod => ({
  key,
  lo,
  hi,
  measures: {
    visibility: { numerator: m.tracked, denominator: m.monitored },
    mentionsPerAnswer: { numerator: m.mentions, denominator: m.monitored },
  },
  ledger,
});

// 정책 §5 예시의 두 달.
//   지난달 — 수집 답변 4,000 · 언급 8,000 · 노출률 70%(= 노출 답변 2,800)
//   이번 달 — 수집 답변 7,000 · 언급 14,700 · 노출률 72%(= 노출 답변 5,040)
const PREV_M = { monitored: 4_000, tracked: 2_800, mentions: 8_000 };
const CUR_M = { monitored: 7_000, tracked: 5_040, mentions: 14_700 };

const monthsOf = (prevLedger: CompareLedger, curLedger: CompareLedger) => ({
  prev: MONTH("2026-08", "2026-08-01", "2026-08-31", PREV_M, prevLedger),
  cur: MONTH("2026-09", "2026-09-01", "2026-09-30", CUR_M, curLedger),
});

const OPTS = {
  kind: "calendarMonth" as const,
  metrics: ["visibility", "mentionsPerAnswer"] as const,
};

describe("조항 ① 비율 지표 — 기간 전체 분자·분모를 합산한 뒤 나눈다", () => {
  const { prev, cur } = monthsOf(OK_LEDGER(), OK_LEDGER({ plannedUnits: 7_000 }));

  it("노출률 70% → 72% = +2.0 %p", () => {
    const [vis] = computeCompare(prev, cur, OPTS);
    expect(vis!.prev).toBe(0.7); // 2,800 / 4,000
    expect(vis!.cur).toBe(0.72); // 5,040 / 7,000
    expect(vis!.unit).toBe("pp");
    expect(vis!.delta).toBeCloseTo(2.0, 10);
    expect(vis!.suppressed).toBe(false);
  });

  it("뮤턴트 — 회차별 비율의 평균으로 바꾸면 이 수가 나오지 않는다", () => {
    // 같은 달을 회차 둘(작은 회차 70%·큰 회차 73%)로 쪼갠 뒤 평균을 내면 71.5% 인데,
    // 합산은 (700 + 4,340) / (1,000 + 6,000) = 72.0% 다. 두 수가 다르다는 것이
    // 조항 ① 의 전부다(작은 회차가 큰 회차와 같은 무게를 갖지 않는다).
    const avgOfRatios = (0.7 + 0.7233333333333334) / 2;
    const sumThenDivide = (700 + 4_340) / (1_000 + 6_000);
    expect(sumThenDivide).toBeCloseTo(0.72, 10);
    expect(avgOfRatios).not.toBeCloseTo(0.72, 3);
  });
});

describe("조항 ② 건수 지표 — 증감은 답변 1건당 값으로", () => {
  const { prev, cur } = monthsOf(OK_LEDGER(), OK_LEDGER({ plannedUnits: 7_000 }));

  it("답변 1건당 언급 2.0 → 2.1 = +5.0 %", () => {
    const [, mpa] = computeCompare(prev, cur, OPTS);
    expect(mpa!.prev).toBe(2); // 8,000 / 4,000
    expect(mpa!.cur).toBe(2.1); // 14,700 / 7,000
    expect(mpa!.unit).toBe("pct");
    expect(mpa!.delta).toBeCloseTo(5.0, 10);
  });

  it("누적 건수를 그대로 빼면 +83.75% 다 — 증감 계산에 쓰지 않는 수", () => {
    // 8,000 → 14,700 은 +83.75%. 늘어난 것의 대부분이 수집량(4,000 → 7,000)이라
    // 브랜드 변화로 읽으면 틀린다. 합계는 규모 정보로 화면에 그대로 두되 증감에서 뺀다.
    expect(((14_700 - 8_000) / 8_000) * 100).toBeCloseTo(83.75, 10);
    const [, mpa] = computeCompare(prev, cur, OPTS);
    expect(mpa!.delta).not.toBeCloseTo(83.75, 1);
  });
});

describe("조항 ③ 누락 비중 — 30% 이상이면 억제", () => {
  it("500 ÷ 4,500 = 11% 는 표시한다", () => {
    const l = OK_LEDGER({ plannedUnits: 4_500, missingUnits: 500, publishedCycles: 3 });
    expect(missingShare(l)).toBeCloseTo(0.1111111111111111, 12);
    const { prev, cur } = monthsOf(l, OK_LEDGER({ plannedUnits: 7_000 }));
    const [vis] = computeCompare(prev, cur, OPTS);
    expect(vis!.suppressed).toBe(false);
    expect(vis!.delta).toBeCloseTo(2.0, 10);
    // 캡션은 사유가 아니라 회차 수 병기다(정책 §5-3 첫 줄).
    expect(periodCaption(vis!, { days: 30, kind: "calendarMonth" })).toEqual({
      key: "window",
      params: { prevCycles: 3, curCycles: 4 },
    });
  });

  it("한 달 4회차 중 2회차 누락 = 50% 는 억제한다", () => {
    // 회차 크기가 같은 달(회차당 계획 1,000). "2회차 누락" 이 곧 계획의 50% 다.
    const l = OK_LEDGER({ plannedUnits: 4_000, missingUnits: 2_000, publishedCycles: 2 });
    expect(missingShare(l)).toBe(0.5);
    const { prev, cur } = monthsOf(l, OK_LEDGER({ plannedUnits: 7_000 }));
    const [vis, mpa] = computeCompare(prev, cur, OPTS);
    expect(vis!.reason).toBe("missing_share");
    expect(vis!.delta).toBeNull();
    // 값 자체는 억제돼도 채운다(캡션이 회차 수를 말해야 하므로).
    expect(vis!.prev).toBe(0.7);
    expect(mpa!.reason).toBe("missing_share");
    expect(periodCaption(vis!, { days: 30, kind: "calendarMonth" })).toEqual({
      key: "reason.missingShare",
      params: { pct: 50 }, // 수집분 = 계획의 50%
    });
  });

  it("4회차 중 1누락(25%)·5회차 중 1누락(20%)은 표시, 정확히 30%는 억제 (플랜 A2)", () => {
    const cases: Array<[label: string, planned: number, missing: number, suppressed: boolean]> = [
      ["4회차 중 1누락 = 25%", 4_000, 1_000, false],
      ["5회차 중 1누락 = 20%", 5_000, 1_000, false],
      ["정확히 30%", 10_000, 3_000, true],
      ["30% 바로 아래", 10_000, 2_999, false],
    ];
    for (const [label, planned, missing, suppressed] of cases) {
      const { prev, cur } = monthsOf(
        OK_LEDGER({ plannedUnits: planned, missingUnits: missing }),
        OK_LEDGER({ plannedUnits: 7_000 }),
      );
      const [vis] = computeCompare(prev, cur, OPTS);
      expect(vis!.suppressed, label).toBe(suppressed);
    }
    expect(MISSING_SHARE_MAX).toBe(0.3);
  });

  it("두 달 중 **한쪽만** 넘어도 억제한다", () => {
    const clean = OK_LEDGER({ plannedUnits: 7_000 });
    const dirty = OK_LEDGER({ plannedUnits: 4_000, missingUnits: 2_000 });
    for (const [p, c] of [
      [dirty, clean],
      [clean, dirty],
    ] as const) {
      const { prev, cur } = monthsOf(p, c);
      expect(computeCompare(prev, cur, OPTS)[0]!.reason).toBe("missing_share");
    }
  });

  it("계획 수집량을 모르는 구간은 누락 0% 가 아니라 **판정하지 않는다**", () => {
    // 원장에 회차가 없는 표면(프로젝트 표면) · `expected_units` 가 전부 NULL 인 구간.
    const unknown = OK_LEDGER({ plannedUnits: 0, missingUnits: 0 });
    expect(missingShareKnown(unknown)).toBe(false);
    expect(missingShare(unknown)).toBe(0); // 0 을 임계와 견주지 않는다
    const { prev, cur } = monthsOf(unknown, OK_LEDGER({ plannedUnits: 7_000 }));
    const [vis] = computeCompare(prev, cur, OPTS);
    expect(vis!.reason).toBeNull();
    expect(vis!.delta).toBeCloseTo(2.0, 10);
  });
});

describe("조항 ⑤ 측정을 시작한 달은 비교 제외", () => {
  it("직전 달 중간에 처음 측정했으면 억제하고, 그 앞 달에 데이터가 있으면 하지 않는다", () => {
    const startMonth = OK_LEDGER({ firstPublishedAnchor: "2026-08-14" });
    const { prev, cur } = monthsOf(startMonth, OK_LEDGER({ plannedUnits: 7_000 }));
    expect(computeCompare(prev, cur, OPTS)[0]!.reason).toBe("start_month");

    const before: ComparePeriod = MONTH("2026-07", "2026-07-01", "2026-07-31", PREV_M, OK_LEDGER());
    expect(computeCompare(prev, cur, { ...OPTS, before })[0]!.reason).toBeNull();
  });

  it("그 달 첫째 주(7일) 안에 시작했으면 온전한 달이다", () => {
    const { prev, cur } = monthsOf(
      OK_LEDGER({ firstPublishedAnchor: "2026-08-07" }),
      OK_LEDGER({ plannedUnits: 7_000 }),
    );
    expect(computeCompare(prev, cur, OPTS)[0]!.reason).toBeNull();
  });
});

describe("표기 — 숫자 포맷", () => {
  it("0 은 `0pp` 가 아니라 **`0.0pp`** 다", () => {
    // 소수 1자리로 접은 뒤 `Number()` 로 되돌리면 `0.0` → `0` 으로 무너진다.
    // 칩 본문은 문자열 포맷이 정본이라 자릿수가 유지돼야 한다.
    expect(periodChipText(periodChip({ metric: "visibility", delta: 0 }))).toBe("0.0pp");
    expect(periodChipText(periodChip({ metric: "visibility", delta: 0.04 }))).toBe("0.0pp");
    expect(periodChipText(periodChip({ metric: "mentionsPerAnswer", delta: 5 }))).toBe("5.0%");
    expect(periodChipText(periodChip({ metric: "visibility", delta: 2 }))).toBe("2.0pp");
  });
});

describe("i18n — 문구 키가 ko·en 양쪽에 있다", () => {
  const dict = (d: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((a, k) => (a as Record<string, unknown>)?.[k], d);

  const captionKeys: PeriodCaptionKey[] = [
    "window",
    "reason.noPrevWindow",
    "reason.noPrevYear",
    "reason.noPrevWeek",
    "reason.noPrevMonth",
    "reason.noDataPrev",
    "reason.noDataCur",
    "reason.missingShare",
    "reason.startWindow",
    "reason.startMonth",
    "reason.unsupported",
  ];
  const labelKeys: PeriodLabelKey[] = [
    "weekly",
    "biweekly",
    "monthly",
    "yearly",
    "thisMonth",
    "lastMonth",
    "thisWeek",
    "lastWeek",
  ];

  it("캡션 키 전부가 두 사전에 있다", () => {
    for (const k of captionKeys) {
      expect(typeof dict(ko.periodCompare, k), `ko ${k}`).toBe("string");
      expect(typeof dict(en.periodCompare, k), `en ${k}`).toBe("string");
    }
  });

  it("라벨 키 전부가 두 사전에 있다", () => {
    for (const k of labelKeys) {
      expect(typeof dict(ko.periodCompare.label, k), `ko label.${k}`).toBe("string");
      expect(typeof dict(en.periodCompare.label, k), `en label.${k}`).toBe("string");
    }
  });

  it("정책 §5-3 의 세 표기가 사전에 그대로 있다", () => {
    expect(ko.periodCompare.window).toBe("현재 {curCycles}회차 / 직전 {prevCycles}회차 수집 기준");
    expect(ko.periodCompare.reason.missingShare).toBe(
      "직전 기간 수집분이 계획의 {pct}%에 그쳐 비교를 표시하지 않습니다",
    );
    expect(ko.periodCompare.reason.startMonth).toBe(
      "직전 달이 측정을 시작한 달이라 비교를 표시하지 않습니다",
    );
    // 주 비교의 새 라벨.
    expect(ko.periodCompare.label.thisWeek).toBe("지난주 대비");
    expect(en.periodCompare.label.thisWeek).toBe("vs. last week");
  });

  it("사용자 문구에 em dash(U+2014)가 없다", () => {
    expect(JSON.stringify(ko.periodCompare)).not.toContain("—");
    expect(JSON.stringify(en.periodCompare)).not.toContain("—");
  });
});

describe("달력 월은 길이와 무관하게 누락 임계를 적용한다", () => {
  it("28일 달에도 적용한다(창 비교의 30일 하한이 새지 않는다)", () => {
    expect(appliesMissingShare({ kind: "calendarMonth", days: 28 })).toBe(true);
    expect(appliesMissingShare({ kind: "window", days: 28 })).toBe(false);
  });
});
