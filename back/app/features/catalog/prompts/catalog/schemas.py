"""catalog.prompts.catalog 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

요청 = CommonFilters(공통 필터 모델) + 모듈 확장 파라미터(모듈-프롬프트.md 2-1).
- surface 는 global|website 만(project 는 프로젝트 모듈 소관이라 422).
- 목록은 data.items + meta.page(core.envelope 규약). 모듈 문서의 data.rows·next_cursor·total 은 meta.page 로 옮겼다.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.core.filters import CommonFilters

WebsiteSort = Literal["prompt", "brand", "country", "lang", "target_url", "answers", "last_measured"]
ExportFormat = Literal["json", "csv", "xlsx"]
ExportColumns = Literal["api", "screen"]
EXPORT_LOCALES = ("ko", "en")
KINDS = ("single", "acr")


class CatalogQuery(CommonFilters):
    """GET /v1/prompts 쿼리. 리스트 축은 같은 이름을 반복해 보낸다(?kind=single&kind=acr)."""
    surface: Literal["global", "website"] = Field(description="global|website (project 는 422)")
    search: str | None = Field(None, max_length=200, description="global: text ILIKE, website: prompt_text·target_url ILIKE(%·_·\\ 는 글자 그대로)")
    measured: bool | None = Field(None, description="true = scope_prompt_id 있음(측정 대상), false = 미측정(D15 배지)")
    kind: list[Literal["single", "acr"]] = Field(default_factory=list, max_length=2, description="global 전용")
    depth4: list[str] = Field(default_factory=list, max_length=200, description="global 전용")
    sort: WebsiteSort | None = Field(None, description="website 전용. 기본 last_measured. global 은 depth1,depth2,depth3,text,prompt_id 고정")
    dir: Literal["asc", "desc"] | None = Field(None, description="website 전용. 기본 desc")
    cursor: str | None = Field(None, max_length=4096, description="키셋 커서(이전 응답 meta.page.next_cursor)")
    limit: int | None = Field(None, description="website 기본 50·상한 200, global 기본 500·상한 500")
    format: ExportFormat = Field("json", description="json(기본)·csv·xlsx. csv·xlsx 는 cursor·limit 무시, 같은 필터·정렬로 상한 50,000행")
    # BG-34(선택, 추가형): global 전량 모드. 한 번에 상한(service.GLOBAL_ALL_MAX)까지, 넘으면 next_cursor 로 이어 받는다
    all: bool = Field(False, description="global 전용 전량 모드: 한 응답에 상한 25,000행까지(넘으면 meta.page.next_cursor 로 이어서). "
                                         "함께 준 limit 은 형식만 검증(1~500, 밖이면 422)하고 쓰지 않는다(meta.ignored_filters 에 limit). "
                                         "website 는 meta.ignored_filters")
    # BG-35(선택, 추가형): 웹사이트 내보내기를 현행 화면 파일 모양(front app/api/website/prompts/export/route.ts)으로
    columns: ExportColumns = Field("api", description="내보내기 열 모양. api(기본) = 응답 열 키·코드 원값 전 열, "
                                                       "screen = 현행 화면 파일 8열(라벨·국가/언어 표시명·'측정 없음' 문구, website·csv|xlsx 전용)")
    # 검증 m4: front 내보내기 링크는 늘 &locale= 를 싣는다(export-button.tsx:22-26). 추가 전에는 모르는 파라미터라 무시(200)였으므로
    # columns=screen 이 아닐 때는 값과 무관하게 무시한다(json 은 meta.ignored_filters 에 locale, 파일 응답은 표시 없음).
    locale: str | None = Field(None, max_length=35, description="columns=screen 의 머리글·표시명·파일 이름 언어(ko|en, 생략 = ko, 그 밖 값은 422). "
                                                                "columns=screen 이 아니면 쓰지 않는다(무시, json 은 meta.ignored_filters)")

    @field_validator("search")
    @classmethod
    def _search(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if any(ord(ch) < 32 or ord(ch) == 127 for ch in v):
            raise ValueError("search 에 제어 문자 금지")
        return v or None

    @model_validator(mode="after")
    def _export_shape(self) -> CatalogQuery:
        """columns=screen 은 웹사이트 내보내기(csv·xlsx) 전용. locale 은 screen 일 때만 ko|en 검증(그 밖 값 422),
        screen 이 아니면 쓰지 않는 값이라 무시한다(추가 전 동작 보존, 검증 m4)."""
        if self.columns == "screen" and (self.surface != "website" or self.format == "json"):
            raise ValueError("columns=screen 은 surface=website 의 format=csv|xlsx 전용")
        if self.columns == "screen" and self.locale is not None and self.locale not in EXPORT_LOCALES:
            raise ValueError("locale 은 ko|en")
        return self

    @field_validator("depth4")
    @classmethod
    def _depth4(cls, v: list[str]) -> list[str]:
        for x in v:
            if not x or len(x) > 100 or any(ord(ch) < 32 or ord(ch) == 127 for ch in x):
                raise ValueError("depth4 값 형식 오류")
        return v


class GlobalPromptRow(BaseModel):
    """글로벌 표준 카탈로그 행(app.prompt, 루트 프로젝트, soft-delete 제외)."""
    prompt_id: uuid.UUID
    text: str
    kind: str
    scope_prompt_id: uuid.UUID | None
    measured: bool = Field(description="scope_prompt_id 있음(D15: 없으면 '미측정' 배지)")
    brand_code: str | None
    brand_presence: str | None
    brand_presence_effective: str | None = Field(description="명시값 우선, 없으면 엄브렐러=unbranded, 그 밖 브랜드=branded, 브랜드 없음=null")
    prompt_type: str | None
    category: str | None
    list_type: str | None
    depth1: str | None
    depth2: str | None
    depth3: str | None
    depth4: str | None
    funnel_stage: str | None
    lang: str | None
    regions: list[str] | None


class WebsitePromptRow(BaseModel):
    """웹사이트 카탈로그 행(app.website_prompt ⋈ app.website_site) + 측정 메타(rd.answer 원시 카운트, 게이트 없는 측정 회차: 현행 패리티)."""
    website_prompt_id: uuid.UUID
    prompt_text: str
    brand_code: str
    country_code: str
    lang_code: str
    target_url: str
    domain: str
    owned_base_url: str | None
    scope_prompt_id: uuid.UUID | None
    measured: bool
    answers: int = Field(description="측정 렌즈(engine[]·from/to) 안 완료·비드롭 답변 수(게이트 없음)")
    last_measured: date | None = Field(description="렌즈 안 최근 round_date(없으면 null)")
    engines: list[str] = Field(description="렌즈 안 측정 엔진 코드(정렬)")


GLOBAL_COLUMNS: tuple[str, ...] = tuple(GlobalPromptRow.model_fields)
WEBSITE_COLUMNS: tuple[str, ...] = tuple(WebsitePromptRow.model_fields)
