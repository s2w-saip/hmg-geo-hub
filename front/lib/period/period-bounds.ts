import { sql, type SQL } from "drizzle-orm";
import { ANCHOR_ALIAS, anchorRoundDateSql } from "./anchor-axis";

/**
 * **기간 경계 술어의 단일 빌더.**
 *
 * `dateFrom`/`dateTo` 를 컬럼에 거는 두 줄(`>= from::date` · `< (to::date + 1)`)이 여섯
 * 자리에 복사돼 있었고, 자리마다 **거는 축이 달랐다**:
 *
 * | 자리 | 축 |
 * | --- | --- |
 * | `scope-aggregates::dateBoundPredicate` / `dateBoundClause` | `COALESCE(r.cycle_anchor_at, r.started_at)` |
 * | `scope-aggregates::cumulativeRunWindow`(run 서브쿼리) | `cycle_anchor_at` · 폴백 `<answers>.measured_at` |
 * | `scope-aggregates::answerWhere`(추이 행 클리핑) | `a.measured_at` |
 * | `scope-aggregates::detailAllRunsWindowPreds` | `<prefix>measured_at` |
 * | `website-sites::websitePromptLens` | `a.measured_at` |
 *
 * 축이 다르면 **같은 달력 선택에서 화면마다 모수가 갈린다**(라이브 실측: 90일 완료 답변
 * 중 `date(measured_at) ≠ date(cycle_anchor_at)` 가 27.0%). 축을 인자로 빼 두면 전환은
 * 호출부마다 **인자 한 줄 교체**가 된다.
 *
 * 이 커밋은 값을 바꾸지 않는다 — 여섯 자리 모두 지금 쓰는 축을 그대로 넘긴다.
 */

/**
 * 기간을 거는 축의 이름.
 *
 * `anchor_round` 가 전환 목표다 — 0077 `scope_answer_cycle_anchors.round_date`
 * (회차 **귀속** 날짜, KST `date`). 기록용 `anchor_date` 가 아니다(계약 §2·§3,
 * 조각 정본은 `lib/period/anchor-axis.ts`).
 */
export type PeriodAxisName =
  /** run 축 — 회차 앵커 우선, 앵커 없는 run 은 시작 시각 폴백. */
  | "run_started"
  /** run 축 — `scope_runs.cycle_anchor_at` 직접(누적 서브쿼리 안). */
  | "run_anchor"
  /** 행 축 — 답변 측정 시각. 추이 버킷·목록 클리핑이 쓴다. */
  | "answer_measured"
  /** 회차 축 — 앵커 테이블의 `round_date`(KST `date`). 옵트인 전환의 목표 축. */
  | "anchor_round";

export interface PeriodAxis {
  name: PeriodAxisName;
  /** 경계를 거는 SQL 식. */
  expr: SQL;
  /**
   * 상한을 `<= to::date` 로 걸지(기본은 `< (to::date + 1)` 반개구간).
   *
   * 축 식이 **`date` 컬럼**이면 둘은 같은 집합이지만, 계약 §3 이 기간을
   * `round_date BETWEEN :from AND :to` 로 적고 있으므로 그 형태를 그대로 낸다 —
   * `(to::date + 1)` 는 timestamptz 를 자정 경계로 자르려던 표기이고, 날짜 컬럼에
   * 남겨 두면 읽는 사람이 "하루가 더 들어가나" 를 매번 다시 따져야 한다.
   */
  inclusiveUpper?: boolean;
}

export function periodAxis(
  name: PeriodAxisName,
  expr: SQL,
  opts: { inclusiveUpper?: boolean } = {},
): PeriodAxis {
  return opts.inclusiveUpper ? { name, expr, inclusiveUpper: true } : { name, expr };
}

/** `COALESCE(<prefix>cycle_anchor_at, <prefix>started_at)` — run 축(앵커 우선). */
export function runStartedAxis(prefix: "" | "r." = "r."): PeriodAxis {
  const col = (n: string) => sql.raw(`${prefix}${n}`); // 고정 리터럴 — 사용자 입력 아님
  return periodAxis("run_started", sql`COALESCE(${col("cycle_anchor_at")}, ${col("started_at")})`);
}

/** `<prefix>cycle_anchor_at` — 누적 run 서브쿼리 안에서는 별칭이 없다. */
export function runAnchorAxis(prefix: "" | "r." = ""): PeriodAxis {
  return periodAxis("run_anchor", sql.raw(`${prefix}cycle_anchor_at`));
}

/** `<expr>` 를 답변 측정 시각 축으로 본다(별칭 표기가 호출부마다 달라 식을 받는다). */
export function answerMeasuredAxis(expr: SQL): PeriodAxis {
  return periodAxis("answer_measured", expr);
}

/**
 * `ca.round_date` — 회차 귀속 날짜 축(계약 §3). 기간은 **양 끝 포함**이다.
 *
 * 이 축을 쓰는 자리는 앵커 테이블이 `FROM`/semi-join 안에 있어야 한다 —
 * 조각 정본은 `lib/period/anchor-axis.ts`(`anchorJoinSql`·`anchorJobIdIn`).
 */
export function anchorRoundAxis(alias = ANCHOR_ALIAS): PeriodAxis {
  return periodAxis("anchor_round", anchorRoundDateSql(alias), { inclusiveUpper: true });
}

export interface PeriodRange {
  dateFrom?: string | null;
  dateTo?: string | null;
}

/**
 * 경계 술어 배열 — `[>= from::date]`, `[< (to::date + 1)]` 순. 한쪽만 있으면 한 개,
 * 둘 다 없으면 빈 배열이다(호출부가 `conds.push(...)` 로 펼쳐 쓰던 형태와 같다).
 *
 * 상한이 `+ 1` 반개구간인 것은 **종료일을 포함**하기 위해서다(그 날 하루 통째로).
 */
export function periodBounds(f: PeriodRange, axis: PeriodAxis): SQL[] {
  const out: SQL[] = [];
  if (f.dateFrom) out.push(sql`${axis.expr} >= ${f.dateFrom}::date`);
  if (f.dateTo) {
    out.push(
      axis.inclusiveUpper
        ? sql`${axis.expr} <= ${f.dateTo}::date`
        : sql`${axis.expr} < (${f.dateTo}::date + 1)`,
    );
  }
  return out;
}

/** 경계를 `AND` 로 묶은 boolean 술어. 기간이 없으면 `true`(무경계). */
export function periodBoundsPredicate(f: PeriodRange, axis: PeriodAxis): SQL {
  const bounds = periodBounds(f, axis);
  return bounds.length ? sql.join(bounds, sql` AND `) : sql`true`;
}

/** 선행 ` AND ` 가 붙은 조각. 기간이 없으면 빈 조각(WHERE 절 뒤에 그대로 이어 붙인다). */
export function periodBoundsClause(f: PeriodRange, axis: PeriodAxis): SQL {
  const bounds = periodBounds(f, axis);
  return bounds.length ? sql` AND ${sql.join(bounds, sql` AND `)}` : sql``;
}
