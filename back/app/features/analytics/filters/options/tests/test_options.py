"""analytics.filters.options(F-1) 테스트.

손 계산 근거(tests/fixtures/fixture-10-data.sql, 회차 노출 기준 오늘 ≥ 2026-09-27):
  global 스냅샷 = 회차 11(09-14). cit_in 답변: k1·k2·k9(US en cat_mask 5 = Hyundai|Genesis, chatgpt·gemini·chatgpt),
    k8(US en 5, deepseek), k4(KR ko 1 = Hyundai), k12(US en 8 = HMG 엄브렐러). DE(k5)·ID(k7)·k3·k6·k15 는 elig 거짓.
    → 매트릭스(admin) = (Hyundai,KR,ko) (null,US,en) (Genesis,US,en) (Hyundai,US,en), 엔진 chatgpt·gemini·deepseek.
    인용(cit_in·source_key ≠ 0) 카테고리 = 1 officialHmg · 4 automotiveMedia · 5 newsMedia · 6 communityForums · 13 other.
  global 기간 09-01~09-30 = 회차 10·11. 회차 10 은 k16·k17(US en 5, chatgpt), k18(US en 8, gemini) 추가.
  website 스냅샷 = 회차 21(09-18, 인용 숨김): Kia DE 사이트, k21·k22 lang de, chatgpt·gemini. 출처 카테고리는 숨김 억제.
  project 스냅샷 = 회차 31(09-20): k31 US en cat_mask 0 chatgpt, 인용 카테고리 1·13.
  카탈로그(rd.catalog_entry): 비트 1 F1 branded L1 D1/D2a · 4 같음 · 2 F2 branded L1 D1 · 8 F1 unbranded L2 D1 · 8 F2 (presence 없음) L1 D1/D2b.
"""
from __future__ import annotations

import json
import pathlib
import re
import uuid
from dataclasses import replace
from datetime import date
from types import SimpleNamespace

import asyncpg
import pytest

from app.core.codes import Country, ProjectDim
from app.core.db import fetch_all, fetch_val
from app.features.analytics.filters.options.service import build_matrix, expand_brands
from tests.support import (
    ADMIN,
    CUST_PROJECT,
    DB_URL,
    HQ_HYUNDAI,
    KIA_EU,
    KIA_US,
    SUSPENDED,
    VENDOR,
    WEBSITE_KIA,
    Sql,
    load_named_sql,
    needs_db,
    raw_fetch,
    staged,
)

URL = "/v1/filters/options"
ADMIN_GLOBAL_MATRIX = [{"brand": "Hyundai", "region": "KR", "lang": "ko"}, {"brand": None, "region": "US", "lang": "en"},
                       {"brand": "Genesis", "region": "US", "lang": "en"}, {"brand": "Hyundai", "region": "US", "lang": "en"}]
GLOBAL_SOURCES = ["officialHmg", "automotiveMedia", "newsMedia", "communityForums", "other"]


def _combos(j: dict) -> set[tuple]:
    return {(x["brand"], x["region"], x["lang"]) for x in j["data"]["geo_matrix"]}


def _codes(xs: list[dict]) -> list[str]:
    return [x["code"] for x in xs]


def _assert_consistent(d: dict) -> None:
    """regions·languages 는 geo_matrix 의 distinct 와 일치해야 한다(단위 F-1 응답 불변식)."""
    assert _codes(d["regions"]) == sorted({x["region"] for x in d["geo_matrix"]})
    assert d["languages"] == sorted({x["lang"] for x in d["geo_matrix"] if x["lang"]})


# ── 순수 함수 ─────────────────────────────────────────────────────────────────
@needs_db
async def test_expand_brands(refs):
    assert expand_brands(5, refs, None) == ["Hyundai", "Genesis"]
    assert expand_brands(5, refs, {"Hyundai"}) == ["Hyundai"]
    assert expand_brands(8 | 2, refs, {"Hyundai"}) == [None]            # 엄브렐러 = 공통(null), Kia 는 스코프 밖
    assert expand_brands(0, refs, {"Kia"}) == [None]
    assert expand_brands(16, refs, {"Hyundai"}) == []                  # Hyundai N 전용은 현대 관점에서 빠진다(추가 결정)


@needs_db
async def test_build_matrix_hidden_unknown_and_virtual(refs):
    us, kr, id_, de = (refs.countries[c].geo_key for c in ("US", "KR", "ID", "DE"))
    en, ko, de_l = refs.langs["en"], refs.langs["ko"], refs.langs["de"]
    chat, gem = refs.engines["chatgpt"][0], refs.engines["gemini"][0]
    ctx = SimpleNamespace(surface="global", refs=refs, own_brands=("Hyundai", "Kia", "Genesis", "Hyundai N"))
    rows = [{"project_key": 1, "geo_key": us, "lang_key": en, "cat_mask": 1, "engine_key": chat},
            {"project_key": 1, "geo_key": id_, "lang_key": en, "cat_mask": 1, "engine_key": gem},      # 숨김 표준 국가
            {"project_key": 1, "geo_key": 0, "lang_key": 0, "cat_mask": 2, "engine_key": gem},         # geo 0(unknown)
            {"project_key": 1, "geo_key": kr, "lang_key": 0, "cat_mask": 8, "engine_key": chat}]       # 언어 없음 → null
    m, regions, langs, engines = build_matrix(ctx, rows)
    assert {(x.brand, x.region, x.lang) for x in m} == {("Hyundai", "US", "en"), (None, "KR", None)}
    assert [r.code for r in regions] == ["KR", "US"] and langs == ["en"]
    assert [e.code for e in engines] == ["chatgpt"]                     # 버려진 행의 엔진은 옵션에 넣지 않는다

    # website: 브랜드·국가 = 사이트(dim_project), 가상 브랜드 코드 행 추가, app.hidden_market(website) 배제
    vb = next(c for c in refs.countries.values() if c.kind == "virtual_brand")
    n_site = ProjectDim(project_key=90, surface=2, is_root=False, project_id=None, site_id=None,
                        site_brand_bit=int(vb.virtual_brand_bit), site_geo_key=kr)
    refs2 = replace(refs, projects=(*refs.projects, n_site))
    ctx_w = SimpleNamespace(surface="website", refs=refs2, own_brands=())
    rows_w = [{"project_key": 2, "geo_key": de, "lang_key": de_l, "cat_mask": 0, "engine_key": chat},
              {"project_key": 90, "geo_key": us, "lang_key": ko, "cat_mask": 0, "engine_key": gem}]   # 답변 geo 가 아니라 사이트 geo
    m, regions, langs, engines = build_matrix(ctx_w, rows_w)
    nb = refs.brand_code_of_bit(int(vb.virtual_brand_bit))
    assert {(x.brand, x.region, x.lang) for x in m} == {("Kia", "DE", "de"), (nb, "KR", "ko"), (nb, vb.code, "ko")}
    assert {r.code: r.kind for r in regions} == {"DE": "iso", "KR": "iso", vb.code: "virtual_brand"}
    ctx_h = SimpleNamespace(surface="website", refs=replace(refs2, hidden_markets={"website": frozenset({"DE"})}), own_brands=())
    m, regions, _, _ = build_matrix(ctx_h, rows_w)                       # 웹사이트 숨김 시장(core Refs.hidden_markets)
    assert "DE" not in {x.region for x in m}
    assert isinstance(refs.countries["US"], Country)


# ── API(DB) ──────────────────────────────────────────────────────────────────
@needs_db
async def test_admin_global_snapshot_shape(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(URL, params={"surface": "global", "include": "source_categories"})
    assert r.status_code == 200, r.text
    j = r.json()
    d = j["data"]
    assert d["geo_matrix"] == ADMIN_GLOBAL_MATRIX
    assert d["regions"] == [{"code": "KR", "area": "Asia", "kind": "iso"}, {"code": "US", "area": "North America", "kind": "iso"}]
    assert d["languages"] == ["en", "ko"]
    assert d["engines"] == [{"code": "chatgpt", "is_default": True}, {"code": "gemini", "is_default": True},
                            {"code": "deepseek", "is_default": False}]
    assert [x["slug"] for x in d["source_categories"]] == GLOBAL_SOURCES
    assert d["source_categories"][0] == {"slug": "officialHmg", "name": "Official (HMG)", "ord": 1}
    assert d["custom_fields"] is None
    cat = d["catalog"]
    assert {(x["brand"], x["funnel"], x["brand_presence"], x["list_type"], x["depth1"], x["depth2"]) for x in cat["rows"]} == {
        ("Hyundai", "F1", "branded", "L1", "D1", "D2a"), ("Genesis", "F1", "branded", "L1", "D1", "D2a"),
        ("Kia", "F2", "branded", "L1", "D1", None), (None, "F1", "unbranded", "L2", "D1", None), (None, "F2", None, "L1", "D1", "D2b")}
    assert _codes(cat["funnel"]) == ["F1", "F2"] and _codes(cat["brand_presence"]) == ["branded", "unbranded"]
    assert _codes(cat["list_type"]) == ["L1", "L2"] and cat["depth3"] == []
    assert cat["depth2"] == [{"code": "D2a", "parent_code": "D1"}, {"code": "D2b", "parent_code": "D1"}]
    m = j["meta"]
    assert m["surface"] == "global" and m["mode"] == "snapshot" and m["as_of"] == "2026-09-14" and m["cycles"] == ["2026-09-14"]
    assert m["generation"] == 1 and m["ignored_filters"] == [] and m["dropped_filters"] == {} and m["suppressed"] == {}
    _assert_consistent(d)
    for x in d["geo_matrix"]:                             # 내부 정수 키 비노출
        assert set(x) == {"brand", "region", "lang"}


@needs_db
async def test_matrix_matches_independent_sql(client_as):
    """독립 SQL(리터럴 창·cit_in, 브랜드 전개는 app.brand 로 손 조인)과 매트릭스 대조."""
    c0 = await asyncpg.connect(DB_URL)
    try:
        rs = await c0.fetch("""
            SELECT DISTINCT g.code AS region, NULLIF(l.code, '') AS lang, a.cat_mask
              FROM rd.answer a
              JOIN rd.dim_country g ON g.geo_key = a.geo_key
              JOIN rd.dim_lang l ON l.lang_key = a.lang_key
             WHERE a.surface = 1 AND a.round_date = DATE '2026-09-14' AND a.cyc_key = ANY('{11}'::int4[]) AND a.cit_in
               AND NOT g.hidden_standard AND g.kind <> 'unknown'""")
        brands = await c0.fetch("SELECT brand_code, brand_bit, is_umbrella FROM app.brand")
    finally:
        await c0.close()
    expected = set()
    for r in rs:                                          # 비트 전개는 테스트 쪽에서 따로(서비스 expand_brands 미사용)
        for b in brands:
            if r["cat_mask"] % (2 * b["brand_bit"]) >= b["brand_bit"]:
                expected.add((None if b["is_umbrella"] else b["brand_code"], r["region"], r["lang"]))
    async with client_as(ADMIN) as c:
        got = _combos((await c.get(URL, params={"surface": "global"})).json())
    assert got == expected and len(got) == 4


@needs_db
async def test_brand_scope_no_leak(client_as):
    """현대 계정: Genesis·Kia 조합·카탈로그 행이 새지 않는다(스코프 브랜드 + 공통만)."""
    async with client_as(HQ_HYUNDAI) as c:
        j = (await c.get(URL, params={"surface": "global"})).json()
    d = j["data"]
    assert _combos(j) == {("Hyundai", "KR", "ko"), (None, "US", "en"), ("Hyundai", "US", "en")}
    assert {x["brand"] for x in d["catalog"]["rows"]} == {"Hyundai", None}
    assert "Genesis" not in str(d) and "Kia" not in str(d)
    _assert_consistent(d)


@needs_db
async def test_country_scope_no_leak(client_as):
    """Kia·US 계정: 공통(k12) US 조합만, KR·Hyundai·Genesis 누출 0. 엔진·출처도 스코프 안 행에서만."""
    async with client_as(KIA_US) as c:
        j = (await c.get(URL, params={"surface": "global", "include": "source_categories"})).json()
    d = j["data"]
    assert d["geo_matrix"] == [{"brand": None, "region": "US", "lang": "en"}]
    assert _codes(d["regions"]) == ["US"] and d["languages"] == ["en"]
    assert d["engines"] == [{"code": "chatgpt", "is_default": True}]
    assert d["source_categories"] == []                   # k12 는 인용 없음
    assert {x["brand"] for x in d["catalog"]["rows"]} == {"Kia", None}
    async with client_as(KIA_EU) as c:                    # 서유럽 권역(DE 포함): 스냅샷에 cit_in 답변 없음 → 빈 매트릭스
        j = (await c.get(URL, params={"surface": "global"})).json()
    assert j["data"]["geo_matrix"] == [] and j["data"]["regions"] == [] and j["data"]["engines"] == []
    assert j["data"]["catalog"]["rows"]                   # 카탈로그는 측정 창과 무관


@needs_db
async def test_period_window_changes_values(client_as):
    """기간 창(회차 10·11)은 스냅샷(회차 11)과 값이 다르다: Kia·US 계정 엔진 gemini(k18) 추가, meta mode cumulative."""
    async with client_as(KIA_US) as c:
        snap = (await c.get(URL, params={"surface": "global"})).json()
        per = (await c.get(URL, params={"surface": "global", "from": "2026-09-01", "to": "2026-09-30"})).json()
        old = (await c.get(URL, params={"surface": "global", "from": "2026-09-01", "to": "2026-09-08"})).json()
    assert _codes(snap["data"]["engines"]) == ["chatgpt"]
    assert _codes(per["data"]["engines"]) == ["chatgpt", "gemini"]
    assert _codes(old["data"]["engines"]) == ["gemini"]                      # 회차 10 만: k18(gemini, 엄브렐러)
    assert per["meta"]["mode"] == "cumulative" and per["meta"]["cycles"] == ["2026-09-07", "2026-09-14"]
    assert old["meta"]["cycles"] == ["2026-09-07"] and old["meta"]["as_of"] == "2026-09-07"
    assert snap["meta"]["mode"] == "snapshot"


@needs_db
async def test_value_filters_ignored_and_declared(client_as):
    """브랜드·국가·언어·엔진·택소노미·출처·커스텀 필드는 결과를 좁히지 않고 meta.ignored_filters 로 드러난다(조용히 무시 금지)."""
    async with client_as(ADMIN) as c:
        base = (await c.get(URL, params={"surface": "global"})).json()
        r = await c.get(URL, params=[("surface", "global"), ("brand", "Kia"), ("country", "KR"), ("lang", "ko"), ("engine", "gemini"),
                                     ("funnel", "F9"), ("depth1", "D1"), ("source", "other"), (f"cf.{uuid.uuid4()}", "x"),
                                     ("depth4", "D4x")])
    assert r.status_code == 200
    j = r.json()
    assert j["data"] == base["data"]
    assert j["meta"]["ignored_filters"] == ["brand", "country", "custom", "depth1", "depth4", "engine", "funnel", "lang", "source"]   # depth4 = BG-03
    assert j["meta"]["dropped_filters"] == {}


@needs_db
async def test_website_surface(client_as):
    async with client_as(ADMIN) as c:
        j = (await c.get(URL, params={"surface": "website", "include": "source_categories"})).json()
    d = j["data"]
    assert d["geo_matrix"] == [{"brand": "Kia", "region": "DE", "lang": "de"}]
    assert d["regions"] == [{"code": "DE", "area": "Europe", "kind": "iso"}]
    assert _codes(d["engines"]) == ["chatgpt", "gemini"]
    assert d["catalog"] is None and d["custom_fields"] is None
    assert d["source_categories"] == [] and j["meta"]["suppressed"] == {"source_categories": "hidden"}   # 회차 21 인용 숨김
    assert j["meta"]["as_of"] == "2026-09-18"
    async with client_as(KIA_EU) as c:                    # 서유럽 Kia 계정은 Kia DE 사이트가 스코프 안
        assert _combos((await c.get(URL, params={"surface": "website"})).json()) == {("Kia", "DE", "de")}


@needs_db
async def test_empty_results(client_as):
    """스코프 안 사이트 없음(Kia·US website) = 스냅샷 없음 억제, 회차 없는 기간 = 기간 억제. 카탈로그는 남는다."""
    async with client_as(KIA_US) as c:
        w = (await c.get(URL, params={"surface": "website", "include": "source_categories"})).json()
    async with client_as(ADMIN) as c:
        p = (await c.get(URL, params={"surface": "global", "from": "2020-01-01", "to": "2020-01-31"})).json()
    assert w["data"]["geo_matrix"] == [] and w["data"]["engines"] == [] and w["meta"]["as_of"] is None
    assert w["meta"]["suppressed"] == {"geo_matrix": "no_active_snapshot", "engines": "no_active_snapshot",
                                       "source_categories": "no_active_snapshot"}
    assert p["data"]["geo_matrix"] == [] and p["meta"]["cycles"] == []
    assert p["meta"]["suppressed"]["geo_matrix"] == "no_cycles_in_period"
    assert p["data"]["catalog"]["rows"]


@needs_db
async def test_project_surface_membership_and_catalog(client_as):
    async with client_as(VENDOR) as c:                   # 활성 멤버
        j = (await c.get(URL, params={"surface": "project", "project_id": str(CUST_PROJECT), "include": "source_categories"})).json()
    d = j["data"]
    assert d["geo_matrix"] == [{"brand": None, "region": "US", "lang": "en"}]
    assert _codes(d["engines"]) == ["chatgpt"]
    assert [x["slug"] for x in d["source_categories"]] == ["officialHmg", "other"]
    assert [(x["funnel"], x["list_type"]) for x in d["catalog"]["rows"]] == [("F9", None)]
    assert d["custom_fields"] == [] and j["meta"]["as_of"] == "2026-09-20"
    async with client_as(HQ_HYUNDAI) as c:               # 비멤버지만 Hyundai·US 프로젝트가 스코프 안 → 열람
        assert (await c.get(URL, params={"surface": "project", "project_id": str(CUST_PROJECT)})).status_code == 200
    for who in (KIA_US, KIA_EU):                          # 스코프 밖·비멤버 → 404(존재 은폐, 값 누출 없음)
        async with client_as(who) as c:
            r = await c.get(URL, params={"surface": "project", "project_id": str(CUST_PROJECT)})
        assert r.status_code == 404 and "data" not in r.json()
    async with client_as(ADMIN) as c:
        assert (await c.get(URL, params={"surface": "project", "project_id": str(uuid.uuid4())})).status_code == 404
        assert (await c.get(URL, params={"surface": "project"})).status_code == 422


@needs_db
async def test_project_custom_fields(client_as):
    """커스텀 필드: 보관 제외, 살아 있는 프롬프트 값만(삭제된 프롬프트 값 제외). 픽스처에 없어 이 테스트가 넣고 지운다."""
    fid, fid_arch = uuid.uuid4(), uuid.uuid4()
    live = uuid.UUID("c3000000-0000-4000-8000-000000000031")
    dead = uuid.uuid4()
    async with staged(Sql(M["actor"]),
                      Sql("INSERT INTO app.prompt (prompt_id, project_id, text, status, created_by, deleted_at) "
                          "VALUES ($1, $2, 'deleted', 'draft', '5eed0000-0000-4000-8000-000000000001', now())", (dead, CUST_PROJECT)),
                      Sql("INSERT INTO app.project_custom_field (field_id, project_id, label, archived, created_by) VALUES "
                          "($1, $3, '차종', false, '5eed0000-0000-4000-8000-000000000001'),"
                          "($2, $3, '보관됨', true, '5eed0000-0000-4000-8000-000000000001')", (fid, fid_arch, CUST_PROJECT)),
                      Sql("INSERT INTO app.prompt_custom_field_value (project_id, prompt_id, field_id, value) VALUES "
                          "($1, $2, $3, 'SUV'), ($1, $4, $3, 'EV'), ($1, $2, $5, 'x')", (CUST_PROJECT, live, fid, dead, fid_arch))), \
            client_as(VENDOR) as c:
        j = (await c.get(URL, params={"surface": "project", "project_id": str(CUST_PROJECT)})).json()
    assert j["data"]["custom_fields"] == [{"field_id": str(fid), "label": "차종", "values": ["SUV"]}]


@needs_db
async def test_auth_and_menu_gates(client_as):
    async with client_as(None) as c:
        assert (await c.get(URL, params={"surface": "global"})).status_code == 401
    async with client_as(SUSPENDED) as c:
        assert (await c.get(URL, params={"surface": "global"})).status_code == 401
    async with client_as(HQ_HYUNDAI) as c:
        r = await c.get(URL, params={"surface": "website"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
    for who, surfaces in ((VENDOR, ("global", "website")), (WEBSITE_KIA, ("global",))):     # core 표면 경로 게이트(D-vendor)
        async with client_as(who) as c:
            for s in surfaces:
                r = await c.get(URL, params={"surface": s})
                assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden", (who, s)


@needs_db
@pytest.mark.parametrize("params", [
    {},
    {"surface": "all"},
    {"surface": "global", "to": "2026-13-01"},
    {"surface": "global", "from": "2026-09-30", "to": "2026-09-01"},
    {"surface": "global", "from": "2026-13-01", "to": "2026-12-31"},
    {"surface": "project", "project_id": "x"},
    {"surface": "global", "cf.not-a-uuid": "v"},
    {"surface": "global", "country": "\x01"},
])
async def test_invalid_params_422(client_as, params):
    async with client_as(ADMIN) as c:
        r = await c.get(URL, params=params)
    assert r.status_code == 422, (params, r.text)
    assert r.json()["error"]["code"] == "unprocessable"


# ── 검증 M4 회귀: 복제본에 행을 넣어 경로별로 API·DB 수준에서 확인(core 롤백 전용 준비 tests.support.staged) ─────────────
# 준비 문장(rd 쓰기)은 API 문장 정적 가드 대상이 아니라 데이터 파일 mutations.pgsql 에 둔다(back/tests/README.md 6절).
M = load_named_sql(pathlib.Path(__file__).with_name("mutations.pgsql"))


def _steps(*stmts: tuple) -> list[Sql]:
    """(문장, 인자…) 묶음 → 준비 단계(행위자 GUC 먼저)."""
    return [Sql(M["actor"]), *(Sql(s[0], tuple(s[1:])) for s in stmts)]


@needs_db
async def test_hyundai_n_global_admin_only(client_as):
    """global Hyundai N 전용 답변(cat_mask·bgrp 16): ADMIN 에는 (Hyundai N, KR, ko) 가 보이고 현대 스코프 계정에는 새지 않는다."""
    async with staged(*_steps((M["answer_ins"], date(2026, 9, 14), 9001, 11, 1, 1, 1, 1, 1, "KR", "ko", 16, 16))):
        async with client_as(ADMIN) as c:
            adm = (await c.get(URL, params={"surface": "global"})).json()
        async with client_as(HQ_HYUNDAI) as c:
            hq = (await c.get(URL, params={"surface": "global"})).json()
    assert _combos(adm) == {(b, r, lang) for b, r, lang in _combos({"data": {"geo_matrix": ADMIN_GLOBAL_MATRIX}})} | {
        ("Hyundai N", "KR", "ko")}
    assert _combos(hq) == {("Hyundai", "KR", "ko"), (None, "US", "en"), ("Hyundai", "US", "en")}
    assert "Hyundai N" not in str(hq["data"])
    _assert_consistent(adm["data"])


@needs_db
async def test_snapshot_falls_back_when_latest_cycle_fully_hidden(client_as):
    """최신 회차 11 이 전체 숨김(hidden_scope 1)이면 스냅샷은 회차 10(09-07)으로 물러난다: k16·k17(US en 5, chatgpt)·k18(US en 8, gemini)."""
    async with staged(*_steps((M["hide_cycle_11"], 1))), client_as(ADMIN) as c:
        j = (await c.get(URL, params={"surface": "global"})).json()
    assert j["meta"]["as_of"] == "2026-09-07" and j["meta"]["cycles"] == ["2026-09-07"] and j["meta"]["mode"] == "snapshot"
    assert _combos(j) == {("Hyundai", "US", "en"), ("Genesis", "US", "en"), (None, "US", "en")}
    assert _codes(j["data"]["engines"]) == ["chatgpt", "gemini"]
    _assert_consistent(j["data"])


D18 = date(2026, 9, 18)
N_SITE, HUS_SITE, HDE_SITE = (uuid.UUID(f"d9000000-0000-4000-8000-00000000009{i}") for i in (0, 1, 2))


@needs_db
async def test_website_fleet_virtual_code_hidden_market_and_missing(client_as):
    """website 함대 스냅샷(09-18):
    - Hyundai N KR 사이트(90) → (Hyundai N, KR, ko) 와 가상 코드 행 (Hyundai N, HYUNDAI-N, ko), 국가 옵션 kind virtual_brand.
    - Hyundai US 사이트(91) → (Hyundai, US, en). 이 사이트 답변의 인용(newsMedia)만 출처 카테고리에 남는다(회차 21 은 인용 숨김).
    - Hyundai DE 사이트(92) 는 09-11 회차뿐 → meta.missing_projects = [그 사이트].
    - app.hidden_market(website, US) 를 넣으면 US 행이 빠진다."""
    dim, cyc, ans = M["site_ins"], M["site_cycle_ins"], M["answer_ins"]
    steps = _steps((dim, 90, uuid.uuid4(), N_SITE, 16, "KR"), (dim, 91, uuid.uuid4(), HUS_SITE, 1, "US"),
                   (dim, 92, uuid.uuid4(), HDE_SITE, 1, "DE"),
                   (cyc, 901, uuid.uuid4(), 90, D18), (cyc, 902, uuid.uuid4(), 91, D18), (cyc, 903, uuid.uuid4(), 92, date(2026, 9, 11)),
                   (ans, D18, 9101, 901, 21, 8, 2, 90, 1, "KR", "ko", 0, 16),
                   (ans, D18, 9102, 902, 21, 8, 2, 91, 2, "US", "en", 0, 1),
                   (M["site_citation_ins"],))
    async with staged(*steps), client_as(ADMIN) as c:
        j = (await c.get(URL, params={"surface": "website", "include": "source_categories"})).json()
        one = (await c.get(URL, params={"surface": "website", "project_id": str(N_SITE)})).json()
        dts = (await c.get("/v1/filters/dates", params={"surface": "website"})).json()
    async with staged(*steps, Sql(M["website_hidden_us"])), client_as(ADMIN) as c:
        h = (await c.get(URL, params={"surface": "website"})).json()
    d = j["data"]
    assert _combos(j) == {("Kia", "DE", "de"), ("Hyundai N", "KR", "ko"), ("Hyundai N", "HYUNDAI-N", "ko"), ("Hyundai", "US", "en")}
    assert d["regions"] == [{"code": "DE", "area": "Europe", "kind": "iso"}, {"code": "HYUNDAI-N", "area": None, "kind": "virtual_brand"},
                            {"code": "KR", "area": "Asia", "kind": "iso"}, {"code": "US", "area": "North America", "kind": "iso"}]
    assert d["languages"] == ["de", "en", "ko"] and _codes(d["engines"]) == ["chatgpt", "gemini"]
    assert [x["slug"] for x in d["source_categories"]] == ["newsMedia"] and j["meta"]["suppressed"] == {}
    assert j["meta"]["as_of"] == "2026-09-18" and j["meta"]["missing_projects"] == [str(HDE_SITE)]
    _assert_consistent(d)
    assert _combos(h) == {("Kia", "DE", "de"), ("Hyundai N", "KR", "ko"), ("Hyundai N", "HYUNDAI-N", "ko")}     # 웹사이트 숨김 시장 US
    assert "US" not in _codes(h["data"]["regions"])
    assert _combos(one) == {("Hyundai N", "KR", "ko"), ("Hyundai N", "HYUNDAI-N", "ko")}                       # 사이트 하나로 좁힘
    assert dts["data"]["dates"] == ["2026-09-18", "2026-09-11"]


@needs_db
async def test_explain_prunes_to_one_leaf(database):
    """계획 시점 가지치기: 스냅샷 매트릭스·출처 문장은 이웃 빈 leaf(2026-08·2026-10)와 다른 표면 leaf 를 계획에 넣지 않는다."""
    from app.core.filters import CommonFilters, resolve_read_context
    from app.core.sqlb import render_literals
    from app.features.analytics.filters.options import queries as q
    from app.features.analytics.filters.options.service import OPTIONS_SUPPORT
    from tests.support import principal

    months = ("202608", "202610")
    # 이웃 leaf 생성(DDL)도 롤백 전용 준비 안에서: 블록이 끝나면 사라진다(DROP 불필요). 계획은 소유자 롤로 잰다(role=None)
    async with staged(Sql(M["ensure_neighbour_leaves"]), role=None) as conn:
        neighbours = [r["relname"] for r in await fetch_all(
            conn, "SELECT relname FROM pg_class WHERE relname = ANY(CAST(:n AS text[]))", {"n": [f"answer_g_{m}" for m in months]})]
        p = await principal(conn, ADMIN)
        ctx = await resolve_read_context(conn, p, CommonFilters(surface="global"), support=OPTIONS_SUPPORT)
        win = await ctx.window(conn)
        ms = replace(ctx.measure(), engine_keys=tuple(sorted(k for k, _ in ctx.refs.engines.values())))
        plans = {}
        for name, s in (("matrix", q.matrix_sql(ms, win)), ("sources", q.source_categories_sql(ms, win))):
            plans[name] = await fetch_val(conn, "EXPLAIN (FORMAT JSON) " + render_literals(s))
    assert win.lo == win.hi and str(win.lo) == "2026-09-14"
    for name, plan in plans.items():
        rels = set(_relations(plan if isinstance(plan, list) else json.loads(plan)))
        fact = "answer" if name == "matrix" else "citation"
        leaves_in_plan = {r for r in rels if re.fullmatch(rf"{fact}_[gwp]_\d{{6}}", r)}
        assert leaves_in_plan == {f"{fact}_g_202609"}, (name, rels)          # 이웃 빈 leaf(08·10)·다른 표면 leaf 없음
    assert {"answer_g_202608", "answer_g_202610"} <= set(neighbours)         # 이웃 leaf 가 실제로 있던 상태에서 잰 계획


def _relations(node) -> list[str]:
    """EXPLAIN JSON 트리에서 Relation Name 전부."""
    out: list[str] = []
    if isinstance(node, dict):
        if "Relation Name" in node:
            out.append(node["Relation Name"])
        for v in node.values():
            out += _relations(v)
    elif isinstance(node, list):
        for v in node:
            out += _relations(v)
    return out


# ── BG-03: catalog.rows·depth4 옵션 ──────────────────────────────────────────
@needs_db
async def test_catalog_depth4_rows_and_options(client_as):
    """depth4 는 카탈로그 원본 행(app.prompt.depth4)에서 읽는다. global 은 관점 비트 행만(HQ_HYUNDAI = 현대·엄브렐러: 제네시스 D4g 는 보이지 않는다),
    project 는 그 프로젝트 프롬프트. 부모 코드 = depth3(없으면 null). 기대값은 원시 행에서 따로 모은다."""
    async with staged(Sql(M["actor"]), Sql(M["depth4_marks"])) as conn:
        want = await raw_fetch(conn, "SELECT DISTINCT p.depth4 FROM rd.catalog_entry ce JOIN app.prompt p ON p.prompt_id = ce.catalog_row_id "
                                     "WHERE ce.brand_bit IN (1, 8) AND p.depth4 IS NOT NULL")
        async with client_as(HQ_HYUNDAI) as c:
            g = (await c.get(URL, params={"surface": "global"})).json()["data"]["catalog"]
        assert [x["code"] for x in g["depth4"]] == sorted(r["depth4"] for r in want) == ["D4x"]
        assert g["depth4"] == [{"code": "D4x", "parent_code": None}]
        assert {(x["brand"], x["depth2"], x["depth4"]) for x in g["rows"] if x["depth4"]} == {("Hyundai", "D2a", "D4x")}
        assert all("depth4" in x for x in g["rows"])
        async with client_as(ADMIN) as c:                 # 전사: 제네시스 행의 D4g 도 보인다
            a = (await c.get(URL, params={"surface": "global"})).json()["data"]["catalog"]
            p = (await c.get(URL, params={"surface": "project", "project_id": str(CUST_PROJECT)})).json()["data"]["catalog"]
        assert [x["code"] for x in a["depth4"]] == ["D4g", "D4x"]
        assert [(x["funnel"], x["depth4"]) for x in p["rows"]] == [("F9", "P4")] and p["depth4"] == [{"code": "P4", "parent_code": None}]
    async with client_as(HQ_HYUNDAI) as c:                # 준비 롤백 뒤: depth4 없음 = 빈 옵션, 행 값 null
        g = (await c.get(URL, params={"surface": "global"})).json()["data"]["catalog"]
    assert g["depth4"] == [] and all(x["depth4"] is None for x in g["rows"])


@needs_db
async def test_source_categories_only_when_included(client_as):
    """WU-12: 출처 카테고리는 include=source_categories 일 때만 계산한다. 기본 응답은 null(요청 안 함, meta.suppressed 에도 없음)이고
    나머지 필드·meta 는 include 를 준 응답과 같다(창이 비거나 인용 숨김이면 include 때만 suppressed 에 적는다)."""
    cases = [("global", {}), ("global", {"from": "2026-09-01", "to": "2026-09-30"}), ("website", {}),
             ("project", {"project_id": str(CUST_PROJECT)}), ("global", {"from": "2020-01-01", "to": "2020-01-31"})]
    for surface, extra in cases:
        uid = VENDOR if surface == "project" else ADMIN
        async with client_as(uid) as c:
            base = (await c.get(URL, params={"surface": surface, **extra})).json()
            inc = (await c.get(URL, params={"surface": surface, **extra, "include": "source_categories"})).json()
        assert base["data"]["source_categories"] is None, surface
        assert isinstance(inc["data"]["source_categories"], list), surface
        assert {k: v for k, v in base["data"].items() if k != "source_categories"} == \
            {k: v for k, v in inc["data"].items() if k != "source_categories"}, surface
        assert "source_categories" not in base["meta"]["suppressed"]
        assert {k: v for k, v in base["meta"].items() if k != "suppressed"} == {k: v for k, v in inc["meta"].items() if k != "suppressed"}
    async with client_as(ADMIN) as c:
        bad = await c.get(URL, params={"surface": "global", "include": "geo_matrix"})
    assert bad.status_code == 422
