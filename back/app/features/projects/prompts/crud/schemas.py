"""projects.prompts.crud 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.filters import SAFE_TEXT, PgLine, single_line

PromptStatus = Literal["draft", "queued", "running", "done", "failed", "paused"]
PromptKind = Literal["single", "acr"]

MAX_LINES = 1000          # 수동 추가 1회 줄 수 상한(현행 상한 없음: 요청 폭주 방지용 신규)
MAX_TEXT = 4000           # 프롬프트 본문 1건 길이 상한(신규)

# 제어 문자(검증 D2·D2-R): NUL·짝 없는 서로게이트가 DB 까지 가면 500 이던 결함. 입력 단계에서 422 로 거부한다
# (6라운드부터 core 전역 처리기도 22xxx·인코딩 오류를 422 invalid_value 로 바꾸지만, 입력 검증이 먼저다).
# - 한 줄 메타(분류 값·regions 항목)는 core.filters.PgLine(C0·DEL·서로게이트 거부)과 규칙이 같아 core 타입을 쓴다(§8 처분).
# - 본문(check_body)은 유지: core PgText 는 NUL·서로게이트만 거부하지만 본문은 탭·줄바꿈(\t \n \r) 밖의 C0·DEL 도 거부한다
#   (프롬프트 본문이 Scope 측정 입력으로 그대로 나가므로 보이지 않는 제어 문자를 받지 않는다, 검증 D2·D5). 규칙이 달라 교체하지 않는다.
# - 목록 q 검색어는 core.filters.SAFE_TEXT 패턴(C0·DEL 배제) + 길이 200.
CTRL_IN_BODY = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]")
Q_PATTERN = SAFE_TEXT


def check_body(v: str) -> str:
    if CTRL_IN_BODY.search(v):
        raise ValueError("본문에 제어 문자(NUL 등) 또는 짝 없는 서로게이트가 있다")
    return v


class PromptItem(BaseModel):
    """프로젝트 프롬프트 1건. 은퇴 축(list_type·depth·funnel·brand_presence)은 노출하지 않는다(모듈-프로젝트 §2)."""
    prompt_id: uuid.UUID
    candidate_id: uuid.UUID | None = None
    text: str
    kind: PromptKind
    status: PromptStatus
    brand_code: str | None = None
    category: str | None = None
    prompt_type: str | None = None
    lang: str | None = None
    regions: list[str] | None = None
    scope_prompt_id: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime
    tags: dict[str, str] = Field(default_factory=dict, description="커스텀 태그값 {field_id: value}")


class PromptList(BaseModel):
    items: list[PromptItem]
    next_cursor: str | None = None


class ManualAdd(BaseModel):
    """수동 추가: 줄바꿈으로 나눠 행당 1건(빈 줄 무시). 전부 draft 로 들어간다."""
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=MAX_LINES * (MAX_TEXT + 1))

    @field_validator("text")
    @classmethod
    def _ctrl(cls, v: str) -> str:
        return check_body(v)


class Created(BaseModel):
    created: int
    prompt_ids: list[uuid.UUID]


class PromptPatch(BaseModel):
    """본문·lang·regions 는 draft 만(그 외 409 prompt_not_draft). 분류 메타·kind 는 상태 무관.
    명시한 필드만 바꾼다(null 은 비우기, text·kind 는 null 불가)."""
    model_config = ConfigDict(extra="forbid")
    text: str | None = Field(None, min_length=1, max_length=MAX_TEXT)
    kind: PromptKind | None = None
    brand_code: PgLine | None = Field(None, max_length=40)
    category: PgLine | None = Field(None, max_length=200)
    prompt_type: PgLine | None = Field(None, max_length=200)
    lang: str | None = Field(None, min_length=2, max_length=16, pattern=r"^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$")
    regions: list[str] | None = Field(None, max_length=300)

    @field_validator("text")
    @classmethod
    def _strip_text(cls, v: str | None) -> str | None:
        if v is None:
            return v
        s = v.strip()
        if not s:
            raise ValueError("본문이 비었다")
        return check_body(s)

    @field_validator("regions")
    @classmethod
    def _regions(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return v
        out = []
        for r in v:
            s = r.strip()
            if not s or len(s) > 40:
                raise ValueError("regions 값 형식 오류")
            out.append(single_line(s))     # 공백 제거 뒤 core PgLine 규칙(제어 문자·서로게이트, 검증 D2-R: list[str] 항목은 pydantic 이 안 본다)
        return list(dict.fromkeys(out))
