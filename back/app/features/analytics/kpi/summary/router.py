"""analytics.kpi.summary 요약 카드 라우터. 경로는 /v1 접두 포함 전체 경로."""
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, ListData
from app.core.errors import ERROR_RESPONSES
from app.core.result_cache import CachedRoute, result_cache

from .schemas import SummaryQuery, SummaryResponse, UnmeasuredPrompt, UnmeasuredQuery
from .service import get_summary, get_unmeasured
from .shared import kpi_context, kpi_today

router = APIRouter(tags=["analytics.kpi"], route_class=CachedRoute)


@router.get("/v1/kpi/summary", response_model=SummaryResponse, responses=ERROR_RESPONSES,
            summary="M01~M05 카드 + 웹사이트 M06·M07·인용 정확도 + M12 모수 + A16 결손. 스냅샷(cycle_offset 0|1) 또는 기간 누적(round_date). 분자·분모 정수 쌍(P3), 웹사이트 발행 ")
@result_cache(key_deps={"today": kpi_today})
async def get_kpi_summary_0(
    request: Request,
    p: CurrentUser,
    conn: RoConn,
    q: Annotated[SummaryQuery, Query()],
    today: Annotated[date | None, Depends(kpi_today)] = None,
) -> SummaryResponse:
    """analytics.kpi.summary: 요약 카드(K-1). 명세: README.md, docs/design/api/모듈-KPI.md §2 K-1."""
    ctx = await kpi_context(conn, p, q, request)
    return await get_summary(conn, ctx, cycle_offset=q.cycle_offset, today=today, by_funnel=q.by_funnel, parts=frozenset(q.parts))


@router.get("/v1/kpi/unmeasured-prompts", response_model=Envelope[ListData[UnmeasuredPrompt]], responses=ERROR_RESPONSES,
            summary="측정 개요 카드의 미측정 프롬프트(적용 − 측정, K-1 과 같은 창·필터·술어). 상한 200, meta.page.total = 절단 전 수")
@result_cache(key_deps={"today": kpi_today})
async def get_kpi_unmeasured_prompts_0(
    request: Request,
    p: CurrentUser,
    conn: RoConn,
    q: Annotated[UnmeasuredQuery, Query()],
    today: Annotated[date | None, Depends(kpi_today)] = None,
) -> Envelope[ListData[UnmeasuredPrompt]]:
    """analytics.kpi.summary: 미측정 프롬프트 목록(BG-04). 명세: README.md."""
    ctx = await kpi_context(conn, p, q, request)
    return await get_unmeasured(conn, ctx, cycle_offset=q.cycle_offset, today=today, limit=q.limit, filters=q)
