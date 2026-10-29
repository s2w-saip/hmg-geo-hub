/**
 * 웹사이트 2026-09-04 회차 사실표 검증 (읽기 전용).
 *
 *   npm run summary:verify-0904
 *
 * 사실표를 **원본(미러)에서 독립 재계산**한 값과 대조한다. 생성기가 쓴 SQL 을
 * 그대로 다시 도는 것이 아니라, 굳혀진 job 집합(summary_cycle_jobs)만 입력으로
 * 받아 scope_mentions·scope_citations 에서 다시 센다.
 */
process.env.DB_POOL_MAX ??= "4";

import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { columnAvailable } from "@/lib/db/column-availability";
import {
  ROLLUP_NAMES,
  canonBrandNameSql,
  canonRollupSql,
  excludeNonCompetitorBrandsSql,
} from "@/lib/db/repositories/scope-aggregates";
import type { OwnEntity } from "@/lib/scope/hmg-brands";
import type { StandardFilters } from "@/lib/scope/result-adapter";

const CYCLE_ANCHOR_AT = "2026-09-04T00:00:00Z";
const CYCLE_WEEK = "2026-08-31";
const SURFACE = "website";

const db = getDb();
const rows = async <T>(q: SQL): Promise<T[]> => (await db.execute(q)) as unknown as T[];
const n = (v: unknown) => Number(v ?? 0);
let failures = 0;
const check = (label: string, a: number, b: number, note = "") => {
  const ok = a === b;
  if (!ok) failures += 1;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${a} vs ${b}${note ? ` (${note})` : ""}`);
};

async function main() {
  await columnAvailable("scope_citations", "url_norm");
  const roster = await rows<{ entity_id: string; name: string }>(
    sql`SELECT entity_id, name FROM entity_registry WHERE role = 'own'`,
  );
  const own: OwnEntity[] = roster.map((r) => ({ id: r.entity_id, name: r.name }));
  const filters: StandardFilters = { ownEntities: own };
  const rollup = canonRollupSql(filters, "m");
  const rawName = sql`COALESCE(n.brand, m.brand)`;
  const brandName = canonBrandNameSql(rawName);
  const isCompetitor = excludeNonCompetitorBrandsSql(brandName, sql`m.brand`);

  // 활성 generation 의 job 집합 = 모든 대조의 유일한 입력
  const ACT = sql`
    act AS (
      SELECT c.cycle_id, c.active_generation_id AS gid, c.project_id
      FROM summary_cycles c
      WHERE c.surface = ${SURFACE} AND c.cycle_anchor_at = ${CYCLE_ANCHOR_AT}::timestamptz
        AND c.status = 'published' AND c.active_generation_id IS NOT NULL
    ),
    jb AS (
      SELECT j.job_id, j.prompt_id, j.engine, j.country, act.cycle_id, act.gid
      FROM summary_cycle_jobs j JOIN act ON act.cycle_id = j.cycle_id AND act.gid = j.generation_id
      WHERE j.cycle_week = ${CYCLE_WEEK}::date
    )`;

  const ledger = await rows<Record<string, unknown>>(sql`
    SELECT count(*)::int AS cycles,
      count(*) FILTER (WHERE status = 'published')::int AS published,
      count(*) FILTER (WHERE view_anchor_at IS NOT NULL)::int AS visible,
      count(*) FILTER (WHERE active_generation_id IS NOT NULL)::int AS with_gen,
      count(*) FILTER (WHERE fleet_visible)::int AS fleet_visible,
      round(avg(completion_ratio), 5)::text AS avg_completion,
      max(analysis_gap_ratio)::text AS max_gap,
      count(*) FILTER (WHERE analysis_gap_ratio > 0.05)::int AS gap_over_5pct
    FROM summary_cycles WHERE surface = ${SURFACE} AND cycle_anchor_at = ${CYCLE_ANCHOR_AT}::timestamptz
  `);
  console.log("원장:", ledger[0]);

  const counts = await rows<Record<string, unknown>>(sql`
    WITH ${ACT}
    SELECT (SELECT count(*) FROM act)::int AS cycles_published,
      (SELECT count(*) FROM jb)::int AS cycle_jobs,
      (SELECT count(*) FROM summary_answers a JOIN act ON act.gid = a.generation_id)::int AS answers,
      (SELECT count(*) FROM summary_brand_mentions b JOIN act ON act.gid = b.generation_id)::int AS brand_mentions,
      (SELECT count(*) FROM summary_domain_citations d JOIN act ON act.gid = d.generation_id)::int AS domain_citations,
      (SELECT count(*) FROM summary_target_hits t JOIN act ON act.gid = t.generation_id)::int AS target_hits,
      (SELECT count(*) FROM summary_prompt_dim p JOIN act ON act.gid = p.generation_id)::int AS prompt_dim,
      (SELECT count(*) FROM summary_cycle_runs r JOIN act ON act.cycle_id = r.cycle_id)::int AS cycle_runs
  `);
  console.log("표별 행수(활성 generation):", counts[0]);

  // 1) 셀 유일성 — (cycle, prompt, engine, country)
  const dup = await rows<{ dups: number }>(sql`
    WITH ${ACT}
    SELECT count(*)::int AS dups FROM (
      SELECT cycle_id, prompt_id, engine, country FROM jb GROUP BY 1,2,3,4 HAVING count(*) > 1
    ) t
  `);
  check("cycle_jobs 셀 유일성(중복 0)", n(dup[0]?.dups), 0);

  // 2) answers 행수 = cycle_jobs 행수
  check("answers = cycle_jobs", n(counts[0]?.answers), n(counts[0]?.cycle_jobs));

  // 2b) 관측 셀(expected_units) = 굳힌 셀(cycle_jobs) — 사이트 없는 프롬프트 포함의 단언
  const units = await rows<Record<string, unknown>>(sql`
    WITH ${ACT}
    SELECT (SELECT COALESCE(sum(expected_units),0) FROM summary_cycles
             WHERE surface = ${SURFACE} AND cycle_anchor_at = ${CYCLE_ANCHOR_AT}::timestamptz)::int AS expected,
           (SELECT COALESCE(sum(completed_units),0) FROM summary_cycles
             WHERE surface = ${SURFACE} AND cycle_anchor_at = ${CYCLE_ANCHOR_AT}::timestamptz)::int AS completed,
           (SELECT count(*) FROM jb)::int AS jobs,
           (SELECT count(*) FROM summary_answers a JOIN act ON act.gid = a.generation_id
             WHERE NOT EXISTS (SELECT 1 FROM website_prompts wp WHERE wp.scope_prompt_id::uuid = a.prompt_id))::int AS siteless_answers,
           (SELECT count(*) FROM summary_prompt_dim d JOIN act ON act.gid = d.generation_id
             WHERE d.site_country IS NULL)::int AS siteless_dim
  `);
  console.log("셀 단언 입력:", units[0]);
  check("expected_units 합 = cycle_jobs", n(units[0]?.expected), n(units[0]?.jobs));
  check("completed_units 합 = cycle_jobs", n(units[0]?.completed), n(units[0]?.jobs));

  // 3) 브랜드 표 SUM(mentions) vs 원본 게이트 통과 mention_count 합 (독립 재계산)
  const bm = await rows<Record<string, unknown>>(sql`
    WITH names AS ${ROLLUP_NAMES}, ${ACT},
    -- 2게이트(rollup·표시명) 모집단 = 브랜드 표에 저장되는 행. 그 안에서 비경쟁
    -- 제외까지 통과한 부분합이 ②의 분모(is_competitor=1)와 answers.all_mentions 다.
    raw AS (
      SELECT sum(m.mention_count) FILTER (WHERE ${isCompetitor})::bigint AS gated,
             sum(m.mention_count)::bigint AS rollup_named
      FROM scope_mentions m JOIN jb ON jb.job_id = m.job_id
      LEFT JOIN names n ON n.entity_id = ${rollup}
      WHERE m.brand_rollup_entity_id IS NOT NULL AND ${rawName} IS NOT NULL
    ),
    tbl AS (
      SELECT sum(b.mentions) FILTER (WHERE b.is_competitor = 1)::bigint AS competitor,
             sum(b.mentions)::bigint AS all_rows
      FROM summary_brand_mentions b JOIN act ON act.gid = b.generation_id
    )
    SELECT raw.gated, raw.rollup_named, tbl.competitor, tbl.all_rows FROM raw, tbl
  `);
  check("brand SUM(mentions|is_competitor=1) = 원본 3게이트 합",
    n(bm[0]?.competitor), n(bm[0]?.gated));
  check("brand SUM(mentions 전체) = 원본 2게이트(rollup·표시명) 합",
    n(bm[0]?.all_rows), n(bm[0]?.rollup_named));

  // 4) answers.all_mentions 합 = 같은 원본 3게이트 합
  const am = await rows<{ s: string }>(sql`
    WITH ${ACT} SELECT COALESCE(sum(a.all_mentions), 0)::bigint AS s
    FROM summary_answers a JOIN act ON act.gid = a.generation_id
  `);
  check("answers SUM(all_mentions) = 원본 3게이트 합", n(am[0]?.s), n(bm[0]?.gated));

  // 5) 인용 가산성 — 표 합 = 원본 인용 행수 (도넛/⑤ 분모의 근거)
  const cit = await rows<Record<string, unknown>>(sql`
    WITH ${ACT},
    raw AS (SELECT count(*)::bigint AS c FROM scope_citations c JOIN jb ON jb.job_id = c.job_id),
    dom AS (SELECT COALESCE(sum(d.citations),0)::bigint AS c FROM summary_domain_citations d JOIN act ON act.gid = d.generation_id),
    tgt AS (SELECT COALESCE(sum(t.citations),0)::bigint AS c FROM summary_target_hits t JOIN act ON act.gid = t.generation_id),
    ans AS (SELECT COALESCE(sum(a.all_citations),0)::bigint AS c FROM summary_answers a JOIN act ON act.gid = a.generation_id)
    SELECT raw.c AS raw, dom.c AS dom, tgt.c AS tgt, ans.c AS ans FROM raw, dom, tgt, ans
  `);
  check("domain_citations SUM = 원본 인용 행수", n(cit[0]?.dom), n(cit[0]?.raw));
  check("target_hits SUM = 원본 인용 행수", n(cit[0]?.tgt), n(cit[0]?.raw));
  check("answers SUM(all_citations) = 원본 인용 행수", n(cit[0]?.ans), n(cit[0]?.raw));

  // 6) has_any_brand = 브랜드 표에 행이 있는 job
  const hb = await rows<Record<string, unknown>>(sql`
    WITH ${ACT}
    SELECT (SELECT count(*) FROM summary_answers a JOIN act ON act.gid = a.generation_id WHERE a.has_any_brand = 1)::int AS flagged,
           (SELECT count(DISTINCT b.job_id) FROM summary_brand_mentions b JOIN act ON act.gid = b.generation_id)::int AS with_rows
  `);
  check("has_any_brand=1 답변 수 = 브랜드 표에 행이 있는 job 수", n(hb[0]?.flagged), n(hb[0]?.with_rows));

  // 7) 참조 무결성 — 사실표 job 이 전부 cycle_jobs 에 있고, dim 이 프로젝트 전량을 덮는가
  const orph = await rows<Record<string, unknown>>(sql`
    WITH ${ACT}
    SELECT
      (SELECT count(*) FROM summary_brand_mentions b JOIN act ON act.gid = b.generation_id
        WHERE NOT EXISTS (SELECT 1 FROM jb WHERE jb.job_id = b.job_id))::int AS brand_orphans,
      (SELECT count(*) FROM summary_domain_citations d JOIN act ON act.gid = d.generation_id
        WHERE NOT EXISTS (SELECT 1 FROM jb WHERE jb.job_id = d.job_id))::int AS domain_orphans,
      (SELECT count(*) FROM jb WHERE NOT EXISTS (
         SELECT 1 FROM summary_prompt_dim p JOIN act a2 ON a2.gid = p.generation_id
         WHERE p.prompt_id = jb.prompt_id AND p.cycle_id = jb.cycle_id))::int AS jobs_without_dim
  `);
  check("brand 표 고아 job", n(orph[0]?.brand_orphans), 0);
  check("domain 표 고아 job", n(orph[0]?.domain_orphans), 0);
  check("dim 없는 측정 프롬프트", n(orph[0]?.jobs_without_dim), 0);

  // 8) ⑥ 표본 — 사실표로 계산한 타겟 인용률(전 프로젝트 무필터)
  const k6 = await rows<Record<string, unknown>>(sql`
    WITH ${ACT},
    tk AS (SELECT DISTINCT c.project_id::text || '|' || p.lang || '|' || p.site_country AS key
           FROM summary_prompt_dim p JOIN act c ON c.gid = p.generation_id),
    sel AS (SELECT DISTINCT owned_base_url FROM website_prompts WHERE owned_base_url IS NOT NULL AND owned_base_url <> ''),
    g AS (
      SELECT t.job_id,
             bool_or(t.matched_base_tracked <> '') AS owned,
             bool_or(t.target_keys && (SELECT array_agg(key) FROM tk)) AS target
      FROM summary_target_hits t JOIN act ON act.gid = t.generation_id
      GROUP BY 1
    )
    SELECT count(*) FILTER (WHERE owned)::int AS owned_answers,
           count(*) FILTER (WHERE owned AND target)::int AS target_answers,
           (SELECT count(*) FROM sel)::int AS declared_bases
    FROM g
  `);
  const oa = n(k6[0]?.owned_answers), ta = n(k6[0]?.target_answers);
  console.log(`ⓖ ⑥ 타겟 인용률(무필터·전 프로젝트): ${ta}/${oa} = ${oa ? ((100 * ta) / oa).toFixed(1) : "—"}%`);

  console.log(failures === 0 ? "\n모든 대조 통과" : `\n실패 ${failures}건`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
