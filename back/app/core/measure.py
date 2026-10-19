"""지표 SQL 빌더(모듈 간 순환을 끊는 중립 패키지). 기능 모듈은 지표 식을 다시 쓰지 않고 여기서 조립한다.

정본 식
- 언급 계열(M01~M04, G-03): rd.answer 당사 열(own_mask·ment_*·sent_*·own_rk_*) 을 관점 비트(own_bits)로 고른다. 모수 = std_in.
  M04(D5) 다중 관점(HMG 전사) = 3사 순위 중 0 을 뺀 최솟값 LEAST(NULLIF(…)).
- 인용 계열(M05, G-25): rd.answer 인용 수 열(cit_*)로 낸다. rd.citation 을 스캔하지 않는다. 모수 = cit_in ∧ 호스트 있는 인용.
  M05 인용 점유율 분자(part 'citations' 의 열 cit_m05, ratios() 가 이 열만 읽는다):
    global          = 출처 카테고리 Official (HMG) 인용 수(동기화 S1 BE-4 = hmg-geo 2670a16 #320·#321 lib/kpi/official-hmg-citations.ts,
                      제품 책임자 Q2 (a)): Σ rd.answer.cit_off(DB-v2.13 P71, 적재 시 rd.dim_source.category_key 로 센 답변 열). 관점 브랜드·국가·언어로
                      좁히지 않는다(현행 분자는 그룹 키의 카테고리만 본다: 공식 도메인·공식 소셜·오버라이드, 브랜드 무관). 원소 스캔이면 같은 판정을
                      rd.citation 원소에서 센다(OFFICIAL_SOURCES). 오버라이드 편집은 재판정(judgment_change 'citation_override') 뒤 반영된다.
    website·project = 종전 표면 자사 판정 = cit_owned(아래 자사 식의 local 모드와 같은 값)
  자사 cit_owned(QUERY-FIXES C-1·G-1 own_expr, C-3 프롬프트별 자사 인용·K-3 밖 소비는 종전 그대로):
    website = (loc_owned ∨ tgt_hit) → cit_loc_tgt · project = loc_owned → cit_loc
    global  = owner_key = ANY(허용 배열: 관점 브랜드의 app.owned_base, 국가·언어 필터로 좁히되 결과가 비면 안 좁힘)
      · 안 좁힘(brand)          → Σ cit_own_{h,k,g}
      · 국가 1개로 좁힘(country1) → Σ cit_own_{h,k,g}c   (답변 국가 = 선택 국가라 정확)
      · 국가 2개 이상(countryN)  → cit_own_x = 0 인 답변은 Σ cit_own_*c, cit_own_x > 0 인 답변만 rd.citation PK 조인으로 정확히 센다
      · 언어로 좁힘(scan)        → rd.citation 스캔(글로벌 lang[] 은 K-1·K-2·K-3·T-1 지원 축(BG-01, KPI_SUPPORT): 언어를 고를 때만 이 경로)
- M06·M07(A2): rd.answer tgt_cited·own_url_cited(측정 단위), 웹사이트 R09 발행 회차는 rd.report_unit_value 로 대체(url_rates).
  분모 = cit_in 답변 중 website 는 web_reg(웹사이트 카탈로그 등록 프롬프트), project 는 게이트 없음(Q5: 적재 시 project_tracked_url·
  project_owned_base 판정). global 은 M06·M07 대상이 아니다(web_reg 거짓이라 분모 0). 인용 정확도(K-1) = 타겟 ∧ 자사 / 자사(라이브).
  프롬프트 단위(part 'url_prompts', 제품 결정 6 DC-02 현행 문구 유지): 같은 모수 답변의 서로 다른 prompt_key 수(측정 프롬프트)와 그중
  tgt_cited·own_url_cited 답변이 하나라도 있는 프롬프트 수(현행 front aggregateWebsiteTargetHitRate = 답변 플래그를 프롬프트로 bool_or).
- 출처 카테고리 축(source[]): 유효 카테고리 = coalesce(오버라이드, rd.dim_source.category_key)(CATEGORY_EXPR, 적재기 category_of 와 같은
  우선순위)가 선택 집합인 출처로의 차원 세미조인. 답변 열(cit_*)은 출처 무관 합이라 출처 축이 있으면 인용 계열은 원소 스캔으로 센다.
- M-1 경쟁사(QUERY-FIXES M-1): NOT (own_bit = ANY(:관점 비트)), 형제 HMG 브랜드는 경쟁 행에 남는다. 순위는 앱에서(LIMIT 금지).

술어 규약(DESIGN-CONTRACT §3): WHERE 는 불리언·= ANY(상수 배열)만, 비트 식은 FILTER 안에서만. 사실 표 질의는 Window.where 3술어 필수.
열·식 조각은 이 파일의 화이트리스트에서만 고른다(사용자 문자열을 SQL 에 넣지 않는다).

D6 보장: 카드(group_by 없음)·추이(round_date·week·month)·엔진(engine)·국가(geo) 가 같은 빌더라 카드 = 버킷 합이다.
성능: count(DISTINCT) 는 병렬 집계를 막으므로 M12 측정 프롬프트 수(part 'prompts')는 별도 문장으로 분리한다.
점유율만 쓰는 소비자(B094 웹사이트 GEO, Q8 언급 수 지표만)는 part 'sov'(답변 수·당사 언급·전체 언급 3열 = 'mentions' 의 같은 식)와
brand_rows(mentions_only=True)(경쟁 행 언급 수만)로 노출·감성·순위 열을 계산하지 않는다. 남는 열의 값은 'mentions'·기본 경쟁 행과 같다.

현행 프로필(core.profile, 제품 결정 19·23~25, WU-1 골격): MeasureScope.profile 의 스위치가 모수 술어 자리(mention_population·
citation_population·scope_where(카드 경로 엔진)·m05_den_col)를 바꾼다. 전부 꺼짐(OFF)이면 이 자리들이 도입 전과 같은 문자열을 내어 문장·응답이 바이트 같다.
구현 전 스위치가 켜지면 core.profile.require_slot 이 NotImplementedError 로 막는다(조용히 옛 정의로 돌지 않게).

이 파일의 빌더 층(plan_counts·merge_counts·*_sql)은 표준 라이브러리 + app.core.{codes,cycles,sqlb,profile} 만 쓴다(대조 러너 재사용).
"""
from __future__ import annotations

import re
import unicodedata
from collections.abc import Collection, Iterable, Sequence
from dataclasses import dataclass, field, replace
from datetime import date
from typing import Any, Literal

from app.core.codes import BRAND_OWN_COLS, OwnedBase, Refs
from app.core.cycles import Window
from app.core.facts import fact_tables, frozen_read
from app.core.profile import OFF, LegacyProfile, require_slot
from app.core.sqlb import Binder, Sql

OwnerMode = Literal["brand", "country1", "countryN", "scan", "local"]
Part = Literal["mentions", "sov", "rank_detail", "prompts", "gap", "urls", "url_prompts", "citations"]
DEFAULT_PARTS: tuple[str, ...] = ("mentions", "gap", "urls", "citations")
# 'sov' = 'mentions' 의 부분집합(answers·own_mentions·total_mentions, B094). 둘 다 주면 'mentions' 가 이긴다.
ALL_PARTS: tuple[str, ...] = ("mentions", "sov", "rank_detail", "prompts", "gap", "urls", "url_prompts", "citations")

# group_by 화이트리스트: 이름 → (결과 열 이름, 식 템플릿). {a} 는 별칭.
GROUPS: dict[str, tuple[str, str]] = {
    "engine": ("engine_key", "{a}.engine_key"),
    "geo": ("geo_key", "{a}.geo_key"),
    "lang": ("lang_key", "{a}.lang_key"),
    "project": ("project_key", "{a}.project_key"),
    "prompt": ("prompt_key", "{a}.prompt_key"),
    "cycle": ("cyc_key", "{a}.cyc_key"),
    "round_date": ("round_date", "{a}.round_date"),
    "week": ("week", "date_trunc('week', {a}.round_date)::date"),
    "month": ("month", "date_trunc('month', {a}.round_date)::date"),
}
CITATION_GROUPS: dict[str, tuple[str, str]] = {**GROUPS, "source": ("source_key", "{a}.source_key"), "url": ("url_key", "{a}.url_key")}


# ════════════════════════════════════════════════════════════════════════════
# 입력: 관점·스코프(ReadContext 가 만든다)
# ════════════════════════════════════════════════════════════════════════════
@dataclass(frozen=True)
class OwnerScope:
    """글로벌 M05 자사 허용 배열과 그 좁힘 상태(allowed_owner_keys 결과)."""
    keys: tuple[int, ...]
    own_bits: tuple[int, ...]              # 허용 배열 브랜드의 당사 열 비트(1·2·4)
    countries: tuple[str, ...] | None      # 요청(스코프 교집합) 국가 ISO, None = 국가 필터 없음
    country_narrowed: bool
    lang_narrowed: bool

    @property
    def mode(self) -> OwnerMode:
        if self.lang_narrowed:
            return "scan"
        if self.country_narrowed:
            return "country1" if self.countries is not None and len(self.countries) == 1 else "countryN"
        return "brand"


def allowed_owner_keys(owned_bases: Iterable[OwnedBase], own_brand_codes: Collection[str], own_bit_of: dict[str, int],
                       countries: Sequence[str] | None, langs: Sequence[str] | None) -> OwnerScope:
    """QUERY-FIXES 공통 기호 :allowed_owner_keys (ownedBasePrefixesForScope hmg-brands.ts:242 이식).
    관점 브랜드의 owned_base(kind base·root_home 모두) → 국가 필터로 좁힘(비면 안 좁힘) → 언어 필터로 좁힘(비면 안 좁힘).
    관점 브랜드에 베이스가 하나도 없으면 전체(판정 공집합 방지)."""
    bases = list(owned_bases)
    by_brand = [o for o in bases if o.brand_code in own_brand_codes] or bases
    narrowed = by_brand
    cn = ln = False
    codes = sorted({c.upper() for c in (countries or ()) if c})
    if codes:
        byc = [o for o in narrowed if o.geo_code and o.geo_code.upper() in codes]
        if byc:
            narrowed, cn = byc, True
    ls = {x.lower() for x in (langs or ()) if x}
    if ls:
        byl = [o for o in narrowed if o.language and o.language.lower() in ls]
        if byl:
            narrowed, ln = byl, True
    bits = tuple(sorted({own_bit_of[o.brand_code] for o in by_brand if o.brand_code in own_bit_of}))
    return OwnerScope(keys=tuple(sorted(o.owner_key for o in narrowed)), own_bits=bits,
                      countries=tuple(codes) if codes else None, country_narrowed=cn, lang_narrowed=ln)


@dataclass(frozen=True)
class MeasureScope:
    """빌더 입력(순수 값). None = 그 축 무제한, 빈 튜플 = 전부 거부(fail-closed)."""
    sf: int
    project_keys: tuple[int, ...]
    own_bits: tuple[int, ...]                  # 관점 비트 ⊆ (1,2,4)
    bgrps: tuple[int, ...] | None              # 모수 bgrp 허용 값(project 표면 None)
    pop_bits: tuple[int, ...] = ()             # 카탈로그 적용 비트(관점 브랜드 비트 ∪ 엄브렐러), M12 적용 프롬프트
    geo_keys: tuple[int, ...] | None = None
    lang_keys: tuple[int, ...] | None = None
    engine_keys: tuple[int, ...] | None = None  # None = 기본 엔진(dflt)
    prompt_keys: tuple[int, ...] | None = None  # 택소노미·커스텀 필드로 푼 프롬프트(None = 무제한)
    owner: OwnerScope | None = None             # 글로벌 M05
    source_category_keys: tuple[int, ...] | None = None   # 출처 카테고리(source[]) 축, None = 무제한
    default_engine_keys: tuple[int, ...] = ()   # rd.dim_engine.is_default(dflt 열이 없는 표: rd.acr_cell)
    profile: LegacyProfile = OFF                # 현행 프로필(core.profile). ReadContext.measure() 가 활성 프로필을 싣는다
    card: bool = False                          # 대시보드 카드 경로 요청(CommonFilters.card): 현행 프로필 summary_all_engines 의 대상
    # A41(catalog_incl_deleted) 보정 집합 = Refs.cat_diff((prompt_key, cat_mask_all), 삭제 포함 카탈로그 ≠ 비삭제 카탈로그인 글로벌 프롬프트).
    # None = 모름(직접 만든 스코프·시험) → catalog_all_pred 가 dim_prompt 세미조인(정의 그대로)으로 간다
    cat_diff: tuple[tuple[int, int | None], ...] | None = None
    # 동결 층(freeze_at_publish, S3): 글로벌 추이 격자 요청(현행 X.trendGrid)이면 in_full_cycle 게이트 없는 격자 뷰(core.facts.GRID)
    frz_grid: bool = False
    # 동결 층 창 판정(S4): 창 회차가 전부 동결 회차(세대 없는 발행 회차 = 구멍 없음)일 때 ReadContext.card_window 가 세운다. 거짓이면 동결 읽기 아님
    frz_ok: bool = False
    # 동결 층 택소노미 축(S4): 글로벌 택소노미 필터의 축별 rd.dim_taxon 키(버린 값 제외, (축, 키) 오름차순). 동결 읽기면 prompt_keys(조회 시점
    # 카탈로그 해석) 대신 frz.card_axis(생성 시점 축)로 건다(frozen_taxon_pred). None = 택소노미 축 없음 또는 동결 축으로 못 푸는 요청(depth4)
    taxon: tuple[tuple[str, tuple[int, ...]], ...] | None = None
    # 동결 읽기 창 회차 키(S4, ReadContext.bind_frozen 이 창에서 싣는다): 옆 표 술어(웹 유닛 게이트·택소노미 축)를 창 회차로 좁힌다(지연: 활성 세대
    # 전체가 아니라 창 회차의 셀만 해시한다). None = 좁히지 않음(값은 같다: 사실 표 문장이 창 3술어를 이미 건다)
    frz_keys: tuple[int, ...] | None = None

    def owner_mode(self) -> OwnerMode:
        if self.sf != 1:
            return "local"
        if self.owner is None:
            raise ValueError("글로벌 표면 인용 지표에는 OwnerScope 가 필요하다")
        return self.owner.mode


def split_own_scopes(ms: MeasureScope) -> tuple[tuple[int, MeasureScope], ...]:
    """D13 split_own(추가형 공용 판정): 관점 비트가 둘 이상이면 비트별 당사 스코프를 비트 오름차순(1 Hyundai·2 Kia·4 Genesis)으로 낸다.
    모수(bgrps·pop_bits)·필터 축·프로젝트는 그대로 두고 own_bits 만 그 비트 하나로 바꾼다: 당사 열(own_mask·ment_x·sent_x·own_rk_x)을
    브랜드 하나로 읽되 분모(답변·전체 언급)는 관점 전체와 같다(현행 다중 관점 표의 Hyundai·Kia·Genesis 각 행).
    관점 비트가 하나면 빈 튜플(분리 없음 = 기존 합친 1행). 행 키(own_brand_code)는 호출자가 Refs.brand_code_of_bit 로 붙인다.
    글로벌 M05 자사 허용 배열(owner)은 관점 전체 기준이라 None 으로 비운다: 분리 스코프로 인용 계열을 세면 core 가 ValueError 로 막는다
    (분리는 언급 계열 M01~M04 전용)."""
    bits = tuple(sorted(set(ms.own_bits)))
    if len(bits) < 2:
        return ()
    return tuple((x, replace(ms, own_bits=(x,), owner=None)) for x in bits)


def split_own_label(refs: Refs, bit: int) -> str:
    """D13 split_own 행 키(own_brand_code) 정본(core 8라운드, bg-mentions-answers R2·bg-trend-geo R4: 두 그룹이 같은 식을 각자 두던 것을
    한 곳으로). 그 비트의 부모 브랜드 코드(Refs.brand_code_of_bit)이고, 하위 브랜드(Hyundai N)가 관점이어도 부모 비트 1 = 'Hyundai' 로 붙인다
    (분리 값은 비트 단위라 비트 1 행은 Hyundai 전체 값). 비트에 브랜드가 없으면 비트 숫자 문자열. brand_key 는 같은 이름의
    rd.dim_brand_name 조회(GET /v1/mentions/brands 당사 행 규칙, DECISIONS-API D13)."""
    return refs.brand_code_of_bit(bit) or str(bit)


def scope_where(ms: MeasureScope, a: str, b: Binder, *, dflt_column: bool = True) -> list[str]:
    """필터 축 술어(불리언·= ANY 만). 사실 표 4종·rd.acr_cell 공통 열 이름.
    엔진 축이 없으면 기본 엔진: dflt 열이 있는 표(사실 표 4종)는 {a}.dflt, 없는 표(rd.acr_cell)는 dflt_column=False 로
    engine_key = ANY(ms.default_engine_keys)(ReadContext 가 rd.dim_engine.is_default 로 채운다. 비면 결과 0, fail-closed).
    현행 프로필 자리: catalog_incl_deleted(A41, WU-4 구현: 글로벌 bgrp 술어 → 삭제 행 포함 카탈로그 세미조인 catalog_all_pred).
    rd.acr_cell(dflt_column=False)도 같은 술어를 받지만 ACR 셀 게이트(acr_in)의 카탈로그 판정은 바꾸지 않는다(퍼널 ACR 은 A41 밖).
    현행 프로필 자리: summary_all_engines(DFLT·DC-01, WU-3 구현: 카드 경로(ms.card) 사실 표는 엔진 축이 없으면 전 엔진 = 엔진 술어 없음.
    현행 집계층 리더 summary-trend-aggregates.ts:730 은 엔진을 고른 때만 거른다. rd.acr_cell 은 카드 경로가 아니라 기본 엔진 그대로)."""
    require_slot(ms.profile, "catalog_incl_deleted", "summary_all_engines")
    w = [f"{a}.project_key = ANY({b.ints(ms.project_keys)})"]
    if catalog_all(ms):
        w.append(catalog_all_pred(ms, a, b))
    elif ms.bgrps is not None:
        w.append(f"{a}.bgrp = ANY({b.ints(ms.bgrps)})")
    if ms.engine_keys is None:
        if not (dflt_column and ms.card and ms.profile.summary_all_engines):
            w.append(f"{a}.dflt" if dflt_column else f"{a}.engine_key = ANY({b.ints(ms.default_engine_keys)})")
    else:
        w.append(f"{a}.engine_key = ANY({b.ints(ms.engine_keys)})")
    if ms.geo_keys is not None:
        w.append(f"{a}.geo_key = ANY({b.ints(ms.geo_keys)})")
    if ms.lang_keys is not None:
        w.append(f"{a}.lang_key = ANY({b.ints(ms.lang_keys)})")
    if ms.prompt_keys is not None:
        if frozen_read(ms) and ms.taxon is not None:
            fp = frozen_taxon_pred(ms.taxon, a, b, keys=ms.frz_keys)
            if fp:
                w.append(fp)
        else:
            w.append(f"{a}.prompt_key = ANY({b.ints(ms.prompt_keys, 'int4')})")
    return w


# 동결 축 열(frz.card_axis): 택소노미 축 → 열. presence 는 집합(현행 presence_set && 한쪽 선택)
TAXON_AXIS_COLS = {"funnel": "funnel_key", "list_type": "list_type_key", "depth1": "depth1_key", "depth2": "depth2_key",
                   "depth3": "depth3_key", "brand_presence": "presence_keys"}


def frozen_taxon_pred(taxon: tuple[tuple[str, tuple[int, ...]], ...], a: str, b: Binder, *,
                      keys: tuple[int, ...] | None = None) -> str | None:
    """동결 층 택소노미 술어(S4): (회차, 프롬프트)가 그 회차 동결 세대의 축 값으로 필터를 통과한다(현행 trendWhere summary-trend-aggregates.ts:741-753
    funnel_catalog·list_type·depth1 = ANY, presence_set && 선택값. depth2·3 은 현행 세부층(생성 시점 summary_prompt_dim) 값). 축이 없으면 None."""
    conds = []
    for axis, tk in taxon:
        col = TAXON_AXIS_COLS[axis]
        if axis == "brand_presence":
            conds.append(f"x.{col} && {b.v(sorted(tk), 'int2[]')}")
        else:
            conds.append(f"x.{col} = ANY({b.ints(tk)})")
    if not conds:
        return None
    if keys is not None:
        conds.insert(0, f"x.cyc_key = ANY({b.ints(keys, 'int4')})")
    return f"({a}.cyc_key, {a}.prompt_key) IN (SELECT x.cyc_key, x.prompt_key FROM frz.card_axis x WHERE {' AND '.join(conds)})"


# ════════════════════════════════════════════════════════════════════════════
# 모수 술어 자리(현행 프로필). 사실 표 4종 공통 열 이름(std_in·cit_in·is_rep)이라 별칭만 바꿔 자식 표에도 쓴다.
# ════════════════════════════════════════════════════════════════════════════
PopTable = Literal["answer", "brand", "stance", "citation"]
_POP_TABLES = ("answer", "brand", "stance", "citation")


def _and(terms: Sequence[str]) -> str:
    return terms[0] if len(terms) == 1 else "(" + " AND ".join(terms) + ")"


def catalog_all(ms: MeasureScope) -> bool:
    """A41(catalog_incl_deleted, WU-4)이 이 스코프에 걸리나: 글로벌 표면만(웹사이트·프로젝트 elig 에는 카탈로그 게이트가 없다)."""
    return ms.profile.catalog_incl_deleted and ms.sf == 1


def catalog_all_pred(ms: MeasureScope, a: str, b: Binder) -> str:
    """A41 카탈로그 술어(scope_where 의 bgrp 자리): 삭제 행 포함 루트 카탈로그 브랜드 비트(rd.dim_prompt.cat_mask_all, DB-v2.15 P88)가
    관점 마스크(bgrps)인 프롬프트. 현행 CAT_CTE(surface-global.ts:117-135, deleted_at 술어 없음)의 catalog_brands·in_root_catalog 둘 다를 건다:
    cat_mask_all ≠ 0 ⇔ in_root_catalog_all(CHECK dim_prompt_cat_all_empty·엄브렐러 폴백), bgrps 에는 0 이 없다(core.codes.brand_masks).
    모수 열(std_in_nc·cit_in_nc, cell_rep 이면 is_rep: 현행 규칙은 카탈로그 무관 elig_nc 로 대표를 고른다)에는 카탈로그 게이트가 없으므로
    이 술어가 카탈로그 게이트다(mention_population·citation_population 과 한 쌍).
    bgrps 가 없으면(글로벌에서는 생기지 않는다) 카탈로그 소속만 건다(fail-closed 쪽: 카탈로그 밖 답변이 새지 않게)."""
    if frozen_read(ms):
        # 동결 층(freeze_at_publish, S3): 카드 뷰의 글로벌 bgrp = 동결 카탈로그 비트(frz.prompt.cat_mask = 현행 catalog_brands, 삭제 행 포함,
        # 0 = 루트 카탈로그 밖)라 사실 행 열 하나로 판정한다(현행 trendWhere in_root_catalog = 1 ∧ catalog_brands && 관점).
        # 비동결 회차 행은 rd bgrp(적재 때 비삭제 카탈로그 비트) 그대로다(설계 12.10: 회차 단위 미러 폴백 대응).
        return f"{a}.bgrp <> 0" if ms.bgrps is None else f"{a}.bgrp = ANY({b.ints(ms.bgrps)})"
    if ms.bgrps is None:
        return f"{a}.prompt_key IN (SELECT d.prompt_key FROM {fact_tables(ms).prompt} d WHERE d.in_root_catalog_all)"
    if ms.cat_diff is not None:
        # 보정 집합 형(성능, WU-5): 삭제 포함 카탈로그가 비삭제 카탈로그와 같은 프롬프트는 cat_mask_all = cat_mask = 사실 표 bgrp(적재 사본,
        # 카탈로그 재판정은 dim_prompt 갱신과 같은 트랜잭션에서 그 답변을 재투영한다. stg 2026-10-01 불일치 0/35만)라 bgrp ∈ bgrps 와 같다.
        # 다른 프롬프트(보정 집합 D, stg 115)만 cat_mask_all 로 판정한다: (bgrp ∈ bgrps ∧ prompt ∉ D) ∨ prompt ∈ D_ok.
        # 세미조인 형은 계획기가 모수 행을 (카탈로그 프롬프트 수 / 전체 프롬프트 수)만큼 적게 추정해 병렬 계획을 버렸다
        # (stg 9/28 /citations/domains 610 → 930ms, /citations/sources 755 → 1,093ms). 이 형은 D 가 비면 종전(끔)과 같은 술어다.
        want = set(ms.bgrps)
        dk = sorted(k for k, _ in ms.cat_diff)
        ok = sorted(k for k, m in ms.cat_diff if m is not None and m in want)
        base = f"{a}.bgrp = ANY({b.ints(ms.bgrps)})"
        if dk:
            base = f"({base} AND NOT ({a}.prompt_key = ANY({b.ints(dk, 'int4')})))"
        return f"({base} OR {a}.prompt_key = ANY({b.ints(ok, 'int4')}))" if ok else base
    return f"{a}.prompt_key IN (SELECT d.prompt_key FROM {fact_tables(ms).prompt} d WHERE d.cat_mask_all = ANY({b.ints(ms.bgrps)}))"


def web_units(ms: MeasureScope) -> bool:
    """WEBREG16(web_registered_only, WU-7)이 이 스코프에 걸리나: website 표면 ∧ 카드 경로 요청(ms.card = CommonFilters.card).
    현행에서 보고서 유닛 게이트는 집계층(사실표) 읽기에만 있고, 카드 경로 요청(front cardParam, WU-3 2f5213d3: 요약·카드 브랜드·추이·GEO·
    웹 엔진 배지·기간 없는 도메인·기간 비교)이 곧 현행 집계층 경로다. 답변 분석 화면(현행 미러 cumulative 경로)은 card 를 보내지 않아 게이트가 없다."""
    return ms.profile.web_registered_only and ms.sf == 2 and ms.card


def web_unit_pred(a: str) -> str:
    """WEBREG16 모수 술어(별칭 a 의 사실 표 4종 공통 prompt_key): 보고서 유닛 소속(rd.web_report_prompt, DB-v2.16 P93) ∧ 제외 유닛 아님
    (app.website_report_excluded P92). 현행 summary-website-aggregates.ts:226-240 unitWhere(report_fs IS NOT NULL ∧ report_fs <> ALL(제외))와
    summary-trend-aggregates.ts:718-727(집계층 report_fs <> 0 ∧ <> ALL(제외)).

    제외 판정은 <> ALL(ARRAY(제외 file_seq)) 형(성능, be/web-card-perf 2026-10-01). 종전 NOT EXISTS 형과 같은 집합이다: 두 열이 NOT NULL
    (P92 file_seq PRIMARY KEY, P93 report_fs NOT NULL)이고 빈 배열이면 <> ALL 은 참. NOT EXISTS 형은 제외 표(3행)가 한 번도 ANALYZE 되지
    않아(reltuples -1, 자동 분석 임계 50행 미만이라 앞으로도 안 된다) 계획기가 반 조인 결과를 1행으로 잡았다. 그러면 모수 세미조인이 1행짜리
    안쪽을 행마다 되감는 Nested Loop 가 되고(stg hmg_r2 9/25 웹 카드 브랜드 범위 계정: 1.6만 행 × 5,111 = 8,444만 비교, mentions/brands
    4.9s), 위 CTE 들도 1행 추정을 물려받아 도메인 목록의 합계(t)를 출처 행마다 다시 접었다(citations/domains 2.2s). InitPlan 배열 형은
    제외 표 통계와 무관하게 web_report_prompt 통계(9,161 추정 대 9,814 실제)로 추정되어 해시 세미조인을 고른다."""
    return (f"{a}.prompt_key IN (SELECT w.prompt_key FROM rd.web_report_prompt w "
            "WHERE w.report_fs <> ALL (ARRAY(SELECT x.file_seq FROM app.website_report_excluded x)))")


def web_unit_pred_frozen(a: str, keys: tuple[int, ...] | None = None) -> str:
    """WEBREG16 동결 읽기 형(S4): 생성 시점 보고 유닛 소속(frz.card_web.report_fs = 현행 summary_answers.report_fs, 셀 단위) ∧ 제외 유닛 아님
    (제외는 현행도 조회 시점 summary_settings website_excluded_fs). 현행 summary-website-aggregates.ts:226-240 unitWhere 와 같은 뜻."""
    # 창 회차 키는 리터럴로 싣는다(술어가 FILTER 여러 곳에 반복돼도 바인드 없이 같은 문자열: 모수 술어 함수는 Binder 를 받지 않는다)
    kw = f"w.cyc_key = ANY('{{{','.join(str(int(k)) for k in sorted(set(keys)))}}}'::int4[]) AND " if keys is not None else ""
    return (f"({a}.cyc_key, {a}.answer_key) IN (SELECT w.cyc_key, w.answer_key FROM frz.card_web w WHERE {kw}w.report_fs IS NOT NULL "
            "AND w.report_fs <> ALL (ARRAY(SELECT x.file_seq FROM app.website_report_excluded x)))")


def unit_gate_of(ms: MeasureScope, a: str, table: PopTable = "answer") -> list[str]:
    """WEBREG16 모수 술어 자리: 동결 읽기면 생성 시점 유닛, 아니면 조회 시점 유닛(web_unit_pred). 걸리지 않으면 [].
    동결 읽기의 웹 사실 표(답변·브랜드·인용 = 웹 카드 읽기 뷰 core.facts.CARD_WEB)는 행 열 {a}.unit_in(DB-v2.24 P127), 그 밖(스탠스)은 반조인형."""
    if not web_units(ms):
        return []
    if not frozen_read(ms):
        return [web_unit_pred(a)]
    return [f"{a}.unit_in"] if table in ("answer", "brand", "citation") else [web_unit_pred_frozen(a, ms.frz_keys)]


def mention_population(ms: MeasureScope, a: str, table: PopTable = "answer") -> str:
    """언급 계열 모수(M01~M04·M12·경쟁 행): 기본 = std_in(elig ∧ ACR 첫 반복 ∧ 분석 있음). table = 별칭 a 가 가리키는 사실 표
    (answer = rd.answer, brand = rd.answer_brand, stance = rd.answer_stance). 표마다 가진 게이트 사본 열이 달라 식이 표를 안다.
    현행 프로필 자리: cell_rep(A1, WU-2: 회차 셀 대표만 = is_rep), acr_iter_unfolded(A15, WU-2), gap_in_population(A16, WU-2·WU-10),
    web_registered_only(WEBREG16, WU-7: 웹 집계층 = 보고서 유닛 소속 프롬프트만), freeze_at_publish(GEN, 신규: 발행 시점 고정),
    catalog_incl_deleted(A41, WU-4: 글로벌은 std_in 자리가 std_in_nc, 카탈로그 게이트는 scope_where 가 건다 → scope_where 와 함께만 쓴다).

    cell_rep(WU-2) 식. is_rep 은 elig 를 함의한다(hub 규칙: ingest REP_UPDATE·rd.rep_expected, 단언 rd.assert_rep). 현행 규칙
    (rep_pick_latest_first)은 카탈로그 무관 elig_nc 를 함의한다(현행 대표 선정은 카탈로그를 보지 않는다, WU-4): 글로벌 카탈로그 게이트는
    scope_where(bgrp 또는 A41 세미조인)가 건다(카탈로그 소속은 프롬프트 속성이라 셀 안에서 같다).
      rd.answer            is_rep [∧ acr_in(A15 꺼짐)] [∧ NOT gap(A16 꺼짐)]. 둘 다 꺼지면 is_rep ∧ std_in(같은 뜻, 열 하나)
      answer_brand·stance  is_rep [∧ std_in(A16 꺼짐)]. std_in 사본의 acr_in 은 is_rep 이 함의한다(셀 최신 = 그 run-셀 최신,
                           rd.assert_rep 이 대표의 acr_in 을 센다: stg 2026-10-01 위반 0). answer_brand 에는 결손 답변 행이 없고(stg 0행)
                           answer_stance 에는 있어(stg 38행, 분석 대기) A16 켜짐이면 std_in 을 빼야 결손 답변 스탠스가 들어온다.
      전부 켜짐(현행 = CURRENT) = 표와 무관하게 is_rep 하나(불리언 술어, 세미조인 없음. A41 은 scope_where 세미조인만 더한다)."""
    require_slot(ms.profile, "cell_rep", "acr_iter_unfolded", "gap_in_population", "web_registered_only", "freeze_at_publish")
    if table not in _POP_TABLES or table == "citation":
        raise ValueError(f"언급 모수 표가 아니다: {table}")
    p = ms.profile
    std = f"{a}.std_in_nc" if catalog_all(ms) else f"{a}.std_in"   # A41(WU-4): 카탈로그 게이트를 뺀 모수 열(DB-v2.15 P89)
    unit = unit_gate_of(ms, a, table)                             # WEBREG16(WU-7): 웹 집계층 = 보고서 유닛 소속 프롬프트만(동결 읽기 = 생성 시점)
    if not p.cell_rep:          # A15·A16 은 cell_rep 없이 켤 수 없다(core.profile.REQUIRES)
        return _and([std] + unit)
    t = [f"{a}.is_rep"]
    if table == "answer":
        if not p.acr_iter_unfolded and not p.gap_in_population:
            t.append(std)
        elif not p.acr_iter_unfolded:
            t.append(f"{a}.acr_in")
        elif not p.gap_in_population:
            t.append(f"NOT {a}.gap")
    elif not p.gap_in_population:
        t.append(std)
    return _and(t + [g for g in frozen_gate(ms, a, table) if g not in t] + unit)


# 동결 읽기 셀 게이트 열(표별). 동결 뷰 is_rep 은 참 고정이라 rd 의 "is_rep ⇒ elig_nc ∧ acr_in" 함의가 동결 셀에는 없다(아래 frozen_gate).
FROZEN_GATE_COL: dict[str, str] = {"answer": "cit_in_nc", "brand": "std_in_nc", "citation": "cit_in_nc"}


def frozen_gate(ms: MeasureScope, a: str, table: PopTable = "answer") -> list[str]:
    """동결 읽기 셀 게이트(be/int3-frztrend): 현행 집계층 조회 게이트 run_status·in_tagged_region·숨김 국가(summary-trend-aggregates.ts:674-753
    trendWhere, summary-global-aggregates.ts:150-160)의 허브 대응 = 행 열 elig_nc(카탈로그 무관 elig, 표마다 그 사본 cit_in_nc·std_in_nc).

    왜: 현행 셀 집합(summary_cycle_jobs)은 게이트 없이 (프롬프트, 엔진, 지역)마다 최신 completed 답변을 굳히고(scripts/summary/surface-global.ts:465-477),
    run_status·in_tagged_region(생성 시점 값, global-predicates.ts:104-108 = 한국어 비-KR 제외 ∧ 태깅 시장 밖 제외)·숨김 국가는 조회 때 건다.
    이관(ops) 세대 셀은 그 집합 그대로라 게이트 밖 셀을 담는다(stg 2026-10-02: 활성 글로벌 셀 282,581 중 28,965, 7월~8월 회차 14개).
    동결 뷰는 is_rep 을 참으로 고정하므로 rd 의 '대표 ⇒ elig_nc' 함의가 없어 그 셀이 모수에 들어갔다(C01 07-06 가시성 분모 2,136 대 현행 356).
    값의 시점: 동결 뷰 행은 셀 rd 행이고 생성 뒤 값이 바뀐 행은 보관(frz.keep_*, 장부 열 밖 값 열 전부 비교: DB-v2.21 P117)이라 이 열은 생성 시점
    값을 따른다. 이관 세대의 rd elig_nc = 운영 생성 시점 in_tagged_region(frz.prompt.regions·is_korean + rd.job.measured_at 재계산, stg 불일치 0).
    표: answer = cit_in_nc(elig_nc ∧ acr_in: 갭 답변은 모수에 남는다, gap_in_population), brand = std_in_nc(브랜드 행은 분석 답변뿐),
    citation = cit_in_nc. stance 는 동결 대상이 아니라(core.facts: rd.answer_stance) rd is_rep 이 이미 함의한다 → 없음.
    웹사이트는 elig_nc = elig = run_status 게이트(현행 trendWhere 공통 run_status IN (completed, partial_failed))."""
    if not frozen_read(ms) or table not in FROZEN_GATE_COL:
        return []
    return [f"{a}.{FROZEN_GATE_COL[table]}"]


def citation_population(ms: MeasureScope, a: str, table: PopTable = "answer", *, unit_gate: bool = True, analysis_path: bool = False) -> str:
    """인용 계열 모수(M05·M06·M07): 기본 = cit_in(elig ∧ ACR 첫 반복, 결손 포함 G-21 g). table = answer(rd.answer) | citation(rd.citation).
    현행 프로필 자리: cell_rep(A1, WU-2: is_rep [∧ cit_in(A15 꺼짐)]), acr_iter_unfolded(A15, WU-2), web_registered_only(WEBREG16, WU-7 구현:
    웹 집계층 = 보고서 유닛 소속 프롬프트만, web_unit_pred), freeze_at_publish(GEN, 신규), catalog_incl_deleted(A41, WU-4: 글로벌은 cit_in 자리가
    cit_in_nc, scope_where 와 한 쌍). A16 은 인용 계열에 영향이 없다(인용 모수는 원래 결손 포함).
    unit_gate=False: WEBREG16 게이트를 걸지 않는다(URL 인용률 프롬프트 단위 url_prompts 전용: 현행 summaryPromptHitRatesSql
    summary-website-aggregates.ts:1244-1271 은 sharedWhere 만 쓰고 유닛 게이트가 없다)."""
    require_slot(ms.profile, "cell_rep", "acr_iter_unfolded", "web_registered_only", "freeze_at_publish")
    if table not in ("answer", "citation"):
        raise ValueError(f"인용 모수 표가 아니다: {table}")
    p = ms.profile
    cit = f"{a}.cit_in_nc" if catalog_all(ms) else f"{a}.cit_in"
    unit = unit_gate_of(ms, a, table) if unit_gate else []
    if not p.cell_rep:
        return _and([cit] + unit)
    t = [rep_term(ms, a, "c", analysis_path=analysis_path)] + ([] if p.acr_iter_unfolded else [cit])
    return _and(t + [g for g in frozen_gate(ms, a, table) if g not in t] + unit)


# 경로 대응표(현행 프로필 rep_round_date_cell, WU-12): (카드 요청, 계열) → 셀 대표. 시험이 rep_term 분기와 대조한다(tests/core/test_rep_seat.py).
#   기준 is_rep = 답변분석 경로 대표(미러 앵커 축 scope-aggregates.ts:1820-1851 + cell-snapshot.ts:104-115: round_date 셀, 원본 시각 DESC, job_id DESC)
#   답변분석(card 없음, 또는 카드 요청 안의 미러 읽기 자리 analysis_path) 언급 = is_rep, 인용 = is_rep XOR rd.rep_cit_delta(인용 숨김 회차를 뺀 대표)
#   카드(card=true, 집계층 사실표 surface-global.ts:464-478 = 회차 셀 대표, 동결 스냅샷 층 frz 가 대체할 자리): 언급 = is_rep, 인용 = is_rep XOR 보정.
#     카드 인용 창(card_slot_rep)은 인용 숨김 회차를 빼고 자리 대표 회차를 고른다. 같은 round_date 에 인용 숨김 형제 회차가 있으면 is_rep(언급 기준)이
#     그 형제로 넘어가 셀이 카드 인용 분모에서 빠진다(int2 검증자 반례): 인용 계열은 경로와 무관하게 인용 숨김을 뺀 대표(보정 표)를 쓴다
REP_PATH: dict[tuple[bool, str], str] = {(True, "m"): "is_rep", (True, "c"): "is_rep^cit_delta", (False, "m"): "is_rep",
                                         (False, "c"): "is_rep^cit_delta"}


def rep_term(ms: MeasureScope, a: str, family: str, *, analysis_path: bool = False) -> str:
    """셀 대표 술어(cell_rep 일 때 모수의 첫 항). 기본 = {a}.is_rep. 현행 프로필 rep_round_date_cell(WU-12)이면 REP_PATH 대로
    답변분석 인용 계열만 is_rep XOR (answer_key ∈ rd.rep_cit_delta(표면)).
    지연: 비상관 해시 서브플랜은 파티션·병렬 작업자마다 다시 만든다(stg 1년 창 52회, +75ms). 보정 행이 있는 자리(round_date) 배열을
    InitPlan 으로 한 번 읽어 그 자리 행에서만 반조인한다(CASE 단락: 다른 파티션은 해시를 만들지 않는다, 값은 같다: 다른 자리에는 보정 행이 없다)."""
    require_slot(ms.profile, "rep_round_date_cell")
    if family not in ("m", "c"):
        raise ValueError(f"계열: {family}")
    # analysis_path: 카드 요청이어도 현행이 미러를 읽는 자리(웹 URL 인용률 기간 = 미러 창 안 적중, A2 계획서 5.7 · url_prompts)
    rule = REP_PATH[(bool(ms.card) and not analysis_path, family)] if ms.profile.rep_round_date_cell else "is_rep"
    if frozen_read(ms) and not analysis_path:
        # 동결 읽기(S3·S4): 카드 뷰 행 = 회차 동결 세대의 셀 대표(is_rep 참). 인용 숨김 회차는 창의 인용 계열 키가 회차 단위로 뺀다(현행 집계층
        # citationCyclesOf). rd 대표 보정(rep_cit_delta)은 rd is_rep 기준이라 동결 셀에 걸면 셀이 뒤집힌다
        rule = "is_rep"
    if rule == "is_rep":
        return f"{a}.is_rep"
    src = f"rd.rep_cit_delta d WHERE d.surface = {int(ms.sf)}"
    return (f"(CASE WHEN {a}.round_date = ANY((SELECT ARRAY(SELECT DISTINCT d.round_date FROM {src}))::date[]) "
            f"THEN ({a}.is_rep <> ({a}.answer_key IN (SELECT d.answer_key FROM {src}))) ELSE {a}.is_rep END)")


def mention_family(ms: MeasureScope) -> str:
    """언급 계열 지표가 쓰는 창 계열(core.codes.HIDDEN_EXCLUDE 키): 'mentions'(인용 숨김 회차는 언급에 남는다).
    현행 카드 기간 창의 회차 선택(R04CIT)은 계열 이름이 아니라 창 키 자체를 자리 대표로 좁힌다(core.cycles.card_period_keys,
    현행 프로필 card_slot_rep, WU-3). WU-1 골격의 'any' 계열 가설(scope-aggregates.ts:2881)은 미러 폴백 경로의 정의라 쓰지 않는다."""
    return "mentions"


def m05_den_col(ms: MeasureScope, a: str) -> str:
    """⑤ 인용 점유율 분모 답변 열: 기본 = cit_n(호스트 있는 인용, G-21 a). 현행 프로필 자리: m05_den_hostless(G21A, WU-5 구현: cit_n_all,
    DB-v2.15 P86 = 호스트 없는 인용 포함). 현행 집계층 ⑤ 분모·GEO 국가 분모는 도메인 NULL 인용도 센다(hmg-geo 2670a16
    lib/summary/generate/context.ts:205-231 '⑤ 분모는 domain NULL 인용도 세고', summary-global-aggregates.ts:858 totalCitations = domains(total)).
    도메인 목록·인용 화면 프롬프트 목록은 현행도 제외라 이 자리가 아니다(citation_where 의 source_key <> 0, plan_counts(m05_den=False)).
    cit_n_all 은 적재기·seed-40·채우기(fill-v215.sql)가 쓴다(NULL = 미채움 → 분모에서 조용히 빠지므로 채움 전에는 켜지 않는다)."""
    require_slot(ms.profile, "m05_den_hostless")
    return f"{a}.cit_n_all" if ms.profile.m05_den_hostless else f"{a}.cit_n"


# ════════════════════════════════════════════════════════════════════════════
# 당사 열(own_cols)·톤
# ════════════════════════════════════════════════════════════════════════════
def _cols(bits: Sequence[int]) -> list[str]:
    bad = [x for x in bits if x not in BRAND_OWN_COLS]
    if bad or not bits:
        raise ValueError(f"관점 비트는 1·2·4 중 하나 이상: {bits}")
    return [BRAND_OWN_COLS[x] for x in sorted(set(bits))]


@dataclass(frozen=True)
class OwnCols:
    """관점 비트로 고른 당사 열 식(G-03). 모든 조각은 화이트리스트 열 이름으로만 만든다."""
    mask: int
    ment: str
    sent_pos: str
    sent_neg: str
    sent_all: str
    rank: str          # 답변 대표 순위(단일 = own_rk_x, 다중 = 0 을 뺀 최솟값), 순위 없으면 NULL 또는 0
    ranked: str        # 순위 있는 답변 조건


def own_cols(own_bits: Sequence[int], a: str = "a") -> OwnCols:
    cs = _cols(own_bits)
    mask = sum(k for k, v in BRAND_OWN_COLS.items() if v in cs)

    def s(prefix: str) -> str:
        return " + ".join(f"{a}.{prefix}_{c}" for c in cs)

    if len(cs) == 1:
        rank, ranked = f"{a}.own_rk_{cs[0]}", f"{a}.own_rk_{cs[0]} > 0"
    else:
        rank = "LEAST(" + ", ".join(f"NULLIF({a}.own_rk_{c}, 0)" for c in cs) + ")"
        ranked = "(" + " OR ".join(f"{a}.own_rk_{c} > 0" for c in cs) + ")"
    return OwnCols(mask, f"({s('ment')})", f"({s('sent_pos')})", f"({s('sent_neg')})", f"({s('sent_all')})", rank, ranked)


def tone_expr(own_bits: Sequence[int], a: str = "a") -> tuple[str, str]:
    """답변 톤(C-2, P1 예외 '관점별 톤 비교'): 긍정 = 관점 sent_pos 합 > sent_neg 합, 부정 = 반대. 같으면 어느 쪽도 아니다."""
    oc = own_cols(own_bits, a)
    return f"({oc.sent_pos} > {oc.sent_neg})", f"({oc.sent_neg} > {oc.sent_pos})"


def own_expr(ms: MeasureScope, c: str, b: Binder) -> str:
    """인용 원소 자사 판정(QUERY-FIXES C-1·G-1). rd.citation 을 원래 스캔하는 기능(C-1 도메인·C-3·드릴다운)이 쓴다."""
    if ms.sf == 1:
        if ms.owner is None:
            raise ValueError("글로벌 own_expr 에는 OwnerScope 필요")
        return f"{c}.owner_key = ANY({b.ints(ms.owner.keys)})"
    if ms.sf == 2:
        return f"({c}.loc_owned OR {c}.tgt_hit)"
    return f"{c}.loc_owned"


# 글로벌 M05 분자(동기화 S1 BE-4): 출처 카테고리가 Official (HMG) 인 출처 키 집합(원소 스캔용). 답변 열 rd.answer.cit_off(DB-v2.13 P71)와
# 같은 판정: 반영된 차원 값 rd.dim_source.category_key(오버라이드 재판정 뒤 = CATEGORY_EXPR). 어휘 = app.citation_category.name
# (현행 OFFICIAL_HMG_CATEGORY, lib/citation-categorizer/taxonomy.ts). 적재 식(_ig_citc·seed-40 _citc·rd.answer_cit_counts)과 같은 이름.
OFFICIAL_CATEGORY_NAME = "Official (HMG)"
OFFICIAL_SOURCES = ("SELECT ds.source_key FROM rd.dim_source ds JOIN app.citation_category cc ON cc.category_key = ds.category_key"
                    f" WHERE cc.name = '{OFFICIAL_CATEGORY_NAME}'")


# 출처 유효 카테고리(ds = rd.dim_source, o = app.citation_domain_override, 결합 키 = 출처 그룹 키 skey).
# 적재기 category_of(seed-3x-common.sql, category_src 1 = 오버라이드)와 같은 우선순위라 반영 뒤에는 dim_source 값과 같고,
# judgment_change 'citation_override' 반영 전에도 조회에 즉시 보인다.
CATEGORY_EXPR = "coalesce(o.category_key, ds.category_key)"
OVERRIDE_JOIN = "LEFT JOIN app.citation_domain_override o ON o.domain = ds.skey"


def source_where(ms: MeasureScope, c: str, b: Binder) -> list[str]:
    """source[] 축: 유효 카테고리가 선택 집합인 출처만(차원 세미조인). 축 없음 = [], 값이 전부 버려졌으면 빈 집합(결과 0)."""
    if ms.source_category_keys is None:
        return []
    return [f"{c}.source_key IN (SELECT ds.source_key FROM rd.dim_source ds {OVERRIDE_JOIN} "
            f"WHERE {CATEGORY_EXPR} = ANY({b.ints(ms.source_category_keys)}))"]


def citation_where(ms: MeasureScope, win: Window, c: str, b: Binder) -> list[str]:
    """rd.citation 스캔 술어: 창 3술어(인용 계열) + 필터 축 + cit_in + 호스트 있는 인용(G-21 a) + 출처 카테고리 축."""
    return (win.where(c, "citations", b) + scope_where(ms, c, b) + [citation_population(ms, c, "citation"), f"{c}.source_key <> 0"]
            + source_where(ms, c, b))


# ════════════════════════════════════════════════════════════════════════════
# answer_counts / citation_counts: 계획(문장 목록) → 실행 → 병합
# ════════════════════════════════════════════════════════════════════════════
@dataclass
class CountsPlan:
    group_names: tuple[str, ...]
    statements: list[tuple[str, Sql]] = field(default_factory=list)    # (역할, 문장). 역할: main·prompts·cross·scan
    parts: tuple[str, ...] = ()


def _group_select(group_by: Sequence[str], split_at: date | None, a: str, b: Binder,
                  table: dict[str, tuple[str, str]] = GROUPS) -> tuple[list[str], list[str]]:
    sel, names = [], []
    for g in group_by:
        if g not in table:
            raise ValueError(f"허용되지 않은 group_by: {g}")
        name, expr = table[g]
        sel.append(f"{expr.format(a=a)} AS {name}")
        names.append(name)
    if split_at is not None:
        sel.append(f"CASE WHEN {a}.round_date >= {b.date(split_at)} THEN 'cur' ELSE 'prev' END AS win")
        names.append("win")
    return sel, names


def _owned_sum(ms: MeasureScope, a: str, mode: OwnerMode) -> str:
    if mode == "local":
        return f"{a}.cit_loc_tgt" if ms.sf == 2 else f"{a}.cit_loc"
    bits = ms.owner.own_bits if ms.owner else ()
    if not bits:
        return "0"
    suffix = "" if mode == "brand" else "c"
    return "(" + " + ".join(f"{a}.cit_own_{BRAND_OWN_COLS[x]}{suffix}" for x in bits) + ")"


def plan_counts(ms: MeasureScope, win: Window, *, group_by: Sequence[str] = (), split_at: date | None = None,
                parts: Collection[str] = DEFAULT_PARTS, m05_den: bool = True) -> CountsPlan:
    """rd.answer 한 번 스캔(main) + 필요 시 보조 문장(prompts·cross·scan). 값은 merge_counts 로 합친다.
    m05_den: cit_total 이 ⑤ 인용 점유율 분모인가(기본 참: 카드·엔진·GEO·추이·기간 비교). 거짓 = 인용 화면 프롬프트 목록처럼 호스트 있는
    인용 수가 필요한 소비자(현행 목록은 호스트 없는 인용 제외). 현행 프로필 m05_den_hostless 가 꺼져 있으면 둘은 같은 식이다."""
    unknown = set(parts) - set(ALL_PARTS)
    if unknown:
        raise ValueError(f"알 수 없는 part: {unknown}")
    parts = tuple(p for p in ALL_PARTS if p in parts)
    a = "a"
    need_m = any(p in parts for p in ("mentions", "sov", "rank_detail", "prompts", "gap"))
    need_c = any(p in parts for p in ("urls", "citations"))
    mode: OwnerMode | None = ms.owner_mode() if "citations" in parts else None
    # 출처 축이 있으면 답변 열(출처 무관 합)로 M05 를 낼 수 없다 → 원소 스캔(scan 문장, citation_where 가 출처 술어를 건다)
    cit_scan = "citations" in parts and (mode == "scan" or ms.source_category_keys is not None)
    mfam = mention_family(ms)
    fams = ([mfam] if need_m else []) + (["citations"] if need_c else [])
    split = need_m and need_c and win.cyc_keys(mfam) != win.cyc_keys("citations")
    plan = CountsPlan(group_names=(), parts=parts)

    # ── main ──
    b = Binder("m")
    gsel, gnames = _group_select(group_by, split_at, a, b)
    plan.group_names = tuple(gnames)
    union = win.union_keys(*fams) if fams else win.cyc_keys("row")
    if split:   # 계열별 숨김이 달라 한 스캔 안에서 FILTER 로 가른다(WHERE 는 두 계열 합집합)
        mf = f"{a}.cyc_key = ANY({b.ints(win.cyc_keys(mfam), 'int4')})"
        cg = f"{a}.cyc_key = ANY({b.ints(win.cyc_keys('citations'), 'int4')})"
    else:
        mf = cg = ""

    def flt(*conds: str) -> str:
        cs = [c for c in conds if c]
        return f" FILTER (WHERE {' AND '.join(cs)})" if cs else ""

    mg = mention_population(ms, a)
    cols: list[str] = []
    if "mentions" in parts or "sov" in parts or "rank_detail" in parts:
        oc = own_cols(ms.own_bits, a)
    if "mentions" in parts:
        cols += [
            f"count(*){flt(mg, mf)} AS answers",
            f"count(*){flt(mg, mf, f'({a}.own_mask & {oc.mask}) <> 0')} AS tracked",
            f"coalesce(sum({oc.ment}){flt(mg, mf)}, 0) AS own_mentions",
            f"coalesce(sum({a}.ment_total){flt(mg, mf)}, 0) AS total_mentions",
            f"coalesce(sum({oc.sent_pos}){flt(mg, mf)}, 0) AS sent_pos",
            f"coalesce(sum({oc.sent_neg}){flt(mg, mf)}, 0) AS sent_neg",
            f"coalesce(sum({oc.sent_all}){flt(mg, mf)}, 0) AS sent_all",
            f"coalesce(sum({oc.rank}){flt(mg, mf, oc.ranked)}, 0) AS rank_sum",
            f"count(*){flt(mg, mf, oc.ranked)} AS ranked",
        ]
    elif "sov" in parts:    # B094 점유율(M02)만: 'mentions' 와 같은 식의 답변 수·당사 언급·전체 언급(노출·감성·순위 열 없음)
        cols += [
            f"count(*){flt(mg, mf)} AS answers",
            f"coalesce(sum({oc.ment}){flt(mg, mf)}, 0) AS own_mentions",
            f"coalesce(sum({a}.ment_total){flt(mg, mf)}, 0) AS total_mentions",
        ]
    if "rank_detail" in parts:
        cols += [
            f"count(*){flt(mg, mf, f'{oc.ment} >= 2')} AS multi",
            f"count(*){flt(mg, mf, oc.ranked, f'{oc.rank} = 1')} AS top1",
            f"count(*){flt(mg, mf, oc.ranked, f'{oc.rank} <= 3')} AS top3",
        ]
    if "gap" in parts:
        cols += [f"count(*){flt(mf)} AS gap_base", f"count(*){flt(mf, f'{a}.gap')} AS gap_answers"]
    if "urls" in parts:
        ug = "" if ms.sf == 3 else f"{a}.web_reg"     # 분모 게이트: website = 등록 프롬프트, project = 없음(Q5), global = 대상 아님(분모 0)
        cols += [f"count(*){flt(cg, ug)} AS url_den",
                 f"count(*){flt(cg, ug, f'{a}.tgt_cited')} AS tgt_hits",
                 f"count(*){flt(cg, ug, f'{a}.own_url_cited')} AS own_url_hits",
                 f"count(*){flt(cg, ug, f'{a}.tgt_cited', f'{a}.own_url_cited')} AS tgt_own_hits"]
    if "citations" in parts and not cit_scan:
        owned = _owned_sum(ms, a, mode)  # type: ignore[arg-type]
        den = m05_den_col(ms, a) if m05_den else f"{a}.cit_n"
        cols += [f"coalesce(sum({den}){flt(cg)}, 0) AS cit_total",
                 f"coalesce(sum({a}.cit_tgt){flt(cg)}, 0) AS cit_target"]
        if mode == "countryN":
            cols.append(f"coalesce(sum({owned}){flt(cg, f'{a}.cit_own_x = 0')}, 0) AS cit_owned")
        else:
            cols.append(f"coalesce(sum({owned}){flt(cg)}, 0) AS cit_owned")
        # M05 분자: global = 공식(HMG) 카테고리 답변 열, website·project = 표면 자사(local 모드라 cross 보정 없음 = cit_owned 와 같은 식)
        m05 = f"{a}.cit_off" if ms.sf == 1 else owned
        cols.append(f"coalesce(sum({m05}){flt(cg)}, 0) AS cit_m05")
    if not cols:
        cols = ["count(*) AS n"]
    where = win.where(a, "row", b, keys=union) + scope_where(ms, a, b) + [citation_population(ms, a)]
    txt = f"SELECT {', '.join(gsel + cols)}\n  FROM {fact_tables(ms).answer} {a}\n WHERE {' AND '.join(where)}"
    if gsel:
        txt += "\n GROUP BY " + ", ".join(str(i + 1) for i in range(len(gsel)))
    plan.statements.append(("main", b.sql(txt)))

    # ── prompts(M12 측정 프롬프트 수: count DISTINCT 는 병렬 집계를 막아 분리) ──
    if "prompts" in parts:
        bp = Binder("q")
        gsel2, _ = _group_select(group_by, split_at, a, bp)
        oc2 = own_cols(ms.own_bits, a)
        w2 = win.where(a, mention_family(ms), bp) + scope_where(ms, a, bp) + [mention_population(ms, a)]
        cols2 = [f"count(DISTINCT {a}.prompt_key) AS measured_prompts",
                 f"count(DISTINCT {a}.prompt_key) FILTER (WHERE ({a}.own_mask & {oc2.mask}) <> 0) AS mentioned_prompts"]
        t2 = f"SELECT {', '.join(gsel2 + cols2)}\n  FROM {fact_tables(ms).answer} {a}\n WHERE {' AND '.join(w2)}"
        if gsel2:
            t2 += "\n GROUP BY " + ", ".join(str(i + 1) for i in range(len(gsel2)))
        plan.statements.append(("prompts", bp.sql(t2)))

    # ── url_prompts(M06·M07 프롬프트 단위, 결정 6: count DISTINCT 라 main 과 분리. 모수 = urls 와 같은 cit_in ∧ 분모 게이트, 인용 계열 회차) ──
    if "url_prompts" in parts:
        bu = Binder("u")
        gsel4, _ = _group_select(group_by, split_at, a, bu)
        # 셀 대표: 스냅샷 = 집계층(카드), 기간 = 미러(답변분석): 현행 URL 인용률 경로(A2: 기간 범위는 미러 창 안 적중, WU-12 rep_round_date_cell)
        # 동결 층(S4): 기간(미러 자리 analysis_path)이면 동결 뷰가 아니라 rd(현행 기간 URL 인용률 = 미러), 스냅샷이면 동결 뷰 + 생성 시점 job 플래그
        # (frz.card_web url_*, 현행 summary_url_hits registered·owned_hit·target_hit summary-website-aggregates.ts:1240-1268, 없으면 동결 행의 rd 열)
        ms4 = replace(ms, frz_ok=False) if win.mode == "cumulative" and frozen_read(ms) else ms
        flag = frozen_read(ms4) and ms.sf == 2
        reg, tgt, own = ((f"coalesce({a}.url_registered, {a}.web_reg)", f"coalesce({a}.url_target_hit, {a}.tgt_cited)",
                          f"coalesce({a}.url_owned_hit, {a}.own_url_cited)") if flag else (f"{a}.web_reg", f"{a}.tgt_cited", f"{a}.own_url_cited"))
        w4 = (win.where(a, "citations", bu) + scope_where(ms4, a, bu)
              + [citation_population(ms4, a, unit_gate=False, analysis_path=win.mode == "cumulative")]
              + ([] if ms.sf == 3 else [reg]))
        cols4 = [f"count(DISTINCT {a}.prompt_key) AS url_measured_prompts",
                 f"count(DISTINCT {a}.prompt_key) FILTER (WHERE {tgt}) AS url_target_prompts",
                 f"count(DISTINCT {a}.prompt_key) FILTER (WHERE {own}) AS url_owned_prompts"]
        t4 = f"SELECT {', '.join(gsel4 + cols4)}\n  FROM {fact_tables(ms4).answer} {a}\n WHERE {' AND '.join(w4)}"
        if gsel4:
            t4 += "\n GROUP BY " + ", ".join(str(i + 1) for i in range(len(gsel4)))
        plan.statements.append(("url_prompts", bu.sql(t4)))

    # ── cross(국가 2개 이상: 교차 국가 자사 인용이 있는 답변만 원소를 센다) ──
    # 원소 스캔(scan)이면 내지 않는다: scan 의 cit_owned(own_expr = owner_key = ANY)가 교차 국가 자사까지 이미 정확히 세고,
    # cross 에는 출처 술어가 없어 더하면 고른 출처 밖 자사가 이중으로 들어간다
    if "citations" in parts and mode == "countryN" and not cit_scan:
        bx = Binder("x")
        gsel3, _ = _group_select(group_by, split_at, a, bx)
        c = "c"
        w3 = (win.where(a, "citations", bx) + scope_where(ms, a, bx) + [citation_population(ms, a), f"{a}.cit_own_x > 0"]
              + win.where(c, "citations", bx)
              + [f"{c}.source_key <> 0", f"{c}.owner_key = ANY({bx.ints(ms.owner.keys)})"])  # type: ignore[union-attr]
        t3 = (f"SELECT {', '.join(gsel3 + ['count(*) AS cit_cross'])}\n  FROM {fact_tables(ms).answer} {a}\n"
              f"  JOIN {fact_tables(ms).citation} {c} ON {c}.surface = {a}.surface AND {c}.round_date = {a}.round_date AND {c}.answer_key = {a}.answer_key\n"
              f" WHERE {' AND '.join(w3)}")
        if gsel3:
            t3 += "\n GROUP BY " + ", ".join(str(i + 1) for i in range(len(gsel3)))
        plan.statements.append(("cross", bx.sql(t3)))

    # ── scan(언어로 좁힌 글로벌 허용 배열 또는 출처 카테고리 축: 원소 스캔) ──
    if cit_scan:
        plan.statements.append(("scan", citation_counts_sql(ms, win, group_by=group_by, split_at=split_at, m05_den=m05_den)))
    return plan


def group_by_has_source(group_by: Sequence[str]) -> bool:
    """원소 스캔 group_by 가 출처·URL 단위인가(그 단위 목록은 현행도 호스트 없는 인용을 뺀다)."""
    return any(g in ("source", "url") for g in group_by)


CITATION_BOOL_COLS = frozenset({"cit_in", "gap", "dflt", "loc_owned", "tgt_hit", "src_first"})
_EXTRA_RE = re.compile(r"^(NOT )?c\.([a-z_]+)$")


def citation_counts_sql(ms: MeasureScope, win: Window, *, group_by: Sequence[str] = (), split_at: date | None = None,
                        extra_where: Sequence[str] = (), m05_den: bool = False) -> Sql:
    """rd.citation 원소 스캔 집계(cit_total·cit_owned·cit_target·cit_m05). group_by 에 source·url 을 쓸 수 있다(C-1·C-2).
    cit_m05 = M05 분자(global = 출처 카테고리 Official (HMG) 원소, website·project = cit_owned 와 같은 판정).
    extra_where 는 rd.citation 불리언 열 조각만 허용한다: 'c.<열>' 또는 'NOT c.<열>'(CITATION_BOOL_COLS). 그 밖은 ValueError.
    m05_den: plan_counts 원소 스캔(scan 역할)이 ⑤ 분모로 부를 때만 참. 현행 프로필 m05_den_hostless 가 켜져 있고 출처 카테고리 축이 없으면
    cit_total 이 호스트 없는 인용(source_key 0)도 센다(답변 열 cit_n_all 과 같은 식). 나머지 열은 종전처럼 호스트 있는 인용만.
    출처·URL 단위 소비자(도메인 목록·C-2)는 기본값(거짓)이라 현행처럼 호스트 없는 인용을 뺀다."""
    for frag in extra_where:
        m = _EXTRA_RE.match(frag)
        if not m or m.group(2) not in CITATION_BOOL_COLS:
            raise ValueError(f"extra_where 는 rd.citation 불리언 열 조각만 허용: {frag!r}")
    c = "c"
    b = Binder("c")
    gsel, _ = _group_select(group_by, split_at, c, b, CITATION_GROUPS)
    own = own_expr(ms, c, b)
    m05 = f"{c}.source_key IN ({OFFICIAL_SOURCES})" if ms.sf == 1 else own     # M05 분자(plan_counts main 의 cit_m05 와 같은 판정)
    host = f"{c}.source_key <> 0"
    hostless = m05_den and ms.profile.m05_den_hostless and ms.source_category_keys is None and not group_by_has_source(group_by)
    if hostless:    # WHERE 에서 호스트 술어를 빼고 cit_total 밖 열의 FILTER 로 옮긴다(현행 ⑤ 분모 = 도메인 NULL 인용 포함)
        cols = ["count(*) AS cit_total", f"count(*) FILTER (WHERE {host} AND {own}) AS cit_owned",
                f"count(*) FILTER (WHERE {host} AND {c}.tgt_hit) AS cit_target", f"count(*) FILTER (WHERE {host} AND {m05}) AS cit_m05"]
        w = [x for x in citation_where(ms, win, c, b) if x != host] + list(extra_where)
    else:
        cols = ["count(*) AS cit_total", f"count(*) FILTER (WHERE {own}) AS cit_owned",
                f"count(*) FILTER (WHERE {c}.tgt_hit) AS cit_target", f"count(*) FILTER (WHERE {m05}) AS cit_m05"]
        w = citation_where(ms, win, c, b) + list(extra_where)
    t = f"SELECT {', '.join(gsel + cols)}\n  FROM {fact_tables(ms).citation} {c}\n WHERE {' AND '.join(w)}"
    if gsel:
        t += "\n GROUP BY " + ", ".join(str(i + 1) for i in range(len(gsel)))
    return b.sql(t)


_INT_METRICS = ("answers", "tracked", "own_mentions", "total_mentions", "sent_pos", "sent_neg", "sent_all", "rank_sum", "ranked",
                "multi", "top1", "top3", "measured_prompts", "mentioned_prompts", "gap_base", "gap_answers",
                "url_den", "tgt_hits", "own_url_hits", "tgt_own_hits", "cit_total", "cit_owned", "cit_target", "cit_m05",
                "url_measured_prompts", "url_target_prompts", "url_owned_prompts")


def merge_counts(plan: CountsPlan, results: Sequence[Sequence[dict[str, Any]]]) -> list[dict[str, Any]]:
    """계획 문장 결과를 그룹 키로 합친다. 없는 그룹·열은 0. 반환 순서 = 그룹 키 정렬."""
    names = plan.group_names
    out: dict[tuple[Any, ...], dict[str, Any]] = {}

    def row_for(r: dict[str, Any]) -> dict[str, Any]:
        k = tuple(r.get(n) for n in names)
        cur = out.get(k)
        if cur is None:
            cur = {n: r.get(n) for n in names}
            out[k] = cur
        return cur

    if len(results) != len(plan.statements):
        raise ValueError("계획 문장 수와 결과 수가 다르다")
    for (role, _), rows in zip(plan.statements, results):  # noqa: B905 (대조 러너가 Python 3.9 에서 이 빌더를 쓴다)
        for r in rows:
            cur = row_for(r)
            if role == "cross":
                cur["cit_owned"] = int(cur.get("cit_owned") or 0) + int(r["cit_cross"] or 0)
                continue
            for key, v in r.items():
                if key in names:
                    continue
                cur[key] = int(v or 0) if key in _INT_METRICS else v
    if not names and not out:
        out[()] = {}
    want = _part_metrics(plan.parts)
    rows = []
    for k in sorted(out, key=lambda t: tuple((x is None, x) for x in t)):
        r = out[k]
        for m in want:
            r.setdefault(m, 0)
        rows.append(r)
    return rows


def _part_metrics(parts: Sequence[str]) -> list[str]:
    m: list[str] = []
    if "mentions" in parts:
        m += ["answers", "tracked", "own_mentions", "total_mentions", "sent_pos", "sent_neg", "sent_all", "rank_sum", "ranked"]
    elif "sov" in parts:
        m += ["answers", "own_mentions", "total_mentions"]
    if "rank_detail" in parts:
        m += ["multi", "top1", "top3"]
    if "prompts" in parts:
        m += ["measured_prompts", "mentioned_prompts"]
    if "gap" in parts:
        m += ["gap_base", "gap_answers"]
    if "urls" in parts:
        m += ["url_den", "tgt_hits", "own_url_hits", "tgt_own_hits"]
    if "url_prompts" in parts:
        m += ["url_measured_prompts", "url_target_prompts", "url_owned_prompts"]
    if "citations" in parts:
        m += ["cit_total", "cit_owned", "cit_target", "cit_m05"]
    return m


def ratios(row: dict[str, Any]) -> dict[str, tuple[int, int]]:
    """카운트 행 → 지표 정수 쌍(num, den). position 은 (순위 합, 순위 있는 답변 수). 없는 부분은 빠진다.
    citation_share 분자 = cit_m05(표면별 M05 분자: global 공식(HMG) 카테고리, website·project 자사). cit_owned 로 대신하지 않는다
    (행을 손으로 합치는 소비자도 cit_m05 를 함께 더해야 한다: 없으면 KeyError 로 드러난다).
    part 'sov' 행(B094: answers·own_mentions·total_mentions 만, tracked 없음)은 share_of_voice 만 낸다."""
    out: dict[str, tuple[int, int]] = {}
    if "answers" in row and "tracked" not in row:
        out["share_of_voice"] = (row["own_mentions"], row["total_mentions"])
    elif "answers" in row:
        out["visibility"] = (row["tracked"], row["answers"])
        out["share_of_voice"] = (row["own_mentions"], row["total_mentions"])
        out["sentiment"] = (row["sent_pos"], row["sent_all"])
        out["position"] = (row["rank_sum"], row["ranked"])
    if "cit_total" in row:
        out["citation_share"] = (row["cit_m05"], row["cit_total"])
    if "url_den" in row:
        out["target_url_rate"] = (row["tgt_hits"], row["url_den"])
        out["owned_url_rate"] = (row["own_url_hits"], row["url_den"])
        out["citation_accuracy"] = (row.get("tgt_own_hits", 0), row["own_url_hits"])
    if "gap_base" in row:
        out["analysis_gap"] = (row["gap_answers"], row["gap_base"])
    return out


async def fetch_counts(conn: Any, ms: MeasureScope, win: Window, *, group_by: Sequence[str] = (), split_at: date | None = None,
                       parts: Collection[str] = DEFAULT_PARTS) -> list[dict[str, Any]]:
    """answer_counts 실행(요청 트랜잭션 안에서 문장 순차 실행). 빈 창(win.empty)이면 DB 문장 없이 그룹 없는 경우 0 행 1개."""
    from app.core.db import fetch_all

    plan = plan_counts(ms, win, group_by=group_by, split_at=split_at, parts=parts)
    if win.empty:
        return merge_counts(plan, [[] for _ in plan.statements])
    results = [await fetch_all(conn, q.text, q.params) for _, q in plan.statements]
    return merge_counts(plan, results)


answer_counts = fetch_counts   # 설계 이름(전체-통합 §5) 별칭


async def citation_counts(conn: Any, ms: MeasureScope, win: Window, *, group_by: Sequence[str] = (),
                          split_at: date | None = None) -> list[dict[str, Any]]:
    """rd.citation 원소 스캔 집계(도메인·출처·URL 단위가 필요한 기능 전용). 카드·추이·국가는 fetch_counts 를 쓴다(G-25).
    빈 창이면 DB 문장 없이 []."""
    from app.core.db import fetch_all

    if win.empty:
        return []
    q = citation_counts_sql(ms, win, group_by=group_by, split_at=split_at)
    return await fetch_all(conn, q.text, q.params)


# ════════════════════════════════════════════════════════════════════════════
# M06·M07 + R09 발행값 접기(url_rates)
# ════════════════════════════════════════════════════════════════════════════
def report_values_sql(round_dates: Sequence[date], brands: Sequence[str], countries: Sequence[str] | None,
                      langs: Sequence[str] | None, *, project_keys: Sequence[int], geo_keys: Sequence[int] | None) -> Sql:
    """활성 웹사이트 발행(app.report_publication status='active' ∧ surface='website')의 유닛 발행값 합(round_date 별).
    스코프: 요청 MeasureScope 와 같은 범위만 합친다(검증 m4) — 유닛(file_seq)의 웹 유닛이 허용 프로젝트(project_keys)에 있고,
    발행 국가가 허용 국가(geo_keys, rd.dim_country 코드)에 있으며, 브랜드가 관점 브랜드(brands)인 행. countries·langs 는 요청 축.
    헤드라인 풀(현행 publishedSubtotal truth-axes.ts:344-345): 회차별로 선택에 풀 유닛이 하나라도 있으면 풀 유닛만, 없으면 전부.
    결과 열: round_date·measured·target_hit·owned·owned_den·units(합산 유닛 수)·slugs(합산에 실제로 들어간 발행물)·pool_applied."""
    b = Binder("r")
    w = [f"v.round_date = ANY({b.v(sorted(set(round_dates)), 'date[]')})", f"v.brand = ANY({b.v(sorted(set(brands)), 'text[]')})",
         f"EXISTS (SELECT 1 FROM rd.web_unit u WHERE u.file_seq = v.file_seq AND u.project_key = ANY({b.ints(project_keys)}))"]
    if geo_keys is not None:
        # 국가 코드는 대소문자가 섞인 가상 지역(SA-Dammam·worldwide 등)이 있어 양쪽 모두 upper 로 비교한다(검증 N2)
        w.append(f"EXISTS (SELECT 1 FROM rd.dim_country g WHERE upper(g.code) = upper(v.country_code) AND g.geo_key = ANY({b.ints(geo_keys)}))")
    if countries is not None:
        w.append(f"upper(v.country_code) = ANY({b.v(sorted({c.upper() for c in countries}), 'text[]')})")
    if langs is not None:
        w.append(f"lower(v.lang_code) = ANY({b.v(sorted({x.lower() for x in langs}), 'text[]')})")
    t = ("WITH sel AS (\n"
         "  SELECT v.round_date, v.in_headline_pool, v.measured_prompts, v.target_hit_prompts, v.owned_prompts, v.owned_prompts_den, p.slug\n"
         "    FROM rd.report_unit_value v\n"
         "    JOIN app.report_publication p ON p.id = v.pub_id AND p.status = 'active' AND p.surface = 'website'\n"
         f"   WHERE {' AND '.join(w)}),\n"
         "pool AS (SELECT round_date, bool_or(in_headline_pool) AS has_pool, bool_and(in_headline_pool) AS all_pool FROM sel GROUP BY round_date)\n"
         "SELECT s.round_date, sum(s.measured_prompts) AS measured, sum(s.target_hit_prompts) AS target_hit,\n"
         "       sum(s.owned_prompts) AS owned, sum(s.owned_prompts_den) AS owned_den, count(*) AS units,\n"
         "       array_agg(DISTINCT s.slug ORDER BY s.slug) AS slugs, bool_or(pool.has_pool AND NOT pool.all_pool) AS pool_applied\n"
         "  FROM sel s JOIN pool ON pool.round_date = s.round_date\n"
         " WHERE s.in_headline_pool OR NOT pool.has_pool\n"
         " GROUP BY s.round_date")
    return b.sql(t)


# R09 를 쓰지 않은(라이브로 낸) 사유. meta.source.reason 에 그대로 싣는다(C-4 provenance, 현행 resolveReportTruthRoute 사유와 대응)
R09_NOT_WEBSITE = "not_website"          # 발행값은 웹사이트 표면만
R09_ENGINE_AXIS = "engine_axis"          # 엔진 축(발행값이 지원하지 않는 축, 현행 unsupported-axis)
R09_PERIOD_RANGE = "period_range"        # 회차 둘 이상의 기간 누적(단위를 섞지 않는다, 현행 period-range)
R09_EMPTY_WINDOW = "empty_window"        # 창에 회차 없음
R09_NO_PUBLICATION = "no_publication"    # 그 회차에 스코프 안 활성 발행값 없음


def _report_cell(x: dict[str, Any]) -> dict[str, Any]:
    cell = {"target": (int(x["target_hit"] or 0), int(x["measured"] or 0)), "owned": (int(x["owned"] or 0), int(x["owned_den"] or 0)),
            "origin": "report", "reason": None, "publications": list(x.get("slugs") or ()),
            "headline_pool_applied": bool(x.get("pool_applied")),
            # 프롬프트 단위(결정 6): 발행값은 원래 프롬프트 단위다(현행 publishedSubtotal: hit·owned·measured 프롬프트, 두 카드 공통 분모 measured)
            "prompts": (int(x["measured"] or 0), int(x["target_hit"] or 0), int(x["owned"] or 0))}
    if "site_count" in x:       # 현행 발행 선택(web_url_rate, WU-7) 행만: 합산 유닛 수·발행 회차를 표식(BG-26)에 그대로 넘긴다
        cell["site_count"] = int(x["site_count"])
        cell["round_date"] = x["round_date"]
    return cell


def _live_cell(r: dict[str, Any], reason: str | None) -> dict[str, Any]:
    return {"target": (int(r.get("tgt_hits") or 0), int(r.get("url_den") or 0)),
            "owned": (int(r.get("own_url_hits") or 0), int(r.get("url_den") or 0)),
            "origin": "live", "reason": reason, "publications": [], "headline_pool_applied": False,
            # 프롬프트 단위(결정 6, part 'url_prompts' 가 있을 때만): (측정 프롬프트, 타겟 URL 인용 프롬프트, 자사 URL 인용 프롬프트)
            "prompts": ((int(r.get("url_measured_prompts") or 0), int(r.get("url_target_prompts") or 0), int(r.get("url_owned_prompts") or 0))
                        if "url_measured_prompts" in r else None)}


def r09_reason(ms: MeasureScope, win: Window, *, by_round: bool, req: R09Request | None = None) -> str | None:
    """R09 발행값을 쓸 수 있는 창인가(None) 아니면 라이브 사유. 카드(by_round=False)는 스냅샷 또는 회차 하나를 고른 기간(from = to,
    D-R09: 현행 resolveReportTruthRoute truth-axes.ts:95-103 와 같다)만, 회차 버킷(by_round)은 회차마다 판정한다.
    현행 프로필 자리: web_url_rate(A2, WU-7 구현): 필터·기간 조건 = 현행 resolveReportTruthRoute(legacy_r09_route, req 필수).
    발행물 안 선택(권한 게이트·브랜드 어휘·어휘 분기)은 legacy_report_rows 가 회차마다 판정한다."""
    require_slot(ms.profile, "web_url_rate")
    if legacy_url_rate(ms):
        return legacy_r09_route(ms, win, _need_req(req), by_round=by_round)[0]
    if ms.sf != 2:
        return R09_NOT_WEBSITE
    if ms.engine_keys is not None:
        return R09_ENGINE_AXIS
    if win.empty:
        return R09_EMPTY_WINDOW
    if not by_round and win.mode != "snapshot" and win.lo != win.hi:
        return R09_PERIOD_RANGE
    return None


# ── 현행 발행값 라우팅(web_url_rate, A2, WU-7) ────────────────────────────────────────────────────────────────────
# 현행(hmg-geo 2670a16 + X.reportTruth): server.ts:5452-5518 websiteTargetHitRateFromPublication → lib/reports/truth-axes.ts
#   ① resolveReportTruthRoute(:81-112): 폴백 축(engine·sourceCategory·funnelStage·brandPresence·listType·depth1~3·region·customField)이 켜지면
#      라이브, 기간은 from = to 하루만 그 날짜 회차(한쪽만 = period-open-ended, 구간 = period-range), 기간이 없으면 화면 최신 회차
#   ② loadPublishedWebsiteRound(report-publications.ts:200): 그 회차 active 웹사이트 발행물의 사이트 전수(file_seq 단위)
#   ③ decidePublishedSelection(truth-axes.ts:246-312): 권한 = 계정 스코프(UI 필터 전) 런타임 분류가 발행 사이트 전부를 덮어야 한다(게이트,
#      좁히지 않는다) → 브랜드 선택은 발행물 어휘로 해석(발행물에 없는 브랜드면 라이브) → 국가·언어 선택이 어휘 분기 유닛(런타임 분류가
#      발행물과 다르거나 둘 이상)에 닿으면 라이브 → 축 선택(축 안 OR·축 사이 AND, 대소문자 무시)
#   ④ publishedSubtotal(:342-364): 선택 ∩ 헤드라인 풀, 비면 선택 전체
# hub 기본(report_values_sql)과 다른 점: 선택을 프로젝트 키(사이트 브랜드 비트로 좁힌 요청 사이트, filters.py 사이트 선택)로 거르므로
#   brand=Hyundai 가 런타임 Hyundai N 사이트의 발행 유닛 fs 40·41 을 뺀다(WU-10 R3: 2,666/4,034 대 리포트 2,775/4,223).
R09_UNSUPPORTED_AXIS = "unsupported_axis"          # 현행 unsupported-axis:<축>(엔진 밖 폴백 축)
R09_PERIOD_OPEN = "period_open_ended"              # 현행 period-open-ended(from·to 한쪽만)
R09_SCOPE_NARROWER = "scope_narrower"              # 현행 scope-narrower-than-publication
R09_BRAND_NOT_IN_PUB = "brand_not_in_publication"  # 현행 brand-not-in-publication
R09_VOCAB_SPLIT = "vocabulary_split"               # 현행 vocabulary-split:<축>
R09_NO_SITES = "no_published_sites"                # 현행 no-published-sites(축 선택이 발행 사이트를 하나도 못 고름)

# 현행 FALLBACK_AXES(truth-axes.ts:34-44) + customField(:90-93)에 대응하는 요청 축(CommonFilters 이름). depth4 는 현행 StandardFilters 에 없는
# 허브 축이라 "모르는 축을 통과시키지 않는다"(:15-22) 원칙대로 폴백 축으로 둔다. region 은 허브 요청 축이 아니다(front 가 국가로 편다).
R09_FALLBACK_AXES = ("engine", "source", "funnel", "brand_presence", "list_type", "depth1", "depth2", "depth3", "depth4", "custom")


@dataclass(frozen=True)
class R09Request:
    """현행 발행값 라우팅 입력(web_url_rate). core.filters.resolve_read_context 가 website 요청에서 만든다(ReadContext.r09).
    brands·countries·langs = 요청 축 원래 값(스코프 검증에서 버려진 값 제외, 없으면 None). 브랜드는 withWebsite 가 흡수하기 전 선택
    (현행 ctx.selectedBrands), 국가는 사이트 국가 원표기(가상·유사 코드 포함). date_from·date_to = 요청 기간 원값(한쪽만 준 기간을 닫기 전).
    fallback_axis = 켜진 폴백 축 이름(R09_FALLBACK_AXES 순서 첫 값), account_project_keys = 계정 스코프 웹사이트 사이트(UI 필터 전)."""
    brands: tuple[str, ...] | None = None
    countries: tuple[str, ...] | None = None
    langs: tuple[str, ...] | None = None
    date_from: date | None = None
    date_to: date | None = None
    fallback_axis: str | None = None
    account_project_keys: tuple[int, ...] = ()


def legacy_url_rate(ms: MeasureScope) -> bool:
    """web_url_rate(A2) 가 이 스코프에 걸리나: website 표면만(project 는 발행값이 없다, global 은 대상 아님)."""
    return ms.profile.web_url_rate and ms.sf == 2


def _need_req(req: R09Request | None) -> R09Request:
    if req is None:
        raise ValueError("현행 프로필 web_url_rate(A2): R09Request(ReadContext.r09)가 필요하다. 조용히 허브 규칙으로 돌지 않는다")
    return req


def legacy_r09_route(ms: MeasureScope, win: Window, req: R09Request, *, by_round: bool) -> tuple[str | None, date | None]:
    """현행 resolveReportTruthRoute(truth-axes.ts:81-112): (라이브 사유 | None, 카드 조회 회차). 회차 버킷(by_round)은 기간 조건을 보지 않고
    폴백 축만 본다(회차마다 legacy_report_rows 가 판정). 카드 회차: from = to 면 그 날짜(현행 roundDate = dateFrom), 기간이 없으면 창 회차
    (win.lo = 화면 최신 노출 회차, 현행 latestVisibleWebsiteRound)."""
    if ms.sf != 2:
        return R09_NOT_WEBSITE, None
    if req.fallback_axis is not None:
        return (R09_ENGINE_AXIS if req.fallback_axis == "engine" else R09_UNSUPPORTED_AXIS), None
    if by_round:
        return (R09_EMPTY_WINDOW if win.empty else None), None
    if req.date_from is not None or req.date_to is not None:
        if req.date_from is None or req.date_to is None:
            return R09_PERIOD_OPEN, None
        if req.date_from != req.date_to:
            return R09_PERIOD_RANGE, None
        return None, req.date_from
    if win.empty or win.lo is None:
        return R09_EMPTY_WINDOW, None
    return None, win.lo


def published_sites_sql(round_dates: Sequence[date]) -> Sql:
    """현행 loadPublishedWebsiteRound(report-publications.ts:200-256): 회차의 active 웹사이트 발행물 사이트 전수(선택은 앱에서, 순수 함수).
    rd.report_unit_value = app.report_site_fact 투영(WU-10 R2 행 단위 동일)."""
    b = Binder("r")
    return b.sql("SELECT v.round_date, v.file_seq, v.brand, v.country_code, v.lang_code, v.in_headline_pool, v.target_hit_prompts,\n"
                 "       v.measured_prompts, v.owned_prompts, v.owned_prompts_den, p.slug\n"
                 "  FROM rd.report_unit_value v\n"
                 "  JOIN app.report_publication p ON p.id = v.pub_id AND p.status = 'active' AND p.surface = 'website'\n"
                 f" WHERE v.round_date = ANY({b.v(sorted(set(round_dates)), 'date[]')})\n"
                 " ORDER BY v.round_date, v.file_seq")


def runtime_sites_sql(project_keys: Sequence[int]) -> Sql:
    """현행 websiteRuntimeClassification(report-publications.ts:129-157): 계정 스코프 사이트 프로젝트의 등록 프롬프트 유닛(file_seq)별
    런타임 분류(사이트 브랜드·사이트 국가 원표기·언어 목록). 한 file_seq 가 사이트 둘에 걸리면 행이 둘이다(어휘 분기로 본다).
    사이트의 Scope 프로젝트가 비어 있으면(app.website_site.scope_project_id 는 UNIQUE 라, 현행에서 한 프로젝트를 나눠 쓰는 사이트
    Genesis SA-Jeddah·SA-Riyadh(= SA-Dammam 프로젝트, surface-website.ts:242 '제네시스 SA 3사이트')가 이관에서 NULL 이 됐다) 프롬프트의
    투영 프로젝트(rd.dim_prompt.project_key)로 소속을 본다: 현행은 공유 프로젝트 id 로 세 사이트를 모두 런타임에 넣는다."""
    b = Binder("r")
    keys = b.ints(project_keys)
    return b.sql("SELECT wp.file_seq, s.brand_code AS brand, s.country_code, array_agg(DISTINCT wp.lang_code ORDER BY wp.lang_code) AS lang_codes\n"
                 "  FROM app.website_prompt wp\n"
                 "  JOIN app.website_site s ON s.site_id = wp.site_id\n"
                 f" WHERE s.scope_project_id IN (SELECT dp.scope_project_id FROM rd.dim_project dp WHERE dp.project_key = ANY({keys}))\n"
                 f"    OR (s.scope_project_id IS NULL AND wp.scope_prompt_id IN (SELECT d.prompt_id FROM {fact_tables().prompt} d\n"
                 f"                                                           WHERE d.surface = 2 AND d.project_key = ANY({keys})))\n"
                 " GROUP BY 1, 2, 3\n ORDER BY 1, 2, 3")


def _ci(v: Any) -> str:
    return (v or "").lower() if isinstance(v, str) or v is None else str(v).lower()


def decide_published_selection(published: Sequence[dict[str, Any]], runtime: Sequence[dict[str, Any]],
                               req: R09Request) -> tuple[list[dict[str, Any]] | None, str | None]:
    """현행 decidePublishedSelection(truth-axes.ts:246-312) 이식(순수). published = published_sites_sql 한 회차 행, runtime = runtime_sites_sql 행.
    반환 (선택 사이트, None) 또는 (None, 라이브 사유)."""
    if not published:
        return None, R09_NO_PUBLICATION
    by_fs: dict[int, list[dict[str, Any]]] = {}
    for r in runtime:
        by_fs.setdefault(int(r["file_seq"]), []).append(r)
    if any(int(p["file_seq"]) not in by_fs for p in published):                 # ① 권한 게이트: 발행 모집단 전부를 덮어야 한다
        return None, R09_SCOPE_NARROWER
    if req.brands:                                                               # ② 브랜드 = 발행물 어휘
        known = {_ci(p["brand"]) for p in published}
        if any(_ci(x) not in known for x in req.brands):
            return None, R09_BRAND_NOT_IN_PUB
    split: list[int] = []                                                        # ③ 어휘 분기(런타임 2행 이상이면 무조건)
    for p in published:
        rows = by_fs[int(p["file_seq"])]
        if len(rows) > 1:
            split.append(int(p["file_seq"]))
            continue
        r = rows[0]
        lang_ok = p["lang_code"] is None or any(_ci(x) == _ci(p["lang_code"]) for x in (r["lang_codes"] or ()))
        if _ci(p["brand"]) != _ci(r["brand"]) or _ci(p["country_code"]) != _ci(r["country_code"]) or not lang_ok:
            split.append(int(p["file_seq"]))
    if split:
        pub_of = {int(p["file_seq"]): p for p in published}
        for sel, pub_vals, run_vals in ((req.countries, lambda p: [p["country_code"]], lambda r: [r["country_code"]]),
                                        (req.langs, lambda p: [p["lang_code"]], lambda r: list(r["lang_codes"] or ()))):
            if not sel:
                continue
            want = {_ci(x) for x in sel}
            for fs in split:
                p = pub_of.get(fs)
                if (p is not None and any(_ci(v) in want for v in pub_vals(p))) or \
                        any(any(_ci(v) in want for v in run_vals(r)) for r in by_fs.get(fs, ())):
                    return None, R09_VOCAB_SPLIT
    brand = {_ci(x) for x in req.brands} if req.brands else None                  # ④ 축 선택(발행물 어휘)
    country = {_ci(x) for x in req.countries} if req.countries else None
    lang = {_ci(x) for x in req.langs} if req.langs else None
    selected = [p for p in published if (brand is None or _ci(p["brand"]) in brand) and (country is None or _ci(p["country_code"]) in country)
                and (lang is None or _ci(p["lang_code"]) in lang)]
    if not selected:
        return None, R09_NO_SITES
    return selected, None


def published_subtotal(sites: Sequence[dict[str, Any]]) -> dict[str, Any] | None:
    """현행 publishedSubtotal(truth-axes.ts:342-364): 선택 ∩ 헤드라인 풀, 비면 선택 전체. 반환 = report_values_sql 행 모양 + site_count."""
    if not sites:
        return None
    pool = [s for s in sites if s["in_headline_pool"]]
    use = pool or list(sites)
    return {"round_date": sites[0]["round_date"], "measured": sum(int(s["measured_prompts"]) for s in use),
            "target_hit": sum(int(s["target_hit_prompts"]) for s in use), "owned": sum(int(s["owned_prompts"]) for s in use),
            "owned_den": sum(int(s["owned_prompts_den"]) for s in use), "units": len(use), "site_count": len(use),
            "slugs": sorted({s["slug"] for s in use}), "pool_applied": 0 < len(pool) < len(sites)}


async def legacy_report_rows(conn: Any, ms: MeasureScope, win: Window, req: R09Request, *,
                             by_round: bool) -> tuple[list[dict[str, Any]], str | None, dict[date, str], date | None]:
    """현행 발행값 선택(web_url_rate). 반환 (발행값 행(report_values_sql 모양 + site_count), 전체 라이브 사유, 회차별 라이브 사유, 카드 회차)."""
    from app.core.db import fetch_all

    reason, card_round = legacy_r09_route(ms, win, req, by_round=by_round)
    if reason is not None:
        return [], reason, {}, card_round
    rds = list(win.round_dates) if by_round else [card_round]  # type: ignore[list-item]
    if not rds:
        return [], None, {}, card_round
    q = published_sites_sql(rds)                                                  # type: ignore[arg-type]
    pub = await fetch_all(conn, q.text, q.params)
    by_rd: dict[date, list[dict[str, Any]]] = {}
    for p in pub:
        by_rd.setdefault(p["round_date"], []).append(p)
    runtime: list[dict[str, Any]] = []
    if by_rd:
        qr = runtime_sites_sql(req.account_project_keys) if req.account_project_keys else None
        runtime = await fetch_all(conn, qr.text, qr.params) if qr is not None else []
    rows: list[dict[str, Any]] = []
    why: dict[date, str] = {}
    for d in rds:
        sel, r = decide_published_selection(by_rd.get(d, []), runtime, req)       # type: ignore[arg-type]
        sub = published_subtotal(sel) if sel is not None else None
        if sub is None:
            why[d] = r or R09_NO_PUBLICATION                                      # type: ignore[index]
        else:
            rows.append(sub)
    return rows, None, why, card_round


def fold_url_rates(win: Window, live: Sequence[dict[str, Any]], report: Sequence[dict[str, Any]], *, by_round: bool,
                   r09: str | None, reasons: dict[Any, str] | None = None, card_round: date | None = None) -> dict[Any, dict[str, Any]]:
    """R09·A5·G-22: 발행 회차는 발행값(프롬프트 단위), 그 밖은 라이브(측정 단위). r09 = r09_reason 결과(None 이면 발행값 사용 가능).
    반환 키: by_round 면 round_date, 아니면 None. 값: target·owned(정수 쌍)·accuracy(타겟 ∧ 자사 / 자사, 항상 라이브)·origin(report|live)·
    reason(라이브 사유, 발행값이면 None)·publications(합산에 들어간 발행물 slug, 스코프 안 것만)·headline_pool_applied·
    prompts((측정·타겟·자사) 프롬프트 수: 발행값이면 발행 프롬프트 합, 라이브면 part 'url_prompts' 결과, 그 part 가 없으면 None).
    reasons·card_round(web_url_rate 현행 선택 전용, 생략 = 종전): 회차별 라이브 사유(발행물 안 선택이 거부된 사유)·카드 조회 회차(from = to 날짜)."""
    rep = {r["round_date"]: r for r in report} if r09 is None else {}
    why = reasons or {}
    out: dict[Any, dict[str, Any]] = {}
    if by_round:
        for r in live:
            d = r["round_date"]
            out[d] = _report_cell(rep[d]) if d in rep else _live_cell(r, r09 or why.get(d) or R09_NO_PUBLICATION)
            out[d]["accuracy"] = (int(r.get("tgt_own_hits") or 0), int(r.get("own_url_hits") or 0))
        for d, x in rep.items():
            if d not in out:
                out[d] = {**_report_cell(x), "accuracy": (0, 0)}
        return out
    r0 = live[0] if live else {}
    key = card_round if card_round is not None else win.lo
    if r09 is None and key in rep:
        out[None] = _report_cell(rep[key])
    else:
        out[None] = _live_cell(r0, r09 or why.get(key) or R09_NO_PUBLICATION)
    out[None]["accuracy"] = (int(r0.get("tgt_own_hits") or 0), int(r0.get("own_url_hits") or 0))
    return out


async def url_rates(conn: Any, ms: MeasureScope, win: Window, *, brands: Sequence[str], countries: Sequence[str] | None,
                    langs: Sequence[str] | None, by_round: bool = False,
                    live: Sequence[dict[str, Any]] | None = None, prompt_units: bool = False,
                    req: R09Request | None = None) -> dict[Any, dict[str, Any]]:
    """M06 타겟 URL 인용률·M07 자사 URL 인용률·인용 정확도(website·project). R09 발행값은 website 기본 엔진일 때만.
    brands·countries·langs 는 필수 인자다(기본값 없음: ReadContext.own_brands·countries·langs 를 그대로 넘긴다, 무제한이면 None 명시).
    live: 호출자가 같은 창·group_by(by_round 면 ('round_date',), 아니면 ())로 이미 센 fetch_counts 결과(parts 에 'urls' 포함)를 넘기면
    rd.answer 를 다시 읽지 않는다. 발행값은 ms 의 project_keys·geo_keys 범위로 한정한다. 인용 숨김 회차 억제는 호출자가
    win.hidden('citations') 로 먼저 판단한다.
    prompt_units=True(결정 6): 라이브 값에 프롬프트 단위(part 'url_prompts')를 함께 센다. live 를 넘기면 그 결과에 url_prompts part 가 있어야 한다.
    req(현행 프로필 web_url_rate, website): 현행 발행값 라우팅 입력(ReadContext.r09). 켜짐이면 brands·countries·langs 대신 req 로 발행 사이트를
    고른다(legacy_report_rows: 권한 게이트·발행물 어휘·어휘 분기·헤드라인 풀). 켜짐인데 req 가 없으면 ValueError."""
    from app.core.db import fetch_all

    if live is None:
        parts = ("urls", "url_prompts") if prompt_units else ("urls",)
        live = await fetch_counts(conn, ms, win, group_by=("round_date",) if by_round else (), parts=parts)
    elif live and "url_den" not in live[0]:
        raise ValueError("live 결과에 urls part(url_den) 가 없다")
    elif prompt_units and live and "url_measured_prompts" not in live[0]:
        raise ValueError("live 결과에 url_prompts part(url_measured_prompts) 가 없다")
    if legacy_url_rate(ms):
        rows, why0, why, card_round = await legacy_report_rows(conn, ms, win, _need_req(req), by_round=by_round)
        return fold_url_rates(win, live, rows, by_round=by_round, r09=why0, reasons=why, card_round=card_round)
    reason = r09_reason(ms, win, by_round=by_round)
    report: list[dict[str, Any]] = []
    if reason is None:
        rds = list(win.round_dates) if by_round else [d for d in win.round_dates if d == win.lo]
        if rds:
            q = report_values_sql(rds, brands, countries, langs, project_keys=ms.project_keys, geo_keys=ms.geo_keys)
            report = await fetch_all(conn, q.text, q.params)
    return fold_url_rates(win, live, report, by_round=by_round, r09=reason)


# ── 동결 층 빈 집계 판정(S4b) ─────────────────────────────────────────────────────────────────────────────────────
# 현행 agg-empty·agg-widget-empty(server.ts:1970-1979·2091·3036·5156, summary-trend-aggregates.ts:1630-1636): 집계층 키 행이 0(필터 뒤 0 포함)이거나
# 위젯 행이 0 이면 미러(또는 세부층)로 간다. 허브 대응 = 같은 창·필터·게이트로 동결 읽기 행이 하나도 없는가.
EmptyKind = Literal["answers", "answers_brands", "citations"]


def frozen_empty_sql(ms: MeasureScope, win: Window, kind: EmptyKind) -> Sql:
    """동결 읽기 빈 집계 탐침: 결과 열 empty(참 = 현행 빈 집계). answers = 답변 행(현행 own 키 행: 모수 게이트 없는 감시 답변),
    answers_brands = 그에 더해 경쟁 브랜드 행(GEO 위젯: HMG 형제 제외, toGeoKpi summary-global-aggregates.ts:1000),
    citations = 호스트 있는 인용 원소(도메인 카드: 이름 붙은 그룹·인용 합 0, summary-citation-read.ts:219-236).
    동결 셀 게이트(frozen_gate)는 건다: 현행 집계층 행은 어느 읽기든 trendWhere 의 run_status·in_tagged_region 을 지난다."""
    if kind not in ("answers", "answers_brands", "citations"):
        raise ValueError(f"알 수 없는 빈 판정: {kind}")
    b = Binder("e")
    ft = fact_tables(ms)
    if kind == "citations":
        w = (win.where("c", "citations", b) + scope_where(ms, "c", b) + frozen_gate(ms, "c", "citation") + unit_gate_of(ms, "c", "citation")
             + ["c.source_key <> 0"])
        return b.sql(f"SELECT NOT EXISTS (SELECT 1 FROM {ft.citation} c WHERE {' AND '.join(w)}) AS empty")
    w = win.where("a", "row", b) + scope_where(ms, "a", b) + frozen_gate(ms, "a") + unit_gate_of(ms, "a")
    t = f"SELECT NOT EXISTS (SELECT 1 FROM {ft.answer} a WHERE {' AND '.join(w)})"
    if kind == "answers_brands":
        wb = (win.where("x", mention_family(ms), b) + scope_where(ms, "x", b) + frozen_gate(ms, "x", "brand") + unit_gate_of(ms, "x", "brand")
              + ["x.competitive", "x.own_bit = 0", "x.brand_key <> 0"])
        t += f" OR NOT EXISTS (SELECT 1 FROM {ft.answer_brand} x WHERE {' AND '.join(wb)})"
    return b.sql(t + " AS empty")


# 현행 URL 인용률 리더의 커버리지(summary-website-aggregates.ts:1273-1297): 고른 회차 세대가 전부 summary_url_hit_generations 에 있어야 사실표.
# 허브 = 이관 세대의 judgment.url_hits_covered(이관기가 frz_ops_url_cov 로 적는다). 허브 생성 세대(S2)는 생성 때 job 플래그를 동결 행으로 가진다
# (현행 새 세대도 0081 뒤 생성기가 url_hits 를 늘 굽는다) = 덮인 것으로 본다. 이관 세대인데 표시가 없으면 덮이지 않은 것(모르면 미러 쪽)
URL_UNCOVERED_SQL = """
SELECT EXISTS (SELECT 1 FROM frz.generation g
                WHERE g.state = 'active' AND g.source = 'ops' AND g.cyc_key = ANY(CAST(:ks AS int4[]))
                  AND (g.judgment ->> 'url_hits_covered') IS DISTINCT FROM 'true')
"""


async def url_hits_uncovered(conn: Any, win: Window) -> bool:
    """창의 인용 계열 회차 중 url_hits 가 없는 이관 세대가 있나(S4b)."""
    from app.core.db import fetch_val

    ks = win.cyc_keys("citations")
    return bool(ks) and bool(await fetch_val(conn, URL_UNCOVERED_SQL, {"ks": list(ks)}))


# ── 동결 층 브랜드 표시명(S4) ─────────────────────────────────────────────────────────────────────────────────────
# 현행 집계층 브랜드 행의 이름은 생성 시점 summary_brand_mentions.brand_name 이다. 허브는 키(brand_key)로 집계하고 이름은 rd.dim_brand_name 을 읽으므로,
# 동결 읽기면 창 회차 동결 세대의 이름(frz.card_brand_name)으로 덮는다. 창에 회차가 여럿이면 가장 늦은 회차 세대의 이름(한 키 = 한 행).
FRZ_BRAND_NAMES_SQL = """
SELECT DISTINCT ON (n.brand_key) n.brand_key, n.name
  FROM frz.card_brand_name n JOIN rd.cycle c ON c.cyc_key = n.cyc_key
 WHERE n.cyc_key = ANY(CAST(:ks AS int4[])) AND n.brand_key = ANY(CAST(:bk AS int4[]))
 ORDER BY n.brand_key, c.round_date DESC, n.cyc_key DESC
"""


async def frozen_brand_names(conn: Any, ms: MeasureScope, win: Window, keys: Sequence[int]) -> dict[int, str]:
    """동결 읽기면 brand_key → 생성 시점 표시명(창 회차의 동결 세대), 아니면 {}. 호출자는 rd.dim_brand_name 이름 위에 덮는다."""
    from app.core.db import fetch_all

    ks = win.union_keys("mentions", "citations")
    bk = sorted({int(k) for k in keys if int(k) != 0})
    if not frozen_read(ms) or not ks or not bk:
        return {}
    return {int(r["brand_key"]): str(r["name"]) for r in await fetch_all(conn, FRZ_BRAND_NAMES_SQL, {"ks": list(ks), "bk": bk})}


# ── ⑥ 인용 정확도 현행 정의(web_accuracy_flat, CACC6, WU-12) ─────────────────────────────────────────────────────
# 허브 기본: 분자 = tgt_cited ∧ own_url_cited(자기 프롬프트 타겟), 분모 = own_url_cited(urls part 의 tgt_own_hits·own_url_hits).
# 현행(hmg-geo 2670a16) 두 경로(S4: unit 은 동결 층 생성 시점 셀 판정 frz.card_web 으로 센다. 동결 회차는 S2 생성기가 아래 식으로 굽고,
# 이관 회차는 운영 summary_answers 플래그를 그대로 옮긴다):
#   unit   카드(card=true, 기간 없음)·추이 = 집계층 summary_answers 유닛 플래그(summary-website-aggregates.ts:1164-1180·1570-1585):
#          분모 = unit_owned, 분자 = unit_owned ∧ unit_target. unit_target = 답변 인용(보고서 NORM = cit_norm) 중 하나라도 같은 보고서 유닛
#          (생성 프로젝트 × report_fs) 프롬프트 전체의 타겟 URL 과 같음(생성기 scripts/summary/surface-website.ts:805-820 ut 'flat').
#          모수 = 집계층(보고서 유닛 소속, web_registered_only). 분모는 허브 own_url_cited 와 같다(stg 09-25 5,681 = 5,681).
#   screen 기간 카드(website 화면은 기간이 있으면 cumulative: true, website/page.tsx:121 → S6.citation 게이트 폴백 → 미러)·비카드 =
#          미러 aggregateWebsiteCitationAccuracy(scope-aggregates.ts:8970-9010): 타겟 = 인용 중 하나라도 화면 사이트 전체 타겟 URL 집합
#          (websiteTargetSetSelect :8831-8849, 언어 축으로 좁힘), 분모 = 자사 ∨ 타겟(websiteCitationJudgmentCtes ownedOrTarget), 분자 = 타겟.
#          모수 = 미러 = 비카드 모수(유닛 게이트·자리 대표 없음): 호출자가 card=False 창을 넘긴다.
#          타겟 집합은 rd.web_target_url(DB-v2.20: 타겟 정규형 → url_key 사전 해석, 적재기가 맞춘다)에서 읽는다.
AccuracyMode = Literal["unit", "screen"]


def legacy_accuracy(ms: MeasureScope) -> bool:
    """web_accuracy_flat(CACC6, WU-12)이 이 스코프에 걸리나: website 표면만."""
    return ms.profile.web_accuracy_flat and ms.sf == 2


def accuracy_mode(card: bool, has_period: bool) -> AccuracyMode:
    """현행 ⑥ 경로: 카드 요청이고 기간이 없으면 집계층(unit), 그 밖(기간 카드 = 미러 cumulative, 비카드 = 미러)은 screen.
    추이는 카드면 unit(summaryWebsiteCitationAccuracyTrend), 비카드면 screen(미러 추이) → 호출자가 has_period=False 로 부른다."""
    return "unit" if card and not has_period else "screen"


def accuracy_counts_sql(ms: MeasureScope, win: Window, *, mode: AccuracyMode, group_by: Sequence[str] = ()) -> Sql:
    """⑥ 현행 정의의 (own_url_hits, tgt_own_hits) = (분모, 분자). 열 이름은 urls part 와 같아 ratios() 의 citation_accuracy 로 읽힌다.
    mode = unit | screen(accuracy_mode). screen 은 ms.card 를 끈 모수(유닛 게이트 없음)로 센다: 창(win)은 호출자가 비카드 창을 넘긴다.
    unit(카드·기간 없음)은 동결 읽기(core.facts.frozen_read)에서만 성립한다(S4): 현행 분모 = sum(unit_owned), 분자 = sum(unit_owned ∧ unit_target)
    (summary-website-aggregates.ts:1164-1180)를 생성 시점 셀 판정(frz.card_web)으로 센다. 모수 = 카드 인용 모수 ∧ 생성 시점 유닛 소속·제외 유닛 아님
    (answerWhere = sharedWhere + unitWhere). 세대 없는 회차가 창에 있으면 요청이 비카드(screen)로 내려오므로(ReadContext.card_window) 조회 시점
    유닛 판정 경로는 없다."""
    if mode not in ("unit", "screen"):
        raise ValueError(f"알 수 없는 ⑥ 경로: {mode}")
    a, c = "a", "c"
    b = Binder("y")
    gsel, _ = _group_select(group_by, None, a, b)
    if mode == "unit":
        if not frozen_read(ms):
            raise ValueError("⑥ 유닛 경로(카드·기간 없음)는 동결 읽기에서만: 창 판정(ReadContext.card_window)을 거치지 않은 스코프")
        pop = win.where(a, "citations", b) + scope_where(ms, a, b) + [citation_population(ms, a, unit_gate=False), f"{a}.unit_in"]
        t = (f"SELECT {', '.join(gsel + [f'count(*) FILTER (WHERE {a}.unit_owned) AS own_url_hits', f'count(*) FILTER (WHERE {a}.unit_owned AND {a}.unit_target) AS tgt_own_hits'])}\n"
             f"  FROM {fact_tables(ms).answer} {a}\n WHERE {' AND '.join(pop)}")
        if gsel:
            t += "\n GROUP BY " + ", ".join(str(i + 1) for i in range(len(gsel)))
        return b.sql(t)
    m = replace(ms, card=False)
    projects = b.ints(m.project_keys)
    cw = win.where(c, "citations", b) + scope_where(m, c, b) + [citation_population(m, c, "citation", unit_gate=False)]
    # 타겟 URL 사전 해석 표(rd.web_target_url, DB-v2.20 P111): 화면 사이트 프로젝트 · 언어 축으로 좁힌 url_key 집합. 인용은 url_key 만
    # 본다(인용 표 url_key 색인). 쿼리 시점에 dim_url 로 정규형을 비교하던 형태보다 stg C11 1년 979 → ~800 ms, 30일 566 → ~280 ms
    lang = f" AND t.lang_key = ANY({b.ints(m.lang_keys)})" if m.lang_keys is not None else ""
    tg = f"SELECT t.url_key FROM rd.web_target_url t WHERE t.project_key = ANY({projects}){lang}"
    hit = (f"SELECT DISTINCT {c}.answer_key FROM {fact_tables(m).citation} {c}"
           f" WHERE {' AND '.join(cw)} AND {c}.url_key IN (SELECT url_key FROM tg)")
    pop = win.where(a, "citations", b) + scope_where(m, a, b) + [citation_population(m, a)]
    target = f"{a}.answer_key IN (SELECT answer_key FROM hit)"
    owned = f"({a}.own_url_cited OR {target})"
    t = (f"WITH tg AS MATERIALIZED ({tg}),\nhit AS MATERIALIZED ({hit})\n"
         f"SELECT {', '.join(gsel + [f'count(*) FILTER (WHERE {owned}) AS own_url_hits', f'count(*) FILTER (WHERE {target}) AS tgt_own_hits'])}\n"
         f"  FROM {fact_tables(m).answer} {a}\n WHERE {' AND '.join(pop)}")
    if gsel:
        t += "\n GROUP BY " + ", ".join(str(i + 1) for i in range(len(gsel)))
    return b.sql(t)


async def accuracy_counts(conn: Any, ms: MeasureScope, win: Window, *, mode: AccuracyMode,
                          group_by: Sequence[str] = ()) -> list[dict[str, Any]]:
    """accuracy_counts_sql 실행. 빈 창이면 DB 문장 없이 [](그룹 없음이면 0 행 1개)."""
    from app.core.db import fetch_all

    if win.empty:
        return [] if group_by else [{"own_url_hits": 0, "tgt_own_hits": 0}]
    q = accuracy_counts_sql(ms, win, mode=mode, group_by=group_by)
    return await fetch_all(conn, q.text, q.params)


# ── 프로젝트 ⑥ 인용 정확도 현행 정의(project_accuracy_single_base, DC-23·차이 #13) ─────────────────────────────────────
# 현행(hmg-geo 2670a16) 프로젝트 ⑥ 카드·추이 = 미러 aggregateCitationAccuracy·aggregateCitationAccuracyTrend(scope-aggregates.ts:8392-8559):
#   분모 = 인용 중 하나라도 정규형(cnorm = 추적 정규화)이 자사 접두 P 와 같거나 P || '/%' 에 LIKE 인 답변, 분자 = 그중 인용 중 하나라도 정규형이
#   추적 URL 정규형 집합에 든 답변, rate = round1(100 × 분자 ÷ 분모)(분모 0 = 값 없음). P = normalizeUrlForMatch(유효 owned base 하나)
#   (projects/[id]/_data/live.ts:225-268: 설정 base 가 있으면 그것들, 없으면 project.domain. 정확히 하나일 때만 조회).
# 허브 기본(urls part)은 웹사이트 규칙이다: 분모 = own_url_cited(적재 loc_owned ∨ tgt_hit, loc_owned = 설정 base ∪ 브랜드·국가 owned base·형제 제외·
#   홈 호스트), 분자 = tgt_cited. 자사 판정 범위와 분모의 타겟 항이 현행과 다르다. 판정 입력(base·domain·추적 URL)은 조회 시점에 app 표에서 읽는다
#   (현행도 조회 시점 판정: 편집 직후 다음 호출에 반영). 결과 캐시는 끝점 추가 키(project_accuracy_cache_key)로 그 표 지문을 싣는다.
@dataclass(frozen=True)
class ProjectAccuracyBase:
    """현행 프로젝트 ⑥ 판정 입력(project_accuracy_base 결과): prefix = 자사 접두, targets = 추적 URL 정규형(빈 값 제외·중복 제거·정렬)."""
    prefix: str
    targets: tuple[str, ...]


def project_accuracy(ms: MeasureScope) -> bool:
    """project_accuracy_single_base(DC-23·#13)가 이 스코프에 걸리나: project 표면만."""
    return ms.profile.project_accuracy_single_base and ms.sf == 3


def project_accuracy_base(domain: str | None, bases: Sequence[str], urls: Sequence[str]) -> ProjectAccuracyBase | None:
    """현행 프로젝트 ⑥ 입력 판정(순수 함수). None = 값 없음(현행은 ⑥ 을 조회하지 않는다):
    - 추적 URL 0개(scope-aggregates.ts:8400·8471, 정규화 전 행 수로 판정)
    - 유효 owned base 가 하나가 아님(설정 base 2개 이상, 또는 설정 0개 ∧ domain 없음: live.ts:225-231·244-268)
    자사 접두 = 유효 base 하나(설정 base_url 또는 project.domain)의 normalizeUrlForMatch. 추적 URL 정규형은 원문 url 을 그 자리에서 정규화한다
    (현행 :8424-8426: 저장된 url_norm 이 아니라 url 을 매번 정규화, 빈 값 제외). 빈 접두(현행은 글로벌 OWNED 호스트 패턴으로 대체)는 허브 쓰기
    불변식상 생기지 않는다(base_url = canonical_http_url, domain = 비지 않은 base_norm 또는 NULL: projects.project.core seed_domain·
    resync_project_domain): 값 없음으로 닫는다."""
    from app.core.urls import normalize_url_for_match

    if not urls:
        return None
    eff = list(bases) if bases else ([domain] if domain else [])
    if len(eff) != 1:
        return None
    prefix = normalize_url_for_match(eff[0])
    if not prefix:
        return None
    return ProjectAccuracyBase(prefix, tuple(sorted({n for n in (normalize_url_for_match(u) for u in urls) if n})))


# 프로젝트 ⑥ 판정 입력(rd.dim_project → app.project 1행). 순서는 판정에 영향이 없다(정렬은 재현성 표시)
PROJECT_ACCURACY_INPUTS_SQL = """
SELECT p.domain,
       ARRAY(SELECT b.base_url FROM app.project_owned_base b WHERE b.project_id = p.project_id ORDER BY b.base_url) AS bases,
       ARRAY(SELECT t.url FROM app.project_tracked_url t WHERE t.project_id = p.project_id ORDER BY t.url) AS urls
  FROM rd.dim_project dp JOIN app.project p ON p.project_id = dp.project_id
 WHERE dp.surface = 3 AND dp.project_key = ANY(CAST(:pk AS int2[]))
"""

# 결과 캐시 끝점 추가 키(project_accuracy_cache_key): 두 app 표(owned base·추적 URL)는 추적 표(DB-v2.11 P67)가 아니다. 쓰기는 같은 트랜잭션에서
# judgment_change 를 남겨 데이터 버전이 바뀌지만, 판정 입력을 읽는 이 경로는 그 규약에 기대지 않고 요청마다 같은 스냅샷에서 지문을 다시 읽는다
PROJECT_ACCURACY_VERSION_SQL = """
SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS v
  FROM (SELECT concat_ws(',', 'd', p.domain) FROM app.project p WHERE p.project_id = CAST(:pid AS uuid)
        UNION ALL
        SELECT concat_ws(',', 'b', b.base_url) FROM app.project_owned_base b WHERE b.project_id = CAST(:pid AS uuid)
        UNION ALL
        SELECT concat_ws(',', 't', t.url) FROM app.project_tracked_url t WHERE t.project_id = CAST(:pid AS uuid)) t(x)
"""


def project_accuracy_counts_sql(ms: MeasureScope, win: Window, base: ProjectAccuracyBase, *, group_by: Sequence[str] = ()) -> Sql:
    """현행 프로젝트 ⑥ 의 (own_url_hits, tgt_own_hits) = (분모, 분자). 열 이름은 urls part 와 같아 호출자가 같은 자리에 끼운다.
    모수 = 허브 ⑥(urls part)과 같은 답변(창 인용 계열 ∧ 스코프 ∧ citation_population): 바뀌는 것은 판정뿐이다(scope-aggregates.ts:8434-8450·
    8510-8536). 자사 = 그 답변 인용 중 하나라도 정규형(rd.dim_url.url_norm = 미러 cnorm, 같은 정규화 citation_url_norm)이 P 이거나
    LIKE P || '/%'(현행 LIKE 그대로: 접두의 % _ 도 패턴이다), 타겟 = 인용 중 하나라도 정규형 ∈ 추적 URL 정규형(비면 거짓).
    인용은 호스트 유무·인용 행 게이트와 무관하게 그 답변의 전부를 본다(현행 EXISTS … WHERE c.job_id = a.job_id)."""
    a, c = "a", "c"
    b = Binder("y")
    gsel, _ = _group_select(group_by, None, a, b)
    ft = fact_tables(ms)
    p = b.v(base.prefix, "text")
    tg = b.v(list(base.targets), "text[]")
    cw = win.where(c, "citations", b) + [f"{c}.project_key = ANY({b.ints(ms.project_keys)})"]
    hit = (f"SELECT {c}.answer_key, bool_or(u.url_norm = {p} OR u.url_norm LIKE {p} || '/%') AS owned,"
           f" bool_or(u.url_norm = ANY({tg})) AS target\n"
           f"  FROM {ft.citation} {c} JOIN rd.dim_url u ON u.url_key = {c}.url_key\n WHERE {' AND '.join(cw)}\n GROUP BY {c}.answer_key")
    pop = win.where(a, "citations", b) + scope_where(ms, a, b) + [citation_population(ms, a)]
    cols = ["count(*) FILTER (WHERE h.owned) AS own_url_hits", "count(*) FILTER (WHERE h.owned AND h.target) AS tgt_own_hits"]
    t = (f"WITH hit AS MATERIALIZED ({hit})\n"
         f"SELECT {', '.join(gsel + cols)}\n  FROM {ft.answer} {a} JOIN hit h ON h.answer_key = {a}.answer_key\n WHERE {' AND '.join(pop)}")
    if gsel:
        t += "\n GROUP BY " + ", ".join(str(i + 1) for i in range(len(gsel)))
    return b.sql(t)


async def project_accuracy_counts(conn: Any, ms: MeasureScope, win: Window, *, group_by: Sequence[str] = ()) -> list[dict[str, Any]]:
    """현행 프로젝트 ⑥ 쌍. 판정 입력이 없으면(project_accuracy_base None) 또는 빈 창이면 사실 표 문장 없이 [](그룹 없음이면 0 행 1개) = 값 없음."""
    from app.core.db import fetch_all

    zero: list[dict[str, Any]] = [] if group_by else [{"own_url_hits": 0, "tgt_own_hits": 0}]
    if win.empty:
        return zero
    rows = await fetch_all(conn, PROJECT_ACCURACY_INPUTS_SQL, {"pk": sorted({int(k) for k in ms.project_keys})})
    if len(rows) > 1:
        raise ValueError("프로젝트 ⑥ 현행 정의는 프로젝트 하나의 스코프에서만: project 표면 스코프가 아니다")
    base = project_accuracy_base(rows[0]["domain"], list(rows[0]["bases"]), list(rows[0]["urls"])) if rows else None
    if base is None:
        return zero
    q = project_accuracy_counts_sql(ms, win, base, group_by=group_by)
    return await fetch_all(conn, q.text, q.params)


async def project_accuracy_cache_key(conn: Any, query: Any) -> str | None:
    """결과 캐시 끝점 추가 키 본체(K-1 요약·T-1 추이 라우터의 key_deps 가 부른다). 켜짐(project_accuracy_single_base) ∧ surface=project ∧
    project_id 가 uuid 일 때만 판정 입력 지문(PROJECT_ACCURACY_VERSION_SQL). 그 밖 = None(문장 없음). query = 요청 query_params."""
    import uuid

    from app.core.db import fetch_val
    from app.core.profile import active_profile

    if not active_profile().project_accuracy_single_base or query.getlist("surface") != ["project"]:
        return None
    try:
        pid = uuid.UUID(str(query.get("project_id")))
    except ValueError:
        return None
    return await fetch_val(conn, PROJECT_ACCURACY_VERSION_SQL, {"pid": str(pid)})


def report_publications_sql(round_dates: Sequence[date], brands: Sequence[str], countries: Sequence[str] | None,
                            langs: Sequence[str] | None, *, project_keys: Sequence[int], geo_keys: Sequence[int] | None) -> Sql:
    """BG-26(추가형): report_values_sql 과 **같은 선택**(활성 웹사이트 발행 · 스코프 · 요청 축 · 헤드라인 풀)에서 합산에 들어간
    발행물별 표시 정보. 결과 열: round_date·slug·cycle_label·cycle_label_en·manifest_verified·site_count(그 발행물에서 합산에 들어간
    유닛 수 = 현행 publication.siteCount)·headline_pool_applied. 선택 술어는 report_values_sql 과 한 벌이어야 한다(하나를 바꾸면 둘 다,
    대조: 발행물별 site_count 합 = report_values_sql units, slug 집합 = slugs)."""
    b = Binder("r")
    w = [f"v.round_date = ANY({b.v(sorted(set(round_dates)), 'date[]')})", f"v.brand = ANY({b.v(sorted(set(brands)), 'text[]')})",
         f"EXISTS (SELECT 1 FROM rd.web_unit u WHERE u.file_seq = v.file_seq AND u.project_key = ANY({b.ints(project_keys)}))"]
    if geo_keys is not None:
        w.append(f"EXISTS (SELECT 1 FROM rd.dim_country g WHERE upper(g.code) = upper(v.country_code) AND g.geo_key = ANY({b.ints(geo_keys)}))")
    if countries is not None:
        w.append(f"upper(v.country_code) = ANY({b.v(sorted({c.upper() for c in countries}), 'text[]')})")
    if langs is not None:
        w.append(f"lower(v.lang_code) = ANY({b.v(sorted({x.lower() for x in langs}), 'text[]')})")
    t = ("WITH sel AS (\n"
         "  SELECT v.round_date, v.in_headline_pool, v.pub_id\n"
         "    FROM rd.report_unit_value v\n"
         "    JOIN app.report_publication p ON p.id = v.pub_id AND p.status = 'active' AND p.surface = 'website'\n"
         f"   WHERE {' AND '.join(w)}),\n"
         "pool AS (SELECT round_date, bool_or(in_headline_pool) AS has_pool, bool_and(in_headline_pool) AS all_pool FROM sel GROUP BY round_date)\n"
         "SELECT s.round_date, p.slug, p.cycle_label, p.cycle_label_en, p.manifest_verified, count(*) AS site_count,\n"
         "       bool_or(pool.has_pool AND NOT pool.all_pool) AS headline_pool_applied\n"
         "  FROM sel s JOIN pool ON pool.round_date = s.round_date JOIN app.report_publication p ON p.id = s.pub_id\n"
         " WHERE s.in_headline_pool OR NOT pool.has_pool\n"
         " GROUP BY s.round_date, p.slug, p.cycle_label, p.cycle_label_en, p.manifest_verified\n"
         " ORDER BY s.round_date, p.slug")
    return b.sql(t)


PUBLICATION_INFO_SQL = """
SELECT p.slug, p.cycle_label, p.cycle_label_en, p.manifest_verified
  FROM app.report_publication p
 WHERE p.slug = ANY(CAST(:slugs AS text[]))
"""


async def report_publications(conn: Any, ms: MeasureScope, win: Window, *, brands: Sequence[str], countries: Sequence[str] | None,
                              langs: Sequence[str] | None, req: R09Request | None = None) -> list[dict[str, Any]]:
    """BG-26(추가형): 카드(url_rates by_round=False)가 발행값을 쓴 회차(win.lo)의 발행물 표시 정보. 발행값을 못 쓰는 창(r09_reason 사유)
    이면 DB 문장 없이 []. 인자 규약은 url_rates 와 같다(ReadContext.own_brands·countries·langs 를 그대로).
    web_url_rate(현행 선택, req 필수): 같은 legacy_report_rows 선택에서 합산에 들어간 발행물(현행 publication.siteCount = 헤드라인 풀 뒤 유닛 수)."""
    from app.core.db import fetch_all

    if legacy_url_rate(ms):
        rows, why0, _, _ = await legacy_report_rows(conn, ms, win, _need_req(req), by_round=False)
        if why0 is not None or not rows:
            return []
        sub = rows[0]
        info = {r["slug"]: r for r in await fetch_all(conn, PUBLICATION_INFO_SQL, {"slugs": list(sub["slugs"])})}
        return [{"round_date": sub["round_date"], "slug": s, "cycle_label": info.get(s, {}).get("cycle_label"),
                 "cycle_label_en": info.get(s, {}).get("cycle_label_en"), "manifest_verified": bool(info.get(s, {}).get("manifest_verified")),
                 "site_count": sub["site_count"], "headline_pool_applied": sub["pool_applied"]} for s in sub["slugs"]]
    if r09_reason(ms, win, by_round=False) is not None or win.lo is None:
        return []
    q = report_publications_sql([win.lo], brands, countries, langs, project_keys=ms.project_keys, geo_keys=ms.geo_keys)
    return await fetch_all(conn, q.text, q.params)


# ════════════════════════════════════════════════════════════════════════════
# 브랜드 행(M-1, QUERY-FIXES M-1)
# ════════════════════════════════════════════════════════════════════════════
def competitor_rows_sql(ms: MeasureScope, win: Window, *, group_by: Sequence[str] = (), hmg_siblings: bool = True,
                        mentions_only: bool = False) -> Sql:
    """경쟁 행: competitive ∧ std_in ∧ NOT (own_bit = ANY(관점 비트)). 형제 HMG 브랜드는 남는다(M-1·T-1). LIMIT 없음(순위는 앱).
    hmg_siblings=False 면 관점 밖 HMG 브랜드(own_bit ≠ 0)도 뺀다(GEO-1 브랜드 격리, 현행 marketStats: 권한 밖 형제 브랜드는 목록·순위에
    없고 분모(답변 ment_total)에만 남는다).
    mentions_only=True(B094: 언급 수만 쓰는 소비자, 웹사이트 GEO)면 brand_key·mentions 만 싣는다(노출·순위·톤 합 없음, 술어·묶음은 같다).
    현행 프로필 자리: brand_exposure_per_alias(G20, WU-4 구현: 노출 답변 수 = sum(rid_n) = (답변, 롤업 id) 단위, 현행 fold.ts:468,486).
    켜지면 rid_n_missing(채우기 전 행 수) 열이 붙고 brand_rows 가 0 이 아니면 예외를 낸다(결과 행에서는 뺀다). mentions_only 여도 이 검사는 같다."""
    require_slot(ms.profile, "brand_exposure_per_alias")
    t_ = "b"
    b = Binder("b")
    gsel, _ = _group_select(group_by, None, t_, b)
    _cols(ms.own_bits)
    w = (win.where(t_, mention_family(ms), b) + scope_where(ms, t_, b)
         + [mention_population(ms, t_, "brand"), f"{t_}.competitive",
            f"NOT ({t_}.own_bit = ANY({b.ints(ms.own_bits)}))" if hmg_siblings else f"{t_}.own_bit = 0"])
    # G20(brand_exposure_per_alias, WU-4): 노출 답변 수 = (답변, 롤업 id) 수 = sum(rid_n)(DB-v2.15 P89). 채우기 전 행(NULL)은 조용히 빠지지 않게
    #   rid_n_missing 으로 세어 brand_rows 가 예외를 낸다. 언급 수·순위·톤 합은 롤업 id 로 나뉘지 않아(언급 행 1개 = rid 1개) 그대로다.
    g20 = ms.profile.brand_exposure_per_alias
    missing = [f"count(*) FILTER (WHERE {t_}.rid_n IS NULL) AS rid_n_missing"] if g20 else []
    if mentions_only:
        cols = [f"{t_}.brand_key", f"sum({t_}.mention_count) AS mentions", *missing]
    else:
        expo = [f"coalesce(sum({t_}.rid_n), 0) AS exposure_answers", *missing] if g20 else ["count(*) AS exposure_answers"]
        cols = [f"{t_}.brand_key", f"sum({t_}.mention_count) AS mentions", *expo,
                f"coalesce(sum({t_}.rk) FILTER (WHERE {t_}.rk > 0), 0) AS rank_sum", f"count(*) FILTER (WHERE {t_}.rk > 0) AS ranked",
                f"sum({t_}.s_pos) AS s_pos", f"sum({t_}.s_neu) AS s_neu", f"sum({t_}.s_neg) AS s_neg", f"sum({t_}.s_mix) AS s_mix"]
    t = f"SELECT {', '.join(gsel + cols)}\n  FROM {fact_tables(ms).answer_brand} {t_}\n WHERE {' AND '.join(w)}\n GROUP BY " + \
        ", ".join([str(i + 1) for i in range(len(gsel))] + [f"{t_}.brand_key"])
    return b.sql(t)


def lc_key(s: str) -> tuple[Any, ...]:
    """JS String.localeCompare(ICU 루트) 근사: 1차 = 악센트 제거·대소문자 무시, 2차 = 원문 casefold, 3차 = 소문자 우선.
    stg 대조에서 현행 F03 순위를 재현한 정렬(parity runner 와 같은 구현)."""
    base = "".join(ch for ch in unicodedata.normalize("NFKD", s) if not unicodedata.combining(ch)).casefold()
    grp = {"Z": 0, "P": 1, "S": 2, "N": 3}
    prim = tuple((grp.get(unicodedata.category(ch)[0], 4), ch) for ch in base)
    return (prim, s.casefold(), tuple(0 if ch.islower() else 1 for ch in s))


def rank_brand_items(items: list[dict[str, Any]], *, key: str = "mentions", name: str = "name") -> list[dict[str, Any]]:
    """언급 수 내림차순, 동률은 이름 localeCompare 순으로 rank(1부터)를 매긴다(당사 행 포함, SQL LIMIT 금지)."""
    ordered = sorted(items, key=lambda i: (-int(i[key] or 0), lc_key(str(i[name]))))
    for r, i in enumerate(ordered, 1):
        i["rank"] = r
    return ordered


async def brand_rows(conn: Any, ms: MeasureScope, win: Window, *, group_by: Sequence[str] = (),
                     hmg_siblings: bool = True, mentions_only: bool = False) -> list[dict[str, Any]]:
    """경쟁 브랜드 행(competitor_rows_sql). 빈 창이면 DB 문장 없이 []. mentions_only = 언급 수 열만(B094, competitor_rows_sql)."""
    from app.core.db import fetch_all

    if win.empty:
        return []
    q = competitor_rows_sql(ms, win, group_by=group_by, hmg_siblings=hmg_siblings, mentions_only=mentions_only)
    rows = _g20_check(ms, await fetch_all(conn, q.text, q.params))
    renamed = await renamed_brand_keys(conn, ms, win)
    if not renamed:
        return rows
    # 동결 읽기에서 창 회차들의 동결 세대 이름이 다른 키(개명): 현행 집계층은 세대별 brand_name 으로 묶어 두 행이 된다(summary_trend_brands 키 =
    # brand_name, fold.ts:468-486). 그 키만 회차로 나눠 읽고 (그룹, 키, 그 회차 세대 이름)으로 다시 더한다(열이 전부 가산이라 값이 같다)
    q2 = competitor_rows_sql(ms, win, group_by=(*group_by, "cycle"), hmg_siblings=hmg_siblings, mentions_only=mentions_only)
    rows2 = _g20_check(ms, await fetch_all(conn, q2.text, q2.params))
    gnames = [GROUPS[g][0] for g in group_by]
    merged: dict[tuple[Any, ...], dict[str, Any]] = {}
    for r in rows2:
        k = int(r["brand_key"])
        if k not in renamed:
            continue
        nm = renamed[k].get(int(r["cyc_key"]))
        key = (*(r[g] for g in gnames), k, nm)
        cur = merged.get(key)
        if cur is None:
            merged[key] = {**{c: v for c, v in r.items() if c != "cyc_key"}, "frz_name": nm}
        else:
            for c, v in r.items():
                if c not in ("cyc_key", "brand_key", *gnames) and v is not None:
                    cur[c] = int(cur[c] or 0) + int(v)
    return [r for r in rows if int(r["brand_key"]) not in renamed] + list(merged.values())


def _g20_check(ms: MeasureScope, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if ms.profile.brand_exposure_per_alias:
        missing = sum(int(r.pop("rid_n_missing") or 0) for r in rows)
        if missing:
            raise RuntimeError(f"G20 노출 단위 열 rd.answer_brand.rid_n 이 비어 있다({missing} 행): DB-v2.15 채우기(fill-v215.sql §P89) 전이다")
    return rows


RENAMED_SQL = """
SELECT n.brand_key, n.cyc_key, n.name FROM frz.card_brand_name n
 WHERE n.cyc_key = ANY(CAST(:ks AS int4[]))
   AND n.brand_key IN (SELECT m.brand_key FROM frz.card_brand_name m WHERE m.cyc_key = ANY(CAST(:ks AS int4[]))
                        GROUP BY 1 HAVING count(DISTINCT m.name) > 1)
"""


async def renamed_brand_keys(conn: Any, ms: MeasureScope, win: Window) -> dict[int, dict[int, str]]:
    """동결 읽기 창에서 회차마다 동결 세대 이름이 다른 브랜드 키(S4b) → {키: {회차 키: 그 세대 이름}}. 동결 읽기가 아니면 {}."""
    from app.core.db import fetch_all

    ks = win.union_keys("mentions", "citations")
    if not frozen_read(ms) or len(ks) < 2:
        return {}
    out: dict[int, dict[int, str]] = {}
    for r in await fetch_all(conn, RENAMED_SQL, {"ks": list(ks)}):
        out.setdefault(int(r["brand_key"]), {})[int(r["cyc_key"])] = str(r["name"])
    return out


# ════════════════════════════════════════════════════════════════════════════
# M12 적용 프롬프트 수(prompt_counts)
# ════════════════════════════════════════════════════════════════════════════
PromptKind = Literal["single", "acr"]


def applied_prompts_sql(ms: MeasureScope, *, kind: PromptKind | None = None) -> Sql:
    """측정 무관 카탈로그 카운트. global = rd.catalog_entry(브랜드 비트 ∈ 관점 ∪ 엄브렐러), website = 웹 등록 프롬프트,
    project = 프로젝트 프롬프트. 택소노미로 푼 prompt_keys 가 있으면 교집합. kind 를 주면 rd.dim_prompt.kind 로 좁힌다
    (FU-1 '카탈로그에 ACR 프롬프트 없음' 판정, 현행 countStandardAcrPrompts)."""
    b = Binder("a")
    if kind is not None and kind not in ("single", "acr"):
        raise ValueError(f"알 수 없는 kind: {kind}")
    if catalog_all(ms):
        # A41(WU-4): 현행 적용 프롬프트 수(countCatalogPromptsFromCatalog scope-aggregates.ts:6353)도 deleted_at 을 걸지 않는다(:6326-6328 주석).
        # 삭제 행 포함 카탈로그 비트(rd.dim_prompt.cat_mask_all, P88) ∈ 관점 마스크 = 관점 브랜드 행이 하나라도 있는 프롬프트(catalog_entry
        # brand_bit ∈ pop_bits 와 같은 뜻, 삭제 행 포함). 남는 차이: 현행은 카탈로그 행 수(count(*))라 다브랜드 프롬프트를 행마다 센다(A41 밖)
        w = [f"d.cat_mask_all = ANY({b.ints(ms.bgrps or ())})" if ms.bgrps is not None else "d.in_root_catalog_all"]
        if ms.prompt_keys is not None:
            w.append(f"d.prompt_key = ANY({b.ints(ms.prompt_keys, 'int4')})")
        if kind is not None:
            w.append(f"d.kind = {b.v(kind, 'text')}")
        return b.sql(f"SELECT count(*) AS applied_prompts FROM {fact_tables(ms).prompt} d WHERE {' AND '.join(w)}")
    if ms.sf == 1:
        w = ["ce.prompt_key IS NOT NULL", f"ce.brand_bit = ANY({b.ints(ms.pop_bits)})"]
        if ms.prompt_keys is not None:
            w.append(f"ce.prompt_key = ANY({b.ints(ms.prompt_keys, 'int4')})")
        if kind is not None:
            w.append(f"EXISTS (SELECT 1 FROM {fact_tables(ms).prompt} p WHERE p.prompt_key = ce.prompt_key AND p.kind = {b.v(kind, 'text')})")
        t = f"SELECT count(DISTINCT ce.prompt_key) AS applied_prompts FROM rd.catalog_entry ce WHERE {' AND '.join(w)}"
    else:
        w = [f"p.surface = {b.v(ms.sf, 'int2')}", f"p.project_key = ANY({b.ints(ms.project_keys)})"]
        if ms.sf == 2:
            w.append("p.web_reg")
        if ms.lang_keys is not None:
            w.append(f"p.lang_key = ANY({b.ints(ms.lang_keys)})")
        if ms.prompt_keys is not None:
            w.append(f"p.prompt_key = ANY({b.ints(ms.prompt_keys, 'int4')})")
        if kind is not None:
            w.append(f"p.kind = {b.v(kind, 'text')}")
        t = f"SELECT count(*) AS applied_prompts FROM {fact_tables(ms).prompt} p WHERE {' AND '.join(w)}"
    return b.sql(t)


async def prompt_counts(conn: Any, ms: MeasureScope, *, kind: PromptKind | None = None) -> int:
    from app.core.db import fetch_val

    q = applied_prompts_sql(ms, kind=kind)
    return int(await fetch_val(conn, q.text, q.params) or 0)


def applied_prompt_keys_sql(ms: MeasureScope, b: Binder, *, kind: PromptKind | None = None,
                            catalog_row_pred: str | None = None) -> str:
    """M12 적용 프롬프트 집합(프롬프트 키, 한 열 prompt_key). catalog_row_pred 가 없으면 applied_prompts_sql 과 같은 술어이고 개수가 그
    카운트와 같다(BG-04 미측정 목록 = 이 집합 − 측정 집합). b 는 호출자 문장의 Binder(바인드 이름이 한 문장 안에서 겹치지 않게).
    catalog_row_pred(global 전용, 원본 행 별칭 cp = app.prompt): 주면 "그 원본 카탈로그 행이 살아 있고(soft-delete 제외) 이 술어를
    통과하는" 카탈로그 행이 하나라도 있는 키만 남긴다(본문을 내는 목록의 권한 게이트: 대상 시장 3분기 filters.catalog_market_scope,
    BG-04 검증 D1). 이 모듈은 core.filters 를 가져오지 않으므로(순환) 술어는 호출자가 core.filters 로 만들어 넘긴다. 술어 없이
    soft-delete 만 걸려면 "true". 카드 applied_prompts(applied_prompts_sql)에는 걸지 않는다(시장 게이트 여부는 메인 결정 대기)."""
    if kind is not None and kind not in ("single", "acr"):
        raise ValueError(f"알 수 없는 kind: {kind}")
    if ms.sf == 1:
        w = ["ce.prompt_key IS NOT NULL", f"ce.brand_bit = ANY({b.ints(ms.pop_bits)})"]
        if catalog_row_pred is not None:
            w.append("EXISTS (SELECT 1 FROM app.prompt cp WHERE cp.prompt_id = ce.catalog_row_id AND cp.deleted_at IS NULL"
                     f" AND {catalog_row_pred})")
        if ms.prompt_keys is not None:
            w.append(f"ce.prompt_key = ANY({b.ints(ms.prompt_keys, 'int4')})")
        if kind is not None:
            w.append(f"EXISTS (SELECT 1 FROM {fact_tables(ms).prompt} p WHERE p.prompt_key = ce.prompt_key AND p.kind = {b.v(kind, 'text')})")
        return f"SELECT DISTINCT ce.prompt_key FROM rd.catalog_entry ce WHERE {' AND '.join(w)}"
    w = [f"p.surface = {b.v(ms.sf, 'int2')}", f"p.project_key = ANY({b.ints(ms.project_keys)})"]
    if ms.sf == 2:
        w.append("p.web_reg")
    if ms.lang_keys is not None:
        w.append(f"p.lang_key = ANY({b.ints(ms.lang_keys)})")
    if ms.prompt_keys is not None:
        w.append(f"p.prompt_key = ANY({b.ints(ms.prompt_keys, 'int4')})")
    if kind is not None:
        w.append(f"p.kind = {b.v(kind, 'text')}")
    return f"SELECT p.prompt_key FROM {fact_tables(ms).prompt} p WHERE {' AND '.join(w)}"


def measured_prompt_where(ms: MeasureScope, win: Window, a: str, b: Binder) -> list[str]:
    """M12 측정 프롬프트 술어(rd.answer 별칭 a): plan_counts 'prompts' 문장과 같다(창 3술어 언급 계열 + 필터 축 + std_in).
    이 술어의 count(DISTINCT prompt_key) = fetch_counts(parts 'prompts') measured_prompts(BG-04 미측정 목록·BG-08 퍼널별 측정 수)."""
    return win.where(a, mention_family(ms), b) + scope_where(ms, a, b) + [mention_population(ms, a)]


def round1(x: float) -> float:
    """현행 overview-card-values.ts round1 과 같은 반올림(0.05 경계 부동소수 보정)."""
    return round(x + (1e-9 if x >= 0 else -1e-9), 1)
