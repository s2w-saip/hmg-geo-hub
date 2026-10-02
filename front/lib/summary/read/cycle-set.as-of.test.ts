import { describe, it, expect } from "vitest";
import { cycleSetAsOf } from "./cycle-set";
import { __testables } from "@/lib/db/repositories/scope-aggregates";
import { formatAsOfDate } from "@/lib/as-of-date";

const { normalizeAsOf } = __testables;

// ════════════════════════════════════════════════════════════════════════════
// 집계층(원장) 경로의 측정 기준일 — 미러 경로와 **같은 값**이어야 한다
// ════════════════════════════════════════════════════════════════════════════
//
// 종전에는 네 자리가 각각 `max(cycleAnchorAt)` → ISO 를 적고 있었고, 미러 경로가
// 앵커 축(`round_date`, KST)으로 옮겨간 뒤 같은 필드(`StandardAggregates.asOf`)에
// 두 시계가 섞였다. 이 파일이 그 합류 지점을 고정한다.
//
// 기대값은 전부 **손계산 리터럴**이다(구현과 같은 함수로 만들지 않는다).
// DB 에 접속하지 않는다 — 순수 함수만 부른다.

/** 손계산 기준: KST = UTC+9 (대한민국은 1988년 이후 서머타임 없음). */
const c = (cycleAnchorAt: string, roundDate?: string) => ({
  cycleAnchorAt,
  ...(roundDate ? { roundDate } : {}),
});

describe("cycleSetAsOf — 축 off(roundDate 없음)는 종전 ISO 그대로", () => {
  it("단일 회차면 그 앵커의 ISO", () => {
    expect(cycleSetAsOf([c("2026-08-31T00:00:00.000Z")])).toBe("2026-08-31T00:00:00.000Z");
  });

  it("여러 회차면 가장 늦은 앵커", () => {
    expect(
      cycleSetAsOf([c("2026-08-24T00:00:00.000Z"), c("2026-09-07T00:00:00.000Z")]),
    ).toBe("2026-09-07T00:00:00.000Z");
  });

  it("빈 집합은 null", () => {
    expect(cycleSetAsOf([])).toBeNull();
  });

  it("파싱 불가 앵커가 섞이면 null (보수적 — 종전 함대 경로와 같은 규칙)", () => {
    expect(cycleSetAsOf([c("2026-09-07T00:00:00.000Z"), c("not-a-date")])).toBeNull();
  });
});

describe("cycleSetAsOf — 축 on(roundDate 실림)은 귀속 날짜", () => {
  it("단일 회차면 그 귀속 날짜", () => {
    // 앵커는 09-13 15:48Z(= KST 09-14 00:48)인데 귀속은 09-14 월요일이다.
    expect(cycleSetAsOf([c("2026-09-13T15:48:44.000Z", "2026-09-14")])).toBe("2026-09-14");
  });

  it("여러 회차면 귀속 날짜의 **사전식** 최대", () => {
    expect(
      cycleSetAsOf([
        c("2026-08-24T01:00:00.000Z", "2026-08-24"),
        c("2026-09-07T01:00:00.000Z", "2026-09-07"),
      ]),
    ).toBe("2026-09-07");
  });

  it("앵커 순서와 귀속 순서가 갈리면 **귀속**이 이긴다", () => {
    // 앵커 최신은 09-17 회차지만 그 회차는 09-11 자리에 귀속됐고(§9.2 빈 자리 배정),
    // 09-14 앵커 회차가 09-18 금요일에 귀속됐다 → 기준일은 09-18 이다.
    expect(
      cycleSetAsOf([
        c("2026-09-17T01:00:00.000Z", "2026-09-11"),
        c("2026-09-14T01:00:00.000Z", "2026-09-18"),
      ]),
    ).toBe("2026-09-18");
  });
});

describe("cycleSetAsOf — 일부만 roundDate 를 가진 섞인 입력", () => {
  // 규약(보고에 명시): 하나라도 실려 있으면 **앵커 축**으로 본다. 안 실린 회차는
  // 빠지지 않고 앵커의 **KST 일자**로 참여한다 — SQL `cycleRoundDate` 의
  // `COALESCE(m.round_date, 앵커 KST 일자)` 가 내는 값과 같아서 형식이 하나로 남는다.
  it("안 실린 회차는 앵커의 KST 일자로 참여한다", () => {
    // 손계산: 2026-09-13 15:48:44Z + 9h = 2026-09-14 00:48:44 KST → 2026-09-14
    expect(
      cycleSetAsOf([c("2026-09-13T15:48:44.000Z"), c("2026-09-07T01:00:00.000Z", "2026-09-07")]),
    ).toBe("2026-09-14");
  });

  it("실린 회차가 더 늦으면 그쪽이 이긴다", () => {
    // 손계산: 2026-09-07 01:00Z + 9h = 2026-09-07 10:00 KST → 2026-09-07
    expect(
      cycleSetAsOf([c("2026-09-07T01:00:00.000Z"), c("2026-09-18T01:00:00.000Z", "2026-09-18")]),
    ).toBe("2026-09-18");
  });

  it("섞여도 출력은 항상 날짜 하나의 형식이다(ISO 가 섞이지 않는다)", () => {
    const out = cycleSetAsOf([
      c("2026-09-13T15:48:44.000Z"),
      c("2026-09-07T01:00:00.000Z", "2026-09-07"),
    ]);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("KST 경계 — UTC 15:00 을 넘기면 다음 날로 센다", () => {
    // 손계산: 14:59:59Z + 9h = 23:59:59 KST(같은 날) / 15:00:00Z + 9h = 다음 날 00:00
    expect(
      cycleSetAsOf([c("2026-08-31T14:59:59.000Z"), c("2026-08-24T01:00:00.000Z", "2026-08-24")]),
    ).toBe("2026-08-31");
    expect(
      cycleSetAsOf([c("2026-08-31T15:00:00.000Z"), c("2026-08-24T01:00:00.000Z", "2026-08-24")]),
    ).toBe("2026-09-01");
  });
});

describe("집계층 asOf == 미러 경로 asOf (같은 회차, 문자열까지)", () => {
  // 미러 경로(앵커 축)는 `to_char(max(ca.round_date), 'YYYY-MM-DD')` 를 내고 JS 는
  // `normalizeAsOf` 로 통과시킨다. 집계층은 같은 회차의 `roundDate` 를 낸다.
  const ROUND = "2026-09-14"; // 손계산 리터럴
  const ANCHOR = "2026-09-13T15:48:44.000Z"; // 그 회차의 앵커(UTC) — KST 로는 09-14 00:48

  it("두 경로의 문자열이 같다", () => {
    const mirror = normalizeAsOf(ROUND); // SQL to_char 결과가 그대로 온 것
    const ledger = cycleSetAsOf([c(ANCHOR, ROUND)]);
    expect(mirror).toBe("2026-09-14");
    expect(ledger).toBe("2026-09-14");
    expect(ledger).toBe(mirror);
  });

  it("화면에 찍히는 날짜도 같다", () => {
    expect(formatAsOfDate(cycleSetAsOf([c(ANCHOR, ROUND)])!)).toBe("2026-09-14");
    expect(formatAsOfDate(normalizeAsOf(ROUND)!)).toBe("2026-09-14");
  });

  it("종전 축이었다면 하루 밀렸다 — 이 전환이 없애는 결함", () => {
    // 종전 집계층은 앵커 ISO 를 그대로 내보냈고 화면이 KST 로 바꿔 찍었다. 앵커가
    // 15:00Z 를 넘긴 회차는 그래서 달력에서 고른 날짜보다 **하루 뒤**로 보인다
    // (손계산: 2026-09-04 15:48:44Z + 9h = 09-05 00:48 KST).
    const anchorRendered = formatAsOfDate("2026-09-04T15:48:44.000Z");
    expect(anchorRendered).toBe("2026-09-05");
    // 귀속 날짜를 쓰면 달력에서 고른 그 날짜(09-04)가 그대로 찍힌다.
    const roundRendered = formatAsOfDate(
      cycleSetAsOf([c("2026-09-04T15:48:44.000Z", "2026-09-04")])!,
    );
    expect(roundRendered).toBe("2026-09-04");
    expect(roundRendered).not.toBe(anchorRendered);
  });
});
