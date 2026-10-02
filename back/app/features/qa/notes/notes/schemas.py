"""qa.notes.notes 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.features.qa.answers.list.scope import QaSurface, Severity, TargetKind

MAX_BODY = 4000


def _body(v: str | None) -> str | None:
    if v is None:
        return None
    s = v.strip()
    if not s:
        raise ValueError("body 는 비어 있으면 안 된다")
    if "\x00" in s:
        raise ValueError("body 형식 오류")
    return s


class QaNoteIn(BaseModel):
    """낱알 노트. target_label 은 클라이언트가 만든 사람이 읽는 스냅샷(재적재로 키가 바뀌어도 무엇을 지목했는지 남긴다).
    target_key: 인용이면 'job_id:ord'(DDL 주석)."""
    model_config = ConfigDict(extra="forbid")
    target_kind: TargetKind
    target_key: str | None = Field(None, max_length=200)
    target_label: str | None = Field(None, max_length=500)
    severity: Severity = "issue"
    body: str = Field(max_length=MAX_BODY)

    @field_validator("body")
    @classmethod
    def _v_body(cls, v: str) -> str | None:
        return _body(v)


class QaNotePatch(BaseModel):
    """부분 갱신. 본문·severity 는 작성자(세션 reviewer_name)만, resolved 토글은 검수자 누구나(resolved_by 에 이름 기록)."""
    model_config = ConfigDict(extra="forbid")
    body: str | None = Field(None, max_length=MAX_BODY)
    severity: Severity | None = None
    resolved: bool | None = None

    @field_validator("body")
    @classmethod
    def _v_body(cls, v: str | None) -> str | None:
        return _body(v)

    @model_validator(mode="after")
    def _nonempty(self) -> QaNotePatch:
        if self.body is None and self.severity is None and self.resolved is None:
            raise ValueError("바꿀 필드(body·severity·resolved)가 하나는 있어야 한다")
        return self


class QaNote(BaseModel):
    note_id: uuid.UUID
    job_id: uuid.UUID
    target_kind: TargetKind
    target_key: str | None
    target_label: str | None
    severity: Severity
    body: str
    reviewer_name: str
    created_at: datetime
    resolved_at: datetime | None
    resolved_by: str | None


class QaNoteRow(QaNote):
    """노트 목록 행 = 노트 + 답변 표시 좌표."""
    prompt_text: str | None
    surface: QaSurface
    brand: list[str] | None
    country: str | None
    engine: str | None
    lang: str | None


class QaNoteDeleted(BaseModel):
    note_id: uuid.UUID
    deleted: bool
