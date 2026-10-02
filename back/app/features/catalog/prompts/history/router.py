"""catalog.prompts.history 변경 이력 라우터. 경로는 /v1 접두 포함 전체 경로.

- /v1/prompts/history: 표준 카탈로그 자리(역할 hq·region·country·admin ∧ 메뉴 standard, 서비스 check_route).
- /v1/admin/catalog/prompts/{prompt_id}/history: 관리 카탈로그 자리(require_admin ∧ 메뉴 admin, U8-7). 표준 메뉴 그룹 게이트 면제.
"""
import uuid
from typing import Annotated

from fastapi import APIRouter, Query
from fastapi.responses import Response

from app.core.auth import CurrentUser, require_admin, require_menu_group
from app.core.db import RoConn
from app.core.errors import ERROR_RESPONSES
from app.features.catalog.prompts.history.schemas import HistoryQuery
from app.features.catalog.prompts.history.service import HistoryEnvelope, list_history, list_prompt_timeline_admin

router = APIRouter(tags=["catalog.prompts"])


@router.get(
    "/v1/prompts/history",
    response_model=HistoryEnvelope,
    responses={**ERROR_RESPONSES, 200: {"description": "format=csv 는 text/csv(UTF-8 BOM, 상한 5,000, X-Export-Truncated)",
                                        "content": {"text/csv": {}}}},
    summary="표준 카탈로그 변경 감사 이력(app.prompt_audit_log), prompt_id 단일 타임라인 포함, 스코프 교집합, 키셋, csv 상한 5,000",
    operation_id="listPromptHistory",
)
async def get_prompts_history(p: CurrentUser, conn: RoConn, q: Annotated[HistoryQuery, Query()]) -> HistoryEnvelope | Response:
    """from/to 는 created_at 의 KST 달력일(이 엔드포인트만의 해석). 기본 from = 오늘(KST) - 90일.
    목록은 data.items(created_at DESC, audit_id DESC), 다음 페이지는 meta.page.next_cursor."""
    return await list_history(conn, p, q)


@router.get(
    "/v1/admin/catalog/prompts/{prompt_id:uuid}/history",
    response_model=HistoryEnvelope,
    responses=ERROR_RESPONSES,
    dependencies=[require_admin, require_menu_group("admin")],
    summary="관리 카탈로그 프롬프트 타임라인(admin ∧ 메뉴 admin, 표준 메뉴 게이트 면제), 기간 없음, 삭제 프롬프트 포함, 키셋",
)
async def get_admin_catalog_prompt_history(
        prompt_id: uuid.UUID, p: CurrentUser, conn: RoConn,
        cursor: Annotated[str | None, Query(max_length=4096)] = None,
        limit: Annotated[int | None, Query(description="기본 100(현행 listForPrompt), 상한 500")] = None) -> HistoryEnvelope:
    """현행 admin 자리(/admin/standards/prompts) 타임라인(listForPrompt: 기간 없음, 최신 100)과 같은 행. 표준 루트 원장만, 정렬 created_at DESC,
    audit_id DESC, 다음 페이지는 meta.page.next_cursor. 비 admin 403 admin_only, 메뉴 admin 없는 admin 403 menu_forbidden."""
    return await list_prompt_timeline_admin(conn, p, prompt_id, cursor=cursor, limit=limit)
