"""analytics.trend.series 값 갭 보강(BG-01·07·09·10·11·48, D13 split_own) 테스트.

기대값은 구현 빌더와 다른 경로로 센다: 준비 트랜잭션 안에서 드라이버 직접(tests.support.raw_fetch, $n 위치 인자) 독립 SQL 로
비트 식을 직접 쓰거나 손 계산 상수와 대조한다. 픽스처 밖 상태(언어·유형·부정·측정 시각)는 staged(롤백 전용)로 만든다.

픽스처 손 계산(글로벌 회차 11 = 2026-09-14, 현대 관점 bgrp & (1|8) <> 0, 기본 엔진)
  std 답변 k1(chatgpt·US·en)·k2(gemini·US·en)·k12(chatgpt·US·en). 당사 answer_brand 행: k1 Hyundai(t_mention 4), k12 Hyundai(t_mention 1).
  측정 시각(UTC): k1 01:00, k2 02:00, k4·k9 01:00·05:00, k12 03:20 → 모두 KST 09-14. 회차 10(09-07): k16 09-07, k17·k18 09-21.
"""
from __future__ import annotations

import contextlib
import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime
from typing import Any

import pytest
from sqlalchemy import event
from sqlalchemy.engine import Engine

from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, VENDOR, Sql, SqlFile, Update, needs_db, raw_fetch, staged

pytestmark = needs_db
D07, D14 = date(2026, 9, 7), date(2026, 9, 14)


def masks(bits: int) -> list[int]:
    return [m for m in range(1, 32) if m & bits]


async def get(client_as, uid, params, status=200) -> dict:
    async with client_as(uid) as c:
        r = await c.get("/v1/trend", params=params)
    assert r.status_code == status, r.text
    return r.json()


def series(body: dict, metric: str, key: str | None = None) -> dict:
    for s in body["data"]["series"]:
        if s["metric"] == metric and s["key"] == key:
            return s
    raise AssertionError(f"계열 없음 {metric} {key}")


def point(s: dict, d: date) -> dict:
    return next(p for p in s["points"] if p["bucket"] == d.isoformat())


def ratio(p: dict) -> tuple[int, int] | None:
    return (p["ratio"]["num"], p["ratio"]["den"]) if p["ratio"] else None


async def cyc(conn, d: date) -> list[int]:
    return [r["cyc_key"] for r in await raw_fetch(conn, "SELECT cyc_key FROM rd.cycle WHERE surface = 1 AND round_date = $1", d)]


async def cyc_of(conn, surface: int, d: date) -> list[int]:
    return [r["cyc_key"] for r in await raw_fetch(conn, "SELECT cyc_key FROM rd.cycle WHERE surface = $1 AND round_date = $2", surface, d)]


async def key_of(conn, sql: str, *args) -> int:
    return int((await raw_fetch(conn, sql, *args))[0]["k"])


# 현대 관점 글로벌 한 회차(언어 조건 선택). 구현은 core 빌더(bgrp = ANY·FILTER), 여기는 비트 식·조인을 직접 쓴다
ROUND_BY_LANG = """
SELECT count(*) FILTER (WHERE a.std_in) AS n, count(*) FILTER (WHERE a.std_in AND a.own_mask & 1 = 1) AS vis,
       coalesce(sum(a.ment_h) FILTER (WHERE a.std_in), 0) AS om, coalesce(sum(a.ment_total) FILTER (WHERE a.std_in), 0) AS tm
  FROM rd.answer a JOIN rd.dim_lang l ON l.lang_key = a.lang_key
 WHERE a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2::int4[]) AND a.bgrp = ANY($3::int2[]) AND a.dflt AND a.cit_in
   AND ($4::text IS NULL OR l.code = $4)
"""
# M05 분자 = 출처 카테고리 Official (HMG) 원소(동기화 S1 BE-4). 언어 축은 모수만 좁힌다($4 는 원소 언어)
CIT_BY_LANG = """
SELECT count(*) AS n, count(*) FILTER (WHERE cc.name = 'Official (HMG)') AS own
  FROM rd.citation c JOIN rd.dim_lang l ON l.lang_key = c.lang_key
  JOIN rd.dim_source s ON s.source_key = c.source_key JOIN app.citation_category cc ON cc.category_key = s.category_key
 WHERE c.surface = 1 AND c.round_date = $1 AND c.cyc_key = ANY($2::int4[]) AND c.bgrp = ANY($3::int2[]) AND c.dflt AND c.cit_in
   AND c.source_key <> 0 AND l.code = $4
"""


def to_ko(ko: int) -> list[Update]:
    """k12(글로벌 회차 11)를 한국어 답변으로 바꾼다(답변·당사 answer_brand 행 모두, 필터 축 사본 일치)."""
    w = {"surface": 1, "round_date": D14, "answer_key": 12}
    return [Update("rd.answer", w, {"lang_key": ko}), Update("rd.answer_brand", w, {"lang_key": ko})]


# ── BG-01: 글로벌 lang[] 적용 ───────────────────────────────────────────────────
async def test_bg01_global_lang_applies_to_values(client_as):
    async with staged() as probe:
        ko = await key_of(probe, "SELECT lang_key AS k FROM rd.dim_lang WHERE code = 'ko'")
    async with staged(*to_ko(ko)) as conn:
        en = await get(client_as, HQ_HYUNDAI, {"surface": "global", "lang": "en"})
        kor = await get(client_as, HQ_HYUNDAI, {"surface": "global", "lang": "ko"})
        both = await get(client_as, HQ_HYUNDAI, {"surface": "global"})
        bad = await get(client_as, HQ_HYUNDAI, {"surface": "global", "lang": "xx"})
        ks = await cyc(conn, D14)
        e_en = (await raw_fetch(conn, ROUND_BY_LANG, D14, ks, masks(9), "en"))[0]
        e_ko = (await raw_fetch(conn, ROUND_BY_LANG, D14, ks, masks(9), "ko"))[0]
        e_all = (await raw_fetch(conn, ROUND_BY_LANG, D14, ks, masks(9), None))[0]
        c_en = (await raw_fetch(conn, CIT_BY_LANG, D14, ks, masks(9), "en"))[0]
    assert en["meta"]["ignored_filters"] == [] and en["meta"]["dropped_filters"] == {}
    assert ratio(point(series(en, "visibility"), D14)) == (e_en["vis"], e_en["n"]) == (1, 2)          # k1·k2
    assert ratio(point(series(en, "share_of_voice"), D14)) == (e_en["om"], e_en["tm"]) == (4, 10)
    assert ratio(point(series(kor, "visibility"), D14)) == (e_ko["vis"], e_ko["n"]) == (1, 1)         # k12 만
    assert ratio(point(series(kor, "share_of_voice"), D14)) == (e_ko["om"], e_ko["tm"]) == (1, 1)
    assert ratio(point(series(both, "visibility"), D14)) == (e_all["vis"], e_all["n"]) == (2, 3)      # 축 없으면 전체
    # 글로벌 M05 + 언어: 원소 스캔(core scan 경로), 분자 = 공식(HMG) 카테고리 원소
    assert ratio(point(series(en, "citation_share"), D14)) == (c_en["own"], c_en["n"]) == (4, 9)
    p = point(series(kor, "citation_share"), D14)
    assert not p["gap"] and p["ratio"] is None                                                       # ko 답변 인용 0 → 분모 0
    assert bad["meta"]["dropped_filters"] == {"lang": ["xx"]}                                        # 모르는 언어: 버림, 빈 집합
    assert all(p["gap"] and p["gap_reason"] == "no_answer" for s in bad["data"]["series"] for p in s["points"])


# ── BG-07: dimension=type ─────────────────────────────────────────────────────
TYPE_SQL = """
SELECT count(DISTINCT b.answer_key) FILTER (WHERE b.t_mention > 0) AS mention,
       count(DISTINCT b.answer_key) FILTER (WHERE b.t_recommendation > 0) AS recommendation,
       count(DISTINCT b.answer_key) FILTER (WHERE b.t_comparison > 0) AS comparison,
       count(DISTINCT b.answer_key) FILTER (WHERE b.t_definition > 0) AS definition,
       count(DISTINCT b.answer_key) FILTER (WHERE b.t_final_choice > 0) AS final_choice
  FROM rd.answer_brand b
 WHERE b.surface = 1 AND b.round_date = $1 AND b.cyc_key = ANY($2::int4[]) AND b.bgrp = ANY($3::int2[]) AND b.dflt
   AND b.std_in AND b.competitive AND b.own_bit = 1 AND ($4::text IS NULL OR b.geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = $4))
"""
TYPES = ("mention", "recommendation", "comparison", "definition", "final_choice")


SET_TYPE = """UPDATE rd.answer_brand SET {col} = $1
 WHERE surface = 1 AND round_date = $2 AND answer_key = $3 AND brand_key = (SELECT brand_key FROM rd.dim_brand_name WHERE name = $4)"""


def typed() -> list[Sql]:
    """k1 현대 행에 추천 2, k12 현대 행에 비교 1(유형 신호). 경쟁 Toyota(k1)에는 추천 5(당사 유형에 섞이면 안 된다)."""
    return [Sql(SET_TYPE.format(col="t_recommendation"), (2, D14, 1, "Hyundai")),
            Sql(SET_TYPE.format(col="t_comparison"), (1, D14, 12, "Hyundai")),
            Sql(SET_TYPE.format(col="t_recommendation"), (5, D14, 1, "Toyota"))]


async def test_bg07_dimension_type_values_and_card_parity(client_as):
    async with staged(*typed()) as conn:
        b = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "type"})
        mon = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "type", "bucket": "month", "metrics": "M08"})
        async with client_as(HQ_HYUNDAI) as c:
            card = (await c.get("/v1/mentions/types", params={"surface": "global"})).json()
        e = (await raw_fetch(conn, TYPE_SQL, D14, await cyc(conn, D14), masks(9), None))[0]
    ss = b["data"]["series"]
    assert [(s["metric"], s["code"], s["key"]) for s in ss] == [("type_exposure", "M08", t) for t in TYPES]
    got = {s["key"]: ratio(point(s, D14)) for s in ss}
    assert got == {t: (e[t], 3) for t in TYPES} == {"mention": (2, 3), "recommendation": (1, 3), "comparison": (1, 3),
                                                     "definition": (0, 3), "final_choice": (0, 3)}
    # 스냅샷 카드(M-2 own_answers)와 같은 술어: 스냅샷 회차 버킷 = 카드
    assert {r["type"]: r["own_answers"] for r in card["data"]["by_type"]} == {t: got[t][0] for t in TYPES}
    for s in ss:                                       # 회차 10 은 언급 모수 0(분석 결손)
        p = point(s, D07)
        assert p["gap"] and p["gap_reason"] == "analysis_pending" and p["negative"] is None
    assert [x["key"] for x in mon["data"]["buckets"]] == ["2026-09-01"]
    assert {s["key"]: ratio(s["points"][0]) for s in mon["data"]["series"]} == got     # 월 = 회차 버킷 합(09-07 은 0/0)


async def test_bg07_type_filters_scope_and_invalid(client_as):
    async with staged(*typed()) as conn:
        gem = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "type", "engine": "gemini"})
        kia = await get(client_as, KIA_US, {"surface": "global", "dimension": "type"})
        e_kia = await raw_fetch(conn, TYPE_SQL.replace("b.own_bit = 1", "b.own_bit = 2"), D14, await cyc(conn, D14), masks(10), "US")
        n_kia = await raw_fetch(conn, """SELECT count(*) FILTER (WHERE std_in) AS n FROM rd.answer
                                          WHERE surface = 1 AND round_date = $1 AND cyc_key = ANY($2::int4[]) AND bgrp = ANY($3::int2[])
                                            AND dflt AND cit_in AND geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = 'US')""",
                                 D14, await cyc(conn, D14), masks(10))
    # gemini: k2 만(당사 현대 행 없음) → 분자 0, 분모 1
    assert {s["key"]: ratio(point(s, D14)) for s in gem["data"]["series"]} == {t: (0, 1) for t in TYPES}
    # KIA_US(스코프 = 기아·US): 기아 당사 행·US 답변만
    assert {s["key"]: ratio(point(s, D14)) for s in kia["data"]["series"]} == {t: (e_kia[0][t], n_kia[0]["n"]) for t in TYPES}
    assert kia["data"]["own_label"] == "Kia"
    for params in ({"metrics": "M01"}, {"metrics": "type_exposure,sov"}):
        r = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "type", **params}, status=422)
        assert r["error"]["code"] == "metric_not_supported"
    ok = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "type", "metrics": "type_exposure"})
    assert len(ok["data"]["series"]) == 5
    src = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "type", "source": "officialHmg"})
    assert src["meta"]["ignored_filters"] == ["source"]                     # 인용 출처 축은 유형 계열에 적용 대상이 아니다
    empty = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "type", "from": "2020-01-01", "to": "2020-01-31"})
    assert empty["data"]["series"] == [] and empty["data"]["buckets"] == []


# ── BG-09: 부정 신호 ─────────────────────────────────────────────────────────
NEG_SQL = """
SELECT coalesce(sum(a.sent_neg_h) FILTER (WHERE a.std_in), 0) AS neg, coalesce(sum(a.sent_all_h) FILTER (WHERE a.std_in), 0) AS sa,
       coalesce(sum(a.sent_pos_h) FILTER (WHERE a.std_in), 0) AS sp
  FROM rd.answer a
 WHERE a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2::int4[]) AND a.bgrp = ANY($3::int2[]) AND a.dflt AND a.cit_in
   AND ($4::text IS NULL OR a.engine_key = (SELECT engine_key FROM rd.dim_engine WHERE code = $4))
"""


async def test_bg09_negative_on_sentiment_points(client_as):
    neg = Update("rd.answer", {"surface": 1, "round_date": D14, "answer_key": 1}, {"sent_neg_h": 1})
    async with staged(neg) as conn:
        b = await get(client_as, HQ_HYUNDAI, {"surface": "global"})
        eng = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "engine", "metrics": "M03"})
        br = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "brand", "metrics": "M03,M01"})
        ks = await cyc(conn, D14)
        e = (await raw_fetch(conn, NEG_SQL, D14, ks, masks(9), None))[0]
        eg = {x: (await raw_fetch(conn, NEG_SQL, D14, ks, masks(9), x))[0] for x in ("chatgpt", "gemini")}
        toyota = (await raw_fetch(conn, """SELECT sum(b.s_neg) AS neg FROM rd.answer_brand b
                                             WHERE b.surface = 1 AND b.round_date = $1 AND b.cyc_key = ANY($2::int4[])
                                               AND b.bgrp = ANY($3::int2[]) AND b.dflt AND b.std_in AND b.competitive
                                               AND b.brand_key = (SELECT brand_key FROM rd.dim_brand_name WHERE name = 'Toyota')""",
                                  D14, ks, masks(9)))[0]
    p = point(series(b, "sentiment"), D14)
    assert ratio(p) == (e["sp"], e["sa"]) == (4, 5) and p["negative"] == e["neg"] == 1
    assert point(series(b, "visibility"), D14)["negative"] is None                  # M03 밖 계열은 null
    assert point(series(b, "sentiment"), D07)["negative"] is None                   # 갭 지점은 null
    for x in ("chatgpt", "gemini"):
        assert point(series(eng, "sentiment", x), D14)["negative"] == eg[x]["neg"]
    assert (eg["chatgpt"]["neg"], eg["gemini"]["neg"]) == (1, 0)
    assert point(series(br, "sentiment", "own"), D14)["negative"] == 1
    assert point(series(br, "sentiment", "Toyota"), D14)["negative"] == toyota["neg"] == 1
    assert point(series(br, "visibility", "Toyota"), D14)["negative"] is None


# ── BG-10: 버킷 측정 일수(KST) ────────────────────────────────────────────────
DAYS_SQL = """
SELECT count(DISTINCT (j.measured_at AT TIME ZONE 'Asia/Seoul')::date) AS d
  FROM rd.job j
 WHERE j.served AND j.surface = 1 AND j.round_date BETWEEN $1::date AND $6::date
   AND j.answer_key IN (SELECT a.answer_key FROM rd.answer a
                         WHERE a.surface = 1 AND a.round_date BETWEEN $1::date AND $6::date AND a.cyc_key = ANY($2::int4[]) AND a.cit_in AND a.dflt
                           AND a.bgrp = ANY($3::int2[])
                           AND ($4::text IS NULL OR a.engine_key = (SELECT engine_key FROM rd.dim_engine WHERE code = $4))
                           AND ($5::text IS NULL OR a.geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = $5)))
"""


async def test_bg10_measured_days_kst(client_as):
    # k12 측정 시각을 09-14 16:00Z(= KST 09-15 01:00)로: UTC 날짜로 세면 1일, KST 로 세면 2일
    shift = Update("rd.job", {"answer_key": 12}, {"measured_at": datetime(2026, 9, 14, 16, 0, tzinfo=UTC)})
    async with staged(shift) as conn:
        b = await get(client_as, HQ_HYUNDAI, {"surface": "global"})
        br = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "brand"})
        mon = await get(client_as, HQ_HYUNDAI, {"surface": "global", "bucket": "month"})
        gem = await get(client_as, HQ_HYUNDAI, {"surface": "global", "engine": "gemini"})
        kia = await get(client_as, KIA_US, {"surface": "global"})
        k14, k07 = await cyc(conn, D14), await cyc(conn, D07)

        async def days(ds, ks, m, eng=None, geo=None):
            return (await raw_fetch(conn, DAYS_SQL, min(ds), ks, m, eng, geo, max(ds)))[0]["d"]
        e14, e07 = await days([D14], k14, masks(9)), await days([D07], k07, masks(9))
        emon = await days([D07, D14], k07 + k14, masks(9))
        g14, g07 = await days([D14], k14, masks(9), "gemini"), await days([D07], k07, masks(9), "gemini")
        kus = await days([D14], k14, masks(10), None, "US")
    got = {x["key"]: x["measured_days"] for x in b["data"]["buckets"]}
    assert got == {D07.isoformat(): e07, D14.isoformat(): e14} == {D07.isoformat(): 2, D14.isoformat(): 2}
    assert {x["key"]: x["measured_days"] for x in br["data"]["buckets"]} == got                 # 차원과 무관한 버킷 속성
    assert mon["data"]["buckets"][0]["measured_days"] == emon == 4                             # 09-07·09-14·09-15·09-21 고유
    assert {x["key"]: x["measured_days"] for x in gem["data"]["buckets"]} == {D07.isoformat(): g07, D14.isoformat(): g14} \
        == {D07.isoformat(): 1, D14.isoformat(): 1}
    assert {x["key"]: x["measured_days"] for x in kia["data"]["buckets"]}[D14.isoformat()] == kus == 1   # 스코프(기아·US) 밖 답변 제외


async def test_bg10_empty_and_hidden(client_as):
    b = await get(client_as, HQ_HYUNDAI, {"surface": "global", "from": "2020-01-01", "to": "2020-01-31"})
    assert b["data"]["buckets"] == []
    async with staged(Update("rd.cycle", {"cyc_key": 11}, {"hidden_scope": 1, "hidden_reason": 1})):
        h = await get(client_as, HQ_HYUNDAI, {"surface": "global"})
    d14 = next(x for x in h["data"]["buckets"] if x["key"] == D14.isoformat())
    assert d14["measured_days"] == 0                                                            # 수집 오류 갭 자리: 답변 없음


# ── BG-11: brand_key[] ────────────────────────────────────────────────────────
COMP_SQL = """
SELECT n.name, sum(b.mention_count) AS m, count(*) AS vis
  FROM rd.answer_brand b JOIN rd.dim_brand_name n USING (brand_key)
 WHERE b.surface = 1 AND b.round_date = $1 AND b.cyc_key = ANY($2::int4[]) AND b.bgrp = ANY($3::int2[])
   AND b.dflt AND b.std_in AND b.competitive AND b.brand_key = $4
 GROUP BY n.name
"""


async def test_bg11_brand_keys_beyond_top(client_as):
    async with staged() as conn:
        smart = await key_of(conn, "SELECT brand_key AS k FROM rd.dim_brand_name WHERE name = 'smart'")
        tesla = await key_of(conn, "SELECT brand_key AS k FROM rd.dim_brand_name WHERE name = 'Tesla'")
        hyundai = await key_of(conn, "SELECT brand_key AS k FROM rd.dim_brand_name WHERE name = 'Hyundai'")
        ks = await cyc(conn, D14)
        e_smart = (await raw_fetch(conn, COMP_SQL, D14, ks, masks(9), smart))[0]
        tot = (await raw_fetch(conn, ROUND_BY_LANG, D14, ks, masks(9), None))[0]
        top1 = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "brand", "top": 1, "metrics": "M02,M01"})
        b = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "brand", "top": 1, "metrics": "M02,M01",
                                              "brand_key": [str(tesla), str(smart), str(hyundai), "999999"]})
    assert [s["key"] for s in top1["data"]["series"] if s["metric"] == "share_of_voice"] == ["own", "Toyota"]
    keys = [(s["key"], s["brand_key"]) for s in b["data"]["series"] if s["metric"] == "share_of_voice"]
    assert keys[0] == ("own", None) and keys[1][0] == "Toyota"
    assert keys[2:] == [("smart", smart), ("Tesla", tesla)]            # 창에 행 있는 요청 브랜드(순위순) 뒤에 행 없는 요청 브랜드
    assert ratio(point(series(b, "share_of_voice", "smart"), D14)) == (e_smart["m"], tot["tm"]) == (1, 11)
    assert ratio(point(series(b, "visibility", "smart"), D14)) == (e_smart["vis"], tot["n"]) == (1, 3)
    assert ratio(point(series(b, "share_of_voice", "Tesla"), D14)) == (0, tot["tm"])          # 창에 언급 없음 = 0 지점
    assert point(series(b, "share_of_voice", "Tesla"), D07)["gap_reason"] == "analysis_pending"
    assert b["meta"]["dropped_filters"] == {"brand_key": [str(hyundai), "999999"]}           # 관점 브랜드·모르는 키
    # 상위에 이미 든 키는 중복 계열을 만들지 않는다
    dup = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "brand", "top": 3, "brand_key": str(smart)})
    assert [s["key"] for s in dup["data"]["series"]].count("smart") == 1


@pytest.mark.parametrize("params", [
    {"dimension": "none", "brand_key": "5"},
    {"dimension": "engine", "split_own": "true"},
    {"dimension": "brand", "brand_key": "0"},
    {"dimension": "brand", "brand_key": "abc"},
    {"dimension": "brand", "brand_key": str(2**31)},
    {"dimension": "brand", "split_own": "maybe"},
])
async def test_brand_params_invalid_422(client_as, params):
    r = await get(client_as, HQ_HYUNDAI, {"surface": "global", **params}, status=422)
    assert r["error"]["code"] == "unprocessable"


# ── D13 split_own ────────────────────────────────────────────────────────────
OWN_BIT_SQL = """
SELECT count(*) FILTER (WHERE a.std_in) AS n,
       count(*) FILTER (WHERE a.std_in AND a.own_mask & 1 = 1) AS vh, count(*) FILTER (WHERE a.std_in AND a.own_mask & 2 = 2) AS vk,
       count(*) FILTER (WHERE a.std_in AND a.own_mask & 4 = 4) AS vg,
       coalesce(sum(a.ment_h) FILTER (WHERE a.std_in), 0) AS mh, coalesce(sum(a.ment_k) FILTER (WHERE a.std_in), 0) AS mk,
       coalesce(sum(a.ment_g) FILTER (WHERE a.std_in), 0) AS mg, coalesce(sum(a.ment_total) FILTER (WHERE a.std_in), 0) AS tm,
       coalesce(sum(a.sent_pos_k) FILTER (WHERE a.std_in), 0) AS pk, coalesce(sum(a.sent_all_k) FILTER (WHERE a.std_in), 0) AS ak
  FROM rd.answer a
 WHERE a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2::int4[]) AND a.bgrp = ANY($3::int2[]) AND a.dflt AND a.cit_in
"""


async def test_d13_split_own_per_viewpoint_brand(client_as):
    async with staged() as conn:
        e = (await raw_fetch(conn, OWN_BIT_SQL, D14, await cyc(conn, D14), masks(15)))[0]
        kia = await key_of(conn, "SELECT brand_key AS k FROM rd.dim_brand_name WHERE name = 'Kia'")
        split = await get(client_as, ADMIN, {"surface": "global", "dimension": "brand", "metrics": "M01,M02,M03",
                                             "split_own": "true", "brand_key": str(kia)})
        merged = await get(client_as, ADMIN, {"surface": "global", "dimension": "brand", "metrics": "M01,M02"})
    own = [s for s in split["data"]["series"] if s["is_own"] and s["metric"] == "visibility"]
    assert [(s["key"], s["own_brand_code"], s["label"]) for s in own] == [("Hyundai", "Hyundai", "Hyundai"), ("Kia", "Kia", "Kia"),
                                                                           ("Genesis", "Genesis", "Genesis")]
    assert split["data"]["own_label"] == "HMG"
    for code, v, m in (("Hyundai", "vh", "mh"), ("Kia", "vk", "mk"), ("Genesis", "vg", "mg")):
        assert ratio(point(series(split, "visibility", code), D14)) == (e[v], e["n"])
        assert ratio(point(series(split, "share_of_voice", code), D14)) == (e[m], e["tm"])
    assert (e["vh"], e["vk"], e["vg"], e["n"], e["mh"], e["mk"], e["tm"]) == (2, 1, 0, 3, 5, 2, 11)
    assert ratio(point(series(split, "sentiment", "Kia"), D14)) == (e["pk"], e["ak"]) == (1, 2)
    assert all(point(s, D07)["gap_reason"] == "analysis_pending" for s in own)         # 갭 판정은 관점 전체와 같다
    assert split["meta"]["dropped_filters"] == {"brand_key": [str(kia)]}                # 관점 브랜드(기아)는 경쟁 계열로 못 더한다
    comp = [s["key"] for s in split["data"]["series"] if not s["is_own"] and s["metric"] == "visibility"]
    assert "Kia" not in comp and "Hyundai" not in comp
    # 기본값(split_own 없음)은 기존 합친 1행, 합친 값 = 관점 전체
    m_own = [s for s in merged["data"]["series"] if s["is_own"]]
    assert [(s["key"], s["own_brand_code"]) for s in m_own] == [("own", None), ("own", None)]
    assert ratio(point(series(merged, "visibility", "own"), D14))[1] == e["n"]


async def test_d13_split_own_single_viewpoint_unchanged(client_as):
    a = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "brand", "split_own": "true"})
    b = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "brand"})
    assert a["data"] == b["data"]                                                       # 관점 하나 = 분리 없음
    k = await get(client_as, KIA_US, {"surface": "global", "dimension": "brand", "split_own": "true"})
    assert [s["key"] for s in k["data"]["series"] if s["is_own"]] == ["own"]


# ── BG-48: 당사 라벨 = mentions/brands own.vp_label ────────────────────────────
@pytest.mark.parametrize("uid,params", [
    (ADMIN, {}), (ADMIN, {"brand": ["Hyundai", "Kia"]}), (ADMIN, {"brand": "Genesis"}), (HQ_HYUNDAI, {}), (KIA_US, {}),
])
async def test_bg48_own_label_matches_brands_vp_label(client_as, uid, params):
    q = {"surface": "global", **params}
    t = await get(client_as, uid, {**q, "dimension": "brand"})
    async with client_as(uid) as c:
        m = (await c.get("/v1/mentions/brands", params=q)).json()
    own = next(s for s in t["data"]["series"] if s["is_own"])
    assert t["data"]["own_label"] == own["label"] == m["data"]["own"]["vp_label"]
    if params.get("brand") == ["Hyundai", "Kia"]:
        assert t["data"]["own_label"] == "HMG"                                           # 이전 규칙은 'Hyundai, Kia'


# ── 웹사이트·프로젝트 표면(유형·측정 일수) ────────────────────────────────────────
async def test_bg07_bg10_other_surfaces(client_as):
    d20, d18 = date(2026, 9, 20), date(2026, 9, 18)
    async with staged() as conn:
        pj = await get(client_as, VENDOR, {"surface": "project", "project_id": str(CUST_PROJECT), "dimension": "type"})
        pv = await get(client_as, VENDOR, {"surface": "project", "project_id": str(CUST_PROJECT), "metrics": "M01"})
        web = await get(client_as, KIA_EU, {"surface": "website"})
        e_pj = (await raw_fetch(conn, """SELECT count(DISTINCT (j.measured_at AT TIME ZONE 'Asia/Seoul')::date) AS d
                                           FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key
                                          WHERE a.surface = 3 AND a.round_date = $1 AND a.cit_in AND a.dflt AND j.served
                                            AND a.cyc_key = ANY($2::int4[])""", d20, await cyc_of(conn, 3, d20)))[0]
        e_web = (await raw_fetch(conn, """SELECT count(DISTINCT (j.measured_at AT TIME ZONE 'Asia/Seoul')::date) AS d
                                            FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key
                                           WHERE a.surface = 2 AND a.round_date = $1 AND a.cit_in AND a.dflt AND a.bgrp = 2 AND j.served
                                             AND a.cyc_key = ANY($2::int4[])""", d18, await cyc_of(conn, 2, d18)))[0]
    den = ratio(point(series(pv, "visibility"), d20))[1]
    assert [s["key"] for s in pj["data"]["series"]] == list(TYPES)
    assert all(ratio(point(s, d20))[1] == den for s in pj["data"]["series"])          # 분모 = M01 분모(버킷 답변)
    assert pj["data"]["buckets"][0]["measured_days"] == e_pj["d"] >= 1
    assert web["data"]["buckets"][0]["measured_days"] == e_web["d"] >= 1



async def test_a1_measured_days_opt_out(client_as, monkeypatch):
    """성능 A1(core 10, 추가형 쿼리 measured_days): 기본(생략·true) = 종전과 같은 계산, false = 계산 문장을 건너뛰고 모든 버킷 null.
    나머지 응답(버킷 키·회차·계열·meta)은 같다."""
    from app.features.analytics.trend.series import service as trend_service

    base = await get(client_as, HQ_HYUNDAI, {"surface": "global"})
    on = await get(client_as, HQ_HYUNDAI, {"surface": "global", "measured_days": "true"})
    assert on == base and all(isinstance(x["measured_days"], int) for x in base["data"]["buckets"])

    async def boom(*_a, **_k):
        raise AssertionError("measured_days=false 인데 계산 문장을 돌렸다")
    monkeypatch.setattr(trend_service, "measured_days", boom)
    off = await get(client_as, HQ_HYUNDAI, {"surface": "global", "measured_days": "false"})
    assert off["data"]["buckets"] and all(x["measured_days"] is None for x in off["data"]["buckets"])
    strip = [{k: v for k, v in x.items() if k != "measured_days"} for x in base["data"]["buckets"]]
    assert [{k: v for k, v in x.items() if k != "measured_days"} for x in off["data"]["buckets"]] == strip
    assert off["data"]["series"] == base["data"]["series"] and off["meta"] == base["meta"]
    br = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "brand", "measured_days": "false"})
    assert all(x["measured_days"] is None for x in br["data"]["buckets"])


# ── P12 성능(기본 응답 불변): 새 경로 응답 = 종전 조합 응답(바이트), 문장 수 감소 ─────────────────────────
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


async def p12_pair(client_as, monkeypatch, uid, params: dict[str, Any], patches) -> tuple[dict, int, int]:
    """(새 응답 JSON, 새 문장 수, 종전 문장 수). 종전 = patches(모듈, 이름, 종전 함수)를 끼운 같은 요청. 응답 바이트가 같아야 한다."""
    async with client_as(uid) as c:
        with recorded() as s_new:
            new = await c.get("/v1/trend", params=params)
        with monkeypatch.context() as m:
            for mod, name, fn in patches:
                m.setattr(mod, name, fn)
            with recorded() as s_old:
                old = await c.get("/v1/trend", params=params)
    assert new.status_code == 200, (params, new.text)
    assert old.status_code == 200, (params, old.text)
    assert new.content == old.content, params
    return new.json(), len(s_new), len(s_old)


def b100_patches():
    """B100 이전: base = core fetch_counts(mentions·gap) 문장 + 비트별 합계 = split_counts(A3) 문장, 경쟁 행 = core brand_rows 전부."""
    from app.core.measure import brand_rows, fetch_counts
    from app.features.analytics.trend.series import service as svc

    async def old_split(conn, ms, win, g, bits, mdefs):
        return await fetch_counts(conn, ms, win, group_by=(g,), parts=("mentions", "gap")), await svc.split_counts(conn, ms, win, g, bits)

    async def old_comp(conn, ms, win, g, *, top, want):
        return await brand_rows(conn, ms, win, group_by=(g,))
    return [(svc, "brand_split_counts", old_split), (svc, "competitor_rows", old_comp)]


B = {"surface": "global", "dimension": "brand"}
B100_CASES: list[dict[str, Any]] = [
    {**B, "split_own": "true", "metrics": ["M01", "M02", "M03", "M04"]},
    {**B, "split_own": "true", "metrics": ["M02"]},
    {**B, "split_own": "true", "metrics": ["M01", "M02", "M04"], "top": 1, "card": "true", "measured_days": "false"},
    {**B, "split_own": "true", "bucket": "week", "metrics": ["M03"]},
    {**B, "split_own": "true", "bucket": "month", "brand": ["Hyundai", "Kia"]},
    {**B, "split_own": "true", "engine": "chatgpt", "country": "US"},
    {**B}, {**B, "top": 1}, {**B, "top": 2, "metrics": ["M04"]}, {**B, "top": 3, "metrics": ["M01", "M03"]},
    {**B, "from": "2025-01-01", "to": "2025-01-31"},
]


async def _b100_run(client_as, monkeypatch, extra_keys: list[int]) -> list[tuple[str, dict, int, int]]:
    out = []
    for uid in (ADMIN, HQ_HYUNDAI, KIA_US):
        for params in [*B100_CASES, {**B, "top": 1, "brand_key": [str(k) for k in extra_keys]},
                       {**B, "split_own": "true", "top": 2, "brand_key": [str(k) for k in extra_keys]}]:
            body, n_new, n_old = await p12_pair(client_as, monkeypatch, uid, params, b100_patches())
            out.append((str(uid), params, n_new, n_old))
            split = uid == ADMIN and params.get("split_own") == "true" and body["data"]["buckets"]
            # split: base·비트 합계 한 문장(-1). 후보에 제외 키가 이미 빠져 경쟁 행·요청 키가 없으면 명부 제외 조회도 돌지 않는다(-1 더)
            assert n_new <= n_old - (1 if split else 0), (uid, params, n_new, n_old)
    return out


async def test_p12_b100_brand_equals_old_composition(client_as, monkeypatch, settings):
    """B100: split_own base·비트별 합계 한 문장(요청 지표 열만) + 경쟁 후보 행만 = 종전 조합(두 문장 + 경쟁 행 전부) 응답 바이트.
    기본 픽스처 · 성능 준비(다회차·인용 숨김·수집 오류 갭) · 명부 제외(Toyota → 다음 순위가 채움) · G20 프로필(노출 단위 열 경로)."""
    from app.core.config import set_settings
    from app.core.measure import brand_rows
    from app.features.analytics.trend.series import service as svc
    from app.features.analytics.trend.series.tests.test_perf_equiv import AUG_LEAF, SEED, _copy

    async with staged() as conn:
        smart = await key_of(conn, "SELECT brand_key AS k FROM rd.dim_brand_name WHERE name = 'smart'")
        tesla = await key_of(conn, "SELECT brand_key AS k FROM rd.dim_brand_name WHERE name = 'Tesla'")
        await _b100_run(client_as, monkeypatch, [smart, tesla])
    async with staged(AUG_LEAF, _copy, SqlFile(SEED)):
        await _b100_run(client_as, monkeypatch, [smart, tesla])
    toyota_excluded = Update("rd.dim_entity", {"entity_id": uuid.UUID("71000000-0000-4000-8000-000000000001")}, {"registry_role": "excluded"})
    async with staged(toyota_excluded):
        await _b100_run(client_as, monkeypatch, [smart])
        b = await get(client_as, HQ_HYUNDAI, {**B, "top": 1})
        assert [s["key"] for s in b["data"]["series"] if s["metric"] == "share_of_voice"] == ["own", "Kia"]   # 제외 뒤 다음 순위
    try:
        set_settings(settings.model_copy(update={"legacy_profile": "brand_exposure_per_alias"}))
        async with staged():
            await _b100_run(client_as, monkeypatch, [smart])
    finally:
        set_settings(settings)
    # 경쟁 행이 실제로 줄어든다(top 1 = 후보 1 브랜드 행만, 종전 = 창의 경쟁 브랜드 행 전부)
    sizes: list[tuple[int, int]] = []
    real = svc.competitor_rows

    async def spy(conn, ms, win, g, *, top, want):
        rows = await real(conn, ms, win, g, top=top, want=want)
        sizes.append((len(rows), len(await brand_rows(conn, ms, win, group_by=(g,)))))
        return rows
    monkeypatch.setattr(svc, "competitor_rows", spy)
    async with staged():
        await get(client_as, HQ_HYUNDAI, {**B, "top": 1})
    assert sizes and all(n < full for n, full in sizes), sizes


def b102_patches():
    """B102 이전: url_rates 가 main 결과를 받지 않고 같은 창 urls 를 다시 센다(live=None)."""
    from app.features.analytics.trend.series import service as svc
    real = svc.url_rates

    async def recount(conn, ms, win, **kw):
        return await real(conn, ms, win, **{**kw, "live": None})
    return [(svc, "url_rates", recount)]


async def test_p12_b102_website_url_rates_reuse_main_counts(client_as, monkeypatch):
    """B102: 웹사이트 M06·M07(R09) bucket=cycle 은 url_rates 가 main 문장 결과(live)를 받아 urls 재집계 문장 1 을 생략. 응답 바이트 = 종전.
    주·월 버킷(접기)·엔진 필터(R09 아님)는 종전 경로 그대로(문장 수 같음)."""
    from app.features.analytics.trend.series import service as svc
    from app.features.analytics.trend.series.tests.staged import Stage
    from app.features.analytics.trend.series.tests.staged import staged as trend_staged

    lives: list[bool] = []
    real = svc.url_rates

    async def spy(conn, ms, win, **kw):
        lives.append(kw.get("live") is not None)
        return await real(conn, ms, win, **kw)
    W = {"surface": "website"}
    cases = [(W, True), ({**W, "metrics": ["M06", "M07", "citation_accuracy"]}, True), ({**W, "metrics": ["M01", "M06"]}, True),
             ({**W, "card": "true", "measured_days": "false", "metrics": ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "ACC"]}, True),
             ({**W, "bucket": "week"}, False), ({**W, "bucket": "month", "metrics": ["M07"]}, False), ({**W, "engine": "gemini"}, False)]
    for unhide in ([21], []):                                   # 21 = 발행(R09 report) 회차, 숨김 그대로면 인용 계열 갭
        async with trend_staged(Stage(unhide=unhide)):
            for params, reuse in cases:
                _, n_new, n_old = await p12_pair(client_as, monkeypatch, KIA_EU, params, b102_patches())
                assert n_new == n_old - (1 if reuse else 0), (unhide, params, n_new, n_old)
                lives.clear()
                with monkeypatch.context() as m:
                    m.setattr(svc, "url_rates", spy)
                    await get(client_as, KIA_EU, params)
                assert lives == ([True] if reuse else ([False] if params.get("bucket") else [])), (params, lives)
        body = await get(client_as, KIA_EU, W)
    assert body["data"]["series"]
