"""platform.auth.session 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

스코프 값의 뜻(프론트 GNB·SNB·필터 드롭다운이 그대로 쓴다)
- null = 그 축에 제약 없음. 빈 배열 [] = 그 축 전부 거부(default-deny: 이 계정의 글로벌·웹사이트 읽기는 403).
- brands   : 유효 브랜드(엄브렐러 제외). admin·scope_all 은 null, 브랜드 스코프가 빈 vendor 도 null(추가 결정 2026-09-28).
- regions  : 계정 권역 id 원값. scope_all 이거나 권역이 없으면 null(권역 자체는 거부 축이 아니다. 국가로 전개돼 countries 에 반영).
- countries: Q10 effectiveScopeCountries 하나(직접 국가 우선, 없으면 권역 전개, 둘 다 없으면 null).
"""
from __future__ import annotations

import uuid

from pydantic import BaseModel, Field

# 역할·운영자·메뉴 그룹 값 집합의 정본은 core.auth(= DB enum app.user_role·operator_scope·menu_group). 여기서 재정의하지 않는다(검증 D1).
from app.core.auth import MenuGroup, Operator, Role

__all__ = ["MenuGroup", "Operator", "Role", "SessionData", "SessionScope"]


class SessionScope(BaseModel):
    all: bool = Field(description="전체 스코프(scope_all 또는 admin, Q16). 참이면 나머지 축은 전부 null")
    brands: list[str] | None = Field(description="유효 브랜드 코드(엄브렐러 제외). null=제한 없음, []=거부")
    regions: list[str] | None = Field(description="계정 권역 id. null=권역 제한 없음")
    countries: list[str] | None = Field(description="유효 국가 ISO(Q10: 직접 국가 우선, 없으면 권역 전개). null=제한 없음, []=거부")
    account_countries: list[str] | None = Field(None, description=(
        "계정 원값 국가(app.user_account.scope_countries, 저장 표기 그대로: 가상 지오 코드 SA-Riyadh·worldwide 등 포함, 권역 전개 없음). "
        "null=원값 없음(전체 스코프이거나 국가를 직접 주지 않은 계정). 현행 front AllowedScope.countries 와 같은 값(fe-u2 요청 1). "
        "데이터 경계는 countries(서버 DataScope)가 정본이다"))


class SessionData(BaseModel):
    user_id: uuid.UUID
    email: str
    display_name: str | None = None
    role: Role
    operator: Operator = Field(description="비용 액션 권한. vendor 는 항상 none(DB CHECK 와 이중 방어)")
    scope: SessionScope
    menu_groups: list[MenuGroup] | None = Field(description="메뉴 그룹 화이트리스트(좁히기 전용). null=role 기본값 그대로. "
                                                        "빈 배열은 내지 않는다(DB CHECK ua_menu_nonempty, 응답에서도 null 로 정규화: fe-u2 요청 5)")
    is_qa_reviewer: bool
