"""DB-v2.16(WU-7 웹사이트 현행 프로필) DB 시험(합성 픽스처, 롤백 전용). 단위 시험은 tests/core/test_legacy_profile.py test_switch_web_*.

  0. 합본 = v2.15 + 패치(바이트), 패치 재적용 거부

  1. DB-v2.16 보고서 유닛 소속(rd.web_report_prompt): rd.refresh_web_report_prompt = 명세 행(사이트 브랜드·국가 정확 일치, 사이트 프로젝트 =
     프롬프트 프로젝트, 언어, 타겟 URL LIKE·NOT LIKE)으로 고른 website_prompt.file_seq(현행 surface-website.ts:145-225 loadUnits 의 report_fs).
     바뀐 행만 쓰고(두 번째 = 0), 키 범위 refresh·단언(rd.assert_web_report_prompt)이 어긋남을 잡는다
  2. web_registered_only 켜짐 ∧ card=true: /v1/kpi/summary website 언급·인용 모수 = 보고서 유닛 소속 ∧ 제외 유닛 아님(독립 SQL),
     url_prompts 는 그대로(현행 URL 인용률은 유닛 게이트 없음). card 없는 요청(답변 분석 = 현행 미러 경로)·꺼짐 = 종전 값
  3. web_url_rate 켜짐: 발행값 선택 = 현행 decidePublishedSelection(권한 게이트: 계정 사이트가 발행 유닛 전부를 덮어야 한다, 발행물 어휘 브랜드).
     픽스처 발행물(09-18)은 계정 사이트에 없는 유닛(301 FR·401 Hyundai)이 있어 현행은 라이브(scope_narrower), 허브 기본은 사이트 스코프 안
     유닛만 합쳐 발행값을 낸다. 두 유닛을 지우면 현행도 발행값(101+102)이고 BG-26 표식 site_count = 합산 유닛 수
"""
from __future__ import annotations

import pathlib

from app.core.config import set_settings
from app.core.db import fetch_one
from tests.support import ADMIN, KIA_EU, Rows, Sql, load_named_sql, needs_db, staged

pytestmark = needs_db
URL = "/v1/kpi/summary"
ROUNDS = load_named_sql(pathlib.Path(__file__).resolve().parents[2] / "app" / "features" / "analytics" / "kpi" / "summary" / "tests"
                        / "rounds.pgsql")
P21, P22, P23 = ("b0000000-0000-4000-8000-000000000021", "b0000000-0000-4000-8000-000000000022", "b0000000-0000-4000-8000-000000000023")
# Kia DE(de) 유닛 명세. shop.kia.de 타겟(P22)은 NOT LIKE 로 뺀다(현행 명세 urlNotLike 형식: 'kia.com/eu%' 류)
UNIT = Rows("app.website_report_unit", [{"ix": 0, "brand_code": "Kia", "country_code": "DE", "lang_code": "de", "url_like": None,
                                         "url_not_like": "shop.kia.de%", "spec_fs": 101}])
# 픽스처 웹 답변(k21·k22)은 P21·P23 에 있다: 게이트 안팎을 가르려면 P23(kia.com/de/sub) 을 명세 밖으로 둔다
UNIT_SUB = Rows("app.website_report_unit", [{"ix": 0, "brand_code": "Kia", "country_code": "DE", "lang_code": "de", "url_like": None,
                                             "url_not_like": "kia.com/de/sub%", "spec_fs": 101}])
REFRESH = Sql("SELECT rd.refresh_web_report_prompt(NULL)")
MEMBERS = """SELECT d.prompt_id::text AS pid, w.report_fs FROM rd.web_report_prompt w JOIN rd.dim_prompt d ON d.prompt_key = w.prompt_key
              ORDER BY 1"""


async def _rows(conn, sql: str) -> list[dict]:
    from app.core.db import fetch_all
    return [dict(r) for r in await fetch_all(conn, sql, {})]


DB = pathlib.Path(__file__).resolve().parents[2] / "db"


def test_merged_ddl_is_v215_plus_patch():
    """합본 DB-v2.16.sql = DB-v2.15.sql + DB-v2.16-patch.sql(바이트). 패치 라벨은 v2.15 의 P90 다음(P91~P93)."""
    assert (DB / "DB-v2.16.sql").read_bytes() == (DB / "DB-v2.15.sql").read_bytes() + (DB / "DB-v2.16-patch.sql").read_bytes()
    patch = (DB / "DB-v2.16-patch.sql").read_text(encoding="utf-8")
    assert "P90 " in (DB / "DB-v2.15-patch.sql").read_text(encoding="utf-8") and all(f"P{n}" in patch for n in (91, 92, 93))


async def test_patch_refuses_reapply():
    import asyncpg
    import pytest

    from tests.support import DB_URL
    c = await asyncpg.connect(DB_URL)
    try:
        with pytest.raises(asyncpg.RaiseError, match="DB-v2.16 이미 적용됨"):
            await c.execute((DB / "DB-v2.16-patch.sql").read_text(encoding="utf-8"))
        await c.execute("ROLLBACK")
        assert await c.fetchval("SELECT count(*) FROM rd.web_report_prompt") == 0          # 거부 = 아무것도 바뀌지 않음
    finally:
        await c.close()


async def test_refresh_web_report_prompt_semantics():
    async with staged(UNIT, role=None) as conn:
        assert await _rows(conn, MEMBERS) == []                                          # 패치 직후·명세 행 전 = 비어 있다
        first = (await fetch_one(conn, "SELECT rd.refresh_web_report_prompt(NULL) AS n", {}))["n"]
        assert await _rows(conn, MEMBERS) == [{"pid": P21, "report_fs": 101}, {"pid": P23, "report_fs": 102}]
        assert first == 2
        assert (await fetch_one(conn, "SELECT rd.refresh_web_report_prompt(NULL) AS n", {}))["n"] == 0          # 멱등(바뀐 행만)
        assert (await fetch_one(conn, "SELECT rd.assert_web_report_prompt() AS n", {}))["n"] == 2
        # 언어가 안 맞으면(명세 en) 소속 없음 → 범위 refresh 는 그 키만 지운다
        await conn.exec_driver_sql("UPDATE app.website_report_unit SET lang_code = 'en' WHERE ix = 0")
        k21 = (await fetch_one(conn, f"SELECT prompt_key FROM rd.dim_prompt WHERE prompt_id = '{P21}'", {}))["prompt_key"]
        n = (await fetch_one(conn, f"SELECT rd.refresh_web_report_prompt(ARRAY[{k21}]::int4[]) AS n", {}))["n"]
        assert n == 1 and await _rows(conn, MEMBERS) == [{"pid": P23, "report_fs": 102}]
        # 단언: 표 ≠ 기대값(P23 도 이제 밖)이면 예외
        sp = await conn.begin_nested()
        try:
            await conn.exec_driver_sql("SELECT rd.assert_web_report_prompt()")
            raise AssertionError("assert_web_report_prompt 가 어긋남을 못 잡았다")
        except Exception as e:                                                          # noqa: BLE001
            assert "기대값" in str(e)
        finally:
            await sp.rollback()
        # 브랜드·국가는 정확 일치(현행 ws.brand = s.brand, ws.country_code = s.cc): 소문자 국가 명세는 소속 없음
        await conn.exec_driver_sql("UPDATE app.website_report_unit SET lang_code = 'de', country_code = 'de' WHERE ix = 0")
        await conn.exec_driver_sql("SELECT rd.refresh_web_report_prompt(NULL)")
        assert await _rows(conn, MEMBERS) == []


_GATED = """
SELECT count(*) AS answers, coalesce(sum(a.ment_total), 0) AS total_mentions, coalesce(sum(a.cit_n), 0) AS cit_total
  FROM rd.answer a JOIN rd.dim_prompt d ON d.prompt_key = a.prompt_key
 WHERE a.surface = 2 AND a.round_date = DATE '2026-09-18' AND a.cyc_key = ANY('{21}'::int4[]) AND a.dflt AND a.std_in
   AND d.prompt_id::text = ANY(CAST(:pids AS text[]))
"""


async def test_web_registered_only_summary(client_as, settings):
    """현행 unitWhere: report_fs 있음 ∧ 제외 유닛 아님. 준비 = 회차 21 인용 숨김 해제 + k21 사본(web_dup_prompt), 명세 = P21·P22(101), P23 밖."""
    try:
        set_settings(settings.model_copy(update={"legacy_profile": "web_registered_only"}))
        async with staged(Sql(ROUNDS["web_dup_prompt"]), UNIT_SUB, REFRESH) as conn:
            want = await fetch_one(conn, _GATED, {"pids": [P21, P22]})
            allw = await fetch_one(conn, _GATED, {"pids": [P21, P22, P23]})
            async with client_as(KIA_EU) as c:
                on = (await c.get(URL, params={"surface": "website", "from": "2026-09-01", "to": "2026-09-30", "card": "true"})).json()
                ana = (await c.get(URL, params={"surface": "website", "from": "2026-09-01", "to": "2026-09-30"})).json()
        async with staged(Sql(ROUNDS["web_dup_prompt"]), UNIT_SUB, REFRESH, Rows("app.website_report_excluded", [{"file_seq": 101}])) as conn:
            excl = await fetch_one(conn, _GATED, {"pids": []})
            async with client_as(KIA_EU) as c:
                ex = (await c.get(URL, params={"surface": "website", "from": "2026-09-01", "to": "2026-09-30", "card": "true"})).json()
        set_settings(settings.model_copy(update={"legacy_profile": "off"}))
        async with staged(Sql(ROUNDS["web_dup_prompt"]), UNIT_SUB, REFRESH), client_as(KIA_EU) as c:
            off = (await c.get(URL, params={"surface": "website", "from": "2026-09-01", "to": "2026-09-30", "card": "true"})).json()
    finally:
        set_settings(settings)
    assert allw["answers"] > want["answers"] > 0                                          # 준비가 게이트 안팎을 가른다(P23 답변)
    assert on["data"]["visibility"]["den"] == want["answers"]
    assert on["data"]["share_of_voice"]["den"] == want["total_mentions"]
    assert off["data"]["visibility"]["den"] == allw["answers"]                            # 꺼짐 = 종전(유닛 밖 P23 포함)
    assert ana["data"]["visibility"]["den"] == allw["answers"]                            # 켜짐이어도 비카드(답변 분석 = 현행 미러) 는 게이트 없음
    assert on["data"]["url_prompts"] == off["data"]["url_prompts"]                        # URL 인용률 프롬프트 단위는 게이트 없음(현행)
    assert excl["answers"] == 0 and ex["data"]["visibility"] is None                    # 제외 유닛 101 → 남는 유닛 소속 없음(모수 0)
    assert ex["meta"]["suppressed"].get("visibility") == "no_data"


async def test_web_url_rate_publication_selection(client_as, settings):
    try:
        set_settings(settings.model_copy(update={"legacy_profile": "web_url_rate"}))
        async with staged(Sql(ROUNDS["web_dup_prompt"])), client_as(KIA_EU) as c:
            nar = (await c.get(URL, params={"surface": "website"})).json()
        drop = Sql("DELETE FROM rd.report_unit_value WHERE round_date = DATE '2026-09-18' AND file_seq IN (301, 401)")
        async with staged(Sql(ROUNDS["web_dup_prompt"]), drop):
            async with client_as(KIA_EU) as c:
                rep = (await c.get(URL, params={"surface": "website"})).json()
                day = (await c.get(URL, params={"surface": "website", "from": "2026-09-18", "to": "2026-09-18"})).json()
                opn = (await c.get(URL, params={"surface": "website", "from": "2026-09-18"})).json()
                eng = (await c.get(URL, params={"surface": "website", "engine": "chatgpt"})).json()
            async with client_as(ADMIN) as c:
                kia = (await c.get(URL, params={"surface": "website", "brand": "Kia"})).json()
                hyu = (await c.get(URL, params={"surface": "website", "brand": "Hyundai"})).json()
        set_settings(settings.model_copy(update={"legacy_profile": "off"}))
        async with staged(Sql(ROUNDS["web_dup_prompt"])), client_as(KIA_EU) as c:
            hub = (await c.get(URL, params={"surface": "website"})).json()
    finally:
        set_settings(settings)
    # 현행: 계정(Kia 서유럽) 사이트가 발행 유닛 301·401 을 못 덮는다 → 라이브. 허브 기본은 스코프 안 유닛(101·102)만 합쳐 발행값
    assert nar["meta"]["source"]["url_rates"] == "live" and nar["meta"]["source"]["reason"] == "scope_narrower"
    assert hub["meta"]["source"]["url_rates"] == "report" and hub["data"]["url_prompts"]["measured_prompts"] == 15
    # 발행 유닛이 계정 사이트 안(101·102)뿐이면 현행도 발행값: 프롬프트 합 측정 10+5·타겟 7+3·자사 8+4, site_count 2
    for body in (rep, day, kia):
        assert body["meta"]["source"]["url_rates"] == "report", body["meta"]["source"]
        assert body["data"]["url_prompts"] == {"measured_prompts": 15, "target_prompts": 10, "owned_prompts": 12}
        assert body["meta"]["source"]["site_count"] == 2 and str(body["meta"]["source"]["round_date"]) == "2026-09-18"
    assert opn["meta"]["source"]["reason"] == "period_open_ended"                          # 현행 period-open-ended(from 만)
    assert eng["meta"]["source"]["reason"] == "engine_axis"
    # brand=Hyundai: 픽스처에 Hyundai 사이트가 없어 사이트 선택이 비고 창도 빈다(현행 withWebsite 빈 결과 = 출처 표식 없음).
    # 발행물 어휘 밖 브랜드(brand_not_in_publication)는 단위 시험(test_switch_web_url_rate)이 가른다
    assert hyu["meta"]["source"] is None
