"""projects.members.invites 초대 수락·거절 라우터. 경로는 /v1 접두 포함 전체 경로."""
import uuid

from fastapi import APIRouter, Request, Response

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.write import RwConn
from app.features.projects.members.invites import service as S
from app.features.projects.members.invites.schemas import PendingInviteList
from app.features.projects.project.core.shared import CRUD_CONSUMED

router = APIRouter(tags=["projects.members"], responses=ERROR_RESPONSES)


@router.post("/v1/projects/{project_id}/members/me/accept", status_code=204, response_class=Response,
             summary="본인 대기 초대 수락 + 감사(콜론형 me:accept 를 하위 리소스형으로 통일)")
async def post_projects_by_id_members_me_accept_0(project_id: uuid.UUID, p: CurrentUser, rw: RwConn) -> Response:
    await S.respond(rw, p, project_id, accept=True)
    return Response(status_code=204)


@router.post("/v1/projects/{project_id}/members/me/reject", status_code=204, response_class=Response,
             summary="본인 대기 초대 거절 + 감사")
async def post_projects_by_id_members_me_reject_1(project_id: uuid.UUID, p: CurrentUser, rw: RwConn) -> Response:
    await S.respond(rw, p, project_id, accept=False)
    return Response(status_code=204)


@router.get("/v1/me/project-invites", response_model=Envelope[PendingInviteList], summary="세션 사용자 대기 초대 목록(알림 배지)")
async def get_me_project_invites_2(request: Request, p: CurrentUser, ro: RoConn) -> Envelope[PendingInviteList]:
    rows = await S.my_pending(ro, p)
    return Envelope[PendingInviteList](data=PendingInviteList(items=rows), meta=crud_meta(request.query_params, surface="project", consumed=CRUD_CONSUMED))
