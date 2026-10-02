"""결과 캐시(core.result_cache, DB-v2.11 P66~P68) 시험.

1) 허용 목록 = 표식 끝점(명시), 제외 끝점은 표식 없음. 캐시 대상 기능 코드는 계정 속성을 읽지 않는다(정적: 키에 계정 속성이 없어도 되는 근거).
2) 끔(HGH_RESULT_CACHE=0) = 캐시 문장·헤더가 하나도 없다. 켬 = 허용 목록 전 끝점 × 대표 파라미터에서 끔 바이트 = 미스 바이트 = 적중 바이트.
3) 보안: 스코프가 다른 계정은 같은 쿼리여도 서로의 캐시를 받지 않는다(교차), 거부 계정은 적중하지 않고 원래 403·404, 해석 스코프가
   같은 계정끼리는 공유한다.
4) 버전 요소(세대·judgment_change·app 표 카운터·KST 날짜·빌드·KPI 기준일 교체)가 바뀌면 미스, 되돌리면 다시 적중.
   적재기 register_projects(finalize 없음)가 새 웹사이트 사이트를 rd.dim_project 에 넣으면 미스(검증 D1 재현).
5) single-flight(동시 같은 키 계산 1회), 조회·저장 실패는 응답에 영향 없음, DB 함수 권한·상한·정리·트리거·저장 크기 누적 정합(동시 저장).
6) 키 공간 상한: 선언 밖 쿼리 파라미터 요청은 캐시를 거치지 않고, dropped_filters 가 있는 응답은 저장하지 않는다. prod 는 헤더 없음.
"""
from __future__ import annotations

import ast
import asyncio
import hashlib
import importlib
import json
import pathlib
import uuid

import asyncpg
import pytest

from app.core import result_cache as rc
from app.core.config import get_settings, set_settings
from app.features import FEATURE_ROUTERS
from tests.core.rcache_calls import BACK, Stmts, all_calls, feature_routes, get, materialize, resolve_skey, warm_calls
from tests.core.rcache_writers import tracked_tables
from tests.support import (
    ADMIN,
    CUST_PROJECT,
    DB_URL,
    HQ_HYUNDAI,
    KIA_EU,
    KIA_US,
    TODAY,
    VENDOR,
    WEBSITE_KIA,
    Rows,
    Sql,
    Update,
    needs_db,
    staged,
)

P = str(CUST_PROJECT)

# 허용 목록 밖으로 둔 분석 GET 과 사유(DECISIONS-API.md "결과 캐시" 표와 같다)
EXCLUDED = {
    ("GET", "/v1/mentions/prompts"): "rd.v_answer_mention_raw(ing.mention 뷰, terms=true)를 읽는다: 세대로 덮이지 않는다",
    ("GET", "/v1/funnel/conversion"): "rd.ga4_row·ga4_dim_property: 이 레포 적재 경로가 세대를 올리지 않는다",
    ("GET", "/v1/funnel/conversion/events"): "can_edit(요청자 편집 가능 여부) 개인 필드",
    ("GET", "/v1/citations/domains/export"): "파일 스트림·다운로드 접근 감사",
    ("GET", "/v1/answers"): "답변 원문 드릴다운(접근 감사 대상 경로와 한 묶음), 결정 범위 밖",
    ("GET", "/v1/answers/{job_id}"): "답변 원문 접근 감사(data_access)",
}


async def owner() -> asyncpg.Connection:
    return await asyncpg.connect(DB_URL)

async def invalidate() -> None:
    c = await owner()
    try:
        await c.fetchval("SELECT app.result_cache_invalidate()")
    finally:
        await c.close()


# ════════════════════════════════════════════════════════════════════════════
# 1) 허용 목록·정적 규칙
# ════════════════════════════════════════════════════════════════════════════
def test_allowlist_equals_marked_routes_and_excludes_personal_paths():
    marked = rc.cacheable_routes(feature_routes())
    assert marked == sorted(rc.ALLOWLIST), sorted(set(marked) ^ set(rc.ALLOWLIST))
    assert len(set(rc.ALLOWLIST)) == len(rc.ALLOWLIST) == 18
    assert not set(EXCLUDED) & set(rc.ALLOWLIST)
    all_get = {(m, r.path_format) for r in feature_routes() for m in (getattr(r, "methods", None) or ())}
    assert set(EXCLUDED) <= all_get
    for m, path in rc.ALLOWLIST:
        assert m == "GET" and path.startswith("/v1/") and not path.startswith(("/v1/admin", "/v1/qa", "/v1/projects", "/v1/me/", "/v1/auth/"))


def test_decorator_outside_allowlist_is_rejected():
    from fastapi import APIRouter

    r = APIRouter(route_class=rc.CachedRoute)
    with pytest.raises(RuntimeError, match="허용 목록 밖"):
        @r.get("/v1/admin/users")
        @rc.result_cache()
        async def _x() -> dict:
            return {}


PRINCIPAL_ATTRS = {"role", "operator", "menu_groups", "user_id", "email", "display_name", "is_qa_reviewer", "is_admin",
                   "scope_all", "scope_brands", "scope_regions", "scope_countries", "principal", "regions", "raw_countries"}


def _cached_feature_files() -> list[pathlib.Path]:
    mods = {importlib.import_module(mod).__file__ for fid, mod in FEATURE_ROUTERS}
    dirs = set()
    for r in feature_routes():
        if getattr(getattr(r, "endpoint", None), "__hgh_result_cache__", None) is not None:
            dirs.add(pathlib.Path(importlib.import_module(r.endpoint.__module__).__file__).parent)
    assert mods and len(dirs) == 16
    return sorted(f for d in dirs for f in d.glob("*.py"))


def test_cached_features_do_not_read_principal_attributes():
    """키에 계정 속성(역할·운영자·메뉴·이메일·user_id·권역 원값)이 없어도 되는 근거: 캐시 대상 기능 코드가 그 속성을 읽지 않는다.
    계정 → 결과는 core.filters.resolve_read_context(DataScope·표면 게이트·resolve_project)만 거친다. 시장 지도 게이트(shows_geo_map)는
    /v1/geo 표식(geo_gate=True)이 서명에 넣는다. 새 기능 코드가 이 속성을 읽으면 여기서 멈춘다(키에 넣거나 허용 목록에서 뺀다)."""
    hits = []
    for f in _cached_feature_files():
        for n in ast.walk(ast.parse(f.read_text(encoding="utf-8"))):
            if isinstance(n, ast.Attribute) and n.attr in PRINCIPAL_ATTRS:
                hits.append(f"{f.relative_to(BACK)}:{n.lineno} .{n.attr}")
    assert hits == [], hits
    geo = (BACK / "app/features/analytics/geo/markets/service.py").read_text(encoding="utf-8")
    assert "shows_geo_map(p)" in geo
    router = (BACK / "app/features/analytics/geo/markets/router.py").read_text(encoding="utf-8")
    assert "@result_cache(geo_gate=True)" in router


def test_key_parts():
    from starlette.datastructures import QueryParams

    q = QueryParams("surface=global&metrics=b&top=3&metrics=a&brand=Kia")
    assert rc.query_items(q) == [["brand", "Kia"], ["metrics", "b"], ["metrics", "a"], ["surface", "global"], ["top", "3"]]
    base = dict(method="GET", route="/v1/trend", path_params={}, query=rc.query_items(q), signature={"all": True}, extra={}, build="b1")
    k0 = rc.key_prefix(**base)
    assert len(k0) == 32 and rc.key_prefix(**base) == k0
    for change in ({"route": "/v1/geo"}, {"query": rc.query_items(QueryParams("surface=global&metrics=a&metrics=b&top=3&brand=Kia"))},
                   {"signature": {"all": False}}, {"extra": {"today": "2026-09-27"}}, {"build": "b2"}, {"path_params": {"skey": "x"}}):
        assert rc.key_prefix(**{**base, **change}) != k0, change
    assert rc.cache_key(k0, "v1") == hashlib.sha256(k0 + b"v1").digest()


def test_merged_ddl_is_v210_plus_patch():
    db = BACK / "db"
    merged = (db / "DB-v2.11.sql").read_bytes()
    assert merged == (db / "DB-v2.10.sql").read_bytes() + (db / "DB-v2.11-patch.sql").read_bytes()


# ════════════════════════════════════════════════════════════════════════════
# 2) 끔·동치
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_off_has_no_cache_path(client_as, rcache_db):
    assert get_settings().result_cache is False                       # 코드 기본값 = 끔
    with Stmts() as st:
        r = await get(client_as, ADMIN, "/v1/trend", {"surface": "global"})
    assert r.status_code == 200 and rc.HEADER.lower() not in {k.lower() for k in r.headers}
    assert not [s for s in st.seen if "result_cache" in s], "끔인데 캐시 문장이 실행됐다"


@needs_db
async def test_bytes_equal_off_miss_hit_all_allowlisted(client_as, cache_on):
    """허용 목록 전 끝점 × 대표 파라미터(기본 화면 34 + 변형): 캐시 끔 바이트 = 미스 바이트 = 적중 바이트, 헤더 miss → hit."""
    skey = await resolve_skey(client_as)
    await invalidate()
    calls = [(u, materialize(p, skey), prm) for u, p, prm in all_calls()]
    off = {}
    s_on = get_settings()
    set_settings(s_on.model_copy(update={"result_cache": False}))
    try:
        for i, (u, path, prm) in enumerate(calls):
            r = await get(client_as, u, path, prm)
            assert r.status_code == 200, (path, prm, r.text[:300])
            assert rc.HEADER.lower() not in {k.lower() for k in r.headers}
            off[i] = r.content
    finally:
        set_settings(s_on)
    seen_routes = set()
    bad = []
    for i, (u, path, prm) in enumerate(calls):
        r1 = await get(client_as, u, path, prm)
        r2 = await get(client_as, u, path, prm)
        stored = not rc.has_dropped_filters(off[i])                   # 버려진 값이 있는 요청은 저장하지 않는다(키 공간 상한)
        if not (r1.status_code == r2.status_code == 200 and r1.content == off[i] == r2.content
                and r2.headers.get(rc.HEADER) == ("hit" if stored else "miss") and r1.headers.get(rc.HEADER) in ("miss", "hit")):
            bad.append((path, prm, r1.status_code, r1.headers.get(rc.HEADER), r2.headers.get(rc.HEADER), r1.content == off[i]))
        if r1.headers.get(rc.HEADER) == "miss":
            assert r2.headers["content-type"] == r1.headers["content-type"] == "application/json"
        route = path if "domains/" not in path else "/v1/citations/domains/{skey}"
        seen_routes.add(route)
    assert bad == [], bad
    assert {p for _, p in rc.ALLOWLIST} <= seen_routes, sorted({p for _, p in rc.ALLOWLIST} - seen_routes)


# ════════════════════════════════════════════════════════════════════════════
# 3) 보안: 교차·거부·공유
# ════════════════════════════════════════════════════════════════════════════
GLOBAL_ACCOUNTS = (ADMIN, HQ_HYUNDAI, KIA_US, KIA_EU)
WEBSITE_ACCOUNTS = (ADMIN, WEBSITE_KIA, KIA_US, KIA_EU)
PROJECT_ACCOUNTS = (ADMIN, VENDOR, HQ_HYUNDAI)


def _cross_matrix() -> list[tuple[str, dict, tuple]]:
    out = []
    for path, prm in warm_calls():
        accts = GLOBAL_ACCOUNTS if prm["surface"] == "global" else WEBSITE_ACCOUNTS
        out.append((path, prm, accts))
    for path, prm in (("/v1/trend", {"surface": "project", "project_id": P}), ("/v1/kpi/summary", {"surface": "project", "project_id": P}),
                      ("/v1/mentions/brands", {"surface": "project", "project_id": P}),
                      ("/v1/filters/options", {"surface": "project", "project_id": P})):
        out.append((path, prm, PROJECT_ACCOUNTS))
    return out


@needs_db
async def test_cross_scope_accounts_never_share_entries(client_as, cache_on):
    """서로 다른 해석 스코프(전체·현대·기아 US·기아 서유럽 권역·웹사이트 기아·프로젝트 멤버 vendor)의 계정이 같은 쿼리를 보내도
    남의 캐시를 받지 않는다: 각 계정 첫 호출 = miss 이고 바이트 = 그 계정 캐시 끔 바이트, 두 번째 = hit 이고 같은 바이트."""
    await invalidate()
    matrix = _cross_matrix()
    s_on = get_settings()
    off: dict[tuple[int, uuid.UUID], bytes] = {}
    set_settings(s_on.model_copy(update={"result_cache": False}))
    try:
        for i, (path, prm, accts) in enumerate(matrix):
            ok = []
            for u in accts:
                r = await get(client_as, u, path, prm)
                if r.status_code == 200:                              # 게이트 거부 계정(예: /v1/geo 의 country 역할)은 거부 시험이 본다
                    off[(i, u)] = r.content
                    ok.append(u)
            assert len(ok) >= 2, (path, prm)
            matrix[i] = (path, prm, tuple(ok))
    finally:
        set_settings(s_on)
    differing = 0
    for i, (path, prm, accts) in enumerate(matrix):
        differing += len({off[(i, u)] for u in accts}) > 1
        for u in accts:                                               # 한 계정씩 채운다: 뒤 계정은 앞 계정 행이 있는 상태에서 조회
            r = await get(client_as, u, path, prm)
            assert (r.status_code, r.headers.get(rc.HEADER)) == (200, "miss"), (u, path, prm, r.headers.get(rc.HEADER))
            assert r.content == off[(i, u)], (u, path, prm)
        for u in reversed(accts):
            r = await get(client_as, u, path, prm)
            assert (r.status_code, r.headers.get(rc.HEADER)) == (200, "hit"), (u, path, prm)
            assert r.content == off[(i, u)], (u, path, prm)
    assert differing >= 20, f"계정별 응답이 다른 호출이 {differing}개뿐: 교차 시험이 스코프 차이를 보지 못한다"


async def _temp_account(scope_brands: list[str], scope_regions: list[str], scope_countries: list[str], role: str,
                        menu: list[str] | None = None) -> uuid.UUID:
    uid = uuid.uuid4()
    c = await owner()
    try:
        await c.execute("SELECT set_config('app.actor_id', $1, false)", str(ADMIN))
        await c.execute("INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands, scope_regions, scope_countries, "
                        "menu_groups, status) VALUES ($1, $2, $3, 'none', false, $4, $5, $6, $7::text[]::app.menu_group[], 'active')",
                        uid, f"t-rcache-{uid}@example.test", role, scope_brands, scope_regions, scope_countries, menu)
    finally:
        await c.close()
    return uid


async def _drop_account(uid: uuid.UUID) -> None:
    c = await owner()
    try:
        await c.execute("SELECT set_config('app.actor_id', $1, false)", str(ADMIN))
        await c.execute("DELETE FROM app.user_account WHERE user_id = $1", uid)
    finally:
        await c.close()


@needs_db
async def test_denied_accounts_never_hit(client_as, cache_on):
    """게이트 거부 계정은 캐시를 조회하지 않고 원래 오류를 받는다(적중 행이 있어도)."""
    await invalidate()
    cases = [
        (ADMIN, WEBSITE_KIA, "/v1/trend", {"surface": "global"}, 403),                         # website 역할 → global 거부
        (ADMIN, VENDOR, "/v1/kpi/summary", {"surface": "global"}, 403),                         # vendor → 표준 경로 거부
        (ADMIN, HQ_HYUNDAI, "/v1/filters/options", {"surface": "website"}, 403),                # 메뉴 standard·project → website 거부
        (ADMIN, KIA_US, "/v1/trend", {"surface": "project", "project_id": P}, 404),             # 기아 US: 현대 US 프로젝트 비가시
        (VENDOR, KIA_EU, "/v1/kpi/summary", {"surface": "project", "project_id": P}, 404),
        (ADMIN, KIA_US, "/v1/geo", {"surface": "global"}, 403),                                 # 시장 지도 게이트(country 역할)
    ]
    # 해석 스코프 서명이 허용 계정과 **같은** 거부 계정(서명에 역할·메뉴·멤버십 원값이 없으므로 게이트가 조회보다 먼저여야 한다)
    web_h = await _temp_account(["Hyundai"], [], [], "website")              # website 역할: global 경로 밖, 서명 = HQ_HYUNDAI 와 같음
    menu_h = await _temp_account(["Hyundai"], [], [], "hq", menu=["project"])  # 메뉴에 standard 없음
    vend_x = await _temp_account([], [], [], "vendor")                        # 비멤버 vendor: VENDOR(멤버)와 DataScope 같음, 프로젝트 비가시
    kia_hq_us = await _temp_account(["Kia"], [], ["US"], "hq")                # KIA_US(country)와 DataScope 같음, 시장 지도 게이트만 다름
    cases += [
        (HQ_HYUNDAI, web_h, "/v1/trend", {"surface": "global"}, 403),
        (HQ_HYUNDAI, menu_h, "/v1/kpi/summary", {"surface": "global"}, 403),
        (VENDOR, vend_x, "/v1/trend", {"surface": "project", "project_id": P}, 404),
        (kia_hq_us, KIA_US, "/v1/geo", {"surface": "global"}, 403),
    ]
    try:
        for warm, u, path, prm, status in cases:
            r0 = await get(client_as, warm, path, prm)
            assert r0.status_code == 200 and r0.headers.get(rc.HEADER) in ("miss", "hit"), (warm, path, r0.status_code)
            r = await get(client_as, u, path, prm)
            assert r.status_code == status, (u, path, r.status_code, r.text[:200])
            assert rc.HEADER.lower() not in {k.lower() for k in r.headers}
            assert r.json()["error"]["code"]
    finally:
        for uid in (web_h, menu_h, vend_x, kia_hq_us):
            await _drop_account(uid)


@needs_db
async def test_same_resolved_scope_shares_entry(client_as, cache_on):
    """해석 스코프가 같은 계정끼리는 공유한다: 메뉴가 달라도(현대 hq 두 계정), 역할·표기가 달라도(권역 kia-western-europe region ↔ 그 권역을
    전개한 국가 목록 country) 같은 행을 쓴다."""
    await invalidate()
    c = await owner()
    try:
        region_countries = [r["country_code"] for r in await c.fetch(
            "SELECT country_code FROM app.rhq_region_country WHERE region_id = 'kia-western-europe' ORDER BY country_code")]
    finally:
        await c.close()
    assert region_countries
    twin_h = await _temp_account(["Hyundai"], [], [], "hq")                   # 메뉴 무제한(HQ_HYUNDAI 는 standard·project)
    twin_k = await _temp_account(["Kia"], [], region_countries, "country")
    try:
        for base, twin, path, prm in ((HQ_HYUNDAI, twin_h, "/v1/trend", {"surface": "global", "dimension": "brand", "split_own": "true"}),
                                      (HQ_HYUNDAI, twin_h, "/v1/mentions/brands", {"surface": "global", "top_n": "20"}),
                                      (KIA_EU, twin_k, "/v1/kpi/summary", {"surface": "global"})):
            r1 = await get(client_as, base, path, prm)
            r2 = await get(client_as, twin, path, prm)
            assert (r1.headers.get(rc.HEADER), r2.headers.get(rc.HEADER)) == ("miss", "hit"), (path, twin)
            assert r1.content == r2.content
            s_on = get_settings()
            set_settings(s_on.model_copy(update={"result_cache": False}))
            try:
                assert (await get(client_as, twin, path, prm)).content == r2.content        # 공유 바이트 = 그 계정이 직접 계산한 바이트
            finally:
                set_settings(s_on)
    finally:
        await _drop_account(twin_h)
        await _drop_account(twin_k)


# ════════════════════════════════════════════════════════════════════════════
# 4) 버전 요소
# ════════════════════════════════════════════════════════════════════════════
D6 = ("/v1/trend", {"surface": "global", "bucket": "cycle", "dimension": "none",
                    "metrics": ["visibility", "share_of_voice", "sentiment", "position", "citation_share"]})


@needs_db
async def test_version_elements_turn_hit_into_miss(client_as, cache_on):
    await invalidate()
    path, prm = D6
    assert (await get(client_as, ADMIN, path, prm)).headers.get(rc.HEADER) == "miss"
    assert (await get(client_as, ADMIN, path, prm)).headers.get(rc.HEADER) == "hit"
    c = await owner()
    try:
        gen = await c.fetchval("SELECT generation FROM rd.surface_generation WHERE surface = 1")
    finally:
        await c.close()
    steps = {
        "generation": (Update("rd.surface_generation", {"surface": 1}, {"generation": gen + 1}),),
        "judgment_change": (Rows("app.judgment_change", [{"kind": "hidden_market", "payload": "{}"}]),),
        "app_table": (Rows("app.hidden_market", [{"surface": "global", "country_code": "ZZ", "reason": "rcache-test"}]),),
        "kst_date": (Sql("CREATE OR REPLACE FUNCTION rd.today_kst() RETURNS date LANGUAGE sql STABLE AS $f$ SELECT DATE '2031-01-01' $f$"),),
        "other_surface_generation": (Update("rd.surface_generation", {"surface": 2}, {"generation": gen + 7}),),
    }
    for name, st in steps.items():
        async with staged(*st, actor=ADMIN):
            r = await get(client_as, ADMIN, path, prm)
            assert (r.status_code, r.headers.get(rc.HEADER)) == (200, "miss"), name
        r = await get(client_as, ADMIN, path, prm)                   # 되돌리면(롤백) 원래 버전 = 원래 행
        assert r.headers.get(rc.HEADER) == "hit", name
    s = get_settings()
    set_settings(s.model_copy(update={"build_id": "rcache-test-build"}))
    try:
        assert (await get(client_as, ADMIN, path, prm)).headers.get(rc.HEADER) == "miss"
    finally:
        set_settings(s)
    assert (await get(client_as, ADMIN, path, prm)).headers.get(rc.HEADER) == "hit"


@needs_db
async def test_kpi_today_override_is_part_of_key(client_as, cache_on):
    from app.features.analytics.kpi.summary.shared import kpi_today
    from app.main import app

    await invalidate()
    prm = {"surface": "global"}
    assert (await get(client_as, ADMIN, "/v1/kpi/summary", prm)).headers.get(rc.HEADER) == "miss"
    app.dependency_overrides[kpi_today] = lambda: TODAY
    try:
        r = await get(client_as, ADMIN, "/v1/kpi/summary", prm)
        assert r.headers.get(rc.HEADER) == "miss"
        assert (await get(client_as, ADMIN, "/v1/kpi/summary", prm)).headers.get(rc.HEADER) == "hit"
    finally:
        app.dependency_overrides.pop(kpi_today, None)
    assert (await get(client_as, ADMIN, "/v1/kpi/summary", prm)).headers.get(rc.HEADER) == "hit"


# ════════════════════════════════════════════════════════════════════════════
# 5) single-flight·실패 격리
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_single_flight_computes_once(client_as, cache_on, monkeypatch):
    from app.features.analytics.trend.series import service

    await invalidate()
    real = service.get_trend
    calls = {"n": 0}

    async def slow(*a, **kw):
        calls["n"] += 1
        await asyncio.sleep(0.3)
        return await real(*a, **kw)

    monkeypatch.setattr(service, "get_trend", slow)
    prm = {"surface": "global", "dimension": "engine"}
    rs = await asyncio.gather(*[get(client_as, ADMIN, "/v1/trend", prm) for _ in range(4)])
    assert calls["n"] == 1
    assert sorted(r.headers.get(rc.HEADER) for r in rs) == ["hit", "hit", "hit", "miss"]
    assert len({r.content for r in rs}) == 1 and all(r.status_code == 200 for r in rs)
    assert rc._inflight == {}


@needs_db
async def test_lookup_and_put_failures_do_not_break_requests(client_as, cache_on, monkeypatch):
    await invalidate()
    path, prm = "/v1/mentions/types", {"surface": "global"}
    s_on = get_settings()
    set_settings(s_on.model_copy(update={"result_cache": False}))
    try:
        want = (await get(client_as, ADMIN, path, prm)).content
    finally:
        set_settings(s_on)
    monkeypatch.setattr(rc, "_LOOKUP_SQL", "SELECT data_version, codec, body FROM app.result_cache_lookup_missing(:prefix)")
    r = await get(client_as, ADMIN, path, prm)                        # 조회 실패 = SAVEPOINT 되돌림, 캐시 없이 계산
    assert r.status_code == 200 and r.content == want and rc.HEADER.lower() not in {k.lower() for k in r.headers}
    monkeypatch.undo()
    monkeypatch.setattr(rc, "_PUT_SQL", "SELECT app.result_cache_put_missing(:k, :route, :dv, :codec, :body, :n)")
    for _ in range(2):                                                # 저장 실패 = 응답은 그대로, 다음 요청도 미스
        r = await get(client_as, ADMIN, path, prm)
        assert (r.status_code, r.headers.get(rc.HEADER), r.content) == (200, "miss", want)


# ════════════════════════════════════════════════════════════════════════════
# DB 함수·트리거(DB-v2.11)
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_db_privileges_and_limits(rcache_db):
    c = await owner()
    try:
        tr = c.transaction()
        await tr.start()
        try:
            await c.execute("SELECT set_config('role', 'api_ro', true)")
            for sql in ("SELECT * FROM rcache.entry", "SELECT * FROM rcache.data_version", "SELECT app.result_cache_invalidate()"):
                with pytest.raises(asyncpg.InsufficientPrivilegeError):
                    async with c.transaction():
                        await c.execute(sql)
            k = hashlib.sha256(b"rcache-limits").digest()
            assert await c.fetchval("SELECT app.result_cache_put($1, 'r', 'v', 'identity', $2, 1)", k, b"x" * (4 * 1024 * 1024 + 1)) is False
            with pytest.raises(asyncpg.InvalidParameterValueError):
                async with c.transaction():
                    await c.fetchval("SELECT app.result_cache_put($1, 'r', 'v', 'identity', $2, 1)", b"short", b"x")
            with pytest.raises(asyncpg.InvalidParameterValueError):
                async with c.transaction():
                    await c.fetchval("SELECT app.result_cache_put($1, 'r', 'v', 'gzip', $2, 1)", k, b"x")
            await c.execute("SELECT set_config('role', 'api_rw', true)")
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                async with c.transaction():
                    await c.fetchval("SELECT app.result_cache_put($1, 'r', 'v', 'identity', $2, 1)", k, b"x")
            await c.execute("SELECT set_config('role', 'migrator', true)")
            assert await c.fetchval("SELECT app.result_cache_invalidate()") >= 0
        finally:
            await tr.rollback()
    finally:
        await c.close()


@needs_db
async def test_db_put_prunes_old_versions_and_lookup_matches_python_key(rcache_db):
    c = await owner()
    try:
        tr = c.transaction()
        await tr.start()
        try:
            await c.execute("DELETE FROM rcache.entry")
            old_k, young_k = hashlib.sha256(b"old").digest(), hashlib.sha256(b"young").digest()
            await c.execute("INSERT INTO rcache.entry (cache_key, route, data_version, codec, body, body_bytes, stored_bytes, created_at) VALUES "
                            "($1, 'r', 'v-old', 'identity', '\\x01', 1, 1, now() - interval '11 minutes'), "
                            "($2, 'r', 'v-old', 'identity', '\\x01', 1, 1, now() - interval '1 minute')", old_k, young_k)
            await c.execute("SELECT set_config('role', 'api_ro', true)")
            dv = await c.fetchval("SELECT app.result_cache_version()")
            prefix = hashlib.sha256(b"prefix").digest()
            key = rc.cache_key(prefix, dv)
            assert await c.fetchval("SELECT app.result_cache_put($1, 'r', $2, 'identity', $3, 3)", key, dv, b"abc") is True
            assert await c.fetchval("SELECT app.result_cache_put($1, 'r', $2, 'identity', $3, 3)", key, dv, b"zzz") is True   # 같은 키 = 그대로
            row = await c.fetchrow("SELECT * FROM app.result_cache_lookup($1)", prefix)
            assert (row["data_version"], row["codec"], bytes(row["body"])) == (dv, "identity", b"abc")
            await c.execute("SELECT set_config('role', 'none', true)")
            left = {bytes(r[0]) for r in await c.fetch("SELECT cache_key FROM rcache.entry")}
            assert left == {young_k, key}                            # 10분 지난 다른 버전 행만 정리
        finally:
            await tr.rollback()
    finally:
        await c.close()


@needs_db
async def test_db_triggers_bump_only_on_changed_rows(rcache_db):
    c = await owner()
    try:
        rows = await c.fetch("SELECT t.tgrelid::regclass::text AS tbl, t.tgname FROM pg_trigger t "
                             "WHERE NOT t.tgisinternal AND t.tgfoid = 'rcache.tg_bump()'::regprocedure")
        by: dict[str, set[str]] = {}
        for r in rows:
            by.setdefault(r["tbl"], set()).add(r["tgname"])
        assert sorted(by) == sorted(tracked_tables()) and len(by) == 26 + 3 + 1 + 1 + 1 + 1   # + DB-v2.16(WU-7) 3표 + DB-v2.20 1표 + DB-v2.21 frz.generation + DB-v2.25 엔티티 합계 + DB-v2.30 창 판정 기초
        assert all(v == {"rcache_bump_ins", "rcache_bump_upd", "rcache_bump_del", "rcache_bump_trunc"} for v in by.values())
        tr = c.transaction()
        await tr.start()
        try:
            v0 = await c.fetchval("SELECT version FROM rcache.data_version WHERE tbl = 'app.citation_domain_override'")
            await c.execute("UPDATE app.citation_domain_override SET note = note WHERE false")                  # 0행 = 그대로
            await c.execute("DELETE FROM app.citation_domain_override WHERE domain = 'rcache-none.example'")
            assert await c.fetchval("SELECT version FROM rcache.data_version WHERE tbl = 'app.citation_domain_override'") == v0
            await c.execute("SELECT set_config('role', 'api_rw', true)")                                          # 쓰기 롤도 정의자로 올린다
            await c.execute("SELECT set_config('app.actor_id', $1, true)", str(ADMIN))
            await c.execute("INSERT INTO app.citation_domain_override (domain, category_key) "
                            "SELECT 'rcache-t.example', min(category_key) FROM app.citation_category")
            await c.execute("SELECT set_config('role', 'none', true)")
            assert await c.fetchval("SELECT version FROM rcache.data_version WHERE tbl = 'app.citation_domain_override'") == v0 + 1
            await c.execute("TRUNCATE app.citation_domain_override")
            assert await c.fetchval("SELECT version FROM rcache.data_version WHERE tbl = 'app.citation_domain_override'") == v0 + 2
        finally:
            await tr.rollback()
    finally:
        await c.close()


@needs_db
async def test_db_counter_orders_concurrent_writers(rcache_db):
    """같은 표 동시 쓰기 두 트랜잭션: 카운터 행 잠금으로 나중 커밋도 반드시 +1(커밋 순서 무관하게 누락 없음)."""
    a, b = await owner(), await owner()
    try:
        v0 = await a.fetchval("SELECT sum(version) FROM rcache.data_version")
        ta, tb = a.transaction(), b.transaction()
        await ta.start()
        await tb.start()
        await a.execute("INSERT INTO app.hidden_market (surface, country_code, reason) VALUES ('global', 'Z1', 'rcache-a')")
        blocked = asyncio.ensure_future(b.execute("INSERT INTO app.hidden_market (surface, country_code, reason) VALUES ('global', 'Z2', 'rcache-b')"))
        await asyncio.sleep(0.3)
        assert not blocked.done()                                     # 카운터 행에서 기다린다
        await ta.commit()
        await blocked
        assert await a.fetchval("SELECT sum(version) FROM rcache.data_version") == v0 + 1
        await tb.commit()
        assert await a.fetchval("SELECT sum(version) FROM rcache.data_version") == v0 + 2
    finally:
        await a.execute("DELETE FROM app.hidden_market WHERE reason IN ('rcache-a', 'rcache-b')")
        await a.close()
        await b.close()


def test_warm_calls_json_matches_front_evidence_shape():
    d = json.loads((BACK / "app/tools/warm_calls.json").read_text(encoding="utf-8"))
    ids = [c["id"] for c in d["calls"]]
    assert len(ids) == len(set(ids)) == 34
    allowed = {p for _, p in rc.ALLOWLIST}
    for c in d["calls"]:
        assert c["path"] in allowed and c["src"].startswith("front/") and c["params"]["surface"] in ("global", "website")


# ════════════════════════════════════════════════════════════════════════════
# 검증 반려 수정(D1·N4·N5)
# ════════════════════════════════════════════════════════════════════════════
async def _entries() -> int:
    c = await owner()
    try:
        return int(await c.fetchval("SELECT count(*) FROM rcache.entry"))
    finally:
        await c.close()


async def _off(client_as, uid, path: str, prm: dict) -> bytes:
    s_on = get_settings()
    set_settings(s_on.model_copy(update={"result_cache": False}))
    try:
        r = await get(client_as, uid, path, prm)
        assert r.status_code == 200, r.text[:200]
        return r.content
    finally:
        set_settings(s_on)


@needs_db
async def test_register_projects_new_site_turns_website_hit_into_miss(client_as, cache_on):
    """검증 D1 재현: 적재기 register_projects 는 finalize 없이 rd.dim_project 에 새 사이트를 넣는다(세대 불변). DB-v2.11 P67 의
    rd.dim_project 트리거 카운터가 버전을 올려 다음 요청은 미스이고, 바이트 = 캐시 끔(meta.missing_projects 에 새 사이트)."""
    from ingest.common.db import LoaderDB
    from ingest.pull.sync.service import register_projects

    await invalidate()
    path, prm = "/v1/kpi/summary", {"surface": "website"}
    before = await get(client_as, ADMIN, path, prm)
    assert before.headers.get(rc.HEADER) == "miss"
    assert (await get(client_as, ADMIN, path, prm)).headers.get(rc.HEADER) == "hit"
    site, spid = uuid.uuid4(), uuid.uuid4()
    c = await owner()
    try:
        g0 = await c.fetchval("SELECT string_agg(generation::text, ',' ORDER BY surface) FROM rd.surface_generation")
        await c.execute("INSERT INTO app.website_site (site_id, brand_code, country_code, scope_project_id) VALUES ($1, 'Hyundai', 'DE', $2)",
                        site, spid)
        try:
            assert await register_projects(LoaderDB(DB_URL, role="loader")) >= 1
            assert await c.fetchval("SELECT count(*) FROM rd.dim_project WHERE scope_project_id = $1 AND surface = 2", spid) == 1
            assert await c.fetchval("SELECT string_agg(generation::text, ',' ORDER BY surface) FROM rd.surface_generation") == g0   # 세대 불변
            after = await get(client_as, ADMIN, path, prm)
            assert (after.status_code, after.headers.get(rc.HEADER)) == (200, "miss")
            assert after.content == await _off(client_as, ADMIN, path, prm) != before.content
            assert str(site) in (after.json()["meta"].get("missing_projects") or [])
        finally:
            await c.execute("DELETE FROM rd.dim_project WHERE scope_project_id = $1", spid)
            await c.execute("DELETE FROM ing.sync_cursor WHERE scope_project_id = $1", spid)
            await c.execute("DELETE FROM app.website_site WHERE site_id = $1", site)
    finally:
        await c.close()


@needs_db
async def test_undeclared_query_params_bypass_cache(client_as, cache_on):
    """선언 밖 쿼리 파라미터(CommonFilters extra=ignore 라 값만 바꿔 키를 무한히 만들 수 있다)는 캐시를 거치지 않는다: 헤더·저장 없음,
    응답 = 캐시 끔. cf.<uuid> 는 project 표면에서만 선언된 동적 키."""
    await invalidate()
    n0 = await _entries()
    for path, prm in (("/v1/trend", {"surface": "global", "zz": "1"}), ("/v1/kpi/summary", {"surface": "global", "own_brand": "Kia"}),
                      ("/v1/trend", {"surface": "global", "cf.00000000-0000-4000-8000-00000000abcd": "v"})):
        want = await _off(client_as, ADMIN, path, prm)
        for _ in range(2):
            r = await get(client_as, ADMIN, path, prm)
            assert r.status_code == 200 and r.content == want and rc.HEADER.lower() not in {k.lower() for k in r.headers}, (path, prm)
    assert await _entries() == n0
    prm = {"surface": "project", "project_id": P, "cf.00000000-0000-4000-8000-00000000abcd": "v"}
    assert [(await get(client_as, ADMIN, "/v1/trend", prm)).headers.get(rc.HEADER) for _ in range(2)] == ["miss", "hit"]
    assert await _entries() == n0 + 1


@needs_db
async def test_trend_measured_days_param_is_declared_and_keyed(client_as, cache_on):
    """성능 A1(core 10): /v1/trend 의 measured_days 쿼리는 선언 파라미터라 캐시를 우회하지 않고(키 공간 상한 규칙과 충돌 없음),
    원문 쿼리로 키가 갈려 끈 응답(null)과 기본 응답(정수)이 섞이지 않는다. 캐시 끔·미스·적중 바이트 동치."""
    await invalidate()
    off_prm = {"surface": "global", "measured_days": "false"}
    want_off = await _off(client_as, ADMIN, "/v1/trend", off_prm)
    want_on = await _off(client_as, ADMIN, "/v1/trend", {"surface": "global"})
    heads = []
    for _ in range(2):
        r = await get(client_as, ADMIN, "/v1/trend", off_prm)
        assert r.status_code == 200 and r.content == want_off
        heads.append(r.headers.get(rc.HEADER))
    assert heads == ["miss", "hit"]                                            # 선언 밖이면 헤더가 없다(test_undeclared_query_params_bypass_cache)
    assert all(b["measured_days"] is None for b in json.loads(want_off)["data"]["buckets"])
    r = await get(client_as, ADMIN, "/v1/trend", {"surface": "global"})
    assert r.headers.get(rc.HEADER) == "miss" and r.content == want_on           # 기본 요청은 다른 키(끈 응답을 받지 않는다)
    assert all(isinstance(b["measured_days"], int) for b in json.loads(r.content)["data"]["buckets"])


@needs_db
async def test_dropped_filter_values_are_not_stored(client_as, cache_on):
    await invalidate()
    n0 = await _entries()
    prm = {"surface": "global", "country": ["ZZ9", "US"]}
    heads = [(await get(client_as, ADMIN, "/v1/kpi/summary", prm)).headers.get(rc.HEADER) for _ in range(2)]
    r = await get(client_as, ADMIN, "/v1/kpi/summary", prm)
    assert heads == ["miss", "miss"] and r.json()["meta"]["dropped_filters"] == {"country": ["ZZ9"]} and rc.has_dropped_filters(r.content)
    assert await _entries() == n0
    ok = await get(client_as, ADMIN, "/v1/kpi/summary", {"surface": "global", "country": ["US"]})
    assert not rc.has_dropped_filters(ok.content)


@needs_db
async def test_prod_env_hides_header_but_still_caches(client_as, cache_on, monkeypatch):
    from app.features.analytics.trend.series import service

    await invalidate()
    real, calls = service.get_trend, {"n": 0}

    async def counting(*a, **kw):
        calls["n"] += 1
        return await real(*a, **kw)

    monkeypatch.setattr(service, "get_trend", counting)
    s = get_settings()
    set_settings(s.model_copy(update={"env": "prod"}))
    try:
        rs = [await get(client_as, ADMIN, "/v1/trend", {"surface": "global", "dimension": "type"}) for _ in range(2)]
    finally:
        set_settings(s)
    assert calls["n"] == 1 and rs[0].content == rs[1].content                  # 두 번째는 적중(계산 없음)
    assert all(rc.HEADER.lower() not in {k.lower() for k in r.headers} for r in rs)
    stg = await get(client_as, ADMIN, "/v1/trend", {"surface": "global", "dimension": "type"})
    assert stg.headers.get(rc.HEADER) == "hit"


async def _stat(c: asyncpg.Connection) -> tuple[int, int, int, int]:
    st = await c.fetchrow("SELECT coalesce(total_bytes, 0) AS b, coalesce(entries, 0) AS n FROM rcache.stat WHERE id = 1")
    real = await c.fetchrow("SELECT coalesce(sum(stored_bytes), 0) AS b, count(*) AS n FROM rcache.entry")
    return (int(st["b"]) if st else 0, int(st["n"]) if st else 0, int(real["b"]), int(real["n"]))


@needs_db
async def test_db_stat_counter_consistent_under_concurrent_puts(rcache_db):
    """put 의 저장 크기 누적(rcache.stat)이 동시 저장(같은 키 경합·새 키·낡은 버전 정리)과 무효화 뒤에도 실제 합과 같다."""
    await invalidate()
    c = await owner()
    try:
        b, n, rb, rn = await _stat(c)
        assert (b, n) == (rb, rn)
        old = [hashlib.sha256(f"old{i}".encode()).digest() for i in range(20)]
        await c.execute("SELECT set_config('role', 'api_ro', false)")
        for k in old:                                                      # 옛 버전 20행(put 으로 넣어 누적에 잡히게)
            assert await c.fetchval("SELECT app.result_cache_put($1, 'r', 'v-old', 'identity', $2, 100)", k, b"o" * 100)
        await c.execute("RESET role")
        await c.execute("UPDATE rcache.entry SET created_at = now() - interval '11 minutes' WHERE data_version = 'v-old'")
        assert (await _stat(c))[:2] == (await _stat(c))[2:]
    finally:
        await c.close()

    async def worker(i: int) -> None:
        cc = await owner()
        try:
            await cc.execute("SELECT set_config('role', 'api_ro', false)")
            for j in range(15):
                k = hashlib.sha256(f"k{(i * 7 + j) % 40}".encode()).digest()          # 40개 키를 여럿이 겹쳐 쓴다
                await cc.fetchval("SELECT app.result_cache_put($1, 'r', 'v-new', 'identity', $2, $3)", k, b"x" * (50 + j), 50 + j)
        finally:
            await cc.close()

    await asyncio.gather(*[worker(i) for i in range(8)])
    c = await owner()
    try:
        b, n, rb, rn = await _stat(c)
        assert (b, n) == (rb, rn) and rn == 40                              # 옛 버전 20행은 정리, 새 키 40개
        assert await c.fetchval("SELECT count(*) FROM rcache.entry WHERE data_version = 'v-old'") == 0
        await c.execute("SELECT set_config('role', 'migrator', false)")
        assert await c.fetchval("SELECT app.result_cache_invalidate()") == 40
        await c.execute("RESET role")
        assert await _stat(c) == (0, 0, 0, 0)
    finally:
        await c.close()


@needs_db
async def test_db_put_uses_index_range_for_pruning(rcache_db):
    """낡은 버전 정리가 표 전체를 훑지 않는다: 색인 (data_version, created_at) 범위 두 개(BitmapOr·Index)로 계획된다."""
    c = await owner()
    try:
        tr = c.transaction()
        await tr.start()
        try:
            await c.execute("INSERT INTO rcache.entry (cache_key, route, data_version, codec, body, body_bytes, stored_bytes, created_at) "
                            "SELECT sha256(convert_to('p' || g, 'UTF8')), 'r', 'v1', 'identity', '\\x01', 1, 1, now() - interval '1 hour' "
                            "FROM generate_series(1, 5000) g")
            await c.execute("ANALYZE rcache.entry")
            plan = "\n".join(r[0] for r in await c.fetch(
                "EXPLAIN DELETE FROM rcache.entry e WHERE (e.data_version < 'v1' OR e.data_version > 'v1') "
                "AND e.created_at < now() - interval '10 minutes'"))
            assert "entry_version_created_idx" in plan and "Seq Scan" not in plan, plan
        finally:
            await tr.rollback()
    finally:
        await c.close()
