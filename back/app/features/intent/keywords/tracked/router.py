"""intent.keywords.tracked 추적 키워드 라우터. 경로는 /v1 접두 포함 전체 경로.

프로젝트 화면 전용: project 표면 게이트(core.auth.require_surface_gate: 역할 천장 front PROJECT_VIEWERS(website 역할 제외, 검증 m-7) + 메뉴 그룹 project)
+ 프로젝트 접근(core.auth.resolve_project).
"""
import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from app.core import auth
from app.core.auth import CurrentUser
from app.core.codes import load_refs
from app.core.db import RoConn
from app.core.envelope import ListData, envelope
from app.core.errors import ERROR_RESPONSES
from app.core.write import RwConn
from app.features.intent.keywords.research.intent_common import intent_meta
from app.features.intent.keywords.tracked import service as svc
from app.features.intent.keywords.tracked.schemas import (
    Removed,
    RemovedEnvelope,
    TrackedAddListEnvelope,
    TrackedEnvelope,
    TrackedKeywordIn,
    TrackedKeywordsIn,
    TrackedListEnvelope,
)

router = APIRouter(tags=["intent.keywords"], dependencies=[auth.require_surface_gate("project")], responses=ERROR_RESPONSES)

_CONSUMED = frozenset({"project_id", "ids"})
ProjectId = Annotated[uuid.UUID, Query(description="프로젝트")]
IncludeVolume = Annotated[bool, Query(description="최신 월 검색량(latest_month·latest_volume) 포함. false 면 읽지 않고 null(키워드 탭은 id·term 만 쓴다)")]


@router.get("/v1/intent/keywords", summary="추적 키워드 + 최신 월 검색량", response_model=TrackedListEnvelope)
async def get_intent_keywords_0(request: Request, p: CurrentUser, conn: RoConn, project_id: ProjectId,
                                include_volume: IncludeVolume = True) -> TrackedListEnvelope:
    acc = await auth.resolve_project(conn, p, await load_refs(conn), project_id, "member")
    items = await svc.list_keywords(conn, acc.project_id, acc.country_code, include_volume=include_volume)
    return TrackedListEnvelope(data=ListData(items=items), meta=intent_meta(request, mode="crud", consumed=_CONSUMED))


@router.post("/v1/intent/keywords", status_code=201, summary="추적 키워드 추가(중복 409). items[] 본문이면 행별 결과 200",
             response_model=TrackedEnvelope,
             responses={200: {"model": TrackedAddListEnvelope, "description": "items[] 본문: 행별 결과(요청 순서, 행마다 단건과 같은 상태·오류)"}})
async def post_intent_keywords_1(request: Request, p: CurrentUser, conn: RoConn, rw: RwConn, project_id: ProjectId,
                                 body: TrackedKeywordIn | TrackedKeywordsIn) -> TrackedEnvelope | JSONResponse:
    acc = await auth.resolve_project(conn, p, await load_refs(conn), project_id, "operate")
    meta = intent_meta(request, mode="crud", consumed=_CONSUMED)
    if isinstance(body, TrackedKeywordsIn):
        rows = await svc.add_keywords(rw, acc.project_id, acc.country_code, body.items)
        return JSONResponse(status_code=200, content=envelope(ListData(items=rows), meta))
    kw = await svc.add_keyword(rw, acc.project_id, acc.country_code, body.term, body.country)
    return TrackedEnvelope(data=kw, meta=meta)


@router.delete("/v1/intent/keywords", summary="추적 키워드 1~100건 삭제", response_model=RemovedEnvelope)
async def delete_intent_keywords_2(request: Request, p: CurrentUser, conn: RoConn, rw: RwConn, project_id: ProjectId,
                                   ids: Annotated[list[uuid.UUID], Query(min_length=1, max_length=svc.MAX_DELETE)]) -> RemovedEnvelope:
    acc = await auth.resolve_project(conn, p, await load_refs(conn), project_id, "operate")
    n = await svc.remove_keywords(rw, acc.project_id, ids)
    return RemovedEnvelope(data=Removed(removed_count=n), meta=intent_meta(request, mode="crud", consumed=_CONSUMED))
