"""projects.settings.overview 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid

from pydantic import BaseModel, Field

from app.features.projects.settings.engines.schemas import EngineSettings
from app.features.projects.settings.owned_bases.schemas import OwnedBase
from app.features.projects.settings.tracked_targets.schemas import BrandAliases, Competitor, Vehicle


class SettingsBundle(BaseModel):
    """설정 화면 묶음(G-25: 화면 호출 수 억제). 추적 URL 은 건수만(목록은 GET /settings/tracked-urls 키셋).
    view=card(홈 KPI 카드)는 카드가 쓰는 값만 채운다: engines·brand_aliases·vehicles 는 null, competitors 는 지정 비교 브랜드 행만."""
    project_id: uuid.UUID
    domain: str | None = None
    my_role: str | None = None
    can_edit: bool = Field(description="활성 Owner 또는 admin")
    engines: EngineSettings | None = Field(None, description="view=card 면 null")
    owned_bases: list[OwnedBase]
    brand_aliases: BrandAliases | None = Field(None, description="view=card 면 null")
    competitors: list[Competitor] = Field(description="추적 경쟁사(brand_name 순). view=card 면 지정 비교 브랜드(is_target) 행만")
    vehicles: list[Vehicle] | None = Field(None, description="view=card 면 null")
    tracked_url_count: int
