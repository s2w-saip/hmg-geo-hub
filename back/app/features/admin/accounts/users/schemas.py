"""admin.accounts.users 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Role = Literal["hq", "region", "country", "admin", "vendor", "website"]
Operator = Literal["none", "assigned", "global"]
MenuGroup = Literal["standard", "website", "project", "admin"]
Status = Literal["active", "suspended"]

# 역할이 허용하는 메뉴 그룹(현행 route-policy.ts ROUTES 의 roles × group). menu_groups 는 이 집합 안에서만 좁힐 수 있다(groupAllowed).
ROLE_GROUPS: dict[str, frozenset[str]] = {
    "hq": frozenset({"standard", "website", "project"}),
    "region": frozenset({"standard", "website", "project"}),
    "country": frozenset({"standard", "website", "project"}),
    "admin": frozenset({"standard", "website", "project", "admin"}),
    "vendor": frozenset({"project"}),
    "website": frozenset({"website"}),
}
_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")        # 현행 admin/_actions.ts EMAIL_RE
_CODE = re.compile(r"^[^\x00-\x1f\x7f]{1,100}$")


def _codes(v: list[str]) -> list[str]:
    out = []
    for x in v:
        s = x.strip()
        if not _CODE.match(s):
            raise ValueError("스코프 값 형식 오류")
        out.append(s)
    return list(dict.fromkeys(out))


class UserItem(BaseModel):
    user_id: uuid.UUID
    email: str
    display_name: str | None = None
    role: Role
    operator: Operator
    scope_all: bool
    scope_brands: list[str]
    scope_regions: list[str]
    scope_countries: list[str]
    menu_groups: list[MenuGroup] | None = Field(None, description="null = 제한 없음(역할이 천장)")
    is_qa_reviewer: bool
    status: Status
    row_version: int = Field(description="낙관적 잠금 값. PATCH 의 If-Match 로 보낸다")
    last_sign_in_at: datetime | None = Field(None, description="Supabase Auth 최근 로그인(조회 실패면 null + meta.suppressed)")
    created_at: datetime
    updated_at: datetime


class _ScopeFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("scope_brands", "scope_regions", "scope_countries", check_fields=False)
    @classmethod
    def _v(cls, v: list[str] | None) -> list[str] | None:
        return None if v is None else _codes(v)

    @field_validator("scope_countries", check_fields=False)
    @classmethod
    def _upper(cls, v: list[str] | None) -> list[str] | None:
        return None if v is None else [x.upper() for x in v]

    @field_validator("display_name", check_fields=False)
    @classmethod
    def _dn(cls, v: str | None) -> str | None:
        return v.strip() or None if v is not None else None


class UserCreate(_ScopeFields):
    email: str = Field(min_length=3, max_length=320)
    display_name: str | None = Field(None, max_length=200)
    role: Role
    operator: Operator = "none"
    scope_all: bool = False
    scope_brands: list[str] = Field(default_factory=list, max_length=20)
    scope_regions: list[str] = Field(default_factory=list, max_length=100)
    scope_countries: list[str] = Field(default_factory=list, max_length=300)
    menu_groups: list[MenuGroup] | None = Field(None, min_length=1, max_length=4)
    is_qa_reviewer: bool = False

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        e = v.strip().lower()
        if not _EMAIL.match(e):
            raise ValueError("이메일 형식 오류")
        return e


class UserPatch(_ScopeFields):
    """준 필드만 바꾼다(model_fields_set). menu_groups 에 null 을 주면 제한 해제."""
    display_name: str | None = Field(None, max_length=200)
    role: Role | None = None
    operator: Operator | None = None
    scope_all: bool | None = None
    scope_brands: list[str] | None = Field(None, max_length=20)
    scope_regions: list[str] | None = Field(None, max_length=100)
    scope_countries: list[str] | None = Field(None, max_length=300)
    menu_groups: list[MenuGroup] | None = Field(None, min_length=1, max_length=4)
    is_qa_reviewer: bool | None = None
    status: Status | None = None


class UserCreated(UserItem):
    temp_password: str = Field(description="임시 비밀번호: 이 응답에만 한 번 싣고 저장·로그하지 않는다")


class UserDeleted(BaseModel):
    user_id: uuid.UUID
    deleted: bool = True
    succeeded_projects: list[uuid.UUID] = Field(default_factory=list, description="Owner 가 사라져 요청 관리자가 승계한 프로젝트")


class AuditItem(BaseModel):
    audit_id: int
    change_type: Literal["create", "update", "delete"]
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    actor_id: uuid.UUID
    actor_email: str | None = None
    created_at: datetime
