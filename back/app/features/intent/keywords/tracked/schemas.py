"""intent.keywords.tracked 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.envelope import Envelope, ListData
from app.core.errors import ErrorDetail

MAX_ADD = 100           # 다건 추가 한 요청 행 상한(삭제 MAX_DELETE 와 같은 규모, 넘치면 화면 어댑터가 나눠 보낸다)


class TrackedKeyword(BaseModel):
    keyword_id: uuid.UUID
    term: str
    country_code: str | None = Field(description="저장값(NULL = 프로젝트 국가)")
    country: str | None = Field(description="유효 국가(프리셋 id). 프로젝트 국가가 프리셋 밖이면 null")
    created_at: datetime
    latest_month: date | None
    latest_volume: int | None


class TrackedKeywordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    term: str = Field(min_length=1, max_length=200)
    country: str | None = Field(None, max_length=8, description="ISO2 프리셋 id. 생략하면 프로젝트 국가를 따른다")


class TrackedKeywordItem(BaseModel):
    """다건 추가의 한 행. 길이 규칙은 행마다 단건 본문(TrackedKeywordIn)으로 따로 검사해 그 행 결과(422)로 준다."""
    model_config = ConfigDict(extra="forbid")
    term: str
    country: str | None = None


class TrackedKeywordsIn(BaseModel):
    """다건 추가 본문(items[]). 단건 본문({term, country})도 같은 경로에서 그대로 받는다."""
    model_config = ConfigDict(extra="forbid")
    items: list[TrackedKeywordItem] = Field(min_length=1, max_length=MAX_ADD, description=f"1~{MAX_ADD}행, 결과는 같은 순서")


class TrackedAddResult(BaseModel):
    status: int = Field(description="그 행을 단건 본문으로 보냈을 때의 HTTP 상태(201 생성, 409 duplicate_keyword, 422 unknown_country·빈 term 등)")
    data: TrackedKeyword | None = Field(description="생성된 행(status 201), 아니면 null")
    error: ErrorDetail | None = Field(description="단건 응답의 error 와 같은 code·message·details(status 201 이면 null)")


class Removed(BaseModel):
    removed_count: int


TrackedListEnvelope = Envelope[ListData[TrackedKeyword]]
TrackedEnvelope = Envelope[TrackedKeyword]
TrackedAddListEnvelope = Envelope[ListData[TrackedAddResult]]
RemovedEnvelope = Envelope[Removed]
