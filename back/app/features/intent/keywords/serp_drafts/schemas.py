"""intent.keywords.serp_drafts 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.envelope import Envelope


class DraftIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: uuid.UUID | None = Field(None, description="프로젝트 화면이면 지정(운영 권한). 없으면 admin·전역 운영자만")
    serp_call_id: int = Field(ge=1, le=2 ** 63 - 1)
    ranks: list[int] | None = Field(None, min_length=1, max_length=10,
                                    description="생략 = 초안 없는 상위 8행을 LLM 1회로, 지정 = 그 행 재생성(gen+1)")


class Draft(BaseModel):
    rank: int
    gen: int
    prompt: str
    model: str | None
    generated_at: datetime


class DraftResult(BaseModel):
    serp_call_id: int
    drafts: list[Draft]
    skipped_count: int = Field(description="대상이었으나 LLM 이 답하지 않았거나 동시 생성과 겹친 행 수")


DraftEnvelope = Envelope[DraftResult]
