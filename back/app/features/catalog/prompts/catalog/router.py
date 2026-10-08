"""catalog.prompts.catalog 카탈로그·측정 메타 라우터. 경로는 /v1 접두 포함 전체 경로.

GET /v1/prompts 하나가 세 변형(taxonomy 스텁 3개)을 맡는다: surface=global(키셋 목록) · surface=website(키셋 목록 + 측정 메타) ·
format=csv|xlsx(같은 필터·정렬 전량, 상한 50,000). 표면별 라우트 게이트는 service.check_route.
"""
from typing import Annotated

from fastapi import APIRouter, Query
from fastapi.responses import Response

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, build_meta
from app.core.errors import ERROR_RESPONSES, ErrorBody
from app.features.catalog.prompts.catalog.schemas import CatalogQuery
from app.features.catalog.prompts.catalog.screen import CatalogScreenPage, CatalogScreenQuery, catalog_screen
from app.features.catalog.prompts.catalog.service import CatalogEnvelope, list_catalog

router = APIRouter(tags=["catalog.prompts"])


@router.post("/v1/prompts/screen", response_model=Envelope[CatalogScreenPage], operation_id="readStandardPromptScreen", responses=ERROR_RESPONSES)
async def read_standard_screen(p: CurrentUser, conn: RoConn, body: CatalogScreenQuery) -> Envelope[CatalogScreenPage]:
    return Envelope(data=await catalog_screen(conn, p, body), meta=build_meta(mode="catalog", surface="global"))

_EXPORT_DOC = {
    "description": "format=csv(text/csv, UTF-8 BOM) 또는 format=xlsx. 상한 도달 시 X-Export-Truncated: true",
    "content": {"text/csv": {}, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {}},
}


@router.get(
    "/v1/prompts",
    response_model=CatalogEnvelope,
    responses={**ERROR_RESPONSES, 200: _EXPORT_DOC,
               409: {"model": ErrorBody, "description": "cursor_stale: 집계 정렬(answers·last_measured) 커서의 데이터 세대가 바뀜(첫 페이지부터 다시)"}},
    summary="프롬프트 카탈로그(global 표준 루트 · website 사이트 카탈로그 + 측정 메타), 키셋 페이지, format=csv|xlsx 내보내기",
    operation_id="listPrompts",
)
async def get_prompts(p: CurrentUser, conn: RoConn, q: Annotated[CatalogQuery, Query()]) -> CatalogEnvelope | Response:
    """global: 루트 카탈로그(soft-delete 제외), 스코프 = 브랜드 ∪ 엄브렐러·NULL ∩ 대상 시장(B1), 정렬 depth1·depth2·depth3·text·prompt_id 고정.
    website: 스코프 사이트의 프롬프트 + 측정 메타(answers·last_measured·engines: engine[]·from/to 렌즈, 발행·노출일·숨김 게이트 없는 측정 회차), 정렬 sort·dir.
    목록은 data.items, 다음 페이지는 meta.page.next_cursor, 전체 행 수는 meta.page.total."""
    return await list_catalog(conn, p, q)
