import { describe, expect, it } from "vitest";
import {
  isYearScaleWindow,
  PERIOD_CHIP_ORDER,
  PERIOD_PRESET_DAYS,
  periodCaption,
  periodChip,
  periodChipText,
  periodPresetKeyOf,
  SUPPRESSED_GLYPH,
  toPeriodDeltaView,
  type PeriodCaptionKey,
} from "./period-compare-view";
import type { CompareLedger, CompareMetricKey, CompareResult } from "./period-compare";

// 표시 계층 — 캡션 키 분기·부호·단위·**금지 문자**를 문자열 규칙으로 못 박는다.
// 컴포넌트 테스트(`renderToStaticMarkup`)는 분기를 정규식으로 보게 되어 조용히 약해진다.

const LEDGER = (o: Partial<CompareLedger> = {}): CompareLedger => ({
  plannedUnits: 100,
  missingUnits: 0,
  publishedCycles: 2,
  dataCycles: 2,
  firstPublishedAnchor: "2026-06-07",
  ...o,
});

const R = (o: Partial<CompareResult> = {}): CompareResult => ({
  metric: "visibility",
  unit: "pp",
  prev: 0.6477,
  cur: 0.7457,
  delta: 9.7984,
  suppressed: false,
  reason: null,
  cyclesPrev: 1,
  cyclesCur: 2,
  plannedPrev: 38748,
  plannedCur: 77496,
  ...o,
});

describe("억제 글리프", () => {
  it("U+2015 HORIZONTAL BAR 이고 U+2014 em dash 가 **아니다**", () => {
    expect(SUPPRESSED_GLYPH).toBe("―");
    expect(SUPPRESSED_GLYPH).not.toBe("—");
    expect(SUPPRESSED_GLYPH.codePointAt(0)).toBe(0x2015);
  });

  it("억제 칩 텍스트에 U+2014 가 0건이다", () => {
    const text = periodChipText(periodChip({ metric: "visibility", delta: null }));
    expect(text).toContain("―");
    expect(text.includes("—")).toBe(false);
  });
});

describe("프리셋", () => {
  it("길이 → 키", () => {
    expect(periodPresetKeyOf(7)).toBe("weekly");
    expect(periodPresetKeyOf(14)).toBe("biweekly");
    expect(periodPresetKeyOf(30)).toBe("monthly");
    expect(periodPresetKeyOf(365)).toBe("yearly");
    expect(periodPresetKeyOf(21)).toBe(null); // 임의 구간
    expect(PERIOD_PRESET_DAYS.yearly).toBe(365);
  });
});

describe("칩", () => {
  it("값은 절대값, 방향은 '좋아졌는가'", () => {
    const up = periodChip({ metric: "visibility", delta: 9.7984 });
    expect(up).toMatchObject({ suppressed: false, value: 9.8, direction: "up", unit: "pp" });
    const down = periodChip({ metric: "visibility", delta: -1.5531 });
    expect(down).toMatchObject({ value: 1.6, direction: "down" });
    expect(periodChipText(up)).toBe("9.8pp");
    expect(periodChipText(down)).toBe("1.6pp");
  });

  it("④ 우선 노출도는 작아지는 것이 좋다(방향만 뒤집는다)", () => {
    const better = periodChip({ metric: "position", delta: -0.4 });
    expect(better).toMatchObject({ value: 0.4, direction: "up", unit: "rank" });
    expect(periodChipText(better)).toBe("0.4"); // 단위 접미사 없음
  });

  it("건수형은 % 접미사", () => {
    expect(periodChipText(periodChip({ metric: "citationsPerAnswer", delta: -63.9 }))).toBe(
      "63.9%",
    );
  });

  it("delta 가 null 이면(억제든 산식 불성립이든) 억제 칩이다", () => {
    expect(periodChip({ metric: "share", delta: null })).toMatchObject({
      suppressed: true,
      value: null,
      direction: "flat",
    });
  });
});

describe("캡션 키 분기", () => {
  const ctx = { days: 7, kind: "window" as const };
  const cap = (reason: CompareResult["reason"], over: Partial<typeof ctx> = {}, extra = {}) =>
    periodCaption(R({ reason }), { ...ctx, ...over, ...extra }).key;

  it("사유별로 키가 갈린다", () => {
    expect(cap(null)).toBe("window");
    expect(cap("unsupported")).toBe("reason.unsupported");
    expect(cap("no_prev")).toBe("reason.noPrevWindow");
    expect(cap("start_window")).toBe("reason.startWindow");
    expect(cap("start_month")).toBe("reason.startMonth");
  });

  it("1년 프리셋의 no_prev 만 전용 문구다(제품 책임자 방향 4)", () => {
    expect(cap("no_prev", { days: 365 })).toBe("reason.noPrevYear");
    expect(cap("no_prev", { days: 30 })).toBe("reason.noPrevWindow");
    expect(periodCaption(R({ reason: "no_prev" }), { days: 30 }).params.days).toBe(30);
  });

  it("no_data 는 현재 구간을 먼저 본다", () => {
    expect(
      periodCaption(R({ reason: "no_data" }), { days: 7, curDataCycles: 0 }).key,
    ).toBe("reason.noDataCur");
    expect(
      periodCaption(R({ reason: "no_data" }), { days: 7, curDataCycles: 3 }).key,
    ).toBe("reason.noDataPrev");
  });

  it("missing_share 는 **수집분** 퍼센트를 싣는다(양쪽이면 직전 구간)", () => {
    const m = periodCaption(R({ reason: "missing_share" }), {
      days: 30,
      prevLedger: LEDGER({ plannedUnits: 35264, missingUnits: 14404 }),
      curLedger: LEDGER({ plannedUnits: 135873, missingUnits: 0 }),
    });
    expect(m.key).toBe("reason.missingShare");
    expect(m.params.pct).toBe(59); // 1 − 0.40846 → 59%
  });

  it("정상 캡션은 회차 수를 싣는다", () => {
    const c = periodCaption(R({ reason: null }), { days: 7 });
    expect(c.params).toMatchObject({ prevCycles: 1, curCycles: 2 });
  });

  it("캡션 키 집합이 고정돼 있다(i18n 키와 1:1)", () => {
    const keys: PeriodCaptionKey[] = [
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
    expect(new Set(keys).size).toBe(11);
  });

  it("달력 월·주의 `no_prev` 는 **일수로 말하지 않는다**", () => {
    // 진행 중인 달의 `days` 는 13 같은 값이라 "직전 13일 구간" 은 틀린 문장이다 —
    // 비교 대상은 직전 **달 전체**다.
    expect(periodCaption(R({ reason: "no_prev" }), { days: 13, kind: "calendarMonth" })).toEqual({
      key: "reason.noPrevMonth",
      params: {},
    });
    expect(periodCaption(R({ reason: "no_prev" }), { days: 5, kind: "calendarWeek" })).toEqual({
      key: "reason.noPrevWeek",
      params: {},
    });
    // 창 비교는 종전 그대로 일수를 싣는다.
    expect(periodCaption(R({ reason: "no_prev" }), { days: 30, kind: "window" })).toEqual({
      key: "reason.noPrevWindow",
      params: { days: 30 },
    });
  });
});

describe("view model", () => {
  const metrics: CompareMetricKey[] = ["visibility", "mentionsPerAnswer"];

  it("칩 순서는 PERIOD_CHIP_ORDER 를 따른다(요청 순서가 아니다)", () => {
    const rs = [
      R({ metric: "mentionsPerAnswer", unit: "pct", delta: 3 }),
      R({ metric: "visibility", delta: 9.8 }),
    ];
    const v = toPeriodDeltaView(rs, { days: 7 });
    expect(v.chips.map((c) => c.key)).toEqual(
      PERIOD_CHIP_ORDER.filter((k) => metrics.includes(k)),
    );
    expect(v.presetKey).toBe("weekly");
  });

  it("사유가 없는데 칩이 전부 억제면 unsupported 캡션으로 닫는다", () => {
    const rs = [R({ delta: null, suppressed: true, reason: null })];
    expect(toPeriodDeltaView(rs, { days: 7 }).caption.key).toBe("reason.unsupported");
  });

  it("결과가 비면 unsupported 다(빈 줄을 그리지 않는다)", () => {
    expect(toPeriodDeltaView([], { days: 7 }).caption.key).toBe("reason.unsupported");
  });
});

describe("U+2014 전수 금지", () => {
  it("이 모듈이 만드는 어떤 문자열에도 em dash 가 없다", () => {
    const all: string[] = [];
    for (const metric of PERIOD_CHIP_ORDER) {
      for (const delta of [null, 0, 1.25, -1.25, 100]) {
        all.push(periodChipText(periodChip({ metric, delta })));
      }
    }
    for (const reason of [
      null,
      "unsupported",
      "no_prev",
      "no_data",
      "missing_share",
      "start_window",
      "start_month",
    ] as const) {
      all.push(periodCaption(R({ reason }), { days: 7, prevLedger: LEDGER() }).key);
    }
    expect(all.join("|").includes("—")).toBe(false);
  });
});

// ── UI 워크트리에서 이식한 회귀 3건 (GGMD-107 통합, 2026-09-19) ──────────────

describe("연간 전용 문구의 도달 (F3)", () => {
  // `yearly` 프리셋이 실제로 만드는 구간은 365 가 아니라 **366일**이다
  // (`presetRange` = 1년 전 같은 날 ~ 끝점, 양 끝 포함). 등호로 판정하면 전용 문구가
  // 영영 안 나오고 고객은 "직전 366일 구간의 …" 을 본다.
  it.each([365, 366, 367])("%i일이면 1년 규모다", (days) => {
    expect(isYearScaleWindow(days)).toBe(true);
    expect(periodCaption(R({ reason: "no_prev", suppressed: true, delta: null }), { days }).key).toBe(
      "reason.noPrevYear",
    );
    expect(periodPresetKeyOf(days)).toBe("yearly");
  });

  it("364일 이하는 창 문구다 — 월간·2주간이 연간으로 새지 않는다", () => {
    for (const days of [7, 14, 30, 364]) {
      expect(isYearScaleWindow(days)).toBe(false);
      const c = periodCaption(R({ reason: "no_prev", suppressed: true, delta: null }), { days });
      expect(c.key, `days=${days}`).toBe("reason.noPrevWindow");
      expect(c.params.days).toBe(days);
    }
  });
});

describe("부호 대칭 반올림 (periodChip)", () => {
  // `Math.round(-0.5) === -0` 이라 크기가 같은 ±0.05 가 다른 상태로 보였다:
  // +0.05 는 "0.1pp 개선", −0.05 만 "0.0pp 변화 없음".
  it("크기가 같으면 표시 크기도 같다", () => {
    const up = periodChip({ metric: "visibility", delta: 0.05 });
    const down = periodChip({ metric: "visibility", delta: -0.05 });
    expect(up.value).toBe(down.value);
    expect(periodChipText(up)).toBe(periodChipText(down));
    expect(up.direction).toBe("up");
    expect(down.direction).toBe("down");
  });

  it("본문이 0.0 인 것과 방향이 flat 인 것이 정확히 같은 집합이다", () => {
    for (const d of [0.04, -0.04, 0.05, -0.05, 0.049999, -0.1, 0.15, -0.15, 0]) {
      const chip = periodChip({ metric: "visibility", delta: d });
      expect(periodChipText(chip).startsWith("0.0"), `delta=${d}`).toBe(chip.direction === "flat");
    }
  });

  it("순위형은 크기 대칭을 지키면서 방향만 뒤집는다", () => {
    expect(periodChip({ metric: "position", delta: -0.44 })).toMatchObject({
      value: 0.4,
      direction: "up", // 순위가 내려간 것 = 개선
    });
    expect(periodChip({ metric: "position", delta: 0.44 })).toMatchObject({
      value: 0.4,
      direction: "down",
    });
  });
});

describe("누락 억제 문구의 퍼센트는 결과에서 온다", () => {
  // 게이트웨이가 화면에 돌려주는 것은 `CompareResult[]` 뿐이라 원장이 넘어가지 않는다.
  it("원장 없이도 수집 비율이 맞는다 (골든 G3: 누락 40.846% → 59%)", () => {
    const c = periodCaption(
      R({
        reason: "missing_share",
        suppressed: true,
        delta: null,
        missingSharePrev: 0.40846,
        missingShareCur: 0,
      }),
      { days: 30 },
    );
    expect(c).toEqual({ key: "reason.missingShare", params: { pct: 59 } });
  });

  it("직전이 임계 미만이면 현재 구간의 비율을 쓴다", () => {
    const c = periodCaption(
      R({
        reason: "missing_share",
        suppressed: true,
        delta: null,
        missingSharePrev: 0.1,
        missingShareCur: 0.75,
      }),
      { days: 30 },
    );
    expect(c.params.pct).toBe(25);
  });

  it("결과가 원장을 이긴다 — 두 경로가 갈리면 화면이 보는 쪽이 맞아야 한다", () => {
    const c = periodCaption(
      R({ reason: "missing_share", suppressed: true, delta: null, missingSharePrev: 0.6 }),
      { days: 30, prevLedger: LEDGER({ plannedUnits: 100, missingUnits: 90 }) },
    );
    expect(c.params.pct).toBe(40); // 결과의 0.6 → 40%, 원장이면 10% 였다
  });
});
