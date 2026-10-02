"""동기화 S1 BE-B: 글로벌 ⑤ 인용 점유율 분자 = 출처 카테고리 Official (HMG) 인용 수(hmg-geo 2670a16 #320 783478c·#321 feddea7).

현행 정본(lib/kpi/official-hmg-citations.ts): 글로벌 ⑤ 분자 = resolveCitationCategory(그룹 키, 오버라이드) = 'Official (HMG)' 인 인용 수,
분모 = 전체(호스트 있는) 인용. 인용 현황 공식(HMG) 비중·출처 카테고리 Official (HMG) 비중과 **같은 값**이다(현행 머리 주석 ①②③).
hub 대응: K-1·K-2·T-1·GEO-1·K-3(Q1 (a)) 의 ⑤ = core.measure cit_m05(= Σ rd.answer.cit_off, 원소 스캔이면 OFFICIAL_SOURCES) /
C-2 /v1/citations/sources 카테고리 officialHmg 행 = 같은 모집단. 이 파일이 그 동치를 필터 축·계정 격자로 단언한다.

합성 확장(롤백 전용, m05.pgsql spread): 글로벌 회차 11(09-14) k1(US·chatgpt, 호스트 인용 9·공식 4 = hyundai.com·hyundaiusa.com·kia.com +
공식 소셜 linkedin.com/hyundai-motor-group)을 3건 복사해 국가·엔진·출처를 가른다(소유 owner_key 는 원본 그대로 = 종전 분자와 갈라지게).
  9501 DE·gemini  ord 2·4 reddit → hyundai.com(공식 +2), ord 10 kia.com → bmwusa.com(-1)   공식 5 / 9   (종전 현대 자사 2)
  9502 KR·chatgpt ord 1 hyundai.com·ord 9 hyundaiusa.com → reddit.com(-2)                   공식 2 / 9   (종전 현대 자사 2)
  9503 US·gemini  그대로                                                                    공식 4 / 9   (종전 현대 자사 2)
답변 인용 수 열은 rd.answer_cit_counts 로 다시 채우고 rd.assert_answer_cit_counts(엄격)로 단언한다(m05.pgsql recount, 적재기와 같은 정본 식).
"""
from __future__ import annotations

import pathlib
from datetime import date
from typing import Any

from app.core.measure import round1
from tests.support import ADMIN, HQ_HYUNDAI, KIA_EU, KIA_US, Sql, load_named_sql, needs_db, raw_fetch, staged

pytestmark = needs_db
D14 = date(2026, 9, 14)
D10 = date(2026, 9, 10)
N = load_named_sql(pathlib.Path(__file__).with_name("m05.pgsql"))
SPREAD = [Sql(N["spread"]), Sql(N["copy"]), Sql(N["recount"])]                       # 9501·9502·9503(머리말 표)
TWO_ROUNDS = [Sql(N["two_rounds"]), Sql(N["copy"]), Sql(N["recount"])]              # 회차 900(09-10) 9601
OVERRIDE_PENDING = [*SPREAD, Sql(N["override_pending"])]
OVERRIDE_REFLECTED = [*OVERRIDE_PENDING, Sql(N["override_reflected"]), Sql(N["recount"])]


async def _get(client_as, uid, path: str, params: dict[str, Any]) -> dict[str, Any]:
    async with client_as(uid) as c:
        r = await c.get(path, params=params)
    assert r.status_code == 200, (path, params, r.text)
    return r.json()


def _pair(x: dict | None) -> tuple[int, int] | None:
    return (x["num"], x["den"]) if x else None


async def _k1(client_as, uid, params) -> tuple[int, int]:
    b = await _get(client_as, uid, "/v1/kpi/summary", {"surface": "global", **params})
    return _pair(b["data"]["citation_share"]) or (0, 0)


async def _c2(client_as, uid, params) -> tuple[int, int]:
    d = (await _get(client_as, uid, "/v1/citations/sources", {"surface": "global", **params}))["data"]
    off = next((c["citations"] for c in d["categories"] if c["category"]["slug"] == "officialHmg"), 0)
    return off, d["total_citations"]


# 독립 기대값: 원소의 출처 차원 카테고리 이름으로 센다(구현은 답변 열 cit_off 합). 관점·국가 무관(전사 관점 = 모수 전부)
OFFICIAL_ELEMENTS = """
SELECT count(*) FILTER (WHERE cc.name = 'Official (HMG)') AS off, count(*) AS n
  FROM rd.citation c JOIN rd.dim_source s ON s.source_key = c.source_key JOIN app.citation_category cc ON cc.category_key = s.category_key
 WHERE c.surface = 1 AND c.round_date = $1 AND c.cyc_key = ANY($2::int4[]) AND c.source_key <> 0 AND c.cit_in AND c.dflt
"""
# K-1 지원 축(KPI_SUPPORT global: 출처 카테고리 source[] 없음). source[] 는 T-1(지원 축)로 C-2 와 대조한다
FILTERS: list[dict[str, Any]] = [{}, {"country": "US"}, {"country": ["US", "DE"]}, {"country": ["US", "DE", "KR"]}, {"engine": "gemini"},
                                 {"engine": ["chatgpt", "gemini"]}, {"lang": "en"}, {"from": "2026-09-01", "to": "2026-09-30"}]
SOURCE_FILTERS: list[dict[str, Any]] = [{"source": ["officialHmg", "communityForums"]}, {"source": "officialHmg"},
                                        {"source": ["officialHmg", "communityForums"], "country": ["US", "DE"]}]


async def _t1(client_as, uid, params) -> tuple[int, int]:
    d = (await _get(client_as, uid, "/v1/trend", {"surface": "global", "metrics": "M05", "bucket": "cycle", **params}))["data"]
    return _pair(next(p for p in d["series"][0]["points"] if p["bucket"] == D14.isoformat())["ratio"]) or (0, 0)


# ════════════════════════════════════════════════════════════════════════════
# 1. K-1 ⑤ = C-2 공식(HMG) 카테고리 값(현행 불변식 ①=②=③) · 필터 축 × 계정 격자
# ════════════════════════════════════════════════════════════════════════════
async def test_k1_numerator_equals_c2_official_category(client_as):
    async with staged(*SPREAD) as conn:
        e = (await raw_fetch(conn, OFFICIAL_ELEMENTS, D14, [11]))[0]
        assert (await _k1(client_as, ADMIN, {})) == (e["off"], e["n"]) == (15, 36)          # 원소 오라클(관점·국가 무관): 4+5+2+4 / 9×4
        seen = 0
        for uid in (ADMIN, HQ_HYUNDAI, KIA_US, KIA_EU):
            for f in FILTERS:
                k1, c2 = await _k1(client_as, uid, f), await _c2(client_as, uid, f)
                assert k1 == c2, (uid, f, k1, c2)
                seen += k1[0] > 0
        assert seen >= 12                                                                    # 비어 있지 않은 격자 칸(4계정 × 8필터 중 16)
        for uid in (ADMIN, HQ_HYUNDAI, KIA_US):
            for f in SOURCE_FILTERS:                                                         # 출처 축 = 원소 스캔(OFFICIAL_SOURCES) 경로
                t1, c2 = await _t1(client_as, uid, f), await _c2(client_as, uid, f)
                assert t1 == c2, (uid, f, t1, c2)
        assert await _t1(client_as, ADMIN, {"source": "officialHmg"}) == (15, 15)           # 분모까지 공식 카테고리로 좁히면 전부 분자
        assert await _k1(client_as, HQ_HYUNDAI, {"country": "DE"}) == (5, 9)                 # 국가 1: 분자를 국가로 좁히지 않는다(종전 0/9 = DE 로 좁힌 현대 자사 배열)
        assert await _k1(client_as, HQ_HYUNDAI, {"country": ["US", "KR"]}) == (10, 27)       # 국가 N: cross 보정 없음(종전 2/27)
        # 관점이 달라도 모집단이 같으면 분자가 같다(브랜드 무관 카테고리 판정). 종전 분자: 현대 관점 자사 8, 전사 관점 3사 자사 12
        assert await _k1(client_as, HQ_HYUNDAI, {}) == await _k1(client_as, ADMIN, {}) == (15, 36)


# ════════════════════════════════════════════════════════════════════════════
# 2. GEO-1·T-1·K-2·K-3 이 카드와 같은 분자(D6), K-3 엔진 일관성 배지(Q1 (a))
# ════════════════════════════════════════════════════════════════════════════
async def test_geo_trend_compare_engines_follow_card(client_as):
    async with staged(*SPREAD):
        for uid in (HQ_HYUNDAI, KIA_EU):                                                     # KIA_EU 는 복사 답변 bgrp 5(현대·제네시스) 밖이라 행 없음
            geo = (await _get(client_as, uid, "/v1/geo", {"surface": "global"}))["data"]
            rows = [c for m in geo["markets"] for c in m["countries"]]
            assert rows or uid == KIA_EU, uid
            for c in rows:
                assert (_pair(c["own"]["citation_share"]) or (0, 0)) == await _k1(client_as, uid, {"country": c["code"]}), (uid, c["code"])
            for m in geo["markets"]:                                                         # 권역 = 국가 분자·분모 합
                cs = [_pair(c["own"]["citation_share"]) or (0, 0) for c in m["countries"]]
                assert (_pair(m["own"]["citation_share"]) or (0, 0)) == (sum(x[0] for x in cs), sum(x[1] for x in cs))
        card = await _k1(client_as, HQ_HYUNDAI, {})
        tr = (await _get(client_as, HQ_HYUNDAI, "/v1/trend", {"surface": "global", "metrics": "M05"}))["data"]
        pt = next(p for p in tr["series"][0]["points"] if p["bucket"] == D14.isoformat())
        assert _pair(pt["ratio"]) == card == (15, 36)
        mon = (await _get(client_as, HQ_HYUNDAI, "/v1/trend", {"surface": "global", "metrics": "M05", "bucket": "month"}))["data"]
        assert _pair(mon["series"][0]["points"][0]["ratio"]) == await _k1(client_as, HQ_HYUNDAI, {"from": "2026-09-01", "to": "2026-09-30"})
        cmp = (await _get(client_as, HQ_HYUNDAI, "/v1/kpi/compare", {"surface": "global", "kind": "cycle",
                                                                    "metrics": "citation_share"}))["data"][0]
        assert _pair(cmp["cur"]) == card
        eng = (await _get(client_as, HQ_HYUNDAI, "/v1/kpi/engines", {"surface": "global"}))["data"]
        rows = {r["engine"]: r for r in eng["rows"]}
        assert (rows["chatgpt"]["cit_owned"], rows["chatgpt"]["cit_total"]) == (6, 18)       # k1 4 + 9502 2(종전 현대 자사 2 + 2: 소유는 URL 판정이라 출처를 바꿔도 남는다)
        assert (rows["gemini"]["cit_owned"], rows["gemini"]["cit_total"]) == (9, 18)         # 9501 5 + 9503 4(종전 2 + 2)
        assert (eng["total"]["cit_owned"], eng["total"]["cit_total"]) == card
        # 배지 = round1(100 × min ÷ max) 을 공식(HMG) 비율로(현행 live.ts:880 은 base URL 자사 citOwned: 4/18 · 4/18 → 100.0, 실측)
        assert eng["engine_consistency"]["citation_share"] == round1(100 * (6 / 18) / (9 / 18)) == 66.7


# ════════════════════════════════════════════════════════════════════════════
# 3. 오버라이드: 반영 전(재판정 대기) 지연 · 반영 뒤 동치. 경쟁사 선택(#323) · 카테고리 Δ 직전 회차 자리(#322)
# ════════════════════════════════════════════════════════════════════════════
async def test_override_lag_then_reflected(client_as):
    async with staged(*OVERRIDE_PENDING):
        k1, c2 = await _k1(client_as, ADMIN, {}), await _c2(client_as, ADMIN, {})
        assert k1 == (15, 36) and c2 == (19, 36)            # 조회 시 즉시 보이는 C-2(CATEGORY_EXPR)와 반영된 차원 기준 ⑤ 의 지연(Q2 (a) 고지)
    async with staged(*OVERRIDE_REFLECTED):
        for f in ({}, {"country": "DE"}, {"lang": "en"}):
            assert await _k1(client_as, ADMIN, f) == await _c2(client_as, ADMIN, f), f
        assert await _t1(client_as, ADMIN, {"source": "officialHmg"}) == await _c2(client_as, ADMIN, {"source": "officialHmg"}) == (19, 19)
        assert await _k1(client_as, ADMIN, {}) == (19, 36)                                   # caranddriver 4건이 공식으로


async def test_competitor_pick_keeps_denominator(client_as):
    """#323: 경쟁사 선택(C-1 competitor[])은 공식(경쟁사) 값만 줄이는 화면 규칙이고 ⑤ 분모 = 전체 인용이다. ⑤·C-2 는 선택과 무관."""
    async with staged(*SPREAD):
        base_k1, base_c2 = await _k1(client_as, HQ_HYUNDAI, {}), await _c2(client_as, HQ_HYUNDAI, {})
        assert await _k1(client_as, HQ_HYUNDAI, {"competitor": "bmwusa.com"}) == base_k1
        assert await _c2(client_as, HQ_HYUNDAI, {"competitor": "bmwusa.com"}) == base_c2
        assert base_k1[1] == base_c2[1] == 36


async def test_category_delta_basis_is_previous_round_slot(client_as):
    """#322: 카테고리 Δ 기준 = 직전 회차 자리(hub 어댑터 citations.ts DC-11). ⑤ 추이 버킷 분자 = 같은 버킷의 카테고리 officialHmg 값이라
    ⑤ Δ(직전 회차 버킷)와 카테고리 Δ(직전 회차 자리)가 같은 기준점을 쓴다. K-1 cycle_offset 1 = 직전 회차."""
    async with staged(*TWO_ROUNDS):
        m05 = (await _get(client_as, HQ_HYUNDAI, "/v1/trend", {"surface": "global", "metrics": "M05"}))["data"]
        cat = (await _get(client_as, HQ_HYUNDAI, "/v1/trend", {"surface": "global", "dimension": "category"}))["data"]
        by_b = {p["bucket"]: _pair(p["ratio"]) for p in m05["series"][0]["points"]}
        off = next(s for s in cat["series"] if s["key"] == "officialHmg")
        by_c = {p["bucket"]: _pair(p["ratio"]) for p in off["points"]}
        assert by_b[D10.isoformat()] == by_c[D10.isoformat()] == (3, 9)
        assert by_b[D14.isoformat()] == by_c[D14.isoformat()] == (4, 9)
        prev = await _get(client_as, HQ_HYUNDAI, "/v1/kpi/summary", {"surface": "global", "cycle_offset": 1})
        assert prev["meta"]["as_of"] == D10.isoformat() and _pair(prev["data"]["citation_share"]) == (3, 9)
        assert await _c2(client_as, HQ_HYUNDAI, {"from": "2026-09-10", "to": "2026-09-10"}) == (3, 9)
