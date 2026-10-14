"""projects.project.core 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.filters import PgLine, PgText

MemberRole = Literal["owner", "viewer"]


class Project(BaseModel):
    """프로젝트 1건(일반 설정값 + 내 멤버십 역할). ai_engines = 저장값(NULL = 명시 저장 전), effective_engines = 실제 측정 엔진."""
    project_id: uuid.UUID
    name: str
    description: str | None = None
    domain: str | None = Field(None, description="대표 도메인(가장 먼저 등록된 owned base 의 정규화 값, 읽기 전용)")
    brand_code: str | None = None
    country_code: str
    scope_project_id: uuid.UUID | None = None
    ga4_property_id: str | None = None
    ai_engines: list[str] | None = None
    effective_engines: list[str]
    my_role: MemberRole | None = Field(None, description="세션 사용자의 활성 멤버십 역할(비멤버 열람·admin 은 null)")
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


class ProjectListItem(Project):
    active_member_count: int = 0
    prompt_count: int = Field(0, description="삭제되지 않은 프롬프트 수")
    prompt_in_flight_count: int = Field(0, description="queued·running 프롬프트 수(카드 진행 배지)")


class PromptStatusCounts(BaseModel):
    """삭제되지 않은 프롬프트의 상태별 개수(app.prompt.status 6값, 없는 상태는 0). 현행 project-dashboard.tsx:108 statusCounts."""
    draft: int = 0
    queued: int = 0
    running: int = 0
    done: int = 0
    failed: int = 0
    paused: int = 0


class RecentPrompt(BaseModel):
    """최근 수정 프롬프트 1건(대시보드 '최근 프롬프트' 패널이 쓰는 값만: id·본문·상태·수정 시각)."""
    prompt_id: uuid.UUID
    text: str
    status: str = Field(description="app.prompt.status(draft·queued·running·done·failed·paused)")
    updated_at: datetime


class ProjectDetail(Project):
    effective_engines: list[str] | None = Field(  # type: ignore[assignment]
        description="실제 측정 엔진(ai_engines NULL 이면 기본 엔진). GET /v1/projects/{id}?view=gate 는 기본 엔진을 읽지 않아 null")
    scope_linked: bool = Field(description="scope_project_id 유무(실제 진단은 GET /settings/scope-link, admin)")
    # ── 요약(BG-38, 추가형 선택 필드). GET /v1/projects/{id} 만 채운다(POST·PATCH 응답·view=gate 는 null, view=gate 의 target_brand 는 채운다) ──
    prompt_counts: PromptStatusCounts | None = Field(None, description="삭제되지 않은 프롬프트 상태별 개수(합 = 프롬프트 수)")
    candidate_count: int | None = Field(None, description="프롬프트 후보 수(app.prompt_candidate)")
    active_member_count: int | None = Field(None, description="활성 멤버 수")
    last_run_at: datetime | None = Field(None, description="running·done 프롬프트 updated_at 최대값(현행 lastAi, 없으면 null)")
    target_brand: str | None = Field(None, description="지정 비교 브랜드(추적 경쟁사 is_target 의 brand_name, 없으면 null)")
    recent_prompts: list[RecentPrompt] | None = Field(
        None, description="삭제되지 않은 프롬프트 updated_at 내림차순 상위 5(동률 prompt_id 내림차순, 현행 recentPrompts)")


class ScopeResolution(BaseModel):
    """Scope 프로젝트 id → 로컬 대상(BG-36). kind=project 면 project_id, kind=website 면 brand_code·country_code 만 채운다."""
    kind: Literal["project", "website"]
    project_id: uuid.UUID | None = Field(None, description="kind=project: 이동할 고객 프로젝트")
    brand_code: str | None = Field(None, description="kind=website: 웹사이트 사이트 브랜드(/website?brand=)")
    country_code: str | None = Field(None, description="kind=website: 사이트 국가 코드 원래 표기(/website?geography=, 가상 지역 포함)")


class CreationOptions(BaseModel):
    """프로젝트 생성 폼 선택지(BG-37). POST /v1/projects 검증과 같은 어휘·같은 판정(service.creation_options·engine_vocab)."""
    brands: list[str] = Field(description="고를 수 있는 브랜드 코드(계정 브랜드는 계정 저장 순, 전체면 RHQ 정본에 등장하는 브랜드를 "
                                          "app.brand.sort_order 순). 현행 GEO_BRANDS 순과 다를 수 있어 어댑터가 재정렬")
    countries: list[str] = Field(description="고를 수 있는 국가 코드(허용 브랜드 권역 국가 ∩ 계정 국가). 계정 국가 스코프가 있으면 계정 "
                                             "저장 순, 없으면 코드 순. 현행 권역 정의 순과 다를 수 있어 어댑터가 재정렬")
    engines: list[str] = Field(description="선택 가능 엔진 코드(rd.dim_engine, 카탈로그 순서)")
    default_engines: list[str] = Field(description="폼 기본 선택 엔진(app.rule_param default_engines)")
    brand_locked: bool = Field(description="브랜드 선택 잠금(무제한 스코프 아님 ∧ 브랜드 1개, 현행 new/page.tsx:67)")


class ProjectList(BaseModel):
    items: list[ProjectListItem]
    next_cursor: str | None = None


_NAME = Field(min_length=1, max_length=200)


class ProjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: PgLine = _NAME
    description: PgText | None = Field(None, max_length=2000)
    domain: PgLine | None = Field(None, max_length=2048, description="대표 도메인(선택). http(s) URL 또는 호스트(스킴 없으면 https://). 정규 URL 로 첫 owned base 를 시드한다")
    brand_code: PgLine | None = Field(None, max_length=50)
    country_code: PgLine = Field(min_length=2, max_length=10)
    ai_engines: list[PgLine] = Field(min_length=1, max_length=20)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("이름은 비울 수 없다")
        return v


class ProjectPatch(BaseModel):
    """name·description·brand_code·ga4_property_id 만(domain·ai_engines·country_code 는 extra=forbid 로 422)."""
    model_config = ConfigDict(extra="forbid")
    name: PgLine | None = Field(None, min_length=1, max_length=200)
    description: PgText | None = Field(None, max_length=2000)
    brand_code: PgLine | None = Field(None, max_length=50)
    ga4_property_id: PgLine | None = Field(None, max_length=50, description="ASCII 숫자만(빈 값 = 해제)")


class ProjectDelete(BaseModel):
    model_config = ConfigDict(extra="forbid")
    confirm_name: PgLine = Field(min_length=1, max_length=200)
