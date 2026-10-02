"""projects.project.core 프로젝트 CRUD 라우터. 경로는 /v1 접두 포함 전체 경로."""
import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Request, Response

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, Page, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.filters import PgLine
from app.core.write import RwConn
from app.features.projects.project.core import service as S
from app.features.projects.project.core.schemas import (
    CreationOptions,
    ProjectCreate,
    ProjectDelete,
    ProjectDetail,
    ProjectList,
    ProjectPatch,
    ScopeResolution,
)
from app.features.projects.project.core.shared import CRUD_CONSUMED

router = APIRouter(tags=["projects.project"], responses=ERROR_RESPONSES)


@router.get("/v1/projects", response_model=Envelope[ProjectList],
            summary="프로젝트 목록(customer, 비관리자는 활성 멤버십), q 검색, 키셋")
async def get_projects_0(request: Request, p: CurrentUser, ro: RoConn,
                         q: Annotated[PgLine | None, Query(max_length=200, description="이름 부분 일치(ILIKE)")] = None,
                         cursor: str | None = Query(None, max_length=4096),
                         limit: int | None = Query(None, ge=1, le=S.LIST_MAX, description=f"기본 {S.LIST_DEFAULT}, 최대 {S.LIST_MAX}")
                         ) -> Envelope[ProjectList]:
    items, nxt, lim = await S.list_projects(ro, p, q, cursor, limit)
    return Envelope[ProjectList](data=ProjectList(items=items, next_cursor=nxt),
                                 meta=crud_meta(request.query_params, surface="project", consumed=CRUD_CONSUMED, page=Page(next_cursor=nxt, limit=lim)))


@router.post("/v1/projects", status_code=201, response_model=Envelope[ProjectDetail],
             summary="생성(operator=global 또는 admin, 스코프 검증): project + owner 멤버 + owned_base + engine_history + outbox(project:create, schedule")
async def post_projects_1(body: ProjectCreate, p: CurrentUser, ro: RoConn, rw: RwConn) -> Envelope[ProjectDetail]:
    out = await S.create_project(ro, rw, p, body)
    return Envelope[ProjectDetail](data=ProjectDetail(**out), meta=crud_meta(surface="project"))


# 고정 경로 두 개는 /v1/projects/{project_id} 보다 먼저 등록한다(creation-options 가 {project_id} 로 잡혀 422 가 되지 않게).
@router.get("/v1/projects/creation-options", response_model=Envelope[CreationOptions],
            summary="생성 폼 선택지(브랜드·국가·엔진·기본 엔진, 생성 검증과 같은 어휘). 비생성자 403 operator_forbidden")
async def get_projects_creation_options(request: Request, p: CurrentUser, ro: RoConn) -> Envelope[CreationOptions]:
    out = await S.get_creation_options(ro, p)
    return Envelope[CreationOptions](data=CreationOptions(**out), meta=crud_meta(request.query_params, surface="project",
                                                                                 consumed=CRUD_CONSUMED))


@router.get("/v1/projects/by-scope/{scope_project_id}", response_model=Envelope[ScopeResolution],
            summary="Scope 프로젝트 id 해석: 고객 프로젝트(활성 멤버·admin) 또는 웹사이트 사이트(brand·country, 스코프 안). 그 밖 404")
async def get_projects_by_scope(scope_project_id: uuid.UUID, request: Request, p: CurrentUser, ro: RoConn
                                ) -> Envelope[ScopeResolution]:
    out = await S.resolve_by_scope(ro, p, scope_project_id)
    return Envelope[ScopeResolution](data=ScopeResolution(**out), meta=crud_meta(request.query_params, surface="project",
                                                                                 consumed=CRUD_CONSUMED))


@router.get("/v1/projects/{project_id}", response_model=Envelope[ProjectDetail],
            summary="상세(일반 설정 + my_role + scope_linked). 비멤버 404")
async def get_projects_by_id_2(project_id: uuid.UUID, request: Request, p: CurrentUser, ro: RoConn) -> Envelope[ProjectDetail]:
    out = await S.get_project(ro, p, project_id)
    return Envelope[ProjectDetail](data=ProjectDetail(**out), meta=crud_meta(request.query_params, surface="project", consumed=CRUD_CONSUMED))


@router.patch("/v1/projects/{project_id}", response_model=Envelope[ProjectDetail],
              summary="name·description·brand_code·ga4_property_id 수정(Owner/admin, extra=forbid). brand_code 변경 시 tracked_brand 재구성 + outbox(pr")
async def patch_projects_by_id_3(project_id: uuid.UUID, body: ProjectPatch, p: CurrentUser, ro: RoConn, rw: RwConn
                                 ) -> Envelope[ProjectDetail]:
    out = await S.patch_project(ro, rw, p, project_id, body)
    return Envelope[ProjectDetail](data=ProjectDetail(**out), meta=crud_meta(surface="project"))


@router.delete("/v1/projects/{project_id}", status_code=204, response_class=Response,
               summary="하드 삭제(confirm_name 대조, standard_root 거부) + outbox(project:delete)")
async def delete_projects_by_id_4(project_id: uuid.UUID, body: ProjectDelete, p: CurrentUser, ro: RoConn, rw: RwConn) -> Response:
    await S.delete_project(ro, rw, p, project_id, body.confirm_name)
    return Response(status_code=204)
