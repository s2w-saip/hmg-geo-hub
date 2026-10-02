"""judgment_change 큐 소비(IG-2 재판정 14종·IG-3 운영 4종): 앱 쪽 편집(트리거 또는 명시 enqueue) → run_queue → 큐 상태 기록 →
rd 가 같은 app·ing 입력의 bulk 시드와 행 단위 동치. 커밋 경로라 일회 DB(fresh_db). 앱 편집은 슈퍼유저 연결 + 행위자 GUC 로 한다
(api_rw 앱 쓰기 흉내, DB 트리거가 'catalog'·'prompt_kind'·'project_setting' 을 남긴다).
"""
from __future__ import annotations

import asyncpg
import pytest

from ingest.common import config as cfg
from ingest.common.db import LoaderDB
from ingest.cycles.workers.service import run_queue
from ingest.testkit import EQ_TABLES, bulk_equivalence, snapshot
from tests.support import needs_db

ACTOR = "5eed0000-0000-4000-8000-000000000001"
TABLES = EQ_TABLES


async def _app(url: str, sql: str) -> None:
    """앱 편집(행위자 GUC). 첫 호출 전에 픽스처 적재 때 트리거가 남긴 대기 요청(합성 카탈로그 INSERT)을 적용 완료로 치운다."""
    c = await asyncpg.connect(url)
    try:
        async with c.transaction():
            await c.execute("UPDATE app.judgment_change SET status = 'applied', applied_at = now() WHERE status = 'pending' AND requested_at < now()")
            await c.execute(f"SELECT set_config('app.actor_id', '{ACTOR}', true), set_config('app.actor_type', 'user', true)")
            await c.execute(sql)
    finally:
        await c.close()


async def _fetch(url: str, sql: str, *a):
    c = await asyncpg.connect(url)
    try:
        return await c.fetch(sql, *a)
    finally:
        await c.close()


async def _drain(url: str, **kw):
    return await run_queue(LoaderDB(url, role="loader"), **kw)


async def _assert_equal(url: str) -> None:
    strict, referenced = await bulk_equivalence(url, TABLES)
    assert not strict, {t: (v["len"], v["only_a"][:2], v["only_b"][:2]) for t, v in strict.items()}
    assert not referenced, referenced


@needs_db
async def test_catalog_and_prompt_kind_via_triggers(fresh_db):
    base = (await _fetch(fresh_db, "SELECT coalesce(max(change_id), 0) FROM app.judgment_change"))[0][0]
    await _app(fresh_db, """
      UPDATE app.prompt SET brand_code = 'Kia', depth2 = 'D2c' WHERE prompt_id = 'c1000000-0000-4000-8000-000000000002';
      INSERT INTO app.prompt (prompt_id, project_id, text, brand_code, list_type, depth1, funnel_stage, kind, scope_prompt_id, status, created_by)
      VALUES ('c1000000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-000000000001', 'not in catalog', 'Genesis', 'L3', 'D9', 'F7',
              'single', 'b0000000-0000-4000-8000-000000000007', 'done', '5eed0000-0000-4000-8000-000000000001');
      UPDATE app.prompt SET kind = 'acr' WHERE prompt_id = 'c1000000-0000-4000-8000-000000000006';""")
    kinds = [r[0] for r in await _fetch(fresh_db, "SELECT kind FROM app.judgment_change WHERE change_id > $1 ORDER BY change_id", base)]
    assert kinds == ["catalog", "catalog", "prompt_kind"]              # DB 트리거가 남긴 요청(앱은 직접 넣지 않는다)
    out = await _drain(fresh_db)
    assert [o.status for o in out] == ["applied"] * 3, out
    rows = await _fetch(fresh_db, "SELECT status, applied_load_id, applied_at IS NOT NULL AS t FROM app.judgment_change WHERE change_id > $1", base)
    assert all(r["status"] == "applied" and r["applied_load_id"] and r["t"] for r in rows)
    loads = await _fetch(fresh_db, "SELECT kind, status FROM ing.load WHERE load_id = ANY($1::bigint[])", [r["applied_load_id"] for r in rows])
    assert {(r["kind"], r["status"]) for r in loads} == {("judgment", "committed")}
    # SP7 이 루트 카탈로그에 들어와 답변 6(US chatgpt) 이 모수가 된다(손계산)
    elig = await _fetch(fresh_db, """SELECT a.elig, a.cat_mask FROM rd.answer a JOIN rd.job j ON j.surface = a.surface AND j.round_date = a.round_date
                                    AND j.answer_key = a.answer_key WHERE j.job_id = '90000000-0000-4000-8000-000000000006'""")
    assert elig[0]["elig"] is True and elig[0]["cat_mask"] == 4
    await _assert_equal(fresh_db)


@needs_db
async def test_project_kinds(fresh_db):
    await _app(fresh_db, """
      UPDATE app.project SET brand_code = 'Kia', domain = 'https://other.example.net/' WHERE project_id = 'c0000000-0000-4000-8000-000000000003';
      INSERT INTO app.project_tracked_url (project_id, url, url_norm, created_by)
      VALUES ('c0000000-0000-4000-8000-000000000003', 'https://mybrand.example.com/', 'mybrand.example.com', '5eed0000-0000-4000-8000-000000000001');
      INSERT INTO app.judgment_change (kind, subject_uuids, requested_by) VALUES
        ('project_target_url', ARRAY['c0000000-0000-4000-8000-000000000003']::uuid[], app.actor());
      DELETE FROM app.project_owned_base WHERE project_id = 'c0000000-0000-4000-8000-000000000003';
      INSERT INTO app.judgment_change (kind, subject_uuids, requested_by) VALUES
        ('project_owned_base', ARRAY['c0000000-0000-4000-8000-000000000003']::uuid[], app.actor());""")
    out = await _drain(fresh_db)
    assert sorted(o.kind for o in out) == ["project_owned_base", "project_setting", "project_target_url"]
    assert all(o.status == "applied" for o in out), out
    bg = await _fetch(fresh_db, "SELECT DISTINCT bgrp FROM rd.answer WHERE surface = 3 AND round_date = '2026-09-20' AND cyc_key = ANY('{31}'::int4[])")
    assert [r[0] for r in bg] == [2]                                    # 프로젝트 브랜드 Kia 비트
    await _assert_equal(fresh_db)


@needs_db
async def test_global_rule_kinds(fresh_db):
    await _app(fresh_db, """
      INSERT INTO app.citation_domain_override (domain, category_key, note) VALUES ('reddit.com', 7, 't');
      INSERT INTO app.judgment_change (kind, subject_texts, requested_by) VALUES ('citation_override', ARRAY['reddit.com'], app.actor());
      INSERT INTO app.owned_base (owner_key, kind, prefix, host, brand_code, geo_code, language)
      VALUES (900, 'base', 'caranddriver.com/review', 'caranddriver.com', 'Hyundai', 'US', 'en');
      INSERT INTO app.judgment_change (kind, requested_by) VALUES ('owned_base', app.actor());
      INSERT INTO app.competitor_domain_token (token, brand_name) VALUES ('bmwusa', 'BMW USA');
      INSERT INTO app.judgment_change (kind, requested_by) VALUES ('competitor_token', app.actor());
      INSERT INTO app.hidden_market (surface, country_code) VALUES ('global', 'US');
      INSERT INTO app.judgment_change (kind, subject_texts, requested_by) VALUES ('hidden_market', ARRAY['US'], app.actor());
      UPDATE app.rule_param SET value = '["chatgpt", "gemini", "deepseek"]' WHERE key = 'default_engines';
      INSERT INTO app.judgment_change (kind, subject_texts, requested_by) VALUES ('rule_param', ARRAY['default_engines'], app.actor());""")
    out = await _drain(fresh_db)
    assert [o.status for o in out] == ["applied"] * 5, out
    await _assert_equal(fresh_db)
    # 멱등: 같은 요청을 다시 처리해도 rd 가 그대로다
    c = await asyncpg.connect(fresh_db)
    try:
        before = await snapshot(c, TABLES)
    finally:
        await c.close()
    await _app(fresh_db, """INSERT INTO app.judgment_change (kind, subject_texts, requested_by) SELECT kind, subject_texts, app.actor()
                              FROM app.judgment_change WHERE change_id IN (SELECT applied_change FROM (SELECT max(change_id) AS applied_change, kind
                              FROM app.judgment_change WHERE status = 'applied' GROUP BY kind) x)
                               AND kind IN ('citation_override', 'owned_base', 'competitor_token', 'hidden_market', 'rule_param')""")
    out = await _drain(fresh_db)
    assert [o.status for o in out] == ["applied"] * 5, out
    c = await asyncpg.connect(fresh_db)
    try:
        assert await snapshot(c, TABLES) == before
    finally:
        await c.close()


@needs_db
async def test_citation_override_alone_moves_competitor_brand_both_ways(fresh_db):
    """결함 D1: citation_override 한 건만 처리해도 경쟁사 브랜드가 카테고리를 따라간다(seed-30 §11: Official (Competitor) 일 때만).
    ① 경쟁사 도메인 bmwusa.com → News & Media: competitor_brand_key NULL ② 오버라이드 삭제 → 규칙 카테고리(경쟁사)로 복귀: 'bmw' 다시 채움."""
    async def comp() -> tuple:
        r = (await _fetch(fresh_db, """SELECT c.name, lower(b.bare) FROM rd.dim_source s JOIN app.citation_category c ON c.category_key = s.category_key
                                        LEFT JOIN rd.dim_brand_name b ON b.brand_key = s.competitor_brand_key WHERE s.skey = 'bmwusa.com'"""))[0]
        return tuple(r)

    assert await comp() == ("Official (Competitor)", "bmw")
    await _app(fresh_db, """
      INSERT INTO app.citation_domain_override (domain, category_key, note) VALUES ('bmwusa.com', 5, 't');
      INSERT INTO app.judgment_change (kind, subject_texts, requested_by) VALUES ('citation_override', ARRAY['bmwusa.com'], app.actor());""")
    out = await _drain(fresh_db)
    assert [(o.kind, o.status) for o in out] == [("citation_override", "applied")], out
    assert await comp() == ("News & Media", None)
    await _assert_equal(fresh_db)
    await _app(fresh_db, """
      DELETE FROM app.citation_domain_override WHERE domain = 'bmwusa.com';
      INSERT INTO app.judgment_change (kind, subject_texts, requested_by) VALUES ('citation_override', ARRAY['bmwusa.com'], app.actor());""")
    out = await _drain(fresh_db)
    assert [(o.kind, o.status) for o in out] == [("citation_override", "applied")], out
    assert await comp() == ("Official (Competitor)", "bmw")
    await _assert_equal(fresh_db)


@needs_db
async def test_entity_brand_rule_and_website_catalog(fresh_db):
    await _app(fresh_db, """
      INSERT INTO app.brand_display_alias (alias, canonical_name) VALUES ('TOYOTA', 'Toyota'), ('smart', 'Smart');
      INSERT INTO app.judgment_change (kind, requested_by) VALUES ('brand_rule', app.actor());
      INSERT INTO app.entity_registry (entity_id, name, role) VALUES ('71000000-0000-4000-8000-000000000003', 'Apple', 'excluded')
        ON CONFLICT (entity_id) DO UPDATE SET role = 'excluded';
      INSERT INTO app.judgment_change (kind, subject_uuids, requested_by)
      VALUES ('entity', ARRAY['71000000-0000-4000-8000-000000000003']::uuid[], app.actor());
      UPDATE app.website_prompt SET target_url = 'https://www.kia.com/de/sub/page' WHERE scope_prompt_id = 'b0000000-0000-4000-8000-000000000023';
      INSERT INTO app.judgment_change (kind, requested_by) VALUES ('website_catalog', app.actor());""")
    out = await _drain(fresh_db)
    assert [o.status for o in out] == ["applied"] * 3, out
    await _assert_equal(fresh_db)


@needs_db
async def test_ops_kinds_failure_escalation_and_deferral(fresh_db, monkeypatch):
    await _app(fresh_db, """
      INSERT INTO app.judgment_change (kind, payload, requested_by) VALUES
        ('anchor_pin', '{"job_id": "90000000-0000-4000-8000-000000000005", "anchor": "2026-09-07", "reason": "op"}', app.actor()),
        ('answer_drop', '{"job_id": "90000000-0000-4000-8000-000000000003", "reason": "op"}', app.actor()),
        ('cycle_admin', '{"cycle_id": "f0000000-0000-4000-8000-000000000011", "op": "hide", "hidden_scope": "all"}', app.actor()),
        ('cycle_admin', '{"cycle_id": "f0000000-0000-4000-8000-000000000011", "op": "explode"}', app.actor());
      INSERT INTO app.judgment_change (kind, subject_uuids, requested_by)
      VALUES ('report_publication', ARRAY['c9000000-0000-4000-8000-000000000001']::uuid[], app.actor());""")
    out = await _drain(fresh_db)
    st = [(o.kind, o.status) for o in out]
    assert st == [("anchor_pin", "applied"), ("answer_drop", "applied"), ("cycle_admin", "applied"), ("cycle_admin", "failed"),
                  ("report_publication", "applied")], st
    bad = (await _fetch(fresh_db, "SELECT status, error FROM app.judgment_change WHERE payload->>'op' = 'explode'"))[0]
    assert bad["status"] == "failed" and "cycle_admin payload" in bad["error"]           # 실패 기록은 롤백 뒤 새 트랜잭션
    assert (await _fetch(fresh_db, "SELECT hidden_scope FROM rd.cycle WHERE cyc_key = 11"))[0][0] == 1
    assert (await _fetch(fresh_db, "SELECT count(*) FROM ing.answer_drop WHERE origin = 'operator' AND change_id IS NOT NULL"))[0][0] == 1
    strict, referenced = await bulk_equivalence(fresh_db, TABLES)
    assert not strict and not referenced, strict

    # 상한 초과 → escalated_rebuild(leaf 스왑 이관), rd 불변
    monkeypatch.setenv("HGH_INGEST_ESCALATE_ANSWERS", "3")
    cfg.get_ingest_settings.cache_clear()
    try:
        await _app(fresh_db, "INSERT INTO app.judgment_change (kind, requested_by) VALUES ('brand_rule', app.actor())")
        out = await _drain(fresh_db)
        assert [(o.kind, o.status) for o in out] == [("brand_rule", "escalated_rebuild")]
    finally:
        monkeypatch.delenv("HGH_INGEST_ESCALATE_ANSWERS")
        cfg.get_ingest_settings.cache_clear()

    # 프로젝트 잠금 충돌 → deferred(대기 유지), 잠금이 풀리면 다음 틱에 적용
    await _app(fresh_db, """INSERT INTO app.judgment_change (kind, subject_uuids, requested_by)
                            VALUES ('project_target_url', ARRAY['c0000000-0000-4000-8000-000000000003']::uuid[], app.actor())""")
    holder = await asyncpg.connect(fresh_db)
    try:
        await holder.execute("SELECT pg_advisory_lock(2, hashtext('a0000000-0000-4000-8000-000000000003'))")
        out = await _drain(fresh_db)
        assert [(o.kind, o.status) for o in out] == [("project_target_url", "deferred")]
        assert (await _fetch(fresh_db, "SELECT status FROM app.judgment_change WHERE kind = 'project_target_url'"))[0][0] == "pending"
        await holder.execute("SELECT pg_advisory_unlock_all()")
    finally:
        await holder.close()
    out = await _drain(fresh_db)
    assert [(o.kind, o.status) for o in out] == [("project_target_url", "applied")]
    assert await _drain(fresh_db) == []                                              # 빈 큐


@needs_db
async def test_unowned_kinds_stay_pending(fresh_db):
    await _app(fresh_db, "INSERT INTO app.judgment_change (kind, subject_texts, requested_by) VALUES ('ga4_property', ARRAY['p1'], app.actor())")
    assert await _drain(fresh_db) == []
    assert (await _fetch(fresh_db, "SELECT status FROM app.judgment_change WHERE kind = 'ga4_property'"))[0][0] == "pending"


@pytest.mark.parametrize("kind", ["catalog", "cycle_admin", "dfs_fetch"])
def test_queue_kind_ownership(kind):
    from ingest.cycles.workers.service import QUEUE_KINDS
    assert (kind in QUEUE_KINDS) == (kind != "dfs_fetch")                            # dfs_fetch 는 빠른 경로 전용
