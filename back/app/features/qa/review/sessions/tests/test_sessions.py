"""qa.review.sessions: 검수 게이트 입장(쿠키 발급)·세션 갱신."""
from __future__ import annotations

import contextlib
import time
import uuid
from collections.abc import Iterator

import pytest

from app.core.auth import QaReviewer, assert_qa_session, hash_ip, rate_key_ip
from app.core.config import get_settings, set_settings
from app.features.qa.answers.list.tests.qa_support import db_exec, db_rows, db_val, job_id_of, new_session, qa_client
from app.features.qa.review.sessions.service import GLOBAL_ATTEMPTS_PER_MINUTE, LoginLimiter
from tests.support import needs_db

pytestmark = [needs_db, pytest.mark.usefixtures("qa_clean")]


@contextlib.contextmanager
def proxy_hops(n: int) -> Iterator[None]:
    """신뢰 프록시 홉 수 교체(qa R6: 기능 안 set_trusted_proxy_hops 를 지우고 core.config.trusted_proxy_hops 를 쓴다)."""
    prev = get_settings()
    set_settings(prev.model_copy(update={"trusted_proxy_hops": n}))
    try:
        yield
    finally:
        set_settings(prev)


async def test_login_sets_cookie_and_opens_gate(client_as):
    async with qa_client(client_as, None) as c:
        r = await c.post("/v1/qa/sessions", json={"name": "  검수자\x07A ", "password": "pw-test"})
        assert r.status_code == 201, r.text
        d = r.json()["data"]
        assert d["reviewer_name"] == "검수자A"                                         # 제어문자 제거·trim
        sc = r.headers["set-cookie"].lower()
        assert sc.startswith("raw_data_qa=") and "httponly" in sc and "samesite=lax" in sc and "max-age" not in sc   # 세션 쿠키
        rows = await db_rows("SELECT reviewer_name, ip_hash FROM app.qa_review_session WHERE session_id = $1", uuid.UUID(d["session_id"]))
        assert rows[0]["reviewer_name"] == "검수자A" and rows[0]["ip_hash"] and "127.0.0.1" not in rows[0]["ip_hash"]   # 원문 IP 저장 안 함
        assert (await c.get("/v1/qa/answers", params={"limit": 1})).status_code == 200          # 발급 쿠키로 게이트 통과


@pytest.mark.parametrize("body, status, code", [
    ({"name": "a", "password": "wrong"}, 401, "bad_credentials"),
    ({"name": "   ", "password": "pw-test"}, 422, "bad_name"),
    ({"name": "x" * 41, "password": "pw-test"}, 422, "bad_name"),
    ({"name": "a", "password": "pw-test", "extra": 1}, 422, "unprocessable"),
    ({"name": "a"}, 422, "unprocessable"),
])
async def test_login_rejects(client_as, body, status, code):
    async with qa_client(client_as, None) as c:
        r = await c.post("/v1/qa/sessions", json=body)
    assert r.status_code == status and r.json()["error"]["code"] == code
    assert "set-cookie" not in r.headers
    assert await db_val("SELECT count(*) FROM app.qa_review_session") == 0


async def test_login_rate_limited(client_as):
    async with qa_client(client_as, None) as c:
        codes = [(await c.post("/v1/qa/sessions", json={"name": "a", "password": "bad"})).status_code for _ in range(11)]
        assert codes == [401] * 10 + [429]
        r = await c.post("/v1/qa/sessions", json={"name": "a", "password": "pw-test"})      # 상한 안에서는 맞는 비밀번호도 막힌다
        assert r.status_code == 429 and r.json()["error"]["code"] == "rate_limited"


async def test_login_kill_switch_and_no_password(client_as, settings):
    async with qa_client(client_as, None) as c:
        set_settings(settings.model_copy(update={"qa_enabled": False}))
        try:
            r = await c.post("/v1/qa/sessions", json={"name": "a", "password": "pw-test"})
            assert r.status_code == 404
            set_settings(settings.model_copy(update={"qa_password": None}))        # 기본 비밀번호 없음
            r = await c.post("/v1/qa/sessions", json={"name": "a", "password": ""})
            assert r.status_code == 401
        finally:
            set_settings(settings)


async def test_touch_own_session_only(client_as):
    rv, other = await new_session("갑"), await new_session("을")
    await db_exec("UPDATE app.qa_review_session SET last_seen_at = now() - interval '1 hour' WHERE session_id = $1", uuid.UUID(rv.session_id))
    async with qa_client(client_as, rv) as c:
        r = await c.patch(f"/v1/qa/sessions/{rv.session_id}")
        assert r.status_code == 200 and r.json()["data"]["reviewer_name"] == "갑"
        assert await db_val("SELECT last_seen_at > now() - interval '1 minute' FROM app.qa_review_session WHERE session_id = $1",
                            uuid.UUID(rv.session_id))
        r = await c.patch(f"/v1/qa/sessions/{other.session_id}")
        assert r.status_code == 403 and r.json()["error"]["code"] == "session_forbidden"
        await db_exec("DELETE FROM app.qa_review_session WHERE session_id = $1", uuid.UUID(rv.session_id))
        r = await c.patch(f"/v1/qa/sessions/{rv.session_id}")                      # 서버 측 폐기(행 삭제)
        assert r.status_code == 401 and r.json()["error"]["code"] == "qa_unauthorized"
    async with qa_client(client_as, None) as c:
        assert (await c.patch(f"/v1/qa/sessions/{other.session_id}")).status_code == 401


async def test_expired_cookie_rejected(client_as):
    rv = await new_session("갑")
    old = QaReviewer(rv.session_id, rv.name, time.time() - 13 * 3600)                 # 12시간 하드 만료
    async with qa_client(client_as, old) as c:
        assert (await c.patch(f"/v1/qa/sessions/{rv.session_id}")).status_code == 401


# ── D1: 입장 시도 상한은 위조 가능한 X-Forwarded-For 첫 원소를 믿지 않는다 ──
async def _attempts(c, n: int, xff) -> list[int]:
    out = []
    for i in range(n):
        h = {"x-forwarded-for": xff(i)} if xff else {}
        out.append((await c.post("/v1/qa/sessions", json={"name": "z", "password": "bad"}, headers=h)).status_code)
    return out


async def test_d1_rotating_xff_does_not_bypass_limit_default(client_as):
    """재현(D1): XFF 를 매번 바꾸면 429 가 한 번도 안 나왔다. 기본(홉 0)은 XFF 를 무시하고 소켓 주소로 센다."""
    async with qa_client(client_as, None) as c:
        codes = await _attempts(c, 12, lambda i: f"9.9.9.{i}")
    assert codes == [401] * 10 + [429, 429]


async def test_d1_trusted_hops_uses_proxy_appended_ip(client_as):
    """배포(CloudFront → ALB, 홉 2): 오른쪽에서 두 번째(CloudFront 가 붙인 뷰어 IP)만 쓴다. 왼쪽 위조 원소를 돌려도 같은 버킷."""
    with proxy_hops(2):
        async with qa_client(client_as, None) as c:
            codes = await _attempts(c, 12, lambda i: f"6.6.6.{i}, 1.2.3.4, 130.176.0.{i}")
            assert codes == [401] * 10 + [429, 429]
            other = await _attempts(c, 1, lambda i: "6.6.6.6, 5.6.7.8, 130.176.0.9")          # 다른 뷰어는 자기 버킷
            assert other == [401]
            short = await _attempts(c, 1, lambda i: "1.2.3.4")                                   # 원소가 모자라면 소켓 주소로 폴백
            assert short == [401]
            r = await c.post("/v1/qa/sessions", json={"name": "갑", "password": "pw-test"},
                             headers={"x-forwarded-for": "evil, 5.6.7.8, 130.176.0.1"})
        assert r.status_code == 201
        ip_h = await db_val("SELECT ip_hash FROM app.qa_review_session WHERE session_id = $1", uuid.UUID(r.json()["data"]["session_id"]))
        assert ip_h == hash_ip("5.6.7.8") and ip_h != hash_ip("evil")                         # ip_hash 도 위조되지 않는다


async def test_d1_global_cap_across_ips(client_as):
    """실제로 IP 를 여럿 쓰는 대입도 전역 분당 상한(60)에 묶인다."""
    with proxy_hops(1):
        async with qa_client(client_as, None) as c:
            codes = await _attempts(c, 62, lambda i: f"10.0.{i // 5}.{i % 5}")
    assert codes == [401] * GLOBAL_ATTEMPTS_PER_MINUTE + [429, 429]


async def test_n1_ipv6_rotation_within_64_shares_one_bucket(client_as):
    """검증 N1 회귀: IPv6 /64 하나 안에서 주소를 돌리면 IP 당 상한(10)이 한 번도 걸리지 않고 전역 상한(60)만 소진됐다.
    버킷 키는 IPv6 /64 접두(IPv4·IPv4 사상 주소는 그대로), 세션 행 ip_hash 는 원래 주소 그대로다."""
    with proxy_hops(2):
        async with qa_client(client_as, None) as c:
            codes = await _attempts(c, 12, lambda i: f"6.6.6.6, 2001:db8:0:1::{i + 1:x}, 130.176.0.1")
            assert codes == [401] * 10 + [429, 429]
            assert await _attempts(c, 1, lambda i: "2001:db8:0:1:ffff:ffff:ffff:ffff, 130.176.0.1") == [429]   # 같은 /64 끝 주소
            assert await _attempts(c, 1, lambda i: "2001:db8:0:2::1, 130.176.0.1") == [401]                  # 다른 /64 는 자기 버킷
            v4 = await _attempts(c, 11, lambda i: f"::ffff:198.51.100.{i % 2}, 130.176.0.1")                    # IPv4 사상 = IPv4 주소별
            assert v4 == [401] * 11
            r = await c.post("/v1/qa/sessions", json={"name": "갑", "password": "pw-test"},
                             headers={"x-forwarded-for": "2001:db8:0:3::7, 130.176.0.1"})
        assert r.status_code == 201
        ip_h = await db_val("SELECT ip_hash FROM app.qa_review_session WHERE session_id = $1", uuid.UUID(r.json()["data"]["session_id"]))
        assert ip_h == hash_ip("2001:db8:0:3::7")                                            # 기록은 원래 주소


def test_n1_rate_key_ip_normalization():
    """qa R6: 버킷 키 정규화는 core.auth.rate_key_ip 로 옮겨졌다(기능 사본 삭제). 입장 경로가 쓰는 규칙이 그대로인지 회귀로 남긴다."""
    assert [rate_key_ip(x) for x in ("2001:db8::1", "2001:0db8:0:0:1:2:3:4", "[2001:db8::5]", "fe80::1%eth0", "::ffff:203.0.113.7",
                                     "203.0.113.7", "garbage", None)] == [
        "2001:db8::/64", "2001:db8::/64", "2001:db8::/64", "fe80::/64", "203.0.113.7", "203.0.113.7", "garbage", None]


def test_d1_key_table_overflow_keeps_global_and_recent_buckets():
    """재현(D1): 키가 max_keys 를 넘으면 표를 통째로 비워 모든 버킷이 초기화됐다. 이제 전역 버킷과 최근 버킷은 남는다."""
    lim = LoginLimiter(limit=2, max_keys=3, global_limit=5)
    assert [lim.hit("a", now=0.0), lim.hit("a", now=0.1), lim.hit("a", now=0.2)] == [True, True, False]
    assert [lim.hit(f"k{i}", now=1.0 + i) for i in range(3)] == [True, True, True]   # 전역 5 소진, 표 넘침(키 a 가 밀려남)
    assert lim.hit("fresh", now=5.0) is False                                          # 표가 넘쳐도 전역 버킷은 유지
    assert lim.hit("fresh", now=61.0) is True                                          # 창이 지나면 다시 열린다


# ── D2: 로그아웃(PATCH /v1/qa/sessions/{id} {"logout": true}. 전용 DELETE(qa R8)·revoked_at(qa R7)은 기각: 메인 결정) ──
async def test_d2_logout_revokes_session_and_clears_cookie(client_as):
    rv = await new_session("갑")
    jid = await job_id_of(1)
    async with qa_client(client_as, rv) as c:
        assert (await c.post(f"/v1/qa/answers/{jid}/lock")).status_code == 200
        r = await c.patch(f"/v1/qa/sessions/{rv.session_id}", json={"logout": True})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d == {"session_id": rv.session_id, "locks_released": 1, "session_deleted": True, "references_detached": 0,
                     "session_kept_reason": None}
        sc = r.headers["set-cookie"].lower()
        assert sc.startswith("raw_data_qa=") and "max-age=0" in sc and "httponly" in sc
    assert await db_val("SELECT count(*) FROM app.qa_review_session WHERE session_id = $1", uuid.UUID(rv.session_id)) == 0
    assert await db_val("SELECT count(*) FROM app.qa_answer_lock") == 0
    async with qa_client(client_as, rv) as c:                                          # 쿠키를 복사해 둬도 서버 측에서 폐기됨
        assert (await c.get("/v1/qa/answers", params={"limit": 1})).status_code == 401
        assert (await c.patch(f"/v1/qa/sessions/{rv.session_id}")).status_code == 401      # 갱신도 401
        r = await c.patch(f"/v1/qa/sessions/{rv.session_id}", json={"logout": True})           # 이미 폐기된 세션도 쿠키 삭제는 된다
        assert r.status_code == 200 and r.json()["data"]["session_deleted"] is False
        assert "max-age=0" in r.headers["set-cookie"].lower()


async def test_n2_logout_with_reviews_and_notes_revokes_session(client_as):
    """검증 N2 회귀: 판정·노트를 남긴 세션은 로그아웃해도 행이 남아(FK) 복사해 둔 쿠키로 12시간 읽기·쓰기가 됐다.
    지금은 같은 트랜잭션에서 판정·노트의 session_id 를 NULL 로 끊고 세션 행을 지운다(작성자 이름·이력은 남는다)."""
    rv = await new_session("갑")
    jid, jid2 = await job_id_of(1), await job_id_of(2)
    async with qa_client(client_as, rv) as c:
        assert (await c.post(f"/v1/qa/answers/{jid}/notes", json={"target_kind": "answer", "body": "메모"})).status_code == 201
        assert (await c.put(f"/v1/qa/answers/{jid}/review", json={"section_flags": {"answer": "ok"}})).status_code == 200
        assert (await c.post(f"/v1/qa/answers/{jid2}/lock")).status_code == 200
        r = await c.patch(f"/v1/qa/sessions/{rv.session_id}", json={"logout": True})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d == {"session_id": rv.session_id, "locks_released": 2, "session_deleted": True, "references_detached": 2,
                 "session_kept_reason": None}
    assert "max-age=0" in r.headers["set-cookie"].lower()
    assert await db_val("SELECT count(*) FROM app.qa_review_session") == 0
    note = (await db_rows("SELECT reviewer_name, session_id, body FROM app.qa_review_note"))[0]
    review = (await db_rows("SELECT reviewer_name, session_id, status FROM app.qa_answer_review WHERE job_id = $1", jid))[0]
    assert (note["reviewer_name"], note["session_id"], note["body"]) == ("갑", None, "메모")          # 작성 이력은 보존
    assert (review["reviewer_name"], review["session_id"], review["status"]) == ("갑", None, "ok")
    async with qa_client(client_as, rv) as c:                                              # 로그아웃 전에 복사해 둔 쿠키
        rs = [await c.get("/v1/qa/answers", params={"limit": 1}), await c.get(f"/v1/qa/answers/{jid}/notes"),
              await c.put(f"/v1/qa/answers/{jid}/review", json={"section_flags": {"answer": "issue"}}),
              await c.post(f"/v1/qa/answers/{jid}/notes", json={"target_kind": "answer", "body": "x"}),
              await c.post(f"/v1/qa/answers/{jid2}/lock")]
    assert [x.status_code for x in rs] == [401] * 5 and {x.json()["error"]["code"] for x in rs} == {"qa_unauthorized"}
    assert await db_val("SELECT status FROM app.qa_answer_review WHERE job_id = $1", jid) == "ok"   # 폐기 뒤 쓰기는 반영 안 됨


async def _logout_tx(rv):
    from app.core.db import get_db
    from app.features.qa.review.sessions import service as S
    async with get_db().transaction("qa_gate") as conn:
        return await S.logout(conn, rv, uuid.UUID(rv.session_id))


async def test_n2_logout_waits_for_inflight_write_then_detaches_it(client_as):
    """쓰기가 먼저 세션을 확인했으면(core.auth.assert_qa_session FOR KEY SHARE) 로그아웃은 그 커밋을 기다렸다가 새 판정까지 끊고 지운다
    (예전 순서 = 락 행 삭제 → 세션 잠금은 이 경로와 교착하거나 FK 500 을 낼 수 있었다)."""
    import asyncio

    from app.core.db import fetch_one, get_db
    from app.features.qa.review.verdict import queries as VQ
    rv = await new_session("갑")
    jid = await job_id_of(1)
    async with get_db().transaction("qa_gate") as w:
        await assert_qa_session(w, rv)
        task = asyncio.create_task(_logout_tx(rv))
        await asyncio.sleep(0.3)
        assert not task.done()                                                             # 진행 중 쓰기를 기다린다
        await fetch_one(w, VQ.UPSERT_REVIEW_SQL, {"job_id": jid, "f_answer": "ok", "f_prompt": None, "f_mentions": None,
                                                  "f_citations": None, "f_acr": None, "f_meta": None, "name": rv.name,
                                                  "sid": uuid.UUID(rv.session_id)})
    out = await asyncio.wait_for(task, 10)
    assert out.session_deleted and out.references_detached == 1
    assert await db_val("SELECT session_id FROM app.qa_answer_review WHERE job_id = $1", jid) is None


async def test_n2_write_racing_a_logout_gets_401_not_500(client_as):
    """로그아웃이 먼저 세션을 잠갔으면, 겹친 쓰기의 세션 확인은 커밋을 기다렸다가 지워진 행을 못 찾아 401 이다(FK 위반 500 아님)."""
    import asyncio

    from app.core.db import get_db
    from app.core.errors import ApiError
    rv = await new_session("갑")

    async def write():
        async with get_db().transaction("qa_gate") as w:
            await assert_qa_session(w, rv)

    from app.features.qa.review.sessions import service as S
    async with get_db().transaction("qa_gate") as lo:
        out = await S.logout(lo, rv, uuid.UUID(rv.session_id))
        task = asyncio.create_task(write())
        await asyncio.sleep(0.3)
        assert not task.done()                                                             # 예전(잠금 없는 SELECT)은 바로 통과했다
    assert out.session_deleted
    with pytest.raises(ApiError) as e:
        await asyncio.wait_for(task, 10)
    assert (e.value.status, e.value.code) == (401, "qa_unauthorized")


async def test_d2_logout_requires_own_cookie(client_as):
    rv, other = await new_session("갑"), await new_session("을")
    async with qa_client(client_as, None) as c:
        r = await c.patch(f"/v1/qa/sessions/{rv.session_id}", json={"logout": True})
    assert r.status_code == 401 and r.json()["error"]["code"] == "qa_unauthorized"
    async with qa_client(client_as, rv) as c:
        r = await c.patch(f"/v1/qa/sessions/{other.session_id}", json={"logout": True})     # 남의 세션 종료 불가
        assert r.status_code == 403 and r.json()["error"]["code"] == "session_forbidden"
        assert (await c.patch(f"/v1/qa/sessions/{rv.session_id}", json={"logout": True, "x": 1})).status_code == 422
        r = await c.patch(f"/v1/qa/sessions/{rv.session_id}", json={"logout": False})         # logout=false 는 갱신
        assert r.status_code == 200 and r.json()["data"]["reviewer_name"] == "갑" and "set-cookie" not in r.headers
    assert await db_val("SELECT count(*) FROM app.qa_review_session") == 2


# ── D3: 폐기된 세션(행 삭제)은 읽기도 401 ──
async def test_d3_revoked_session_blocks_reads(client_as):
    rv = await new_session("dave")
    jid = await job_id_of(1)
    paths = ["/v1/qa/answers", f"/v1/qa/answers/{jid}", "/v1/qa/notes/export", "/v1/qa/notes", "/v1/qa/notes/counts",
             "/v1/qa/answers/progress", f"/v1/qa/answers/{jid}/neighbors", "/v1/qa/filters", f"/v1/qa/answers/{jid}/notes",
             f"/v1/qa/answers/{jid}/review", f"/v1/qa/deltas?job_ids={jid}"]
    async with qa_client(client_as, rv) as c:
        assert [(await c.get(p)).status_code for p in paths] == [200] * len(paths)
        await db_exec("DELETE FROM app.qa_review_session WHERE session_id = $1", uuid.UUID(rv.session_id))
        rs = [await c.get(p) for p in paths]
    assert [r.status_code for r in rs] == [401] * len(paths)
    assert {r.json()["error"]["code"] for r in rs} == {"qa_unauthorized"}
