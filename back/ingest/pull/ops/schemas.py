"""ingest.pull.ops 응답 모델(Pydantic v2). 봉투는 app.core.envelope(Envelope[ListData[T]], meta.page 키셋)."""
from __future__ import annotations

import datetime as dt
import uuid
from typing import Literal

from pydantic import BaseModel, Field

SurfaceName = Literal["global", "website", "project"]
LoadKind = Literal["run", "recheck", "judgment", "cycle_admin", "rebuild", "ga4", "dfs", "report", "seed"]
LoadStatus = Literal["running", "committed", "failed"]


class IngestStatusRow(BaseModel):
    scope_project_id: uuid.UUID
    surface: SurfaceName
    last_attempt_at: dt.datetime | None = Field(None, description="마지막 pull 시도(커서 임대 시각)")
    last_success_at: dt.datetime | None = None
    last_error: str | None = Field(None, description="마지막 패스 오류(사유 앞, 2000자 이내)")
    prompts_updated_to: dt.datetime | None = Field(None, description="프롬프트 증분 커서")
    regions: list[str] | None = Field(None, description="Scope 프로젝트 시장 설정")
    open_runs: int = Field(description="미해소·분석 대기 run 수")
    blocked_runs: int = Field(description="연속 실패로 막힌 run 수")


class BacklogRow(BaseModel):
    run_id: uuid.UUID
    scope_project_id: uuid.UUID
    surface: SurfaceName | None = None
    sync_state: Literal["new", "staging", "loaded", "deferred", "blocked"]
    status: str = Field(description="Scope run 상태")
    total_jobs: int | None = None
    unresolved_jobs: int
    analysis_pending: int
    recheck_until: dt.datetime | None = None
    analysis_recheck_until: dt.datetime | None = None
    attempts: int
    next_attempt_at: dt.datetime | None = None
    last_error: str | None = None
    started_at: dt.datetime | None = None


class LoadRow(BaseModel):
    load_id: int
    kind: LoadKind
    run_id: uuid.UUID | None = None
    status: LoadStatus
    rule_ver: int
    jobs_fetched: int | None = None
    jobs_changed: int | None = None
    jobs_removed: int | None = None
    rd_answers_upserted: int | None = None
    rd_gate_propagated: int | None = None
    rd_rep_flips: int | None = None
    rd_children_rows: int | None = None
    started_at: dt.datetime
    finished_at: dt.datetime | None = None
    error: str | None = None
