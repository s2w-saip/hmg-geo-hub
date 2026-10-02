"""projects.members.audit 멤버 감사 라우터. 경로는 /v1 접두 포함 전체 경로."""
import uuid

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, Page, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.features.projects.members.audit import service as S
from app.features.projects.members.audit.schemas import MemberAuditList
from app.features.projects.project.core.shared import CRUD_CONSUMED

router = APIRouter(tags=["projects.members"], responses=ERROR_RESPONSES)


@router.get("/v1/projects/{project_id}/member-audit", response_model=Envelope[MemberAuditList],
            summary="멤버 변경 감사 로그 키셋(member_audit_project_idx 채택 전제)")
async def get_projects_by_id_member_audit_0(project_id: uuid.UUID, request: Request, p: CurrentUser, ro: RoConn,
                                            cursor: str | None = Query(None, max_length=4096),
                                            limit: int | None = Query(None, ge=1, le=S.MAX_LIMIT,
                                                                      description=f"기본 {S.DEFAULT_LIMIT}, 최대 {S.MAX_LIMIT}")
                                            ) -> Envelope[MemberAuditList]:
    items, nxt, lim = await S.list_audit(ro, p, project_id, cursor, limit)
    return Envelope[MemberAuditList](data=MemberAuditList(items=items, next_cursor=nxt),
                                     meta=crud_meta(request.query_params, surface="project", consumed=CRUD_CONSUMED, page=Page(next_cursor=nxt, limit=lim)))
