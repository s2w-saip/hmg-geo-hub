"""intent.keywords.fetches 수집 요청(비동기) 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Path, Query, Request
from fastapi.responses import JSONResponse
from pydantic import Field

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import ListData, envelope
from app.core.errors import ERROR_RESPONSES
from app.core.write import RwConn
from app.features.intent.keywords.fetches import service as svc
from app.features.intent.keywords.fetches.schemas import (
    MAX_STATUS_IDS,
    FetchAcceptedEnvelope,
    FetchIn,
    FetchStatusEnvelope,
    FetchStatusListEnvelope,
)
from app.features.intent.keywords.research.intent_common import intent_meta

router = APIRouter(tags=["intent.keywords"], responses=ERROR_RESPONSES)
_CONSUMED = frozenset({"ids"})
ChangeId = Annotated[int, Field(ge=1, le=2 ** 63 - 1)]


@router.post("/v1/intent/fetches", status_code=202,
             summary="DataForSEO 수집 요청: 신선하면 200 skip, 아니면 judgment_change(dfs_fetch, 제안 kind) 202 {change_id}",
             response_model=FetchAcceptedEnvelope, responses={200: {"model": FetchAcceptedEnvelope, "description": "신선함(수집 안 함)"}})
async def post_intent_fetches_0(request: Request, p: CurrentUser, conn: RoConn, rw: RwConn, body: FetchIn) -> JSONResponse:
    data, code = await svc.accept(conn, rw, p, body)
    return JSONResponse(status_code=code, content=envelope(data, intent_meta(request, mode="crud")))


@router.get("/v1/intent/fetches/{change_id}", summary="수집 요청 상태", response_model=FetchStatusEnvelope)
async def get_intent_fetches_by_id_1(request: Request, p: CurrentUser, conn: RoConn,
                                     change_id: Annotated[int, Path(ge=1, le=2 ** 63 - 1)]) -> FetchStatusEnvelope:
    data = await svc.status(conn, p, change_id)
    return FetchStatusEnvelope(data=data, meta=intent_meta(request, mode="crud"))


@router.get("/v1/intent/fetches", summary="수집 요청 상태 일괄(폴링용, 요청 순서). 단건과 같은 가시성: 하나라도 없거나 볼 수 없으면 404",
            response_model=FetchStatusListEnvelope)
async def get_intent_fetches_2(request: Request, p: CurrentUser, conn: RoConn,
                               ids: Annotated[list[ChangeId], Query(min_length=1, max_length=MAX_STATUS_IDS,
                                                                    description=f"change id 1~{MAX_STATUS_IDS}건")]
                               ) -> FetchStatusListEnvelope:
    items = await svc.statuses(conn, p, ids)
    return FetchStatusListEnvelope(data=ListData(items=items), meta=intent_meta(request, mode="crud", consumed=_CONSUMED))
