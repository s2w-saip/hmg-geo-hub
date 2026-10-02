"""공통 필터 모델(CommonFilters)과 읽기 문맥 해석(resolve_read_context).

- CommonFilters 는 FastAPI query parameter model 이다: `filters: Annotated[CommonFilters, Query()]`.
  own_brand 는 입력받지 않는다(서버 결정). from/to 는 둘 다 주면 from ≤ to(아니면 422). 한쪽만 주면(fe-u1 요청 5) resolve_read_context 가
  front resolveDateRange(lib/hgh/query.ts:230-255)와 같은 규칙으로 닫는다: 빠진 to = 최신 회차(GET /v1/filters/dates 기본 family
  mentions 의 latest_round_date, 없으면 오늘 KST), 빠진 from = first_measured_date(없으면 to), 뒤집히면 준 쪽으로 접는다(하루 창, 검증 V6-1).
  ReadContext 는 늘 양쪽이다.
- 엔드포인트마다 표면별 지원 축(FilterSupport)을 선언한다. 선언 밖 축이 들어오면 무시하고 meta.ignored_filters 에 적는다.
- 권한 밖·알 수 없는 값은 버리고 meta.dropped_filters 에 적는다. 축을 줬는데 남는 값이 없으면 그 축은 빈 집합(결과 0, fail-closed).
- 스코프는 서버가 계산한다(DataScope). 계정 스코프 자체가 비면 403(default-deny).
- ReadContext.measure() 가 core.measure 빌더 입력(MeasureScope, 활성 현행 프로필 core.profile 포함)을, ReadContext.window() 가 core.cycles 창을 만든다.
- 표면 경로 게이트(core.auth.require_surface: 역할 천장 + menu_groups)를 resolve_read_context 첫 줄에서 건다(분석 읽기 일괄).
  관리 기능(라우터가 require_admin·require_menu_group('admin') 으로 이미 막는 경로)은 surface_gate=False 로 부른다(표면 게이트 대상 아님).
- cf.* 커스텀 필드는 custom_fields(parse_custom_fields 결과) 또는 query_params(request.query_params)로 넘긴다. 둘 다 없으면 cf.* 를 알 수 없다.
- CommonFilters 를 받지 않는 엔드포인트(CRUD·관리·세션·적재 운영)는 ignored_axes(request.query_params, …)로 들어온 공통 축을
  meta.ignored_filters 에 적는다(쿼리 이름 → 축 이름표 = query_axes(), 이 모듈 한 벌).
- 자유 문자열 입력(본문·쿼리)은 PgText(여러 줄)·PgLine(한 줄) 타입으로 받는다: NUL·서로게이트(·한 줄은 제어 문자)를 422 로 거부.
  빠뜨려도 DB 가 22xxx 로 거부하면 core.errors 전역 처리기가 422 invalid_value 로 바꾼다(최후 방어).
- 카탈로그(app.prompt) 스코프 술어 3종(catalog_brand_scope·catalog_market_scope·catalog_market_filter)도 여기 한 벌이다(P-1·P-2·관리 카탈로그).
- from·to 허용 범위 = DATE_MIN~DATE_MAX(2000-01-01~2100-12-31, catalog history 운영 범위와 같다. 밖이면 422). 파생 창 산술(직전 구간·달력 월)이 달력 끝에서 넘치지 않게 한다.
- surface=global 의 project_id 는 값을 바꾸지 않으므로(루트 고정) meta.ignored_filters 에 'project_id' 로 적는다.
- depth4(BG-03, 선택 축): 카탈로그 depth4(app.prompt.depth4, rd.dim_taxon 축 아님)를 프롬프트 키로 푼다. 다른 공통 축과 같이 준 축(provided)
  으로 세므로 지원 선언하지 않은 엔드포인트는 meta.ignored_filters 에 'depth4' 로 적는다(검증 D2: 선언 밖 축은 조용히 무시하지 않는다).
  카탈로그 /v1/prompts(global)는 자체 술어로 depth4 를 쓰므로 CATALOG_SUPPORT 에 선언한다(resolve_taxonomy=False 라 여기서는 풀지 않는다).
  global = 관점 카탈로그 행(rd.catalog_entry.brand_bit ∈ pop_bits, catalog_row_id = app.prompt.prompt_id)의 depth4 정확 일치(다른 택소노미
  축과 같은 행 조건), 그 행 범위에 없는 값은 dropped(결과 0, fail-closed. 검증 D5: 타 브랜드 카탈로그 행의 depth4 존재·연결이 드러나지
  않게 옵션 F-1 catalog.depth4 와 같은 행 범위), project = 그 프로젝트 app.prompt.depth4 정확 일치.
- 글로벌 택소노미 축(funnel·brand_presence·list_type·depth1~3)도 같은 규칙(제품 결정 7, 2026-09-30): 행 매칭·dropped 판정 모두 관점 카탈로그 행
  (brand_bit ∈ pop_bits). 관점 행에 없는 값은 dropped(결과 0). 옵션(F-1 catalog)과 같은 행 범위라 옵션 ⊇ 데이터.

기능 추가 파라미터(limit·cursor·kind 등): FastAPI 는 쿼리 모델(Annotated[CommonFilters, Query()])과 다른 Query 인자를 섞으면 모델을
'filters' 필드 하나로 취급해 422 가 난다. 기능 인자는 CommonFilters 를 상속한 쿼리 모델 하나에 더한다:
    class DomainsQuery(CommonFilters):
        limit: int = Field(50, ge=1, le=200)
        cursor: str | None = None
    async def list_domains(user: CurrentUser, conn: RoConn, q: Annotated[DomainsQuery, Query()]): ...
자유 문자열 파라미터(검색어·경로 키)는 SAFE_TEXT 패턴(제어 문자 배제)을 Field·Path pattern= 으로 건다(길이는 min/max_length).

관점 브랜드(own_brand) 규칙(DESIGN-CONTRACT §2, QUERY-FIXES 공통 기호, 모듈-KPI §5)
- global·website: 계정 브랜드 스코프(scope_all 이면 엄브렐러 제외 전 브랜드) ∩ brand[](주면). 교집합이 비면 스코프 전체.
  관점 비트 = 브랜드별 당사 열 비트(하위 브랜드는 부모 비트로 접음). 현대 계정 = {1}, 기아 {2}, 제네시스 {4}, 전사 {1,2,4}.
- global 모수 bgrp = 카탈로그 비트 v 중 v & (관점 브랜드 비트 | 엄브렐러 비트) ≠ 0(standard-filters.ts:64), website = 사이트 브랜드 비트.
- project: 프로젝트 브랜드(app.project.brand_code, 없으면 3사). bgrp 술어 없음(프로젝트 키로 고정).
"""
from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator

from app.core import errors
from app.core.auth import (
    DataScope,
    Principal,
    ProjectAccess,
    ProjectLevel,
    require_surface,
    resolve_project,
)
from app.core.codes import SURFACE_CODE, ProjectDim, Refs, Surface, brand_masks, load_refs
from app.core.cycles import Window, resolve_window, selectable_round_dates
from app.core.db import fetch_all, fetch_val
from app.core.facts import fact_tables
from app.core.measure import R09_FALLBACK_AXES, MeasureScope, OwnerScope, R09Request, allowed_owner_keys
from app.core.profile import active_profile
from app.core.sqlb import Binder

log = logging.getLogger("hgh.filters")

Axis = Literal["brand", "country", "lang", "engine", "period", "funnel", "brand_presence", "list_type",
               "depth1", "depth2", "depth3", "depth4", "source", "custom"]
TAXONOMY_AXES = ("funnel", "brand_presence", "list_type", "depth1", "depth2", "depth3")
DEPTH4_AXIS = "depth4"           # 선택 축(BG-03): TAXONOMY_AXES 밖(rd.dim_taxon 축 아님). 비선언 엔드포인트는 ignored(모듈 머리 주석)
ALL_AXES: tuple[str, ...] = ("brand", "country", "lang", "engine", "period", *TAXONOMY_AXES, DEPTH4_AXIS, "source", "custom")
SAFE_TEXT = r"^[^\x00-\x1f\x7f]+$"           # 자유 문자열 값 규칙(제어 문자·NUL 배제). NUL 이 DB 까지 가면 드라이버 인코딩 오류가 된다
_VALUE_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,100}$")
DATE_MIN = date(2000, 1, 1)                     # from·to 허용 범위(파생 창 산술이 달력 끝에서 OverflowError 를 내지 않게)
DATE_MAX = date(2100, 12, 31)
_CF_RE = re.compile(r"^cf\.([0-9a-fA-F-]{36})$")

# ── 자유 문자열 입력 타입 ──
# PostgreSQL text 는 NUL(U+0000)을 담지 못하고(asyncpg 22021), 짝 없는 서로게이트(U+D800~DFFF)는 UTF-8 로 인코딩되지 않는다.
_PG_UNSAFE = re.compile(r"[\x00\ud800-\udfff]")
_LINE_UNSAFE = re.compile(r"[\x00-\x1f\x7f\ud800-\udfff]")


def pg_safe(v: str) -> str:
    """여러 줄 텍스트 검사(NUL·서로게이트 거부). pydantic 검증기로 쓰면 422."""
    if _PG_UNSAFE.search(v):
        raise ValueError("NUL·서로게이트 문자는 쓸 수 없다")
    return v


def single_line(v: str) -> str:
    """한 줄 값 검사(C0 제어 문자·DEL·서로게이트 거부)."""
    if _LINE_UNSAFE.search(v):
        raise ValueError("제어 문자는 쓸 수 없다")
    return v


PgText = Annotated[str, AfterValidator(pg_safe)]
"""여러 줄 자유 텍스트(설명·메모·본문): NUL·서로게이트만 거부."""
PgLine = Annotated[str, AfterValidator(single_line)]
"""한 줄 값(이름·라벨·브랜드·별칭·이메일·URL·검색어): C0 제어 문자·DEL·서로게이트 거부."""


class CommonFilters(BaseModel):
    """모든 읽기 API 공통 필터(명세 §4). 리스트 축은 같은 이름을 반복해 보낸다(?country=US&country=GB)."""
    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    surface: Surface = Field(description="global|website|project")
    project_id: uuid.UUID | None = Field(None, description=(
        "project 표면 필수. website 는 사이트 하나로 좁힐 때(선택). project 표면은 커스텀 필드 필터 cf.<field_uuid>=값(동적 키, 반복)도 받는다: "
        "한 필드 안 값은 OR, 필드끼리 AND, 키 형식 오류 422, 빈 값만 준 필드는 결과 0. 다른 표면의 cf.* 는 meta.ignored_filters 'custom'"))
    brand: list[str] = Field(default_factory=list, max_length=20, description="관점 브랜드 좁히기(스코프 안). brand_code")
    country: list[str] = Field(default_factory=list, max_length=300, description="ISO 국가(웹사이트는 가상 코드 포함)")
    lang: list[str] = Field(default_factory=list, max_length=100)
    engine: list[str] = Field(default_factory=list, max_length=20, description="엔진 코드. 없으면 기본 엔진(dflt)")
    from_: date | None = Field(None, alias="from", description="앵커(round_date) 시작. to 만 주면 first_measured_date 로 채운다")
    to: date | None = Field(None, description="앵커(round_date) 끝. from 만 주면 최신 회차(latest_round_date, 없으면 오늘 KST)로 채운다")
    funnel: list[str] = Field(default_factory=list, max_length=100)
    brand_presence: list[str] = Field(default_factory=list, max_length=10)
    list_type: list[str] = Field(default_factory=list, max_length=100)
    depth1: list[str] = Field(default_factory=list, max_length=200)
    depth2: list[str] = Field(default_factory=list, max_length=200)
    depth3: list[str] = Field(default_factory=list, max_length=200)
    depth4: list[str] = Field(default_factory=list, max_length=200,
                              description="카탈로그 depth4(BG-03). 지원 축으로 선언한 엔드포인트만 적용(그 밖은 meta.ignored_filters)")
    source: list[str] = Field(default_factory=list, max_length=50, description="인용 출처 카테고리 slug")
    card: bool = Field(False, description=(
        "대시보드 카드 경로 요청(global·website). 현행 프로필(운영 hmg-geo 재현 스위치)의 카드 정의를 쓴다: card_slot_rep(기간 창 = 자리마다 "
        "대표 회차 하나)·summary_all_engines(엔진 필터 없음 = 전 엔진)·web_registered_only(website 모수 = 보고서 유닛 소속). "
        "스위치가 꺼져 있거나 project 표면이면 효과 없음"))

    @model_validator(mode="after")
    def _check(self) -> CommonFilters:
        if self.from_ is not None and self.to is not None and self.from_ > self.to:
            raise ValueError("from ≤ to")
        for d in (self.from_, self.to):
            if d is not None and not (DATE_MIN <= d <= DATE_MAX):
                raise ValueError(f"from·to 허용 범위: {DATE_MIN}~{DATE_MAX}")
        for name in ("brand", "country", "lang", "engine", "source", *TAXONOMY_AXES, DEPTH4_AXIS):
            for v in getattr(self, name):
                if not _VALUE_RE.match(v):
                    raise ValueError(f"{name} 값 형식 오류")
        return self

    def provided(self) -> set[str]:
        """사용자가 준 축(period 포함)."""
        out = {a for a in ("brand", "country", "lang", "engine", "source", *TAXONOMY_AXES, DEPTH4_AXIS) if getattr(self, a)}
        if self.from_ is not None or self.to is not None:
            out.add("period")
        return out


@dataclass(frozen=True)
class FilterSupport:
    """엔드포인트의 표면별 지원 축. 선언 밖 축은 무시(meta.ignored_filters)."""
    global_: frozenset[str] = frozenset()
    website: frozenset[str] = frozenset()
    project: frozenset[str] = frozenset()

    def for_surface(self, surface: str) -> frozenset[str]:
        return {"global": self.global_, "website": self.website, "project": self.project}[surface]

    @classmethod
    def of(cls, *, global_: tuple[str, ...] = (), website: tuple[str, ...] = (), project: tuple[str, ...] = ()) -> FilterSupport:
        for axes in (global_, website, project):
            bad = set(axes) - set(ALL_AXES)
            if bad:
                raise ValueError(f"알 수 없는 축: {bad}")
        return cls(frozenset(global_), frozenset(website), frozenset(project))


# 대시보드 지표 공통(K-1·K-2·K-3·T-1 기준). lang[] 은 세 표면 모두(BG-01, 모듈-KPI §2 축 표 "전부": 글로벌 M05 는 언어로 좁힌
# 허용 배열이면 core.measure 원소 스캔 경로). depth4 는 global·project(BG-03, 선택 축).
KPI_SUPPORT = FilterSupport.of(
    global_=("brand", "country", "lang", "engine", "period", *TAXONOMY_AXES, DEPTH4_AXIS),
    website=("brand", "country", "lang", "engine", "period"),
    project=("country", "lang", "engine", "period", *TAXONOMY_AXES, DEPTH4_AXIS, "custom"),
)


def query_axes() -> dict[str, str]:
    """쿼리 파라미터 이름 → 축 이름(정본). CommonFilters 필드·별칭에서 파생: from·to → period, 나머지는 필드 이름.
    surface·project_id 는 같은 이름(표면 없는 엔드포인트에 들어오면 무시 대상), own_brand 는 입력 축이 아니지만(서버 결정)
    들어오면 무시 목록에 적는다. cf.<id> 는 이 표 밖(ignored_axes 가 custom 으로 센다)."""
    return dict(_QUERY_AXES)


def _derive_query_axes() -> dict[str, str]:
    out: dict[str, str] = {}
    for name, f in CommonFilters.model_fields.items():
        out[f.alias or name] = "period" if name in ("from_", "to") else name
    out["own_brand"] = "own_brand"
    return out


_QUERY_AXES: dict[str, str] = _derive_query_axes()


def ignored_axes(query_params: Mapping[str, Any] | Iterable[str], support: FilterSupport | Iterable[str] | None = None,
                 surface: str | None = None, *, consumed: Iterable[str] = (), extra_supported: Iterable[str] = ()) -> list[str]:
    """CommonFilters 를 받지 않는 엔드포인트용: 들어온 공통 필터 축 중 지원하지 않는 것(정렬, meta.ignored_filters).

    query_params     request.query_params(또는 키 목록)
    support          FilterSupport(표면별, surface 가 없으면 세 표면 합집합) 또는 지원 축 이름 목록. None = 지원 축 없음
    consumed         엔드포인트가 자기 파라미터로 쓰는 쿼리 이름(예: research 의 단일 country, ops 의 surface). 축으로 세지 않는다
    extra_supported  지원 목록에 더할 축 이름"""
    if isinstance(support, FilterSupport):
        sup = set(support.for_surface(surface)) if surface else set(support.global_ | support.website | support.project)
    else:
        sup = set(support or ())
    sup |= set(extra_supported)
    skip = set(consumed)
    given: set[str] = set()
    for k in query_params:
        if k in skip:
            continue
        if k.startswith("cf."):
            given.add("custom")
        elif k in _QUERY_AXES:
            given.add(_QUERY_AXES[k])
    return sorted(given - sup)


@dataclass(frozen=True)
class ReadContext:
    surface: str
    sf: int
    principal: Principal
    scope: DataScope
    refs: Refs
    project_keys: tuple[int, ...]
    own_brands: tuple[str, ...]
    own_bits: tuple[int, ...]
    pop_bits: tuple[int, ...]
    bgrps: tuple[int, ...] | None
    geo_keys: tuple[int, ...] | None
    countries: tuple[str, ...] | None          # 유효 국가 ISO(요청 ∩ 스코프, 요청 없으면 스코프). 자사 허용 배열·R09 에 쓴다
    lang_keys: tuple[int, ...] | None
    langs: tuple[str, ...] | None
    engine_keys: tuple[int, ...] | None
    prompt_keys: tuple[int, ...] | None
    source_category_keys: tuple[int, ...] | None
    owner: OwnerScope | None
    date_from: date | None
    date_to: date | None
    ignored_filters: tuple[str, ...] = ()
    dropped_filters: dict[str, tuple[str, ...]] = field(default_factory=dict)
    project: ProjectAccess | None = None
    project_ids: dict[int, str] = field(default_factory=dict)
    # website: 요청 country[] 의 가상 코드(HYUNDAI-N 등)가 풀린 사이트 브랜드 비트, 없으면 None. 계정 스코프의 가상 코드는 싣지 않는다
    # (스코프 사이트 판정은 DataScope.site_allowed, 동기화 S1 BE-8)
    virtual_brand_bits: tuple[int, ...] | None = None
    request_iso: tuple[str, ...] | None = None          # website: country[] 의 ISO 부분(스코프 안), 국가 축을 안 줬으면 None
    # countries 가 계정 스코프에서 왔나(요청 ISO 없음). 계정 원값 국가를 따로 쓰는 소비자(GA4 시장: 요청 ∩ 계정 원값, 요청 없으면 계정 원값)가 본다
    geo_from_scope: bool = False
    # 현행 프로필 web_url_rate(A2, WU-7): 현행 발행값 라우팅 입력(website 만, 그 밖 None). core.measure.url_rates(req=…)에 넘긴다
    r09: R09Request | None = None
    # 대시보드 카드 경로 요청(CommonFilters.card, global·website 만). measure()·window() 가 현행 프로필 카드 스위치 대상으로 싣는다
    card: bool = False
    # 동결 층(freeze_at_publish, S3): 글로벌 추이 격자 요청(현행 X.trendGrid). analytics.trend.series 가 격자 경로에서만 세운다(core.facts.GRID)
    frz_grid: bool = False
    # 동결 층 창 판정(S4, core.cycles 동결 판정): card_window 가 창 회차 전부 동결이면 세운다(core.facts.frozen_read 입력)
    frz_ok: bool = False
    # 동결 층 택소노미 축(S4, frozen_taxon): 글로벌 택소노미 필터의 축별 키. 동결 읽기의 프롬프트 술어(core.measure.frozen_taxon_pred)
    taxon: tuple[tuple[str, tuple[int, ...]], ...] | None = None
    # 동결 읽기 창 회차 키(S4, bind_frozen): 옆 표 술어를 창 회차로 좁힌다(core.measure.MeasureScope.frz_keys)
    frz_keys: tuple[int, ...] | None = None
    # 글로벌 택소노미 요청 값 → 사전 키(S4b): 동결 읽기의 버림(dropped_filters) 판정을 동결 축으로 다시 한다(frozen_drops)
    taxon_codes: tuple[tuple[str, tuple[tuple[str, tuple[int, ...]], ...]], ...] | None = None

    @property
    def web_cumulative(self) -> bool:
        """현행 웹사이트 미러 누적 경로(답변 분석 화면) 요청인가 = website ∧ 카드 경로 아님. 이때 web_registered_only(WEBREG16) 게이트가
        걸리지 않는다(core.measure.web_units 가 MeasureScope.card 로 판정한다. 이 속성은 그 판정의 이름표)."""
        return self.surface == "website" and not self.card

    def website_site_ok(self, country_code: str | None, brand_bit: int | None) -> bool:
        """사이트 하나가 요청 국가 축을 통과하나(front websiteSiteGeoPred 의미: ISO ∨ 가상 브랜드 합집합, 한쪽만이면 그쪽).
        계정 스코프·관점 브랜드(bgrps)는 호출자가 따로 건다(카탈로그 _scoped_sites 처럼 app.website_site 로 사이트를 풀 때: DataScope.site_allowed).
        국가 축을 요청하지 않았으면(geo_from_scope) 통과: 스코프는 호출자가 이미 걸었고, 그때 countries 는 측정 이력이 있는 사이트 국가라
        (동기화 S1 BE-8: 현대 N 계정) 미측정 사이트를 떨어뜨린다. 요청 값이 전부 버려졌으면(countries ()) 통과하지 않는다."""
        cc = (country_code or "").upper()
        vb = set(self.virtual_brand_bits or ())
        if self.request_iso is not None and vb:
            return cc in self.request_iso or brand_bit in vb
        if self.request_iso is not None:
            return cc in self.request_iso
        if vb:
            return brand_bit in vb
        return self.geo_from_scope or self.countries is None or cc in self.countries

    def measure(self) -> MeasureScope:
        return MeasureScope(sf=self.sf, project_keys=self.project_keys, own_bits=self.own_bits, bgrps=self.bgrps,
                            pop_bits=self.pop_bits, geo_keys=self.geo_keys, lang_keys=self.lang_keys,
                            engine_keys=self.engine_keys, prompt_keys=self.prompt_keys, owner=self.owner,
                            source_category_keys=self.source_category_keys,
                            default_engine_keys=self.refs.default_engine_keys if self.refs is not None else (),
                            profile=active_profile(), card=self.card,
                            cat_diff=self.refs.cat_diff if self.refs is not None else None, frz_grid=self.frz_grid,
                            frz_ok=self.frz_ok, taxon=self.taxon, frz_keys=self.frz_keys)

    async def window(self, conn: Any, *, offset: int = 0, today: date | None = None, all_visible: bool = False,
                     ungated: bool = False) -> Window:
        """core.cycles.resolve_window(요청 기간). all_visible·ungated 는 카탈로그 측정 메타 전용(core.cycles 참고)."""
        return await resolve_window(conn, surface=self.surface, project_keys=self.project_keys, date_from=self.date_from,
                                    date_to=self.date_to, offset=offset, today=today, project_ids=self.project_ids,
                                    all_visible=all_visible, ungated=ungated, profile=active_profile(), card=self.card)

    @property
    def agg_unsupported(self) -> bool:
        """현행 집계층이 표현 못 하는 택소노미 축(depth2·depth3)을 건 요청인가. 현행은 그 요청을 기간이면 미러, 스냅샷이면 세부층(생성 시점)으로,
        추이는 미러로 보낸다(server.ts:1918-1926 viaGlobalS1, :3020-3025 viaGlobalSeries, :5134-5145 viaTrend: planTrendRead → aggFallback)."""
        return any(a in AGG_UNSUPPORTED_AXES for a, _ in (self.taxon or ()))

    def bind_frozen(self, frz: bool | None, *, live: bool = False, keys: tuple[int, ...] | None = None) -> ReadContext:
        """동결 판정(Window.frz·TrendGrid 판정) → 이 요청의 문맥(S4). None = 판정 대상 아님(그대로), True = 동결 읽기(frz_ok),
        False = 창에 세대 없는 발행 회차(구멍)가 있다: 현행은 요청 전체를 미러로 폴백한다(lib/summary/read/cycle-set.ts:336-357
        classifyCycleRange holes, :400-401 unpublished-cycle-in-range → server.ts onMirror). 허브의 미러 경로 대응 = 카드가 아닌 요청이라
        card=False 로 내린다(호출자는 창을 다시 푼다: card_window). live=True 면 판정과 무관하게 내린다(현행이 그 요청을 미러로 보내는 다른 사유:
        agg_unsupported)."""
        if frz is None:
            return self
        if frz and not live:
            return replace(self, frz_ok=True, frz_keys=keys)
        return replace(self, card=False, frz_ok=False, frz_grid=False, frz_keys=None)

    async def frozen_drops(self, conn: Any) -> ReadContext:
        """동결 읽기의 택소노미 버림 판정(S4b): 조회 시점 관점 카탈로그(결정 7) 대신 창 동결 회차의 생성 시점 축(frz.card_axis)에 그 값이 있는지로
        다시 판정한다. 필터에 쓰인 값(frozen_taxon_pred 가 거르는 값)과 meta.dropped_filters 가 맞도록. 관점 한정 = 동결 카탈로그 비트가 관점
        모수(bgrps)인 프롬프트의 축만 본다(동결 카드 모수 술어 catalog_all_pred 와 같은 범위). 동결 읽기가 아니거나 택소노미가 없으면 그대로."""
        if not self.frz_ok or not self.taxon_codes or not self.frz_keys:
            return self
        cols = {"funnel": "x.funnel_key", "list_type": "x.list_type_key", "depth1": "x.depth1_key", "depth2": "x.depth2_key",
                "depth3": "x.depth3_key", "brand_presence": "unnest(x.presence_keys)"}
        want = [a for a, _ in self.taxon_codes]
        gate = "" if self.bgrps is None else " AND q.cat_mask = ANY(CAST(:bg AS int2[]))"
        sql = " UNION ".join(
            f"SELECT '{a}' AS ax, {cols[a]} AS k FROM frz.card_axis x JOIN frz.generation g ON g.cyc_key = x.cyc_key AND g.state = 'active' "
            f"JOIN frz.prompt q ON q.gen_key = g.gen_key AND q.prompt_key = x.prompt_key "
            f"WHERE x.cyc_key = ANY(CAST(:ks AS int4[])){gate}" for a in want)
        params: dict[str, Any] = {"ks": list(self.frz_keys)}
        if self.bgrps is not None:
            params["bg"] = list(self.bgrps)
        have: dict[str, set[int]] = {}
        for r in await fetch_all(conn, sql, params):
            if r["k"] is not None:
                have.setdefault(r["ax"], set()).add(int(r["k"]))
        dropped = {k: v for k, v in self.dropped_filters.items() if k not in want}
        for a, codes in self.taxon_codes:
            gone = tuple(c for c, ks in codes if not set(ks) & have.get(a, set()))
            if gone:
                dropped[a] = gone
        return replace(self, dropped_filters=dropped)

    @property
    def own_variant_unsupported(self) -> bool:
        """현행 resolveOwnVariantKey(summary-trend-aggregates.ts:388-397)가 null = 집계층 당사 변형 없음: 관점 브랜드가 둘 이상이면서 전부는 아님
        (생성 변형 = ALL + 브랜드 하나씩, tenant/hmg.ts:244-288). admin 다중 선택·두 브랜드 잠금 계정."""
        if self.refs is None:
            return False
        allbits = {b for b in (self.refs.own_bit_of(x.code) for x in self.refs.real_brands) if b}
        mine = set(self.own_bits)
        return len(mine) > 1 and mine != allbits

    async def frozen_route_reason(self, conn: Any, win: Window, route: str) -> str | None:
        """동결 판정을 통과한 창에서 현행이 그래도 사실표를 떠나는 사유(S4b, FROZEN_ROUTES). None = 동결 읽기, 문자열 = 미러(비카드) 사유.
        self 는 frz_ok 문맥(동결 읽기 술어로 빈 집계를 잰다)."""
        from app.core.measure import frozen_empty_sql

        rule = FROZEN_ROUTES.get((route, self.surface))
        if rule is None:
            return None
        period = win.mode == "cumulative"
        if self.source_category_keys is not None:
            return "unsupported-filter:source-category"                 # 게이트 G2(gate.ts:200-204)
        if self.surface == "website":                                     # 같은 (프로젝트, 주)에 쓸 회차 둘(cycle-set.ts:412-419, 스냅샷 픽 :259-262)
            seen: set[tuple[int, date]] = set()
            for c in win.cycles:
                if c.hidden_scope in (1, 3):
                    continue
                k = (c.project_key, c.round_date - timedelta(days=c.round_date.weekday()))
                if k in seen:
                    return "duplicate-cycle-in-week"
                seen.add(k)
        if (self.agg_unsupported or self.own_variant_unsupported) and (period or rule.plan_live_snapshot):
            return "unsupported-agg:" + ("depth" if self.agg_unsupported else "own-variant")
        if rule.single is not None:
            days = {c.round_date for c in win.cycles if c.cyc_key in set(win.cyc_keys("row"))}
            n = len(days) if rule.single == "day" else len({d - timedelta(days=d.weekday()) for d in days})
            if n < 2:
                return "agg-single-cycle"
        if rule.empty is not None and (period or rule.empty_live_snapshot) and not win.empty:
            q = frozen_empty_sql(self.measure(), win, rule.empty)  # type: ignore[arg-type]
            if await fetch_val(conn, q.text, q.params):
                return "agg-empty"
        return None

    async def card_window(self, conn: Any, *, route: str = "kpi", offset: int = 0,
                          today: date | None = None) -> tuple[ReadContext, Window]:
        """카드 경로 요청의 창 + 동결 판정을 실은 문맥(S4·S4b). 동결 읽기 대상이 아니면 (self, window()) 와 같다.
        구멍(core.cycles.frz_judge)이거나 현행이 그 요청을 사실표에서 내보내는 다른 사유(frozen_route_reason)가 있으면 card=False 문맥과
        그 문맥으로 다시 푼 창(현행 미러 폴백 = 비카드 창)을 돌려준다."""
        win = await self.window(conn, offset=offset, today=today)
        ctx = self.bind_frozen(win.frz, keys=win.all_keys())
        if not self.card or win.frz is None:
            return ctx, win
        if ctx.card:
            why = await ctx.frozen_route_reason(conn, win, route)
            if why is None:
                return await ctx.frozen_drops(conn), win
            log.info("frz card %s %s: %s → 비카드", route, self.surface, why)
            ctx = self.bind_frozen(False)
        return ctx, await ctx.window(conn, offset=offset, today=today)


def parse_custom_fields(query_params: Any) -> dict[str, list[str]]:
    """?cf.<field_id>=값 (반복 가능) → {field_id: [값…]}. 형식이 틀린 키는 무시하지 않고 422."""
    out: dict[str, list[str]] = {}
    for k in {k for k in query_params if k.startswith("cf.")}:
        m = _CF_RE.match(k)
        if not m:
            raise errors.unprocessable("커스텀 필드 키 형식: cf.<field_id>")
        vals = [v for v in query_params.getlist(k) if v]
        if any(not _VALUE_RE.match(v) for v in vals):
            raise errors.unprocessable("커스텀 필드 값 형식 오류")
        out[str(uuid.UUID(m.group(1)))] = vals
    return out


def _site_code(refs: Refs, p: ProjectDim) -> str | None:
    """웹사이트 사이트 차원의 국가 코드(rd.dim_country 원래 표기). 없으면 None."""
    c = refs.country_by_key(p.site_geo_key)
    return c.code if c is not None else None


def _viewpoint(refs: Refs, scope: DataScope, requested: list[str], dropped: dict[str, list[str]]) -> tuple[str, ...]:
    """관점 브랜드: 스코프 브랜드(전사 = 엄브렐러 제외 전 브랜드) ∩ 요청. 알 수 없는·스코프 밖·엄브렐러 값은 dropped."""
    base = [b.code for b in refs.real_brands] if scope.brands is None else [c for c in scope.brands if refs.brand(c)]
    if not base:
        raise errors.forbidden("브랜드 스코프 없음", code="no_brand_scope")
    if not requested:
        return tuple(base)
    keep = []
    for c in requested:
        b = refs.brand(c)
        if b is None or b.is_umbrella or c not in base:
            dropped.setdefault("brand", []).append(c)
        else:
            keep.append(c)
    return tuple(dict.fromkeys(keep)) or tuple(base)


async def _taxonomy_prompt_keys_global(conn: Any, filters: CommonFilters, dropped: dict[str, list[str]],
                                       depth4: Sequence[str] = (), pop_bits: Sequence[int] = (),
                                       axes_out: dict[str, tuple[int, ...]] | None = None,
                                       codes_out: dict[str, tuple[tuple[str, tuple[int, ...]], ...]] | None = None) -> tuple[int, ...] | None:
    axes = [a for a in TAXONOMY_AXES if getattr(filters, a)]
    if not axes and not depth4:
        return None
    rows = await fetch_all(conn, "SELECT taxon_key, axis, code FROM rd.dim_taxon WHERE axis = ANY(CAST(:ax AS text[]))",
                           {"ax": ["presence" if a == "brand_presence" else a for a in axes]})
    by: dict[tuple[str, str], list[int]] = {}
    for r in rows:                      # depth2·3 는 부모가 다르면 같은 코드가 여러 키일 수 있다
        by.setdefault((r["axis"], r["code"]), []).append(int(r["taxon_key"]))
    col = {"funnel": "funnel_key", "brand_presence": "presence_key", "list_type": "list_type_key",
           "depth1": "depth1_key", "depth2": "depth2_key", "depth3": "depth3_key"}
    # 제품 결정 7(2026-09-30, kpi R2): 모든 택소노미 축의 행 매칭과 dropped 판정을 관점 카탈로그 행(brand_bit ∈ pop_bits)으로 한정한다.
    # 예전은 rd.dim_taxon 사전·rd.catalog_entry 전 행이라 타 브랜드 카탈로그 행에만 있는 값을 필터로 주면 그 행과 prompt_key 를 공유하는
    # 데이터가 나왔다(값 존재·연결 오라클). 옵션(F-1 catalog, CATALOG_GLOBAL_SQL)은 이미 같은 행 범위다. depth4 는 검증 D5 에서 먼저 한정.
    bits = sorted({int(x) for x in pop_bits})
    where, params = ["ce.prompt_key IS NOT NULL", "ce.brand_bit = ANY(CAST(:vbits AS int2[]))"], {"vbits": bits}
    for a in axes:
        dbaxis = "presence" if a == "brand_presence" else a
        cand = sorted({k for v in getattr(filters, a) for k in by.get((dbaxis, v), ())})
        seen = {int(r["k"]) for r in await fetch_all(
            conn, f"SELECT DISTINCT ce.{col[a]} AS k FROM rd.catalog_entry ce "
                  f"WHERE ce.brand_bit = ANY(CAST(:vbits AS int2[])) AND ce.{col[a]} = ANY(CAST(:cand AS int2[]))",
            {"vbits": bits, "cand": cand})} if cand else set()
        keys = []
        for v in getattr(filters, a):
            k = [x for x in by.get((dbaxis, v), ()) if x in seen]
            if not k:
                dropped.setdefault(a, []).append(v)
            else:
                keys.extend(k)
        where.append(f"ce.{col[a]} = ANY(CAST(:{a} AS int2[]))")
        params[a] = sorted(set(keys))
        if axes_out is not None:
            # 동결 층 택소노미 축(S4): 요청 값의 사전 키 전부(조회 시점 관점 카탈로그로 버리지 않는다). 동결 회차는 생성 시점 축으로 거르므로
            # 지금 카탈로그에서 사라진 값도 그 회차에는 있을 수 있다(현행 trendWhere 는 값 존재 판정 없이 생성 시점 축 등호)
            axes_out[a] = tuple(sorted({k for v in getattr(filters, a) for k in by.get((dbaxis, v), ())}))
        if codes_out is not None:                     # 동결 읽기 버림 판정(S4b): 요청 값 → 사전 키
            codes_out[a] = tuple((v, tuple(sorted(by.get((dbaxis, v), ())))) for v in dict.fromkeys(getattr(filters, a)))
    if depth4:
        # depth4 는 rd.dim_taxon 축이 아니다: 관점 카탈로그 행(brand_bit ∈ pop_bits)의 app.prompt.depth4 정확 일치(다른 축과 같은 행 조건).
        # 그 행 범위에 없는 값 = dropped(검증 D5: 판정·매칭 모두 관점 행으로 한정, 옵션 F-1 catalog.depth4 와 같은 범위)
        vals = sorted(set(depth4))
        known = {r["depth4"] for r in await fetch_all(
            conn, "SELECT DISTINCT p.depth4 FROM rd.catalog_entry ce JOIN app.prompt p ON p.prompt_id = ce.catalog_row_id "
                  "WHERE ce.brand_bit = ANY(CAST(:d4bits AS int2[])) AND p.depth4 = ANY(CAST(:d4 AS text[]))", {"d4": vals, "d4bits": bits})}
        for v in depth4:
            if v not in known:
                dropped.setdefault(DEPTH4_AXIS, []).append(v)
        where.append("ce.catalog_row_id IN (SELECT p.prompt_id FROM app.prompt p WHERE p.depth4 = ANY(CAST(:depth4 AS text[])))")
        params["depth4"] = sorted(known)
    rs = await fetch_all(conn, f"SELECT DISTINCT ce.prompt_key FROM rd.catalog_entry ce WHERE {' AND '.join(where)}", params)
    return tuple(sorted(int(r["prompt_key"]) for r in rs))


def frozen_taxon(axes: dict[str, tuple[int, ...]], filters: CommonFilters, *, depth4: bool) -> tuple[tuple[str, tuple[int, ...]], ...] | None:
    """동결 층 택소노미 축(S4): 축별 키 → MeasureScope.taxon. 현행 trendWhere 존재 축은 한쪽만 고른 때만 건다(양쪽·0개 = 무필터,
    summary-trend-aggregates.ts:756-763 presenceWant). depth4 는 현행 생성 축에 없다(허브 BG-03 전용) → None(조회 시점 해석 그대로)."""
    if depth4:
        return None
    pres = set(filters.brand_presence or ())
    out = [(a, k) for a, k in sorted(axes.items()) if not (a == "brand_presence" and {"branded", "unbranded"} <= pres)]
    return tuple(out)


AGG_UNSUPPORTED_AXES = ("depth2", "depth3")     # 현행 집계층이 표현 못 하는 축(summary-trend-aggregates.ts:421-430 trendUnsupportedAxisReason)


@dataclass(frozen=True)
class FrozenRoute:
    """카드 경로별 현행 사실표 이탈 규칙(S4b, hmg-geo 2670a16 lib/scope/server.ts). 목적지 '세부층'은 생성 시점 값이라 허브는 동결 읽기 그대로,
    '미러'는 비카드로 내린다. plan_live_snapshot = 스냅샷에서 planTrendRead 거부(depth2·3, 당사 변형 없음)가 미러인가(거짓 = 세부층),
    empty = 빈 집계 판정 종류(None = 그 경로에 빈 집계 분기 없음), empty_live_snapshot = 스냅샷 빈 집계가 미러인가,
    single = 추이 점 하나 판정('day' = 회차 날짜 수 < 2, 'week' = 회차 주 수 < 2, None = 없음). 기간 모드의 plan·빈 집계 목적지는 늘 미러."""
    plan_live_snapshot: bool
    empty: str | None
    empty_live_snapshot: bool
    single: str | None = None


# 현행 근거(서버 주석·코드, 줄 = front 사본): 글로벌 KPI viaGlobalS1 1883-1981(onDetail = 세부층, 기간 aggFallback = 미러 1918-1926), 브랜드
# S1.competitors 4124-4150(onDetail = 미러), 추이 viaGlobalSeries 2972-3041(agg-single-cycle 3014-3019, G_TREND_MIN_CYCLES = 2 :2661),
# GEO 4359-4373(onDetail = 미러, widget-empty = 국가·브랜드 행 0 summary-global-aggregates.ts:1000), 도메인 viaGlobalTrend 2041-2096(미러),
# 웹 KPI·브랜드·GEO·엔진 배지 viaTrend 5095-5162(스냅샷 세부층, 기간 미러, 웹 own keyRows 0 = summary-website-aggregates.ts:488·680),
# 웹 출처 구성 S6.citation(only domains, 빈 집계 사실상 없음 :723-725), 웹 추이 cachedWebsiteTrendSet 4813-4848(weeks < TREND_MIN_CYCLES = 2,
# 빈 집계 분기 없음). 기간 비교는 이 표 밖(폴백 없음, readComparePeriods)
FROZEN_ROUTES: dict[tuple[str, str], FrozenRoute] = {
    ("kpi", "global"): FrozenRoute(False, "answers", False),
    ("brands", "global"): FrozenRoute(True, "answers", True),
    ("geo", "global"): FrozenRoute(True, "answers_brands", True),
    ("domains", "global"): FrozenRoute(True, "citations", True),
    ("trend", "global"): FrozenRoute(True, "answers", True, "day"),
    ("kpi", "website"): FrozenRoute(False, "answers", False),
    ("brands", "website"): FrozenRoute(False, "answers", False),
    ("geo", "website"): FrozenRoute(False, "answers", False),
    ("engines", "website"): FrozenRoute(False, "answers", False),
    ("domains", "website"): FrozenRoute(False, None, False),
    ("trend", "website"): FrozenRoute(True, None, False, "week"),
}


async def _taxonomy_prompt_keys_project(conn: Any, project_id: uuid.UUID, filters: CommonFilters,
                                        custom: dict[str, list[str]]) -> tuple[int, ...] | None:
    axes = [a for a in TAXONOMY_AXES if getattr(filters, a)]
    if not axes and not custom and not filters.depth4:
        return None
    col = {"funnel": "funnel_stage", "brand_presence": "brand_presence", "list_type": "list_type",
           "depth1": "depth1", "depth2": "depth2", "depth3": "depth3"}
    where = ["p.project_id = :pid", "p.deleted_at IS NULL"]
    params: dict[str, Any] = {"pid": project_id}
    for a in axes:
        where.append(f"p.{col[a]} = ANY(CAST(:{a} AS text[]))")
        params[a] = list(getattr(filters, a))
    if filters.depth4:                  # BG-03: 프로젝트 프롬프트 depth4 정확 일치(다른 택소노미 축과 같은 app.prompt 열 비교)
        where.append("p.depth4 = ANY(CAST(:depth4 AS text[]))")
        params["depth4"] = list(filters.depth4)
    for i, (fid, vals) in enumerate(sorted(custom.items())):
        where.append(f"EXISTS (SELECT 1 FROM app.prompt_custom_field_value v WHERE v.prompt_id = p.prompt_id "
                     f"AND v.field_id = CAST(:f{i} AS uuid) AND v.value = ANY(CAST(:fv{i} AS text[])))")
        params[f"f{i}"] = fid
        params[f"fv{i}"] = vals
    rs = await fetch_all(conn, f"SELECT DISTINCT dp.prompt_key FROM app.prompt p JOIN {fact_tables().prompt} dp ON dp.prompt_id = p.scope_prompt_id "
                               f"WHERE {' AND '.join(where)}", params)
    return tuple(sorted(int(r["prompt_key"]) for r in rs))


PERIOD_BOUND_FAMILY = "mentions"      # GET /v1/filters/dates 기본 family(DatesQuery.family)와 같은 게이트


async def close_period(conn: Any, surface: str, project_keys: tuple[int, ...], lo: date | None, hi: date | None) -> tuple[date, date]:
    """한쪽만 준 기간을 닫는다(fe-u1 요청 5). front resolveDateRange(lib/hgh/query.ts:230-255)가 GET /v1/filters/dates 로 하던 일을 서버가 한다:
    빠진 끝 = 같은 표면·프로젝트의 선택 가능 최신 회차(core.cycles.selectable_round_dates, family mentions), 없으면 오늘 KST.
    빠진 시작 = 같은 문장의 최초 회차(first_measured_date), 없으면 끝. 그 뒤 DATE_MIN~DATE_MAX 로 자른다.
    채운 쪽이 준 쪽을 넘어 뒤집히면 **준 쪽으로 접는다**(검증 V6-1): from 이 빠졌으면(to 가 최초 회차보다 이르면) from = to,
    to 가 빠졌으면(from 이 최신 회차보다 늦으면) to = from. 어느 쪽이든 하루 창이라 준 경계 밖 회차는 절대 들어오지 않는다
    (양쪽을 준 from=DATE_MIN&to=같은 날 과 같은 결과). 예전 max(lo, hi) 는 to 만 준 경우 hi 를 최초 회차로 끌어올려 to 이후 데이터를 냈다."""
    from app.core.db import fetch_val

    if (lo is None) == (hi is None):
        raise ValueError("close_period 는 한쪽만 준 기간에만 쓴다")
    given_to = hi is not None
    rd = await selectable_round_dates(conn, surface=surface, project_keys=project_keys, family=PERIOD_BOUND_FAMILY, limit=1)
    if hi is None:
        hi = rd.dates[0] if rd.dates else await fetch_val(conn, "SELECT rd.today_kst()")
    if lo is None:
        lo = rd.first or hi
    lo, hi = min(max(lo, DATE_MIN), DATE_MAX), min(max(hi, DATE_MIN), DATE_MAX)  # type: ignore[type-var]
    if lo > hi:  # type: ignore[operator]
        if given_to:
            lo = hi                                       # to 만 줬다: 최초 회차가 to 보다 늦다 → [to, to]
        else:
            hi = lo                                       # from 만 줬다: 최신 회차가 from 보다 이르다 → [from, from]
    return lo, hi  # type: ignore[return-value]


async def resolve_read_context(conn: Any, principal: Principal, filters: CommonFilters, *, support: FilterSupport,
                               project_level: ProjectLevel = "member", custom_fields: dict[str, list[str]] | None = None,
                               refs: Refs | None = None, surface_gate: bool = True,
                               query_params: Mapping[str, Any] | None = None, resolve_taxonomy: bool = True) -> ReadContext:
    """표면 게이트 → 스코프 ∩ 요청 → ReadContext. conn 은 요청의 api_ro 트랜잭션(같은 스냅샷에서 참조·스코프·데이터를 읽는다).

    surface_gate=False: 표면 경로 게이트(require_surface)를 건너뛴다. 관리 기능 전용(라우터가 require_admin·require_menu_group('admin')
      으로 이미 막는 경로: 예 /v1/admin/citation-overrides/candidates). 데이터 스코프(DataScope)는 그대로 건다.
    query_params: request.query_params. custom_fields 를 따로 주지 않으면 여기서 cf.* 를 읽는다(주지 않으면 cf.* 를 모른다).
    resolve_taxonomy=False: global 택소노미 축을 rd.dim_taxon 사전으로 풀지 않는다(prompt_keys·dropped 없음). app.prompt 열 값을
      요청 값 그대로 비교하는 카탈로그용(front prompt-list-readonly.tsx:172-182, 미발행 행에만 있는 값도 매칭)."""
    if surface_gate:
        require_surface(principal, filters.surface)
    if custom_fields is None and query_params is not None:
        custom_fields = parse_custom_fields(query_params)
    refs = refs or await load_refs(conn)
    surface = filters.surface
    scope = DataScope.of(principal, refs).for_surface(surface)      # website: 도시 의사 코드 scopeParent(front withPseudoCountries)
    if surface != "project" and scope.countries == ():
        raise errors.forbidden("계정 권역이 국가로 풀리지 않음", code="no_country_scope")   # default-deny(검증 B1)
    sf = SURFACE_CODE[surface]
    sup = support.for_surface(surface)
    # depth4(BG-03)도 provided 축이다: 비선언 엔드포인트는 ignored(검증 D2, 선언 밖 축은 조용히 무시하지 않는다)
    given = filters.provided() | ({"custom"} if custom_fields else set())
    ignored = sorted(given - sup)
    if surface == "global" and filters.project_id is not None:
        ignored.append("project_id")          # 글로벌은 루트 프로젝트 고정이라 값을 바꾸지 않는다(조용히 무시하지 않는다)

    def use(axis: str) -> bool:
        return axis in given and axis in sup

    dropped: dict[str, list[str]] = {}

    project: ProjectAccess | None = None
    project_ids: dict[int, str] = {}
    bgrps: tuple[int, ...] | None
    virtual_bits: set[int] = set()

    # ── 국가(스코프 교집합) ──
    req_countries: list[str] = []
    if use("country"):
        for c in filters.country:
            cc = c.upper()
            ref = refs.countries.get(cc)
            if ref is None or (ref.kind != "virtual_brand" and surface != "project" and not scope.country_allowed(cc)):
                dropped.setdefault("country", []).append(c)
                continue
            if ref.kind == "virtual_brand":
                if surface != "website" or ref.virtual_brand_bit is None:
                    dropped.setdefault("country", []).append(c)
                else:
                    virtual_bits.add(int(ref.virtual_brand_bit))
                continue
            req_countries.append(cc)
    iso_req = tuple(sorted(set(req_countries)))
    geo_from_scope = False                                        # 답변 국가 축이 계정 스코프 국가에서 왔나(요청 ISO 없음)
    if use("country") and (iso_req or virtual_bits):
        countries: tuple[str, ...] | None = iso_req if iso_req else scope.countries
        geo_from_scope = not iso_req
    elif use("country"):
        countries = ()                                            # 준 값이 전부 버려짐 → 빈 집합
    else:   # 프로젝트 표면은 멤버십·프로젝트 스코프로 이미 좁혀져 계정 국가 스코프를 답변 축에 걸지 않는다(모듈-필터 열린 질문 6, 잠정)
        countries = scope.countries if surface != "project" else None
        geo_from_scope = surface != "project"
    geo_keys = None if countries is None else tuple(sorted(k for k in (refs.geo_key(c) for c in countries) if k is not None))
    # website 계정 국가 스코프의 브랜드 가상 코드(현대 N 계정의 HYUNDAI-N, 동기화 S1 BE-8): 현행 websiteScopeCountryCondition
    # (website-sites.ts:96-108)은 스코프 국가를 splitWebsiteGeo 로 갈라 country_code ∈ 실 코드 ∨ 사이트 브랜드 ∈ 가상 코드 브랜드로 건다.
    # 사이트 선택은 DataScope.site_allowed(같은 판정), 답변 국가 축은 아래 website 분기가 선택된 사이트 국가로 바꾼다(요청 가상 코드와 같은 방식).
    scope_vbits = set(scope.virtual_brand_bits(refs)) if surface == "website" else set()
    scope_real = tuple(c for c in (scope.countries or ()) if refs.countries.get(c) is None
                       or refs.countries[c].kind != "virtual_brand") if scope_vbits else ()

    # ── 표면별 프로젝트·관점 ──
    brand_narrowed = False
    if surface == "project":
        if filters.project_id is None:
            raise errors.unprocessable("project 표면은 project_id 필수", details={"field": "project_id"})
        project = await resolve_project(conn, principal, refs, filters.project_id, project_level)
        project_keys = project.project_keys
        own = (project.brand_code,) if project.brand_code and refs.own_bit_of(project.brand_code) else \
            tuple(b.code for b in refs.real_brands if b.bit in (1, 2, 4))
        bgrps = None
    else:
        own = _viewpoint(refs, scope, list(filters.brand) if use("brand") else [], dropped)
        # 요청 brand[] 가 관점을 실제로 좁혔나(남은 값이 하나라도 있나). 좁혔으면 글로벌 데이터 축 모수는 그 브랜드 카탈로그 행이 있는
        # 프롬프트만(공통 = 엄브렐러·무브랜드 행 제외): 현행 데이터 리더 전부의 brand 정확 일치(미러 scope-aggregates.ts:2276·:6082·:9261
        # catalogIn, 사전집계 summary-global-aggregates.ts:183 catalog_brands &&). 요청이 없으면 공통 포함(관리자 무필터 = 전 카탈로그,
        # 브랜드 스코프 계정 = 하드락 [스코프 브랜드, HMG](standard-filters.ts:53-64)이고 어댑터가 보내지 않는다(lib/hgh/query.ts:299-302)).
        # 남는 차이: 하드락 계정의 무브랜드(NULL) 프롬프트(현행 제외, 백엔드는 HMG 와 같은 엄브렐러 비트라 포함. stg 0건). 옵션(F-1)은 brand 축 미지원이라 공통 포함.
        brand_narrowed = use("brand") and any(c not in dropped.get("brand", ()) for c in filters.brand)
        if surface == "global":
            project_keys = tuple(p.project_key for p in refs.projects if p.surface == 1 and p.is_root)
            pop = 0 if brand_narrowed else refs.umbrella_bit
            for c in own:
                pop |= refs.brand(c).bit  # type: ignore[union-attr]
            bgrps = tuple(brand_masks(pop, refs.bit_universe))
        else:
            own_site_bits = {refs.brand(c).bit for c in own}  # type: ignore[union-attr]
            # 국가 축에 ISO 와 가상 브랜드 코드가 섞이면 합집합(front website-geo-pred.ts:18-24 websiteSiteGeoPred: 국가 ∈ ISO ∨ 브랜드 ∈ 가상,
            # 분석·카탈로그 공통 scope-aggregates.ts:973·8371·8629). 가상 코드만이면 사이트 브랜드를 그 비트로 좁힌다.
            union = bool(virtual_bits) and bool(iso_req)
            if virtual_bits and not union:
                own_site_bits &= virtual_bits
            elif geo_from_scope and scope_vbits and not scope_real:
                own_site_bits &= scope_vbits          # 스코프 국가가 가상 코드뿐(현대 N 계정): 요청 가상 코드만일 때와 같이 사이트 브랜드를 그 비트로
            sites = [p for p in refs.projects if p.surface == 2 and p.site_brand_bit in own_site_bits
                     and scope.site_allowed(refs, p.site_brand_bit, _site_code(refs, p))]
            if union:
                iso = set(iso_req)
                # 사이트 국가는 rd.dim_country 원표기(worldwide 등), 요청 ISO 는 대문자: 대문자로 비교한다(동기화 S1 검증 F3)
                sites = [p for p in sites if p.site_brand_bit in virtual_bits or (_site_code(refs, p) or "").upper() in iso]
                site_cc = {c.upper() for c in (_site_code(refs, p) for p in sites) if c}
                countries = tuple(sorted(iso | site_cc))
                geo_keys = tuple(sorted(k for k in (refs.geo_key(c) for c in countries) if k is not None))
            elif geo_from_scope and scope_vbits:
                # 답변 국가 축 = 스코프 실 코드 ∪ 선택된 사이트 국가(가상 코드 자체는 답변 국가가 아니다: 현대 N 사이트 답변은 KR·worldwide)
                site_cc = {c.upper() for c in (_site_code(refs, p) for p in sites) if c}      # 대문자 = DataScope·ReadContext.countries 표기
                countries = tuple(sorted(set(scope_real) | site_cc))
                geo_keys = tuple(sorted(k for k in (refs.geo_key(c) for c in countries) if k is not None))
            if filters.project_id is not None:
                pid = str(filters.project_id)
                sites = [p for p in sites if p.project_id == pid or p.site_id == pid]
                if not sites:
                    raise errors.not_found("사이트 없음")
            project_keys = tuple(p.project_key for p in sites)
            project_ids = {p.project_key: (p.site_id or p.project_id or "") for p in sites}
            bgrps = tuple(sorted(own_site_bits))
    own_bits = tuple(sorted({b for b in (refs.own_bit_of(c) for c in own) if b is not None}))
    if not own_bits:
        raise errors.forbidden("관점 브랜드 없음", code="no_brand_scope")
    common = not (surface == "global" and brand_narrowed)       # 공통 행(엄브렐러 비트) 포함 여부: 글로벌에서 brand[] 로 좁히면 뺀다
    pop_bits = tuple(sorted({refs.brand(c).bit for c in own if refs.brand(c)}
                            | ({refs.umbrella_bit} if refs.umbrella_bit and common else set())))

    # ── 언어·엔진·출처 ──
    lang_keys = langs = None
    if use("lang"):
        ks, ls = [], []
        for x in filters.lang:
            k = refs.langs.get(x.lower())
            if k is None:
                dropped.setdefault("lang", []).append(x)
            else:
                ks.append(k)
                ls.append(x.lower())
        lang_keys, langs = tuple(sorted(set(ks))), tuple(sorted(set(ls)))
    engine_keys = None
    if use("engine"):
        ks = []
        for x in filters.engine:
            e = refs.engines.get(x)
            if e is None:
                dropped.setdefault("engine", []).append(x)
            else:
                ks.append(e[0])
        engine_keys = tuple(sorted(set(ks)))
    source_keys = None
    if use("source"):
        ks = []
        for x in filters.source:
            k = refs.categories.get(x)
            if k is None:
                dropped.setdefault("source", []).append(x)
            else:
                ks.append(k)
        source_keys = tuple(sorted(set(ks)))

    # ── 택소노미·커스텀 필드 → 프롬프트 키 ──
    prompt_keys = None
    taxon: tuple[tuple[str, tuple[int, ...]], ...] | None = None
    taxon_codes: tuple[tuple[str, tuple[tuple[str, tuple[int, ...]], ...]], ...] | None = None
    if surface == "global" and resolve_taxonomy and (any(use(a) for a in TAXONOMY_AXES) or use(DEPTH4_AXIS)):
        axes: dict[str, tuple[int, ...]] = {}
        codes: dict[str, tuple[tuple[str, tuple[int, ...]], ...]] = {}
        prompt_keys = await _taxonomy_prompt_keys_global(conn, filters, dropped,
                                                         depth4=filters.depth4 if use(DEPTH4_AXIS) else (), pop_bits=pop_bits,
                                                         axes_out=axes, codes_out=codes)
        taxon = frozen_taxon(axes, filters, depth4=bool(use(DEPTH4_AXIS) and filters.depth4))
        taxon_codes = tuple(sorted(codes.items())) if taxon is not None else None
    elif surface == "project" and project is not None and (any(use(a) for a in TAXONOMY_AXES) or use(DEPTH4_AXIS)
                                                           or (use("custom") and custom_fields)):
        f2 = filters.model_copy(update={a: (getattr(filters, a) if use(a) else []) for a in (*TAXONOMY_AXES, DEPTH4_AXIS)})
        prompt_keys = await _taxonomy_prompt_keys_project(conn, project.project_id, f2, custom_fields if use("custom") else {})

    # ── 글로벌 자사 인용 허용 배열 ──
    owner = None
    if surface == "global":
        own_bit_of = {b.code: refs.own_bit_of(b.code) for b in refs.brands if refs.own_bit_of(b.code)}
        owner_brands = {refs.brand_code_of_bit(b) for b in own_bits}
        owner = allowed_owner_keys(refs.owned_bases, {c for c in owner_brands if c}, own_bit_of,  # type: ignore[arg-type]
                                   [c for c in (countries or ()) if refs.countries.get(c) and refs.countries[c].kind == "iso"]
                                   if countries is not None else None,
                                   langs)

    date_from, date_to = (filters.from_, filters.to) if use("period") else (None, None)
    if (date_from is None) != (date_to is None):
        # 경계는 GET /v1/filters/dates 와 같은 프로젝트 집합에서 읽는다(날짜 축은 값 필터를 받지 않는다: website 는 요청 브랜드·국가로
        # 좁히기 전 스코프 사이트 + project_id, global·project 는 같은 키)
        bound_keys = tuple(project_keys)
        if surface == "website":
            vp_bits = {refs.brand(c).bit for c in _viewpoint(refs, scope, [], {})}  # type: ignore[union-attr]
            bound = [p for p in refs.projects if p.surface == 2 and p.site_brand_bit in vp_bits
                     and scope.site_allowed(refs, p.site_brand_bit, _site_code(refs, p))]
            if filters.project_id is not None:
                bound = [p for p in bound if p.project_id == str(filters.project_id) or p.site_id == str(filters.project_id)]
            bound_keys = tuple(p.project_key for p in bound)
        date_from, date_to = await close_period(conn, surface, bound_keys, date_from, date_to)

    r09 = None
    if surface == "website":
        # 현행 발행값 라우팅 입력(web_url_rate, core.measure.R09Request): 요청 축 원값(스코프에서 버려진 값 제외)·기간 원값(닫기 전)·
        # 폴백 축(현행 FALLBACK_AXES + customField)·계정 스코프 사이트(UI 필터 전 = 위 기간 경계와 같은 사이트 선택, project_id 무시).
        def kept(axis: str) -> tuple[str, ...] | None:
            vals = tuple(v for v in getattr(filters, axis) if v not in dropped.get(axis, ())) if axis in given else ()
            return vals or None
        acct_bits = {refs.brand(c).bit for c in _viewpoint(refs, scope, [], {})}  # type: ignore[union-attr]
        acct = tuple(p.project_key for p in refs.projects if p.surface == 2 and p.site_brand_bit in acct_bits
                     and scope.site_allowed(refs, p.site_brand_bit, _site_code(refs, p)))
        r09 = R09Request(brands=kept("brand"), countries=kept("country"), langs=kept("lang"), date_from=filters.from_, date_to=filters.to,
                         fallback_axis=next((x for x in R09_FALLBACK_AXES if x in given), None), account_project_keys=acct)

    return ReadContext(
        surface=surface, sf=sf, principal=principal, scope=scope, refs=refs, project_keys=tuple(project_keys),
        own_brands=tuple(own), own_bits=own_bits, pop_bits=pop_bits, bgrps=bgrps, geo_keys=geo_keys, countries=countries,
        lang_keys=lang_keys, langs=langs, engine_keys=engine_keys, prompt_keys=prompt_keys, source_category_keys=source_keys,
        owner=owner, date_from=date_from, date_to=date_to,
        ignored_filters=tuple(ignored), dropped_filters={k: tuple(v) for k, v in dropped.items()}, project=project,
        project_ids=project_ids, virtual_brand_bits=tuple(sorted(virtual_bits)) if virtual_bits else None,
        request_iso=iso_req if (surface == "website" and iso_req) else None, geo_from_scope=geo_from_scope, r09=r09,
        card=bool(filters.card) and surface in ("global", "website"), taxon=taxon, taxon_codes=taxon_codes)


# ════════════════════════════════════════════════════════════════════════════
# 카탈로그(app.prompt) 스코프 술어: P-1·P-2·관리 카탈로그 한 벌(별칭 a 는 코드 상수만)
# ════════════════════════════════════════════════════════════════════════════
# 지리 의사 시장 코드(현행 front lib/standards/prompt-markets.ts:25 GEO_PSEUDO 허용목록). 카탈로그 시장 필터 값이다(드롭다운 노출
# isGeoFilterable :54-57, 정확 매칭 matchesMarket :110-118). 국가가 아니라 계정 국가 스코프 검사 대상이 아니고, 목록 밖 x:* 는 필터 값이 아니다.
GEO_PSEUDO_MARKETS = frozenset({"x:WW", "x:EU", "x:ME"})


def normalize_market(raw: str) -> str | None:
    """현행 normalizeMarket(prompt-markets.ts): 실국가 대문자, 의사코드 'x:' + 대문자, 빈 값 None."""
    t = (raw or "").strip()
    if not t:
        return None
    return f"x:{t[2:].upper()}" if t.lower().startswith("x:") else t.upper()


def split_geo_pseudo(codes: Iterable[str]) -> tuple[list[str], list[str]]:
    """요청 country[] → (core 로 넘길 나머지, 지리 의사 시장 코드 허용목록 안의 것(정규화)). 목록 밖 x:* 는 나머지에 남아 core 가 dropped 로 적는다."""
    rest: list[str] = []
    pseudo: list[str] = []
    for c in codes:
        n = normalize_market(c)
        if n is not None and n in GEO_PSEUDO_MARKETS:
            pseudo.append(n)
        else:
            rest.append(c)
    return rest, sorted(set(pseudo))
def catalog_brand_scope(a: str, own_brands: Sequence[str], umbrella: Sequence[str], b: Binder) -> str:
    """브랜드 스코프: brand NULL(공통) ∪ 엄브렐러 ∪ 관점 브랜드."""
    return (f"({a}.brand_code IS NULL OR {a}.brand_code = ANY({b.v(list(umbrella), 'text[]')}) "
            f"OR {a}.brand_code = ANY({b.v(list(own_brands), 'text[]')}))")


def catalog_market_scope(a: str, countries: Sequence[str] | None, b: Binder) -> str | None:
    """대상 시장 ∩ 계정 국가 스코프(B1 2026-09-03) 3분기: ① regions NULL(상속 = 전 시장) ② 실국가 태그 없음(의사코드 x:* 만·빈 배열 =
    시장 귀속 없음) ③ 실국가 겹침(공백·대소문자 정규화). countries None(국가 스코프 없음)이거나 유효값이 없으면 None(술어 없음)."""
    if countries is None:
        return None
    codes = sorted({c.strip().upper() for c in countries if c and c.strip() and not c.strip().lower().startswith("x:")})
    if not codes:
        return None
    return (f"({a}.regions IS NULL"
            f" OR NOT EXISTS (SELECT 1 FROM unnest({a}.regions) AS mr(v) WHERE btrim(mr.v) <> '' AND lower(btrim(mr.v)) NOT LIKE 'x:%')"
            f" OR EXISTS (SELECT 1 FROM unnest({a}.regions) AS mr(v) WHERE lower(btrim(mr.v)) NOT LIKE 'x:%'"
            f" AND upper(btrim(mr.v)) = ANY({b.v(codes, 'text[]')})))")


def catalog_market_filter(a: str, countries: Sequence[str], b: Binder) -> str:
    """요청 국가 필터: regions 가 요청 코드 중 하나를 정확히 포함. 빈 목록 = 전부 버려진 요청 = false(fail-closed)."""
    codes = sorted({c.strip().upper() for c in countries if c and c.strip()})
    if not codes:
        return "false"
    return f"EXISTS (SELECT 1 FROM unnest({a}.regions) AS mf(v) WHERE upper(btrim(mf.v)) = ANY({b.v(codes, 'text[]')}))"
