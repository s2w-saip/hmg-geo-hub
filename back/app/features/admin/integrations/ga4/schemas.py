"""admin.integrations.ga4 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

PropStatus = Literal["active", "pending_grant", "unmapped"]
Ga4Fields = Literal["full", "registry"]          # 속성 목록 열 범위(registry = 화면 표 열만, 기본 full = 종전)
WriteReturn = Literal["full", "minimal"]         # PUT 응답 범위(minimal = property 재조회 생략, 기본 full = 종전)
ConvBasis = Literal["key_events", "tracked_events"]
CONV_BASIS: dict[int, ConvBasis] = {1: "key_events", 2: "tracked_events"}
PROPERTY_ID_RE = re.compile(r"^\d{1,20}$")                       # 현행 upsertGa4Mapping: 숫자만
EVENT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,39}$")           # GA4 이벤트 이름 규칙(영문 시작, 영숫자·밑줄, 40자)


class ProjectOverride(BaseModel):
    project_id: uuid.UUID
    name: str
    brand_code: str | None = Field(None, description="프로젝트 브랜드(app.project.brand_code, BG-43)")
    country_code: str | None = Field(None, description="프로젝트 국가(app.project.country_code, BG-43)")


class ProjectOverrideItem(BaseModel):
    """GA4 속성을 직접 지정한 프로젝트 한 행(BG-43). 레지스트리에 없는 속성을 지정한 프로젝트도 나온다(registered 거짓)."""
    project_id: uuid.UUID
    name: str
    kind: Literal["standard_root", "customer"]
    brand_code: str | None = None
    country_code: str
    property_id: str = Field(description="프로젝트가 직접 지정한 GA4 속성 id(app.project.ga4_property_id)")
    registered: bool = Field(description="그 속성이 레지스트리(app.ga4_property)에 있는지")
    property_status: PropStatus | None = Field(None, description="레지스트리 속성 상태(미등록이면 null)")
    created_at: datetime


class PendingChange(BaseModel):
    change_id: int
    kind: Literal["ga4_property", "ga4_tracked_event"]
    status: Literal["pending", "running"]
    requested_at: datetime


class Ga4Property(BaseModel):
    property_id: str
    brand_code: str | None = None
    country_code: str | None = None
    status: PropStatus
    verified_at: datetime | None = Field(None, description="마지막 GA4 읽기 권한 확인 성공 시각(PUT verify=true 성공 때 갱신, 현행 '검증일' 열). "
                                                            "매핑·상태가 바뀌어도 초기화하지 않는다(현행과 같음)")
    updated_by: uuid.UUID | None = None
    updated_by_email: str | None = None
    updated_at: datetime
    tracked_events: int | None = Field(description="추적(전환) 이벤트 수. 0 이면 key events 폴백(fields=registry 면 null)")
    loaded: bool | None = Field(description="적재기가 rd.ga4_dim_property 에 투영했는지(GA4 행 적재 대상, fields=registry 면 null)")
    conv_basis: ConvBasis | None = Field(None, description="적재된 전환 기준(1 key events 폴백, 2 추적 이벤트)")
    project_overrides: list[ProjectOverride] | None = Field(default_factory=list,
                                                            description="이 속성을 직접 지정한 고객 프로젝트(읽기 전용, fields=registry 면 null)")
    pending: list[PendingChange] | None = Field(default_factory=list, description="대기·실행 중 요청(fields=registry 면 null)")


class PropertyPut(BaseModel):
    """브랜드·국가 매핑(둘 다 주거나 둘 다 null = 미매핑). verify=true 면 GA4 Data API 로 읽기 권한을 확인하고 active 로 올린다."""
    model_config = ConfigDict(extra="forbid")
    brand_code: str | None = Field(None, min_length=1, max_length=50)
    country_code: str | None = Field(None, min_length=2, max_length=2)
    verify: bool = False

    @field_validator("country_code")
    @classmethod
    def _cc(cls, v: str | None) -> str | None:
        if v is None:
            return None
        s = v.strip().upper()
        if not re.fullmatch(r"[A-Z]{2}", s):
            raise ValueError("country_code 는 ISO 3166-1 alpha-2")
        return s

    @model_validator(mode="after")
    def _pair(self) -> PropertyPut:
        if (self.brand_code is None) != (self.country_code is None):
            raise ValueError("brand_code·country_code 는 둘 다 주거나 둘 다 null")
        return self


class PropertyWritten(BaseModel):
    property: Ga4Property | None = Field(description="저장 뒤 속성 행(return=minimal 면 null: 응답용 재조회 생략)")
    verified: bool | None = Field(None, description="verify 요청 결과(요청 안 했으면 null)")
    change_id: int | None = None
    propagation: Literal["pending", "none"]
    pending_market_cleared: bool = Field(False, description="같은 브랜드·국가의 속성 없는 시장(대기) 행을 이 매핑으로 지웠는지")


class PropertyDeleted(BaseModel):
    property_id: str
    deleted: bool = True
    removed_tracked_events: int
    project_overrides: int = Field(description="이 속성을 직접 지정한 프로젝트 수(삭제 후에도 프로젝트 설정에 남는다)")
    change_id: int
    propagation: Literal["pending"] = "pending"


class EventItem(BaseModel):
    event_name: str
    count: int = Field(description="최근 창(기본 90일) eventCount 합(rd.ga4_row events 보고서). 추적 중이나 미발생이면 0")
    tracked: bool


class EventsData(BaseModel):
    property_id: str
    window_from: date
    window_to: date
    loaded: bool
    conv_basis: ConvBasis | None = None
    items: list[EventItem]


class EventsPut(BaseModel):
    """추적 이벤트 집합 통째로 교체(빈 배열 = 해제 → key events 폴백)."""
    model_config = ConfigDict(extra="forbid")
    event_names: list[str] = Field(max_length=100)

    @field_validator("event_names")
    @classmethod
    def _names(cls, v: list[str]) -> list[str]:
        out = []
        for n in v:
            s = n.strip()
            if not EVENT_RE.match(s):
                raise ValueError(f"이벤트 이름 형식 오류: {s[:40]}")
            out.append(s)
        return sorted(set(out))


class EventsWritten(BaseModel):
    property_id: str
    event_names: list[str]
    change_id: int | None = None
    propagation: Literal["pending", "none"]


class PendingMarket(BaseModel):
    """속성 id 없이 브랜드×국가만 등록한 시장(app.ga4_market_pending, 현행 ga4_properties.property_id NULL·status unmapped 행).
    속성 목록(GET /v1/admin/ga4/properties)과 합쳐 보이는 것은 프론트 어댑터가 한다."""
    brand_code: str
    country_code: str
    note: str | None = None
    updated_by: uuid.UUID | None = None
    updated_by_email: str | None = None
    updated_at: datetime


class MarketPut(BaseModel):
    """대기 시장 등록·수정(멱등). 같은 브랜드·국가에 속성이 이미 매핑돼 있으면 409 market_taken."""
    model_config = ConfigDict(extra="forbid")
    note: str | None = Field(None, max_length=500)

    @field_validator("note")
    @classmethod
    def _note(cls, v: str | None) -> str | None:
        return (v.strip() or None) if v is not None else None


class MarketWritten(BaseModel):
    market: PendingMarket
    created: bool = Field(description="새로 만들었으면 true, 이미 있던 행을 고쳤으면 false")


class MarketDeleted(BaseModel):
    brand_code: str
    country_code: str
    deleted: bool = True
