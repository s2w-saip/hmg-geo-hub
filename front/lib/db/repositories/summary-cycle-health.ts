import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { cycleNotHiddenSql, cycleViewableSql } from "./summary-cycles";
import { columnAvailable, hiddenCycleColumnsAvailable } from "@/lib/db/column-availability";
import { pendingCyclesSql, type CycleRow } from "@/lib/summary/generate/cycle";
import { VIEW_ANCHOR_DELAY, type SummarySurface } from "@/lib/summary/generate/types";

// 회차 사슬 감시의 **읽기 전용 리포지토리** (2026-09-16).
//
// 판정은 여기 없다 — `lib/summary/health/cycle-chain.ts` 가 한다. 이 파일은
// 문장만 낸다. 경계 이유는 취향이 아니라 ESLint 집행이다(`no-restricted-imports`:
// 원 DB 클라이언트는 `lib/db/**` 밖에서 import 금지 = data-access-security).
//
// ⚠️ **술어를 새로 쓰지 않는다.** 아래 문장들이 쓰는 술어는 전부 기존 정본이다:
//   · `cycleNotHiddenSql`  숨김 게이트(0070)
//   · `VIEW_ANCHOR_DELAY`  노출 지연 — 리터럴 복사 금지, interval 문자열 그대로
//   · `pendingCyclesSql`   `--pending` 정본 — **그대로 호출**한다
// 감시가 화면·생성기와 다른 집합을 보면 감시는 거짓말을 시작한다.

/**
 * timestamptz 를 **`Date#toISOString()` 과 바이트 동일한** 문자열로 낸다.
 *
 * 판정이 키를 문자열로 비교하므로(정렬 가능한 표현이 필요하다) 원장 쪽과 픽 쪽이
 * 같은 축이어야 한다. `::text` 는 로캘·TimeZone 에 흔들리는 `YYYY-MM-DD HH:MM:SS+00`
 * 을 내므로 쓰지 않는다. `.MS` 는 밀리초 3자리 = `toISOString()` 과 같은 정밀도다.
 *
 * ⚠️ `delay` 를 이 헬퍼에 문자열 보간으로 넣는 곳이 있다(`due_at`). 값의 출처는
 *    코드 상수 `VIEW_ANCHOR_DELAY` 뿐이고 사용자 입력이 아니다 — 그 전제가 깨지면
 *    (예: 표면을 env 로 받게 되면) 보간을 바인드로 바꿔야 한다.
 */
function ISO_UTC(expr: string): string {
  return `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/** 원장 한 행 — 노출 지체 판정에 필요한 것만. */
export interface CycleLedgerRow {
  cycleAnchorAt: string;
  /** `cycle_anchor_at + VIEW_ANCHOR_DELAY[표면]` — 계약상 노출 시각. */
  dueAt: string;
  /**
   * "한 회차" 의 **묶음 키**. `pendingCyclesSql` 의 `groupBy` 와 같은 정의다:
   * 글로벌은 앵커 하나가 한 회차, 웹사이트는 **함대 주 하나가 한 회차**(95개
   * 프로젝트가 한 주를 공유한다 — 설계 §6-5).
   *
   * ⚠️ 이걸 안 쓰고 행 수로 "몇 회차 밀렸나" 를 세면 웹사이트가 **한 주만 밀려도
   * 95** 가 나온다 → 등급이 항상 2(긴급)로 굳어 등급 구분이 죽는다.
   */
  groupKey: string;
  /**
   * `cycle_week`(UTC 월요일). 글로벌 묶음 키는 **앵커**라 주가 따로 필요하다 —
   * 판정이 "같은 주의 중복 패자" 를 접을 때 쓴다(`cycle-chain.ts::judgeViewLagSurface`).
   */
  cycleWeek: string;
  /**
   * 중복 패자 접기의 **파티션 한 축**. 관제 5단계는 `(surface, project_id, cycle_week)`
   * 로 대표를 고르므로, 접기도 프로젝트를 봐야 같은 주 다른 사이트의 대표가 이 프로젝트의
   * 패자를 지우지 않는다(읽기 쪽 `cycle-set.ts::fleetGroupOf` 와 같은 키).
   */
  projectId: string;
  /**
   * `fleet_visible` — 같은 주 **대표 회차인가**. 여기서 술어로 거르지 않는 이유는
   * 아래 `readCycleLedger` 머리 주석(한 주가 통째로 패자인 병리를 감시가 봐야 한다).
   * 판정이 이 값을 쓴다.
   */
  fleetVisible: boolean;
  status: string;
  hasActiveGeneration: boolean;
  analysisGapRatio: number | null;
}

/**
 * 표면의 회차를 앵커 내림차순으로. 숨긴 회차는 뺀다(화면에 안 나오는 것이 정상이라
 * 그것을 "지체" 로 세면 숨김이 곧 경보가 된다).
 *
 * ⚠️ **`fleet_visible` 을 일부러 걸지 않는다**(2026-09-16 검증 지적에 대한 답).
 *    `pickWebsiteCycles` 는 그것을 거는데 여기서는 안 걸어 비대칭처럼 보인다.
 *    의도된 것이다 — 여기에 `fleet_visible` 을 걸면, 한 주가 통째로 패자만 남는 병리
 *    (관제 결함)를 감시가 **못 보게 된다**. 실측(2026-09-16): website 61행이
 *    false 인데 전부 기존 주에 흡수됐다. 이 줄을 지우기 전에 위 문장을 읽어라.
 *    대신 값을 **열로 실어 보내고**(`fleetVisible`·`cycleWeek`) 판정이 접는다
 *    (`cycle-chain.ts::judgeViewLagSurface` → `dropFleetLosers`).
 *
 * ⚠️ 종전 이 자리에는 "패자는 묶음 키가 기존 주와 같아 `cyclesBehind` 에 영향이 0" 이라고
 *    적혀 있었다 — **웹사이트에서만 참이다**(그쪽 묶음 키가 `cycle_week` 다). 글로벌 묶음
 *    키는 **앵커**라 패자가 자기 그룹을 만든다. 2026-09-18 `pickGlobalCycle` 이 같은 주
 *    대표를 고르게 된 뒤로는, 접지 않으면 중복 주마다 "한 회차 밀림" 오탐이 상시로 뜬다.
 *
 * 400행 상한 — 판정은 최신 몇 **묶음**만 보면 된다. 웹사이트는 한 주가 함대 95개
 * 프로젝트라 400행 ≈ 최근 4주다(2026-09-16 실측 website 769 · global 20). 상한에
 * 걸려도 판정은 '더 최신 쪽'만 쓰므로 최신 묶음을 놓치지 않는다.
 */
export async function readCycleLedger(
  surface: SummarySurface,
): Promise<CycleLedgerRow[]> {
  // 숨김 게이트는 SQL 을 만들기 **전에** 확정한다 — 컬럼 없는 배포에서 42703 이
  // 나면 감시가 통째로 죽는다(`pickWebsiteCycles` 와 같은 자세).
  const notHidden = cycleNotHiddenSql(await hiddenCycleColumnsAvailable(), "c");
  const delay = VIEW_ANCHOR_DELAY[surface];
  // 묶음 키 — `pendingCyclesSql` 의 `groupBy` 와 **같은 정의**를 쓴다.
  //
  // ⚠️ 글로벌 키는 반드시 `ISO_UTC`(= `Date#toISOString()` 과 **바이트 동일**)여야 한다.
  //    `::text` 는 `2026-09-13 15:48:44.276+00` 을 내는데, 픽(`pickGlobalCycle`)은
  //    `toISOString()` 으로 `2026-09-13T15:48:44.276Z` 를 낸다. 판정은 이 둘을
  //    **문자열로 비교**하므로 인덱스 10 에서 `' '(0x20) < 'T'(0x54)` 가 되어
  //    **같은 날짜의 더 최신 회차가 '밀림' 으로 안 잡힌다**(2026-09-16 검증 실측).
  //    세션 TimeZone 이 UTC 가 아니면 방향이 뒤집혀 영구 오탐이 된다.
  //    `summary-cycle-health.test.ts` 가 이 형식을 SQL 문자열로 단언한다.
  const groupBy = sql.raw(
    surface === "website" ? "to_char(c.cycle_week, 'YYYY-MM-DD')" : ISO_UTC("c.cycle_anchor_at"),
  );
  const rows = (await getDb().execute(sql`
    SELECT ${sql.raw(ISO_UTC("c.cycle_anchor_at"))}      AS cycle_anchor_at,
           ${sql.raw(ISO_UTC(`(c.cycle_anchor_at + interval '${delay}')`))} AS due_at,
           ${groupBy}                                     AS group_key,
           to_char(c.cycle_week, 'YYYY-MM-DD')            AS cycle_week,
           c.project_id::text                             AS project_id,
           c.fleet_visible                                AS fleet_visible,
           c.status                                      AS status,
           (c.active_generation_id IS NOT NULL)           AS has_gen,
           c.analysis_gap_ratio::float8                   AS gap
    FROM summary_cycles c
    WHERE c.surface = ${surface} AND ${notHidden}
    ORDER BY c.cycle_anchor_at DESC
    LIMIT 400
  `)) as unknown as Array<{
    cycle_anchor_at: string;
    due_at: string;
    group_key: string;
    cycle_week: string;
    project_id: string;
    fleet_visible: boolean | null;
    status: string;
    has_gen: boolean;
    gap: number | null;
  }>;
  return rows.map((r) => ({
    cycleAnchorAt: r.cycle_anchor_at,
    dueAt: r.due_at,
    groupKey: r.group_key,
    cycleWeek: r.cycle_week,
    projectId: r.project_id,
    // 픽과 같은 방향 — 모르면 대표로 접는다(패자로 접으면 행이 조용히 사라진다).
    fleetVisible: r.fleet_visible !== false,
    status: r.status,
    hasActiveGeneration: r.has_gen,
    analysisGapRatio: r.gap,
  }));
}

/**
 * 원장이 아는 웹사이트 프로젝트 전량.
 *
 * 화면은 요청마다 다른 목록으로 `pickWebsiteCycles` 를 부른다. 감시는 전량을 넘겨
 * "서빙될 수 있는 것 중 가장 최신" 을 본다 — 화면이 보는 것의 **상계**다. 상계를
 * 쓰는 이유: 감시가 화면보다 낙관적이면(= 더 최신을 봤다고 믿으면) 실제 지체를
 * 놓친다. 상계는 반대로 틀려도 "지체 없음" 쪽으로만 틀린다.
 */
export async function readWebsiteProjectIds(): Promise<string[]> {
  const rows = (await getDb().execute(sql`
    SELECT DISTINCT project_id::text AS project_id
    FROM summary_cycles WHERE surface = 'website'
  `)) as unknown as Array<{ project_id: string }>;
  return rows.map((r) => r.project_id);
}

/**
 * 지금 **서빙 가능한** 회차 수 — 픽의 `null` 을 해석하기 위한 프로브.
 *
 * ⚠️ 이 함수는 **일부러 catch 하지 않는다.** 그것이 존재 이유다.
 *
 * `pickGlobalCycle`·`pickWebsiteCycles` 는 `catch → null` 이다. 화면에는 그 자세가
 * 옳다(회차를 모르면 미러로 폴백한다 — 잘못 읽는 것보다 느린 것이 싸다). 그런데
 * **감시에게 `null` 은 두 명제가 겹친 값**이다:
 *   ① 고를 회차가 정말 없다              → 전 화면 미러 폴백 = 라이브 이슈(등급 2)
 *   ② 조회가 순간 죽었다                 → 감시가 말할 것이 없다(경보 아님)
 * 둘을 구분 못 하면 DB 순간 오류가 곧바로 **긴급 2** 로 Slack 에 나간다
 * (2026-09-16 검증 실측: `overdueHours:384, severity:2`).
 *
 * 그래서 픽이 `null` 을 주면 이 프로브를 한 번 더 던진다. 프로브가 **던지면** DB 가
 * 아픈 것이므로 판정을 접고(`skipped`), 프로브가 답하면 픽의 `null` 은 ① 이다.
 *
 * 술어는 픽과 같다 — `cycleViewableSql`(V-2) + `cycleNotHiddenSql`(0070),
 * 웹사이트는 `fleet_visible` 까지(픽이 거는 것과 같은 조건).
 */
export async function countViewableCycles(
  surface: SummarySurface,
): Promise<number> {
  const notHidden = cycleNotHiddenSql(await hiddenCycleColumnsAvailable(), "c");
  const fleet = sql.raw(surface === "website" ? "AND c.fleet_visible" : "");
  const rows = (await getDb().execute(sql`
    SELECT count(*)::int AS n
    FROM summary_cycles c
    WHERE c.surface = ${surface}
      AND ${cycleViewableSql("c")}
      AND c.active_generation_id IS NOT NULL
      AND ${notHidden}
      ${fleet}
  `)) as unknown as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

export interface StaleCycleRow {
  cycleId: string;
  surface: SummarySurface;
  anchorAt: string;
  staleSince: string;
}

/**
 * **마감 후 늦게 도착한 run 이 붙은, 그런데 이미 발행된 회차** (F7, 2026-09-16 검증).
 *
 * 두 감시의 사각지대였다. 이런 회차는
 *   ① 발행·노출돼 있으므로 노출 지체 감시가 `cyclesBehind=0` 으로 PASS 를 내고,
 *   ② `active_generation_id IS NOT NULL` 이라 `--pending` 이 안 뽑아 적체에서도 빠진다.
 * 그 결과 **고객 화면에 낡은 값이 떠 있는데 둘 다 조용하다.**
 * 라이브 실측(2026-09-16): global 2건 — 그중 하나는 **지금 서빙 중인 09-13 회차**로
 * 발행 1.5시간 뒤 늦은 run 이 붙었다(stale_since 2026-09-15 18:40Z).
 *
 * `active_generation_id IS NOT NULL` 로 좁히는 것이 핵심이다. 활성 generation 이 없는
 * stale 회차는 갭 여집합(`readGapExcludedCycles`)이 이미 세고 있어 **이중 계상**이 된다
 * (실측: 나머지 5건이 정확히 그쪽 집합이다).
 */
export async function readStaleCycles(
  surfaces: readonly SummarySurface[],
): Promise<StaleCycleRow[]> {
  const notHidden = cycleNotHiddenSql(await hiddenCycleColumnsAvailable(), "c");
  const rows = (await getDb().execute(sql`
    SELECT c.cycle_id::text                          AS cycle_id,
           c.surface                                 AS surface,
           ${sql.raw(ISO_UTC("c.cycle_anchor_at"))}  AS anchor_at,
           ${sql.raw(ISO_UTC("c.stale_since"))}      AS stale_since
    FROM summary_cycles c
    WHERE c.surface = ANY(${sql.param([...surfaces])}::text[])
      AND c.stale_since IS NOT NULL
      AND c.active_generation_id IS NOT NULL
      AND ${notHidden}
    ORDER BY c.stale_since
  `)) as unknown as Array<{
    cycle_id: string;
    surface: SummarySurface;
    anchor_at: string;
    stale_since: string;
  }>;
  return rows.map((r) => ({
    cycleId: r.cycle_id,
    surface: r.surface,
    anchorAt: r.anchor_at,
    staleSince: r.stale_since,
  }));
}

/**
 * `--pending` 정본을 그대로 실행한다. 생성기가 지금 뽑을 회차 = 이 집합.
 *
 * ⚠️ **`surface` 는 `SummarySurface`(global·website) 뿐이다 — `project` 를 넣지 마라.**
 * 원장에는 `surface='project'` 회차가 함께 산다(2026-09-16 실측 121건). 그런데 사실표
 * 생성기는 그 표면을 **만들지 않는다**(`generate-cycle.ts --surface=global|website`,
 * `SummarySurface` 타입이 둘뿐) — 같은 날 실측에서 project 회차 121건 중 활성
 * generation 이 있는 것은 **0건**이고 `view_anchor_at` 도 전부 NULL 이다.
 * 즉 그 표면을 적체로 세면 **첫날부터 105건이 영구 오탐**으로 뜬다. 술어가 아니라
 * 모수를 잘못 잡아 감시가 죽는 전형적인 경로다.
 */
export async function readPendingCycles(args: {
  surface: SummarySurface;
  gapMax: number;
  limit: number;
}): Promise<CycleRow[]> {
  return (await getDb().execute(pendingCyclesSql(args))) as unknown as CycleRow[];
}

/**
 * 회차별 **대기 시작 시각**.
 *
 * `pendingCyclesSql` 은 이 값을 안 돌려준다(생성기는 필요 없으니까). 정본 술어에
 * 컬럼을 덧붙이는 대신 id 로 한 번 더 읽는다 — 6시간에 한 번 도는 감시라 왕복
 * 하나가 싸고, 술어는 손대지 않는다.
 *
 * ⚠️ `summary_cycles` 에는 `updated_at` 이 **없다**(0059 DDL). `closed_at` 이
 *    "언제부터 만들어질 수 있었나" 의 유일한 근거다.
 */
export async function readCycleWaitingSince(
  cycleIds: string[],
): Promise<Map<string, string>> {
  if (cycleIds.length === 0) return new Map();
  const rows = (await getDb().execute(sql`
    SELECT cycle_id::text AS cycle_id,
           COALESCE(closed_at, created_at)::text AS since
    FROM summary_cycles WHERE cycle_id = ANY(${sql.param(cycleIds)}::uuid[])
  `)) as unknown as Array<{ cycle_id: string; since: string }>;
  return new Map(rows.map((r) => [r.cycle_id, r.since]));
}

export interface GapExcludedGroup {
  surface: string;
  count: number;
  oldestAnchorAt: string;
  newestAnchorAt: string;
}

/**
 * 생성기가 **영원히 안 뽑는** 회차 — 표면별 집계.
 *
 * `isGeneratorSkipped`(읽기 계층)와 **같은 명제**를 SQL 로 쓴 것이다. 3값 논리에
 * 주의: `NOT (gap <= MAX)` 은 gap 이 `NULL` 이면 UNKNOWN 이라 `WHERE` 가 버린다.
 * 갭 미상 회차(2026-09-11 실측 웹사이트 36건)를 놓치지 않으려면 `IS NULL` 을
 * **명시**해야 한다.
 *
 * 이것들은 적체가 아니므로 경보 대상이 아니다. 그래도 세는 이유는 7/07·7/11·
 * 7/19·7/24 글로벌 4건이 아무 기록 없이 사라져 있었기 때문이다 — 본문에 건수로 적는다.
 *
 * ⚠️ `surfaces` 를 **반드시** 넘긴다 — 아래 `readPendingCycles` 주석의 `project`
 *    표면 함정과 같은 이유다(2026-09-16 실측: project 표면 13건이 딸려 나온다).
 */
export async function readGapExcludedCycles(
  gapMax: number,
  surfaces: readonly SummarySurface[],
): Promise<GapExcludedGroup[]> {
  const rows = (await getDb().execute(sql`
    SELECT surface,
           count(*)::int              AS count,
           min(cycle_anchor_at)::text AS oldest_anchor_at,
           max(cycle_anchor_at)::text AS newest_anchor_at
    FROM summary_cycles
    WHERE surface = ANY(${sql.param([...surfaces])}::text[])
      AND active_generation_id IS NULL
      AND status IN ('closed', 'generating')
      AND (analysis_gap_ratio IS NULL
           OR analysis_gap_ratio > ${String(gapMax)}::numeric)
    GROUP BY surface
    ORDER BY surface
  `)) as unknown as Array<{
    surface: string;
    count: number;
    oldest_anchor_at: string;
    newest_anchor_at: string;
  }>;
  return rows.map((r) => ({
    surface: r.surface,
    count: r.count,
    oldestAnchorAt: r.oldest_anchor_at,
    newestAnchorAt: r.newest_anchor_at,
  }));
}

// ── 자사·타겟 URL 인용률 사실표(0081) 커버리지 ────────────────────────────────
//
// 생성기 8b 단계는 **비치명**이다(실패해도 generation 은 성공). 그래서 실패가 조용하면
// 그 회차를 보는 화면 전체가 미러 라이브 집계(함대 11 s · Kia×MX 87 s, 2026-09-27
// EXPLAIN)로 돌아가고 아무도 모른다. 이 조회가 그 구멍을 센다: **노출 중인 웹사이트
// 회차의 활성 generation 인데 원장(`summary_url_hit_generations`)에 없는 것**.
// 원인이 8b 실패든 백필 누락이든 화면에서는 같은 결과(미러 폴백)이므로 한 술어로 본다.

export interface UrlHitsGapRow {
  cycleId: string;
  projectId: string;
  anchorAt: string;
  generationId: string;
  /** `summary_generations.timings.url_hits_failed` 가 1 이면 true(0064 미적용이면 null). */
  failed: boolean | null;
}

/**
 * 판정 대상 = **카드가 지금 실제로 읽는 회차**: `summary-cycles.ts::pickWebsiteCycles` 와 같은
 * 규칙(노출 가능·함대 대표·숨김 아님·활성 generation 이 있는 웹사이트 회차 중 **최신
 * `cycle_week`**)이다. 지나간 주의 회차는 스냅샷 카드가 읽지 않으므로 누락이어도 화면이
 * 느려지지 않는다: 그것까지 세면 백필 전 과거 주 회차 95개가 6시간마다 오탐으로 울린다
 * (재검증 2026-09-27 지적 2).
 *
 * 0081 미적용이면 `null`(판정 불가: 통과가 아니다).
 */
export async function readUrlHitsGaps(): Promise<UrlHitsGapRow[] | null> {
  if (!(await columnAvailable("summary_url_hit_generations", "jobs"))) return null;
  const [notHiddenOk, timingsOk] = await Promise.all([
    hiddenCycleColumnsAvailable(),
    columnAvailable("summary_generations", "timings"),
  ]);
  const failedSql = timingsOk
    ? sql`(SELECT (g.timings ->> 'url_hits_failed') = '1' FROM summary_generations g
          WHERE g.generation_id = c.active_generation_id)`
    : sql`NULL::boolean`;
  const rows = (await getDb().execute(sql`
    WITH wk AS (
      SELECT max(cycle_week) AS w
      FROM summary_cycles
      WHERE surface = 'website' AND fleet_visible
        AND ${cycleViewableSql()} AND active_generation_id IS NOT NULL
        AND ${cycleNotHiddenSql(notHiddenOk)}
    )
    SELECT c.cycle_id::text AS cycle_id, c.project_id::text AS project_id,
           c.cycle_anchor_at::text AS anchor_at, c.active_generation_id::text AS generation_id,
           ${failedSql} AS failed
    FROM summary_cycles c, wk
    WHERE c.surface = 'website'
      AND c.active_generation_id IS NOT NULL
      AND c.fleet_visible
      AND ${cycleViewableSql("c")}
      AND ${cycleNotHiddenSql(notHiddenOk, "c")}
      AND c.cycle_week = wk.w
      AND NOT EXISTS (
        SELECT 1 FROM summary_url_hit_generations u WHERE u.generation_id = c.active_generation_id
      )
    ORDER BY c.project_id
    LIMIT 500
  `)) as unknown as Array<{
    cycle_id: string; project_id: string; anchor_at: string; generation_id: string; failed: boolean | null;
  }>;
  return rows.map((r) => ({
    cycleId: r.cycle_id,
    projectId: r.project_id,
    anchorAt: r.anchor_at,
    generationId: r.generation_id,
    failed: r.failed,
  }));
}
