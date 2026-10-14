"""analytics.filters.options 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

필드 이름 정본(검증 M1): 현행 프론트 계약 MeasuredScopeCombo {brand, region, lang}
(front/components/dash/dimension-filter-panel.tsx:643)을 따른다. 프론트는 그대로 두고 데이터 함수만 바꾸므로 이름을 바꾸지 않는다.
필드 이름은 현행 프론트 계약 MeasuredScopeCombo {brand, region, lang} 을 따른다(모듈 문서 docs/design/api/모듈-필터.md §2.2 도
같은 이름으로 동기화됨: geo_matrix[{brand, region, lang}]·regions[{code, area, kind}]).

내부 정수 키(geo_key·brand_bit·lang_key·engine_key·category_key·taxon_key)는 응답에 싣지 않는다(core.envelope 규칙).
브랜드는 brand_code, 국가는 코드(ISO·가상), 언어는 소문자 BCP-47, 엔진은 코드, 택소노미는 코드로 낸다.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.core.envelope import Envelope
from app.core.filters import CommonFilters


class GeoCombo(BaseModel):
    """캐스케이드 매트릭스 한 행(현행 MeasuredScopeCombo {brand, region, lang} 과 같은 모양: region = 국가 코드).
    모듈 문서 §2.2 의 {brand, country, lang} 과 같은 값이다(이름만 프론트 계약을 따름)."""
    brand: str | None = Field(description="brand_code. null = 공통(엄브렐러·무브랜드) 프롬프트. 어느 브랜드를 골라도 남는다")
    region: str = Field(description="국가 코드(ISO, 웹사이트는 가상 코드 포함)")
    lang: str | None = Field(description="소문자 BCP-47. null = 언어 태그 없는 프롬프트(국가 옵션에만 기여)")


class RegionOption(BaseModel):
    """국가 옵션 한 행. 모듈 문서 §2.2 의 countries[{code, region, kind}] 와 같은 값(권역 필드 이름 region → area)."""
    code: str = Field(description="국가 코드. geo_matrix 의 region distinct 와 같다")
    area: str | None = Field(description="소속 권역 코드(rd.dim_region, 예: Europe). 없으면 null")
    kind: str = Field(description="iso|pseudo|virtual_brand")


class EngineOption(BaseModel):
    code: str
    is_default: bool


class TaxonOption(BaseModel):
    code: str
    parent_code: str | None = None


class CatalogRow(BaseModel):
    """카탈로그 택소노미 조합 한 행(현행 CatalogTaxonomyRow 계승: 패널이 브랜드·축 선택으로 좁힌다)."""
    brand: str | None = Field(description="brand_code. null = 공통(엄브렐러)")
    funnel: str | None = None
    brand_presence: str | None = None
    list_type: str | None = None
    depth1: str | None = None
    depth2: str | None = None
    depth3: str | None = None
    depth4: str | None = Field(None, description="카탈로그 depth4(BG-03, 현행 CatalogTaxonomyRow.depth4). 분석 축 depth4[] 값")


class CatalogOptions(BaseModel):
    rows: list[CatalogRow]
    funnel: list[TaxonOption]
    brand_presence: list[TaxonOption]
    list_type: list[TaxonOption]
    depth1: list[TaxonOption]
    depth2: list[TaxonOption]
    depth3: list[TaxonOption]
    depth4: list[TaxonOption] = Field(default_factory=list, description="depth4 코드(부모 = depth3, BG-03)")


class SourceCategoryOption(BaseModel):
    slug: str
    name: str
    ord: int


class CustomFieldOption(BaseModel):
    field_id: str
    label: str
    values: list[str]


class OptionsQuery(CommonFilters):
    """F-1 요청: 공통 필터 + include(무거운 선택 필드, WU-12)."""
    include: list[Literal["source_categories"]] = Field(default_factory=list, max_length=1, description=(
        "추가로 계산할 필드. source_categories = 출처 카테고리(창 안 인용 스캔, 옵션 서버 시간의 대부분). 주지 않으면 그 필드는 null"))
    geo_only: bool = Field(False, description=(
        "B095: true = 국가 옵션만 쓰는 화면(전환). 카탈로그 택소노미(global = rd.dim_taxon·카탈로그 2문장, project = 프로젝트 프롬프트)와 "
        "커스텀 필드 문장을 돌리지 않고 catalog·custom_fields 를 null 로 둔다. geo_matrix·regions·languages·engines·meta 는 같다"))


class OptionsData(BaseModel):
    geo_matrix: list[GeoCombo] = Field(description="옵션 창 안에서 측정된 브랜드×국가×언어 조합(스코프 적용, 사용자 선택으로 좁히지 않음)")
    regions: list[RegionOption] = Field(description="geo_matrix 의 국가 목록(숨김 국가 제외)")
    languages: list[str] = Field(description="geo_matrix 의 언어 목록(하위호환 단순 목록)")
    engines: list[EngineOption] = Field(description="옵션 창 안에서 실제 측정된 엔진")
    catalog: CatalogOptions | None = Field(description="카탈로그 택소노미(global = rd.catalog_entry, project = app.prompt). website 는 null(택소노미 축 없음). "
                                                       "geo_only=true 면 null")
    source_categories: list[SourceCategoryOption] | None = Field(description=(
        "옵션 창(인용 계열 숨김 적용) 안에 인용 원소가 있는 출처 카테고리. include=source_categories 를 줄 때만 계산하고, 주지 않으면 null"
        "(요청하지 않음. 빈 목록 [] 은 '계산했는데 없음'). 현행 화면의 출처 필터는 정적 카테고리 목록이라 이 값을 쓰지 않는다(WU-12)"))
    custom_fields: list[CustomFieldOption] | None = Field(description="프로젝트 커스텀 필드(surface=project 만, 그 밖은 null). geo_only=true 면 null")


OptionsResponse = Envelope[OptionsData]
