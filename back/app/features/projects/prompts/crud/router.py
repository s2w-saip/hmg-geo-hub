"""projects.prompts.crud 프롬프트 CRUD 라우터. 경로는 /v1 접두 포함 전체 경로.

권한: 목록 = 프로젝트 가시(core.auth.resolve_project member), 추가·수정·삭제 = 활성 Owner 또는 admin(owner).
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Request, Response

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, Page, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.filters import parse_custom_fields
from app.core.write import RwConn
from app.features.projects.prompts.screen import ProjectScreenPage, ProjectScreenQuery, prompt_screen

from . import service
from .common import PJ3_CONSUMED, ROUTER_DEPS, project_gate
from .schemas import Q_PATTERN, Created, ManualAdd, PromptItem, PromptKind, PromptList, PromptPatch, PromptStatus

router = APIRouter(tags=["projects.prompts"], dependencies=ROUTER_DEPS, responses=ERROR_RESPONSES)


@router.post("/v1/projects/{project_id}/prompts/screen", response_model=Envelope[ProjectScreenPage[PromptItem]])
async def read_prompt_screen(project_id: uuid.UUID, body: ProjectScreenQuery, p: CurrentUser, conn: RoConn) -> Envelope[ProjectScreenPage[PromptItem]]:
    await project_gate(conn, p, project_id, "active_member")
    return Envelope(data=await prompt_screen(conn, project_id, body), meta=crud_meta(surface="project"))


@router.get("/v1/projects/{project_id}/prompts", summary="프롬프트 목록(status[]·kind·q·커스텀 필드 값, 키셋) + 태그값",
            response_model=Envelope[PromptList])
async def get_projects_by_id_prompts_0(
    project_id: uuid.UUID, request: Request, p: CurrentUser, conn: RoConn,
    status: Annotated[list[PromptStatus], Query(max_length=6, description="draft|queued|running|done|failed|paused (반복)")] = [],  # noqa: B006
    kind: Annotated[PromptKind | None, Query(description="single|acr")] = None,
    q: Annotated[str | None, Query(min_length=1, max_length=200, pattern=Q_PATTERN,
                                   description="본문 부분 일치(대소문자 무시). 제어 문자 금지")] = None,
    cursor: Annotated[str | None, Query(max_length=4096)] = None,
    limit: Annotated[int | None, Query(ge=1, le=500)] = None,
) -> Envelope[PromptList]:
    """커스텀 필드 값 필터는 ?cf.<field_id>=값(반복 가능, core.filters.parse_custom_fields). 프로젝트 밖 필드는 dropped + 빈 결과."""
    await project_gate(conn, p, project_id, "active_member")      # 멤버 전용 읽기(front prompt/page.tsx:43, 메인 정정 2026-09-28)
    custom = parse_custom_fields(request.query_params)
    data, total, dropped = await service.list_prompts(conn, project_id, statuses=list(status), kind=kind, q_text=q, custom=custom,
                                                      cursor=cursor, limit=limit)
    meta = crud_meta(request.query_params, surface="project", consumed=PJ3_CONSUMED, extra_supported=("custom",))
    if dropped:
        meta.dropped_filters["custom"] = dropped
    meta.page = Page(next_cursor=data.next_cursor, limit=limit or 50, total=total)
    return Envelope[PromptList](data=data, meta=meta)


@router.post("/v1/projects/{project_id}/prompts", status_code=201, summary="수동 추가(줄바꿈 분리, draft)",
             response_model=Envelope[Created])
async def post_projects_by_id_prompts_1(project_id: uuid.UUID, body: ManualAdd, p: CurrentUser, conn: RoConn,
                                        rw: RwConn) -> Envelope[Created]:
    await project_gate(conn, p, project_id, "owner")
    return Envelope[Created](data=await service.add_manual(rw, project_id, body.text), meta=crud_meta(surface="project"))


@router.patch("/v1/projects/{project_id}/prompts/{prompt_id}", summary="본문(draft 만)·메타 수정", response_model=Envelope[PromptItem])
async def patch_projects_by_id_prompts_by_id_2(project_id: uuid.UUID, prompt_id: uuid.UUID, body: PromptPatch, p: CurrentUser,
                                               conn: RoConn, rw: RwConn) -> Envelope[PromptItem]:
    await project_gate(conn, p, project_id, "owner")
    item = await service.patch_prompt(rw, project_id, prompt_id, body.model_dump(exclude_unset=True))
    return Envelope[PromptItem](data=item, meta=crud_meta(surface="project"))


@router.delete("/v1/projects/{project_id}/prompts/{prompt_id}", status_code=204,
               summary="draft ∧ scope_prompt_id NULL 만 삭제, 그 외 409")
async def delete_projects_by_id_prompts_by_id_3(project_id: uuid.UUID, prompt_id: uuid.UUID, p: CurrentUser, conn: RoConn,
                                                rw: RwConn) -> Response:
    await project_gate(conn, p, project_id, "owner")
    await service.delete_prompt(rw, project_id, prompt_id)
    return Response(status_code=204)
