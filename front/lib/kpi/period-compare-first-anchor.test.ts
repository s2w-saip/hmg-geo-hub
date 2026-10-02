import { describe, expect, it } from "vitest";
import { judgeStartWindow, CALENDAR_WEEK_DAYS } from "@/lib/kpi/period-compare";
import { regularRoundDateOf } from "@/lib/kpi/period-compare-week";

// ════════════════════════════════════════════════════════════════════════════
// `F`(전 이력 첫 발행 앵커)의 귀속 — 공식이 아니라 저장된 배정 (검증 D5)
// ════════════════════════════════════════════════════════════════════════════
//
// `regularRoundDateOf` 는 **"같은 주의 정규 요일"** 공식이다. 그런데 스펙 §9.2 의 실제
// 배정에는 자리가 차면 옆 주로 미는 분기가 있다(`basis` = `next_empty`·`nearest`·
// `merged`). 그래서 공식은 저장값과 **최대 한 주** 어긋날 수 있고, 조항 ⑤
// (측정 시작 구간 제외)의 `F > prevLo + grace` 경계에서 판정이 뒤집힌다.
//
// 수리: SQL 이 매핑 표 `scope_cycle_rounds` 에서 `first_published_round` 를 한 컬럼 더
// 읽고, 호출부가 **그 값을 우선**한다. 매핑이 없을 때만 공식으로 폴백한다.
//
// 아래 기대값은 전부 **손계산 리터럴**이다.
// 기준 달력(2026-09):
//   9/7(월) 8 9 10 11(금) 12 13(일) · 9/14(월) 15 16 17 18(금) 19 20(일)
//   9/21(월) 22 23 24 25(금) 26 27(일)

/** 통합 배선의 해소 규칙 — SQL 이 준 매핑이 있으면 그것, 없으면 공식. */
function resolveF(
  surface: "global" | "website",
  mappedRound: string | null,
  anchorKstDay: string | null,
): string | null {
  return mappedRound ?? (anchorKstDay ? regularRoundDateOf(surface, anchorKstDay) : null);
}

describe("공식과 저장된 배정이 갈리는 자리", () => {
  // canonical: 앵커가 이미 정규 요일이면 둘이 같다.
  it("canonical — 웹사이트 금요일 앵커는 공식과 매핑이 같다", () => {
    expect(regularRoundDateOf("website", "2026-09-11")).toBe("2026-09-11");
    expect(resolveF("website", "2026-09-11", "2026-09-11")).toBe("2026-09-11");
  });

  // prev_empty: 같은 주 앞자리로 — 공식과 결과가 같다(주를 안 넘는다).
  it("prev_empty — 목요일 앵커가 같은 주 금요일로 가면 공식도 맞힌다", () => {
    expect(regularRoundDateOf("website", "2026-09-17")).toBe("2026-09-18");
    expect(resolveF("website", "2026-09-18", "2026-09-17")).toBe("2026-09-18");
  });

  // next_empty: **다음 주**로 밀린 배정. 공식은 같은 주를 내므로 7일 어긋난다.
  it("next_empty — 다음 주로 밀리면 공식이 7일 어긋난다", () => {
    const anchor = "2026-09-12"; // 토요일
    expect(regularRoundDateOf("website", anchor)).toBe("2026-09-11"); // 같은 주 금
    // 실제 배정은 9/11 자리가 차 있어 다음 금요일로 밀렸다.
    expect(resolveF("website", "2026-09-18", anchor)).toBe("2026-09-18");
    // 매핑이 없으면 공식으로 떨어진다(= 종전 동작).
    expect(resolveF("website", null, anchor)).toBe("2026-09-11");
  });

  // merged: 앞뒤가 다 차서 가까운 회차에 합쳐진 경우도 주를 넘길 수 있다.
  it("merged — 합쳐진 자리도 매핑이 이긴다", () => {
    const anchor = "2026-09-20"; // 일요일
    expect(regularRoundDateOf("website", anchor)).toBe("2026-09-18");
    expect(resolveF("website", "2026-09-25", anchor)).toBe("2026-09-25");
  });

  it("글로벌은 월요일 자리다", () => {
    expect(regularRoundDateOf("global", "2026-09-17")).toBe("2026-09-14");
    expect(resolveF("global", "2026-09-21", "2026-09-17")).toBe("2026-09-21");
  });

  it("발행 이력이 없으면 null 이다", () => {
    expect(resolveF("global", null, null)).toBeNull();
  });
});

describe("경계 — 갈린 F 가 조항 ⑤ 판정을 뒤집는다", () => {
  // `judgeStartWindow` = `F > prevLo + grace(N)`. 달력 주의 직전 구간은 항상 7일이라
  // grace 는 `CALENDAR_WEEK_DAYS` 로 고정된다.
  const grace = CALENDAR_WEEK_DAYS; // 7
  const prevLo = "2026-09-14"; // 직전 주 월요일

  it("grace 계산이 우리가 가정한 7일이다", () => {
    expect(grace).toBe(7);
  });

  it("공식(9/11)은 시작 구간이 아니고, 실제 배정(9/18)은 시작 구간이다", () => {
    // 같은 앵커(9/12 토)에서 공식과 매핑이 갈리는 경우다.
    const byFormula = resolveF("website", null, "2026-09-12"); // 2026-09-11
    const byMapping = resolveF("website", "2026-09-18", "2026-09-12"); // 2026-09-18
    expect(byFormula).toBe("2026-09-11");
    expect(byMapping).toBe("2026-09-18");

    // F 가 직전 구간 시작보다 **앞**이면 이미 측정 중이던 구간이다 → 제외 안 함.
    expect(
      judgeStartWindow({ firstPublishedAnchor: byFormula, prevLo, days: grace }),
    ).toBe(false);
    // F 가 직전 구간 안이면 그 구간이 곧 시작 구간이다 → 비교 제외.
    expect(
      judgeStartWindow({ firstPublishedAnchor: byMapping, prevLo, days: grace }),
    ).toBe(true);
  });

  it("F 가 없으면 판정하지 않는다(종전과 같다)", () => {
    expect(judgeStartWindow({ firstPublishedAnchor: null, prevLo, days: grace })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// N8 — `F` 는 "가장 이른 앵커를 가진 **그 회차**" 의 귀속일이다
// ════════════════════════════════════════════════════════════════════════════
//
// SQL 이 `min(round_date)` + `INNER JOIN` 이던 때의 오차 두 방향을 손계산으로 못박는다.
// 기준 달력(2026-09): 7(월) … 11(금) … 14(월) … 18(금) … 21(월) … 25(금)

/** SQL 이 내려주는 값 = 앵커가 가장 이른 회차 한 행의 `round_date`(매핑 없으면 NULL). */
type FirstRow = { anchorKst: string; mappedRound: string | null };

/** 수리된 SQL 의 의미를 JS 로 재현한 것 — 테스트가 기대를 만드는 함수가 아니다. */
function firstOf(rows: readonly FirstRow[]): FirstRow | undefined {
  return [...rows].sort((a, b) => a.anchorKst.localeCompare(b.anchorKst))[0];
}

describe("과억제 방향 — 첫 회차만 매핑이 없을 때", () => {
  // 첫 회차(09-07 앵커)에 매핑이 없고 뒤 회차(09-14)에 있다.
  const rows: FirstRow[] = [
    { anchorKst: "2026-09-07", mappedRound: null },
    { anchorKst: "2026-09-14", mappedRound: "2026-09-14" },
  ];

  it("INNER + min() 이면 F 가 09-14 로 **늦어진다**(과억제)", () => {
    const innerMin = rows
      .map((r) => r.mappedRound)
      .filter((d): d is string => d !== null)
      .sort()[0];
    expect(innerMin).toBe("2026-09-14");
  });

  it("수리 후에는 첫 회차가 뽑히고 매핑이 없으니 공식 폴백이다", () => {
    const first = firstOf(rows)!;
    expect(first.anchorKst).toBe("2026-09-07");
    expect(first.mappedRound).toBeNull();
    expect(resolveF("global", first.mappedRound, first.anchorKst)).toBe("2026-09-07");
  });

  it("그 차이가 조항 ⑤ 판정을 뒤집는다", () => {
    // 직전 구간 = 09-07 주. grace(7) = ceil(7/4) = 2 → 경계는 09-09.
    const prevLo = "2026-09-07";
    const days = CALENDAR_WEEK_DAYS;
    // 늦어진 F(09-14)는 경계 뒤라 "시작 구간" 으로 읽혀 **억제**된다(과억제).
    expect(judgeStartWindow({ firstPublishedAnchor: "2026-09-14", prevLo, days })).toBe(true);
    // 올바른 F(09-07)는 경계 앞이라 억제하지 않는다.
    expect(judgeStartWindow({ firstPublishedAnchor: "2026-09-07", prevLo, days })).toBe(false);
  });
});

describe("과소억제 방향 — 뒤 회차가 더 이른 round_date 를 가질 때", () => {
  // §9.2 는 앞 자리로 미는 분기(prev_empty)가 있어 이런 배치가 가능하다:
  // 첫 회차(09-17 앵커)는 뒤 자리 09-21 로, 뒤 회차(09-19 앵커)는 앞 자리 09-14 로.
  const rows: FirstRow[] = [
    { anchorKst: "2026-09-17", mappedRound: "2026-09-21" },
    { anchorKst: "2026-09-19", mappedRound: "2026-09-14" },
  ];

  it("min() 이면 F 가 09-14 로 **빨라진다**(과소억제)", () => {
    const min = rows
      .map((r) => r.mappedRound!)
      .sort()[0];
    expect(min).toBe("2026-09-14");
  });

  it("수리 후에는 첫 회차의 귀속일(09-21)이 F 다", () => {
    const first = firstOf(rows)!;
    expect(first.anchorKst).toBe("2026-09-17");
    expect(resolveF("global", first.mappedRound, first.anchorKst)).toBe("2026-09-21");
  });

  it("그 차이가 조항 ⑤ 판정을 뒤집는다", () => {
    // 직전 구간 = 09-14 주. grace(7) = 2 → 경계는 09-16.
    const prevLo = "2026-09-14";
    const days = CALENDAR_WEEK_DAYS;
    // 빨라진 F(09-14)는 경계 앞이라 억제하지 **않는다**(과소억제).
    expect(judgeStartWindow({ firstPublishedAnchor: "2026-09-14", prevLo, days })).toBe(false);
    // 올바른 F(09-21)는 경계 뒤라 시작 구간으로 억제한다.
    expect(judgeStartWindow({ firstPublishedAnchor: "2026-09-21", prevLo, days })).toBe(true);
  });
});
