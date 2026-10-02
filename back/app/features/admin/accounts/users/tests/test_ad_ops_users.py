"""admin.accounts.users 통합 테스트(로컬 개발 DB, 합성 계정 6종 + 테스트가 만드는 임시 계정, Supabase 는 가짜 어댑터).

기대값은 tests/support.py 계정 표에서 손으로 고른다(예: 이메일에 't-kia' 가 들어간 계정 = KIA_US·KIA_EU).
"""
from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime

import asyncpg
import httpx
import pytest
import pytest_asyncio
from pydantic import SecretStr
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core.auth import principal_from_row
from app.core.config import Settings
from app.core.db import get_db
from app.features.admin.accounts.users import queries, service
from app.features.admin.accounts.users.adapters import AuthAdminError, SupabaseAuthAdmin, get_auth_admin
from app.features.admin.accounts.users.schemas import UserPatch
from tests.support import ADMIN, CUST_PROJECT, DB_URL, HQ_HYUNDAI, KIA_US, VENDOR, needs_db

BASE = "/v1/admin/users"


def _ro_checked_out() -> int:
    """외부 호출 시점에 요청이 쥔 api_ro 커넥션 수(CurrentUserDetached·RoSession 이면 0, CurrentUser·RoConn 이면 1)."""
    return get_db().engine("api_ro").pool.checkedout()


class FakeAuth:
    def __init__(self) -> None:
        self.ro_at_call: list[tuple[str, int]] = []                  # (호출, 그 시점 api_ro 대여 수): R2 회귀
        self.created: dict[uuid.UUID, tuple[str, str]] = {}
        self.deleted: list[uuid.UUID] = []
        self.fail_create: str | None = None
        self.fail_delete: str | None = None
        self.fail_sign = False
        self.force_id: uuid.UUID | None = None
        self.sign: dict[uuid.UUID, datetime] = {}

    async def create_user(self, email: str, password: str) -> uuid.UUID:
        self.ro_at_call.append(("create", _ro_checked_out()))
        if self.fail_create:
            raise AuthAdminError(self.fail_create)  # type: ignore[arg-type]
        uid = self.force_id or uuid.uuid4()
        self.created[uid] = (email, password)
        return uid

    async def delete_user(self, user_id: uuid.UUID) -> None:
        self.ro_at_call.append(("delete", _ro_checked_out()))
        if self.fail_delete:
            raise AuthAdminError(self.fail_delete)  # type: ignore[arg-type]
        self.deleted.append(user_id)

    async def last_sign_in(self, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, datetime | None]:
        self.ro_at_call.append(("last_sign_in", _ro_checked_out()))
        if self.fail_sign:
            raise AuthAdminError("upstream")
        return {u: self.sign.get(u) for u in user_ids}


@pytest_asyncio.fixture(loop_scope="session")
async def env(seeded):
    """가짜 어댑터 주입 + 임시 계정 태그. 끝나면 태그 계정·멤버십을 소유자 접속(행위자 GUC)으로 지운다.
    Supabase 설정은 core.config(테스트 Settings 에 supabase_* 없음 = 미설정)라 env 를 지울 필요가 없다."""
    from app.main import app

    fake = FakeAuth()
    app.dependency_overrides[get_auth_admin] = lambda: fake
    tag = f"t-users-{uuid.uuid4().hex[:8]}"
    c = await asyncpg.connect(DB_URL)
    try:
        yield {"fake": fake, "tag": tag, "owner": c, "app": app}
    finally:
        app.dependency_overrides.pop(get_auth_admin, None)
        async with c.transaction():                                   # 계정 삭제 = 감사 트리거 행위자 필요(트랜잭션 로컬 GUC)
            await c.execute("SELECT set_config('app.actor_id', $1, true)", str(ADMIN))
            ids = [r["user_id"] for r in await c.fetch("SELECT user_id FROM app.user_account WHERE email::text LIKE $1", f"{tag}%")]
            await c.execute("DELETE FROM app.project WHERE created_by = ANY($1::uuid[])", ids)
            await c.execute("DELETE FROM app.project_member WHERE project_id = $1 AND user_id = $2", CUST_PROJECT, ADMIN)
            await c.execute("DELETE FROM app.user_account WHERE user_id = ANY($1::uuid[])", ids)
        await c.close()


def _mk(env, name: str, **kw) -> dict:
    return {"email": f"{env['tag']}-{name}@example.test", "role": "country", "scope_brands": ["Kia"], "scope_countries": ["us"], **kw}


async def _create(c, env, name: str, **kw) -> dict:
    r = await c.post(BASE, json=_mk(env, name, **kw))
    assert r.status_code == 201, r.text
    return r.json()["data"]


@needs_db
async def test_auth_gates(client_as, env):
    async with client_as(None) as c:
        assert (await c.get(BASE)).status_code == 401
    for uid in (HQ_HYUNDAI, KIA_US, VENDOR):
        async with client_as(uid) as c:
            for r in (await c.get(BASE), await c.get(f"{BASE}/{ADMIN}"), await c.get(f"{BASE}/{ADMIN}/audit"),
                      await c.post(BASE, json=_mk(env, "x")), await c.patch(f"{BASE}/{uid}", json={"role": "admin"}, headers={"If-Match": "1"}),
                      await c.delete(f"{BASE}/{VENDOR}")):
                assert r.status_code == 403, (uid, r.text)
                assert "t-admin@example.test" not in r.text
    assert env["fake"].created == {} and env["fake"].deleted == []


@needs_db
async def test_list_filters_pagination(client_as, env):
    fake = env["fake"]
    fake.sign[KIA_US] = datetime(2026, 9, 1, tzinfo=UTC)
    async with client_as(ADMIN) as c:
        r = await c.get(BASE, params={"q": "t-kia"})
        assert r.status_code == 200, r.text
        b = r.json()
        emails = {i["email"]: i for i in b["data"]["items"]}
        assert set(emails) == {"t-kia-us@example.test", "t-kia-eu@example.test"}
        assert emails["t-kia-us@example.test"]["last_sign_in_at"].startswith("2026-09-01")
        assert emails["t-kia-eu@example.test"]["scope_regions"] == ["kia-western-europe"] and b["meta"]["suppressed"] == {}
        # 필터 전후: menu_group=project → HQ_HYUNDAI·VENDOR, role=admin·status=active → ADMIN 하나(시드 시스템 계정은 정지)
        r = await c.get(BASE, params={"q": "@example.test", "menu_group": "project"})
        assert {i["email"] for i in r.json()["data"]["items"]} == {"t-hq-h@example.test", "t-vendor@example.test"}
        r = await c.get(BASE, params={"role": "admin", "status": "active", "q": "example.test"})
        assert [i["user_id"] for i in r.json()["data"]["items"]] == [str(ADMIN)]
        r = await c.get(BASE, params={"q": "%", "surface": "global", "from": "2026-01-01"})
        assert r.json()["data"]["items"] == [] and r.json()["meta"]["ignored_filters"] == ["period", "surface"]
        # 키셋: 2건을 1건씩
        r1 = (await c.get(BASE, params={"q": "t-kia", "limit": 1})).json()
        r2 = (await c.get(BASE, params={"q": "t-kia", "limit": 1, "cursor": r1["meta"]["page"]["next_cursor"]})).json()
        assert {r1["data"]["items"][0]["email"], r2["data"]["items"][0]["email"]} == set(emails)
        assert r2["meta"]["page"]["next_cursor"] is None
        r = await c.get(BASE, params={"q": "t-hq", "limit": 1, "cursor": r1["meta"]["page"]["next_cursor"]})
        assert r.status_code == 422 and r.json()["error"]["code"] == "cursor_invalid"
        for bad in ({"role": "boss"}, {"status": "x"}, {"limit": 0}, {"menu_group": "x"}):
            assert (await c.get(BASE, params=bad)).status_code == 422
        # 최근 로그인 조회 실패 → null + 억제 사유
        fake.fail_sign = True
        r = await c.get(BASE, params={"q": "t-kia-us"})
        assert r.json()["data"]["items"][0]["last_sign_in_at"] is None
        assert r.json()["meta"]["suppressed"] == {"last_sign_in_at": "upstream_unavailable"}
        r = await c.get(f"{BASE}/{KIA_US}")
        assert r.status_code == 200 and r.json()["data"]["email"] == "t-kia-us@example.test"
        assert (await c.get(f"{BASE}/{uuid.uuid4()}")).status_code == 404


@needs_db
async def test_unconfigured_adapter(client_as, env):
    env["app"].dependency_overrides.pop(get_auth_admin, None)            # 설정 없는 실제 의존성
    async with client_as(ADMIN) as c:
        r = await c.get(BASE, params={"q": "t-kia-us"})
        assert r.status_code == 200 and r.json()["meta"]["suppressed"] == {"last_sign_in_at": "auth_admin_unconfigured"}
        r = await c.post(BASE, json=_mk(env, "nocfg"))
        assert r.status_code == 503 and r.json()["error"]["code"] == "auth_admin_unconfigured"
    assert await env["owner"].fetchval("SELECT count(*) FROM app.user_account WHERE email::text LIKE $1", f"{env['tag']}%") == 0


@needs_db
async def test_create(client_as, env):
    fake, own = env["fake"], env["owner"]
    async with client_as(ADMIN) as c:
        d = await _create(c, env, "a", display_name="  테스트 A ")
        assert d["scope_countries"] == ["US"] and d["display_name"] == "테스트 A" and d["row_version"] == 1
        assert len(d["temp_password"]) == 16 and fake.created[uuid.UUID(d["user_id"])][1] == d["temp_password"]
        au = await own.fetchrow("SELECT change_type, actor_id, after FROM app.permission_audit_log WHERE target_user_id = $1",
                                uuid.UUID(d["user_id"]))
        assert au["change_type"] == "create" and au["actor_id"] == ADMIN and json.loads(au["after"])["role"] == "country"
        # admin 은 scope_all 강제, 배열 비움
        d = await _create(c, env, "adm", role="admin", operator="global")
        assert d["scope_all"] is True and d["scope_brands"] == [] and d["scope_countries"] == []
        n0 = len(fake.created)
        cases = [
            (_mk(env, "b", role="admin", scope_all=False), 422, "admin_scope_all"),
            (_mk(env, "b", role="vendor", operator="assigned", scope_brands=[], scope_countries=[]), 422, "vendor_operator"),
            (_mk(env, "b", menu_groups=["admin"]), 422, "menu_group_not_allowed"),
            (_mk(env, "b", scope_countries=[]), 422, "constraint_violation"),
            (_mk(env, "b", scope_brands=["Nope"]), 422, "unknown_scope_ref"),
            (_mk(env, "b", role="region", scope_regions=["no-such-region"], scope_countries=[]), 422, "unknown_scope_ref"),
            ({**_mk(env, "b"), "email": "t-admin@example.test"}, 409, "email_taken"),
            ({**_mk(env, "b"), "email": "not-an-email"}, 422, "unprocessable"),
            ({**_mk(env, "b"), "role": "boss"}, 422, "unprocessable"),
        ]
        for body, st, code in cases:
            r = await c.post(BASE, json=body)
            assert (r.status_code, r.json()["error"]["code"]) == (st, code), (body, r.text)
        assert len(fake.created) == n0                                             # 사전 검증에서 막혀 외부 계정을 만들지 않았다
        r = await c.post(BASE, json=_mk(env, "b", scope_countries=[]))
        err = r.json()["error"]                                                  # 제약 이름은 응답에 싣지 않는다(검증 m-3), 규칙은 문구로
        assert err["details"] is None and err["message"] == "country 역할은 국가 또는 권역 스코프가 필요"
        # 외부 충돌 → 409, 외부 오류 → 502
        fake.fail_create = "conflict"
        assert (await c.post(BASE, json=_mk(env, "c"))).status_code == 409
        fake.fail_create = "upstream"
        r = await c.post(BASE, json=_mk(env, "c"))
        assert r.status_code == 502 and r.json()["error"]["code"] == "upstream_auth"
        fake.fail_create = None
        # 보상 삭제: 외부가 기존 id(ADMIN)를 돌려주면 앱 INSERT 가 PK 충돌 → 외부 계정 보상 삭제 후 409
        fake.force_id = ADMIN
        r = await c.post(BASE, json=_mk(env, "d"))
        assert r.status_code == 409 and r.json()["error"]["code"] == "duplicate" and fake.deleted == [ADMIN]
        fake.fail_delete = "upstream"
        r = await c.post(BASE, json=_mk(env, "d"))
        assert r.status_code == 502 and r.json()["error"]["code"] == "compensation_failed"
        fake.force_id, fake.fail_delete = None, None
        assert await own.fetchval("SELECT count(*) FROM app.user_account WHERE email::text LIKE $1", f"{env['tag']}-d%") == 0


@needs_db
async def test_patch(client_as, env):
    own = env["owner"]
    async with client_as(ADMIN) as c:
        u = await _create(c, env, "p")
        url = f"{BASE}/{u['user_id']}"
        assert (await c.patch(url, json={"role": "hq"})).status_code == 428
        r = await c.patch(url, json={"role": "hq"}, headers={"If-Match": "7"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "row_version_conflict"
        assert r.json()["error"]["details"]["row_version"] == 1
        assert (await c.patch(url, json={"role": "hq"}, headers={"If-Match": "x"})).status_code == 422
        r = await c.patch(url, json={"role": "region", "scope_regions": ["kia-western-europe"], "scope_countries": []},
                          headers={"If-Match": '"1"'})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert (d["role"], d["scope_regions"], d["scope_countries"], d["row_version"]) == ("region", ["kia-western-europe"], [], 2)
        # 가드: vendor operator·menu_groups·참조 없음(롤백 확인)
        for body, code in (({"role": "vendor", "operator": "assigned"}, "vendor_operator"),
                           ({"menu_groups": ["admin"]}, "menu_group_not_allowed"),
                           ({"scope_regions": ["no-such-region"]}, "unknown_scope_ref"),
                           ({"scope_brands": []}, "constraint_violation"),
                           ({"role": None}, "unprocessable")):
            r = await c.patch(url, json=body, headers={"If-Match": "2"})
            assert r.status_code == 422 and r.json()["error"]["code"] == code, (body, r.text)
        assert await own.fetchval("SELECT row_version FROM app.user_account WHERE user_id = $1", uuid.UUID(u["user_id"])) == 2
        # 표시명만 바꾸면 권한 감사 행이 늘지 않는다(트리거 keep 열 밖)
        r = await c.patch(url, json={"display_name": "이름", "menu_groups": ["standard"]}, headers={"If-Match": "2"})
        assert r.status_code == 200 and r.json()["data"]["menu_groups"] == ["standard"]
        r = await c.patch(url, json={"display_name": "이름2"}, headers={"If-Match": "3"})
        assert r.status_code == 200 and r.json()["data"]["row_version"] == 4
        r = await c.patch(url, json={"menu_groups": None}, headers={"If-Match": "4"})
        assert r.json()["data"]["menu_groups"] is None
        r = await c.get(f"{url}/audit")
        types = [i["change_type"] for i in r.json()["data"]["items"]]
        assert types == ["update", "update", "update", "create"]                  # 표시명만 바꾼 PATCH 는 기록 없음
        a0 = r.json()["data"]["items"][-2]
        assert a0["before"]["role"] == "country" and a0["after"]["role"] == "region" and a0["actor_email"] == "t-admin@example.test"
        r1 = (await c.get(f"{url}/audit", params={"limit": 3})).json()
        r2 = (await c.get(f"{url}/audit", params={"limit": 3, "cursor": r1["meta"]["page"]["next_cursor"]})).json()
        assert [i["change_type"] for i in r2["data"]["items"]] == ["create"] and r2["meta"]["page"]["next_cursor"] is None
        assert (await c.get(f"{BASE}/{uuid.uuid4()}/audit")).status_code == 404
        # 자기 강등·자기 정지
        rv = (await c.get(f"{BASE}/{ADMIN}")).json()["data"]["row_version"]
        for body in ({"role": "hq", "scope_brands": ["Hyundai"]}, {"status": "suspended"}):
            r = await c.patch(f"{BASE}/{ADMIN}", json=body, headers={"If-Match": str(rv)})
            assert r.status_code == 409 and r.json()["error"]["code"] == "self_demote"
        # 다른 admin 강등은 가능(ADMIN 이 남는다), admin 승격은 scope_all 강제
        t = await _create(c, env, "t", role="admin")
        r = await c.patch(f"{BASE}/{t['user_id']}", json={"role": "hq", "scope_brands": ["Hyundai"], "scope_all": False},
                          headers={"If-Match": "1"})
        assert r.status_code == 200 and r.json()["data"]["role"] == "hq" and r.json()["data"]["scope_all"] is False
        r = await c.patch(f"{BASE}/{t['user_id']}", json={"role": "admin"}, headers={"If-Match": "2"})
        assert r.status_code == 200 and r.json()["data"]["scope_all"] is True and r.json()["data"]["scope_brands"] == []
        assert (await c.patch(f"{BASE}/{uuid.uuid4()}", json={"role": "hq"}, headers={"If-Match": "1"})).status_code == 404


@needs_db
async def test_last_admin_guard_service(database, env):
    """행위자도 admin 이라 API 로는 닿지 않는 방어 심층 분기: 활성 admin 이 대상 하나뿐인 상태를 서비스에서 직접 확인."""
    from app.core.db import fetch_one

    async with database.read("api_ro") as ro:
        row = await fetch_one(ro, "SELECT user_id, email::text AS email, role::text AS role, operator::text AS operator, scope_all, "
                                  "scope_brands, scope_regions, scope_countries, menu_groups::text[] AS menu_groups, "
                                  "is_qa_reviewer, row_version FROM app.user_account WHERE user_id = :u", {"u": ADMIN})
    assert row is not None
    ghost = principal_from_row({**row, "user_id": uuid.uuid4()})                  # DB 에 없는 admin 행위자
    async with database.write(ADMIN) as rw:
        with pytest.raises(Exception) as ei:
            await service.patch_user(rw, ghost, ADMIN, UserPatch(role="hq", scope_brands=["Hyundai"]), str(row["row_version"]))
    assert getattr(ei.value, "code", None) == "last_admin"


async def _admin_row(database, uid):
    from app.core.db import fetch_one

    async with database.read("api_ro") as ro:
        return await fetch_one(ro, "SELECT user_id, email::text AS email, role::text AS role, operator::text AS operator, scope_all, "
                                   "scope_brands, scope_regions, scope_countries, menu_groups::text[] AS menu_groups, "
                                   "is_qa_reviewer, row_version FROM app.user_account WHERE user_id = :u", {"u": uid})


def _effective_admins_sql() -> str:
    return ("SELECT count(*) FROM app.user_account WHERE role = 'admin' AND status = 'active' "
            "AND (menu_groups IS NULL OR 'admin' = ANY(menu_groups::text[]))")


@needs_db
async def test_d1_admin_menu_removal_is_demotion(client_as, env):
    """검증 D1 회귀: admin 메뉴 그룹 제거는 사실상 강등이다. 자기 자신이면 409 self_demote, 이후에도 관리 화면에 들어올 수 있어야 한다."""
    own = env["owner"]
    n0 = await own.fetchval(_effective_admins_sql())
    async with client_as(ADMIN) as c:
        rv = (await c.get(f"{BASE}/{ADMIN}")).json()["data"]["row_version"]
        for body in ({"menu_groups": ["standard"]}, {"menu_groups": ["standard", "website", "project"]}):
            r = await c.patch(f"{BASE}/{ADMIN}", json=body, headers={"If-Match": str(rv)})
            assert r.status_code == 409 and r.json()["error"]["code"] == "self_demote", (body, r.text)
        assert (await c.get(BASE)).status_code == 200                              # 잠기지 않았다
        assert (await c.get(f"{BASE}/{ADMIN}")).json()["data"]["row_version"] == rv
        t = await _create(c, env, "d1t", role="admin")
    # 임시 admin T 도 자기 자신의 admin 메뉴는 못 뺀다. admin 메뉴를 유지한 채 좁히는 것은 강등이 아니라 가능
    async with client_as(uuid.UUID(t["user_id"])) as c:
        r = await c.patch(f"{BASE}/{t['user_id']}", json={"menu_groups": ["standard"]}, headers={"If-Match": "1"})
        assert r.status_code == 409 and r.json()["error"]["code"] == "self_demote", r.text
        assert (await c.get(BASE)).status_code == 200
        r = await c.patch(f"{BASE}/{t['user_id']}", json={"menu_groups": ["admin", "standard"]}, headers={"If-Match": "1"})
        assert r.status_code == 200 and r.json()["data"]["menu_groups"] == ["admin", "standard"]
        assert (await c.get(BASE)).status_code == 200
    # 다른 실효 admin 이 남으면 남의 admin 메뉴를 빼는 것은 가능(강등 허용)
    async with client_as(ADMIN) as c:
        u = await _create(c, env, "d1u", role="admin")
        r = await c.patch(f"{BASE}/{u['user_id']}", json={"menu_groups": ["standard"]}, headers={"If-Match": "1"})
        assert r.status_code == 200 and r.json()["data"]["menu_groups"] == ["standard"]
    assert await own.fetchval(_effective_admins_sql()) == n0 + 1                   # ADMIN(+기존) + T, U 는 실효 admin 아님


@needs_db
async def test_d1_last_effective_admin_guard_service(database, env, client_as):
    """검증 D1 회귀(방어 심층): 남은 다른 admin 이 admin 메뉴가 없는(실효 admin 아닌) 계정뿐이면, ADMIN 의 admin 메뉴 제거는 409 last_admin."""
    own = env["owner"]
    n_eff = await own.fetchval(_effective_admins_sql())
    assert n_eff == 1, "픽스처 전제: 실효 admin 은 ADMIN 1명"
    async with client_as(ADMIN) as c:
        w = await _create(c, env, "d1w", role="admin", menu_groups=["standard"])   # role admin 이지만 admin 메뉴 없음
        assert w["menu_groups"] == ["standard"]
    row = await _admin_row(database, ADMIN)
    assert row is not None
    ghost = principal_from_row({**row, "user_id": uuid.uuid4()})
    for patch in (UserPatch(menu_groups=["standard"]), UserPatch(role="hq", scope_brands=["Hyundai"]), UserPatch(status="suspended")):
        async with database.write(ADMIN) as rw:
            with pytest.raises(Exception) as ei:
                await service.patch_user(rw, ghost, ADMIN, patch, str(row["row_version"]))
        assert getattr(ei.value, "code", None) == "last_admin", patch
    assert await own.fetchval(_effective_admins_sql()) == 1


@needs_db
async def test_d2_demote_admin_scope(client_as, env):
    """검증 D2 회귀: admin 강등 시 Q16 강제 scope_all=true 가 암묵 승계되어 명시한 좁은 스코프가 버려지면 안 된다."""
    own = env["owner"]
    async with client_as(ADMIN) as c:
        t = await _create(c, env, "d2t", role="admin")
        assert t["scope_all"] is True
        r = await c.patch(f"{BASE}/{t['user_id']}", json={"role": "country", "scope_brands": ["Kia"], "scope_countries": ["US"]},
                          headers={"If-Match": "1"})
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert (d["role"], d["scope_all"], d["scope_brands"], d["scope_countries"]) == ("country", False, ["Kia"], ["US"])
        row = await own.fetchrow("SELECT scope_all, scope_brands, scope_countries FROM app.user_account WHERE user_id = $1",
                                 uuid.UUID(t["user_id"]))
        assert (row["scope_all"], list(row["scope_brands"]), list(row["scope_countries"])) == (False, ["Kia"], ["US"])
        # 배열 없이 강등만 하면 scope_all 이 false 로 돌아가 CHECK 가 막는다(넓은 권한으로 조용히 남지 않음)
        t2 = await _create(c, env, "d2u", role="admin")
        r = await c.patch(f"{BASE}/{t2['user_id']}", json={"role": "hq"}, headers={"If-Match": "1"})
        assert r.status_code == 422 and r.json()["error"]["code"] == "constraint_violation", r.text
        # 비 admin scope_all 계정에 좁은 배열만 명시하면 좁힌다
        h = await _create(c, env, "d2h", role="hq", scope_all=True, scope_brands=[], scope_countries=[])
        assert h["scope_all"] is True
        r = await c.patch(f"{BASE}/{h['user_id']}", json={"scope_brands": ["Hyundai"]}, headers={"If-Match": "1"})
        assert r.status_code == 200 and (r.json()["data"]["scope_all"], r.json()["data"]["scope_brands"]) == (False, ["Hyundai"])
        # scope_all=true 를 명시하면 배열은 비운다(현행 정규화)
        r = await c.patch(f"{BASE}/{h['user_id']}", json={"scope_all": True, "scope_brands": ["Kia"]}, headers={"If-Match": "2"})
        assert r.status_code == 200 and (r.json()["data"]["scope_all"], r.json()["data"]["scope_brands"]) == (True, [])


@needs_db
async def test_delete(client_as, env):
    fake, own = env["fake"], env["owner"]
    async with client_as(ADMIN) as c:
        r = await c.delete(f"{BASE}/{ADMIN}")
        assert r.status_code == 409 and r.json()["error"]["code"] == "self_delete"
        assert (await c.delete(f"{BASE}/{uuid.uuid4()}")).status_code == 404
        # 참조 기록이 있으면 409 user_referenced(외부 삭제 없음)
        u = await _create(c, env, "ref")
        await own.execute("INSERT INTO app.project (kind, name, country_code, created_by) VALUES ('customer', $1, 'US', $2)",
                          env["tag"], uuid.UUID(u["user_id"]))
        r = await c.delete(f"{BASE}/{u['user_id']}")
        assert r.status_code == 409 and r.json()["error"]["details"] == {"projects_created": 1} and fake.deleted == []
        # Owner 승계: 고객 프로젝트의 유일한 활성 Owner 를 지우면 삭제한 admin 이 Owner 가 된다
        o = await _create(c, env, "own")
        oid = uuid.UUID(o["user_id"])
        await own.execute("INSERT INTO app.project_member (project_id, user_id, role, status, invited_by, accepted_at) "
                          "VALUES ($1, $2, 'owner', 'active', $3, now())", CUST_PROJECT, oid, ADMIN)
        fake.fail_delete = "upstream"
        r = await c.delete(f"{BASE}/{oid}")
        assert r.status_code == 502 and await own.fetchval("SELECT count(*) FROM app.user_account WHERE user_id = $1", oid) == 1
        fake.fail_delete = None
        r = await c.delete(f"{BASE}/{oid}")
        assert r.status_code == 200, r.text
        assert r.json()["data"] == {"user_id": str(oid), "deleted": True, "succeeded_projects": [str(CUST_PROJECT)]}
        assert fake.deleted == [oid]
        m = await own.fetchrow("SELECT role, status FROM app.project_member WHERE project_id = $1 AND user_id = $2", CUST_PROJECT, ADMIN)
        assert (m["role"], m["status"]) == ("owner", "active")
        ctx = await own.fetchval("SELECT context FROM app.member_audit_log WHERE project_id = $1 AND action = 'promote' "
                                 "ORDER BY audit_id DESC LIMIT 1", CUST_PROJECT)
        assert ctx == f"orphan-succession (deleted user {oid})"
        # 삭제된 계정의 권한 이력은 남는다(create·delete)
        r = await c.get(f"{BASE}/{oid}/audit")
        assert [i["change_type"] for i in r.json()["data"]["items"]] == ["delete", "create"]
        # auth 쪽에 이미 없는 계정도 앱 삭제는 진행
        g = await _create(c, env, "gone")
        fake.fail_delete = "not_found"
        assert (await c.delete(f"{BASE}/{g['user_id']}")).status_code == 200
        fake.fail_delete = None


@needs_db
async def test_r2_supabase_calls_hold_no_ro_connection(client_as, env):
    """ad-ops R2 회귀: Supabase 호출(최근 로그인·생성·삭제) 시점에 요청이 api_ro 커넥션을 쥐지 않는다(CurrentUserDetached + RoSession)."""
    fake = env["fake"]
    fake.ro_at_call.clear()
    async with client_as(ADMIN) as c:
        assert (await c.get(BASE, params={"q": "t-kia"})).status_code == 200
        assert (await c.get(f"{BASE}/{KIA_US}")).status_code == 200
        u = await _create(c, env, "r2")
        assert (await c.delete(f"{BASE}/{u['user_id']}")).status_code == 200
    assert [k for k, _ in fake.ro_at_call] == ["last_sign_in", "last_sign_in", "create", "delete"]
    assert all(n == 0 for _, n in fake.ro_at_call), fake.ro_at_call


@needs_db
async def test_r2_detached_gates_same_codes(client_as, env):
    """Detached 게이트(목록·단건·생성·삭제)도 라우터 게이트와 같은 판정·코드: 비 admin = admin_only, admin 메뉴 없는 admin = menu_forbidden."""
    async with client_as(ADMIN) as c:
        w = await _create(c, env, "r2m", role="admin", menu_groups=["standard"])        # role admin, admin 메뉴 없음
    for uid, code in ((HQ_HYUNDAI, "admin_only"), (uuid.UUID(w["user_id"]), "menu_forbidden")):
        async with client_as(uid) as c:
            for r in (await c.get(BASE), await c.get(f"{BASE}/{ADMIN}"), await c.post(BASE, json=_mk(env, "r2x")),
                      await c.delete(f"{BASE}/{VENDOR}"),                                         # Detached 게이트
                      await c.get(f"{BASE}/{ADMIN}/audit"),
                      await c.patch(f"{BASE}/{ADMIN}", json={"role": "hq"}, headers={"If-Match": "1"})):   # 라우터 게이트
                assert r.status_code == 403 and r.json()["error"]["code"] == code, (uid, r.request.method, r.text)
                assert r.headers.get("cache-control") == "no-store"
    assert env["fake"].created.get(uuid.UUID(w["user_id"])) is not None and len(env["fake"].created) == 1
    assert env["fake"].deleted == []


@needs_db
async def test_r11_last_admin_db_trigger(database, env):
    """ad-ops R11 회귀(DB-v2.6 P50 ua_last_admin): 앱 사전 판정(409 last_admin)을 우회해 실효 admin 을 모두 정지하면 커밋 때 거부된다.
    ① 소유자 직접 쓰기(asyncpg 트랜잭션) ② 앱 쓰기 풀(api_rw)·기능 UPDATE 문장. 둘 다 롤백돼 실효 admin 수가 그대로다."""
    own = env["owner"]
    n0 = await own.fetchval(_effective_admins_sql())
    assert n0 >= 1
    with pytest.raises(asyncpg.CheckViolationError) as ei:
        async with own.transaction():
            await own.execute("SELECT set_config('app.actor_id', $1, true)", str(ADMIN))
            await own.execute("UPDATE app.user_account SET status = 'suspended' WHERE role = 'admin' AND status = 'active'")
    assert ei.value.constraint_name == "ua_last_admin" and ei.value.sqlstate == "23514"
    assert await own.fetchval(_effective_admins_sql()) == n0
    rows = await own.fetch("SELECT user_id, display_name, role::text AS role, operator::text AS operator, scope_all, scope_brands, "
                           "scope_regions, scope_countries, menu_groups::text[] AS menu_groups, is_qa_reviewer, row_version "
                           "FROM app.user_account WHERE role = 'admin' AND status = 'active' "
                           "AND (menu_groups IS NULL OR 'admin' = ANY(menu_groups::text[]))")
    with pytest.raises(DBAPIError) as ei2:
        async with get_db().write(ADMIN) as rw:                  # 커밋(블록 종료) 때 지연 트리거가 판정한다
            for r in rows:
                res = await rw.execute(text(queries.UPDATE_SQL), {**{k: r[k] for k in (
                    "display_name", "role", "operator", "scope_all", "scope_brands", "scope_regions", "scope_countries",
                    "menu_groups", "is_qa_reviewer")}, "uid": r["user_id"], "status": "suspended", "rv": r["row_version"]})
                assert res.rowcount == 1                              # 문장 자체는 통과(DEFERRABLE INITIALLY DEFERRED)
    api = service.db_error(ei2.value)
    assert api is not None and (api.status, api.code, api.details) == (409, "last_admin", None)       # 제약 이름 비노출(검증 m-3)
    assert await own.fetchval(_effective_admins_sql()) == n0


# ── 실제 어댑터(네트워크 없이 httpx.MockTransport). 설정은 core.config.Settings(R1: 기능 설정 모델 폐기) ──
def _adapter(handler) -> SupabaseAuthAdmin:
    s = Settings(env="test", supabase_url="https://x.supabase.co", supabase_service_role_key=SecretStr("svc-key"))
    return SupabaseAuthAdmin(s, transport=httpx.MockTransport(handler))


async def test_supabase_adapter_requests():
    seen = []
    uid = uuid.uuid4()

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append((req.method, req.url.path, dict(req.url.params), req.headers.get("apikey"), req.headers.get("authorization")))
        if req.method == "POST":
            body = json.loads(req.content)
            assert body == {"email": "a@b.c", "password": "pw", "email_confirm": True}
            return httpx.Response(200, json={"id": str(uid)})
        if req.method == "DELETE":
            return httpx.Response(404, json={"msg": "User not found"})
        if req.url.path.endswith(str(uid)):
            return httpx.Response(200, json={"id": str(uid), "last_sign_in_at": "2026-09-01T00:00:00Z"})
        page = int(req.url.params["page"])
        return httpx.Response(200, json={"users": [{"id": str(uid), "last_sign_in_at": None}] if page == 1 else []})

    a = _adapter(handler)
    assert await a.create_user("a@b.c", "pw") == uid
    with pytest.raises(AuthAdminError) as ei:
        await a.delete_user(uid)
    assert ei.value.kind == "not_found"
    assert (await a.last_sign_in([uid]))[uid] == datetime(2026, 9, 1, tzinfo=UTC)
    other = uuid.uuid4()
    assert await a.last_sign_in([uid, other]) == {uid: None}
    assert all(s[3] == "svc-key" and s[4] == "Bearer svc-key" for s in seen)
    assert seen[0][:2] == ("POST", "/auth/v1/admin/users") and seen[-1][2] == {"page": "1", "per_page": "1000"}


async def test_supabase_adapter_errors():
    a = _adapter(lambda req: httpx.Response(422, json={"msg": "A user with this email address has already been registered"}))
    with pytest.raises(AuthAdminError) as ei:
        await a.create_user("a@b.c", "pw")
    assert ei.value.kind == "conflict"

    def boom(req):
        raise httpx.ConnectError("down", request=req)
    with pytest.raises(AuthAdminError) as ei:
        await _adapter(boom).delete_user(uuid.uuid4())
    assert ei.value.kind == "upstream" and "svc-key" not in str(ei.value)
    assert "svc-key" not in repr(_adapter(boom))
    # 설정 읽기(env → Settings)는 core.config 소관(tests/core). 여기서는 미설정이면 어댑터를 만들지 않는 것만 본다
    with pytest.raises(AuthAdminError) as ei:
        SupabaseAuthAdmin(Settings(env="test"))
    assert ei.value.kind == "unconfigured"
    with pytest.raises(AuthAdminError):
        SupabaseAuthAdmin(Settings(env="test", supabase_url="https://x.supabase.co"))            # 키 없음
