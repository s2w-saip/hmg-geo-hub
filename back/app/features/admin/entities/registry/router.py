"""admin.entities.registry 엔티티 레지스트리 라우터. 경로는 /v1 접두 포함 전체 경로. admin 전용(AD-2).

GET: surface 필수, from/to(없으면 최신 노출 회차, 366일 이하), q·role·sort, 키셋(세대 바뀌면 409 cursor_stale).
  기본 창은 요청 공용 api_ro, 기간을 주면 admin_long 트랜잭션 하나에서 창 해석·집계(meta.source.pool).
  메뉴 그룹 admin 도 본다(legacy 페이지 게이트 route-policy /admin = group admin 동등, B081). fields=names = 귀속 판정 생략(B088).
PUT: 역할 설정 + judgment_change('entity'). 응답 WriteAccepted(propagation=pending) + 재구축 경고. 쓰기는 legacy 액션처럼 role 만.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request

from app.core.auth import require_admin, require_menu_group
from app.core.codes import Surface
from app.core.db import RoConn
from app.core.envelope import Envelope, build_meta
from app.core.errors import ERROR_RESPONSES
from app.core.filters import PgLine, ignored_axes
from app.core.write import RwConn
from app.features.admin.catalog.prompts.admin_common import clean_text
from app.features.admin.entities.registry import service as svc
from app.features.admin.entities.registry.schemas import EntityList, Role, RoleBody, RoleResult, Sort

router = APIRouter(tags=["admin.entities"], dependencies=[require_admin], responses=ERROR_RESPONSES)


@router.get("/v1/admin/entities",
            summary="Brand 엔티티 목록 + 엔티티별 전 기간 답변·언급 수(운영 listDiscoveredBrands 정의, rd.entity_mention_total) + 유효 귀속 자사 브랜드",
            response_model=Envelope[EntityList], dependencies=[require_menu_group("admin")])
async def get_admin_entities_0(
        request: Request, ro: RoConn,
        surface: Annotated[Surface, Query(description="global|website|project")],
        date_from: Annotated[date | None, Query(alias="from", description="round_date 시작(to 와 쌍)")] = None,
        date_to: Annotated[date | None, Query(alias="to", description="round_date 끝")] = None,
        q: Annotated[PgLine | None, Query(max_length=200, description="이름 부분일치")] = None,
        role: Annotated[Role | None, Query()] = None,
        sort: Annotated[Sort, Query()] = "answers_desc",
        cursor: Annotated[str | None, Query(max_length=4096)] = None,
        limit: Annotated[int | None, Query(description="기본 100, 최대 500")] = None,
        fields: Annotated[Literal["full", "names"], Query(description=(
            "full(기본) = 종전 그대로. names = 이름·유형만 쓰는 호출(검토함 병합 후보)용: 유효 귀속 판정(own_brand)을 하지 않는다(null). "
            "행·순서·이름·유형·역할·수치·커서는 full 과 같다"))] = "full",
) -> Envelope[EntityList]:
    data, win, page, pool = await svc.list_entities(ro, surface=surface, date_from=date_from, date_to=date_to, role=role,
                                                    q_text=clean_text(q, field="q", max_len=200), sort=sort, cursor=cursor, limit=limit,
                                                    own_brand=fields == "full")
    meta = build_meta(mode=win.mode, surface=surface, window=win, page=page, suppressed={},
                      source={"count_grain": "entity_all_time", "count_table": "rd.entity_mention_total", "pool": pool})
    # surface 는 이 엔드포인트의 필수 인자(consumed), from·to 는 기간 축(period 지원). 그 밖의 공통 축은 무시 목록
    meta.ignored_filters = ignored_axes(request.query_params, ("period",), consumed=("surface",))
    return Envelope[EntityList](data=data, meta=meta)


@router.put("/v1/admin/entities/{entity_id}", summary="역할 설정 + judgment_change(entity, {op, old, new}). 전 기간 leaf 재구축 경고",
            response_model=Envelope[RoleResult])
async def put_admin_entities_by_id_1(entity_id: uuid.UUID, body: RoleBody, ro: RoConn, rw: RwConn) -> Envelope[RoleResult]:
    return Envelope[RoleResult](data=await svc.set_role(ro, rw, entity_id, body), meta=build_meta(mode="crud"))
