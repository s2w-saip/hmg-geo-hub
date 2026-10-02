"""analytics.funnel.conversion AI 유입·전환(GA4) 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.filters import parse_custom_fields, resolve_read_context
from app.features.admin.integrations.ga4.schemas import EventsPut
from app.features.analytics.funnel.conversion import service
from app.features.analytics.funnel.conversion.schemas import (
    ConversionData,
    ConversionEventsData,
    ConversionEventsParams,
    ConversionEventsWritten,
    ConversionParams,
)

router = APIRouter(tags=["analytics.funnel"])
_EVENTS_CONSUMED = ("property_id", "project_id", "surface")   # 전환 이벤트 경로가 자기 파라미터로 쓰는 쿼리(공통 필터 축으로 세지 않는다)


@router.get("/v1/funnel/conversion", response_model=Envelope[ConversionData], responses=ERROR_RESPONSES,
            summary="GA4 AI 유입·전환(요약·일별 추이·엔진별·페이지별·국가별·커버리지 data.coverage). 분모 = 세션(G-12 a), 분자 = report 3 is_conv(conv_basis 제안). view=summ")
async def get_funnel_conversion_0(request: Request, params: Annotated[ConversionParams, Query()], user: CurrentUser,
                                  conn: RoConn) -> Envelope[ConversionData]:
    """analytics.funnel.conversion: 적재된 GA4 행(rd.ga4_row)만 읽는다(실시간 GA4 호출 없음). 비율은 Ratio(정수 쌍).
    project 표면은 활성 멤버·admin 만(현행 프로젝트 화면 게이트, BG-28)."""
    custom = parse_custom_fields(request.query_params)   # GA4 에 커스텀 필드 축은 없다: core 가 ignored 로 드러낸다
    ctx = await resolve_read_context(conn, user, params, support=service.SUPPORT, custom_fields=custom, project_level="active_member")
    return await service.build(conn, ctx, params)


@router.get("/v1/funnel/conversion/events", response_model=Envelope[ConversionEventsData], responses=ERROR_RESPONSES,
            summary="전환 이벤트 목록(비관리자 경로, BG-29): 적재된 events 보고서 최근 90일 eventCount ∪ 추적 이벤트. 표면 게이트 + 속성 소속 검증")
async def get_funnel_conversion_events_1(request: Request, params: Annotated[ConversionEventsParams, Query()], user: CurrentUser,
                                         conn: RoConn) -> Envelope[ConversionEventsData]:
    """프로젝트 맥락(project_id) = 활성 멤버 ∧ 그 프로젝트가 해석하는 속성, 그 밖 = 계정 스코프 시장이 해석하는 속성. 밖이면 404."""
    d = await service.list_events(conn, user, params)
    return Envelope[ConversionEventsData](data=d, meta=crud_meta(request.query_params, mode="crud", surface=params.effective_surface,
                                                                   source={"events": "rd.ga4_row", "window_days": 90},
                                                                   consumed=_EVENTS_CONSUMED))


@router.put("/v1/funnel/conversion/events", response_model=Envelope[ConversionEventsWritten], responses=ERROR_RESPONSES,
            summary="전환 이벤트 교체(비관리자 경로, BG-29) + judgment_change(ga4_tracked_event). 편집 = admin·프로젝트 Owner·역할 country·region·hq")
async def put_funnel_conversion_events_2(request: Request, params: Annotated[ConversionEventsParams, Query()], body: EventsPut,
                                         user: CurrentUser, conn: RoConn) -> Envelope[ConversionEventsWritten]:
    """권한 판정은 읽기 트랜잭션, 교체는 api_rw 쓰기 트랜잭션(admin 경로와 같은 본체). 레지스트리 밖 속성은 404."""
    w = await service.put_events(conn, user, params, body)
    return Envelope[ConversionEventsWritten](data=w, meta=crud_meta(request.query_params, mode="crud", surface=params.effective_surface,
                                                                     consumed=_EVENTS_CONSUMED))
