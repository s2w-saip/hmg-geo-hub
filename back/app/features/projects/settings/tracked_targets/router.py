"""projects.settings.tracked_targets 추적 대상(별칭·경쟁사·차종) 라우터. 경로는 /v1 접두 포함 전체 경로."""
import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.filters import PgLine
from app.core.write import RwConn
from app.features.projects.settings.tracked_targets import service as S
from app.features.projects.settings.tracked_targets.schemas import (
    BrandAliasesPut,
    CompetitorCreate,
    TargetPut,
    TrackedWrite,
    VehicleCreate,
)

router = APIRouter(tags=["projects.settings"], responses=ERROR_RESPONSES)


def _env(out: dict) -> Envelope[TrackedWrite]:
    return Envelope[TrackedWrite](data=TrackedWrite(**out), meta=crud_meta(surface="project"))


@router.put("/v1/projects/{project_id}/settings/brand-aliases", response_model=Envelope[TrackedWrite],
            summary="브랜드 별칭 교체 + tracked_brand 재구성 + judgment_change(project_setting)")
async def put_projects_by_id_settings_brand_aliases_0(project_id: uuid.UUID, body: BrandAliasesPut, p: CurrentUser, ro: RoConn,
                                                      rw: RwConn) -> Envelope[TrackedWrite]:
    return _env(await S.put_brand_aliases(ro, rw, p, project_id, body.brand_code, body.aliases))


@router.post("/v1/projects/{project_id}/settings/competitors", status_code=201, response_model=Envelope[TrackedWrite],
             summary="경쟁 브랜드 추가 + 재구성 + judgment_change")
async def post_projects_by_id_settings_competitors_1(project_id: uuid.UUID, body: CompetitorCreate, p: CurrentUser, ro: RoConn,
                                                     rw: RwConn) -> Envelope[TrackedWrite]:
    return _env(await S.add_competitor(ro, rw, p, project_id, body))


@router.delete("/v1/projects/{project_id}/settings/competitors", response_model=Envelope[TrackedWrite],
               summary="경쟁 브랜드 삭제(?brand_name=)")
async def delete_projects_by_id_settings_competitors_2(project_id: uuid.UUID, p: CurrentUser, ro: RoConn, rw: RwConn,
                                                       brand_name: Annotated[PgLine, Query(min_length=1, max_length=200)]) -> Envelope[TrackedWrite]:
    return _env(await S.remove_competitor(ro, rw, p, project_id, brand_name))


@router.put("/v1/projects/{project_id}/settings/competitors/target", response_model=Envelope[TrackedWrite],
            summary="KPI #16 비교 기준 브랜드 지정/해제(조회 시점 설정, judgment_change 없음)")
async def put_projects_by_id_settings_competitors_target_3(project_id: uuid.UUID, body: TargetPut, p: CurrentUser, ro: RoConn,
                                                           rw: RwConn) -> Envelope[TrackedWrite]:
    return _env(await S.set_target(ro, rw, p, project_id, body.brand_name))


@router.post("/v1/projects/{project_id}/settings/vehicles", status_code=201, response_model=Envelope[TrackedWrite],
             summary="추적 차종 추가(+경쟁사 자동 등록) + judgment_change")
async def post_projects_by_id_settings_vehicles_4(project_id: uuid.UUID, body: VehicleCreate, p: CurrentUser, ro: RoConn,
                                                  rw: RwConn) -> Envelope[TrackedWrite]:
    return _env(await S.add_vehicle(ro, rw, p, project_id, body))


@router.delete("/v1/projects/{project_id}/settings/vehicles", response_model=Envelope[TrackedWrite],
               summary="추적 차종 삭제(?brand=&model=)")
async def delete_projects_by_id_settings_vehicles_5(project_id: uuid.UUID, p: CurrentUser, ro: RoConn, rw: RwConn,
                                                    brand: Annotated[PgLine, Query(min_length=1, max_length=200)],
                                                    model: Annotated[PgLine, Query(min_length=1, max_length=200)]) -> Envelope[TrackedWrite]:
    return _env(await S.remove_vehicle(ro, rw, p, project_id, brand, model))
