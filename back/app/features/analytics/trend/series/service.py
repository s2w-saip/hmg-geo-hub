"""analytics.trend.series 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

규칙(T-1 명세 metrics_rules, 결정 Q9·Q18)
- 창: from/to 가 있으면 그 기간(D1: round_date 가 기간 안인 모든 완료 측정). 없으면 기본 창 = 최근 12 버킷(회차 12자리·주 12·월 12, Q9)
  = core.cycles.resolve_recent_window(n=12, bucket).
- 현행 프로필 trend_grid(WU-6, 제품 결정 19·25, 현행 X.trendGrid): bucket=cycle ∧ global·website 면 창·자리를 core.cycles.resolve_trend_grid 로
  바꾼다. 자리 = 원장 round_date 최신 13개(기간이 있으면 그 안에서 13개, 끝쪽 미발행 절단), 미발행 자리 = 갭 hidden, 수집 오류 숨김뿐인 자리 =
  갭 collection_error, 값 = 자리(웹사이트는 (프로젝트, 자리)) 대표 회차 하나(계열별), 글로벌 완결성 0.9 미만 자리 = 갭 collection_error,
  수집 오류 인용 숨김 회차가 있는 자리 = 인용 계열 갭 collection_error(⑥ citation_accuracy 는 제외). 그 밖 버킷·표면은 아래 새 정의 그대로.
- 원장 자리(R11): 창 안 rd.cycle 회차. 운영자가 전체 숨김(hidden_scope 1, 사유 operator)한 회차는 자리가 아니고,
  수집 오류로 숨긴 회차(사유 collection_error)는 갭 자리로 남긴다(core CycleRow.is_slot·hidden_reason). 자리 없는 주·월은 버킷을 만들지 않는다.
- 계열별 숨김(R04·Q18): 언급 계열(M01~M04) = hidden {1,3}, 인용 계열(M05~M07, M09·M10) = hidden {1,2}(core.codes.HIDDEN_EXCLUDE).
  버킷의 자리가 그 계열에서 전부 빠지면 그 계열 지점은 gap(hidden 또는 collection_error).
- 자리 있는 버킷의 데이터 유무(no_answer)는 계열마다 그 계열 모수로 판정한다(검증 D1): 언급 계열 = 언급 계열 회차의 답변 수(gap_base),
  인용 계열 = 인용 계열 회차의 cit_in 답변 수. 언급만 숨긴 회차(hidden_scope 3)의 인용 지점이 no_answer 로 비지 않는다.
- source[](T-1 명세 filters.supported: 인용 구성 계열에만 적용): M05·M09·M10 을 선택 카테고리 출처의 인용으로 좁힌다(분자·분모 모두).
  core MeasureScope.source_category_keys(유효 카테고리 = 운영자 오버라이드 우선)라 M05 는 core 가 원소 스캔으로, M09·M10 은
  queries.mix_counts_sql 이 같은 술어(core citation_where)로 센다. 언급 계열·M06·M07 에는 적용하지 않고, 요청에 적용 대상 계열이 하나도 없으면 meta.ignored_filters 에
  source 를 싣는다. surface=global 의 project_id 는 core 가 ignored_filters 에 싣는다.
- 값: 카드와 같은 빌더(core.measure.fetch_counts, D6)라 카드 = 버킷 합. 비율은 정수 쌍, M04 는 순위 합·순위 있는 답변 수.
- 웹사이트 M06·M07(R09·A5): 차원 none·기본 엔진이면 core.measure.url_rates(by_round) 로 회차별 발행값/라이브 값과 origin.
  bucket=cycle 은 회차마다. 주·월 버킷(fe-u4 요청 3, core 9라운드)은 **그 버킷의 인용 계열 회차가 하나일 때만** 그 회차의 값(발행이면
  report)을 쓰고, 둘 이상이면 라이브(버킷 누적). 현행 front 에는 접는 규칙이 없다(웹사이트 추이는 M06·M07 을 그리지 않는다:
  live-trend-chart.tsx:39-46 TREND_SERIES, trend-kpi-family.ts:26-27 '추이에는 싣지 않지만'). 그래서 카드의 현행 규칙
  truth-axes.ts:95-101('발행물은 회차 두 점뿐이다. 하루짜리(from === to)만 회차로 읽을 수 있고, 구간은 어느 회차의 값인지 정의되지 않는다')을 버킷에 옮겼다.
  웹사이트 회차는 주 1회(금요일, server.ts:4843)라 주 버킷은 보통 회차 하나 = 회차 버킷과 같은 값이다. 엔진 분리는 라이브만.
- 인용 정확도 citation_accuracy(website·project, 요청할 때만, WU-9 표시 정합): 현행 웹사이트 추이의 ⑥ 선(website/_data/live.ts:246-272
  fetchWebsiteCitationAccuracyTrend, 세부층 summary-website-aggregates.ts:1570-1650 = 회차별 타겟∧자사 답변 ÷ 자사 URL 인용 답변, 항상 라이브)을
  같은 빌더의 버킷 값으로 낸다: (tgt_own_hits, own_url_hits)(core.measure.ratios, K-1 카드 citation_accuracy 와 같은 쌍). R09 발행값·origin 을
  쓰지 않는다(현행 ⑥ 은 발행물을 읽지 않는다). 기본 지표 목록에는 넣지 않는다(기존 요청의 응답 불변).
- 차원: engine = 지표 × 엔진(시리즈 키 = 엔진 코드, Q9), brand = 당사 + 경쟁 상위 top(core.measure.brand_rows, M-1 경쟁 규칙),
  source·category = 인용 출처·카테고리 구성비(queries.mix_counts_sql: core.measure.citation_where 술어의 rd.citation 스캔, 1년 조합 고위험).

값 갭 보강(BG 라운드, 추가형)
- BG-01: 글로벌 지원 축에 lang[] 추가(core 빌더가 답변 언어 축 lang_key 를 걸고, 글로벌 M05 는 언어로 좁힌 자사 허용 배열이면 원소 스캔).
- BG-07 dimension=type(M08 type_exposure): 버킷 × 유형 5종, 분자 = 그 유형 신호가 있는 당사 답변(queries.type_counts_sql, M-2 당사 행 술어),
  분모 = 버킷 답변(fetch_counts answers, M01 분모와 같다). 갭 규칙은 언급 계열과 같다.
- BG-09: sentiment(M03) 지점에 부정 신호 수(negative). 당사 = rd.answer sent_neg_x(fetch_counts sent_neg), 경쟁 = rd.answer_brand s_neg.
- BG-10: 버킷 measured_days = queries.measured_days_sql(버킷 답변 cit_in 의 rd.job.measured_at KST 고유 일수). 자리 없는·숨김 회차는 0.
  성능 A1: 쿼리 measured_days=false(with_measured_days=False)면 문장을 돌리지 않고 모든 버킷 null.
- BG-11 brand_key[](dimension=brand): 상위 top 밖 경쟁 브랜드 계열을 더한다(창에 언급이 없으면 0 지점). 모르는 키·관점 브랜드 키는
  meta.dropped_filters.brand_key. 경쟁 계열에 brand_key 를 싣는다.
- BG-48: own_label = GET /v1/mentions/brands own.vp_label 과 같은 규칙(관점 하나 = brand_code, 여럿 = 엄브렐러 brand_code).
- D13 split_own(dimension=brand): 관점 비트가 둘 이상이면 core.measure.split_own_scopes 로 비트별 당사 계열(key = own_brand_code,
  brand_key = 같은 이름의 rd.dim_brand_name 키: mentions/brands 당사 행과 같은 조회 규칙, 검증 V1).
  분모·갭 판정은 관점 전체(합친 계열과 같다). 관점이 하나면 기존 합친 'own' 계열.
- BG-11 비경쟁 브랜드(검증 V2): dim_brand_name.kind 3 이고 창에 competitive 행이 없는 요청 키는 dropped_filters.brand_key.
- 명부 제외(동기화 S1 BE-5, 현행 hmg-geo 2670a16 excluded-brands.ts filterBrandTrend·filterFirstPosition, 키 = core.entities): dimension=brand
  경쟁 계열 선정에서 제외 키 행을 top 앞에서 뺀다(다음 순위가 채운다 = 현행 server.ts:3364·:3484 캡 + 제외 수 → recapBrands). 요청
  brand_key[] 의 제외 키는 dropped_filters.brand_key. 분모·당사 계열·남은 경쟁 계열 값은 그대로(KPI 값 불변).

성능 P12(기본 응답 불변, 값 동치는 tests/test_trend_bg.py p12 시험)
- B100 dimension=brand: split_own 이면 base(mentions·gap)와 비트별 당사 합계를 rd.answer 한 문장으로(brand_split_counts, 요청 지표 열만),
  경쟁 행은 순위 후보(top) ∪ 요청 brand_key[] 브랜드만 앱으로 받는다(competitor_rows, 동결 개명 창은 core brand_rows 그대로).
- B102 웹사이트 M06·M07(R09, bucket=cycle): url_rates 에 main 문장 결과(live, urls part)를 넘겨 같은 창 재집계 문장을 없앤다.
- B101 dims(선택): 'dimension[:metric,…][@top]' 항목마다 그 차원 단일 요청과 같은 계열·meta 를 data.dims[] 에 함께 낸다. 창·measured_days 는
  요청 하나에서 한 번, (버킷) base 행·인용 계열 자리 유무·source·category 구성비 문장(per)은 차원 사이에 나눠 쓴다(_Shared). 생략 = 종전.
"""
from __future__ import annotations

import re
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from datetime import date
from typing import Any

from app.core import errors
from app.core.auth import Principal
from app.core.codes import HIDDEN_REASON
from app.core.cycles import GRID_RULES, CycleRow, TrendGrid, Window, bucket_start, frz_eligible, resolve_recent_window, resolve_trend_grid
from app.core.db import fetch_all
from app.core.entities import excluded_brand_keys
from app.core.envelope import SUPPRESS_HIDDEN, SUPPRESS_NO_SNAPSHOT, Envelope, Meta, RankAvg, Ratio, build_meta
from app.core.filters import KPI_SUPPORT, CommonFilters, FilterSupport, ReadContext, resolve_read_context
from app.core.measure import (
    accuracy_counts,
    accuracy_mode,
    brand_rows,
    fetch_counts,
    frozen_brand_names,
    lc_key,
    legacy_accuracy,
    rank_brand_items,
    ratios,
    renamed_brand_keys,
    split_own_label,
    split_own_scopes,
    url_rates,
)
from app.core.profile import LegacyProfile, active_profile

from . import queries as q
from .schemas import TrendBucket, TrendData, TrendDimBlock, TrendPoint, TrendSeries

DEFAULT_WINDOW = 12                       # Q9: 회차 12자리·주 12·월 12
DEFAULT_TOP = 10
BUCKET_GROUP = {"cycle": "round_date", "week": "week", "month": "month"}    # core.measure.GROUPS 이름 = 결과 열 이름
GROUP_COL = {"round_date": "round_date", "week": "week", "month": "month", "engine": "engine_key"}   # group_by 이름 → 결과 열
# T-1 지원 축 = 대시보드 지표 공통(KPI_SUPPORT) + source[](명세 filters.supported, 인용 구성 계열 전용). 엔드포인트별 지원 축 선언은
# 기능 소유(계약 §4 규칙 2)라 core 에 T-1 전용 상수를 두지 않는다.
# BG-01: 글로벌 lang[] 추가(core KPI_SUPPORT 는 다른 기능이 공유하므로 이 기능 선언에만 더한다).
TREND_SUPPORT = FilterSupport(global_=KPI_SUPPORT.global_ | {"source", "lang"}, website=KPI_SUPPORT.website | {"source"},
                              project=KPI_SUPPORT.project | {"source"})
SOURCE_METRICS = ("M05", "M09", "M10")    # source[] 가 좁히는 계열(인용 출처 단위로 셀 수 있는 것)

# 지표 정의: 코드 → (응답 이름, 계열, 값 종류). 응답 이름은 core.measure.ratios 키와 같다.
@dataclass(frozen=True)
class MetricDef:
    code: str
    name: str
    family: str       # mentions | citations
    kind: str         # ratio | rank


METRICS: tuple[MetricDef, ...] = (
    MetricDef("M01", "visibility", "mentions", "ratio"),
    MetricDef("M02", "share_of_voice", "mentions", "ratio"),
    MetricDef("M03", "sentiment", "mentions", "ratio"),
    MetricDef("M04", "position", "mentions", "rank"),
    MetricDef("M05", "citation_share", "citations", "ratio"),
    MetricDef("M06", "target_url_rate", "citations", "ratio"),
    MetricDef("M07", "owned_url_rate", "citations", "ratio"),
    MetricDef("ACC", "citation_accuracy", "citations", "ratio"),      # 요청할 때만(OPT_IN_METRICS), 현행 ⑥ 인용 정확도 선
)
BY_CODE = {m.code: m for m in METRICS}
BY_NAME = {m.name: m for m in METRICS}
ALIASES = {"exposure_rate": "M01", "sov": "M02", "favorability": "M03", "avg_position": "M04", "own_url_rate": "M07"}
SURFACE_METRICS = {"global": ("M01", "M02", "M03", "M04", "M05"),
                   "website": ("M01", "M02", "M03", "M04", "M05", "M06", "M07"),
                   "project": ("M01", "M02", "M03", "M04", "M05", "M06", "M07")}   # Q5: project 도 M06·M07 채움
OPT_IN_METRICS = {"global": (), "website": ("ACC",), "project": ("ACC",)}   # 기본 목록 밖, 요청하면 받는다(기존 요청 응답 불변)
BRAND_METRICS = ("M01", "M02", "M03", "M04")      # 경쟁 브랜드 행에는 인용 계열이 없다(M-1)
MIX_DEF = {"source": MetricDef("M09", "source_share", "citations", "ratio"),
           "category": MetricDef("M10", "category_share", "citations", "ratio")}
TYPE_DEF = MetricDef("M08", "type_exposure", "mentions", "ratio")      # BG-07 dimension=type
BRAND_ONLY = "dimension=brand 전용"
# B101 dims 항목 'dimension[:metric,…][@top]'. brand 는 기본 dimension 으로만(brand_key·split_own·dropped_filters 가 기본 차원 전용)
DIMS_ITEM = re.compile(r"^(none|engine|type|source|category)(?::([A-Za-z0-9_,]+))?(?:@([0-9]{1,2}))?$")
DIM_ORDER = ("none", "engine", "brand", "type", "source", "category")    # 계산 순서: (버킷) base 를 만드는 차원 먼저, 구성비는 끝(공유)


# ════════════════════════════════════════════════════════════════════════════
# 입력 해석
# ════════════════════════════════════════════════════════════════════════════
def parse_metrics(raw: Sequence[str], surface: str, dimension: str) -> tuple[MetricDef, ...]:
    """?metrics=M01,M02 또는 반복(?metrics=M01&metrics=sov). 알 수 없는 값·표면/차원이 지원하지 않는 값은 422."""
    tokens = [t.strip() for r in raw for t in r.split(",") if t.strip()]
    if dimension == "type":
        bad = [t for t in tokens if t.upper() != TYPE_DEF.code and t.lower() != TYPE_DEF.name]
        if bad:
            raise errors.unprocessable("dimension=type 은 M08(type_exposure)만 받는다", code="metric_not_supported",
                                       details={"metrics": bad, "allowed": [TYPE_DEF.code]})
        return (TYPE_DEF,)
    if dimension in MIX_DEF:
        if tokens:
            raise errors.unprocessable("dimension=source·category 는 metrics 를 받지 않는다(구성비 한 계열)",
                                       code="metric_not_supported", details={"metrics": tokens})
        return (MIX_DEF[dimension],)
    allowed = SURFACE_METRICS[surface] if dimension != "brand" else tuple(c for c in BRAND_METRICS if c in SURFACE_METRICS[surface])
    if not tokens:
        return tuple(BY_CODE[c] for c in (("M02",) if dimension == "brand" else allowed))
    if dimension != "brand":
        allowed = allowed + OPT_IN_METRICS[surface]
    out: list[MetricDef] = []
    unknown: list[str] = []
    unsupported: list[str] = []
    for t in tokens:
        code = t.upper() if t.upper() in BY_CODE else ALIASES.get(t.lower()) or (BY_NAME[t.lower()].code if t.lower() in BY_NAME else None)
        if code is None:
            unknown.append(t)
        elif code not in allowed:
            unsupported.append(t)
        elif BY_CODE[code] not in out:
            out.append(BY_CODE[code])
    if unknown:
        raise errors.unprocessable("알 수 없는 지표", code="unknown_metric", details={"metrics": unknown})
    if unsupported:
        raise errors.unprocessable("이 표면·차원이 지원하지 않는 지표", code="metric_not_supported",
                                   details={"metrics": unsupported, "allowed": list(allowed)})
    return tuple(out)


@dataclass(frozen=True)
class DimSpec:
    """B101 dims 항목 하나: 그 차원 단일 요청(dimension·metrics·top)과 같은 계열을 낸다."""
    dimension: str
    mdefs: tuple[MetricDef, ...]
    top: int


def parse_dims(raw: Sequence[str], surface: str, primary: str, top: int) -> list[DimSpec]:
    """?dims=engine:visibility,share_of_voice&dims=type&dims=category@13(반복). 항목 = 'dimension[:metric,…][@top]': metrics 생략 = 그 차원
    기본 세트(parse_metrics 규칙 그대로), top 생략 = 요청 top. 형식 오류·brand·기본 dimension 또는 항목끼리 중복·top 범위(1~50) 밖 = 422."""
    out: list[DimSpec] = []
    seen = {primary}
    for item in raw:
        m = DIMS_ITEM.match(item.strip())
        if m is None:
            raise errors.unprocessable("dims 항목 형식: dimension[:metric,…][@top] (dimension = none|engine|type|source|category)",
                                       details={"field": "dims", "value": item})
        dim, mets, t = m.group(1), m.group(2), m.group(3)
        if dim in seen:
            raise errors.unprocessable("dims 차원 중복(기본 dimension 포함)", details={"field": "dims", "value": item})
        seen.add(dim)
        n = int(t) if t is not None else top
        if not 1 <= n <= 50:
            raise errors.unprocessable("dims top 범위: 1~50", details={"field": "dims", "value": item})
        out.append(DimSpec(dim, parse_metrics([mets] if mets else [], surface, dim), n))
    return out


def bucket_key(d: date, bucket: str) -> date:
    """core.measure GROUPS 의 week(date_trunc 'week' = ISO 월요일)·month(1일)와 같은 규칙(core.cycles.bucket_start)."""
    return bucket_start(d, bucket)


def own_label(ctx: ReadContext) -> str:
    """BG-48: GET /v1/mentions/brands own.vp_label 과 같은 규칙(mentions.brands.common.viewpoint_label). 관점 브랜드가 하나면 그 brand_code,
    둘 이상이면 엄브렐러 brand_code(app.brand, 리터럴 금지). 엄브렐러가 없으면 '+' 연결."""
    if len(ctx.own_brands) == 1:
        return ctx.own_brands[0]
    return ctx.refs.brand_code_of_bit(ctx.refs.umbrella_bit) or "+".join(ctx.own_brands)


# ════════════════════════════════════════════════════════════════════════════
# 원장 자리(R11)
# ════════════════════════════════════════════════════════════════════════════
@dataclass
class Slot:
    key: date
    rows: list[CycleRow] = field(default_factory=list)
    gaps: dict[str, str] | None = None     # 현행 추이 격자(프로필 trend_grid): 계열(mentions·citations·accuracy) → 갭 사유. None = 새 정의

    @property
    def round_dates(self) -> list[date]:
        return sorted({r.round_date for r in self.rows})


def build_slots(win: Window, bucket: str) -> list[Slot]:
    """창 회차를 버킷 자리로 묶는다(core CycleRow.is_slot: 운영자 전체 숨김은 자리가 아니고, 수집 오류 전체 숨김은 갭 자리)."""
    by: dict[date, Slot] = {}
    for r in win.cycles:
        if r.is_slot:
            k = bucket_key(r.round_date, bucket)
            by.setdefault(k, Slot(k)).rows.append(r)
    return [by[k] for k in sorted(by)]


def grid_slots_of(grid: TrendGrid) -> list[Slot]:
    """현행 추이 격자(core.cycles.resolve_trend_grid) → 버킷 자리. 키 = round_date(bucket=cycle), 계열 갭 = core 판정."""
    return [Slot(p.slot.round_date, [c.row() for c in p.slot.cycles], dict(p.gaps)) for p in grid.picks]


async def trend_window(conn: Any, ctx: ReadContext, bucket: str, *, today: date | None = None) -> Window:
    """기간 지정이면 그 창, 아니면 최근 12 버킷 창(Q9, core.cycles.resolve_recent_window)."""
    if ctx.date_from is not None:
        return await ctx.window(conn, today=today)
    return await resolve_recent_window(conn, surface=ctx.surface, project_keys=ctx.project_keys, n=DEFAULT_WINDOW, bucket=bucket,  # type: ignore[arg-type]
                                       today=today, project_ids=ctx.project_ids, profile=active_profile(), card=ctx.card)


def single_round(slot: Slot, win: Window, family: str) -> date | None:
    """버킷의 그 계열 회차(round_date)가 정확히 하나면 그 날짜, 아니면 None(주·월 버킷 R09 접기: 회차 하나 = 그 회차의 값)."""
    keys = set(win.cyc_keys(family))
    rds = {r.round_date for r in slot.rows if r.cyc_key in keys}
    return next(iter(rds)) if len(rds) == 1 else None


def family_gap(slot: Slot, win: Window, family: str) -> str | None:
    """버킷의 자리가 이 계열에서 전부 빠졌으면 사유(collection_error 우선, 그 밖 hidden). 아니면 None.
    격자 자리(slot.gaps, 프로필 trend_grid)면 core 판정(core.cycles.pick_slot)을 그대로 쓴다. accuracy 는 격자 자리에서만 쓰는 키."""
    if slot.gaps is not None:
        return slot.gaps.get(family)
    keys = set(win.cyc_keys(family))
    if any(r.cyc_key in keys for r in slot.rows):
        return None
    return "collection_error" if any(r.hidden_reason == HIDDEN_REASON["collection_error"] for r in slot.rows) else SUPPRESS_HIDDEN


# ════════════════════════════════════════════════════════════════════════════
# 지점 조립
# ════════════════════════════════════════════════════════════════════════════
def _presence(md: MetricDef, row: dict[str, Any] | None, cit_present: bool = False) -> str | None:
    """자리 있는 버킷의 데이터 유무(계열별 모수, 검증 D1).
    언급 계열: 언급 계열 회차의 완료 답변 0(gap_base) = no_answer, 분석된 답변 0 = analysis_pending.
    인용 계열: 인용 계열 회차의 cit_in 답변 0 = no_answer(cit_present 는 citation_presence 결과). row 의 gap_base 는 split 모드에서
    언급 계열 회차만 세므로 인용 계열 판정에 쓰지 않는다."""
    if md.family == "citations":
        return None if cit_present else "no_answer"
    if row is None or int(row.get("gap_base") or 0) == 0:
        return "no_answer"
    if int(row.get("answers") or 0) == 0:
        return "analysis_pending"
    return None


async def citation_presence(conn: Any, ctx: ReadContext, win: Window, group_by: tuple[str, ...],
                            idx: dict[tuple[Any, ...], dict[str, Any]] | None) -> set[tuple[Any, ...]]:
    """인용 계열 모수(인용 계열 회차 키 ∧ cit_in) 답변이 1건 이상인 그룹 키 집합. 키 모양 = group_by 결과 열 순서.
    두 계열 회차 키가 같으면 fetch_counts(gap) 의 gap_base 가 곧 인용 계열 모수라 추가 문장이 없다. 다르면(계열별 숨김 회차가 창에 있음)
    core.measure.fetch_counts(parts=('urls',)) 한 문장으로 센다: 인용 계열만 요청하면 core 가 WHERE 를 인용 계열 회차 키로 건다."""
    cols = tuple(GROUP_COL[g] for g in group_by)
    if idx is not None and win.cyc_keys("mentions") == win.cyc_keys("citations"):
        return {k for k, r in idx.items() if int(r.get("gap_base") or 0) > 0}
    rows = await fetch_counts(conn, ctx.measure(), win, group_by=group_by, parts=("urls",))
    return {tuple(r.get(c) for c in cols) for r in rows}


def make_point(md: MetricDef, slot: Slot, hidden: str | None, presence: str | None, pair: tuple[int, int] | None,
               origin: str | None = None, negative: int | None = None) -> TrendPoint:
    """negative(BG-09)는 sentiment(M03) 지점에만 싣는다(갭이면 null)."""
    reason = hidden or presence
    if reason is not None:
        return TrendPoint(bucket=slot.key, gap=True, gap_reason=reason)  # type: ignore[arg-type]
    num, den = pair if pair is not None else (0, 0)
    if md.kind == "rank":
        return TrendPoint(bucket=slot.key, rank=RankAvg(sum=int(num), count=int(den)) if den else None, origin=origin)  # type: ignore[arg-type]
    neg = int(negative or 0) if md.code == "M03" else None
    return TrendPoint(bucket=slot.key, ratio=Ratio(num=int(num), den=int(den)) if den else None, origin=origin,  # type: ignore[arg-type]
                      negative=neg)


def _neg(row: dict[str, Any] | None, col: str = "sent_neg") -> int:
    return int((row or {}).get(col) or 0)


def _rows_by(rows: Sequence[dict[str, Any]], *cols: str) -> dict[tuple[Any, ...], dict[str, Any]]:
    return {tuple(r.get(c) for c in cols): r for r in rows}


@dataclass
class _Shared:
    """B101 dims 요청 한 번 안에서 차원 사이에 나눠 쓰는 결과(같은 ctx·창·버킷). 단일 차원 요청은 만들지 않는다(종전 경로 그대로).
    base: (버킷) group_by fetch_counts 결과(parts ⊇ mentions·gap, dimension none·brand·type 이 만든다). type 의 base 와 구성비의 인용 계열
          자리 유무(두 계열 회차 키가 같을 때 gap_base, citation_presence 규칙)로 다시 쓴다. 언급·gap 열은 parts 가 더 많아도(인용 계열은
          FILTER 로 분리) 같은 값이고, 인용 계열 회차에만 있는 버킷 행(answers·gap_base 0)은 행이 없을 때와 같은 지점을 만든다.
          brand split_own 경로의 행은 answers·total_mentions·gap_base·gap_answers 만 있다(쓰는 쪽도 그 열만 읽는다).
    presence: (버킷) 인용 계열 자리 유무(citation_presence 결과). mix: source·category 를 함께 요청했을 때 queries.mix_pair_sql 결과."""
    base: list[dict[str, Any]] | None = None
    presence: set[tuple[Any, ...]] | None = None
    mix: list[dict[str, Any]] | None = None


async def _bucket_presence(conn: Any, ctx: ReadContext, win: Window, g: str, shared: _Shared | None) -> set[tuple[Any, ...]]:
    """(버킷) 인용 계열 자리 유무. dims 요청이면 한 번 세어 나눠 쓰고, 같은 요청의 (버킷) base 가 있으면 citation_presence 가 그 gap_base 로
    문장 없이 낸다(두 계열 회차 키가 같을 때)."""
    if shared is None:
        return await citation_presence(conn, ctx, win, (g,), None)
    if shared.presence is None:
        shared.presence = await citation_presence(conn, ctx, win, (g,), _rows_by(shared.base, g) if shared.base is not None else None)
    return shared.presence


# ════════════════════════════════════════════════════════════════════════════
# 차원별 시리즈
# ════════════════════════════════════════════════════════════════════════════
async def _series_plain(conn: Any, ctx: ReadContext, win: Window, slots: list[Slot], bucket: str,
                        mdefs: tuple[MetricDef, ...], dimension: str, *, shared: _Shared | None = None) -> list[TrendSeries]:
    """dimension none·engine: 지표 × (엔진)."""
    ms = ctx.measure()
    g = BUCKET_GROUP[bucket]
    url_metrics = [m for m in mdefs if m.code in ("M06", "M07")]
    acc = any(m.code == "ACC" for m in mdefs)       # 인용 정확도: 항상 버킷 라이브(urls part 의 tgt_own_hits·own_url_hits)
    use_r09 = bool(url_metrics) and ctx.surface == "website" and ctx.engine_keys is None and dimension == "none"
    fold_r09 = use_r09 and bucket != "cycle"         # 주·월: 인용 계열 회차가 하나인 버킷만 그 회차의 R09 값(아니면 버킷 라이브)
    m05 = any(m.code == "M05" for m in mdefs)
    parts = ["mentions", "gap"]
    if m05:
        parts.append("citations")          # source[] 가 있으면 core 가 원소 스캔(선택 카테고리 출처 인용만, 분자·분모 모두)
    # urls part: 버킷 라이브 M06·M07(R09 를 안 쓰거나 주·월 접기)·인용 정확도, 그리고 B102: R09 회차 버킷(bucket=cycle)도 같은 main 문장에서
    # 세어 url_rates 에 live 로 넘긴다(url_rates 가 같은 창 urls 를 다시 세던 문장 생략, 값은 같은 술어·같은 FILTER)
    if url_metrics or acc:
        parts.append("urls")
    group_by: tuple[str, ...] = (g, "engine") if dimension == "engine" else (g,)
    rows = await fetch_counts(conn, ms, win, group_by=group_by, parts=parts)
    idx = _rows_by(rows, BUCKET_GROUP[bucket], *(("engine_key",) if dimension == "engine" else ()))
    if shared is not None and dimension == "none":
        shared.base = rows
    cit_seen: set[tuple[Any, ...]] = set()
    if any(m.family == "citations" for m in mdefs):
        cit_seen = await citation_presence(conn, ctx, win, group_by, idx)
        if shared is not None and dimension == "none":
            shared.presence = cit_seen
    # 현행 ⑥(web_accuracy_flat, WU-12): 카드 추이 = 집계층 유닛 flat 타겟(summaryWebsiteCitationAccuracyTrend), 비카드 = 미러 정의.
    # 같은 창·같은 버킷 키로 따로 세어 ACC 점만 바꾼다(M07 등 urls part 의 다른 값은 그대로)
    acc_idx: dict[tuple[Any, ...], dict[str, Any]] | None = None
    if acc and legacy_accuracy(ms):
        acc_rows = await accuracy_counts(conn, ms, win, mode=accuracy_mode(ctx.card, False), group_by=group_by)
        acc_idx = _rows_by(acc_rows, BUCKET_GROUP[bucket], *(("engine_key",) if dimension == "engine" else ()))
    rates: dict[Any, dict[str, Any]] = {}
    if use_r09:
        # bucket=cycle 이면 main 결과가 곧 회차(round_date)별 라이브 urls 다(B102). 주·월은 버킷 키가 회차가 아니라 url_rates 가 회차별로 센다
        rates = await url_rates(conn, ms, win, brands=ctx.own_brands, countries=ctx.countries, langs=ctx.langs, by_round=True,
                                live=None if fold_r09 else rows, req=ctx.r09)
    url_origin = "live" if ctx.surface == "website" else None

    if dimension == "engine":
        code_of = {k: c for c, (k, _) in ctx.refs.engines.items()}
        engine_keys = list(ctx.engine_keys) if ctx.engine_keys is not None else \
            sorted(k for _, (k, d) in ctx.refs.engines.items() if d)
        dims: list[tuple[Any, str | None]] = [(k, code_of.get(k)) for k in engine_keys]
    else:
        dims = [(None, None)]

    out: list[TrendSeries] = []
    for md in mdefs:
        for dkey, dcode in dims:
            pts = []
            for s in slots:
                gk = (s.key, dkey) if dimension == "engine" else (s.key,)
                row = idx.get(gk)
                hidden = family_gap(s, win, "accuracy" if md.code == "ACC" and s.gaps is not None else md.family)
                presence = _presence(md, row, gk in cit_seen)
                origin = None
                if md.code in ("M06", "M07"):
                    one = single_round(s, win, "citations") if fold_r09 else None
                    if fold_r09 and not (one is not None and (rates.get(one) or {}).get("origin") == "report"):
                        pair = ratios(row).get(md.name) if row else None       # 버킷 라이브(회차 둘 이상이거나 그 회차 발행값 없음)
                        origin = url_origin
                    elif use_r09:
                        rv = rates.get(one if fold_r09 else s.key)
                        pair = rv["target" if md.code == "M06" else "owned"] if rv else None
                        origin = rv["origin"] if rv else None
                        if origin == "report":          # 발행값은 발행 원장이 근거라 라이브 답변 유무와 무관(R09)
                            presence = None
                    else:
                        pair = ratios(row).get(md.name) if row else None
                        origin = url_origin
                elif md.code == "ACC" and acc_idx is not None:
                    ar = acc_idx.get(gk)
                    pair = (int(ar["tgt_own_hits"] or 0), int(ar["own_url_hits"] or 0)) if ar else ((0, 0) if row else None)
                else:
                    pair = ratios(row).get(md.name) if row else None
                pts.append(make_point(md, s, hidden, presence, pair, origin, negative=_neg(row)))
            out.append(TrendSeries(metric=md.name, code=md.code, kind=md.kind, key=dcode,  # type: ignore[arg-type]
                                   points=pts))
    return out


@dataclass(frozen=True)
class OwnPart:
    """dimension=brand 당사 계열 하나: 합친 'own'(own_brand_code·brand_key None) 또는 split_own 관점 브랜드별
    (key = own_brand_code, brand_key = 그 brand_code 와 같은 이름의 rd.dim_brand_name 키, 검증 V1)."""
    key: str
    label: str
    own_brand_code: str | None
    idx: dict[tuple[Any, ...], dict[str, Any]]
    brand_key: int | None = None


async def _own_parts(conn: Any, ctx: ReadContext, win: Window, g: str, label: str, idx: dict[tuple[Any, ...], dict[str, Any]],
                     split_own: bool) -> list[OwnPart]:
    """D13: split_own 이고 관점 비트가 둘 이상이면 core.measure.split_own_scopes(비트 오름차순)로 비트별 당사 값, 아니면 합친 1행.
    분리 행에는 brand_key 를 싣는다(검증 V1): GET /v1/mentions/brands 당사 행과 같은 규칙(이름 = 관점 brand_code)이라 두 그룹의
    관점 브랜드 행을 brand_key 로 잇는다. 이름이 차원에 없으면 null(행 키는 own_brand_code 로 유일하다).
    P12 B100: _series_brand 의 분리 경로는 base 와 비트별 합계를 한 문장(brand_split_counts)으로 세어 같은 규칙으로 계열을 만들고, 이 함수는
    분리 없는 경우(합친 1행)에 쓴다. 분리 분기는 같은 값의 단독 경로(A3 split_counts)로 남긴다(동치 시험의 바꿔 끼우기 자리)."""
    ms = ctx.measure()
    splits = split_own_scopes(ms) if split_own else ()
    if not splits:
        return [OwnPart("own", label, None, idx)]
    codes = [split_own_label(ctx.refs, bit) for bit, _ in splits]
    keys = {str(r["name"]): int(r["brand_key"]) for r in await fetch_all(conn, q.OWN_BRAND_KEYS_SQL, {"names": codes})}
    per_bit = await split_counts(conn, ms, win, g, [bit for bit, _ in splits])
    return [OwnPart(code, code, code, _rows_by(rows, g), keys.get(code)) for code, rows in zip(codes, per_bit, strict=True)]


async def split_counts(conn: Any, ms: Any, win: Window, g: str, bits: Sequence[int]) -> list[list[dict[str, Any]]]:
    """A3: 비트별 fetch_counts(split_own_scopes 스코프, group_by=(g,), parts=('mentions',)) 결과와 같은 행 목록을 rd.answer 한 문장
    (queries.own_split_counts_sql)으로. 행 = 그룹 키 오름차순, 값은 int(merge_counts 와 같은 정규화). 빈 창이면 문장 없이 빈 목록."""
    if win.empty:
        return [[] for _ in bits]
    sq = q.own_split_counts_sql(ms, win, g, bits)
    rows = sorted(await fetch_all(conn, sq.text, sq.params), key=lambda r: (r[g] is None, r[g]))
    shared = ("answers", "total_mentions")
    return [[{g: r[g], **{k: int(r[k] or 0) for k in shared}, **{k: int(r[f"{k}{i}"] or 0) for k in q.SPLIT_KEYS}} for r in rows]
            for i in range(len(bits))]


async def brand_split_counts(conn: Any, ms: Any, win: Window, g: str, bits: Sequence[int],
                             mdefs: Sequence[MetricDef]) -> tuple[list[dict[str, Any]], list[list[dict[str, Any]]]]:
    """B100: dimension=brand split_own 의 (base, 비트별 당사 합계)를 rd.answer 한 문장(queries.own_split_counts_sql base=True)으로.
    base 행 = fetch_counts(group_by=(g,), parts=('mentions','gap')) 중 _series_brand 가 읽는 answers·total_mentions·gap_base·gap_answers
    (같은 WHERE·같은 식), 비트별 행 = split_counts 와 같은 모양. 비트 열은 요청 지표(mdefs)가 읽는 것만 세고 나머지는 0(그 지표 지점을
    만들지 않는다). 빈 창이면 문장 없이 빈 목록."""
    if win.empty:
        return [], [[] for _ in bits]
    keys = {k for m in mdefs for k in q.SPLIT_KEYS_BY_METRIC.get(m.code, ())}
    sq = q.own_split_counts_sql(ms, win, g, bits, base=True, keys=keys)
    rows = sorted(await fetch_all(conn, sq.text, sq.params), key=lambda r: (r[g] is None, r[g]))
    base = [{g: r[g], **{k: int(r[k] or 0) for k in ("answers", "total_mentions", "gap_base", "gap_answers")}} for r in rows]
    shared = ("answers", "total_mentions")
    per_bit = [[{g: r[g], **{k: int(r[k] or 0) for k in shared},
                 **{k: int(r[f"{k}{i}"] or 0) if k in keys else 0 for k in q.SPLIT_KEYS}} for r in rows]
               for i in range(len(bits))]
    return base, per_bit


async def competitor_rows(conn: Any, ms: Any, win: Window, g: str, *, top: int, want: Sequence[int]) -> list[dict[str, Any]]:
    """B100: dimension=brand 경쟁 행 중 순위 후보(top) ∪ 요청 brand_key[] 브랜드의 행만(queries.competitor_candidates_sql). core brand_rows 와
    선정·값이 같다(후보 밖 브랜드는 top 안에 들 수 없다, 쿼리 머리 주석). 창에 동결 개명 키가 있으면(core renamed_brand_keys: 동결 읽기 ∧ 회차 2개
    이상일 때만 문장) 계열 = (키, 세대 이름)이라 core brand_rows 를 그대로 쓴다(그 경우 개명 조회 문장 1 이 더 돈다). G20 노출 단위 미채움
    행이 있으면 core brand_rows 로 다시 읽어 같은 예외를 낸다(오류 경로). 빈 창이면 문장 없이 []."""
    if win.empty:
        return []
    if await renamed_brand_keys(conn, ms, win):
        return await brand_rows(conn, ms, win, group_by=(g,))
    sq = q.competitor_candidates_sql(ms, win, g, top, want)
    rows = await fetch_all(conn, sq.text, sq.params)
    if ms.profile.brand_exposure_per_alias:
        if any(int(r.get("rid_n_missing") or 0) for r in rows):
            return await brand_rows(conn, ms, win, group_by=(g,))
        for r in rows:
            r.pop("rid_n_missing", None)
    return rows


async def _series_brand(conn: Any, ctx: ReadContext, win: Window, slots: list[Slot], bucket: str,
                        mdefs: tuple[MetricDef, ...], top: int, label: str, *, brand_keys: Sequence[int] = (),
                        split_own: bool = False, dropped: dict[str, list[str]] | None = None,
                        shared: _Shared | None = None) -> list[TrendSeries]:
    """dimension brand(M11): 당사 계열(rd.answer 당사 열) + 경쟁 상위 top(core brand_rows: 형제 HMG 브랜드는 경쟁 행에 남는다)
    + BG-11 요청 brand_key[](top 밖 경쟁 브랜드). D13 split_own 이면 당사를 관점 브랜드별 계열로 나눈다(분모·갭은 관점 전체)."""
    ms = ctx.measure()
    g = BUCKET_GROUP[bucket]
    splits = split_own_scopes(ms) if split_own else ()
    if splits:
        # B100: base(mentions·gap)와 비트별 당사 합계를 rd.answer 한 문장으로(같은 WHERE 이중 스캔 제거, 요청 지표 열만)
        rows, per_bit = await brand_split_counts(conn, ms, win, g, [bit for bit, _ in splits], mdefs)
        idx = _rows_by(rows, g)
        codes = [split_own_label(ctx.refs, bit) for bit, _ in splits]
        okeys = {str(r["name"]): int(r["brand_key"]) for r in await fetch_all(conn, q.OWN_BRAND_KEYS_SQL, {"names": codes})}
        owns = [OwnPart(code, code, code, _rows_by(prow, g), okeys.get(code)) for code, prow in zip(codes, per_bit, strict=True)]
    else:
        rows = await fetch_counts(conn, ms, win, group_by=(g,), parts=("mentions", "gap"))
        idx = _rows_by(rows, g)
        owns = await _own_parts(conn, ctx, win, g, label, idx, split_own)
    if shared is not None:
        shared.base = rows
    want = list(dict.fromkeys(int(k) for k in brand_keys))
    comp = [r for r in await competitor_rows(conn, ms, win, g, top=top, want=want) if int(r["brand_key"]) != 0]
    # 명부 제외(BE-5): 제외 키 경쟁 행은 순위·top 선정 전에 뺀다(다음 순위가 채운다, 현행 filterBrandTrend·filterFirstPosition +
    # server.ts:3364·:3484 캡 여유). 분모(base = fetch_counts)와 남은 계열 값은 그대로. 경쟁 행은 관점 비트 밖이라 자사 계열은 무관.
    excluded = await excluded_brand_keys(conn) if comp or want else frozenset()
    comp = [r for r in comp if int(r["brand_key"]) not in excluded]
    # 계열 정체 = (브랜드 키, 세대 이름): 동결 읽기에서 개명 브랜드는 core.measure.brand_rows 가 세대 이름별 행(frz_name)으로 나눠 준다(S4b,
    # 현행 추이 브랜드 계열 키 = brand_name). 개명이 없으면 이름은 None 이고 종전과 같다(키 하나 = 계열 하나)
    totals: dict[tuple[int, str | None], int] = defaultdict(int)
    for r in comp:
        totals[(int(r["brand_key"]), r.get("frz_name"))] += int(r["mentions"] or 0)
    info: dict[int, dict[str, Any]] = {}
    lookup = sorted({k for k, _ in totals} | set(want))
    if lookup:
        info = {int(r["brand_key"]): r for r in await fetch_all(conn, q.BRAND_NAMES_SQL, {"keys": lookup})}
    names = {k: str(r["name"]) for k, r in info.items()}
    names.update(await frozen_brand_names(conn, ms, win, list(names)))           # 동결 읽기: 생성 시점 표시명(S4)
    ranked = rank_brand_items([{"brand_key": k, "frz_name": nm, "mentions": v, "name": nm or names.get(k, "")}
                               for (k, nm), v in totals.items()])
    chosen = ranked[:top]
    # BG-11: 요청 키 중 경쟁 브랜드(관점 비트 밖)만 더한다. 모르는 키·관점 브랜드 키는 dropped(조용히 무시하지 않는다).
    # 검증 V2: 비경쟁 브랜드(kind 3, 예 Apple)는 창에 competitive 행이 있을 때만(= brand_rows 합계에 있을 때만) 경쟁 계열이 된다.
    # 창에 competitive 행이 없으면 경쟁 목록(GET /v1/mentions/brands)에 나올 수 없으므로 0 계열로 섞지 않고 dropped 로 돌려준다.
    # 명부 제외 키 요청도 dropped: 경쟁 목록(GET /v1/mentions/brands)에 나올 수 없는 행이다(V2 와 같은 이유).
    have = {int(i["brand_key"]) for i in chosen}
    tkeys = {k for k, _ in totals}
    bad = [k for k in want if k not in info or int(info[k]["own_bit"] or 0) in ctx.own_bits
           or (int(info[k]["kind"]) == q.BRAND_KIND_NON_COMPETITOR and k not in tkeys) or k in excluded]
    extra = [k for k in want if k not in have and k not in bad]
    if bad and dropped is not None:
        dropped["brand_key"] = [str(k) for k in bad]
    chosen = chosen + [i for i in ranked if int(i["brand_key"]) in extra] + \
        sorted(({"brand_key": k, "frz_name": None, "mentions": 0, "name": names[k]} for k in extra if k not in tkeys),
               key=lambda i: lc_key(i["name"]))
    cidx = {(r.get(g), int(r["brand_key"]), r.get("frz_name")): r for r in comp}

    def comp_pair(md: MetricDef, r: dict[str, Any] | None, base: dict[str, Any] | None) -> tuple[int, int] | None:
        if r is None:
            r = {}
        b = base or {}
        if md.code == "M01":
            return int(r.get("exposure_answers") or 0), int(b.get("answers") or 0)
        if md.code == "M02":
            return int(r.get("mentions") or 0), int(b.get("total_mentions") or 0)
        if md.code == "M03":
            s_all = sum(int(r.get(k) or 0) for k in ("s_pos", "s_neu", "s_neg", "s_mix"))   # A3: mixed 는 분모 포함·긍정 제외
            return int(r.get("s_pos") or 0), s_all
        return int(r.get("rank_sum") or 0), int(r.get("ranked") or 0)

    out: list[TrendSeries] = []
    for md in mdefs:
        own_pts: list[list[TrendPoint]] = [[] for _ in owns]
        comp_pts: dict[tuple[int, str | None], list[TrendPoint]] = {(int(i["brand_key"]), i.get("frz_name")): [] for i in chosen}
        for s in slots:
            base = idx.get((s.key,))
            hidden = family_gap(s, win, md.family)
            presence = _presence(md, base)
            for n, part in enumerate(owns):
                orow = part.idx.get((s.key,))
                own_pts[n].append(make_point(md, s, hidden, presence, ratios(orow).get(md.name) if orow else None,
                                             negative=_neg(orow)))
            for i in chosen:
                ck = (int(i["brand_key"]), i.get("frz_name"))
                crow = cidx.get((s.key, *ck))
                comp_pts[ck].append(make_point(md, s, hidden, presence, comp_pair(md, crow, base), negative=_neg(crow, "s_neg")))
        for n, part in enumerate(owns):
            out.append(TrendSeries(metric=md.name, code=md.code, kind=md.kind, key=part.key, label=part.label, is_own=True,  # type: ignore[arg-type]
                                   own_brand_code=part.own_brand_code, brand_key=part.brand_key, points=own_pts[n]))
        for i in chosen:
            k = int(i["brand_key"])
            out.append(TrendSeries(metric=md.name, code=md.code, kind=md.kind, key=i["name"], label=i["name"],  # type: ignore[arg-type]
                                   is_own=False, brand_key=k, points=comp_pts[(k, i.get("frz_name"))]))
    return out


async def _series_type(conn: Any, ctx: ReadContext, win: Window, slots: list[Slot], bucket: str, *,
                       shared: _Shared | None = None) -> list[TrendSeries]:
    """BG-07 dimension=type(M08): 버킷 × 유형 5종. 분자 = 그 유형 신호가 있는 당사 답변(queries.type_counts_sql), 분모 = 버킷 답변(std_in).
    dims 요청이면 같은 요청의 (버킷) base(none·brand 차원)를 그대로 쓴다(answers·gap_base 만 읽는다, _Shared)."""
    md = TYPE_DEF
    ms = ctx.measure()
    g = BUCKET_GROUP[bucket]
    if shared is not None and shared.base is not None:
        base_rows = shared.base
    else:
        base_rows = await fetch_counts(conn, ms, win, group_by=(g,), parts=("mentions", "gap"))
        if shared is not None:
            shared.base = base_rows
    idx = _rows_by(base_rows, g)
    trows: dict[Any, dict[str, Any]] = {}
    if win.cyc_keys("mentions"):
        tq = q.type_counts_sql(ms, win, g)
        trows = {r[g]: r for r in await fetch_all(conn, tq.text, tq.params)}
    out: list[TrendSeries] = []
    for n, t in enumerate(q.TYPE_COLS):
        pts = []
        for s in slots:
            base = idx.get((s.key,))
            num = int((trows.get(s.key) or {}).get(f"a{n}") or 0)
            pts.append(make_point(md, s, family_gap(s, win, md.family), _presence(md, base),
                                  (num, int(base.get("answers") or 0) if base else 0)))
        out.append(TrendSeries(metric=md.name, code=md.code, kind="ratio", key=t, label=t, points=pts))
    return out


async def measured_days(conn: Any, ctx: ReadContext, win: Window, bucket: str) -> dict[Any, int]:
    """BG-10: 버킷 키 → 측정 일수(queries.measured_days_sql). 두 계열 모두 숨긴 창이면 빈 dict(전부 0)."""
    fams = [f for f in ("mentions", "citations") if win.cyc_keys(f)]
    if win.empty or not fams:
        return {}
    g = BUCKET_GROUP[bucket]
    mq = q.measured_days_sql(ctx.measure(), win, g, fams)
    return {r[g]: int(r["measured_days"] or 0) for r in await fetch_all(conn, mq.text, mq.params)}


async def _series_mix(conn: Any, ctx: ReadContext, win: Window, slots: list[Slot], bucket: str,
                      dimension: str, top: int, *, shared: _Shared | None = None) -> list[TrendSeries]:
    """dimension source·category(M09·M10): 버킷별 출처(카테고리) 인용 수 / 버킷 전체 인용 수(호스트 있는 인용, cit_in).
    dims 요청이면 인용 계열 자리 유무를 차원 사이에 나눠 쓰고(_bucket_presence), source·category 를 함께 요청했으면 queries.mix_pair_sql
    결과(per 1회, 호출자가 _Shared.mix 에 둔다)에서 이 차원의 부분(source = part 1, category = part 2)을 읽는다."""
    md = MIX_DEF[dimension]
    ms = ctx.measure()
    g = BUCKET_GROUP[bucket]
    seen = await _bucket_presence(conn, ctx, win, g, shared)            # 인용 계열 모수로 자리 유무(검증 D1)
    # A2: (버킷, 출처) 합산·출처 차원 조인·순위 후보 좁히기는 SQL(queries.mix_counts_sql), 순위 정본(rank_brand_items: 합계 내림차순 →
    # lc_key)은 여기서 후보에만 건다. source[] 는 core citation_where 가 건다(분자·분모 모두 선택 카테고리 출처).
    rows: list[dict[str, Any]] = []
    if not win.empty and shared is not None and shared.mix is not None:
        own_part = 1 if dimension == "source" else 2
        rows = [r for r in shared.mix if r["part"] == 0] + [{**r, "part": 1} for r in shared.mix if r["part"] == own_part]
    elif not win.empty:
        mq = q.mix_counts_sql(ms, win, g, dimension, top)
        rows = await fetch_all(conn, mq.text, mq.params)
    bucket_total: dict[Any, int] = {r["bk"]: int(r["n"] or 0) for r in rows if r["part"] == 0}
    # 차원 값별 (버킷 → 인용 수). 삽입 순서 = 차원 키 오름차순(합계·lc_key 가 모두 같은 완전 동률의 순서를 결정적으로)
    per: dict[Any, dict[Any, int]] = defaultdict(lambda: defaultdict(int))
    labels: dict[Any, tuple[str, str]] = {}
    for r in sorted((r for r in rows if r["part"] == 1), key=lambda r: (int(r["dkey"]), r["bk"])):
        k = int(r["dkey"])
        per[k][r["bk"]] += int(r["n"] or 0)
        if dimension == "source":
            labels[k] = (r["skey"], r["domain"])
        elif k not in labels:
            c = ctx.refs.category(k)
            labels[k] = (c.slug, c.name) if c else (str(k), str(k))
    items = rank_brand_items([{"k": k, "mentions": sum(v.values()), "name": labels[k][1]} for k, v in per.items()])[:top]
    out: list[TrendSeries] = []
    for i in items:
        k = i["k"]
        pts = []
        for s in slots:
            hidden = family_gap(s, win, md.family)
            pts.append(make_point(md, s, hidden, _presence(md, None, (s.key,) in seen),
                                  (per[k].get(s.key, 0), bucket_total.get(s.key, 0))))
        out.append(TrendSeries(metric=md.name, code=md.code, kind="ratio", key=labels[k][0], label=labels[k][1], points=pts))
    return out


# ════════════════════════════════════════════════════════════════════════════
# 진입점
# ════════════════════════════════════════════════════════════════════════════
async def _bind_trend(conn: Any, ctx: ReadContext, win: Window, *, grid: bool) -> ReadContext:
    """추이 창의 동결 판정(S4·S4b): 통과 = 동결 읽기 문맥(글로벌 격자는 격자 뷰), 구멍·현행 미러 사유 = 비카드 문맥."""
    c2 = ctx.bind_frozen(win.frz, keys=win.all_keys())
    if not c2.frz_ok:
        return c2
    if grid and c2.surface == "global":
        c2 = replace(c2, frz_grid=True)
    if await c2.frozen_route_reason(conn, win, "trend") is None:
        return await c2.frozen_drops(conn)
    return ctx.bind_frozen(False)


async def _series_of(conn: Any, ctx: ReadContext, win: Window, slots: list[Slot], bucket: str, dimension: str,
                     mdefs: tuple[MetricDef, ...], top: int, label: str, *, brand_keys: Sequence[int] = (), split_own: bool = False,
                     dropped: dict[str, list[str]] | None = None, shared: _Shared | None = None) -> list[TrendSeries]:
    """차원 하나의 계열. shared 는 dims 요청에서만 넘긴다(단일 차원 요청은 종전 호출 그대로: 기존 동치 시험이 이 이름들을 바꿔 끼운다)."""
    kw: dict[str, Any] = {"shared": shared} if shared is not None else {}
    if dimension in ("none", "engine"):
        return await _series_plain(conn, ctx, win, slots, bucket, mdefs, dimension, **kw)
    if dimension == "brand":
        return await _series_brand(conn, ctx, win, slots, bucket, mdefs, top, label, brand_keys=brand_keys,
                                   split_own=split_own, dropped=dropped, **kw)
    if dimension == "type":
        return await _series_type(conn, ctx, win, slots, bucket, **kw)
    return await _series_mix(conn, ctx, win, slots, bucket, dimension, top, **kw)


async def _multi_series(conn: Any, ctx: ReadContext, win: Window, slots: list[Slot], bucket: str, specs: Sequence[DimSpec],
                        label: str, *, brand_keys: Sequence[int], split_own: bool,
                        dropped: dict[str, list[str]]) -> list[list[TrendSeries]]:
    """B101 dims: 차원마다 단일 요청과 같은 계열(specs 순서로 돌려준다). 계산은 DIM_ORDER 순서((버킷) base 를 만드는 차원 먼저)로 하며
    _Shared 로 base·인용 계열 자리 유무를 나눠 쓰고, source·category 가 함께 있으면 구성비 문장을 하나(queries.mix_pair_sql)로 돌린다."""
    shared = _Shared()
    by_dim = {s.dimension: s for s in specs}
    if "source" in by_dim and "category" in by_dim and not win.empty:
        mq = q.mix_pair_sql(ctx.measure(), win, BUCKET_GROUP[bucket], by_dim["source"].top)
        shared.mix = await fetch_all(conn, mq.text, mq.params)
    out: dict[str, list[TrendSeries]] = {}
    for d in sorted(by_dim, key=DIM_ORDER.index):
        s = by_dim[d]
        out[d] = await _series_of(conn, ctx, win, slots, bucket, d, s.mdefs, s.top, label, brand_keys=brand_keys,
                                  split_own=split_own, dropped=dropped, shared=shared)
    return [out[s.dimension] for s in specs]


def _hidden_suppressed(win: Window, mdefs: Sequence[MetricDef]) -> dict[str, str]:
    """창이 계열에서 전부 숨김이면 그 계열 지표 이름 → hidden(meta.suppressed)."""
    out: dict[str, str] = {}
    for fam in ("mentions", "citations"):
        if win.hidden(fam):
            for m in mdefs:
                if m.family == fam:
                    out[m.name] = SUPPRESS_HIDDEN
    return out


def _trend_meta(win: Window, ctx: ReadContext, suppressed: dict[str, str], dropped: dict[str, list[str]], dimension: str,
                mdefs: Sequence[MetricDef]) -> Meta:
    meta = build_meta(mode="cumulative", window=win, ctx=ctx, suppressed=suppressed)
    meta.dropped_filters.update(dropped)             # BG-11: 모르는·관점 브랜드 brand_key
    if ctx.source_category_keys is not None and not (dimension in MIX_DEF or any(m.code in SOURCE_METRICS for m in mdefs)):
        mark_ignored(meta, "source")                  # 적용 대상 계열(M05·M09·M10)이 없는 요청: 조용히 무시하지 않는다
    return meta


async def get_trend(conn: Any, principal: Principal, filters: CommonFilters, *, bucket: str, dimension: str, metrics: Sequence[str],
                    top: int, custom_fields: dict[str, list[str]] | None = None, today: date | None = None,
                    brand_keys: Sequence[int] = (), split_own: bool = False, with_measured_days: bool = True,
                    profile: LegacyProfile | None = None, dims: Sequence[str] = ()) -> Envelope[TrendData]:
    prof = profile if profile is not None else active_profile()
    mdefs = parse_metrics(metrics, filters.surface, dimension)
    extras = parse_dims(dims, filters.surface, dimension, top)        # B101(선택): 없으면 종전 단일 차원
    if dimension != "brand" and (brand_keys or split_own):   # 다른 차원에서 조용히 무시하지 않는다
        field_ = "brand_key" if brand_keys else "split_own"
        raise errors.unprocessable(f"{field_} 는 {BRAND_ONLY}", details={"field": field_, "dimension": dimension})
    ctx = await resolve_read_context(conn, principal, filters, support=TREND_SUPPORT, custom_fields=custom_fields)
    if prof.trend_grid and bucket == "cycle" and ctx.surface in GRID_RULES:
        # 현행 X.trendGrid(프로필 trend_grid, WU-6): 원장 자리 최신 13개(기간이 있으면 그 안), 자리 대표 회차만 값, 완결성·인용 표식 갭
        fz = frz_eligible(prof, surface=ctx.surface, card=ctx.card)
        grid = await resolve_trend_grid(conn, surface=ctx.surface, project_keys=ctx.project_keys, date_from=ctx.date_from,
                                        date_to=ctx.date_to, today=today, project_ids=ctx.project_ids, frz=fz)
        win, slots = grid.window, grid_slots_of(grid)
        # 동결 판정(S4·S4b): 격자 범위에 세대 없는 회차(구멍)가 있거나 현행이 추이를 미러로 보내는 사유(점 하나·plan·빈 집계, FROZEN_ROUTES)면
        # 요청 전체를 비카드로. 격자 자체는 카드와 무관해 그대로. 글로벌 격자 추이는 in_full_cycle 게이트만 뺀 격자 뷰(core.facts.GRID, S3)
        ctx = await _bind_trend(conn, ctx, win, grid=True)
    else:
        win = await trend_window(conn, ctx, bucket, today=today)
        ctx2 = await _bind_trend(conn, ctx, win, grid=False)
        if ctx2.card != ctx.card:
            win = await trend_window(conn, ctx2, bucket, today=today)
        ctx = ctx2
        slots = build_slots(win, bucket)
    label = own_label(ctx)
    suppressed: dict[str, str] = {}
    dropped: dict[str, list[str]] = {}
    days: dict[Any, int] = {}
    extra_series: list[list[TrendSeries]] = [[] for _ in extras]
    if not slots:
        suppressed["*"] = SUPPRESS_NO_SNAPSHOT
        series: list[TrendSeries] = []
    else:
        if with_measured_days:
            days = await measured_days(conn, ctx, win, bucket)
        suppressed.update(_hidden_suppressed(win, mdefs))
        if not extras:
            series = await _series_of(conn, ctx, win, slots, bucket, dimension, mdefs, top, label, brand_keys=brand_keys,
                                      split_own=split_own, dropped=dropped)
        else:
            series, *extra_series = await _multi_series(conn, ctx, win, slots, bucket, [DimSpec(dimension, mdefs, top), *extras], label,
                                                        brand_keys=brand_keys, split_own=split_own, dropped=dropped)
    data = TrendData(bucket=bucket, dimension=dimension, own_label=label,  # type: ignore[arg-type]
                     buckets=[TrendBucket(key=s.key, round_dates=s.round_dates,
                                          measured_days=days.get(s.key, 0) if with_measured_days else None) for s in slots],
                     series=series)
    if extras:     # B101: 차원마다 그 차원 단일 요청과 같은 meta(억제·무시 축은 그 차원 지표로 판정)
        data.dims = [TrendDimBlock(dimension=s.dimension, series=ss,  # type: ignore[arg-type]
                                   meta=_trend_meta(win, ctx, _hidden_suppressed(win, s.mdefs) if slots else {"*": SUPPRESS_NO_SNAPSHOT},
                                                    {}, s.dimension, s.mdefs))
                     for s, ss in zip(extras, extra_series, strict=True)]
    meta = _trend_meta(win, ctx, suppressed, dropped, dimension, mdefs)
    return Envelope[TrendData](data=data, meta=meta)


def mark_ignored(meta: Meta, axis: str) -> None:
    if axis not in meta.ignored_filters:
        meta.ignored_filters = sorted([*meta.ignored_filters, axis])
