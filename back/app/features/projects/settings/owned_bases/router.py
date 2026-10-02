"""projects.settings.owned_bases 소유 베이스 URL 라우터. 경로는 /v1 접두 포함 전체 경로."""
import uuid
from typing import Annotated

from fastapi import APIRouter, Query

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.filters import PgLine
from app.core.write import RwConn
from app.features.projects.settings.owned_bases import service as S
from app.features.projects.settings.owned_bases.schemas import OwnedBaseCreate, OwnedBaseWrite

router = APIRouter(tags=["projects.settings"], responses=ERROR_RESPONSES)


@router.post("/v1/projects/{project_id}/settings/owned-bases", status_code=201, response_model=Envelope[OwnedBaseWrite],
             summary="owned base 추가 + domain 재동기화 + judgment_change(project_owned_base) + outbox")
async def post_projects_by_id_settings_owned_bases_0(project_id: uuid.UUID, body: OwnedBaseCreate, p: CurrentUser, ro: RoConn,
                                                     rw: RwConn) -> Envelope[OwnedBaseWrite]:
    out = await S.add(ro, rw, p, project_id, body.base_url, body.label)
    return Envelope[OwnedBaseWrite](data=OwnedBaseWrite(**out), meta=crud_meta(surface="project"))


@router.delete("/v1/projects/{project_id}/settings/owned-bases", response_model=Envelope[OwnedBaseWrite],
               summary="owned base 삭제(?base_norm=)")
async def delete_projects_by_id_settings_owned_bases_1(project_id: uuid.UUID, p: CurrentUser, ro: RoConn, rw: RwConn,
                                                       base_norm: Annotated[PgLine, Query(min_length=1, max_length=2048)]
                                                       ) -> Envelope[OwnedBaseWrite]:
    out = await S.remove(ro, rw, p, project_id, base_norm)
    return Envelope[OwnedBaseWrite](data=OwnedBaseWrite(**out), meta=crud_meta(surface="project"))
