"""admin.accounts.users 계정 CRUD·감사 라우터. 경로는 /v1 접두 포함 전체 경로.

모든 엔드포인트: 인증 + role=admin + 메뉴 그룹 admin(판정·코드 = require_admin·require_menu_group: admin_only·menu_forbidden).
외부 호출(Supabase)이 있는 엔드포인트(목록·단건 = 최근 로그인 조회, 생성·삭제)는 CurrentUserDetached 로 받아 요청 커넥션을 쥐지 않는다:
게이트는 같은 Detached principal 로 건다(AdminDetached), 읽기는 RoSession(짧은 api_ro), 쓰기는 get_db().write 를 호출 전·후로 나눠 연다.
그 밖(PATCH·감사 이력)은 CurrentUser + 엔드포인트 dependencies 게이트. 비밀번호 재발급은 범위 밖(Q16).
공통 필터(CommonFilters) 축은 이 API 군에 없다: 들어오면 meta.ignored_filters 로 드러낸다(core.filters.ignored_axes).
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Header, Path, Query, Request

from app.core.auth import AdminDetached, CurrentUser, require_admin, require_menu_group
from app.core.db import RoConn, RoSession
from app.core.envelope import Envelope, ListData, Page, build_meta
from app.core.errors import ERROR_RESPONSES
from app.core.filters import ignored_axes
from app.core.write import RwConn

from . import service
from .adapters import AuthAdminDep
from .schemas import AuditItem, MenuGroup, Operator, Role, Status, UserCreate, UserCreated, UserDeleted, UserItem, UserPatch

router = APIRouter(tags=["admin.accounts"], responses=ERROR_RESPONSES)
GATE = [require_admin, require_menu_group("admin")]          # 요청 커넥션(CurrentUser → RoConn)을 쓰는 엔드포인트 게이트


UserId = Annotated[uuid.UUID, Path(description="app.user_account.user_id(= Supabase auth id)")]


@router.get("/v1/admin/users", summary="계정 목록 키셋")
async def get_admin_users_0(
    request: Request, p: AdminDetached, open_ro: RoSession, auth: AuthAdminDep,
    role: Annotated[Role | None, Query()] = None,
    operator: Annotated[Operator | None, Query()] = None,
    status: Annotated[Status | None, Query()] = None,
    menu_group: Annotated[MenuGroup | None, Query(description="menu_groups 에 이 그룹을 가진 계정(null=무제한 계정은 제외)")] = None,
    q: Annotated[str | None, Query(max_length=200, description="이메일·표시명 부분 일치")] = None,
    cursor: Annotated[str | None, Query(max_length=4096)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> Envelope[ListData[UserItem]]:
    """(created_at, user_id) DESC 키셋. last_sign_in_at 은 Supabase Auth 조회(실패 시 null + meta.suppressed)."""
    items, meta = await service.list_users(open_ro, auth, role=role, operator=operator, status=status, menu_group=menu_group, q=q,
                                           cursor=cursor, limit=limit)
    meta.ignored_filters = ignored_axes(request.query_params)
    return Envelope[ListData[UserItem]](data=ListData[UserItem](items=items), meta=meta)


@router.post("/v1/admin/users", status_code=201,
             summary="계정 생성(Supabase Admin → app.user_account + permission_audit_log, 보상 삭제)")
async def post_admin_users_1(p: AdminDetached, auth: AuthAdminDep, body: UserCreate) -> Envelope[UserCreated]:
    """임시 비밀번호는 응답에만 1회. admin 은 scope_all 강제(Q16). 감사 행은 DB 트리거가 남긴다."""
    return Envelope[UserCreated](data=await service.create_user(p, auth, body), meta=build_meta(mode="crud"))


@router.get("/v1/admin/users/{user_id}", summary="계정 단건")
async def get_admin_users_by_id_2(p: AdminDetached, open_ro: RoSession, auth: AuthAdminDep, user_id: UserId) -> Envelope[UserItem]:
    item, meta = await service.get_user(open_ro, auth, user_id)
    return Envelope[UserItem](data=item, meta=meta)


@router.patch("/v1/admin/users/{user_id}", dependencies=GATE, summary="역할·스코프·operator·menu_groups·status·is_qa_reviewer 원자 갱신(If-Match row_version)")
async def patch_admin_users_by_id_3(p: CurrentUser, conn: RwConn, user_id: UserId, body: UserPatch,
                                    if_match: Annotated[str | None, Header(alias="If-Match", max_length=40)] = None) -> Envelope[UserItem]:
    """If-Match 없으면 428, 불일치 409 row_version_conflict. 가드: vendor operator·자기 강등·마지막 admin·menu_groups."""
    return Envelope[UserItem](data=await service.patch_user(conn, p, user_id, body, if_match), meta=build_meta(mode="crud"))


@router.delete("/v1/admin/users/{user_id}", summary="계정 삭제(마지막 admin 보호, Owner 승계)")
async def delete_admin_users_by_id_4(p: AdminDetached, open_ro: RoSession, auth: AuthAdminDep, user_id: UserId) -> Envelope[UserDeleted]:
    """자기 삭제 409, 참조 기록이 있으면 409 user_referenced(정지로 처리). 인증 선삭제 → 앱 삭제 + Owner 승계."""
    return Envelope[UserDeleted](data=await service.delete_user(open_ro, p, auth, user_id), meta=build_meta(mode="crud"))


@router.get("/v1/admin/users/{user_id}/audit", dependencies=GATE, summary="권한 변경 이력(permission_audit_log 인덱스 제안 채택)")
async def get_admin_users_by_id_audit_5(
    p: CurrentUser, conn: RoConn, user_id: UserId,
    cursor: Annotated[str | None, Query(max_length=4096)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> Envelope[ListData[AuditItem]]:
    """(created_at, audit_id) DESC 키셋. 삭제된 계정도 이력이 있으면 보인다."""
    items, nxt = await service.list_audit(conn, user_id, cursor=cursor, limit=limit)
    return Envelope[ListData[AuditItem]](data=ListData[AuditItem](items=items),
                                         meta=build_meta(mode="audit", page=Page(next_cursor=nxt, limit=limit)))
