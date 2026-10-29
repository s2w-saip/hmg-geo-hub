/**
 * 생성기 코어 — 세부층 사실표 INSERT 빌더.
 *
 * 표면이 다른 부분(웹사이트의 보고서 유닛 플래그, 글로벌의 `target_hits` 미생성)은
 * **조각(SQL)** 으로 받는다. 조각을 안 주면 두 표면 중 좁은 쪽 문장이 그대로 나온다.
 *
 * `withCtes` 계약: `WITH names AS (…), <withCtes>, mm AS (…)` 로 이어 붙는다. 즉 호출부가
 * `jb`(셀 집합)·`d`(공통 차원)·필요하면 인용 CTE 까지 **순서대로** 만들어 넘긴다.
 */
import { sql, type SQL } from "drizzle-orm";
import type { BrandExprs } from "./context";
import { COL_COMMON, D_COMMON, type GenerationKeys } from "./types";

const raw = (s?: string) => (s ? sql.raw(s) : sql``);

export type AnswersExtras = {
  /** `cc` 뒤에 이어 붙는 CTE 조각(`, cn AS …, uo AS …`). */
  ctes?: SQL;
  /** INSERT 컬럼 목록 꼬리(`, report_fs, unit_owned, unit_target`). */
  columns?: string;
  /** SELECT 목록 꼬리. */
  select?: SQL;
  /** FROM 절 꼬리(`LEFT JOIN uo …`). */
  joins?: SQL;
};

/** `summary_answers` (§6-4 ①의 분모 monitored, 미언급 프롬프트 has_any_brand). */
export function insertAnswersSql(args: {
  keys: GenerationKeys;
  rollupNames: SQL;
  withCtes: SQL;
  brand: BrandExprs;
  extras?: AnswersExtras;
}): SQL {
  const { keys, brand } = args;
  const x = args.extras ?? {};
  return sql`
      WITH names AS ${args.rollupNames}, ${args.withCtes},
      mm AS (
        SELECT m.job_id, sum(m.mention_count)::int AS mentions
        FROM scope_mentions m JOIN jb ON jb.job_id = m.job_id
        LEFT JOIN names n ON n.entity_id = ${brand.rollup}
        WHERE m.brand_rollup_entity_id IS NOT NULL AND ${brand.rawName} IS NOT NULL AND ${brand.isCompetitor}
        GROUP BY 1
      ),
      bb AS (
        SELECT DISTINCT m.job_id
        FROM scope_mentions m JOIN jb ON jb.job_id = m.job_id
        LEFT JOIN names n ON n.entity_id = ${brand.rollup}
        WHERE m.brand_rollup_entity_id IS NOT NULL AND ${brand.rawName} IS NOT NULL
      ),
      cc AS (
        SELECT c.job_id, count(*)::int AS cits
        FROM scope_citations c JOIN jb ON jb.job_id = c.job_id GROUP BY 1
      )${x.ctes ?? sql``}
      INSERT INTO summary_answers
        (cycle_week, cycle_id, generation_id, ${sql.raw(COL_COMMON)},
         monitored, all_mentions, all_citations, has_any_brand${raw(x.columns)})
      SELECT ${keys.cycleWeek}::date, ${keys.cycleId}::uuid, ${keys.generationId}::uuid, ${D_COMMON},
             1, COALESCE(mm.mentions, 0), COALESCE(cc.cits, 0),
             CASE WHEN bb.job_id IS NOT NULL THEN 1 ELSE 0 END${x.select ?? sql``}
      FROM d LEFT JOIN mm ON mm.job_id = d.job_id
             LEFT JOIN bb ON bb.job_id = d.job_id
             LEFT JOIN cc ON cc.job_id = d.job_id${x.joins ?? sql``}
    `;
}

/** `summary_brand_mentions` (§3-4: 키는 (job, brand_id, brand_name)). 두 표면 동일. */
export function insertBrandMentionsSql(args: {
  keys: GenerationKeys;
  rollupNames: SQL;
  withCtes: SQL;
  brand: BrandExprs;
}): SQL {
  const { keys, brand } = args;
  return sql`
      WITH names AS ${args.rollupNames}, ${args.withCtes},
      mrows AS (
        SELECT m.job_id, ${brand.rollup} AS brand_id, ${brand.brandName} AS brand_name,
               (${brand.isCompetitor}) AS pass, m.mention_count, m.avg_position,
               m.sentiment_positive, m.sentiment_neutral, m.sentiment_negative, m.sentiment_mixed,
               m.type_mention, m.type_recommendation, m.type_comparison, m.type_definition, m.type_final_choice
        FROM scope_mentions m JOIN jb ON jb.job_id = m.job_id
        LEFT JOIN names n ON n.entity_id = ${brand.rollup}
        WHERE m.brand_rollup_entity_id IS NOT NULL AND ${brand.rawName} IS NOT NULL
      ),
      bg AS (
        SELECT job_id, brand_id, brand_name,
               bool_or(pass)::int AS is_competitor,
               sum(mention_count)::int AS mentions,
               min(avg_position)::real AS first_rank,
               sum(sentiment_positive)::int AS positive, sum(sentiment_neutral)::int AS neutral,
               sum(sentiment_negative)::int AS negative, sum(sentiment_mixed)::int AS mixed,
               sum(type_mention)::int AS type_mention, sum(type_recommendation)::int AS type_recommendation,
               sum(type_comparison)::int AS type_comparison, sum(type_definition)::int AS type_definition,
               sum(type_final_choice)::int AS type_final_choice
        FROM mrows GROUP BY 1,2,3
      )
      INSERT INTO summary_brand_mentions
        (cycle_week, cycle_id, generation_id, ${sql.raw(COL_COMMON)},
         brand_id, brand_name, is_competitor, mentions, first_rank,
         positive, neutral, negative, mixed,
         type_mention, type_recommendation, type_comparison, type_definition, type_final_choice)
      SELECT ${keys.cycleWeek}::date, ${keys.cycleId}::uuid, ${keys.generationId}::uuid, ${D_COMMON},
             bg.brand_id, bg.brand_name, bg.is_competitor, bg.mentions, bg.first_rank,
             bg.positive, bg.neutral, bg.negative, bg.mixed,
             bg.type_mention, bg.type_recommendation, bg.type_comparison, bg.type_definition, bg.type_final_choice
      FROM d JOIN bg ON bg.job_id = d.job_id
    `;
}

export type DomainCitationExtras = {
  /** `dg` SELECT 목록 꼬리(웹사이트 `unit_owned_citations`). */
  dgSelect?: SQL;
  /** `dg` FROM 절 꼬리(웹사이트의 `JOIN jb … LEFT JOIN runit unb …`). */
  dgFrom?: SQL;
  columns?: string;
  select?: SQL;
};

/** `summary_domain_citations` (§3-5: (job, group_key, matched_base)). */
export function insertDomainCitationsSql(args: {
  keys: GenerationKeys;
  /** `jb`·`d`·인용 CTE(`c2`/`un`/`ub`)까지 포함한 WITH 조각. */
  withCtes: SQL;
  extras?: DomainCitationExtras;
}): SQL {
  const { keys } = args;
  const x = args.extras ?? {};
  return sql`
      WITH ${args.withCtes},
      dg AS (
        SELECT c2.job_id, c2.gk AS group_key, min(c2.domain) AS domain,
               COALESCE(ub.matched_base, '') AS matched_base,
               max((ub.base IS NULL)::int) AS base_norm_null,
               count(*)::int AS citations${x.dgSelect ?? sql``}
        FROM c2 JOIN ub ON ub.uk = c2.uk${x.dgFrom ?? sql``}
        GROUP BY 1, 2, 4
      )
      INSERT INTO summary_domain_citations
        (cycle_week, cycle_id, generation_id, ${sql.raw(COL_COMMON)},
         group_key, domain, matched_base, base_norm_null, citations${raw(x.columns)})
      SELECT ${keys.cycleWeek}::date, ${keys.cycleId}::uuid, ${keys.generationId}::uuid, ${D_COMMON},
             dg.group_key, dg.domain, dg.matched_base, dg.base_norm_null, dg.citations${x.select ?? sql``}
      FROM d JOIN dg ON dg.job_id = d.job_id
    `;
}

/**
 * `summary_target_hits` (⑥ 전용, §3-5 v4.1 #4) — 웹사이트 표면만 만든다.
 * `withCtes` 는 `jb`·`d`·`targets`·인용 CTE 를 순서대로 담고 있어야 한다.
 */
export function insertTargetHitsSql(args: { keys: GenerationKeys; withCtes: SQL }): SQL {
  // `keys` 라는 CTE 이름이 SQL 안에 있어 JS 쪽은 `k` 로 받는다.
  const k = args.keys;
  return sql`
      WITH ${args.withCtes},
      base AS (
        SELECT c2.job_id, COALESCE(ub.matched_base_tracked, '') AS mbt, c2.uk, ub.trk
        FROM c2 JOIN ub ON ub.uk = c2.uk
      ),
      cnt AS (SELECT job_id, mbt, count(*)::int AS citations FROM base GROUP BY 1,2),
      keys AS (
        SELECT b.job_id, b.mbt, array_agg(DISTINCT t.key) AS target_keys
        FROM base b JOIN targets t ON t.turl = b.trk GROUP BY 1,2
      )
      INSERT INTO summary_target_hits
        (cycle_week, cycle_id, generation_id, job_id, prompt_id, engine, country, project_id, lang,
         run_status, matched_base_tracked, target_keys, citations)
      SELECT ${k.cycleWeek}::date, ${k.cycleId}::uuid, ${k.generationId}::uuid,
             d.job_id, d.prompt_id, d.engine, d.country, d.project_id, d.lang, d.run_status,
             cnt.mbt,
             CASE WHEN d.site_present = 1 THEN COALESCE(keys.target_keys, '{}') ELSE '{}' END,
             cnt.citations
      FROM d JOIN cnt ON cnt.job_id = d.job_id
             LEFT JOIN keys ON keys.job_id = cnt.job_id AND keys.mbt = cnt.mbt
    `;
}
