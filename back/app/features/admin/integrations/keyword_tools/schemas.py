"""admin.integrations.keyword_tools 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Freshness = Literal["fresh", "stale", "missing"]
SearchIntent = Literal["informational", "navigational", "transactional", "commercial"]


class _Loc(BaseModel):
    model_config = ConfigDict(extra="forbid")
    country: str | None = Field(None, min_length=2, max_length=2, description="지역 프리셋 id(kr·us 등). location_code 보다 우선")
    location_code: int | None = Field(None, ge=1, le=99999999, description="DataForSEO location_code(프리셋에 있는 값만)")
    language_code: str | None = Field(None, min_length=2, max_length=10, description="생략 시 프리셋 언어")
    force: bool = Field(False, description="신선해도 다시 수집 요청")


class VolumeBody(_Loc):
    keywords: list[str] = Field(min_length=1, max_length=1000)


class PromptToVolumeBody(_Loc):
    prompt_text: str = Field(min_length=1, max_length=4000)


class ToPromptBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    keywords: list[str] = Field(min_length=1, max_length=500, description="키워드 또는 '[kw1,kw2]-제목 - 설명' 행")
    keyword_volume_map: dict[str, int] | None = Field(None, max_length=5000)
    max_questions: int = Field(100, ge=1, le=500)


class MonthlyVolume(BaseModel):
    month: date
    search_volume: int | None = None


class VolumeItem(BaseModel):
    keyword: str
    term_norm: str
    search_volume: int | None = None
    competition_index: int | None = None
    competition: Literal["LOW", "MEDIUM", "HIGH"] | None = Field(None, description="DataForSEO competition 라벨(최신 월 행, BG-40, 현행 "
                                                                                  "keyword-tools 경쟁도 배지·CSV). 적재 전 행·세 값 밖은 null")
    cpc: float | None = None
    month: date | None = Field(None, description="최신 월")
    monthly_searches: list[MonthlyVolume] = Field(default_factory=list, description="최근 12개월(최신 먼저)")
    observed_at: datetime | None = None
    freshness: Freshness


class FetchState(BaseModel):
    status: Literal["fresh", "queued", "pending"] = Field(description="fresh = 수집 불필요, queued = 새 요청, pending = 같은 요청 대기 중")
    change_id: int | None = None
    terms: list[str] = Field(default_factory=list, description="수집 요청 대상 term_norm(queued 면 새 요청에 실린 것만)")
    pending_terms: list[str] = Field(default_factory=list, description="이미 대기·진행 중인 다른 요청이 가진 term(새 요청에서 뺐다)")
    pending_change_ids: list[int] = Field(default_factory=list, description="pending_terms 를 가진 대기·진행 중 요청")


class Summary(BaseModel):
    requested: int
    found: int
    total_search_volume: int
    avg_search_volume: int | None = None


class VolumeData(BaseModel):
    location_code: int
    language_code: str
    keywords: list[VolumeItem]
    missing: list[str]
    summary: Summary
    fetch: FetchState


class Question(BaseModel):
    original_input: str
    question: str
    search_intent: SearchIntent
    volume: int | None = None


class ToPromptData(BaseModel):
    questions: list[Question]
    total_questions: int
    source_keywords: int
    failed_batches: int = 0


class PromptToVolumeData(BaseModel):
    volume: int | None = Field(None, description="추출 키워드 중 최대 검색량(0·미수집이면 null)")
    keywords: list[str]
    location_code: int
    language_code: str
    volumes: list[VolumeItem]
    fetch: FetchState
