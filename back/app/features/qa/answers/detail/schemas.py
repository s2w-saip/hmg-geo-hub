"""qa.answers.detail 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, Field

from app.core.envelope import Ratio
from app.features.qa.answers.list.scope import QaSurface


class QaAnswerHead(BaseModel):
    job_id: uuid.UUID
    surface: QaSurface
    brand: list[str] = Field(description="rd.job.bgrp 비트의 brand_code(app.brand 정렬 순, 카탈로그 밖이면 빈 목록)")
    country: str | None
    engine: str | None
    lang: str | None
    round_date: date
    measured_at: datetime | None
    job_status: str = Field(description="completed|in_progress|failed|other(rd.job.status_code)")
    dropped: bool
    served: bool
    status: str | None = Field(description="Scope 원문 상태(rd.v_answer_body.status). 원문 행이 없으면 null")
    analysis_status: str | None
    model_slug: str | None
    answer_text: str | None
    run_id: uuid.UUID | None = Field(None, description="Scope 실행 id(ing.answer.run_id, 현행 검수 메타 runId granule-tables.tsx:451). 원문 행이 없으면 null")
    region: str | None = Field(None, description="Scope 측정 지역(ing.answer.region, 현행 :454). country(사이트 가상 지역 우선)와 다를 수 있다")
    prompt_run_id: uuid.UUID | None = Field(None, description="Scope prompt_run_id(ing.answer.prompt_run_id). 원문 행이 없으면 null")


class QaPromptCatalog(BaseModel):
    brand: str | None
    brand_presence: str | None
    list_type: str | None
    depth1: str | None
    depth2: str | None
    depth3: str | None
    depth4: str | None
    funnel_stage: str | None
    kind: str | None
    prompt_type: str | None
    category: str | None


class QaPrompt(BaseModel):
    prompt_id: uuid.UUID | None
    text: str | None
    kind: str | None
    lang: str | None
    funnel: str | None = Field(description="rd.dim_taxon(funnel) 코드")
    regions: list[str] | None
    is_korean: bool | None
    catalog: QaPromptCatalog | None = Field(description="표준 루트 카탈로그 표시값(app.prompt). 루트 카탈로그 행이 없으면 null")


class QaMention(BaseModel):
    ord: int
    entity_id: uuid.UUID | None
    display_name: str | None
    entity_type: str | None
    mention_count: int
    avg_position: float | None
    surfaces: list[str] | None
    brand_rollup_entity_id: uuid.UUID | None
    rollup_parent_name: str | None
    registry_role: str | None
    is_own: bool
    is_excluded: bool
    sentiment_positive: int
    sentiment_neutral: int
    sentiment_negative: int
    sentiment_mixed: int
    type_mention: int
    type_recommendation: int
    type_comparison: int
    type_definition: int
    type_final_choice: int


class QaCitation(BaseModel):
    ord: int
    target_key: str = Field(description="노트 대상 키 'job_id:ord'")
    ref_index: int | None
    url: str | None
    title: str | None
    host: str | None
    domain: str | None
    stored_category: str | None = Field(description="Scope 저장 분류(scope_category)")
    override_category: str | None = Field(description="app.citation_domain_override 분류 slug(오버라이드가 없으면 null)")
    effective_category: str | None = Field(description="override ?? stored")
    url_norm: str | None = Field(None, description="정규화 URL(BG-46). 서빙 답변 = rd.dim_url.url_norm, rd.citation 행이 없는 비서빙 job = 원문 url 에 적재기 식(pg_temp.cit_norm) 적용. URL 없음은 null")
    url_base_norm: str | None = Field(None, description="정규화 기준 URL(BG-46). 서빙 답변 = rd.dim_url.url_base_norm, 비서빙 job = 원문 url 에 적재기 식(pg_temp.cit_base_norm) 적용. null 규칙은 url_norm 과 같다")


class QaAcrChoice(BaseModel):
    level: int = Field(description="1 브랜드 2 차종 3 회사")
    entity_id: uuid.UUID | None
    name: str | None
    brand: str | None
    parent_brand: str | None
    entity_type: str | None
    appearance: int
    choice: int
    cond_choice: int
    off_shortlist: int
    unresolved: int
    generic: int
    appearance_rate: Ratio = Field(description="appearance / valid_turn1")
    acr: Ratio = Field(description="choice / valid_acr(정본 acr-iteration-denominator)")
    overall_choice_share: Ratio = Field(description="acr 와 같은 값(정본 정의)")


class QaAcrCell(BaseModel):
    acr_cell_key: int | None = Field(None, description="ACR 셀 식별자(rd.acr_cell.acr_cell_key, BG-46). 셀 단위 노트 키·재조회에 쓴다")
    prompt_run_id: uuid.UUID | None = Field(None, description="그 셀의 Scope prompt_run_id(rd.v_acr_cell_run, DB-v2.9 P63). 현행 ACR 노트 키 "
                                                              "${promptRunId}:${entityId} 와 잇는다. 대응 행이 없으면 null")
    round_date: date
    planned: int
    valid_turn1: int
    valid_acr: int
    co_single: int
    co_conditional: int
    co_generic: int
    co_off_shortlist: int
    co_unresolved: int
    co_none: int
    is_rep: bool
    choices: list[QaAcrChoice]


class QaAnchor(BaseModel):
    anchor: date
    reason: str | None
    source_measured_at: datetime | None


class QaDrop(BaseModel):
    reason: str | None
    dropped_at: datetime | None
    source_measured_at: datetime | None


class QaDerived(BaseModel):
    anchor: QaAnchor | None
    drop: QaDrop | None


class QaAnswerDetail(BaseModel):
    answer: QaAnswerHead
    prompt: QaPrompt
    mentions: list[QaMention]
    citations: list[QaCitation]
    acr: list[QaAcrCell]
    derived: QaDerived
