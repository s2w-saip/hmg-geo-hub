"""analytics.filters.options 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

규칙(단위 F-1, 모듈-필터 §2.2, 계약서 §4 규칙 1·2·4·5)
- 권한 교집합(규칙 1): 스코프·표면 프로젝트는 core.filters.resolve_read_context 가 정한다(요청으로 넓힐 수 없다).
- 지원 축 선언(규칙 2): 이 API 는 기간(from/to)만 받는다. 브랜드·국가·언어·엔진·택소노미·출처·커스텀 필드는 결과를 좁히지 않고
  meta.ignored_filters 로 알린다(패널이 draft 선택으로 매트릭스를 좁힌다: 규칙 5, 현행 listMeasuredScopeMatrix 설계).
- 옵션 창 = 데이터 창(규칙 4): from/to 가 있으면 그 기간, 없으면 core.cycles 함대 스냅샷(Q1). 매트릭스·엔진은 row 계열(전체 숨김만
  배제), 출처 카테고리는 citations 계열(인용 숨김 배제) 회차 키를 쓴다.
- 브랜드 전개: global 은 rd.answer.cat_mask 비트를 brand_code 로 펼친다(엄브렐러 비트·0 은 null = 공통). 브랜드 스코프 계정은
  스코프 브랜드 + 공통만(standard-filters.ts:64). website 는 사이트 브랜드·국가(rd.dim_project), project 는 비트 전개(스코프 무관).
- 숨김 국가: global = rd.dim_country.hidden_standard, website = app.hidden_market(surface website, core Refs.hidden_markets).
  project 는 걸지 않는다. 국가 옵션의 소속 권역 = core Refs.area_code(rd.dim_region).
- 표면 경로 게이트(역할 천장 + menu_groups)는 core.filters.resolve_read_context 가 건다(core.auth.require_surface).
- 출처 카테고리 = 유효 카테고리(core.measure.CATEGORY_EXPR: 운영자 오버라이드 우선). source[] 데이터 축과 같은 해석이라 옵션 ⊇ 데이터.
- 현행 프로필 filter_options(F1W4, WU-8): 켜지면 글로벌·웹사이트 국가·매트릭스·언어·엔진을 운영 hmg-geo 2670a16 + read_screens 14키 규칙으로
  낸다(build_legacy_global·build_legacy_website·default_engines). 스코프 교집합(관점 브랜드·스코프 국가·전용 사이트 코드)은 그대로 건다. project 무변경.
- geo_only(B095, 선택): 국가 옵션만 쓰는 전환 화면용. 카탈로그 택소노미(TAXON·CATALOG 문장)·커스텀 필드 문장을 건너뛰고 그 필드는 null.
  다른 필드·meta 는 기본 호출과 같다(현행 프로필 경로 포함).
"""
from __future__ import annotations

from collections.abc import Iterable
from dataclasses import is_dataclass, replace
from types import SimpleNamespace
from typing import Any

from fastapi import Request

from app.core.auth import Principal, dedicated_site_codes
from app.core.codes import Country, Refs
from app.core.db import RoConn, fetch_all, fetch_val
from app.core.envelope import Envelope, build_meta
from app.core.filters import CommonFilters, FilterSupport, ReadContext, resolve_read_context
from app.core.profile import LegacyProfile, active_profile
from app.features.analytics.filters.options import queries as q
from app.features.analytics.filters.options.schemas import (
    CatalogOptions,
    CatalogRow,
    CustomFieldOption,
    EngineOption,
    GeoCombo,
    OptionsData,
    RegionOption,
    SourceCategoryOption,
    TaxonOption,
)

# 기간만 지원(그 밖의 축은 ignored_filters). 표면 공통.
OPTIONS_SUPPORT = FilterSupport.of(global_=("period",), website=("period",), project=("period",))
_AXES = ("funnel", "brand_presence", "list_type", "depth1", "depth2", "depth3", "depth4")   # depth4 = BG-03(부모 depth3)


def expand_brands(cat_mask: int, refs: Refs, allowed: set[str] | None) -> list[str | None]:
    """cat_mask 비트 → brand_code 목록. 엄브렐러 비트와 0(공통·미등록)은 None. allowed 가 있으면 그 밖 브랜드는 뺀다."""
    if cat_mask == 0:
        return [None]
    out: list[str | None] = []
    for b in refs.brands:
        if not cat_mask & b.bit:
            continue
        if b.is_umbrella:
            out.append(None)
        elif allowed is None or b.code in allowed:
            out.append(b.code)
    return list(dict.fromkeys(out))


def _uniq_taxa(pairs: Iterable[tuple[str | None, str | None]]) -> list[TaxonOption]:
    seen = sorted({(c, p) for c, p in pairs if c}, key=lambda x: (x[0], x[1] or ""))
    return [TaxonOption(code=c, parent_code=p) for c, p in seen]   # type: ignore[arg-type]


def _catalog(rows: list[CatalogRow], parents: dict[str, list[tuple[str | None, str | None]]]) -> CatalogOptions:
    uniq = sorted({tuple(r.model_dump().values()) for r in rows}, key=lambda t: tuple("" if v is None else v for v in t))
    cat_rows = [CatalogRow(**dict(zip(CatalogRow.model_fields, t, strict=True))) for t in uniq]
    return CatalogOptions(rows=cat_rows, **{a: _uniq_taxa(parents[a]) for a in _AXES})


async def _catalog_global(conn: Any, ctx: ReadContext) -> CatalogOptions:
    refs = ctx.refs
    taxa = {int(r["taxon_key"]): r for r in await fetch_all(conn, q.TAXON_SQL)}

    def code(k: Any) -> str | None:
        t = taxa.get(int(k)) if k is not None else None
        return t["code"] if t else None

    def parent(k: Any) -> str | None:
        t = taxa.get(int(k)) if k is not None else None
        return code(t["parent_key"]) if t and t["parent_key"] is not None else None

    rows: list[CatalogRow] = []
    parents: dict[str, list[tuple[str | None, str | None]]] = {a: [] for a in _AXES}
    cols = {"funnel": "funnel_key", "brand_presence": "presence_key", "list_type": "list_type_key",
            "depth1": "depth1_key", "depth2": "depth2_key", "depth3": "depth3_key"}
    for r in await fetch_all(conn, q.CATALOG_GLOBAL_SQL, {"bits": list(ctx.pop_bits)}):
        b = next((x for x in refs.brands if x.bit == int(r["brand_bit"])), None)
        brand = None if b is None or b.is_umbrella else b.code
        rows.append(CatalogRow(brand=brand, depth4=r["depth4"], **{a: code(r[c]) for a, c in cols.items()}))
        for a, c in cols.items():
            parents[a].append((code(r[c]), parent(r[c])))
        parents["depth4"].append((r["depth4"], code(r["depth3_key"])))
    return _catalog(rows, parents)


async def _catalog_project(conn: Any, ctx: ReadContext) -> CatalogOptions:
    assert ctx.project is not None
    refs = ctx.refs
    rows: list[CatalogRow] = []
    parents: dict[str, list[tuple[str | None, str | None]]] = {a: [] for a in _AXES}
    for r in await fetch_all(conn, q.CATALOG_PROJECT_SQL, {"pid": ctx.project.project_id}):
        b = refs.brand(r["brand_code"]) if r["brand_code"] else None
        brand = None if b is None or b.is_umbrella else b.code
        row = CatalogRow(brand=brand, funnel=r["funnel_stage"], brand_presence=r["brand_presence"], list_type=r["list_type"],
                         depth1=r["depth1"], depth2=r["depth2"], depth3=r["depth3"], depth4=r["depth4"])
        rows.append(row)
        parents["funnel"].append((row.funnel, None))
        parents["brand_presence"].append((row.brand_presence, None))
        parents["list_type"].append((row.list_type, None))
        parents["depth1"].append((row.depth1, None))
        parents["depth2"].append((row.depth2, row.depth1))
        parents["depth3"].append((row.depth3, row.depth2))
        parents["depth4"].append((row.depth4, row.depth3))
    return _catalog(rows, parents)


def _brand_geo(refs: Refs) -> set[str]:
    return {code for code, c in refs.countries.items() if c.kind == "virtual_brand"}


def build_matrix(ctx: ReadContext, rows: list[dict[str, Any]]) -> tuple[list[GeoCombo], list[RegionOption], list[str], list[EngineOption]]:
    """1단계 소집합(project_key·geo_key·lang_key·cat_mask·engine_key) → 매트릭스·국가·언어·엔진(순수 함수: 단위 테스트 대상).
    권역 코드·웹사이트 숨김 시장은 ctx.refs(core Refs.areas·hidden_markets)에서 온다."""
    refs = ctx.refs
    by_geo: dict[int, Country] = {c.geo_key: c for c in refs.countries.values()}
    lang_of = {k: code for code, k in refs.langs.items()}
    engine_of = {k: (code, d) for code, (k, d) in refs.engines.items()}
    sites = {p.project_key: p for p in refs.projects if p.surface == 2}
    combos: set[tuple[str | None, str, str | None]] = set()
    countries: dict[str, Country] = {}
    engines: set[int] = set()

    def usable(c: Country | None, hidden: set[str]) -> bool:
        return c is not None and c.kind != "unknown" and bool(c.code) and c.code.upper() not in hidden

    if ctx.surface == "global":
        hidden = {c.code.upper() for c in refs.countries.values() if c.hidden_standard}
        allowed = set(ctx.own_brands)
    else:
        hidden = set(refs.hidden_markets.get("website", frozenset())) if ctx.surface == "website" else set()
        allowed = None
    for r in rows:
        lang = lang_of.get(int(r["lang_key"])) or None
        if ctx.surface == "website":
            site = sites.get(int(r["project_key"]))
            c = by_geo.get(site.site_geo_key) if site else None
            brands: list[str | None] = [refs.brand_code_of_bit(site.site_brand_bit)] if site else []
        else:
            c = by_geo.get(int(r["geo_key"]))
            brands = expand_brands(int(r["cat_mask"]), refs, allowed)
        if not usable(c, hidden) or not brands:
            continue
        assert c is not None
        countries[c.code] = c
        engines.add(int(r["engine_key"]))
        for br in brands:
            combos.add((br, c.code, lang))
    if ctx.surface == "website":        # 브랜드 가상 코드(현행 withWebsiteBrandGeoCombos): 그 브랜드 사이트 행마다 region 을 가상 코드로 바꾼 행
        for v in refs.countries.values():
            if v.kind != "virtual_brand" or v.virtual_brand_bit is None or v.code.upper() in hidden:
                continue
            vb = refs.brand_code_of_bit(int(v.virtual_brand_bit))
            extra = {(br, v.code, lang) for br, _, lang in combos if br is not None and br == vb}
            if extra:
                combos |= extra
                countries[v.code] = v
        # 전용 사이트 계정(website 스코프 국가 = worldwide·CPO·브랜드 가상 코드): 국가 옵션은 그 코드만, 사이트 브랜드는 모 브랜드로 적는다
        # (현행 website-sites.ts listWebsiteScopeMatrix:246-254·listWebsiteCountries:281, 동기화 S1 검증 F2. 패널이 비관리자 행을 계정 브랜드로
        # 거르므로 'Hyundai N' 그대로면 언어 옵션까지 빈다). 사이트 행의 실 국가(KR·worldwide)는 옵션이 아니다(데이터 축이 스코프 밖으로 버린다).
        scope = getattr(ctx, "scope", None)        # 순수 함수 단위 시험은 스코프 없는 문맥을 넘긴다(= 제한 없음)
        dedicated = set() if scope is None or scope.all else set(dedicated_site_codes(scope.countries or (), _brand_geo(refs)))
        if dedicated:
            def parent(br: str | None) -> str | None:
                b = refs.brand(br) if br else None
                return b.parent if b is not None and b.parent else br
            combos = {(parent(br), r, lang) for br, r, lang in combos if r.upper() in dedicated}
            countries = {k: v for k, v in countries.items() if k.upper() in dedicated}
    matrix = [GeoCombo(brand=b, region=r, lang=lang)
              for b, r, lang in sorted(combos, key=lambda t: (t[1], t[2] or "", t[0] or ""))]
    regions = [RegionOption(code=c.code, area=(refs.area_code(c.region_key) or None) if c.region_key else None, kind=c.kind)
               for c in sorted(countries.values(), key=lambda x: x.code)]
    langs = sorted({lang for _, _, lang in combos if lang})
    engs = [EngineOption(code=engine_of[k][0], is_default=engine_of[k][1]) for k in sorted(engines) if k in engine_of and engine_of[k][0]]
    return matrix, regions, langs, engs


# ════════════════════════════════════════════════════════════════════════════
# 현행 프로필 filter_options(F1W4, WU-8, 제품 결정 19·25): 운영 hmg-geo 2670a16 + read_screens 14키의 옵션 규칙
# ════════════════════════════════════════════════════════════════════════════
async def legacy_website_key(request: Request, conn: RoConn) -> str | None:
    """결과 캐시 끝점 추가 키(router key_deps). 켜짐(filter_options) + surface=website 일 때만 등록 사이트·프롬프트 언어 지문
    (queries.LEGACY_WEBSITE_VERSION_SQL)을 낸다. 두 app 표는 추적 표가 아니라서 데이터 버전이 그 변경을 모른다. 꺼짐·다른 표면 = None(쿼리 없음)."""
    if not active_profile().filter_options or request.query_params.getlist("surface") != ["website"]:
        return None
    return await fetch_val(conn, q.LEGACY_WEBSITE_VERSION_SQL)


def default_engines(refs: Refs) -> list[EngineOption]:
    """현행 엔진 옵션: 글로벌·웹사이트 패널은 engineOptions 를 받지 않아 정적 DIMENSIONS.engine = ["chatgpt","gemini"]
    (components/dash/dimension-filter-panel.tsx:165, dashboard/page.tsx·website/page.tsx 가 넘기지 않음). 측정 창·스코프 무관.
    허브 표현 = 기본 엔진(rd.dim_engine.is_default: 스케줄 targets 가 비었을 때의 기본 타깃 = chatgpt·gemini) 전부, 엔진 키 순."""
    return [EngineOption(code=code, is_default=True) for code, (k, d) in sorted(refs.engines.items(), key=lambda kv: kv[1][0]) if d]


def build_legacy_global(ctx: ReadContext, rows: list[dict[str, Any]], brands: tuple[str, ...] | None = None
                        ) -> tuple[list[GeoCombo], list[RegionOption], list[str], list[EngineOption]]:
    """글로벌 현행 옵션(순수 함수). rows = queries.legacy_global_sql 소집합(served 열 포함).
    - 국가(regions) = 현행 listMeasuredRegions: 상태 무관(served 거짓 행 포함) → 실패·진행 중 답변만 있는 국가도 나온다(U4-N8 되돌림).
    - 매트릭스·언어 = 현행 listMeasuredScopeMatrix·listMeasuredStandardLanguages: completed(served) 행만.
    그래서 regions ⊇ geo_matrix 의 distinct 이고 같지 않을 수 있다(현행 두 목록도 그렇다. 화면 드롭다운은 매트릭스가 있으면 매트릭스에서 파생:
    dimension-filter-panel.tsx:1260). 브랜드 전개·숨김·스코프는 build_matrix 와 같다. 엔진 = default_engines."""
    served = [r for r in rows if r["served"]]
    matrix, _, langs, _ = build_matrix(ctx, served)
    _, regions, _, _ = build_matrix(ctx, rows)
    if brands is not None:      # 선택 브랜드(관리자 brand[]): 국가·언어만 좁힌다. 매트릭스는 계정 스코프 그대로(listMeasuredScopeMatrix(scope))
        narrowed = replace(ctx, own_brands=tuple(brands)) if is_dataclass(ctx) else SimpleNamespace(**{**vars(ctx), "own_brands": tuple(brands)})
        _, regions, _, _ = build_matrix(narrowed, rows)
        _, _, langs, _ = build_matrix(narrowed, served)
    return matrix, regions, langs, default_engines(ctx.refs)


def legacy_option_brands(ctx: ReadContext, filters: CommonFilters) -> tuple[str, ...] | None:
    """현행 옵션의 선택 브랜드 좁힘(WU-12, 제품 결정 19·25). None = 좁히지 않음(계정 스코프 그대로).
    현행: 옵션 함수에 optionScope = narrowScopeBrands(user.scope, filters.brand)(hmg-brands.ts:177-186)를 넘긴다
    (dashboard/page.tsx:195·200·209, website/page.tsx:167·170·171·173). filters.brand 는 readStandardFilters(standard-filters.ts:73-76)가
    브랜드 스코프 계정이면 URL 을 무시하고 [스코프 브랜드, HMG] 로 잠그므로 그 계정은 스코프 그대로(좁힘 없음). URL brand 를 받는 경우만 좁힌다:
      global : 스코프 전체(all) 또는 스코프 브랜드가 없는 계정 → brands = 요청값 그대로(검증 없음: 모르는 코드는 공통 행만 남는다)
      website: 관리자만 brand 축을 받는다(website/page.tsx readStandardFilters 허용 축 isAdmin ? brand). 허브는 전체 스코프로 판정(Q16: admin ⇒ 전체)
    권한: 요청 브랜드는 스코프 전체 계정에서만 쓰이므로 스코프를 넓히지 않는다(스코프 브랜드 계정은 이 경로에 오지 않는다)."""
    req = [b for b in (filters.brand or []) if b]
    if not req:
        return None
    scope = getattr(ctx, "scope", None)
    if ctx.surface == "website":
        # 현행 판정은 역할(admin)이지만 결과 캐시 키는 역할을 모른다(스코프 서명만): admin ⇒ 전체 스코프(Q16)이므로 전체 스코프로 판정한다.
        # 남는 차이: 관리자 아닌 전체 스코프 계정이 website 옵션에 brand 를 직접 주면 좁혀진다(현행은 무시. 프론트는 옵션에 brand 를 보내지 않는다)
        return tuple(dict.fromkeys(req)) if scope is None or scope.all else None
    if scope is None or scope.all or not scope.brands:
        return tuple(dict.fromkeys(req))
    return None


async def _legacy_website_sources(conn: Any, ctx: ReadContext, filters: CommonFilters, brands: tuple[str, ...] | None = None
                                  ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """스코프 안 등록 사이트와 그 프롬프트 언어. 사이트 = 관점 브랜드 비트(ctx.bgrps: 현행 websiteBrandCondition, 현대 N 계정은 N 비트) ∧
    DataScope.site_allowed(현행 websiteScopeCountryCondition: country_code ∈ 스코프 실 코드 ∨ 사이트 브랜드 ∈ 가상 코드 브랜드).
    project_id 가 있으면 그 사이트 하나(core 가 측정 사이트로 이미 존재·스코프를 판정했다)."""
    bits = list(ctx.bgrps or ())
    sites = await fetch_all(conn, q.LEGACY_WEBSITE_SITES_SQL, {"bits": bits}) if bits else []
    scope = getattr(ctx, "scope", None)
    if scope is not None:
        sites = [s for s in sites if scope.site_allowed(ctx.refs, int(s["brand_bit"]), s["country_code"])]
    if filters.project_id is not None:
        pid = str(filters.project_id)
        sites = [s for s in sites if pid in (s["site_id"], s["scope_project_id"])]
    if brands is not None:      # 관리자 선택 브랜드(현행 websiteBrandCondition(optionScope): 사이트 brand ∈ 선택값, 국가·매트릭스·언어 모두)
        sites = [s for s in sites if s["brand_code"] in brands]
    langs = await fetch_all(conn, q.LEGACY_WEBSITE_LANGS_SQL, {"ids": [s["site_id"] for s in sites]}) if sites else []
    return sites, langs


def build_legacy_website(ctx: ReadContext, sites: list[dict[str, Any]], langs: list[dict[str, Any]]
                         ) -> tuple[list[GeoCombo], list[RegionOption], list[str]]:
    """웹사이트 현행 옵션(순수 함수, 측정 창 무관). sites·langs = _legacy_website_sources.
    - 국가(regions) = listWebsiteCountries(website-sites.ts:258-281): 사이트 country_code(원표기) ∪ 사이트 브랜드의 가상 코드
      (websiteBrandGeoCodesFor), 전용 사이트 계정은 그 코드만. 프롬프트 없는 사이트도 나온다.
    - 매트릭스 = listWebsiteScopeMatrix(:216-254): (사이트 브랜드, country_code, lang_code 원값) ∪ 가상 코드 행(withWebsiteBrandGeoCombos),
      전용 사이트 계정은 그 코드 행만·브랜드는 모 브랜드(WEBSITE_SITE_BRAND_PARENT).
    - 언어 = listMeasuredLanguages(:176-197): 스코프 안 사이트 프롬프트 lang_code DISTINCT.
    허브만의 제약 하나는 유지한다: app.hidden_market(website) 시장은 뺀다(현행에는 웹 숨김 시장 개념이 없다. 허브 데이터 축이 그 시장을 버리므로
    옵션만 되살리면 죽은 옵션이 된다. 좁히는 방향이라 권한을 넓히지 않는다)."""
    refs = ctx.refs
    hidden = set(refs.hidden_markets.get("website", frozenset()))
    live = [s for s in sites if str(s["country_code"]).upper() not in hidden]
    by_site: dict[str, set[str]] = {}
    for r in langs:
        if r["lang_code"]:
            by_site.setdefault(r["site_id"], set()).add(r["lang_code"])
    codes: dict[str, str] = {str(s["country_code"]).upper(): str(s["country_code"]) for s in live}
    combos: set[tuple[str | None, str, str | None]] = {(s["brand_code"], str(s["country_code"]), lang)
                                                       for s in live for lang in by_site.get(s["site_id"], ())}
    site_brands = {s["brand_code"] for s in live}
    for v in refs.countries.values():
        if v.kind != "virtual_brand" or v.virtual_brand_bit is None or v.code.upper() in hidden:
            continue
        vb = refs.brand_code_of_bit(int(v.virtual_brand_bit))
        if vb in site_brands:
            codes[v.code.upper()] = v.code
            combos |= {(br, v.code, lang) for br, _, lang in combos if br == vb}
    langs_out = sorted({lang for s in live for lang in by_site.get(s["site_id"], ())})
    scope = getattr(ctx, "scope", None)
    dedicated = set() if scope is None or scope.all else set(dedicated_site_codes(scope.countries or (), _brand_geo(refs)))
    if dedicated:
        def parent(br: str | None) -> str | None:
            b = refs.brand(br) if br else None
            return b.parent if b is not None and b.parent else br
        combos = {(parent(br), r, lang) for br, r, lang in combos if r.upper() in dedicated}
        codes = {k: c for k, c in codes.items() if k in dedicated}
    matrix = [GeoCombo(brand=b, region=r, lang=lang) for b, r, lang in sorted(combos, key=lambda t: (t[1], t[2] or "", t[0] or ""))]
    regions = []
    for code in sorted(codes.values()):
        c = refs.countries.get(code.upper())
        kind = c.kind if c is not None and c.kind in ("iso", "pseudo", "virtual_brand") else "pseudo"
        area = (refs.area_code(c.region_key) or None) if c is not None and c.region_key else None
        regions.append(RegionOption(code=code, area=area, kind=kind))
    return matrix, regions, langs_out


async def get_options(conn: Any, principal: Principal, filters: CommonFilters, custom_fields: dict[str, list[str]],
                      *, profile: LegacyProfile | None = None, include: frozenset[str] = frozenset(),
                      geo_only: bool = False) -> Envelope[OptionsData]:
    """include: 'source_categories' 가 있을 때만 출처 카테고리를 계산한다(창 안 인용 스캔, 옵션 서버 시간의 대부분). 없으면 data 값 null,
    meta.suppressed 에도 적지 않는다(null 자체가 '요청하지 않음'). 그 밖의 필드 값은 include 와 무관하다.
    geo_only(B095): 국가 옵션만 쓰는 화면(전환)용. 카탈로그 택소노미·커스텀 필드 문장을 건너뛰고 catalog·custom_fields = null(같은 규칙:
    null = 요청하지 않음, 억제 표식 없음). 매트릭스·국가·언어·엔진은 같은 매트릭스 문장의 결과라 그대로 낸다."""
    ctx = await resolve_read_context(conn, principal, filters, support=OPTIONS_SUPPORT, custom_fields=custom_fields)
    win = await ctx.window(conn)
    refs = ctx.refs
    prof = profile if profile is not None else active_profile()
    legacy = prof.filter_options and ctx.surface in ("global", "website")      # 현행 프로필 F1W4(WU-8). project 는 대상 아님(README 참고)
    opt_brands = legacy_option_brands(ctx, filters) if legacy else None       # WU-12: 선택 브랜드 좁힘(None = 스코프 그대로)
    want_sources = "source_categories" in include                            # WU-12: 출처 카테고리는 명시 요청 때만
    # 엔진 옵션은 측정된 전 엔진이 후보다: 기본 엔진(dflt) 술어 대신 전 엔진 키 배열을 준다(scope_where 의 engine 축).
    # 현행 프로필: 글로벌 옵션 창은 기본 엔진 답변만(anchorDefaultEngineScope, 엔진 미선택 = 옵션 요청).
    engine_keys = refs.default_engine_keys if legacy else tuple(sorted(k for k, _ in refs.engines.values()))
    ms = replace(ctx.measure(), engine_keys=engine_keys)

    suppressed: dict[str, str] = {}
    rows: list[dict[str, Any]] = []
    sources: list[dict[str, Any]] = []
    web_sites: list[dict[str, Any]] = []
    web_langs: list[dict[str, Any]] = []
    if legacy and ctx.surface == "website":         # 등록 사이트 기준(측정 창 무관): 창이 비어도 국가·언어·엔진 옵션이 있다
        web_sites, web_langs = await _legacy_website_sources(conn, ctx, filters, opt_brands)
    if win.empty:
        reason = "no_active_snapshot" if win.mode == "snapshot" else "no_cycles_in_period"
        for k in ("geo_matrix", "engines", "source_categories"):
            if k == "source_categories" and not want_sources:
                continue
            if legacy and (k == "engines" or (k == "geo_matrix" and ctx.surface == "website")):
                continue                            # 현행: 엔진 = 정적 목록, 웹사이트 국가·매트릭스 = 등록 사이트(창 무관)
            suppressed[k] = reason
    else:
        if not (legacy and ctx.surface == "website"):
            m = q.legacy_global_sql(ms, win) if legacy else q.matrix_sql(ms, win)
            rows = await fetch_all(conn, m.text, m.params)
        if want_sources and win.cyc_keys("citations"):
            s = q.source_categories_sql(ms, win)
            sources = await fetch_all(conn, s.text, s.params)
        elif want_sources:
            suppressed["source_categories"] = "hidden"
    if legacy and ctx.surface == "website":
        matrix, regions, langs = build_legacy_website(ctx, web_sites, web_langs)
        engines = default_engines(refs)
    elif legacy:
        matrix, regions, langs, engines = build_legacy_global(ctx, rows, opt_brands)
    else:
        matrix, regions, langs, engines = build_matrix(ctx, rows)

    catalog = None
    if geo_only:
        pass                                        # B095: 국가 옵션만(카탈로그·커스텀 필드 미요청 = null)
    elif ctx.surface == "global":
        catalog = await _catalog_global(conn, ctx)
    elif ctx.surface == "project":
        catalog = await _catalog_project(conn, ctx)
    cfs = None
    if ctx.surface == "project" and ctx.project is not None and not geo_only:
        cfs = [CustomFieldOption(field_id=r["field_id"], label=r["label"], values=list(r["vals"] or []))
               for r in await fetch_all(conn, q.CUSTOM_FIELDS_SQL, {"pid": ctx.project.project_id})]

    data = OptionsData(geo_matrix=matrix, regions=regions, languages=langs, engines=engines, catalog=catalog,
                       source_categories=([SourceCategoryOption(slug=r["slug"], name=r["name"], ord=int(r["ord"])) for r in sources]
                                          if want_sources else None),
                       custom_fields=cfs)
    meta = build_meta(mode=win.mode, ctx=ctx, window=win, suppressed=suppressed)
    if opt_brands is not None:  # brand 축을 실제로 썼다: ignored 에서 뺀다. 모르는 브랜드 코드는 dropped(현행처럼 공통 행만 남기고, 결과 캐시 저장 안 함)
        meta.ignored_filters = [f for f in meta.ignored_filters if f != "brand"]
        unknown = [b for b in opt_brands if refs.brand(b) is None]
        if unknown:
            meta.dropped_filters["brand"] = unknown
    return Envelope[OptionsData](data=data, meta=meta)
