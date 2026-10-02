"""projects.settings.scope_link Scope 연결 진단 라우터. 경로는 /v1 접두 포함 전체 경로.

라이브 진단 어댑터(adapter.py, 기본 꺼짐)를 켜면 이 핸들러가 외부 호출(Scope)을 한다. 그래서 요청 커넥션을 쥐지 않는
core.auth.CurrentUserDetached(계정만 짧은 api_ro 트랜잭션에서 읽고 반납) + core.db.RoSession(진단 읽기용 짧은 트랜잭션)으로 받고,
읽기를 끝낸 뒤(커넥션 반납 후) 어댑터를 부른다(core.db 규약, 6라운드 pj-core R6 처분).
admin 게이트도 CurrentUser 를 여는 require_admin 의존성 대신 핸들러 안에서 core.auth.check_admin(같은 판정·코드 403 admin_only)으로 건다.
"""
import uuid

from fastapi import APIRouter, Depends, Request

from app.core.auth import CurrentUserDetached, check_admin
from app.core.db import RoSession
from app.core.envelope import Envelope, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.write import access_audit
from app.features.projects.project.core.shared import CRUD_CONSUMED
from app.features.projects.settings.scope_link import service as S
from app.features.projects.settings.scope_link.adapter import ScopeProbe, get_scope_probe
from app.features.projects.settings.scope_link.schemas import ScopeLink

router = APIRouter(tags=["projects.settings"], responses=ERROR_RESPONSES)


@router.get("/v1/projects/{project_id}/settings/scope-link", response_model=Envelope[ScopeLink],
            summary="Scope 연결 진단(admin): outbox 대기·오류, 최신 회차 job/served 수. 라이브 Scope 호출 없음")
async def get_projects_by_id_settings_scope_link_0(project_id: uuid.UUID, request: Request, p: CurrentUserDetached,
                                                   open_ro: RoSession, probe: ScopeProbe = Depends(get_scope_probe)
                                                   ) -> Envelope[ScopeLink]:
    check_admin(p)                                  # core require_admin 과 같은 판정·코드(요청 커넥션 없이)
    async with open_ro() as ro:
        out = await S.diagnose(ro, p, project_id)
    live = None
    if out["scope_project_id"] is not None:        # 외부 호출(어댑터를 켰을 때): 커넥션을 쥐지 않은 상태
        live = await probe.probe(out["scope_project_id"])
        if live is not None:
            access_audit(p, "scope_call", "scope_link.probe", target=str(project_id), detail={"probe": probe.name})
    return Envelope[ScopeLink](data=ScopeLink(**out, live=live),
                               meta=crud_meta(request.query_params, surface="project", consumed=CRUD_CONSUMED,
                                              source={"live_probe": probe.name}))
