"""core 6라운드(비분석 8그룹 + 적재 요청) 반영 확인.

sqlguard SAVEPOINT·DB 오류 전역 매핑·no-store·auth(check_role·CurrentUserDetached·active_member·global 운영자 스코프·client_ip·QaLiveConn)·
filters(ignored_axes·PgText·V1 표면 게이트 생략·웹사이트 ISO∪가상 합집합·택소노미 사전 생략)·write(dedupe 모드·supersede·savepoint·QA 감사)·
contracts·kw(골든 세트 ↔ DB 생성 열)·urls(파이썬 ↔ 적재 SQL cit_norm)·xlsx 쓰기·export·upload·cycles(all_visible·ungated)·pagination·llm·
DB-v2.6(마지막 admin 트리거·analyze_facts).
"""
from __future__ import annotations

import contextlib
import dataclasses
import io
import json
import pathlib
import re
import uuid
import zipfile
from datetime import date

import asyncpg
import httpx
import pytest
from fastapi import FastAPI, Request, UploadFile
from pydantic import TypeAdapter, ValidationError
from sqlalchemy.exc import DBAPIError

from app.core import errors
from app.core.auth import (
    CurrentUser,
    CurrentUserDetached,
    QaReviewer,
    check_menu_group,
    check_role,
    client_ip,
    rate_key_ip,
    require_operator,
    resolve_project,
)
from app.core.contracts import ContractError, DfsFetch, parse_change, parse_outbox
from app.core.cycles import resolve_window
from app.core.db import fetch_one, fetch_val, get_db
from app.core.errors import from_db_error, install_error_handlers
from app.core.export import csv_chunks, export_headers, export_response
from app.core.filters import (
    KPI_SUPPORT,
    CommonFilters,
    FilterSupport,
    PgLine,
    PgText,
    ignored_axes,
    query_axes,
    resolve_read_context,
)
from app.core.kw import PRESETS, preset_of, sanitize, term_norm
from app.core.llm import LlmError, OpenRouterClient, UnavailableLlm, call_llm
from app.core.pagination import Cursor, decode_cursor, encode_cursor
from app.core.sqlguard import fact_guard
from app.core.upload import UploadLimitMiddleware, read_upload_file, read_upload_request
from app.core.urls import canonical_http_url, normalize_url_for_match
from app.core.write import (
    access_audit_qa,
    enqueue_change,
    enqueue_change_result,
    enqueue_scope,
    get_audit_writer,
    savepoint,
)
from app.core.xlsx import SheetSpec, XlsxBudget, XlsxReader, iter_workbook, write_workbook
from tests.support import (
    ADMIN,
    CUST_PROJECT,
    DB_URL,
    HQ_HYUNDAI,
    TODAY,
    VENDOR,
    Update,
    needs_db,
    principal,
    staged,
)

BACK = pathlib.Path(__file__).resolve().parents[2]


class _Rollback(Exception):
    pass


@contextlib.asynccontextmanager
async def rw_rollback(database, uid=ADMIN):
    """api_rw 쓰기 트랜잭션을 열고 블록이 끝나면 되돌린다(복제본에 흔적을 남기지 않는다)."""
    try:
        async with database.write(uid) as c:
            yield c
            raise _Rollback
    except _Rollback:
        pass


# ── sqlguard ──────────────────────────────────────────────────────────────────
def test_sqlguard_allows_savepoint_family_only():
    for ok in ("SAVEPOINT sa_savepoint_1", "RELEASE SAVEPOINT sa_savepoint_1", "ROLLBACK TO SAVEPOINT sa_savepoint_1"):
        assert fact_guard(ok) == [], ok
    for bad in ("BEGIN", "COMMIT", "ROLLBACK", "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"):
        assert fact_guard(bad), bad


# ── DB 오류 전역 매핑 ─────────────────────────────────────────────────────────
@needs_db
async def test_db_error_mapping_real_errors(database):
    async with database.read("api_ro") as c:
        with pytest.raises(Exception) as e:
            await fetch_one(c, "SELECT CAST(:v AS text) AS v", {"v": "a\x00b"})
    m = from_db_error(e.value)
    assert m is not None and (m.status, m.code) == (422, "invalid_value")
    async with database.read("api_ro") as c:
        with pytest.raises(Exception) as e:
            await fetch_one(c, "SELECT CAST(:v AS text) AS v", {"v": "\ud800"})      # 클라이언트 인코딩 단계(서버 왕복 전)
    m = from_db_error(e.value)
    assert m is not None and (m.status, m.code) == (422, "invalid_value")


def _app_with(route):
    app = FastAPI()
    install_error_handlers(app)
    app.add_api_route("/x", route, methods=["GET", "POST"])
    return app


@needs_db
async def test_db_error_handler_and_no_store(database):
    async def boom():
        async with get_db().read("api_ro") as c:
            await fetch_one(c, "SELECT CAST(:v AS text) AS v", {"v": "\x00"})

    async def denied():
        raise errors.forbidden("x", code="role_forbidden")

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app_with(boom)), base_url="http://t") as c:
        r = await c.get("/x")
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_value"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app_with(denied)), base_url="http://t") as c:
        r = await c.get("/x")
    assert r.status_code == 403 and r.headers.get("cache-control") == "no-store"


@needs_db
async def test_db_error_mapping_narrowed_m3(database, caplog):
    """검증 m-3: 22xxx 는 입력 유래(22001·22P02·22007·22008·22021, 쓰기 요청의 22003)만 422, 나머지(22012 등)는 500 + WARNING(exc_info).
    무결성 매핑은 유지하되 응답 details 에 제약 이름을 싣지 않는다(로그에만)."""
    async def run(sql: str, params: dict):
        async with get_db().read("api_ro") as c:
            await fetch_one(c, sql, params)

    async def div0():
        await run("SELECT 1 / CAST(:z AS int4) AS v", {"z": 0})

    async def out_of_range():                            # 서버 22003
        await run("SELECT CAST(CAST(:v AS int4) AS int2) AS v", {"v": 70000})

    async def arg_overflow():                            # 서버 왕복 전 asyncpg 인자 인코딩(22000 + OverflowError → 22003)
        await run("SELECT CAST(:v AS int2) AS v", {"v": 70000})

    async def bad_text():
        await run("SELECT CAST(:v AS int4) AS v", {"v": "x1"})

    for fn, method, want in ((div0, "GET", (500, "internal")), (div0, "POST", (500, "internal")),
                             (out_of_range, "GET", (500, "internal")), (out_of_range, "POST", (422, "invalid_value")),
                             (arg_overflow, "GET", (500, "internal")), (arg_overflow, "POST", (422, "invalid_value")),
                             (bad_text, "GET", (422, "invalid_value"))):
        caplog.clear()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=_app_with(fn)), base_url="http://t") as c:
            r = await c.request(method, "/x")
        assert (r.status_code, r.json()["error"]["code"]) == want, (fn.__name__, method, r.text)
        if want[0] == 500:
            assert any(rec.levelname == "WARNING" and rec.exc_info for rec in caplog.records), fn.__name__
    async with rw_rollback(database) as c:
        with pytest.raises(DBAPIError) as e:
            await fetch_one(c, "INSERT INTO app.project_tracked_keyword (project_id, term) VALUES (:p, 'dup-m3'), (:p, 'DUP-m3 ') "
                               "RETURNING keyword_id", {"p": CUST_PROJECT})
    m = from_db_error(e.value, write=True)
    assert m is not None and (m.status, m.code, m.details) == (409, "conflict", None)          # 제약 이름 비노출
    m = from_db_error(e.value, messages={"project_tracked_keyword_norm_uq": "duplicate_keyword"}, write=True)
    assert m is not None and (m.status, m.code, m.details) == (409, "duplicate_keyword", None)


# ── auth ─────────────────────────────────────────────────────────────────────
@needs_db
async def test_check_role_and_menu_group(ro):
    hq = await principal(ro, HQ_HYUNDAI)
    check_role(hq, "hq", "admin")
    with pytest.raises(errors.ApiError) as e:
        check_role(hq, "admin")
    assert e.value.code == "role_forbidden"
    check_menu_group(hq, "project")
    with pytest.raises(errors.ApiError) as e:
        check_menu_group(hq, "website")
    assert e.value.code == "menu_forbidden"


@needs_db
async def test_resolve_project_levels_scope_id_and_members_only(ro, refs):
    hq = await principal(ro, HQ_HYUNDAI)          # 비멤버, 스코프 안(Hyundai/US)
    acc = await resolve_project(ro, hq, refs, CUST_PROJECT, "member")
    assert acc.member_role is None and acc.scope_project_id == uuid.UUID("a0000000-0000-4000-8000-000000000003")
    for level, kw in (("active_member", {}), ("owner", {"members_only": True}), ("member", {"members_only": True})):
        with pytest.raises(errors.ApiError) as e:
            await resolve_project(ro, hq, refs, CUST_PROJECT, level, **kw)
        assert e.value.status == 404, level
    with pytest.raises(errors.ApiError) as e:
        await resolve_project(ro, hq, refs, CUST_PROJECT, "owner")          # 가시 비멤버의 owner = 403(기존 의미 유지)
    assert e.value.status == 403
    v = await principal(ro, VENDOR)               # 활성 viewer 멤버
    assert (await resolve_project(ro, v, refs, CUST_PROJECT, "active_member")).member_role == "viewer"
    adm = await principal(ro, ADMIN)
    assert (await resolve_project(ro, adm, refs, CUST_PROJECT, "active_member")).member_role is None


@needs_db
async def test_require_operator_global_needs_project_in_scope(ro, refs):
    hq = await principal(ro, HQ_HYUNDAI)
    g_in = dataclasses.replace(hq, operator="global")                        # Hyundai 스코프: CUST_PROJECT(Hyundai/US) 안
    await require_operator(ro, g_in, "run", CUST_PROJECT, refs=refs)
    await require_operator(ro, g_in, "run", CUST_PROJECT)                    # refs 없이도(내부에서 읽는다)
    g_out = dataclasses.replace(hq, operator="global", scope_brands=("Genesis",))
    with pytest.raises(errors.ApiError) as e:
        await require_operator(ro, g_out, "run", CUST_PROJECT, refs=refs)
    assert e.value.code == "operator_forbidden"


def _req(headers: dict[str, str], client=("10.0.0.9", 1234)) -> Request:
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
                    "client": client, "query_string": b""})


def test_client_ip_trusted_hops_and_rate_key():
    r = _req({"X-Forwarded-For": "6.6.6.6, 1.2.3.4, 10.0.0.2"})
    assert client_ip(r, hops=0) == "10.0.0.9"               # 기본 0: 소켓 주소(뷰어 XFF 불신)
    assert client_ip(r, hops=2) == "1.2.3.4"                # CloudFront → ALB → 앱: 오른쪽에서 두 번째
    assert client_ip(r, hops=5) == "10.0.0.9"               # 원소 부족: 소켓 폴백
    assert client_ip(r) == "10.0.0.9"                       # 설정 기본값 0
    assert rate_key_ip("2001:db8:1:2:aaaa::1") == "2001:db8:1:2::/64"
    assert rate_key_ip("::ffff:1.2.3.4") == "1.2.3.4" and rate_key_ip("garbage") == "garbage"


@needs_db
async def test_current_user_detached_releases_connection(database, client_as):
    seen: dict[str, int] = {}
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/detached")
    async def detached(p: CurrentUserDetached) -> dict:
        seen["detached"] = get_db().engine("api_ro").pool.checkedout()
        return {"role": p.role}

    @app.get("/held")
    async def held(p: CurrentUser) -> dict:
        seen["held"] = get_db().engine("api_ro").pool.checkedout()
        return {"role": p.role}

    async with client_as(HQ_HYUNDAI, app_=app) as c:
        assert (await c.get("/detached")).json() == {"role": "hq"}
        assert (await c.get("/held")).status_code == 200
        assert (await c.get("/detached", headers={"Authorization": "Bearer x"})).status_code == 401
    assert seen == {"detached": 0, "held": 1}


# ── filters ──────────────────────────────────────────────────────────────────
def test_query_axes_and_ignored_axes():
    ax = query_axes()
    assert ax["from"] == ax["to"] == "period" and ax["surface"] == "surface" and ax["own_brand"] == "own_brand"
    q = ["from", "to", "brand", "cf.11111111-0000-4000-8000-000000000001", "surface", "project_id", "q", "limit"]
    assert ignored_axes(q) == ["brand", "custom", "period", "project_id", "surface"]
    assert ignored_axes(q, consumed=("surface", "project_id")) == ["brand", "custom", "period"]
    assert ignored_axes(q, ("brand", "period"), consumed=("surface",), extra_supported=("custom",)) == ["project_id"]
    assert ignored_axes(["country", "lang", "source"], KPI_SUPPORT, "global") == ["source"]   # 표면 지원 축(글로벌 lang 은 지원: BG-01)
    assert ignored_axes(["country", "lang"], KPI_SUPPORT) == []                          # 표면 없으면 세 표면 합집합
    assert ignored_axes(["country"], FilterSupport.of(), consumed=("country",)) == []     # 단일 국가 파라미터


def test_geo_pseudo_market_split():
    from app.core.filters import split_geo_pseudo
    assert split_geo_pseudo(["DE", "x:ww", " X:EU ", "x:na", "x:CPO"]) == (["DE", "x:na", "x:CPO"], ["x:EU", "x:WW"])


def test_pg_text_line_types():
    t, line = TypeAdapter(PgText), TypeAdapter(PgLine)
    assert t.validate_python("줄1\n줄2") == "줄1\n줄2"
    for bad in ("a\x00b", "\ud800"):
        with pytest.raises(ValidationError):
            t.validate_python(bad)
    for bad in ("a\nb", "a\tb", "a\x7fb", "\udfff"):
        with pytest.raises(ValidationError):
            line.validate_python(bad)


def _cf(**kw) -> CommonFilters:
    return CommonFilters.model_validate({k.rstrip("_"): v for k, v in kw.items()})


@needs_db
async def test_v1_surface_gate_skip_for_admin_features(ro, refs):
    adm = dataclasses.replace(await principal(ro, ADMIN), menu_groups=("admin",))   # 관리 메뉴만 가진 admin
    with pytest.raises(errors.ApiError) as e:
        await resolve_read_context(ro, adm, _cf(surface="global"), support=KPI_SUPPORT, refs=refs)
    assert e.value.code == "menu_forbidden"
    ctx = await resolve_read_context(ro, adm, _cf(surface="global"), support=KPI_SUPPORT, refs=refs, surface_gate=False)
    assert ctx.surface == "global" and ctx.scope.all


@needs_db
async def test_cf_from_query_params_and_taxonomy_flag(ro, refs):
    from starlette.datastructures import QueryParams
    adm = await principal(ro, ADMIN)
    qp = QueryParams("surface=global&cf.11111111-0000-4000-8000-00000000000a=x")
    ctx = await resolve_read_context(ro, adm, _cf(surface="global"), support=KPI_SUPPORT, refs=refs, query_params=qp)
    assert "custom" in ctx.ignored_filters                                            # 예전: custom_fields 를 안 넘기면 조용히 버려짐
    f = _cf(surface="global", funnel=["no-such-funnel"])
    ctx = await resolve_read_context(ro, adm, f, support=KPI_SUPPORT, refs=refs)
    assert ctx.dropped_filters.get("funnel") == ("no-such-funnel",) and ctx.prompt_keys == ()
    ctx = await resolve_read_context(ro, adm, f, support=KPI_SUPPORT, refs=refs, resolve_taxonomy=False)
    assert "funnel" not in ctx.dropped_filters and ctx.prompt_keys is None             # 카탈로그: 요청 값 그대로 app.prompt 열과 비교


@needs_db
async def test_website_iso_and_virtual_codes_are_union(ro, refs):
    """front website-geo-pred.ts:18-24 websiteSiteGeoPred: country=[DE, HYUNDAI-N] = (국가 DE) ∨ (브랜드 Hyundai N)."""
    vb = refs.countries["HYUNDAI-N"].virtual_brand_bit
    geo = {c: refs.countries[c].geo_key for c in ("DE", "US")}
    hy = refs.brand("Hyundai").bit
    kia_de = next(p for p in refs.projects if p.surface == 2)
    extra = (dataclasses.replace(kia_de, project_key=91, site_id=str(uuid.uuid4()), site_brand_bit=vb, site_geo_key=geo["US"]),
             dataclasses.replace(kia_de, project_key=92, site_id=str(uuid.uuid4()), site_brand_bit=hy, site_geo_key=geo["US"]),
             dataclasses.replace(kia_de, project_key=93, site_id=str(uuid.uuid4()), site_brand_bit=hy, site_geo_key=geo["DE"]))
    r2 = dataclasses.replace(refs, projects=refs.projects + extra)
    adm = await principal(ro, ADMIN)
    web = FilterSupport.of(website=("brand", "country", "lang", "engine", "period"))
    both = await resolve_read_context(ro, adm, _cf(surface="website", country=["DE", "HYUNDAI-N"]), support=web, refs=r2)
    assert set(both.project_keys) == {kia_de.project_key, 91, 93}                      # 92(Hyundai US) 만 빠진다
    assert set(both.countries or ()) == {"DE", "US"} and both.request_iso == ("DE",)
    assert both.website_site_ok("US", vb) and both.website_site_ok("DE", hy) and not both.website_site_ok("US", hy)
    only_v = await resolve_read_context(ro, adm, _cf(surface="website", country=["HYUNDAI-N"]), support=web, refs=r2)
    assert set(only_v.project_keys) == {91} and only_v.request_iso is None
    only_iso = await resolve_read_context(ro, adm, _cf(surface="website", country=["DE"]), support=web, refs=r2)
    assert only_iso.countries == ("DE",) and only_iso.website_site_ok("DE", hy) and not only_iso.website_site_ok("US", vb)


# ── contracts ────────────────────────────────────────────────────────────────
def test_contracts_parse_and_reject():
    d = parse_change("dfs_fetch", {"fetch": "insight", "terms": ["기아 EV9"], "location_code": 2410, "language_code": "ko"})
    assert isinstance(d, DfsFetch) and d.endpoints == ("search_volume", "serp_organic") and not d.include_seed
    assert parse_change("anchor_pin", {"job_id": str(uuid.uuid4()), "anchor": "2026-09-14", "reason": "x"}).op == "set"
    assert parse_change("answer_drop", {"job_id": str(uuid.uuid4()), "reason": "x"}).op == "drop"
    for kind, bad in (("cycle_admin", {"cycle_id": str(uuid.uuid4()), "op": "hide"}),                    # hidden_scope 없음
                      ("cycle_admin", {"cycle_id": str(uuid.uuid4()), "op": "set_view_date"}),
                      ("dfs_fetch", {"endpoint": "search_volume", "terms": ["a"], "location_code": 1, "language_code": "ko"}),
                      ("anchor_pin", {"job_id": str(uuid.uuid4())}), ("answer_drop", None)):
        with pytest.raises(ContractError):
            parse_change(kind, bad)
    assert parse_change("catalog", {"anything": 1}) is None                             # 트리거 소관 kind 는 검증 밖
    assert parse_outbox("prompt", "disable", {"prompt_id": str(uuid.uuid4()), "project_id": None}).scope_prompt_id is None
    with pytest.raises(ContractError):
        parse_outbox("schedule", "set_targets", {"project_id": str(uuid.uuid4())})


# ── write ────────────────────────────────────────────────────────────────────
@needs_db
async def test_enqueue_change_modes(database):
    async with rw_rollback(database) as c:
        subj = [uuid.uuid4()]
        pl = {"cycle_id": str(subj[0]), "op": "hide", "hidden_scope": "all", "reason": "operator"}
        a = await enqueue_change_result(c, "cycle_admin", subject_uuids=subj, payload=pl, dedupe="coalesce_pending")
        b = await enqueue_change_result(c, "cycle_admin", subject_uuids=subj, payload=pl, dedupe="coalesce_pending")
        assert a.created and not b.created and a.change_id == b.change_id
        with pytest.raises(errors.ApiError) as e:                                     # raise: 같은 주체 대기 = 409
            await enqueue_change(c, "cycle_admin", subject_uuids=subj, payload=pl)
        assert e.value.code == "duplicate_pending" and e.value.details == {"change_id": a.change_id}
        vd = {"cycle_id": str(subj[0]), "op": "set_view_date", "view_date": "2026-09-30"}
        cid = await enqueue_change(c, "cycle_admin", subject_uuids=subj, payload=vd, dedupe_key={"op": "set_view_date"})
        assert cid != a.change_id                                                      # dedupe_key: 다른 op 는 묻히지 않는다

        async def never(_row):
            return False
        n = await enqueue_change_result(c, "cycle_admin", subject_uuids=subj, payload=pl, dedupe="coalesce_active", reusable=never)
        assert n.created                                                               # 재사용 후보를 거르면 새 행
        assert await enqueue_change(c, "cycle_admin", subject_uuids=subj, payload=pl, dedupe="off") > n.change_id
        with pytest.raises(ContractError):                                             # 계약 위반 = 코드 결함
            await enqueue_change(c, "cycle_admin", subject_uuids=subj, payload={"op": "hide"}, dedupe="off")


@needs_db
async def test_enqueue_scope_supersede_and_savepoint(database):
    async with rw_rollback(database) as c:
        pid = uuid.uuid4()
        pl = {"prompt_id": str(pid), "project_id": str(CUST_PROJECT)}
        o1 = await enqueue_scope(c, "prompt", pid, "disable", pl, supersede=("disable", "enable"))
        o2 = await enqueue_scope(c, "prompt", pid, "enable", pl, supersede=("disable", "enable"))
        o3 = await enqueue_scope(c, "prompt", pid, "disable", pl, supersede=("disable", "enable"))
        rows = {}
        for i in (o1, o2, o3):
            r = await fetch_one(c, "SELECT done_at IS NOT NULL AS done, last_error FROM app.scope_outbox WHERE outbox_id = :i", {"i": i})
            rows[i] = (r["done"], r["last_error"])
        assert rows == {o1: (True, "superseded"), o2: (True, "superseded"), o3: (False, None)}
        with pytest.raises(DBAPIError):
            async with savepoint(c):
                await fetch_one(c, "SELECT CAST(:v AS int4) AS v", {"v": "not-int"})
        assert await fetch_val(c, "SELECT count(*) FROM app.scope_outbox WHERE aggregate_id = :a", {"a": pid}) == 3   # 바깥 트랜잭션 계속


def test_access_audit_qa_records_session_actor():
    w = get_audit_writer()
    before = len(w.pending())
    sid = str(uuid.uuid4())
    access_audit_qa(QaReviewer(sid, "검수자A", 0.0), "download", "qa.notes.export", detail={"rows": 3})
    ev = w.pending()[before]
    assert (str(ev.actor_id), ev.actor_role, ev.kind) == (sid, "vendor", "download")
    assert ev.detail == {"actor_kind": "qa_reviewer", "reviewer_name": "검수자A", "rows": 3}
    w._buf.clear()


# ── kw·urls ──────────────────────────────────────────────────────────────────
GOLDEN_TERMS = ["Kia EV9", "  기아  ", "CAFÉ", " 현대　", "ÀBC", "ＧＥＮＥＳＩＳ", "a "]


def test_kw_helpers_and_presets():
    assert term_norm("CAFÉ") == "café" and term_norm("  Kia EV9 ") == "kia ev9"
    assert sanitize(" (a), [b]\n c ") == "a b c" and sanitize("x" * 100) == ""
    assert len(PRESETS) == 29 and list(PRESETS)[:3] == ["us", "ca", "mx"] and preset_of("KR").location_code == 2410
    with pytest.raises(errors.ApiError) as e:
        preset_of("zz")
    assert e.value.code == "unknown_country"


@needs_db
async def test_term_norm_matches_db_generated_column():
    """app.project_tracked_keyword.term_norm(DB-v2.6 P44 생성 열) = core.kw.term_norm(골든 세트: NFD·전각·유니코드 공백 포함)."""
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        try:
            got = [r[0] for r in await c.fetch(
                "INSERT INTO app.project_tracked_keyword (project_id, term) SELECT $1, t FROM unnest($2::text[]) WITH ORDINALITY u(t, i) "
                "ORDER BY i RETURNING term_norm", CUST_PROJECT, GOLDEN_TERMS)]
        finally:
            await tr.rollback()
    finally:
        await c.close()
    assert got == [term_norm(t) for t in GOLDEN_TERMS]


GOLDEN_URLS = ["https://www.Kia.com/us/en/ev9?utm_source=x&a=1#top", "http://hyundai.com/?gclid=abc", "https://a.com/p?x=1&fbclid=z&y=2",
               "  https://B.com/path///  ", "https://c.com/?utm_medium=m&keep=1", "www.d.com/q?_ga=1"]


@needs_db
async def test_url_norm_matches_loader_sql():
    common = (BACK / "migration" / "seed" / "seed-3x-common.sql").read_text(encoding="utf-8")
    fn = re.search(r"CREATE OR REPLACE FUNCTION pg_temp\.cit_norm\(text\).*?\$f\$;", common, re.S)
    assert fn is not None
    c = await asyncpg.connect(DB_URL)
    try:
        await c.execute(fn.group(0))
        got = [r[0] for r in await c.fetch("SELECT pg_temp.cit_norm(u) FROM unnest($1::text[]) WITH ORDINALITY x(u, i) ORDER BY i", GOLDEN_URLS)]
    finally:
        await c.close()
    assert got == [normalize_url_for_match(u) for u in GOLDEN_URLS]
    assert canonical_http_url("HTTPS://Kia.COM", field="url") == "https://kia.com/"
    with pytest.raises(errors.ApiError):
        canonical_http_url("https://u:p@example.com/", field="url")


# ── xlsx·export·upload ───────────────────────────────────────────────────────
def test_xlsx_writer_roundtrip_streaming_and_sheet_names():
    rows = [["a", 1, 2.5, None, True, date(2026, 9, 28), float("nan"), "x\x00y<&>", ["p", "q"]] for _ in range(1203)]

    def specs():
        return [SheetSpec("s[1]", [f"h{i}" for i in range(9)], iter(rows), widths=[10] * 9), SheetSpec("S[1]", ["z"], iter([["only"]]))]

    whole, stream = write_workbook(specs()), b"".join(iter_workbook(specs()))
    for data in (whole, stream):
        z = zipfile.ZipFile(io.BytesIO(data))
        assert z.testzip() is None
        wb = z.read("xl/workbook.xml").decode()
        assert '<sheet name="s 1 "' in wb and '<sheet name="S 1  2"' in wb                  # 금지 문자 공백, 대소문자 무시 중복 접미
        sh = XlsxReader(XlsxBudget()).read(data)
        assert len(sh.rows) == 1204 and sh.rows[1].cells == ["a", "1", "2.5", "", "true", "2026-09-28", "", "xy<&>", "p;q"]


async def test_export_csv_neutralizes_formulas_and_headers():
    body = b"".join(csv_chunks(["a", "b"], [{"a": "=1+1", "b": -5}, {"a": "@x", "b": "-y"}]))
    text = body.decode("utf-8")
    assert text.startswith("﻿") and "'=1+1,-5" in text and "'@x,'-y" in text
    h = export_headers("프롬프트 목록.csv", truncated=True)
    assert h["X-Export-Truncated"] == "true" and h["Cache-Control"] == "no-store" and "filename*=UTF-8''" in h["Content-Disposition"]
    r = export_response("xlsx", ["a"], [{"a": "v"}], basename="t")
    assert r.media_type.endswith("spreadsheetml.sheet")
    chunks = [c async for c in r.body_iterator]
    assert XlsxReader(XlsxBudget()).read(b"".join(chunks)).rows[1].cells == ["v"]


async def test_upload_limits(monkeypatch):
    from app.core import upload as up
    from app.core.config import get_settings

    monkeypatch.setattr(up, "get_settings", lambda: get_settings().model_copy(update={"upload_max_bytes": 1000}))
    app = FastAPI()
    install_error_handlers(app)
    app.add_middleware(UploadLimitMiddleware)

    @app.post("/f")
    async def f(file: UploadFile) -> dict:
        return {"n": len(await read_upload_file(file, max_bytes=10))}

    @app.post("/raw")
    async def raw(request: Request) -> dict:
        return {"n": len(await read_upload_request(request))}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        assert (await c.post("/f", files={"file": ("a.xlsx", b"12345")})).json() == {"n": 5}
        r = await c.post("/f", files={"file": ("a.xlsx", b"x" * 11)})
        assert r.status_code == 413 and r.json()["error"]["code"] == "payload_too_large"                 # 기능 상한
        r = await c.post("/f", files={"file": ("a.xlsx", b"x" * 200_000)})
        assert r.status_code == 413 and r.json()["error"]["code"] == "payload_too_large"                 # 전역 상한(미들웨어)
        r = await c.post("/f", files={"file": ("a.xlsx", b"")})
        assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_upload"
        assert (await c.post("/raw", content=b"abc", headers={"content-type": "application/octet-stream"})).json() == {"n": 3}
        # 검증 m-1: Content-Type 이 둘 이상이면 해석과 무관하게 400(마지막 값만 보던 때 200,000B multipart 가 상한을 지나갔다)
        dup = [("content-type", "multipart/form-data; boundary=a"), ("content-type", "application/json")]
        r = await c.post("/f", content=b"x" * 200_000, headers=dup)
        assert (r.status_code, r.json()["error"]["code"]) == (400, "invalid_upload")
        r = await c.post("/raw", content=b"abc", headers=[("content-type", "application/octet-stream"), ("content-length", "3"),
                                                            ("content-length", "3")])
        assert r.status_code == 400
        assert (await c.post("/raw", content=b"abc", headers={"content-type": "text/plain"})).status_code == 415


# ── cycles·pagination ────────────────────────────────────────────────────────
@needs_db
async def test_window_all_visible_and_ungated(client_as):
    async with staged(Update("rd.cycle", {"cyc_key": 11}, {"servable": False})) as conn:
        root = await fetch_val(conn, "SELECT project_key FROM rd.dim_project WHERE surface = 1 AND is_root")
        snap = await resolve_window(conn, surface="global", project_keys=[root], date_from=None, date_to=None, today=TODAY)
        allv = await resolve_window(conn, surface="global", project_keys=[root], date_from=None, date_to=None, today=TODAY, all_visible=True)
        ung = await resolve_window(conn, surface="global", project_keys=[root], date_from=None, date_to=None, today=TODAY,
                                   all_visible=True, ungated=True)
    assert snap.mode == "snapshot" and snap.lo == snap.hi == date(2026, 9, 7)             # 11 비발행 → 최신 가시 = 10
    assert allv.mode == "cumulative" and (allv.lo, allv.hi) == (date(2026, 9, 7), date(2026, 9, 7)) and allv.all_keys() == (10,)
    assert ung.all_keys() == (10, 11, 12) and (ung.lo, ung.hi) == (date(2026, 9, 7), date(2026, 9, 21))


def test_cursor_text_max_and_date_bounds():
    long = "가" * 600
    tok = encode_cursor(Cursor(sort="s", dir="asc", key=(long,), fh="f"))
    with pytest.raises(errors.ApiError):
        decode_cursor(tok, sort="s", dir="asc", fh="f", types=("text",))
    assert decode_cursor(tok, sort="s", dir="asc", fh="f", types=("text",), text_max=1000).key == (long,)
    for d, ok in ((date(1900, 1, 1), True), (date(2999, 12, 31), True), (date(1, 1, 1), False), (date(9999, 12, 31), False)):
        t = encode_cursor(Cursor(sort="s", dir="asc", key=(d,), fh="f"))
        if ok:
            assert decode_cursor(t, sort="s", dir="asc", fh="f", types=("date",)).key == (d,)
        else:
            with pytest.raises(errors.ApiError):
                decode_cursor(t, sort="s", dir="asc", fh="f", types=("date",))


# ── llm ──────────────────────────────────────────────────────────────────────
async def test_llm_client_retry_and_error_mapping():
    from pydantic import SecretStr

    from app.core.config import get_settings

    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        assert req.url.path.endswith("/chat/completions") and "Bearer k" in req.headers["authorization"]
        if calls["n"] == 1:
            return httpx.Response(503)
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"ok": 1})}}]})

    s = get_settings().model_copy(update={"openrouter_api_key": SecretStr("k")})
    cl = OpenRouterClient(s, transport=httpx.MockTransport(handler))
    assert await cl.complete_json("p", {"type": "object"}, temperature=0, max_tokens=10) == {"ok": 1} and calls["n"] == 2
    bad = OpenRouterClient(s, transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"choices": [{"message": {"content": "[]"}}]})))
    with pytest.raises(LlmError) as e:
        await bad.complete_json("p", {}, temperature=0, max_tokens=1)
    assert e.value.kind == "invalid"
    with pytest.raises(errors.ApiError) as e:
        await call_llm(UnavailableLlm(), "p", {}, temperature=0, max_tokens=1)
    assert (e.value.status, e.value.code) == (503, "llm_unavailable")
    with pytest.raises(errors.ApiError) as e:
        await call_llm(bad, "p", {}, temperature=0, max_tokens=1)
    assert (e.value.status, e.value.code) == (502, "llm_failed")
    assert "k" not in repr(cl).replace("key=set", "")


# ── DB-v2.6 ──────────────────────────────────────────────────────────────────
@needs_db
async def test_last_admin_trigger_and_analyze_helper(seeded):          # seeded: 테스트 계정(ADMIN) 준비(역순 실행에서도)
    c = await asyncpg.connect(DB_URL)
    try:
        await c.execute("SELECT set_config('app.actor_id', $1, false)", str(ADMIN))
        others = await c.fetchval("SELECT count(*) FROM app.user_account WHERE role = 'admin' AND status = 'active' "
                                  "AND (menu_groups IS NULL OR 'admin' = ANY(menu_groups)) AND user_id <> $1", ADMIN)
        if others == 0:
            with pytest.raises(asyncpg.CheckViolationError) as e:
                async with c.transaction():
                    await c.execute("UPDATE app.user_account SET status = 'suspended' WHERE user_id = $1", ADMIN)
            assert e.value.constraint_name == "ua_last_admin"
        async with c.transaction():                                  # 다른 실효 admin 을 같은 트랜잭션에서 만들면 통과(지연 트리거)
            uid = uuid.uuid4()
            await c.execute("INSERT INTO app.user_account (user_id, email, role, operator, scope_all, menu_groups) "
                            "VALUES ($1, $2, 'admin', 'global', true, NULL)", uid, f"t-r6-{uid}@example.test")
            await c.execute("UPDATE app.user_account SET menu_groups = '{standard}' WHERE user_id = $1", ADMIN)
            await c.execute("UPDATE app.user_account SET menu_groups = NULL WHERE user_id = $1", ADMIN)
            await c.execute("DELETE FROM app.user_account WHERE user_id = $1", uid)
        await c.execute("SET ROLE loader")
        r = await c.fetchrow("SELECT analyzed, skipped FROM rd.analyze_facts(ARRAY['rd.answer','ing.citation']::regclass[])")
        assert r["analyzed"] > 2 and r["skipped"] == 0                  # 파티션 트리 표 단위(DB-v2.7 P56), 소유자 = 전부 MAINTAIN
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await c.fetchrow("SELECT * FROM rd.analyze_facts(ARRAY['app.prompt']::regclass[])")
        await c.execute("RESET ROLE")
        assert await c.fetchval("SELECT has_function_privilege('admin_long', 'rd.today_kst()', 'execute')")
    finally:
        await c.close()


_EFF_ADMINS = ("SELECT count(*) FROM app.user_account u WHERE u.role = 'admin' AND u.status = 'active' "
               "AND (u.menu_groups IS NULL OR 'admin' = ANY (u.menu_groups))")


@needs_db
@pytest.mark.parametrize("iso", ["read_committed", "repeatable_read", "serializable"])
@pytest.mark.parametrize("flow", ["interleaved", "sequential"])
async def test_last_admin_trigger_concurrent_m2(seeded, iso, flow):
    """검증 m-2(DB-v2.7 P53): 실효 admin 이 2명뿐일 때 두 트랜잭션이 각각 한 명씩 정지시키면 둘 다 커밋되면 안 된다.
    interleaved = 둘 다 UPDATE 한 뒤 동시에 커밋(트리거의 FOR SHARE 가 서로의 행 잠금을 기다려 교착 → 한쪽 40P01, 또는 40001·23514),
    sequential = T1 이 완전히 커밋된 뒤 T2(스냅샷은 T1 커밋 전)가 UPDATE·커밋(RR·SERIALIZABLE 40001, RC 23514)."""
    import asyncio

    x, y = uuid.uuid4(), uuid.uuid4()
    own = await asyncpg.connect(DB_URL)
    conns: list[asyncpg.Connection] = []
    others: list[uuid.UUID] = []
    try:
        await own.execute("SELECT set_config('app.actor_id', $1, false)", str(ADMIN))
        await own.execute("INSERT INTO app.user_account (user_id, email, role, operator, scope_all, menu_groups) VALUES "
                          "($1, $3, 'admin', 'global', true, NULL), ($2, $4, 'admin', 'global', true, NULL)",
                          x, y, f"t-m2-{x}@example.test", f"t-m2-{y}@example.test")
        others = [r[0] for r in await own.fetch(_EFF_ADMINS.replace("count(*)", "u.user_id") + " AND u.user_id <> ALL($1::uuid[])", [x, y])]
        await own.execute("UPDATE app.user_account SET status = 'suspended' WHERE user_id = ANY($1::uuid[])", others)
        assert await own.fetchval(_EFF_ADMINS) == 2
        for _ in range(2):
            c = await asyncpg.connect(DB_URL)
            await c.execute("SELECT set_config('app.actor_id', $1, false)", str(ADMIN))
            conns.append(c)
        c1, c2 = conns
        t1, t2 = c1.transaction(isolation=iso), c2.transaction(isolation=iso)
        await t1.start()
        await t2.start()
        await c1.fetchval(_EFF_ADMINS)                       # 스냅샷 확정(RR·SERIALIZABLE)
        await c2.fetchval(_EFF_ADMINS)
        upd = "UPDATE app.user_account SET status = 'suspended' WHERE user_id = $1"
        errs: list[BaseException] = []
        if flow == "interleaved":
            await c1.execute(upd, x)
            await c2.execute(upd, y)
            res = await asyncio.gather(t1.commit(), t2.commit(), return_exceptions=True)
            errs = [r for r in res if isinstance(r, BaseException)]
        else:
            await c1.execute(upd, x)
            await t1.commit()
            try:
                await c2.execute(upd, y)
                await t2.commit()
            except asyncpg.PostgresError as e:
                errs.append(e)
        for t in (t1, t2):
            with contextlib.suppress(Exception):
                await t.rollback()
        assert len(errs) == 1, errs
        assert getattr(errs[0], "sqlstate", None) in ("40001", "40P01", "23514"), errs
        assert await own.fetchval(_EFF_ADMINS) == 1                          # 한 명은 남는다
    finally:
        for c in conns:
            await c.close()
        await own.execute("UPDATE app.user_account SET status = 'active' WHERE user_id = ANY($1::uuid[])", others)
        await own.execute("DELETE FROM app.user_account WHERE user_id = ANY($1::uuid[])", [x, y])
        await own.close()
