"""analytics.funnel.conversion 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

확장 파라미터(모듈-AI-퍼널 §2.2): device[](mobile·desktop·tablet), visitor_type[](new·returning), page_limit(15, 1..50).
허용 값 밖은 422(현행 parseConversionFilters 의 허용 목록 DEVICE_VALUES·VISITOR_VALUES 와 같다).
값 갭 보강(2026-09-28, 전부 추가형): days(7·28·90, BG-30), coverage.markets[].property_id(BG-29), by_engine_all(BG-31),
전환 이벤트 비관리자 경로 모델 ConversionEvents*(BG-29), property_source(project 표면 속성 선택, 검증 D3).
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.core.envelope import Ratio
from app.core.filters import CommonFilters

RELATIVE_DAYS: tuple[int, ...] = (7, 28, 90)   # BG-30: 현행 conversion-window.ts 기간 버튼(7·28·90일)


class ConversionParams(CommonFilters):
    """공통 필터 + GA4 확장 파라미터(한 query parameter model). engine[] 은 공통 축(AI 유입 sessionSource 엔진)으로 받는다."""
    device: list[Literal["mobile", "desktop", "tablet"]] = Field(default_factory=list, max_length=3, description="기기(두 코호트 공통)")
    visitor_type: list[Literal["new", "returning"]] = Field(default_factory=list, max_length=2, description="신규·재방문(두 코호트 공통)")
    page_limit: int = Field(15, ge=1, le=50, description="페이지별 표 행 수 상한")
    include_pages: bool = Field(True, description=(
        "false = 페이지별 표(data.pages)를 계산하지 않고 빈 배열로 둔다. 요약·커버리지·추이만 쓰는 대시보드 ⑦ 카드용 "
        "(현행 프런트 dashboard.ts toTrafficConversionKpi). 다른 필드 값은 같다"))
    rollup_lite: bool = Field(False, description=(
        "B096: true 이고 커버리지 시장이 2개 이상(전환 화면의 권역·본사 롤업 분기)이면 롤업이 그리지 않는 부분을 계산하지 않는다: "
        "페이지 문장·엔진 비교 문장을 건너뛰고 trend·by_engine·by_engine_all·pages = []. summary·by_country·coverage·period·meta 는 같다. "
        "시장이 하나 이하(국가 리프)면 효과 없음"))
    summary_only: bool = Field(False, description=(
        "B096: true = 요약 카드용(AI 전환율·분자·분모와 커버리지). 페이지 문장·엔진 비교 문장을 건너뛰고 trend·by_engine·by_engine_all·"
        "pages = [], by_country = null. summary·coverage·period·meta 는 같다"))
    days: int | None = Field(None, description="최신 적재일 기준 상대 창 길이(7·28·90, BG-30). from/to 와 함께 줄 수 없다. 둘 다 없으면 90")
    property_source: Literal["project", "market"] | None = Field(None, description=(
        "project 표면 전용 속성 선택(검증 D3). 생략·project = 프로젝트 직접 지정 우선(전환 화면 page.tsx:52-55), "
        "market = 직접 지정을 건너뛰고 프로젝트 (브랜드, 국가) 시장 속성만(프로젝트 대시보드 ⑦ live.ts:219-231). 다른 표면에서 주면 422"))

    @model_validator(mode="after")
    def _days(self) -> ConversionParams:
        if self.days is not None:
            if self.days not in RELATIVE_DAYS:
                raise ValueError(f"days 허용 값: {', '.join(str(d) for d in RELATIVE_DAYS)}")
            if self.from_ is not None or self.to is not None:
                raise ValueError("days 는 from·to 와 함께 줄 수 없다")
        if self.property_source is not None and self.surface != "project":
            raise ValueError("property_source 는 project 표면에서만")
        return self


class CohortSessions(BaseModel):
    sessions: int
    conversions: int


class AiSummary(CohortSessions):
    page_views: int
    conv: Ratio = Field(description="conversions / sessions")


class HumanSummary(CohortSessions):
    conv: Ratio = Field(description="conversions / sessions")


class Summary(BaseModel):
    ai: AiSummary
    human: HumanSummary


class TrendPoint(BaseModel):
    date: date
    ai_sessions: int
    ai_conversions: int
    human_sessions: int
    human_conversions: int


class EngineRow(BaseModel):
    engine: str = Field(description="엔진 코드. 매핑 없는 AI 유입은 'other'")
    sessions: int
    conversions: int
    conv: Ratio


class PageRow(BaseModel):
    url: str
    ai_sessions: int
    ai_conversions: int
    human_sessions: int
    human_conversions: int


class CountryRow(BaseModel):
    brand: str
    country: str
    ai: CohortSessions
    human: CohortSessions


class Market(BaseModel):
    brand: str
    country: str
    status: Literal["active", "pending_grant", "unmapped"]
    as_of: date | None = Field(description="그 속성의 최신 적재 보고서 날짜(active 만)")
    property_id: str | None = Field(None, description=(
        "그 시장이 해석한 GA4 속성 id(active·pending_grant 만, unmapped 는 null). 전환 이벤트 다이얼로그 대상(BG-29). "
        "project 표면의 프로젝트 직접 지정 속성은 active 적재 전이면 pending_grant 로 싣고(검증 D2), 다른 시장에 귀속된 속성을 "
        "가리키면 unmapped·null(검증 D1). 레지스트리 상태 unmapped 시장은 속성 id 가 있어도 null(현행과 다름, 검증 D4)"))


class Coverage(BaseModel):
    measured_markets: int
    total_markets: int
    markets: list[Market]


class Period(BaseModel):
    from_: date | None = Field(serialization_alias="from")
    to: date | None


class ConversionData(BaseModel):
    period: Period = Field(description="적용한 GA4 보고서 날짜 창(속성 시간대). from/to 미지정이면 최신 적재일 기준 최근 90일")
    summary: Summary
    trend: list[TrendPoint]
    by_engine: list[EngineRow]
    pages: list[PageRow]
    by_country: list[CountryRow] | None = Field(description="매칭 active 속성이 2개 이상일 때만")
    coverage: Coverage
    by_engine_all: list[EngineRow] = Field(default_factory=list, description=(
        "엔진 비교용 엔진별 분해(BG-31): engine[] 을 적용하지 않는다(기기·방문자 유형·시장·기간은 적용). "
        "engine[] 이 없으면 by_engine 과 같다. 현행 화면의 '다른 엔진과 비교'(conversion.ts:51-57)용"))


# ── 전환 이벤트(비관리자 경로, BG-29) ──
class ConversionEventsParams(BaseModel):
    """GET·PUT /v1/funnel/conversion/events 쿼리. 공통 필터 축은 없다(들어오면 meta.ignored_filters)."""
    property_id: str = Field(pattern=r"^\d{1,20}$", description="GA4 속성 id(숫자). coverage.markets[].property_id 또는 프로젝트 속성")
    project_id: uuid.UUID | None = Field(None, description="프로젝트 맥락(프로젝트 전환 화면). 있으면 그 프로젝트가 해석하는 속성만")
    surface: Literal["global", "website", "project"] | None = Field(
        None, description="열람 표면(표면 경로 게이트). 생략하면 project_id 가 있으면 project, 없으면 website")

    @model_validator(mode="after")
    def _surface(self) -> ConversionEventsParams:
        if self.project_id is not None and self.surface not in (None, "project"):
            raise ValueError("project_id 는 project 표면에서만")
        if self.surface == "project" and self.project_id is None:
            raise ValueError("project 표면은 project_id 필수")
        return self

    @property
    def effective_surface(self) -> str:
        return self.surface or ("project" if self.project_id is not None else "website")


class ConversionEventItem(BaseModel):
    event_name: str
    count: int = Field(description="최근 90일(오늘 KST 기준) eventCount 합(적재된 events 보고서). 추적 중이나 미발생이면 0")
    tracked: bool


class ConversionEventsData(BaseModel):
    property_id: str
    window_from: date
    window_to: date
    loaded: bool = Field(description="적재 투영(rd.ga4_dim_property)이 있는지. false 면 수는 전부 0")
    conv_basis: Literal["key_events", "tracked_events"] | None = None
    registered: bool = Field(description="관리자 레지스트리(app.ga4_property)에 있는지. false 면 편집(PUT)은 404(추적 이벤트는 레지스트리 속성에만)")
    can_edit: bool = Field(description="이 맥락에서 편집 가능 여부(admin, 프로젝트 활성 Owner, 비프로젝트는 역할 country·region·hq)")
    items: list[ConversionEventItem] = Field(description="추적 우선 → 수 내림차순 → 이름")


class ConversionEventsWritten(BaseModel):
    property_id: str
    event_names: list[str]
    change_id: int | None = None
    propagation: Literal["pending", "none"]
