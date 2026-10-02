/**
 * summary_* 사실표 — **웹사이트 표면 어댑터**.
 *
 * 공통 뼈대(회차 원장·generation·사실표 INSERT·스왑)는 `lib/summary/generate/*` 코어가
 * 갖고, 이 파일에는 웹사이트에만 있는 것만 남긴다:
 *   · 보고서 v2.4 유닛(사이트×언어) 멤버십과 그 자사/타겟 판정
 *   · country = `website_sites.country_code`(없으면 답변 region 폴백) · lang = 소문자 `lang_code`
 *   · `summary_target_hits` 생성(⑥ 전용)
 *   · `in_tagged_region`·`in_full_cycle` = 1 고정(웹사이트는 표준 게이트를 안 탄다)
 *
 * 설계 정본: internal-kb/hmg-geo-summary-table-design-v4-2026-09-06.md
 *   §3(그레인·컬럼) · §6-4(KPI 가 쓰는 값) · §7-3(격리) · §7-5(판정 규칙 한 벌) · §8-1(회차 멤버십)
 *
 * 규율
 *  · **summary_* 표에만 쓴다.** 미러(scope_*)·카탈로그(prompts·website_*)는 읽기 전용.
 *  · 판정 규칙(롤업·표시명·비경쟁·그룹키·URL 정규화)은 재구현하지 않고 오늘의 SQL
 *    빌더를 그대로 import 한다(§7-5) — 규칙이 두 벌이 되는 순간 화면과 사실표가 갈린다.
 *  · tx1 은 REPEATABLE READ 안에서 셀 선택(summary_cycle_jobs)과 scope_runs.synced_at
 *    스냅샷을 함께 굳히고, 스왑 tx 는 `FOR SHARE` 로 그 지문을 다시 읽어 비교한다(§7-3).
 *  · 재실행 안전: 회차는 UNIQUE(project_id, cycle_anchor_at) 로 재사용, generation 은
 *    매번 새로 만든다 → 세부층 행이 충돌하지 않는다. 스왑 후 옛 generation 행을 지운다.
 */
import { readFileSync } from "node:fs";
import { sql, type SQL } from "drizzle-orm";
import { columnAvailable } from "@/lib/db/column-availability";
import {
  answerCycleAnchorsWritable,
  refreshAnchorsForRunsSql,
} from "@/lib/db/repositories/scope-answer-anchors";
import { anchorRootProjectIdOrThrow } from "@/lib/scope/anchor-root";
import { checkCellSelection } from "@/lib/summary/generate/cell-guard";

// 표면 판정의 'standard' 근거 — 해소 정본은 `lib/scope/anchor-root.ts` 한 곳이다(N-4).
const ANCHOR_ROOT_PROJECT_ID = anchorRootProjectIdOrThrow();
import {
  ROLLUP_NAMES,
  citationTrackedNormSql,
  ownedBasePrefixClause,
  websiteOwnedUnits,
  websitePromptUrlHitJobFlagsSql,
} from "@/lib/db/repositories/scope-aggregates";
import { ensureColumnAvailability } from "@/lib/db/column-availability";
import type { WebsiteOwnedUnit } from "@/lib/scope/website-owned-unit";
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
  rowCountsSql,
  markGenerationReadySql,
  updateCycleCountersFromWindowSql,
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
  insertTargetHitsSql,
  insertUrlHitsSql,
  purgeOldUrlHitsSql,
} from "@/lib/summary/generate/load";
import { markDriftFailedSql, purgeOldGenerationRows, swapGeneration } from "@/lib/summary/generate/swap";
import type { GenerationKeys, RosterEntity } from "@/lib/summary/generate/types";
import {
  ownVariants as tenantOwnVariants,
  ownedBasePrefixFromUrl,
  rosterSnapshot,
  noiseSnapshot,
  sharedGlobalHosts,
  STANDARD_ROOT_PROJECT_ID,
} from "@/lib/summary/tenant/hmg";
import { EXCLUDED_SITE_COUNTRY_CODES } from "./excluded";
import { presenceSetExpr } from "./global-predicates";

export const SURFACE = "website" as const;

/** ⑤ 분자 출처(T3) — 재접기 CLI 도 같은 값을 써야 하므로 상수로 둔다. */
export const OWN_CITATIONS_FROM = "unit_column" as const;

/** 회차 좌표 — 종전 `website-0904.ts` 의 상수 3종이 여기로 들어온다. */
export type WebsiteCycleSpec = {
  cycleAnchorAt: string;
  cycleWeek: string;
  /** 멤버십 창(run.started_at). 회차 원장이 아직 run 을 갖고 있지 않은 레거시 경로용. */
  window?: { from: string; to: string };
};

// ── 판정 입력 (테넌트 값 — §부록 A: 생성기는 스냅샷을 입력으로 받는다) ─────────
export type UnitRow = {
  promptId: string; fs: number; base: string;
  /** tracked NORM(쿼리 보존) — ⑥ 타겟 판정용. */ turl: string;
  /** base NORM(쿼리 제거) — ⑤ 자사 판정(타겟 ⊂ 자사)용. */ turlBase: string;
  sibs: string[]; homeHost: string | null;
};
export type Ctx = {
  filters: StandardFilters;
  roster: RosterEntity[];
  basePrefixes: string[]; // 선언 base 전량 → owned 판정 prefix (최장 일치 universe)
  /** 보고서 v2.4 유닛(사이트×언어) 멤버십 — 프로젝트별 프롬프트 목록. */
  unitsByProject: Map<string, UnitRow[]>;
  unitCount: number;
  /**
   * 자사·타겟 URL 인용률(GGMD-61, 0081)의 유닛 판정 입력: 대시보드 미러 경로
   * (`server.ts::websiteOwnedPrefixes` → `websiteOwnedUnits()`)와 **같은 함수**로 읽는다.
   * 위 `unitsByProject`(보고서 spec 109 유닛)와 다른 모집단이다: 이 카드 2종의 미러
   * 쌍둥이가 spec 이 아니라 `website_prompts` 전 유닛(사이트 × file_seq)을 쓰기 때문이다.
   */
  ownedUnits: WebsiteOwnedUnit[] | null;
  /**
   * `ownedUnits` 가 null 인 이유. `"0081-missing"` = 표가 없다(정상적인 롤아웃 창),
   * 그 밖의 문자열 = 유닛 적재 실패(8b 를 건너뛰고 실패 플래그를 남긴다).
   */
  urlHitsSkip?: string;
};

// ── 보고서 v2.4 유닛 (§0060) ────────────────────────────────────────────────
// 정본 = scripts/reports/extract-citation-data.mts + report-spec.json(109 유닛).
// 규칙이 전부 유닛 고유(화면 필터 무관)라 생성 시점에 행 플래그로 굳힌다.
//
// ⚠️ `report_fs` 는 spec 의 `fs` 가 아니라 **그 유닛 프롬프트의 file_seq** 다.
// spec 에 fs=41 이 두 줄 있는데(Hyundai N/worldwide/en · Hyundai/worldwide/en),
// 보고서는 041(GLOBAL-N, np 100)과 043(Worldwide EN, np 150)으로 갈라져 있다.
// 실측(2026-09-06): 109 유닛의 file_seq 는 전부 유일하고, spec.fs 와 다른 것은
// 그 한 줄(ix 26 → file_seq 43)뿐이다. 즉 file_seq 가 보고서 u 의 정본이다.
type SpecRow = {
  brand: string; cc: string; langCode?: string; fs: number;
  urlLike?: string; urlNotLike?: string;
};

async function loadUnits(
  rt: GeneratorRuntime,
): Promise<{ byProject: Map<string, UnitRow[]>; units: number }> {
  const spec = JSON.parse(
    readFileSync("scripts/reports/report-spec.json", "utf8"),
  ) as SpecRow[];
  const values = sql.join(
    spec.map(
      (c, ix) => sql`(${ix}::int, ${c.brand}, ${c.cc}, ${c.langCode ?? null}::text,
                      ${c.urlLike ?? null}::text, ${c.urlNotLike ?? null}::text)`,
    ),
    sql`, `,
  );
  const specRows = await rt.rows<{
    pid: string; prompt_id: string; report_fs: number; unit_base: string; turl: string;
    turl_base: string; sibs: string[] | null; home_host: string | null;
  }>(sql`
    WITH spec(ix, brand, cc, lang_code, url_like, url_not_like) AS (VALUES ${values}),
    up AS (
      SELECT s.ix, wp.file_seq, ws.scope_project_id::uuid AS pid,
             wp.scope_prompt_id::uuid AS prompt_id, summary_report_norm(wp.target_url) AS turl,
             citation_url_base_norm(wp.target_url) AS turl_base,
             wp.owned_base_url
      FROM spec s
      JOIN website_sites ws ON ws.brand = s.brand AND ws.country_code = s.cc
      JOIN website_prompts wp ON wp.site_id = ws.id AND (s.lang_code IS NULL OR wp.lang_code = s.lang_code)
      WHERE wp.scope_prompt_id IS NOT NULL AND ws.scope_project_id IS NOT NULL
        AND (s.url_like     IS NULL OR summary_report_norm(wp.target_url) LIKE     s.url_like)
        AND (s.url_not_like IS NULL OR summary_report_norm(wp.target_url) NOT LIKE s.url_not_like)
    ),
    -- 폴백 BASE — 타겟 URL 의 최빈 host(hyundai/kia/genesis.com 만 host/1seg).
    -- 추출기는 동률에서 비결정적이라 문자열 tiebreak 를 박는다.
    heur AS (
      SELECT DISTINCT ON (ix) ix, k AS base FROM (
        SELECT ix,
               CASE WHEN split_part(turl, '/', 1) IN ('hyundai.com','kia.com','genesis.com')
                         AND split_part(turl, '/', 2) <> ''
                    THEN split_part(turl, '/', 1) || '/' || split_part(turl, '/', 2)
                    ELSE split_part(turl, '/', 1) END AS k,
               count(*) AS n
        FROM up GROUP BY 1, 2
      ) z ORDER BY ix, n DESC, k
    ),
    -- 자사 BASE — 유닛이 **선언한 값**(website_prompts.owned_base_url, 0049)을 우선(#215).
    decl AS (
      SELECT DISTINCT ON (ix) ix, owned_base_url AS base FROM (
        SELECT ix, owned_base_url, count(*) AS n FROM up
        WHERE owned_base_url IS NOT NULL AND owned_base_url <> '' GROUP BY 1, 2
      ) d ORDER BY ix, n DESC, owned_base_url
    ),
    b AS (SELECT h.ix, COALESCE(d.base, h.base) AS base FROM heur h LEFT JOIN decl d ON d.ix = h.ix),
    -- 형제 base — 같은 호스트의 **더 긴 선언 base**(다른 유닛 자산)는 자사에서 뺀다(#215).
    -- 모집단은 선언 목록 전량(사이트·프로젝트로 좁히지 않는다 — 추출기와 동일).
    sib AS (
      SELECT b.ix, array_agg(DISTINCT w.owned_base_url) AS sibs
      FROM b JOIN website_prompts w
        ON w.owned_base_url IS NOT NULL AND w.owned_base_url LIKE b.base || '/%'
      GROUP BY 1
    )
    SELECT up.pid::text AS pid, up.prompt_id::text AS prompt_id, up.file_seq::int AS report_fs,
           b.base AS unit_base, up.turl, up.turl_base,
           COALESCE(sib.sibs, '{}') AS sibs,
           -- 사이트 루트 홈 = 자사(#216). 공유 글로벌 호스트는 국가 유닛의 홈이 아니라 제외.
           CASE WHEN split_part(b.base, '/', 1) = ANY(${sql.param(sharedGlobalHosts())}::text[])
                THEN NULL ELSE split_part(b.base, '/', 1) END AS home_host
    FROM up JOIN b ON b.ix = up.ix LEFT JOIN sib ON sib.ix = up.ix
  `);
  const byProject = new Map<string, UnitRow[]>();
  const units = new Set<number>();
  for (const r of specRows) {
    units.add(Number(r.report_fs));
    const list = byProject.get(r.pid) ?? [];
    list.push({
      promptId: r.prompt_id, fs: Number(r.report_fs), base: r.unit_base, turl: r.turl,
      turlBase: r.turl_base, sibs: r.sibs ?? [], homeHost: r.home_host,
    });
    byProject.set(r.pid, list);
  }
  return { byProject, units: units.size };
}

/**
 * 보고서 유닛 **자사 판정** — 정본 엑셀(v2.5 인용 내역)의 자사=1 과 같은 술어.
 *
 * 대시보드 규칙 `scope-aggregates.ts::ownedBasePrefixClause` 를 **그대로 import** 해 쓴다.
 * base 목록만 그 유닛의 선언 base 하나로, 형제 모집단은 `[base, ...sibs]` 로 넘긴다
 * (그 함수의 longerSiblings 계산이 정확히 sibs 를 뽑아낸다). 따라서 아래가 전부 포함된다:
 *   · 접두 매칭 + **`.html` 동치** + 호스트 사전필터
 *   · 같은 호스트의 더 긴 선언 base(형제) 제외 (#215)
 *   · 사이트 루트 홈 = 자사, 공유 글로벌 호스트 제외 (#216)
 * 여기에 **타겟 ⊂ 자사**(#213) 를 OR 로 얹는다 — 대시보드의 websiteTargetOwnedClause 와 같은 자리.
 *
 * ⚠️ 판정 입력은 **base NORM(url_base_norm, 쿼리 제거)** 이다. tracked NORM(쿼리 보존)으로
 * 옮겨 적었다가 엑셀 대비 11 job·13건이 적게 잡혔다(2026-09-06): base 자체의 `.html` 변형
 * (`hyundai.com/no/no.html` 등)과 base 정확 일치인데 쿼리가 붙은 행(`hyundai.com/in/en?…`)이
 * 통째로 빠진다. 규칙을 옮겨 적지 말고 함수를 부를 것 — 이 두 분기가 그 함수 안에 있다.
 *
 * 프로젝트에 유닛이 여럿이면(제네시스 SA 3사이트) `report_fs` 로 분기한다.
 */
function unitOwnedSql(norm: SQL, alias: string, units: UnitRow[]): SQL {
  const byFs = new Map<number, UnitRow>();
  for (const u of units) if (!byFs.has(u.fs)) byFs.set(u.fs, u);
  if (byFs.size === 0) return sql`false`;
  const branches = [...byFs.values()].map((u) => {
    const owned = ownedBasePrefixClause(norm, [u.base], [u.base, ...u.sibs]);
    // 타겟 ⊂ 자사 — 타겟도 같은 base NORM 으로 비교한다(대시보드 ⑤ 경로와 동일).
    const target = sql`EXISTS (SELECT 1 FROM runit t WHERE t.report_fs = ${u.fs}::int
                        AND COALESCE(t.turl_base, '') <> '' AND t.turl_base = ${norm})`;
    return sql`WHEN ${u.fs}::int THEN (${owned} OR ${target})`;
  });
  return sql`(CASE ${sql.raw(alias)}.report_fs ${sql.join(branches, sql` `)} ELSE false END)`;
}

/** `runit(prompt_id, report_fs, unit_base, turl, sibs, home_host)` CTE — 한 프로젝트의 유닛 멤버십. */
function unitCte(list: UnitRow[]): SQL {
  if (list.length === 0) {
    return sql`runit AS (
      SELECT NULL::uuid AS prompt_id, NULL::int AS report_fs, NULL::text AS unit_base,
             NULL::text AS turl, NULL::text AS turl_base, NULL::text[] AS sibs, NULL::text AS home_host
      WHERE false
    )`;
  }
  return sql`runit AS (
    SELECT * FROM (VALUES ${sql.join(
      list.map(
        (r) => sql`(${r.promptId}::uuid, ${r.fs}::int, ${r.base}::text, ${r.turl}::text,
                    ${r.turlBase}::text, ${sql.param(r.sibs)}::text[], ${r.homeHost}::text)`,
      ),
      sql`, `,
    )}) AS v(prompt_id, report_fs, unit_base, turl, turl_base, sibs, home_host)
  )`;
}

// ── 셀 유일화 정본 ───────────────────────────────────────────────────────────
/**
 * 셀(job) 유일화 SELECT — **두 경로가 반드시 같은 SQL 을 쓰도록** 한 곳에 둔다.
 *   · dry-run: 'inlineJobsCte' 의 'cells'
 *   · 실행:    'summary_cycle_jobs' INSERT 의 서브쿼리
 * 2026-09-10 수리 전에는 두 곳에 복붙돼 있었고, 그 중 **INSERT 쪽만** 결함이 있어
 * 테스트가 dry-run 만 보다가 놓칠 뻔했다. 게다가 사이트 조인 조건도 비대칭이었다
 * (INSERT 는 'AND ws.scope_project_id = <pid>' 가 있고 dry-run 은 없었다) — 사이트의
 * 소속 프로젝트가 run 의 프로젝트와 다른 답변이 생기면 두 경로가 다른 셀을 고른다.
 * 실측으로는 답변 431,619건 전수 0건이지만 **데이터 의존 불변식**이라 코드로 맞춘다.
 *
 * 유일화 열은 'summary_cycle_jobs' 유니크 키와 같아야 한다
 * ('cycle_week, cycle_id, generation_id, prompt_id, engine, country'). 회차 단위 문장이라
 * 앞의 셋은 상수이므로 셀 축은 '(prompt_id, target→engine, country)' 다.
 * 'country' 는 'region' 이 아니라 사이트 'country_code' 에서 오므로(폴백이 region),
 * **서브쿼리 안에서 먼저 확정**한 뒤 그 값으로 유일화한다 — 밖에서 접으면 그레인이
 * 유니크 키보다 넓어져 23505 가 난다.
 */
const CELL_KEY = "a.prompt_id, a.target, k.country";

function cellSelectSql(args: {
  /** SELECT 목록(유일화 열 + 경로별로 필요한 컬럼). */
  select: SQL;
  /** 'scope_answers a' 뒤에 붙는 조인(예: 'JOIN mem ON …'). */
  extraFrom?: SQL;
  /** 'website_sites ws' 조인에 붙는 소속 프로젝트 한정 — 두 경로가 같아야 한다. */
  siteScope: SQL;
  /** WHERE 절. */
  where: SQL;
}): SQL {
  return sql`
      SELECT DISTINCT ON (${sql.raw(CELL_KEY)}) ${args.select}
      FROM scope_answers a${args.extraFrom ?? sql``}
      LEFT JOIN website_prompts wp ON wp.scope_prompt_id::uuid = a.prompt_id
      LEFT JOIN website_sites ws ON ws.id = wp.site_id${args.siteScope}
      CROSS JOIN LATERAL (SELECT COALESCE(ws.country_code, a.region) AS country) k
      WHERE ${args.where}
      -- 같은 셀이 여러 번 측정됐으면 **최신**을 남긴다(종전 규칙).
      -- 'a.job_id' 는 결정성 tiebreaker — measured_at 이 같아도 매 실행 같은 셀을 고른다.
      ORDER BY ${sql.raw(CELL_KEY)}, a.measured_at DESC, a.job_id`;
}

// ── 셀(job) 집합 — §3-1: 회차 run 의 completed 답변에서 셀당 최신 1건 ─────────
/** 미러에서 직접 계산하는 셀 집합(dry-run 전용 — 실행 경로는 summary_cycle_jobs 를 읽는다). */
function inlineJobsCte(spec: WebsiteCycleSpec, projectIds: string[] | null): SQL {
  const win = spec.window;
  if (!win) throw new Error("inlineJobsCte 는 멤버십 창이 있는 회차에서만 쓴다");
  const projScope = projectIds
    ? sql`r.project_id = ANY(${sql.param(projectIds)}::uuid[])`
    : sql`r.project_id IN (SELECT DISTINCT scope_project_id::uuid FROM website_sites WHERE scope_project_id IS NOT NULL)`;
  return sql`
    mem AS (
      SELECT r.run_id, r.project_id, r.status
      FROM scope_runs r
      WHERE r.started_at >= ${win.from}::timestamptz AND r.started_at < ${win.to}::timestamptz
        AND ${projScope}
    ),
    cells AS (${cellSelectSql({
      select: sql`a.job_id, a.run_id, a.prompt_id, a.target, a.region, k.country, a.measured_at`,
      extraFrom: sql` JOIN mem ON mem.run_id = a.run_id`,
      // INSERT 경로의 'ws.scope_project_id = <pid>' 와 같은 한정 — 여기서는 run 의 프로젝트다.
      siteScope: sql` AND ws.scope_project_id::uuid = mem.project_id`,
      where: sql`a.status = 'completed'`,
    })}),
    jb AS (
      SELECT c.job_id, c.run_id, c.prompt_id, c.target AS engine,
             c.country, c.measured_at,
             COALESCE(ws.scope_project_id::uuid, mem.project_id) AS project_id
      FROM cells c
      JOIN mem ON mem.run_id = c.run_id
      LEFT JOIN website_prompts wp ON wp.scope_prompt_id::uuid = c.prompt_id
      LEFT JOIN website_sites ws ON ws.id = wp.site_id
    )`;
}

/** 실행 경로 — 굳혀 둔 summary_cycle_jobs 를 읽는다(§7-3: 표 간 모수 동일성). */
function storedJobsCte(keys: GenerationKeys): SQL {
  return sql`
    jb AS (
      SELECT j.job_id, j.run_id, j.prompt_id, j.engine, j.country, j.measured_at,
             ${sql.raw("NULL::uuid")} AS project_id
      FROM summary_cycle_jobs j
      WHERE j.cycle_week = ${keys.cycleWeek}::date AND j.cycle_id = ${keys.cycleId}::uuid
        AND j.generation_id = ${keys.generationId}::uuid
    )`;
}

/** 사실표 3종이 공유하는 공통 차원(§3-2) — jb 를 전제로 한다. */
function dimsCte(projectId: string, units: UnitRow[]): SQL {
  return sql`
    ${unitCte(units)},
    cat AS (
      SELECT p.scope_prompt_id AS pid,
             COALESCE(array_agg(DISTINCT p.brand) FILTER (WHERE p.brand IS NOT NULL), '{}') AS catalog_brands,
             (array_agg(p.funnel_stage   ORDER BY p.updated_at DESC))[1] AS funnel_catalog,
             -- 원값 1행(감사·대조용) + 조회가 쓰는 유도 집합(0063). 웹사이트 프롬프트는
             -- 'prompts' 매칭이 0건이라 항상 '{}' 지만(2026-09-06 실측: 12,685 중 matched 0),
             -- 규칙은 글로벌과 한 벌로 둔다 — 매칭이 생기는 날 조용히 갈리지 않게.
             (array_agg(p.brand_presence ORDER BY p.updated_at DESC))[1] AS brand_presence_resolved,
             ${presenceSetExpr(sql`p.brand`, sql`p.brand_presence`)} AS presence_set,
             (array_agg(p.list_type      ORDER BY p.updated_at DESC))[1] AS list_type,
             (array_agg(p.depth1         ORDER BY p.updated_at DESC))[1] AS depth1,
             (array_agg(p.depth2         ORDER BY p.updated_at DESC))[1] AS depth2,
             (array_agg(p.depth3         ORDER BY p.updated_at DESC))[1] AS depth3,
             (array_agg(p.id             ORDER BY p.updated_at DESC))[1] AS catalog_row_id,
             (array_agg(p.status::text   ORDER BY p.updated_at DESC))[1] AS catalog_status
      FROM prompts p
      WHERE p.deleted_at IS NULL AND p.scope_prompt_id IS NOT NULL
      GROUP BY 1
    ),
    root AS (
      SELECT DISTINCT scope_prompt_id AS pid FROM prompts
      WHERE project_id = ${STANDARD_ROOT_PROJECT_ID}::uuid AND scope_prompt_id IS NOT NULL
    ),
    d AS (
      SELECT jb.job_id, jb.prompt_id, jb.engine, jb.country, jb.measured_at,
             ${projectId}::uuid AS project_id,
             -- 사이트 없는 프롬프트: lang 은 scope_prompts.lang(대문자)을 소문자로 접어 쓴다
             -- (website 표면의 lang 원천이 소문자 lang_code 이므로 축을 맞춘다).
             COALESCE(wp.lang_code, lower(sp.lang)) AS lang,
             (CASE WHEN wp.id IS NOT NULL THEN 1 ELSE 0 END) AS site_present,
             COALESCE(cat.catalog_brands, '{}') AS catalog_brands,
             cat.funnel_catalog, sp.funnel_stage AS funnel_scope,
             cat.brand_presence_resolved, COALESCE(cat.presence_set, '{}') AS presence_set,
             cat.list_type, cat.depth1, cat.depth2, cat.depth3,
             (CASE WHEN root.pid IS NOT NULL THEN 1 ELSE 0 END) AS in_root_catalog,
             1 AS in_tagged_region, 1 AS in_full_cycle,
             r.status AS run_status,
             runit.report_fs, runit.unit_base, runit.turl
      FROM jb
      LEFT JOIN runit ON runit.prompt_id = jb.prompt_id
      LEFT JOIN website_prompts wp ON wp.scope_prompt_id::uuid = jb.prompt_id
      JOIN scope_runs r ON r.run_id = jb.run_id
      LEFT JOIN scope_prompts sp ON sp.prompt_id = jb.prompt_id
      LEFT JOIN cat  ON cat.pid  = jb.prompt_id
      LEFT JOIN root ON root.pid = jb.prompt_id
    )`;
}

/** ⑥ 타겟 집합 — 전 사이트의 target_url 정규화 + 'project|lang|country' 키(§3-5). */
const TARGETS_CTE = sql`
  targets AS (
    SELECT DISTINCT ${citationTrackedNormSql(sql`wp.target_url`)} AS turl,
           ws.scope_project_id || '|' || wp.lang_code || '|' || ws.country_code AS key
    FROM website_prompts wp JOIN website_sites ws ON ws.id = wp.site_id
    WHERE wp.target_url <> '' AND ws.scope_project_id IS NOT NULL
  )`;

const citations = (ctx: Ctx) => citationCtes({ bases: ctx.basePrefixes, tracked: true });

// ── 컨텍스트 ────────────────────────────────────────────────────────────────
export async function loadCtx(rt: GeneratorRuntime): Promise<Ctx> {
  const roster = await rt.rows<{ entity_id: string; name: string }>(OWN_ROSTER_SQL);
  const ownEntities: RosterEntity[] = roster.map((r) => ({ id: r.entity_id, name: r.name }));
  const baseRows = await rt.rows<{ base: string }>(
    sql`SELECT DISTINCT owned_base_url AS base FROM website_prompts
        WHERE owned_base_url IS NOT NULL AND owned_base_url <> ''`,
  );
  const basePrefixes = [
    ...new Set(baseRows.map((r) => ownedBasePrefixFromUrl(r.base)).filter(Boolean)),
  ];
  const { byProject, units } = await loadUnits(rt);
  const urlHits = await loadUrlHitsUnits(rt);
  return {
    filters: { ownEntities },
    roster: ownEntities,
    basePrefixes,
    unitsByProject: byProject,
    unitCount: units,
    ownedUnits: urlHits.units,
    urlHitsSkip: urlHits.skip,
  };
}

/**
 * 0081 단계(8b)의 입력: **비치명**. 0081 이 없으면 아예 읽지 않고, 읽다 실패해도 던지지
 * 않는다: 이 단계가 세부층·집계층 생성을 막으면 안 된다(검증 2026-09-27 지적 2).
 */
async function loadUrlHitsUnits(
  rt: GeneratorRuntime,
): Promise<{ units: WebsiteOwnedUnit[] | null; skip?: string }> {
  try {
    if (!(await columnAvailable("summary_url_hit_generations", "jobs"))) {
      return { units: null, skip: "0081-missing" };
    }
    // 판정 빌더가 정규화 컬럼(0052) 유무를 **동기**로 본다: 먼저 확정해 둔다.
    await ensureColumnAvailability();
    return { units: await websiteOwnedUnits() };
  } catch (e) {
    rt.log(`  ↳ URL 인용률 유닛 적재 실패(비치명: 이번 실행의 8b 는 건너뛴다): ${String(e).slice(0, 300)}`);
    return { units: null, skip: `units-load-failed: ${String(e).slice(0, 200)}` };
  }
}

/**
 * `own_variant` 목록 — `ALL` + 명부 브랜드 각각(글로벌과 같은 유도, PR② T3).
 *
 * ⑤ 스코프는 **좁히지 않는다**(`scopeNarrowing: "none"`). 웹사이트의 base universe 는
 * 카탈로그가 아니라 사이트 **선언**(`website_prompts.owned_base_url`)이고, 오늘 리더는 그것을
 * (프로젝트, 언어, 사이트 국가)로 좁히는데(`websiteDeclaredOwnedBases`, SA:5242-5283)
 * **프로젝트 축이 `OwnCitationScope` 에 없다** — 반쪽만 좁히면 어느 화면과도 안 맞는다.
 * 굳힌 값 = 선언 전량 기준(= 오늘의 계정 무필터). T4/T11 인계 사항.
 * 세부층 `lang` 은 소문자(`wp.lang_code`)라 스코프 행도 소문자다.
 */
export function ownVariants(ctx: Ctx): OwnVariant[] {
  return tenantOwnVariants({
    roster: ctx.roster,
    basePrefixes: ctx.basePrefixes,
    scopeNarrowing: "none",
    langCase: "lower",
  });
}

export type WebsiteProject = { project_id: string; runs: string[] };

/** 멤버십 창 안의 웹사이트 프로젝트와 그 run 목록(레거시 경로). */
export async function listProjects(
  rt: GeneratorRuntime,
  spec: WebsiteCycleSpec,
  opts: { limit?: number; onlyProject?: string } = {},
): Promise<WebsiteProject[]> {
  const win = spec.window;
  if (!win) throw new Error("listProjects 는 멤버십 창이 있는 회차에서만 쓴다");
  const r = await rt.rows<WebsiteProject>(sql`
    SELECT r.project_id::text AS project_id, array_agg(r.run_id::text ORDER BY r.started_at) AS runs
    FROM scope_runs r
    WHERE r.started_at >= ${win.from}::timestamptz AND r.started_at < ${win.to}::timestamptz
      AND r.project_id IN (SELECT DISTINCT scope_project_id::uuid FROM website_sites WHERE scope_project_id IS NOT NULL)
      AND r.project_id NOT IN (
        SELECT DISTINCT scope_project_id::uuid FROM website_sites
        WHERE scope_project_id IS NOT NULL AND country_code = ANY(${sql.param(EXCLUDED_SITE_COUNTRY_CODES)}::text[])
      )
    GROUP BY 1 ORDER BY 1
  `);
  const filtered = opts.onlyProject ? r.filter((x) => x.project_id === opts.onlyProject) : r;
  return opts.limit && opts.limit > 0 ? filtered.slice(0, opts.limit) : filtered;
}

// ── DRY-RUN ─────────────────────────────────────────────────────────────────
export async function dryRun(
  rt: GeneratorRuntime,
  ctx: Ctx,
  spec: WebsiteCycleSpec,
  projects: { project_id: string }[],
) {
  const ids = projects.map((p) => p.project_id);
  const J = inlineJobsCte(spec, ids);
  const b = brandExprs(ctx.filters);

  const cells = await rt.rows<Record<string, unknown>>(sql`
    WITH ${J},
    all_ans AS (SELECT a.* FROM scope_answers a JOIN mem ON mem.run_id = a.run_id)
    SELECT (SELECT count(*) FROM jb)::int AS jobs,
           (SELECT count(*) FROM cells)::int AS cells_all,
           (SELECT count(*) FROM cells c WHERE NOT EXISTS (
              SELECT 1 FROM website_prompts wp WHERE wp.scope_prompt_id::uuid = c.prompt_id))::int AS cells_orphan,
           (SELECT count(DISTINCT (prompt_id, target, region)) FROM all_ans)::int AS expected_units,
           (SELECT count(*) FROM all_ans)::int AS answers_raw
  `);
  rt.log("셀:", cells[0]);

  const counts = await rt.rows<Record<string, unknown>>(sql`
    WITH names AS ${ROLLUP_NAMES}, ${J},
    mrows AS (
      SELECT m.job_id, ${b.rollup} AS brand_id, ${b.brandName} AS brand_name, (${b.isCompetitor}) AS pass,
             m.mention_count
      FROM scope_mentions m JOIN jb ON jb.job_id = m.job_id
      LEFT JOIN names n ON n.entity_id = ${b.rollup}
      WHERE m.brand_rollup_entity_id IS NOT NULL AND ${b.rawName} IS NOT NULL
    ),
    bgrp AS (
      SELECT job_id, brand_id, brand_name, bool_or(pass) AS anyp, bool_and(pass) AS allp,
             sum(mention_count)::int AS mentions,
             sum(mention_count) FILTER (WHERE pass)::int AS mentions_pass
      FROM mrows GROUP BY 1,2,3
    )
    SELECT (SELECT count(*) FROM bgrp)::int AS brand_rows,
           (SELECT count(*) FROM bgrp WHERE anyp <> allp)::int AS brand_rows_mixed,
           (SELECT COALESCE(sum(mentions),0) FROM bgrp WHERE anyp)::int AS brand_mentions_competitor,
           (SELECT COALESCE(sum(mentions_pass),0) FROM bgrp)::int AS brand_mentions_pass,
           (SELECT count(DISTINCT job_id) FROM bgrp)::int AS jobs_with_brand
  `);
  rt.log("브랜드 표:", counts[0]);

  const cit = await rt.rows<Record<string, unknown>>(sql`
    WITH ${J}, ${TARGETS_CTE}, ${citations(ctx)},
    dg AS (
      SELECT c2.job_id, c2.gk, COALESCE(ub.matched_base, '') AS mb
      FROM c2 JOIN ub ON ub.uk = c2.uk GROUP BY 1,2,3
    ),
    tg AS (
      SELECT c2.job_id, COALESCE(ub.matched_base_tracked, '') AS mbt
      FROM c2 JOIN ub ON ub.uk = c2.uk GROUP BY 1,2
    )
    SELECT (SELECT count(*) FROM c2)::int AS citations_raw,
           (SELECT count(*) FROM dg)::int AS domain_rows,
           (SELECT count(*) FROM tg)::int AS target_rows,
           (SELECT count(*) FROM ub WHERE matched_base IS NOT NULL)::int AS urls_owned_base,
           (SELECT count(*) FROM ub WHERE matched_base_tracked IS NOT NULL)::int AS urls_owned_tracked,
           (SELECT count(*) FROM un WHERE base IS NULL)::int AS urls_base_null,
           (SELECT count(*) FROM un JOIN targets t ON t.turl = un.trk)::int AS urls_target_hit
  `);
  rt.log("인용 표:", cit[0]);

  const dim = await rt.rows<Record<string, unknown>>(sql`
    SELECT count(*)::int AS dim_rows
    FROM website_prompts wp JOIN website_sites ws ON ws.id = wp.site_id
    WHERE ws.scope_project_id = ANY(${sql.param(ids)}::text[]) AND wp.scope_prompt_id IS NOT NULL
  `);
  rt.log("dim:", dim[0]);

  const gap = await rt.rows<Record<string, unknown>>(sql`
    WITH ${J}
    SELECT count(*)::int AS jobs,
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM scope_mentions m WHERE m.job_id = jb.job_id)
                         AND NOT EXISTS (SELECT 1 FROM scope_citations c WHERE c.job_id = jb.job_id))::int AS gap_jobs
    FROM jb
  `);
  rt.log("분석 갭:", gap[0]);
  return {
    jobs: n(cells[0]?.jobs),
    expected_units: n(cells[0]?.expected_units),
    brand_rows: n(counts[0]?.brand_rows),
    domain_rows: n(cit[0]?.domain_rows),
    target_rows: n(cit[0]?.target_rows),
    dim_rows: n(dim[0]?.dim_rows),
    gap_jobs: n(gap[0]?.gap_jobs),
  };
}

// ── 자사·타겟 URL 인용률 사실표 (0081) ─────────────────────────────────────
/**
 * `summary_url_hits` + 원장 한 문장. 생성(8b 단계)과 백필(`generate-cycle --url-hits`)이
 * **같은 문장**을 쓴다: 백필이 다른 판정을 내면 새 generation 과 옛 generation 의 값이 갈린다.
 * 입력 job = 그 generation 에 굳힌 `summary_cycle_jobs`(표 간 모수 동일성, §7-3).
 */
export function urlHitsInsertSql(
  units: readonly WebsiteOwnedUnit[],
  keys: GenerationKeys,
  pid: string,
  version: string,
): SQL {
  return insertUrlHitsSql({
    keys,
    version,
    flags: websitePromptUrlHitJobFlagsSql({
      jobs: sql`SELECT j.job_id, j.prompt_id FROM summary_cycle_jobs j
        WHERE j.cycle_week = ${keys.cycleWeek}::date AND j.cycle_id = ${keys.cycleId}::uuid
          AND j.generation_id = ${keys.generationId}::uuid`,
      projectIds: [pid],
      units,
    }),
  });
}

// ── 적재 ────────────────────────────────────────────────────────────────────
export type ProjectResult = {
  pid: string;
  ok: boolean;
  reason?: string;
  counts: unknown;
  cycleId: string;
  generationId: string;
};

export async function generateProject(
  rt: GeneratorRuntime,
  ctx: Ctx,
  spec: WebsiteCycleSpec,
  p: WebsiteProject,
  opts: { cycleId?: string } = {},
): Promise<ProjectResult> {
  const pid = p.project_id;

  // 1) 회차 원장 (§2-6). UNIQUE(project_id, cycle_anchor_at) → 재실행은 재사용.
  const cycleId =
    opts.cycleId ??
    (
      await rt.rows<{ cycle_id: string }>(
        upsertCycleSql({
          surface: SURFACE,
          projectId: pid,
          cycleAnchorAt: spec.cycleAnchorAt,
          cycleWeek: spec.cycleWeek,
          version: rt.version,
        }),
      )
    )[0].cycle_id;

  // 2) generation (loading) — 판정 입력 스냅샷을 함께 굳힌다(§7-8).
  const gen = await rt.rows<{ generation_id: string }>(
    insertGenerationSql({
      cycleId,
      version: rt.version,
      rosterSnapshot: rosterSnapshot(ctx.roster),
      baseUniverse: { matching_universe: ctx.basePrefixes },
      targetUniverse: {
        source: "website_prompts.target_url (전 사이트) + project|lang|country key",
      },
      noiseSnapshot: noiseSnapshot(),
    }),
  );
  const genId = gen[0].generation_id;
  const keys: GenerationKeys = { cycleWeek: spec.cycleWeek, cycleId, generationId: genId };

  // 앵커 테이블 전파(B2) 가능 여부 — 프로브는 트랜잭션 **밖에서** 확정한다
  // (column-availability 계약 ①). 0077 미적용이면 false 라 문장이 아예 안 나간다.
  const anchorsWritable = await answerCycleAnchorsWritable();
  // 0081(자사·타겟 URL 인용률 사실표) 단계를 돌리는가: 표가 있고 유닛 적재가 성공했을 때만.
  // 판정은 `loadCtx` 가 이미 했다(비치명: 어떤 경우에도 여기서 던지지 않는다).
  const urlUnits = ctx.ownedUnits;
  const urlHitsReady = urlUnits !== null;
  if (!urlHitsReady && ctx.urlHitsSkip && ctx.urlHitsSkip !== "0081-missing") {
    rt.timings.url_hits_failed = 1;
  }

  try {
    // 3) tx1 — REPEATABLE READ 스냅샷 안에서 멤버십 + 셀 집합 + synced_at 지문(§7-3)
    await rt.time("cycle_jobs", () =>
      rt.db.transaction(
        async (tx) => {
          await tx.execute(upsertCycleRunsSql(cycleId, p.runs));
          // 원장 → 앵커 테이블 전파(스펙 §4 · B2) — surface-global.ts 의 같은 자리와 동일.
          // `upsertCycleRunsSql` 은 재귀속(ON CONFLICT DO UPDATE SET cycle_id) 경로다.
          if (anchorsWritable) {
            const stmt = refreshAnchorsForRunsSql(p.runs, ANCHOR_ROOT_PROJECT_ID);
            if (stmt) await tx.execute(stmt);
          }
          await tx.execute(sql`
          INSERT INTO summary_cycle_jobs
            (cycle_week, cycle_id, generation_id, job_id, run_id, prompt_id, engine, country, measured_at)
          -- LEFT JOIN: website_prompts 에 행이 없는 프롬프트의 답변도 회차에 **포함**한다
          -- (제품 결정 2026-09-06). 사이트가 없으면 country 는 scope_answers.region 폴백 —
          -- 이렇게 해야 expected_units(관측 셀) 와 cycle_jobs 가 일치한다.
          --
          -- ⚠️ 셀 유일화(DISTINCT ON)는 **이 표의 유니크 키와 같은 열**이어야 한다:
          --    (cycle_week, cycle_id, generation_id, prompt_id, engine, country).
          --    2026-09-10 수리 전에는 region 으로 유일화하고 country 는 **서브쿼리 밖에서**
          --    사이트 country_code 로 접었다 — region 이 country 보다 잘게 갈리므로 같은 셀이
          --    둘 남아 23505(duplicate key)로 죽었다. 그래서 사이트 조인을 서브쿼리 **안으로**
          --    올리고 country 를 먼저 확정한 뒤 그 값으로 유일화한다.
          --    실측(웹사이트 767 회차 전수): 영향 회차는 8/10 주 2개뿐이고 둘 다 미발행이다
          --    (345→200 · 278→176). 발행분 616 회차는 중복 0 → 패리티 영향 0.
          --    원인은 그 주에 측정 프록시가 CZ→US 로 바뀐 것이다(사이트 country_code 는 CZ 하나,
          --    그 프로젝트의 다른 회차는 전부 단일 region). 즉 region 은 분석 축이 아니라
          --    측정 위치이고 같은 셀의 재측정이다 — 유니크 키에 region 을 넣는 안은 그래서
          --    기각했다(그 주만 셀이 2배가 되어 전 표에서 이중 계상된다).
          SELECT ${spec.cycleWeek}::date, ${cycleId}::uuid, ${genId}::uuid,
                 c.job_id, c.run_id, c.prompt_id, c.target,
                 c.country, c.measured_at
          FROM (${cellSelectSql({
            select: sql`a.job_id, a.run_id, a.prompt_id, a.target, k.country, a.measured_at`,
            siteScope: sql` AND ws.scope_project_id = ${pid}`,
            where: sql`a.run_id = ANY(${sql.param(p.runs)}::uuid[]) AND a.status = 'completed'`,
          })}) c
        `);
        },
        { isolationLevel: "repeatable read" },
      ),
    );

    const J = storedJobsCte(keys);
    const units = ctx.unitsByProject.get(pid) ?? [];
    const D = dimsCte(pid, units);
    const b = brandExprs(ctx.filters);
    const cit = citations(ctx);

    // 4) 회차 카운터 (§2-1: expected 는 사전 산식이 아니라 관측값)
    await rt.exec(
      updateCycleCountersFromWindowSql({ cycleId, version: rt.version, jobsCte: J, runIds: p.runs }),
    );

    // 4b) 단언 — 굳힌 셀 수가 관측 완료 셀 수와 같은가(사이트 없는 프롬프트 포함 후 성립).
    //
    // ⚠️ 기대값은 **셀 선택과 같은 그레인**으로 세야 한다(2026-09-10 수리).
    //    원장 카운터(`cycleCountersCte` 의 `completed_units`)는 **region 그레인**이라
    //    프록시 전환 회차에서 `cycle_jobs`(country 그레인)와 필연적으로 어긋난다 —
    //    실측 345 vs 200 · 278 vs 176. 그건 "답변을 흘린" 것이 아니라 **같은 셀의 재측정을
    //    접은 것**이므로, 그 차이로 생성을 막으면 안 된다.
    //    가드의 의도(셀 선택이 답변을 진짜로 흘렸는가)는 그대로다 — 같은 답변 집합을
    //    같은 DISTINCT 열 `(prompt_id, target, country)` 로 센 값과 비교한다.
    //    접힘 수(region 그레인 − country 그레인)는 버리지 않고 로그·timings 에 남긴다.
    //    ⓘ 후속: 원장 카운터 자체를 country 그레인으로 옮기는 것은 관제 코드·앱 배포 범위라
    //       여기서 안 건드린다. 그때까지 콘솔의 `completed_units` 는 전환 회차에서
    //       `cycle_jobs` 보다 크게 보인다(결함 아님).
    const asrt = await rt.rows<{
      jobs: number; expected: number; completed: number; completed_cells: number;
    }>(sql`
      WITH ${J},
      all_ans AS (
        SELECT a.*, COALESCE(ws.country_code, a.region) AS cell_country
        FROM scope_answers a
        LEFT JOIN website_prompts wp ON wp.scope_prompt_id::uuid = a.prompt_id
        LEFT JOIN website_sites ws ON ws.id = wp.site_id AND ws.scope_project_id = ${pid}
        WHERE a.run_id = ANY(${sql.param(p.runs)}::uuid[])
      )
      SELECT (SELECT count(*) FROM jb)::int AS jobs,
             (SELECT count(DISTINCT (prompt_id, target, region)) FROM all_ans)::int AS expected,
             (SELECT count(DISTINCT (prompt_id, target, region)) FROM all_ans WHERE status = 'completed')::int AS completed,
             (SELECT count(DISTINCT (prompt_id, target, cell_country)) FROM all_ans WHERE status = 'completed')::int AS completed_cells
    `);
    const a0 = asrt[0];
    // region→country 로 접힌 수. 0 이 정상이고, 프록시가 바뀐 주에만 > 0 이다.
    const collapsed = n(a0?.completed) - n(a0?.completed_cells);
    if (collapsed > 0) {
      rt.timings.cells_region_collapsed = collapsed;
      rt.log(
        `셀 접힘 ${collapsed}건 — 같은 (prompt, engine, country) 를 서로 다른 region 으로 ` +
          `재측정한 답변을 최신 하나로 접었다(region 그레인 ${a0?.completed} → country ${a0?.completed_cells}). ` +
          `원장 completed_units 는 region 그레인이라 이 회차에서 더 크게 보인다.`,
      );
    }
    if (n(a0?.jobs) !== n(a0?.completed_cells)) {
      throw new Error(
        `[${pid}] cycle_jobs(${a0?.jobs}) ≠ 완료 셀(${a0?.completed_cells}, ` +
          `(prompt,engine,country) 그레인) — 셀 선택이 답변을 흘렸다` +
          (collapsed > 0 ? ` [참고: region 그레인 ${a0?.completed}, 접힘 ${collapsed}]` : ""),
      );
    }

    // 5) summary_answers (§6-4 ①의 분모 monitored, 미언급 프롬프트 has_any_brand)
    await rt.time("answers", () =>
      rt.exec(
        insertAnswersSql({
          keys,
          rollupNames: ROLLUP_NAMES,
          withCtes: sql`${J}, ${D}`,
          brand: b,
          extras: {
            ctes: sql`,
      -- 보고서 NORM(= citation_url_norm, 0060). url_norm 이 채워져 있으면 그것을 쓴다.
      cn AS MATERIALIZED (
        SELECT c.job_id,
               COALESCE(c.url_norm, summary_report_norm(c.url)) AS n,          -- ⑥ 타겟(쿼리 보존)
               COALESCE(c.url_base_norm, citation_url_base_norm(c.url)) AS nb  -- ⑤ 자사(쿼리 제거)
        FROM scope_citations c JOIN jb ON jb.job_id = c.job_id
      ),
      uo AS (  -- 유닛 자사 인용을 가진 job (추출기 oa) — 판정은 unitOwnedSql 한 벌
        SELECT DISTINCT cn.job_id FROM cn
        JOIN jb ON jb.job_id = cn.job_id JOIN runit ON runit.prompt_id = jb.prompt_id
        WHERE runit.unit_base IS NOT NULL AND ${unitOwnedSql(sql`cn.nb`, "runit", units)}
      ),
      -- 유닛 타겟 URL 인용을 가진 job. **flat** 이다 — 자기 프롬프트의 타겟이 아니라
      -- 그 유닛 전체의 타겟 집합과 맞춘다(오늘 websiteTargetSetSelect 와 같은 의미론).
      -- 실측 근거(2026-09-06, Kia/AU u=073): 보고서 c6 = [117, 120] 인데 자기 프롬프트
      -- 한정이면 96, 프롬프트 단위 bool_or 면 108, **flat 이면 117** 로 정확히 맞는다.
      ut AS (
        SELECT DISTINCT cn.job_id FROM cn
        JOIN jb ON jb.job_id = cn.job_id
        JOIN runit r1 ON r1.prompt_id = jb.prompt_id
        JOIN runit r2 ON r2.report_fs = r1.report_fs
                     AND COALESCE(r2.turl, '') <> '' AND r2.turl = cn.n
      )`,
            columns: ",\n         report_fs, unit_owned, unit_target",
            select: sql`,
             d.report_fs,
             CASE WHEN uo.job_id IS NOT NULL THEN 1 ELSE 0 END,
             CASE WHEN ut.job_id IS NOT NULL THEN 1 ELSE 0 END`,
            joins: sql`
             LEFT JOIN uo ON uo.job_id = d.job_id
             LEFT JOIN ut ON ut.job_id = d.job_id`,
          },
        }),
      ),
    );

    // 6) summary_brand_mentions (§3-4: 키는 (job, brand_id, brand_name))
    await rt.time("brand_mentions", () =>
      rt.exec(
        insertBrandMentionsSql({ keys, rollupNames: ROLLUP_NAMES, withCtes: sql`${J}, ${D}`, brand: b }),
      ),
    );

    // 7) summary_domain_citations (§3-5: (job, group_key, matched_base))
    await rt.time("domain_citations", () =>
      rt.exec(
        insertDomainCitationsSql({
          keys,
          withCtes: sql`${J}, ${D}, ${cit}`,
          extras: {
            dgSelect: sql`,
               -- 보고서 유닛 자사 인용 수(§0060, 추출기 oc). ub.trk = tracked NORM = 보고서 NORM.
               count(*) FILTER (
                 WHERE unb.unit_base IS NOT NULL AND ${unitOwnedSql(sql`ub.base`, "unb", units)}
               )::int AS unit_owned_citations`,
            dgFrom: sql`
        JOIN jb ON jb.job_id = c2.job_id
        LEFT JOIN runit unb ON unb.prompt_id = jb.prompt_id`,
            // 0067 ① — `report_fs` 를 여기서 굳힌다. `d` 가 이미 `runit.report_fs` 를
            // 갖고 있어(위 `d AS (…)`) 추가 조인이 없다. 이게 없으면 2단 enrich 가
            // `summary_answers` job 세미조인을 남긴다(T7 실측 148.9 ms > 기준 130).
            columns: ", unit_owned_citations, report_fs",
            select: sql`,
             dg.unit_owned_citations,
             d.report_fs`,
          },
        }),
      ),
    );

    // 8) summary_target_hits (⑥ 전용, §3-5 v4.1 #4)
    await rt.time("target_hits", () =>
      rt.exec(insertTargetHitsSql({ keys, withCtes: sql`${J}, ${D}, ${TARGETS_CTE}, ${cit}` })),
    );

    // 8b) summary_url_hits (0081 · 자사·타겟 URL 인용률 GGMD-61): job 단위 판정 플래그.
    // 0081 미적용 DB 에서는 **조용히 건너뛴다**(0065 접기와 같은 자세: 코드가 마이그레이션
    // 보다 먼저 배포될 수 있다). 건너뛴 generation 은 원장 행이 없으므로 리더가 미러로 간다.
    // 판정 스코프(`projectIds`)는 이 프로젝트 하나다: 미러 쌍둥이의 `wp` 가 화면 스코프의
    // 사이트로 좁히는 자리이고, 한 사이트 = 한 프로젝트라 프로젝트 단위 생성과 같은 모수다.
    // ⚠️ **비치명**이다. 이 표가 실패해도 세부층·집계층 생성은 계속한다: 원장 행이 없으면
    //    리더가 미러로 가므로 값은 종전 그대로다. 한 문장(데이터 변경 CTE)이라 실패 시 남는 행도 없다.
    if (urlUnits) {
      await rt.time("url_hits", () =>
        rt.heavy(urlHitsInsertSql(urlUnits, keys, pid, rt.version)).catch((e: unknown) => {
          rt.timings.url_hits_failed = 1;
          rt.log(`  ↳ summary_url_hits 적재 실패(비치명: 이 generation 은 미러 경로): ${String(e).slice(0, 300)}`);
        }),
      );
    }

    // 9) summary_prompt_dim (§3-6: 측정 여부 무관 — 미측정 = dim 에 있고 jobs 에 없음)
    await rt.time("prompt_dim", () =>
      rt.exec(sql`
      WITH ${J}, ${unitCte(units)},
      wc AS (SELECT prompt_id, count(*)::int AS window_cells FROM jb GROUP BY 1),
      cat AS (
        SELECT p.scope_prompt_id AS pid,
               COALESCE(array_agg(DISTINCT p.brand) FILTER (WHERE p.brand IS NOT NULL), '{}') AS catalog_brands,
               (array_agg(p.funnel_stage   ORDER BY p.updated_at DESC))[1] AS funnel_catalog,
               (array_agg(p.brand_presence ORDER BY p.updated_at DESC))[1] AS brand_presence_resolved,
               ${presenceSetExpr(sql`p.brand`, sql`p.brand_presence`)} AS presence_set,
               (array_agg(p.list_type      ORDER BY p.updated_at DESC))[1] AS list_type,
               (array_agg(p.depth1         ORDER BY p.updated_at DESC))[1] AS depth1,
               (array_agg(p.depth2         ORDER BY p.updated_at DESC))[1] AS depth2,
               (array_agg(p.depth3         ORDER BY p.updated_at DESC))[1] AS depth3,
               (array_agg(p.id             ORDER BY p.updated_at DESC))[1] AS catalog_row_id,
               (array_agg(p.status::text   ORDER BY p.updated_at DESC))[1] AS catalog_status
        FROM prompts p WHERE p.deleted_at IS NULL AND p.scope_prompt_id IS NOT NULL GROUP BY 1
      ),
      root AS (
        SELECT DISTINCT scope_prompt_id AS pid FROM prompts
        WHERE project_id = ${STANDARD_ROOT_PROJECT_ID}::uuid AND scope_prompt_id IS NOT NULL
      )
      INSERT INTO summary_prompt_dim
        (cycle_week, cycle_id, generation_id, prompt_id, project_id, lang, catalog_brands,
         funnel_catalog, funnel_scope, brand_presence_resolved, presence_set, list_type, depth1, depth2, depth3,
         regions, is_korean, in_root_catalog, catalog_status, catalog_deleted, in_full_cycle,
         expected_cells, window_cells, catalog_row_id, custom_tags, text,
         site_country, site_lang, target_url_norm, owned_base_url,
         report_fs, unit_base, target_url_norm_report)
      SELECT ${spec.cycleWeek}::date, ${cycleId}::uuid, ${genId}::uuid,
             wp.scope_prompt_id::uuid, ${pid}::uuid, wp.lang_code,
             COALESCE(cat.catalog_brands, '{}'),
             cat.funnel_catalog, sp.funnel_stage, cat.brand_presence_resolved,
             COALESCE(cat.presence_set, '{}'),
             cat.list_type, cat.depth1, cat.depth2, cat.depth3,
             sp.regions, CASE WHEN sp.is_korean THEN 1 ELSE 0 END,
             CASE WHEN root.pid IS NOT NULL THEN 1 ELSE 0 END,
             cat.catalog_status, 0, 1,
             NULL::int, COALESCE(wc.window_cells, 0), cat.catalog_row_id, NULL::jsonb,
             COALESCE(sp.text, wp.prompt_text),
             ws.country_code, wp.lang_code,
             ${citationTrackedNormSql(sql`wp.target_url`)}, wp.owned_base_url,
             runit.report_fs, runit.unit_base, summary_report_norm(wp.target_url)
      FROM website_prompts wp
      JOIN website_sites ws ON ws.id = wp.site_id
      LEFT JOIN scope_prompts sp ON sp.prompt_id = wp.scope_prompt_id::uuid
      LEFT JOIN runit ON runit.prompt_id = wp.scope_prompt_id::uuid
      LEFT JOIN cat  ON cat.pid  = wp.scope_prompt_id::uuid
      LEFT JOIN root ON root.pid = wp.scope_prompt_id::uuid
      LEFT JOIN wc   ON wc.prompt_id = wp.scope_prompt_id::uuid
      WHERE ws.scope_project_id = ${pid} AND wp.scope_prompt_id IS NOT NULL
      UNION ALL
      -- 사이트(website_prompts) 행이 없는데 이 회차에 측정된 프롬프트(제품 결정 2026-09-06).
      -- 측정 프롬프트가 dim 에 빠지면 "미측정 = dim − jobs" 가 음수 방향으로 깨진다.
      SELECT ${spec.cycleWeek}::date, ${cycleId}::uuid, ${genId}::uuid,
             o.prompt_id, ${pid}::uuid, lower(sp.lang),
             COALESCE(cat.catalog_brands, '{}'),
             cat.funnel_catalog, sp.funnel_stage, cat.brand_presence_resolved,
             COALESCE(cat.presence_set, '{}'),
             cat.list_type, cat.depth1, cat.depth2, cat.depth3,
             sp.regions, CASE WHEN sp.is_korean THEN 1 ELSE 0 END,
             CASE WHEN root.pid IS NOT NULL THEN 1 ELSE 0 END,
             cat.catalog_status, 0, 1,
             NULL::int, COALESCE(wc.window_cells, 0), cat.catalog_row_id, NULL::jsonb,
             sp.text,
             NULL::text, NULL::text, NULL::text, NULL::text,
             NULL::int, NULL::text, NULL::text
      FROM (SELECT DISTINCT prompt_id FROM jb) o
      LEFT JOIN scope_prompts sp ON sp.prompt_id = o.prompt_id
      LEFT JOIN cat  ON cat.pid  = o.prompt_id
      LEFT JOIN root ON root.pid = o.prompt_id
      LEFT JOIN wc   ON wc.prompt_id = o.prompt_id
      WHERE NOT EXISTS (
        SELECT 1 FROM website_prompts w2 WHERE w2.scope_prompt_id::uuid = o.prompt_id
      )
    `),
    );

    // 10) 행수 기록 → ready
    const rc = await rt.rows<Record<string, unknown>>(rowCountsSql(genId));
    await rt.exec(markGenerationReadySql(genId, rc[0]));

    // 11) 스왑 tx (§7-3 낙관 검사 + §7-1 원자 전환)
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
      // 이 분기는 throw 하지 않고 return 한다 — catch 를 안 타므로 여기서 직접 되돌린다.
      await rt.exec(restoreCycleStatusOnFailureSql(cycleId));
      return { pid, ok: false, reason: "synced_at drift", counts: rc[0], cycleId, generationId: genId };
    }

    // 12) 옛 generation 세부층 정리 (§7-1 — 커밋 후, 급하지 않음)
    await purgeOldGenerationRows(rt, keys);
    // 옛 generation 의 0081 행 정리: **비치명**. 스왑은 이미 커밋됐다: 여기서 던지면 catch 가
    // 활성 generation 을 failed 로 접는다(검증 2026-09-27 지적 2). 남은 행은 값에 영향이 없다
    // (리더는 활성 generation 만 조인한다): 다음 생성의 정리가 가져간다.
    if (urlHitsReady) {
      try {
        for (const stmt of purgeOldUrlHitsSql(keys)) await rt.exec(stmt);
      } catch (e) {
        rt.timings.url_hits_purge_failed = 1;
        rt.log(`  ↳ summary_url_hits 옛 generation 정리 실패(비치명): ${String(e).slice(0, 300)}`);
      }
    }
    return { pid, ok: true, counts: rc[0], cycleId, generationId: genId };
  } catch (e) {
    await rt.exec(markGenerationFailedSql(genId, String(e).slice(0, 2000)));
    // 카운터 UPDATE 가 올려 둔 'generating' 을 되돌린다 — 안 되돌리면 `--pending` 이
    // 그 회차를 영영 다시 안 뽑는다(cycle.ts::restoreCycleStatusOnFailureSql 머리 주석).
    await rt.exec(restoreCycleStatusOnFailureSql(cycleId));
    throw e;
  }
}

/** 회차 전체 행수 — 레거시 스크립트의 마지막 로그. */
export async function cycleTotals(rt: GeneratorRuntime, spec: WebsiteCycleSpec) {
  const totals = await rt.rows<Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*) FROM summary_cycles WHERE surface = ${SURFACE} AND cycle_anchor_at = ${spec.cycleAnchorAt}::timestamptz)::int AS cycles,
      (SELECT count(*) FROM summary_cycles WHERE surface = ${SURFACE} AND cycle_anchor_at = ${spec.cycleAnchorAt}::timestamptz AND status = 'published')::int AS published,
      (SELECT count(*) FROM summary_cycle_runs cr JOIN summary_cycles c USING (cycle_id) WHERE c.cycle_anchor_at = ${spec.cycleAnchorAt}::timestamptz)::int AS cycle_runs,
      (SELECT count(*) FROM summary_cycle_jobs       WHERE cycle_week = ${spec.cycleWeek}::date)::int AS cycle_jobs,
      (SELECT count(*) FROM summary_answers          WHERE cycle_week = ${spec.cycleWeek}::date)::int AS answers,
      (SELECT count(*) FROM summary_brand_mentions   WHERE cycle_week = ${spec.cycleWeek}::date)::int AS brand_mentions,
      (SELECT count(*) FROM summary_domain_citations WHERE cycle_week = ${spec.cycleWeek}::date)::int AS domain_citations,
      (SELECT count(*) FROM summary_target_hits      WHERE cycle_week = ${spec.cycleWeek}::date)::int AS target_hits,
      (SELECT count(*) FROM summary_prompt_dim       WHERE cycle_week = ${spec.cycleWeek}::date)::int AS prompt_dim
  `);
  return totals[0];
}
