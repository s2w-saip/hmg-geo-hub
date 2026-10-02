"""analytics.citations.targets 타겟·자사 URL 인용률 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES
from app.core.filters import CommonFilters, parse_custom_fields, resolve_read_context
from app.core.result_cache import CachedRoute, result_cache

from . import service
from .schemas import TargetsData

router = APIRouter(tags=["analytics.citations"], route_class=CachedRoute)


@router.get("/v1/citations/targets", response_model=Envelope[TargetsData], responses=ERROR_RESPONSES,
            summary="웹사이트 M06·M07(측정 단위 A2), 발행 회차는 rd.report_unit_value 우선(R09) + provenance. core.measure.url_rates 를 K-1 과 공유")
@result_cache()
async def get_citations_targets_0(
    request: Request,
    p: CurrentUser,
    conn: RoConn,
    filters: Annotated[CommonFilters, Query()],
) -> Envelope[TargetsData]:
    """analytics.citations.targets: C-4 타겟·자사 URL 인용률. 명세 README.md·docs/design/api/units/C-4-*.json."""
    service.check_surface(filters.surface)
    custom = parse_custom_fields(request.query_params)       # project 밖 표면에서 주면 ignored_filters 에 'custom' 으로 드러난다
    ctx = await resolve_read_context(conn, p, filters, support=service.SUPPORT, custom_fields=custom)
    win = await service.window_for(ctx, conn)
    return await service.compute_targets(conn, ctx, win)
