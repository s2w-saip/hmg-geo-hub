"""projects.prompts.execute 측정 실행 라우터. 경로는 /v1 접두 포함 전체 경로.

권한: 비용 액션. 프로젝트 가시(member) + core.auth.require_operator('run')(admin·global 운영자·assigned 는 활성 멤버). 202.
접근 감사: Scope 반영 요청이라 kind scope_call(Q4, 응답 후 비동기 배치).
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.write import RwConn, access_audit
from app.features.projects.prompts.crud.common import ROUTER_DEPS, operate_gate

from . import service
from .publisher import ScopePublisher, get_publisher
from .schemas import ExecuteResult

router = APIRouter(tags=["projects.prompts"], dependencies=ROUTER_DEPS, responses=ERROR_RESPONSES)


@router.post("/v1/projects/{project_id}/prompts/execute", status_code=202,
             summary="저장+실행(운영자 게이트): draft·복구 대상 outbox(prompt:create) + queued. 202", response_model=Envelope[ExecuteResult])
async def post_projects_by_id_prompts_execute_0(project_id: uuid.UUID, p: CurrentUser, conn: RoConn, rw: RwConn,
                                                publisher: Annotated[ScopePublisher, Depends(get_publisher)]) -> Envelope[ExecuteResult]:
    acc = await operate_gate(conn, p, project_id)
    res = await service.execute(rw, acc, publisher)
    access_audit(p, "scope_call", "projects.prompts.execute", target=str(project_id), detail={"queued": res.queued})
    return Envelope[ExecuteResult](data=res, meta=crud_meta(surface="project"))
