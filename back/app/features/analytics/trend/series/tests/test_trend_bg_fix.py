"""analytics.trend.series 독립 검증(818b56f, conditional) 결함 V1~V4 회귀 테스트.

- V1: split_own 분리 당사 계열에 brand_key(mentions/brands 당사 행과 같은 조회 규칙: 이름 = 관점 brand_code)를 싣는다.
- V2: 창에 competitive 행이 없는 비경쟁 브랜드(kind 3, 픽스처 Apple)를 brand_key[] 로 요청하면 0 계열이 아니라 dropped.
- V3(known_diff 고정): 유형 추이 분자는 M-2 와 같이 competitive 당사 행만 센다(현행 front typeTrend 는 비경쟁 표기 당사 행도 셌다).
- V4(known_diff 고정): measured_days 는 엔진 합집합의 KST 고유 일수다(현행 엔진 추이는 엔진별 고유 일수의 max).
검증 2차(818b56f fail) 추가:
- D1: 하위 브랜드 다중 관점 split 키 = 비트의 부모 코드, core split_own_scopes 는 하나의 정의(mentions 그룹과 공용).
- D3(known_diff 고정): measured_days 는 셀 대표(is_rep)가 아니라 버킷 답변 전부로 센다.
- D5: units T-1·G-1 에 추가 파라미터·필드·422 규칙(D3 셋째 차이 포함)이 실려 있다.
- D2·D4·D6 은 위 V1·V3·V2 가 재현한다. D7(kpi-filters 와 같은 줄 충돌)은 같은 문구로 맞춰 해소(동작 무관, 테스트 없음).
기대값은 구현 빌더와 다른 경로(드라이버 직접 독립 SQL·손 계산 상수)로 센다.
"""
from __future__ import annotations

from datetime import UTC, date, datetime

from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, Update, needs_db, raw_fetch, staged

from .test_trend_bg import D07, TYPE_SQL, TYPES, cyc, get, key_of, masks, point, ratio, series

pytestmark = needs_db
D14 = date(2026, 9, 14)


# ── V1: split_own 분리 당사 계열의 brand_key ──────────────────────────────────────
async def test_v1_split_own_rows_carry_brand_key_matching_mentions(client_as):
    async with staged() as conn:
        names = {r["name"]: int(r["brand_key"]) for r in await raw_fetch(
            conn, "SELECT name, brand_key FROM rd.dim_brand_name WHERE name = ANY($1::text[])", ["Hyundai", "Kia", "Genesis"])}
        split = await get(client_as, ADMIN, {"surface": "global", "dimension": "brand", "metrics": "M01,M02", "split_own": "true"})
        merged = await get(client_as, ADMIN, {"surface": "global", "dimension": "brand", "metrics": "M01"})
        mention_keys: dict[str, int | None] = {}
        for code in ("Hyundai", "Kia", "Genesis"):      # 관점 하나(brand=code)면 mentions/brands 당사 행이 brand_key 를 싣는다
            async with client_as(ADMIN) as c:
                m = (await c.get("/v1/mentions/brands", params={"surface": "global", "brand": code})).json()
            mention_keys[code] = next(i["brand_key"] for i in m["data"]["brands"] if i["is_own"])
    assert names == {"Hyundai": 1, "Kia": 2}                                              # 픽스처: Genesis 는 표시 브랜드 차원에 없다
    for metric in ("visibility", "share_of_voice"):
        own = [(s["key"], s["own_brand_code"], s["brand_key"]) for s in split["data"]["series"] if s["is_own"] and s["metric"] == metric]
        assert own == [("Hyundai", "Hyundai", names["Hyundai"]), ("Kia", "Kia", names["Kia"]), ("Genesis", "Genesis", None)]
    # 두 그룹의 관점 브랜드 행을 같은 키로 잇는다(이름 = brand_code 규칙)
    got = {s["key"]: s["brand_key"] for s in split["data"]["series"] if s["is_own"] and s["metric"] == "visibility"}
    assert got == mention_keys == {"Hyundai": 1, "Kia": 2, "Genesis": None}
    # 합친 'own' 계열은 기존과 같이 null(추가형)
    assert [s["brand_key"] for s in merged["data"]["series"] if s["is_own"]] == [None]


# ── V2: 비경쟁 브랜드 brand_key[] ─────────────────────────────────────────────────
async def test_v2_non_competitor_brand_key_dropped(client_as):
    async with staged() as conn:
        apple = await key_of(conn, "SELECT brand_key AS k FROM rd.dim_brand_name WHERE name = 'Apple' AND kind = 3")
        smart = await key_of(conn, "SELECT brand_key AS k FROM rd.dim_brand_name WHERE name = 'smart' AND kind = 3")
        tesla = await key_of(conn, "SELECT brand_key AS k FROM rd.dim_brand_name WHERE name = 'Tesla' AND kind = 2")
        comp = {r["brand_key"]: r["n"] for r in await raw_fetch(
            conn, """SELECT brand_key, count(*) FILTER (WHERE competitive) AS n FROM rd.answer_brand
                      WHERE surface = 1 AND round_date = $2 AND cyc_key = ANY($3::int4[]) AND brand_key = ANY($1::int4[])
                      GROUP BY 1""", [apple, smart], D14, await cyc(conn, D14))}
        kus = await get(client_as, KIA_US, {"surface": "global", "dimension": "brand", "brand_key": str(apple)})
        hq = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "brand", "top": 1,
                                               "brand_key": [str(apple), str(smart), str(tesla)]})
    assert comp == {apple: 0, smart: 1}                   # Apple = competitive 행 없음(비경쟁), smart = 비경쟁 표기지만 competitive 행 있음
    # 검증 재현: KIA_US + Apple → 0 지점 Apple 계열이 섞이던 것을 dropped 로
    assert kus["meta"]["dropped_filters"] == {"brand_key": [str(apple)]}
    assert all(s["key"] != "Apple" for s in kus["data"]["series"])
    # competitive 행이 창에 있는 비경쟁 표기 브랜드(smart)는 경쟁 목록에 나오므로 계열로 남고, 행 없는 경쟁 브랜드(Tesla)는 0 계열(기존 규칙)
    keys = [s["key"] for s in hq["data"]["series"] if s["metric"] == "share_of_voice"]
    assert "Apple" not in keys and "smart" in keys and "Tesla" in keys
    assert hq["meta"]["dropped_filters"] == {"brand_key": [str(apple)]}


# ── V3: 유형 추이 분자 = competitive 당사 행(M-2 와 같은 술어, known_diff) ─────────────────
async def test_v3_type_counts_competitive_own_rows_only(client_as):
    # k12 현대 당사 행(t_mention 1)에 비교 신호를 주고 competitive=false 로 둔다: 현행 front typeTrend 는 이 답변을 셌고 API 는 세지 않는다
    step = Update("rd.answer_brand", {"surface": 1, "round_date": D14, "answer_key": 12, "brand_key": 1},
                  {"t_comparison": 1, "competitive": False, "rk": 0})
    async with staged(step) as conn:
        b = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "type"})
        async with client_as(HQ_HYUNDAI) as c:
            card = (await c.get("/v1/mentions/types", params={"surface": "global"})).json()
        ks = await cyc(conn, D14)
        e = (await raw_fetch(conn, TYPE_SQL, D14, ks, masks(9), None))[0]
        # 현행 front 규칙(competitive 무시)으로 센 값: 차이가 실제로 생기는 상태인지 확인
        loose = (await raw_fetch(conn, TYPE_SQL.replace("AND b.competitive ", ""), D14, ks, masks(9), None))[0]
    got = {s["key"]: ratio(point(s, D14))[0] for s in b["data"]["series"]}
    assert got == {t: e[t] for t in TYPES}
    assert (got["mention"], got["comparison"]) == (1, 0) and (loose["mention"], loose["comparison"]) == (2, 1)
    assert {r["type"]: r["own_answers"] for r in card["data"]["by_type"]} == got        # M-2 카드와 같은 술어(F08·F10 대조 기준)


# ── V4: measured_days = 엔진 합집합 KST 고유 일수(known_diff) ─────────────────────────
PER_ENGINE_DAYS = """
SELECT e.code, count(DISTINCT (j.measured_at AT TIME ZONE 'Asia/Seoul')::date) AS d
  FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key AND j.surface = a.surface AND j.round_date = a.round_date
  JOIN rd.dim_engine e ON e.engine_key = a.engine_key
 WHERE a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2::int4[]) AND a.bgrp = ANY($3::int2[]) AND a.dflt AND a.cit_in AND j.served
 GROUP BY 1
"""


async def test_v4_measured_days_engine_union_not_max(client_as):
    # k2(gemini) 를 09-14 16:30Z(= KST 09-15)로: chatgpt 는 09-14 하루, gemini 는 09-15 하루(엔진별 max = 1, 합집합 = 2)
    shift = Update("rd.job", {"answer_key": 2}, {"measured_at": datetime(2026, 9, 14, 16, 30, tzinfo=UTC)})
    async with staged(shift) as conn:
        none = await get(client_as, HQ_HYUNDAI, {"surface": "global"})
        eng = await get(client_as, HQ_HYUNDAI, {"surface": "global", "dimension": "engine"})
        per = {r["code"]: r["d"] for r in await raw_fetch(conn, PER_ENGINE_DAYS, D14, await cyc(conn, D14), masks(9))}
    d14 = D14.isoformat()
    assert per == {"chatgpt": 1, "gemini": 1}
    assert {x["key"]: x["measured_days"] for x in none["data"]["buckets"]}[d14] == 2 != max(per.values())
    assert {x["key"]: x["measured_days"] for x in eng["data"]["buckets"]}[d14] == 2          # 차원과 무관한 버킷 속성
    assert point(series(eng, "visibility", "gemini"), D14)["gap"] is False


# ── 검증 2차(818b56f fail) D1: 하위 브랜드 다중 관점의 split 행 키 = 부모 브랜드 코드(core 공용 판정 하나) ────────────
# mentions 그룹(feat/bg-mentions-answers 9f33bb5)이 core 추가분을 걷고 이 그룹의 core.measure.split_own_scopes(ms) 를 그대로 쓰며,
# 행 키도 같은 식(mentions/brands/common.own_brand_code_of_bit = Refs.brand_code_of_bit)이다. 이 테스트는 trend 쪽 규칙을 고정한다:
# 관점 [Hyundai N, Kia] 의 분리 키는 'Hyundai'·'Kia'(비트 1·2 의 부모 코드). 모수(bgrp)는 관점 선택을 따르므로 [Hyundai, Kia] 와 값이
# 같다고 두지 않고, 같은 관점의 합친 계열과 분모를 공유하는지만 본다.
PARENT_CODE_OF_BITS = """
SELECT brand_bit, brand_code FROM app.brand
 WHERE brand_bit = ANY($1::int4[]) AND parent_brand_code IS NULL AND NOT is_umbrella ORDER BY brand_bit
"""


async def test_d1_sub_brand_multi_view_split_key_is_parent_code(client_as):
    base = {"surface": "global", "dimension": "brand", "metrics": "M01,M02", "split_own": "true"}
    async with staged() as conn:
        parent = [r["brand_code"] for r in await raw_fetch(conn, PARENT_CODE_OF_BITS, [1, 2])]
        keys = {r["name"]: int(r["brand_key"]) for r in await raw_fetch(
            conn, "SELECT name, brand_key FROM rd.dim_brand_name WHERE name = ANY($1::text[])", parent)}
        sub = await get(client_as, ADMIN, {**base, "brand": ["Hyundai N", "Kia"]})
        merged = await get(client_as, ADMIN, {**{k: v for k, v in base.items() if k != "split_own"}, "brand": ["Hyundai N", "Kia"]})
        one = await get(client_as, ADMIN, {**base, "brand": ["Hyundai N"]})
    assert parent == ["Hyundai", "Kia"]
    for metric in ("visibility", "share_of_voice"):
        own = [(s["key"], s["own_brand_code"], s["brand_key"]) for s in sub["data"]["series"] if s["is_own"] and s["metric"] == metric]
        assert own == [(c, c, keys.get(c)) for c in parent]                      # 'Hyundai N' 이 아니라 비트 1 의 부모 코드
        dens = [p["ratio"] and p["ratio"]["den"] for p in series(merged, metric, "own")["points"]]
        for c in parent:                                                          # 분모 = 같은 관점의 합친 계열(D13)
            assert [p["ratio"] and p["ratio"]["den"] for p in series(sub, metric, c)["points"]] == dens
    assert sub["data"]["own_label"] == "HMG"                                      # 다중 관점 라벨(BG-48)은 그대로
    # 관점 비트가 하나(하위 브랜드 단독)면 가르지 않는다: 합친 'own' 1행, 라벨 = 그 코드(mentions 도 같은 규칙: 비트 하나면 빈 split)
    assert [(s["key"], s["own_brand_code"]) for s in one["data"]["series"] if s["is_own"] and s["metric"] == "visibility"] == [("own", None)]
    assert one["data"]["own_label"] == "Hyundai N"


def test_d1_core_split_own_single_definition_contract():
    """core 공용 판정은 하나(merge-tree 무충돌 조건): split_own_scopes(ms) -> tuple[(bit, MeasureScope)], 비트 하나면 ()."""
    import inspect

    from app.core import measure
    assert list(inspect.signature(measure.split_own_scopes).parameters) == ["ms"]
    assert not hasattr(measure, "OwnSplit") and not hasattr(measure, "SPLIT_OWN_ARG")   # 두 번째 정의(다른 계약)를 core 에 두지 않는다


# ── 검증 2차 D3: measured_days 는 셀 대표(is_rep)가 아니라 버킷 답변 전부(known_diff 셋째 차이) ─────────────────────
ALL_DAYS = """
SELECT array_agg(DISTINCT a.answer_key ORDER BY a.answer_key) AS ks,
       count(DISTINCT (j.measured_at AT TIME ZONE 'Asia/Seoul')::date) AS d
  FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key AND j.surface = a.surface AND j.round_date = a.round_date
 WHERE a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2::int4[]) AND a.dflt AND a.cit_in AND j.served
"""
# 현행 front 규칙: (프롬프트·엔진·국가) 셀 대표 1건(kpiTabCellSnapshot, scope-aggregates.ts:9730) → 엔진별 세션 TZ(UTC) 일수 → max(10563)
FRONT_DAYS = """
WITH rep AS (
  SELECT DISTINCT ON (a.prompt_key, a.engine_key, a.geo_key) a.engine_key, j.measured_at
    FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key AND j.surface = a.surface AND j.round_date = a.round_date
   WHERE a.surface = 1 AND a.round_date = $1 AND a.cyc_key = ANY($2::int4[]) AND a.dflt AND a.cit_in AND j.served
   ORDER BY a.prompt_key, a.engine_key, a.geo_key, j.measured_at DESC, a.answer_key DESC)
SELECT max(d) AS d FROM (SELECT engine_key, count(DISTINCT (measured_at AT TIME ZONE 'UTC')::date) AS d FROM rep GROUP BY 1) e
"""


async def test_d3_measured_days_all_answers_not_cell_representative(client_as):
    # 회차 10(09-07): k16(is_rep 거짓, 09-07 측정)과 k17(is_rep 참, 09-21)이 같은 셀, k18 은 다른 셀(09-21)
    async with staged() as conn:
        ks = await cyc(conn, D07)
        allr = (await raw_fetch(conn, ALL_DAYS, D07, ks))[0]
        front = (await raw_fetch(conn, FRONT_DAYS, D07, ks))[0]
        rep = {r["answer_key"]: r["is_rep"] for r in await raw_fetch(
            conn, "SELECT answer_key, is_rep FROM rd.answer WHERE surface = 1 AND round_date = $1 AND cyc_key = ANY($2::int4[])", D07, ks)}
        b = await get(client_as, ADMIN, {"surface": "global"})
    assert list(allr["ks"]) == [16, 17, 18] and rep == {16: False, 17: True, 18: True}
    got = {x["key"]: x["measured_days"] for x in b["data"]["buckets"]}[D07.isoformat()]
    assert got == allr["d"] == 2                    # API: 버킷 답변 전부(비대표 k16 의 09-07 포함), 엔진 합집합, KST
    assert front["d"] == 1 != got                   # 현행: 셀 대표(k17·k18 = 09-21)만, 엔진별 max


# ── 검증 2차 D5: 명세 units(T-1·G-1)에 추가 파라미터·필드·422 규칙이 추가형으로 실려 있다(기능 README 만 갱신한 상태 재발 방지) ──
def _unit(prefix: str) -> dict:
    import json
    from pathlib import Path

    here = Path(__file__).resolve()
    root = next(p for p in here.parents if (p / "docs" / "design" / "api" / "units").is_dir())
    [f] = sorted((root / "docs" / "design" / "api" / "units").glob(f"{prefix}-*.json"))
    return json.loads(f.read_text(encoding="utf-8"))


def test_d5_units_carry_bg_additions():
    t1, g1 = _unit("T-1"), _unit("G-1")
    t1_params = " ".join(t1["filters"]["extra_params"])
    for name in ("dimension: enum(none|engine|brand|source|category|type)", "brand_key: int[]", "split_own: bool"):
        assert name in t1_params
    t1_bg = " ".join(t1["bg_additions"])
    for field in ("M08", "points[].negative", "buckets[].measured_days", "series[].brand_key", "series[].own_brand_code",
                  "data.own_label", "422 규칙", "셀 대표"):
        assert field in t1_bg
    assert any(s.startswith("lang[]") and "BG-01" in s for s in t1["filters"]["supported"])
    g1_sup = " ".join(g1["filters"]["supported"])
    assert "lang[](BG-01" in g1_sup and "funnel[]·brand_presence[]·list_type[]·depth1~3[](BG-02" in g1_sup
    assert any("BG-48" in s and "own_label" in s for s in g1["bg_additions"])
