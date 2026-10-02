"""analytics.geo.markets(GEO-1) 테스트. 로컬 개발 DB(합성 픽스처) 복제본 an_trend_geo.

픽스처 손 계산(글로벌 스냅샷 = 회차 11, 2026-09-14)
  현대 관점 US: std = k1·k2·k12 → 노출 2/3, 언급 5/11, 우호 4/5, 순위 3/2, 인용 자사 2/9. KR 은 k4(분석 결손, std 0)뿐이라 측정 국가 아님.
  US 경쟁 행: Toyota 3(k1) · smart 1(k2) · Kia 2(k2, 형제 HMG 브랜드 → 브랜드 격리로 경쟁사 아님, 분모에는 남음).
  → 당사 순위 1, 경쟁 필드 3(당사 + Toyota + smart), 최대 경쟁사 Toyota(노출 1/3, 언급 3/11, 우호 0/2, 순위 1/1).
기대값은 아래 독립 SQL(소유자 접속, 비트 식을 직접 쓴다)로도 센다.
"""
from __future__ import annotations

from datetime import date

import asyncpg
import pytest

from app.features.analytics.trend.series.tests.staged import NewCycle, Stage, scalar_rows, staged
from tests.support import ADMIN, CUST_PROJECT, DB_URL, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db

pytestmark = needs_db
D14 = date(2026, 9, 14)


async def one(sql: str, *args):
    c = await asyncpg.connect(DB_URL)
    try:
        return await c.fetchrow(sql, *args)
    finally:
        await c.close()


async def col(sql: str, *args) -> list:
    c = await asyncpg.connect(DB_URL)
    try:
        return [r[0] for r in await c.fetch(sql, *args)]
    finally:
        await c.close()


async def get(client_as, uid, params, status=200):
    async with client_as(uid) as c:
        r = await c.get("/v1/geo", params=params)
    assert r.status_code == status, r.text
    return r.json()


def masks(bits: int) -> list[int]:
    """관점 모수 bgrp 허용 값. 테스트 SQL 도 경계 가드(비트 식은 FILTER 안, WHERE 는 = ANY)를 지킨다."""
    return [m for m in range(1, 32) if m & bits]


async def cyc(surface: int, d: date) -> list[int]:
    return await col("SELECT cyc_key FROM rd.cycle WHERE surface = $1 AND round_date = $2", surface, d)


def rt(x: dict | None) -> tuple[int, int] | None:
    return (x["num"], x["den"]) if x else None


US_HYUNDAI = """
SELECT count(*) FILTER (WHERE a.std_in) AS n, count(*) FILTER (WHERE a.std_in AND a.own_mask & 1 = 1) AS vis,
       sum(a.ment_h) FILTER (WHERE a.std_in) AS om, sum(a.ment_total) FILTER (WHERE a.std_in) AS tm,
       sum(a.sent_pos_h) FILTER (WHERE a.std_in) AS sp, sum(a.sent_all_h) FILTER (WHERE a.std_in) AS sa,
       sum(a.own_rk_h) FILTER (WHERE a.std_in AND a.own_rk_h > 0) AS rks, count(*) FILTER (WHERE a.std_in AND a.own_rk_h > 0) AS rkn,
       sum(a.cit_n) AS cit, sum(a.cit_off) AS co
  FROM rd.answer a JOIN rd.dim_country g ON g.geo_key = a.geo_key AND g.code = 'US'
 WHERE a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($3::int4[]) AND a.bgrp = ANY($4::int2[]) AND a.dflt AND a.cit_in
   AND ($2::text IS NULL OR a.engine_key = (SELECT engine_key FROM rd.dim_engine WHERE code = $2))
"""


async def us_hyundai(engine: str | None):
    return await one(US_HYUNDAI, D14, engine, await cyc(1, D14), masks(9))


async def test_global_snapshot_region_tree(client_as):
    b = await get(client_as, HQ_HYUNDAI, {"surface": "global"})
    d, m = b["data"], b["meta"]
    assert d["active_brand"] == "Hyundai" and d["own_label"] == "Hyundai"
    assert m["mode"] == "snapshot" and m["as_of"] == D14.isoformat() and m["cycles"] == [D14.isoformat()] and m["suppressed"] == {}
    assert [x["region_id"] for x in d["markets"]] == ["hyundai-north-america"]
    na = d["markets"][0]
    assert na["region_label"] == "북아메리카" and na["country_count"] == 1 and [c["code"] for c in na["countries"]] == ["US"]
    e = await us_hyundai(None)
    us = na["countries"][0]
    assert set(us) == {"code", "answers", "own", "rank", "top_own_brand", "top_rival"}   # 검증 D3: country_name 은 프론트(명세 차이)
    assert us["answers"] == e["n"] == 3
    assert rt(us["own"]["visibility"]) == (e["vis"], e["n"]) == (2, 3)
    assert rt(us["own"]["share_of_voice"]) == (e["om"], e["tm"]) == (5, 11)
    assert rt(us["own"]["sentiment"]) == (e["sp"], e["sa"]) == (4, 5)
    assert us["own"]["position"] == {"sum": e["rks"], "count": e["rkn"]}
    assert rt(us["own"]["citation_share"]) == (e["co"], e["cit"]) == (4, 9)          # M05 분자 = 공식(HMG) 카테고리(hmg-geo #321)
    assert us["rank"] == {"our": 1, "field_size": 3}
    assert us["top_own_brand"] == {"brand": "Hyundai", "share_of_voice": {"num": 5, "den": 11}}
    tr = us["top_rival"]
    assert tr["brand"] == "Toyota"
    assert rt(tr["metrics"]["visibility"]) == (1, 3) and rt(tr["metrics"]["share_of_voice"]) == (3, 11)
    assert rt(tr["metrics"]["sentiment"]) == (0, 2) and tr["metrics"]["position"] == {"sum": 1, "count": 1}
    assert tr["metrics"]["citation_share"] is None
    # 권역 값 = 소속 국가 원시값 합(국가 하나라 같다)
    assert na["own"] == us["own"] and na["rank"] == us["rank"] and na["top_rival"] == us["top_rival"]
    regions = await col("SELECT region_id FROM app.rhq_region WHERE brand_code = 'Hyundai' ORDER BY region_id")
    assert d["pending"] == [r for r in regions if r != "hyundai-north-america"]


async def test_sibling_brand_isolated_from_rivals(client_as):
    """형제 HMG 브랜드(Kia)는 경쟁사 목록에 없고 분모(시장 전체 언급)에는 남는다."""
    b = await get(client_as, HQ_HYUNDAI, {"surface": "global", "engine": "gemini"})
    us = b["data"]["markets"][0]["countries"][0]
    e = await us_hyundai("gemini")
    assert rt(us["own"]["share_of_voice"]) == (e["om"], e["tm"]) == (0, 3)      # 분모 3 = Kia 2 + smart 1
    assert us["top_rival"]["brand"] == "smart" and us["rank"] == {"our": 2, "field_size": 2}
    assert us["top_own_brand"] is None


async def test_filters_change_rows(client_as):
    kr = await get(client_as, HQ_HYUNDAI, {"surface": "global", "country": "KR"})
    assert kr["data"]["markets"] == [] and "hyundai-north-america" in kr["data"]["pending"]
    rng = await get(client_as, HQ_HYUNDAI, {"surface": "global", "from": "2026-09-01", "to": "2026-09-20"})
    assert rng["meta"]["mode"] == "cumulative" and rng["meta"]["cycles"] == ["2026-09-07", D14.isoformat()]
    us = rng["data"]["markets"][0]["countries"][0]
    assert rt(us["own"]["share_of_voice"]) == (5, 11)            # 회차 10 은 언급 모수 0(분석 결손)이라 누적이 스냅샷과 같다
    ign = await get(client_as, HQ_HYUNDAI, {"surface": "global", "funnel": "F1", "lang": "en"})
    assert ign["meta"]["ignored_filters"] == []                   # BG-01·BG-02: 글로벌 lang[]·택소노미는 지원 축(적용)
    assert rt(ign["data"]["markets"][0]["countries"][0]["own"]["share_of_voice"]) == (5, 11)   # k1·k2·k12 모두 F1·en


async def test_brand_required_for_region_tree(client_as):
    b = await get(client_as, ADMIN, {"surface": "global"})
    assert b["data"]["markets"] == [] and b["data"]["pending"] == [] and b["data"]["active_brand"] is None
    assert b["data"]["own_label"] == "HMG" and b["meta"]["suppressed"] == {"markets": "brand_required"}
    # core 10라운드: brand[] 는 카탈로그 정확 일치(현행 answerWhere f.brand IN, scope-aggregates.ts:2276). 예전 기대(US 가 보임)는
    # 공통 HMG 프롬프트 SP3(bgrp 8)의 US 답변 때문이었다. 기아 카탈로그 프롬프트의 스냅샷 답변은 DE(std_in 거짓)뿐이라 시장이 없다.
    kia = await get(client_as, ADMIN, {"surface": "global", "brand": "Kia"})
    assert kia["data"]["active_brand"] == "Kia" and kia["data"]["markets"] == []
    hy = await get(client_as, ADMIN, {"surface": "global", "brand": "Hyundai"})
    assert hy["data"]["active_brand"] == "Hyundai"
    us = next(c for m in hy["data"]["markets"] for c in m["countries"] if c["code"] == "US")
    e = await one("""SELECT count(*) FILTER (WHERE std_in) AS n, sum(ment_h) FILTER (WHERE std_in) AS om, sum(ment_total) FILTER (WHERE std_in) AS tm
                       FROM rd.answer WHERE surface = 1 AND round_date = $1 AND cyc_key = ANY($2::int4[]) AND bgrp = ANY($3::int2[])
                        AND dflt AND cit_in AND geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = 'US')""",
                  D14, await cyc(1, D14), masks(1))
    assert us["answers"] == e["n"] == 2 and rt(us["own"]["share_of_voice"]) == (e["om"], e["tm"])


async def test_region_scope_no_leak(client_as):
    """KIA_EU(서유럽 권역): 글로벌 스냅샷에 서유럽 측정 국가가 없어 markets=[], US 는 스코프 밖이라 요청해도 버린다."""
    b = await get(client_as, KIA_EU, {"surface": "global"})
    assert b["data"]["markets"] == []
    regions = await col("SELECT region_id FROM app.rhq_region WHERE brand_code = 'Kia' ORDER BY region_id")
    assert b["data"]["pending"] == regions
    us = await get(client_as, KIA_EU, {"surface": "global", "country": "US"})
    assert us["meta"]["dropped_filters"] == {"country": ["US"]} and us["data"]["markets"] == []


async def test_website_mentions_only(client_as):
    b = await get(client_as, KIA_EU, {"surface": "website"})
    assert b["meta"]["suppressed"] == {k: "website_mentions_only" for k in ("visibility", "sentiment", "position", "citation_share")}
    m = b["data"]["markets"]
    assert [x["region_id"] for x in m] == ["kia-western-europe"]
    de = m[0]["countries"][0]
    d18 = date(2026, 9, 18)
    e = await one("""SELECT count(*) AS n, sum(ment_k) AS om, sum(ment_total) AS tm FROM rd.answer
                      WHERE surface = 2 AND round_date = $1 AND cyc_key = ANY($2::int4[]) AND std_in AND dflt AND bgrp = 2""",
                  d18, await cyc(2, d18))
    assert de["code"] == "DE" and de["answers"] == e["n"] and rt(de["own"]["share_of_voice"]) == (e["om"], e["tm"]) == (1, 1)
    assert de["own"]["visibility"] is None and de["own"]["position"] is None and de["own"]["citation_share"] is None


async def test_role_and_menu_gates(client_as):
    async with client_as(None) as c:
        assert (await c.get("/v1/geo", params={"surface": "global"})).status_code == 401
    async with client_as(SUSPENDED) as c:
        assert (await c.get("/v1/geo", params={"surface": "global"})).status_code == 401
    for uid in (KIA_US, VENDOR):                     # showsGeoMap: country·vendor 는 GEO 화면 없음
        r = await get(client_as, uid, {"surface": "global"}, status=403)
        assert r["error"]["code"] == "role_forbidden"
    r = await get(client_as, HQ_HYUNDAI, {"surface": "website"}, status=403)
    assert r["error"]["code"] == "menu_forbidden"


async def test_empty_window(client_as):
    b = await get(client_as, HQ_HYUNDAI, {"surface": "global", "from": "2020-01-01", "to": "2020-01-31"})
    assert b["data"]["markets"] == [] and b["data"]["pending"] == [] and b["meta"]["suppressed"] == {"*": "no_active_snapshot"}


@pytest.mark.parametrize("params,code", [
    ({"surface": "project"}, "surface_not_supported"),                  # Q8: 프로젝트 표면 제외
    ({"surface": "global", "from": "2026-09-02", "to": "2026-09-01"}, "unprocessable"),
    ({"surface": "global", "from": "bad", "to": "2026-09-01"}, "unprocessable"),
    ({"surface": "nope"}, "unprocessable"),
    ({}, "unprocessable"),
])
async def test_invalid_params_422(client_as, params, code):
    r = await get(client_as, ADMIN, params, status=422)
    assert r["error"]["code"] == code


# ════════════════════════════════════════════════════════════════════════════
# 검증 결함 회귀(D4·D5). 회차·사실 행을 더하는 시험은 staged(트랜잭션 + ROLLBACK, 복제본 불변)로 돈다.
# ════════════════════════════════════════════════════════════════════════════
async def test_d4_project_id_on_global_is_marked_ignored(client_as):
    b = await get(client_as, HQ_HYUNDAI, {"surface": "global", "project_id": str(CUST_PROJECT)})
    assert b["meta"]["ignored_filters"] == ["project_id"]
    assert [c["code"] for m in b["data"]["markets"] for c in m["countries"]] == ["US"]


# 독립 기대값: 기간 누적 국가별(계열별 회차 키를 직접 가른다. 구현은 core.measure 빌더의 FILTER 분리)
PERIOD_BY_COUNTRY = """
SELECT g.code,
       count(*) FILTER (WHERE a.std_in AND a.cyc_key = ANY(CAST(:mk AS int4[]))) AS n,
       count(*) FILTER (WHERE a.std_in AND a.cyc_key = ANY(CAST(:mk AS int4[])) AND a.own_mask & 1 = 1) AS vis,
       sum(a.ment_h) FILTER (WHERE a.std_in AND a.cyc_key = ANY(CAST(:mk AS int4[]))) AS om,
       sum(a.ment_total) FILTER (WHERE a.std_in AND a.cyc_key = ANY(CAST(:mk AS int4[]))) AS tm,
       sum(a.cit_n) FILTER (WHERE a.cyc_key = ANY(CAST(:ck AS int4[]))) AS cit,
       sum(a.cit_off) FILTER (WHERE a.cyc_key = ANY(CAST(:ck AS int4[]))) AS co
  FROM rd.answer a JOIN rd.dim_country g ON g.geo_key = a.geo_key
 WHERE a.surface = 1 AND a.round_date BETWEEN :lo AND :hi AND a.cyc_key = ANY(CAST(:all AS int4[]))
   AND a.bgrp = ANY(CAST(:m AS int2[])) AND a.dflt AND a.cit_in
 GROUP BY g.code
"""
CYCLES = """SELECT c.cyc_key, c.hidden_scope FROM rd.cycle c
             WHERE c.surface = 1 AND c.servable AND c.round_date BETWEEN :lo AND :hi"""


async def test_d5_period_region_sum_multi_country_and_hidden_cycles(client_as):
    """D5(4): 권역 = 소속 국가 원시값 합(US·CA 두 국가), 기간 누적에서 전체 숨김 회차는 빠지고 언급 숨김 회차는 인용 계열에만 든다.
    회차 904(09-10) = 회차 11 의 US 행을 CA 로 복사, 905(09-11) = US 복사 + 운영자 전체 숨김, 906(09-12) = US 복사 + 언급 숨김."""
    lo, hi = date(2026, 9, 1), date(2026, 9, 20)
    st = Stage(cycles=[NewCycle(904, date(2026, 9, 10), copy_from=11, geos={"US": "CA"}),
                       NewCycle(905, date(2026, 9, 11), hidden_scope=1, hidden_reason=2, copy_from=11, geos={"US": "US"}),
                       NewCycle(906, date(2026, 9, 12), hidden_scope=3, hidden_reason=2, copy_from=11, geos={"US": "US"})])
    async with staged(st) as conn:
        b = await get(client_as, HQ_HYUNDAI, {"surface": "global", "from": lo.isoformat(), "to": hi.isoformat()})
        snap = await get(client_as, HQ_HYUNDAI, {"surface": "global"})
        cy = await scalar_rows(conn, CYCLES, lo=lo, hi=hi)
        mk = [r["cyc_key"] for r in cy if r["hidden_scope"] not in (1, 3)]
        ck = [r["cyc_key"] for r in cy if r["hidden_scope"] not in (1, 2)]
        rows = await scalar_rows(conn, PERIOD_BY_COUNTRY, mk=mk, ck=ck, all=sorted({*mk, *ck}), lo=lo, hi=hi, m=masks(9))
    assert 905 not in mk + ck and 906 in ck and 906 not in mk
    e = {r["code"]: r for r in rows}
    na = next(m for m in b["data"]["markets"] if m["region_id"] == "hyundai-north-america")
    got = {c["code"]: c for c in na["countries"]}
    assert sorted(got) == ["CA", "US"] and na["country_count"] == 2
    for cc in ("US", "CA"):
        c, x = got[cc], e[cc]
        assert c["answers"] == x["n"]
        assert rt(c["own"]["visibility"]) == (x["vis"], x["n"])
        assert rt(c["own"]["share_of_voice"]) == (x["om"], x["tm"])
        assert rt(c["own"]["citation_share"]) == (x["co"], x["cit"])
    assert rt(got["US"]["own"]["share_of_voice"]) == (5, 11) and rt(got["US"]["own"]["citation_share"]) == (8, 18)   # 906 인용만
    assert rt(got["CA"]["own"]["citation_share"]) == (4, 9)
    # 권역 = 국가 원시값(분자·분모) 합(P3, 평균 아님)
    assert na["answers"] == sum(e[c]["n"] for c in ("US", "CA")) == 6
    for k, (num, den) in {"visibility": ("vis", "n"), "share_of_voice": ("om", "tm"), "citation_share": ("co", "cit")}.items():
        assert rt(na["own"][k]) == (sum(e[c][num] for c in ("US", "CA")), sum(e[c][den] for c in ("US", "CA")))
    assert rt(na["own"]["share_of_voice"]) == (10, 22) and rt(na["own"]["citation_share"]) == (12, 27)
    assert na["rank"] == {"our": 1, "field_size": 3}
    assert na["top_rival"]["brand"] == "Toyota" and rt(na["top_rival"]["metrics"]["share_of_voice"]) == (6, 22)
    # 스냅샷은 최신 비숨김 회차(09-14) 하나라 더한 회차가 섞이지 않는다
    assert snap["meta"]["as_of"] == D14.isoformat()
    sus = snap["data"]["markets"][0]["countries"]
    assert [c["code"] for c in sus] == ["US"] and rt(sus[0]["own"]["share_of_voice"]) == (5, 11)
