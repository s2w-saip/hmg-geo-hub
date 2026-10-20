"""analytics.funnel.acr 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

확장 파라미터 상한은 모듈-AI-퍼널 §2.1 이 정본이다(열린 질문 9 권장: 이 문서가 정본, 계약서엔 링크만).
trend_cycles 기본 12 는 제품 결정 Q12(ACR 추이 기본 12회차, 코드 상수)다.
"""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

from app.core.envelope import Ratio
from app.core.filters import CommonFilters

TREND_CYCLES_DEFAULT = 12   # Q12: ACR 추이 기본 창 = 게이트 통과 최근 12회차


class AcrParams(CommonFilters):
    """공통 필터 + ACR 확장 파라미터(한 query parameter model)."""
    top_brands: int = Field(12, ge=1, le=50, description="브랜드 표·KPI 랭킹 상한")
    trend_series: int = Field(5, ge=1, le=10, description="추이 시리즈 브랜드 수(당사 우선 + 상위)")
    trend_cycles: int = Field(TREND_CYCLES_DEFAULT, ge=1, le=104, description="추이 회차 수(창 끝에서 거꾸로, Q12 기본 12)")
    battle_limit: int = Field(200, ge=1, le=500, description="배틀 그리드 프롬프트 상한")
    territory_limit: int = Field(12, ge=1, le=24, description="점유 맵 시트(국가×엔진) 상한")
    model_limit: int = Field(12, ge=1, le=50, description="차종 전환율 표 상한")
    # ── 계산 생략(B097). 전부 선택: 주지 않으면 응답이 이전과 같다 ──
    include_option_countries: bool = Field(True, description=(
        "false = options.countries 를 계산하지 않고 [] 로 둔다(국가 옵션 문장 생략). 화면 국가 목록은 /v1/filters/options 를 쓴다. "
        "options.langs·다른 필드 값은 같다"))
    include_catalog_count: bool = Field(True, description=(
        "false = 카탈로그 ACR 프롬프트 수를 셀이 없는 응답(prompt_runs 0·빈 창·숨김·원천 준비 중)에서만 세고, 셀이 있으면 세지 않고 "
        "totals.catalog_acr_prompts = null(측정 대기 안내만 이 값을 읽는다). 다른 값은 같다"))


class AcrTotals(BaseModel):
    prompt_runs: int = Field(description="셀(prompt-run) 수. coverage 분모")
    prompts: int = Field(description="측정된 ACR 프롬프트 수(count DISTINCT)")
    iterations: int = Field(description="유효 ACR 반복 합(Σvalid_acr). choice_share 분모")
    engines: list[str] = Field(description="셀에 나온 엔진 코드")
    catalog_acr_prompts: int | None = Field(description="카탈로그의 ACR 프롬프트 수(측정 무관). 0 이면 '카탈로그에 ACR 없음', 양수인데 prompt_runs 0 이면 "
                                                    "'측정 대기'. include_catalog_count=false 이고 셀이 있으면(prompt_runs > 0) null")


class AcrBrand(BaseModel):
    brand: str
    is_ours: bool
    choice: int
    appearance: int
    cells: int
    choice_share: Ratio = Field(description="choice / totals.iterations")
    coverage: Ratio = Field(description="등장 셀 / totals.prompt_runs")


class AcrOwn(BaseModel):
    choice: int = Field(description="관점 당사 브랜드 선택 합(1순위 횟수)")
    appearance: int = Field(description="관점 당사 브랜드 등장 합")
    cells: int = Field(description="당사 행이 있는 셀 수(DISTINCT: 당사 브랜드가 여럿 있어도 셀당 1)")
    choice_share: Ratio = Field(description="choice / totals.iterations (Top1)")
    coverage: Ratio = Field(description="cells / totals.prompt_runs (Top5 후보군 포함)")


class AcrTrendPoint(BaseModel):
    brand: str
    num: int = Field(description="그 회차 그 브랜드 선택 수(분모는 버킷 den)")


class AcrTrendBucket(BaseModel):
    round_date: date
    gap: bool = Field(description="게이트 통과 회차인데 ACR 셀이 없음(den 0)")
    den: int = Field(description="그 회차 유효 ACR 반복 합")
    series: list[AcrTrendPoint]


class AcrTrend(BaseModel):
    series_brands: list[str]
    buckets: list[AcrTrendBucket]


class AcrBattleCell(BaseModel):
    engine: str
    winner_brand: str | None
    winner_is_ours: bool
    choice: int


class AcrBattleRow(BaseModel):
    prompt_id: str
    prompt_text: str | None
    cells: list[AcrBattleCell]


class AcrModelRow(BaseModel):
    brand: str | None = Field(description="소속 브랜드(parent_brand), 모르면 null")
    model: str
    is_ours: bool
    conversion: Ratio = Field(description="Σchoice / 등장 셀 Σvalid_acr")
    cells: int = Field(description="등장 셀 수(shortlist)")
    top1: int = Field(description="최종 선택 수")


class AcrTerritoryEntry(BaseModel):
    brand: str
    choice: int
    is_ours: bool


class AcrTerritoryRow(BaseModel):
    prompt_id: str
    prompt_text: str | None
    valid_acr: int
    entries: list[AcrTerritoryEntry]


class AcrTerritorySheet(BaseModel):
    country: str | None
    engine: str
    rows: list[AcrTerritoryRow]


class AcrOptions(BaseModel):
    """ACR 모집단 필터 옵션(BG-33, 현행 listMeasuredAcrLanguages scope-aggregates.ts:7740). 언어를 골라도 다른 언어 옵션이 남고,
    국가 옵션은 요청 국가가 아니라 계정 국가 스코프로 좁힌다.
    langs = 현행과 같이 스코프 브랜드·국가·기간만 건 ACR 셀(엔진·택소노미·커스텀·lang 축 없음, 검증 D5).
    countries = 데이터와 같은 셀 선택(창·스코프·엔진·택소노미)에서 geo 축만 스코프로 바꾸고 숨김 국가를 뺀 것(검증 D2)."""
    langs: list[str] = Field(default_factory=list, description="ACR 셀이 있는 언어(소문자 BCP-47, 오름차순). 창·스코프 브랜드·"
                             "country[] 만 적용하고 lang[]·engine[](전 엔진)·택소노미·커스텀 축은 적용하지 않는다(현행 listMeasuredAcrLanguages)")
    countries: list[str] = Field(default_factory=list, description="ACR 셀이 있는 국가 코드(오름차순). country[] 대신 계정 국가 스코프를 "
                                 "적용하고 숨김 국가(global = hidden_standard, website = 숨김 시장)는 뺀다(/v1/filters/options regions 와 같은 규칙)")


class AcrData(BaseModel):
    totals: AcrTotals
    brands: list[AcrBrand]
    own: AcrOwn | None = Field(None, description=(
        "관점 당사(합친 당사) 합계 — KPI 카드 원천. 브랜드 표 상한(top_brands) 밖 당사도 센다. 셀이 없으면 null"))
    trend: AcrTrend
    battle: list[AcrBattleRow]
    model_conversion: list[AcrModelRow]
    territory: list[AcrTerritorySheet]
    options: AcrOptions = Field(default_factory=AcrOptions, description="ACR 모집단 언어·국가 옵션(BG-33). /v1/filters/options 는 답변 모집단이라 다르다")
