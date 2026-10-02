"""값 갭 보강(bg-qa-platform): BG-45 현재 세션 조회(GET /v1/qa/sessions/current), 결정 D2 신뢰 중계 클라이언트 IP(core.auth.client_ip).

기대값은 소유자 접속 독립 SQL(db_val·db_rows)과 손계산이다. 설정 교체는 qa_clean 이 테스트 끝에 되돌린다.
"""
from __future__ import annotations

import time
import uuid

import pytest
from pydantic import SecretStr
from starlette.requests import Request

from app.core.auth import QaReviewer, client_ip, hash_ip, relay_client_ip
from app.core.config import get_settings, load_settings, set_settings
from app.features.qa.answers.list.tests.qa_support import db_exec, db_val, new_session, qa_client
from tests.support import ADMIN, needs_db

SECRET = "relay-secret-0123456789abcdef"          # 테스트 전용 값(16자 이상)


def _req(headers: list[tuple[str, str]], client: tuple[str, int] = ("10.0.0.9", 5555)) -> Request:
    return Request({"type": "http", "method": "GET", "path": "/", "headers": [(k.lower().encode(), v.encode()) for k, v in headers],
                    "client": client})


def _with_relay(secret: str | None, hops: int = 0) -> None:
    set_settings(get_settings().model_copy(update={"relay_secret": SecretStr(secret) if secret else None, "trusted_proxy_hops": hops}))


# ════════════════════════════════════════════════════════════════════════════
# D2: 신뢰 중계 헤더(단위, DB 불필요)
# ════════════════════════════════════════════════════════════════════════════
@pytest.fixture
def restore_settings():
    prev = get_settings()
    yield
    set_settings(prev)


@pytest.mark.usefixtures("restore_settings")
def test_d2_relay_unset_ignores_headers():
    _with_relay(None)
    r = _req([("x-hgh-relay-secret", SECRET), ("x-hgh-client-ip", "203.0.113.5")])
    assert relay_client_ip(r) is None and client_ip(r) == "10.0.0.9"          # 미설정: 헤더 무시(기존 규칙 = 소켓 주소)


@pytest.mark.usefixtures("restore_settings")
def test_d2_relay_trusted_only_with_matching_secret():
    _with_relay(SECRET)
    ok = [("x-hgh-relay-secret", SECRET), ("x-hgh-client-ip", "203.0.113.5")]
    assert client_ip(_req(ok)) == "203.0.113.5"
    assert client_ip(_req(ok), hops=0) == "203.0.113.5"                         # 명시 hops 와 무관하게 중계 헤더가 먼저
    assert client_ip(_req([("x-hgh-relay-secret", SECRET), ("x-hgh-client-ip", " 2001:DB8:0:0::1 ")])) == "2001:db8::1"   # 표준 표기
    cases = [
        [("x-hgh-relay-secret", SECRET[:-1] + "X"), ("x-hgh-client-ip", "203.0.113.5")],            # 비밀 불일치
        [("x-hgh-relay-secret", SECRET + "x"), ("x-hgh-client-ip", "203.0.113.5")],                 # 길이 다름
        [("x-hgh-relay-secret", ""), ("x-hgh-client-ip", "203.0.113.5")],                           # 빈 값
        [("x-hgh-client-ip", "203.0.113.5")],                                                       # 비밀 헤더 없음
        [("x-hgh-relay-secret", SECRET)],                                                           # IP 헤더 없음
        [("x-hgh-relay-secret", SECRET), ("x-hgh-relay-secret", SECRET), ("x-hgh-client-ip", "203.0.113.5")],   # 비밀 헤더 중복
        [("x-hgh-relay-secret", SECRET), ("x-hgh-client-ip", "203.0.113.5"), ("x-hgh-client-ip", "198.51.100.1")],   # IP 헤더 중복
        [("x-hgh-relay-secret", SECRET), ("x-hgh-client-ip", "evil")],                              # 주소 형식 아님
        [("x-hgh-relay-secret", SECRET), ("x-hgh-client-ip", "203.0.113.5, 198.51.100.1")],          # 목록 불가
        [("x-hgh-relay-secret", SECRET), ("x-hgh-client-ip", "1" * 70)],                            # 64자 초과
    ]
    for h in cases:
        assert relay_client_ip(_req(h)) is None, h
        assert client_ip(_req(h)) == "10.0.0.9", h                                                  # 기존 규칙(소켓 주소)


@pytest.mark.usefixtures("restore_settings")
def test_d2_relay_mismatch_falls_back_to_xff_rule():
    _with_relay(SECRET, hops=2)
    xff = ("x-forwarded-for", "6.6.6.6, 1.2.3.4, 130.176.0.1")
    assert client_ip(_req([xff, ("x-hgh-relay-secret", "wrong-secret-000000000"), ("x-hgh-client-ip", "9.9.9.9")])) == "1.2.3.4"
    assert client_ip(_req([xff, ("x-hgh-relay-secret", SECRET), ("x-hgh-client-ip", "9.9.9.9")])) == "9.9.9.9"


def test_d2_config_relay_secret():
    assert load_settings({"HGH_ENV": "test"}).relay_secret is None
    s = load_settings({"HGH_ENV": "test", "HGH_RELAY_SECRET": SECRET})
    assert s.relay_secret is not None and s.relay_secret.get_secret_value() == SECRET
    assert SECRET not in repr(s) and SECRET not in str(s)                     # 비밀값 출력 금지
    with pytest.raises(ValueError, match="HGH_RELAY_SECRET"):
        load_settings({"HGH_ENV": "test", "HGH_RELAY_SECRET": "short"})


# ════════════════════════════════════════════════════════════════════════════
# D2: 입장 경로(POST /v1/qa/sessions)가 중계 IP 로 시도 상한·ip_hash 를 센다
# ════════════════════════════════════════════════════════════════════════════
async def _attempts(c, n: int, headers) -> list[int]:
    return [(await c.post("/v1/qa/sessions", json={"name": "z", "password": "bad"}, headers=headers(i))).status_code for i in range(n)]


@needs_db
@pytest.mark.usefixtures("qa_clean")
async def test_d2_login_uses_relay_ip_only_with_secret(client_as):
    _with_relay(SECRET)
    async with qa_client(client_as, None) as c:
        # 비밀이 맞으면 뷰어마다 자기 버킷(BFF 출구 IP 한 버킷으로 뭉치지 않는다)
        codes = await _attempts(c, 12, lambda i: {"x-hgh-relay-secret": SECRET, "x-hgh-client-ip": f"203.0.113.{i}"})
        assert codes == [401] * 12
        same = await _attempts(c, 11, lambda i: {"x-hgh-relay-secret": SECRET, "x-hgh-client-ip": "198.51.100.7"})
        assert same == [401] * 10 + [429]                                     # 같은 뷰어는 IP 당 10회
        r = await c.post("/v1/qa/sessions", json={"name": "갑", "password": "pw-test"},
                         headers={"x-hgh-relay-secret": SECRET, "x-hgh-client-ip": "192.0.2.44"})
    assert r.status_code == 201, r.text
    ip_h = await db_val("SELECT ip_hash FROM app.qa_review_session WHERE session_id = $1", uuid.UUID(r.json()["data"]["session_id"]))
    assert ip_h == hash_ip("192.0.2.44")


@needs_db
@pytest.mark.usefixtures("qa_clean")
async def test_d2_login_forged_relay_without_secret_is_ignored(client_as):
    _with_relay(SECRET)
    async with qa_client(client_as, None) as c:
        codes = await _attempts(c, 11, lambda i: {"x-hgh-relay-secret": "guess-guess-guess-0", "x-hgh-client-ip": f"203.0.113.{i}"})
    assert codes == [401] * 10 + [429]                                         # 위조 헤더는 무시 → 소켓 주소 한 버킷
    _with_relay(None)
    from app.features.qa.review.sessions.service import limiter
    limiter.reset()
    async with qa_client(client_as, None) as c:
        codes = await _attempts(c, 11, lambda i: {"x-hgh-relay-secret": SECRET, "x-hgh-client-ip": f"203.0.113.{i}"})
    assert codes == [401] * 10 + [429]                                         # 미설정이면 맞는 값이라도 무시


# ════════════════════════════════════════════════════════════════════════════
# BG-45: GET /v1/qa/sessions/current(부작용 없는 현재 세션 조회)
# ════════════════════════════════════════════════════════════════════════════
@needs_db
@pytest.mark.usefixtures("qa_clean")
async def test_bg45_current_returns_row_without_side_effect(client_as):
    rv = await new_session("갑")
    sid = uuid.UUID(rv.session_id)
    await db_exec("UPDATE app.qa_review_session SET last_seen_at = now() - interval '1 hour' WHERE session_id = $1", sid)
    before = await db_val("SELECT last_seen_at FROM app.qa_review_session WHERE session_id = $1", sid)
    started = await db_val("SELECT started_at FROM app.qa_review_session WHERE session_id = $1", sid)
    async with qa_client(client_as, rv) as c:
        r = await c.get("/v1/qa/sessions/current")
        r2 = await c.get("/v1/qa/sessions/current")
    assert r.status_code == 200, r.text
    assert r.headers["cache-control"] == "no-store" and "set-cookie" not in r.headers
    d = r.json()["data"]
    assert d["session_id"] == rv.session_id and d["reviewer_name"] == "갑"
    assert d == r2.json()["data"]                                              # 두 번 불러도 같다(갱신 없음)
    assert await db_val("SELECT last_seen_at FROM app.qa_review_session WHERE session_id = $1", sid) == before   # last_seen_at 그대로
    from datetime import datetime
    assert datetime.fromisoformat(d["last_seen_at"]) == before and datetime.fromisoformat(d["started_at"]) == started
    assert r.json()["meta"]["mode"] == "qa"


@needs_db
@pytest.mark.usefixtures("qa_clean")
async def test_bg45_current_rejects_missing_revoked_expired(client_as, settings):
    rv, other = await new_session("갑"), await new_session("을")
    async with qa_client(client_as, None) as c:
        r = await c.get("/v1/qa/sessions/current")
        assert r.status_code == 401 and r.json()["error"]["code"] == "qa_unauthorized"
    async with qa_client(client_as, None, bearer=ADMIN) as c:                  # 일반 계정 JWT 로는 열리지 않는다
        assert (await c.get("/v1/qa/sessions/current")).status_code == 401
    async with qa_client(client_as, QaReviewer(rv.session_id, rv.name, time.time() - 13 * 3600)) as c:   # 12시간 하드 만료
        assert (await c.get("/v1/qa/sessions/current")).status_code == 401
    async with qa_client(client_as, QaReviewer("not-a-uuid", "x", time.time())) as c:                 # 서명은 맞고 id 형식 오류
        assert (await c.get("/v1/qa/sessions/current")).status_code == 401
    async with qa_client(client_as, rv) as c:
        assert (await c.get("/v1/qa/sessions/current")).json()["data"]["session_id"] == rv.session_id   # 남의 세션은 보이지 않는다
        assert (await c.get(f"/v1/qa/sessions/{other.session_id}")).status_code == 405                  # id 경로는 PATCH 전용 그대로
        set_settings(settings.model_copy(update={"qa_enabled": False}))                                  # 킬 스위치
        try:
            assert (await c.get("/v1/qa/sessions/current")).status_code == 401
        finally:
            set_settings(settings)
        assert (await c.patch(f"/v1/qa/sessions/{rv.session_id}", json={"logout": True})).status_code == 200
        r = await c.get("/v1/qa/sessions/current")                                                        # 로그아웃(행 삭제) 뒤
    assert r.status_code == 401 and r.json()["error"]["code"] == "qa_unauthorized"
    async with qa_client(client_as, other) as c:
        await db_exec("DELETE FROM app.qa_review_session WHERE session_id = $1", uuid.UUID(other.session_id))   # 운영 폐기
        assert (await c.get("/v1/qa/sessions/current")).status_code == 401
