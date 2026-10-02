"""admin.catalog.prompts 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.filters import PgLine, PgText
from app.core.write import WriteAccepted

PromptType = Literal["comparison", "recommendation", "information", "other"]   # 현행 lib/db/repositories/prompts.ts PromptType
Kind = Literal["single", "acr"]
Presence = Literal["branded", "unbranded"]                                        # DDL CHECK app.prompt.brand_presence

# 라벨 열(현행 CATALOG_LABEL_FIELDS 와 같은 집합, 이름은 DB 열 이름)
LABEL_FIELDS: tuple[str, ...] = ("prompt_type", "category", "brand_code", "brand_presence", "list_type",
                                 "depth1", "depth2", "depth3", "depth4", "funnel_stage")
TEXT_MAX = 5000
LABEL_MAX = 200
# 요청 자유 문자열: 본문 = PgText(여러 줄, NUL·서로게이트 거부), 라벨 = PgLine(한 줄, 제어 문자까지 거부). core.filters 규약.


class CatalogPrompt(BaseModel):
    """표준 루트 카탈로그 한 행(app.prompt). scope_text 는 rd.dim_prompt.text(읽기 응답만, 쓰기 응답은 null)."""
    prompt_id: uuid.UUID
    text: str
    prompt_type: str | None = None
    category: str | None = None
    brand_code: str | None = None
    brand_presence: str | None = None
    list_type: str | None = None
    depth1: str | None = None
    depth2: str | None = None
    depth3: str | None = None
    depth4: str | None = Field(None, description="편집 전용 메타(rd.dim_taxon 축 아님)")
    funnel_stage: str | None = None
    kind: str
    lang: str | None = Field(None, description="번역 시트 언어(ISO 639-1 대문자). null = 미지정")
    regions: list[str] | None = Field(None, description="대상 시장(ISO alpha-2 또는 x: 의사코드). null = 미지정(상속)")
    scope_prompt_id: uuid.UUID | None = None
    scope_text: str | None = None
    tracked: bool = Field(description="scope_prompt_id 연결 여부(미추적 = false)")
    status: str
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None
    outbox_pending: bool | None = Field(None, description="Scope 반영 대기(미완료 app.scope_outbox 행 있음, BG-44). 목록·상세·쓰기 응답 모두 "
                                                          "같은 술어로 채운다(쓰기 응답은 이번 쓰기의 outbox 행 포함, 검증 D4)")
    outbox_error: str | None = Field(None, description="대기 중 outbox 의 가장 최근 전송 오류(last_error). 대기 없음·오류 없음이면 null")


class CatalogStats(BaseModel):
    """활성 행 기준 통계(필터와 무관한 루트 카탈로그 전체). deleted 는 include_deleted 일 때만 센다(현행 동일)."""
    total: int
    tracked: int
    untracked: int
    scope_orphans: int = Field(description="Scope 쪽 루트 프롬프트 중 어떤 카탈로그 행도 연결하지 않은 수(rd.dim_prompt)")
    acr: int
    deleted: int


class CatalogListData(BaseModel):
    items: list[CatalogPrompt]
    stats: CatalogStats


class PendingChange(BaseModel):
    change_id: int
    kind: str
    status: str
    requested_at: datetime


class PendingOutbox(BaseModel):
    outbox_id: int
    op: str
    attempts: int
    created_at: datetime
    last_error: str | None = None


class CatalogPromptDetail(BaseModel):
    prompt: CatalogPrompt
    pending_changes: list[PendingChange]
    pending_outbox: list[PendingOutbox]


class PromptWriteResult(WriteAccepted):
    """쓰기 결과. change_id = 이 쓰기로 트리거가 남긴 첫 judgment_change(없으면 null), change_ids = 전부."""
    prompt: CatalogPrompt | None = None
    change_ids: list[int] = Field(default_factory=list)
    outbox_id: int | None = None
    applied: bool = Field(True, description="false = 변경 없음(no-op) 또는 dry_run")
    warnings: list[str] = Field(default_factory=list)


# ── 요청 ──
class _Labels(BaseModel):
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


class CreatePromptBody(_Labels):
    text: PgText = Field(min_length=1, max_length=TEXT_MAX)
    kind: Kind = "single"
    lang: str | None = Field(None, max_length=10)
    regions: list[str] | None = Field(None, max_length=300)


class TextBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: PgText = Field(min_length=1, max_length=TEXT_MAX)


class LabelsBody(_Labels):
    """준 필드만 바꾼다(생략 = 불변, null = 비우기). 하나도 없으면 422."""


class RegionsBody(BaseModel):
    """regions·lang 중 준 것만 바꾼다(생략 = 불변, null = 미지정으로 되돌림)."""
    model_config = ConfigDict(extra="forbid")
    regions: list[str] | None = Field(None, max_length=300)
    lang: str | None = Field(None, max_length=10)


class KindBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Kind
    dry_run: bool = Field(False, description="true 면 쓰지 않고 영향·경고만 돌려준다")
