"""admin.catalog.bulk 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.core.filters import PgLine, PgText
from app.core.write import WriteAccepted
from app.features.admin.catalog.prompts.schemas import LABEL_MAX, TEXT_MAX, Presence, PromptType

MAX_ITEMS = 200            # 요청당 적용 상한(모듈-관리자 §2.1)


class RowFailure(BaseModel):
    prompt_id: str
    code: str
    message: str


class BulkRegionsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_ITEMS)
    regions: list[str] | None = Field(description="설정할 시장. null = 미지정(상속)으로 되돌림", max_length=300)


class BulkRegionsResult(WriteAccepted):
    batch_id: uuid.UUID
    updated: int
    unchanged: int
    failed: list[RowFailure]
    outbox_ids: list[int]


class BulkLabels(BaseModel):
    """준 필드만 바꾼다(생략 = 불변, null = 비우기). 라벨은 한 줄(PgLine): preview 는 제어 문자가 든 새 값을 경고 후 뺀다."""
    model_config = ConfigDict(extra="forbid")
    prompt_type: PromptType | None = None
    category: PgLine | None = Field(None, max_length=LABEL_MAX)
    brand_code: PgLine | None = Field(None, max_length=LABEL_MAX)
    brand_presence: Presence | None = None
    list_type: PgLine | None = Field(None, max_length=LABEL_MAX)
    depth1: PgLine | None = Field(None, max_length=LABEL_MAX)
    depth2: PgLine | None = Field(None, max_length=LABEL_MAX)
    depth3: PgLine | None = Field(None, max_length=LABEL_MAX)
    depth4: PgLine | None = Field(None, max_length=LABEL_MAX)
    funnel_stage: PgLine | None = Field(None, max_length=LABEL_MAX)


class BulkItem(BaseModel):
    """한 행의 변경. text·regions·lang 도 생략 = 불변, regions·lang 의 null = 미지정. text 비우기는 불허."""
    model_config = ConfigDict(extra="forbid")
    prompt_id: uuid.UUID
    text: PgText | None = Field(None, max_length=TEXT_MAX)
    labels: BulkLabels = Field(default_factory=BulkLabels)
    regions: list[str] | None = Field(None, max_length=300)
    lang: str | None = Field(None, max_length=10)


class PreviewItem(BaseModel):
    prompt_id: str
    current_text: str
    changes: dict[str, dict[str, str | None]] = Field(description="필드별 {old, new}")
    item: dict[str, Any] = Field(description="bulk/apply 에 그대로 되돌려 보낼 BulkItem(준 필드만 담는다)")


class PreviewData(BaseModel):
    items: list[PreviewItem]
    unmatched_ids: list[str]
    unchanged: int
    warnings: list[str]
    batch_id: uuid.UUID = Field(description="서버 생성. bulk/apply 청크들이 공유(감사 batch_id)")


class ApplyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    batch_id: uuid.UUID
    items: list[BulkItem] = Field(min_length=1, max_length=MAX_ITEMS)


class ApplyResult(WriteAccepted):
    batch_id: uuid.UUID
    applied: int = Field(description="실제로 바뀐 행 수")
    unchanged: int = Field(description="이미 같은 값이라 쓰지 않은 행 수(재시도 멱등)")
    failed: list[RowFailure]
    change_ids: list[int]
    outbox_ids: list[int]
