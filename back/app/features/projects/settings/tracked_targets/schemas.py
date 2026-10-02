"""projects.settings.tracked_targets 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.filters import PgLine, PgText

_ALIASES = Field(default_factory=list, max_length=100)


class BrandAliases(BaseModel):
    brand_code: str | None = Field(None, description="프로젝트 브랜드(없으면 null)")
    aliases: list[str] = Field(default_factory=list, description="정본 이름을 뺀 별칭")


class Competitor(BaseModel):
    brand_name: str
    aliases: list[str] = Field(default_factory=list)
    notes: str | None = None
    is_target: bool = Field(False, description="KPI #16 비교 기준 브랜드(프로젝트당 최대 1)")
    created_at: datetime


class Vehicle(BaseModel):
    brand: str
    model: str
    segment: str | None = None
    aliases: list[str] = Field(default_factory=list)
    created_at: datetime


class BrandAliasesPut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    brand_code: PgLine = Field(min_length=1, max_length=50, description="현재 프로젝트 브랜드와 같아야 한다(다르면 409)")
    aliases: list[PgLine] = _ALIASES


class CompetitorCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    brand_name: PgLine = Field(min_length=1, max_length=200)
    aliases: list[PgLine] = _ALIASES
    notes: PgText | None = Field(None, max_length=2000)


class TargetPut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    brand_name: PgLine | None = Field(None, max_length=200, description="null = 지정 해제(SOV 1위 외부 브랜드 자동 선택)")


class VehicleCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    brand: PgLine = Field(min_length=1, max_length=200)
    model: PgLine = Field(min_length=1, max_length=200)
    segment: PgLine | None = Field(None, max_length=200)
    aliases: list[PgLine] = _ALIASES


class TrackedWrite(BaseModel):
    """추적 대상 쓰기 결과: 재구성된 추적 브랜드 정본 목록과 재판정 큐 change_id(대상 없으면 null)."""
    brand_aliases: BrandAliases | None = None
    competitor: Competitor | None = None
    vehicle: Vehicle | None = None
    target_brand: str | None = None
    tracked_brands: list[str] = Field(default_factory=list)
    change_id: int | None = None
    propagation: str = "none"
