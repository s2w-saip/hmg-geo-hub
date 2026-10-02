"""동결 카드 읽기 지연(DB-v2.32, 가번호 DB-vNEXT-frz-perf + analytics.citations.domains 동결 접기, be/int3-frzperf) 값 동치 시험.

1. 뷰 동치: 새 카드 뷰(frz.card_*)·웹 카드 뷰(frz.card_*_w) = 바꾸기 전 정의(DB-v2.24 P126·P127 본문을 여기서 다시 만든 부분 질의)와 행 다중집합이
   같다(EXCEPT ALL 양방향 0). 준비는 두 정의가 갈릴 수 있는 경우를 전부 만든다: 보관(글로벌·웹, 보관 갈래와 rd 갈래 제외), 활성 아닌 세대의
   셀(building 세대, 셀·프롬프트 축 복사 = 같은 답변이 두 세대 셀), in_full_cycle 거짓 프롬프트, 웹 표면 셀이 글로벌 카드 뷰의 surface <> 1 갈래.
2. 동결 접기: 동결 읽기 도메인 목록의 인용 프롬프트 수(gp)를 MATERIALIZED g0 에서 센 값 = 카드 뷰를 다시 읽어 센 값(바꾸기 전 문장).
롤백 전용(staged), 합성 픽스처.
"""
from __future__ import annotations

import pathlib
from typing import Any

import pytest
from sqlalchemy import text

from app.core.config import set_settings
from tests.support import ADMIN, Sql, load_named_sql, needs_db, resolve_test_profile, staged

pytestmark = needs_db
FREEZE = "SELECT frz.freeze_cycle(cycle_id, '{}'::jsonb) FROM ing.cycle WHERE cyc_key IN (10, 11, 21) ORDER BY cyc_key"
BG = load_named_sql(pathlib.Path(__file__).resolve().parents[2] / "app/features/analytics/citations/domains/tests/bg.pgsql")
# 동결 회차 11 셀(답변 2·3·4, in_full_cycle 참)에 템플릿 답변 1 의 인용(계정 출처 linkedin.com/hyundai-motor-group 포함)과 도메인 대표 행
# 'linkedin.com' 인용을 복사한다(픽스처 동결 셀에는 인용이 거의 없어 카드 도메인이 비면 비카드로 내려간다). bg.pgsql @host_row 가 차원 행을 만든다
CELL_CITES = """
INSERT INTO rd.citation (round_date, answer_key, url_key, source_key, cyc_key, prompt_key, surface, ord, project_key, engine_key, geo_key,
                         lang_key, bgrp, scope_key, owner_key, cit_in, gap, dflt, loc_owned, tgt_hit, src_first, rule_ver, cit_in_nc, is_rep)
SELECT a.round_date, a.answer_key, c.url_key, c.source_key, a.cyc_key, a.prompt_key, a.surface, c.ord, a.project_key, a.engine_key, a.geo_key,
       a.lang_key, a.bgrp, c.scope_key, c.owner_key, c.cit_in, c.gap, c.dflt, c.loc_owned, c.tgt_hit, c.src_first, c.rule_ver, c.cit_in_nc, a.is_rep
  FROM rd.citation c CROSS JOIN rd.answer a
 WHERE c.surface = 1 AND c.round_date = '2026-09-14' AND c.answer_key = 1 AND a.surface = 1 AND a.cyc_key = 11 AND a.answer_key IN (2, 3, 4)
"""
FACTS = ("answer", "answer_brand", "citation")


async def _x(conn: Any, sql: str) -> Any:
    return await conn.execute(text(sql).execution_options(hgh_sql_guard=False))


async def _cols(conn: Any, t: str) -> list[str]:
    r = await _x(conn, f"SELECT attname FROM pg_attribute WHERE attrelid = 'rd.{t}'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum")
    return [x[0] for x in r.all()]


def _old_card(t: str, cols: list[str]) -> str:
    """DB-v2.24 P126 카드 뷰 본문(바꾸기 전)."""
    rd = ", ".join({"is_rep": "true AS is_rep", "bgrp": "CASE WHEN c.surface = 1 THEN q.cat_mask ELSE x.bgrp END AS bgrp", "surface": "c.surface",
                    "round_date": "c.round_date", "cyc_key": "c.cyc_key", "answer_key": "c.answer_key"}.get(a, f"x.{a}") for a in cols)
    kp = ", ".join({"is_rep": "true AS is_rep", "round_date": "c.round_date", "cyc_key": "c.cyc_key", "surface": "c.surface", "answer_key": "c.answer_key",
                    "bgrp": "CASE WHEN c.surface = 1 THEN q.cat_mask ELSE k.bgrp END AS bgrp"}.get(a, f"k.{a}") for a in cols)
    return (f"SELECT {rd} FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = 'active' "
            f"JOIN frz.prompt q ON q.gen_key = c.gen_key AND q.prompt_key = c.prompt_key AND q.in_full_cycle "
            f"JOIN rd.{t} x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key AND x.answer_key = c.answer_key "
            f"WHERE NOT EXISTS (SELECT 1 FROM frz.kept p WHERE p.gen_key = c.gen_key AND p.answer_key = c.answer_key) "
            f"UNION ALL SELECT {kp} FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = 'active' "
            f"JOIN frz.prompt q ON q.gen_key = c.gen_key AND q.prompt_key = c.prompt_key AND q.in_full_cycle "
            f"JOIN frz.keep_{t} k ON k.gen_key = c.gen_key AND k.answer_key = c.answer_key")


def _old_web(t: str, cols: list[str]) -> str:
    """DB-v2.24 P127 웹 카드 뷰 본문(바꾸기 전)."""
    w = ("(w.report_fs IS NOT NULL AND w.report_fs <> ALL (ARRAY(SELECT e.file_seq FROM app.website_report_excluded e))) AS unit_in, "
         "coalesce(w.unit_owned, false) AS unit_owned, coalesce(w.unit_target, false) AS unit_target, w.url_registered, w.url_owned_hit, w.url_target_hit")
    seat = {"is_rep": "true AS is_rep", "surface": "c.surface", "round_date": "c.round_date", "cyc_key": "c.cyc_key", "answer_key": "c.answer_key"}
    rd = ", ".join(seat.get(a, f"x.{a}") for a in cols)
    kp = ", ".join(seat.get(a, f"k.{a}") for a in cols)
    return (f"SELECT {rd}, {w} FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = 'active' AND g.surface = 2 "
            f"JOIN rd.{t} x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key AND x.answer_key = c.answer_key "
            f"LEFT JOIN frz.cell_web w ON w.gen_key = c.gen_key AND w.answer_key = c.answer_key "
            f"WHERE c.surface = 2 AND NOT EXISTS (SELECT 1 FROM frz.kept p WHERE p.gen_key = c.gen_key AND p.answer_key = c.answer_key) "
            f"UNION ALL SELECT {kp}, {w} FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = 'active' AND g.surface = 2 "
            f"JOIN frz.keep_{t} k ON k.gen_key = c.gen_key AND k.answer_key = c.answer_key "
            f"LEFT JOIN frz.cell_web w ON w.gen_key = c.gen_key AND w.answer_key = c.answer_key WHERE c.surface = 2")


async def _keep_changed(conn: Any, cyc: int) -> int:
    """회차 cyc 동결 답변 하나(인용 있는 답변 우선)를 보관 관문으로 바꾼다(언급 +2, 인용 행 1 삭제): 보관 갈래·rd 갈래 제외가 둘 다 생긴다."""
    ak = (await _x(conn, f"""SELECT c.answer_key FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = 'active'
                              WHERE c.cyc_key = {cyc}
                              ORDER BY EXISTS (SELECT 1 FROM rd.citation x WHERE x.answer_key = c.answer_key) DESC,
                                       EXISTS (SELECT 1 FROM rd.answer_brand b WHERE b.answer_key = c.answer_key) DESC, c.answer_key LIMIT 1""")).scalar()
    assert ak is not None, f"전제: 회차 {cyc} 에 동결 답변"
    await _x(conn, f"SELECT frz.keep_rewrite(ARRAY[{ak}], 'apply')")
    await _x(conn, f"UPDATE rd.answer_brand SET mention_count = mention_count + 2 WHERE answer_key = {ak}")
    await _x(conn, f"UPDATE rd.answer SET ment_total = ment_total + 2 WHERE answer_key = {ak}")
    await _x(conn, f"DELETE FROM rd.citation WHERE answer_key = {ak} AND ord = (SELECT max(ord) FROM rd.citation WHERE answer_key = {ak})")
    await _x(conn, f"SELECT frz.keep_settle(ARRAY[{ak}], 'apply')")
    return int(ak)


async def _building_copy(conn: Any, cyc: int) -> None:
    """회차 cyc 활성 세대의 셀·프롬프트 축을 복사한 building 세대(활성 아님): 두 정의 모두 이 셀을 읽지 않아야 한다. 보관도 하나 단다."""
    await _x(conn, f"""
        WITH a AS (SELECT * FROM frz.generation WHERE cyc_key = {cyc} AND state = 'active'),
             n AS (INSERT INTO frz.generation (cyc_key, surface, source, state) SELECT cyc_key, surface, 'hub', 'building' FROM a RETURNING gen_key),
             c AS (INSERT INTO frz.cell (gen_key, answer_key, surface, cyc_key, round_date, prompt_key, engine_key, geo_key)
                   SELECT n.gen_key, c.answer_key, c.surface, c.cyc_key, c.round_date, c.prompt_key, c.engine_key, c.geo_key
                     FROM frz.cell c JOIN a ON a.gen_key = c.gen_key CROSS JOIN n RETURNING 1)
        INSERT INTO frz.prompt (gen_key, prompt_key, cyc_key, in_full_cycle, in_root_catalog, catalog_deleted, cat_mask, funnel_key)
        SELECT n.gen_key, q.prompt_key, q.cyc_key, q.in_full_cycle, q.in_root_catalog, q.catalog_deleted, q.cat_mask, q.funnel_key
          FROM frz.prompt q JOIN a ON a.gen_key = q.gen_key CROSS JOIN n""")
    await _x(conn, f"""INSERT INTO frz.kept (gen_key, answer_key, src)
                       SELECT c.gen_key, min(c.answer_key), 'apply' FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key
                        WHERE g.cyc_key = {cyc} AND g.state = 'building' GROUP BY c.gen_key""")


async def test_card_views_equal_previous_definition():
    async with staged(Sql(FREEZE), role=None) as conn:
        assert "DB-v2.32" in ((await _x(conn, "SELECT obj_description('frz.card_citation'::regclass, 'pg_class')")).scalar() or "")
        kept = [await _keep_changed(conn, 11), await _keep_changed(conn, 21)]
        await _building_copy(conn, 11)
        await _building_copy(conn, 21)
        # 활성 세대 프롬프트 하나를 in_full_cycle 거짓으로(카드 게이트)
        await _x(conn, """UPDATE frz.prompt q SET in_full_cycle = false FROM frz.generation g
                           WHERE g.gen_key = q.gen_key AND g.state = 'active' AND g.cyc_key = 10
                             AND q.prompt_key = (SELECT min(prompt_key) FROM frz.prompt q2 WHERE q2.gen_key = g.gen_key)""")
        n_kept = (await _x(conn, "SELECT count(*) FROM frz.kept")).scalar()
        assert n_kept >= 4, n_kept
        for t in FACTS:
            cols = await _cols(conn, t)
            for view, old in ((f"frz.card_{t}", _old_card(t, cols)), (f"frz.card_{t}_w", _old_web(t, cols))):
                n_new = (await _x(conn, f"SELECT count(*) FROM {view}")).scalar()
                n_old = (await _x(conn, f"SELECT count(*) FROM ({old}) o")).scalar()
                diff = (await _x(conn, f"SELECT count(*) FROM ((SELECT * FROM {view} EXCEPT ALL SELECT * FROM ({old}) o) "
                                       f"UNION ALL (SELECT * FROM ({old}) o EXCEPT ALL SELECT * FROM {view})) d")).scalar()
                assert n_new > 0 and n_new == n_old and diff == 0, (view, n_new, n_old, diff)
                # 보관한 답변은 보관 갈래 한 벌만(rd 갈래 제외), 같은 다중집합 안에서 확인
                k = (await _x(conn, f"SELECT count(*) FROM {view} WHERE answer_key = ANY(ARRAY{kept})")).scalar()
                k_old = (await _x(conn, f"SELECT count(*) FROM ({old}) o WHERE answer_key = ANY(ARRAY{kept})")).scalar()
                assert k == k_old, (view, k, k_old)
        # 글로벌 카드 뷰가 웹 표면 셀도 낸다(surface <> 1 갈래 = bgrp 는 rd 값)
        assert (await _x(conn, "SELECT count(*) FROM frz.card_answer WHERE surface = 2")).scalar() > 0


async def test_view_plan_filters_on_cell_scan():
    """계획 모양: 세대·보관 판정이 셀 스캔의 해시 부분계획 필터다(rd 행마다 세대·보관 탐침이 붙지 않는다)."""
    async with staged(Sql(FREEZE), role=None) as conn:
        plan = "\n".join(x[0] for x in (await _x(conn, "EXPLAIN SELECT count(*) FROM frz.card_citation WHERE surface = 1 "
                                                       "AND round_date = '2026-09-14' AND cyc_key = ANY('{11}'::int4[])")).all())
        assert "hashed SubPlan" in plan and "Anti Join" not in plan and "generation_pkey" not in plan, plan


@pytest.mark.parametrize("limit", ["50", "0"])
async def test_frozen_domains_gp_from_g0_equals_rescan(settings, client_as, monkeypatch, limit):
    """동결 읽기 도메인 목록: 접힌 키 인용 프롬프트 수를 g0(MATERIALIZED)에서 센 응답 = 카드 뷰를 다시 읽어 센 응답(바꾸기 전 문장)."""
    from app.features.analytics.citations.domains import queries as dq

    spec = "freeze_at_publish,cell_rep,catalog_incl_deleted,rep_pick_latest_first,web_registered_only,domains_card_by_host"
    set_settings(settings.model_copy(update={"legacy_profile": resolve_test_profile(spec)}))
    params = {"surface": "global", "limit": limit, "card": "true"}          # 창 = 최신 동결 회차(11, 2026-09-14)
    seen: list[str] = []
    orig = dq.domains_sql

    def spy(*a: Any, **kw: Any) -> Any:
        s = orig(*a, **kw)
        seen.append(s.text)
        return s
    monkeypatch.setattr(dq, "domains_sql", spy)
    try:
        async with staged(Sql(BG["host_row"]), Sql(FREEZE), Sql(CELL_CITES)):
            async with client_as(ADMIN) as c:
                new = (await c.get("/v1/citations/domains", params=params)).json()
            monkeypatch.setattr(dq, "frozen_read", lambda ms: False)       # 접기 모양만 옛 문장(표 이름 자리는 그대로 동결 뷰)
            async with client_as(ADMIN) as c:
                old = (await c.get("/v1/citations/domains", params=params)).json()
    finally:
        set_settings(settings)
    assert "frz.card_citation" in seen[0] and "frz.card_citation" in seen[1]
    if limit != "0":
        assert "g0 AS MATERIALIZED (" in seen[0] and "FROM g0 JOIN fk ON fk.k = g0.source_key" in seen[0]
        assert "g0 AS MATERIALIZED (" not in seen[1] and "FROM frz.card_citation c JOIN fk ON fk.k = c.source_key" in seen[1]
        rows = {x["skey"]: x for x in new["data"]["items"]}
        assert "linkedin.com/hyundai-motor-group" not in rows and rows["linkedin.com"]["citations"] == 6   # 접힌 키가 실제로 있다(답변 3개 × 2)
        assert rows["linkedin.com"]["citing_prompts"] >= 1
    assert new["data"] == old["data"]
