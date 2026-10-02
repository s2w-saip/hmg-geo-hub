/**
 * summary_* 사실표 — **글로벌(루트 프로젝트) 표면 어댑터**.
 *
 * 공통 뼈대(회차 원장·generation·사실표 INSERT·스왑)는 `lib/summary/generate/*` 코어가 갖고,
 * 웹사이트 표면(`surface-website.ts`)과 **다른 것만** 여기 남는다:
 *   · country  = scope_answers.region (글로벌은 다국가 프롬프트가 있어 답변 속성)
 *   · lang     = scope_prompts.lang **대문자 그대로**(표면별 원천 고정, §3-2)
 *   · 카탈로그 = 루트 프로젝트(prompts.project_id = STANDARD_ROOT) 행만, deleted_at 무시
 *                (SA 의 표준 경로가 `project_id = STANDARD_ROOT` 를 카탈로그 축 술어와
 *                 한 서브쿼리로 병합하고 deleted_at 술어는 없다 — SA:905-943·§3-6)
 *   · in_tagged_region = SA:676-721 두 술어의 AND 를 **실제로 계산**(웹사이트는 1 고정)
 *   · in_full_cycle    = §3-7 게이트를 회차 run 집합 창으로 재현(웹사이트는 1 고정)
 *   · summary_target_hits 는 만들지 않는다(웹사이트 전용, §3-5 v4.1 #4)
 *   · 보고서 유닛 플래그(report_fs·unit_owned·unit_target·unit_owned_citations)는 NULL
 *     — 글로벌엔 보고서 유닛이 없다. 0060 이 전부 nullable 로 붙여 컬럼 제약이 없다.
 *   · 규모가 3배라 프로젝트 단위가 아니라 **run 배치 단위**로 tx 를 쪼갠다(§7-1).
 *
 * 규율
 *  · **summary_* 표에만 쓴다.** 미러(scope_*)·카탈로그(prompts)는 읽기 전용.
 *  · 판정 규칙은 재구현하지 않고 오늘의 SQL 빌더를 그대로 import 한다(§7-5).
 *  · tx1 은 REPEATABLE READ 안에서 셀 선택과 scope_runs.synced_at 스냅샷을 함께 굳히고,
 *    스왑 tx 는 `FOR SHARE` 로 그 지문을 다시 읽어 비교한다(§7-3).
 */
import { sql, type SQL } from "drizzle-orm";
import { columnAvailable } from "@/lib/db/column-availability";
import {
  answerCycleAnchorsWritable,
  refreshAnchorsForRunsSql,
} from "@/lib/db/repositories/scope-answer-anchors";
// ⚠️ 아래 `ROOT_PROJECT_ID` 와 **다른 값일 수 있다**(그쪽은 하드코딩 폴백이 있다).
// 앵커 표면 판정은 해소 정본 한 곳만 쓴다(N-4).
import { anchorRootProjectIdOrThrow } from "@/lib/scope/anchor-root";
import { ROLLUP_NAMES } from "@/lib/db/repositories/scope-aggregates";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import {
  brandExprs,
  citationCtes,
  num as n,
  OWN_ROSTER_SQL,
  type GeneratorRuntime,
} from "@/lib/summary/generate/context";
import {
  insertGenerationSql,
  markGenerationFailedSql,
  restoreCycleStatusOnFailureSql,
  markGenerationReadySql,
  rowCountsSql,
  updateCycleCountersFromValuesSql,
  upsertCycleRunsSql,
  upsertCycleSql,
} from "@/lib/summary/generate/cycle";
import {
  analyzeFoldSources,
  FOLD_STATEMENT_TIMEOUT,
  FOLD_WORK_MEM,
  foldBatches,
  type OwnVariant,
} from "@/lib/summary/generate/fold";
import {
  insertAnswersSql,
  insertBrandMentionsSql,
  insertDomainCitationsSql,
} from "@/lib/summary/generate/load";
import {
  markDriftFailedSql,
  purgeOldGenerationRows,
  swapGeneration,
} from "@/lib/summary/generate/swap";
import type { GenerationKeys, RosterEntity } from "@/lib/summary/generate/types";
import {
  globalBaseUniverse,
  hiddenStandardRegions,
  noiseSnapshot,
  ownVariants as tenantOwnVariants,
  rosterSnapshot,
  sharedGlobalHosts,
  STANDARD_ROOT_PROJECT_ID,
} from "@/lib/summary/tenant/hmg";
import { fullCycleCte, inTaggedRegionExpr, presenceSetExpr } from "./global-predicates";

export const SURFACE = "global" as const;

/** ⑤ 분자 출처(T3) — 재접기 CLI 도 같은 값을 써야 하므로 상수로 둔다. */
export const OWN_CITATIONS_FROM = "scope" as const;

/** scope 루트 프로젝트. 화면 경로는 env(SCOPE_ROOT_PROJECT_ID)로 같은 값을 읽는다. */
export const ROOT_PROJECT_ID =
  process.env.SCOPE_ROOT_PROJECT_ID ?? "be28fe15-c743-4a88-abb8-182b25602812";

/**
 * §2-1 분석 게이트 임계 — 초과 시 --allow-gap 없이는 적재 거부.
 * 정본은 `lib/summary/read/analysis-gap.ts`(읽기 쪽 `isGeneratorSkipped` 와 같은 값이어야
 * 한다). 여기서는 기존 import 경로를 유지하려고 재수출만 한다.
 */
export { ANALYSIS_GAP_MAX } from "@/lib/summary/read/analysis-gap";

export type GlobalCycleSpec = {
  cycleAnchorAt: string;
  /** `(cycle_anchor_at AT TIME ZONE 'UTC')::date` — scope 가 채운 anchor 와 대조하는 값. */
  cycleAnchorDate: string;
  cycleWeek: string;
  /**
   * anchor 가 NULL 인 run 을 귀속시키는 measured_at 창(§8-1).
   * 회차 원장(`summary_cycle_runs`)이 이미 run 을 들고 있는 경로(T9 CLI)는 창이 없다 —
   * 그쪽은 `runsMemCte` 로 굳혀 둔 집합을 그대로 mem 으로 쓴다.
   */
  window?: { from: string; to: string };
};

export type Ctx = { filters: StandardFilters; roster: RosterEntity[]; basePrefixes: string[] };

// ── 루트 카탈로그 (§3-6) ────────────────────────────────────────────────────
// **루트 프로젝트 행만** 모집단이다 — SA 의 표준 경로는 카탈로그 축(brand·depth·
// list_type·funnel) 술어를 `project_id = STANDARD_ROOT` 와 한 서브쿼리로 병합한다
// (SA:905-943, `answerWhere` 머리 주석). 웹사이트 생성기가 전 프로젝트 행을 모으는 것과
// 다른 이유가 여기 있다(그쪽은 표준 게이트를 안 탄다).
// `deleted_at` 술어는 없다 — 오늘 SA 에도 0건(§3-6). 삭제 행은 `catalog_deleted` 로 기록만.
const CAT_CTE = sql`
  cat AS (
    SELECT p.scope_prompt_id AS pid,
           COALESCE(array_agg(DISTINCT p.brand) FILTER (WHERE p.brand IS NOT NULL), '{}') AS catalog_brands,
           (array_agg(p.funnel_stage   ORDER BY p.updated_at DESC))[1] AS funnel_catalog,
           -- 원값 1행(감사·대조용, 조회는 쓰지 않는다) + 조회가 쓰는 유도 집합(0063).
           (array_agg(p.brand_presence ORDER BY p.updated_at DESC))[1] AS brand_presence_resolved,
           ${presenceSetExpr(sql`p.brand`, sql`p.brand_presence`)} AS presence_set,
           (array_agg(p.list_type      ORDER BY p.updated_at DESC))[1] AS list_type,
           (array_agg(p.depth1         ORDER BY p.updated_at DESC))[1] AS depth1,
           (array_agg(p.depth2         ORDER BY p.updated_at DESC))[1] AS depth2,
           (array_agg(p.depth3         ORDER BY p.updated_at DESC))[1] AS depth3,
           (array_agg(p.id             ORDER BY p.updated_at DESC))[1] AS catalog_row_id,
           (array_agg(p.status::text   ORDER BY p.updated_at DESC))[1] AS catalog_status,
           max((p.deleted_at IS NOT NULL)::int) AS catalog_deleted
    FROM prompts p
    WHERE p.project_id = ${STANDARD_ROOT_PROJECT_ID}::uuid AND p.scope_prompt_id IS NOT NULL
    GROUP BY 1
  )`;

// ── 회차 멤버십 (§8-1) ──────────────────────────────────────────────────────
// run 상태 술어 없음 — run_status 는 조회 게이트다. scope 가 anchor 를 채워 두었으면
// 그 값을 우선하고, NULL 이면 measured_at 창으로 귀속한다(현재 미러는 전부 NULL).
export function memCte(spec: GlobalCycleSpec): SQL {
  if (!spec.window) throw new Error("memCte 는 멤버십 창이 있는 회차에서만 쓴다");
  return sql`
  mem AS (
    SELECT r.run_id, r.status, r.synced_at, r.cycle_anchor_at, r.started_at
    FROM scope_runs r
    WHERE r.project_id = ${ROOT_PROJECT_ID}::uuid
      AND (CASE
             WHEN r.cycle_anchor_at IS NOT NULL
               THEN (r.cycle_anchor_at AT TIME ZONE 'UTC')::date = ${spec.cycleAnchorDate}::date
             ELSE EXISTS (
               SELECT 1 FROM scope_answers a
               WHERE a.run_id = r.run_id
                 AND a.measured_at >= ${spec.window.from}::timestamptz
                 AND a.measured_at <  ${spec.window.to}::timestamptz)
           END)
  )`;
}

/**
 * 회차 원장에 **굳혀 둔** run 집합을 mem 으로 쓴다(§8-1 P6: 닫힌 회차의 모수는 안 바뀐다).
 * 관제(`summary_cycle_runs`)가 귀속을 끝낸 회차를 생성할 때의 경로 — 창 재계산을 하지 않는다.
 */
export function runsMemCte(runIds: string[]): SQL {
  return sql`
  mem AS (
    SELECT r.run_id, r.status, r.synced_at, r.cycle_anchor_at, r.started_at
    FROM scope_runs r
    WHERE r.run_id = ANY(${sql.param(runIds)}::uuid[])
  )`;
}

const citations = (ctx: Ctx) =>
  citationCtes({
    bases: ctx.basePrefixes,
    tracked: false,
    tiebreak: true,
    rootHomeHosts: sharedGlobalHosts(),
  });

// ── 세부층 공통 차원 (§3-2) ─────────────────────────────────────────────────
// 사실표 3종이 공유한다. dim 을 **먼저 적재**하고 여기서 읽는다 — full-cycle 게이트를
// 프롬프트당 한 번만 계산하고, dim 과 사실표의 프롬프트 속성이 정의상 같아진다.
function dimsCte(keys: GenerationKeys, runIds: string[]): SQL {
  return sql`
    jb AS (
      SELECT j.job_id, j.run_id, j.prompt_id, j.engine, j.country, j.measured_at
      FROM summary_cycle_jobs j
      WHERE j.cycle_week = ${keys.cycleWeek}::date AND j.cycle_id = ${keys.cycleId}::uuid
        AND j.generation_id = ${keys.generationId}::uuid AND j.run_id = ANY(${sql.param(runIds)}::uuid[])
    ),
    d AS (
      SELECT jb.job_id, jb.prompt_id, jb.engine, jb.country,
             ${ROOT_PROJECT_ID}::uuid AS project_id,
             dm.lang, dm.catalog_brands,
             dm.funnel_catalog, dm.funnel_scope, dm.brand_presence_resolved, dm.presence_set,
             dm.list_type, dm.depth1, dm.depth2, dm.depth3,
             dm.in_root_catalog,
             ${inTaggedRegionExpr(sql`jb.prompt_id`, sql`jb.country`, sql`jb.measured_at`)} AS in_tagged_region,
             dm.in_full_cycle,
             r.status AS run_status
      FROM jb
      JOIN scope_runs r ON r.run_id = jb.run_id
      JOIN summary_prompt_dim dm
        ON dm.cycle_week = ${keys.cycleWeek}::date AND dm.cycle_id = ${keys.cycleId}::uuid
       AND dm.generation_id = ${keys.generationId}::uuid AND dm.prompt_id = jb.prompt_id
    )`;
}

// ── 컨텍스트 ────────────────────────────────────────────────────────────────
export async function loadCtx(rt: GeneratorRuntime): Promise<Ctx> {
  const roster = await rt.rows<{ entity_id: string; name: string }>(OWN_ROSTER_SQL);
  const ownEntities: RosterEntity[] = roster.map((r) => ({ id: r.entity_id, name: r.name }));
  // 글로벌 universe = 카탈로그 선언 base 전량(§3-5). 웹사이트처럼 사이트별로 좁히지 않는다.
  return { filters: { ownEntities }, roster: ownEntities, basePrefixes: globalBaseUniverse() };
}

/**
 * `own_variant` 목록 — `ALL` + 명부 브랜드 각각(2026-09-10 실측 3사 → **4개**).
 *
 * 유도는 테넌트 seam 이 한다(PR② T3). 글로벌은 base universe 가 `GEO_OWNED_BASES` 이므로
 * ⑤ 스코프를 그 카탈로그의 (국가, 언어) 축으로 좁힌다 — 오늘 리더가 `f.region`·`f.lang` 을
 * `ownedBasePrefixesForScope` 에 넘기는 것과 같은 좁힘(2026-09-01 −12.83%p 수정).
 * 세부층 `lang` 은 대문자(`dm.lang` = `scope_prompts.lang`)라 스코프 행도 대문자다.
 */
export function ownVariants(ctx: Ctx): OwnVariant[] {
  return tenantOwnVariants({
    roster: ctx.roster,
    basePrefixes: ctx.basePrefixes,
    scopeNarrowing: "catalog-geo",
    langCase: "upper",
  });
}

export async function listRuns(rt: GeneratorRuntime, spec: GlobalCycleSpec) {
  return rt.rows<{ run_id: string; status: string; anchored: boolean }>(sql`
    WITH ${memCte(spec)}
    SELECT run_id::text AS run_id, status, (cycle_anchor_at IS NOT NULL) AS anchored
    FROM mem ORDER BY started_at
  `);
}

/** 회차 관측치 — expected/completed 셀, 분석 갭(답변 기준·셀 기준). §2-1 */
export type Observed = {
  answers_all: number; answers_completed: number;
  expected_units: number; completed_units: number; prompts: number;
  gap_answers: number; gap_cells: number;
  measured_from: string | null; measured_to: string | null;
};

export async function observe(rt: GeneratorRuntime, mem: SQL): Promise<Observed> {
  const r = await rt.heavyRows<Observed>(sql`
    WITH ${mem},
    all_ans AS (SELECT a.* FROM scope_answers a JOIN mem ON mem.run_id = a.run_id),
    cells AS (
      SELECT DISTINCT ON (a.prompt_id, a.target, a.region) a.job_id
      FROM all_ans a WHERE a.status = 'completed'
      ORDER BY a.prompt_id, a.target, a.region, a.measured_at DESC
    )
    SELECT (SELECT count(*) FROM all_ans)::int AS answers_all,
           (SELECT count(*) FROM all_ans WHERE status = 'completed')::int AS answers_completed,
           (SELECT count(DISTINCT (prompt_id, target, region)) FROM all_ans)::int AS expected_units,
           (SELECT count(DISTINCT (prompt_id, target, region)) FROM all_ans WHERE status = 'completed')::int AS completed_units,
           (SELECT count(DISTINCT prompt_id) FROM all_ans WHERE status = 'completed')::int AS prompts,
           (SELECT count(*) FROM all_ans a WHERE a.status = 'completed'
              AND NOT EXISTS (SELECT 1 FROM scope_mentions m WHERE m.job_id = a.job_id)
              AND NOT EXISTS (SELECT 1 FROM scope_citations c WHERE c.job_id = a.job_id))::int AS gap_answers,
           (SELECT count(*) FROM cells c
              WHERE NOT EXISTS (SELECT 1 FROM scope_mentions m WHERE m.job_id = c.job_id)
                AND NOT EXISTS (SELECT 1 FROM scope_citations x WHERE x.job_id = c.job_id))::int AS gap_cells,
           (SELECT min(measured_at)::text FROM all_ans) AS measured_from,
           (SELECT max(measured_at)::text FROM all_ans) AS measured_to
  `);
  return r[0];
}

// ── DRY-RUN ─────────────────────────────────────────────────────────────────
export async function dryRun(
  rt: GeneratorRuntime,
  ctx: Ctx,
  spec: GlobalCycleSpec,
  runIds: string[],
) {
  const b = brandExprs(ctx.filters);
  const MEM = memCte(spec);
  const INLINE_JB = sql`
    jb AS (
      SELECT DISTINCT ON (a.prompt_id, a.target, a.region)
             a.job_id, a.run_id, a.prompt_id, a.target AS engine, a.region AS country, a.measured_at
      FROM scope_answers a JOIN mem ON mem.run_id = a.run_id
      WHERE a.status = 'completed'
      ORDER BY a.prompt_id, a.target, a.region, a.measured_at DESC
    )`;

  const fcRow = await rt.heavyRows<Record<string, unknown>>(sql`
    WITH ${MEM}, ${fullCycleCte(ROOT_PROJECT_ID)}, ${INLINE_JB}
    SELECT (SELECT count(*) FROM fc_active)::int AS active_cells,
           (SELECT count(*) FROM fc)::int AS fc_prompts,
           (SELECT count(*) FROM fc WHERE window_cells >= expected_cells)::int AS fc_pass,
           (SELECT count(*) FROM fc WHERE window_cells > 0)::int AS fc_in_window,
           (SELECT count(*) FROM fc WHERE window_cells > 0 AND window_cells >= expected_cells)::int AS fc_in_window_pass,
           (SELECT count(*) FROM jb)::int AS cells,
           (SELECT count(*) FROM jb JOIN fc ON fc.prompt_id = jb.prompt_id
             WHERE fc.window_cells >= fc.expected_cells)::int AS cells_full_cycle,
           (SELECT count(DISTINCT jb.prompt_id) FROM jb JOIN fc ON fc.prompt_id = jb.prompt_id
             WHERE fc.window_cells >= fc.expected_cells)::int AS prompts_full_cycle,
           (SELECT count(*) FROM jb WHERE ${inTaggedRegionExpr(sql`jb.prompt_id`, sql`jb.country`, sql`jb.measured_at`)} = 1)::int AS cells_tagged_region,
           (SELECT count(*) FROM jb WHERE jb.country = ANY(${sql.param(hiddenStandardRegions())}::text[]))::int AS cells_hidden_region
  `);
  rt.log("full-cycle·지역태그:", fcRow[0]);

  const brand = await rt.heavyRows<Record<string, unknown>>(sql`
    WITH names AS ${ROLLUP_NAMES}, ${MEM}, ${INLINE_JB},
    mrows AS (
      SELECT m.job_id, ${b.rollup} AS brand_id, ${b.brandName} AS brand_name,
             (${b.isCompetitor}) AS pass, m.mention_count
      FROM scope_mentions m JOIN jb ON jb.job_id = m.job_id
      LEFT JOIN names n ON n.entity_id = ${b.rollup}
      WHERE m.brand_rollup_entity_id IS NOT NULL AND ${b.rawName} IS NOT NULL
    ),
    bg AS (
      SELECT job_id, brand_id, brand_name, bool_or(pass) AS anyp,
             sum(mention_count)::bigint AS mentions,
             sum(mention_count) FILTER (WHERE pass)::bigint AS mentions_pass
      FROM mrows GROUP BY 1,2,3
    )
    SELECT (SELECT count(*) FROM bg)::int AS brand_rows,
           (SELECT COALESCE(sum(mentions),0) FROM bg)::bigint AS mentions_2gate,
           (SELECT COALESCE(sum(mentions_pass),0) FROM bg)::bigint AS mentions_3gate,
           (SELECT count(DISTINCT job_id) FROM bg)::int AS jobs_with_brand
  `);
  rt.log("브랜드 표(예상):", brand[0]);

  const cit = await rt.heavyRows<Record<string, unknown>>(sql`
    WITH ${MEM}, ${INLINE_JB}, ${citations(ctx)},
    dg AS (
      SELECT c2.job_id, c2.gk, COALESCE(ub.matched_base, '') AS mb
      FROM c2 JOIN ub ON ub.uk = c2.uk GROUP BY 1,2,3
    )
    SELECT (SELECT count(*) FROM c2)::int AS citations_raw,
           (SELECT count(*) FROM dg)::int AS domain_rows,
           (SELECT count(*) FROM un)::int AS distinct_urls,
           (SELECT count(*) FROM ub WHERE matched_base IS NOT NULL)::int AS urls_owned_base,
           (SELECT count(*) FROM un WHERE base IS NULL)::int AS urls_base_null
  `);
  rt.log("인용 표(예상):", cit[0]);

  const dim = await rt.heavyRows<Record<string, unknown>>(sql`
    WITH ${MEM}, ${INLINE_JB}, ${CAT_CTE}
    SELECT (SELECT count(*) FROM cat)::int AS catalog_prompts,
           (SELECT count(DISTINCT prompt_id) FROM jb)::int AS measured_prompts,
           (SELECT count(*) FROM (SELECT pid FROM cat UNION SELECT prompt_id FROM jb) u)::int AS dim_rows,
           (SELECT count(*) FROM cat WHERE cardinality(catalog_brands) > 1)::int AS multi_brand_prompts,
           (SELECT count(*) FROM cat WHERE catalog_deleted = 1)::int AS with_deleted_row
  `);
  rt.log("dim(예상):", dim[0]);

  // 카탈로그 중복의 brand × depth 결합 (§3-6 은 depth 만 의도적 변경으로 잡았다).
  // 오늘 미러는 brand·depth 를 **한 prompts 행**이 동시에 만족해야 하는 세미조인이고,
  // 사실표는 brand=배열(any-match) · depth=최신 1행이다. 그래서 "brand b 를 가진 행의
  // depth" 와 "채택된 최신 행의 depth" 가 다른 프롬프트에서 결합 필터가 갈린다.
  const split = await rt.heavyRows<Record<string, unknown>>(sql`
    WITH ${MEM}, ${INLINE_JB}, ${CAT_CTE},
    r AS (
      SELECT p.scope_prompt_id AS pid, p.brand, p.depth1, p.depth2, p.depth3
      FROM prompts p
      WHERE p.project_id = ${STANDARD_ROOT_PROJECT_ID}::uuid AND p.scope_prompt_id IS NOT NULL
    ),
    j AS (
      SELECT r.pid, r.brand, r.depth1, r.depth2, r.depth3,
             cat.depth1 AS d1, cat.depth2 AS d2, cat.depth3 AS d3
      FROM r JOIN cat ON cat.pid = r.pid
    ),
    sp AS (
      SELECT DISTINCT pid FROM j
      WHERE depth1 IS DISTINCT FROM d1 OR depth2 IS DISTINCT FROM d2 OR depth3 IS DISTINCT FROM d3
    ),
    spb AS (
      SELECT DISTINCT pid FROM j
      WHERE brand IS NOT NULL
        AND (depth1 IS DISTINCT FROM d1 OR depth2 IS DISTINCT FROM d2 OR depth3 IS DISTINCT FROM d3)
    )
    SELECT (SELECT count(*) FROM sp)::int  AS prompts_depth_differs,
           (SELECT count(*) FROM spb)::int AS prompts_brand_depth_split,
           (SELECT count(*) FROM jb WHERE jb.prompt_id IN (SELECT pid FROM spb))::int AS cells_affected
  `);
  rt.log("brand×depth 결합 갈림:", split[0]);

  const expected = {
    cycle_runs: runIds.length,
    cycle_jobs: n(fcRow[0]?.cells),
    answers: n(fcRow[0]?.cells),
    brand_mentions: n(brand[0]?.brand_rows),
    domain_citations: n(cit[0]?.domain_rows),
    target_hits: 0,
    prompt_dim: n(dim[0]?.dim_rows),
  };
  rt.log("표별 예상 행수:", expected);
  return expected;
}

// ── 적재 ────────────────────────────────────────────────────────────────────
export async function generate(
  rt: GeneratorRuntime,
  ctx: Ctx,
  spec: GlobalCycleSpec,
  runIds: string[],
  obs: Observed,
  opts: { cycleId?: string; runBatch?: number; mem?: SQL } = {},
) {
  const RUN_BATCH = opts.runBatch && opts.runBatch > 0 ? opts.runBatch : 20;
  // full-cycle 게이트가 보는 창. 레거시는 anchor/창 판정, T9 CLI 는 굳혀 둔 run 집합.
  const mem = opts.mem ?? memCte(spec);
  const cycleId =
    opts.cycleId ??
    (
      await rt.rows<{ cycle_id: string }>(
        upsertCycleSql({
          surface: SURFACE,
          projectId: ROOT_PROJECT_ID,
          cycleAnchorAt: spec.cycleAnchorAt,
          cycleWeek: spec.cycleWeek,
          version: rt.version,
        }),
      )
    )[0].cycle_id;

  const gen = await rt.rows<{ generation_id: string }>(
    insertGenerationSql({
      cycleId,
      version: rt.version,
      rosterSnapshot: rosterSnapshot(ctx.roster, {
        scopeRootProjectId: ROOT_PROJECT_ID,
        hiddenStandardRegions: hiddenStandardRegions(),
      }),
      baseUniverse: { matching_universe: ctx.basePrefixes },
      targetUniverse: { source: "글로벌 표면 — 타겟 universe 없음(summary_target_hits 미생성)" },
      noiseSnapshot: noiseSnapshot(),
    }),
  );
  const genId = gen[0].generation_id;
  const keys: GenerationKeys = { cycleWeek: spec.cycleWeek, cycleId, generationId: genId };
  rt.log(`cycle=${cycleId} generation=${genId}`);

  // 앵커 테이블 전파(B2) 가능 여부 — 프로브는 트랜잭션 **밖에서** 확정한다
  // (column-availability 계약 ①). 0077 미적용이면 false 라 문장이 아예 안 나간다.
  const anchorsWritable = await answerCycleAnchorsWritable();

  try {
    // 1) tx1 — REPEATABLE READ 안에서 멤버십 + 셀 집합 + synced_at 지문(§7-3)
    await rt.time("cycle_jobs", () =>
      rt.db.transaction(
        async (tx) => {
          await tx.execute(sql`SET LOCAL statement_timeout = '600s'`);
          await tx.execute(upsertCycleRunsSql(cycleId, runIds));
          // 원장 → 앵커 테이블 전파(스펙 §4 · B2). `upsertCycleRunsSql` 은
          // `ON CONFLICT (run_id) DO UPDATE SET cycle_id = …` 라 **재귀속** 경로다 —
          // run 의 회차가 바뀌면 앵커 테이블의 cycle_id·ledger 앵커·view_anchor 가 전부
          // 따라와야 한다. 같은 tx1 안이라 롤백되면 전파도 함께 없던 일이 된다.
          if (anchorsWritable) {
            const stmt = refreshAnchorsForRunsSql(runIds, anchorRootProjectIdOrThrow());
            if (stmt) await tx.execute(stmt);
          }
          await tx.execute(sql`
          INSERT INTO summary_cycle_jobs
            (cycle_week, cycle_id, generation_id, job_id, run_id, prompt_id, engine, country, measured_at)
          -- 글로벌은 country = scope_answers.region (프롬프트 속성이 아니라 답변 속성, §3-1).
          SELECT ${spec.cycleWeek}::date, ${cycleId}::uuid, ${genId}::uuid,
                 c.job_id, c.run_id, c.prompt_id, c.target, c.region, c.measured_at
          FROM (
            SELECT DISTINCT ON (a.prompt_id, a.target, a.region)
                   a.job_id, a.run_id, a.prompt_id, a.target, a.region, a.measured_at
            FROM scope_answers a
            WHERE a.run_id = ANY(${sql.param(runIds)}::uuid[]) AND a.status = 'completed'
              AND a.prompt_id IS NOT NULL AND a.region IS NOT NULL
            ORDER BY a.prompt_id, a.target, a.region, a.measured_at DESC
          ) c
        `);
        },
        { isolationLevel: "repeatable read" },
      ),
    );
    const jobCount = n(
      (
        await rt.rows<{ c: number }>(
          sql`SELECT count(*)::int AS c FROM summary_cycle_jobs
              WHERE cycle_week = ${spec.cycleWeek}::date AND generation_id = ${genId}::uuid`,
        )
      )[0]?.c,
    );
    rt.log(`cycle_jobs ${jobCount}행 (관측 완료 셀 ${obs.completed_units})`);
    if (jobCount !== obs.completed_units) {
      throw new Error(
        `cycle_jobs(${jobCount}) ≠ completed_units(${obs.completed_units}) — 셀 선택이 답변을 흘렸다`,
      );
    }

    // 2) 회차 카운터 (§2-1 — expected 는 사전 산식이 아니라 관측값)
    const gapRatio = obs.answers_completed > 0 ? obs.gap_answers / obs.answers_completed : 0;
    await rt.exec(
      updateCycleCountersFromValuesSql({
        cycleId,
        version: rt.version,
        measuredFrom: obs.measured_from,
        measuredTo: obs.measured_to,
        expectedUnits: obs.expected_units,
        completedUnits: obs.completed_units,
        analysisGapRatio: gapRatio.toFixed(5),
      }),
    );

    // 3) summary_prompt_dim (§3-6) — full-cycle 게이트를 프롬프트당 1회 계산해 굳힌다.
    //    모집단 = 루트 카탈로그 전체 ∪ 이 회차가 실제 측정한 prompt_id(§3-6).
    await rt.time("prompt_dim", () =>
      rt.heavy(sql`
      WITH ${mem}, ${fullCycleCte(ROOT_PROJECT_ID)}, ${CAT_CTE},
      jb AS (
        SELECT j.prompt_id, count(*)::int AS cells
        FROM summary_cycle_jobs j
        WHERE j.cycle_week = ${spec.cycleWeek}::date AND j.cycle_id = ${cycleId}::uuid
          AND j.generation_id = ${genId}::uuid
        GROUP BY 1
      ),
      pids AS (
        SELECT pid FROM cat
        UNION
        SELECT prompt_id FROM jb
      )
      INSERT INTO summary_prompt_dim
        (cycle_week, cycle_id, generation_id, prompt_id, project_id, lang, catalog_brands,
         funnel_catalog, funnel_scope, brand_presence_resolved, presence_set, list_type, depth1, depth2, depth3,
         regions, is_korean, in_root_catalog, catalog_status, catalog_deleted, in_full_cycle,
         expected_cells, window_cells, catalog_row_id, custom_tags, text,
         site_country, site_lang, target_url_norm, owned_base_url)
      SELECT ${spec.cycleWeek}::date, ${cycleId}::uuid, ${genId}::uuid,
             pids.pid, ${ROOT_PROJECT_ID}::uuid,
             sp.lang,                              -- 대문자 그대로(§3-2 표면별 원천 고정)
             COALESCE(cat.catalog_brands, '{}'),
             cat.funnel_catalog, sp.funnel_stage, cat.brand_presence_resolved,
             COALESCE(cat.presence_set, '{}'),
             cat.list_type, cat.depth1, cat.depth2, cat.depth3,
             sp.regions, CASE WHEN sp.is_korean THEN 1 ELSE 0 END,
             CASE WHEN cat.pid IS NOT NULL THEN 1 ELSE 0 END,
             cat.catalog_status, COALESCE(cat.catalog_deleted, 0),
             CASE WHEN fc.prompt_id IS NOT NULL AND fc.window_cells >= fc.expected_cells THEN 1 ELSE 0 END,
             fc.expected_cells, COALESCE(fc.window_cells, jb.cells),
             cat.catalog_row_id, NULL::jsonb, sp.text,
             NULL::text, NULL::text, NULL::text, NULL::text
      FROM pids
      LEFT JOIN cat ON cat.pid = pids.pid
      LEFT JOIN scope_prompts sp ON sp.prompt_id = pids.pid
      LEFT JOIN fc  ON fc.prompt_id  = pids.pid
      LEFT JOIN jb  ON jb.prompt_id  = pids.pid
    `),
    );
    const dimCount = n(
      (
        await rt.rows<{ c: number }>(
          sql`SELECT count(*)::int AS c FROM summary_prompt_dim
              WHERE cycle_week = ${spec.cycleWeek}::date AND generation_id = ${genId}::uuid`,
        )
      )[0]?.c,
    );
    const fcStat = await rt.rows<Record<string, unknown>>(sql`
      SELECT count(*) FILTER (WHERE in_full_cycle = 1)::int AS pass_prompts,
             count(*) FILTER (WHERE in_full_cycle = 1 AND window_cells > 0)::int AS pass_measured
      FROM summary_prompt_dim
      WHERE cycle_week = ${spec.cycleWeek}::date AND generation_id = ${genId}::uuid
    `);
    rt.log(`prompt_dim ${dimCount}행 · in_full_cycle=1 프롬프트`, fcStat[0]);

    // 4) 사실표 3종 — run 배치 단위 tx (§7-1)
    const batches: string[][] = [];
    for (let i = 0; i < runIds.length; i += RUN_BATCH) batches.push(runIds.slice(i, i + RUN_BATCH));
    const b = brandExprs(ctx.filters);
    let bi = 0;
    for (const batch of batches) {
      bi += 1;
      const D = dimsCte(keys, batch);

      await rt.time("answers", () =>
        rt.heavy(insertAnswersSql({ keys, rollupNames: ROLLUP_NAMES, withCtes: D, brand: b })),
      );
      await rt.time("brand_mentions", () =>
        rt.heavy(insertBrandMentionsSql({ keys, rollupNames: ROLLUP_NAMES, withCtes: D, brand: b })),
      );
      await rt.time("domain_citations", () =>
        rt.heavy(insertDomainCitationsSql({ keys, withCtes: sql`${D}, ${citations(ctx)}` })),
      );

      rt.log(`배치 ${bi}/${batches.length} (run ${batch.length}개) 완료`);
    }

    // 5) 행수 기록 → ready
    const rc = await rt.rows<Record<string, unknown>>(rowCountsSql(genId));
    rt.log("표별 행수:", rc[0]);
    await rt.exec(
      markGenerationReadySql(genId, {
        ...rc[0],
        analysis_gap_answers: obs.gap_answers,
        analysis_gap_cells: obs.gap_cells,
      }),
    );

    // 6) 스왑 tx (§7-3 낙관 검사 + §7-1 원자 전환) — 집계층 접기를 **같은 tx 안에서** 한다.
    //    스왑이 접히면 집계층 행도 함께 사라진다(PR② T2 수용 기준 ⑤).
    // 0065(집계층 확장 7컬럼) 미적용 DB 에서 접기를 쏘면 42703 으로 생성 전체가 죽는다 —
    // `timings`(0064) 와 같은 자세로 **조용히 건너뛴다**. 코드가 마이그레이션보다 먼저 배포될 수 있다.
    const foldReady = await columnAvailable("summary_trend_own", "comp_mentions");
    if (!foldReady) rt.log("  ↳ summary_trend_own 확장 컬럼 없음(0065 미적용) — 집계층 접기 생략");
    // 새 generation 을 플래너에게 알린다(스왑 tx 밖 — 세부층은 이미 커밋됐다). 실패해도 진행.
    if (foldReady) await analyzeFoldSources(rt, keys);
    const swapped = await swapGeneration(rt, cycleId, genId, SURFACE, foldReady ? {
      batches: foldBatches({
        keys,
        surface: SURFACE,
        cycleAnchorAt: spec.cycleAnchorAt,
        variants: ownVariants(ctx),
        ownCitationsFrom: OWN_CITATIONS_FROM,
      }),
      statementTimeout: FOLD_STATEMENT_TIMEOUT,
      workMem: FOLD_WORK_MEM,
    } : undefined);
    if (!swapped) {
      await rt.exec(markDriftFailedSql(genId));
      throw new Error("synced_at drift — generation 폐기. 재실행하면 새 generation 으로 다시 만든다.");
    }

    // 7) 옛 generation 세부층 정리 (§7-1 — 커밋 후)
    await purgeOldGenerationRows(rt, keys);
    return { counts: rc[0], cycleId, generationId: genId };
  } catch (e) {
    await rt.exec(markGenerationFailedSql(genId, String(e).slice(0, 2000)));
    // 카운터 UPDATE 가 올려 둔 'generating' 을 되돌린다 — 안 되돌리면 `--pending` 이
    // 그 회차를 영영 다시 안 뽑는다(cycle.ts::restoreCycleStatusOnFailureSql 머리 주석).
    await rt.exec(restoreCycleStatusOnFailureSql(cycleId));
    throw e;
  }
}
