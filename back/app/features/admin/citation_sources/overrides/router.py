"""admin.citation_sources.overrides 도메인 카테고리 오버라이드 라우터. 경로는 /v1 접두 포함 전체 경로.

모든 엔드포인트: 인증(CurrentUser) + role=admin + 메뉴 그룹 admin. 읽기는 api_ro(후보의 긴 창만 admin_long), 쓰기는 api_rw(RwConn).
정적 경로(/candidates·/categories)를 파라미터 경로(/{domain})보다 먼저 선언한다.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Query, Request

from app.core.auth import CurrentUser, require_admin, require_menu_group
from app.core.db import RoConn
from app.core.envelope import Envelope, ListData, Page, build_meta, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.write import RwConn

from . import service
from .schemas import CandidateItem, CandidateQuery, CategoryItem, OverrideCleared, OverrideItem, OverridePut, OverrideWritten

router = APIRouter(tags=["admin.citation_sources"], dependencies=[require_admin, require_menu_group("admin")],
                   responses=ERROR_RESPONSES)

DomainPath = Annotated[str, Path(min_length=1, max_length=260, description="호스트 도메인(소문자·www. 제거로 정규화)")]


@router.get("/v1/admin/citation-overrides", summary="오버라이드 목록 키셋")
async def get_admin_citation_overrides_0(
    request: Request, p: CurrentUser, conn: RoConn,
    cursor: Annotated[str | None, Query(max_length=4096)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> Envelope[ListData[OverrideItem]]:
    """(updated_at, domain) DESC 키셋. 다음 페이지는 meta.page.next_cursor. 공통 필터 축은 지원하지 않는다(들어오면 meta.ignored_filters)."""
    items, nxt = await service.list_overrides(conn, cursor=cursor, limit=limit)
    meta = crud_meta(request.query_params, mode="admin", page=Page(next_cursor=nxt, limit=limit))
    return Envelope[ListData[OverrideItem]](data=ListData[OverrideItem](items=items), meta=meta)


@router.get("/v1/admin/citation-overrides/candidates",
            summary="기간 내 인용 상위 도메인 + 현재 분류(기간 필수, admin_long, limit 500)")
async def get_admin_citation_overrides_candidates_1(
    request: Request, p: CurrentUser, conn: RoConn, filters: Annotated[CandidateQuery, Query()],
) -> Envelope[ListData[CandidateItem]]:
    """surface 필수, from/to 기본 = 최신 노출 회차(최대 366일). 카테고리 좁히기는 공통 필터 source[](slug). limit 기본 500."""
    items, meta = await service.list_candidates(conn, p, filters, limit=filters.limit, query_params=request.query_params)
    return Envelope[ListData[CandidateItem]](data=ListData[CandidateItem](items=items), meta=meta)


@router.get("/v1/admin/citation-overrides/categories", summary="app.citation_category 전체")
async def get_admin_citation_overrides_categories_2(p: CurrentUser, conn: RoConn) -> Envelope[ListData[CategoryItem]]:
    return Envelope[ListData[CategoryItem]](data=ListData[CategoryItem](items=await service.list_categories(conn)),
                                            meta=build_meta(mode="admin"))


@router.put("/v1/admin/citation-overrides/{domain}", summary="도메인 분류 교정 + judgment_change(citation_override)")
async def put_admin_citation_overrides_by_id_3(p: CurrentUser, conn: RwConn, domain: DomainPath,
                                               body: OverridePut) -> Envelope[OverrideWritten]:
    """upsert. 분류가 바뀌면 같은 트랜잭션에서 재판정 요청(비동기 반영: propagation pending). 같은 도메인 대기 요청이 있으면 409."""
    return Envelope[OverrideWritten](data=await service.put_override(conn, domain, body), meta=build_meta(mode="admin"))


@router.delete("/v1/admin/citation-overrides/{domain}", summary="오버라이드 삭제 + judgment_change")
async def delete_admin_citation_overrides_by_id_4(p: CurrentUser, conn: RwConn, domain: DomainPath) -> Envelope[OverrideCleared]:
    """삭제 = 기본 분류(owned·seed·rule·fallback)로 원복 요청. 없으면 404."""
    return Envelope[OverrideCleared](data=await service.delete_override(conn, domain), meta=build_meta(mode="admin"))
