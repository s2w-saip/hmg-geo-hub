"""코드표·상수와 참조 차원 로더(Refs).

DB 코드(int2)는 내부 전용이다. 응답·경로에는 코드 문자열(surface 이름, brand_code, ISO 국가, 엔진 코드)만 내보낸다.
브랜드 비트의 정본은 app.brand 다(Q11: 엄브렐러 비트 리터럴 8 금지). 이 모듈의 BRAND_OWN_COLS 는 rd.answer 당사 열(G-03·G-25)
접미사 h·k·g 와 비트 1·2·4 의 대응(DDL 열 이름 자체가 이 셋으로 닫혀 있다)만 고정한다.

Refs 는 요청마다 한 문장으로 읽는 작은 참조 표 묶음이다(결과 캐시가 아니다: D8). 차원 키 해석·스코프·자사 허용 배열 계산에 쓴다.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal

from app.core.facts import fact_tables

Surface = Literal["global", "website", "project"]
SURFACE_CODE: dict[str, int] = {"global": 1, "website": 2, "project": 3}
SURFACE_NAME: dict[int, str] = {v: k for k, v in SURFACE_CODE.items()}

# rd.answer 당사 열 접미사(own_rk_h·ment_h·sent_pos_h·cit_own_h …)와 own_bit 의 대응. DDL 이 이 셋으로 닫혀 있다.
BRAND_OWN_COLS: dict[int, str] = {1: "h", 2: "k", 4: "g"}
OWN_BITS: tuple[int, ...] = (1, 2, 4)

# rd.cycle.hidden_scope 코드(DB-v2.1 P07): 0 없음 1 all 2 citations 3 mentions.
# 계열별 배제 집합(core.cycles 가 쓰는 정본). mentions 계열 = {1,3}, citations 계열 = {1,2}, any = {1,2,3}, row(옵션·스냅샷 기준일) = {1}.
HIDDEN_EXCLUDE: dict[str, frozenset[int]] = {
    "mentions": frozenset({1, 3}),
    "citations": frozenset({1, 2}),
    "any": frozenset({1, 2, 3}),
    "row": frozenset({1}),
}
Family = Literal["mentions", "citations", "any", "row"]

# rd.job.status_code, rd.answer.analysis_state, rd.answer_stance.stance, rd.cycle.status
STATUS_CODE = {"completed": 0, "running": 1, "failed": 2, "other": 3}
ANALYSIS_STATE = {"analyzed_mentions": 0, "analyzed_empty": 1, "pending": 2, "failed": 3}
STANCE_CODE = {"positive": 1, "neutral": 2, "mixed": 3, "negative": 4}
CYCLE_STATUS = {"open": 0, "closed": 1, "published": 2, "stale": 3}
# rd.cycle.hidden_reason(DB-v2.1 P06): hidden_scope 와 짝. 수집 오류 숨김은 추이의 갭 자리로 남고, 운영자 전체 숨김은 자리가 아니다(T-1 R11)
HIDDEN_REASON = {"none": 0, "collection_error": 1, "operator": 2}


def brand_masks(bits: int, universe: int) -> list[int]:
    """(m & bits) <> 0 인 1..universe 값 목록. universe = app.brand 비트 전체 OR(비트 식을 WHERE 밖 상수 배열로 푼다)."""
    return [m for m in range(1, universe + 1) if (m & bits) and not (m & ~universe)]


@dataclass(frozen=True)
class Brand:
    code: str
    bit: int
    is_umbrella: bool
    parent: str | None
    sort_order: int


@dataclass(frozen=True)
class OwnedBase:
    owner_key: int
    kind: str
    prefix: str
    brand_code: str
    geo_code: str | None
    language: str | None


@dataclass(frozen=True)
class Country:
    geo_key: int
    code: str
    kind: str
    region_key: int | None
    virtual_brand_bit: int | None
    hidden_standard: bool


@dataclass(frozen=True)
class ProjectDim:
    project_key: int
    surface: int
    is_root: bool
    project_id: str | None
    site_id: str | None
    site_brand_bit: int
    site_geo_key: int


@dataclass(frozen=True)
class CategoryRef:
    """출처 카테고리(app.citation_category, 13행 코드표). category_key 는 외부 식별자로 내보내도 된다(코드표 키)."""
    category_key: int
    slug: str
    name: str
    ord: int


@dataclass(frozen=True)
class Refs:
    """요청 시점 참조 차원. load_refs 한 문장으로 채운다."""
    brands: tuple[Brand, ...]
    owned_bases: tuple[OwnedBase, ...]
    engines: dict[str, tuple[int, bool]]          # code → (engine_key, is_default)
    countries: dict[str, Country]                  # 대문자 코드 → Country(code 는 원래 표기)
    langs: dict[str, int]                          # code(소문자) → lang_key
    rhq: dict[str, tuple[str, tuple[str, ...]]]    # region_id → (brand_code, 국가 코드들)
    categories: dict[str, int]                     # slug → category_key
    projects: tuple[ProjectDim, ...]               # surface 1·2 차원(프로젝트 표면은 요청 프로젝트만 따로 해석)
    extra: dict[str, Any] = field(default_factory=dict)
    areas: dict[int, str] = field(default_factory=dict)                     # rd.dim_region region_key → 권역 코드
    hidden_markets: dict[str, frozenset[str]] = field(default_factory=dict)  # app.hidden_market surface → 대문자 국가 코드
    category_refs: dict[int, CategoryRef] = field(default_factory=dict)      # category_key → CategoryRef(slug·name·ord)
    # 현행 프로필 catalog_incl_deleted(A41)가 켜져 있을 때만 채운다(load_refs): 글로벌 프롬프트 중 삭제 포함 카탈로그(cat_mask_all·
    # in_root_catalog_all)가 비삭제 카탈로그(cat_mask·in_root_catalog)와 다른 행의 (prompt_key, cat_mask_all). stg 2026-10-01 115행.
    # core.measure.catalog_all_pred 가 사실 표 bgrp(= 비삭제 cat_mask 사본) + 이 작은 보정 집합으로 세미조인을 대신한다(성능, WU-5).
    cat_diff: tuple[tuple[int, int | None], ...] | None = None

    def __post_init__(self) -> None:
        # 역색인(O(1) 조회). frozen 이라 object.__setattr__ 로 한 번 채운다(필드가 아니라 eq·hash 대상 아님)
        object.__setattr__(self, "_by_geo", {c.geo_key: c for c in self.countries.values()})
        object.__setattr__(self, "_lang_code", {k: code for code, k in self.langs.items()})
        object.__setattr__(self, "_engine_code", {k: code for code, (k, _) in self.engines.items()})

    # ── 브랜드 ──
    def brand(self, code: str) -> Brand | None:
        for b in self.brands:
            if b.code == code:
                return b
        return None

    @property
    def umbrella_bit(self) -> int:
        return next((b.bit for b in self.brands if b.is_umbrella), 0)

    @property
    def bit_universe(self) -> int:
        u = 0
        for b in self.brands:
            u |= b.bit
        return u

    @property
    def real_brands(self) -> tuple[Brand, ...]:
        return tuple(b for b in self.brands if not b.is_umbrella)

    def own_bit_of(self, code: str) -> int | None:
        """자사 열 비트(1·2·4). 하위 브랜드(예: Hyundai N 16)는 부모 브랜드 비트로 접는다(rd.dim_brand_name own_bit 규칙과 같다)."""
        b = self.brand(code)
        seen = 0
        while b is not None and seen < 4:
            if b.bit in BRAND_OWN_COLS:
                return b.bit
            b = self.brand(b.parent) if b.parent else None
            seen += 1
        return None

    def brand_code_of_bit(self, bit: int) -> str | None:
        return next((b.code for b in self.brands if b.bit == bit), None)

    # ── 국가·권역 ──
    def region_countries(self, region_ids: list[str] | tuple[str, ...]) -> list[str]:
        out: list[str] = []
        for rid in region_ids:
            r = self.rhq.get(rid)
            if r:
                out.extend(r[1])
        return sorted(set(out))

    def geo_key(self, code: str) -> int | None:
        c = self.countries.get(code.upper())
        return c.geo_key if c else None

    def country_by_key(self, geo_key: int) -> Country | None:
        return self._by_geo.get(int(geo_key))  # type: ignore[attr-defined]

    def area_code(self, region_key: int | None) -> str | None:
        """국가의 소속 권역 코드(rd.dim_region). 없으면 None."""
        return None if region_key is None else self.areas.get(int(region_key))

    def hidden_market(self, surface: str, code: str) -> bool:
        """app.hidden_market(surface: 'global'|'website') 에 그 국가가 있는가(대소문자 무시)."""
        return code.upper() in self.hidden_markets.get(surface, frozenset())

    # ── 언어·엔진·카테고리 역색인 ──
    def lang_code(self, lang_key: int) -> str | None:
        return self._lang_code.get(int(lang_key))  # type: ignore[attr-defined]

    def engine_code(self, engine_key: int) -> str | None:
        return self._engine_code.get(int(engine_key))  # type: ignore[attr-defined]

    @property
    def default_engine_keys(self) -> tuple[int, ...]:
        """rd.dim_engine.is_default 엔진 키(engine[] 이 비었을 때의 기본 엔진, dflt 열이 없는 표용: rd.acr_cell)."""
        return tuple(sorted(k for k, d in self.engines.values() if d))

    def category(self, category_key: int | None) -> CategoryRef | None:
        return None if category_key is None else self.category_refs.get(int(category_key))


_REFS_SQL = """
SELECT json_build_object(
  'brands', (SELECT coalesce(json_agg(json_build_object('code', brand_code, 'bit', brand_bit, 'umb', is_umbrella,
                                                        'parent', parent_brand_code, 'ord', sort_order) ORDER BY sort_order), '[]')
               FROM app.brand),
  'owned', (SELECT coalesce(json_agg(json_build_object('k', owner_key, 'kind', kind, 'prefix', prefix, 'brand', brand_code,
                                                       'geo', geo_code, 'lang', language) ORDER BY owner_key), '[]')
              FROM app.owned_base),
  'engines', (SELECT coalesce(json_agg(json_build_object('k', engine_key, 'code', code, 'd', is_default) ORDER BY engine_key), '[]')
                FROM rd.dim_engine),
  'countries', (SELECT coalesce(json_agg(json_build_object('k', geo_key, 'code', code, 'kind', kind, 'r', region_key,
                                                           'vb', virtual_brand_bit, 'h', hidden_standard) ORDER BY geo_key), '[]')
                  FROM rd.dim_country),
  'langs', (SELECT coalesce(json_agg(json_build_object('k', lang_key, 'code', code) ORDER BY lang_key), '[]') FROM rd.dim_lang),
  'rhq', (SELECT coalesce(json_agg(json_build_object('id', r.region_id, 'brand', r.brand_code,
                                                     'cc', (SELECT coalesce(json_agg(c.country_code ORDER BY c.country_code), '[]')
                                                              FROM app.rhq_region_country c WHERE c.region_id = r.region_id))
                                   ORDER BY r.region_id), '[]') FROM app.rhq_region r),
  'cats', (SELECT coalesce(json_agg(json_build_object('k', category_key, 'slug', slug, 'name', name, 'ord', ord) ORDER BY ord), '[]')
             FROM app.citation_category),
  'areas', (SELECT coalesce(json_agg(json_build_object('k', region_key, 'code', code) ORDER BY region_key), '[]') FROM rd.dim_region),
  'hidden', (SELECT coalesce(json_agg(json_build_object('s', surface, 'cc', country_code) ORDER BY surface, country_code), '[]')
               FROM app.hidden_market),
  'projects', (SELECT coalesce(json_agg(json_build_object('k', project_key, 's', surface, 'root', is_root, 'pid', project_id,
                                                          'site', site_id, 'sb', site_brand_bit, 'sg', site_geo_key) ORDER BY project_key), '[]')
                 FROM rd.dim_project WHERE surface IN (1, 2))
) AS refs
"""


def parse_refs(raw: dict[str, Any] | str) -> Refs:
    d = json.loads(raw) if isinstance(raw, str) else raw
    ups = [x["code"].upper() for x in d["countries"]]
    dup = sorted({c for c in ups if ups.count(c) > 1})
    if dup:     # 국가 조회는 대소문자 무시(upper 키)라 대소문자만 다른 코드가 둘이면 어느 쪽인지 정할 수 없다
        raise ValueError(f"rd.dim_country 코드가 대소문자만 달리 중복: {dup}")
    return Refs(
        brands=tuple(Brand(x["code"], int(x["bit"]), bool(x["umb"]), x["parent"], int(x["ord"])) for x in d["brands"]),
        owned_bases=tuple(OwnedBase(int(x["k"]), x["kind"], x["prefix"], x["brand"], x["geo"], x["lang"]) for x in d["owned"]),
        engines={x["code"]: (int(x["k"]), bool(x["d"])) for x in d["engines"]},
        countries={x["code"].upper(): Country(int(x["k"]), x["code"], x["kind"], x["r"], x["vb"], bool(x["h"]))
                   for x in d["countries"]},     # 키 = 대문자(대소문자 무시 조회), Country.code = 원래 표기(SA-Dammam 등 가상 지역)
        langs={x["code"].lower(): int(x["k"]) for x in d["langs"]},
        rhq={x["id"]: (x["brand"], tuple(x["cc"])) for x in d["rhq"]},
        categories={x["slug"]: int(x["k"]) for x in d["cats"]},
        projects=tuple(ProjectDim(int(x["k"]), int(x["s"]), bool(x["root"]), x["pid"], x["site"], int(x["sb"]), int(x["sg"]))
                       for x in d["projects"]),
        areas={int(x["k"]): x["code"] for x in d.get("areas", ())},
        hidden_markets={s: frozenset(h["cc"].upper() for h in d.get("hidden", ()) if h["s"] == s)
                        for s in sorted({h["s"] for h in d.get("hidden", ())})},
        category_refs={int(x["k"]): CategoryRef(int(x["k"]), x["slug"], x.get("name") or x["slug"], int(x.get("ord") or 0))
                       for x in d["cats"]},
    )


# A41 보정 집합(Refs.cat_diff): 삭제 포함 카탈로그가 비삭제 카탈로그와 다른 글로벌 프롬프트. 소형 차원 표 1회 스캔(stg 2.8만 행 수 ms)
# 표 이름 = 사실 표 이름 자리(core.facts, 동결 스냅샷 층 S0). 참조 차원은 스코프 없이 적재하므로 늘 LIVE.
_CAT_DIFF_SQL = f"""
SELECT coalesce(json_agg(json_build_array(d.prompt_key, d.cat_mask_all) ORDER BY d.prompt_key), '[]')
  FROM {fact_tables().prompt} d
 WHERE d.surface = 1 AND (d.cat_mask_all, d.in_root_catalog_all) IS DISTINCT FROM (d.cat_mask, d.in_root_catalog)
"""


async def load_refs(conn) -> Refs:
    """요청 트랜잭션 안에서 참조 차원을 한 문장으로 읽는다(conn = SQLAlchemy AsyncConnection).
    현행 프로필 catalog_incl_deleted 가 켜져 있으면 A41 보정 집합(Refs.cat_diff)을 한 문장 더 읽는다(꺼짐 = 종전과 같은 한 문장)."""
    from dataclasses import replace

    from sqlalchemy import text

    from app.core.profile import active_profile

    row = (await conn.execute(text(_REFS_SQL))).first()
    refs = parse_refs(row[0])
    if active_profile().catalog_incl_deleted:
        raw = (await conn.execute(text(_CAT_DIFF_SQL))).first()[0]
        d = json.loads(raw) if isinstance(raw, str) else raw
        refs = replace(refs, cat_diff=tuple((int(k), None if m is None else int(m)) for k, m in d))
    return refs
