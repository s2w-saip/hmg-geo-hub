"""projects.settings.overview 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid

from pydantic import BaseModel, Field

from app.features.projects.settings.engines.schemas import EngineSettings
from app.features.projects.settings.owned_bases.schemas import OwnedBase
from app.features.projects.settings.tracked_targets.schemas import BrandAliases, Competitor, Vehicle


class SettingsBundle(BaseModel):
    """설정 화면 묶음(G-25: 화면 호출 수 억제). 추적 URL 은 건수만(목록은 GET /settings/tracked-urls 키셋)."""
    project_id: uuid.UUID
    domain: str | None = None
    my_role: str | None = None
    can_edit: bool = Field(description="활성 Owner 또는 admin")
    engines: EngineSettings
    owned_bases: list[OwnedBase]
    brand_aliases: BrandAliases
    competitors: list[Competitor]
    vehicles: list[Vehicle]
    tracked_url_count: int
