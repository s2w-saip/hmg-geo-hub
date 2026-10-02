import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { dayOfSql } from "@/lib/period/sql-day";
import {
  CYCLE_ROUND_ALIAS,
  cycleRoundDateSql,
  cycleRoundJoinSql,
} from "@/lib/period/anchor-axis";
import {
  hiddenCycleColumnsAvailable,
  hiddenCycleScopeAvailable,
} from "@/lib/db/column-availability";
import type { AnchorHiddenFamily } from "@/lib/db/repositories/scope-answer-anchors";
import { cycleViewableSql, type CycleSurface } from "@/lib/db/repositories/summary-cycles";

// ════════════════════════════════════════════════════════════════════════════
// 공용 추이 격자(D5)의 **자리 목록** — 원장이 낸다
// ════════════════════════════════════════════════════════════════════════════
//
// 정본: `internal-kb/hmg-geo-trend-single-source-design-2026-09-20.md` §7.
// W0 실측(A5)이 "원장만으로 격자를 세울 수 있다"를 확정했다: 글로벌 자리 15개가
// 전부 월요일이고, 07-13·07-20·07-27 은 회차가 `closed`·미발행이라 점이 없다.
//
// ── 자리(slot)의 정의 ──────────────────────────────────────────────────────
//
//   자리 키 = **회차 귀속 날짜**(`round_date`, KST). 글로벌 = 월요일 · 웹사이트 =
//   금요일 · 프로젝트 = 앵커 날짜 그대로(정규 요일 없음). 요일을 이 파일이 계산하지
//   않는다 — 0077 배정이 이미 굳혀 둔 값을 읽을 뿐이다(규칙 두 벌 금지).
//
//   한 자리에 회차가 여럿일 수 있다(W0 A3: 글로벌 07-13 둘 · 08-10 셋 · 08-17 둘 ·
//   08-24 둘). 그래서 이 문장은 **회차가 아니라 자리를 행으로** 낸다.
//
// ── 판정은 여기서 하지 않는다 ──────────────────────────────────────────────
//
// SQL 은 **셈만** 한다(서빙 가능 회차 수·수집 오류 수·운영 숨김 수·완결성). 점이냐
// 갭이냐 미표시냐는 `lib/period/trend-grid.ts` 의 순수 함수가 정한다 — 테스트가
// 그 판정을 DB 없이 전수로 고정할 수 있어야 하기 때문이다.
//
// ── 게이트는 카드·달력과 **같은 것** ───────────────────────────────────────
//
//   노출일    `cycleViewableSql()` — 카드·달력과 **같은 조각을 import** 한다(검증 N6).
//             종전에는 같은 뜻의 SQL 을 여기서 다시 썼는데, 규칙이 한 벌이어야 하는
//             자리에 두 벌이 있으면 한쪽만 고치는 결함이 난다(V-2).
//   발행      `active_generation_id IS NOT NULL`
//   함대      `fleet_visible` — 단 **프로젝트 표면은 면제**(원장 함대 개념이 없다).
//             같은 자리 안의 패자는 자리 단위로 합쳐지므로 별도 게이트가 아니라
//             "자리에 서빙 가능한 회차가 하나라도 있는가"로 흡수된다(설계 §6 부수규칙 2).
//   숨김      **계열 단위**다(0071 `hidden_scope`, 앵커 스펙 §10.2). `mentions` 계열은
//             `hidden_scope='citations'` 회차를 숨김으로 보지 않는다.
//
// ── 앵커 표에 행이 없는 회차 (미러 실측 2026-09-20, 초판의 결함) ────────────
//
// 초판은 `COALESCE(cr.round_date, 앵커 KST 일자)` 로 폴백했다 — `summary-cycles.ts`
// 의 기간 술어에서 그대로 옮겨 온 조각이다. 기간 술어에서는 맞는 폴백이지만
// **격자 자리로는 틀린다**: 미러 실측에서 website 자리에 `2026-07-20`(월) ·
// `2026-08-17`(월) · `2026-08-18`(화) · `2026-08-19`(수)가 섞였다. 전부
// `servable_cycles = 0` 이고, 앵커 표에 행이 없어 폴백이 **앵커 요일 그대로** 자리를
// 만든 것이다. 격자의 자리는 정규 요일이어야 한다(앵커 표의 감사
// `off_canonical_round_date = 0` 이 그 성질이다).
//
// 왜 앵커 행이 없나: 앵커 표는 **완료 답변**에서 만들어진다. 완료 답변이 한 건도 없는
// 회차(미발행·유령)는 행이 없다 — `lib/kpi/period-compare-week.ts::regularRoundDateOf`
// 머리 주석이 같은 사실을 같은 이유로 적어 두었다.
//
// 처리(두 단):
//   ① **SQL 이 정규 요일로 스냅한다** — 같은 KST 주의 그 표면 정규 요일.
//      `hmg_anchor_week(앵커 KST 일자) + (hmg_round_canonical_dow(표면) - 1)` 이고
//      이것은 `regularRoundDateOf` 와 **같은 식**이다(월요일 + (dow-1)). 요일 상수는
//      DB 함수 한 곳에서 오므로 TS 로 두 벌이 되지 않는다. 정규 요일이 없는 표면
//      (project)은 그 함수가 NULL 이라 COALESCE 가 앵커 KST 일자로 떨어진다(= 규칙대로).
//   ② **자리를 새로 만들지는 않는다** — 스냅한 회차만 모인 후보는 원장이 그 자리에
//      회차를 귀속시킨 적이 없으므로 자리가 아니다. 그래서 `assigned_cycles`(앵커 행이
//      있는 회차 수)를 실어 보내고, 판정(`toTrendSlots`)이 0인 후보를 버린다.
//      실측 네 건은 전부 같은 주의 금요일 자리(07-24·08-21)로 흡수돼 **자리 수가 늘지
//      않는다** — 합류한 회차는 전부 서빙 불가라 점·갭 판정도 안 바뀐다.
//
// ⚠️ 상관 서브쿼리를 쓰지 않는다(계약 §5) — 귀속 날짜는 `cycleRoundJoinSql` 의
//    **파생 표**에서 온다. `min()` 은 `round_date`(date)에 걸린다(`min(uuid)` 아님).
// ⚠️ 회차 id 목록은 `array_agg(… ::text ORDER BY …)` 다. uuid 정렬을 드라이버 변형에
//    맡기지 않으려고 text 로 못 박는다.
// ⚠️ 문장은 **한 벌**이다(`trendGridSlotSql`). 실행부와 덤프·pglite 가드가 같은 빌더를
//    부른다 — 텍스트를 복사하면 "덤프에는 있는데 가드에는 없는" 문장이 생긴다.

/** 원장이 낸 자리 한 행 — 판정 전의 **원자료**다. */
export interface TrendGridSlotRow {
  /** 자리 키이자 라벨(KST `YYYY-MM-DD`). 그 표면의 정규 요일이다. */
  roundDate: string;
  /**
   * `roundDate` 가 속한 **KST 주의 월요일**(`hmg_anchor_week`). 미러 주 격자
   * (`ca.anchor_week`)와 대조할 때 쓴다.
   *
   * ⚠️ 원장 `cycle_week` 가 **아니다.** 초판이 그것을 실었다가 값이 한 주씩 어긋났다
   *    (미러 실측: 글로벌 06-08 자리의 `cycle_week` 가 06-01). `cycle_week` 는 앵커
   *    **시각**의 UTC 주라 KST 귀속 날짜와 다른 시계다. 자리 키는 `roundDate` 하나이고
   *    이 열은 대조용 파생값일 뿐이다 — 병합(`mergeTrendGrid`)은 이 열을 보지 않는다.
   */
  anchorWeek: string;
  /** 이 자리에 든 회차 전부(정렬). 스냅해 합류한 회차도 포함한다. */
  cycleIds: string[];
  /** 이 자리의 회차 수. */
  totalCycles: number;
  /**
   * 그중 **앵커 표가 이 자리로 귀속시킨** 회차 수. 0 이면 원장이 그 자리에 회차를
   * 둔 적이 없다(스냅해 들어온 것뿐) — 판정이 그 후보를 자리로 세지 않는다.
   */
  assignedCycles: number;
  /** 노출일·발행·함대·숨김(계열) 게이트를 **전부 통과한** 회차 수. */
  servableCycles: number;
  /** 이 계열에서 숨겨졌고 사유가 `collection_error` 인 회차 수. */
  collectionErrorCycles: number;
  /** 사유가 `operator` 인 회차 수(계열 무관). 화면에 음영을 그리지 않는다. */
  operatorCycles: number;
  /**
   * 서빙 가능한 회차의 `completion_ratio` **최댓값**. 없으면 `null`.
   * 임계 판정은 하지 않는다 — 임계는 PR①(W1)의 결정이고 여기는 값만 싣는다.
   */
  completionRatio: number | null;
}

export interface TrendGridSlotQuery {
  surface: CycleSurface;
  projectIds: string[];
  /** 숨김 게이트가 보는 지표 계열(지면 단위). 기본값을 두지 않는다. */
  family: AnchorHiddenFamily;
  /** 안전 상한(일). 이 일수보다 오래된 자리는 아예 안 읽는다. */
  maxDays: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// id 목록은 **바인드 1개**(배열 값)로 넘긴다 — `summary-cycles.ts::uuidArray` 와 같은
// 이유(함대 95~126 프로젝트에서 문장 텍스트가 id 개수만큼 갈려 계획 재사용이 깨진다).
const uuidArray = (ids: string[]): SQL => sql`${sql.param(ids)}::uuid[]`;

/** `(c.cycle_anchor_at AT TIME ZONE 'Asia/Seoul')::date` — 앵커 시각의 KST 일자. */
const anchorKstDate = (alias = "c"): SQL =>
  dayOfSql(sql.raw(`${alias}.cycle_anchor_at`), "Asia/Seoul");

/**
 * 원장 표면 어휘 → **앵커 표 표면 어휘**. 원장은 `global`, 앵커 쪽(0077
 * `hmg_round_canonical_dow`·`selectableAnchorDatesSql`)은 `standard` 다.
 * 매핑을 흩지 말고 여기 한 곳을 경유한다 — 틀리면 `hmg_round_canonical_dow` 가 NULL 을
 * 내고 글로벌 스냅이 조용히 앵커 요일로 떨어진다(= 이 수리가 없앤 그 결함).
 */
export const canonicalRoundSurface = (s: CycleSurface): string =>
  s === "global" ? "standard" : s;

/**
 * 자리 날짜 — **정본은 앵커 표**이고, 행이 없으면 같은 주의 정규 요일로 스냅한다.
 * 정규 요일이 없는 표면(project)은 `hmg_round_canonical_dow` 가 NULL 이라 앵커 KST 일자다.
 */
const slotDateSql = (surface: CycleSurface): SQL =>
  sql`COALESCE(
                 ${cycleRoundDateSql(CYCLE_ROUND_ALIAS)},
                 hmg_anchor_week(${anchorKstDate()})
                   + (hmg_round_canonical_dow(${canonicalRoundSurface(surface)}) - 1),
                 ${anchorKstDate()}
               )`;

/**
 * 이 계열에서 **숨김인가**. 0070 미적용이면 `false`(종전과 같은 판정),
 * 0070 ✓ / 0071 ✗ 이면 범위를 모르므로 회차 전체 숨김으로 본다.
 * 의미는 `scope-answer-anchors.ts::anchorNotHiddenSql` 의 부정과 같다.
 */
function hiddenHereSql(
  family: AnchorHiddenFamily,
  hiddenCols: boolean,
  scopeCol: boolean,
): SQL {
  if (!hiddenCols) return sql`false`;
  // 괄호는 **필수**다. 아래 `NOT ${hiddenHere}` 자리에서 `NOT c.hidden_reason IS NOT NULL`
  // 이 되면 우연히 맞는 우선순위에 기대게 된다(`IS NOT NULL` 이 `NOT` 보다 강하다).
  // 조각이 한 번이라도 바뀌면 조용히 반대 뜻이 되는 자리라 텍스트로 못 박는다.
  return family === "mentions" && scopeCol
    ? sql`(c.hidden_reason IS NOT NULL AND COALESCE(c.hidden_scope, 'all') = 'all')`
    : sql`(c.hidden_reason IS NOT NULL)`;
}

/** 컬럼 가용성까지 확정된 문장 인자 — 빌더는 프로브를 하지 않는다(테스트가 고정할 수 있게). */
export interface TrendGridSlotSqlInput extends TrendGridSlotQuery {
  /** 0070 `hidden_reason`·`hidden_scope` 컬럼이 있는가. */
  hiddenCols: boolean;
  /** 0071 `hidden_scope` 를 계열 판정에 쓸 수 있는가. */
  scopeCol: boolean;
}

/**
 * 자리 목록 문장 — **단일 정본**. 실행부·덤프·pglite 가드가 전부 이것을 부른다.
 * 단일 SELECT(WITH 1개), 세미콜론 없음, 읽기 전용.
 */
export function trendGridSlotSql(q: TrendGridSlotSqlInput): SQL {
  const hiddenHere = hiddenHereSql(q.family, q.hiddenCols, q.scopeCol);
  const reasonCol = q.hiddenCols ? sql`c.hidden_reason` : sql`NULL::text`;
  const idArr = uuidArray(q.projectIds);
  return sql`WITH cyc AS (
        SELECT c.cycle_id::text   AS cycle_id,
               ${slotDateSql(q.surface)} AS round_date,
               (${cycleRoundDateSql(CYCLE_ROUND_ALIAS)} IS NOT NULL) AS assigned,
               c.completion_ratio AS completion_ratio,
               ${reasonCol}       AS reason,
               ${hiddenHere}      AS hidden_here,
               (${cycleViewableSql("c")}
                AND c.active_generation_id IS NOT NULL
                AND (c.surface = 'project' OR c.fleet_visible)
                AND NOT ${hiddenHere}) AS servable
          FROM summary_cycles c${cycleRoundJoinSql(
            sql.raw("c.cycle_id"),
            CYCLE_ROUND_ALIAS,
            sql`ca.project_id = ANY(${idArr})`,
          )}
         WHERE c.surface = ${q.surface}
           AND c.project_id = ANY(${idArr})
      )
      SELECT to_char(g.round_date, 'YYYY-MM-DD')                      AS round_date,
             to_char(hmg_anchor_week(g.round_date), 'YYYY-MM-DD')      AS anchor_week,
             array_agg(g.cycle_id ORDER BY g.cycle_id)                 AS cycle_ids,
             count(*)::int                                             AS total_cycles,
             count(*) FILTER (WHERE g.assigned)::int                   AS assigned_cycles,
             count(*) FILTER (WHERE g.servable)::int                   AS servable_cycles,
             count(*) FILTER (WHERE g.hidden_here
                                AND g.reason = 'collection_error')::int AS collection_error_cycles,
             count(*) FILTER (WHERE g.reason = 'operator')::int         AS operator_cycles,
             max(g.completion_ratio) FILTER (WHERE g.servable)::text    AS completion_ratio
        FROM cyc g
       WHERE g.round_date >= hmg_anchor_today() - ${sql.raw(String(q.maxDays))}
       GROUP BY g.round_date
       ORDER BY g.round_date`;
}

/**
 * 원장 + 앵커 표에서 **자리 목록**을 낸다. 오름차순(이른 자리 먼저).
 *
 * **null = 판정 불가**(표 없음·DB 오류·0077 미적용). 호출부는 이것을 "격자를 못
 * 세웠다"로 읽고 종전 경로를 쓴다 — 빈 배열("자리가 하나도 없다")과 섞지 않는다.
 */
export async function trendGridSlotRows(
  q: TrendGridSlotQuery,
): Promise<TrendGridSlotRow[] | null> {
  const ids = [...new Set(q.projectIds.filter((id) => UUID_RE.test(id)))];
  // ⚠️ **`null` 이다**(검증 C3, 2026-09-20). 초판은 `[]` 를 냈는데, 그 뒤 `[]` 에
  //    "원장이 이 창에 자리가 없다고 답했다" 는 뜻이 생겼다(`trend-grid-buckets.ts`).
  //    스코프를 못 만든 경우는 **문장을 돌리지도 않은 것**이라 그 답이 아니다 —
  //    `[]` 로 두면 scope 미연결 프로젝트(`gapProjectIds` 가 빈 배열)에서 그 지면의
  //    추이가 통째로 빈다. 바로 아래 `maxDays` 가드와 같은 어휘로 맞춘다.
  if (ids.length === 0) return null;
  if (!Number.isInteger(q.maxDays) || q.maxDays <= 0) return null;

  // 컬럼 가용성은 **SQL 을 만들기 전에** 확정한다(이 리포의 모든 원장 조회와 같은 자세).
  const hiddenCols = await hiddenCycleColumnsAvailable();
  // 0071 은 따로 프로브한다 — 0070 에 합치면 "0070 ✓ / 0071 ✗" 배포에서 숨김이 통째로 꺼진다.
  const scopeCol = hiddenCols && (await hiddenCycleScopeAvailable());

  try {
    const rows = (await getDb().execute(
      trendGridSlotSql({ ...q, projectIds: ids, hiddenCols, scopeCol }),
    )) as unknown as Array<{
      round_date: string;
      anchor_week: string | null;
      cycle_ids: string[] | null;
      total_cycles: number;
      assigned_cycles: number;
      servable_cycles: number;
      collection_error_cycles: number;
      operator_cycles: number;
      completion_ratio: string | null;
    }>;
    return rows.map((r) => ({
      roundDate: r.round_date,
      anchorWeek: r.anchor_week ?? r.round_date,
      cycleIds: r.cycle_ids ?? [],
      totalCycles: Number(r.total_cycles),
      assignedCycles: Number(r.assigned_cycles),
      servableCycles: Number(r.servable_cycles),
      collectionErrorCycles: Number(r.collection_error_cycles),
      operatorCycles: Number(r.operator_cycles),
      // `numeric` 은 드라이버가 문자열로 준다 — 판정에 쓰이므로 여기서 수로 고정한다.
      completionRatio: r.completion_ratio == null ? null : Number(r.completion_ratio),
    }));
  } catch {
    return null;
  }
}
