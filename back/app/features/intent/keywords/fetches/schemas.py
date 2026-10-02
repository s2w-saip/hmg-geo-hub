"""intent.keywords.fetches 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.envelope import Envelope

FetchKind = Literal["insight", "related", "search"]
MAX_TERMS = 20          # 한 요청 terms 상한(모듈-고객-관심 열린 질문 9: 현행 상한 미확인 → 화면 다건 검색 규모로 20)


class FetchIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    project_id: uuid.UUID | None = Field(None, description="프로젝트 화면이면 지정(운영 권한). 없으면 admin·전역 운영자만")
    kind: FetchKind = Field(description="insight = 검색량+SERP, related = 연관어, search = 연관어(seed 포함)")
    terms: list[str] = Field(min_length=1, max_length=MAX_TERMS)
    country: str | None = Field(None, max_length=8, description="ISO2 프리셋 id. project_id 가 있으면 생략 시 프로젝트 국가")
    force: bool = Field(False, description="신선해도 다시 수집")


class FetchAccepted(BaseModel):
    status: Literal["fresh", "queued", "pending"] = Field(description="fresh = 수집 불필요(200), queued = 새 요청(202), pending = 같은 요청이 이미 대기(202)")
    change_id: int | None
    terms: list[str] = Field(description="수집 대상 term(신선한 term 은 빠진다)")
    fresh_terms: list[str]


class FetchStatus(BaseModel):
    change_id: int
    status: Literal["pending", "running", "applied", "failed", "escalated_rebuild"]
    kind: str | None
    country: str | None
    terms: list[str]
    project_id: uuid.UUID | None
    requested_at: datetime
    claimed_at: datetime | None
    applied_at: datetime | None
    error: str | None


FetchAcceptedEnvelope = Envelope[FetchAccepted]
FetchStatusEnvelope = Envelope[FetchStatus]
