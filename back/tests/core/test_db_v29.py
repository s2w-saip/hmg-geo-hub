"""DB-v2.9(core 8라운드) 확인: P59 계정 국가 스코프의 가상·의사 지오 코드 허용과 정본 표기, P60·P61 GA4 이관 채움, P62 DataForSEO 값 채움
(적재기와 같은 규칙: 뒤 원소 우선·세 값 밖 NULL), P63 뷰 열·권한, P64 known_diff 3행.
채움 SQL 은 패치 파일에서 그대로 떼어 트랜잭션 안에서 돌리고 되돌린다(패치 본문과 시험이 갈라지지 않게)."""
from __future__ import annotations

import pathlib
import re
import uuid

import asyncpg
import pytest

from app.core.auth import DataScope
from app.core.codes import load_refs
from tests.support import ADMIN, DB_URL, needs_db, principal, staged

BACK = pathlib.Path(__file__).resolve().parents[2]
PATCH = (BACK / "db" / "DB-v2.9-patch.sql").read_text(encoding="utf-8")


def _block(tag: str) -> str:
    """패치의 '-- ── <tag>' 절에서 DO $b$ … END $b$; 채움 블록만 떼어 낸다."""
    m = re.search(rf"-- ── {tag} ─+\n(.*?)-- ── P", PATCH, re.S)
    assert m is not None, tag
    b = re.search(r"(DO \$b\$.*?END \$b\$;)", m.group(1), re.S)
    assert b is not None, tag
    return b.group(1)


async def _conn() -> asyncpg.Connection:
    c = await asyncpg.connect(DB_URL)
    await c.execute("SELECT set_config('app.actor_id', $1, false)", str(ADMIN))
    return c


# ── P59 ───────────────────────────────────────────────────────────────────────
@needs_db
async def test_scope_countries_accept_virtual_geo_and_canonicalize_p59(seeded):
    """rd.dim_country 의 의사(SA-Dammam)·가상 브랜드(HYUNDAI-N) 코드를 받고, 대소문자 무시로 정본 표기(rhq 국가 → dim_country 코드)로
    맞추며 중복을 걷는다(첫 등장 순). 어디에도 없는 코드·빈 코드(unknown)는 23503."""
    c = await _conn()
    uid = uuid.uuid4()
    try:
        tr = c.transaction()
        await tr.start()
        try:
            await c.execute("INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands, scope_countries) "
                            "VALUES ($1, $2, 'country', 'none', false, '{Hyundai}', ARRAY['sa-dammam','kr','SA-Dammam','hyundai-n'])",
                            uid, f"t-v29-{uid}@example.test")
            got = await c.fetchval("SELECT scope_countries FROM app.user_account WHERE user_id = $1", uid)
            assert got == ["SA-Dammam", "KR", "HYUNDAI-N"]
            for bad in (["ZZ"], [""], ["KR", "SA-Nowhere"]):
                with pytest.raises(asyncpg.ForeignKeyViolationError):
                    async with c.transaction():
                        await c.execute("UPDATE app.user_account SET scope_countries = $2 WHERE user_id = $1", uid, bad)
            # 정본 표기와 같은 값으로 쓰면 행 값이 바뀌지 않는다(감사 행 없음)
            before = await c.fetchval("SELECT count(*) FROM app.permission_audit_log WHERE target_user_id = $1", uid)
            await c.execute("UPDATE app.user_account SET scope_countries = ARRAY['SA-DAMMAM','kr','hyundai-N'] WHERE user_id = $1", uid)
            assert await c.fetchval("SELECT scope_countries FROM app.user_account WHERE user_id = $1", uid) == ["SA-Dammam", "KR", "HYUNDAI-N"]
            assert await c.fetchval("SELECT count(*) FROM app.permission_audit_log WHERE target_user_id = $1", uid) == before
        finally:
            await tr.rollback()
    finally:
        await c.close()


@needs_db
async def test_virtual_geo_scope_matches_backend_upper_compare_p59(seeded):
    """정본 표기로 저장해도 백엔드 판정은 양쪽 upper 비교(DataScope.of·country_allowed·Refs.geo_key): 표기 정규화가 가시성을 바꾸지 않는다."""
    async with staged() as conn:
        refs = await load_refs(conn)
    c = await _conn()
    uid = uuid.uuid4()
    try:
        await c.execute("INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands, scope_countries) "
                        "VALUES ($1, $2, 'country', 'none', false, '{Hyundai}', ARRAY['sa-dammam'])", uid, f"t-v29b-{uid}@example.test")
        async with staged() as conn:
            p = await principal(conn, uid)
        assert p.scope_countries == ("SA-Dammam",)
        ds = DataScope.of(p, refs)
        assert ds.country_allowed("SA-Dammam") and ds.country_allowed("sa-dammam") and not ds.country_allowed("SA")
        assert refs.geo_key("SA-Dammam") is not None and refs.geo_key("sa-DAMMAM") == refs.geo_key("SA-Dammam")
    finally:
        await c.execute("DELETE FROM app.user_account WHERE user_id = $1", uid)
        await c.close()


@needs_db
async def test_admin_api_upper_input_is_stored_canonical_p59(seeded, client_as):
    """관리 API 는 국가를 upper 로 받는다(schemas._upper): 'SA-DAMMAM' 이 정본 'SA-Dammam' 으로 저장되고 응답도 정본 표기.
    어디에도 없는 코드는 422 unknown_scope_ref(참조 트리거 23503)."""
    c = await _conn()
    uid = uuid.uuid4()
    try:
        await c.execute("INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands, scope_countries) "
                        "VALUES ($1, $2, 'country', 'none', false, '{Hyundai}', '{KR}')", uid, f"t-v29c-{uid}@example.test")
        async with client_as(ADMIN) as cl:
            url = f"/v1/admin/users/{uid}"
            r = await cl.patch(url, json={"scope_countries": ["sa-dammam", "KR"]}, headers={"If-Match": "1"})
            assert r.status_code == 200, r.text
            assert r.json()["data"]["scope_countries"] == ["SA-Dammam", "KR"]
            bad = await cl.patch(url, json={"scope_countries": ["SA-NOWHERE"]}, headers={"If-Match": "2"})
            assert bad.status_code == 422 and bad.json()["error"]["code"] == "unknown_scope_ref", bad.text
    finally:
        await c.execute("DELETE FROM app.user_account WHERE user_id = $1", uid)
        await c.close()


# ── P60·P61 ───────────────────────────────────────────────────────────────────
MIG_SRC = """
CREATE SCHEMA IF NOT EXISTS mig_src;
CREATE TABLE mig_src.ga4_properties (id uuid DEFAULT gen_random_uuid() NOT NULL, brand text NOT NULL, country_code text NOT NULL,
  property_id text, status text NOT NULL, granted_at timestamptz, verified_at timestamptz, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO mig_src.ga4_properties (brand, country_code, property_id, status, verified_at, created_by, updated_at) VALUES
  ('Kia', 'DE', '901', 'active', '2026-09-01 10:00+00', '00000000-0000-4000-8000-0000000000aa', '2026-09-02'),
  ('Kia', 'FR', NULL, 'unmapped', NULL, '00000000-0000-4000-8000-0000000000aa', '2026-09-03'),
  ('Hyundai', ' us', '', 'unmapped', NULL, '00000000-0000-4000-8000-0000000000aa', '2026-09-03'),
  ('Kia', 'IT', NULL, 'unmapped', NULL, '00000000-0000-4000-8000-0000000000aa', '2026-09-03'),
  ('Nope', 'ES', NULL, 'unmapped', NULL, '00000000-0000-4000-8000-0000000000aa', '2026-09-03');
INSERT INTO app.ga4_property (property_id, brand_code, country_code, status) VALUES ('901', 'Kia', 'DE', 'active'),
  ('902', 'Kia', 'IT', 'pending_grant');
"""


@needs_db
async def test_ga4_backfill_from_mig_src_p60_p61(seeded):
    """verified_at 은 같은 property_id 의 원천 값, 대기 시장은 property_id 없는 원천 행(국가 upper·trim, 알 수 없는 브랜드·이미 매핑된 시장 제외)."""
    c = await _conn()
    try:
        tr = c.transaction()
        await tr.start()
        try:
            if await c.fetchval("SELECT to_regclass('mig_src.ga4_properties') IS NOT NULL"):
                pytest.skip("mig_src.ga4_properties 가 이미 있다(이관 DB)")
            await c.execute(MIG_SRC)
            await c.execute(_block("P60"))
            await c.execute(_block("P61"))
            assert await c.fetchval("SELECT verified_at::text FROM app.ga4_property WHERE property_id = '901'") == "2026-09-01 10:00:00+00"
            assert await c.fetchval("SELECT verified_at FROM app.ga4_property WHERE property_id = '902'") is None
            rows = await c.fetch("SELECT brand_code, country_code FROM app.ga4_market_pending ORDER BY 1, 2")
            assert [tuple(r) for r in rows] == [("Hyundai", "US"), ("Kia", "FR")]
        finally:
            await tr.rollback()
    finally:
        await c.close()


@needs_db
async def test_ga4_market_pending_checks_and_grants_p61(seeded):
    c = await _conn()
    try:
        r = await c.fetchrow(
            "SELECT pg_get_userbyid(relowner) AS owner, has_table_privilege('api_rw', oid, 'insert') AS rw_ins, "
            "has_table_privilege('api_rw', oid, 'delete') AS rw_del, has_table_privilege('api_ro', oid, 'select') AS ro_sel, "
            "has_table_privilege('api_ro', oid, 'insert') AS ro_ins, has_table_privilege('loader', oid, 'insert') AS loader_ins "
            "FROM pg_class WHERE oid = 'app.ga4_market_pending'::regclass")
        assert (r["owner"], r["rw_ins"], r["rw_del"], r["ro_sel"], r["ro_ins"], r["loader_ins"]) == ("hmg_owner", True, True, True, False, False)
        for bad in (("Kia", "de"), ("Kia", "DEU"), ("NoBrand", "DE")):
            with pytest.raises((asyncpg.CheckViolationError, asyncpg.ForeignKeyViolationError)):
                async with c.transaction():
                    await c.execute("INSERT INTO app.ga4_market_pending (brand_code, country_code) VALUES ($1, $2)", *bad)
    finally:
        await c.close()


# ── P62 ───────────────────────────────────────────────────────────────────────
@needs_db
async def test_dfs_backfill_total_count_and_competition_p62(seeded):
    """total_count = 응답 tasks[0].result[0].total_count(숫자일 때만), competition = keyword 의 term_norm 이 그 kw_key 와 같은 원소 중
    마지막 원소(적재기 ON CONFLICT DO UPDATE 와 같은 결과), LOW·MEDIUM·HIGH 밖이면 NULL. requested_at = observed_at 인 호출만."""
    c = await _conn()
    try:
        tr = c.transaction()
        await tr.start()
        try:
            await c.execute("SELECT rd.ensure_month_leaf('ext.dfs_call'::regclass, date '2026-09-01')")
            await c.execute("INSERT INTO rd.dim_keyword (term, term_norm) SELECT t, app.term_norm(t) FROM unnest(ARRAY['v29 suv','v29 ev','v29 best']) t "
                            "ON CONFLICT DO NOTHING")
            sug = await c.fetchval(
                "INSERT INTO ext.dfs_call (endpoint, location_code, language_code, keywords, request, response, status_code, requested_at) "
                "VALUES ('keyword_suggestions', 2840, 'en', '{v29 suv}', '[]', "
                "'{\"tasks\":[{\"result\":[{\"total_count\": 1234, \"items\":[]}]}]}', 200, '2026-09-10 00:00+00') RETURNING call_id")
            sug_bad = await c.fetchval(
                "INSERT INTO ext.dfs_call (endpoint, location_code, language_code, keywords, request, response, status_code, requested_at) "
                "VALUES ('keyword_suggestions', 2840, 'en', '{v29 ev}', '[]', "
                "'{\"tasks\":[{\"result\":[{\"total_count\": \"x\"}]}]}', 200, '2026-09-10 00:00+00') RETURNING call_id")
            vol = await c.fetchval(
                "INSERT INTO ext.dfs_call (endpoint, location_code, language_code, keywords, request, response, status_code, requested_at) "
                "VALUES ('search_volume', 2840, 'en', '{v29 suv,v29 ev}', '[]', "
                "'{\"tasks\":[{\"result\":[{\"keyword\":\"V29 SUV\",\"competition\":\"LOW\"},{\"keyword\":\"v29 ev\",\"competition\":\"weird\"},"
                "{\"keyword\":\"v29 suv \",\"competition\":\"HIGH\"}]}]}', 200, '2026-09-10 00:00+00') RETURNING call_id")
            k = {r["term"]: r["kw_key"] for r in await c.fetch("SELECT term, kw_key FROM rd.dim_keyword WHERE term LIKE 'v29 %'")}
            await c.execute("INSERT INTO rd.kw_suggestion (call_id, seed_kw_key, location_code, language_code, pos, kw_key, observed_at) VALUES "
                            "($1, $3, 2840, 'en', 1, $4, '2026-09-10 00:00+00'), ($2, $5, 2840, 'en', 1, $4, '2026-09-10 00:00+00')",
                            sug, sug_bad, k["v29 suv"], k["v29 best"], k["v29 ev"])
            await c.execute("INSERT INTO rd.kw_volume_monthly (kw_key, location_code, language_code, month, call_id, observed_at) "
                            "SELECT kk, 2840, 'en', m, $1, '2026-09-10 00:00+00' FROM unnest($2::int4[]) kk, "
                            "unnest(ARRAY[date '2026-07-01', date '2026-08-01']) m", vol, [k["v29 suv"], k["v29 ev"]])
            await c.execute(_block("P62"))
            tc = {r["call_id"]: r["total_count"] for r in await c.fetch("SELECT call_id, total_count FROM rd.kw_suggestion WHERE call_id = ANY($1)",
                                                                         [sug, sug_bad])}
            assert tc == {sug: 1234, sug_bad: None}
            comp = {(r["kw_key"], r["month"].month): r["competition"] for r in await c.fetch(
                "SELECT kw_key, month, competition FROM rd.kw_volume_monthly WHERE call_id = $1", vol)}
            assert comp == {(k["v29 suv"], 7): "HIGH", (k["v29 suv"], 8): "HIGH", (k["v29 ev"], 7): None, (k["v29 ev"], 8): None}
            with pytest.raises(asyncpg.CheckViolationError):
                async with c.transaction():
                    await c.execute("UPDATE rd.kw_volume_monthly SET competition = 'low' WHERE call_id = $1", vol)
        finally:
            await tr.rollback()
    finally:
        await c.close()


# ── P63·P64 ───────────────────────────────────────────────────────────────────
@needs_db
async def test_views_and_known_diff_p63_p64(seeded):
    c = await _conn()
    try:
        cols = [r["attname"] for r in await c.fetch("SELECT attname FROM pg_attribute WHERE attrelid = 'rd.v_answer_body'::regclass "
                                                    "AND attnum > 0 AND NOT attisdropped ORDER BY attnum")]
        assert cols[-3:] == ["run_id", "region", "prompt_run_id"] and cols[:3] == ["answer_key", "job_id", "surface"]
        for role in ("api_ro", "admin_long", "qa_gate"):
            assert await c.fetchval("SELECT has_table_privilege($1, 'rd.v_acr_cell_run', 'select') "
                                    "AND has_column_privilege($1, 'rd.v_answer_body', 'region', 'select')", role), role
        assert not await c.fetchval("SELECT has_table_privilege('api_rw', 'rd.v_acr_cell_run', 'select')")
        assert await c.fetchval("SELECT count(*) FROM rd.v_acr_cell_run") == await c.fetchval("SELECT count(*) FROM ing.acr_prompt_run")
        kd = {(r["rule_id"], r["feature_id"], r["metric_key_like"]) for r in await c.fetch(
            "SELECT rule_id, feature_id, metric_key_like FROM mig.known_diff WHERE compat_variant = 'input' AND notice_required")}
        assert {("K-1b", "analytics.kpi.summary", "unmeasured%"), ("BG-07", "analytics.trend.series", "type_exposure%"),
                ("BG-10", "analytics.trend.series", "measured_days")} <= kd
    finally:
        await c.close()


@needs_db
async def test_qa_views_match_ing_p63(seeded):
    """검수 뷰 = ing 원천(전 행): rd.v_answer_body 끝 열 = ing.answer(answer_key_map 경유), rd.v_acr_cell_run = ing.acr_prompt_run.
    기능 시험(qa/answers/detail/tests/test_bg46.py)은 SQL 가드 G3 로 ing 를 못 읽어 뷰와 API 를 대조하고, 뷰 = 원천은 여기서 잇는다."""
    c = await _conn()
    try:
        diff = await c.fetchval(
            "SELECT count(*) FROM rd.v_answer_body v JOIN ing.answer_key_map m ON m.answer_key = v.answer_key "
            "JOIN ing.answer a ON a.run_month = m.run_month AND a.job_id = m.job_id "
            "WHERE (v.run_id, v.region, v.prompt_run_id) IS DISTINCT FROM (a.run_id, a.region, a.prompt_run_id)")
        n = await c.fetchval("SELECT count(*) FROM rd.v_answer_body")
        assert diff == 0 and n > 0
        assert await c.fetchval("SELECT count(*) FROM (SELECT acr_cell_key, prompt_run_id, run_id FROM rd.v_acr_cell_run "
                                "EXCEPT SELECT acr_cell_key, prompt_run_id, run_id FROM ing.acr_prompt_run) x") == 0
        assert await c.fetchval("SELECT count(*) FROM rd.v_acr_cell_run") == await c.fetchval("SELECT count(*) FROM ing.acr_prompt_run") > 0
    finally:
        await c.close()
