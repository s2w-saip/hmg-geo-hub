"""projects.prompts.fields 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_LABEL = 100
MAX_VALUE = 500
MAX_BULK = 1000


def _clean(v: str, what: str) -> str:
    s = v.strip()
    if not s:
        raise ValueError(f"{what} 이 비었다")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in s):
        raise ValueError(f"{what} 에 제어 문자")
    return s


class FieldItem(BaseModel):
    field_id: uuid.UUID
    label: str
    archived: bool
    created_at: datetime
    value_count: int = Field(description="이 태그에 값이 있는 프롬프트 수(완전 삭제 시 함께 지워지는 값 수)")


class FieldList(BaseModel):
    items: list[FieldItem]


class FieldCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str = Field(min_length=1, max_length=MAX_LABEL)

    @field_validator("label")
    @classmethod
    def _label(cls, v: str) -> str:
        return _clean(v, "태그 이름")


class ValueSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: str = Field(min_length=1, max_length=MAX_VALUE)

    @field_validator("value")
    @classmethod
    def _value(cls, v: str) -> str:
        return _clean(v, "값")


class BulkSet(ValueSet):
    prompt_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_BULK)

    @field_validator("prompt_ids")
    @classmethod
    def _dedupe(cls, v: list[uuid.UUID]) -> list[uuid.UUID]:
        return list(dict.fromkeys(v))


class ValueResult(BaseModel):
    prompt_id: uuid.UUID
    field_id: uuid.UUID
    value: str


class BulkResult(BaseModel):
    field_id: uuid.UUID
    count: int
