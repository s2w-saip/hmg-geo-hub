"""projects.prompts.execute 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ExecuteResult(BaseModel):
    """저장+실행 결과(구 pushedCount/failedCount 를 outbox 적재 건수로 재정의, PJ-3 open ①).
    queued = 이번에 발행 요청을 적재한 행 수(draft + recovered), recovered = queued 인데 Scope 미발행이던 복구 대상,
    skipped_pending = 이미 미완료 발행 요청이 있어 건너뛴 행 수."""
    queued: int
    recovered: int
    skipped_pending: int
    propagation: Literal["pending"] = Field("pending", description="Scope 반영은 outbox 워커가 비동기로 한다")
