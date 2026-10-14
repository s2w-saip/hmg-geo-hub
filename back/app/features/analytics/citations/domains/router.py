"""analytics.citations.domains 인용 도메인 순위 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES, ErrorBody
from app.core.result_cache import CachedRoute, result_cache
from app.features.analytics.citations.domains import service
from app.features.analytics.citations.domains.schemas import DomainsData, DomainsExportQuery, DomainsQuery

router = APIRouter(tags=["analytics.citations"], route_class=CachedRoute)


@router.get("/v1/citations/domains", response_model=Envelope[DomainsData],
            responses={**ERROR_RESPONSES, 409: {"model": ErrorBody, "description": "conflict(cursor_stale)"}},
            summary="출처(source_key: 도메인·공식 소셜 계정) 인용 순위 + 요약(M05, 고유 출처 수) + 경쟁사 브랜드별 인용 합. limit=0 이면 요약·경쟁사 합만(대시보드 경쟁사 행). mention_brand 로 언급 드릴다운 인용 탭 대체(limit 2,000 까지 한 번 조회). q·sort·dir·skey[](BG-20·21), competitor_sources(BG-20), include_den·include_competitor_totals(읽지 않는 계산 끄기)")
@result_cache()
async def get_citations_domains_0(request: Request, conn: RoConn, user: CurrentUser,
                                  params: Annotated[DomainsQuery, Query()]) -> Envelope[DomainsData]:
    """analytics.citations.domains: C-1 도메인 순위(모듈-인용 §2)."""
    return await service.get_domains(conn, user, params, request)


# 도메인 드릴다운 /v1/citations/domains/{skey:path} 보다 먼저 등록돼야 한다(같은 접두의 path 변환기). 기능 레지스트리 순서가
# domains → domain_detail 이라 이 경로가 먼저 걸린다(회귀: tests/test_domains_bg.py test_export_route_not_detail).
@router.get("/v1/citations/domains/export", response_class=StreamingResponse, responses=ERROR_RESPONSES,
            summary="BG-22 인용 도메인 순위 내보내기(xlsx|csv): 목록과 같은 필터·검색·정렬·선택, 전량(상한 5,000행, 넘으면 X-Export-Truncated)")
async def get_citations_domains_export_1(request: Request, conn: RoConn, user: CurrentUser,
                                         params: Annotated[DomainsExportQuery, Query()]) -> StreamingResponse:
    """analytics.citations.domains: BG-22 도메인 순위 파일(현행 onExport 7열)."""
    return await service.export_domains(conn, user, params, request)
