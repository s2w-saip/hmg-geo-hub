"""analytics.citations.tone 답변 톤별 인용 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES
from app.core.result_cache import CachedRoute, result_cache
from app.features.analytics.citations.tone import service
from app.features.analytics.citations.tone.schemas import ToneData, ToneQuery

router = APIRouter(tags=["analytics.citations"], route_class=CachedRoute)


@router.get("/v1/citations/sources/tone", response_model=Envelope[ToneData], responses=ERROR_RESPONSES,
            summary="톤별 인용 URL·출처 목록(group_by=url|source), 검색 q, 키셋")
@result_cache()
async def get_citations_sources_tone_0(request: Request, conn: RoConn, user: CurrentUser,
                                       params: Annotated[ToneQuery, Query()]) -> Envelope[ToneData]:
    """analytics.citations.tone: C-2 톤 드릴다운(모듈-인용 §2)."""
    return await service.get_tone_rows(conn, user, params, request)
