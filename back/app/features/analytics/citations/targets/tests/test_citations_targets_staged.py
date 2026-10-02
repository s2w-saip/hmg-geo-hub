"""GET /v1/citations/targets(C-4) 검증 결함 회귀(D1·D2·D3·D5·D6). 추가 합성 행 = prompts/tests/staged.pgsql, 창 주입 없이 실제 rd.cycle 경로.

추가 행
- @website: 웹사이트 회차 22(Kia DE 사이트, 2026-09-25, 숨김 없음) + 답변 2건(k21·k22 복사, 둘 다 타겟·자사 URL 인용) + 웹 유닛 103(en)·104(de)
- @pub_single: rep-0925 에 유닛 101(Kia DE de, 헤드라인 풀) 11/20 · 13/20
- @pub_mixed_pool: rep-0925 에 유닛 103(Kia DE en, 비풀) 1/7 · 2/7 → 101 과 섞이면 현행(풀만) 20 · 11 · 13(core D-headline 이 같은 값),
  풀 규칙 없는 전체 합이면 27 · 12 · 15(검증 D2 재현값)
- @pub_multi: hyundai-secret-0925(brand_scope Hyundai, 유닛 401 = 웹 유닛 없음) · kia-extra-0925(brand_scope Kia, 유닛 104 4/5 · 5/5)
기대값은 rd.answer 불리언 집계·rd.report_unit_value 합을 손으로 쓴 SQL(기능 코드와 다른 경로)로 같은 테스트 안에서 계산한다.
"""
from __future__ import annotations

from typing import Any

from app.features.analytics.citations.prompts.tests.staged_db import owner_fetch, staged
from tests.support import ADMIN, KIA_EU, KIA_US, needs_db

URL = "/v1/citations/targets"


async def get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


async def live_expected(engine: str | None = None) -> dict[str, Any]:
    """회차 22 라이브(web_reg ∧ cit_in, 엔진 기본 또는 지정) 독립 집계."""
    r = (await owner_fetch("""
        SELECT count(*) AS den, count(*) FILTER (WHERE a.tgt_cited) AS t, count(*) FILTER (WHERE a.own_url_cited) AS o
          FROM rd.answer a JOIN rd.dim_engine e ON e.engine_key = a.engine_key
         WHERE a.surface = 2 AND a.round_date = '2026-09-25' AND a.cyc_key = ANY(ARRAY[22]) AND a.web_reg AND a.cit_in
           AND (CASE WHEN $1::text IS NULL THEN a.dflt ELSE e.code = $1 END)""", engine))[0]
    den = int(r["den"])
    return {"measured": den, "target": {"num": int(r["t"]), "den": den} if den else None,
            "owned": {"num": int(r["o"]), "den": den} if den else None}


async def report_expected(*, countries: list[str] | None, lang: str | None = None, pool_rule: bool = True) -> tuple[dict[str, Any], list[str]]:
    """2026-09-25 활성 발행 유닛 중 사이트 프로젝트(2) 웹 유닛·Kia 브랜드 합(독립). pool_rule = 현행 publishedSubtotal(풀이 있으면 풀만)."""
    rows = await owner_fetch("""
        SELECT p.slug, v.in_headline_pool AS pool, v.target_hit_prompts AS t, v.measured_prompts AS m, v.owned_prompts AS o,
               v.owned_prompts_den AS od
          FROM rd.report_unit_value v JOIN app.report_publication p ON p.id = v.pub_id AND p.status = 'active'
          JOIN rd.web_unit u ON u.file_seq = v.file_seq AND u.project_key = 2
         WHERE v.round_date = '2026-09-25' AND v.brand = 'Kia'
           AND ($1::text[] IS NULL OR upper(v.country_code) = ANY($1::text[])) AND ($2::text IS NULL OR v.lang_code = $2)""",
        countries, lang)
    if pool_rule and any(r["pool"] for r in rows):
        rows = [r for r in rows if r["pool"]]
    t, m, o, od = (sum(int(r[k]) for r in rows) for k in ("t", "m", "o", "od"))
    return ({"measured": m, "target": {"num": t, "den": m}, "owned": {"num": o, "den": od}}, sorted({r["slug"] for r in rows}))


async def report_source(*, countries: list[str] | None, lang: str | None = None) -> dict[str, Any]:
    """발행값 meta.source 기대값(BG-26 publications 포함). 발행물별 사이트 수 = 풀 규칙 뒤 그 발행물 유닛 수(독립 SQL, 현행 siteCount)."""
    rows = await owner_fetch("""
        SELECT p.slug, p.cycle_label, p.cycle_label_en, p.round_date, p.manifest_verified, v.file_seq, v.in_headline_pool AS pool
          FROM rd.report_unit_value v JOIN app.report_publication p ON p.id = v.pub_id AND p.status = 'active'
          JOIN rd.web_unit u ON u.file_seq = v.file_seq AND u.project_key = 2
         WHERE v.round_date = '2026-09-25' AND v.brand = 'Kia'
           AND ($1::text[] IS NULL OR upper(v.country_code) = ANY($1::text[])) AND ($2::text IS NULL OR v.lang_code = $2)""",
        countries, lang)
    pool_mixed = any(r["pool"] for r in rows) and not all(r["pool"] for r in rows)
    if any(r["pool"] for r in rows):
        rows = [r for r in rows if r["pool"]]
    by: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        by.setdefault(r["slug"], []).append(r)
    pubs = [{"slug": k, "cycle_label": v[0]["cycle_label"], "cycle_label_en": v[0]["cycle_label_en"], "round_date": v[0]["round_date"].isoformat(),
             "site_count": len({x["file_seq"] for x in v}), "headline_pool_applied": pool_mixed, "manifest_verified": v[0]["manifest_verified"]}
            for k, v in sorted(by.items())]
    return {"origin": "report", "publication_slugs": sorted(by), "publications": pubs}


# ── D1: 브랜드 범위 발행물이 여럿인 회차, 관점 밖 slug 비노출 + 합산한 발행물만 출처 ─────────
@needs_db
async def test_d1_only_summed_publications_are_listed(client_as):
    async with staged("website", "pub_single", "pub_multi"):
        r = await get(client_as, KIA_EU, surface="website")
        b = r.json()
        assert r.status_code == 200, r.text
        want, slugs = await report_expected(countries=["DE"])
        assert slugs == ["kia-extra-0925", "rep-0925"] and want["measured"] == 25               # 손 계산: 20 + 5
        assert b["data"] == want and b["meta"]["cycles"] == ["2026-09-25"]
        assert b["meta"]["source"] == await report_source(countries=["DE"]) and b["meta"]["source"]["publication_slugs"] == slugs
        assert [(p["slug"], p["site_count"]) for p in b["meta"]["source"]["publications"]] == [("kia-extra-0925", 1), ("rep-0925", 1)]
        assert "hyundai-secret" not in r.text                                                   # 관점 밖 발행물 식별자 비노출
        # 전사 계정도 합산에 들어가지 않은 발행물(웹 유닛 없는 401)은 출처에 없다. 가상 지역 유닛 102(SA-Dammam)까지 합친다
        r = await get(client_as, ADMIN, surface="website")
        want, slugs = await report_expected(countries=None)
        assert r.json()["data"] == want and r.json()["meta"]["source"] == await report_source(countries=None)
        assert r.json()["meta"]["source"]["publication_slugs"] == slugs
        assert "hyundai-secret" not in r.text
        r = await get(client_as, ADMIN, surface="website", brand="Hyundai")                    # 현대 관점: 현대 사이트 없음 → 회차 없음
        assert r.json()["meta"]["suppressed"] == {"*": "no_active_snapshot"} and r.json()["meta"]["source"] is None
        assert "hyundai-secret" not in r.text
        r = await get(client_as, KIA_US, surface="website")                                     # DE 사이트 스코프 밖: 회차·발행값·출처 없음
        assert r.json()["meta"]["suppressed"] == {"*": "no_active_snapshot"} and r.json()["meta"]["source"] is None
        assert "0925" not in r.text


# ── D2: 헤드라인 풀 참·거짓 유닛이 섞인 선택 ────────────────────────────────────────
@needs_db
async def test_d2_mixed_headline_pool_never_serves_unpooled_sum(client_as):
    async with staged("website", "pub_single", "pub_mixed_pool"):
        r = await get(client_as, KIA_EU, surface="website")
        b = r.json()
        wrong, _ = await report_expected(countries=["DE"], pool_rule=False)
        assert wrong["measured"] == 27                                                          # core 전체 합(검증 D2 재현값)
        assert b["data"] != wrong
        pooled, pooled_slugs = await report_expected(countries=["DE"])
        assert pooled["measured"] == 20                                                         # 현행 publishedSubtotal 값
        # core D-headline(publishedSubtotal 규칙): 풀 합과 같은 발행값, 출처는 풀 유닛 발행물
        assert (b["data"], b["meta"]["source"]) == (pooled, await report_source(countries=["DE"]))
        assert b["meta"]["source"]["publication_slugs"] == pooled_slugs
        # BG-26: 풀 유닛만 합산(101) → 사이트 1, 헤드라인 풀 규칙이 유닛(103)을 뺐다
        assert [(p["site_count"], p["headline_pool_applied"]) for p in b["meta"]["source"]["publications"]] == [(1, True)]
        # 풀 유닛만 고른 선택·비풀 유닛만 고른 선택은 두 규칙이 같다 → 발행값
        for lang in ("de", "en"):
            r = await get(client_as, KIA_EU, surface="website", lang=lang)
            want, slugs = await report_expected(countries=["DE"], lang=lang)
            assert r.json()["data"] == want and r.json()["meta"]["source"] == await report_source(countries=["DE"], lang=lang), lang
            assert r.json()["meta"]["source"]["publication_slugs"] == slugs
        assert want == {"measured": 7, "target": {"num": 1, "den": 7}, "owned": {"num": 2, "den": 7}}


# ── D3·D5: 회차 하나를 고른 기간(from = to)은 발행값(D-R09, 현행 resolveReportTruthRoute), 구간은 라이브 + 사유 ───────
@needs_db
async def test_d3_single_round_period_uses_report_and_range_is_live(client_as):
    async with staged("website", "pub_single"):
        r = await get(client_as, KIA_EU, surface="website")
        want, slugs = await report_expected(countries=["DE"])
        assert r.json()["data"] == want and r.json()["meta"]["source"]["publication_slugs"] == ["rep-0925"] == slugs
        assert r.json()["meta"]["source"] == await report_source(countries=["DE"])
        live = await live_expected()
        assert live == {"measured": 2, "target": {"num": 2, "den": 2}, "owned": {"num": 2, "den": 2}}
        one = await get(client_as, KIA_EU, surface="website", **{"from": "2026-09-25", "to": "2026-09-25"})
        m = one.json()["meta"]
        assert m["mode"] == "cumulative" and m["source"] == await report_source(countries=["DE"]) and m["source"]["publication_slugs"] == slugs
        assert one.json()["data"] == want
        r = await get(client_as, KIA_EU, surface="website", **{"from": "2026-09-01", "to": "2026-09-30"})
        m = r.json()["meta"]
        assert m["mode"] == "cumulative" and m["source"] == {"origin": "live", "reason": "period_range"}
        assert r.json()["data"] == live


@needs_db
async def test_d5_live_reasons(client_as):
    async with staged("website", "pub_single"):
        r = await get(client_as, KIA_EU, surface="website", engine="chatgpt")
        assert r.json()["meta"]["source"] == {"origin": "live", "reason": "engine_axis"}
        assert r.json()["data"] == await live_expected("chatgpt")
        r = await get(client_as, KIA_EU, surface="website", lang="en")                         # 발행 유닛 101 은 de
        assert r.json()["meta"]["source"] == {"origin": "live", "reason": "no_publication"}
        assert r.json()["data"]["measured"] == 0                                                # 답변도 de
