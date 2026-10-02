"""analytics.trend.series(T-1) 테스트. 로컬 개발 DB(합성 픽스처) 복제본 an_trend_geo.

픽스처 손 계산(back/tests/README.md §4, tests/core/test_db.py 머리 주석)
  글로벌 원장 자리: 회차 10(2026-09-07, 노출 09-09) · 11(09-14, 노출 09-16). 회차 12(09-21)는 open 비서빙이라 자리가 아니다.
  현대 관점(bgrp & (1|8) <> 0, 기본 엔진 dflt) 회차 11: std = k1·k2·k12, 인용 모수(cit_in) = k1·k2·k4·k9·k12,
    노출 2/3, 언급 5/11, 우호 4/5, 순위 3/2, 인용 자사 2/9. 회차 10: cit_in 3건(k16·k17·k18)인데 std 0 → 언급 계열 analysis_pending.
  웹사이트: 회차 21(09-18) 인용 숨김(hidden_scope 2) → 인용 계열 gap hidden.
기대값은 아래 독립 SQL(소유자 접속, 구현 빌더와 다른 식)로 센다.
"""
from __future__ import annotations

from datetime import date

import asyncpg
import pytest

from app.core.cycles import CycleRow, build_window
from app.features.analytics.trend.series import service
from app.features.analytics.trend.series.tests.staged import NewCycle, Stage, scalar_rows, staged
from tests.support import ADMIN, CUST_PROJECT, DB_URL, HQ_HYUNDAI, KIA_DE_SITE, KIA_EU, KIA_US, SUSPENDED, VENDOR, needs_db

D07, D14, D18, D20 = date(2026, 9, 7), date(2026, 9, 14), date(2026, 9, 18), date(2026, 9, 20)


async def one(sql: str, *args):
    c = await asyncpg.connect(DB_URL)
    try:
        return await c.fetchrow(sql, *args)
    finally:
        await c.close()


async def many(sql: str, *args):
    c = await asyncpg.connect(DB_URL)
    try:
        return await c.fetch(sql, *args)
    finally:
        await c.close()


def masks(bits: int) -> list[int]:
    """관점 모수 bgrp 허용 값(bgrp & bits <> 0 인 1..31). 테스트 SQL 도 경계 가드(비트 식은 FILTER 안, WHERE 는 = ANY)를 지킨다."""
    return [m for m in range(1, 32) if m & bits]


async def cyc(surface: int, d: date) -> list[int]:
    c = await asyncpg.connect(DB_URL)
    try:
        return [r[0] for r in await c.fetch("SELECT cyc_key FROM rd.cycle WHERE surface = $1 AND round_date = $2", surface, d)]
    finally:
        await c.close()


def series(body: dict, metric: str, key: str | None = None) -> dict:
    for s in body["data"]["series"]:
        if s["metric"] == metric and s["key"] == key:
            return s
    raise AssertionError(f"계열 없음 {metric} {key}")


def point(s: dict, d: date) -> dict:
    return next(p for p in s["points"] if p["bucket"] == d.isoformat())


def ratio(p: dict) -> tuple[int, int] | None:
    return (p["ratio"]["num"], p["ratio"]["den"]) if p["ratio"] else None


# 독립 기대값: 현대 관점 글로벌 한 회차(비트 식을 직접 쓴다. 구현은 bgrp = ANY(상수 배열)·FILTER 빌더)
HYUNDAI_ROUND = """
SELECT count(*) FILTER (WHERE std_in) AS answers,
       count(*) FILTER (WHERE std_in AND own_mask & 1 = 1) AS vis,
       sum(ment_h) FILTER (WHERE std_in) AS own_m, sum(ment_total) FILTER (WHERE std_in) AS tot_m,
       sum(sent_pos_h) FILTER (WHERE std_in) AS sp, sum(sent_all_h) FILTER (WHERE std_in) AS sa,
       sum(own_rk_h) FILTER (WHERE std_in AND own_rk_h > 0) AS rks, count(*) FILTER (WHERE std_in AND own_rk_h > 0) AS rkn,
       sum(cit_n) AS cit, sum(cit_off) AS cit_own, count(*) AS cit_in_answers
  FROM rd.answer
 WHERE surface = 1 AND round_date = $1 AND cyc_key = ANY($3::int4[]) AND bgrp = ANY($4::int2[])
   AND engine_key IN (SELECT engine_key FROM rd.dim_engine WHERE is_default)
   AND cit_in AND ($2::text IS NULL OR engine_key = (SELECT engine_key FROM rd.dim_engine WHERE code = $2))
"""


async def hyundai_round(d: date, engine: str | None):
    return await one(HYUNDAI_ROUND, d, engine, await cyc(1, d), masks(9))


# ── 정상 응답 형태·값 ─────────────────────────────────────────────────────────
@needs_db
async def test_default_window_shape_and_values(client_as):
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.get("/v1/trend", params={"surface": "global"})
    assert r.status_code == 200, r.text
    b = r.json()
    d, m = b["data"], b["meta"]
    assert d["bucket"] == "cycle" and d["dimension"] == "none" and d["own_label"] == "Hyundai"
    assert [x["key"] for x in d["buckets"]] == [D07.isoformat(), D14.isoformat()]          # 회차 12(비서빙)는 자리 아님
    assert [s["code"] for s in d["series"]] == ["M01", "M02", "M03", "M04", "M05"]          # 글로벌 기본 세트
    assert all(len(s["points"]) == len(d["buckets"]) for s in d["series"])
    assert m["mode"] == "cumulative" and m["cycles"] == [D07.isoformat(), D14.isoformat()] and m["surface"] == "global"
    assert m["suppressed"] == {} and m["ignored_filters"] == [] and m["generation"] is not None

    e = await hyundai_round(D14, None)
    assert ratio(point(series(b, "visibility"), D14)) == (e["vis"], e["answers"]) == (2, 3)
    assert ratio(point(series(b, "share_of_voice"), D14)) == (e["own_m"], e["tot_m"]) == (5, 11)
    assert ratio(point(series(b, "sentiment"), D14)) == (e["sp"], e["sa"]) == (4, 5)
    assert point(series(b, "position"), D14)["rank"] == {"sum": e["rks"], "count": e["rkn"]} == {"sum": 3, "count": 2}
    assert ratio(point(series(b, "citation_share"), D14)) == (e["cit_own"], e["cit"]) == (4, 9)   # M05 분자 = 공식(HMG) 카테고리

    e07 = await hyundai_round(D07, None)
    assert e07["answers"] == 0 and e07["cit_in_answers"] > 0
    for mname in ("visibility", "share_of_voice", "sentiment", "position"):
        p = point(series(b, mname), D07)
        assert p["gap"] and p["gap_reason"] == "analysis_pending" and p["ratio"] is None and p["rank"] is None
    p = point(series(b, "citation_share"), D07)          # 인용 계열은 모수 답변이 있어 갭 아님, 인용 0 → 분모 0 = null
    assert not p["gap"] and p["ratio"] is None and e07["cit"] == 0


@needs_db
async def test_month_bucket_is_sum_of_cycle_buckets(client_as):
    """D6: 월 버킷 = 그 달 회차 버킷의 분자·분모 합."""
    async with client_as(HQ_HYUNDAI) as c:
        cyc = (await c.get("/v1/trend", params={"surface": "global"})).json()
        mon = (await c.get("/v1/trend", params={"surface": "global", "bucket": "month"})).json()
    assert [x["key"] for x in mon["data"]["buckets"]] == ["2026-09-01"]
    assert mon["data"]["buckets"][0]["round_dates"] == [D07.isoformat(), D14.isoformat()]
    for mname in ("visibility", "share_of_voice", "citation_share"):
        pts = [ratio(p) for p in series(cyc, mname)["points"] if ratio(p)]
        want = (sum(x[0] for x in pts), sum(x[1] for x in pts))
        assert ratio(series(mon, mname)["points"][0]) == want
    week = (await _get(client_as, HQ_HYUNDAI, {"surface": "global", "bucket": "week"}))
    assert [x["key"] for x in week["data"]["buckets"]] == ["2026-09-07", "2026-09-14"]     # 두 회차 모두 월요일


async def _get(client_as, uid, params):
    async with client_as(uid) as c:
        r = await c.get("/v1/trend", params=params)
    assert r.status_code == 200, r.text
    return r.json()


@needs_db
async def test_period_filter_narrows_buckets(client_as):
    b = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "from": "2026-09-10", "to": "2026-09-20"})
    assert [x["key"] for x in b["data"]["buckets"]] == [D14.isoformat()]
    assert b["meta"]["cycles"] == [D14.isoformat()]


@needs_db
async def test_engine_filter_changes_values(client_as):
    base = await _get(client_as, HQ_HYUNDAI, {"surface": "global"})
    gem = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "engine": "gemini"})
    e = await hyundai_round(D14, "gemini")
    assert ratio(point(series(gem, "visibility"), D14)) == (e["vis"], e["answers"]) == (0, 1)
    assert ratio(point(series(gem, "share_of_voice"), D14)) == (e["own_m"], e["tot_m"]) == (0, 3)
    assert ratio(point(series(base, "visibility"), D14)) != ratio(point(series(gem, "visibility"), D14))


@needs_db
async def test_country_filter_and_ignored_axes(client_as):
    kr = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "country": "KR", "lang": "ko", "source": "x"})
    p = point(series(kr, "visibility"), D14)
    assert p["gap"] and p["gap_reason"] == "analysis_pending"          # KR 답변 k4 = 분석 결손(std 0, cit_in 1)
    assert kr["meta"]["ignored_filters"] == []                          # 글로벌 lang 은 지원 축(BG-01, KPI_SUPPORT 파생): KR·ko = k4
    assert kr["meta"]["dropped_filters"] == {"source": ["x"]}           # source[] 는 지원 축(검증 D2): 모르는 카테고리는 버린다
    p = point(series(kr, "citation_share"), D14)
    assert not p["gap"] and p["ratio"] is None                         # 남은 카테고리 없음 = 빈 집합(fail-closed), 분모 0


# ── 차원 ─────────────────────────────────────────────────────────────────────
@needs_db
async def test_dimension_engine_series_keyed_by_engine_code(client_as):
    b = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "engine", "metrics": "M01,sov"})
    keys = [(s["metric"], s["key"]) for s in b["data"]["series"]]
    assert keys == [("visibility", "chatgpt"), ("visibility", "gemini"), ("share_of_voice", "chatgpt"), ("share_of_voice", "gemini")]
    for code in ("chatgpt", "gemini"):
        e = await hyundai_round(D14, code)
        assert ratio(point(series(b, "visibility", code), D14)) == (e["vis"], e["answers"])
        assert ratio(point(series(b, "share_of_voice", code), D14)) == (e["own_m"], e["tot_m"])


@needs_db
async def test_dimension_brand_own_and_competitors(client_as):
    b = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "brand"})
    ss = b["data"]["series"]
    assert ss[0]["key"] == "own" and ss[0]["is_own"] and ss[0]["label"] == "Hyundai" and ss[0]["metric"] == "share_of_voice"
    # 경쟁 행(M-1): competitive ∧ std_in ∧ own_bit <> 1(형제 Kia 는 남는다), 언급 수 내림차순
    rows = await many("""
        SELECT n.name, sum(b.mention_count) AS m FROM rd.answer_brand b JOIN rd.dim_brand_name n USING (brand_key)
         WHERE b.surface = 1 AND b.round_date = $1 AND b.cyc_key = ANY($2::int4[]) AND b.bgrp = ANY($3::int2[])
           AND b.dflt AND b.std_in AND b.competitive AND b.own_bit <> 1 AND b.brand_key <> 0
         GROUP BY n.name ORDER BY 2 DESC, 1""", D14, await cyc(1, D14), masks(9))
    tot = (await hyundai_round(D14, None))["tot_m"]
    assert [s["key"] for s in ss[1:]] == [r["name"] for r in rows] == ["Toyota", "Kia", "smart"]
    for r in rows:
        assert ratio(point(series(b, "share_of_voice", r["name"]), D14)) == (r["m"], tot)
    top1 = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "brand", "top": 1, "metrics": "M04"})
    assert [(s["metric"], s["key"]) for s in top1["data"]["series"]] == [("position", "own"), ("position", "Toyota")]
    assert point(top1["data"]["series"][1], D14)["rank"] == {"sum": 1, "count": 1}


@needs_db
async def test_dimension_source_and_category_mix(client_as):
    src = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "source", "top": 3})
    rows = await many("""
        SELECT s.skey, count(*) AS n FROM rd.citation c JOIN rd.dim_source s USING (source_key)
         WHERE c.surface = 1 AND c.round_date = $1 AND c.cyc_key = ANY($2::int4[]) AND c.bgrp = ANY($3::int2[])
           AND c.dflt AND c.cit_in AND c.source_key <> 0
         GROUP BY s.skey ORDER BY 2 DESC, 1""", D14, await cyc(1, D14), masks(9))
    total = sum(r["n"] for r in rows)
    assert total == 9 and len(src["data"]["series"]) == 3
    top = src["data"]["series"][0]
    assert top["key"] == rows[0]["skey"] == "reddit.com" and top["code"] == "M09"
    assert ratio(point(top, D14)) == (rows[0]["n"], total) == (2, 9)
    cat = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "category"})
    crow = await many("""
        SELECT cc.slug, count(*) AS n FROM rd.citation c JOIN rd.dim_source s USING (source_key)
          JOIN app.citation_category cc ON cc.category_key = s.category_key
         WHERE c.surface = 1 AND c.round_date = $1 AND c.cyc_key = ANY($2::int4[]) AND c.bgrp = ANY($3::int2[])
           AND c.dflt AND c.cit_in AND c.source_key <> 0
         GROUP BY cc.slug""", D14, await cyc(1, D14), masks(9))
    got = {s["key"]: ratio(point(s, D14)) for s in cat["data"]["series"]}
    assert got == {r["slug"]: (r["n"], 9) for r in crow}


# ── 표면별 ────────────────────────────────────────────────────────────────────
@needs_db
async def test_website_citation_hidden_cycle(client_as):
    b = await _get(client_as, KIA_EU, {"surface": "website"})
    assert [x["key"] for x in b["data"]["buckets"]] == [D18.isoformat()]
    assert [s["code"] for s in b["data"]["series"]] == ["M01", "M02", "M03", "M04", "M05", "M06", "M07"]
    for mname in ("citation_share", "target_url_rate", "owned_url_rate"):
        p = point(series(b, mname), D18)
        assert p["gap"] and p["gap_reason"] == "hidden"
        assert b["meta"]["suppressed"][mname] == "hidden"
    e = await one("""SELECT count(*) AS n, count(*) FILTER (WHERE own_mask & 2 = 2) AS vis, sum(ment_k) AS om, sum(ment_total) AS tm
                       FROM rd.answer WHERE surface = 2 AND round_date = $1 AND cyc_key = ANY($2::int4[])
                        AND std_in AND dflt AND bgrp = 2""", D18, await cyc(2, D18))
    assert ratio(point(series(b, "visibility"), D18)) == (e["vis"], e["n"]) == (1, 2)
    assert ratio(point(series(b, "share_of_voice"), D18)) == (e["om"], e["tm"])


@needs_db
async def test_project_surface_member(client_as):
    b = await _get(client_as, VENDOR, {"surface": "project", "project_id": str(CUST_PROJECT)})
    assert [x["key"] for x in b["data"]["buckets"]] == [D20.isoformat()]
    assert [s["code"] for s in b["data"]["series"]] == ["M01", "M02", "M03", "M04", "M05", "M06", "M07"]
    assert ratio(point(series(b, "visibility"), D20)) == (0, 1)
    assert point(series(b, "target_url_rate"), D20)["origin"] is None       # R09 은 웹사이트 전용


# ── 권한·스코프 ───────────────────────────────────────────────────────────────
@needs_db
async def test_auth_and_menu_gates(client_as):
    async with client_as(None) as c:
        assert (await c.get("/v1/trend", params={"surface": "global"})).status_code == 401
    async with client_as(SUSPENDED) as c:
        r = await c.get("/v1/trend", params={"surface": "global"})
        assert r.status_code == 401 and r.json()["error"]["code"] == "no_account"
    async with client_as(HQ_HYUNDAI) as c:                     # 메뉴 standard·project → 웹사이트 금지
        r = await c.get("/v1/trend", params={"surface": "website"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
    async with client_as(VENDOR) as c:                         # core 표면 경로 게이트(D-vendor): 역할이 표준 경로 밖
        r = await c.get("/v1/trend", params={"surface": "global"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"


@needs_db
async def test_scope_no_leak_country_account(client_as):
    """KIA_US(기아·US): 관점 = 기아, 국가 = US. 스코프 밖 국가 요청은 버리고(dropped) 값 0(fail-closed)."""
    b = await _get(client_as, KIA_US, {"surface": "global"})
    assert b["data"]["own_label"] == "Kia"
    e = await one("""SELECT count(*) FILTER (WHERE std_in) AS n, sum(ment_k) FILTER (WHERE std_in) AS om,
                            sum(ment_total) FILTER (WHERE std_in) AS tm
                       FROM rd.answer WHERE surface = 1 AND round_date = $1 AND cyc_key = ANY($2::int4[]) AND bgrp = ANY($3::int2[])
                        AND dflt AND cit_in AND geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = 'US')""",
                  D14, await cyc(1, D14), masks(10))
    assert ratio(point(series(b, "share_of_voice"), D14)) == (e["om"], e["tm"])
    assert ratio(point(series(b, "visibility"), D14))[1] == e["n"] == 1
    kr = await _get(client_as, KIA_US, {"surface": "global", "country": "KR"})
    assert kr["meta"]["dropped_filters"] == {"country": ["KR"]}
    assert all(p["gap"] and p["gap_reason"] == "no_answer" for s in kr["data"]["series"] for p in s["points"])


@needs_db
async def test_admin_viewpoint_hmg(client_as):
    b = await _get(client_as, ADMIN, {"surface": "global"})
    assert b["data"]["own_label"] == "HMG"
    e = await one("""SELECT count(*) FILTER (WHERE std_in) AS n, count(*) FILTER (WHERE std_in AND own_mask & 7 <> 0) AS vis
                       FROM rd.answer WHERE surface = 1 AND round_date = $1 AND cyc_key = ANY($2::int4[]) AND bgrp = ANY($3::int2[])
                        AND dflt AND cit_in""", D14, await cyc(1, D14), masks(15))
    assert ratio(point(series(b, "visibility"), D14)) == (e["vis"], e["n"])


# ── 빈 결과·검증 ──────────────────────────────────────────────────────────────
@needs_db
async def test_empty_window(client_as):
    b = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "from": "2020-01-01", "to": "2020-01-31"})
    assert b["data"]["buckets"] == [] and b["data"]["series"] == []
    assert b["meta"]["suppressed"] == {"*": "no_active_snapshot"} and b["meta"]["cycles"] == []


@needs_db
@pytest.mark.parametrize("params,code", [
    ({"surface": "global", "bucket": "day"}, "unprocessable"),
    ({"surface": "global", "dimension": "prompt"}, "unprocessable"),
    ({"surface": "global", "metrics": "M99"}, "unknown_metric"),
    ({"surface": "global", "metrics": "M06"}, "metric_not_supported"),                 # 웹사이트·프로젝트 전용
    ({"surface": "global", "dimension": "brand", "metrics": "M05"}, "metric_not_supported"),
    ({"surface": "global", "dimension": "source", "metrics": "M01"}, "metric_not_supported"),
    ({"surface": "global", "from": "2026-09-02", "to": "2026-09-01"}, "unprocessable"),
    ({"surface": "global", "from": "2026-09-20", "to": "2026-09-01"}, "unprocessable"),
    ({"surface": "global", "top": 0}, "unprocessable"),
    ({"surface": "mars"}, "unprocessable"),
    ({"surface": "project"}, "unprocessable"),                                          # project_id 필수
])
async def test_invalid_params_422(client_as, params, code):
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.get("/v1/trend", params=params)
    assert r.status_code == 422, r.text
    assert r.json()["error"]["code"] == code


# ── 순수 함수(원장 자리·기본 창) ───────────────────────────────────────────────
def _row(k: int, d: date, hidden: int = 0, reason: int = 0) -> CycleRow:
    return CycleRow(cyc_key=k, project_key=1, round_date=d, hidden_scope=hidden, hidden_reason=reason)


def test_slots_collection_error_kept_operator_hidden_dropped():
    # 2 = 수집 오류 전체 숨김, 3 = 운영자 전체 숨김, 4 = 운영자 인용 숨김(core CycleRow.hidden_reason)
    rows = [_row(1, date(2026, 8, 3)), _row(2, date(2026, 8, 10), hidden=1, reason=1), _row(3, date(2026, 8, 17), hidden=1, reason=2),
            _row(4, date(2026, 8, 24), hidden=2, reason=2)]
    win = build_window(surface="global", mode="cumulative", rows=rows, lo=rows[0].round_date, hi=rows[-1].round_date,
                       generation=1, project_keys=(1,))
    slots = service.build_slots(win, "cycle")
    assert [s.key for s in slots] == [date(2026, 8, 3), date(2026, 8, 10), date(2026, 8, 24)]
    assert service.family_gap(slots[0], win, "mentions") is None
    assert service.family_gap(slots[1], win, "mentions") == "collection_error"
    assert service.family_gap(slots[2], win, "mentions") is None
    assert service.family_gap(slots[2], win, "citations") == "hidden"
    month = service.build_slots(win, "month")
    assert [(s.key, s.round_dates) for s in month] == [(date(2026, 8, 1), [date(2026, 8, 3), date(2026, 8, 10), date(2026, 8, 24)])]


async def test_default_window_is_core_recent_window(monkeypatch):
    """기간 미지정 = core.cycles.resolve_recent_window(n=12, bucket) 위임(창 계산은 core 시험 tests/core/test_round5.py 가 맡는다)."""
    seen = {}

    async def fake_recent(conn, **kw):
        seen.update(kw)
        return build_window(surface="global", mode="cumulative", rows=[], lo=None, hi=None, generation=7, project_keys=(1,))
    monkeypatch.setattr(service, "resolve_recent_window", fake_recent)

    class Ctx:
        surface, project_keys, project_ids, date_from, card = "global", (1,), {}, None, False
    for bucket in ("cycle", "week", "month"):
        w = await service.trend_window(None, Ctx(), bucket)
        assert (seen["n"], seen["bucket"], seen["surface"], seen["project_keys"]) == (12, bucket, "global", (1,)) and w.generation == 7


def test_parse_metrics_aliases_and_defaults():
    got = service.parse_metrics(["M02,exposure_rate", "sov", "position"], "global", "none")
    assert [m.code for m in got] == ["M02", "M01", "M04"]
    assert [m.code for m in service.parse_metrics([], "website", "none")] == ["M01", "M02", "M03", "M04", "M05", "M06", "M07"]
    assert [m.code for m in service.parse_metrics([], "global", "brand")] == ["M02"]
    assert [m.code for m in service.parse_metrics([], "global", "category")] == ["M10"]


# ════════════════════════════════════════════════════════════════════════════
# 검증 결함 회귀(D1·D2·D4·D5). 회차·사실 행을 더하는 시험은 staged(트랜잭션 + ROLLBACK, 복제본 불변)로 돈다.
# ════════════════════════════════════════════════════════════════════════════
def d(day: int) -> date:
    return date(2026, 9, day)


# 독립 기대값: 현대 관점 글로벌 인용(rd.citation 원소를 직접 센다. 구현 M05 는 답변 인용 수 열 cit_off 빌더·출처 축이면 원소 스캔).
# M05 분자 = 출처 카테고리 Official (HMG)(동기화 S1 BE-4 = hmg-geo #320): 원소의 출처 차원 카테고리 이름으로 센다(관점 브랜드 무관)
HQ_CIT = """
SELECT count(*) FILTER (WHERE cc.name = 'Official (HMG)') AS own, count(*) AS n
  FROM rd.citation c JOIN rd.dim_source s ON s.source_key = c.source_key JOIN app.citation_category cc ON cc.category_key = s.category_key
 WHERE c.surface = 1 AND c.round_date = :rd AND c.cyc_key = ANY(CAST(:ks AS int4[])) AND c.bgrp = ANY(CAST(:m AS int2[]))
   AND c.dflt AND c.cit_in AND c.source_key <> 0 AND s.category_key = ANY(CAST(:cats AS int2[]))
"""
CATS = "SELECT cc.category_key, cc.slug FROM app.citation_category cc"


async def hq_cit(conn, rd: date, ks: list[int], slugs: list[str] | None = None) -> tuple[int, int]:
    cats = {r["slug"]: r["category_key"] for r in await scalar_rows(conn, CATS)}
    keep = [cats[x] for x in (slugs or cats)]
    r = (await scalar_rows(conn, HQ_CIT, rd=rd, ks=ks, m=masks(9), cats=keep))[0]
    return int(r["own"]), int(r["n"])


@needs_db
async def test_d1_mentions_hidden_cycle_keeps_citation_points(client_as):
    """D1: 언급만 숨긴 회차(hidden_scope 3)의 인용 계열 지점은 인용 계열 모수로 판정한다(no_answer 가 아니다).
    회차 16(2026-09-10) = 회차 11 복사 + 언급 숨김. 기대 M05 4/9(공식(HMG)), 월 버킷 = 회차 버킷 합(D6) 8/18, 출처·엔진 차원도 같은 규칙."""
    async with staged(Stage(cycles=[NewCycle(901, d(10), hidden_scope=3, hidden_reason=2, copy_from=11)])) as conn:
        b = await _get(client_as, HQ_HYUNDAI, {"surface": "global"})
        mon = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "bucket": "month"})
        src = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "source", "top": 3})
        eng = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "engine", "metrics": "M05"})
        e10 = await hq_cit(conn, d(10), [901])
    assert [x["key"] for x in b["data"]["buckets"]] == [d(7).isoformat(), d(10).isoformat(), D14.isoformat()]
    p = point(series(b, "citation_share"), d(10))
    assert not p["gap"] and ratio(p) == e10 == (4, 9)
    for mname in ("visibility", "share_of_voice", "sentiment", "position"):
        p = point(series(b, mname), d(10))
        assert p["gap"] and p["gap_reason"] == "hidden"
    assert b["meta"]["suppressed"] == {}
    cyc_pts = [ratio(p) for p in series(b, "citation_share")["points"] if ratio(p)]
    assert ratio(series(mon, "citation_share")["points"][0]) == (sum(x[0] for x in cyc_pts), sum(x[1] for x in cyc_pts)) == (8, 18)
    assert ratio(series(mon, "visibility")["points"][0]) == (2, 3)          # 언급 계열은 숨김 회차를 빼고 합한다
    reddit = series(src, "source_share", "reddit.com")
    assert not point(reddit, d(10))["gap"] and ratio(point(reddit, d(10))) == ratio(point(reddit, D14)) == (2, 9)
    gpt = series(eng, "citation_share", "chatgpt")
    assert ratio(point(gpt, d(10))) == ratio(point(gpt, D14)) and not point(gpt, d(10))["gap"]
    gem = series(eng, "citation_share", "gemini")
    assert not point(gem, d(10))["gap"] and point(gem, d(10))["ratio"] is None     # 인용 모수 답변은 있고 인용 0 → 분모 0


@needs_db
async def test_d2_source_filter_applies_to_citation_share(client_as):
    """D2: source[](인용 출처 카테고리)는 M05·M09·M10 에 적용되고(분자·분모 모두 그 카테고리), 언급 계열에는 적용되지 않는다."""
    async with staged(Stage()) as conn:
        off = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "source": "officialHmg"})
        cats = [r["slug"] for r in await scalar_rows(conn, CATS)]
        every = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "source": cats})
        e_off = await hq_cit(conn, D14, await cyc(1, D14), ["officialHmg"])
        e_mix = {x: (await hq_cit(conn, D14, await cyc(1, D14), [x]))[1] for x in ("officialHmg", "communityForums")}
        mix = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "category",
                                                 "source": ["officialHmg", "communityForums"]})
        m01 = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "metrics": "M01", "source": "officialHmg"})
        brand = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "brand", "source": "officialHmg"})
        eng = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "engine", "metrics": "M05", "source": "officialHmg"})
    assert ratio(point(series(off, "citation_share"), D14)) == e_off == (4, 4)       # 공식 HMG 4건 전부가 분자(카테고리 = 분자 판정)
    assert ratio(point(series(off, "visibility"), D14)) == (2, 3)                    # 언급 계열은 그대로
    assert off["meta"]["ignored_filters"] == [] and off["meta"]["dropped_filters"] == {}
    assert ratio(point(series(every, "citation_share"), D14)) == (4, 9)              # 전 카테고리 = 필터 없음과 같다
    tot = sum(e_mix.values())
    assert {s["key"]: ratio(point(s, D14)) for s in mix["data"]["series"]} == {k: (v, tot) for k, v in e_mix.items()} \
        == {"officialHmg": (4, 6), "communityForums": (2, 6)}
    assert m01["meta"]["ignored_filters"] == ["source"]                              # 적용 대상 계열이 없으면 무시를 표시
    assert brand["meta"]["ignored_filters"] == ["source"]
    gpt = point(series(eng, "citation_share", "chatgpt"), D14)
    assert ratio(gpt) == (4, 4)                                                      # k1 은 chatgpt 답변


@needs_db
async def test_d4_project_id_on_global_is_marked_ignored(client_as):
    b = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "project_id": str(CUST_PROJECT), "top": 3})
    assert b["meta"]["ignored_filters"] == ["project_id"]
    assert ratio(point(series(b, "visibility"), D14)) == (2, 3)                      # 값은 루트 프로젝트 그대로


@needs_db
async def test_d5_default_window_12_buckets_on_db(client_as):
    """D5(3): 실제 rd.cycle 경로로 기본 창 12자리(Q9)·수집 오류 갭 자리·운영자 숨김 비자리를 확인한다(FAR_PAST resolve_window, HIDDEN_REASON_SQL).
    원장: 09-01~09-06·08·09·10·13 빈 회차, 09-11 수집 오류 전체 숨김, 09-12 운영자 전체 숨김 + 픽스처 09-07·09-14 = 자리 13개."""
    empty = [NewCycle(900 + i, d(i)) for i in (1, 2, 3, 4, 5, 6, 8, 9, 10, 13)]
    hid = [NewCycle(911, d(11), hidden_scope=1, hidden_reason=1, copy_from=11),
           NewCycle(912, d(12), hidden_scope=1, hidden_reason=2, copy_from=11)]
    async with staged(Stage(cycles=empty + hid)):
        b = await _get(client_as, HQ_HYUNDAI, {"surface": "global"})
        wk = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "bucket": "week"})
        rng = await _get(client_as, HQ_HYUNDAI, {"surface": "global", "from": "2026-09-01", "to": "2026-09-30"})
    want = [d(i).isoformat() for i in (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14)]
    assert [x["key"] for x in b["data"]["buckets"]] == want                           # 최근 12자리(09-01 빠짐, 09-12 자리 아님)
    assert b["meta"]["cycles"] == [x for x in want if x != d(11).isoformat()]         # 전체 숨김 회차는 meta.cycles 에 없다
    for s in b["data"]["series"]:
        p = point(s, d(11))
        assert p["gap"] and p["gap_reason"] == "collection_error"
        p = point(s, d(2))
        assert p["gap"] and p["gap_reason"] == "no_answer"
    assert ratio(point(series(b, "visibility"), D14)) == (2, 3)
    assert [(x["key"], x["round_dates"]) for x in wk["data"]["buckets"]] == [
        ("2026-08-31", [d(i).isoformat() for i in range(1, 7)]),
        ("2026-09-07", [d(i).isoformat() for i in (7, 8, 9, 10, 11, 13)]),
        ("2026-09-14", [D14.isoformat()])]
    assert [x["key"] for x in rng["data"]["buckets"]][0] == d(1).isoformat() and len(rng["data"]["buckets"]) == 13


# 독립 기대값: R09 발행값(활성 발행, 사이트 웹 유닛, 브랜드 Kia, 국가 DE)
R09_SQL = """
SELECT sum(v.measured_prompts) AS m, sum(v.target_hit_prompts) AS t, sum(v.owned_prompts) AS o, sum(v.owned_prompts_den) AS od
  FROM rd.report_unit_value v JOIN app.report_publication p ON p.id = v.pub_id AND p.status = 'active'
 WHERE v.round_date = :rd AND v.brand = 'Kia' AND upper(v.country_code) = 'DE'
   AND v.file_seq IN (SELECT u.file_seq FROM rd.web_unit u JOIN rd.dim_project dp ON dp.project_key = u.project_key
                       WHERE dp.site_id = :site)
"""
LIVE_URL_SQL = """
SELECT count(*) FILTER (WHERE a.web_reg) AS den, count(*) FILTER (WHERE a.web_reg AND a.tgt_cited) AS tgt,
       count(*) FILTER (WHERE a.web_reg AND a.own_url_cited) AS own
  FROM rd.answer a
 WHERE a.surface = 2 AND a.round_date = :rd AND a.cyc_key = ANY(CAST(:ks AS int4[])) AND a.dflt AND a.cit_in AND a.bgrp = 2
"""


@needs_db
async def test_d5_website_r09_report_origin(client_as):
    """D5(2): 웹사이트 회차 21 의 인용 숨김을 풀면 M06·M07 회차 지점은 R09 발행값(origin=report).
    주 버킷(fe-u4 요청 3, core 9라운드): 그 주의 인용 계열 회차가 21 하나라 회차 값과 같은 발행값(예전 = 라이브)."""
    async with staged(Stage(unhide=[21])) as conn:
        b = await _get(client_as, KIA_EU, {"surface": "website"})
        wk = await _get(client_as, KIA_EU, {"surface": "website", "bucket": "week"})
        r = (await scalar_rows(conn, R09_SQL, rd=D18, site=KIA_DE_SITE))[0]
        lv = (await scalar_rows(conn, LIVE_URL_SQL, rd=D18, ks=await cyc(2, D18)))[0]
    assert b["meta"]["suppressed"] == {}
    tgt, own = point(series(b, "target_url_rate"), D18), point(series(b, "owned_url_rate"), D18)
    assert tgt["origin"] == own["origin"] == "report" and not tgt["gap"]
    assert ratio(tgt) == (r["t"], r["m"]) == (10, 15) and ratio(own) == (r["o"], r["od"]) == (12, 15)
    wkey = date(2026, 9, 14)
    tgt_w, own_w = point(series(wk, "target_url_rate"), wkey), point(series(wk, "owned_url_rate"), wkey)
    assert tgt_w["origin"] == own_w["origin"] == "report" and not tgt_w["gap"]
    assert ratio(tgt_w) == ratio(tgt) == (10, 15) and ratio(own_w) == ratio(own) == (12, 15)
    assert (lv["tgt"], lv["den"]) == (2, 2)                                    # 같은 회차 라이브 값(발행값과 다르다: 출처가 갈린다)
    assert not point(series(b, "citation_share"), D18)["gap"]


@needs_db
async def test_week_bucket_r09_folds_only_single_round(client_as):
    """fe-u4 요청 3: 같은 주에 인용 계열 회차가 둘이면(09-16 라이브 전용 + 09-18 발행) 주 지점은 버킷 라이브(두 회차 누적, origin=live).
    발행 회차 하나만 주 값으로 쓰면 다른 회차의 측정이 빠지고, 두 발행값을 더하면 단위(프롬프트 vs 측정)가 섞인다: 카드 규칙
    truth-axes.ts:95-101(구간은 어느 회차 값인지 정의되지 않음 → 라이브)과 같다. 회차 버킷은 회차마다 그대로(09-16 live, 09-18 report)."""
    kia_de_site_pk = 2
    async with staged(Stage(unhide=[21], cycles=[NewCycle(902, date(2026, 9, 16), surface=2, project_key=kia_de_site_pk, copy_from=21)])) as conn:
        cyc = await _get(client_as, KIA_EU, {"surface": "website", "from": "2026-09-14", "to": "2026-09-20"})
        wk = await _get(client_as, KIA_EU, {"surface": "website", "bucket": "week", "from": "2026-09-14", "to": "2026-09-20"})
        l18 = (await scalar_rows(conn, LIVE_URL_SQL, rd=D18, ks=[21]))[0]
        l16 = (await scalar_rows(conn, LIVE_URL_SQL, rd=date(2026, 9, 16), ks=[902]))[0]
    t16, t18 = point(series(cyc, "target_url_rate"), date(2026, 9, 16)), point(series(cyc, "target_url_rate"), D18)
    assert (t16["origin"], t18["origin"]) == ("live", "report") and ratio(t18) == (10, 15)
    tw = point(series(wk, "target_url_rate"), date(2026, 9, 14))
    assert tw["origin"] == "live" and ratio(tw) == (l16["tgt"] + l18["tgt"], l16["den"] + l18["den"]) == (4, 4)


# ── BG 보강 순수 함수(core.measure.split_own_scopes·유형 지표 파싱) ─────────────────
def test_split_own_scopes_pure():
    from app.core.measure import MeasureScope, OwnerScope, split_own_scopes
    owner = OwnerScope(keys=(1, 2), own_bits=(1, 2), countries=None, country_narrowed=False, lang_narrowed=False)
    ms = MeasureScope(sf=1, project_keys=(1,), own_bits=(4, 1, 2), bgrps=(1, 2, 3), pop_bits=(1, 2, 4, 8), owner=owner)
    parts = split_own_scopes(ms)
    assert [b for b, _ in parts] == [1, 2, 4]                                  # 비트 오름차순(Hyundai·Kia·Genesis)
    for b, s in parts:
        assert s.own_bits == (b,) and s.owner is None                        # 인용 계열 자사 배열은 비운다(언급 계열 전용)
        assert (s.bgrps, s.pop_bits, s.project_keys) == (ms.bgrps, ms.pop_bits, ms.project_keys)   # 모수는 관점 전체 그대로
    assert split_own_scopes(MeasureScope(sf=1, project_keys=(1,), own_bits=(1,), bgrps=(1,))) == ()


def test_parse_metrics_type_dimension():
    assert [m.code for m in service.parse_metrics([], "global", "type")] == ["M08"]
    assert [m.code for m in service.parse_metrics(["m08", "type_exposure"], "project", "type")] == ["M08"]
