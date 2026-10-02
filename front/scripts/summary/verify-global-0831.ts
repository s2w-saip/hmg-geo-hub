/**
 * 글로벌 2026-08-31 회차 사실표 검증 (읽기 전용).
 *
 *   npm run summary:verify-global-0831
 *
 * 사실표를 **원본(미러)에서 독립 재계산**한 값과 대조한다. 생성기가 쓴 SQL 을 그대로
 * 다시 도는 것이 아니라, 굳혀진 job 집합(summary_cycle_jobs)만 입력으로 받아
 * scope_mentions·scope_citations 에서 다시 센다. verify-website-0904.ts 의 글로벌판.
 *
 * ⚠️ 성능: 활성 generation 을 **먼저 JS 로 확정**하고 (cycle_week, cycle_id, generation_id)
 * 를 리터럴 파라미터로 넘긴다. 웹사이트판처럼 `act`/`jb` CTE 를 여러 번 참조하면 PG 가
 * CTE 를 materialize 하고 `NOT EXISTS (… FROM jb …)` 가 행마다 CTE 를 재스캔한다 —
 * 글로벌 규모(브랜드 229k·인용 96k)에서 600s statement_timeout 을 넘겼다(2026-09-06 실측).
 */
process.env.DB_POOL_MAX ??= "3";

import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { columnAvailable } from "@/lib/db/column-availability";
import {
  ROLLUP_NAMES,
  canonBrandNameSql,
  canonRollupSql,
  citationNormExpr,
  excludeNonCompetitorBrandsSql,
  ownedBasePrefixClause,
} from "@/lib/db/repositories/scope-aggregates";
import { STANDARD_ROOT_PROJECT_ID } from "@/lib/db/repositories/standards";
import { GEO_OWNED_BASE_PREFIXES, SHARED_GLOBAL_HOSTS } from "@/lib/geo-catalog/owned";
import type { OwnEntity } from "@/lib/scope/hmg-brands";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { fullCycleCte, inTaggedRegionExpr, presenceSetExpr } from "./global-predicates";

const SURFACE = "global";
const ROOT_PROJECT_ID =
  process.env.SCOPE_ROOT_PROJECT_ID ?? "be28fe15-c743-4a88-abb8-182b25602812";
const CYCLE_ANCHOR_AT = "2026-08-31T00:00:00Z";
const CYCLE_ANCHOR_DATE = "2026-08-31";
const CYCLE_WEEK = "2026-08-31";
const WIN_FROM = "2026-08-30T00:00:00Z";
const WIN_TO = "2026-09-02T00:00:00Z";

const db = getDb();
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const rows = async <T>(q: SQL): Promise<T[]> =>
  (await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '600s'`);
    return (await tx.execute(q)) as unknown as T[];
  })) as unknown as T[];
const n = (v: unknown) => Number(v ?? 0);
let failures = 0;
const check = (label: string, a: number, b: number, note = "") => {
  const ok = a === b;
  if (!ok) failures += 1;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${a} vs ${b}${note ? ` (${note})` : ""}`);
};

/** 회차 run 집합 — 생성기와 같은 멤버십 술어(§8-1)를 독립적으로 다시 만든다. */
const MEM_CTE = sql`
  mem AS (
    SELECT r.run_id FROM scope_runs r
    WHERE r.project_id = ${ROOT_PROJECT_ID}::uuid
      AND (CASE
             WHEN r.cycle_anchor_at IS NOT NULL
               THEN (r.cycle_anchor_at AT TIME ZONE 'UTC')::date = ${CYCLE_ANCHOR_DATE}::date
             ELSE EXISTS (SELECT 1 FROM scope_answers a WHERE a.run_id = r.run_id
                           AND a.measured_at >= ${WIN_FROM}::timestamptz
                           AND a.measured_at <  ${WIN_TO}::timestamptz) END)
  )`;

async function main() {
  await Promise.all([
    columnAvailable("scope_citations", "url_norm"),
    columnAvailable("scope_prompts", "is_korean"),
    columnAvailable("scope_prompts", "regions"),
  ]);

  const ledger = await rows<Record<string, unknown>>(sql`
    SELECT cycle_id::text AS cycle_id, active_generation_id::text AS gid, status, cycle_week::text AS cycle_week,
           expected_units, completed_units, sealed_units,
           completion_ratio::text AS completion_ratio, analysis_gap_ratio::text AS analysis_gap_ratio,
           analysis_gate, closed_by, anchor_source, fleet_visible,
           (view_anchor_at IS NOT NULL) AS visible, generator_version
    FROM summary_cycles
    WHERE surface = ${SURFACE} AND project_id = ${ROOT_PROJECT_ID}::uuid
      AND cycle_anchor_at = ${CYCLE_ANCHOR_AT}::timestamptz
  `);
  console.log("원장:", ledger[0]);
  check("회차 1개", ledger.length, 1);
  const published = ledger.filter((r) => r.status === "published" && r.gid);
  check("published + active generation", published.length, 1);
  if (published.length !== 1) {
    console.log("\n활성 generation 이 없어 이후 대조를 건너뛴다.");
    process.exit(1);
  }
  const cycleId = String(published[0].cycle_id);
  const genId = String(published[0].gid);
  const W = sql`${CYCLE_WEEK}::date`;
  const C = sql`${cycleId}::uuid`;
  const G = sql`${genId}::uuid`;
  /** 사실표 행 선택 술어 — 파티션 키 + PK 접두라 인덱스로 떨어진다. */
  const pick = (a: string) =>
    sql`${sql.raw(a)}.cycle_week = ${W} AND ${sql.raw(a)}.cycle_id = ${C} AND ${sql.raw(a)}.generation_id = ${G}`;

  const counts = await rows<Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*) FROM summary_cycle_jobs j       WHERE ${pick("j")})::int AS cycle_jobs,
      (SELECT count(*) FROM summary_answers a          WHERE ${pick("a")})::int AS answers,
      (SELECT count(*) FROM summary_brand_mentions b   WHERE ${pick("b")})::int AS brand_mentions,
      (SELECT count(*) FROM summary_domain_citations d WHERE ${pick("d")})::int AS domain_citations,
      (SELECT count(*) FROM summary_target_hits t      WHERE ${pick("t")})::int AS target_hits,
      (SELECT count(*) FROM summary_prompt_dim p       WHERE ${pick("p")})::int AS prompt_dim,
      (SELECT count(*) FROM summary_cycle_runs r WHERE r.cycle_id = ${C})::int AS cycle_runs
  `);
  log("표별 행수(활성 generation):", counts[0]);
  check("summary_target_hits 미생성(글로벌)", n(counts[0]?.target_hits), 0);

  // 1) 셀 유일성 — (prompt, engine, country)
  const dup = await rows<{ dups: number }>(sql`
    SELECT count(*)::int AS dups FROM (
      SELECT prompt_id, engine, country FROM summary_cycle_jobs j WHERE ${pick("j")}
      GROUP BY 1,2,3 HAVING count(*) > 1
    ) t
  `);
  check("cycle_jobs 셀 유일성(중복 0)", n(dup[0]?.dups), 0);

  // 2) answers = cycle_jobs, 원장 관측치 = 굳힌 셀
  check("answers = cycle_jobs", n(counts[0]?.answers), n(counts[0]?.cycle_jobs));
  check("expected_units = cycle_jobs", n(ledger[0]?.expected_units), n(counts[0]?.cycle_jobs));
  check("completed_units = cycle_jobs", n(ledger[0]?.completed_units), n(counts[0]?.cycle_jobs));

  // 2b) 굳힌 셀 = 미러에서 독립 재계산한 회차 셀 집합
  const mirror = await rows<Record<string, unknown>>(sql`
    WITH ${MEM_CTE},
    all_ans AS (SELECT a.* FROM scope_answers a JOIN mem ON mem.run_id = a.run_id)
    SELECT count(DISTINCT (prompt_id, target, region)) FILTER (WHERE status = 'completed')::int AS cells,
           count(*) FILTER (WHERE status = 'completed')::int AS answers_completed,
           count(DISTINCT prompt_id) FILTER (WHERE status = 'completed')::int AS prompts,
           (SELECT count(*) FROM mem)::int AS runs
    FROM all_ans
  `);
  log("미러 재계산:", mirror[0]);
  check("cycle_jobs = 미러 완료 셀", n(counts[0]?.cycle_jobs), n(mirror[0]?.cells));
  check("cycle_runs = 미러 회차 run", n(counts[0]?.cycle_runs), n(mirror[0]?.runs));

  // 3) 브랜드 표 SUM(mentions) vs 원본 게이트 통과 mention_count 합 (독립 재계산)
  const roster = await rows<{ entity_id: string; name: string }>(
    sql`SELECT entity_id, name FROM entity_registry WHERE role = 'own'`,
  );
  const own: OwnEntity[] = roster.map((r) => ({ id: r.entity_id, name: r.name }));
  const filters: StandardFilters = { ownEntities: own };
  const rollup = canonRollupSql(filters, "m");
  const rawName = sql`COALESCE(n.brand, m.brand)`;
  const brandName = canonBrandNameSql(rawName);
  const isCompetitor = excludeNonCompetitorBrandsSql(brandName, sql`m.brand`);

  const bm = await rows<Record<string, unknown>>(sql`
    WITH names AS ${ROLLUP_NAMES},
    raw AS (
      SELECT sum(m.mention_count) FILTER (WHERE ${isCompetitor})::bigint AS gated,
             sum(m.mention_count)::bigint AS rollup_named
      FROM scope_mentions m
      JOIN summary_cycle_jobs j ON j.job_id = m.job_id AND ${pick("j")}
      LEFT JOIN names n ON n.entity_id = ${rollup}
      WHERE m.brand_rollup_entity_id IS NOT NULL AND ${rawName} IS NOT NULL
    ),
    tbl AS (
      SELECT sum(b.mentions) FILTER (WHERE b.is_competitor = 1)::bigint AS competitor,
             sum(b.mentions)::bigint AS all_rows
      FROM summary_brand_mentions b WHERE ${pick("b")}
    ),
    ans AS (SELECT COALESCE(sum(a.all_mentions), 0)::bigint AS s FROM summary_answers a WHERE ${pick("a")})
    SELECT raw.gated, raw.rollup_named, tbl.competitor, tbl.all_rows, ans.s AS answers_all_mentions
    FROM raw, tbl, ans
  `);
  log("브랜드 대조 입력:", bm[0]);
  check("brand SUM(mentions|is_competitor=1) = 원본 3게이트 합", n(bm[0]?.competitor), n(bm[0]?.gated));
  check("brand SUM(mentions 전체) = 원본 2게이트(rollup·표시명) 합", n(bm[0]?.all_rows), n(bm[0]?.rollup_named));
  check("answers SUM(all_mentions) = 원본 3게이트 합", n(bm[0]?.answers_all_mentions), n(bm[0]?.gated));

  // 4) 인용 가산성 — 표 합 = 원본 인용 행수
  const cit = await rows<Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*) FROM scope_citations c
        JOIN summary_cycle_jobs j ON j.job_id = c.job_id AND ${pick("j")})::bigint AS raw,
      (SELECT COALESCE(sum(d.citations),0) FROM summary_domain_citations d WHERE ${pick("d")})::bigint AS dom,
      (SELECT COALESCE(sum(a.all_citations),0) FROM summary_answers a WHERE ${pick("a")})::bigint AS ans
  `);
  log("인용 대조 입력:", cit[0]);
  check("domain_citations SUM = 원본 인용 행수", n(cit[0]?.dom), n(cit[0]?.raw));
  check("answers SUM(all_citations) = 원본 인용 행수", n(cit[0]?.ans), n(cit[0]?.raw));

  // 5) has_any_brand = 브랜드 표에 행이 있는 job
  const hb = await rows<Record<string, unknown>>(sql`
    SELECT (SELECT count(*) FROM summary_answers a WHERE ${pick("a")} AND a.has_any_brand = 1)::int AS flagged,
           (SELECT count(DISTINCT b.job_id) FROM summary_brand_mentions b WHERE ${pick("b")})::int AS with_rows
  `);
  check("has_any_brand=1 답변 수 = 브랜드 표에 행이 있는 job 수", n(hb[0]?.flagged), n(hb[0]?.with_rows));

  // 6) 참조 무결성 + dim 커버리지 (PK 인덱스 anti-join)
  const orph = await rows<Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*) FROM summary_brand_mentions b WHERE ${pick("b")}
        AND NOT EXISTS (SELECT 1 FROM summary_cycle_jobs j
          WHERE j.cycle_week = b.cycle_week AND j.cycle_id = b.cycle_id
            AND j.generation_id = b.generation_id AND j.job_id = b.job_id))::int AS brand_orphans,
      (SELECT count(*) FROM summary_domain_citations d WHERE ${pick("d")}
        AND NOT EXISTS (SELECT 1 FROM summary_cycle_jobs j
          WHERE j.cycle_week = d.cycle_week AND j.cycle_id = d.cycle_id
            AND j.generation_id = d.generation_id AND j.job_id = d.job_id))::int AS domain_orphans,
      (SELECT count(*) FROM summary_cycle_jobs j WHERE ${pick("j")}
        AND NOT EXISTS (SELECT 1 FROM summary_prompt_dim p
          WHERE p.cycle_week = j.cycle_week AND p.cycle_id = j.cycle_id
            AND p.generation_id = j.generation_id AND p.prompt_id = j.prompt_id))::int AS jobs_without_dim,
      (SELECT count(*) FROM summary_prompt_dim p WHERE ${pick("p")} AND p.in_root_catalog = 1)::int AS dim_in_catalog,
      (SELECT count(DISTINCT scope_prompt_id) FROM prompts
        WHERE project_id = ${STANDARD_ROOT_PROJECT_ID}::uuid AND scope_prompt_id IS NOT NULL)::int AS catalog_prompts
  `);
  log("참조 무결성 입력:", orph[0]);
  check("brand 표 고아 job", n(orph[0]?.brand_orphans), 0);
  check("domain 표 고아 job", n(orph[0]?.domain_orphans), 0);
  check("dim 없는 측정 프롬프트", n(orph[0]?.jobs_without_dim), 0);
  check("dim in_root_catalog=1 = 루트 카탈로그 프롬프트 수",
    n(orph[0]?.dim_in_catalog), n(orph[0]?.catalog_prompts));

  // 6b) brandPresence 축(0063) — 사실표 presence_set 을 카탈로그에서 **독립 재계산**해 대조.
  // 이 축이 갈리면 화면 숫자가 조용히 틀린다(2026-09-06: branded 격자 12,776 vs 20,712).
  // 컬럼이 아직 없으면(0063 미적용) 건너뛴다 — 적용 전 회차를 검증할 수 있어야 한다.
  if (await columnAvailable("summary_prompt_dim", "presence_set")) {
    const ps = await rows<Record<string, unknown>>(sql`
      WITH want AS (
        SELECT p.scope_prompt_id AS pid, ${presenceSetExpr(sql`p.brand`, sql`p.brand_presence`)} AS pset
        FROM prompts p
        WHERE p.project_id = ${STANDARD_ROOT_PROJECT_ID}::uuid AND p.scope_prompt_id IS NOT NULL
        GROUP BY 1
      ),
      got AS (
        SELECT d.prompt_id AS pid, d.presence_set FROM summary_prompt_dim d
        WHERE ${pick("d")} AND d.in_root_catalog = 1
      )
      SELECT count(*)::int AS root_prompts,
        count(*) FILTER (WHERE got.presence_set IS DISTINCT FROM want.pset)::int AS mismatched,
        count(*) FILTER (WHERE cardinality(got.presence_set) = 0)::int AS empty_in_catalog,
        (SELECT count(*) FROM summary_answers a
          WHERE ${pick("a")} AND a.in_root_catalog = 1
            AND a.presence_set IS DISTINCT FROM (
              SELECT w.pset FROM want w WHERE w.pid = a.prompt_id))::int AS answers_mismatched
      FROM got JOIN want ON want.pid = got.pid
    `);
    log("presence_set 재계산 대조:", ps[0]);
    check("dim.presence_set = 카탈로그 재계산", n(ps[0]?.mismatched), 0);
    check("루트 카탈로그 프롬프트의 presence_set 공집합", n(ps[0]?.empty_in_catalog), 0);
    check("answers.presence_set = dim 재계산", n(ps[0]?.answers_mismatched), 0);
  } else {
    log("presence_set 컬럼 없음(0063 미적용) — brandPresence 축 대조 skip");
  }

  // 7) §3-7 full-cycle — dim 플래그 vs 미러 독립 재계산
  const fcCmp = await rows<Record<string, unknown>>(sql`
    WITH ${MEM_CTE}, ${fullCycleCte(ROOT_PROJECT_ID)},
    cmp AS (
      SELECT p.prompt_id, p.in_full_cycle AS got, p.expected_cells, p.window_cells,
             (CASE WHEN fc.prompt_id IS NOT NULL AND fc.window_cells >= fc.expected_cells THEN 1 ELSE 0 END) AS want,
             fc.expected_cells AS fc_expected, fc.window_cells AS fc_window
      FROM summary_prompt_dim p LEFT JOIN fc ON fc.prompt_id = p.prompt_id
      WHERE ${pick("p")}
    )
    SELECT count(*) FILTER (WHERE want <> got)::int AS mismatched,
           count(*) FILTER (WHERE got = 1)::int AS dim_pass,
           count(*) FILTER (WHERE fc_expected IS NOT NULL AND expected_cells IS DISTINCT FROM fc_expected)::int AS expected_drift,
           count(*) FILTER (WHERE fc_window IS NOT NULL AND window_cells IS DISTINCT FROM fc_window)::int AS window_drift
    FROM cmp
  `);
  log("full-cycle 재계산 대조:", fcCmp[0]);
  check("dim.in_full_cycle = 미러 재계산", n(fcCmp[0]?.mismatched), 0);
  check("dim.expected_cells = 미러 재계산", n(fcCmp[0]?.expected_drift), 0);
  check("dim.window_cells = 미러 재계산", n(fcCmp[0]?.window_drift), 0);

  const fcStats = await rows<Record<string, unknown>>(sql`
    SELECT count(*)::int AS cells,
           count(*) FILTER (WHERE in_full_cycle = 1)::int AS cells_pass,
           count(DISTINCT prompt_id)::int AS prompts,
           count(DISTINCT prompt_id) FILTER (WHERE in_full_cycle = 1)::int AS prompts_pass,
           count(*) FILTER (WHERE in_tagged_region = 1)::int AS cells_tagged,
           count(*) FILTER (WHERE country = 'ID')::int AS cells_hidden,
           count(*) FILTER (WHERE in_root_catalog = 1)::int AS cells_in_catalog,
           count(DISTINCT lang)::int AS langs,
           count(*) FILTER (WHERE lang IS NULL)::int AS lang_null
    FROM summary_answers a WHERE ${pick("a")}
  `);
  log("in_full_cycle / in_tagged_region 통계(셀 기준):", fcStats[0]);

  // 8) 사실표 3종의 차원이 dim 과 같은가(비정규화 복사 정합)
  const drift = await rows<Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*) FROM summary_answers a JOIN summary_prompt_dim p
         ON p.cycle_week = a.cycle_week AND p.cycle_id = a.cycle_id
        AND p.generation_id = a.generation_id AND p.prompt_id = a.prompt_id
        WHERE ${pick("a")} AND (a.in_full_cycle <> p.in_full_cycle OR a.lang IS DISTINCT FROM p.lang
          OR a.catalog_brands <> p.catalog_brands OR a.in_root_catalog <> p.in_root_catalog
          OR a.depth1 IS DISTINCT FROM p.depth1))::int AS answers_drift,
      (SELECT count(*) FROM summary_brand_mentions b JOIN summary_prompt_dim p
         ON p.cycle_week = b.cycle_week AND p.cycle_id = b.cycle_id
        AND p.generation_id = b.generation_id AND p.prompt_id = b.prompt_id
        WHERE ${pick("b")} AND (b.in_full_cycle <> p.in_full_cycle OR b.catalog_brands <> p.catalog_brands))::int AS brand_drift,
      (SELECT count(*) FROM summary_domain_citations d JOIN summary_prompt_dim p
         ON p.cycle_week = d.cycle_week AND p.cycle_id = d.cycle_id
        AND p.generation_id = d.generation_id AND p.prompt_id = d.prompt_id
        WHERE ${pick("d")} AND (d.in_full_cycle <> p.in_full_cycle OR d.catalog_brands <> p.catalog_brands))::int AS domain_drift
  `);
  check("answers 차원 = dim", n(drift[0]?.answers_drift), 0);
  check("brand 차원 = dim", n(drift[0]?.brand_drift), 0);
  check("domain 차원 = dim", n(drift[0]?.domain_drift), 0);

  // 9) in_tagged_region 을 미러에서 독립 재계산
  //    측정 시각은 summary_answers 에 없다 — 생성기(surface-global.ts dimsCte 의 jb)와 같은
  //    원천인 summary_cycle_jobs.measured_at 을 PK 로 조인해 넘긴다(태그 우선 규칙의 8/19 경계).
  const trCmp = await rows<{ mismatched: number }>(sql`
    SELECT count(*)::int AS mismatched FROM summary_answers a
    JOIN summary_cycle_jobs j
      ON j.cycle_week = a.cycle_week AND j.cycle_id = a.cycle_id
     AND j.generation_id = a.generation_id AND j.job_id = a.job_id
    WHERE ${pick("a")} AND a.in_tagged_region <> ${inTaggedRegionExpr(sql`a.prompt_id`, sql`a.country`, sql`j.measured_at`)}
  `);
  check("in_tagged_region = 미러 재계산", n(trCmp[0]?.mismatched), 0);

  // 10) 가산성 (§9-3) — 임의 두 슬라이스의 SUM 합 = 합집합 슬라이스
  const add = await rows<Record<string, unknown>>(sql`
    SELECT
      (SELECT COALESCE(sum(mentions),0) FROM summary_brand_mentions b WHERE ${pick("b")} AND engine = 'chatgpt')::bigint AS chatgpt,
      (SELECT COALESCE(sum(mentions),0) FROM summary_brand_mentions b WHERE ${pick("b")} AND engine = 'gemini')::bigint AS gemini,
      (SELECT COALESCE(sum(mentions),0) FROM summary_brand_mentions b WHERE ${pick("b")} AND engine IN ('chatgpt','gemini'))::bigint AS engines_both,
      (SELECT COALESCE(sum(mentions),0) FROM summary_brand_mentions b WHERE ${pick("b")})::bigint AS engines_all,
      (SELECT COALESCE(sum(citations),0) FROM summary_domain_citations d WHERE ${pick("d")} AND country = 'KR')::bigint AS kr,
      (SELECT COALESCE(sum(citations),0) FROM summary_domain_citations d WHERE ${pick("d")} AND country = 'US')::bigint AS us,
      (SELECT COALESCE(sum(citations),0) FROM summary_domain_citations d WHERE ${pick("d")} AND country IN ('KR','US'))::bigint AS kr_us,
      (SELECT COALESCE(sum(monitored),0) FROM summary_answers a WHERE ${pick("a")} AND in_full_cycle = 1)::bigint AS mon_fc,
      (SELECT COALESCE(sum(monitored),0) FROM summary_answers a WHERE ${pick("a")} AND in_full_cycle = 0)::bigint AS mon_nfc,
      (SELECT COALESCE(sum(monitored),0) FROM summary_answers a WHERE ${pick("a")})::bigint AS mon_all
  `);
  check("브랜드 가산성 chatgpt+gemini", n(add[0]?.chatgpt) + n(add[0]?.gemini), n(add[0]?.engines_both));
  check("브랜드 엔진 축이 전체를 덮는다", n(add[0]?.engines_both), n(add[0]?.engines_all));
  check("인용 가산성 KR+US", n(add[0]?.kr) + n(add[0]?.us), n(add[0]?.kr_us));
  check("monitored 가산성 in_full_cycle 0/1", n(add[0]?.mon_fc) + n(add[0]?.mon_nfc), n(add[0]?.mon_all));

  // 11) ⑤ owned 동치 — universe 전체를 선택했을 때 사실표 matched_base 부착 = 미러 판정.
  //     읽기 ⑤ 는 `matched_base <> '' AND matched_base = ANY($sel)` 뿐이라, 미러가 자사로
  //     치는 인용에 base 가 안 붙어 있으면(루트 홈 #216 · `.html` 동치) 조용히 적게 나온다.
  //     universe 를 통째로 넘기면 longerSiblings 가 공집합이라 그 함수는
  //     `접두 매칭 OR 루트 홈` 으로 환원된다 = 사실표 matched_base <> '' 와 동치여야 한다.
  const bases = [...GEO_OWNED_BASE_PREFIXES];
  const ownedCmp = await rows<Record<string, unknown>>(sql`
    WITH c2 AS MATERIALIZED (
      SELECT c.job_id, COALESCE(c.url, '') AS uk, c.url_base_norm AS bk
      FROM scope_citations c JOIN summary_cycle_jobs j ON j.job_id = c.job_id AND ${pick("j")}
    ),
    un AS MATERIALIZED (
      SELECT uk, ${citationNormExpr("base", sql`nullif(uk, '')`, sql`max(bk)`)} AS base, count(*)::bigint AS hits
      FROM c2 GROUP BY uk
    ),
    m AS (
      SELECT uk, hits, (${ownedBasePrefixClause(sql`un.base`, bases, bases)}) AS owned,
             (SELECT b.base FROM unnest(${sql.param(bases)}::text[]) AS b(base)
               WHERE un.base IS NOT NULL
                 AND split_part(un.base, '/', 1) = split_part(b.base, '/', 1)
                 AND (un.base = b.base OR un.base LIKE b.base || '/%' OR un.base = b.base || '.html')
               ORDER BY length(b.base) DESC, b.base LIMIT 1) AS longest,
             (SELECT b.base FROM unnest(${sql.param(bases)}::text[]) AS b(base)
               WHERE un.base IS NOT NULL
                 AND split_part(b.base, '/', 1) <> ALL(${sql.param([...SHARED_GLOBAL_HOSTS])}::text[])
                 AND rtrim(split_part(un.base, '?', 1), '/') = split_part(b.base, '/', 1)
               ORDER BY length(b.base) ASC, b.base LIMIT 1) AS home
      FROM un
    )
    SELECT count(*) FILTER (WHERE owned)::int AS mirror_owned_urls,
           COALESCE(sum(hits) FILTER (WHERE owned), 0)::bigint AS mirror_owned_citations,
           count(*) FILTER (WHERE owned AND COALESCE(longest, home) IS NULL)::int AS owned_without_base,
           count(*) FILTER (WHERE NOT owned AND COALESCE(longest, home) IS NOT NULL)::int AS base_without_owned
    FROM m
  `);
  log("⑤ owned 동치(URL 기준):", ownedCmp[0]);
  check("미러 owned 인데 base 미부착", n(ownedCmp[0]?.owned_without_base), 0);
  check("base 붙었는데 미러 non-owned", n(ownedCmp[0]?.base_without_owned), 0);

  const ownedRows = await rows<Record<string, unknown>>(sql`
    SELECT COALESCE(sum(d.citations), 0)::bigint AS owned_citations,
           count(DISTINCT d.matched_base) FILTER (WHERE d.matched_base <> '')::int AS distinct_bases,
           count(*) FILTER (WHERE d.matched_base <> '' AND NOT (d.matched_base = ANY(${sql.param(bases)}::text[])))::int AS base_outside_universe,
           (SELECT count(*) FROM summary_domain_citations x WHERE ${pick("x")} AND x.base_norm_null = 1)::int AS base_norm_null_rows
    FROM summary_domain_citations d WHERE ${pick("d")} AND d.matched_base <> ''
  `);
  log("사실표 owned 행:", ownedRows[0]);
  check("사실표 owned 인용 수 = 미러 owned 인용 수",
    n(ownedRows[0]?.owned_citations), n(ownedCmp[0]?.mirror_owned_citations));
  check("matched_base 가 universe 밖", n(ownedRows[0]?.base_outside_universe), 0);

  // 12) 값 무결성 — 글로벌엔 보고서 유닛 플래그가 없다
  const sanity = await rows<Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*) FROM summary_brand_mentions b WHERE ${pick("b")}
        AND b.first_rank IS NOT NULL AND b.first_rank <> round(b.first_rank))::int AS fractional_ranks,
      (SELECT count(*) FROM summary_answers a WHERE ${pick("a")} AND a.report_fs IS NOT NULL)::int AS report_fs_set,
      (SELECT count(*) FROM summary_answers a WHERE ${pick("a")}
        AND (a.unit_owned IS NOT NULL OR a.unit_target IS NOT NULL))::int AS unit_flags_set,
      (SELECT count(*) FROM summary_domain_citations d WHERE ${pick("d")}
        AND d.unit_owned_citations IS NOT NULL)::int AS unit_cit_set,
      (SELECT count(*) FROM summary_prompt_dim p WHERE ${pick("p")}
        AND (p.site_country IS NOT NULL OR p.owned_base_url IS NOT NULL OR p.report_fs IS NOT NULL))::int AS website_cols_set,
      (SELECT count(*) FROM summary_answers a WHERE ${pick("a")} AND a.lang IS NOT NULL AND a.lang <> upper(a.lang))::int AS lang_not_upper
  `);
  log("값 무결성:", sanity[0]);
  check("글로벌 report_fs NULL", n(sanity[0]?.report_fs_set), 0);
  check("글로벌 unit_owned/unit_target NULL", n(sanity[0]?.unit_flags_set), 0);
  check("글로벌 unit_owned_citations NULL", n(sanity[0]?.unit_cit_set), 0);
  check("글로벌 dim 의 웹사이트 전용 컬럼 NULL", n(sanity[0]?.website_cols_set), 0);
  check("lang 은 대문자(§3-2)", n(sanity[0]?.lang_not_upper), 0);

  console.log(failures === 0 ? "\n모든 대조 통과" : `\n실패 ${failures}건`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
