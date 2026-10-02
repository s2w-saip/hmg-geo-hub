"""admin.changes.queue 재판정·운영 요청 조회 라우터. 경로는 /v1 접두 포함 전체 경로.

모든 엔드포인트: 인증(CurrentUser) + role=admin + 메뉴 그룹 admin(좁히기). 읽기는 api_ro(RoConn, 계정 조회와 같은 트랜잭션).
"""
from __future__ import annotations

import uuid
from typing import Annotated, get_args

from fastapi import APIRouter, Path, Query, Request

from app.core.auth import CurrentUser, require_admin, require_menu_group
from app.core.db import RoConn
from app.core.envelope import Envelope, ListData, Page, build_meta, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.write import ChangeKind

from . import service
from .schemas import ChangeItem, ChangeStatus

router = APIRouter(tags=["admin.changes"], dependencies=[require_admin, require_menu_group("admin")], responses=ERROR_RESPONSES)

KINDS = get_args(ChangeKind)


@router.get("/v1/admin/changes", summary="재판정·운영 요청 큐 조회(kind[]·status[]·requested_by·subject), 모든 비동기 쓰기 반영 확인 경로")
async def get_admin_changes_0(
    request: Request, p: CurrentUser, conn: RoConn,
    kind: Annotated[list[ChangeKind], Query(max_length=len(KINDS), description="요청 종류(반복 가능)")] = [],  # noqa: B006
    status: Annotated[list[ChangeStatus], Query(max_length=5, description="상태(반복 가능)")] = [],  # noqa: B006
    requested_by: Annotated[uuid.UUID | None, Query(description="요청자 user_id")] = None,
    subject: Annotated[str | None, Query(min_length=1, max_length=300, description="대상(UUID 면 subject_uuids, 아니면 subject_texts 원소)")] = None,
    cursor: Annotated[str | None, Query(max_length=4096)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> Envelope[ListData[ChangeItem]]:
    """change_id DESC 키셋. 다음 페이지는 meta.page.next_cursor. 공통 필터 축은 지원하지 않는다(들어오면 meta.ignored_filters)."""
    items, nxt = await service.list_changes(conn, kinds=list(kind), statuses=list(status), requested_by=requested_by,
                                            subject=subject, cursor=cursor, limit=limit)
    meta = crud_meta(request.query_params, mode="admin", page=Page(next_cursor=nxt, limit=limit))
    return Envelope[ListData[ChangeItem]](data=ListData[ChangeItem](items=items), meta=meta)


@router.get("/v1/admin/changes/{change_id}", summary="요청 1건 상태(pending·running·applied·failed·escalated_rebuild)")
async def get_admin_changes_by_id_1(p: CurrentUser, conn: RoConn,
                                    change_id: Annotated[int, Path(ge=1, le=2 ** 63 - 1)]) -> Envelope[ChangeItem]:
    """없으면 404."""
    return Envelope[ChangeItem](data=await service.get_change(conn, change_id), meta=build_meta(mode="admin"))
