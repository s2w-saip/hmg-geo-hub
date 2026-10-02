"""projects.prompts.fields 커스텀 필드 라우터. 경로는 /v1 접두 포함 전체 경로.

권한: 목록 = 프로젝트 가시(member), 추가·보관·복구·삭제·값 쓰기 = 활성 Owner 또는 admin(owner).
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Request, Response

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.write import RwConn
from app.features.projects.prompts.crud.common import PJ3_CONSUMED, ROUTER_DEPS, project_gate

from . import service
from .schemas import BulkResult, BulkSet, FieldCreate, FieldItem, FieldList, ValueResult, ValueSet

router = APIRouter(tags=["projects.prompts"], dependencies=ROUTER_DEPS, responses=ERROR_RESPONSES)


@router.get("/v1/projects/{project_id}/prompt-fields", summary="커스텀 태그 목록", response_model=Envelope[FieldList])
async def get_projects_by_id_prompt_fields_0(project_id: uuid.UUID, request: Request, p: CurrentUser, conn: RoConn) -> Envelope[FieldList]:
    await project_gate(conn, p, project_id, "active_member")      # 멤버 전용 읽기(front prompt/page.tsx:43, 메인 정정 2026-09-28)
    return Envelope[FieldList](data=await service.list_fields(conn, project_id), meta=crud_meta(request.query_params, surface="project", consumed=PJ3_CONSUMED))


@router.post("/v1/projects/{project_id}/prompt-fields", status_code=201, summary="태그 추가(예약어 거부)", response_model=Envelope[FieldItem])
async def post_projects_by_id_prompt_fields_1(project_id: uuid.UUID, body: FieldCreate, p: CurrentUser, conn: RoConn,
                                              rw: RwConn) -> Envelope[FieldItem]:
    await project_gate(conn, p, project_id, "owner")
    return Envelope[FieldItem](data=await service.create_field(rw, project_id, body.label), meta=crud_meta(surface="project"))


@router.post("/v1/projects/{project_id}/prompt-fields/{field_id}/archive", summary="태그 보관", response_model=Envelope[FieldItem])
async def post_projects_by_id_prompt_fields_by_id_archive_2(project_id: uuid.UUID, field_id: uuid.UUID, p: CurrentUser, conn: RoConn,
                                                            rw: RwConn) -> Envelope[FieldItem]:
    await project_gate(conn, p, project_id, "owner")
    return Envelope[FieldItem](data=await service.set_archived(rw, project_id, field_id, True), meta=crud_meta(surface="project"))


@router.post("/v1/projects/{project_id}/prompt-fields/{field_id}/restore", summary="태그 복구", response_model=Envelope[FieldItem])
async def post_projects_by_id_prompt_fields_by_id_restore_3(project_id: uuid.UUID, field_id: uuid.UUID, p: CurrentUser, conn: RoConn,
                                                            rw: RwConn) -> Envelope[FieldItem]:
    await project_gate(conn, p, project_id, "owner")
    return Envelope[FieldItem](data=await service.set_archived(rw, project_id, field_id, False), meta=crud_meta(surface="project"))


@router.delete("/v1/projects/{project_id}/prompt-fields/{field_id}", status_code=204, summary="태그 완전 삭제(값 CASCADE)")
async def delete_projects_by_id_prompt_fields_by_id_4(project_id: uuid.UUID, field_id: uuid.UUID, p: CurrentUser, conn: RoConn,
                                                     rw: RwConn) -> Response:
    await project_gate(conn, p, project_id, "owner")
    await service.delete_field(rw, project_id, field_id)
    return Response(status_code=204)


@router.put("/v1/projects/{project_id}/prompts/{prompt_id}/fields/{field_id}", summary="프롬프트 1건 태그값 UPSERT",
            response_model=Envelope[ValueResult])
async def put_projects_by_id_prompts_by_id_fields_by_id_5(project_id: uuid.UUID, prompt_id: uuid.UUID, field_id: uuid.UUID, body: ValueSet,
                                                          p: CurrentUser, conn: RoConn, rw: RwConn) -> Envelope[ValueResult]:
    await project_gate(conn, p, project_id, "owner")
    return Envelope[ValueResult](data=await service.set_value(rw, project_id, prompt_id, field_id, body.value), meta=crud_meta(surface="project"))


@router.post("/v1/projects/{project_id}/prompt-fields/{field_id}/bulk-set", summary="여러 프롬프트 태그값 일괄 적용",
             response_model=Envelope[BulkResult])
async def post_projects_by_id_prompt_fields_by_id_bulk_set_6(project_id: uuid.UUID, field_id: uuid.UUID, body: BulkSet, p: CurrentUser,
                                                             conn: RoConn, rw: RwConn) -> Envelope[BulkResult]:
    await project_gate(conn, p, project_id, "owner")
    return Envelope[BulkResult](data=await service.bulk_set(rw, project_id, field_id, body.prompt_ids, body.value), meta=crud_meta(surface="project"))


@router.delete("/v1/projects/{project_id}/prompts/{prompt_id}/fields/{field_id}", status_code=204, summary="태그값 지우기")
async def delete_projects_by_id_prompts_by_id_fields_by_id_7(project_id: uuid.UUID, prompt_id: uuid.UUID, field_id: uuid.UUID,
                                                             p: CurrentUser, conn: RoConn, rw: RwConn) -> Response:
    await project_gate(conn, p, project_id, "owner")
    await service.clear_value(rw, project_id, prompt_id, field_id)
    return Response(status_code=204)
