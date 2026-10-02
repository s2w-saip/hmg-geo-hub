"""KPI 그룹(summary·compare·engines) 공용 조각. 새 규칙을 만들지 않고 core 를 부르는 얇은 층만 둔다.

- 표면 경로 게이트: core.filters.resolve_read_context 가 첫 줄에서 core.auth.require_surface(route-policy 역할 천장 + menu_groups)를 건다.
- 읽기 문맥: core.filters.resolve_read_context(KPI_SUPPORT) + 커스텀 필드(?cf.<id>=, project 표면만 지원 축).
- 기준일(today) 주입: 기본 None = DB rd.today_kst(). 테스트는 app.dependency_overrides 로 고정일을 넣는다.
"""
from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import Request

from app.core.auth import Principal
from app.core.filters import KPI_SUPPORT, CommonFilters, ReadContext, parse_custom_fields, resolve_read_context


def kpi_today() -> date | None:
    """회차 노출 기준일 의존성(None = DB rd.today_kst()). 테스트 전용 교체 지점."""
    return None


async def kpi_context(conn: Any, p: Principal, filters: CommonFilters, request: Request) -> ReadContext:
    """표면 게이트(core) → 스코프 ∩ 요청(KPI_SUPPORT). 스코프가 비면 core 가 403, 프로젝트 비가시 404·project_id 누락 422."""
    custom = parse_custom_fields(request.query_params)
    return await resolve_read_context(conn, p, filters, support=KPI_SUPPORT, custom_fields=custom or None)


def engine_codes(ctx: ReadContext) -> dict[int, str]:
    """engine_key → 엔진 코드(응답에 내부 정수 키를 싣지 않는다)."""
    return {k: code for code, (k, _d) in ctx.refs.engines.items()}
