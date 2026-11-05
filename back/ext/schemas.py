"""The response shapes of the prompt and reference API, for its OpenAPI document (docs/ssot-staging/service/openapi.json). Handlers build
their responses in app.py; these models describe them and are checked against real responses by ext/tests/test_app.py."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Unknown(BaseModel):
    """A stored code the code tables do not know. The request still succeeds."""
    code: None = None
    raw: int


class Meta(BaseModel):
    contract_version: str = Field(description="계약 버전. 바뀌면 프로젝트 · 프롬프트 · 기준정보를 전부 다시 읽는다")
    as_of: datetime | None = Field(description="마지막으로 성공한 입력 가져오기 시각")


class PromptsMeta(Meta):
    next_after_seq: int = Field(description="다음 요청의 after_seq")
    has_more: bool


class ReferenceMeta(Meta):
    etag: str = Field(description="이 종류의 etag. 목록의 etag와 같으면 다시 읽지 않아도 된다")
    change_seq: int
    next_after_key: str = Field(description="다음 요청의 after_key")
    has_more: bool


class ProjectRow(BaseModel):
    id: str
    status: str = Field(description="active가 아니면 surface가 오지 않는다")
    surface: str | Unknown | None = Field(None, description="global · website · project")
    change_seq: int = Field(description="정의 또는 측정 설정이 마지막으로 바뀐 순번")
    reset_seq: int = Field(description="이 값이 내가 든 after_seq보다 크면 그 프로젝트의 프롬프트를 0부터 다시 읽는다")
    etag: str


class WebUnit(BaseModel):
    file_seq: int | None = Field(description="website 측정 단위 번호. 프롬프트의 unit_file_seq와 같다")
    lang_codes: list[str]
    base: str | None = Field(description="기준 URL. 선언된 값만 온다")


class TrackedTarget(BaseModel):
    kind: Literal["brand", "model"] = Field(description="경쟁 브랜드 또는 모델")
    name: str
    brand: str | None = Field(None, description="모델의 브랜드")


class Measurement(BaseModel):
    """측정 설정. 아직 정하지 않은 값은 비어 있다."""
    brands: list[str] = Field(description="측정할 브랜드. brand_bit 코드")
    countries: list[str] = Field(description="측정할 국가. country 코드")
    engines: list[str] = Field(description="AI 엔진. engine 코드")
    cadence: Literal["weekly", "biweekly", "monthly"] | None = Field(description="측정 주기")
    acr_repeats: int | None = Field(description="ACR 측정에서 셀마다 반복하는 횟수")
    web_units: list[WebUnit]
    owned_urls: list[str] = Field(description="소유 URL")
    tracked_urls: list[str] = Field(description="추적 URL")
    tracked_targets: list[TrackedTarget] = Field(description="추적 대상")


class CustomField(BaseModel):
    field_id: str
    label: str
    archived: bool
    created_at: datetime | None = None


class Project(BaseModel):
    """active가 아닌 프로젝트는 id · status · 순번 · etag만 온다."""
    id: str
    status: str
    change_seq: int
    reset_seq: int
    etag: str
    recorded_at: datetime
    origin: str | None = None
    name: str | None = None
    surface: str | Unknown | None = None
    is_root: bool | None = Field(None, description="Global 카탈로그 프로젝트")
    site_brands: list[str | Unknown] | None = Field(None, description="website 측정 사이트의 브랜드")
    country: str | None = None
    regions: list[str] | None = None
    brands: Any = None
    domain: str | None = None
    custom_fields: list[CustomField] | None = Field(None, description="커스텀 태그 컬럼. 값은 프롬프트의 custom_values")
    measurement: Measurement | None = Field(None, description="측정 설정")


class CatalogRow(BaseModel):
    catalog_row_id: Any = None
    brands: list[str | Unknown]
    kind: str | None = None
    funnel: str | None = None
    brand_presence: str | None = None
    list_type: str | None = None
    depth1: str | None = None
    depth2: str | None = None
    depth3: str | None = None
    depth4: str | None = None


class Prompt(BaseModel):
    """상태는 active · draft · paused · archived · removed다. active가 아니면 id · project_id · status · 순번 · etag만 온다."""
    id: str
    project_id: str
    status: Literal["active", "draft", "paused", "archived", "removed"]
    change_seq: int
    etag: str
    recorded_at: datetime
    origin: str | None = None
    text: str | None = None
    surface: str | Unknown | None = None
    kind: str | None = Field(None, description="측정 종류. single · acr")
    language: str | None = None
    regions: list[str] | None = Field(None, description="측정 국가")
    in_catalog: bool | None = None
    funnel: str | None = None
    brand_presence: str | None = None
    list_type: str | None = None
    depth1: str | None = None
    depth2: str | None = None
    depth3: str | None = None
    depth4: str | None = None
    catalogs: list[CatalogRow] | None = Field(None, description="Global 카탈로그의 브랜드별 행")
    unit_file_seq: int | None = Field(None, description="website 측정 단위 번호")
    target_url: str | None = Field(None, description="타겟 URL(website)")
    custom_values: dict[str, Any] | None = Field(None, description="커스텀 태그 값. 키는 custom_fields의 field_id")


class ReferenceFamily(BaseModel):
    family: str = Field(description="내 호출자 종류가 읽을 수 있는 기준정보 종류")
    item_count: int
    change_seq: int
    etag: str


# ── 기준정보 항목: 종류마다 key와 아래 값 ──────────────────────────────────────────────────────────────────

class ReferenceItemBase(BaseModel):
    key: str


class EngineItem(ReferenceItemBase):
    """engine (수집)"""
    code: str
    is_default: bool | None = None


class CountryItem(ReferenceItemBase):
    """country (수집)"""
    code: str
    region: str | None = None
    kind: str | None = None
    hidden_standard: bool | None = None
    virtual_brand_bit: int | None = None


class LanguageItem(ReferenceItemBase):
    """language (수집)"""
    code: str


class KeywordCondition(BaseModel):
    location_code: int
    language_code: str


class InterestKeywordItem(ReferenceItemBase):
    """interest_keyword (수집): 글로벌 키워드 카탈로그. brands가 비면 모든 브랜드 공통"""
    term: str
    term_norm: str
    conditions: list[KeywordCondition]
    source_types: list[str]
    brands: list[str]


class InterestSourceItem(ReferenceItemBase):
    """interest_source (수집): 글로벌 소스 URL"""
    source_key: str
    url: str
    channel: str
    brands: list[str]


class TaxonItem(ReferenceItemBase):
    """taxon (분석): 프롬프트 분류. path는 상위 코드"""
    axis: str
    code: str
    path: list[str]


class BrandItem(ReferenceItemBase):
    """brand (분석): 자사 브랜드"""
    name: str
    bare: str
    own_bit: int


class SourceOverrideItem(ReferenceItemBase):
    """source_override (분석): 도메인 큐레이션"""
    skey: str
    category: str


class SourceSeedItem(ReferenceItemBase):
    """source_seed (분석): 도메인 → 출처 카테고리 시드"""
    skey: str
    category: str


class SocialMatcher(BaseModel):
    prefix: str
    boundary: bool


class SourceSocialItem(ReferenceItemBase):
    """source_social (분석): 공식 소셜 계정과 URL 매칭 규칙"""
    skey: str
    domain: str
    category: str
    matchers: list[SocialMatcher]


class SourceCodeItem(ReferenceItemBase):
    """source_code (분석): 출처 카테고리 13개와 분류 출처 6개"""
    kind: Literal["category", "layer"]
    code: str
    number: int
    name_en: str
    name_ko: str
    ord: int
    description: str | None = None


class EntityRoleItem(ReferenceItemBase):
    """entity_role (분석): 사람이 정한 역할만 온다. 없는 엔티티는 경쟁사"""
    entity_id: str
    rep_name: str
    role: Literal["own", "excluded"]
    brand: str | None = None


class SurfaceItem(ReferenceItemBase):
    """surface (분석)"""
    value: int
    code: str


class BrandBitItem(ReferenceItemBase):
    """brand_bit (분석)"""
    bit: int
    code: str


class MentionTypeItem(ReferenceItemBase):
    """mention_type (분석)"""
    code: str


ReferenceItem = (EngineItem | CountryItem | LanguageItem | InterestKeywordItem | InterestSourceItem | TaxonItem | BrandItem | SourceOverrideItem
                 | SourceSeedItem | SourceSocialItem | SourceCodeItem | EntityRoleItem | SurfaceItem | BrandBitItem | MentionTypeItem)


# ── 응답 ────────────────────────────────────────────────────────────────────────────────────────────────

class ProjectList(BaseModel):
    items: list[ProjectRow]


class PromptList(BaseModel):
    items: list[Prompt]


class FamilyList(BaseModel):
    families: list[ReferenceFamily]


class ReferenceItems(BaseModel):
    family: str
    items: list[ReferenceItem]


class ProjectsResponse(BaseModel):
    data: ProjectList
    meta: Meta


class ProjectResponse(BaseModel):
    data: Project
    meta: Meta


class PromptsResponse(BaseModel):
    data: PromptList
    meta: PromptsMeta


class FamiliesResponse(BaseModel):
    data: FamilyList
    meta: Meta


class ReferenceResponse(BaseModel):
    data: ReferenceItems
    meta: ReferenceMeta


class Health(BaseModel):
    ok: bool


class ErrorDetail(BaseModel):
    code: Literal["unauthorized", "not_found", "method_not_allowed", "invalid_value", "rate_limited", "source_unavailable"]
    message: str


class ErrorResponse(BaseModel):
    model_config = ConfigDict(json_schema_extra={"example": {"error": {"code": "unauthorized", "message": "Send Authorization: Bearer <API key>"}}})
    error: ErrorDetail
