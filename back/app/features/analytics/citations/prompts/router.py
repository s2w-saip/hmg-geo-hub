"""analytics.citations.prompts 프롬프트별 인용 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES, ErrorBody
from app.core.filters import parse_custom_fields, resolve_read_context
from app.core.result_cache import CachedRoute, result_cache

from . import service
from .schemas import CitationPromptsData, PromptsQuery

router = APIRouter(tags=["analytics.citations"], route_class=CachedRoute)


@router.get("/v1/citations/prompts", response_model=Envelope[CitationPromptsData], responses={**ERROR_RESPONSES, 409: {"model": ErrorBody, "description": "conflict(cursor_stale)"}},
            summary="프롬프트별 인용 owned/uncited 버킷, 버킷 카운트, 행당 답변 참조 8, 검색·키셋(웹사이트 상위 5 분할은 limit=5)")
@result_cache()
async def get_citations_prompts_0(
    request: Request,
    p: CurrentUser,
    conn: RoConn,
    params: Annotated[PromptsQuery, Query()],
) -> Envelope[CitationPromptsData]:
    """analytics.citations.prompts: C-3 프롬프트별 인용(자사/미인용 분할). 명세 README.md·docs/design/api/units/C-3-*.json."""
    qq = service.normalize_q(params.q)                        # 제어 문자 = 422 field q(DB 에 닿기 전)
    custom = parse_custom_fields(request.query_params)       # project 밖 표면에서 주면 ignored_filters 에 'custom' 으로 드러난다
    filters = params.common()
    ctx = await resolve_read_context(conn, p, filters, support=service.SUPPORT, custom_fields=custom)
    req = service.PageRequest(owned=params.owned, q=qq, limit=params.limit, cursor=params.cursor,
                              fh=service.request_hash(filters, params.owned, qq, custom))
    win = await service.window_for(ctx, conn)
    return await service.list_prompts(conn, ctx, win, req)
