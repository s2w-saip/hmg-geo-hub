"""front 요청(core 8라운드) 확인: fe-u1 요청 2(X-Request-Id)·3(안정 operationId·잠금 파일)·4(업로드 413·415 선언)·5(한쪽 기간)·6(cf.* 설명),
fe-u2 요청 1(SessionScope.account_countries)·5(menu_groups 빈 배열 → null). D2(신뢰 중계 IP)는 bg-qa-platform 이 구현(test_bg_qa_platform)."""
from __future__ import annotations

import logging
import pathlib
import re
import uuid

import asyncpg
import httpx
from fastapi import FastAPI

from app.core.errors import install_error_handlers
from app.core.reqid import RequestIdMiddleware, current_request_id, install_log_record_factory, parse_request_id
from app.core.upload import UploadLimitMiddleware
from app.core.write import AccessAuditWriter
from app.main import app, stable_operation_id
from tests.support import ADMIN, DB_URL, HQ_HYUNDAI, needs_db, principal, staged

BACK = pathlib.Path(__file__).resolve().parents[2]
OPS = ("get", "post", "put", "patch", "delete")


# ── fe-u1 2: X-Request-Id ────────────────────────────────────────────────────
def _mini() -> FastAPI:
    a = FastAPI()
    install_error_handlers(a)
    a.add_middleware(UploadLimitMiddleware)
    a.add_middleware(RequestIdMiddleware)
    seen: dict[str, object] = {}

    @a.get("/ok")
    async def ok() -> dict:
        w = AccessAuditWriter()
        w.record_actor(ADMIN, "admin", "data_access", "t")
        seen["ctx"] = current_request_id()
        seen["audit"] = w.pending()[0].request_id
        return {"ok": True}

    @a.get("/boom")
    async def boom() -> dict:
        raise RuntimeError("x")

    @a.post("/up")
    async def up() -> dict:
        return {"ok": True}

    a.state.seen = seen
    return a


async def test_request_id_echo_generate_and_audit():
    a = _mini()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a, raise_app_exceptions=False), base_url="http://t") as c:
        given = str(uuid.uuid4())
        r = await c.get("/ok", headers={"X-Request-Id": given.upper()})
        assert r.headers["x-request-id"] == given                         # 표준 표기 UUID 는 그대로(소문자 정규화)
        assert str(a.state.seen["ctx"]) == given and str(a.state.seen["audit"]) == given   # 접근 감사 기본값 = 그 요청 ID
        for bad in ("not-a-uuid", "{" + given + "}", given.replace("-", ""), "x" * 36):
            r = await c.get("/ok", headers={"X-Request-Id": bad})
            rid = uuid.UUID(r.headers["x-request-id"])
            assert rid.version == 4 and str(rid) != given
        r1, r2 = await c.get("/ok"), await c.get("/ok")
        assert r1.headers["x-request-id"] != r2.headers["x-request-id"]
        # 처리되지 않은 예외 500(ServerErrorMiddleware 경로)에도 같은 ID
        r = await c.get("/boom", headers={"X-Request-Id": given})
        assert r.status_code == 500 and r.headers["x-request-id"] == given and r.json()["error"]["code"] == "internal"
        # 업로드 상한 미들웨어가 직접 내는 400 에도 붙는다(요청 ID 미들웨어가 더 바깥)
        r = await c.post("/up", content=b"x", headers=[("content-type", "text/csv"), ("content-type", "text/csv"),
                                                        ("x-request-id", given)])
        assert r.status_code == 400 and r.headers["x-request-id"] == given
    assert current_request_id() is None                                  # 요청 밖으로 새지 않는다


async def test_access_log_quotes_path_and_carries_rid_v62_v63(caplog):
    """검증 V6-2: 경로의 %0A 는 scope path 에 줄바꿈으로 디코딩돼 들어온다. hgh.access 는 경로를 퍼센트 인코딩해 한 줄로 남긴다.
    검증 V6-3: 메시지 자체에 rid= 를 넣는다(형식 문자열이 %(request_id)s 를 안 써도 요청 ID 가 남는다)."""
    a = _mini()
    given = str(uuid.uuid4())
    with caplog.at_level(logging.INFO, logger="hgh.access"):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url="http://t") as c:
            r = await c.get("/ok%0A2026-09-29 INFO hgh.access GET /admin 200 1ms rid=forged", headers={"X-Request-Id": given})
            assert r.status_code == 404
            await c.get("/ok", headers={"X-Request-Id": given})
    msgs = [rec.getMessage() for rec in caplog.records if rec.name == "hgh.access"]
    assert len(msgs) == 2 and all("\n" not in m and "\r" not in m for m in msgs), msgs
    assert msgs[0].startswith("GET /ok%0A2026-09-29%20INFO%20hgh.access%20GET%20/admin") and msgs[0].endswith(f"rid={given}")
    assert msgs[1] == msgs[1].split(" rid=")[0] + f" rid={given}" and msgs[1].startswith("GET /ok 200 ")
    from app.core.reqid import safe_path
    assert safe_path("a\r\nb c/é") == "a%0D%0Ab%20c/%C3%A9" and safe_path("x" * 3000).endswith("…") and len(safe_path("x" * 3000)) == 2049


def test_logging_config_file_formats_rid_v63(tmp_path):
    """back/logging.json(배포 uvicorn --log-config)을 dictConfig 로 올려 hgh.access 한 줄에 rid 가 두 번(형식·메시지) 남고,
    팩토리·요청 밖 레코드(uvicorn 기동 로그 등)도 필터가 '-' 를 달아 형식 오류가 나지 않는지 본다."""
    import io
    import json
    import logging.config

    cfg = json.loads((BACK / "logging.json").read_text(encoding="utf-8"))
    buf = io.StringIO()
    cfg["handlers"]["stdout"]["stream"] = buf
    saved = {n: (logging.getLogger(n).handlers[:], logging.getLogger(n).level, logging.getLogger(n).propagate)
             for n in ("hgh", "hgh.access", "uvicorn", "uvicorn.error", "uvicorn.access", "")}
    try:
        logging.config.dictConfig(cfg)
        base = logging.getLogRecordFactory()
        logging.setLogRecordFactory(logging.LogRecord)          # 팩토리 없는 레코드(uvicorn 기동 시점)도 필터가 채운다
        try:
            logging.getLogger("uvicorn.error").info("Started server process")
        finally:
            logging.setLogRecordFactory(base)
        rid = str(uuid.uuid4())
        logging.getLogger("hgh.access").info("GET /x 200 1ms rid=%s", rid)
        logging.getLogger("uvicorn.access").info("should be silenced")
    finally:
        for n, (h, lv, pr) in saved.items():
            lg = logging.getLogger(n)
            lg.handlers[:] = h
            lg.setLevel(lv)
            lg.propagate = pr
    lines = buf.getvalue().splitlines()
    assert any("uvicorn.error rid=- Started server process" in ln for ln in lines), lines
    assert any(ln.endswith(f"rid={rid}") and "hgh.access" in ln for ln in lines), lines
    assert not any("should be silenced" in ln for ln in lines)


def test_parse_request_id_and_log_record():
    assert parse_request_id(None) is None and parse_request_id("") is None
    assert parse_request_id("123e4567-e89b-12d3-a456-426614174000") == uuid.UUID("123e4567-e89b-12d3-a456-426614174000")
    install_log_record_factory()
    rec = logging.getLogger("hgh.test").makeRecord("hgh.test", logging.INFO, __file__, 1, "m", (), None)
    assert rec.request_id == "-"                                           # type: ignore[attr-defined]


@needs_db
async def test_app_echoes_request_id_on_real_routes():   # 무인증 401 은 커넥션 없이 끝난다(D-2, test_core9)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        given = str(uuid.uuid4())
        r = await c.get("/v1/auth/me", headers={"X-Request-Id": given})     # 무인증 401 도 헤더가 붙는다
        assert r.status_code == 401 and r.headers["x-request-id"] == given


# ── fe-u1 3: 안정 operationId·잠금 파일 ────────────────────────────────────────
def test_operation_ids_stable_and_unique():
    spec = app.openapi()
    ids = {(p, m): op["operationId"] for p, v in spec["paths"].items() for m, op in v.items() if m in OPS}
    assert len(set(ids.values())) == len(ids)
    explicit = {"listPrompts", "listPromptHistory"}                        # 라우트가 직접 준 값은 그대로
    for (p, m), oid in ids.items():
        if oid in explicit:
            continue
        want = f"{m}_" + re.sub(r"[^0-9A-Za-z]+", "_", re.sub(r"\{([^}]+)\}", r"by_\1", p)).strip("_")
        assert oid == want, (p, m, oid)
        assert not re.search(r"_\d+_v1_", oid), oid                           # FastAPI 기본(함수 이름의 등록 순번) 아님
    from fastapi.routing import APIRoute

    async def _ep() -> None:
        return None

    route = APIRoute("/v1/admin/ga4/markets/{brand_code}/{country_code}", endpoint=_ep, methods=["PUT"])
    assert stable_operation_id(route) == "put_v1_admin_ga4_markets_by_brand_code_by_country_code"


def _lock_pins(text: str) -> dict[str, str]:
    return {m.group(1).lower(): m.group(2) for m in re.finditer(r"^([A-Za-z0-9_.-]+)==([^\s\\;]+)", text, re.M)}


def test_requirements_locks_hash_pinned_and_split():
    """D-4(core 9): 런타임 잠금(requirements.lock)과 개발 잠금(requirements-dev.lock)으로 나누고 전부 해시 고정.
    pip install --require-hashes -r 로 설치된다(요구 항목마다 --hash). OpenAPI 판(fastapi·starlette·pydantic)은 런타임 잠금에 있고,
    개발 잠금 = 런타임 전부(같은 판) + 개발 도구. 지금 venv 의 판이 개발 잠금과 같아야 한다(잠금과 실행 환경 드리프트 방지)."""
    from importlib.metadata import version

    import fastapi
    import pydantic
    import starlette
    rt_text = (BACK / "requirements.lock").read_text(encoding="utf-8")
    dev_text = (BACK / "requirements-dev.lock").read_text(encoding="utf-8")
    rt, dev = _lock_pins(rt_text), _lock_pins(dev_text)
    assert rt["fastapi"] == fastapi.__version__ and rt["starlette"] == starlette.__version__ and rt["pydantic"] == pydantic.VERSION
    for text in (rt_text, dev_text):
        blocks = [b for b in re.split(r"\n(?=[A-Za-z0-9])", text) if b.strip() and not b.startswith("#")]
        assert blocks and all("--hash=sha256:" in b for b in blocks)
    assert set(dev) - set(rt) == {"pytest", "pytest-asyncio", "ruff", "pglast", "psycopg2-binary", "iniconfig", "packaging", "pluggy", "pygments"}
    assert all(dev[k] == v for k, v in rt.items())
    assert {k: version(k) for k in dev} == dev
    ci = (BACK.parent / "ci" / "github-workflows" / "back-ci.yml").read_text(encoding="utf-8")
    assert "pip install -q --require-hashes -r requirements-dev.lock" in ci and "-e \".[dev]\"" not in ci
    fci = (BACK.parent / "ci" / "github-workflows" / "front-ci.yml").read_text(encoding="utf-8")
    assert "pip install -q --require-hashes -r requirements.lock" in fci and "fastapi==" not in fci


# ── fe-u1 4·6: 업로드 응답 선언, cf.* 설명 ─────────────────────────────────────
def test_upload_routes_declare_413_415_and_cf_rules_described():
    spec = app.openapi()
    for p in ("/v1/admin/catalog/prompts/import/preview", "/v1/projects/{project_id}/prompts/import",
              "/v1/projects/{project_id}/settings/tracked-urls/import"):
        assert {"400", "413", "415"} <= set(spec["paths"][p]["post"]["responses"]), p
    assert "cf.<field_uuid>" in spec["info"]["description"] and "OR" in spec["info"]["description"]
    params = spec["paths"]["/v1/kpi/summary"]["get"]["parameters"]
    pid = next(x for x in params if x["name"] == "project_id")
    assert "cf.<field_uuid>" in pid["description"]


# ── fe-u1 5: 한쪽 기간 ─────────────────────────────────────────────────────────
def _body(r: httpx.Response) -> dict:
    assert r.status_code == 200, r.text
    return r.json()


@needs_db
async def test_one_sided_period_equals_front_fill(client_as):
    """빠진 to = latest_round_date, 빠진 from = first_measured_date(front resolveDateRange 와 같은 채움). 뒤집힘은 test_one_sided_inverted_folds_to_given_v61."""
    async with client_as(ADMIN) as c:
        for surface in ("global", "website"):
            d = _body(await c.get("/v1/filters/dates", params={"surface": surface}))["data"]
            latest, first = d["latest_round_date"], d["first_measured_date"]
            assert latest and first
            base = {"surface": surface}
            one = _body(await c.get("/v1/kpi/summary", params={**base, "from": first}))
            two = _body(await c.get("/v1/kpi/summary", params={**base, "from": first, "to": latest}))
            assert one == two and one["meta"]["mode"] == "cumulative"
            one = _body(await c.get("/v1/kpi/summary", params={**base, "to": latest}))
            assert one == two
            # 최신 회차보다 늦은 from → to = from(하루 창, 데이터 0), 422 아님
            late = _body(await c.get("/v1/kpi/summary", params={**base, "from": "2099-01-01"}))
            assert late["meta"]["cycles"] == [] and late["meta"]["mode"] == "cumulative"

@needs_db
async def test_one_sided_inverted_folds_to_given_v61(client_as):
    """검증 V6-1: 채운 쪽이 준 쪽을 넘어 뒤집히면 준 쪽으로 접는다(하루 창). to 만 준 값이 최초 회차보다 이르면 예전 max(lo, hi) 는
    to 를 최초 회차로 끌어올려 to 이후 회차(2026-09-07)를 냈다. 기대 = 양쪽을 준 from=2000-01-01&to=그날 과 같은 응답(회차 없음)."""
    from datetime import date, timedelta

    async with client_as(ADMIN) as c:
        for surface in ("global", "website"):
            d = _body(await c.get("/v1/filters/dates", params={"surface": surface}))["data"]
            first, latest = date.fromisoformat(d["first_measured_date"]), date.fromisoformat(d["latest_round_date"])
            base = {"surface": surface}
            before = (first - timedelta(days=1)).isoformat()
            one = _body(await c.get("/v1/kpi/summary", params={**base, "to": before}))
            two = _body(await c.get("/v1/kpi/summary", params={**base, "from": "2000-01-01", "to": before}))
            assert one["meta"]["cycles"] == [] == two["meta"]["cycles"], (surface, one["meta"]["cycles"])
            assert one["data"] == two["data"]
            after = (latest + timedelta(days=1)).isoformat()
            one = _body(await c.get("/v1/kpi/summary", params={**base, "from": after}))
            two = _body(await c.get("/v1/kpi/summary", params={**base, "from": after, "to": "2100-12-31"}))
            assert one["meta"]["cycles"] == [] == two["meta"]["cycles"] and one["data"] == two["data"]
            # 경계 안쪽 한쪽 기간은 그대로 닫힌다(to = 최초 회차 → 그 회차 하나)
            one = _body(await c.get("/v1/kpi/summary", params={**base, "to": first.isoformat()}))
            assert one["meta"]["cycles"] == [first.isoformat()]


async def test_close_period_unit_v61():
    """순수 규칙: 선택 가능 회차 [first, latest] 를 흉내 내 네 경우를 확인한다(DB 없이)."""
    from datetime import date
    from unittest.mock import patch

    from app.core import filters as F
    from app.core.cycles import RoundDates

    rd = RoundDates(dates=(date(2026, 9, 14),), total=2, first=date(2026, 9, 7), generation=1)

    async def fake(*a, **k):
        return rd

    with patch.object(F, "selectable_round_dates", fake):
        assert await F.close_period(None, "global", (), None, date(2026, 9, 6)) == (date(2026, 9, 6), date(2026, 9, 6))
        assert await F.close_period(None, "global", (), None, date(2026, 9, 10)) == (date(2026, 9, 7), date(2026, 9, 10))
        assert await F.close_period(None, "global", (), date(2026, 9, 15), None) == (date(2026, 9, 15), date(2026, 9, 15))
        assert await F.close_period(None, "global", (), date(2026, 9, 8), None) == (date(2026, 9, 8), date(2026, 9, 14))


@needs_db
async def test_one_sided_period_ignored_where_unsupported(client_as):
    async with client_as(ADMIN) as c:
        # 기간을 지원하지 않는 엔드포인트는 한쪽만 줘도 ignored_filters 'period'
        r = _body(await c.get("/v1/filters/dates", params={"surface": "global", "to": "2026-09-01"}))
        assert "period" in r["meta"]["ignored_filters"]
        # 두 값을 다 주면 기존 검증 그대로(from > to 422)
        assert (await c.get("/v1/kpi/summary", params={"surface": "global", "from": "2026-09-02", "to": "2026-09-01"})).status_code == 422


@needs_db
async def test_one_sided_period_keeps_pair_rule_where_declared(client_as):
    """회차 운영 목록은 자체 기본 창이라 쌍 규칙 유지, 전환 funnel 의 days 는 한쪽 기간과도 함께 줄 수 없다."""
    async with client_as(ADMIN) as c:
        assert (await c.get("/v1/admin/cycles", params={"surface": "global", "from": "2026-09-01"})).status_code == 422
        r = await c.get("/v1/funnel/conversion", params={"surface": "global", "days": 28, "to": "2026-09-01"})
        assert r.status_code == 422, r.text


# ── fe-u2 1·5: 세션 ───────────────────────────────────────────────────────────
@needs_db
async def test_session_account_countries_and_menu_groups(seeded, client_as):
    c0 = await asyncpg.connect(DB_URL)
    uid = uuid.uuid4()
    try:
        await c0.execute("SELECT set_config('app.actor_id', $1, false)", str(ADMIN))
        await c0.execute("INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands, scope_regions, scope_countries) "
                         "VALUES ($1, $2, 'country', 'none', false, '{Genesis}', '{genesis-middle-east}', ARRAY['sa-dammam','SA'])",
                         uid, f"t-fe-{uid}@example.test")
        async with client_as(uid) as c:
            s = _body(await c.get("/v1/auth/me"))["data"]
        assert s["scope"]["account_countries"] == ["SA-Dammam", "SA"]       # 저장 표기(정본) 그대로
        assert s["scope"]["countries"] == ["SA", "SA-DAMMAM"]                # 유효 국가(DataScope, 대문자)
        assert s["menu_groups"] is None
        async with client_as(HQ_HYUNDAI) as c:
            s = _body(await c.get("/v1/auth/me"))["data"]
        async with staged() as conn:
            p = await principal(conn, HQ_HYUNDAI)
        assert s["scope"]["account_countries"] == (list(p.scope_countries) or None)
        async with client_as(ADMIN) as c:
            s = _body(await c.get("/v1/auth/me"))["data"]
        assert s["scope"]["all"] is True and s["scope"]["account_countries"] is None
    finally:
        await c0.execute("DELETE FROM app.user_account WHERE user_id = $1", uid)
        await c0.close()


def test_session_menu_groups_empty_normalized():
    from app.core.auth import Principal
    from app.features.platform.auth.session.service import build_session

    p = Principal(user_id=ADMIN, email="a@example.test", display_name=None, role="hq", operator="none", scope_all=True,
                  scope_brands=(), scope_regions=(), scope_countries=(), menu_groups=(), is_qa_reviewer=False)  # type: ignore[call-arg]
    assert build_session(p, None).menu_groups is None                                            # type: ignore[arg-type]
