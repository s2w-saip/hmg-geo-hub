"""projects.settings.overview 설정 묶음 라우터. 경로는 /v1 접두 포함 전체 경로."""
import uuid

from fastapi import APIRouter, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.features.projects.project.core.shared import CRUD_CONSUMED
from app.features.projects.settings.overview import service as S
from app.features.projects.settings.overview.schemas import SettingsBundle

router = APIRouter(tags=["projects.settings"], responses=ERROR_RESPONSES)


@router.get("/v1/projects/{project_id}/settings", response_model=Envelope[SettingsBundle],
            summary="설정 화면 묶음 1회 조회(엔진·owned base·별칭·경쟁사·차종·추적 URL 건수), G-25 억제")
async def get_projects_by_id_settings_0(project_id: uuid.UUID, request: Request, p: CurrentUser, ro: RoConn) -> Envelope[SettingsBundle]:
    return Envelope[SettingsBundle](data=SettingsBundle(**await S.bundle(ro, p, project_id)), meta=crud_meta(request.query_params, surface="project", consumed=CRUD_CONSUMED))
