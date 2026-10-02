"""admin.catalog.reference 택소노미·시장 라우터. 경로는 /v1 접두 포함 전체 경로. admin 전용, api_ro.

공통 필터 축은 전부 지원하지 않는다: 들어오면 core.envelope.crud_meta 가 meta.ignored_filters 에 적는다."""
from __future__ import annotations

from fastapi import APIRouter, Request

from app.core.auth import require_admin, require_menu_group
from app.core.db import RoConn
from app.core.envelope import Envelope, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.features.admin.catalog.reference import service as svc
from app.features.admin.catalog.reference.schemas import MarketData, TaxonomyData

router = APIRouter(tags=["admin.catalog"], dependencies=[require_admin, require_menu_group("admin")],
                   responses=ERROR_RESPONSES)


@router.get("/v1/admin/catalog/taxonomy", summary="택소노미 캐스케이딩 옵션(depth4 포함)", response_model=Envelope[TaxonomyData])
async def get_admin_catalog_taxonomy_0(request: Request, ro: RoConn) -> Envelope[TaxonomyData]:
    return Envelope[TaxonomyData](data=await svc.taxonomy(ro), meta=crud_meta(request.query_params, mode="catalog"))


@router.get("/v1/admin/catalog/markets", summary="시장 어휘(rd.dim_project.regions), Scope 직접 호출 금지", response_model=Envelope[MarketData])
async def get_admin_catalog_markets_1(request: Request, ro: RoConn) -> Envelope[MarketData]:
    meta = crud_meta(request.query_params, mode="catalog", source={"regions": "rd.dim_project.regions"})
    return Envelope[MarketData](data=await svc.markets(ro), meta=meta)
