"""판정 입력 재판정(judgment_change IG-2 kind): 영향 차원 갱신 → 영향 답변 계산 → reproject.

kind 별 규칙(전체-통합 consistency_fixes 19, DB-보정 ingestion_flow 13)
  scope_prompt·catalog·prompt_kind   dim_taxon 새 코드 → rd.catalog_entry(해당 행) → dim_prompt(cat_mask·in_root_catalog·kind·funnel …) → 그 프롬프트 답변
  website_catalog                    rd.web_unit(유닛 판정 입력) → 웹사이트 프롬프트 dim_prompt(unit·targets·web_reg) → 바뀐 프롬프트·유닛 답변
  project_setting·project_owned_base·project_target_url  그 프로젝트(표면 3) 답변 전부(bgrp·loc_owned·tgt_hit 재판정)
  owned_base                         dim_url.owner_key 재판정 → 바뀐 URL 을 인용한 답변(cit_own_* 재계산 + 단언)
  citation_override                  출처 차원(카테고리·경쟁사 브랜드) 재판정 → 카테고리가 바뀐 출처를 인용한 답변 재투영
                                     (rd.answer.cit_off·cit_c1..13 재계산 + 단언, DB-v2.13·동기화 S1 BE-B·DB-v2.15 P86 WU-5)
  competitor_token                   출처 차원만(경쟁사 브랜드). 사실 행 불변(조회 시 dim_source 조인)
  hidden_market                      dim_country.hidden_standard → 글로벌 답변 중 그 국가(·region 없음) 답변
  rule_param                         default_engines → dim_engine.is_default → 그 엔진 답변(dflt). 회차 파라미터는 cycles_tick 이 반영
  entity·brand_rule                  표시 브랜드 차원(kind·own_bit·등록 역할) → 그 엔티티(엔티티) 또는 전 답변(규칙)의 언급·스탠스·ACR
프로젝트 한정 kind 는 rule_ver 를 올리지 않는다(현재 rule_set 최신값을 그대로 쓴다: 적재기는 app.rule_set 을 쓰지 않는다).
영향 답변이 상한(HGH_INGEST_ESCALATE_ANSWERS)을 넘으면 Escalated → 큐 행 escalated_rebuild(leaf 스왑 재구축 이관).
"""
from __future__ import annotations

import logging
from typing import Any

import asyncpg

from ingest.common.config import get_ingest_settings
from ingest.common.db import LoadContext, lock_dims
from ingest.common.rules import refresh_app_rules

from . import queries as q
from .service import ApplyResult, Escalated, project, refresh_web_report, refresh_web_target

log = logging.getLogger("hgh.ingest.rejudge")

PROJECT_KINDS = frozenset({"project_setting", "project_owned_base", "project_target_url"})
PROMPT_KINDS = frozenset({"scope_prompt", "catalog", "prompt_kind"})
GLOBAL_KINDS = frozenset({"entity", "brand_rule", "competitor_token", "hidden_market", "citation_override", "owned_base",
                          "website_catalog", "rule_param"})
IG2_KINDS = PROJECT_KINDS | PROMPT_KINDS | GLOBAL_KINDS

# ── SQL ──
TAXON_NEW = """
WITH rc AS (SELECT p.*, coalesce(p.brand_presence, CASE WHEN b.is_umbrella THEN 'unbranded' WHEN p.brand_code IS NOT NULL THEN 'branded' END) AS presence_res
              FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
              LEFT JOIN app.brand b ON b.brand_code = p.brand_code WHERE p.deleted_at IS NULL),
t AS (SELECT 'funnel' AS axis, funnel_stage AS code FROM app.prompt WHERE coalesce(funnel_stage, '') <> ''
      UNION SELECT 'presence', presence_res FROM rc WHERE presence_res IS NOT NULL
      UNION SELECT 'list_type', list_type FROM rc WHERE coalesce(list_type, '') <> ''
      UNION SELECT 'depth1', depth1 FROM rc WHERE coalesce(depth1, '') <> '')
INSERT INTO rd.dim_taxon (taxon_key, axis, code, parent_key)
SELECT ((SELECT coalesce(max(taxon_key), 0) FROM rd.dim_taxon) + row_number() OVER (ORDER BY t.axis, t.code))::int2, t.axis, t.code, NULL
  FROM t WHERE NOT EXISTS (SELECT 1 FROM rd.dim_taxon d WHERE d.axis = t.axis AND d.code = t.code AND d.parent_key IS NULL)
"""
TAXON_NEW_DEPTH = """
WITH rc AS (SELECT p.* FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root' WHERE p.deleted_at IS NULL),
y AS (SELECT DISTINCT d1.taxon_key AS pk, x.depth2 AS code
        FROM (SELECT DISTINCT nullif(depth1, '') AS depth1, depth2 FROM rc WHERE coalesce(depth2, '') <> '') x
        LEFT JOIN rd.dim_taxon d1 ON d1.axis = 'depth1' AND d1.code = x.depth1)
INSERT INTO rd.dim_taxon (taxon_key, axis, code, parent_key)
SELECT ((SELECT coalesce(max(taxon_key), 0) FROM rd.dim_taxon) + row_number() OVER (ORDER BY y.pk NULLS FIRST, y.code))::int2, 'depth2', y.code, y.pk
  FROM y WHERE NOT EXISTS (SELECT 1 FROM rd.dim_taxon d WHERE d.axis = 'depth2' AND d.code = y.code AND d.parent_key IS NOT DISTINCT FROM y.pk)
"""
TAXON_NEW_DEPTH3 = """
WITH rc AS (SELECT p.* FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root' WHERE p.deleted_at IS NULL),
y AS (SELECT DISTINCT d2.taxon_key AS pk, x.depth3 AS code
        FROM (SELECT DISTINCT nullif(depth1, '') AS depth1, nullif(depth2, '') AS depth2, depth3 FROM rc WHERE coalesce(depth3, '') <> '') x
        LEFT JOIN rd.dim_taxon d1 ON d1.axis = 'depth1' AND d1.code = x.depth1
        LEFT JOIN rd.dim_taxon d2 ON d2.axis = 'depth2' AND d2.code = x.depth2 AND d2.parent_key IS NOT DISTINCT FROM d1.taxon_key)
INSERT INTO rd.dim_taxon (taxon_key, axis, code, parent_key)
SELECT ((SELECT coalesce(max(taxon_key), 0) FROM rd.dim_taxon) + row_number() OVER (ORDER BY y.pk NULLS FIRST, y.code))::int2, 'depth3', y.code, y.pk
  FROM y WHERE NOT EXISTS (SELECT 1 FROM rd.dim_taxon d WHERE d.axis = 'depth3' AND d.code = y.code AND d.parent_key IS NOT DISTINCT FROM y.pk)
"""
# seed-30 §8 을 영향 행으로 좁힘: 해당 scope_prompt_id 의 루트 카탈로그 행 ∪ 페이로드 행(삭제·이동 포함) ∪ 기존 catalog_entry 의 그 프롬프트 행
CATALOG_REFRESH_DELETE = """
DELETE FROM rd.catalog_entry ce
 WHERE ce.catalog_row_id = ANY($2::uuid[])
    OR ce.catalog_row_id IN (SELECT p.prompt_id FROM app.prompt p WHERE p.scope_prompt_id = ANY($1::uuid[]))
    OR ce.prompt_key IN (SELECT d.prompt_key FROM rd.dim_prompt d WHERE d.prompt_id = ANY($1::uuid[]))
"""
CATALOG_REFRESH_INSERT = """
INSERT INTO rd.catalog_entry (catalog_row_id, prompt_key, brand_bit, presence_key, funnel_key, list_type_key, depth1_key, depth2_key,
                              depth3_key, kind, load_id)
SELECT c.prompt_id, dp.prompt_key, coalesce(b.brand_bit, u.brand_bit),
       tp.taxon_key, tf.taxon_key, tl.taxon_key, t1.taxon_key, t2.taxon_key, t3.taxon_key, c.kind, $3
  FROM (SELECT p.*, coalesce(p.brand_presence, CASE WHEN bb.is_umbrella THEN 'unbranded' WHEN p.brand_code IS NOT NULL THEN 'branded' END) AS presence_res
          FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
          LEFT JOIN app.brand bb ON bb.brand_code = p.brand_code
         WHERE p.deleted_at IS NULL AND (p.scope_prompt_id = ANY($1::uuid[]) OR p.prompt_id = ANY($2::uuid[]))) c
  CROSS JOIN (SELECT brand_bit FROM app.brand WHERE is_umbrella) u
  LEFT JOIN app.brand b ON b.brand_code = c.brand_code
  LEFT JOIN rd.dim_prompt dp ON dp.prompt_id = c.scope_prompt_id
  LEFT JOIN rd.dim_taxon tp ON tp.axis = 'presence' AND tp.code = c.presence_res
  LEFT JOIN rd.dim_taxon tf ON tf.axis = 'funnel' AND tf.code = c.funnel_stage
  LEFT JOIN rd.dim_taxon tl ON tl.axis = 'list_type' AND tl.code = c.list_type
  LEFT JOIN rd.dim_taxon t1 ON t1.axis = 'depth1' AND t1.code = c.depth1
  LEFT JOIN rd.dim_taxon t2 ON t2.axis = 'depth2' AND t2.code = c.depth2 AND t2.parent_key IS NOT DISTINCT FROM t1.taxon_key
  LEFT JOIN rd.dim_taxon t3 ON t3.axis = 'depth3' AND t3.code = c.depth3 AND t3.parent_key IS NOT DISTINCT FROM t2.taxon_key
"""
KEYS_OF_PROMPTS = "SELECT j.answer_key FROM rd.job j JOIN rd.dim_prompt d ON d.prompt_key = j.prompt_key WHERE d.prompt_id = ANY($1::uuid[])"
UNPROJECTED_OF_PROMPTS = """
SELECT k.answer_key FROM ing.answer a JOIN ing.answer_key_map k ON k.job_id = a.job_id
 WHERE a.prompt_id = ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM rd.job j WHERE j.answer_key = k.answer_key)
"""
PRS_OF_PROMPTS = "SELECT prompt_run_id FROM ing.acr_prompt_run WHERE prompt_id = ANY($1::uuid[])"
KEYS_OF_PROJECTS = """
SELECT j.answer_key FROM rd.job j JOIN rd.dim_project d ON d.project_key = j.project_key
 WHERE j.surface = 3 AND (d.project_id = ANY($1::uuid[]) OR d.scope_project_id = ANY($1::uuid[]))
"""
PRS_OF_PROJECTS = """
SELECT p.prompt_run_id FROM ing.acr_prompt_run p JOIN ing.run r ON r.run_id = p.run_id JOIN rd.dim_project d ON d.scope_project_id = r.scope_project_id
 WHERE d.project_id = ANY($1::uuid[]) OR d.scope_project_id = ANY($1::uuid[])
"""
OWNER_REFRESH = """
UPDATE rd.dim_url u SET owner_key = n.ok, rule_ver = $1
  FROM (SELECT url_key, pg_temp.owner_key_of(url_base_norm) AS ok FROM rd.dim_url WHERE url_key <> 0 AND coalesce(url_base_norm, '') <> '') n
 WHERE n.url_key = u.url_key AND u.owner_key IS DISTINCT FROM n.ok
RETURNING u.url_key
"""
KEYS_OF_URLS = """
SELECT DISTINCT j.answer_key FROM rd.citation c JOIN rd.job j ON j.surface = c.surface AND j.round_date = c.round_date AND j.answer_key = c.answer_key
 WHERE c.url_key = ANY($1::int4[])
"""
# RETURNING 의 x.category_key = 갱신 전 값(FROM 의 같은 표 사본), s.category_key = 갱신 뒤 값. off_flip = Official (HMG) 여부가 바뀜
#   (rd.answer.cit_off 가 바뀌는 출처, DB-v2.13 P71). 공식 카테고리 키는 app.citation_category name 으로 푼다(cit_off 적재 식과 같은 어휘).
SOURCE_CATEGORY_REFRESH = """
UPDATE rd.dim_source s SET category_key = cc.category_key, category_src = c.src, rule_ver = $1
  FROM rd.dim_source x CROSS JOIN LATERAL pg_temp.category_of(x.skey) c JOIN app.citation_category cc ON cc.name = c.cat
 WHERE s.source_key = x.source_key AND x.source_key <> 0 AND ($2::text[] IS NULL OR x.domain = ANY($2::text[]) OR x.skey = ANY($2::text[]))
   AND (s.category_key, s.category_src) IS DISTINCT FROM (cc.category_key, c.src)
RETURNING s.source_key,
          (x.category_key = (SELECT o.category_key FROM app.citation_category o WHERE o.name = 'Official (HMG)'))
            IS DISTINCT FROM (s.category_key = (SELECT o.category_key FROM app.citation_category o WHERE o.name = 'Official (HMG)')) AS off_flip
"""
# 출처를 인용한 서빙·비서빙 답변(재투영 대상, KEYS_OF_URLS 와 같은 모양). rd.citation 은 cit_source_idx(source_key, round_date)로 읽는다
KEYS_OF_SOURCES = """
SELECT DISTINCT j.answer_key FROM rd.citation c JOIN rd.job j ON j.surface = c.surface AND j.round_date = c.round_date AND j.answer_key = c.answer_key
 WHERE c.source_key = ANY($1::int4[])
"""
COMPETITOR_BRANDS = """
WITH own AS (SELECT lower(b.brand_code) AS bare, (CASE WHEN b.brand_bit IN (1, 2, 4) THEN b.brand_bit ELSE coalesce(pb.brand_bit, 0) END)::int2 AS bit
               FROM app.brand b LEFT JOIN app.brand pb ON pb.brand_code = b.parent_brand_code WHERE b.is_hmg_own AND NOT b.is_umbrella),
c AS (SELECT DISTINCT pg_temp.canon_brand(brand_name) AS name, pg_temp.brand_bare(brand_name) AS bare FROM app.competitor_domain_token)
INSERT INTO rd.dim_brand_name (name, bare, kind, own_bit)
SELECT c.name, c.bare, (CASE WHEN coalesce(o.bit, 0) <> 0 THEN 1 WHEN nc.name IS NOT NULL THEN 3 ELSE 2 END)::int2, coalesce(o.bit, 0::int2)
  FROM c LEFT JOIN own o ON o.bare = lower(pg_temp.js_trim(c.bare)) LEFT JOIN app.non_competitor_name nc ON nc.name = lower(pg_temp.js_trim(c.bare))
 WHERE c.bare <> '' AND NOT EXISTS (SELECT 1 FROM rd.dim_brand_name b WHERE b.bare = c.bare OR b.name = c.name)   -- 이름 UNIQUE(NAME 스위치 전환 중 혼합 상태 방어)
 ORDER BY c.bare
"""
SOURCE_COMPETITOR_REFRESH = """
UPDATE rd.dim_source s SET competitor_brand_key = n.bk, rule_ver = $1
  FROM (SELECT x.source_key, CASE WHEN cc.name = 'Official (Competitor)' THEN b.brand_key END AS bk
          FROM rd.dim_source x JOIN app.citation_category cc ON cc.category_key = x.category_key
          LEFT JOIN rd.dim_brand_name b ON b.bare = pg_temp.brand_bare(pg_temp.competitor_brand_of(x.domain))
         WHERE x.source_key <> 0) n
 WHERE n.source_key = s.source_key AND s.competitor_brand_key IS DISTINCT FROM n.bk
RETURNING s.source_key
"""
HIDDEN_REFRESH = """
UPDATE rd.dim_country g SET hidden_standard = n.h
  FROM (SELECT geo_key, EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.surface = 'global' AND upper(h.country_code) = upper(x.code)) AS h FROM rd.dim_country x) n
 WHERE n.geo_key = g.geo_key AND g.hidden_standard IS DISTINCT FROM n.h
RETURNING g.geo_key
"""
KEYS_OF_GEOS = "SELECT answer_key FROM rd.job WHERE surface = 1 AND geo_key = ANY($1::int2[])"
DEFAULT_ENGINE_REFRESH = """
UPDATE rd.dim_engine e SET is_default = n.d
  FROM (SELECT engine_key, code IN (SELECT jsonb_array_elements_text(value) FROM app.rule_param WHERE key = 'default_engines') AS d
          FROM rd.dim_engine WHERE engine_key <> 0) n
 WHERE n.engine_key = e.engine_key AND e.is_default IS DISTINCT FROM n.d
RETURNING e.engine_key
"""
KEYS_OF_ENGINES = "SELECT answer_key FROM rd.job WHERE engine_key = ANY($1::int2[])"
BRAND_KIND_REFRESH = """
WITH own AS (SELECT lower(b.brand_code) AS bare, (CASE WHEN b.brand_bit IN (1, 2, 4) THEN b.brand_bit ELSE coalesce(pb.brand_bit, 0) END)::int2 AS bit
               FROM app.brand b LEFT JOIN app.brand pb ON pb.brand_code = b.parent_brand_code WHERE b.is_hmg_own AND NOT b.is_umbrella),
n AS (SELECT d.brand_key, coalesce(o.bit, 0::int2) AS own_bit,
             (CASE WHEN coalesce(o.bit, 0) <> 0 THEN 1 WHEN nc.name IS NOT NULL THEN 3 ELSE 2 END)::int2 AS kind
        FROM rd.dim_brand_name d LEFT JOIN own o ON o.bare = lower(pg_temp.js_trim(d.bare))
        LEFT JOIN app.non_competitor_name nc ON nc.name = lower(pg_temp.js_trim(d.bare))
       WHERE d.brand_key <> 0)
UPDATE rd.dim_brand_name d SET own_bit = n.own_bit, kind = n.kind FROM n
 WHERE n.brand_key = d.brand_key AND (d.own_bit, d.kind) IS DISTINCT FROM (n.own_bit, n.kind)
RETURNING d.brand_key
"""
REGISTRY_ROLE_REFRESH = """
UPDATE rd.dim_entity d SET registry_role = r.role
  FROM (SELECT e.entity_id, g.role FROM rd.dim_entity e LEFT JOIN app.entity_registry g ON g.entity_id = e.entity_id) r
 WHERE r.entity_id = d.entity_id AND d.registry_role IS DISTINCT FROM r.role
"""
KEYS_OF_ENTITIES = """
WITH ids AS (SELECT unnest($1::uuid[]) AS e UNION SELECT alias_id FROM _alias_map WHERE canon_id = ANY($1::uuid[])
             UNION SELECT canon_id FROM _alias_map WHERE alias_id = ANY($1::uuid[])),
jobs AS (SELECT job_id FROM ing.mention WHERE brand_rollup_entity_id IN (SELECT e FROM ids) OR entity_id IN (SELECT e FROM ids)
         UNION SELECT job_id FROM ing.answer_stance WHERE entity_id IN (SELECT e FROM ids))
SELECT j.answer_key FROM rd.job j WHERE j.job_id IN (SELECT job_id FROM jobs)
"""
PRS_OF_ENTITIES = """
SELECT DISTINCT prompt_run_id FROM ing.acr_rollup_row WHERE entity_id = ANY($1::uuid[]) OR brand_rollup_entity_id = ANY($1::uuid[])
"""
KEYS_WITH_BRANDS = """
SELECT j.answer_key FROM rd.job j WHERE j.served AND EXISTS (
  SELECT 1 FROM ing.answer_key_map k JOIN ing.mention m ON m.run_month = k.run_month AND m.job_id = k.job_id WHERE k.answer_key = j.answer_key
  UNION ALL SELECT 1 FROM ing.answer_key_map k JOIN ing.answer_stance s ON s.run_month = k.run_month AND s.job_id = k.job_id WHERE k.answer_key = j.answer_key)
"""
ALL_PRS = "SELECT prompt_run_id FROM ing.acr_prompt_run"
# seed-30 §6 rd.web_unit 전량 재계산(유닛 = 사이트 × file_seq, 소규모). 키는 (project_key, file_seq) 로 유지하고 새 유닛만 max+1.
WEB_UNIT_REFRESH = """
DROP TABLE IF EXISTS _rj_wu;
CREATE TEMP TABLE _rj_wu ON COMMIT DROP AS
WITH wp AS (
  SELECT wp.site_id, wp.file_seq, nullif(wp.owned_base_url, '') AS decl, pg_temp.cit_base_norm(wp.target_url) AS turl_base, wp.scope_prompt_id
    FROM app.website_prompt wp WHERE wp.scope_prompt_id IS NOT NULL AND wp.file_seq IS NOT NULL),
u AS (SELECT DISTINCT site_id, file_seq FROM wp),
decl AS (SELECT DISTINCT ON (site_id, file_seq) site_id, file_seq, decl AS base
           FROM (SELECT site_id, file_seq, decl, count(*) AS n FROM wp WHERE decl IS NOT NULL GROUP BY 1, 2, 3) d
          ORDER BY site_id, file_seq, n DESC, decl),
heur AS (SELECT DISTINCT ON (site_id, file_seq) site_id, file_seq, k AS base
           FROM (SELECT site_id, file_seq,
                        CASE WHEN split_part(turl_base, '/', 1) IN (SELECT host FROM _r_shared_host) AND split_part(turl_base, '/', 2) <> ''
                             THEN split_part(turl_base, '/', 1) || '/' || split_part(turl_base, '/', 2) ELSE split_part(turl_base, '/', 1) END AS k,
                        count(*) AS n
                   FROM wp WHERE coalesce(turl_base, '') <> '' GROUP BY 1, 2, 3) h
          ORDER BY site_id, file_seq, n DESC, k),
proj AS (SELECT DISTINCT ON (wp.site_id, wp.file_seq) wp.site_id, wp.file_seq, ip.scope_project_id
           FROM wp JOIN ing.prompt ip ON ip.scope_prompt_id = wp.scope_prompt_id
          GROUP BY 1, 2, 3 ORDER BY wp.site_id, wp.file_seq, count(*) DESC, ip.scope_project_id)
SELECT u.site_id, u.file_seq, coalesce(s.scope_project_id, pj.scope_project_id) AS scope_project_id,
       nullif(pg_temp.owned_prefix(coalesce(d.base, h.base)), '') AS base,
       CASE WHEN d.base IS NOT NULL THEN 'decl' WHEN h.base IS NOT NULL THEN 'heur' END AS base_src
  FROM u JOIN app.website_site s ON s.site_id = u.site_id
  LEFT JOIN decl d ON d.site_id = u.site_id AND d.file_seq = u.file_seq
  LEFT JOIN heur h ON h.site_id = u.site_id AND h.file_seq = u.file_seq
  LEFT JOIN proj pj ON pj.site_id = u.site_id AND pj.file_seq = u.file_seq;
UPDATE _rj_wu SET base_src = NULL WHERE base IS NULL;
DROP TABLE IF EXISTS _rj_decl;
CREATE TEMP TABLE _rj_decl ON COMMIT DROP AS
SELECT DISTINCT pg_temp.owned_prefix(owned_base_url) AS q FROM app.website_prompt WHERE coalesce(owned_base_url, '') <> '';
DELETE FROM _rj_decl WHERE coalesce(q, '') = '';
DROP TABLE IF EXISTS _rj_wun;
CREATE TEMP TABLE _rj_wun ON COMMIT DROP AS
WITH ku AS (SELECT DISTINCT ON (dp.project_key, w.file_seq) dp.project_key, w.*
              FROM _rj_wu w JOIN rd.dim_project dp ON dp.scope_project_id = w.scope_project_id ORDER BY dp.project_key, w.file_seq, w.site_id)
SELECT ku.project_key, ku.file_seq,
       coalesce((SELECT array_agg(DISTINCT lower(wp.lang_code) ORDER BY lower(wp.lang_code)) FROM app.website_prompt wp
                  WHERE wp.site_id = ku.site_id AND wp.file_seq = ku.file_seq AND coalesce(wp.lang_code, '') <> ''), '{}') AS lang_codes,
       ku.base, ku.base_src,
       CASE WHEN ku.base IS NULL THEN '{}'::text[] ELSE
         coalesce((SELECT array_agg(q ORDER BY q) FROM _rj_decl WHERE length(q) > length(ku.base) AND starts_with(q, ku.base || '/')), '{}') END AS sibs,
       CASE WHEN ku.base IS NOT NULL AND split_part(ku.base, '/', 1) NOT IN (SELECT host FROM _r_shared_host) THEN split_part(ku.base, '/', 1) END AS home_host,
       coalesce((SELECT array_agg(DISTINCT pg_temp.cit_norm(wp.target_url) ORDER BY pg_temp.cit_norm(wp.target_url)) FROM app.website_prompt wp
                  WHERE wp.site_id = ku.site_id AND wp.file_seq = ku.file_seq AND coalesce(wp.target_url, '') <> ''), '{}') AS turls
  FROM ku;
"""
WEB_UNIT_UPDATE = """
UPDATE rd.web_unit w SET lang_codes = n.lang_codes, base = n.base, base_src = n.base_src, sibs = n.sibs, home_host = n.home_host, turls = n.turls,
       rule_ver = $1
  FROM _rj_wun n WHERE n.project_key = w.project_key AND n.file_seq = w.file_seq
   AND (w.lang_codes, w.base, w.base_src, w.sibs, w.home_host, w.turls) IS DISTINCT FROM (n.lang_codes, n.base, n.base_src, n.sibs, n.home_host, n.turls)
RETURNING w.unit_key
"""
WEB_UNIT_INSERT = """
INSERT INTO rd.web_unit (unit_key, project_key, file_seq, lang_codes, base, base_src, sibs, home_host, turls, rule_ver)
SELECT ((SELECT coalesce(max(unit_key), 0) FROM rd.web_unit) + row_number() OVER (ORDER BY n.project_key, n.file_seq))::int2,
       n.project_key, n.file_seq, n.lang_codes, n.base, n.base_src, n.sibs, n.home_host, n.turls, $1
  FROM _rj_wun n WHERE NOT EXISTS (SELECT 1 FROM rd.web_unit w WHERE w.project_key = n.project_key AND w.file_seq = n.file_seq)
RETURNING unit_key
"""
WEBSITE_PROMPTS = "SELECT DISTINCT scope_prompt_id FROM app.website_prompt WHERE scope_prompt_id IS NOT NULL"
KEYS_OF_UNITS = "SELECT j.answer_key FROM rd.job j JOIN rd.dim_prompt d ON d.prompt_key = j.prompt_key WHERE d.unit_key = ANY($1::int2[])"


async def _refresh_prompts(conn: asyncpg.Connection, ctx: LoadContext, prompt_ids: list[Any]) -> list[int]:
    """기존 dim_prompt 재판정(없는 프롬프트는 project() 의 새 프롬프트 경로가 넣는다). 반환 = 바뀐 prompt_key."""
    await conn.execute("DROP TABLE IF EXISTS _ig_rp; CREATE TEMP TABLE _ig_rp (prompt_id uuid PRIMARY KEY) ON COMMIT DROP")
    await conn.execute("INSERT INTO _ig_rp SELECT DISTINCT p FROM unnest($1::uuid[]) p WHERE p IS NOT NULL ON CONFLICT DO NOTHING", prompt_ids)
    return [r[0] for r in await conn.fetch(q.DIM_PROMPT_REFRESH, ctx.rule_ver)]


async def _merge_app_countries(conn: asyncpg.Connection) -> None:
    """app 원천 국가 표기 전부를 rd.dim_country 에 병합(DIM_COUNTRY 정본 규칙, 검증 F1·F3): 새 코드는 넣고 표기가 새 승자와 다른 기존 행은 고친다."""
    await conn.execute(q.DIM_COUNTRY, [r[0] for r in await conn.fetch(q.APP_COUNTRY_CODES)])


async def _keys(conn: asyncpg.Connection, sql: str, *args: Any) -> list[int]:
    return [int(r[0]) for r in await conn.fetch(sql, *args)]


async def rejudge(conn: asyncpg.Connection, ctx: LoadContext, kind: str, *, subject_uuids: list[Any] | None = None,
                  subject_texts: list[str] | None = None, payload: dict[str, Any] | None = None,
                  escalate_at: int | None = None) -> ApplyResult:
    """judgment_change 한 행의 IG-2 재판정. 반환 = 재투영 결과(사실 행 불변 kind 는 빈 결과 + ctx.rd_changed)."""
    if kind not in IG2_KINDS:
        raise ValueError(f"IG-2 재판정 kind 아님: {kind}")
    subj = list(subject_uuids or [])
    texts = list(subject_texts or []) or None
    limit = escalate_at if escalate_at is not None else get_ingest_settings().escalate_answers
    await refresh_app_rules(conn)
    await lock_dims(conn)
    keys: list[int] = []
    prs: list[Any] = []
    prompts: list[Any] = []
    ents: list[Any] = []

    if kind in PROMPT_KINDS:
        rows = list(subj)
        for part in ("old", "new"):
            v = (payload or {}).get(part) or {}
            if v.get("scope_prompt_id"):
                rows.append(v["scope_prompt_id"])
        prompts = sorted({str(x) for x in rows})
        row_ids = [payload["prompt_id"]] if payload and payload.get("prompt_id") else []
        if kind != "scope_prompt":
            await conn.execute(TAXON_NEW)
            await conn.execute(TAXON_NEW_DEPTH)
            await conn.execute(TAXON_NEW_DEPTH3)
        await _refresh_prompts(conn, ctx, prompts)
        keys = await _keys(conn, KEYS_OF_PROMPTS, prompts) + await _keys(conn, UNPROJECTED_OF_PROMPTS, prompts)
        prs = [r[0] for r in await conn.fetch(PRS_OF_PROMPTS, prompts)]
        res = await project(conn, ctx, [], extra_keys=keys, extra_prompts=prompts, extra_prompt_runs=prs, detect_global=False, escalate_at=limit)
        if kind != "scope_prompt":
            await conn.execute(CATALOG_REFRESH_DELETE, prompts, row_ids)
            await conn.execute(CATALOG_REFRESH_INSERT, prompts, row_ids, ctx.load_id)
        ctx.rd_changed = True
        ctx.surfaces |= {1, 2, 3} if not res.surfaces else res.surfaces
        return res

    if kind == "website_catalog":
        await _merge_app_countries(conn)
        await conn.execute(WEB_UNIT_REFRESH)
        units = await _keys(conn, WEB_UNIT_UPDATE, ctx.rule_ver) + await _keys(conn, WEB_UNIT_INSERT, ctx.rule_ver)
        prompts = [r[0] for r in await conn.fetch(WEBSITE_PROMPTS)] + subj
        changed = await _refresh_prompts(conn, ctx, prompts)
        await refresh_web_report(conn, None)         # WEBREG16(DB-v2.16): 사이트·프롬프트·언어·타겟이 바뀌면 보고서 유닛 소속도 다시 판정(전체 약 35ms)
        await refresh_web_target(conn, None, None)   # WU-12(DB-v2.20): 타겟이 바뀌면 사전 해석 전체(stg 약 0.8초)
        keys = await _keys(conn, "SELECT answer_key FROM rd.job WHERE prompt_key = ANY($1::int4[])", changed)
        if units:
            keys += await _keys(conn, KEYS_OF_UNITS, units)
        keys += await _keys(conn, UNPROJECTED_OF_PROMPTS, prompts)
        prs = [r[0] for r in await conn.fetch(PRS_OF_PROMPTS, prompts)]
        ctx.rd_changed = True
        ctx.surfaces.add(2)
    elif kind in PROJECT_KINDS:
        await _merge_app_countries(conn)             # 프로젝트 국가 표기(app.project.country_code)가 정본 후보가 된다(검증 F3)
        keys = await _keys(conn, KEYS_OF_PROJECTS, subj)
        prs = [r[0] for r in await conn.fetch(PRS_OF_PROJECTS, subj)]
    elif kind == "owned_base":
        await _merge_app_countries(conn)             # owned base geo_code 표기(검증 F3)
        urls = await _keys(conn, OWNER_REFRESH, ctx.rule_ver)
        if urls:
            keys = await _keys(conn, KEYS_OF_URLS, urls)
            ctx.rd_changed = True
            ctx.surfaces |= {1, 2, 3}
    elif kind == "citation_override":
        # 카테고리가 바뀌면 경쟁사 브랜드도 따라 바뀐다(seed-30 §11: Official (Competitor) 일 때만 채움, 결함 D1).
        # 경쟁사 표시 브랜드 이름은 토큰 표에서 이미 발급돼 있지만 없으면 채운다(competitor_token 과 같은 순서).
        cat = await conn.fetch(SOURCE_CATEGORY_REFRESH, ctx.rule_ver, texts)
        n1 = await conn.execute(COMPETITOR_BRANDS)
        comp = await conn.fetch(SOURCE_COMPETITOR_REFRESH, ctx.rule_ver)
        if cat or comp or not str(n1).endswith(" 0"):
            ctx.rd_changed = True
            ctx.surfaces |= {1, 2, 3}
        # 카테고리가 바뀐 출처 → 그 출처를 인용한 답변의 cit_off(글로벌 ⑤ 분자, 공식(HMG) 여부가 바뀐 때)와 cit_c1..13(DB-v2.15 P86 카테고리별
        # 인용 수, 인용 성능 수정안 B·WU-5: 카테고리가 바뀌면 항상)이 바뀐다: apply.project 재투영(같은 트랜잭션, 끝에서
        # rd.assert_answer_cit_counts 엄격 단언 + ASSERT_CIT_EXT). 종전에는 공식 여부가 바뀐 출처만 재투영했다(off_flip).
        changed = sorted(int(r["source_key"]) for r in cat)
        if changed:
            keys = await _keys(conn, KEYS_OF_SOURCES, changed)
    elif kind == "competitor_token":
        n1 = await conn.execute(COMPETITOR_BRANDS)
        n2 = await conn.fetch(SOURCE_COMPETITOR_REFRESH, ctx.rule_ver)
        if n2 or not str(n1).endswith(" 0"):
            ctx.rd_changed = True
            ctx.surfaces |= {1, 2, 3}
    elif kind == "hidden_market":
        await _merge_app_countries(conn)             # 숨김 시장 표기(검증 F3). 병합이 고친 행의 hidden_standard 도 여기서 맞는다
        geos = await _keys(conn, HIDDEN_REFRESH)
        keys = await _keys(conn, KEYS_OF_GEOS, geos) if geos else []
        # 글로벌 숨김 시장 집합이 비었다/생겼다 → region 없음 답변의 elig 가 바뀐다(rootHiddenRegionsExclusion 3치 논리)
        keys += await _keys(conn, "SELECT answer_key FROM rd.job WHERE surface = 1 AND geo_key = 0")
        prs = [r[0] for r in await conn.fetch(
            "SELECT p.prompt_run_id FROM ing.acr_prompt_run p JOIN rd.dim_country g ON upper(g.code) = upper(p.region) WHERE g.geo_key = ANY($1::int2[])", geos)]
        if geos:
            ctx.rd_changed = True
            ctx.surfaces |= {1}
    elif kind == "rule_param":
        engines = await _keys(conn, DEFAULT_ENGINE_REFRESH)
        if engines:
            keys = await _keys(conn, KEYS_OF_ENGINES, engines)
            ctx.rd_changed = True
            ctx.surfaces |= {1, 2, 3}
    elif kind in ("entity", "brand_rule"):
        if await conn.fetch(BRAND_KIND_REFRESH):
            ctx.rd_changed = True
            ctx.surfaces |= {1, 2, 3}
        await conn.execute(REGISTRY_ROLE_REFRESH)
        if kind == "entity" and subj:
            keys = await _keys(conn, KEYS_OF_ENTITIES, subj)
            prs = [r[0] for r in await conn.fetch(PRS_OF_ENTITIES, subj)]
        else:
            keys = await _keys(conn, KEYS_WITH_BRANDS)
            prs = [r[0] for r in await conn.fetch(ALL_PRS)]
            # 표시 브랜드 규칙(별칭 등)이 바뀌면 엔티티 차원의 표시 브랜드 키(rd.dim_entity.brand_key = 언급 표기 쌍의 최빈 bare)도 바뀔 수 있다.
            # 재투영 답변만으로는 _ig_ent_ids(바뀐 job 의 엔티티)에 들지 않아 차원이 옛 키로 남는다(bulk 와 다름). 현행 프로필 NAME 은
            # 대소문자 별칭('TOYOTA' → 'Toyota')도 키를 바꾸므로 드러났다(be/int3-name2). 전 엔티티를 차원 재계산 대상으로 넣는다.
            ents = [r[0] for r in await conn.fetch("SELECT entity_id FROM rd.dim_entity")]

    keys = sorted(set(keys))
    if len(keys) > limit:
        raise Escalated(len(keys), limit)
    if not keys and not prs:
        return ApplyResult()
    return await project(conn, ctx, [], extra_keys=keys, extra_prompt_runs=prs, extra_entities=ents or None, detect_global=False,
                         escalate_at=limit, repick_names=kind in ("brand_rule", "entity", "competitor_token"))


__all__ = ["GLOBAL_KINDS", "IG2_KINDS", "PROJECT_KINDS", "PROMPT_KINDS", "Escalated", "rejudge"]
