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
    """상세 질의. surface 는 검증용(실제 표면과 다르면 404), brand[] 는 global·website 관점 브랜드(스코프 교집합, 접근 범위 불변).

    선택 게이트(project_id·gate_country[]·gate_brand[]): 화면(BFF)이 게이트한 범위로 접근을 더 좁힌다(계정 스코프 ∩, 밖이면 404).
    없으면 종전 동작(계정 스코프·답변 프로젝트 가시성만). 현행 getMirrorAnswerBody 의 IDOR 게이트(run 소속·region·prompt brand)와 같은 범위.
    lite: 답변 모달이 쓰지 않는 값을 계산하지 않는다(기본 거짓 = 종전 응답)."""
    model_config = ConfigDict(extra="ignore")

    surface: Surface | None = Field(None, description="global|website|project. 주면 실제 표면과 같아야 한다(다르면 404)")
    brand: list[str] = Field(default_factory=list, max_length=20,
                             description="관점 브랜드(global·website, project 는 ignored). 당사 배지·밑줄·스탠스 판정 입력(목록과 같은 규칙)")
    project_id: uuid.UUID | None = Field(None, description=(
        "project 표면 선택 게이트: 화면이 게이트한 프로젝트. 답변의 프로젝트와 다르면 404(현행 fetchProjectAnswerBody 의 run 소속 게이트). "
        "없으면 종전(답변 프로젝트의 가시성만). global·website 는 ignored(meta.ignored_filters)"))
    gate_country: list[str] = Field(default_factory=list, max_length=300, description=(
        "global 선택 게이트: 화면 URL 국가(ISO). 답변 국가가 계정 스코프 ∩ 이 목록 밖이면 404(현행 region 게이트, 스코프 밖 값은 버림). "
        "없으면 종전(계정 스코프 국가). website(사이트 국가 리맵은 게이트에 쓰지 않는다)·project 는 쓰지 않는다"))
    gate_brand: list[str] = Field(default_factory=list, max_length=20, description=(
        "global·website 선택 게이트: 화면 URL 브랜드. global = 그 브랜드 카탈로그 행이 있는 프롬프트(현행 prompt brand 게이트), "
        "website = 그 브랜드 사이트(현행 narrowScopeBrands). 계정 스코프 ∩(스코프 밖 값은 버림), 밖이면 404. 없으면 종전. project 는 쓰지 않는다"))
    lite: bool = Field(False, description=(
        "참이면 답변 모달이 쓰지 않는 값을 계산하지 않고 null: header.catalog·cycle_id·anchor_date·model_slug·is_rep·acr_iter_rank, "
        "citations[].owned·target_hit. 거짓(기본) = 종전 응답"))

    @model_validator(mode="after")
    def _check(self) -> AnswerDetailQuery:
        for name in ("brand", "gate_country", "gate_brand"):
            for v in getattr(self, name):
                if not _VALUE_RE.match(v):
                    raise ValueError(f"{name} 값 형식 오류")
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
    cycle_id: uuid.UUID | None = Field(description="lite 면 null")
    round_date: date
    anchor_date: date | None = Field(description="lite 면 null")
    measured_at: datetime | None = None
    engine: str
    country: str | None = None
    lang: str | None = None
    prompt: PromptInfo
    catalog: CatalogInfo | None = Field(None, description="global 만. lite 면 null")
    analysis_state: int
    gap: bool
    is_acr: bool
    is_rep: bool | None = Field(description="lite 면 null")
    acr_iter_rank: int | None = Field(description="lite 면 null")
    model_slug: str | None = Field(None, description="lite 면 null")


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
    owned: bool | None = Field(description="lite 면 null")
    target_hit: bool | None = Field(description="lite 면 null")


class AnswerDetail(BaseModel):
    id: uuid.UUID = Field(description="job_id")
    header: Header
    body: Body
    mentions: Mentions
    sentiment: SentimentBlock
    stances: list[Stance] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
