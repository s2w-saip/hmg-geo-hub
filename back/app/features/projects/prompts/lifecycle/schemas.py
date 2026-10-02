"""projects.prompts.lifecycle 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field


class LifecycleImpact(BaseModel):
    """중지·완전삭제 영향(원시 카운트, 분자·분모 없음). 현행 PromptLifecycleImpact(answers·mentions·citations·sharedRows).
    그레인: answers = served 답변(rd.answer), mentions = 브랜드 언급 행(rd.answer_brand), citations = 인용 원소(rd.citation)."""
    prompt_id: uuid.UUID
    published: bool = Field(description="Scope 에 발행됐는가(scope_prompt_id 있음). 아니면 카운트는 전부 0")
    answers: int
    mentions: int
    citations: int
    shared_rows: int = Field(description="같은 Scope 프롬프트를 쓰는 다른 카탈로그 행 수(0 이 아니면 공유 가드)")


class LifecycleResult(BaseModel):
    prompt_id: uuid.UUID
    status: str
    deleted: bool = False
    shared_rows: int = 0
    propagation: Literal["pending", "none"] = Field(description="pending = Scope 반영 요청을 outbox 에 적재함, none = 로컬만")
    outbox_id: int | None = None
