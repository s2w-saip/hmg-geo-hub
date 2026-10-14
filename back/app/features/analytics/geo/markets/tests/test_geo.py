"""analytics.geo.markets(GEO-1) 테스트. 로컬 개발 DB(합성 픽스처) 복제본 an_trend_geo.

픽스처 손 계산(글로벌 스냅샷 = 회차 11, 2026-09-14)
  현대 관점 US: std = k1·k2·k12 → 노출 2/3, 언급 5/11, 우호 4/5, 순위 3/2, 인용 자사 2/9. KR 은 k4(분석 결손, std 0)뿐이라 측정 국가 아님.
  US 경쟁 행: Toyota 3(k1) · smart 1(k2) · Kia 2(k2, 형제 HMG 브랜드 → 브랜드 격리로 경쟁사 아님, 분모에는 남음).
  → 당사 순위 1, 경쟁 필드 3(당사 + Toyota + smart), 최대 경쟁사 Toyota(노출 1/3, 언급 3/11, 우호 0/2, 순위 1/1).
기대값은 아래 독립 SQL(소유자 접속, 비트 식을 직접 쓴다)로도 센다.
"""
from __future__ import annotations

import contextlib
import re
import uuid
from collections.abc import Iterator
from dataclasses import replace
from datetime import date

import asyncpg
import pytest
from sqlalchemy import event
from sqlalchemy.engine import Engine

from app.core.cycles import CycleRow, build_window
from app.core.measure import MeasureScope, competitor_rows_sql, merge_counts, plan_counts, ratios
from app.features.analytics.trend.series.tests.staged import NewCycle, Stage, scalar_rows, staged
from tests.support import ADMIN, CUST_PROJECT, DB_URL, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, Rows, Update, needs_db, raw_fetch
from tests.support import staged as core_staged

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


# ════════════════════════════════════════════════════════════════════════════
# B094: 웹사이트(언급 수 지표만, Q8)는 점유율이 쓰는 열만 센다 — core.measure part 'sov'·brand_rows(mentions_only=True).
# 응답 바이트 = 종전 열 조합(part 'mentions'·경쟁 행 전 열) 응답, 노출·감성·순위 열은 문장에 없다. 글로벌 문장은 바이트 그대로다.
# ════════════════════════════════════════════════════════════════════════════
@contextlib.contextmanager
def recorded() -> Iterator[list[str]]:
    """이 블록에서 실행된 SQL 문장(모든 엔진)."""
    seen: list[str] = []

    def before(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        seen.append(statement)
    event.listen(Engine, "before_cursor_execute", before)
    try:
        yield seen
    finally:
        event.remove(Engine, "before_cursor_execute", before)


def b094_old():
    """B094 이전 호출: 웹사이트도 part 'mentions'(9열) + 경쟁 행 전 열(노출·순위·톤 합)."""
    from app.features.analytics.geo.markets import service as S
    real_counts, real_rows = S.fetch_counts, S.brand_rows

    async def old_counts(conn, ms, win, *, parts, **kw):
        return await real_counts(conn, ms, win, parts=("mentions",) if tuple(parts) == ("sov",) else parts, **kw)

    async def old_rows(conn, ms, win, *, mentions_only=False, **kw):
        return await real_rows(conn, ms, win, **kw)
    return [(S, "fetch_counts", old_counts), (S, "brand_rows", old_rows)]


async def b094_pair(client_as, monkeypatch, uid, params) -> tuple[dict, list[str], list[str]]:
    """(새 응답 JSON, 새 문장, 종전 문장). 종전 = b094_old 를 끼운 같은 요청. 응답 바이트가 같아야 한다."""
    async with client_as(uid) as c:
        with recorded() as s_new:
            new = await c.get("/v1/geo", params=params)
        with monkeypatch.context() as m:
            for mod, name, fn in b094_old():
                m.setattr(mod, name, fn)
            with recorded() as s_old:
                old = await c.get("/v1/geo", params=params)
    assert new.status_code == 200, (params, new.text)
    assert old.status_code == 200, (params, old.text)
    assert new.content == old.content, params
    return new.json(), s_new, s_old


def fact_statements(stmts: list[str]) -> tuple[list[str], list[str]]:
    """(당사 집계 문장, 경쟁 행 문장). 사실 표 이름은 LIVE(rd.*)·동결 카드 뷰(frz.card_*) 어느 쪽이든."""
    return ([s for s in stmts if "AS total_mentions" in s],
            [s for s in stmts if "sum(b.mention_count) AS mentions" in s])


async def b094_web_steps(*, rid_null: bool = False) -> list:
    """웹사이트 회차 21(2026-09-18) 준비: 답변 21 = DE(당사 1·Toyota 3·BMW 1·형제 Hyundai 1), 답변 22 → FR(당사 2·Toyota 2·smart 2 동률).
    국가 둘(같은 권역 = 권역 합산), 경쟁사 셋, 형제 HMG 브랜드(경쟁사 아님, 분모에는 남음), 최대 경쟁사 동률(이름순)을 만든다.
    rid_null = DE Toyota 경쟁 행의 노출 단위 열(rid_n)을 비운다(G20 채우기 전 행)."""
    async with core_staged() as probe:
        keys = {r["name"]: int(r["brand_key"]) for r in await raw_fetch(
            probe, "SELECT brand_key, name FROM rd.dim_brand_name WHERE name = ANY($1::text[])", ["Toyota", "smart", "BMW", "Hyundai"])}
        geo = {r["code"]: int(r["geo_key"]) for r in await raw_fetch(
            probe, "SELECT code, geo_key FROM rd.dim_country WHERE code = ANY($1::text[])", ["DE", "FR"])}
    d18 = date(2026, 9, 18)
    base = {"round_date": d18, "cyc_key": 21, "surface": 2, "project_key": 2, "lang_key": 1, "bgrp": 2, "entity_rows": 1,
            "t_mention": 1, "t_recommendation": 0, "t_comparison": 0, "t_definition": 0, "t_final_choice": 0, "competitive": True,
            "std_in": True, "elig": True, "dflt": True, "rule_ver": 1, "is_rep": True, "std_in_nc": True, "rid_n": 1}
    a21 = {**base, "answer_key": 21, "prompt_key": 8, "engine_key": 1, "geo_key": geo["DE"]}
    a22 = {**base, "answer_key": 22, "prompt_key": 10, "engine_key": 2, "geo_key": geo["FR"]}
    rows = [
        {**a21, "brand_key": keys["Toyota"], "own_bit": 0, "mention_count": 3, "rk": 2, "s_pos": 1, "s_neu": 1, "s_neg": 1, "s_mix": 0,
         "rid_n": None if rid_null else 1},
        {**a21, "brand_key": keys["BMW"], "own_bit": 0, "mention_count": 1, "rk": 3, "s_pos": 0, "s_neu": 1, "s_neg": 0, "s_mix": 0},
        {**a21, "brand_key": keys["Hyundai"], "own_bit": 1, "mention_count": 1, "rk": 4, "s_pos": 1, "s_neu": 0, "s_neg": 0, "s_mix": 0},
        {**a22, "brand_key": keys["Toyota"], "own_bit": 0, "mention_count": 2, "rk": 2, "s_pos": 0, "s_neu": 0, "s_neg": 0, "s_mix": 1},
        {**a22, "brand_key": keys["smart"], "own_bit": 0, "mention_count": 2, "rk": 3, "s_pos": 0, "s_neu": 0, "s_neg": 1, "s_mix": 0},
    ]
    return [Update("rd.answer", {"surface": 2, "round_date": d18, "answer_key": 21}, {"ment_total": 6}),
            Update("rd.answer", {"surface": 2, "round_date": d18, "answer_key": 22},
                   {"geo_key": geo["FR"], "region_geo_key": geo["FR"], "ment_total": 6, "ment_k": 2, "own_mask": 2, "own_rk_k": 1,
                    "sent_pos_k": 1, "sent_all_k": 2}),
            Rows("rd.answer_brand", rows)]


WEB_CASES: list[tuple[uuid.UUID, dict]] = [
    (KIA_EU, {"surface": "website"}),
    (ADMIN, {"surface": "website", "brand": "Kia"}),
    (ADMIN, {"surface": "website", "brand": "Kia", "engine": "gemini"}),
    (ADMIN, {"surface": "website", "brand": "Kia", "country": "DE"}),
    (ADMIN, {"surface": "website", "brand": "Kia", "from": "2026-09-01", "to": "2026-09-30"}),
    (ADMIN, {"surface": "website"}),                                            # 관점 여럿 = brand_required(사실 문장 없음)
]
GLOBAL_CASES: list[tuple[uuid.UUID, dict]] = [
    (HQ_HYUNDAI, {"surface": "global"}),
    (HQ_HYUNDAI, {"surface": "global", "from": "2026-09-01", "to": "2026-09-20"}),
    (ADMIN, {"surface": "global", "brand": "Hyundai", "lang": "en"}),
]


async def _b094_run(client_as, monkeypatch) -> list[dict]:
    out = []
    for uid, params in WEB_CASES:
        body, s_new, s_old = await b094_pair(client_as, monkeypatch, uid, params)
        assert len(s_new) == len(s_old), params
        own_new, comp_new = fact_statements(s_new)
        own_old, comp_old = fact_statements(s_old)
        assert len(own_new) == len(own_old) and len(comp_new) == len(comp_old), params
        for s in own_new:                                                       # 당사: 답변·당사 언급·전체 언급 3열만
            assert "AS answers" in s and "AS own_mentions" in s
            assert not any(f"AS {c}" in s for c in ("tracked", "sent_pos", "sent_neg", "sent_all", "rank_sum", "ranked")), s
        for s in comp_new:                                                      # 경쟁 행: 언급 수만
            assert not any(f"AS {c}" in s for c in ("exposure_answers", "rank_sum", "ranked", "s_pos", "s_neu", "s_neg", "s_mix")), s
        for s in own_old:
            assert "AS tracked" in s and "AS rank_sum" in s                     # 종전 조합은 실제로 전 열을 셌다
        out.append(body)
    for uid, params in GLOBAL_CASES:                                            # 글로벌: 문장 바이트 그대로(B094 는 웹사이트만)
        _, s_new, s_old = await b094_pair(client_as, monkeypatch, uid, params)
        assert s_new == s_old, params
    return out


async def test_b094_website_sov_columns_equal_full(client_as, monkeypatch):
    """B094: 웹사이트 GEO 응답 = 종전(전 열) 응답 바이트(기본 픽스처·국가 2·경쟁사 3·형제 HMG·동률), 노출·감성·순위 열은 세지 않는다."""
    async with core_staged():
        base = await _b094_run(client_as, monkeypatch)
    assert base[0]["data"]["markets"] and base[0]["data"]["markets"][0]["countries"][0]["code"] == "DE"
    async with core_staged(*await b094_web_steps()):
        rich = await _b094_run(client_as, monkeypatch)
    kia = rich[1]["data"]["markets"]
    assert [m["region_id"] for m in kia] == ["kia-western-europe"]
    we = kia[0]
    got = {c["code"]: c for c in we["countries"]}
    assert sorted(got) == ["DE", "FR"]
    assert rt(got["DE"]["own"]["share_of_voice"]) == (1, 6) and got["DE"]["rank"] == {"our": 2, "field_size": 3}
    assert got["DE"]["top_rival"] == {"brand": "Toyota", "metrics": {"visibility": None, "share_of_voice": {"num": 3, "den": 6},
                                                                     "sentiment": None, "position": None, "citation_share": None}}
    assert rt(got["FR"]["own"]["share_of_voice"]) == (2, 6) and got["FR"]["rank"] == {"our": 1, "field_size": 3}
    assert got["FR"]["top_rival"]["brand"] == "smart"                         # Toyota·smart 동률 → 이름순(localeCompare)
    assert rt(we["own"]["share_of_voice"]) == (3, 12) and we["rank"] == {"our": 2, "field_size": 4}
    assert we["top_rival"]["brand"] == "Toyota" and rt(we["top_rival"]["metrics"]["share_of_voice"]) == (5, 12)
    assert all(c["own"]["visibility"] is None and c["own"]["sentiment"] is None for c in we["countries"])


@pytest.mark.legacy_profile("brand_exposure_per_alias")
async def test_b094_website_sov_columns_g20(client_as, monkeypatch):
    """G20 프로필(노출 단위 열 rid_n): 경쟁 행 언급 수만 읽어도 채우기 전 검사(rid_n_missing)는 종전과 같이 건다."""
    async with core_staged(*await b094_web_steps()):
        await _b094_run(client_as, monkeypatch)
        async with client_as(ADMIN) as c:
            with recorded() as s:
                assert (await c.get("/v1/geo", params={"surface": "website", "brand": "Kia"})).status_code == 200
        comp = fact_statements(s)[1]
        assert comp and all("AS rid_n_missing" in x and "AS exposure_answers" not in x for x in comp)
    async with core_staged(*await b094_web_steps(rid_null=True)):
        for patches in ([], b094_old()):                                        # 채우기 전 행: 새·종전 경로 모두 G20 예외
            with monkeypatch.context() as m:
                for mod, name, fn in patches:
                    m.setattr(mod, name, fn)
                async with client_as(ADMIN) as c:
                    with pytest.raises(RuntimeError, match="G20"):
                        await c.get("/v1/geo", params={"surface": "website", "brand": "Kia"})


# 동결 층(현행 프로필 freeze_at_publish): 대시보드 fetchGeo 는 card=true 라 웹사이트 GEO 도 카드 뷰를 읽는다(tests/core/test_frz_read.py 와 같은 준비:
# 웹 보고 유닛 준비(test_web_accuracy PREP) 뒤 회차 동결. 유닛이 없으면 카드 모수가 비어 비교가 헛돈다)
FRZ_ON = "freeze_at_publish,cell_rep,catalog_incl_deleted,rep_pick_latest_first,web_registered_only,summary_all_engines,web_accuracy_flat"


async def test_b094_website_card_frozen_layer(client_as, monkeypatch, settings):
    """B094 + 동결 층: 웹사이트 카드 GEO(card=true)는 동결 뷰(frz.card_answer_w·frz.card_answer_brand_w)에서 같은 열만 센다. 응답 = 종전 바이트."""
    from app.core.config import set_settings
    from tests.core.test_web_accuracy import FREEZE21
    from tests.core.test_web_accuracy import PREP as WEB_PREP
    from tests.support import resolve_test_profile

    set_settings(settings.model_copy(update={"legacy_profile": resolve_test_profile(FRZ_ON)}))
    try:
        async with core_staged(*WEB_PREP, *await b094_web_steps(), FREEZE21):          # 웹 회차 21 동결(준비 행 포함)
            bodies = []
            for uid, params in ((KIA_EU, {"surface": "website", "card": "true"}),
                                (ADMIN, {"surface": "website", "brand": "Kia", "card": "true"})):
                body, s_new, s_old = await b094_pair(client_as, monkeypatch, uid, params)
                own, comp = fact_statements(s_new)
                assert own and comp and len(s_new) == len(s_old), params
                assert all("frz.card_answer_w a" in x for x in own) and all("frz.card_answer_brand_w b" in x for x in comp), params
                assert not any(f"AS {c}" in x for x in own for c in ("tracked", "sent_pos", "rank_sum")), params
                assert not any(f"AS {c}" in x for x in comp for c in ("exposure_answers", "rank_sum", "s_pos")), params
                bodies.append(body)
    finally:
        set_settings(settings)
    got = {c["code"]: c for m in bodies[1]["data"]["markets"] for c in m["countries"]}
    assert "DE" in got, bodies
    assert got["DE"]["top_rival"]["brand"] == "Toyota" and rt(got["DE"]["own"]["share_of_voice"]) == (1, 6)   # 준비 행이 동결 층에 들어갔다


def _b094_scope() -> tuple[MeasureScope, object]:
    """웹사이트 회차 21(Kia DE 사이트) 빌더 입력(DB 없이 문장만 본다)."""
    d = date(2026, 9, 18)
    win = build_window(surface="website", mode="snapshot", rows=[CycleRow(21, 2, d, 0)], lo=d, hi=d, generation=1, project_keys=(2,))
    return MeasureScope(sf=2, project_keys=(2,), own_bits=(2,), bgrps=(2,), pop_bits=(2,)), win


FROM = "\n  FROM "


def select_items(sql: str) -> list[str]:
    """SELECT 목록 항목(최상위 쉼표 = 다음 항목이 count(*)·coalesce(·별칭 열로 시작)."""
    return re.split(r", (?=count\(\*\)|coalesce\(|a\.|b\.)", sql.split(FROM)[0].removeprefix("SELECT "))


def test_b094_sov_part_builder():
    """core part 'sov': 'mentions' 와 같은 식의 3열(WHERE·묶음 같다), 병합 행은 3열만, ratios 는 점유율만. 'mentions' 가 같이 오면 'mentions'."""
    ms, win = _b094_scope()
    full = plan_counts(ms, win, group_by=("geo",), parts=("mentions",)).statements[0][1].text
    sov_plan = plan_counts(ms, win, group_by=("geo",), parts=("sov",))
    sov = sov_plan.statements[0][1].text
    assert [r for r, _ in sov_plan.statements] == ["main"]
    keep = (" AS geo_key", " AS answers", " AS own_mentions", " AS total_mentions")
    assert len(select_items(full)) == 10
    assert select_items(sov) == [x for x in select_items(full) if x.endswith(keep)]      # 같은 식, 3열 + 묶음
    assert full.split(FROM)[1] == sov.split(FROM)[1]                                     # FROM·WHERE·GROUP BY 같다
    both = plan_counts(ms, win, parts=("mentions", "sov")).statements[0][1].text
    assert both == plan_counts(ms, win, parts=("mentions",)).statements[0][1].text
    merged = merge_counts(sov_plan, [[{"geo_key": 44, "answers": 2, "own_mentions": 1, "total_mentions": 6}]])
    assert merged == [{"geo_key": 44, "answers": 2, "own_mentions": 1, "total_mentions": 6}]
    assert merge_counts(plan_counts(ms, win, parts=("sov",)), [[]]) == [{"answers": 0, "own_mentions": 0, "total_mentions": 0}]
    assert ratios(merged[0]) == {"share_of_voice": (1, 6)}
    row = {"answers": 3, "tracked": 2, "own_mentions": 5, "total_mentions": 11, "sent_pos": 4, "sent_neg": 1, "sent_all": 5,
           "rank_sum": 3, "ranked": 2}
    assert list(ratios(row)) == ["visibility", "share_of_voice", "sentiment", "position"]   # 'mentions' 행은 종전 그대로
    assert ratios(row)["share_of_voice"] == (5, 11)


def test_b094_competitor_mentions_only_builder():
    """competitor_rows_sql(mentions_only=True): brand_key·mentions 만, 술어·묶음은 기본과 같다. G20 이면 rid_n_missing 검사 열은 남는다."""
    from app.core.profile import parse_profile
    ms, win = _b094_scope()
    for kw in ({}, {"group_by": ("geo",), "hmg_siblings": False}):
        full = competitor_rows_sql(ms, win, **kw).text
        lite = competitor_rows_sql(ms, win, mentions_only=True, **kw).text
        assert full.split(FROM)[1] == lite.split(FROM)[1]
        head = lite.split(FROM)[0]
        assert head.endswith("b.brand_key, sum(b.mention_count) AS mentions")
        assert "sum(b.mention_count) AS mentions" in full and "AS exposure_answers" in full
    g20 = replace(ms, profile=parse_profile("brand_exposure_per_alias"))
    lite = competitor_rows_sql(g20, win, mentions_only=True).text
    assert "AS rid_n_missing" in lite and "exposure_answers" not in lite and "AS s_pos" not in lite
    assert competitor_rows_sql(ms, win).text == competitor_rows_sql(ms, win, mentions_only=False).text
