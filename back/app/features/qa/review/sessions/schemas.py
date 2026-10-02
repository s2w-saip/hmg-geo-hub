"""qa.review.sessions 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class QaLoginIn(BaseModel):
    """검수 게이트 입장(Q17): 이름(평문, 제어문자 제거 후 1~40자) + 공유 비밀번호."""
    model_config = ConfigDict(extra="forbid")
    name: str = Field(max_length=200)
    password: str = Field(max_length=200)


class QaSessionOut(BaseModel):
    session_id: uuid.UUID
    reviewer_name: str
    started_at: datetime
    last_seen_at: datetime


class QaSessionPatch(BaseModel):
    """PATCH 본문(선택). 없거나 logout=false 면 활동 갱신, logout=true 면 로그아웃."""
    model_config = ConfigDict(extra="forbid")
    logout: bool = False


class QaLogoutOut(BaseModel):
    """로그아웃 결과. 쿠키는 항상 지운다(max-age=0)."""
    session_id: uuid.UUID
    locks_released: int = Field(description="이 세션이 쥐고 있던 락 해제 수")
    session_deleted: bool = Field(description="세션 행 삭제(서버 측 폐기) 여부. 행이 이미 없었으면 false")
    references_detached: int = Field(0, description="session_id 를 NULL 로 끊은 판정·노트 수(작성자 이름은 남는다)")
    session_kept_reason: str | None = Field(None, description="행을 지우지 못한 이유. 로그아웃이 참조를 끊고 지우므로 보통 null(방어선)")
