"""projects.members.roster 멤버 목록·역할 라우터. 경로는 /v1 접두 포함 전체 경로."""
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request, Response

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, crud_meta
from app.core.errors import ERROR_RESPONSES, ErrorBody
from app.core.write import RwConn
from app.features.projects.members.roster import service as S
from app.features.projects.members.roster.schemas import InviteBody, Member, MemberList, RolePatch
from app.features.projects.project.core.shared import CRUD_CONSUMED

router = APIRouter(tags=["projects.members"], responses=ERROR_RESPONSES)


@router.get("/v1/projects/{project_id}/members", response_model=Envelope[MemberList], summary="멤버 목록(pending+active)")
async def get_projects_by_id_members_0(project_id: uuid.UUID, request: Request, p: CurrentUser, ro: RoConn) -> Envelope[MemberList]:
    rows = await S.list_members(ro, p, project_id)
    return Envelope[MemberList](data=MemberList(items=rows), meta=crud_meta(request.query_params, surface="project", consumed=CRUD_CONSUMED))


@router.post("/v1/projects/{project_id}/members", status_code=201, response_model=Envelope[Member],
             summary="기존 가입자 초대(viewer·pending) + member_audit_log(invite)",
             responses={409: {"model": ErrorBody, "description": "already_member(이미 활성 멤버) · already_invited(초대 대기 중) · "
                                                                  "retry_conflict(동시 변경, 재시도 가능). details.status 는 호환용"}})
async def post_projects_by_id_members_1(project_id: uuid.UUID, body: InviteBody, p: CurrentUser, ro: RoConn, rw: RwConn
                                        ) -> Envelope[Member]:
    row = await S.invite(ro, rw, p, project_id, body.email)
    return Envelope[Member](data=Member(**row), meta=crud_meta(surface="project"))


@router.patch("/v1/projects/{project_id}/members/{user_id}", response_model=Envelope[Member],
              summary="promote/demote(마지막 Owner 강등 금지, FOR UPDATE)")
async def patch_projects_by_id_members_by_id_2(project_id: uuid.UUID, user_id: uuid.UUID, body: RolePatch, p: CurrentUser,
                                               ro: RoConn, rw: RwConn) -> Envelope[Member]:
    row = await S.change_role(ro, rw, p, project_id, user_id, body.role)
    return Envelope[Member](data=Member(**row), meta=crud_meta(surface="project"))


@router.delete("/v1/projects/{project_id}/members/{user_id}", status_code=204, response_class=Response,
               summary="pending=초대 취소, active=제거 + 감사. expect 로 상태 조건(초대 취소 전용 = expect=pending)",
               responses={409: {"model": ErrorBody, "description": "not_pending(expect=pending 인데 활성 멤버) · not_active(expect=active 인데 "
                                                                    "초대 대기) · cannot_remove_owner"}})
async def delete_projects_by_id_members_by_id_3(
        project_id: uuid.UUID, user_id: uuid.UUID, p: CurrentUser, ro: RoConn, rw: RwConn,
        expect: Annotated[Literal["pending", "active"] | None, Query(
            description="상태 조건(선택). pending = 대기 중인 초대만 취소(아니면 409 not_pending), active = 활성 멤버만 제거(아니면 409 "
                        "not_active). 생략 = 예전처럼 상태에 따라 취소 또는 제거")] = None) -> Response:
    await S.remove(ro, rw, p, project_id, user_id, expect)
    return Response(status_code=204)
