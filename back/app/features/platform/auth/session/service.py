"""platform.auth.session 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

세션 응답은 core.auth 의 Principal(계정 원값, vendor operator 정규화 포함)과 DataScope(스코프 계산 정본)를 그대로 옮긴다.
스코프 규칙(admin 전체 스코프, vendor 빈 브랜드 무제한, 권역 → 국가 전개, 미해석 권역 거부)은 전부 DataScope.of 에 있고
여기서는 다시 판정하지 않는다. 이 모듈이 하는 일은 표현(null·빈 배열 의미)뿐이다(무시된 필터 보고는 core.filters.ignored_axes).
menu_groups 는 저장값이 아니라 core.auth.principal_from_row 가 파생한 유효값이다(effective_menu_groups: 현행 lib/auth/menu-groups.ts,
동기화 S1 BE-7). 표면 게이트와 같은 값이라 front 착지(lib/auth/actions.ts apiLanding)·GNB 가 게이트와 어긋나지 않는다.
scope.countries 는 DataScope.countries(Q10) 그대로다: 전용 사이트 계정의 global 국가(DataScope.for_surface('global'))는 싣지 않는다
(front 표시 함수는 account_countries 원값으로 같은 규칙을 계산한다, 어댑터 FA-1).
"""
from __future__ import annotations

from app.core.auth import DataScope, Principal
from app.core.codes import Refs

from .schemas import SessionData, SessionScope

# 이 엔드포인트는 공통 필터를 하나도 지원하지 않는다(단위 명세 filters.supported = []). 들어온 필터 키는 라우터가
# core.envelope.crud_meta(= core.filters.ignored_axes, 지원 축 없음)로 meta.ignored_filters 에 축 이름으로 적는다.


def _opt(values: tuple[str, ...] | None) -> list[str] | None:
    return None if values is None else list(values)


def session_scope(p: Principal, refs: Refs) -> SessionScope:
    s = DataScope.of(p, refs)
    if s.all:
        return SessionScope(all=True, brands=None, regions=None, countries=None)
    return SessionScope(all=False, brands=_opt(s.brands), regions=list(s.regions) or None, countries=_opt(s.countries),
                        account_countries=list(p.scope_countries) or None)


def build_session(p: Principal, refs: Refs) -> SessionData:
    return SessionData(user_id=p.user_id, email=p.email, display_name=p.display_name, role=p.role, operator=p.operator,
                       scope=session_scope(p, refs), menu_groups=list(p.menu_groups or ()) or None,
                       is_qa_reviewer=p.is_qa_reviewer)
