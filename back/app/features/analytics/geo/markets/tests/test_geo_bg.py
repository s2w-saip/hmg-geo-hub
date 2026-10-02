"""analytics.geo.markets 값 갭 보강(BG-01 글로벌 lang[], BG-02 글로벌 택소노미 축, BG-48 당사 라벨) 테스트.

기대값은 준비 트랜잭션 안 드라이버 직접 독립 SQL(tests.support.raw_fetch, 비트 식·조인을 직접 쓴다)과 손 계산 상수로 센다.
픽스처(글로벌 스냅샷 = 회차 11, 2026-09-14): 현대 관점 US std 답변 k1(프롬프트 1·F1·L1·en)·k2(프롬프트 1·en)·k12(프롬프트 3·F1·L2·en).
"""
from __future__ import annotations

from datetime import date

import pytest

from tests.support import ADMIN, HQ_HYUNDAI, KIA_EU, Update, needs_db, raw_fetch, staged

pytestmark = needs_db
D14 = date(2026, 9, 14)


def masks(bits: int) -> list[int]:
    return [m for m in range(1, 32) if m & bits]


async def get(client_as, uid, params, status=200) -> dict:
    async with client_as(uid) as c:
        r = await c.get("/v1/geo", params=params)
    assert r.status_code == status, r.text
    return r.json()


def rt(x: dict | None) -> tuple[int, int] | None:
    return (x["num"], x["den"]) if x else None


def us_row(b: dict) -> dict | None:
    return next((c for m in b["data"]["markets"] for c in m["countries"] if c["code"] == "US"), None)


# 현대 관점 US 한 회차: 언어·목록 유형(택소노미) 조건 선택. 구현은 core 빌더(bgrp = ANY·prompt_key = ANY), 여기는 조인·비트 식을 직접
US_SQL = """
SELECT count(*) FILTER (WHERE a.std_in) AS n, count(*) FILTER (WHERE a.std_in AND a.own_mask & 1 = 1) AS vis,
       coalesce(sum(a.ment_h) FILTER (WHERE a.std_in), 0) AS om, coalesce(sum(a.ment_total) FILTER (WHERE a.std_in), 0) AS tm
  FROM rd.answer a JOIN rd.dim_country g ON g.geo_key = a.geo_key AND g.code = 'US' JOIN rd.dim_lang l ON l.lang_key = a.lang_key
 WHERE a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2::int4[]) AND a.bgrp = ANY($3::int2[]) AND a.dflt AND a.cit_in
   AND ($4::text IS NULL OR l.code = $4)
   AND ($5::text IS NULL OR a.prompt_key IN (SELECT ce.prompt_key FROM rd.catalog_entry ce JOIN rd.dim_taxon t ON t.taxon_key = ce.list_type_key
                                              WHERE t.axis = 'list_type' AND t.code = $5))
"""
# M05 분자 = 출처 카테고리 Official (HMG) 원소(동기화 S1 BE-4, 관점·언어로 분자 판정을 좁히지 않는다). 구현은 core 원소 스캔(OFFICIAL_SOURCES)
CIT_SQL = """
SELECT count(*) AS n, count(*) FILTER (WHERE cc.name = 'Official (HMG)') AS own
  FROM rd.citation c JOIN rd.dim_country g ON g.geo_key = c.geo_key AND g.code = 'US' JOIN rd.dim_lang l ON l.lang_key = c.lang_key
  JOIN rd.dim_source s ON s.source_key = c.source_key JOIN app.citation_category cc ON cc.category_key = s.category_key
 WHERE c.surface = 1 AND c.round_date = $1 AND c.cyc_key = ANY($2::int4[]) AND c.bgrp = ANY($3::int2[]) AND c.dflt AND c.cit_in
   AND c.source_key <> 0 AND l.code = $4
"""


async def cyc(conn, d: date) -> list[int]:
    return [r["cyc_key"] for r in await raw_fetch(conn, "SELECT cyc_key FROM rd.cycle WHERE surface = 1 AND round_date = $1", d)]


# ── BG-01 ────────────────────────────────────────────────────────────────────
async def test_bg01_global_lang_applies(client_as):
    async with staged() as probe:
        ko = (await raw_fetch(probe, "SELECT lang_key FROM rd.dim_lang WHERE code = 'ko'"))[0]["lang_key"]
    w = {"surface": 1, "round_date": D14, "answer_key": 12}
    async with staged(Update("rd.answer", w, {"lang_key": ko}), Update("rd.answer_brand", w, {"lang_key": ko})) as conn:
        en = await get(client_as, HQ_HYUNDAI, {"surface": "global", "lang": "en"})
        kor = await get(client_as, HQ_HYUNDAI, {"surface": "global", "lang": "ko"})
        base = await get(client_as, HQ_HYUNDAI, {"surface": "global"})
        ks = await cyc(conn, D14)
        e_en = (await raw_fetch(conn, US_SQL, D14, ks, masks(9), "en", None))[0]
        e_ko = (await raw_fetch(conn, US_SQL, D14, ks, masks(9), "ko", None))[0]
        c_en = (await raw_fetch(conn, CIT_SQL, D14, ks, masks(9), "en"))[0]
    assert en["meta"]["ignored_filters"] == [] and en["meta"]["dropped_filters"] == {}
    us = us_row(en)
    assert us["answers"] == e_en["n"] == 2
    assert rt(us["own"]["visibility"]) == (e_en["vis"], e_en["n"]) == (1, 2)
    assert rt(us["own"]["share_of_voice"]) == (e_en["om"], e_en["tm"]) == (4, 10)
    assert rt(us["own"]["citation_share"]) == (c_en["own"], c_en["n"]) == (4, 9)          # 언어 축 = 원소 스캔, 분자 = 공식(HMG)
    ku = us_row(kor)
    assert ku["answers"] == e_ko["n"] == 1 and rt(ku["own"]["share_of_voice"]) == (e_ko["om"], e_ko["tm"]) == (1, 1)
    assert ku["top_rival"] is None and ku["rank"] == {"our": 1, "field_size": 1}          # 경쟁 행도 언어 축(k12 는 경쟁 행 없음)
    assert us_row(base)["answers"] == 3


# ── BG-02 ────────────────────────────────────────────────────────────────────
async def test_bg02_global_taxonomy_axes(client_as):
    async with staged() as conn:
        l2 = await get(client_as, HQ_HYUNDAI, {"surface": "global", "list_type": "L2"})
        l1 = await get(client_as, HQ_HYUNDAI, {"surface": "global", "list_type": "L1"})
        ks = await cyc(conn, D14)
        e2 = (await raw_fetch(conn, US_SQL, D14, ks, masks(9), None, "L2"))[0]
        e1 = (await raw_fetch(conn, US_SQL, D14, ks, masks(9), None, "L1"))[0]
    assert l2["meta"]["ignored_filters"] == []
    u2, u1 = us_row(l2), us_row(l1)
    assert u2["answers"] == e2["n"] == 1 and rt(u2["own"]["share_of_voice"]) == (e2["om"], e2["tm"]) == (1, 1)   # k12 만
    assert u2["top_rival"] is None
    assert u1["answers"] == e1["n"] == 2 and rt(u1["own"]["visibility"]) == (e1["vis"], e1["n"]) == (1, 2)       # k1·k2
    assert u1["top_rival"]["brand"] == "Toyota"
    bad = await get(client_as, HQ_HYUNDAI, {"surface": "global", "funnel": "F404"})
    assert bad["meta"]["dropped_filters"] == {"funnel": ["F404"]}
    assert bad["data"]["markets"] == [] and "hyundai-north-america" in bad["data"]["pending"]                   # 빈 집합(fail-closed)
    web = await get(client_as, KIA_EU, {"surface": "website", "funnel": "F1"})
    assert web["meta"]["ignored_filters"] == ["funnel"]                                                          # 웹사이트는 지원 축 밖


# ── BG-48 ────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("uid,params", [(ADMIN, {}), (ADMIN, {"brand": ["Hyundai", "Kia"]}), (HQ_HYUNDAI, {}), (ADMIN, {"brand": "Kia"})])
async def test_bg48_own_label_matches_brands_vp_label(client_as, uid, params):
    q = {"surface": "global", **params}
    g = await get(client_as, uid, q)
    async with client_as(uid) as c:
        m = (await c.get("/v1/mentions/brands", params=q)).json()
    assert g["data"]["own_label"] == m["data"]["own"]["vp_label"]
    if params.get("brand") == ["Hyundai", "Kia"]:
        assert g["data"]["own_label"] == "HMG" and g["data"]["markets"] == []                # 이전 규칙은 'Hyundai, Kia'
