"""admin.cycles.cycles 회차 숨김·마감·노출일 라우터. 경로는 /v1 접두 포함 전체 경로.

모든 엔드포인트: 인증 + role=admin + 메뉴 그룹 admin. 목록·대상 확인은 api_ro, 상세 진행률은 admin_long, 요청 기록은 api_rw.
쓰기 응답: 요청을 남기면 202(비동기 반영), dry_run 이면 200.
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Query, Request, Response

from app.core.auth import CurrentUser, require_admin, require_menu_group
from app.core.db import AdminLongConn, RoConn
from app.core.envelope import Envelope, ListData, build_meta
from app.core.errors import ERROR_RESPONSES
from app.core.filters import parse_custom_fields
from app.core.write import RwConn

from . import service
from .schemas import CloseBody, CycleDetail, CycleItem, CycleListQuery, CycleRequestResult, HideBody, UnhideBody, ViewDateBody

router = APIRouter(tags=["admin.cycles"], dependencies=[require_admin, require_menu_group("admin")], responses=ERROR_RESPONSES)

CycleRef = Annotated[str, Path(min_length=1, max_length=64, description="cycle_id(uuid). 운영 호환으로 정수 cyc_key 도 받는다")]


def _written(res: CycleRequestResult, response: Response) -> Envelope[CycleRequestResult]:
    response.status_code = 200 if res.dry_run else 202
    return Envelope[CycleRequestResult](data=res, meta=build_meta(mode="admin", surface=None))


@router.get("/v1/admin/cycles", summary="회차 원장 목록(rd.cycle 상태·servable·view_date·hidden_scope·hidden_reason(제안)·generation + 대기 요청), 기본 최근 26주")
async def get_admin_cycles_0(request: Request, p: CurrentUser, conn: RoConn,
                             q: Annotated[CycleListQuery, Query()]) -> Envelope[ListData[CycleItem]]:
    """surface 필수, project_id(프로젝트 또는 웹사이트 사이트) 선택, from/to(round_date) 선택. 그 밖의 공통 필터 축은 meta.ignored_filters."""
    parse_custom_fields(request.query_params)            # cf 키 형식만 검사(분석 읽기와 같은 422). 값은 쓰지 않는다(ignored custom)
    items, meta = await service.list_cycles(conn, q, query_params=request.query_params)
    return Envelope[ListData[CycleItem]](data=ListData[CycleItem](items=items), meta=meta)


@router.get("/v1/admin/cycles/{cyc_key}", summary="회차 상세 + 진행률(rd.job status·dropped·served 분포, rd.answer gap 수 조회 시 계산). 기대 유닛 분모 미제공(D8 ③)")
async def get_admin_cycles_by_id_1(p: CurrentUser, conn: RoConn, long_conn: AdminLongConn, cyc_key: CycleRef) -> Envelope[CycleDetail]:
    """진행률 분모는 Q2 개정으로 rd.cycle 카운터(expected_units 등)를 함께 낸다."""
    d = await service.get_cycle(conn, long_conn, cyc_key)
    return Envelope[CycleDetail](data=d, meta=build_meta(mode="admin", surface=d.surface, generation=d.generation))


@router.post("/v1/admin/cycles/{cyc_key}/hide", status_code=202, summary="숨김 요청 judgment_change(cycle_admin), dry_run")
async def post_admin_cycles_by_id_hide_2(p: CurrentUser, conn: RoConn, rw: RwConn, cyc_key: CycleRef, body: HideBody,
                                         response: Response) -> Envelope[CycleRequestResult]:
    return _written(await service.hide(conn, rw, cyc_key, body), response)


@router.post("/v1/admin/cycles/{cyc_key}/unhide", status_code=202, summary="숨김 해제 요청")
async def post_admin_cycles_by_id_unhide_3(p: CurrentUser, conn: RoConn, rw: RwConn, cyc_key: CycleRef, body: UnhideBody,
                                           response: Response) -> Envelope[CycleRequestResult]:
    return _written(await service.unhide(conn, rw, cyc_key, body), response)


@router.post("/v1/admin/cycles/{cyc_key}/close", status_code=202, summary="운영자 마감 요청, dry_run")
async def post_admin_cycles_by_id_close_4(p: CurrentUser, conn: RoConn, rw: RwConn, cyc_key: CycleRef, body: CloseBody,
                                          response: Response) -> Envelope[CycleRequestResult]:
    return _written(await service.close(conn, rw, cyc_key, body), response)


@router.put("/v1/admin/cycles/{cyc_key}/view-date", status_code=202, summary="노출일 설정 요청, dry_run")
async def put_admin_cycles_by_id_view_date_5(p: CurrentUser, conn: RoConn, rw: RwConn, cyc_key: CycleRef, body: ViewDateBody,
                                             response: Response) -> Envelope[CycleRequestResult]:
    return _written(await service.set_view_date(conn, rw, cyc_key, body), response)
