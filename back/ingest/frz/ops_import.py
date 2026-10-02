"""운영 summary 활성 세대 → 허브 동결 층(frz) 이관 적재기(결정 32, DB-v2.21, card-snapshot-design.md 12장).

무엇을 옮기나(사실 행 전체 복사 없음)
  - 셀 집합: mig_src.frz_ops_cell(운영 summary_cycle_jobs 활성 세대) → frz.cell. job_id → rd.job(answer_key·프롬프트·엔진·지역 키).
    좌석 = 운영 회차(ing.cycle.cycle_id = 운영 cycle_id)의 rd.cycle(cyc_key·round_date·surface).
  - 프롬프트 축: mig_src.frz_ops_prompt(운영 summary_prompt_dim) → frz.prompt(in_full_cycle·카탈로그 비트·퍼널·depth·report_fs, 원값 src).
  - 판정 입력: 운영 세대 스냅샷 4종 → frz.ops_judgment(감사 사본), frz.generation.judgment = 세대 id·스냅샷 md5(버전 포인터).
  - S4(DB-v2.24): 웹 셀 판정 mig_src.frz_ops_web(운영 summary_answers 유닛 플래그·summary_url_hits) → frz.cell_web(웹 셀 전부, 빠지면 실패),
    택소노미 축 frz.prompt.src(운영 원값) → frz.prompt_axis, 브랜드 표시명 frz._bake_names(이관 시점 rd 이름).
  - 보관(바뀐 답변만):
      ops  = 운영 미러에서 동기화 지문이 바뀐 run 의 답변(mig_src.frz_ops_changed). 운영 세부층 행(frz_ops_brand)을 허브 행 모양으로 바꾼
             값이 지금 rd 와 다르면 그 값을 보관한다(언급 계열: answer_brand 행 + 답변 당사 열). 인용은 운영에서 바뀐 답변이 0 이라
             지금 rd 행을 그대로 쓰고, 인용 수가 다른 답변은 변환 실패로 멈춘다.
      seat = rd 행 좌석(cyc_key·round_date)이 동결 좌석과 다른 답변: 지금 rd 행을 보관하고 뷰가 좌석을 셀 값으로 바꿔 낸다.
  - 단언(회차마다, 활성화 뒤 같은 트랜잭션): frz.assert_generation + 축 합 대조(mig_src.frz_ops_sum_*: 운영 summary_trend_* 합)
      answers 축: 셀 수·in_full_cycle 셀 수·all_mentions(Σ ment_total)·all_citations(Σ cit_n_all)·has_any_brand
      브랜드 축(brand_name): mentions·answers(Σ rid_n = (답변, 롤업) 수)·comp_rank_sum(Σ rk)·comp_ranked_answers
      당사 축(own_variant): tracked_answers·own_mentions·own_positive·own_negative·own_signals (ALL = 당사 비트 전부, 그 밖 = rd.dim_brand_name
      의 같은 이름 행 own_bit: 테넌트 이름을 코드에 박지 않는다)
      도메인 축: 인용 원소 수(Σ citations)
    하나라도 다르면 그 회차는 적재하지 않는다(트랜잭션 롤백, 결과에 축별 차이).
  - 운영 summary 접기(현행 프로필 brand_card_fold, DB-v2.27): ops·seat 보관 뒤 공존 답변을 접어 보관한다(ingest.frz.fold, src 'fold').
    운영 all_mentions(summary_answers, 언급 행 단위 경쟁)는 접기 전 값이라 단언은 Σ ment_total − 접기 차(보관 답변의 접힌 ment_total − rd ment_total)로
    대조하고, 선택 입력 mig_src.frz_ops_sum_comp(운영 trend_own comp_mentions = 카드 점유율 분모)가 있으면 Σ ment_total 을 그 값과 대조한다.
트랜잭션: 회차 1개 = 트랜잭션 1개(원자 교체: 옛 세대 해제 → 새 세대 → 활성화 → 단언). 드라이런(기본)은 끝에서 롤백.
멱등: 같은 운영 세대가 이미 활성이면 건너뛴다(--force 면 다시 만든다). 추출 중 재생성된 회차(시작·끝 마커 불일치)는 건너뛴다.
잠금: 회차 표면의 적재 잠금(NS_SURFACE 배타, 적재기·재판정과 직렬). 적재 워커는 멈추고 돌리는 것이 절차다.
롤: migrator(mig_src 읽기·frz 쓰기). 출력 = 개수·회차 키·8자 접두만(비밀값·URL 없음).
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any

import asyncpg

from ingest.common.db import NS_SURFACE
from ingest.frz import fold as frz_fold

# ── 입력 존재·권한 ───────────────────────────────────────────────────────────
INPUT_TABLES = ("frz_ops_marker", "frz_ops_generation", "frz_ops_cell", "frz_ops_prompt", "frz_ops_changed", "frz_ops_answer",
                "frz_ops_brand", "frz_ops_sum_cycle", "frz_ops_sum_brand", "frz_ops_sum_own", "frz_ops_web", "frz_ops_url_cov")
INPUT_CHECK = """
SELECT t, to_regclass('mig_src.' || t) IS NOT NULL AND has_table_privilege(('mig_src.' || t)::regclass, 'select') AS ok
  FROM unnest($1::text[]) t
"""

# 이관 대상 회차: 시작 마커의 활성 세대(끝 마커와 같아야 한다 = 추출 중 재생성 없음)
CYCLES = """
SELECT s.cycle_id, s.surface AS ops_surface, s.active_generation_id AS generation_id,
       (e.active_generation_id IS NOT DISTINCT FROM s.active_generation_id) AS stable,
       c.cyc_key, rc.surface, rc.round_date
  FROM mig_src.frz_ops_marker s
  LEFT JOIN mig_src.frz_ops_marker e ON e.phase = 'end' AND e.cycle_id = s.cycle_id
  LEFT JOIN ing.cycle c ON c.cycle_id = s.cycle_id
  LEFT JOIN rd.cycle rc ON rc.cyc_key = c.cyc_key
 WHERE s.phase = 'start' AND ($1::uuid[] IS NULL OR s.cycle_id = ANY ($1::uuid[]))
 ORDER BY rc.round_date NULLS LAST, s.cycle_id
"""

ACTIVE_GEN = "SELECT gen_key, ops_generation_id FROM frz.generation WHERE cyc_key = $1 AND state = 'active'"

NEW_GEN = """
INSERT INTO frz.generation (cyc_key, surface, source, ops_cycle_id, ops_generation_id, ops_generator_version, ops_started_at, ops_finished_at,
                            judgment)
SELECT $1::int4, $2::int2, 'ops', g.cycle_id, g.generation_id, g.generator_version, g.started_at, g.finished_at,
       jsonb_build_object('ops_generation_id', g.generation_id, 'generator_version', g.generator_version,
                          'roster_md5', md5(coalesce(g.roster_snapshot::text, '')), 'base_md5', md5(coalesce(g.base_universe::text, '')),
                          'target_md5', md5(coalesce(g.target_universe::text, '')), 'noise_md5', md5(coalesce(g.noise_snapshot::text, '')))
  FROM mig_src.frz_ops_generation g WHERE g.generation_id = $3::uuid AND g.cycle_id = $4::uuid
RETURNING gen_key
"""
NEW_JUDGMENT = """
INSERT INTO frz.ops_judgment (gen_key, roster_snapshot, base_universe, target_universe, noise_snapshot)
SELECT $1::int4, g.roster_snapshot, g.base_universe, g.target_universe, g.noise_snapshot FROM mig_src.frz_ops_generation g WHERE g.generation_id = $2
"""

# 회차 인자(임시 표): CREATE TABLE AS 같은 유틸리티 문장은 바인드 인자를 받지 않으므로 아래 문장들은 이 표를 조인한다
ARGS = """
DROP TABLE IF EXISTS _fz_arg;
CREATE TEMP TABLE _fz_arg (cycle_id uuid NOT NULL, generation_id uuid NOT NULL, surface int2 NOT NULL, cyc_key int4 NOT NULL,
                           round_date date NOT NULL) ON COMMIT DROP;
"""
ARGS_SET = "INSERT INTO _fz_arg VALUES ($1::uuid, $2::uuid, $3::int2, $4::int4, $5::date)"

# ── 셀 ─────────────────────────────────────────────────────────────────────
# 운영 셀 → rd.job. src_* = rd 행 실제 위치(좌석이 다르면 보관 seat 로 옮긴다). served = 그 위치에 rd.answer 행이 있다
CELL_MAP = """
DROP TABLE IF EXISTS _fz_cell;
CREATE TEMP TABLE _fz_cell ON COMMIT DROP AS
SELECT o.job_id, j.answer_key, j.surface AS src_surface, j.round_date AS src_round_date, j.cyc_key AS src_cyc_key,
       j.prompt_key, j.engine_key, j.geo_key,
       EXISTS (SELECT 1 FROM rd.answer a WHERE a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key) AS served
  FROM _fz_arg g JOIN mig_src.frz_ops_cell o ON o.cycle_id = g.cycle_id AND o.generation_id = g.generation_id
  LEFT JOIN rd.job j ON j.job_id = o.job_id;
"""
CELL_FAILS = """
SELECT count(*) FILTER (WHERE answer_key IS NULL) AS job_unmapped,
       count(*) FILTER (WHERE answer_key IS NOT NULL AND NOT served) AS answer_missing,
       count(*) FILTER (WHERE answer_key IS NOT NULL AND served AND src_surface <> $1) AS surface_mismatch,
       count(*) FILTER (WHERE answer_key IS NOT NULL AND served AND src_surface = $1 AND (src_cyc_key <> $2 OR src_round_date <> $3)) AS seat_moved,
       count(*) AS cells,
       (SELECT count(*) FROM (SELECT answer_key FROM _fz_cell WHERE answer_key IS NOT NULL GROUP BY 1 HAVING count(*) > 1) d) AS dup_answers,
       coalesce(array_agg(left(job_id::text, 8) ORDER BY job_id) FILTER (WHERE answer_key IS NULL OR NOT served OR src_surface <> $1), '{}') AS fail_jobs
  FROM _fz_cell
"""
CELL_INSERT = """
INSERT INTO frz.cell (gen_key, answer_key, surface, cyc_key, round_date, prompt_key, engine_key, geo_key)
SELECT $1::int4, answer_key, $2::int2, $3::int4, $4::date, prompt_key, engine_key, geo_key
  FROM _fz_cell WHERE answer_key IS NOT NULL AND served AND src_surface = $2::int2
"""

# ── 프롬프트 축 ──────────────────────────────────────────────────────────────
# 카탈로그 비트 = 운영 catalog_brands 이름의 rd.dim_brand_name 당사 비트(kind 1). 퍼널·depth = rd.dim_taxon(axis, code, 부모).
PROMPT_INSERT = """
INSERT INTO frz.prompt (gen_key, prompt_key, cyc_key, in_full_cycle, expected_cells, window_cells, in_root_catalog, catalog_deleted, cat_mask,
                        funnel_key, presence_key, list_type_key, depth1_key, depth2_key, depth3_key, regions, is_korean, report_fs, src)
SELECT $1::int4, d.prompt_key, $2::int4, p.in_full_cycle = 1, p.expected_cells, p.window_cells, p.in_root_catalog = 1, p.catalog_deleted = 1,
       coalesce((SELECT bit_or(n.own_bit) FROM unnest(p.catalog_brands) b(name) JOIN rd.dim_brand_name n ON n.name = b.name AND n.kind = 1), 0)::int2,
       coalesce(tf.taxon_key, 0), tp.taxon_key, tl.taxon_key, t1.taxon_key, t2.taxon_key, t3.taxon_key,
       p.regions, CASE WHEN p.is_korean IS NULL THEN NULL ELSE p.is_korean = 1 END, p.report_fs,
       jsonb_strip_nulls(jsonb_build_object(
         'catalog_brands', p.catalog_brands, 'funnel_catalog', p.funnel_catalog, 'funnel_scope', p.funnel_scope,
         'brand_presence_resolved', p.brand_presence_resolved, 'presence_set', p.presence_set, 'list_type', p.list_type,
         'depth1', p.depth1, 'depth2', p.depth2, 'depth3', p.depth3, 'catalog_status', p.catalog_status, 'unit_base', p.unit_base,
         'site_country', p.site_country, 'site_lang', p.site_lang, 'lang', p.lang))
  FROM mig_src.frz_ops_prompt p
  JOIN rd.dim_prompt d ON d.prompt_id = p.prompt_id
  LEFT JOIN rd.dim_taxon tf ON tf.axis = 'funnel' AND tf.code = coalesce(p.funnel_catalog, p.funnel_scope) AND tf.parent_key IS NULL
  LEFT JOIN rd.dim_taxon tp ON tp.axis = 'presence' AND tp.code = p.brand_presence_resolved AND tp.parent_key IS NULL
  LEFT JOIN rd.dim_taxon tl ON tl.axis = 'list_type' AND tl.code = p.list_type AND tl.parent_key IS NULL
  LEFT JOIN rd.dim_taxon t1 ON t1.axis = 'depth1' AND t1.code = p.depth1 AND t1.parent_key IS NULL
  LEFT JOIN rd.dim_taxon t2 ON t2.axis = 'depth2' AND t2.code = p.depth2 AND t2.parent_key IS NOT DISTINCT FROM t1.taxon_key
  LEFT JOIN rd.dim_taxon t3 ON t3.axis = 'depth3' AND t3.code = p.depth3 AND t3.parent_key IS NOT DISTINCT FROM t2.taxon_key
 WHERE p.cycle_id = $3::uuid AND p.generation_id = $4::uuid
"""
# ── S4(DB-v2.24): 웹 셀 판정·택소노미 축·브랜드 표시명 ─────────────────────────────────────────
# 웹 셀 = 운영 summary_answers 유닛 플래그 + summary_url_hits job 플래그(없으면 NULL). 셀(CELL_INSERT)과 같은 행만
WEB_INSERT = """
INSERT INTO frz.cell_web (gen_key, answer_key, cyc_key, report_fs, unit_owned, unit_target, url_registered, url_owned_hit, url_target_hit)
SELECT $1::int4, f.answer_key, g.cyc_key, w.report_fs, coalesce(w.unit_owned, 0) = 1, coalesce(w.unit_target, 0) = 1,
       w.url_registered, w.url_owned_hit, w.url_target_hit
  FROM _fz_arg g JOIN _fz_cell f ON f.answer_key IS NOT NULL AND f.served AND f.src_surface = g.surface
  JOIN mig_src.frz_ops_web w ON w.cycle_id = g.cycle_id AND w.generation_id = g.generation_id AND w.job_id = f.job_id
"""
WEB_MISSING = """
SELECT count(*) FROM frz.cell c WHERE c.gen_key = $1
   AND NOT EXISTS (SELECT 1 FROM frz.cell_web w WHERE w.gen_key = c.gen_key AND w.answer_key = c.answer_key)
"""
# 택소노미 축 = 운영 summary_prompt_dim 원값(frz.prompt.src): funnel_catalog(현행 trendWhere funnelCol)·presence_set·list_type·depth1~3
AXIS_INSERT = """
INSERT INTO frz.prompt_axis (gen_key, prompt_key, cyc_key, funnel_key, presence_keys, list_type_key, depth1_key, depth2_key, depth3_key)
SELECT q.gen_key, q.prompt_key, q.cyc_key, tf.taxon_key,
       coalesce((SELECT array_agg(t.taxon_key ORDER BY t.taxon_key) FROM rd.dim_taxon t
                  WHERE t.axis = 'presence' AND t.parent_key IS NULL
                    AND t.code IN (SELECT jsonb_array_elements_text(coalesce(q.src -> 'presence_set', '[]'::jsonb)))), '{}'),
       tl.taxon_key, t1.taxon_key, t2.taxon_key, t3.taxon_key
  FROM frz.prompt q
  LEFT JOIN rd.dim_taxon tf ON tf.axis = 'funnel' AND tf.code = q.src ->> 'funnel_catalog' AND tf.parent_key IS NULL
  LEFT JOIN rd.dim_taxon tl ON tl.axis = 'list_type' AND tl.code = q.src ->> 'list_type' AND tl.parent_key IS NULL
  LEFT JOIN rd.dim_taxon t1 ON t1.axis = 'depth1' AND t1.code = q.src ->> 'depth1' AND t1.parent_key IS NULL
  LEFT JOIN rd.dim_taxon t2 ON t2.axis = 'depth2' AND t2.code = q.src ->> 'depth2' AND t2.parent_key IS NOT DISTINCT FROM t1.taxon_key
  LEFT JOIN rd.dim_taxon t3 ON t3.axis = 'depth3' AND t3.code = q.src ->> 'depth3' AND t3.parent_key IS NOT DISTINCT FROM t2.taxon_key
 WHERE q.gen_key = $1
"""

PROMPT_FAILS = """
SELECT count(*) AS ops_prompts,
       count(*) FILTER (WHERE d.prompt_key IS NULL) AS prompt_unmapped,
       count(*) FILTER (WHERE d.prompt_key IS NULL AND EXISTS (SELECT 1 FROM mig_src.frz_ops_cell c
                                                               WHERE c.cycle_id = p.cycle_id AND c.generation_id = p.generation_id
                                                                 AND c.prompt_id = p.prompt_id)) AS prompt_unmapped_with_cells
  FROM mig_src.frz_ops_prompt p LEFT JOIN rd.dim_prompt d ON d.prompt_id = p.prompt_id
 WHERE p.cycle_id = $1 AND p.generation_id = $2
"""

# ── 보관: ops(운영 세부층 변환) ──────────────────────────────────────────────
# 대상 = 바뀐 답변 목록 중 이 회차 셀(좌석 무관: 변환 기준 행은 rd 실제 위치). 인용 수가 운영과 다르면 변환 실패(인용은 옮기지 않는다)
OPS_TARGETS = """
DROP TABLE IF EXISTS _fz_ops;
CREATE TEMP TABLE _fz_ops ON COMMIT DROP AS
SELECT f.job_id, f.answer_key, f.src_surface, f.src_round_date, f.src_cyc_key, oa.all_citations,
       (SELECT a.cit_n_all FROM rd.answer a WHERE a.surface = f.src_surface AND a.round_date = f.src_round_date AND a.answer_key = f.answer_key) AS hub_cit
  FROM _fz_arg g
  JOIN mig_src.frz_ops_changed x ON x.cycle_id = g.cycle_id AND x.generation_id = g.generation_id
  JOIN _fz_cell f ON f.job_id = x.job_id AND f.answer_key IS NOT NULL AND f.served AND f.src_surface = g.surface
  LEFT JOIN mig_src.frz_ops_answer oa ON oa.cycle_id = x.cycle_id AND oa.generation_id = x.generation_id AND oa.job_id = x.job_id;
"""
# 운영 브랜드 행 → 허브 answer_brand 행 모양(적재기 _ig_ab 와 같은 그레인: 답변 × 브랜드 키 × competitive)
OPS_BRAND = """
DROP TABLE IF EXISTS _fz_ob;
CREATE TEMP TABLE _fz_ob ON COMMIT DROP AS
SELECT t.answer_key, n.brand_key, (b.is_competitor = 1) AS competitive, max(n.own_bit)::int2 AS own_bit,
       count(*)::int2 AS entity_rows, count(DISTINCT b.brand_id)::int2 AS rid_n, sum(b.mentions)::int2 AS mention_count,
       sum(b.positive)::int2 AS s_pos, sum(b.neutral)::int2 AS s_neu, sum(b.negative)::int2 AS s_neg, sum(b.mixed)::int2 AS s_mix,
       sum(b.type_mention)::int2 AS t_mention, sum(b.type_recommendation)::int2 AS t_recommendation,
       sum(b.type_comparison)::int2 AS t_comparison, sum(b.type_definition)::int2 AS t_definition,
       sum(b.type_final_choice)::int2 AS t_final_choice, min(b.first_rank) AS tp
  FROM _fz_arg g CROSS JOIN _fz_ops t
  JOIN mig_src.frz_ops_brand b ON b.cycle_id = g.cycle_id AND b.generation_id = g.generation_id AND b.job_id = t.job_id
  JOIN rd.dim_brand_name n ON n.name = b.brand_name
 WHERE t.all_citations IS NOT DISTINCT FROM t.hub_cit
 GROUP BY t.answer_key, n.brand_key, (b.is_competitor = 1);
ALTER TABLE _fz_ob ADD COLUMN rk int2 NOT NULL DEFAULT 0;
UPDATE _fz_ob a SET rk = x.rk
  FROM (SELECT answer_key, brand_key, rank() OVER (PARTITION BY answer_key ORDER BY tp)::int2 AS rk
          FROM _fz_ob WHERE competitive AND brand_key <> 0 AND tp IS NOT NULL) x
 WHERE x.answer_key = a.answer_key AND x.brand_key = a.brand_key AND a.competitive;
"""
OPS_FAILS = """
SELECT count(*) AS changed,
       count(*) FILTER (WHERE all_citations IS DISTINCT FROM hub_cit) AS citations_differ,
       (SELECT count(DISTINCT b.brand_name) FROM mig_src.frz_ops_brand b JOIN _fz_ops t ON t.job_id = b.job_id
         WHERE b.cycle_id = $1 AND b.generation_id = $2 AND NOT EXISTS (SELECT 1 FROM rd.dim_brand_name n WHERE n.name = b.brand_name)) AS brand_unmapped,
       (SELECT coalesce(array_agg(DISTINCT b.brand_name), '{}') FROM mig_src.frz_ops_brand b JOIN _fz_ops t ON t.job_id = b.job_id
         WHERE b.cycle_id = $1 AND b.generation_id = $2 AND NOT EXISTS (SELECT 1 FROM rd.dim_brand_name n WHERE n.name = b.brand_name)) AS brand_unmapped_names
  FROM _fz_ops
"""
# 변환 후보(answer_brand 행·답변 행). 기준 = 지금 rd 행(실제 위치), 언급 계열 열만 운영 값으로 바꾼다
OPS_CANDIDATE = """
DROP TABLE IF EXISTS _fz_kb;
CREATE TEMP TABLE _fz_kb ON COMMIT DROP AS
SELECT a.round_date, b.answer_key, b.brand_key, a.cyc_key, a.prompt_key, a.surface, a.project_key, a.engine_key, a.geo_key, a.lang_key, a.bgrp,
       b.own_bit, b.entity_rows, b.mention_count, b.rk, b.s_pos, b.s_neu, b.s_neg, b.s_mix,
       b.t_mention, b.t_recommendation, b.t_comparison, b.t_definition, b.t_final_choice,
       b.competitive, a.std_in, a.elig, a.dflt, a.rule_ver, a.is_rep, a.std_in_nc, b.rid_n
  FROM _fz_ob b JOIN _fz_ops t ON t.answer_key = b.answer_key
  JOIN rd.answer a ON a.surface = t.src_surface AND a.round_date = t.src_round_date AND a.answer_key = t.answer_key;
-- 브랜드 키 0 행(운영 세부층에 없는 롤업 없음·이름 없음 언급)은 지금 rd 행을 그대로 잇는다
INSERT INTO _fz_kb
SELECT x.round_date, x.answer_key, x.brand_key, x.cyc_key, x.prompt_key, x.surface, x.project_key, x.engine_key, x.geo_key, x.lang_key, x.bgrp,
       x.own_bit, x.entity_rows, x.mention_count, x.rk, x.s_pos, x.s_neu, x.s_neg, x.s_mix,
       x.t_mention, x.t_recommendation, x.t_comparison, x.t_definition, x.t_final_choice,
       x.competitive, x.std_in, x.elig, x.dflt, x.rule_ver, x.is_rep, x.std_in_nc, x.rid_n
  FROM _fz_ops t JOIN rd.answer_brand x ON x.surface = t.src_surface AND x.round_date = t.src_round_date AND x.answer_key = t.answer_key
 WHERE x.brand_key = 0 AND t.all_citations IS NOT DISTINCT FROM t.hub_cit;
DROP TABLE IF EXISTS _fz_ko;
CREATE TEMP TABLE _fz_ko ON COMMIT DROP AS
SELECT t.answer_key,
       coalesce(bit_or(own_bit) FILTER (WHERE own_bit <> 0), 0)::int2 AS own_mask,
       coalesce(min(rk) FILTER (WHERE own_bit = 1 AND rk > 0), 0)::int2 AS own_rk_h,
       coalesce(min(rk) FILTER (WHERE own_bit = 2 AND rk > 0), 0)::int2 AS own_rk_k,
       coalesce(min(rk) FILTER (WHERE own_bit = 4 AND rk > 0), 0)::int2 AS own_rk_g,
       coalesce(sum(mention_count) FILTER (WHERE competitive), 0)::int2 AS ment_total,
       coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 1), 0)::int2 AS ment_h,
       coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 2), 0)::int2 AS ment_k,
       coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 4), 0)::int2 AS ment_g,
       coalesce(sum(s_pos) FILTER (WHERE own_bit = 1), 0)::int2 AS sent_pos_h,
       coalesce(sum(s_pos) FILTER (WHERE own_bit = 2), 0)::int2 AS sent_pos_k,
       coalesce(sum(s_pos) FILTER (WHERE own_bit = 4), 0)::int2 AS sent_pos_g,
       coalesce(sum(s_neg) FILTER (WHERE own_bit = 1), 0)::int2 AS sent_neg_h,
       coalesce(sum(s_neg) FILTER (WHERE own_bit = 2), 0)::int2 AS sent_neg_k,
       coalesce(sum(s_neg) FILTER (WHERE own_bit = 4), 0)::int2 AS sent_neg_g,
       coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 1), 0)::int2 AS sent_all_h,
       coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 2), 0)::int2 AS sent_all_k,
       coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 4), 0)::int2 AS sent_all_g,
       coalesce(bit_or(rd.t_own_bits(own_bit, t_mention, t_recommendation, t_comparison, t_definition, t_final_choice)), 0)::int2 AS t_own
  FROM _fz_ops t LEFT JOIN _fz_kb b ON b.answer_key = t.answer_key
 WHERE t.all_citations IS NOT DISTINCT FROM t.hub_cit
 GROUP BY t.answer_key;
DROP TABLE IF EXISTS _fz_ka;
CREATE TEMP TABLE _fz_ka ON COMMIT DROP AS SELECT a.* FROM frz.keep_answer a WHERE false;
INSERT INTO _fz_ka
SELECT (jsonb_populate_record(NULL::frz.keep_answer, to_jsonb(a) || (to_jsonb(o) - 'answer_key'))).*
  FROM _fz_ko o JOIN _fz_ops t ON t.answer_key = o.answer_key
  JOIN rd.answer a ON a.surface = t.src_surface AND a.round_date = t.src_round_date AND a.answer_key = t.answer_key;
"""
# 지금 rd 와 값이 다른 답변만(is_rep·load_id 무시). 반환 = 보관할 답변 키
OPS_DIFFER = """
WITH k AS (SELECT answer_key FROM _fz_ka),
cur AS (
  SELECT t.answer_key, md5(string_agg(j, '|' ORDER BY j)) AS h FROM (
    SELECT t.answer_key, 'a' || (to_jsonb(x) - '{is_rep,load_id}'::text[])::text AS j FROM _fz_ops t JOIN k USING (answer_key)
      JOIN rd.answer x ON x.surface = t.src_surface AND x.round_date = t.src_round_date AND x.answer_key = t.answer_key
    UNION ALL
    SELECT t.answer_key, 'b' || (to_jsonb(x) - '{is_rep,load_id}'::text[])::text FROM _fz_ops t JOIN k USING (answer_key)
      JOIN rd.answer_brand x ON x.surface = t.src_surface AND x.round_date = t.src_round_date AND x.answer_key = t.answer_key) t
  GROUP BY t.answer_key),
cand AS (
  SELECT z.answer_key, md5(string_agg(j, '|' ORDER BY j)) AS h FROM (
    SELECT a.answer_key, 'a' || (to_jsonb(a) - '{is_rep,load_id,gen_key}'::text[])::text AS j FROM _fz_ka a
    UNION ALL
    SELECT b.answer_key, 'b' || (to_jsonb(b) - '{is_rep,load_id}'::text[])::text FROM _fz_kb b) z
  GROUP BY z.answer_key)
SELECT coalesce(array_agg(k.answer_key ORDER BY k.answer_key), '{}'::int4[])
  FROM k LEFT JOIN cur USING (answer_key) LEFT JOIN cand USING (answer_key)
 WHERE cur.h IS DISTINCT FROM cand.h
"""
_KB_COLS = ("round_date, answer_key, brand_key, cyc_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key, bgrp, own_bit, "
            "entity_rows, mention_count, rk, s_pos, s_neu, s_neg, s_mix, t_mention, t_recommendation, t_comparison, t_definition, "
            "t_final_choice, competitive, std_in, elig, dflt, rule_ver, is_rep, std_in_nc, rid_n")
# 보관 행 = rd 열 + 끝에 gen_key(DB-v2.21 P115, 세대 단위 보관). $2 = 세대
OPS_KEEP = (
    "INSERT INTO frz.keep_answer SELECT (jsonb_populate_record(a, jsonb_build_object('gen_key', $2::int4))).* FROM _fz_ka a "
    "WHERE a.answer_key = ANY ($1::int4[])",
    f"INSERT INTO frz.keep_answer_brand ({_KB_COLS}, gen_key) SELECT {_KB_COLS}, $2::int4 FROM _fz_kb b WHERE b.answer_key = ANY ($1::int4[])",
    """INSERT INTO frz.keep_citation SELECT x.*, $2::int4 FROM _fz_ops t
  JOIN rd.citation x ON x.surface = t.src_surface AND x.round_date = t.src_round_date AND x.answer_key = t.answer_key
 WHERE t.answer_key = ANY ($1::int4[])""",
)
# ── 보관: seat(rd 좌석 ≠ 동결 좌석, 이 세대에 이미 보관한 답변 제외) ─────────────────────
SEAT_KEYS = """
SELECT coalesce(array_agg(answer_key ORDER BY answer_key), '{}'::int4[]) FROM _fz_cell
 WHERE answer_key IS NOT NULL AND served AND src_surface = $1 AND (src_cyc_key <> $2 OR src_round_date <> $3)
   AND NOT EXISTS (SELECT 1 FROM frz.kept p WHERE p.gen_key = $4 AND p.answer_key = _fz_cell.answer_key)
"""
SEAT_KEEP = tuple(
    f"INSERT INTO frz.keep_{t} SELECT x.*, $2::int4 FROM _fz_cell f JOIN rd.{t} x ON x.surface = f.src_surface AND x.round_date = f.src_round_date "
    f"AND x.answer_key = f.answer_key WHERE f.answer_key = ANY ($1::int4[])" for t in ("answer", "answer_brand", "citation"))
CLAIM = "SELECT frz._claim($1::int4, $2::int4[], $3)"

# ── 단언: 동결 읽기 뷰(활성화 뒤) 대 운영 집계층 합 ───────────────────────────
VERIFY_ANSWERS = """
WITH a AS (SELECT * FROM frz.answer WHERE surface = $1 AND round_date = $2 AND cyc_key = ANY ($3::int4[]))
SELECT count(*) AS cells,
       count(*) FILTER (WHERE q.in_full_cycle) AS cells_ifc,
       coalesce(sum(a.ment_total), 0) AS all_mentions,
       coalesce(sum(a.cit_n_all), 0) AS all_citations,
       count(*) FILTER (WHERE a.cit_n_all IS NULL) AS cit_n_all_null,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM frz.answer_brand b WHERE b.surface = $1 AND b.round_date = $2 AND b.cyc_key = ANY ($3::int4[])
                                        AND b.answer_key = a.answer_key AND b.brand_key <> 0)) AS has_any_brand,
       (SELECT count(*) FROM frz.citation c WHERE c.surface = $1 AND c.round_date = $2 AND c.cyc_key = ANY ($3::int4[])) AS domain_citations
  FROM a LEFT JOIN frz.prompt q ON q.gen_key = $4 AND q.prompt_key = a.prompt_key
"""
OPS_SUM_CYCLE = """
SELECT cells, cells_ifc, all_mentions, all_citations, has_any_brand, domain_citations
  FROM mig_src.frz_ops_sum_cycle WHERE cycle_id = $1 AND generation_id = $2
"""
VERIFY_BRANDS = """
WITH h AS (
  SELECT n.name AS brand_name, sum(b.mention_count)::bigint AS mentions, sum(b.rid_n)::bigint AS answers,
         count(*) FILTER (WHERE b.rid_n IS NULL) AS rid_null,
         coalesce(sum(b.rk) FILTER (WHERE b.competitive AND b.rk > 0), 0)::bigint AS comp_rank_sum,
         count(*) FILTER (WHERE b.competitive AND b.rk > 0)::bigint AS comp_ranked_answers
    FROM frz.answer_brand b JOIN rd.dim_brand_name n ON n.brand_key = b.brand_key
   WHERE b.surface = $1 AND b.round_date = $2 AND b.cyc_key = ANY ($3::int4[]) AND b.brand_key <> 0
   GROUP BY n.name),
o AS (
  SELECT brand_name, mentions::bigint, answers::bigint, round(comp_rank_sum)::bigint AS comp_rank_sum, comp_ranked_answers::bigint
    FROM mig_src.frz_ops_sum_brand WHERE cycle_id = $4 AND generation_id = $5)
SELECT count(*) AS names,
       count(*) FILTER (WHERE h.brand_name IS NULL) AS ops_only,
       count(*) FILTER (WHERE o.brand_name IS NULL) AS hub_only,
       count(*) FILTER (WHERE coalesce(h.mentions, 0) <> coalesce(o.mentions, 0)) AS mentions_diff,
       count(*) FILTER (WHERE coalesce(h.answers, 0) <> coalesce(o.answers, 0)) AS answers_diff,
       count(*) FILTER (WHERE coalesce(h.comp_rank_sum, 0) <> coalesce(o.comp_rank_sum, 0)) AS comp_rank_sum_diff,
       count(*) FILTER (WHERE coalesce(h.comp_ranked_answers, 0) <> coalesce(o.comp_ranked_answers, 0)) AS comp_ranked_diff,
       coalesce(sum(h.rid_null), 0) AS rid_n_null,
       coalesce(sum(abs(coalesce(h.mentions, 0) - coalesce(o.mentions, 0))), 0) AS mentions_abs_delta
  FROM h FULL JOIN o ON o.brand_name = h.brand_name
 WHERE coalesce(h.mentions, 0) <> 0 OR coalesce(o.mentions, 0) <> 0 OR coalesce(h.answers, 0) <> 0 OR coalesce(o.answers, 0) <> 0
"""
# 당사 변형: ALL = 당사 비트 전부, 그 밖 = 같은 이름의 rd.dim_brand_name 당사 행 비트(없으면 bits NULL = 실패)
VERIFY_OWN = """
WITH v AS (
  SELECT o.own_variant,
         CASE WHEN o.own_variant = 'ALL' THEN (SELECT bit_or(own_bit) FROM rd.dim_brand_name WHERE kind = 1)
              ELSE (SELECT bit_or(own_bit) FROM rd.dim_brand_name WHERE kind = 1 AND name = o.own_variant) END AS bits,
         o.tracked_answers, o.own_mentions, o.own_positive, o.own_negative, o.own_signals
    FROM mig_src.frz_ops_sum_own o WHERE o.cycle_id = $4 AND o.generation_id = $5),
a AS (SELECT * FROM frz.answer WHERE surface = $1 AND round_date = $2 AND cyc_key = ANY ($3::int4[])),
h AS (
  SELECT v.own_variant,
         count(a.*) FILTER (WHERE (a.own_mask & v.bits) <> 0) AS tracked_answers,
         coalesce(sum(CASE WHEN v.bits & 1 <> 0 THEN a.ment_h ELSE 0 END + CASE WHEN v.bits & 2 <> 0 THEN a.ment_k ELSE 0 END
                      + CASE WHEN v.bits & 4 <> 0 THEN a.ment_g ELSE 0 END), 0) AS own_mentions,
         coalesce(sum(CASE WHEN v.bits & 1 <> 0 THEN a.sent_pos_h ELSE 0 END + CASE WHEN v.bits & 2 <> 0 THEN a.sent_pos_k ELSE 0 END
                      + CASE WHEN v.bits & 4 <> 0 THEN a.sent_pos_g ELSE 0 END), 0) AS own_positive,
         coalesce(sum(CASE WHEN v.bits & 1 <> 0 THEN a.sent_neg_h ELSE 0 END + CASE WHEN v.bits & 2 <> 0 THEN a.sent_neg_k ELSE 0 END
                      + CASE WHEN v.bits & 4 <> 0 THEN a.sent_neg_g ELSE 0 END), 0) AS own_negative,
         coalesce(sum(CASE WHEN v.bits & 1 <> 0 THEN a.sent_all_h ELSE 0 END + CASE WHEN v.bits & 2 <> 0 THEN a.sent_all_k ELSE 0 END
                      + CASE WHEN v.bits & 4 <> 0 THEN a.sent_all_g ELSE 0 END), 0) AS own_signals
    FROM v LEFT JOIN a ON v.bits IS NOT NULL
   GROUP BY v.own_variant)
SELECT v.own_variant, v.bits,
       v.tracked_answers AS o_tracked, h.tracked_answers AS h_tracked, v.own_mentions AS o_mentions, h.own_mentions AS h_mentions,
       v.own_positive AS o_positive, h.own_positive AS h_positive, v.own_negative AS o_negative, h.own_negative AS h_negative,
       v.own_signals AS o_signals, h.own_signals AS h_signals
  FROM v JOIN h USING (own_variant) ORDER BY v.own_variant
"""
# S4b 단언 보강(선택 입력 mig_src.frz_ops_sum_brand_x·frz_ops_sum_own_x 가 있을 때만): 브랜드 축 감정·유형 합, 당사 축 순위·복수 언급.
# 허브 정의 = 운영 fold.ts:731-804 와 같은 뜻: 당사 순위 tp = 관점 비트 own_rk 중 0 아닌 최소(core.measure.own_cols), mc = 관점 비트 ment 합
OPTIONAL_X = "SELECT to_regclass('mig_src.frz_ops_sum_brand_x') IS NOT NULL AND to_regclass('mig_src.frz_ops_sum_own_x') IS NOT NULL"
VERIFY_BRANDS_X = """
WITH h AS (
  SELECT n.name AS brand_name, sum(b.s_pos)::bigint AS positive, sum(b.s_neu)::bigint AS neutral, sum(b.s_neg)::bigint AS negative,
         sum(b.s_mix)::bigint AS mixed, sum(b.t_mention)::bigint AS type_mention, sum(b.t_recommendation)::bigint AS type_recommendation,
         sum(b.t_comparison)::bigint AS type_comparison, sum(b.t_definition)::bigint AS type_definition,
         sum(b.t_final_choice)::bigint AS type_final_choice
    FROM frz.answer_brand b JOIN rd.dim_brand_name n ON n.brand_key = b.brand_key
   WHERE b.surface = $1 AND b.round_date = $2 AND b.cyc_key = ANY ($3::int4[]) AND b.brand_key <> 0
   GROUP BY n.name),
o AS (SELECT * FROM mig_src.frz_ops_sum_brand_x WHERE cycle_id = $4 AND generation_id = $5)
SELECT count(*) FILTER (WHERE coalesce(h.positive, 0) <> coalesce(o.positive, 0)) AS positive_diff,
       count(*) FILTER (WHERE coalesce(h.neutral, 0) <> coalesce(o.neutral, 0)) AS neutral_diff,
       count(*) FILTER (WHERE coalesce(h.negative, 0) <> coalesce(o.negative, 0)) AS negative_diff,
       count(*) FILTER (WHERE coalesce(h.mixed, 0) <> coalesce(o.mixed, 0)) AS mixed_diff,
       count(*) FILTER (WHERE (coalesce(h.type_mention, 0), coalesce(h.type_recommendation, 0), coalesce(h.type_comparison, 0),
                               coalesce(h.type_definition, 0), coalesce(h.type_final_choice, 0))
                    IS DISTINCT FROM (coalesce(o.type_mention, 0), coalesce(o.type_recommendation, 0), coalesce(o.type_comparison, 0),
                               coalesce(o.type_definition, 0), coalesce(o.type_final_choice, 0))) AS types_diff
  FROM h FULL JOIN o ON o.brand_name = h.brand_name
"""
VERIFY_OWN_X = """
WITH v AS (
  SELECT o.own_variant,
         CASE WHEN o.own_variant = 'ALL' THEN (SELECT bit_or(own_bit) FROM rd.dim_brand_name WHERE kind = 1)
              ELSE (SELECT bit_or(own_bit) FROM rd.dim_brand_name WHERE kind = 1 AND name = o.own_variant) END AS bits,
         o.rank_sum, o.ranked_answers, o.top1_answers, o.top3_answers, o.multi_answers
    FROM mig_src.frz_ops_sum_own_x o WHERE o.cycle_id = $4 AND o.generation_id = $5),
a AS (SELECT * FROM frz.answer WHERE surface = $1 AND round_date = $2 AND cyc_key = ANY ($3::int4[])),
r AS (
  SELECT v.own_variant,
         LEAST(CASE WHEN v.bits & 1 <> 0 THEN nullif(a.own_rk_h, 0) END, CASE WHEN v.bits & 2 <> 0 THEN nullif(a.own_rk_k, 0) END,
               CASE WHEN v.bits & 4 <> 0 THEN nullif(a.own_rk_g, 0) END) AS tp,
         (CASE WHEN v.bits & 1 <> 0 THEN a.ment_h ELSE 0 END + CASE WHEN v.bits & 2 <> 0 THEN a.ment_k ELSE 0 END
          + CASE WHEN v.bits & 4 <> 0 THEN a.ment_g ELSE 0 END) AS mc
    FROM v JOIN a ON v.bits IS NOT NULL),
h AS (
  SELECT own_variant, coalesce(sum(tp), 0)::bigint AS rank_sum, count(tp)::bigint AS ranked_answers,
         count(*) FILTER (WHERE tp <= 1)::bigint AS top1_answers, count(*) FILTER (WHERE tp <= 3)::bigint AS top3_answers,
         count(*) FILTER (WHERE mc >= 2)::bigint AS multi_answers
    FROM r GROUP BY own_variant)
SELECT v.own_variant,
       (v.rank_sum, v.ranked_answers, v.top1_answers, v.top3_answers, v.multi_answers)
         IS DISTINCT FROM (coalesce(h.rank_sum, 0), coalesce(h.ranked_answers, 0), coalesce(h.top1_answers, 0), coalesce(h.top3_answers, 0),
                           coalesce(h.multi_answers, 0)) AS differ,
       v.bits IS NULL AS unmapped
  FROM v LEFT JOIN h USING (own_variant) ORDER BY v.own_variant
"""

ROW_COUNTS = """
SELECT (SELECT count(*) FROM frz.cell WHERE gen_key = $1) AS cells, (SELECT count(*) FROM frz.prompt WHERE gen_key = $1) AS prompts,
       (SELECT count(*) FROM frz.kept p WHERE p.src = 'ops' AND p.gen_key = $1) AS kept_ops,
       (SELECT count(*) FROM frz.kept p WHERE p.src = 'seat' AND p.gen_key = $1) AS kept_seat,
       (SELECT count(*) FROM frz.kept p WHERE p.src = 'fold' AND p.gen_key = $1) AS kept_fold
"""
# 접기 차(운영 all_mentions = summary_answers 언급 행 단위 경쟁, 접기 전 값과 맞추려고 Σ ment_total 에서 뺀다). 두 갈래:
#   fold = 접기 보관 답변: 보관 ment_total(접힌 경쟁 행 합) − 지금 rd ment_total(언급 행 단위 = 운영 all_mentions 와 같은 정의)
#   ops  = 운영 세부층 변환 보관(바뀐 답변) 중 rd 기준 공존 답변: 보관 ment_total(운영 summary_brand_mentions 는 이미 접힌 행) − 그 답변의 운영
#          all_mentions(mig_src.frz_ops_answer, 같은 운영 세대의 값). 두 값이 같은 운영 세대에서 나오므로 차 = 접기 몫뿐이고, 실제 운영 변경(측정·분석이
#          바뀐 몫)은 보관 ment_total 과 운영 all_mentions 양쪽에 같이 들어 있어 가려지지 않는다. 공존 아닌 ops 보관 답변은 보정하지 않는다(접기 몫이
#          없어야 하므로 차가 있으면 그대로 실패로 드러난다). 공존 판정이 rd 기준인 것은 접기 대상 판정(ingest.frz.fold.CANDIDATES)과 같다.
FOLD_DELTA = """
SELECT coalesce((SELECT sum(k.ment_total - x.ment_total)
                   FROM frz.kept p JOIN frz.keep_answer k ON k.gen_key = p.gen_key AND k.answer_key = p.answer_key
                   JOIN rd.job j ON j.answer_key = p.answer_key
                   JOIN rd.answer x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key
                  WHERE p.gen_key = $1 AND p.src = 'fold'), 0)::bigint AS fold,
       coalesce((SELECT sum(k.ment_total - oa.all_mentions)
                   FROM frz.kept p JOIN frz.keep_answer k ON k.gen_key = p.gen_key AND k.answer_key = p.answer_key
                   JOIN rd.job j ON j.answer_key = p.answer_key
                   JOIN mig_src.frz_ops_answer oa ON oa.cycle_id = $2 AND oa.generation_id = $3 AND oa.job_id = j.job_id
                  WHERE p.gen_key = $1 AND p.src = 'ops'
                    AND EXISTS (SELECT 1 FROM rd.answer_brand f JOIN rd.answer_brand t ON t.surface = f.surface AND t.round_date = f.round_date
                                       AND t.answer_key = f.answer_key AND t.brand_key = f.brand_key AND t.competitive
                                 WHERE f.surface = j.surface AND f.round_date = j.round_date AND f.answer_key = j.answer_key
                                   AND NOT f.competitive AND f.brand_key <> 0)), 0)::bigint AS ops
"""
# 선택 입력(재추출 뒤): 운영 카드 점유율 분모 = summary_trend_own.comp_mentions(변형 ALL, 접힌 경쟁 행 언급 합)
OPTIONAL_COMP = "SELECT to_regclass('mig_src.frz_ops_sum_comp') IS NOT NULL"
OPS_SUM_COMP = "SELECT comp_mentions FROM mig_src.frz_ops_sum_comp WHERE cycle_id = $1 AND generation_id = $2"


class _Abort(Exception):
    """드라이런·단언 실패 롤백용(결과는 들고 나간다)."""

    def __init__(self, result: dict[str, Any]):
        super().__init__("rollback")
        self.result = result


@dataclass
class ImportReport:
    commit: bool
    cycles: list[dict[str, Any]] = field(default_factory=list)

    def summary(self) -> dict[str, Any]:
        by: dict[str, int] = {}
        for c in self.cycles:
            by[c["status"]] = by.get(c["status"], 0) + 1
        return {"commit": self.commit, "cycles": len(self.cycles), "by_status": by,
                "kept_ops": sum(int(c.get("counts", {}).get("kept_ops", 0)) for c in self.cycles),
                "kept_seat": sum(int(c.get("counts", {}).get("kept_seat", 0)) for c in self.cycles),
                "kept_fold": sum(int(c.get("counts", {}).get("kept_fold", 0)) for c in self.cycles),
                "sec": round(sum(float(c.get("sec", 0)) for c in self.cycles), 1)}


def _axis_failures(ans: asyncpg.Record, ops: asyncpg.Record | None, brands: asyncpg.Record, own: list[asyncpg.Record]) -> list[str]:
    """축 합 대조 실패 목록(빈 목록 = 통과). 순수 함수(단위 시험 대상)."""
    fails: list[str] = []
    if ops is None:
        return ["ops_sum_missing"]
    for k in ("cells", "cells_ifc", "all_mentions", "all_citations", "has_any_brand", "domain_citations"):
        if int(ans[k]) != int(ops[k]):
            fails.append(f"answers.{k} hub={int(ans[k])} ops={int(ops[k])}")
    if int(ans["cit_n_all_null"]):
        fails.append(f"answers.cit_n_all_null {int(ans['cit_n_all_null'])}")
    for k in ("ops_only", "hub_only", "mentions_diff", "answers_diff", "comp_rank_sum_diff", "comp_ranked_diff", "rid_n_null"):
        if int(brands[k]):
            fails.append(f"brands.{k} {int(brands[k])}")
    for r in own:
        if r["bits"] is None:
            fails.append(f"own.{r['own_variant']} variant_unmapped")
            continue
        for k in ("tracked", "mentions", "positive", "negative", "signals"):
            if int(r[f"o_{k}"]) != int(r[f"h_{k}"] or 0):
                fails.append(f"own.{r['own_variant']}.{k} hub={int(r[f'h_{k}'] or 0)} ops={int(r[f'o_{k}'])}")
    return fails


def _load_failures(cf: Any, pf: Any, of: Any) -> list[str]:
    """변환 실패(셀·프롬프트·ops 보관). 하나라도 있으면 그 회차는 적재하지 않는다. 순수 함수(단위 시험 대상)."""
    fails = [f"cells.{k} {int(cf[k])}" for k in ("job_unmapped", "answer_missing", "surface_mismatch", "dup_answers") if int(cf[k])]
    if int(pf["prompt_unmapped_with_cells"]):
        fails.append(f"prompts.unmapped_with_cells {int(pf['prompt_unmapped_with_cells'])}")
    fails += [f"ops.{k} {int(of[k])}" for k in ("citations_differ", "brand_unmapped") if int(of[k])]
    return fails


async def check_inputs(conn: asyncpg.Connection) -> list[str]:
    rows = await conn.fetch(INPUT_CHECK, list(INPUT_TABLES))
    return [r["t"] for r in rows if not r["ok"]]


async def _import_one(conn: asyncpg.Connection, cyc: asyncpg.Record, *, commit: bool, force: bool) -> dict[str, Any]:
    t0 = time.monotonic()
    head = {"cycle": str(cyc["cycle_id"])[:8], "ops_generation": str(cyc["generation_id"])[:8], "cyc_key": cyc["cyc_key"]}
    if cyc["cyc_key"] is None or cyc["surface"] is None:
        return {**head, "status": "cycle_unmapped"}
    if not cyc["stable"]:
        return {**head, "status": "regenerated_during_export"}
    surface, rdate, ckey = int(cyc["surface"]), cyc["round_date"], int(cyc["cyc_key"])
    try:
        async with conn.transaction():
            await conn.execute("SELECT set_config('statement_timeout', '600s', true), set_config('lock_timeout', '30s', true)")
            await conn.execute("SELECT pg_advisory_xact_lock($1::int4, $2::int4)", NS_SURFACE, surface)
            cur = await conn.fetchrow(ACTIVE_GEN, ckey)
            released = None
            if cur is not None:
                if cur["ops_generation_id"] == cyc["generation_id"] and not force:
                    raise _Abort({**head, "status": "already_current", "gen_key": cur["gen_key"]})
                released = json.loads(await conn.fetchval("SELECT frz.release($1, $2)::text", cur["gen_key"],
                                                          "force" if cur["ops_generation_id"] == cyc["generation_id"] else "ops_regenerated"))
            gen = await conn.fetchval(NEW_GEN, ckey, surface, cyc["generation_id"], cyc["cycle_id"])
            if gen is None:
                raise _Abort({**head, "status": "generation_missing"})
            await conn.execute(NEW_JUDGMENT, gen, cyc["generation_id"])
            await conn.execute(ARGS)
            await conn.execute(ARGS_SET, cyc["cycle_id"], cyc["generation_id"], surface, ckey, rdate)
            await conn.execute(CELL_MAP)
            cf = await conn.fetchrow(CELL_FAILS, surface, ckey, rdate)
            await conn.execute(CELL_INSERT, gen, surface, ckey, rdate)
            await conn.execute(PROMPT_INSERT, gen, ckey, cyc["cycle_id"], cyc["generation_id"])
            pf = await conn.fetchrow(PROMPT_FAILS, cyc["cycle_id"], cyc["generation_id"])
            # S4: 웹 셀 판정(웹 회차) · 택소노미 축 · 브랜드 표시명(이관 시점 rd 이름 = 운영 이름과 같다: 브랜드 축 단언이 이름으로 대조한다)
            web_missing = web_partial = 0
            if surface == 2:
                await conn.execute(WEB_INSERT, gen)
                web_missing = int(await conn.fetchval(WEB_MISSING, gen))
                # 웹 카드 읽기 뷰(DB-v2.24 P127)는 웹 in_full_cycle 참을 전제한다(현행 생성기 상수 1, surface-website.ts:9·404)
                web_partial = int(await conn.fetchval("SELECT count(*) FROM frz.prompt WHERE gen_key = $1 AND NOT in_full_cycle", gen))
            if surface == 2:                            # URL 인용률 사실표 커버리지(현행 summary_url_hit_generations, S4b)
                await conn.execute("UPDATE frz.generation SET judgment = judgment || jsonb_build_object('url_hits_covered', "
                                   "EXISTS (SELECT 1 FROM mig_src.frz_ops_url_cov v WHERE v.generation_id = $2)) WHERE gen_key = $1",
                                   gen, cyc["generation_id"])
            n_axis = int((await conn.execute(AXIS_INSERT, gen)).split()[-1])
            n_names = int(await conn.fetchval("SELECT frz._bake_names($1)", gen))
            # ops 보관(운영 세부층 변환) → seat 보관(나머지 좌석 이동)
            await conn.execute(OPS_TARGETS)
            await conn.execute(OPS_BRAND)
            of = await conn.fetchrow(OPS_FAILS, cyc["cycle_id"], cyc["generation_id"])
            await conn.execute(OPS_CANDIDATE)
            differ = list(await conn.fetchval(OPS_DIFFER))
            ops_keys = list(await conn.fetchval(CLAIM, gen, differ, "ops")) if differ else []
            for q in OPS_KEEP if ops_keys else ():
                await conn.execute(q, ops_keys, gen)
            seat = list(await conn.fetchval(SEAT_KEYS, surface, ckey, rdate, gen))
            seat_keys = list(await conn.fetchval(CLAIM, gen, seat, "seat")) if seat else []
            for q in SEAT_KEEP if seat_keys else ():
                await conn.execute(q, seat_keys, gen)
            # 운영 summary 접기(brand_card_fold): ops·seat 보관 뒤 공존 답변. 실패는 회차 실패(접히지 않은 값을 적재하지 않는다)
            fold_fail: list[str] = []
            fold_res = {"candidates": 0, "kept": 0}
            try:
                async with conn.transaction():
                    fold_res = await frz_fold.keep_generation(conn, gen)
            except (asyncpg.PostgresError, frz_fold.FoldDrift) as e:
                fold_fail.append(f"fold.error {type(e).__name__}: {str(e)[:200]}")
            await conn.execute("SELECT frz.activate($1)", gen)
            structure = json.loads(await conn.fetchval("SELECT frz.assert_generation($1)::text", gen))
            ans = dict(await conn.fetchrow(VERIFY_ANSWERS, surface, rdate, [ckey], gen))
            fd = await conn.fetchrow(FOLD_DELTA, gen, cyc["cycle_id"], cyc["generation_id"]) if frz_fold.enabled() else None
            fold_delta = int(fd["fold"]) + int(fd["ops"]) if fd else 0
            fold_res = {**fold_res, "ops_delta": int(fd["ops"]) if fd else 0}
            ment_sum = int(ans["all_mentions"])
            ans["all_mentions"] = ment_sum - fold_delta          # 운영 all_mentions 는 접기 전(언급 행 단위) 값
            comp_state = "skipped"
            if frz_fold.enabled() and await conn.fetchval(OPTIONAL_COMP):
                oc = await conn.fetchval(OPS_SUM_COMP, cyc["cycle_id"], cyc["generation_id"])
                if oc is None:
                    comp_state = "missing_row"
                    fold_fail.append("answers.comp_mentions ops_row_missing")
                else:
                    comp_state = "checked"
                    if int(oc) != ment_sum:
                        fold_fail.append(f"answers.comp_mentions hub={ment_sum} ops={int(oc)}")
            ops_sum = await conn.fetchrow(OPS_SUM_CYCLE, cyc["cycle_id"], cyc["generation_id"])
            brands = await conn.fetchrow(VERIFY_BRANDS, surface, rdate, [ckey], cyc["cycle_id"], cyc["generation_id"])
            own = list(await conn.fetch(VERIFY_OWN, surface, rdate, [ckey], cyc["cycle_id"], cyc["generation_id"]))
            # S4b 보강 단언(선택 입력): 없으면 건너뜀을 결과에 적는다
            x_fails: list[str] = []
            x_state = "skipped"
            if await conn.fetchval(OPTIONAL_X):
                x_state = "checked"
                bx = await conn.fetchrow(VERIFY_BRANDS_X, surface, rdate, [ckey], cyc["cycle_id"], cyc["generation_id"])
                x_fails += [f"brands_x.{k} {int(bx[k])}" for k in ("positive_diff", "neutral_diff", "negative_diff", "mixed_diff", "types_diff")
                            if int(bx[k])]
                for r in await conn.fetch(VERIFY_OWN_X, surface, rdate, [ckey], cyc["cycle_id"], cyc["generation_id"]):
                    if r["unmapped"]:
                        x_fails.append(f"own_x.{r['own_variant']} variant_unmapped")
                    elif r["differ"]:
                        x_fails.append(f"own_x.{r['own_variant']} rank_multi_differ")
            fails = _load_failures(cf, pf, of) + _axis_failures(ans, ops_sum, brands, own) + x_fails + fold_fail
            if web_missing:
                fails.append(f"web.cells_without_flags {web_missing}")
            if web_partial:
                fails.append(f"web.prompts_not_full_cycle {web_partial}")
            counts = {**dict(await conn.fetchrow(ROW_COUNTS, gen)), "axis_prompts": n_axis, "brand_names": n_names}
            verify = {"structure": structure, "answers": dict(ans), "brands": dict(brands), "own_variants": len(own), "extra": x_state,
                      "fold": {**fold_res, "ment_delta": fold_delta, "comp": comp_state}, "fails": fails}
            await conn.execute("UPDATE frz.generation SET row_counts = $2::jsonb, verify = $3::jsonb WHERE gen_key = $1",
                               gen, json.dumps(counts, default=int), json.dumps(verify, default=str))
            res = {**head, "gen_key": gen, "counts": counts,
                   "cells": {k: cf[k] for k in ("cells", "job_unmapped", "answer_missing", "surface_mismatch", "seat_moved", "dup_answers")},
                   "fail_jobs": list(cf["fail_jobs"])[:20],
                   "prompts": dict(pf), "ops": {k: of[k] for k in ("changed", "citations_differ", "brand_unmapped")},
                   "brand_unmapped_names": list(of["brand_unmapped_names"])[:20],
                   "ops_differ": len(differ), "released": released, "extra_verify": x_state,
                   "fold": {**fold_res, "ment_delta": fold_delta, "comp": comp_state}, "fails": fails}
            if fails:
                raise _Abort({**res, "status": "assert_failed"})
            if not commit:
                raise _Abort({**res, "status": "dry_run_ok"})
            res["status"] = "committed"
    except _Abort as a:
        res = a.result
    res["sec"] = round(time.monotonic() - t0, 2)
    return res


async def run(conn: asyncpg.Connection, *, cycles: list[Any] | None = None, commit: bool = False, force: bool = False,
              limit: int | None = None) -> ImportReport:
    """회차마다 트랜잭션 1개로 이관한다. commit=False(기본)면 회차마다 끝에서 롤백(같은 단언을 돌린다)."""
    missing = await check_inputs(conn)
    if missing:
        raise RuntimeError(f"mig_src 입력 표 없음 또는 권한 없음: {', '.join(missing)}(추출 export.py --frz → 적재, migrator 롤)")
    rows = await conn.fetch(CYCLES, cycles)
    if limit is not None:
        rows = rows[:limit]
    rep = ImportReport(commit=commit)
    for r in rows:
        rep.cycles.append(await _import_one(conn, r, commit=commit, force=force))
    return rep
