"""analytics.funnel.acr AI 선택률(ACR) 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES
from app.core.filters import parse_custom_fields, resolve_read_context
from app.core.result_cache import CachedRoute, result_cache
from app.features.analytics.funnel.acr import service
from app.features.analytics.funnel.acr.schemas import AcrData, AcrParams

router = APIRouter(tags=["analytics.funnel"], route_class=CachedRoute)


@router.get("/v1/funnel/acr", response_model=Envelope[AcrData], responses=ERROR_RESPONSES,
            summary="AI 선택률 화면 전체(총량·브랜드 표·KPI 원천·회차 추이·배틀·차종 전환율·점유 맵·측정 대기 카운트) 한 응답. 스냅샷 = 최신 노출 회차 모든 ACR 셀(A1), 기간 = 게이트 통과 회차(D1). webs")
@result_cache()
async def get_funnel_acr_0(request: Request, params: Annotated[AcrParams, Query()], user: CurrentUser, conn: RoConn) -> Envelope[AcrData]:
    """analytics.funnel.acr: ACR 셀(rd.acr_cell·rd.acr_choice) 6구획 한 응답. 비율은 Ratio(정수 쌍), 퍼센트는 프론트."""
    custom = parse_custom_fields(request.query_params)   # 비프로젝트 표면이면 core 가 custom 을 ignored 로 드러낸다
    ctx = await resolve_read_context(conn, user, params, support=service.SUPPORT, custom_fields=custom)
    return await service.build(conn, ctx, params)
