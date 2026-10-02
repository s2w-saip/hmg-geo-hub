import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  atTimeZoneSql,
  dayAfterSql,
  dayOfSql,
  dayStartSql,
  sessionTzBucketSql,
  weekStartSql,
} from "./sql-day";
import {
  ANCHOR_DAY_TZ,
  isoDaySlice,
  weekStartOf,
  weekStartOrThrow,
} from "./day-arith";

// 이 조각들은 흩어져 있던 표현식을 **글자 그대로** 옮긴 것이다. 호출부의 SQL 텍스트가
// 바이트 동일한지는 여기 텍스트 단언 + 호출부 스냅샷 둘로 증명한다: 조각의 출력이
// 종전 인라인과 같은 문자열이면, 그 자리를 조각 호출로 바꾼 것은 치환일 뿐이다.

const dialect = new PgDialect();
const text = (q: SQL) => dialect.sqlToQuery(q).sql;

describe("SQL 일자 조각 — 종전 인라인과 글자가 같아야 한다", () => {
  it("atTimeZoneSql", () =>
    expect(text(atTimeZoneSql(sql`c.cycle_anchor_at`))).toBe(
      "c.cycle_anchor_at AT TIME ZONE 'UTC'",
    ));

  it("dayOfSql — summary-period-compare anchorDayExpr", () =>
    expect(text(dayOfSql(sql`c.cycle_anchor_at`))).toBe(
      "(c.cycle_anchor_at AT TIME ZONE 'UTC')::date",
    ));

  it("dayStartSql — 바인드 값", () =>
    expect(text(dayStartSql("2026-08-17"))).toBe(
      "(($1::date)::timestamp AT TIME ZONE 'UTC')",
    ));

  it("dayAfterSql — 바인드 값", () =>
    expect(text(dayAfterSql("2026-09-13"))).toBe(
      "((($1::date) + 1)::timestamp AT TIME ZONE 'UTC')",
    ));

  it("weekStartSql — summary-cycles cycleWeekExpr", () =>
    expect(text(weekStartSql(sql`c.cycle_anchor_at`))).toBe(
      "(date_trunc('week', (c.cycle_anchor_at AT TIME ZONE 'UTC')))::date",
    ));

  it("sessionTzBucketSql — 종전 미러 격자(세션 TZ 의존)", () => {
    expect(text(sessionTzBucketSql("week", sql`a.measured_at`))).toBe(
      "date_trunc('week', a.measured_at)",
    );
    expect(text(sessionTzBucketSql("day", sql`a.measured_at`))).toBe(
      "date_trunc('day', a.measured_at)",
    );
  });

  it("타임존은 바인드가 아니라 리터럴이다 (바인드면 텍스트가 갈린다)", () => {
    expect(dialect.sqlToQuery(dayOfSql(sql`x`)).params).toEqual([]);
  });

  it("UTC 아닌 타임존은 던진다 — 조용한 폴백 금지", () => {
    expect(() => isoDaySlice("2026-08-30T22:35:00Z", "Asia/Seoul")).toThrow();
    expect(() => weekStartOf("2026-08-30T22:35:00Z", "Asia/Seoul")).toThrow();
  });
});

describe("JS 일자·주 산술", () => {
  it("현재 축은 UTC", () => expect(ANCHOR_DAY_TZ).toBe("UTC"));

  it("isoDaySlice 는 파싱이 아니라 앞 10자", () => {
    expect(isoDaySlice("2026-08-30T22:35:00Z")).toBe("2026-08-30");
    // 오프셋 표기가 들어오면 그 오프셋의 일자가 나온다 — 종전 utcDay·datePasses 와 동일.
    expect(isoDaySlice("2026-08-31T07:35:00+09:00")).toBe("2026-08-31");
  });

  it("weekStartOf — 일요일 22:35Z 는 그 주 월요일(08-24)", () => {
    expect(weekStartOf("2026-08-30T22:35:00Z")).toBe("2026-08-24");
    expect(weekStartOf("2026-08-31T01:10:00Z")).toBe("2026-08-31");
    expect(weekStartOf("2026-09-06T23:59:59Z")).toBe("2026-08-31");
    expect(weekStartOf("2026-09-07T00:00:00Z")).toBe("2026-09-07");
  });

  it("weekStartOf — 빈 값·파싱 불가는 null", () => {
    expect(weekStartOf(null)).toBeNull();
    expect(weekStartOf(undefined)).toBeNull();
    expect(weekStartOf("")).toBeNull();
    expect(weekStartOf("not-a-date")).toBeNull();
  });

  it("weekStartOrThrow — 파싱 불가 **문자열**은 RangeError (종전 toISOString 계약)", () => {
    expect(weekStartOrThrow("2026-08-30T22:35:00Z")).toBe("2026-08-24");
    expect(() => weekStartOrThrow("not-a-date")).toThrow(RangeError);
  });

  it("weekStartOrThrow — nullish 는 **종전과 계약이 다르다**(옛: '1969-12-29' 반환)", () => {
    // 타입이 금지한 입력이라 두 호출부 모두 선행 가드로 도달 불가다. 그래도 계약을
    // 여기 박아 둔다 — 옛 구현은 `new Date(null)` 이 epoch 로 파싱돼 1969년을 주 키로
    // 조용히 흘렸다(2026-09-19 독립 검증이 실행으로 확인한 유일한 동작 차이).
    for (const bad of [null, undefined, ""]) {
      expect(() => weekStartOrThrow(bad as unknown as string)).toThrow(RangeError);
    }
  });
});
