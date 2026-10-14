"""projects.prompts.candidates 후보 풀 라우터. 경로는 /v1 접두 포함 전체 경로.

권한: 목록 = 프로젝트 가시(member), 승격·삭제 = 활성 Owner 또는 admin(owner).
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Request, Response

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, Page, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.write import RwConn
from app.features.projects.prompts.crud.common import PJ3_CONSUMED, ROUTER_DEPS, project_gate
from app.features.projects.prompts.screen import ProjectScreenPage, ProjectScreenQuery, candidate_screen

from . import service
from .schemas import CandidateIds, CandidateItem, CandidateList, DeleteResult, SelectResult

router = APIRouter(tags=["projects.prompts"], dependencies=ROUTER_DEPS, responses=ERROR_RESPONSES)


@router.post("/v1/projects/{project_id}/prompt-candidates/screen", response_model=Envelope[ProjectScreenPage[CandidateItem]])
async def read_candidate_screen(project_id: uuid.UUID, body: ProjectScreenQuery, p: CurrentUser, conn: RoConn) -> Envelope[ProjectScreenPage[CandidateItem]]:
    await project_gate(conn, p, project_id, "active_member")
    return Envelope(data=await candidate_screen(conn, project_id, body), meta=crud_meta(surface="project"))


@router.get("/v1/projects/{project_id}/prompt-candidates", summary="후보 풀 목록", response_model=Envelope[CandidateList])
async def get_projects_by_id_prompt_candidates_0(
    project_id: uuid.UUID, request: Request, p: CurrentUser, conn: RoConn,
    cursor: Annotated[str | None, Query(max_length=4096)] = None,
    limit: Annotated[int | None, Query(ge=1, le=500)] = None,
    include_total: Annotated[bool, Query(description=(
        "false = 전체 건수(COUNT) 를 세지 않고 meta.page.total = null(행·커서는 같다). 건수를 따로 아는 화면(홈 타일은 상세 "
        "candidate_count)용"))] = True,
) -> Envelope[CandidateList]:
    await project_gate(conn, p, project_id, "active_member")      # 멤버 전용 읽기(front prompt/page.tsx:43, 메인 정정 2026-09-28)
    data, total, lim = await service.list_candidates(conn, project_id, cursor, limit, include_total=include_total)
    meta = crud_meta(request.query_params, surface="project", consumed=PJ3_CONSUMED)
    meta.page = Page(next_cursor=data.next_cursor, limit=lim, total=total)
    return Envelope[CandidateList](data=data, meta=meta)


@router.post("/v1/projects/{project_id}/prompt-candidates/select", status_code=201, summary="선택 후보를 draft 프롬프트로 승격",
             response_model=Envelope[SelectResult])
async def post_projects_by_id_prompt_candidates_select_1(project_id: uuid.UUID, body: CandidateIds, p: CurrentUser, conn: RoConn,
                                                         rw: RwConn) -> Envelope[SelectResult]:
    await project_gate(conn, p, project_id, "owner")
    return Envelope[SelectResult](data=await service.select_candidates(rw, project_id, body.candidate_ids), meta=crud_meta(surface="project"))


@router.delete("/v1/projects/{project_id}/prompt-candidates/{candidate_id}", status_code=204, summary="후보 1건 삭제")
async def delete_projects_by_id_prompt_candidates_by_id_2(project_id: uuid.UUID, candidate_id: uuid.UUID, p: CurrentUser,
                                                          conn: RoConn, rw: RwConn) -> Response:
    await project_gate(conn, p, project_id, "owner")
    await service.delete_one(rw, project_id, candidate_id)
    return Response(status_code=204)


@router.post("/v1/projects/{project_id}/prompt-candidates/bulk-delete", summary="후보 선택 삭제", response_model=Envelope[DeleteResult])
async def post_projects_by_id_prompt_candidates_bulk_delete_3(project_id: uuid.UUID, body: CandidateIds, p: CurrentUser,
                                                              conn: RoConn, rw: RwConn) -> Envelope[DeleteResult]:
    await project_gate(conn, p, project_id, "owner")
    return Envelope[DeleteResult](data=await service.delete_many(rw, project_id, body.candidate_ids), meta=crud_meta(surface="project"))
