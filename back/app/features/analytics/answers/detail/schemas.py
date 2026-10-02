"""analytics.answers.detail 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

응답 형태는 모듈-답변-드릴다운 §3.2 를 따른다. 공개 id = job_id. 내부 정수 키(answer_key·cyc_key·brand_bit·own_bit)는 싣지 않는다
(core.envelope 규칙): 브랜드 행의 당사 여부는 own(bool)만 낸다.
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.codes import Surface

Sentiment = Literal["positive", "negative", "mixed", "neutral"]
EvidenceMatch = Literal["verified", "mismatch", "unavailable"]
_VALUE_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,100}$")


class AnswerDetailQuery(BaseModel):
    """상세 질의. surface 는 검증용(실제 표면과 다르면 404), brand[] 는 global·website 관점 브랜드(스코프 교집합, 접근 범위 불변)."""
    model_config = ConfigDict(extra="ignore")

    surface: Surface | None = Field(None, description="global|website|project. 주면 실제 표면과 같아야 한다(다르면 404)")
    brand: list[str] = Field(default_factory=list, max_length=20,
                             description="관점 브랜드(global·website, project 는 ignored). 당사 배지·밑줄·스탠스 판정 입력(목록과 같은 규칙)")

    @model_validator(mode="after")
    def _check(self) -> AnswerDetailQuery:
        for v in self.brand:
            if not _VALUE_RE.match(v):
                raise ValueError("brand 값 형식 오류")
        return self


class PromptInfo(BaseModel):
    prompt_id: uuid.UUID
    text: str | None = None
    funnel: str | None = None
    kind: str


class CatalogInfo(BaseModel):
    brand: str | None = None
    presence: str | None = None
    list_type: str | None = None
    depth1: str | None = None
    depth2: str | None = None
    depth3: str | None = None


class Header(BaseModel):
    surface: Surface
    cycle_id: uuid.UUID
    round_date: date
    anchor_date: date
    measured_at: datetime | None = None
    engine: str
    country: str | None = None
    lang: str | None = None
    prompt: PromptInfo
    catalog: CatalogInfo | None = None
    analysis_state: int
    gap: bool
    is_acr: bool
    is_rep: bool
    acr_iter_rank: int
    model_slug: str | None = None


class Body(BaseModel):
    available: bool
    answer_text: str | None = None


class BrandMention(BaseModel):
    name: str
    mention_count: int
    rank: int | None = None
    own: bool


class ModelMention(BaseModel):
    name: str
    mention_count: int
    avg_position: float | None = None
    parent_brand: str | None = None


class Mentions(BaseModel):
    brands: list[BrandMention] = Field(default_factory=list)
    models: list[ModelMention] = Field(default_factory=list)


class SentimentEvidence(BaseModel):
    brand_name: str | None = None
    sentiment: Sentiment
    assertion: str | None = None
    descriptors: list[str] = Field(default_factory=list)
    criteria: list[str] = Field(default_factory=list)
    context_snippet: str | None = None


class SentimentSpan(BaseModel):
    start: int = Field(description="코드포인트, 문장 시작")
    end: int = Field(description="코드포인트, 문장 끝(배타)")
    sentiment: Sentiment
    evidence: list[SentimentEvidence]


class SentimentBlock(BaseModel):
    spans: list[SentimentSpan] = Field(default_factory=list)
    skipped: int = 0


class Stance(BaseModel):
    turn_index: int
    entity_id: uuid.UUID
    brand: str
    own: bool
    stance: Sentiment
    confidence: float | None = None
    evidence_text: str | None = None
    evidence_match: EvidenceMatch
    reason: str | None = None


class Citation(BaseModel):
    ord: int
    url: str | None = None
    title: str | None = None
    domain: str | None = None
    category: str | None = Field(None, description="app.citation_category.slug")
    owned: bool
    target_hit: bool


class AnswerDetail(BaseModel):
    id: uuid.UUID = Field(description="job_id")
    header: Header
    body: Body
    mentions: Mentions
    sentiment: SentimentBlock
    stances: list[Stance] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
