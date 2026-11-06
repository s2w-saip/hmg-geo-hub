// Type-only snapshot; no database or server implementation is included.
import { type SQL } from "drizzle-orm";
import { type DayTimeZone } from "./day-arith";
/** `(col AT TIME ZONE 'UTC')` — 타임스탬프를 그 타임존의 벽시계로. */
export declare function atTimeZoneSql(col: SQL, tz?: DayTimeZone): SQL;
/** `(col AT TIME ZONE 'UTC')::date` — 타임스탬프 → 그 타임존의 달력 일자. */
export declare function dayOfSql(col: SQL, tz?: DayTimeZone): SQL;
/** `((day::date)::timestamp AT TIME ZONE 'UTC')` — 일자 → 그 날 00:00 (포함 하한). */
export declare function dayStartSql(day: string | SQL, tz?: DayTimeZone): SQL;
/** `(((day::date) + 1)::timestamp AT TIME ZONE 'UTC')` — 반개구간 상한(그 날 포함). */
export declare function dayAfterSql(day: string | SQL, tz?: DayTimeZone): SQL;
/**
 * `(date_trunc('week', (col AT TIME ZONE 'UTC')))::date` — **명시 타임존** 주 월요일.
 *
 * `::date` 단독 캐스트도, `timestamptz` 직접 절단도 쓰지 않는다: 둘 다 세션 TimeZone 을
 * 탄다(0053 `scope_anchor_fold` 선례).
 */
export declare function weekStartSql(col: SQL, tz?: DayTimeZone): SQL;
/** `date_trunc(unit, …)` 의 허용 단위 — 리터럴로 굳혀 쓰므로 화이트리스트가 필요하다. */
export type SessionTzBucketUnit = "week" | "day" | "month";
/**
 * ⚠️ **세션 TimeZone 의존** 버킷 — `date_trunc('week', <timestamptz>)`.
 *
 * 파일 머리 주석 참조. 종전 식을 **글자 그대로** 옮긴 것이고 값은 바뀌지 않는다.
 * 이 함수를 부르는 자리가 곧 "축 전환 때 고쳐야 할 목록"이다.
 */
export declare function sessionTzBucketSql(unit: SessionTzBucketUnit, col: SQL): SQL;
/**
 * 추이 버킷의 **축 라우터** — 앵커 축이면 세션 TZ 를 타지 않는 저장 컬럼을 쓴다.
 *
 * | unit | off (종전) | on (앵커 축) |
 * | --- | --- | --- |
 * | `week` | `date_trunc('week', a.measured_at)` | `ca.anchor_week` |
 * | `day` | `date_trunc('day', a.measured_at)` | `ca.round_date` |
 * | `month` | `date_trunc('month', a.measured_at)` | `ca.anchor_month` |
 *
 * 앵커 축에서 `date_trunc` 를 **한 번도 부르지 않는** 것이 요점이다(계약: "앵커 축에서는
 * 세션 타임존 의존 `date_trunc` 를 쓰지 않는다"). 세 컬럼은 쓰기 시점에 KST 로 굳은
 * `date` 라 세션 GUC 가 남아도 주 배정이 밀리지 않는다.
 *
 * `day` 가 `round_date` 인 이유: 앵커 축의 하루 = 회차 하나다. `anchor_date`(실제 측정
 * 앵커일)를 쓰면 달력에서 고른 날짜와 축이 갈린다(§9.2).
 *
 * ⚠️ 종전 경로는 **글자 그대로** `sessionTzBucketSql` 에 위임한다 — 출력 텍스트가 같아야
 * `pg_stat_statements` 정규화 텍스트 비교가 성립한다.
 */
export declare function periodBucketSql(unit: SessionTzBucketUnit, measuredCol: SQL, opts?: {
    anchorAxis?: boolean;
    anchorAlias?: string;
}): SQL;
