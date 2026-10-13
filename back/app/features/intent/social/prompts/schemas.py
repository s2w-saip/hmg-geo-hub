"""intent.social.prompts 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.envelope import Envelope, ListData


class SimilarTo(BaseModel):
    text: str
    score: float = Field(description="문자 bigram 코사인 0~1(임계 0.5, 조회 시 계산, 저장 안 함)")
    kind: Literal["prompt", "candidate"]


class GeneratedPrompt(BaseModel):
    prompt_id: uuid.UUID
    seed_key: str
    question: str
    layer: Literal["L1-context", "L2-condition", "L3-intersection"] | None
    funnel_stage: str | None
    source_label: str | None
    priority: int | None
    origin: Literal["composed"] | None = Field(description="composed = 구성 생성, null = 자동 배치")
    batch_no: int
    model: str | None
    generated_at: datetime
    similar_to: SimilarTo | None
    in_candidate_pool: bool = Field(description="question 과 같은 텍스트가 프로젝트 후보 풀(app.prompt_candidate)에 있음(조회 시 계산, 저장 안 함). "
                                                "화면 '이미 추가됨' 판정 — 프런트가 후보 풀 전체를 읽지 않게 한다")


class ComboPick(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cond_a_id: uuid.UUID
    cond_b_id: uuid.UUID


class Selection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    context_ids: list[uuid.UUID] = Field(default_factory=list, max_length=50)
    condition_ids: list[uuid.UUID] = Field(default_factory=list, max_length=50)
    combinations: list[ComboPick] = Field(default_factory=list, max_length=50)
    cross: bool = Field(False, description="고른 맥락 × 조건 교차 시드(최대 12)")


class GenerateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["more", "selected"] = Field(description="more = 코퍼스 상위 시드 다음 배치, selected = 사용자가 고른 행")
    selection: Selection | None = None


class GenerateOut(BaseModel):
    prompts: list[GeneratedPrompt]
    exhausted: bool = Field(description="more: 남은 시드가 없음")
    skipped_existing: int = Field(description="이미 생성된 시드(동시 생성과 겹친 행 포함)")


class Removed(BaseModel):
    removed_count: int


PromptListEnvelope = Envelope[ListData[GeneratedPrompt]]
GenerateEnvelope = Envelope[GenerateOut]
RemovedEnvelope = Envelope[Removed]
