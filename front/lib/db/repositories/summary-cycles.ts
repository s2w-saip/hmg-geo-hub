import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { atTimeZoneSql, dayAfterSql, dayOfSql, dayStartSql, weekStartSql } from "@/lib/period/sql-day";
import {
  CYCLE_ROUND_ALIAS,
  cycleRoundDateSql,
  cycleRoundJoinSql,
} from "@/lib/period/anchor-axis";
import {
  SURFACE_LABEL,
  rootSurfaceArmSql,
  websiteSurfaceArmSql,
} from "@/lib/surface/run-surface";
import {
  hiddenCycleColumnsAvailable,
  hiddenCycleScopeAvailable,
} from "@/lib/db/column-availability";
import { dropFleetLosers } from "@/lib/summary/fleet-visible";
// 원장 → 앵커 테이블 전파(스펙 §4 · B2). 같은 트랜잭션 안에서 명시 호출한다.
import {
  answerCycleAnchorsWritable,
  refreshAnchorsForRunsSql,
} from "@/lib/db/repositories/scope-answer-anchors";

// 회차 선택 — 설계 v4.1 §6-5(웹사이트 함대) · §8-3(게이트).
//
// 웹사이트 표면의 "한 회차" 는 프로젝트 하나가 아니라 **함대 주(cycle_week) 안의
// 프로젝트별 회차 집합**이다(0053/0054 가 인코딩한 "124 사이트를 한 주로 정렬,
// 같은 주 두 회차면 큰 쪽만" 규칙 = `fleet_visible`).
//
// 회차가 **하나라도** 있으면 그 회차 집합으로 읽는다(제품 결정 2026-09-06). 그 주에
// 회차가 없는 프로젝트는 폴백으로 메우지 않고 **이번 회차 모수에서 뺀다** — 그것이
// 회차 의미론이다("이번 회차에 이 사이트 데이터 없음"). 종전 미러 경로는 창 없는
// 셀당 최신이라 케이던스가 멈춘 32 프로젝트의 **7월 값**을 이번 주 합산에 섞어
// 보여주고 있었다(패리티 실측 notes/hmg-summary-verify/parity-website-0904.md).
// 부분 혼합(일부는 회차·일부는 미러)은 여전히 금지 — 뺄 뿐 메우지 않는다.
//
// null 은 세 경우뿐이다: 회차가 0개 · 한 프로젝트가 그 주에 2회차(§6-1 규칙 1 위반)
// · 조회 실패(마이그레이션 선/후 배포 내성).

/**
 * 고른 회차 하나 — 표면(글로벌·웹사이트·프로젝트)에 무관하게 같은 튜플이다.
 * 조회는 항상 `(cycle_id, generation_id = active)` 쌍으로 하고, `cycle_week` 는
 * 주 파티션 프루닝용이다(§6-1 규칙 1).
 */
export interface SummaryCyclePick {
  cycleId: string;
  generationId: string;
  projectId: string;
  cycleAnchorAt: string; // ISO
  cycleWeek: string; // YYYY-MM-DD 월요일 (글로벌 KST · 그 외 UTC — cycleWeekForSurfaceExpr)
  /**
   * `summary_cycles.fleet_visible` — 같은 `(표면, 프로젝트, 주)` 에 회차가 둘일 때
   * 관제(`runCycleControl` 5단계)가 고른 **대표 회차인가**. 표면을 가리지 않고 매 실행
   * 재계산된다(웹사이트 전용 값이 아니다).
   *
   * **선택 필드다.** 채우는 곳은 범위 조회(`pickCyclesInRange` → `judgeCycleRange`)와
   * 글로벌 스냅샷 픽(`pickGlobalCycle`)이다. `pickWebsiteCycles` 는 비워 둔다 — 그쪽은
   * `WHERE c.fleet_visible` 을 술어로 걸어 애초에 대표만 나온다.
   *
   * ⚠️ `undefined` = **모른다**(값이 안 실린 경로). 소비자는 `=== false` 일 때만 패자로
   *    본다 — 모르는 것을 패자로 접으면 값이 조용히 사라지는 방향이라 그쪽이 더 나쁘다
   *    (`lib/summary/read/cycle-set.ts::restrictToFleetVisible`).
   */
  fleetVisible?: boolean;
  /**
   * **회차 귀속 날짜**(`round_date`, KST `YYYY-MM-DD`) — 앵커 축(0077)의 기간 키.
   *
   * 매핑 표 `scope_cycle_rounds(project_id, anchor_date → round_date)` 에서 오고,
   * 매핑이 없으면 앵커의 KST 일자로 폴백한다(0077 `hmg_round_date_of` 와 같은 규칙).
   *
   * **선택 필드다.** 앵커 축이 꺼져 있으면 조회가 싣지 않고, 그때 판정은 종전대로
   * `cycleAnchorAt` 의 UTC 일자를 본다(`cycle-set.ts::cycleDayOf`). `undefined` 를
   * 종전 축으로 접는 방향이 안전하다 — 반대로 접으면 매핑 없는 배포에서 기간 판정이
   * 통째로 어긋난다.
   */
  roundDate?: string | null;
  /**
   * **회차 완결성**(`completed_units / expected_units`) — 추이 격자(`X.trendGrid`)의
   * 자리 판정 입력. 값의 정의·임계는 `lib/summary/read/cycle-completion.ts` 가 정본이다.
   *
   * **선택 필드다.** 싣는 경로는 기간 조회(`pickCyclesInRange` → `judgeCycleRange`)이고,
   * 그것도 **격자 키가 켜졌을 때만**이다 — `CycleSet` 은 통째로 `unstable_cache` 의
   * 호출 키가 되므로, 꺼진 배포에 `null` 을 실으면 기존 셀이 전부 미스가 된다
   * (`roundDate` 가 같은 이유로 선택 필드인 것과 같다).
   *
   * ⚠️ `undefined` 와 `null` 이 다른 명제다: `undefined` = 이 경로가 값을 안 싣는다,
   *    `null` = 원장이 카운터를 못 잰 회차다. 둘 다 갭으로 보지 않는 것은 같지만,
   *    전자는 "격자가 꺼져 있다" 이므로 자리 판정 자체가 돌지 않는다.
   */
  completionRatio?: number | null;
}

/** 웹사이트 함대 경로의 종전 이름 — 구조는 `SummaryCyclePick` 과 같다. */
export type WebsiteCyclePick = SummaryCyclePick;

// id 목록은 **바인드 1개**(배열 값)로 넘긴다 — `ARRAY[$1,$2,…]` 펼침은 웹사이트
// 함대(95~126 프로젝트)에서 문장 텍스트를 id 개수만큼 바꿔 계획 재사용을 막는다(PR① B4-a).
// 배열은 `sql.param` 으로만 — 템플릿에 JS 배열을 직접 넣으면 record 로 바인딩된다.
const uuidArray = (ids: string[]): SQL => sql`${sql.param(ids)}::uuid[]`;

/**
 * 뷰 앵커 게이트(**V-2**, 제품 확정 2026-09-10) — "이 회차를 **지금** 서빙해도 되는가".
 *
 * `view_anchor_at` 은 고객이 기대하는 **값이 보이는 날짜**다(`cycle_anchor_at` = 고객이
 * 기대하는 측정일, `measured_at` = 측정 시작 시각). 그날 전에는 회차가 생성·published
 * 되어 있어도 내지 않고 **직전 published 회차를 그대로 낸다**(D-1(2) 경로와 같은 자세).
 * 값을 찍는 쪽은 스왑 tx 한 곳뿐이다(`lib/summary/generate/swap.ts::publishCycleSql`,
 * V-1 = `GREATEST(cycle_anchor_at + 표면 지연, 첫 스왑 시각)`).
 *
 * **정의는 여기 한 벌뿐이다.** 노출 술어가 두 벌이 되면 픽과 범위 판정이 갈려
 * "게이트는 통과했는데 조회는 빈" 회차가 생긴다.
 */
export function cycleViewableSql(alias?: string): SQL {
  const c = sql.raw(alias ? `${alias}.` : "");
  return sql`${c}view_anchor_at IS NOT NULL AND ${c}view_anchor_at <= now()`;
}

/**
 * **원장 숨김 게이트**(0070, 2026-09-10) — "이 회차를 화면에 내도 되는가".
 *
 * `hidden_reason IS NOT NULL` 인 회차는 수집이 깨졌거나 운영 판단으로 내린 회차다.
 * 노출 게이트(`cycleViewableSql`)와 **직교**한다: 저쪽은 "아직 날짜가 안 됐다"(시간),
 * 이쪽은 "이 회차는 값이 틀렸다"(품질). 그래서 술어를 합치지 않고 나란히 AND 한다 —
 * 합치면 "왜 안 보이나" 의 답이 하나로 뭉개진다.
 *
 * ⚠️ 0070 적용 **전** 배포에서는 컬럼이 없다. 그때 이 술어를 그냥 쓰면 42703 으로
 *    조회가 죽고, 이 파일의 픽들은 catch → `null` = **전 화면 미러 폴백**이 된다.
 *    그래서 호출부가 `hiddenCycleColumnsAvailable()` 을 await 한 결과를 넘기고,
 *    false 면 `true`(제약 없음) = 종전과 바이트 동일한 SQL 이 나간다.
 */
export function cycleNotHiddenSql(available: boolean, alias?: string): SQL {
  if (!available) return sql`true`;
  const c = sql.raw(alias ? `${alias}.` : "");
  return sql`${c}hidden_reason IS NULL`;
}

// ── 앵커 축(0077) — 회차의 **귀속 날짜**(`round_date`) 조각 ─────────────────
//
// 계약: `notes/hmg-anchor-table/streams/CONTRACT.md` §2·§3.
//
// 원장(`summary_cycles`)에는 귀속 날짜가 없다 — 회차의 실제 앵커 시각만 있다. 귀속의
// 정본은 답변 단위 앵커 표 `scope_answer_cycle_anchors.round_date` 이고(매핑 표
// `scope_cycle_rounds` 는 그 값을 만든 배정 원장이다), 회차 집합 판정은 **같은 값**을
// 봐야 한다 — 안 그러면 달력에서 고른 날짜와 사실표가 고른 회차가 갈린다.
//
// ⚠️ **매핑 표를 원장 앵커로 찾지 않는다**(2026-09-20 실측 빈틈). 종전 조각은
//    `m.anchor_date = (c.cycle_anchor_at AT TIME ZONE 'Asia/Seoul')::date` 였는데,
//    매핑 표의 `anchor_date` 는 **앵커 표가 실제로 쓴 앵커**(0053 registry 보정 반영)라
//    원장 앵커와 다를 수 있다. website 함대에서 원장 앵커 08-01 인 회차 24개가 registry
//    로 07-27 에 접혀 있었고, 조인이 빗나가 `COALESCE` 폴백이 앵커 KST 일자를 내는 바람에
//    추이 x축에 **토·일 라벨**(08-01·08-02)이 섰다. 조각 정본은 이제 DATA 헬퍼
//    `lib/period/anchor-axis.ts::cycleRoundJoinSql` 한 곳이다.
//
// ⚠️ 상관 서브쿼리를 쓰지 않는다(계약 §5) — 파생 표 + `GROUP BY cycle_id` 다.
//
// 앵커 행이 없으면(백필 전·표면 밖) **앵커의 KST 일자**로 폴백한다
// (`hmg_round_date_of` 와 같은 규칙). 배정이 끝나면 같은 값이다.

/** `(c.cycle_anchor_at AT TIME ZONE 'Asia/Seoul')::date` — 회차 앵커의 KST 일자. */
const cycleAnchorKstDate = (alias = "c"): SQL =>
  dayOfSql(sql.raw(`${alias}.cycle_anchor_at`), "Asia/Seoul");

/** `COALESCE(cr.round_date, <앵커 KST 일자>)` — 기간 술어·판정이 보는 날짜. */
const cycleRoundDate = (alias = "c", m = CYCLE_ROUND_ALIAS): SQL =>
  sql`COALESCE(${cycleRoundDateSql(m)}, ${cycleAnchorKstDate(alias)})`;

/**
 * 축이 **꺼져 있으면 빈 조각**이다 — 조인도 열도 붙지 않아 문장이 종전과 바이트 동일하다.
 * 켜져 있을 때만 `, to_char(…) AS round_date` / ` LEFT JOIN …` 가 붙는다.
 */
const roundDateSelectFrag = (anchorAxis: boolean, alias = "c", m = CYCLE_ROUND_ALIAS): SQL =>
  anchorAxis
    ? sql`,
             to_char(${cycleRoundDate(alias, m)}, 'YYYY-MM-DD') AS round_date`
    : sql``;

/**
 * `scope` 는 바깥 질의와 **같은 프로젝트 집합**이다(상관이 아니라 같은 값의 재기입).
 * 파생 표를 그 집합으로 좁혀 회차 표가 전수로 커지지 않게 한다.
 */
const roundsJoinFrag = (
  anchorAxis: boolean,
  scope: SQL,
  alias = "c",
  m = CYCLE_ROUND_ALIAS,
): SQL =>
  anchorAxis
    ? cycleRoundJoinSql(sql.raw(`${alias}.cycle_id`), m, scope)
    : sql``;

export interface WebsiteCyclePickResult {
  /** 회차가 있는 프로젝트의 회차(프로젝트당 1개). 최소 1개. */
  cycles: WebsiteCyclePick[];
  /** 이번 회차에 데이터가 없는 프로젝트 — 모수에서 제외된다(폴백으로 메우지 않는다). */
  missingProjectIds: string[];
}

/**
 * 최신 함대 주의 프로젝트별 published 회차 집합.
 * - 회차가 하나도 없으면 **null**(전체 폴백).
 * - 한 프로젝트가 그 주에 회차 둘 이상이면 **null**(§6-1 규칙 1 위반 = 조회 계층 거부).
 * - 표가 없거나 조회가 실패해도 **null**(마이그레이션 선/후 배포 내성).
 * - 일부 프로젝트에 회차가 없는 것은 정상 — `missingProjectIds` 로 돌려준다.
 */
export async function pickWebsiteCycles(
  projectIds: string[],
  // 앵커 축(0077): 켜면 회차의 **귀속 날짜**(`round_date`)를 함께 싣는다. 스냅샷 픽의
  // 선택 자체는 바뀌지 않는다 — 기간이 "회차 하나로 떨어지는가" 판정(`dateRangeReason`)
  // 이 그 날짜를 보기 때문에 싣는 것뿐이다.
  opts: { anchorAxis?: boolean } = {},
): Promise<WebsiteCyclePickResult | null> {
  if (projectIds.length === 0) return null;
  const anchorAxis = opts.anchorAxis === true;
  const ids = uuidArray(projectIds);
  // 숨김 게이트는 **SQL 을 만들기 전에** 확정한다(컬럼 없는 배포에서 42703 → 전 화면 폴백).
  // 프로브는 **한 번만** 묻고 두 별칭 술어를 파생한다 — 두 번 await 하면 같은 문장 안에서
  // 서로 다른 답을 받을 수 있고(프로브가 도중에 갱신되면), 그때 SQL 한쪽에만 술어가 붙는다.
  const hiddenCols = await hiddenCycleColumnsAvailable();
  const notHidden = cycleNotHiddenSql(hiddenCols);
  const notHiddenC = cycleNotHiddenSql(hiddenCols, "c");
  try {
    const rows = (await getDb().execute(sql`
      WITH wk AS (
        SELECT max(cycle_week) AS w
        FROM summary_cycles
        WHERE surface = 'website' AND fleet_visible
          AND ${cycleViewableSql()} AND active_generation_id IS NOT NULL
          AND ${notHidden}
          AND project_id = ANY(${ids})
      )
      SELECT c.cycle_id::text          AS cycle_id,
             c.active_generation_id::text AS generation_id,
             c.project_id::text        AS project_id,
             c.cycle_anchor_at         AS cycle_anchor_at,
             to_char(c.cycle_week, 'YYYY-MM-DD') AS cycle_week${roundDateSelectFrag(anchorAxis)}
      FROM summary_cycles c${roundsJoinFrag(anchorAxis, sql`ca.project_id = ANY(${ids})`)}, wk
      WHERE c.surface = 'website' AND c.fleet_visible
        AND ${cycleViewableSql("c")} AND c.active_generation_id IS NOT NULL
        AND ${notHiddenC}
        AND c.cycle_week = wk.w
        AND c.project_id = ANY(${ids})
    `)) as unknown as Array<{
      cycle_id: string;
      generation_id: string;
      project_id: string;
      cycle_anchor_at: Date | string;
      cycle_week: string;
      round_date?: string | null;
    }>;
    if (rows.length === 0) return null;
    const byProject = new Map<string, WebsiteCyclePick>();
    for (const r of rows) {
      // 같은 프로젝트가 한 주에 둘 이상 = 세부층 규칙 위반 → 폴백.
      if (byProject.has(r.project_id)) return null;
      byProject.set(r.project_id, {
        cycleId: r.cycle_id,
        generationId: r.generation_id,
        projectId: r.project_id,
        cycleAnchorAt: new Date(r.cycle_anchor_at).toISOString(),
        cycleWeek: r.cycle_week,
        // 축이 꺼져 있으면 열 자체가 없다 → `undefined` = 종전 축(판정이 앵커 일자를 본다).
        ...(r.round_date ? { roundDate: r.round_date } : {}),
      });
    }
    // 회차가 없는 프로젝트는 이번 회차 모수 밖이다 — 목록만 돌려준다.
    const missingProjectIds = [...new Set(projectIds)].filter((id) => !byProject.has(id));
    return { cycles: [...byProject.values()], missingProjectIds };
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 글로벌(표준 루트) 표면의 노출 가능한 **최신 주의 대표 회차 1개** — 설계 v4.1 §6-5.
 *
 * 글로벌은 프로젝트가 루트 하나뿐이라 함대 개념이 없다. 회차가 없거나 조회가
 * 실패하면 **null**(전체 폴백) — 웹사이트와 같은 자세다:
 * 표 미적용(마이그레이션 선/후 배포)·DB 오류·미생성이 전부 같은 결과로 수렴한다.
 *
 * `rootProjectId` 는 `scope_runs.project_id`(= 사실표 `project_id`)다.
 * mock 모드의 플레이스홀더(`mock-root-project`)처럼 uuid 가 아닌 값은 캐스트
 * 오류를 내기 전에 걸러 낸다 — 폴백 결과는 같지만 DB 에 잡음을 남기지 않는다.
 *
 * ── 왜 "최신 앵커" 가 아니라 "최신 주의 대표" 인가 (2026-09-18, 제품 확정) ──
 *
 * 중복 주(같은 `cycle_week` 에 회차 둘)에서는 **뒤에 열린 쪽이 결손·부분 재측정**이다
 * (프로덕션 실측: 8/17 주 = 대표 08-18 9,068유닛 76.1% / 패자 08-19 906유닛 87.0%).
 * 종전 `ORDER BY cycle_anchor_at DESC LIMIT 1` 은 그 패자를 골랐다. 그 결과 카드·asOf
 * (스냅샷)와 추이 끝점(2026-09-18 커밋 ddf4d59 로 대표만 찍는다)이 같은 주에서 갈리고,
 * 경쟁사 top-N 로스터도 출처가 두 벌이 된다(검증자 R1).
 *
 * 조회는 **두 단**이다. `LIMIT 1` 을 `ORDER BY fleet_visible DESC` 로 바꾸지 않은 이유:
 *   1단 `wk` — 종전 술어 그대로 고른 **최신 회차의 주**. 즉 "어느 주를 볼 것인가" 는
 *        종전과 **바이트 단위로 같은 판정**이다(중복 주가 아니면 결과도 같다).
 *   2단    — 그 주의 노출 가능 회차를 전부 가져와 **JS 가 대표를 고른다**
 *        (`dropFleetLosers` — 추이·감시와 같은 함수. 규칙 두 벌 금지).
 *
 * 그래서 "대표가 숨김·미발행이라 후보에 없는 주" 는 **패자가 그대로 선택된다** — 그 주를
 * 건너뛰고 더 과거 회차로 물러나지 않는다. 술어(`WHERE c.fleet_visible`)로 걸면 정확히
 * 그 후퇴가 일어나고, 화면은 이유 없이 한 주 낡은 값을 낸다.
 *
 * ⚠️ 숨김(0070/0071)과의 상호작용은 **종전 그대로**다: 이 픽의 `cycleNotHiddenSql` 은
 *    범위를 안 보므로 `hidden_scope='citations'` 회차도 후보에서 빠진다(스냅샷은 회차
 *    전체가 한 "측정 기준일" 이라 반쪽을 낼 수 없다 — `schema.migration-0071.test.ts`).
 *    그 경우 같은 주에 남는 회차가 패자뿐이면 위 규칙대로 패자가 선택된다.
 */
export async function pickGlobalCycle(
  rootProjectId: string,
  // 앵커 축(0077) — `pickWebsiteCycles` 와 같은 계약(값을 싣기만 한다).
  opts: { anchorAxis?: boolean } = {},
): Promise<SummaryCyclePick | null> {
  if (!rootProjectId || !UUID_RE.test(rootProjectId)) return null;
  const anchorAxis = opts.anchorAxis === true;
  // 프로브 1회 → 두 별칭(`pickWebsiteCycles` 와 같은 자세). 2단이 서로 다른 답을 받으면
  // 1단만 숨김을 걸어 "고른 주에서 아무것도 못 고르는" 공집합이 난다.
  const hiddenCols = await hiddenCycleColumnsAvailable();
  const notHidden = cycleNotHiddenSql(hiddenCols, "c");
  const notHiddenW = cycleNotHiddenSql(hiddenCols, "w");
  try {
    const rows = (await getDb().execute(sql`
      WITH wk AS (
        SELECT w.cycle_week AS cycle_week
        FROM summary_cycles w
        WHERE w.surface = 'global'
          AND w.project_id = ${rootProjectId}::uuid
          AND ${cycleViewableSql("w")}
          AND w.active_generation_id IS NOT NULL
          AND ${notHiddenW}
        ORDER BY w.cycle_anchor_at DESC
        LIMIT 1
      )
      SELECT c.cycle_id::text             AS cycle_id,
             c.active_generation_id::text AS generation_id,
             c.project_id::text           AS project_id,
             c.cycle_anchor_at            AS cycle_anchor_at,
             to_char(c.cycle_week, 'YYYY-MM-DD') AS cycle_week,
             c.fleet_visible              AS fleet_visible${roundDateSelectFrag(anchorAxis)}
      FROM summary_cycles c${roundsJoinFrag(anchorAxis, sql`ca.project_id = ${rootProjectId}::uuid`)}, wk
      WHERE c.surface = 'global'
        AND c.project_id = ${rootProjectId}::uuid
        AND ${cycleViewableSql("c")}
        AND c.active_generation_id IS NOT NULL
        AND ${notHidden}
        AND c.cycle_week = wk.cycle_week
      ORDER BY c.cycle_anchor_at DESC
    `)) as unknown as Array<{
      cycle_id: string;
      generation_id: string;
      project_id: string;
      cycle_anchor_at: Date | string;
      cycle_week: string;
      fleet_visible: boolean | null;
      round_date?: string | null;
    }>;
    const picks: SummaryCyclePick[] = rows.map((r) => ({
      cycleId: r.cycle_id,
      generationId: r.generation_id,
      projectId: r.project_id,
      cycleAnchorAt: new Date(r.cycle_anchor_at).toISOString(),
      cycleWeek: r.cycle_week,
      // `pickCyclesInRange` 와 같은 방향 — 모르면 대표로 접는다(`=== true` 금지).
      fleetVisible: r.fleet_visible !== false,
      ...(r.round_date ? { roundDate: r.round_date } : {}),
    }));
    // 같은 주에 대표가 있으면 패자를 버린다. 대표가 없으면 전부 남는다(그때는 아래
    // `[0]` = 그 주의 최신 앵커 = 종전 동작). 정렬이 앵커 내림차순이라 `[0]` 이 최신이다.
    const picked = dropFleetLosers(picks, (c) => c.cycleWeek, (c) => c.fleetVisible)[0] ?? null;
    // 관측 — **패자를 서빙한다**(그 주에 노출 가능한 대표가 없다). 설계된 폴백이지 오류가
    // 아니지만, 화면 값이 결손 회차라는 사실이 로그에 남아야 "왜 이 숫자냐" 에 답할 수 있다.
    // 로그 어휘는 `x-hmg-summary(...)` 관례를 따른다(게이트 로그와 같은 grep 으로 잡힌다).
    if (picked && picked.fleetVisible === false) {
      console.info(
        `x-hmg-summary(global snapshot): fleet-loser-served week:${picked.cycleWeek} anchor:${picked.cycleAnchorAt}`,
      );
    }
    return picked;
  } catch {
    return null;
  }
}

// ── 회차 **집합** 선택 (기간·추이 표면) — PR② T9 / 플랜 §6-3 ────────────────
//
// 스냅샷 두 픽(`pickGlobalCycle`·`pickWebsiteCycles`)은 "노출 가능한 최신 회차" 만
// 돌려준다. 기간 표면은 판정이 반대다 — **범위 안에 무엇이 있는지 전부** 봐야
// "합계에 구멍이 있는가"(§6-3 (b))를 알 수 있다. 그래서 이 문장은 노출 불가 회차도
// 함께 걷어 오고, 판정은 `lib/summary/read/cycle-set.ts` 의 순수 함수가 한다.
//
// 열은 판정에 필요한 것만 7개다. 행은 원장 크기에 비례한다(2026-09-10 실측: 원장
// 전체가 96행 — global 1 + website 95). 함대 13주면 최대 1,235행이고 전부 좁은 행이라
// 전송 비용이 무시할 수준이다. **회차 수 상한은 두지 않는다**(제품 확정 D-2 (2)) —
// 대신 회차 수를 관측 헤더에 노출한다.
//
// ⚠️ 날짜 경계는 **UTC 일**이다 — 게이트의 `utcDay`(ISO 앞 10자)와 같은 축이어야
//    한다. 서버 TimeZone 에 의존하는 `$1::date::timestamptz` 를 쓰지 않고
//    `($1::date)::timestamp AT TIME ZONE 'UTC'` 로 못 박는다. 상계는 반열림
//    (`< to+1일`)이라 그날 안의 어느 시각 anchor 도 포함된다.
// ⚠️ 날짜는 **스칼라 바인드**다. `sql.param(배열)::date[]` 는 drizzle-orm/postgres-js
//    가 date/timestamp/numeric 직렬화기를 항등함수로 덮어써 실 DB 에서 죽는다
//    (`summary-website-aggregates.ts::dateArray` 주석). 여기서는 배열이 필요 없다.

/** 범위 조회 한 행 — 판정에 필요한 최소 열. */
export interface CycleRangeRow {
  cycleId: string;
  /** 노출 불가 회차는 null 일 수 있다(그래서 판정 후에만 회차로 승격한다). */
  generationId: string | null;
  projectId: string;
  cycleAnchorAt: string; // ISO
  cycleWeek: string; // YYYY-MM-DD 월요일 (글로벌 KST · 그 외 UTC — cycleWeekForSurfaceExpr)
  /** `summary_cycles.status` 원값 — `open` 을 구멍에서 빼기 위해 필요하다. */
  status: string;
  /**
   * 오늘의 "노출 가능(published)" 정의 =
   * `cycleViewableSql()`(V-2: `view_anchor_at IS NOT NULL AND view_anchor_at <= now()`)
   * `AND active_generation_id IS NOT NULL`.
   * 스냅샷 두 픽이 쓰는 술어와 **같은 것**이다 — 원장 `status` 문자열과 갈리면
   * 조회 가능성이 이긴다(그래서 `stale` 도 노출 가능이면 집합에 남는다).
   */
  renderable: boolean;
  /**
   * **아직 노출일 전**(V-2 금족) — 생성·published 는 끝났는데 `view_anchor_at > now()`.
   *
   * `renderable=false` 의 두 원인을 갈라 놓기 위한 열이다. "생성이 안 됐다"(구멍)와
   * "곧 나올 것이 아직 날짜가 안 됐다"는 다른 명제다 — 후자를 구멍으로 세면 V-1 이
   * 켜진 뒤 **모든 새 회차가 1~2일씩 전 화면을 폴백시킨다**(종전 `newer-runs` 상시
   * 폴백과 같은 형태). 판정은 `cycle-set.ts::judgeCycleRange` 가 한다.
   */
  pending: boolean;
  /**
   * `summary_cycles.analysis_gap_ratio` — 그 회차 답변 중 **분석이 안 붙은 비율**.
   *
   * `renderable=false` 의 세 번째 원인을 가르기 위한 열이다(F1). 이 값이
   * `ANALYSIS_GAP_MAX` 를 넘는 `closed` 회차는 생성기가 `--pending` 에서 **뽑지 않으므로**
   * scope 분석 백필이 오기 전에는 영원히 미발행이다 — "아직 안 만들어진 구멍"이 아니라
   * **미발행 확정**이고, 구멍으로 세면 기간 조회가 그 회차 때문에 영구히 폴백한다.
   * `null` = 갭을 모른다(그때는 구멍으로 본다 — 모르면 보수적으로).
   */
  analysisGapRatio: number | null;
  /**
   * **유령 회차** 판별용 — 관제가 멤버 0 인 채로 열고 즉시 닫은 회차(위 D1 경고 ③).
   *
   * `expected_units IS NULL AND completed_units = 0` 이면 그 회차에는 측정 유닛이 아예
   * 없다. 갭(`analysis_gap_ratio`)도 `NULL` 이라 생성기의 `analysis_gap_ratio <= gapMax`
   * 술어가 **SQL 3값 논리로 영원히 거짓**이다 — 백필이 와도 안 뽑힌다. 그래서 읽기 쪽도
   * skipped 와 같은 성질로 면제한다(`cycle-set.ts::isGeneratorSkipped`).
   * ⚠️ 갭이 `NULL` 이어도 **멤버가 있는** 회차는 여전히 구멍이다(fail-closed).
   */
  expectedUnits: number | null;
  completedUnits: number | null;
  /**
   * **원장 숨김**(0070) — `hidden_reason IS NOT NULL`. `renderable=false` 의 네 번째
   * 원인이자, 유일하게 **사람이 찍은** 원인이다.
   *
   * 판정은 skipped 와 같다(구멍이 아니라 **의도된 제외**) — `cycle-set.ts::judgeCycleRange`.
   * 구멍으로 세면 숨기는 순간 그 창의 기간 조회가 통째로 미러로 떨어진다(= 숨김이
   * 목적과 정반대로 골짜기를 되살린다).
   *
   * 0070 미적용 배포에서는 컬럼이 없어 항상 `false` 다(= 종전 판정 그대로).
   */
  hidden: boolean;
  /**
   * **숨김 범위**(0071) — `all` = 회차 전체 · `citations` = 인용 계열만.
   *
   * `hidden` 이 참일 때만 의미가 있다. 판정은 `cycle-set.ts::judgeCycleRange` 가 둘로 가른다:
   *   · `all`       → 창에서 뺀다(오늘 그대로). 반쪽 회차를 합계에 넣을 수 없다.
   *   · `citations` → **창에 넣는다**(D2 A1). 언급 4 KPI 는 실값이고, 인용 계열만
   *                   `trend-gaps.ts` 의 회차 축 마킹이 갭으로 덮는다.
   * 둘 다 `holes`(구멍) 면제는 유지한다 — 숨김은 "빠진 회차" 가 아니라 의도된 제외다.
   *
   * **기본값을 두지 않는다.** `CycleRangeRow` 를 만드는 자리가 늘면 컴파일 에러가 나야
   * 한다(0071 이 `family` 에 세운 규율과 같은 이유). 0071 미적용 DB 에서는 SQL 이
   * 리터럴 `'all'` 을 실어 **오늘 동작으로 폴백**한다.
   */
  hiddenScope: HiddenCycleScope;
  /**
   * **같은 주 대표 회차인가**(`fleet_visible`, 0059부터 `NOT NULL DEFAULT true`).
   *
   * 관제 5단계(`cycleFleetSql`)가 `(surface, project_id, cycle_week)` 마다 하나만
   * `true` 로 둔다 — **글로벌도 대상이다**(표면을 안 가린다). 웹사이트는 이 술어가
   * `pickCyclesInRange` 의 `WHERE` 에 이미 걸려 있어 여기 실리는 값이 항상 `true` 지만,
   * 글로벌은 걸지 않으므로 패자(`false`)도 그대로 실려 온다.
   *
   * 판정에는 쓰지 않는다(구멍·주 중복은 종전 그대로) — **글로벌 추이 경로만** 이 값으로
   * 점을 고른다(`cycle-set.ts::restrictToFleetVisible`). 누적·스냅샷은 안 본다.
   */
  fleetVisible: boolean;
  /**
   * **회차 귀속 날짜**(`round_date`, KST) — 앵커 축이 켜졌을 때만 실린다.
   * `undefined` = 종전 축(판정이 `cycleAnchorAt` 의 UTC 일자를 본다).
   */
  roundDate?: string | null;
}

export interface CycleRangeQuery {
  surface: CycleSurface;
  projectIds: string[];
  /**
   * 기간 경계(YYYY-MM-DD, inclusive). null = 무한(한쪽만 줘도 open-ended).
   *
   * 축에 따라 **무엇의 일자인가** 가 다르다:
   *   · 종전 축  — `cycle_anchor_at` 의 **UTC** 일자(게이트의 `utcDay` 와 같은 축).
   *   · 앵커 축  — 회차의 **귀속 날짜**(`round_date`, KST). 달력이 고르는 것과 같은 값.
   */
  dateFrom?: string | null;
  dateTo?: string | null;
  /**
   * 앵커 축(0077)으로 판정하는가. 기본 `false` = 종전(문장이 바이트 동일하다).
   *
   * 켜면 ① 매핑 표를 LEFT JOIN 해 `round_date` 를 싣고 ② 기간 술어를 그 날짜에
   * **양 끝 포함**(`BETWEEN`)으로 건다. 종전의 반열림 상한(`< to+1일`)은 timestamptz
   * 를 자정에서 자르려던 표기이고, `date` 컬럼에서는 같은 집합을 더 읽기 쉽게 쓴다.
   */
  anchorAxis?: boolean;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 범위 안의 회차 전부(노출 불가 포함) — 판정은 호출부(`cycle-set.ts`)가 한다.
 *
 * **null = 판정 불가**(표 없음·DB 오류). 호출부는 이것을 폴백으로 삼는다(fail-closed).
 * 빈 배열은 판정 가능하되 "범위에 회차 없음" 이라는 다른 명제다 — 섞지 않는다.
 */
export async function pickCyclesInRange(
  q: CycleRangeQuery,
): Promise<CycleRangeRow[] | null> {
  // uuid 가 아닌 값(mock 모드 플레이스홀더)은 캐스트 오류 전에 걸러 낸다.
  const ids = [...new Set(q.projectIds.filter((id) => UUID_RE.test(id)))];
  if (ids.length === 0) return [];
  if (q.dateFrom && !DAY_RE.test(q.dateFrom)) return null;
  if (q.dateTo && !DAY_RE.test(q.dateTo)) return null;

  // 숨김 컬럼 유무를 **SQL 을 만들기 전에** 확정한다(이 파일의 다른 픽과 같은 자세).
  const hiddenCols = await hiddenCycleColumnsAvailable();
  const hiddenExpr = hiddenCols ? sql`(c.hidden_reason IS NOT NULL)` : sql`false`;
  // 범위 컬럼(0071)은 **따로** 프로브한다 — 0070 프로브에 합치면 "0070 ✓ / 0071 ✗" 배포에서
  // 숨김이 통째로 꺼진다(`column-availability.ts::hiddenCycleScopeAvailable` 주석의 4상태).
  // 순서는 `hiddenCycleSlots` 와 같게 **0070 이 참일 때만** 묻는다: hidden_reason 이 없으면
  // `hidden` 이 항상 false 라 범위가 판정에 안 쓰이고, 콜드 왕복만 하나 늘 뿐이다.
  // 0071 미적용이면 리터럴 `'all'` — 판정이 0071 이전(회차 전체 숨김)으로 폴백한다.
  const hiddenScopeExpr =
    hiddenCols && (await hiddenCycleScopeAvailable())
      ? sql`COALESCE(c.hidden_scope, 'all')`
      : sql`'all'`;
  const anchorAxis = q.anchorAxis === true;
  const conds: SQL[] = [
    sql`c.surface = ${q.surface}`,
    sql`c.project_id = ANY(${uuidArray(ids)})`,
  ];
  // 함대 가시성은 **웹사이트 표면의 회차 정의**에 들어 있다(0053/0054) — 그래서 여기서
  // 술어로 건다. 글로벌은 걸지 않는다: 누적(합산)은 한 주 두 회차를 더하는 것이 정당하고,
  // 판정(구멍·빈 집합)도 패자 회차를 봐야 정확하다. 대신 값을 열로 실어 보내 **추이 경로만**
  // 거른다(`cycle-set.ts::restrictToFleetVisible`) — 술어로 올리면 누적까지 바뀐다.
  if (q.surface === "website") conds.push(sql`c.fleet_visible`);
  // 기간 경계 — 앵커 축은 **귀속 날짜**(KST `date`)에 양 끝 포함으로, 종전 축은
  // 앵커 시각의 UTC 일 경계에 반열림으로 건다.
  if (q.dateFrom) {
    conds.push(
      anchorAxis
        ? sql`${cycleRoundDate()} >= ${q.dateFrom}::date`
        : sql`c.cycle_anchor_at >= ${dayStartSql(q.dateFrom)}`,
    );
  }
  if (q.dateTo) {
    conds.push(
      anchorAxis
        ? sql`${cycleRoundDate()} <= ${q.dateTo}::date`
        : sql`c.cycle_anchor_at < ${dayAfterSql(q.dateTo)}`,
    );
  }

  try {
    const rows = (await getDb().execute(sql`
      SELECT c.cycle_id::text             AS cycle_id,
             c.active_generation_id::text AS generation_id,
             c.project_id::text           AS project_id,
             c.cycle_anchor_at            AS cycle_anchor_at,
             to_char(c.cycle_week, 'YYYY-MM-DD') AS cycle_week,
             c.status                     AS status,
             (${cycleViewableSql("c")} AND c.active_generation_id IS NOT NULL) AS renderable,
             (c.view_anchor_at IS NOT NULL AND c.view_anchor_at > now()
              AND c.active_generation_id IS NOT NULL) AS pending,
             c.analysis_gap_ratio::text   AS analysis_gap_ratio,
             c.expected_units             AS expected_units,
             c.completed_units            AS completed_units,
             ${hiddenExpr}                AS hidden,
             ${hiddenScopeExpr}           AS hidden_scope,
             c.fleet_visible              AS fleet_visible${roundDateSelectFrag(anchorAxis)}
      FROM summary_cycles c${roundsJoinFrag(anchorAxis, sql`ca.project_id = ANY(${uuidArray(ids)})`)}
      WHERE ${sql.join(conds, sql` AND `)}
      ORDER BY c.cycle_anchor_at, c.project_id
    `)) as unknown as Array<{
      cycle_id: string;
      generation_id: string | null;
      project_id: string;
      cycle_anchor_at: Date | string;
      cycle_week: string;
      status: string;
      renderable: boolean | null;
      pending: boolean | null;
      analysis_gap_ratio: string | null;
      expected_units: number | null;
      completed_units: number | null;
      hidden: boolean | null;
      hidden_scope: string | null;
      fleet_visible: boolean | null;
      round_date?: string | null;
    }>;
    return rows.map((r) => ({
      cycleId: r.cycle_id,
      generationId: r.generation_id,
      projectId: r.project_id,
      cycleAnchorAt: new Date(r.cycle_anchor_at).toISOString(),
      cycleWeek: r.cycle_week,
      status: r.status,
      renderable: r.renderable === true,
      pending: r.pending === true,
      // `numeric` 은 드라이버가 문자열로 준다 — 판정에 쓰이므로 여기서 수로 고정한다.
      analysisGapRatio: r.analysis_gap_ratio == null ? null : Number(r.analysis_gap_ratio),
      expectedUnits: r.expected_units == null ? null : Number(r.expected_units),
      completedUnits: r.completed_units == null ? null : Number(r.completed_units),
      hidden: r.hidden === true,
      // 어휘 밖의 값(구 원장·드라이버 변형)은 **넓은 쪽**으로 접는다 — 모르는 범위를
      // `citations` 로 읽으면 반쪽 회차가 조용히 합계에 든다(fail-closed).
      hiddenScope: r.hidden_scope === "citations" ? "citations" : "all",
      // 컬럼은 `NOT NULL DEFAULT true`(0059)라 실제로 `null` 이 오지 않는다. 그래도
      // **모르면 대표로 접는다** — `=== true` 로 쓰면 드라이버 변형 하나가 창의 회차를
      // 통째로 패자로 만들어 추이가 조용히 비는 방향이라, 반대쪽으로 못 박는다.
      fleetVisible: r.fleet_visible !== false,
      // 축이 꺼져 있으면 열 자체가 없다 → `undefined` = 종전 축.
      ...(r.round_date ? { roundDate: r.round_date } : {}),
    }));
  } catch {
    return null;
  }
}

// ── 숨긴 회차의 **갭 슬롯** (0070, 2026-09-10) ──────────────────────────────
//
// 숨김은 두 가지를 한다: ① 값을 화면에서 뺀다(위 술어들) ② 그 자리에 **"오류로 인해
// 수집되지 않음" 슬롯**을 남긴다. ②가 없으면 8/17 과 8/31 이 곧장 붙어 버려서, 값이
// 사라진 것이 아니라 **그 주가 없었던 것처럼** 보인다 — 숨김이 만드는 두 번째 거짓말이다.
//
// 화면 축이 두 종류라 슬롯 키도 두 개를 함께 돌려준다:
//   · `cycleWeek`  — 미러 경로의 주 격자 키(글로벌 = 회차 앵커의 KST 주 — `mirrorWeekKey`,
//                    그 외 = `date_trunc('week', measured_at)`). 원장도 같은 표면 규칙이다.
//   · `anchorDay`  — 집계층 회차 축(`cycleAnchorAt`) 키. 8/25 앵커 회차는 두 값이 다르다
//                    (주 2026-08-24 · 앵커일 2026-08-25). 경로마다 맞는 것을 골라 쓴다.
//
// 창(dateFrom/dateTo)을 **인자로 받지 않는다.** 원장 전체가 실측 96행이라 필터가 이득이
// 없고, 창 경계 해석이 두 벌(집계층 UTC 일 vs 미러 trendWindowFloor)로 갈리면 "슬롯이
// 한 칸 밖이라 안 그려진다" 는 조용한 결함이 생긴다. 창은 **끼워 넣는 쪽**이 판정한다 —
// 축의 첫/마지막 사이에 있는 키만 슬롯이 된다(`insertTrendGapSlots`).

/** 숨긴 회차 하나 — 갭 슬롯 하나에 대응한다. */
export interface HiddenCycleSlot {
  cycleId: string;
  projectId: string;
  /** `YYYY-MM-DD` 월요일(글로벌 KST · 그 외 UTC) — 미러 주 격자 키. */
  cycleWeek: string;
  /** `YYYY-MM-DD` — 회차 anchor 의 UTC 일. **축 off** 집계층 회차 축 키. */
  anchorDay: string;
  /**
   * `YYYY-MM-DD` — 회차의 **귀속 날짜**(축 on 의 회차 축 키). 축이 꺼져 있거나 앵커
   * 행이 없으면 `null`.
   *
   * ⚠️ 이것이 없으면 축 on 에서 **슬롯이 데이터 점 옆에 하나 더 선다**(2026-09-20
   *    관찰의 글로벌 `8. 25.`). 숨김 회차의 앵커 KST 일자(08-25)와 그 회차의 귀속
   *    날짜(08-24)가 다르면, 08-24 자리에 이미 점이 있어도 슬롯 키가 달라
   *    `insertTrendGapSlots` 의 `present` 검사를 통과해 끼어든다
   *    (`lib/viz/trend-gap.ts:295`).
   */
  roundDate: string | null;
  /**
   * 회차 anchor 원값(ISO). 갭 슬롯의 **표시 라벨 전용**(앵커의 KST 일 — 2026-09-28).
   * 키(`anchorDay`)는 UTC 일이라, 이 값 없이 `${anchorDay}T00:00Z` 를 합성하면 15:00Z 이후
   * 앵커(운영 앵커는 매번 15:4xZ)의 슬롯이 KST 규칙보다 하루 이르게 보인다.
   */
  anchorAt: string;
  /** `collection_error` | `operator`. 오늘 화면이 그리는 것은 전자뿐이다. */
  reason: string;
  /**
   * 숨김 **범위**(0071 `hidden_scope`). `all` = 회차 전체 · `citations` = 인용 계열만.
   * 원장이 NULL 이거나 0071 미적용이면 **`all`** 이다 — 리더는 이 필드가 항상 채워진
   * 것으로 읽고, "모르면 넓게 숨긴다"(= 0071 이전 동작)가 기본값이다.
   */
  scope: HiddenCycleScope;
}

/** 숨김 범위 어휘 — 원장 CHECK(`summary_cycles_hidden_scope_ck`)와 같은 두 값. */
export type HiddenCycleScope = "all" | "citations";

/**
 * 이 표면·프로젝트들에서 **숨긴 회차** 전부. 실패·컬럼 미적용은 **빈 배열**이다.
 *
 * 실패 자세가 폴백이 아니라 빈 배열인 이유: 이 목록은 값을 만들지 않는다(슬롯만 만든다).
 * 못 읽으면 갭 음영이 안 그려질 뿐, 숨김 자체는 위 술어들이 이미 집행했다 — 관측 실패로
 * 전 화면을 미러로 떨어뜨리는 것이 더 비싸다(`hasOpenCycle` 과 같은 자세).
 */
export async function hiddenCycleSlots(q: {
  /**
   * 생략하면 **표면을 가리지 않는다**. 갭 슬롯은 "이 프로젝트의 이 주가 깨졌다" 는
   * 사실이고, 그 사실에 표면이 필요한 자리가 없다 — 프로젝트 표면 추이(/projects/[id])
   * 처럼 회차 표면이 무엇인지 호출부가 단정할 수 없는 경로가 있어 선택 인자로 둔다.
   */
  surface?: CycleSurface;
  projectIds: string[];
  /** 앵커 축이면 **귀속 날짜**(`round_date`)를 함께 싣는다. 꺼져 있으면 조각이 빈 SQL 이다. */
  anchorAxis?: boolean;
}): Promise<HiddenCycleSlot[]> {
  const ids = [...new Set(q.projectIds.filter((id) => UUID_RE.test(id)))];
  if (ids.length === 0) return [];
  if (!(await hiddenCycleColumnsAvailable())) return [];
  const anchorAxis = q.anchorAxis === true;
  const surfaceCond = q.surface ? sql`c.surface = ${q.surface}` : sql`true`;
  // 범위 컬럼(0071)은 따로 프로브한다 — 없으면 `'all'` 리터럴이라 0071 이전과 동일하다.
  const scopeCol = (await hiddenCycleScopeAvailable())
    ? sql`COALESCE(c.hidden_scope, 'all')`
    : sql`'all'`;
  try {
    const rows = (await getDb().execute(sql`
      SELECT c.cycle_id::text   AS cycle_id,
             c.project_id::text AS project_id,
             to_char(c.cycle_week, 'YYYY-MM-DD')                      AS cycle_week,
             to_char(${atTimeZoneSql(sql`c.cycle_anchor_at`)}, 'YYYY-MM-DD') AS anchor_day,
             c.cycle_anchor_at  AS anchor_at,
             c.hidden_reason    AS reason,
             ${scopeCol}        AS scope${roundDateSelectFrag(anchorAxis)}
      FROM summary_cycles c${roundsJoinFrag(anchorAxis, sql`ca.project_id = ANY(${uuidArray(ids)})`)}
      WHERE ${surfaceCond}
        AND c.project_id = ANY(${uuidArray(ids)})
        AND c.hidden_reason IS NOT NULL
      ORDER BY c.cycle_anchor_at, c.project_id
    `)) as unknown as Array<{
      cycle_id: string;
      project_id: string;
      cycle_week: string;
      anchor_day: string;
      anchor_at: string | Date;
      reason: string;
      scope: string | null;
      round_date?: string | null;
    }>;
    return rows.map((r) => ({
      cycleId: r.cycle_id,
      projectId: r.project_id,
      cycleWeek: r.cycle_week,
      anchorDay: r.anchor_day,
      // 축이 꺼져 있으면 열 자체가 없다 → `null` = 종전 키(앵커 일자)를 쓴다.
      roundDate: r.round_date ?? null,
      // postgres-js 는 timestamptz 를 Date 로 준다 — 문자열이든 Date 든 같은 ISO 로 수렴.
      anchorAt: new Date(r.anchor_at).toISOString(),
      reason: r.reason,
      // 알 수 없는 값은 **넓은 쪽**으로 접는다 — 어휘가 늘었는데 리더가 모르면
      // 인용만 숨기다 말고 전부 내보내는 것보다 전부 숨기는 쪽이 안전하다.
      scope: r.scope === "citations" ? "citations" : "all",
    }));
  } catch {
    return [];
  }
}

// ── 열린 회차(회차 밖 최신 run) 관측 — PR① T5 → 배지 제거(제품 책임자 2026-09-10) ──
//
// 종전 `hasNewerRunsOutsideCycles` 는 "회차 뒤에 도착한 run 이 있으면 폴백" 이었다.
// 그 판정 자체는 옳았지만 결과가 과했다: 루트에 미귀속 run 이 상시 6,600개 이상
// 있어(2026-09-09 실측) 글로벌 대시보드는 **항상** 미러로 떨어졌다. D-1(2)(제품 책임자
// 2026-09-10)로 "열린 회차 동안에는 직전 published 회차를 사실표로 그대로 내고
// 폴백하지 않는다" 가 됐고, 그때 함께 붙였던 **"측정 중 n%" 배지는 같은 날 제거**됐다.
//
// 배지를 뺀 이유(제품 결정 2026-09-10 07:50): 비율의 분모·분자가 run 이라 화면 값의
// 축과 맞지 않는다 — ① 셀 단위 진척이 아니고(같은 시점 실측: run 95.2% vs 셀 99.99%)
// ② **전 함대 run 을 세므로** 비-admin 사용자의 값 축 스코프 밖까지 포함한다
// ③ 분자에 무엇을 넣느냐(종결이냐 측정됨이냐)로 숫자가 크게 흔들린다
//    (2026-09-10 실측 1,228 run: completed 886 · partial_failed 283 · failed 43 ·
//     running 16 → completed/total 72.2% · (completed+partial)/total 95.2% ·
//     종결/total 98.7%. failed 43 run 이 남긴 completed 답변은 **0건**이다).
//
// 그래서 남는 것은 **불리언 하나**다: 고른 회차 밖에 더 최신 run 이 있는가.
// 진척 집계(COUNT … FILTER)는 하지 않는다 — 값이 화면에 나가지 않으므로 셀 수를
// 셀 이유가 없다. 용도는 관측뿐이다(`x-hmg-summary: hit open-cycle`).
//
// ⚠️ **판정에 영향이 0이어야 한다.** 이 프로브가 실패해도(표 없음·DB 오류·인자 없음)
//    폴백하지 않는다 — 종전 `open-cycle-unavailable` 사유는 폐기됐다. 관측 실패는
//    관측 실패일 뿐이고, 폴백은 "값이 틀릴 수 있을 때" 만 한다. (종전 배지 경로는
//    판정 불가를 폴백으로 삼았다 — 배지가 값을 화면에 냈기 때문이다.)

/**
 * 이 프로젝트들에 **열린 회차가 있는가** — 관측 전용(`x-hmg-summary: … open-cycle`).
 *
 * 결과는 화면 값에도 게이트 판정에도 영향이 없다. 그래서 실패 자세가 폴백이 아니라
 * **false** 다: 표가 없거나 DB 가 죽어도 관측만 꺼지고 전 화면은 그대로 돈다
 * (배지 시절의 `open-cycle-unavailable` = 미러 폴백은 값이 화면에 나갔기 때문에
 * 필요했던 자세이고, 배지가 사라진 뒤엔 "관측 실패로 전 화면이 느려지는" 손해뿐이다).
 *
 * ⚠️ **판정 소스가 바뀌었다 (T16 검증 6-②, 2026-09-10).** 종전 `hasOpenCycleRuns` 는
 * "고른 회차의 마지막 run 보다 늦게 시작한 **미귀속** run 이 있는가" 였다. 그것은
 * 회차 관제(A1)가 없던 시절의 프록시였고, **관제가 착지하는 순간 무력화된다**:
 * 실측(2026-09-10) 루트의 그 미귀속 run 이 1,232건 → 관제가 전부 귀속하면 **0건**이
 * 되어, 회차가 실제로 열려 있는 동안 오히려 `open-cycle` 이 꺼진다. 정확히 거꾸로다.
 *
 * 이제는 원장을 직접 본다 — `summary_cycles` 에 그 프로젝트의 `status='open'` 회차가
 * 있는가. 관제가 회차를 열고 닫는 주체이므로 이것이 정본이고, 프록시가 아니다.
 *
 * 계약은 종전 그대로: 불리언 하나, 실패 시 false, 진척을 세지 않는다(EXISTS 한 방).
 */
export async function hasOpenCycle(projectIds: string[]): Promise<boolean> {
  if (projectIds.length === 0) return false;
  try {
    const rows = (await getDb().execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM summary_cycles c
        WHERE c.project_id = ANY(${uuidArray(projectIds)})
          AND c.status = 'open'
      ) AS open_cycle
    `)) as unknown as Array<{ open_cycle: boolean | null }>;
    return rows[0]?.open_cycle === true;
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 회차 관제 (A1 / PR① T6) — 원장 **쓰기**
// ══════════════════════════════════════════════════════════════════════════
//
// 여기부터가 `summary_cycles`·`summary_cycle_runs` 에 **쓰는** 첫 코드다. 종전에는
// `scripts/summary/*.ts` 안의 1회성 회차 상수(`global-0831.ts:69`·`website-0904.ts:55`)가
// 사람 손으로 회차를 열고 `attributed_by='operator'` 로 멤버십을 굳혔다.
//
// 계약 — 설계 v4.1 §2 그대로:
//   · 미러 3표(`scope_runs`·`scope_answers`·`scope_mentions`/`scope_citations`)는 **읽기만**
//     한다(P5). `replaceRun` 은 이 모듈을 모른다.
//   · 쓰기 대상은 `summary_cycles`·`summary_cycle_runs` **둘뿐**이다.
//   · 한 틱 = 한 트랜잭션. 중간에 죽으면 통째로 롤백된다.
//
// ── `AS MATERIALIZED` 에 대하여 — 계획 고정용이지 성능의 근거가 아니다 ──────
//
// 여기 CTE 들에 붙은 `AS MATERIALIZED` 는 **플랜 안정성**을 위한 것이다. 지워도
// 지금은 거의 차이가 없다: T15 검증(2026-09-10) 이 이 모듈의 판정 문장에서 힌트
// **12개를 전부 제거**하고 재실측했다 — **1,346 ms → 1,377 ms (+2.3%)**.
// 이유는 PG12+ 의 인라인 규칙이 이미 우리가 원하는 대로 동작하기 때문이다:
// `cyc`·`unatt`·`new_anchor`·`attr`·`cflag`·`cnt`·`allmem`·`allc` 는 **2회 이상
// 참조**라 애초에 인라인되지 않고, 인라인되는 `known`·`memb`·`cans` 는 안쪽이 이미
// 96/19행이라 재평가 비용이 회당 0.008 ms 다.
//
// ⚠️ **내가 앞서 적었던 "지우면 50,875 ms(120배)" 는 틀린 일반화였다.** 그 수치 자체는
//   실측이지만 **이 코드가 아닌 문장**에서 나왔다 — 2026-09-10 착수 정찰에 쓴 1회용
//   probe(`recon2.mjs`)의 `attribution_summary` 문장이고, 조건이 달랐다:
//     · 최종 SELECT 가 `FROM attr a` 로 `attr` 을 **딱 한 번** 참조 → PG 가 인라인
//     · 그러면 `known`(1회 참조)도, 그 안의 `new_anchor` 도 연쇄로 인라인되어
//       LATERAL 이 **행마다** `cyc ∪ new_anchor` 를 다시 만든다 (미귀속 run 25,594행)
//   커밋된 코드는 그 형태였던 적이 없다(`attr`·`pick`·`cyc` 가 여러 번 참조된다).
//   즉 "힌트가 성능을 만든다"가 아니라 **"단일 참조 + LATERAL 조합이 위험하다"** 가
//   그 실측의 교훈이다. 이 파일에 그 조합을 새로 만들 때만 다시 조심하면 된다.
//
// 그래서 힌트는 남긴다(무해하고, 플랜이 데이터 분포에 따라 뒤집히는 것을 막는다).
// 다만 **지우는 것이 장애로 이어진다고 믿지 마라** — 근거는 위 +2.3% 다.

/** 회차 표면 — `summary_cycles.surface` CHECK 어휘. */
export type CycleSurface = "global" | "website" | "project";

/** 열릴 회차 하나(드라이런 표의 행). */
export interface CycleOpenPlanRow {
  projectId: string;
  surface: CycleSurface;
  /** ISO. scope 가 준 `cycle_anchor_at` 원값(반올림하지 않는다). */
  anchorAt: string;
  /**
   * 회차 주(월요일 date) — 글로벌은 `anchor AT TIME ZONE 'Asia/Seoul'` 절단(KST 월요일),
   * 웹사이트·프로젝트는 `anchor AT TIME ZONE 'UTC'` 절단(UTC 월요일). `cycleWeekForSurfaceExpr`.
   */
  cycleWeek: string;
  /** 이 anchor 를 들고 온 미귀속 run 수. */
  runs: number;
}

/** 귀속 판정 요약(§2-3). scope·derived·late 는 **이번 패스가 삼킬 것**만 센다. */
export interface CycleAttributionPlan {
  /** `cycle_anchor_at` 이 채워진 run — 그대로 귀속(규칙 1). */
  scope: number;
  /** anchor NULL → 알려진 anchor 열의 `≤ started_at` 최대값으로 귀속(규칙 2). */
  derived: number;
  /** 종결·노출된 회차에 뒤늦게 붙는 run(§2-1) — `stale_since` 를 찍는다. */
  late: number;
  /**
   * 귀속 가능하지만 `maxAttributions` 상한에 걸려 **다음 패스로 이월**되는 run.
   * 0 이 아니면 적체가 있다는 뜻이다 — 관제는 매 20분 돌므로 스스로 소진된다.
   */
  deferred: number;
  /**
   * 첫 anchor 이전이라 어느 회차에도 속하지 않는 run(규칙 2 말미). 사실표 밖.
   * ⚠️ `project_id IS NOT NULL` 인 run 만 센다 — project_id 가 NULL 인 레거시 run
   * (2026-09-10 실측 594건)은 판정 후보 자체가 아니라 이 수에도 안 들어온다.
   */
  unattributed: number;
  /** 귀속 대상 run 이 걸친 프로젝트 수. */
  projects: number;
}

/** 종결 판정 한 행. `blockedBy` 가 있으면 판정은 섰지만 쓰지 않는다. */
export interface CycleClosePlanRow {
  cycleId: string | null;
  projectId: string;
  surface: CycleSurface;
  anchorAt: string;
  status: string;
  closedBy: "next_anchor" | "complete" | "recheck_window";
  /**
   * 종결을 집행하지 않는 이유. `status <> 'open'` 이면 그 값이 들어간다 —
   * `published` 회차를 `closed` 로 되돌리는 것은 §2-7 전이의 **역주행**이다.
   */
  blockedBy?: string;
}

/** 회차 카운터(§2-1). 드라이런에서는 "귀속 후" 기준의 예상값이다. */
export interface CycleCounterRow {
  cycleId: string | null;
  projectId: string;
  anchorAt: string;
  /** 상태 무관 DISTINCT (prompt_id, target, region) 셀 수 — **관측값**이지 사전 산식이 아니다. */
  expectedUnits: number;
  /** 그중 `status='completed'` 답변이 1건 이상인 셀. */
  completedUnits: number;
  completionRatio: number | null;
  /** completed 답변 중 언급·인용이 **둘 다** 0 인 비율(프록시 게이트, 임계 0.05). */
  analysisGapRatio: number | null;
  measuredFrom: string | null;
  measuredTo: string | null;
}

export interface CycleControlPlan {
  open: CycleOpenPlanRow[];
  attribution: CycleAttributionPlan;
  close: CycleClosePlanRow[];
  counters: CycleCounterRow[];
  /** 판정 SQL 자체의 소요(ms) — 예산(§7-2) 감시용. */
  judgeMs: number;
}

export interface CycleControlWriteResult {
  opened: number;
  attributed: number;
  late: number;
  closed: number;
  countersUpdated: number;
  fleetChanged: number;
  staleMarked: number;
}

export interface CycleControlSqlOptions {
  /** 판정 기준 시각. 생략 시 DB `now()` 대신 프로세스 시각을 쓴다(테스트 고정용). */
  now?: Date;
  /**
   * `surface='global'` 로 볼 scope 루트 프로젝트. **코어는 테넌트 상수를 갖지 않는다** —
   * 호출부(또는 `SCOPE_ROOT_PROJECT_ID`)가 준다. 없으면 어떤 회차도 global 이 아니다.
   */
  rootProjectId?: string | null;
  /** 한 틱에 귀속할 run 상한. 첫 패스가 폭주하지 않게 오래된 run 부터 나눠 삼킨다. */
  maxAttributions?: number;
  /** `scope_runs.started_at` 재확인 창(일). 기본 = 미러의 `RUN_RECHECK_WINDOW_DAYS`. */
  recheckWindowDays?: number;
  /** 종결 (b) "100%" 의 정온(quiet) 창(시간). 기본 `DEFAULT_COMPLETE_QUIET_HOURS`. */
  completeQuietHours?: number;
  /**
   * 적용 tx 의 **문장당** `statement_timeout`(ms). 기본 `APPLY_STATEMENT_TIMEOUT_MS`.
   *
   * ⚠️ `SET LOCAL statement_timeout` 은 tx 가 아니라 **문장마다** 적용된다 —
   * 다섯 문장이면 최악이 5배다(T16 검증 6-①). 호출부가 남은 요청 예산을 문장 수로
   * 나눠 넘기면 tx 전체가 그 예산 안에 들어온다.
   */
  statementTimeoutMs?: number;
}

/**
 * `applyCycleControl` 이 문장을 낼 대상. drizzle 의 db 와 tx 가 둘 다 만족한다.
 *
 * 외부 tx 를 받을 수 있게 열어 둔 이유는 **테스트가 쓰기 경로를 진짜로 실행하되
 * 절대 커밋하지 않게** 하기 위해서다(T16 검증 D3: 형태 단언은 "ON CONFLICT 가
 * 문자열에 있다" 까지만 증명하고, 다섯 문장이 한 tx 에서 순서대로 돌 때 두 번째
 * 패스가 0행을 쓴다는 것은 다른 명제다). 프로덕션 경로는 이 인자를 쓰지 않는다.
 */
export interface CycleControlExecutor {
  execute: (q: SQL) => Promise<unknown>;
}

/** `applyCycleControl` 이 한 tx 에서 내는 쓰기 문장 수 — 예산 나누기의 분모다. */
export const APPLY_STATEMENT_COUNT = 5;
/** 문장당 기본 상한. 실측 판정 1.6 s · 카운터 0.5 s 이므로 10배 여유다. */
export const APPLY_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * 종결 (b) "100% 완료" 의 **정온(quiet) 창** — 마지막 run 이 시작된 뒤 이만큼 조용해야
 * 100% 를 종결로 인정한다.
 *
 * 왜 필요한가 (2026-09-10 코디네이터 판정): 한 디스패치의 run 은 **동시에 도착하지
 * 않는다.** 가드가 없으면 첫 run 하나가 자기 셀을 다 채운 순간 `completed == expected` 가
 * 되어 회차가 닫히고, 같은 디스패치의 나머지 run 이 전부 `late` + `stale_since` 로
 * 들어온다 — 모수가 틀린 채로 굳고 stale 연쇄가 시작된다.
 *
 * 손실이 비대칭이라 창을 잡는다:
 *   · 늦게 닫으면 → 사실표가 몇 시간 늦는다. 그동안 화면은 D-1(2) 로 직전 회차를 낸다.
 *   · 일찍 닫으면 → 잘못된 모수 + stale 연쇄. 되돌리려면 재생성이 필요하다.
 *
 * **값이 36시간인 이유 — 처음 넣은 6시간은 실측상 뚫렸다.**
 * 2026-09-10 실측(원장의 실제 두 회차, run 도착 간격):
 *
 *   | 회차 | run | 도착 분산 | **최대 도착 간격** |
 *   | --- | --- | --- | --- |
 *   | 글로벌 8/31 | 216 | 39.9 h | **19.2 h** (6h 초과 구멍 2회 · 12h 초과 1회) |
 *   | 웹사이트 9/4 | 186 | 98.9 h | **29.1 h** |
 *
 * 즉 6시간 창은 그 두 회차 안에서 **뚫린다** — 구멍 직전에 이미 100% 였다면 (b) 가
 * 일찍 발화해 나머지 run 이 전부 `late` 가 된다. 관측된 최대 구멍 29.1 h 를 덮고
 * 여유를 둔 값이 **36시간**이다(코디네이터 판정 2026-09-10).
 *
 * 상한도 있다: (c) `recheck_window` 가 3일(72 h)이므로 정온 창이 그것을 넘으면 (b) 는
 * 영원히 (c) 보다 늦게 발화해 사실상 죽는다. 36 h 는 29.1 h(관측 상한)와 72 h(제도 상한)
 * 사이다. 값을 바꾸려면 **이 상수 하나만** 고치면 된다 — 판정식은 `completeQuietHours`
 * 옵션으로 전부 이 값을 지나고, 형태 테스트가 값 변경 시 함께 깨진다.
 *
 * 그리고 (b) 는 최적화지 안전망이 아니다. 실제로 과거 회차를 닫은 것은 **(a) `next_anchor`**
 * 이고, 어떤 회차도 (c) 3일을 넘겨 열려 있지 못한다. (b) 를 보수적으로 잡아도 회차가
 * 영영 안 닫히지는 않는다 — 최악이 (c) 까지 3일 지연이다.
 *
 * (a) `next_anchor` 와 (c) `recheck_window` 에는 걸지 않는다 — 둘은 그 자체가 이미
 * "더 안 온다" 의 증거다(다음 회차가 열렸다 / 미러가 다시 안 당긴다).
 */
export const DEFAULT_COMPLETE_QUIET_HOURS = 36;

const CLOSED_CYCLE_STATUSES = ["closed", "generating", "published", "stale"] as const;

/**
 * 회차 판정 CTE — **드라이런과 적용이 같은 술어를 쓰도록** 한 곳에서 만든다.
 *
 * 산출 CTE:
 *   `cyc`        원장의 회차 전량(표면 판정 포함)
 *   `unatt`      `summary_cycle_runs` 에 없는 run(= 열기·귀속 후보, §2-3 규칙 0)
 *   `new_anchor` 원장이 아직 모르는 anchor = **열릴 회차**
 *   `known`      알려진 anchor 열 = 원장 anchor ∪ 이번에 열릴 anchor
 *   `attr`       run → anchor 귀속(규칙 1: scope / 규칙 2: derived / 없으면 NULL)
 *
 * ⚠️ `known` 을 "`scope_runs.cycle_anchor_at` 전량" 으로 잡으면 안 된다. 이미 원장이
 *   삼킨 run 의 scope anchor 는 **운영자가 다른 회차로 선언한 값**일 수 있다(실측:
 *   루트 8/31 회차는 원장 anchor `2026-08-31T00:00:00Z` 인데 그 회차 run 80개의 scope
 *   anchor 는 `2026-08-31T03:00:36Z` 다). 그것을 알려진 anchor 로 세면 같은 주에 유령
 *   회차가 하나 더 열린다. §2-3 규칙 0 "닫힌 회차의 멤버십은 hmg 원장이 이긴다" 가
 *   여기서 집행된다 — 알려진 anchor 는 **원장 ∪ 미귀속 run 의 anchor** 뿐이다.
 *
 * ⚠️⚠️ **`new_anchor` 는 `pick`(상한 적용 후)에서 유도한다 — `unatt` 가 아니다.**
 *   T16 검증 D1(2026-09-10): 종전에는 열기가 `new_anchor` **전량**을 열고 귀속만
 *   `LIMIT cap` 이었다. 한 틱에서 상한을 넘기면 이런 경로가 열린다:
 *     ① 회차 N개가 전부 열린다 → ② 오래된 run cap 개만 귀속된다 →
 *     ③ **멤버 0 인 중간 회차**가 `expected_units = NULL` 인 채 `next_anchor` 로 즉시
 *        닫힌다 → ④ 다음 틱에 그 run 들이 `closed` 회차로 들어와 전부 `late` +
 *        `stale_since` 가 되고, 카운터는 `status='open'` 이 아니라 **영원히 NULL 동결**.
 *   지금 대상(1,295)은 상한(5,000) 아래라 안 터지지만, 설계가 예정한 §7-7 anchor 백필
 *   (미귀속 24,299 에 scope anchor 를 채운다)이 정확히 이 상한을 넘긴다.
 *   → 열기와 귀속이 **같은 run 집합**을 보게 만들어 구조적으로 막는다. 멤버 0 회차는
 *     애초에 열리지 않고 다음 패스로 이월된다.
 *
 * ⚠️ 상한을 `unatt` 에 걸면 안 된다(그것이 자연스러워 보이지만 정반대로 작동한다).
 *   정렬이 `started_at` 오름차순이라 가장 오래된 run 부터 집는데, **가장 오래된 run 은
 *   첫 anchor 이전이라 어차피 귀속 불가**다(실측 24,299건). 상한이 그 쪽에 다 쓰이고
 *   정작 귀속돼야 할 최근 run 은 영원히 못 들어온다. 상한은 **귀속 가능한 run**
 *   (`attr` 에서 anchor 가 잡힌 것)에만 건다.
 */
function cycleJudgeCte(opts: CycleControlSqlOptions = {}): SQL {
  const cap = opts.maxAttributions ?? DEFAULT_MAX_ATTRIBUTIONS;
  return sql`
    WITH cyc AS MATERIALIZED (
      -- surface 는 원장이 이미 들고 있는 컬럼이다(0059). 여기서 다시 유도하지
      -- 않는다 — 운영자가 선언한 표면을 코드가 덮어쓰면 안 된다. 유도는 **새로
      -- 여는 회차**에만 필요하고, 그건 surfaceExpr 이 담당한다.
      SELECT c0.cycle_id, c0.project_id, c0.cycle_anchor_at, c0.status, c0.view_anchor_at,
             c0.expected_units, c0.completed_units, c0.fleet_visible, c0.surface, c0.closed_by
      FROM summary_cycles c0
    ),
    unatt AS MATERIALIZED (
      SELECT r.run_id, r.project_id, r.started_at, r.synced_at, r.cycle_anchor_at
      FROM scope_runs r
      WHERE r.project_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM summary_cycle_runs cr WHERE cr.run_id = r.run_id)
    ),
    -- 규칙 1: scope 가 anchor 를 준 run 은 그대로. known 을 필요로 하지 않으므로
    -- 먼저 확정된다 — 이 순서가 new_anchor ← pick ← attr ← known 의 순환을 푼다.
    scoped AS MATERIALIZED (
      SELECT u.run_id, u.project_id, u.started_at, u.synced_at,
             u.cycle_anchor_at AS anchor, 'scope'::text AS src
      FROM unatt u WHERE u.cycle_anchor_at IS NOT NULL
    ),
    known AS MATERIALIZED (
      SELECT project_id, cycle_anchor_at AS anchor FROM cyc
      UNION
      SELECT project_id, anchor FROM scoped
    ),
    -- 규칙 2: anchor NULL 이면 알려진 anchor 열의 <= started_at 최대값.
    -- 없으면(첫 anchor 이전) 행 자체가 없다 = 미귀속.
    derived AS MATERIALIZED (
      SELECT u.run_id, u.project_id, u.started_at, u.synced_at,
             d.anchor, 'derived'::text AS src
      FROM unatt u
      JOIN LATERAL (
        SELECT max(k.anchor) AS anchor
        FROM known k
        WHERE k.project_id = u.project_id AND k.anchor <= u.started_at
      ) d ON true
      WHERE u.cycle_anchor_at IS NULL AND d.anchor IS NOT NULL
    ),
    attr AS MATERIALIZED (
      SELECT * FROM scoped UNION ALL SELECT * FROM derived
    ),
    -- 이번 패스가 실제로 삼킬 run. 열기·귀속·카운터·종결이 **전부 이 집합**을 본다.
    pick AS MATERIALIZED (
      SELECT a.* FROM attr a ORDER BY a.started_at NULLS FIRST LIMIT ${cap}
    ),
    -- 열릴 회차 = pick 안의 anchor 중 원장이 모르는 것. pick 밖 anchor 는 열지 않는다(D1).
    new_anchor AS MATERIALIZED (
      SELECT p.project_id, p.anchor, count(*)::int AS runs
      FROM pick p
      WHERE NOT EXISTS (
        SELECT 1 FROM cyc c
        WHERE c.project_id = p.project_id AND c.cycle_anchor_at = p.anchor
      )
      GROUP BY p.project_id, p.anchor
    ),
    -- 이번 패스에 굳을 멤버십(기존 + 신규). 카운터·종결이 공유한다.
    pickmem AS MATERIALIZED (
      SELECT c.project_id, c.cycle_anchor_at AS anchor, cr.run_id, r.started_at
      FROM summary_cycle_runs cr
      JOIN cyc c ON c.cycle_id = cr.cycle_id
      JOIN scope_runs r ON r.run_id = cr.run_id
      UNION ALL
      SELECT p.project_id, p.anchor, p.run_id, p.started_at FROM pick p
    )
  `;
}

/**
 * 표면 판정식 — `new_anchor` 쪽(원장에 없는 프로젝트)에서 쓴다.
 *
 * 판정 근거·라벨 어휘·팔 순서의 정본은 `lib/surface/run-surface.ts` 다(생산자가 넷이고
 * 어휘·순서가 서로 달랐다 — 그 표가 그 파일 머리 주석에 있다). 조립만 여기 남긴다:
 * `CASE` 들여쓰기가 생산자마다 달라 텍스트를 바이트 그대로 보존해야 하기 때문이다.
 */
function surfaceExpr(col: SQL, rootProjectId: string | null): SQL {
  const label = SURFACE_LABEL.ledger;
  // 순서는 LEDGER_SURFACE_ORDER = root → website → project(ELSE).
  const globalArm = rootSurfaceArmSql(col, rootProjectId, label.root);
  return sql`CASE
      ${globalArm}
      ${websiteSurfaceArmSql(col, label.website)}
      ELSE ${sql.raw(`'${label.project}'`)}
    END`;
}

/**
 * 회차 주 키. **`::date` 단독 캐스트를 쓰지 않는다** — `timestamptz::date` 는 세션
 * 타임존에 따라 날짜가 갈린다(0053 `scope_anchor_fold` 선례, 설계 §2-5).
 * 이 식은 **UTC 월요일**이다 — 웹사이트·프로젝트 표면의 규칙. 글로벌은 `cycleWeekKstExpr`.
 */
function cycleWeekExpr(col: SQL): SQL {
  // 식 정본은 `lib/period/sql-day.ts::weekStartSql` — 텍스트 동일(그 모듈 테스트가 고정).
  return weekStartSql(col);
}

/**
 * 글로벌 표면의 회차 주 키 — **KST 월요일**(2026-09-28, 제품 책임자 옵션 1).
 *
 * 글로벌 회차는 KST 월요일 0시대(= UTC 일요일 15~16시)에 앵커가 선다. UTC 절단은 그 회차를
 * **전 주**에 넣는다: 9/21 회차(앵커 09-20T15:50Z) → 2026-09-14 로 9/14 회차와 같은 주가 되고,
 * 9/28 회차(09-27T16:00Z) → 2026-09-21. 같은 (표면, 프로젝트, 주) 에 회차가 둘이면
 * `cycleFleetSql` 이 하나를 `fleet_visible=false` 로 내린다 — 한 주가 통째로 가려진다.
 * KST 절단이면 9/7·9/14·9/21·9/28 로 회차마다 제 주를 갖는다(9/8 회차 01:10Z 는 두 규칙이
 * 같은 2026-09-07).
 *
 * 웹사이트·프로젝트는 UTC 를 유지한다: 웹사이트는 두 규칙이 같은 값(797/797), 프로젝트는
 * UTC 가 원장 규칙(145/145 · KST 132/145) — 수치는 `scope-aggregates.ts::mirrorWeekKey` 머리 주석.
 * 미러 추이의 글로벌 주 격자(회차 앵커의 KST 주)와 **같은 규칙**이어야 갭 슬롯 키
 * (`trend-gaps.ts`)가 격자에 선다.
 *
 * 값은 여전히 월요일 date 라 세부층 주 파티션(0064 `summary_ensure_week_partitions`,
 * `[월, 월+7)`) 경계와 어긋나지 않는다.
 */
function cycleWeekKstExpr(col: SQL): SQL {
  return sql`(date_trunc('week', (${col} AT TIME ZONE 'Asia/Seoul')))::date`;
}

/** 표면별 회차 주 키 — `surfaceExpr` 와 같은 판정(루트 = 글로벌). 루트 미지정이면 UTC. */
function cycleWeekForSurfaceExpr(anchor: SQL, projectCol: SQL, rootProjectId: string | null): SQL {
  if (!rootProjectId) return cycleWeekExpr(anchor);
  return sql`CASE WHEN ${projectCol} = ${rootProjectId}::uuid
      THEN ${cycleWeekKstExpr(anchor)}
      ELSE ${cycleWeekExpr(anchor)}
    END`;
}

/** 카운터 CTE — 귀속 **후** 멤버십 기준. 드라이런·적용이 같은 식을 쓴다. */
function cycleCountersCte(scope: "plan" | "apply"): SQL {
  // plan: 아직 안 쓴 귀속(**pick** = 이번 패스가 실제로 삼킬 것)까지 합쳐 "이번 틱 후"
  //   를 미리 센다. `attr` 전량이 아니라 `pick` 인 것이 D1 수리의 핵심이다 — 상한에
  //   걸려 이번 패스에 안 들어올 run 을 카운터에 세면 드라이런이 거짓을 말한다.
  // apply: 이미 원장에 들어간 멤버십만 — open 회차만 다시 센다(P6: 종결 회차 모수 동결).
  const memberSource =
    scope === "plan"
      ? sql`
        SELECT c.cycle_id, c.project_id, c.cycle_anchor_at AS anchor, cr.run_id
        FROM summary_cycle_runs cr
        JOIN cyc c ON c.cycle_id = cr.cycle_id
        WHERE c.status = 'open'
        UNION ALL
        SELECT NULL::uuid, p.project_id, p.anchor, p.run_id FROM pick p`
      : sql`
        SELECT c.cycle_id, c.project_id, c.cycle_anchor_at AS anchor, cr.run_id
        FROM summary_cycle_runs cr
        JOIN summary_cycles c ON c.cycle_id = cr.cycle_id
        WHERE c.status = 'open'`;
  return sql`
    memb AS MATERIALIZED (${memberSource}),
    cans AS MATERIALIZED (
      SELECT m.project_id, m.anchor, a.job_id, a.prompt_id, a.target, a.region, a.status, a.measured_at
      FROM memb m JOIN scope_answers a ON a.run_id = m.run_id
    ),
    cflag AS MATERIALIZED (
      SELECT x.project_id, x.anchor, x.prompt_id, x.target, x.region, x.status, x.measured_at,
             (x.status = 'completed'
              AND NOT EXISTS (SELECT 1 FROM scope_mentions sm  WHERE sm.job_id = x.job_id)
              AND NOT EXISTS (SELECT 1 FROM scope_citations sc WHERE sc.job_id = x.job_id)) AS is_gap
      FROM cans x
    ),
    ccells AS (
      SELECT project_id, anchor, prompt_id, target, region,
             bool_or(status = 'completed') AS done
      FROM cflag GROUP BY 1, 2, 3, 4, 5
    ),
    cnt AS MATERIALIZED (
      SELECT g.project_id, g.anchor, g.expected, g.completed,
             f.measured_from, f.measured_to, f.completed_answers, f.gap_answers
      FROM (
        SELECT project_id, anchor, count(*)::int AS expected,
               count(*) FILTER (WHERE done)::int AS completed
        FROM ccells GROUP BY 1, 2
      ) g
      JOIN (
        SELECT project_id, anchor,
               min(measured_at) AS measured_from, max(measured_at) AS measured_to,
               count(*) FILTER (WHERE status = 'completed')::int AS completed_answers,
               count(*) FILTER (WHERE is_gap)::int AS gap_answers
        FROM cflag GROUP BY 1, 2
      ) f ON f.project_id = g.project_id AND f.anchor = g.anchor
    )
  `;
}

const DEFAULT_MAX_ATTRIBUTIONS = 5_000;

function nowIso(opts: CycleControlSqlOptions): string {
  return (opts.now ?? new Date()).toISOString();
}

function recheckCutoffIso(opts: CycleControlSqlOptions, days: number): string {
  return new Date((opts.now ?? new Date()).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function quietCutoffIso(opts: CycleControlSqlOptions): string {
  const hours = opts.completeQuietHours ?? DEFAULT_COMPLETE_QUIET_HOURS;
  return new Date((opts.now ?? new Date()).getTime() - hours * 60 * 60 * 1000).toISOString();
}

/**
 * 종결 사유 판정식(§2-1 (a)(b)(c)). 우선순위는 설계가 적은 순서 그대로다 —
 * (a) 다음 anchor 출현 → (b) 100% → (c) 재확인 창 밖.
 */
function closeReasonExpr(cutoffIso: string, quietIso: string): SQL {
  return sql`CASE
      WHEN EXISTS (
        SELECT 1 FROM allc x
        WHERE x.project_id = allc.project_id AND x.anchor > allc.anchor
      )
        -- 멤버 존재 요건 (T16 검증 D1, 2026-09-10). (b) 는 expected>0 을, (c) 는
        -- EXISTS allmem 을 요구하는데 (a) 만 순수 anchor 비교였다. 그래서 멤버 0 회차가
        -- expected_units = NULL 인 채 즉시 닫히고, 뒤늦게 온 run 이 전부 late 가 되며
        -- 카운터가 영원히 NULL 로 동결되는 경로가 있었다. 세 팔의 술어 모양을 맞춘다.
        AND EXISTS (SELECT 1 FROM allmem m WHERE m.project_id = allc.project_id AND m.anchor = allc.anchor)
        THEN 'next_anchor'
      WHEN COALESCE(allc.expected, 0) > 0 AND COALESCE(allc.completed, 0) >= COALESCE(allc.expected, 0)
        -- 정온 가드(DEFAULT_COMPLETE_QUIET_HOURS): 마지막 run 이 시작된 뒤 조용해야
        -- 100% 를 종결로 인정한다. started_at IS NULL 은 "모른다" 이므로 **닫지 않는다** —
        -- 손실 비대칭(늦게 닫기 = 몇 시간 지연 / 일찍 닫기 = 잘못된 모수 + stale 연쇄).
        AND NOT EXISTS (
          SELECT 1 FROM allmem m
          WHERE m.project_id = allc.project_id AND m.anchor = allc.anchor
            AND (m.started_at IS NULL OR m.started_at >= ${quietIso}::timestamptz)
        )
        THEN 'complete'
      WHEN EXISTS (SELECT 1 FROM allmem m WHERE m.project_id = allc.project_id AND m.anchor = allc.anchor)
        AND NOT EXISTS (
          SELECT 1 FROM allmem m
          WHERE m.project_id = allc.project_id AND m.anchor = allc.anchor
            AND (m.started_at IS NULL OR m.started_at >= ${cutoffIso}::timestamptz)
        ) THEN 'recheck_window'
      ELSE NULL
    END`;
}

/**
 * **읽기 전용** 회차 관제 판정 — 쓰기 0. T16 드라이런과 `runCycleControl({dryRun:true})`
 * 가 같이 쓴다. 적용 경로와 술어가 갈리지 않도록 CTE 를 공유한다.
 */
export async function readCycleControlPlan(
  opts: CycleControlSqlOptions = {},
): Promise<CycleControlPlan> {
  const root = opts.rootProjectId ?? null;
  const days = opts.recheckWindowDays ?? 3;
  const cutoff = recheckCutoffIso(opts, days);
  const quiet = quietCutoffIso(opts);
  const t0 = Date.now();
  const rows = (await getDb().execute(sql`
    ${cycleJudgeCte(opts)},
    ${cycleCountersCte("plan")},
    -- 종결 판정이 보는 멤버십 = 기존 + **이번 패스가 굳힐 것(pick)**. attr 전량이
    -- 아니다 — 상한 밖 run 을 멤버로 세면 (a)(c) 판정이 실제와 달라진다(D1).
    allmem AS MATERIALIZED (SELECT project_id, anchor, started_at FROM pickmem),
    allc AS MATERIALIZED (
      -- 이미 closed_by 가 찍힌 회차는 판정 대상이 아니다. 그것을 빼지 않으면 표가
      -- "운영자가 이미 닫은 96 회차" 로 덮여 **이번 틱이 실제로 하는 일이 안 보인다**.
      -- (published 회차의 종결 사유는 다시 계산해도 쓰이지 않는다 — §2-7 전이는
      --  published → closed 로 되돌아가지 않는다.)
      SELECT c.cycle_id, c.project_id, c.cycle_anchor_at AS anchor, c.status, c.surface,
             COALESCE(n.expected, c.expected_units) AS expected,
             COALESCE(n.completed, c.completed_units) AS completed
      FROM cyc c
      LEFT JOIN cnt n ON n.project_id = c.project_id AND n.anchor = c.cycle_anchor_at
      UNION ALL
      SELECT NULL::uuid, na.project_id, na.anchor, 'open',
             ${surfaceExpr(sql`na.project_id`, root)}, n.expected, n.completed
      FROM new_anchor na
      LEFT JOIN cnt n ON n.project_id = na.project_id AND n.anchor = na.anchor
    ),
    allc_open AS MATERIALIZED (
      SELECT a.* FROM allc a
      WHERE NOT EXISTS (
        SELECT 1 FROM cyc c
        WHERE c.cycle_id = a.cycle_id AND c.status <> 'open' AND c.closed_by IS NOT NULL
      )
    )
    SELECT jsonb_build_object(
      'open', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'projectId', na.project_id::text,
          'surface', ${surfaceExpr(sql`na.project_id`, root)},
          'anchorAt', to_char(na.anchor AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ'),
          'cycleWeek', to_char(${cycleWeekForSurfaceExpr(sql`na.anchor`, sql`na.project_id`, root)}, 'YYYY-MM-DD'),
          'runs', na.runs
        ) ORDER BY na.anchor, na.project_id)
        FROM new_anchor na), '[]'::jsonb),
      'attribution', (
        SELECT jsonb_build_object(
          -- scope/derived/late 는 **이번 패스가 삼킬 것(pick)** 만 센다.
          'scope',        (SELECT count(*) FROM pick p LEFT JOIN LATERAL (
                             SELECT COALESCE(bool_or(c.status = ANY(${sql.param([...CLOSED_CYCLE_STATUSES])}::text[])), false) AS late
                             FROM cyc c WHERE c.project_id = p.project_id AND c.cycle_anchor_at = p.anchor
                           ) lt ON true WHERE p.src = 'scope' AND NOT lt.late),
          'derived',      (SELECT count(*) FROM pick p LEFT JOIN LATERAL (
                             SELECT COALESCE(bool_or(c.status = ANY(${sql.param([...CLOSED_CYCLE_STATUSES])}::text[])), false) AS late
                             FROM cyc c WHERE c.project_id = p.project_id AND c.cycle_anchor_at = p.anchor
                           ) lt ON true WHERE p.src = 'derived' AND NOT lt.late),
          'late',         (SELECT count(*) FROM pick p LEFT JOIN LATERAL (
                             SELECT COALESCE(bool_or(c.status = ANY(${sql.param([...CLOSED_CYCLE_STATUSES])}::text[])), false) AS late
                             FROM cyc c WHERE c.project_id = p.project_id AND c.cycle_anchor_at = p.anchor
                           ) lt ON true WHERE lt.late),
          -- 귀속 가능하지만 상한에 걸려 **다음 패스로 이월**되는 run(D1 가시화).
          'deferred',     (SELECT count(*) FROM attr) - (SELECT count(*) FROM pick),
          -- 첫 anchor 이전이라 어느 회차에도 못 붙는 run. 상한과 무관하게 구조적이다.
          -- ⚠️ 이 수는 project_id IS NOT NULL 인 run 만 센다(unatt 술어).
          --    project_id NULL 인 레거시 run(2026-09-10 실측 594건)은 여기 안 들어온다.
          'unattributed', (SELECT count(*) FROM unatt u WHERE NOT EXISTS (SELECT 1 FROM attr a WHERE a.run_id = u.run_id)),
          'projects',     (SELECT count(DISTINCT p.project_id) FROM pick p)
        )),
      'close', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'cycleId', allc.cycle_id::text,
          'projectId', allc.project_id::text,
          'surface', allc.surface,
          'anchorAt', to_char(allc.anchor AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ'),
          'status', allc.status,
          'closedBy', ${closeReasonExpr(cutoff, quiet)},
          'blockedBy', CASE WHEN allc.status <> 'open' THEN 'status=' || allc.status END
        ) ORDER BY allc.anchor, allc.project_id)
        FROM allc_open allc WHERE ${closeReasonExpr(cutoff, quiet)} IS NOT NULL), '[]'::jsonb),
      'counters', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'cycleId', (SELECT c.cycle_id::text FROM cyc c
                      WHERE c.project_id = n.project_id AND c.cycle_anchor_at = n.anchor),
          'projectId', n.project_id::text,
          'anchorAt', to_char(n.anchor AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ'),
          'expectedUnits', n.expected,
          'completedUnits', n.completed,
          'completionRatio', CASE WHEN n.expected > 0
                                  THEN round(n.completed::numeric / n.expected, 5) END,
          'analysisGapRatio', CASE WHEN n.completed_answers > 0
                                   THEN round(n.gap_answers::numeric / n.completed_answers, 5) END,
          'measuredFrom', to_char(n.measured_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ'),
          'measuredTo', to_char(n.measured_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MSZ')
        ) ORDER BY n.anchor, n.project_id)
        FROM cnt n), '[]'::jsonb)
    ) AS plan
  `)) as unknown as Array<{ plan: Omit<CycleControlPlan, "judgeMs"> }>;
  const plan = rows[0]?.plan;
  return {
    open: plan?.open ?? [],
    attribution: plan?.attribution ?? {
      scope: 0, derived: 0, late: 0, unattributed: 0, projects: 0,
    },
    close: (plan?.close ?? []).filter((r) => r.closedBy !== null),
    counters: plan?.counters ?? [],
    judgeMs: Date.now() - t0,
  };
}

/**
 * 회차 관제 **적용** — 한 트랜잭션, 다섯 문장. 미러는 읽기만 한다(P5).
 *
 * 순서가 의미를 가진다:
 *   1) 열기      — 원장이 모르는 anchor 로 `open` 회차를 만든다
 *   2) 귀속      — 미귀속 run 을 회차에 굳힌다(종결 회차면 `late` + `stale_since`)
 *   3) 카운터    — `open` 회차만 다시 센다(P6: 종결 회차 모수는 동결)
 *   4) 종결      — (a) 다음 anchor · (b) 100% · (c) 재확인 창 밖
 *   5) fleet_visible — 같은 (표면, 프로젝트, 주) 에 회차 둘이면 하나만
 *
 * 2)가 1) 뒤인 이유: 1)이 만든 회차에 그 run 들이 바로 붙어야 한다. 3)이 2) 뒤인
 * 이유: 새 멤버십이 카운터에 반영돼야 4)의 `complete` 판정이 선다.
 *
 * 멱등: 재실행 시 모든 문장이 0행을 쓴다. 2)는 `ON CONFLICT (run_id) DO NOTHING`,
 * 3)은 `ROW(...) IS DISTINCT FROM ROW(...)` 가드, 5)는 `IS DISTINCT FROM` 가드가
 * 담당한다. 4)는 `status='open'` 술어 자체가 재실행을 막는다.
 */
/** 1) 열기 — 원장이 모르는 anchor 로 `open` 회차를 만든다. */
function cycleOpenSql(opts: CycleControlSqlOptions): SQL {
  const root = opts.rootProjectId ?? null;
  return sql`
    ${cycleJudgeCte(opts)}
    INSERT INTO summary_cycles
      (surface, project_id, cycle_anchor_at, cycle_week, anchor_source, status, fleet_visible)
    SELECT ${surfaceExpr(sql`na.project_id`, root)}, na.project_id, na.anchor,
           ${cycleWeekForSurfaceExpr(sql`na.anchor`, sql`na.project_id`, root)}, 'scope', 'open', true
    FROM new_anchor na
    ON CONFLICT (project_id, cycle_anchor_at) DO NOTHING
    RETURNING 1
  `;
}

/**
 * 2) 귀속 (+ 종결 회차에 붙은 late run 은 `stale_since`).
 * 멱등의 근거는 `ON CONFLICT (run_id) DO NOTHING` — 한 run 은 한 회차에만(§2-1).
 */
function cycleAttributeSql(opts: CycleControlSqlOptions): SQL {
  const at = nowIso(opts);
  return sql`
    ${cycleJudgeCte(opts)},
    -- 상한은 판정 CTE 의 pick 이 이미 걸었다(D1). 여기서 또 LIMIT 을 걸면 열기와
    -- 귀속이 다시 어긋난다 — 두 문장이 **같은 pick** 을 보는 것이 수리의 요점이다.
    bind AS (
      SELECT c.cycle_id, p.run_id, p.synced_at,
             CASE WHEN c.status = ANY(${sql.param([...CLOSED_CYCLE_STATUSES])}::text[])
                  THEN 'late' ELSE p.src END AS attributed_by
      FROM pick p
      JOIN cyc c ON c.project_id = p.project_id AND c.cycle_anchor_at = p.anchor
    ),
    ins AS (
      INSERT INTO summary_cycle_runs (cycle_id, run_id, attributed_by, synced_at_seen)
      SELECT b.cycle_id, b.run_id, b.attributed_by, b.synced_at FROM bind b
      ON CONFLICT (run_id) DO NOTHING
      RETURNING cycle_id, run_id, attributed_by
    ),
    mark AS (
      UPDATE summary_cycles c
      SET stale_since = ${at}::timestamptz
      WHERE c.stale_since IS NULL
        AND c.cycle_id IN (SELECT i.cycle_id FROM ins i WHERE i.attributed_by = 'late')
      RETURNING 1
    )
    SELECT (SELECT count(*)::int FROM ins) AS attributed,
           (SELECT count(*)::int FROM ins WHERE attributed_by = 'late') AS late,
           (SELECT count(*)::int FROM mark) AS stale_marked,
           -- 앵커 테이블 전파(B2) 대상 — **이번 틱이 실제로 귀속한 run** 만.
           -- ON CONFLICT DO NOTHING 이라 이미 붙어 있던 run 은 여기 안 들어온다.
           (SELECT coalesce(array_agg(i.run_id::text), ARRAY[]::text[]) FROM ins i) AS run_ids
  `;
}

/**
 * 3) 카운터 — `open` 회차만(P6: 종결 회차 모수는 동결).
 *
 * 멱등의 근거는 말미의 `ROW(...) IS DISTINCT FROM ROW(...)` 다. 같은 값을 다시 써도
 * UPDATE 는 rowcount 를 올리므로, 값이 실제로 달라졌을 때만 쓴다.
 */
function cycleCountersSql(): SQL {
  const newRatio = sql`CASE WHEN n.expected > 0 THEN round(n.completed::numeric / n.expected, 5) END`;
  const newGap = sql`CASE WHEN n.completed_answers > 0 THEN round(n.gap_answers::numeric / n.completed_answers, 5) END`;
  const newGate = sql`CASE WHEN c.analysis_gate = 'override' THEN 'override' ELSE 'proxy' END`;
  return sql`
    WITH ${cycleCountersCte("apply")}
    UPDATE summary_cycles c SET
      expected_units     = n.expected,
      completed_units    = n.completed,
      sealed_units       = n.expected - n.completed,
      completion_ratio   = ${newRatio},
      analysis_gap_ratio = ${newGap},
      analysis_gate      = ${newGate},
      measured_from      = n.measured_from,
      measured_to        = n.measured_to
    FROM cnt n
    WHERE c.project_id = n.project_id AND c.cycle_anchor_at = n.anchor AND c.status = 'open'
      AND ROW(c.expected_units, c.completed_units, c.sealed_units, c.completion_ratio,
              c.analysis_gap_ratio, c.measured_from, c.measured_to, c.analysis_gate)
          IS DISTINCT FROM
          ROW(n.expected, n.completed, n.expected - n.completed, ${newRatio}, ${newGap},
              n.measured_from, n.measured_to, ${newGate})
    RETURNING 1
  `;
}

/** 4) 종결 — (a) 다음 anchor · (b) 100% · (c) 재확인 창 밖. `status='open'` 만 대상. */
function cycleCloseSql(opts: CycleControlSqlOptions): SQL {
  const days = opts.recheckWindowDays ?? 3;
  return sql`
    WITH allc AS MATERIALIZED (
      SELECT c.cycle_id, c.project_id, c.cycle_anchor_at AS anchor, c.status,
             c.expected_units AS expected, c.completed_units AS completed
      FROM summary_cycles c
    ),
    allmem AS MATERIALIZED (
      SELECT c.project_id, c.cycle_anchor_at AS anchor, r.started_at
      FROM summary_cycle_runs cr
      JOIN summary_cycles c ON c.cycle_id = cr.cycle_id
      JOIN scope_runs r ON r.run_id = cr.run_id
    ),
    plan AS (
      SELECT allc.cycle_id, ${closeReasonExpr(recheckCutoffIso(opts, days), quietCutoffIso(opts))} AS reason
      FROM allc WHERE allc.status = 'open'
    )
    UPDATE summary_cycles c SET
      status       = 'closed',
      closed_at    = ${nowIso(opts)}::timestamptz,
      closed_by    = p.reason,
      sealed_units = COALESCE(c.expected_units, 0) - COALESCE(c.completed_units, 0)
    FROM plan p
    WHERE c.cycle_id = p.cycle_id AND p.reason IS NOT NULL
    RETURNING 1
  `;
}

/**
 * 5) fleet_visible — 같은 (표면, 프로젝트, 주) 에 둘이면 하나만(§2-5).
 *
 * 설계의 규칙은 "expected 큰 쪽" 이다. 여기에 **노출 여부를 먼저** 본다:
 * 아직 생성도 안 된 새 회차가 expected 가 크다는 이유로 이미 노출 중인 회차를
 * 끌어내리면 그 주의 화면이 통째로 빈다. 노출 상태가 같을 때 비로소 expected 가
 * 갈림길이 된다.
 *
 * ⚠️ 노출 순위가 **2단**인 것이 V-2(뷰 앵커 게이트)의 귀결이다. 읽기 경로가 보는 것은
 * `cycleViewableSql()`(= `view_anchor_at <= now()`) 이지 `IS NOT NULL` 이 아니다.
 *   1단 **지금 서빙 중**(`<= now()`) — 이것을 끌어내리면 화면이 즉시 빈다.
 *   2단 **생성은 됐으나 아직 미래 앵커**(`IS NOT NULL`) — 화면엔 아직 안 나오지만,
 *       아직 생성도 안 된 회차보다는 앞이다(종전 규칙의 보존).
 * 1단이 없으면 미래 앵커 회차가 expected 만으로 **지금 서빙 중인 회차를 끌어내려**
 * 그 앵커가 올 때까지 그 주가 통째로 비는 창이 열린다. 2단이 없으면 반대로 종전
 * "생성됨 > 미생성" 보호가 사라진다. 둘 다 필요하다.
 *
 * 기준 시각은 관제 tx 의 주입 시계(`opts.now`)를 쓴다 — 같은 틱 안에서 다섯 문장이
 * 서로 다른 `now()` 를 보면 판정이 갈린다.
 */
function cycleFleetSql(opts: CycleControlSqlOptions = {}): SQL {
  const at = nowIso(opts);
  return sql`
    WITH ranked AS (
      SELECT c.cycle_id, c.fleet_visible,
             (row_number() OVER (
                PARTITION BY c.surface, c.project_id, c.cycle_week
                ORDER BY (c.view_anchor_at IS NOT NULL
                          AND c.view_anchor_at <= ${at}::timestamptz) DESC,
                         (c.view_anchor_at IS NOT NULL) DESC,
                         COALESCE(c.expected_units, 0) DESC,
                         c.cycle_anchor_at DESC
              ) = 1) AS want
      FROM summary_cycles c
    )
    UPDATE summary_cycles c SET fleet_visible = r.want
    FROM ranked r
    WHERE r.cycle_id = c.cycle_id AND c.fleet_visible IS DISTINCT FROM r.want
    RETURNING 1
  `;
}

/**
 * 회차 관제 **적용** — 한 트랜잭션, 다섯 문장. 미러는 읽기만 한다(P5).
 *
 * 순서가 의미를 가진다:
 *   1) 열기 → 2) 귀속 → 3) 카운터 → 4) 종결 → 5) fleet_visible
 * 2)가 1) 뒤인 이유: 1)이 만든 회차에 그 run 들이 바로 붙어야 한다. 3)이 2) 뒤인
 * 이유: 새 멤버십이 카운터에 반영돼야 4)의 `complete` 판정이 선다.
 *
 * 멱등: 재실행 시 다섯 문장이 전부 0행을 쓴다. 1)·2)는 `ON CONFLICT … DO NOTHING`,
 * 3)·5)는 `IS DISTINCT FROM` 가드, 4)는 `status='open'` 술어가 담당한다.
 */
export async function applyCycleControl(
  opts: CycleControlSqlOptions = {},
  externalTx?: CycleControlExecutor,
): Promise<CycleControlWriteResult> {
  const stmtMs = Math.max(2_000, opts.statementTimeoutMs ?? APPLY_STATEMENT_TIMEOUT_MS);
  // ── 앵커 테이블 전파(B2) 준비 ────────────────────────────────────────────────
  // 프로브는 **트랜잭션을 열기 전에** 확정한다(column-availability 계약 ①). 0077
  // 미적용 배포에서는 `false` 가 되어 문장이 아예 안 나가고 관제는 종전과 동일하다.
  const anchorsWritable = await answerCycleAnchorsWritable();
  const run = async (tx: CycleControlExecutor): Promise<CycleControlWriteResult> => {
    // 미러를 읽는 문장이 섞여 있다 — 잠금 대기로 sync 틱을 잡아먹지 않게 짧게 끊는다.
    await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
    // 문장당 상한. 다섯 문장이므로 tx 최악은 이 값의 5배다(APPLY_STATEMENT_COUNT).
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(`'${stmtMs}ms'`)}`);

    const opened = (await tx.execute(cycleOpenSql(opts))) as unknown as unknown[];
    const attrRows = (await tx.execute(cycleAttributeSql(opts))) as unknown as Array<{
      attributed: number; late: number; stale_marked: number; run_ids: string[] | null;
    }>;
    const counters = (await tx.execute(cycleCountersSql())) as unknown as unknown[];
    const closed = (await tx.execute(cycleCloseSql(opts))) as unknown as unknown[];
    const fleet = (await tx.execute(cycleFleetSql(opts))) as unknown as unknown[];

    const a = attrRows[0];
    // ── 원장 → 앵커 테이블 전파 (스펙 §4 · B2) ─────────────────────────────
    // 이 틱이 바꾸는 것과 앵커 테이블의 관계:
    //   · 귀속(2) — `cycle_id`·ledger 앵커·노출일을 전부 움직인다 → **재계산 대상**
    //   · 열기(1) — 새 회차는 귀속(2)이 붙어야 답변에 닿는다 → 2로 덮인다
    //   · 카운터(3)·fleet_visible(5) — 앵커 테이블이 읽지 않는 컬럼이다
    //   · 종결(4) `status='closed'` — ⚠️ 결정 ⑪ 이 `status` 를 읽으므로 **무관하지 않다.**
    //     오늘 무해한 이유는 둘이다: ① `WHERE status='open'` 이라 published→closed 전이를
    //     만들지 않는다 ② ⑪ 은 `ledger_view_anchor_date IS NULL` 일 때만 도달하는데
    //     `publishCycleSql` 이 노출일·status·active_generation 을 한 문장에서 함께 찍어
    //     published 회차는 사실상 항상 노출일을 갖는다(분기 ①이 이긴다).
    //     **⑪ 술어를 다른 컬럼으로 재정의하면 이 분류를 다시 봐야 한다** — 그때 대상은
    //     `generate/cycle.ts` 의 status 3문(`updateCycleCountersFrom{Values,Window}Sql`·
    //     `restoreCycleStatusOnFailureSql`)과 이 종결 문장이다.
    //   · 앵커 이동 — 이 리포에 `UPDATE … SET cycle_anchor_at` 경로가 없다
    // 그래서 **새로 귀속된 run** 만 재계산한다. 같은 트랜잭션 안이라 관제가 롤백되면
    // 전파도 함께 없던 일이 된다.
    const attributedRuns = Array.isArray(a?.run_ids) ? a.run_ids : [];
    if (anchorsWritable) {
      const stmt = refreshAnchorsForRunsSql(attributedRuns, opts.rootProjectId ?? null);
      if (stmt) await tx.execute(stmt);
    }
    return {
      opened: opened.length,
      attributed: Number(a?.attributed ?? 0),
      late: Number(a?.late ?? 0),
      staleMarked: Number(a?.stale_marked ?? 0),
      countersUpdated: counters.length,
      closed: closed.length,
      fleetChanged: fleet.length,
    };
  };
  // 외부 tx 를 받으면 새로 열지 않는다 — 호출부가 롤백을 쥔다(int 테스트가 그 경로다).
  return externalTx ? run(externalTx) : getDb().transaction(run);
}

/**
 * 다음 N 주 파티션 선생성(0064 `summary_ensure_week_partitions`). 함수가 아직 없으면
 * **null** — 마이그레이션 적용 전 배포에서도 라우트가 200 을 내야 한다.
 * 반환값은 이번 호출이 만든 파티션 수다.
 */
/** 파티션 선생성 결과. `created === null` = 0064 미적용(함수 없음) 또는 실패. */
export interface EnsurePartitionsResult {
  created: number | null;
  /** 타임아웃·락 실패 등. 있으면 관제 본체는 계속하되 응답에 실어 표면화한다. */
  error?: string;
}

/**
 * 파티션 선생성 문장의 상한. **자체 트랜잭션**에서 `SET LOCAL` 로 건다.
 *
 * 왜 자체 tx 인가 (T16 검증 D2, 2026-09-10): 종전에는 `getDb().execute(...)` 를
 * 트랜잭션 **밖에서** 그냥 불렀다. 0064 파일 머리의 `SET LOCAL lock_timeout='3s'` 는
 * 마이그레이션 트랜잭션에만 걸리는 값이라 **런타임 호출에는 아무 상한이 없었다.**
 * 그 호출이 하는 일이 가볍지 않다:
 *   ① `CREATE TABLE … PARTITION OF` — 부모 6표에 **ACCESS EXCLUSIVE**.
 *      생성 러너가 적재 중이면 무한 대기한다.
 *   ② 만든 게 있으면 `summary_ensure_cycle_gen_stats()` — `summary_*` 중 cycle_id +
 *      generation_id 를 가진 **모든 테이블에 ANALYZE**. 실측 규모 **63표 · 562 MB**
 *      (최대 파티션 `summary_brand_mentions_20260831` 299 MB).
 * 이게 이미 250 s 를 쓴 sync 요청 뒤에 붙으므로, 상한이 없으면 `maxDuration` 300 s 를
 * 넘겨 **관제가 아니라 라우트 전체가 죽는다**.
 *
 * 값의 근거: 락은 짧게 포기해야 러너와 싸우지 않는다(3 s — `applyCycleControl` 과 동일).
 * 문장 상한은 ANALYZE 562 MB 를 한 번에 도는 최악을 담되 300 s 예산 안에 남아야 하므로
 * **120 s**. 파티션이 생기는 틱은 주 1회뿐이고, 실패해도 다음 틱이 다시 시도한다
 * (멱등) — 여기서 죽는 것보다 끊고 재시도하는 편이 언제나 싸다.
 */
const PARTITION_LOCK_TIMEOUT_MS = 3_000;
/**
 * 문장 **천장**. 기대 소요가 아니다 — ANALYZE 는 전수 스캔이 아니라 표본 추출이라
 * 평시엔 수 초다. 이 값은 락 경합·IO 이상으로 늘어질 때 끊는 상한이다.
 * ⚠️ 호출부(크론)는 **남은 요청 예산**을 넘겨 이보다 더 짧게 끊을 수 있다 —
 * sync 가 이미 250 s 를 쓴 뒤라면 120 s 를 그대로 쓰면 maxDuration 300 s 를 넘긴다.
 */
export const PARTITION_STATEMENT_TIMEOUT_MS = 120_000;

/**
 * 다음 N 주 파티션 선생성(0064 `summary_ensure_week_partitions`). 함수가 아직 없으면
 * `created: null` — 마이그레이션 적용 전 배포에서도 라우트가 200 을 내야 한다.
 *
 * 실패(타임아웃·락)는 **던지지 않고** `error` 로 돌려준다. 파티션이 없으면 나중에
 * 생성이 죽지만, 그건 이 틱이 아니라 생성 러너의 문제다 — 관제 본체(열기·귀속·종결)는
 * 파티션과 무관하므로 계속 돌아야 한다.
 */
export async function ensureSummaryWeekPartitions(
  from: Date,
  to: Date,
  o: { statementTimeoutMs?: number } = {},
): Promise<EnsurePartitionsResult> {
  const stmtMs = Math.max(
    1_000,
    Math.min(PARTITION_STATEMENT_TIMEOUT_MS, o.statementTimeoutMs ?? PARTITION_STATEMENT_TIMEOUT_MS),
  );
  try {
    const probe = (await getDb().execute(sql`
      SELECT to_regprocedure('public.summary_ensure_week_partitions(date, date)') IS NOT NULL AS ok
    `)) as unknown as Array<{ ok: boolean }>;
    if (!probe[0]?.ok) return { created: null };
  } catch (err) {
    return { created: null, error: `probe: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return await getDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = ${sql.raw(`'${PARTITION_LOCK_TIMEOUT_MS}ms'`)}`);
      await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(`'${stmtMs}ms'`)}`);
      const rows = (await tx.execute(sql`
        SELECT summary_ensure_week_partitions(
          (${from.toISOString()}::timestamptz AT TIME ZONE 'UTC')::date,
          (${to.toISOString()}::timestamptz AT TIME ZONE 'UTC')::date
        )::int AS created
      `)) as unknown as Array<{ created: number }>;
      return { created: Number(rows[0]?.created ?? 0) };
    });
  } catch (err) {
    // 타임아웃이면 tx 가 통째로 롤백된다 — 만들다 만 파티션은 남지 않는다.
    return { created: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 형태 테스트 전용 — 컴파일된 SQL 로 술어를 고정한다(실 DB 없이). */
export const __testables = {
  cycleViewableSql,
  cycleJudgeCte,
  cycleOpenSql,
  cycleAttributeSql,
  cycleCountersSql,
  cycleCloseSql,
  cycleFleetSql,
  cycleWeekExpr,
  cycleWeekKstExpr,
  cycleWeekForSurfaceExpr,
  surfaceExpr,
  closeReasonExpr,
};
