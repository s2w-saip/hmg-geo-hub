"""브랜드 NULL·HMG 공통 카탈로그 프롬프트(core 10라운드, 메인 결정 = 현행 맞춤).

현행 front 규칙(표준 표면 데이터 축, 7개 리더 전부 같다: KPI·추이·언급·인용·GEO·답변 목록·ACR, 미러·사전집계 두 경로 모두):
- 브랜드 필터 = 카탈로그 brand 정확 일치. 미러 answerWhere·catalogPromptPreds·acrWhere 의 `brand IN (...)`(scope-aggregates.ts:2276·
  :6082·:9261, 정의 :2093-2094), 사전집계 `catalog_brands && $brands`(summary-global-aggregates.ts:183, NULL 브랜드는 빈 배열이라 불일치).
  공통(엄브렐러 HMG·NULL) 행은 필터를 걸면 빠진다. 기능별 예외 없음.
- 관리자(scope.all): 필터 없으면 전 카탈로그(NULL·HMG 포함), brand=X 면 X 정확 일치(standard-filters.ts:60-64 URL 값).
- 브랜드 스코프 계정: 필터가 [스코프 브랜드…, 'HMG'] 로 하드락(standard-filters.ts:53-64, URL brand 무시)이고 U1 어댑터는 그 값을
  보내지 않는다(lib/hgh/query.ts:299-302 urlBrands). 그래서 백엔드에는 '필터 없음' 으로 오고 공통 포함이 현행 HMG 포함과 맞는다.
  남는 차이 1개: 현행은 하드락이라 **무브랜드(NULL) 프롬프트를 뺀다**. 백엔드는 NULL·HMG 가 같은 엄브렐러 비트(Q11 cat_mask)라 가를 수 없어
  포함한다(stg 루트 카탈로그 NULL·HMG 프롬프트 0건이라 값 차이 0, 2026-09-29 읽기 전용 조사). 아래 시험이 그 차이를 명시해 고정한다.
- :9618-9622 의 `OR brand IS NULL OR brand = 'HMG'` 는 수집 기간 헤더(standardCollectionDates)에만 쓰이고 데이터 리더에는 없다.
백엔드: 글로벌 표면에서 brand[] 가 관점을 실제로 좁히면 모수 비트(bgrps·pop_bits)에서 엄브렐러 비트를 뺀다(core.filters 한 곳).
대조 기대값은 구현(rd.dim_prompt.cat_mask 비트 겹침)과 다른 경로(app.prompt 카탈로그 행의 brand 값)로 만든다.
"""
from __future__ import annotations

import uuid
from datetime import date

import asyncpg
import pytest

from app.core.auth import load_principal
from app.core.filters import KPI_SUPPORT, CommonFilters, resolve_read_context
from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, KIA_US, needs_db, raw_fetch, staged

pytestmark = needs_db

CATALOG_ROWS = """
SELECT dp.prompt_key, p.brand_code
  FROM app.prompt p
  JOIN app.project r ON r.project_id = p.project_id AND r.kind = 'standard_root'
  JOIN rd.dim_prompt dp ON dp.prompt_id = p.scope_prompt_id AND dp.surface = 1
 WHERE p.deleted_at IS NULL
"""
UMBRELLA = "HMG"
ALL_BRANDS = ["Hyundai", "Kia", "Genesis", "HMG"]


def _front_keys(rows: list[dict], requested: list[str] | None) -> set[int]:
    """현행 front 데이터 축: requested = None 이면 전 카탈로그 행(rootCatalogGate), 아니면 brand 정확 일치(NULL 불일치)."""
    return {int(r["prompt_key"]) for r in rows if requested is None or r["brand_code"] in requested}


def _null_only(rows: list[dict]) -> set[int]:
    by: dict[int, set] = {}
    for r in rows:
        by.setdefault(int(r["prompt_key"]), set()).add(r["brand_code"])
    return {k for k, bs in by.items() if bs == {None}}


async def _backend(uid: uuid.UUID, brand: list[str]):
    async with staged() as conn:
        rows = await raw_fetch(conn, CATALOG_ROWS)
        masks = {int(r["prompt_key"]): int(r["cat_mask"]) for r in await raw_fetch(conn, "SELECT prompt_key, cat_mask FROM rd.dim_prompt WHERE surface = 1")}
        ctx = await resolve_read_context(conn, await load_principal(conn, uid), CommonFilters(surface="global", brand=brand), support=KPI_SUPPORT)
    cat = {int(r["prompt_key"]) for r in rows}
    return {k for k, m in masks.items() if m in set(ctx.bgrps or ()) and k in cat}, rows, ctx


# (이름, 계정, 백엔드가 받는 brand[], 현행 데이터 축 필터(하드락 반영), 무브랜드 차이 허용 여부)
CASES = [
    ("관리자·필터 없음", ADMIN, [], None, False),
    ("관리자·Kia", ADMIN, ["Kia"], ["Kia"], False),
    ("관리자·Kia+Hyundai", ADMIN, ["Kia", "Hyundai"], ["Kia", "Hyundai"], False),
    ("관리자·Genesis", ADMIN, ["Genesis"], ["Genesis"], False),
    ("HQ 현대(하드락 [Hyundai, HMG], 어댑터 미전송)", HQ_HYUNDAI, [], ["Hyundai", UMBRELLA], True),
    ("기아 국가 계정(하드락 [Kia, HMG])", KIA_US, [], ["Kia", UMBRELLA], True),
    ("HQ 현대·brand=Hyundai 직접(API 전용 경로)", HQ_HYUNDAI, ["Hyundai"], ["Hyundai"], False),
]


@pytest.mark.parametrize("name,uid,brand,req,null_gap", CASES, ids=[c[0] for c in CASES])
async def test_population_equals_front_rule(seeded, name, uid, brand, req, null_gap):
    keys, rows, ctx = await _backend(uid, brand)
    want = _front_keys(rows, req)
    extra = _null_only(rows) if null_gap else set()
    assert keys == want | extra, (name, sorted(keys), sorted(want))
    if null_gap:
        assert extra and not extra & want                    # 하드락 계정의 남은 차이 = 무브랜드 전용 프롬프트뿐(픽스처 SP2)
    assert (ctx.refs.umbrella_bit in ctx.pop_bits) == (not brand), (name, ctx.pop_bits)   # M12 적용·택소노미 행 범위도 같은 규칙


async def test_umbrella_account(seeded):
    """엄브렐러를 스코프에 가진 계정(stg: Hyundai·Kia·Genesis·HMG·Hyundai N 6계정): 하드락 [..., HMG] = 전 브랜드 + HMG."""
    uid = uuid.uuid4()
    c = await asyncpg.connect(DB_URL)
    try:
        await c.execute("SELECT set_config('app.actor_id', $1, false)", str(ADMIN))
        await c.execute("INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands) "
                        "VALUES ($1, $2, 'hq', 'none', false, '{Hyundai,Kia,Genesis,HMG}')", uid, f"t-umb-{uid}@example.test")
        keys, rows, _ = await _backend(uid, [])
        assert keys == _front_keys(rows, ALL_BRANDS) | _null_only(rows)
        keys, rows, _ = await _backend(uid, ["Kia"])                # API 전용(front 는 하드락이라 보내지 않는다): 정확 일치
        assert keys == _front_keys(rows, ["Kia"])
    finally:
        await c.execute("DELETE FROM app.user_account WHERE user_id = $1", uid)
        await c.close()


async def test_dropped_brand_only_is_not_a_narrowing(seeded):
    """요청 값이 전부 버려지면(스코프 밖·엄브렐러·모르는 코드) 관점은 스코프 전체로 돌아가고 공통도 그대로(좁힌 것이 아니다)."""
    keys, rows, ctx = await _backend(HQ_HYUNDAI, ["Kia", "HMG", "Nope"])
    assert ctx.dropped_filters.get("brand") == ("Kia", "HMG", "Nope")
    assert keys == _front_keys(rows, ["Hyundai", UMBRELLA]) | _null_only(rows)


# ── 기능별 대표 요청(관리자 brand 1·2개): 모수 수 = 현행 규칙으로 센 수(구현과 다른 경로: 카탈로그 행 brand) ─────────────
SNAP = "2026-09-14"
FRONT_COUNTS = """
SELECT count(*) FILTER (WHERE a.std_in) AS std, count(*) FILTER (WHERE a.cit_in) AS cit,
       count(*) FILTER (WHERE a.std_in AND a.cit_in AND g.code = 'US') AS us_std
  FROM rd.answer a
  JOIN rd.dim_prompt dp ON dp.prompt_key = a.prompt_key
  LEFT JOIN rd.dim_country g ON g.geo_key = a.geo_key
 WHERE a.surface = 1 AND a.round_date = $1::date AND a.dflt
   AND a.cyc_key = ANY(SELECT c.cyc_key FROM rd.cycle c WHERE c.surface = 1 AND c.round_date = $1::date AND c.hidden_scope = 0)
   AND EXISTS (SELECT 1 FROM app.prompt p JOIN app.project r ON r.project_id = p.project_id AND r.kind = 'standard_root'
                WHERE p.scope_prompt_id = dp.prompt_id AND p.deleted_at IS NULL AND ($2::text[] IS NULL OR p.brand_code = ANY($2::text[])))
"""


@pytest.mark.parametrize("brand", [["Kia"], ["Hyundai", "Kia"], []], ids=["Kia", "Hyundai+Kia", "필터 없음"])
async def test_endpoints_population_equals_front(seeded, client_as, brand):
    async with staged() as conn:
        e = (await raw_fetch(conn, FRONT_COUNTS, date.fromisoformat(SNAP), brand or None))[0]
    q = {"surface": "global", **({"brand": brand} if brand else {})}
    async with client_as(ADMIN) as c:
        k1 = (await c.get("/v1/kpi/summary", params=q)).json()
        tr = (await c.get("/v1/trend", params={**q, "metrics": "visibility"})).json()
        mb = (await c.get("/v1/mentions/brands", params=q)).json()
        dm = (await c.get("/v1/citations/domains", params=q)).json()
        geo = (await c.get("/v1/geo", params=q)).json() if len(brand) == 1 else None    # GEO 권역 트리는 브랜드 하나일 때만(brand_required)
        ans = (await c.get("/v1/answers", params={**q, "limit": 200})).json()
    assert k1["meta"]["cycles"] == [SNAP]
    assert k1["data"]["params"]["answers"] == e["std"], (brand, k1["data"]["params"], dict(e))          # K-1(M01 분모)
    vis = next(p for s in tr["data"]["series"] if s["metric"] == "visibility" for p in s["points"] if p["bucket"] == SNAP)
    assert (vis["ratio"] or {"den": 0})["den"] == e["std"]                                                 # T-1 = K-1(D6)
    assert mb["data"]["totals"]["answers"] == e["std"]                                                    # M-1 모수
    assert dm["data"]["summary"]["answers_den"] == e["cit"]                                                # C 인용 커버리지 분모
    if geo is not None:
        us = [c for m in geo["data"]["markets"] for c in m["countries"] if c["code"] == "US"]
        assert (us[0]["answers"] if us else 0) == e["us_std"]                                               # GEO-1
    async with staged() as conn:
        rows = await raw_fetch(conn, CATALOG_ROWS + " AND dp.prompt_id::text = ANY($1::text[])",
                               sorted({i["prompt"]["prompt_id"] for i in ans["data"]["items"]}))
    assert all(brand == [] or r["brand_code"] in brand or any(
        x["brand_code"] in brand for x in rows if x["prompt_key"] == r["prompt_key"]) for r in rows)      # 답변 목록: 정확 일치 밖 프롬프트 없음
