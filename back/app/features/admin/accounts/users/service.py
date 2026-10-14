"""admin.accounts.users 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

규칙(AD-5 명세, 모듈-관리자 §2.6, DECISIONS-API Q16, DB-v2.3 P31·DB-v2.4 P41, 현행 admin/_actions.ts)
- 감사: app.permission_audit_log 는 DB 트리거가 쓴다(행위자 app.actor() 필수). 앱은 core.db 쓰기 트랜잭션(행위자 GUC)에서 user_account 만 쓴다.
- 스코프 값 참조 검증(23503)·권역 참조 보호는 DB 트리거, CHECK(ua_*)는 DB 가 정본이다. 위반은 제약명과 함께 422 로 돌려준다.
- admin 은 scope_all 강제(Q16, CHECK ua_admin_scope_all). scope_all 이면 스코프 배열을 비운다(현행 정규화).
- PATCH 가드 순서: vendor operator(422) → 자기 강등·정지·admin 메뉴 제거(409 self_demote)·마지막 실효 admin(409 last_admin) → menu_groups ⊆ 역할 허용 그룹(422)
  → If-Match row_version(409 row_version_conflict) → CHECK(422).
- 생성: 사전 검증(쓰기 트랜잭션에서 넣어 보고 롤백) → Supabase createUser → DB INSERT → 실패 시 auth 보상 삭제.
- 삭제: 자기 삭제·마지막 admin 거부 → 참조 확인(있으면 409, 정지 안내) → auth 선삭제 → DB 삭제 + Owner 승계(현행 removeUserAndSucceedOrphans).
- 외부 호출(Supabase)은 DB 커넥션을 쥔 채 하지 않는다: 핸들러는 CurrentUserDetached, 읽기는 RoSession(짧은 api_ro), 쓰기는
  get_db().write 를 호출 전·후로 나눠 연다. 비밀번호 재발급은 범위 밖(Q16).
- DB 오류는 core.errors.from_db_error(+ 계정 표 제약별 코드)로 바꾼다. 마지막 실효 admin 은 앱이 409 last_admin 으로 먼저 막고,
  DB 제약 트리거 ua_last_admin(DB-v2.6 P50, 커밋 때 23514)이 DB 직접 쓰기·다른 경로의 최후 방어다.
"""
from __future__ import annotations

import logging
import secrets
import string
import uuid
from typing import Any

from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal
from app.core.db import RoOpener, fetch_all, fetch_one, get_db
from app.core.envelope import Meta, Page, build_meta
from app.core.pagination import decode_cursor, fetch_keyset, filter_hash, keyset_page, keyset_predicate
from app.core.sqlb import Binder

from . import queries
from .adapters import AuthAdmin, AuthAdminError
from .schemas import ROLE_GROUPS, AuditItem, UserCreate, UserCreated, UserDeleted, UserItem, UserPatch

log = logging.getLogger("hgh.admin.users")

LIST_SORT = "created_at,user_id"
AUDIT_SORT = "created_at,audit_id"
_CONSTRAINT_MSG = {
    "ua_vendor_no_operator": "vendor 는 operator none 만",
    "ua_scope_nonempty": "scope_all 이 아니면 브랜드 스코프가 1개 이상 필요(vendor 제외)",
    "ua_region_scope": "region 역할은 권역 또는 국가 스코프가 필요",
    "ua_country_scope": "country 역할은 국가 또는 권역 스코프가 필요",
    "ua_menu_nonempty": "menu_groups 는 null(무제한) 또는 1개 이상",
    "ua_admin_scope_all": "admin 은 scope_all 필수",
}


# 유일 위반 제약별 코드(core.errors.from_db_error messages: 23505 → 409)
_UNIQUE_CODES = {"user_account_email_key": "email_taken", "user_account_pkey": "duplicate"}


# ── 공용 ──
def db_error(e: DBAPIError) -> errors.ApiError | None:
    """계정 쓰기 DB 오류 → API 오류(core.errors.from_db_error + 계정 표 규칙). 모르는 것은 None(그대로 500).
    23503 = 스코프 값 참조 없음(참조 트리거는 제약 이름 없이 올린다) 또는 FK → 422 unknown_scope_ref.
    23514 ua_last_admin(DB-v2.6 P50) → 409 last_admin(앱 사전 판정과 같은 코드). 그 밖 CHECK(ua_*) → 422 constraint_violation.
    40001·40P01(마지막 admin 트리거의 FOR SHARE 직렬화, DB-v2.7 P53) → 409 retry_conflict(재시도 가능, 검증 N-1). PATCH 는 커밋이
    RwConn 의존성 정리 때라 core 전역 처리기(쓰기 요청 매핑)가 같은 코드로 낸다."""
    state, constraint = errors.db_error_info(e)
    if state == "23503":
        return errors.unprocessable("스코프 값이 참조 표(app.brand·app.rhq_region·app.rhq_region_country·rd.dim_country)에 없다",
                                    code="unknown_scope_ref")
    if state == "23514" and constraint == "ua_last_admin":
        return errors.conflict("last_admin", "마지막 실효 admin(활성·admin 메뉴) 은 없앨 수 없다")
    api = errors.from_db_error(e, messages=_UNIQUE_CODES, write=True)
    if api is not None and api.code == "constraint_violation" and constraint in _CONSTRAINT_MSG:
        api.message = _CONSTRAINT_MSG[constraint]           # 제약 이름은 응답에 싣지 않는다(검증 m-3), 규칙은 사람이 읽는 문구로
    return api


def temp_password(n: int = 16) -> str:
    """현행 generateTempPassword 대응: 대·소문자·숫자·기호를 하나 이상 포함한 무작위 비밀번호."""
    pools = (string.ascii_lowercase, string.ascii_uppercase, string.digits, "!@#$%^&*-_")
    chars = [secrets.choice(p) for p in pools] + [secrets.choice("".join(pools)) for _ in range(n - len(pools))]
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


def _item(r: dict[str, Any], last: Any = None) -> UserItem:
    return UserItem(**{k: r[k] for k in ("user_id", "email", "display_name", "role", "operator", "scope_all", "is_qa_reviewer", "status",
                                         "row_version", "created_at", "updated_at")},
                    scope_brands=list(r["scope_brands"] or []), scope_regions=list(r["scope_regions"] or []),
                    scope_countries=list(r["scope_countries"] or []),
                    menu_groups=list(r["menu_groups"]) if r["menu_groups"] else None, last_sign_in_at=last)


async def _sign_ins(auth: AuthAdmin, ids: list[uuid.UUID], suppressed: dict[str, str], *, reuse: bool = False) -> dict[uuid.UUID, Any]:
    if not ids:
        return {}
    try:
        return await auth.last_sign_in(ids, reuse=reuse)
    except AuthAdminError as e:
        suppressed["last_sign_in_at"] = "auth_admin_unconfigured" if e.kind == "unconfigured" else "upstream_unavailable"
        log.warning("최근 로그인 조회 실패: %s", e.kind)
        return {}


def _escape_like(q: str) -> str:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


# ── 읽기(계정 행은 짧은 api_ro 트랜잭션에서 읽고 반납한 뒤 최근 로그인을 Supabase 에 묻는다) ──
async def list_users(open_ro: RoOpener, auth: AuthAdmin, *, role: str | None, operator: str | None, status: str | None,
                     menu_group: str | None, q: str | None, cursor: str | None, limit: int) -> tuple[list[UserItem], Meta]:
    fh = filter_hash({"role": role, "op": operator, "st": status, "mg": menu_group, "q": q})
    cur = decode_cursor(cursor, sort=LIST_SORT, dir="desc", fh=fh, types=["timestamptz", "uuid"])
    b = Binder()
    pred = keyset_predicate(["u.created_at", "u.user_id"], "desc", cur, b) or "true"
    async with open_ro() as conn:
        rows = await fetch_keyset(conn, queries.LIST_SQL.format(keyset=pred), {
            **b.params, "role": role, "operator": operator, "status": status, "menu_group": menu_group,
            "pat": _escape_like(q.strip()) if q and q.strip() else None, "lim": limit + 1})
    page, nxt = keyset_page(rows, limit, lambda r: (r["created_at"], r["user_id"]), sort=LIST_SORT, dir="desc", fh=fh)
    suppressed: dict[str, str] = {}
    # 커서 있는 이어지는 페이지는 첫 페이지가 시작한 Supabase 스캔을 이어 쓴다(페이지마다 처음부터 재스캔하지 않음, 값 동일)
    last = await _sign_ins(auth, [r["user_id"] for r in page], suppressed, reuse=cursor is not None)
    return [_item(r, last.get(r["user_id"])) for r in page], build_meta(mode="crud", suppressed=suppressed,
                                                                        page=Page(next_cursor=nxt, limit=limit))


async def get_user(open_ro: RoOpener, auth: AuthAdmin, user_id: uuid.UUID) -> tuple[UserItem, Meta]:
    async with open_ro() as conn:
        r = await fetch_one(conn, queries.ONE_SQL, {"uid": user_id})
    if r is None:
        raise errors.not_found("계정 없음")
    suppressed: dict[str, str] = {}
    last = await _sign_ins(auth, [user_id], suppressed)
    return _item(r, last.get(user_id)), build_meta(mode="crud", suppressed=suppressed)


async def list_audit(conn: AsyncConnection, user_id: uuid.UUID, *, cursor: str | None, limit: int) -> tuple[list[AuditItem], str | None]:
    ok = await fetch_one(conn, queries.AUDIT_EXISTS_SQL, {"uid": user_id})
    if not ok or not ok["found"]:
        raise errors.not_found("계정·이력 없음")
    fh = filter_hash({"uid": str(user_id)})
    cur = decode_cursor(cursor, sort=AUDIT_SORT, dir="desc", fh=fh, types=["timestamptz", "int8"])
    b = Binder()
    pred = keyset_predicate(["l.created_at", "l.audit_id"], "desc", cur, b) or "true"
    rows = await fetch_keyset(conn, queries.AUDIT_SQL.format(keyset=pred), {**b.params, "uid": user_id, "lim": limit + 1})
    page, nxt = keyset_page(rows, limit, lambda r: (r["created_at"], int(r["audit_id"])), sort=AUDIT_SORT, dir="desc", fh=fh)
    return [AuditItem(**r) for r in page], nxt


# ── 값 정규화·가드 ──
_SCOPE_ARRAYS = ("scope_brands", "scope_regions", "scope_countries")


def _effective_admin(role: str, status: str, menu_groups: list[str] | None) -> bool:
    """실효 admin: role admin ∧ 활성 ∧ admin 메뉴 그룹 접근(null = 제한 없음). queries._EFFECTIVE_ADMIN 과 같은 정의."""
    return role == "admin" and status == "active" and (menu_groups is None or "admin" in menu_groups)


def _normalize(v: dict[str, Any], explicit: set[str], prev_role: str | None = None) -> dict[str, Any]:
    """병합된 계정 값 정규화: vendor operator, admin scope_all(Q16), scope_all 이면 배열 비움, menu_groups ⊆ 역할 허용 그룹.

    scope_all 을 명시하지 않은 PATCH 에서 기존 scope_all=true 를 암묵 승계하면 요청보다 넓은 권한이 남는다(검증 D2):
    - admin 에서 다른 역할로 내리면 Q16 강제분(scope_all=true)은 admin 역할에만 딸리므로 false 로 되돌린다.
    - 비어 있지 않은 스코프 배열을 명시하면 좁히려는 뜻으로 보고 false 로 해석한다.
    scope_all=true 를 명시했으면 배열을 비운다(현행 _actions.ts: scopeAll=true 가 배열을 지움).
    """
    if "scope_all" not in explicit and v["role"] != "admin":
        narrowing = any(k in explicit and v[k] for k in _SCOPE_ARRAYS)
        if prev_role == "admin" or narrowing:
            v["scope_all"] = False
    if v["role"] == "vendor" and v["operator"] != "none":
        if "operator" in explicit:
            raise errors.unprocessable("vendor 는 operator none 만(비용 액션 권한 금지)", code="vendor_operator",
                                       details={"field": "operator"})
        v["operator"] = "none"
    if v["role"] == "admin":
        if "scope_all" in explicit and v["scope_all"] is False:
            raise errors.unprocessable("admin 은 scope_all 필수(Q16)", code="admin_scope_all", details={"field": "scope_all"})
        v["scope_all"] = True
    if v["scope_all"]:
        v["scope_brands"], v["scope_regions"], v["scope_countries"] = [], [], []
    return v


def _check_menu(v: dict[str, Any]) -> None:
    mg = v["menu_groups"]
    if mg is not None and not set(mg) <= ROLE_GROUPS[v["role"]]:
        raise errors.unprocessable("menu_groups 는 역할이 허용한 그룹 안에서만 좁힐 수 있다", code="menu_group_not_allowed",
                                   details={"allowed": sorted(ROLE_GROUPS[v["role"]]), "field": "menu_groups"})


def _params(uid: uuid.UUID, v: dict[str, Any]) -> dict[str, Any]:
    return {"uid": uid, "display_name": v["display_name"], "role": v["role"], "operator": v["operator"], "scope_all": v["scope_all"],
            "scope_brands": v["scope_brands"], "scope_regions": v["scope_regions"], "scope_countries": v["scope_countries"],
            "menu_groups": v["menu_groups"], "is_qa_reviewer": v["is_qa_reviewer"]}


class _Rollback(Exception):
    """사전 검증 트랜잭션을 되돌리기 위한 내부 신호."""


# ── 생성 ──
async def create_user(p: Principal, auth: AuthAdmin, body: UserCreate) -> UserCreated:
    v = _normalize(body.model_dump(), set(body.model_fields_set))
    _check_menu(v)
    db = get_db()
    probe = uuid.uuid4()
    # ① 사전 검증: 쓰기 트랜잭션에서 실제로 넣어 CHECK·참조 트리거를 통과하는지 보고 되돌린다(외부 계정을 만들기 전에 거부)
    try:
        async with db.write(p.user_id) as conn:
            if await fetch_one(conn, queries.EMAIL_TAKEN_SQL, {"email": v["email"]}):
                raise errors.conflict("email_taken", "이미 등록된 이메일")
            await conn.execute(_text(queries.INSERT_SQL), {**_params(probe, v), "email": v["email"]})
            raise _Rollback
    except _Rollback:
        pass
    except DBAPIError as e:
        raise (db_error(e) or e) from e
    # ② 외부 계정(트랜잭션 밖)
    password = temp_password()
    try:
        uid = await auth.create_user(v["email"], password)
    except AuthAdminError as e:
        if e.kind == "conflict":
            raise errors.conflict("email_taken", "인증 서비스에 이미 등록된 이메일") from e
        if e.kind == "unconfigured":
            raise errors.unavailable("계정 인증 서비스 설정 없음", code="auth_admin_unconfigured") from e
        raise errors.upstream("계정 인증 서비스 오류", code="upstream_auth") from e
    # ③ 앱 계정 + 감사(트리거). 실패하면 외부 계정을 보상 삭제한다
    try:
        async with db.write(p.user_id) as conn:
            await conn.execute(_text(queries.INSERT_SQL), {**_params(uid, v), "email": v["email"]})
            r = await fetch_one(conn, queries.ONE_SQL, {"uid": uid})
    except Exception as e:
        try:
            await auth.delete_user(uid)
        except AuthAdminError as ce:
            log.error("계정 생성 보상 삭제 실패(고아 auth 계정): user_id=%s kind=%s", uid, ce.kind)
            raise errors.upstream("앱 계정 생성 실패 후 인증 계정 보상 삭제도 실패(운영 확인 필요)", code="compensation_failed") from e
        if isinstance(e, DBAPIError):
            raise (db_error(e) or e) from e
        raise
    assert r is not None
    return UserCreated(**_item(r).model_dump(), temp_password=password)


# ── 수정 ──
def parse_if_match(raw: str | None) -> int:
    if raw is None or not raw.strip():
        raise errors.ApiError(428, "precondition_required", "If-Match(row_version) 헤더 필요")
    s = raw.strip()
    if s.startswith("W/"):
        s = s[2:]
    s = s.strip('"')
    if not s.isdigit() or int(s) >= 2 ** 31:
        raise errors.unprocessable("If-Match 는 정수 row_version", code="invalid_if_match", details={"field": "If-Match"})
    return int(s)


async def patch_user(conn: AsyncConnection, p: Principal, user_id: uuid.UUID, body: UserPatch, if_match: str | None) -> UserItem:
    rv = parse_if_match(if_match)
    cur = await fetch_one(conn, queries.LOCK_SQL, {"uid": user_id})
    if cur is None:
        raise errors.not_found("계정 없음")
    explicit = set(body.model_fields_set)
    v = {k: (list(cur[k]) if isinstance(cur[k], list) else cur[k]) for k in (
        "display_name", "role", "operator", "scope_all", "scope_brands", "scope_regions", "scope_countries", "menu_groups",
        "is_qa_reviewer", "status")}
    v["menu_groups"] = list(cur["menu_groups"]) if cur["menu_groups"] else None
    for k in explicit:
        val = getattr(body, k)
        if val is None and k != "menu_groups" and k != "display_name":
            raise errors.unprocessable(f"{k} 는 null 로 둘 수 없다", details={"field": k})
        v[k] = val
    v = _normalize(v, explicit, prev_role=cur["role"])                           # ① vendor operator
    was_admin = _effective_admin(cur["role"], cur["status"], list(cur["menu_groups"]) if cur["menu_groups"] else None)
    if was_admin and not _effective_admin(v["role"], v["status"], v["menu_groups"]):   # ② 자기 강등·마지막 admin(admin 메뉴 제거 포함)
        if user_id == p.user_id:
            raise errors.conflict("self_demote", "자기 자신을 admin 에서 내리거나 정지하거나 admin 메뉴를 뺄 수 없다")
        n = await fetch_one(conn, queries.OTHER_ADMINS_SQL, {"uid": user_id})
        if not n or n["n"] == 0:
            raise errors.conflict("last_admin", "마지막 실효 admin(활성·admin 메뉴) 은 내리거나 정지하거나 admin 메뉴를 뺄 수 없다")
    _check_menu(v)                                                                # ③ menu_groups ⊆ 역할 허용
    if int(cur["row_version"]) != rv:                                             # ④ 낙관적 잠금
        raise errors.conflict("row_version_conflict", "다른 곳에서 먼저 수정됐다: 다시 조회 후 수정",
                              {"row_version": int(cur["row_version"])})
    try:                                                                          # ⑤ CHECK·참조(트리거)
        r = await fetch_one(conn, queries.UPDATE_SQL, {**_params(user_id, v), "status": v["status"], "rv": rv})
    except DBAPIError as e:
        raise (db_error(e) or e) from e
    if r is None:
        raise errors.conflict("row_version_conflict", "다른 곳에서 먼저 수정됐다: 다시 조회 후 수정")
    out = await fetch_one(conn, queries.ONE_SQL, {"uid": user_id})
    return _item(out)  # type: ignore[arg-type]


# ── 삭제 ──
async def delete_user(open_ro: RoOpener, p: Principal, auth: AuthAdmin, user_id: uuid.UUID) -> UserDeleted:
    if user_id == p.user_id:
        raise errors.conflict("self_delete", "자기 자신은 삭제할 수 없다")
    async with open_ro() as ro:                                     # 사전 확인(짧은 api_ro, 외부 호출 전에 반납)
        cur = await fetch_one(ro, queries.ONE_SQL, {"uid": user_id})
        if cur is None:
            raise errors.not_found("계정 없음")
        refs = await fetch_one(ro, queries.REFS_SQL, {"uid": user_id})
        held = {k: v for k, v in (refs or {}).items() if v}
        if held:
            raise errors.conflict("user_referenced", "다른 기록이 참조하는 계정이다: 삭제 대신 정지(status suspended)로 처리", held)
        if _effective_admin(cur["role"], cur["status"], list(cur["menu_groups"]) if cur["menu_groups"] else None):   # 마지막 admin 보호(방어 심층: 행위자도 admin 이라 보통 통과)
            n = await fetch_one(ro, queries.OTHER_ADMINS_RO_SQL, {"uid": user_id})
            if not n or n["n"] == 0:
                raise errors.conflict("last_admin", "마지막 활성 admin 은 삭제할 수 없다")
    db = get_db()
    try:                                                            # 인증 선삭제(로그인 즉시 차단)
        await auth.delete_user(user_id)
    except AuthAdminError as e:
        if e.kind == "unconfigured":
            raise errors.unavailable("계정 인증 서비스 설정 없음", code="auth_admin_unconfigured") from e
        if e.kind != "not_found":                                   # 이미 없는 auth 계정은 앱 삭제를 계속한다
            raise errors.upstream("계정 인증 서비스 오류", code="upstream_auth") from e
    try:
        async with db.write(p.user_id) as conn:
            owned = [r["project_id"] for r in await fetch_all(conn, queries.OWNED_PROJECTS_SQL, {"uid": user_id})]
            gone = await fetch_one(conn, queries.DELETE_SQL, {"uid": user_id})     # 멤버십은 ON DELETE CASCADE, 감사는 트리거
            if gone is None:
                raise errors.not_found("계정 없음")
            orphans = [r["p"] for r in await fetch_all(conn, queries.ORPHANS_SQL, {"pids": [str(x) for x in owned]})] if owned else []
            if orphans:                                               # Owner 0명 프로젝트는 삭제한 admin 이 승계(2026-07-02 결정), 고아 전부를 문장 2개로
                pids = [str(x) for x in orphans]
                await conn.execute(_text(queries.SUCCEED_SQL), {"pids": pids, "actor": p.user_id})
                await conn.execute(_text(queries.MEMBER_AUDIT_SQL), {"pids": pids, "actor": p.user_id,
                                                                      "ctx": f"orphan-succession (deleted user {user_id})"})
    except DBAPIError as e:
        log.error("인증 계정 삭제 후 앱 계정 삭제 실패: user_id=%s", user_id)
        raise errors.conflict("delete_incomplete", "인증 계정은 삭제됐으나 앱 계정 삭제에 실패했다(재시도 가능)",
                              {"user_id": str(user_id), "sqlstate": errors.db_error_info(e)[0]}) from e
    return UserDeleted(user_id=user_id, succeeded_projects=orphans)


def _text(sql: str) -> Any:
    from sqlalchemy import text
    return text(sql)
