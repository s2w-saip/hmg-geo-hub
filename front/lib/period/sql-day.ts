import { sql, type SQL } from "drizzle-orm";
import { ANCHOR_DAY_TZ, type DayTimeZone } from "./day-arith";
import {
  ANCHOR_ALIAS,
  anchorMonthSql,
  anchorRoundDateSql,
  anchorWeekSql,
} from "./anchor-axis";

/**
 * 일자·주 경계 **SQL 조각 빌더** — `day-arith.ts` 의 SQL 짝.
 *
 * 같은 절단이 리포 전역에 `AT TIME ZONE 'UTC'` 리터럴로 흩어져 있었다. 조각을 한 곳에
 * 모아 두면 축 전환이 이 파일의 수정으로 끝난다. **이 커밋은 표현식을 하나도 바꾸지
 * 않는다** — 각 호출부가 지금 쓰는 타임존을 그대로 넘기고, 출력 SQL 텍스트는 바이트
 * 동일하다(`lib/period/sql-day.test.ts` 가 조각별 텍스트를 글자로 고정한다).
 *
 * ── ⚠️ 세션 타임존 의존 자리 ───────────────────────────────────────────────
 * `date_trunc('week', <timestamptz>)` 는 **세션 TimeZone 으로 잘린다**. 아래
 * `sessionTzBucketSql` 이 그 형태이고, 오늘 미러 추이 격자가 전부 그것을 쓴다.
 * 세션이 UTC 가 아니면 주 배정이 한 칸 밀리는데 에러가 없어 발견되지 않는다
 * (Supavisor 풀에서 앞선 세션의 GUC 가 남는 경로가 이 리포에 실증돼 있다).
 *
 * **이번 정리에서는 고치지 않는다** — `AT TIME ZONE 'UTC'` 를 붙이는 순간 값이 바뀔
 * 수 있기 때문이다(비UTC 세션에서만이지만, 그 판정을 DB 접속 없이 할 수 없다).
 * 축 전환 단계에서 처리한다.
 *
 * 전환 대상 목록(= `sessionTzBucketSql` 호출부, 전부 scope-aggregates.ts):
 *   · `trendWeekKey`(measured 분기) — 미러 주 격자 정본
 *   · `aggregateStandardTrendFromMirror` / `aggregateCitationAccuracyTrend` /
 *     `aggregateWebsiteCitationAccuracyTrend` 의 `bkt`(+ 스냅샷 CTE 별칭 판)
 *   · `readCitationDomainDayCounts` 의 주 스냅샷(DISTINCT ON·선택·ORDER BY 3자리)
 *   · `getMirrorStatus` 의 distinct week 카운트
 *
 * ⚠️ **아직 이 빌더로 안 들어온 세션 TZ 의존 자리**(모두 scope-aggregates.ts):
 *   · `kpiTabTrendCols`·`kpiTabWindowBoundsSql` 의 `date_trunc(${field}, …)` —
 *     `field` 가 **바인드**라 리터럴 판과 SQL 텍스트가 다르다. 빌더로 바꾸면 바인드가
 *     사라져 바이트 동일이 깨지므로 그대로 뒀다.
 *   · `count(DISTINCT date_trunc('day', …))` 계열(measured_days 진단 카운터 7자리)과
 *     `latestMeasureDays`·ACR 일 버킷 — 기간 축이 아니라 진단·일 롤업이라 제외.
 */

// 타임존은 코드가 고르는 고정 상수다(사용자 입력 아님) — 바인드가 아니라 리터럴로
// 박아야 종전 텍스트와 바이트가 같다.
const tzLiteral = (tz: DayTimeZone): SQL => sql.raw(`'${tz}'`);

/** `(col AT TIME ZONE 'UTC')` — 타임스탬프를 그 타임존의 벽시계로. */
export function atTimeZoneSql(col: SQL, tz: DayTimeZone = ANCHOR_DAY_TZ): SQL {
  return sql`${col} AT TIME ZONE ${tzLiteral(tz)}`;
}

/** `(col AT TIME ZONE 'UTC')::date` — 타임스탬프 → 그 타임존의 달력 일자. */
export function dayOfSql(col: SQL, tz: DayTimeZone = ANCHOR_DAY_TZ): SQL {
  return sql`(${col} AT TIME ZONE ${tzLiteral(tz)})::date`;
}

/** `((day::date)::timestamp AT TIME ZONE 'UTC')` — 일자 → 그 날 00:00 (포함 하한). */
export function dayStartSql(day: string | SQL, tz: DayTimeZone = ANCHOR_DAY_TZ): SQL {
  return sql`((${day}::date)::timestamp AT TIME ZONE ${tzLiteral(tz)})`;
}

/** `(((day::date) + 1)::timestamp AT TIME ZONE 'UTC')` — 반개구간 상한(그 날 포함). */
export function dayAfterSql(day: string | SQL, tz: DayTimeZone = ANCHOR_DAY_TZ): SQL {
  return sql`(((${day}::date) + 1)::timestamp AT TIME ZONE ${tzLiteral(tz)})`;
}

/**
 * `(date_trunc('week', (col AT TIME ZONE 'UTC')))::date` — **명시 타임존** 주 월요일.
 *
 * `::date` 단독 캐스트도, `timestamptz` 직접 절단도 쓰지 않는다: 둘 다 세션 TimeZone 을
 * 탄다(0053 `scope_anchor_fold` 선례).
 */
export function weekStartSql(col: SQL, tz: DayTimeZone = ANCHOR_DAY_TZ): SQL {
  return sql`(date_trunc('week', (${col} AT TIME ZONE ${tzLiteral(tz)})))::date`;
}

/** `date_trunc(unit, …)` 의 허용 단위 — 리터럴로 굳혀 쓰므로 화이트리스트가 필요하다. */
export type SessionTzBucketUnit = "week" | "day" | "month";

/**
 * ⚠️ **세션 TimeZone 의존** 버킷 — `date_trunc('week', <timestamptz>)`.
 *
 * 파일 머리 주석 참조. 종전 식을 **글자 그대로** 옮긴 것이고 값은 바뀌지 않는다.
 * 이 함수를 부르는 자리가 곧 "축 전환 때 고쳐야 할 목록"이다.
 */
export function sessionTzBucketSql(unit: SessionTzBucketUnit, col: SQL): SQL {
  return sql`date_trunc(${sql.raw(`'${unit}'`)}, ${col})`;
}

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
export function periodBucketSql(
  unit: SessionTzBucketUnit,
  measuredCol: SQL,
  opts: { anchorAxis?: boolean; anchorAlias?: string } = {},
): SQL {
  if (!opts.anchorAxis) return sessionTzBucketSql(unit, measuredCol);
  const a = opts.anchorAlias ?? ANCHOR_ALIAS;
  if (unit === "week") return anchorWeekSql(a);
  if (unit === "month") return anchorMonthSql(a);
  return anchorRoundDateSql(a);
}
