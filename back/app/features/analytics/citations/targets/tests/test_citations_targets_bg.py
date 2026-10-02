"""BG 보강(bg-citations) 회귀: /v1/citations/targets meta.source.publications(BG-26, 발행 회차 라벨·기준일·사이트 수) +
core report_publications_sql(추가형)이 발행값 합산(core report_values_sql)과 같은 선택인지 대조.

준비: prompts/tests/staged.pgsql @website·@pub_*(웹사이트 회차 22 = 2026-09-25) + 발행물 라벨 갱신(app 표 = 행위자 GUC 필요).
"""
from __future__ import annotations

from datetime import date

from app.core.measure import report_publications_sql, report_values_sql
from app.features.analytics.citations.prompts.tests.staged_db import SQL as PROMPT_SQL
from tests.support import KIA_EU, KIA_US, SYSTEM, Sql, Update, needs_db, raw_fetch, staged

pytestmark = needs_db
URL = "/v1/citations/targets"
REP_0925 = "c9000000-0000-4000-8000-000000000002"
LABEL = Update("app.report_publication", {"slug": "rep-0925"},
               {"cycle_label": "9월 4주차", "cycle_label_en": "Sep W4", "manifest_verified": True})


async def get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


async def test_bg26_publication_labels_and_site_count(client_as):
    async with staged(Sql(PROMPT_SQL["website"]), Sql(PROMPT_SQL["pub_single"]), Sql(PROMPT_SQL["pub_multi"]), LABEL, actor=SYSTEM) as conn:
        b = (await get(client_as, KIA_EU, surface="website")).json()
        src = b["meta"]["source"]
        assert src["origin"] == "report" and src["publication_slugs"] == ["kia-extra-0925", "rep-0925"]
        # 독립: 발행물별 합산 유닛 수(사이트 프로젝트 2 의 웹 유닛·Kia·DE, 전부 풀)
        cnt = {r["slug"]: int(r["n"]) for r in await raw_fetch(conn, """
            SELECT p.slug, count(*) AS n FROM rd.report_unit_value v JOIN app.report_publication p ON p.id = v.pub_id AND p.status = 'active'
              JOIN rd.web_unit u ON u.file_seq = v.file_seq AND u.project_key = 2
             WHERE v.round_date = '2026-09-25' AND v.brand = 'Kia' AND upper(v.country_code) = 'DE' GROUP BY p.slug""")}
        assert cnt == {"kia-extra-0925": 1, "rep-0925": 1}
        assert src["publications"] == [
            {"slug": "kia-extra-0925", "cycle_label": None, "cycle_label_en": None, "round_date": "2026-09-25", "site_count": 1,
             "headline_pool_applied": False, "manifest_verified": False},
            {"slug": "rep-0925", "cycle_label": "9월 4주차", "cycle_label_en": "Sep W4", "round_date": "2026-09-25", "site_count": 1,
             "headline_pool_applied": False, "manifest_verified": True}]
        assert "hyundai-secret" not in str(src)                                                   # 관점 밖 발행물 비노출(D1 과 같다)
        # 라이브면 키를 더하지 않는다(기존 모양)
        live = (await get(client_as, KIA_EU, surface="website", engine="chatgpt")).json()["meta"]["source"]
        assert live == {"origin": "live", "reason": "engine_axis"}
        # 스코프 밖: 회차·출처 없음
        k = (await get(client_as, KIA_US, surface="website")).json()["meta"]
        assert k["source"] is None and "9월" not in str(k)


async def test_bg26_core_selection_matches_report_values():
    """발행물별 site_count 합 = report_values_sql units, slug 집합 = slugs(같은 선택 술어 두 벌의 대조). 풀 섞임 포함."""
    async with staged(Sql(PROMPT_SQL["website"]), Sql(PROMPT_SQL["pub_single"]), Sql(PROMPT_SQL["pub_mixed_pool"]),
                      Sql(PROMPT_SQL["pub_multi"]), role=None) as conn:
        rd_ = [date(2026, 9, 25), date(2026, 9, 18)]
        for brands, countries, langs in ((["Kia"], None, None), (["Kia"], ["DE"], None), (["Kia"], ["DE"], ["en"]),
                                         (["Kia", "Hyundai"], None, None), (["Hyundai"], None, None)):
            args = dict(project_keys=[2], geo_keys=None)
            v = report_values_sql(rd_, brands, countries, langs, **args)
            p = report_publications_sql(rd_, brands, countries, langs, **args)
            vr = await _fetch(conn, v)
            pr = await _fetch(conn, p)
            for r in vr:
                mine = [x for x in pr if x["round_date"] == r["round_date"]]
                assert sum(int(x["site_count"]) for x in mine) == int(r["units"]), (brands, countries, langs, r["round_date"])
                assert sorted(x["slug"] for x in mine) == list(r["slugs"])
                assert all(bool(x["headline_pool_applied"]) == bool(r["pool_applied"]) for x in mine)
            assert {x["round_date"] for x in pr} == {r["round_date"] for r in vr}
        mixed = [x for x in await _fetch(conn, report_publications_sql([date(2026, 9, 25)], ["Kia"], ["DE"], None, project_keys=[2],
                                                                        geo_keys=None))]
        assert [(x["slug"], x["site_count"], x["headline_pool_applied"]) for x in mixed] == [("kia-extra-0925", 1, True), ("rep-0925", 1, True)]


async def _fetch(conn, s) -> list[dict]:
    from app.core.db import fetch_all
    return await fetch_all(conn, s.text, s.params)
