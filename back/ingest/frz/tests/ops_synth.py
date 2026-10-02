"""합성 운영 이관 입력(mig_src.frz_ops_*): 허브 픽스처 회차의 rd 대표 답변을 운영 세대처럼 꾸민다(고객 데이터 아님).

축 합(frz_ops_sum_*)은 기대 동결 상태 표(_exp_a·_exp_ab·_exp_c: 답변·브랜드·인용 행)에서 이관기 단언과 같은 정의로 센다. 기본 기대 상태 =
지금 rd 의 셀 답변 행. 바뀐 답변 시험은 그 답변의 기대 행을 시험이 손으로 계산해 바꿔 넣는다(이관기 변환과 독립인 재계산).
"""
from __future__ import annotations

import json
import pathlib
import uuid

import asyncpg

MIG_SRC_FRZ = pathlib.Path(__file__).resolve().parents[3] / "migration" / "mig_src_frz.sql"

OPS_HEAD = """
INSERT INTO mig_src.frz_ops_marker (phase, cycle_id, surface, project_id, active_generation_id, captured_at)
SELECT p.phase, i.cycle_id, i.surface, i.scope_project_id, $2::uuid, now()
  FROM ing.cycle i CROSS JOIN (VALUES ('start'), ('end')) p(phase) WHERE i.cyc_key = $1::int4;
"""
OPS_GEN = """
INSERT INTO mig_src.frz_ops_generation (generation_id, cycle_id, generator_version, status, started_at, finished_at, row_counts, checksum,
                                        roster_snapshot, base_universe, target_universe, noise_snapshot)
SELECT $2::uuid, i.cycle_id, 'synthetic', 'ready', now(), now(), '{}'::jsonb, NULL, '{"roster": 1}'::jsonb, '{}'::jsonb, NULL, '{}'::jsonb
  FROM ing.cycle i WHERE i.cyc_key = $1::int4
"""
OPS_CELLS = """
INSERT INTO mig_src.frz_ops_cell (cycle_id, generation_id, cycle_week, job_id, run_id, prompt_id, engine, country, measured_at)
SELECT i.cycle_id, $2::uuid, a.round_date, j.job_id, r.run_id, d.prompt_id, e.code, g.code, coalesce(j.measured_at, now())
  FROM rd.answer a JOIN ing.cycle i ON i.cyc_key = a.cyc_key
  JOIN rd.job j ON j.answer_key = a.answer_key JOIN ing.run r ON r.run_key = j.run_key
  JOIN rd.dim_prompt d ON d.prompt_key = a.prompt_key JOIN rd.dim_engine e ON e.engine_key = a.engine_key
  JOIN rd.dim_country g ON g.geo_key = a.geo_key
 WHERE a.cyc_key = $1::int4 AND a.is_rep
"""
OPS_PROMPTS = """
INSERT INTO mig_src.frz_ops_prompt (cycle_id, generation_id, prompt_id, project_id, lang, catalog_brands, funnel_catalog, funnel_scope,
                                    brand_presence_resolved, presence_set, list_type, depth1, depth2, depth3, regions, is_korean, in_root_catalog,
                                    catalog_status, catalog_deleted, in_full_cycle, expected_cells, window_cells, report_fs, unit_base, site_country, site_lang)
SELECT DISTINCT c.cycle_id, c.generation_id, c.prompt_id, i.scope_project_id, NULL::text,
       ARRAY(SELECT n.name FROM rd.dim_brand_name n WHERE n.kind = 1 AND (n.own_bit & d.cat_mask) <> 0 ORDER BY n.name), NULL::text, NULL::text,
       NULL::text, '{}'::text[], NULL::text, NULL::text, NULL::text, NULL::text, d.regions, d.is_korean::int, d.in_root_catalog::int, NULL::text,
       0, 1, 1, 1, NULL::int, NULL::text, NULL::text, NULL::text
  FROM mig_src.frz_ops_cell c JOIN ing.cycle i ON i.cycle_id = c.cycle_id JOIN rd.dim_prompt d ON d.prompt_id = c.prompt_id
 WHERE c.generation_id = $1::uuid
"""
# S4 웹 셀 판정(운영 summary_answers 유닛 플래그 + summary_url_hits): job_id 해시로 정한 합성 값(허브 판정과 일부러 다르게 둔다)
OPS_WEB = """
INSERT INTO mig_src.frz_ops_web (cycle_id, generation_id, job_id, report_fs, unit_owned, unit_target, url_registered, url_owned_hit, url_target_hit)
SELECT c.cycle_id, c.generation_id, c.job_id,
       CASE WHEN abs(hashtext(c.job_id::text)) % 3 = 0 THEN NULL ELSE 700 + abs(hashtext(c.job_id::text)) % 2 END,
       abs(hashtext(c.job_id::text || 'o')) % 2, abs(hashtext(c.job_id::text || 't')) % 2,
       true, abs(hashtext(c.job_id::text || 'u')) % 2 = 1, abs(hashtext(c.job_id::text || 'h')) % 2 = 1
  FROM mig_src.frz_ops_cell c JOIN ing.cycle i ON i.cycle_id = c.cycle_id
 WHERE c.generation_id = $1::uuid AND i.surface = 'website'
"""
# 기대 동결 상태(기본 = 지금 rd 셀 행)
EXP = """
DROP TABLE IF EXISTS _exp_a, _exp_ab, _exp_c;
CREATE TEMP TABLE _exp_a AS SELECT a.* FROM rd.answer a WHERE a.cyc_key = {k} AND a.is_rep;
CREATE TEMP TABLE _exp_ab AS SELECT b.* FROM rd.answer_brand b JOIN _exp_a a USING (surface, round_date, answer_key);
CREATE TEMP TABLE _exp_c AS SELECT x.* FROM rd.citation x JOIN _exp_a a USING (surface, round_date, answer_key);
ALTER TABLE _exp_a ADD COLUMN am int;   -- 운영 all_mentions(언급 행 단위) 이 ment_total 과 다를 때만(brand_card_fold 접기 답변), 아니면 NULL
"""
SUMS = """
INSERT INTO mig_src.frz_ops_sum_cycle (cycle_id, generation_id, cells, cells_ifc, all_mentions, all_citations, has_any_brand, domain_citations)
SELECT $1::uuid, $2::uuid, count(*), count(*), coalesce(sum(coalesce(a.am, a.ment_total)), 0), coalesce(sum(a.cit_n_all), 0),
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM _exp_ab b WHERE b.answer_key = a.answer_key AND b.brand_key <> 0)),
       (SELECT count(*) FROM _exp_c)
  FROM _exp_a a;
INSERT INTO mig_src.frz_ops_sum_comp (cycle_id, generation_id, comp_mentions)
SELECT $1::uuid, $2::uuid, coalesce(sum(a.ment_total), 0) FROM _exp_a a;
INSERT INTO mig_src.frz_ops_sum_brand (cycle_id, generation_id, brand_name, mentions, answers, comp_rank_sum, comp_ranked_answers)
SELECT $1::uuid, $2::uuid, n.name, sum(b.mention_count), sum(b.rid_n), coalesce(sum(b.rk) FILTER (WHERE b.competitive AND b.rk > 0), 0),
       count(*) FILTER (WHERE b.competitive AND b.rk > 0)
  FROM _exp_ab b JOIN rd.dim_brand_name n ON n.brand_key = b.brand_key WHERE b.brand_key <> 0 GROUP BY n.name;
INSERT INTO mig_src.frz_ops_sum_own (cycle_id, generation_id, own_variant, tracked_answers, own_mentions, own_positive, own_negative, own_signals)
SELECT $1::uuid, $2::uuid, v.name,
       count(*) FILTER (WHERE (a.own_mask & v.bits) <> 0),
       coalesce(sum(CASE WHEN v.bits & 1 <> 0 THEN a.ment_h ELSE 0 END + CASE WHEN v.bits & 2 <> 0 THEN a.ment_k ELSE 0 END
                    + CASE WHEN v.bits & 4 <> 0 THEN a.ment_g ELSE 0 END), 0),
       coalesce(sum(CASE WHEN v.bits & 1 <> 0 THEN a.sent_pos_h ELSE 0 END + CASE WHEN v.bits & 2 <> 0 THEN a.sent_pos_k ELSE 0 END
                    + CASE WHEN v.bits & 4 <> 0 THEN a.sent_pos_g ELSE 0 END), 0),
       coalesce(sum(CASE WHEN v.bits & 1 <> 0 THEN a.sent_neg_h ELSE 0 END + CASE WHEN v.bits & 2 <> 0 THEN a.sent_neg_k ELSE 0 END
                    + CASE WHEN v.bits & 4 <> 0 THEN a.sent_neg_g ELSE 0 END), 0),
       coalesce(sum(CASE WHEN v.bits & 1 <> 0 THEN a.sent_all_h ELSE 0 END + CASE WHEN v.bits & 2 <> 0 THEN a.sent_all_k ELSE 0 END
                    + CASE WHEN v.bits & 4 <> 0 THEN a.sent_all_g ELSE 0 END), 0)
  FROM (SELECT 'ALL' AS name, (SELECT bit_or(own_bit) FROM rd.dim_brand_name WHERE kind = 1) AS bits
        UNION ALL SELECT name, own_bit FROM rd.dim_brand_name WHERE kind = 1) v
  CROSS JOIN _exp_a a
 GROUP BY v.name
"""
# S4b 보강 합(선택 입력): 운영 fold 정의(브랜드 감정·유형 합, 당사 순위 tp·복수 언급 mc)를 기대 상태 표에서 독립으로 센다
SUMS_X = """
INSERT INTO mig_src.frz_ops_sum_brand_x
SELECT $1::uuid, $2::uuid, n.name, sum(b.s_pos), sum(b.s_neu), sum(b.s_neg), sum(b.s_mix), sum(b.t_mention), sum(b.t_recommendation),
       sum(b.t_comparison), sum(b.t_definition), sum(b.t_final_choice)
  FROM _exp_ab b JOIN rd.dim_brand_name n ON n.brand_key = b.brand_key WHERE b.brand_key <> 0 GROUP BY n.name;
INSERT INTO mig_src.frz_ops_sum_own_x
SELECT $1::uuid, $2::uuid, v.name, coalesce(sum(x.tp), 0), count(x.tp), count(*) FILTER (WHERE x.tp <= 1), count(*) FILTER (WHERE x.tp <= 3),
       count(*) FILTER (WHERE x.mc >= 2)
  FROM (SELECT 'ALL' AS name, (SELECT bit_or(own_bit) FROM rd.dim_brand_name WHERE kind = 1) AS bits
        UNION ALL SELECT name, own_bit FROM rd.dim_brand_name WHERE kind = 1) v
  CROSS JOIN LATERAL (SELECT (SELECT min(r) FROM unnest(ARRAY[CASE WHEN v.bits & 1 <> 0 THEN a.own_rk_h END, CASE WHEN v.bits & 2 <> 0 THEN a.own_rk_k END,
                                                          CASE WHEN v.bits & 4 <> 0 THEN a.own_rk_g END]) r WHERE r > 0) AS tp,
                             (CASE WHEN v.bits & 1 <> 0 THEN a.ment_h ELSE 0 END + CASE WHEN v.bits & 2 <> 0 THEN a.ment_k ELSE 0 END
                              + CASE WHEN v.bits & 4 <> 0 THEN a.ment_g ELSE 0 END) AS mc
                        FROM _exp_a a) x
 GROUP BY v.name
"""
CLEAR_SUMS = """
DELETE FROM mig_src.frz_ops_sum_cycle WHERE generation_id = $1::uuid;
DELETE FROM mig_src.frz_ops_sum_comp WHERE generation_id = $1::uuid;
DELETE FROM mig_src.frz_ops_sum_brand WHERE generation_id = $1::uuid;
DELETE FROM mig_src.frz_ops_sum_own WHERE generation_id = $1::uuid;
DELETE FROM mig_src.frz_ops_sum_brand_x WHERE generation_id = $1::uuid;
DELETE FROM mig_src.frz_ops_sum_own_x WHERE generation_id = $1::uuid;
"""


async def ensure_mig_src(c: asyncpg.Connection) -> None:
    await c.execute(MIG_SRC_FRZ.read_text(encoding="utf-8"))


async def make_ops(c: asyncpg.Connection, cyc_key: int) -> tuple[uuid.UUID, uuid.UUID]:
    """회차 하나의 합성 운영 세대. 반환 = (운영 cycle_id, generation_id). 축 합은 기본 기대 상태로 채운다."""
    await ensure_mig_src(c)
    gen = uuid.uuid4()
    cycle_id = await c.fetchval("SELECT cycle_id FROM ing.cycle WHERE cyc_key = $1", cyc_key)
    for q in (OPS_HEAD, OPS_GEN, OPS_CELLS):
        await c.execute(q, cyc_key, gen)
    await c.execute(OPS_PROMPTS, gen)
    await c.execute(OPS_WEB, gen)
    await c.execute("INSERT INTO mig_src.frz_ops_url_cov SELECT $1::uuid WHERE EXISTS (SELECT 1 FROM ing.cycle WHERE cyc_key = $2 AND surface = 'website')",
                    gen, cyc_key)
    await c.execute(EXP.format(k=int(cyc_key)))
    await fold_expected(c)
    await write_sums(c, cycle_id, gen)
    return cycle_id, gen


async def fold_expected(c: asyncpg.Connection) -> list[int]:
    """brand_card_fold 가 켜져 있으면 기대 상태를 운영 summary 접기로 바꾼다(운영 세대는 접힌 세부층에서 생성됐다): 공존 답변의 브랜드 행 =
    독립 오라클(fold_oracle.oracle, 구현 ingest.frz.fold 를 쓰지 않는다)의 접힌 행, 답변 당사 열 = 그 행에서(fold_oracle.answer_cols),
    운영 all_mentions = 접기 전 ment_total(am). 오라클 행이 rd 와 같은 답변(접기 몫 없음)은 그대로. 반환 = 바꾼 답변 키."""
    from ingest.frz import fold as FD
    from ingest.frz.tests.fold_oracle import answer_cols, oracle, rows_of

    if not FD.enabled():
        return []
    keys = [int(r[0]) for r in await c.fetch(
        "SELECT DISTINCT answer_key FROM _exp_ab WHERE brand_key <> 0 GROUP BY answer_key, brand_key "
        "HAVING bool_or(competitive) AND bool_or(NOT competitive)")]
    changed = []
    for k in sorted(keys):
        job = await c.fetchval("SELECT job_id FROM rd.job WHERE answer_key = $1", k)
        ex = await oracle(c, job)
        if ex == await rows_of(c, "rd", k):
            continue
        changed.append(k)
        rows = [{"brand_key": bk, "competitive": comp, **v} for (bk, comp), v in ex.items()]
        await c.execute("DELETE FROM _exp_ab WHERE answer_key = $1", k)
        await c.execute("""INSERT INTO _exp_ab SELECT (jsonb_populate_record(NULL::_exp_ab, to_jsonb(t) || e.j)).*
                             FROM (SELECT * FROM rd.answer_brand b WHERE b.answer_key = $1 ORDER BY brand_key, competitive LIMIT 1) t
                             CROSS JOIN LATERAL jsonb_array_elements($2::jsonb) e(j)""", k, json.dumps(rows))
        o = answer_cols(ex)
        await c.execute("UPDATE _exp_a SET am = ment_total, " + ", ".join(f"{x} = {int(v)}" for x, v in o.items()) + " WHERE answer_key = $1", k)
    return changed


async def write_sums(c: asyncpg.Connection, cycle_id: uuid.UUID, gen: uuid.UUID) -> None:
    """_exp_* 에서 축 합을 다시 쓴다."""
    for q in CLEAR_SUMS.strip().split(";\n"):
        if q.strip():
            await c.execute(q, gen)
    for q in SUMS.strip().split(";\nINSERT") + SUMS_X.strip().split(";\nINSERT"):
        q = q if q.startswith("INSERT") else "INSERT" + q
        await c.execute(q, cycle_id, gen)
