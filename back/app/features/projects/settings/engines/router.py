"""projects.settings.engines AI 엔진 라우터. 경로는 /v1 접두 포함 전체 경로."""
import uuid

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, Page, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.write import RwConn
from app.features.projects.project.core.shared import CRUD_CONSUMED
from app.features.projects.settings.engines import service as S
from app.features.projects.settings.engines.schemas import EngineHistoryList, EnginesPut, EnginesWrite

router = APIRouter(tags=["projects.settings"], responses=ERROR_RESPONSES)


@router.put("/v1/projects/{project_id}/settings/engines", response_model=Envelope[EnginesWrite],
            summary="AI 엔진 교체(Owner ∧ 운영자) + engine_history + outbox(schedule:set_targets)")
async def put_projects_by_id_settings_engines_0(project_id: uuid.UUID, body: EnginesPut, p: CurrentUser, ro: RoConn, rw: RwConn
                                                ) -> Envelope[EnginesWrite]:
    out = await S.put_engines(ro, rw, p, project_id, body.engines)
    return Envelope[EnginesWrite](data=EnginesWrite(**out), meta=crud_meta(surface="project"))


@router.get("/v1/projects/{project_id}/settings/engines/history", response_model=Envelope[EngineHistoryList], summary="엔진 변경 이력")
async def get_projects_by_id_settings_engines_history_1(project_id: uuid.UUID, request: Request, p: CurrentUser, ro: RoConn,
                                                        cursor: str | None = Query(None, max_length=4096),
                                                        limit: int | None = Query(None, ge=1, le=S.HISTORY_MAX)
                                                        ) -> Envelope[EngineHistoryList]:
    items, nxt, lim = await S.history(ro, p, project_id, cursor, limit)
    return Envelope[EngineHistoryList](data=EngineHistoryList(items=items, next_cursor=nxt),
                                       meta=crud_meta(request.query_params, surface="project", consumed=CRUD_CONSUMED, page=Page(next_cursor=nxt, limit=lim)))
