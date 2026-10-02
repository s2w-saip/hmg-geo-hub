"""GET /v1/prompts(P-1) 통합 테스트. 기대값은 손계산(seed.py 행 목록) 또는 구현과 다른 형태의 독립 SQL.

공용 픽스처(fixture-10-data.sql) 루트 카탈로그 활성 6행: best suv(H) · best suv (G)(G) · common q(NULL) · acr q(HMG) · 현대 SUV 추천(H) ·
us only(Kia). 웹사이트 Kia DE 3행: ev9?(chatgpt 1건, 09-18) · deals?(0) · sub?(gemini 1건, 09-18, 회차 21 인용 숨김 = row 계열엔 보임).
웹사이트 회차는 rd.cycle cyc_key 21 하나(surface 2, Kia DE 사이트 project_key 2, 2026-09-18 servable). 측정 메타의 게이트 없는 창(catalog #11)은
그 회차를 비발행·미래 노출·hidden_scope 1 로 바꾼 staged 준비(롤백 전용)로 확인한다(공용 픽스처는 고치지 않는다).
"""
from __future__ import annotations

import csv
import dataclasses
import io
import uuid
import zipfile
from datetime import date

import pytest
import pytest_asyncio

from app.core.db import get_db
from app.core.pagination import Cursor, decode_cursor, encode_cursor
from app.core.write import get_audit_writer
from app.features.catalog.prompts.catalog import queries as CQ
from app.features.catalog.prompts.catalog.schemas import GLOBAL_COLUMNS
from app.features.catalog.prompts.catalog.tests import seed as S
from tests.support import ADMIN, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, SYSTEM, VENDOR, Sql, Update, needs_db, staged

pytestmark = needs_db

F_BEST_H = uuid.UUID("c1000000-0000-4000-8000-000000000001")
F_COMMON = uuid.UUID("c1000000-0000-4000-8000-000000000002")
F_ACR = uuid.UUID("c1000000-0000-4000-8000-000000000003")
F_HY_KO = uuid.UUID("c1000000-0000-4000-8000-000000000004")
F_US_ONLY = uuid.UUID("c1000000-0000-4000-8000-000000000006")
F_BEST_G = uuid.UUID("c1000000-0000-4000-8000-000000000011")
FIXTURE_LIVE = {F_BEST_H, F_COMMON, F_ACR, F_HY_KO, F_US_ONLY, F_BEST_G}
G = S.gid


@pytest_asyncio.fixture(scope="module", loop_scope="session", autouse=True)
async def _seed(seeded):
    await S.seed()


def _fh_of(body) -> str:
    """커서 안의 필터 해시(서버가 넣은 값 그대로)."""
    import base64
    import json
    tok = body["meta"]["page"]["next_cursor"]
    return json.loads(base64.urlsafe_b64decode(tok + "=" * (-len(tok) % 4)))["fh"]


def ids(body, key="prompt_id") -> list[uuid.UUID]:
    return [uuid.UUID(x[key]) for x in body["data"]["items"]]


async def _all_pages(c, params, key="prompt_id"):
    out, cursor, pages = [], None, 0
    while True:
        r = await c.get("/v1/prompts", params={**params, **({"cursor": cursor} if cursor else {})})
        assert r.status_code == 200, r.text
        b = r.json()
        out += ids(b, key)
        pages += 1
        cursor = b["meta"]["page"]["next_cursor"]
        if not cursor:
            return out, b, pages


# ════════════════════════════════════════════════════════════════════════════
# 글로벌
# ════════════════════════════════════════════════════════════════════════════
async def test_global_shape_and_total(client_as):
    n = (await S.q("SELECT count(*) AS n FROM app.prompt WHERE project_id = $1 AND deleted_at IS NULL", uuid.UUID(S.ROOT)))[0]["n"]
    assert n == len(FIXTURE_LIVE) + len(S.LIVE_GLOBAL) == 14
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params={"surface": "global"})
    assert r.status_code == 200, r.text
    b = r.json()
    assert set(ids(b)) == FIXTURE_LIVE | set(S.LIVE_GLOBAL)
    assert G(9) not in ids(b)                                                          # soft-delete 제외
    m = b["meta"]
    assert (m["mode"], m["surface"], m["generation"], m["cycles"], m["as_of"]) == ("catalog", "global", None, [], None)
    assert m["page"] == {"next_cursor": None, "limit": 500, "total": 14}
    row = next(x for x in b["data"]["items"] if x["prompt_id"] == str(G(1)))
    assert row == {"prompt_id": str(G(1)), "text": "kr market suv", "kind": "single", "scope_prompt_id": None, "measured": False,
                   "brand_code": "Hyundai", "brand_presence": None, "brand_presence_effective": "branded", "prompt_type": None,
                   "category": None, "list_type": "L1", "depth1": "D1", "depth2": "D2a", "depth3": "D3x", "depth4": "D4x",
                   "funnel_stage": "F1", "lang": "KO", "regions": ["KR"]}
    acr = next(x for x in b["data"]["items"] if x["prompt_id"] == str(F_ACR))
    assert acr["brand_presence_effective"] == "unbranded" and acr["measured"] is True          # 엄브렐러(app.brand.is_umbrella)
    assert next(x for x in b["data"]["items"] if x["prompt_id"] == str(F_COMMON))["brand_presence_effective"] is None


async def test_global_keyset_paging_matches_independent_order(client_as):
    expected = [r["prompt_id"] for r in await S.q(
        "SELECT prompt_id FROM app.prompt WHERE project_id = $1 AND deleted_at IS NULL "
        "ORDER BY depth1 ASC NULLS LAST, depth2 ASC NULLS LAST, depth3 ASC NULLS LAST, text, prompt_id", uuid.UUID(S.ROOT))]
    async with client_as(ADMIN) as c:
        got, last, pages = await _all_pages(c, {"surface": "global", "limit": 4})
    assert got == expected and len(set(got)) == 14 and pages == 4
    assert last["meta"]["page"]["total"] == 14


async def test_global_brand_scope_hq_hyundai(client_as):
    """스코프 브랜드 Hyundai = Hyundai ∪ HMG(엄브렐러) ∪ NULL. Hyundai N·Kia·Genesis 행 누출 0."""
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.get("/v1/prompts", params={"surface": "global"})
        r2 = await c.get("/v1/prompts", params={"surface": "global", "brand": "Kia"})
    assert r.status_code == 200, r.text
    assert set(ids(r.json())) == {F_BEST_H, F_COMMON, F_ACR, F_HY_KO, G(1), G(7)}
    b2 = r2.json()                                                          # 스코프 밖 브랜드 요청 → dropped, 행은 늘지 않는다
    assert b2["meta"]["dropped_filters"] == {"brand": ["Kia"]} and set(ids(b2)) == set(ids(r.json()))


async def test_global_market_scope_country_accounts(client_as):
    """B1 3분기: NULL(상속)·의사코드만·빈 배열 = 보임, 실국가는 스코프 국가와 겹칠 때만(공백·대소문자 정규화)."""
    async with client_as(KIA_US) as c:
        us = await c.get("/v1/prompts", params={"surface": "global"})
        leak = await c.get("/v1/prompts", params={"surface": "global", "country": "DE"})
    assert set(ids(us.json())) == {F_COMMON, F_ACR, F_US_ONLY, G(2), G(3), G(4), G(7), G(8)}
    lb = leak.json()                                                        # 스코프 밖 국가 요청 → 빈 결과(누출 0)
    assert lb["meta"]["dropped_filters"] == {"country": ["DE"]} and lb["data"]["items"] == [] and lb["meta"]["page"]["total"] == 0
    async with client_as(KIA_EU) as c:
        eu = await c.get("/v1/prompts", params={"surface": "global"})
    assert set(ids(eu.json())) == {F_COMMON, F_ACR, F_US_ONLY, G(3), G(4), G(5), G(7), G(8)}


async def test_global_geo_pseudo_market_filter(client_as):
    """catalog #7(메인 결정 = front 현행): 지리 의사 시장 코드 x:WW·x:EU·x:ME 는 시장 필터 값이다(prompt-markets.ts:25 GEO_PSEUDO,
    :54-57 isGeoFilterable, :110-118 matchesMarket 정확 매칭·정규화). 허용목록 밖 x:* 는 필터 값이 아니다(dropped, 빈 결과)."""
    prep = (Sql("SELECT set_config('app.actor_id', $1, true)", (str(SYSTEM),)),        # app.prompt 감사 트리거 행위자
            Sql("UPDATE app.prompt SET regions = $1::text[] WHERE prompt_id = $2", (["x:WW"], G(3))),
            Sql("UPDATE app.prompt SET regions = $1::text[] WHERE prompt_id = $2", (["KR", "x:eu"], F_HY_KO)))
    async with staged(*prep), client_as(ADMIN) as c:
        ww = (await c.get("/v1/prompts", params={"surface": "global", "country": "x:WW"})).json()
        mix = (await c.get("/v1/prompts", params={"surface": "global", "country": ["X:ww", "US"]})).json()
        eu = (await c.get("/v1/prompts", params={"surface": "global", "country": "x:EU"})).json()
        na = (await c.get("/v1/prompts", params={"surface": "global", "country": "x:na"})).json()
    assert set(ids(ww)) == {G(3)} and "country" not in ww["meta"]["dropped_filters"]
    assert set(ids(mix)) == {G(3), G(2)}                                   # G2 regions [" us ", "x:na"] 는 US 로 매칭
    assert set(ids(eu)) == {F_HY_KO}                                       # 저장값 'x:eu' 도 정규화 뒤 같다
    assert ids(na) == [] and na["meta"]["dropped_filters"] == {"country": ["x:na"]}


async def test_global_filters_change_values(client_as):
    async with client_as(ADMIN) as c:
        async def got(**params):
            r = await c.get("/v1/prompts", params={"surface": "global", **params})
            assert r.status_code == 200, r.text
            return r.json()
        base = await got()
        assert base["meta"]["page"]["total"] == 14
        assert set(ids(await got(country="DE"))) == {G(5)}                            # 요청 시장 = regions 정확 포함(미지정 제외)
        assert set(ids(await got(country="us"))) == {G(2)}
        zz = await got(country="ZZ")
        assert zz["data"]["items"] == [] and zz["meta"]["dropped_filters"] == {"country": ["ZZ"]}
        assert set(ids(await got(brand="Kia"))) == {F_COMMON, F_ACR, F_US_ONLY, G(2), G(3), G(4), G(5), G(7), G(8)}
        assert set(ids(await got(lang="ko"))) == {G(1)}
        assert set(ids(await got(depth1="D1"))) == FIXTURE_LIVE | {G(1), G(2), G(5), G(7)}
        assert set(ids(await got(funnel="F2"))) == {F_COMMON, F_US_ONLY, G(2)}
        assert set(ids(await got(brand_presence="unbranded"))) == {F_ACR}
        # catalog #8(메인 결정 = front 현행 prompt-list-readonly.tsx:172-182): 택소노미 값은 app.prompt 열 값 그대로 비교한다.
        # 이전 기대(rd.dim_taxon 사전 밖 = dropped + 빈 결과)에서 바뀐 이유: 미발행 행(G1, scope_prompt_id NULL)에만 있는 값도 매칭.
        d3 = await got(depth3="D3x")
        assert set(ids(d3)) == {G(1)} and d3["meta"]["dropped_filters"] == {}
        assert set(ids(await got(funnel="F1"))) == {F_BEST_H, F_ACR, F_HY_KO, F_BEST_G, G(1)}   # 발행 행 ∪ 미발행 G1(열 값 그대로)
        nope = await got(depth1="no-such-depth")                                        # 어느 행에도 없는 값 = 빈 결과(dropped 아님)
        assert nope["data"]["items"] == [] and nope["meta"]["dropped_filters"] == {}
        assert set(ids(await got(depth4="D4x"))) == {G(1)}
        assert set(ids(await got(kind="acr"))) == {F_ACR}
        assert set(ids(await got(measured="false"))) == set(S.LIVE_GLOBAL)
        assert set(ids(await got(measured="true"))) == FIXTURE_LIVE
        assert set(ids(await got(search="SUV"))) == {F_BEST_H, F_BEST_G, F_HY_KO, G(1)}
        assert set(ids(await got(search="%"))) == {G(7)}                               # 와일드카드 이스케이프
        assert set(ids(await got(search="0%_o"))) == {G(7)}
        assert set(ids(await got(search="\\x"))) == {G(7)}
        ign = await got(engine="chatgpt", **{"from": "2026-09-01", "to": "2026-09-30"}, source="news", sort="prompt",
                        project_id=str(uuid.uuid4()))
        assert ign["meta"]["page"]["total"] == 14
        assert ign["meta"]["ignored_filters"] == ["engine", "period", "project_id", "sort", "source"]
        empty = await got(search="no-such-text-xyz")
        assert empty["data"]["items"] == [] and empty["meta"]["page"] == {"next_cursor": None, "limit": 500, "total": 0}


# ════════════════════════════════════════════════════════════════════════════
# 웹사이트
# ════════════════════════════════════════════════════════════════════════════
W_EV9, W_DEALS, W_SUB = "ev9?", "deals?", "sub?"


def by_text(body) -> dict[str, dict]:
    return {x["prompt_text"]: x for x in body["data"]["items"]}


async def test_website_measure_meta_and_order(client_as):
    vis = [r["cyc_key"] for r in await S.q(
        "SELECT cyc_key FROM rd.cycle WHERE surface = 2 AND servable AND view_date <= current_date AND hidden_scope <> 1")]
    exp = {r["prompt_id"]: r for r in await S.q(
        "SELECT dp.prompt_id, count(*) AS n, max(a.round_date) AS last, array_agg(DISTINCT e.code ORDER BY e.code) AS eng "
        "FROM rd.answer a JOIN rd.dim_prompt dp ON dp.prompt_key = a.prompt_key JOIN rd.dim_engine e ON e.engine_key = a.engine_key "
        "WHERE a.surface = 2 AND a.round_date BETWEEN '2000-01-01' AND '2100-01-01' AND a.cyc_key = ANY($1::int4[]) "
        "GROUP BY dp.prompt_id", vis)}
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params={"surface": "website"})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["meta"]["page"]["total"] == 7 and b["meta"]["mode"] == "catalog" and b["meta"]["generation"] is not None
    rows = by_text(b)
    for t in (W_EV9, W_SUB):
        e = exp[uuid.UUID(rows[t]["scope_prompt_id"])]
        assert (rows[t]["answers"], rows[t]["last_measured"], rows[t]["engines"]) == (e["n"], e["last"].isoformat(), e["eng"])
    assert (rows[W_EV9]["answers"], rows[W_EV9]["engines"], rows[W_SUB]["engines"]) == (1, ["chatgpt"], ["gemini"])   # 손계산
    assert (rows[W_DEALS]["answers"], rows[W_DEALS]["last_measured"], rows[W_DEALS]["engines"]) == (0, None, [])
    assert rows["us kia a"]["measured"] is False and rows[W_EV9]["measured"] is True
    texts = [x["prompt_text"] for x in b["data"]["items"]]                      # 기본 last_measured desc, NULL 은 뒤
    assert set(texts[:2]) == {W_EV9, W_SUB} and len(texts) == 7


async def test_website_lens_does_not_filter_rows(client_as):
    async with client_as(ADMIN) as c:
        g = (await c.get("/v1/prompts", params={"surface": "website", "engine": "gemini"})).json()
        old = (await c.get("/v1/prompts", params={"surface": "website", "from": "2026-09-01", "to": "2026-09-10"})).json()
        hit = (await c.get("/v1/prompts", params={"surface": "website", "from": "2026-09-18", "to": "2026-09-18"})).json()
    assert g["meta"]["page"]["total"] == old["meta"]["page"]["total"] == 7
    assert (by_text(g)[W_EV9]["answers"], by_text(g)[W_SUB]["answers"], by_text(g)[W_SUB]["engines"]) == (0, 1, ["gemini"])
    assert all(x["answers"] == 0 and x["last_measured"] is None for x in old["data"]["items"])
    assert (by_text(hit)[W_EV9]["answers"], by_text(hit)[W_SUB]["answers"]) == (1, 1)


async def test_website_scope_and_filters(client_as):
    async with client_as(KIA_US) as c:
        us = (await c.get("/v1/prompts", params={"surface": "website"})).json()
    assert set(by_text(us)) == {"us kia a", "=1+1 us kia 50%_b"}
    async with client_as(KIA_EU) as c:
        eu = (await c.get("/v1/prompts", params={"surface": "website"})).json()
        leak = (await c.get("/v1/prompts", params={"surface": "website", "country": "US"})).json()
    assert set(by_text(eu)) == {W_EV9, W_DEALS, W_SUB}
    assert leak["data"]["items"] == [] and leak["meta"]["dropped_filters"] == {"country": ["US"]}
    async with client_as(S.WEBSITE_USER) as c:
        web = (await c.get("/v1/prompts", params={"surface": "website"})).json()
    assert set(by_text(web)) == {W_EV9, W_DEALS, W_SUB, "us kia a", "=1+1 us kia 50%_b"}
    async with client_as(ADMIN) as c:
        async def got(**params):
            r = await c.get("/v1/prompts", params={"surface": "website", **params})
            assert r.status_code == 200, r.text
            return r.json()
        assert set(by_text(await got(country="HYUNDAI-N"))) == {"n de"}                 # 가상 브랜드 코드 = 사이트 브랜드
        assert set(by_text(await got(brand="Hyundai"))) == {"kr hy"}                    # 사이트 브랜드 엄격 일치(N 제외)
        assert set(by_text(await got(country="DE"))) == {W_EV9, W_DEALS, W_SUB, "n de"}
        assert set(by_text(await got(lang="en"))) == {"us kia a", "=1+1 us kia 50%_b"}
        assert set(by_text(await got(search="50%_"))) == {"=1+1 us kia 50%_b"}
        assert set(by_text(await got(search="B_X"))) == {"=1+1 us kia 50%_b"}          # target_url ILIKE
        assert set(by_text(await got(measured="true"))) == {W_EV9, W_DEALS, W_SUB}
        ign = await got(depth1="D1", kind="acr", depth4="x")
        assert ign["meta"]["page"]["total"] == 7 and ign["meta"]["ignored_filters"] == ["depth1", "depth4", "kind"]
        empty = await got(lang="ko", country="US")
        assert empty["data"]["items"] == [] and empty["meta"]["page"]["total"] == 0


async def test_website_country_iso_and_virtual_is_union(client_as):
    """catalog #9(core ISO ∪ 가상 합집합, front websiteSiteGeoPred): country=[US, HYUNDAI-N] = US 사이트 ∪ Hyundai N 사이트.
    이전(core 교집합: N 비트 ∧ 국가 US)이면 빈 결과였다. 손계산: S1 Kia US 2행 + S2 Hyundai N DE 1행."""
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params={"surface": "website", "country": ["US", "HYUNDAI-N"]})
        csv_r = await c.get("/v1/prompts", params={"surface": "website", "country": ["US", "HYUNDAI-N"], "format": "csv"})
    assert r.status_code == 200, r.text
    assert set(by_text(r.json())) == {"us kia a", "=1+1 us kia 50%_b", "n de"} and r.json()["meta"]["page"]["total"] == 3
    assert {x["prompt_text"] for x in _csv(csv_r)} == {"us kia a", "'=1+1 us kia 50%_b", "n de"}
    async with client_as(KIA_EU) as c:                                                   # 관점 Kia: N 비트 없음 → ISO 쪽만(US 는 스코프 밖)
        r = await c.get("/v1/prompts", params={"surface": "website", "country": ["DE", "HYUNDAI-N"]})
    assert set(by_text(r.json())) == {W_EV9, W_DEALS, W_SUB}


@pytest.mark.parametrize("sort,dir_,expr", [
    ("prompt", "asc", "left(wp.prompt_text, 256) ASC, wp.website_prompt_id ASC"),
    ("country", "desc", "ws.country_code DESC, wp.website_prompt_id DESC"),
    ("target_url", "asc", "wp.target_url ASC, wp.website_prompt_id ASC"),
])
async def test_website_native_sort_keyset(client_as, sort, dir_, expr):
    expected = [r["website_prompt_id"] for r in await S.q(
        f"SELECT wp.website_prompt_id FROM app.website_prompt wp JOIN app.website_site ws USING (site_id) ORDER BY {expr}")]
    async with client_as(ADMIN) as c:
        got, last, pages = await _all_pages(c, {"surface": "website", "sort": sort, "dir": dir_, "limit": 2}, key="website_prompt_id")
    assert got == expected and pages == 4 and last["meta"]["page"]["total"] == 7


async def test_website_aggregate_sort_keyset_and_stale_cursor(client_as):
    async with client_as(ADMIN) as c:
        got, _, _ = await _all_pages(c, {"surface": "website", "sort": "answers", "dir": "desc", "limit": 3}, key="website_prompt_id")
        first = (await c.get("/v1/prompts", params={"surface": "website", "limit": 3})).json()
        rows = {uuid.UUID(x["website_prompt_id"]): x for x in first["data"]["items"]}
        assert len(got) == 7 and len(set(got)) == 7
        top2 = {x["prompt_text"] for x in first["data"]["items"][:2]}
        assert top2 == {W_EV9, W_SUB} and all(r["answers"] == 1 for r in list(rows.values())[:2])
        cur = first["meta"]["page"]["next_cursor"]
        r = await c.get("/v1/prompts", params={"surface": "website", "limit": 3, "cursor": cur})
        assert r.status_code == 200
        # 세대가 바뀐 뒤의 커서(집계 정렬 = 순위가 흔들린다) → 409 cursor_stale. rd 를 쓰지 않고 이전 세대 커서를 만든다
        old = decode_cursor(cur, sort="last_measured", dir="desc", fh=_fh_of(first), types=("bool", "date", "uuid"))
        stale = encode_cursor(Cursor(sort=old.sort, dir=old.dir, key=old.key, fh=old.fh, g=first["meta"]["generation"] - 1))
        r = await c.get("/v1/prompts", params={"surface": "website", "limit": 3, "cursor": stale})
        assert r.status_code == 409 and r.json()["error"]["code"] == "cursor_stale"


async def _all_items(c, params) -> tuple[list[dict], dict, int]:
    """next_cursor 를 따라 끝까지(무한 반복 방지 상한 20페이지) 모은 행 전체."""
    out, cursor = [], None
    for pages in range(1, 21):
        r = await c.get("/v1/prompts", params={**params, **({"cursor": cursor} if cursor else {})})
        assert r.status_code == 200, r.text
        b = r.json()
        out += b["data"]["items"]
        cursor = b["meta"]["page"]["next_cursor"]
        if not cursor:
            return out, b, pages
    raise AssertionError(f"next_cursor 가 20페이지 안에 끝나지 않음(반복): {params}")


@pytest.mark.parametrize("sort,dir_", [(None, None), ("last_measured", "asc"), ("last_measured", "desc"), ("answers", "asc")])
async def test_website_aggregate_sort_traverses_all_rows_nulls_last(client_as, sort, dir_):
    """검증 D1·D4 회귀: 미측정(NULL) 행이 있는 기본 정렬(last_measured desc)·asc 를 limit=2 로 끝까지 순회하면 total 과 같은 id 집합,
    NULL 은 방향과 무관하게 뒤. (D1 이전: 센티넬 DATE '0001-01-01' 이 asyncpg 에서 -infinity 로 인코딩돼 desc 는 4/7 행에서 끝나고
    asc 는 같은 2행을 끝없이 반복했다.)"""
    params = {"surface": "website", "limit": 2, **({"sort": sort} if sort else {}), **({"dir": dir_} if dir_ else {})}
    all_ids = {r["website_prompt_id"] for r in await S.q("SELECT website_prompt_id FROM app.website_prompt")}
    async with client_as(ADMIN) as c:
        items, last, pages = await _all_items(c, params)
    got = [uuid.UUID(x["website_prompt_id"]) for x in items]
    assert len(got) == len(set(got)) == last["meta"]["page"]["total"] == 7 and set(got) == all_ids and pages == 4
    if sort in (None, "last_measured"):
        lm = [x["last_measured"] for x in items]
        n_set = sum(v is not None for v in lm)
        assert n_set == 2 and all(v is not None for v in lm[:n_set]) and all(v is None for v in lm[n_set:])   # NULL 은 뒤
        desc = (dir_ or "desc") == "desc"
        keyed = [(x["last_measured"] or "", uuid.UUID(x["website_prompt_id"])) for x in items[:n_set]]
        assert keyed == sorted(keyed, reverse=desc)
        tail = [uuid.UUID(x["website_prompt_id"]) for x in items[n_set:]]
        assert tail == sorted(tail, reverse=desc)                              # NULL 끼리는 id(같은 방향)


async def test_website_null_date_cursor_is_real_date(client_as):
    """커서에 실리는 미측정 자리값은 실날짜(1900-01-01)여야 한다(date.min 은 asyncpg -infinity)."""
    async with client_as(ADMIN) as c:
        first = (await c.get("/v1/prompts", params={"surface": "website", "limit": 3})).json()
    cur = decode_cursor(first["meta"]["page"]["next_cursor"], sort="last_measured", dir="desc", fh=_fh_of(first),
                        types=("bool", "date", "uuid"))
    assert cur.key[0] is False and cur.key[1].year == 1900                     # 3번째 행 = 첫 미측정 행


async def test_website_lens_uses_core_visible_window(client_as, monkeypatch):
    """측정 메타 창 = core.cycles.resolve_window(all_visible·ungated): 게이트 없는 측정 회차 전부(catalog #11 메인 결정 = front 현행
    website-sites.ts:386-407). 이전 기대(실날짜 1900-01-01~2999-12-31 범위 + servable·노출일 게이트)에서 바뀐 이유: core 가 all_visible·ungated
    를 지원해 우회를 걷었다. ① 기간 무지정 렌즈가 all_visible·ungated 로 core 창을 부르는지 ② 창이 고른 회차만 측정 메타에 들어가는지
    (창을 비우면 전부 0) ③ 인용 숨김(hidden_scope 2) 회차가 포함되는지를 본다."""
    from app.features.catalog.prompts.catalog import service as svc
    calls: list[dict] = []
    real = svc.resolve_window

    async def spy(conn, **kw):
        calls.append(kw)
        return await real(conn, **kw)
    monkeypatch.setattr(svc, "resolve_window", spy)
    async with client_as(ADMIN) as c:
        for params in ({}, {"sort": "prompt"}):                                        # 모양 B·모양 A
            b = (await c.get("/v1/prompts", params={"surface": "website", **params})).json()
            assert (by_text(b)[W_SUB]["answers"], by_text(b)[W_SUB]["last_measured"]) == (1, "2026-09-18")   # 회차 21 = 인용 숨김, 포함
    assert calls and all((k["surface"], k["date_from"], k["date_to"], k["all_visible"], k["ungated"]) == ("website", None, None, True, True)
                         for k in calls)
    assert all("today" not in k for k in calls)

    async def empty(conn, **kw):                                                         # 창이 회차를 하나도 고르지 않으면 측정 메타 0
        w = await real(conn, **kw)
        return dataclasses.replace(w, cycles=(), keys={f: () for f in w.keys}, round_dates=())
    monkeypatch.setattr(svc, "resolve_window", empty)
    async with client_as(ADMIN) as c:
        for params in ({}, {"sort": "prompt"}):
            b = (await c.get("/v1/prompts", params={"surface": "website", **params})).json()
            assert all((x["answers"], x["last_measured"], x["engines"]) == (0, None, []) for x in b["data"]["items"]), params


@pytest.mark.parametrize("case,values", [
    ("unservable", {"servable": False}),                                  # 비발행
    ("future_view", {"view_date": date(2099, 1, 1)}),                     # 노출일 전(rd.today_kst() 기준 먼 미래)
    ("hidden_all", {"hidden_scope": 1, "hidden_reason": 2}),              # 숨김 all(운영자)
])
async def test_website_lens_ungated_parity(client_as, case, values):
    """catalog #11 현행 패리티: 웹사이트 유일 회차 21(Kia DE 09-18)을 비발행·미래 노출·hidden_scope 1 로 바꿔도 측정 메타에 그대로 든다.
    손계산: ev9? = chatgpt 1건 09-18, sub? = gemini 1건 09-18, deals? = 0. core 발행 창(servable ∧ view_date ≤ 오늘 ∧ hidden ≠ 1)이었다면
    세 경우 모두 answers 0·last_measured null 이다. 기간 렌즈(from/to = 09-18)도 같은 창 규칙(모양 A·B·csv 모두)."""
    async with staged(Update("rd.cycle", {"cyc_key": 21}, values)), client_as(ADMIN) as c:
        for params in ({}, {"sort": "prompt"}, {"from": "2026-09-18", "to": "2026-09-18"}):
            r = await c.get("/v1/prompts", params={"surface": "website", **params})
            assert r.status_code == 200, (case, r.text)
            rows = by_text(r.json())
            got = {t: (rows[t]["answers"], rows[t]["last_measured"], rows[t]["engines"]) for t in (W_EV9, W_SUB, W_DEALS)}
            assert got == {W_EV9: (1, "2026-09-18", ["chatgpt"]), W_SUB: (1, "2026-09-18", ["gemini"]), W_DEALS: (0, None, [])}, (case, params)
        csv_rows = {x["prompt_text"]: x for x in _csv(await c.get("/v1/prompts", params={"surface": "website", "format": "csv"}))}
        assert (csv_rows[W_EV9]["answers"], csv_rows[W_EV9]["last_measured"]) == ("1", "2026-09-18"), case


async def test_website_project_id_unmeasured_site(client_as):
    """검증 D7: 측정 이력 없는(rd.dim_project 행 없는) 사이트로도 좁힐 수 있다. 스코프 밖·없는 사이트는 404(누출 0)."""
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params={"surface": "website", "project_id": str(S.sid(1))})
        assert r.status_code == 200, r.text
        assert set(by_text(r.json())) == {"us kia a", "=1+1 us kia 50%_b"} and r.json()["meta"]["page"]["total"] == 2
        kde = await c.get("/v1/prompts", params={"surface": "website", "project_id": "d0000000-0000-4000-8000-000000000002"})
        scope_pid = await c.get("/v1/prompts", params={"surface": "website", "project_id": "a0000000-0000-4000-8000-000000000002"})
        assert set(by_text(kde.json())) == set(by_text(scope_pid.json())) == {W_EV9, W_DEALS, W_SUB}   # 사이트 id·Scope 프로젝트 id
        csv_r = await c.get("/v1/prompts", params={"surface": "website", "project_id": str(S.sid(1)), "format": "csv"})
        assert {x["prompt_text"] for x in _csv(csv_r)} == {"us kia a", "'=1+1 us kia 50%_b"}
        r = await c.get("/v1/prompts", params={"surface": "website", "project_id": str(uuid.uuid4())})
        assert r.status_code == 404
    async with client_as(KIA_US) as c:
        for pid in ("d0000000-0000-4000-8000-000000000002", str(S.sid(2))):              # Kia DE(국가 밖)·Hyundai N DE(브랜드 밖)
            r = await c.get("/v1/prompts", params={"surface": "website", "project_id": pid})
            assert r.status_code == 404, (pid, r.text)
        r = await c.get("/v1/prompts", params={"surface": "website", "project_id": str(S.sid(1))})
        assert r.status_code == 200 and r.json()["meta"]["page"]["total"] == 2


async def test_website_project_id_with_mismatched_country_is_empty_not_404(client_as):
    """검증 catalog N1 회귀: 스코프 안 사이트(project_id)에 요청 국가가 어긋나면 404 '사이트 없음' 이었다(스코프 밖·없는 사이트와 구별 불가).
    지금은 404 를 스코프(브랜드·스코프 국가)만으로 판정하고, 요청 국가는 행 필터라 200 빈 목록이다(core 해석과 같은 의미)."""
    kia_de = "d0000000-0000-4000-8000-000000000002"
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params={"surface": "website", "project_id": kia_de, "country": "US"})
        assert r.status_code == 200, r.text
        assert r.json()["data"]["items"] == [] and r.json()["meta"]["page"]["total"] == 0
        csv_r = await c.get("/v1/prompts", params={"surface": "website", "project_id": kia_de, "country": "US", "format": "csv"})
        assert csv_r.status_code == 200 and _csv(csv_r) == []
        r = await c.get("/v1/prompts", params={"surface": "website", "project_id": kia_de, "country": "DE"})
        assert set(by_text(r.json())) == {W_EV9, W_DEALS, W_SUB}
        r = await c.get("/v1/prompts", params={"surface": "website", "project_id": kia_de, "brand": "Hyundai"})
        assert r.status_code == 404                                                                   # 브랜드 밖은 core 와 같게 404
    async with client_as(KIA_EU) as c:
        r = await c.get("/v1/prompts", params={"surface": "website", "project_id": kia_de, "country": "US"})     # 스코프 밖 국가 요청
        assert r.status_code == 200 and r.json()["data"]["items"] == [] and r.json()["meta"]["dropped_filters"] == {"country": ["US"]}
    async with client_as(KIA_US) as c:
        r = await c.get("/v1/prompts", params={"surface": "website", "project_id": kia_de, "country": "US"})     # 사이트가 스코프 밖
        assert r.status_code == 404


def test_openapi_documents_cursor_stale_409():
    """검증 D6: 모양 B 는 세대 변경 시 409 cursor_stale 을 낸다 → OpenAPI 에 409 가 있어야 한다."""
    from app.main import app
    responses = app.openapi()["paths"]["/v1/prompts"]["get"]["responses"]
    assert {"200", "401", "403", "404", "409", "422"} <= set(responses)


# ════════════════════════════════════════════════════════════════════════════
# 권한·검증
# ════════════════════════════════════════════════════════════════════════════
async def test_route_gates(client_as):
    for surface in ("global", "website"):
        async with client_as(VENDOR) as c:
            r = await c.get("/v1/prompts", params={"surface": surface})
        assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
        async with client_as(None) as c:
            assert (await c.get("/v1/prompts", params={"surface": surface})).status_code == 401
        async with client_as(SUSPENDED) as c:
            r = await c.get("/v1/prompts", params={"surface": surface})
        assert r.status_code == 401 and r.json()["error"]["code"] == "no_account"
    async with client_as(S.WEBSITE_USER) as c:
        r = await c.get("/v1/prompts", params={"surface": "global"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    async with client_as(HQ_HYUNDAI) as c:                                        # 메뉴 그룹 {standard, project}
        r = await c.get("/v1/prompts", params={"surface": "website"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"


@pytest.mark.parametrize("params", [
    {}, {"surface": "project"}, {"surface": "nope"}, {"surface": "global", "limit": 0}, {"surface": "global", "limit": 501},
    {"surface": "website", "limit": 201}, {"surface": "website", "sort": "bogus"}, {"surface": "website", "dir": "up"},
    {"surface": "global", "from": "2026-09-02", "to": "2026-09-01"}, {"surface": "global", "kind": "x"}, {"surface": "global", "format": "pdf"},
    {"surface": "global", "cursor": "garbage"}, {"surface": "global", "measured": "maybe"},
])
async def test_invalid_params_422(client_as, params):
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params=params)
    assert r.status_code == 422, r.text


async def test_cursor_bound_to_filters(client_as):
    async with client_as(ADMIN) as c:
        b = (await c.get("/v1/prompts", params={"surface": "global", "limit": 2})).json()
        cur = b["meta"]["page"]["next_cursor"]
        r = await c.get("/v1/prompts", params={"surface": "global", "limit": 2, "brand": "Kia", "cursor": cur})
        assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"
        w = (await c.get("/v1/prompts", params={"surface": "website", "limit": 2, "sort": "prompt"})).json()
        r = await c.get("/v1/prompts", params={"surface": "website", "limit": 2, "sort": "brand", "cursor": w["meta"]["page"]["next_cursor"]})
        assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"


# ════════════════════════════════════════════════════════════════════════════
# 내보내기
# ════════════════════════════════════════════════════════════════════════════
def _csv(r) -> list[dict]:
    assert r.content.startswith(b"\xef\xbb\xbf")
    return list(csv.DictReader(io.StringIO(r.content.decode("utf-8-sig"))))


async def _audit_count(action: str) -> int:
    await get_audit_writer().flush()
    async with get_db().read("admin_long") as c:
        from app.core.db import fetch_val
        return int(await fetch_val(c, "SELECT count(*) FROM app.access_audit_log WHERE actor_id = :a AND action = :x AND kind = 'download'",
                                   {"a": ADMIN, "x": action}))


async def test_export_csv_global_and_audit(client_as):
    before = await _audit_count("catalog.prompts.export")
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params={"surface": "global", "format": "csv", "limit": 1, "cursor": "ignored-for-export"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv") and "attachment" in r.headers["content-disposition"]
    assert "x-export-truncated" not in r.headers and r.headers["cache-control"] == "no-store"
    rows = _csv(r)
    expected = [r["prompt_id"] for r in await S.q(
        "SELECT prompt_id FROM app.prompt WHERE project_id = $1 AND deleted_at IS NULL "
        "ORDER BY depth1 ASC NULLS LAST, depth2 ASC NULLS LAST, depth3 ASC NULLS LAST, text, prompt_id", uuid.UUID(S.ROOT))]
    assert list(rows[0]) == list(GLOBAL_COLUMNS) and [uuid.UUID(x["prompt_id"]) for x in rows] == expected    # 같은 정렬, cursor·limit 무시
    g1 = next(x for x in rows if x["prompt_id"] == str(G(1)))
    assert (g1["regions"], g1["measured"], g1["depth4"]) == ("KR", "false", "D4x")
    assert await _audit_count("catalog.prompts.export") == before + 1


async def test_export_csv_website_injection_guard_and_scope(client_as):
    async with client_as(KIA_US) as c:
        r = await c.get("/v1/prompts", params={"surface": "website", "format": "csv"})
    rows = _csv(r)
    assert {x["prompt_text"] for x in rows} == {"us kia a", "'=1+1 us kia 50%_b"}              # 수식 주입 무력화, 스코프 동일
    assert rows[0].keys() >= {"answers", "last_measured", "engines"}


@pytest.mark.parametrize("value,expected", [
    (["=HYPERLINK(\"http://x\")", "KR"], "'=HYPERLINK(\"http://x\");KR"),
    (["+1", "US"], "'+1;US"),
    (["KR", "=1+1"], "KR;=1+1"),                       # 셀 첫 글자만 수식 판정 대상
    ({"=a": 1}, '{"=a": 1}'),
    ("@SUM(A1)", "'@SUM(A1)"),
    (-5, "-5"),                                        # 숫자형은 수식이 아니다
    (None, ""),
])
def test_csv_formula_guard_any_type(value, expected):
    """검증 D3: 수식 주입 가드는 원값 형과 무관하게 직렬화된 셀 문자열에 건다(리스트·dict 포함). #2 로 기능 export.py 를 core.export 로 대체(같은 규칙)."""
    from app.core.export import csv_chunks, csv_safe
    assert csv_safe(value) == expected
    body = b"".join(csv_chunks(["regions"], [{"regions": value}])).decode("utf-8-sig")
    assert list(csv.reader(io.StringIO(body)))[1] == [expected]


async def test_export_xlsx_and_truncation(client_as, monkeypatch):
    async with client_as(ADMIN) as c:
        r = await c.get("/v1/prompts", params={"surface": "website", "format": "xlsx"})
        assert r.status_code == 200 and r.headers["content-type"].startswith("application/vnd.openxmlformats")
        assert r.headers["cache-control"] == "no-store" and 'filename="prompts-website.xlsx"' in r.headers["content-disposition"]
        z = zipfile.ZipFile(io.BytesIO(r.content))                             # core.export xlsx = 스트리밍 응답(본문 전체를 모아 읽는다)
        sheet = z.read("xl/worksheets/sheet1.xml").decode()
        assert sheet.count("<row ") == 8 and "ev9?" in sheet and "=1+1 us kia 50%_b" in sheet and "<f>" not in sheet
        assert {"[Content_Types].xml", "xl/workbook.xml"} <= set(z.namelist())
        monkeypatch.setattr(CQ, "EXPORT_MAX_ROWS", 2)
        r = await c.get("/v1/prompts", params={"surface": "global", "format": "csv"})
        assert r.headers.get("x-export-truncated") == "true" and len(_csv(r)) == 2
