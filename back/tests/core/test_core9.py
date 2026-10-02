"""core 9라운드: D-1(stg·prod API 문서 경로 끔), D-2(토큰 검증이 DB 커넥션보다 먼저)."""
from __future__ import annotations

import os
import pathlib
import subprocess
import sys

import httpx
import jwt
import pytest
from fastapi import FastAPI, Request
from fastapi.routing import APIRoute
from sqlalchemy import event
from sqlalchemy.pool import Pool

from app.core import auth as auth_mod
from app.core import db as db_mod
from app.core.auth import CurrentUser
from app.core.db import AdminLongConn, RoConn
from app.core.errors import ApiError, install_error_handlers
from app.main import app, docs_urls
from tests.support import ADMIN, TEST_KID, needs_db

BACK = pathlib.Path(__file__).resolve().parents[2]


# ── D-1: /openapi.json·/docs·/redoc 는 local·test 에서만 ─────────────────────────
def test_docs_urls_by_env():
    on = {"openapi_url": "/openapi.json", "docs_url": "/docs", "redoc_url": "/redoc"}
    off = {"openapi_url": None, "docs_url": None, "redoc_url": None}
    assert docs_urls(None) == docs_urls("") == docs_urls("local") == docs_urls("test") == docs_urls(" test ") == on
    for env in ("stg", "prod", "production", "PROD", "unknown"):          # 알 수 없는 값도 닫는다(fail-closed)
        assert docs_urls(env) == off, env


_PROBE = """
import json, sys
from fastapi.testclient import TestClient
from app.main import app, docs_urls
c = TestClient(app)
codes = {p: c.get(p).status_code for p in ("/openapi.json", "/docs", "/redoc", "/docs/oauth2-redirect")}
print(json.dumps({"codes": codes, "paths": len(app.openapi()["paths"]), "healthz": c.get("/healthz").status_code}))
"""


@pytest.mark.parametrize("env", ["stg", "prod", "test"])
def test_docs_routes_follow_hgh_env_in_fresh_process(env):
    """앱은 import 시점의 HGH_ENV 로 경로를 정한다(systemd 유닛 Environment=HGH_ENV). 새 프로세스로 확인한다.
    stg·prod 에서도 app.openapi() 는 그대로 만들어진다(front 계약 생성은 프로세스 안 호출이라 영향 없음)."""
    import json

    envv = {k: v for k, v in os.environ.items() if not k.startswith("HGH_")}
    envv.update({"HGH_ENV": env, "PYTHONPATH": str(BACK)})
    out = subprocess.run([sys.executable, "-W", "ignore", "-c", _PROBE], cwd=BACK, env=envv, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-2000:]
    got = json.loads(out.stdout.strip().splitlines()[-1])
    want = 404 if env in ("stg", "prod") else 200
    assert got["codes"]["/openapi.json"] == want and got["codes"]["/docs"] == want and got["codes"]["/redoc"] == want, got
    assert got["paths"] > 100 and got["healthz"] == 200


# ── D-2: 무인증·토큰 오류는 풀 커넥션 없이 401 ─────────────────────────────────
def _routes(rs):
    for r in rs:
        if isinstance(r, APIRoute):
            yield r
        elif hasattr(r, "original_router"):                                  # FastAPI include_router 지연 포함(_IncludedRouter)
            yield from _routes(r.original_router.routes)


def _calls(dep, out: set) -> set:
    for d in dep.dependencies:
        out.add(d.call)
        _calls(d, out)
    return out


_BEARER = {auth_mod.get_principal, auth_mod.get_principal_detached, db_mod.get_ro_conn,
           db_mod.get_admin_long_conn}


def bearer_routes() -> list[APIRoute]:
    return [r for r in _routes(app.routes) if _calls(r.dependant, set()) & _BEARER]


class _Opened:
    """풀 체크아웃(SQLAlchemy Pool checkout 이벤트) + Database.transaction 호출 수."""

    def __init__(self, monkeypatch):
        self.checkouts = 0
        self.transactions: list[str] = []
        orig = db_mod.Database.transaction

        def tx(inner, pool, **kw):
            self.transactions.append(pool)
            return orig(inner, pool, **kw)

        monkeypatch.setattr(db_mod.Database, "transaction", tx)

    def on_checkout(self, *_):
        self.checkouts += 1


@pytest.fixture
def opened(monkeypatch):
    o = _Opened(monkeypatch)
    event.listen(Pool, "checkout", o.on_checkout)
    yield o
    event.remove(Pool, "checkout", o.on_checkout)


def _url(r: APIRoute) -> str:
    path = r.path_format
    for name in r.param_convertors:
        path = path.replace("{" + name + "}", "00000000-0000-4000-8000-000000000000")
    return path


@needs_db
async def test_unauthenticated_requests_open_no_connection(database, token, opened):
    """Bearer 경로 전부에 무토큰·형식 오류 토큰·만료 토큰을 보내면 401 이고 풀 커넥션 획득·트랜잭션 0.
    대조: 같은 계측에서 정상 토큰 요청은 커넥션을 잡는다(계측이 살아 있음)."""
    routes = bearer_routes()
    assert len(routes) > 150                                                 # 전 기능 라우터(누락 감지)
    expired = token(ADMIN, exp_in=-3600)
    heads = ({}, {"Authorization": "Bearer not-a-jwt"}, {"Authorization": f"Bearer {expired}"}, {"Authorization": "Basic x"})
    bad: list[tuple[str, str, int]] = []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        for r in routes:
            m = sorted(r.methods)[0]
            for h in heads:
                resp = await c.request(m, _url(r), headers=h)
                if resp.status_code != 401:
                    bad.append((m, r.path, resp.status_code))
        assert not bad, bad[:10]
        assert opened.checkouts == 0 and opened.transactions == [], (opened.checkouts, opened.transactions[:5])
        ok = await c.get("/v1/auth/me", headers={"Authorization": f"Bearer {token(ADMIN)}"})
    assert ok.status_code == 200
    assert opened.checkouts >= 1 and opened.transactions == ["api_ro"]


@needs_db
async def test_handler_declaring_conn_before_user_still_verifies_first(database, token, opened):
    """핸들러가 RoConn 을 CurrentUser 보다 앞에 선언해도(의존성 해석 순서 = 선언 순서) 커넥션 전에 토큰을 본다.
    검증 성공 값은 요청당 한 번만 계산한다(get_principal 과 커넥션 의존성이 공유)."""
    a = FastAPI()
    install_error_handlers(a)
    calls = {"verify": 0}
    orig = auth_mod.get_verifier().verify

    async def counting(tok):
        calls["verify"] += 1
        return await orig(tok)

    @a.get("/ro-first")
    async def ro_first(conn: RoConn, p: CurrentUser) -> dict:
        return {"uid": str(p.user_id)}

    @a.get("/long-only")
    async def long_only(conn: AdminLongConn) -> dict:
        return {"ok": True}

    v = auth_mod.get_verifier()
    v.verify = counting                                                        # type: ignore[method-assign]
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=a), base_url="http://t") as c:
            for path in ("/ro-first", "/long-only"):
                assert (await c.get(path)).status_code == 401
                assert (await c.get(path, headers={"Authorization": "Bearer x.y.z"})).status_code == 401
            assert opened.checkouts == 0 and opened.transactions == []
            calls["verify"] = 0
            r = await c.get("/ro-first", headers={"Authorization": f"Bearer {token(ADMIN)}"})
            assert r.status_code == 200 and r.json()["uid"] == str(ADMIN)
            assert calls["verify"] == 1                                        # 커넥션 의존성과 get_principal 이 한 번 검증을 공유
            assert opened.transactions == ["api_ro"]
    finally:
        del v.verify


async def test_sub_claim_must_be_uuid_before_connection(token, rsa_key):
    """sub 형식 오류도 커넥션 전 401(verified_subject). 성공 값은 request.state 에 한 번만 계산된다."""
    import time

    from starlette.requests import Request

    def req(tok: str) -> Request:
        return Request({"type": "http", "headers": [(b"authorization", f"Bearer {tok}".encode())], "state": {}})

    with pytest.raises(ApiError) as ei:
        now = int(time.time())
        bad = jwt.encode({"sub": "nope", "aud": "authenticated", "exp": now + 600, "iat": now}, rsa_key, algorithm="RS256",
                         headers={"kid": TEST_KID})
        await auth_mod.verified_subject(req(bad))
    assert ei.value.status == 401
    r = req(token(ADMIN))
    assert await auth_mod.verified_subject(r) == ADMIN
    same = Request({"type": "http", "headers": [], "state": r.scope["state"]})  # 같은 요청 상태, 헤더 없음 → 캐시 값(재검증 없음)
    assert await auth_mod.verified_subject(same) == ADMIN


# ── D-7: LLM 재시도 포함 총 시간을 요청 기한 안으로 ────────────────────────────────
def _or_settings():
    from pydantic import SecretStr

    from app.core.config import Settings
    return Settings(env="test", openrouter_api_key=SecretStr("or-key-test"))


def _ok_body() -> dict:
    import json
    return {"choices": [{"message": {"content": json.dumps({"k": 1})}}]}


class _FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def _client(handler, *, deadline_in: float | None, clock=None, **kw):
    from app.core.llm import OpenRouterClient

    clk = clock or _FakeClock()
    dl = None if deadline_in is None else clk() + deadline_in
    return OpenRouterClient(_or_settings(), transport=httpx.MockTransport(handler), deadline=dl, clock=clk, **kw), clk


async def _call(c, **kw):
    return await c.complete_json("p", {"type": "object"}, temperature=0, max_tokens=10, **kw)


async def test_llm_retry_skipped_when_deadline_too_short():
    """첫 시도가 170초 걸려 5xx: 남은 5초 - 대기 1.5초 < 최소 5초 → 재시도 없이 기한 오류(504). 예전은 1.5초 뒤 한 번 더 180초를 썼다."""
    from app.core.llm import LlmError, call_llm

    calls = []
    clk = _FakeClock()

    def slow_500(req):
        calls.append(clk.t)
        clk.t += 170
        return httpx.Response(503)

    c, _ = _client(slow_500, deadline_in=175, clock=clk)
    with pytest.raises(LlmError) as ei:
        await _call(c, timeout_s=180)
    assert ei.value.kind == "deadline" and len(calls) == 1
    with pytest.raises(ApiError) as ae:                                           # API 오류 매핑: 504 llm_timeout
        clk.t = 1000.0
        await call_llm(_client(slow_500, deadline_in=175, clock=clk)[0], "p", {}, temperature=0, max_tokens=1, timeout_s=180)
    assert (ae.value.status, ae.value.code) == (504, "llm_timeout")


async def test_llm_retry_allowed_within_deadline_and_without_deadline():
    """빠른 429 뒤 기한이 넉넉하면 재시도(성공). 기한이 없는 호출(기존 호출자)은 예전처럼 1회 재시도."""
    for deadline_in in (175.0, None):
        seq = [httpx.Response(429), httpx.Response(200, json=_ok_body())]
        clk = _FakeClock()

        def h(req, seq=seq, clk=clk):
            clk.t += 1
            return seq.pop(0)

        c, _ = _client(h, deadline_in=deadline_in, clock=clk, backoff_s=0.0)
        assert await _call(c, timeout_s=180) == {"k": 1} and seq == []


async def test_llm_no_call_when_deadline_already_short():
    """남은 기한 < 최소 시도 시간이면 호출 자체를 하지 않는다(과금 0)."""
    from app.core.llm import LlmError

    calls = []
    c, _ = _client(lambda req: calls.append(1) or httpx.Response(200, json=_ok_body()), deadline_in=3.0)
    with pytest.raises(LlmError) as ei:
        await _call(c)
    assert ei.value.kind == "deadline" and calls == []


async def test_llm_attempt_capped_by_deadline_real_time():
    """느린 본문: 시도 제한 = 남은 기한(0.4초). 기한에 잘린 시도는 재시도하지 않는다. 실제 시간 < 1.5초(예전: 60초 read timeout 두 번)."""
    import asyncio
    import time

    from app.core.llm import LlmError, OpenRouterClient

    calls = []

    async def hang(req):
        calls.append(1)
        await asyncio.sleep(30)
        return httpx.Response(200, json=_ok_body())

    c = OpenRouterClient(_or_settings(), transport=httpx.MockTransport(hang), deadline=time.monotonic() + 0.4, min_attempt_s=0.1)
    t0 = time.monotonic()
    with pytest.raises(LlmError) as ei:
        await _call(c, timeout_s=60)
    assert ei.value.kind == "deadline" and calls == [1] and time.monotonic() - t0 < 1.5


async def test_llm_attempt_total_cap_without_deadline():
    """기한이 없어도 시도 하나는 timeout_s 를 넘지 못한다(asyncio.timeout 총량 상한). 두 시도 + 대기 뒤 502 계열(upstream)."""
    import asyncio
    import time

    from app.core.llm import LlmError, OpenRouterClient

    async def hang(req):
        await asyncio.sleep(30)
        return httpx.Response(200, json=_ok_body())

    c = OpenRouterClient(_or_settings(), transport=httpx.MockTransport(hang), backoff_s=0.05)
    t0 = time.monotonic()
    with pytest.raises(LlmError) as ei:
        await _call(c, timeout_s=0.2)
    assert ei.value.kind == "upstream" and time.monotonic() - t0 < 1.5


def test_every_llm_route_has_deadline_under_bff_wait():
    """get_llm 을 쓰는 라우트는 전부 request_deadline 을 건다. 상한은 프론트 BFF 대기보다 짧다(front/lib/hgh/adapters)."""
    from app.core.llm import get_llm

    bff_wait = {"/v1/admin/keyword-tools/to-prompt": 185, "/v1/admin/keyword-tools/prompt-to-volume": 185,
                "/v1/intent/social/prompts": 110, "/v1/intent/serp-drafts": 70}
    seen = {}
    for r in _routes(app.routes):
        calls = _calls(r.dependant, set())
        if get_llm not in calls:
            continue
        budgets = [c.hgh_llm_budget_s for c in calls if hasattr(c, "hgh_llm_budget_s")]
        assert len(budgets) == 1, r.path
        seen[r.path] = budgets[0]
        spec = app.openapi()["paths"][r.path][sorted(r.methods)[0].lower()]
        assert {"502", "504"} <= set(spec["responses"]), r.path
        assert any(p["name"] == "X-HGH-Timeout-Ms" and p["in"] == "header" for p in spec["parameters"]), r.path
    assert set(seen) == set(bff_wait), seen
    for path, b in seen.items():
        assert b <= bff_wait[path] - 5, (path, b)


@needs_db
async def test_llm_route_header_deadline_short_circuits(client_as):
    """라우트 경로: X-HGH-Timeout-Ms 가 짧으면(3초 - 여유 2초 = 1초 < 최소 5초) LLM 을 부르지 않고 504 llm_timeout.
    헤더 범위 밖(0)은 422. 헤더가 없으면 라우트 상수 기한으로 정상 호출."""
    from app.core import llm as llm_mod

    calls = []

    def ok(req):
        calls.append(1)
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"keywords": []}'}}]})

    def fake_get_llm(request: Request):
        return llm_mod.OpenRouterClient(_or_settings(), transport=httpx.MockTransport(ok),
                                        deadline=getattr(request.state, llm_mod._DEADLINE_STATE, None))

    app.dependency_overrides[llm_mod.get_llm] = fake_get_llm
    try:
        async with client_as(ADMIN) as c:
            r = await c.post("/v1/admin/keyword-tools/prompt-to-volume", json={"prompt_text": "x"}, headers={"X-HGH-Timeout-Ms": "3000"})
            assert r.status_code == 504 and r.json()["error"]["code"] == "llm_timeout" and calls == [], r.text
            r = await c.post("/v1/admin/keyword-tools/prompt-to-volume", json={"prompt_text": "x"}, headers={"X-HGH-Timeout-Ms": "0"})
            assert r.status_code == 422 and calls == []
            r = await c.post("/v1/admin/keyword-tools/prompt-to-volume", json={"prompt_text": "x"})
            assert r.status_code == 200 and calls == [1], r.text
    finally:
        app.dependency_overrides.pop(llm_mod.get_llm, None)
