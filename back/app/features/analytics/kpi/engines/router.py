"""analytics.kpi.engines 엔진별 서브 지표 라우터. 경로는 /v1 접두 포함 전체 경로."""
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES
from app.core.result_cache import CachedRoute, result_cache
from app.features.analytics.kpi.summary.shared import kpi_context, kpi_today

from .schemas import EnginesData, EnginesQuery
from .service import get_engines

router = APIRouter(tags=["analytics.kpi"], route_class=CachedRoute)


@router.get("/v1/kpi/engines", response_model=Envelope[EnginesData], responses=ERROR_RESPONSES,
            summary="엔진별 행(답변·당사 언급·순위·감성·인용 정수)과 total, Core 5 엔진 간 일관성(100 x min / max, 유효 엔진 2개 미만 null). 스냅샷 cycle_offset 0|1")
@result_cache(key_deps={"today": kpi_today})
async def get_kpi_engines_0(
    request: Request,
    p: CurrentUser,
    conn: RoConn,
    q: Annotated[EnginesQuery, Query()],
    today: Annotated[date | None, Depends(kpi_today)] = None,
) -> Envelope[EnginesData]:
    """analytics.kpi.engines: 엔진별 서브 지표(K-3). 명세: README.md, docs/design/api/모듈-KPI.md §2 K-3."""
    ctx = await kpi_context(conn, p, q, request)
    return await get_engines(conn, ctx, part=q.part, cycle_offset=q.cycle_offset, today=today, parts=q.parts)
