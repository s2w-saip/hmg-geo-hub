"""projects.prompts.lifecycle 일시정지·재개·삭제 영향 라우터. 경로는 /v1 접두 포함 전체 경로.

권한: 영향 미리보기·중지·완전 삭제 = 활성 Owner 또는 admin(owner), 재개 = 비용 액션(member 가시성 + require_operator('run')).
접근 감사: Scope 반영 요청(중지·재개·완전 삭제)은 kind scope_call(Q4).
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.write import RwConn, access_audit
from app.features.projects.prompts.crud.common import PJ3_CONSUMED, ROUTER_DEPS, operate_gate, project_gate
from app.features.projects.prompts.execute.publisher import ScopePublisher, get_publisher

from . import service
from .schemas import LifecycleImpact, LifecycleResult

router = APIRouter(tags=["projects.prompts"], dependencies=ROUTER_DEPS, responses=ERROR_RESPONSES)
Publisher = Annotated[ScopePublisher, Depends(get_publisher)]


@router.get("/v1/projects/{project_id}/prompts/{prompt_id}/lifecycle-impact",
            summary="중지·완전삭제 영향 미리보기(served 답변·브랜드 언급 행·인용 원소·공유 행), api_ro", response_model=Envelope[LifecycleImpact])
async def get_projects_by_id_prompts_by_id_lifecycle_impact_0(project_id: uuid.UUID, prompt_id: uuid.UUID, request: Request,
                                                              p: CurrentUser, conn: RoConn) -> Envelope[LifecycleImpact]:
    acc = await project_gate(conn, p, project_id, "owner")
    data = await service.impact(conn, acc, prompt_id)
    return Envelope[LifecycleImpact](data=data, meta=crud_meta(request.query_params, surface="project", consumed=PJ3_CONSUMED))


@router.post("/v1/projects/{project_id}/prompts/{prompt_id}/pause", summary="측정 중지(Owner), outbox(prompt:disable)",
             response_model=Envelope[LifecycleResult])
async def post_projects_by_id_prompts_by_id_pause_1(project_id: uuid.UUID, prompt_id: uuid.UUID, p: CurrentUser, conn: RoConn,
                                                    rw: RwConn, publisher: Publisher) -> Envelope[LifecycleResult]:
    acc = await project_gate(conn, p, project_id, "owner")
    res = await service.pause(rw, acc, prompt_id, publisher)
    access_audit(p, "scope_call", "projects.prompts.pause", target=str(prompt_id), detail={"project_id": str(project_id)})
    return Envelope[LifecycleResult](data=res, meta=crud_meta(surface="project"))


@router.post("/v1/projects/{project_id}/prompts/{prompt_id}/resume", summary="측정 재개(운영자 게이트), outbox(prompt:enable)",
             response_model=Envelope[LifecycleResult])
async def post_projects_by_id_prompts_by_id_resume_2(project_id: uuid.UUID, prompt_id: uuid.UUID, p: CurrentUser, conn: RoConn,
                                                     rw: RwConn, publisher: Publisher) -> Envelope[LifecycleResult]:
    acc = await operate_gate(conn, p, project_id)
    res = await service.resume(rw, acc, prompt_id, publisher)
    access_audit(p, "scope_call", "projects.prompts.resume", target=str(prompt_id), detail={"project_id": str(project_id)})
    return Envelope[LifecycleResult](data=res, meta=crud_meta(surface="project"))


@router.post("/v1/projects/{project_id}/prompts/{prompt_id}/hard-delete",
             summary="완전 삭제(공유 0 이면 outbox(prompt:delete) + soft delete)", response_model=Envelope[LifecycleResult])
async def post_projects_by_id_prompts_by_id_hard_delete_3(project_id: uuid.UUID, prompt_id: uuid.UUID, p: CurrentUser, conn: RoConn,
                                                          rw: RwConn, publisher: Publisher) -> Envelope[LifecycleResult]:
    acc = await project_gate(conn, p, project_id, "owner")
    res = await service.hard_delete(rw, acc, prompt_id, publisher)
    access_audit(p, "scope_call", "projects.prompts.hard_delete", target=str(prompt_id),
                 detail={"project_id": str(project_id), "shared_rows": res.shared_rows, "propagation": res.propagation})
    return Envelope[LifecycleResult](data=res, meta=crud_meta(surface="project"))
