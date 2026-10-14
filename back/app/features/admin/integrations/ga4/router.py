"""admin.integrations.ga4 GA4 속성 라우터. 경로는 /v1 접두 포함 전체 경로.

모든 엔드포인트: 인증 + role=admin + 메뉴 그룹 admin(판정·코드 = require_admin·require_menu_group). 읽기 api_ro, 쓰기 api_rw.
PUT 속성은 verify(외부 호출: GA4 Data API)가 있어 CurrentUserDetached 로 받는다: 게이트는 같은 Detached principal 로(AdminDetached),
읽기는 RoSession(짧은 api_ro), 쓰기 트랜잭션은 호출 뒤에 get_db().write 로 연다. 그 밖은 CurrentUser + 엔드포인트 dependencies 게이트.
공통 필터 축은 없다: 들어오면 meta.ignored_filters(core.envelope.crud_meta).
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Query, Request

from app.core.auth import AdminDetached, CurrentUser, require_admin, require_menu_group
from app.core.db import RoConn, RoSession
from app.core.envelope import Envelope, ListData, Page, build_meta, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.write import RwConn

from . import service
from .adapters import Ga4AccessDep
from .schemas import (
    EventsData,
    EventsPut,
    EventsWritten,
    Ga4Fields,
    Ga4Property,
    MarketDeleted,
    MarketPut,
    MarketWritten,
    PendingMarket,
    ProjectOverrideItem,
    PropertyDeleted,
    PropertyPut,
    PropertyWritten,
    PropStatus,
    WriteReturn,
)

router = APIRouter(tags=["admin.integrations"], responses=ERROR_RESPONSES)
GATE = [require_admin, require_menu_group("admin")]          # 요청 커넥션(CurrentUser → RoConn)을 쓰는 엔드포인트 게이트


PropertyId = Annotated[str, Path(pattern=r"^\d{1,20}$", description="GA4 속성 id(숫자)")]
BrandCode = Annotated[str, Path(min_length=1, max_length=50, description="브랜드 코드(app.brand.brand_code)")]
CountryCode = Annotated[str, Path(pattern=r"^[A-Za-z]{2}$", description="ISO 3166-1 alpha-2(대문자로 맞춘다)")]


@router.get("/v1/admin/ga4/properties", dependencies=GATE, summary="(단위 설계 필요) GA4 속성 목록")
async def get_admin_ga4_properties_0(
    request: Request, p: CurrentUser, conn: RoConn,
    brand_code: Annotated[str | None, Query(max_length=50)] = None,
    country_code: Annotated[str | None, Query(min_length=2, max_length=2)] = None,
    status: Annotated[PropStatus | None, Query()] = None,
    fields: Annotated[Ga4Fields, Query(description="registry = 화면 표 열만(tracked_events·loaded·conv_basis·project_overrides·pending 은 "
                                                   "계산하지 않고 null). 기본 full = 종전")] = "full",
) -> Envelope[ListData[Ga4Property]]:
    """브랜드·국가 순. 추적 이벤트 수·적재 투영 여부·프로젝트 직접 지정·대기 요청을 함께 낸다(fields=registry 면 생략)."""
    items = await service.list_properties(conn, brand=brand_code, country=country_code, status=status, fields=fields)
    return Envelope[ListData[Ga4Property]](data=ListData[Ga4Property](items=items), meta=crud_meta(request.query_params, mode="admin"))


@router.get("/v1/admin/ga4/project-overrides", dependencies=GATE, summary="GA4 속성을 직접 지정한 프로젝트 목록(레지스트리 밖 속성 포함)")
async def get_admin_ga4_project_overrides_5(
    request: Request, p: CurrentUser, conn: RoConn,
    property_id: Annotated[str | None, Query(pattern=r"^\d{1,20}$")] = None,
    registered: Annotated[bool | None, Query(description="true = 레지스트리에 있는 속성만, false = 없는 속성만")] = None,
    cursor: Annotated[str | None, Query(max_length=4096)] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> Envelope[ListData[ProjectOverrideItem]]:
    """app.project.ga4_property_id 가 있는 프로젝트(현행 /admin/ga4 프로젝트 오버라이드 표). 브랜드·국가·레지스트리 등록 여부·속성 상태를 낸다.
    (created_at, project_id) DESC 키셋, 다음 페이지는 meta.page.next_cursor. 공통 필터 축은 없다(meta.ignored_filters)."""
    items, nxt = await service.list_project_overrides(conn, property_id=property_id, registered=registered, cursor=cursor, limit=limit)
    meta = crud_meta(request.query_params, mode="admin", page=Page(next_cursor=nxt, limit=limit))
    return Envelope[ListData[ProjectOverrideItem]](data=ListData[ProjectOverrideItem](items=items), meta=meta)


@router.put("/v1/admin/ga4/properties/{property_id}", summary="(단위 설계 필요) GA4 속성 등록·수정(브랜드·국가 매핑) + judgment_change(ga4_property)")
async def put_admin_ga4_properties_by_id_1(
    p: AdminDetached, open_ro: RoSession, ga4: Ga4AccessDep, property_id: PropertyId, body: PropertyPut,
    ret: Annotated[WriteReturn, Query(alias="return", description="minimal = 응답 property 재조회 생략(null). 기본 full = 종전")] = "full",
) -> Envelope[PropertyWritten]:
    """verify=true 면 GA4 읽기 권한 확인 후 active(실패면 저장 안 함). 같은 브랜드·국가가 다른 속성에 있으면 409 market_taken."""
    data = await service.put_property(open_ro, p, ga4, property_id, body, minimal=ret == "minimal")
    return Envelope[PropertyWritten](data=data, meta=build_meta(mode="admin"))


@router.delete("/v1/admin/ga4/properties/{property_id}", dependencies=GATE, summary="(단위 설계 필요) GA4 속성 삭제")
async def delete_admin_ga4_properties_by_id_2(p: CurrentUser, conn: RwConn, property_id: PropertyId) -> Envelope[PropertyDeleted]:
    """추적 이벤트도 함께 지운다. 프로젝트 직접 지정(app.project.ga4_property_id)은 프로젝트 설정 소관이라 남기고 수만 알린다."""
    return Envelope[PropertyDeleted](data=await service.delete_property(conn, property_id), meta=build_meta(mode="admin"))


@router.get("/v1/admin/ga4/properties/{property_id}/events", dependencies=GATE, summary="(단위 설계 필요) 추적 이벤트 목록")
async def get_admin_ga4_properties_by_id_events_3(p: CurrentUser, conn: RoConn, property_id: PropertyId) -> Envelope[EventsData]:
    """적재된 events 보고서 최근 90일 eventCount ∪ 추적 중 이벤트(추적 우선 → 수 DESC)."""
    d = await service.list_events(conn, property_id)
    return Envelope[EventsData](data=d, meta=build_meta(mode="admin", source={"events": "rd.ga4_row", "window_days": 90}))


@router.put("/v1/admin/ga4/properties/{property_id}/events", dependencies=GATE, summary="(단위 설계 필요) 추적 이벤트 교체 + judgment_change(ga4_tracked_event)")
async def put_admin_ga4_properties_by_id_events_4(p: CurrentUser, conn: RwConn, property_id: PropertyId,
                                                  body: EventsPut) -> Envelope[EventsWritten]:
    """빈 배열 = 추적 해제(key events 폴백). 집합이 그대로면 요청 없이 200(propagation none)."""
    return Envelope[EventsWritten](data=await service.put_events(conn, property_id, body), meta=build_meta(mode="admin"))


# ── 속성 없는 시장(대기, DB-v2.9 P61) ──
@router.get("/v1/admin/ga4/markets", dependencies=GATE, summary="속성 없이 등록한 GA4 시장(브랜드×국가) 목록")
async def get_admin_ga4_markets(
    request: Request, p: CurrentUser, conn: RoConn,
    brand_code: Annotated[str | None, Query(max_length=50)] = None,
    country_code: Annotated[str | None, Query(pattern=r"^[A-Za-z]{2}$")] = None,
) -> Envelope[ListData[PendingMarket]]:
    """브랜드·국가 순. 속성 목록과 합쳐 보이는 것은 프론트 어댑터 몫(현행 /admin/ga4 표의 속성 id 빈 행)."""
    items = await service.list_markets(conn, brand=brand_code, country=country_code)
    return Envelope[ListData[PendingMarket]](data=ListData[PendingMarket](items=items), meta=crud_meta(request.query_params, mode="admin"))


@router.get("/v1/admin/ga4/markets/{brand_code}/{country_code}", dependencies=GATE, summary="대기 시장 단건")
async def get_admin_ga4_market(p: CurrentUser, conn: RoConn, brand_code: BrandCode, country_code: CountryCode) -> Envelope[PendingMarket]:
    return Envelope[PendingMarket](data=await service.get_market(conn, brand_code, country_code), meta=build_meta(mode="admin"))


@router.put("/v1/admin/ga4/markets/{brand_code}/{country_code}", dependencies=GATE, summary="대기 시장 등록·수정(속성 id 없이 브랜드×국가)")
async def put_admin_ga4_market(p: CurrentUser, conn: RwConn, brand_code: BrandCode, country_code: CountryCode,
                               body: MarketPut) -> Envelope[MarketWritten]:
    """멱등. 같은 시장에 속성이 매핑돼 있으면 409 market_taken(details.property_id), 알 수 없는 브랜드 422 unknown_brand.
    나중에 속성을 이 시장에 매핑하면(PUT properties/{id}) 대기 행은 같은 트랜잭션에서 지워진다."""
    return Envelope[MarketWritten](data=await service.put_market(conn, brand_code, country_code, body), meta=build_meta(mode="admin"))


@router.delete("/v1/admin/ga4/markets/{brand_code}/{country_code}", dependencies=GATE, summary="대기 시장 삭제")
async def delete_admin_ga4_market(p: CurrentUser, conn: RwConn, brand_code: BrandCode, country_code: CountryCode) -> Envelope[MarketDeleted]:
    return Envelope[MarketDeleted](data=await service.delete_market(conn, brand_code, country_code), meta=build_meta(mode="admin"))
