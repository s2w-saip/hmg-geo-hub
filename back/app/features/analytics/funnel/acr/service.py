"""analytics.funnel.acr 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

규칙(모듈-AI-퍼널 §2.1, G-11 a, DECISIONS-API Q1·Q12)
- 시간 축: 스냅샷(from/to 없음) = 함대 규칙 최신 노출 회차 하나의 모든 셀(A1), 기간 = round_date 가 기간 안인 게이트 통과 회차 전부(D1).
  숨김은 언급 계열({1,3} 배제). 현행 ACR 의 지면 'all' 예외는 사라진다.
- 엔진: engine[] 이 비면 rd.dim_engine.is_default 목록(acr_cell 에 dflt 열이 없어 core scope_where(dflt_column=False) 가 기본 엔진 키를 건다).
- 카탈로그 ACR 프롬프트 수 = core.measure.prompt_counts(kind='acr')(현행 countStandardAcrPrompts 대체).
- 표면 경로 게이트(역할 천장 + menu_groups)는 core.filters.resolve_read_context 가 건다.
- 반복 접기(R13·A15)는 적재 시 셀 단위로 끝나 있다. 조회부는 acr_in 만 건다.
- 추이: 버킷 = 회차(round_date). 창 끝(스냅샷이면 그 회차, 기간이면 기간 끝)에서 거꾸로 trend_cycles 개의 게이트 통과 회차(Q12 기본 12).
  분자·분모는 같은 셀 선택(같은 게이트)을 쓰고, ACR 셀이 없는 게이트 회차는 gap 으로 둔다.
  창(스냅샷 회차·기간)에 셀이 0 이어도 추이는 낸다(그 회차는 gap). 이때 시리즈 브랜드는 추이 창 전체 브랜드 순위에서 고른다.
- 표면: global 은 실데이터. website·project 는 같은 쿼리를 쓰되 ACR 원천(카탈로그 ACR 프롬프트·셀)이 없으면 A12 source_pending.
- 옵션(BG-33): data.options.langs·countries = ACR 셀 모집단(현행 listMeasuredAcrLanguages). 창이 비었거나 숨김·원천 준비 중이면 빈 목록.
  langs = 현행과 같은 축만 건다(스코프 브랜드·국가·기간): lang 축(자기 축)·엔진 축(전 엔진, 기본 엔진 한정도 없음)·택소노미·커스텀 축은
  빼고 낸다(검증 D5, 현행 scope-aggregates.ts:7740-7783 은 엔진·택소노미를 걸지 않는다).
  countries = 데이터와 같은 셀 선택에서 geo 축만 계정 국가 스코프로 바꾸고, 숨김 국가(global = rd.dim_country.hidden_standard,
  website = app.hidden_market 'website')를 뺀다(검증 D2, 현행 listMeasuredRegions(..., true)·/v1/filters/options regions 와 같다).
  website 계정 스코프의 브랜드 가상 코드(현대 N 계정 HYUNDAI-N)는 DataScope.site_allowed 로 고른 사이트의 국가로 푼다(option_scope_countries,
  데이터 경로 core.filters 동기화 S1 BE-8 ③ 과 같다. 종전: 가상 코드로 셀 geo 를 걸어 0행).
- 비율은 Ratio(정수 쌍)만 낸다(P3). 내부 정수 키(cyc_key·geo_key·engine_key·brand_key)는 응답에 싣지 않는다.
- 명부 제외(동기화 S1 BE-5, 현행 hmg-geo 2670a16 excluded-brands.ts:258-262 filterAcr, 키 = core.entities, 메인 결정 2026-09-30 현행 동작):
  브랜드 표(brands)는 상위 top_brands 를 읽은 뒤 제외 키 행(당사 제외)만 뺀다. 다음 순위로 채우지 않는다(현행: 캐시된 LIMIT 12 결과를
  거르므로 표가 제외 수만큼 준다). 추이 시리즈(당사 우선 + 상위 trend_series)는 거르기 전 행에서 고른다(현행: 추이는 집계
  안에서 거르기 전 brands 로 고르고 filterAcr 는 brands 만 거른다). 값은 그대로: totals·choice_share·coverage 분모·추이 분모·
  배틀 승자·차종·점유 맵 항목.
"""
from __future__ import annotations

import dataclasses
import json
from datetime import date
from typing import Any

from app.core.codes import HIDDEN_EXCLUDE, Refs
from app.core.cycles import Window, build_window, resolve_window
from app.core.db import fetch_all, fetch_one
from app.core.entities import excluded_brand_keys, keep
from app.core.envelope import SUPPRESS_HIDDEN, SUPPRESS_NO_SNAPSHOT, SUPPRESS_SOURCE_PENDING, Envelope, Meta, build_meta, ratio
from app.core.filters import TAXONOMY_AXES, FilterSupport, ReadContext
from app.core.measure import MeasureScope, prompt_counts
from app.features.analytics.funnel.acr import queries as q
from app.features.analytics.funnel.acr.schemas import (
    AcrBattleCell,
    AcrBattleRow,
    AcrBrand,
    AcrData,
    AcrModelRow,
    AcrOptions,
    AcrParams,
    AcrTerritoryEntry,
    AcrTerritoryRow,
    AcrTerritorySheet,
    AcrTotals,
    AcrTrend,
    AcrTrendBucket,
    AcrTrendPoint,
)

# 표면별 지원 축(모듈-AI-퍼널 §2.1 필터 표). source[] 는 인용 전용 축이라 전 표면 ignored.
# website 는 카탈로그 축 해석 경로가 core 에 없어(웹 프롬프트는 택소노미 없음) 선언하지 않는다(ignored 로 드러남).
SUPPORT = FilterSupport.of(
    global_=("brand", "country", "lang", "engine", "period", *TAXONOMY_AXES),
    website=("brand", "country", "lang", "engine", "period"),
    project=("country", "lang", "engine", "period", *TAXONOMY_AXES, "custom"),
)
_EPOCH = date(2000, 1, 1)   # 추이 회차 후보 하한(rd.cycle 은 작은 표라 전 이력 후보를 읽고 앱에서 N개로 자른다)


def trend_window(win: Window, candidates: Window, n: int) -> Window:
    """창 끝에서 거꾸로 n 개 게이트 통과(언급 계열) 회차 날짜로 좁힌 창. 순수 함수."""
    rows = [r for r in candidates.cycles if r.hidden_scope not in HIDDEN_EXCLUDE["mentions"]
            and (win.hi is None or r.round_date <= win.hi)]
    if win.mode == "cumulative" and win.lo is not None:
        rows = [r for r in rows if r.round_date >= win.lo]
    dates = sorted({r.round_date for r in rows})[-n:]
    rows = [r for r in rows if r.round_date in set(dates)]
    lo, hi = (dates[0], dates[-1]) if dates else (None, None)
    return build_window(surface=win.surface, mode="cumulative", rows=rows, lo=lo, hi=hi, generation=win.generation,
                        project_keys=tuple(sorted({r.project_key for r in candidates.cycles})))


def _engine_code(refs: Refs, key: int) -> str:
    for code, (k, _) in refs.engines.items():
        if k == key:
            return code
    return ""


def _json(v: Any) -> list[dict[str, Any]]:
    """json_agg 결과(드라이버가 문자열로 줄 수 있다) → 목록."""
    if v is None:
        return []
    return json.loads(v) if isinstance(v, str) else list(v)


def empty_data(catalog: int = 0) -> AcrData:
    return AcrData(totals=AcrTotals(prompt_runs=0, prompts=0, iterations=0, engines=[], catalog_acr_prompts=catalog),
                   brands=[], trend=AcrTrend(series_brands=[], buckets=[]), battle=[], model_conversion=[], territory=[])


async def catalog_acr_prompts(conn: Any, ctx: ReadContext, ms: MeasureScope) -> int:
    """카탈로그 ACR 프롬프트 수(현행 countStandardAcrPrompts 대체) = core.measure.prompt_counts(kind='acr')."""
    return await prompt_counts(conn, ms, kind="acr")


def langs_scope(ms: MeasureScope, refs: Refs) -> MeasureScope:
    """언어 옵션 셀 선택(순수 함수, 검증 D5). 현행 listMeasuredAcrLanguages 는 스코프 브랜드·국가·기간만 건다:
    lang 축(자기 축)·택소노미·커스텀(prompt_keys)을 빼고, 엔진은 전 엔진(기본 엔진 한정도 걸지 않는다)."""
    every = tuple(sorted(k for k, _ in refs.engines.values()))
    return dataclasses.replace(ms, lang_keys=None, prompt_keys=None, engine_keys=every)


def hidden_countries(ctx: ReadContext) -> frozenset[str]:
    """국가 옵션에서 뺄 숨김 국가(대문자, 검증 D2). /v1/filters/options build_matrix 와 같은 규칙:
    global = rd.dim_country.hidden_standard, website = app.hidden_market('website'), project = 없음."""
    refs = ctx.refs
    if ctx.surface == "global":
        return frozenset(c.code.upper() for c in refs.countries.values() if c.hidden_standard and c.code)
    if ctx.surface == "website":
        return frozenset(refs.hidden_markets.get("website", frozenset()))
    return frozenset()


def option_scope_countries(ctx: ReadContext, ms: MeasureScope) -> tuple[str, ...] | None:
    """국가 옵션 셀 선택의 geo 축 = 계정 국가 스코프(요청 국가로 좁히지 않는다. 순수 함수). project 표면은 None(국가 축 없음).
    website 계정 스코프에 브랜드 가상 코드(HYUNDAI-N)가 있으면 데이터 경로(core.filters, 동기화 S1 BE-8 ③)와 같게 푼다: 가상 코드는 답변 국가가
    아니므로 스코프 실 코드 ∪ DataScope.site_allowed 를 통과한 선택 사이트(ms.project_keys)의 사이트 국가(현행 websiteScopeCountryCondition,
    현대 N 계정 = 현대 N 사이트 셀의 국가). 사이트는 ms.project_keys 안에서만 보므로 다른 브랜드 사이트로 넓어지지 않는다.
    가상 코드가 없는 계정은 스코프 국가 그대로(종전)."""
    if ctx.surface == "project":
        return None
    scope_c = ctx.scope.countries
    refs = ctx.refs
    if ctx.surface != "website" or not scope_c or not ctx.scope.virtual_brand_bits(refs):
        return scope_c
    real = {c.upper() for c in scope_c if refs.countries.get(c.upper()) is None or refs.countries[c.upper()].kind != "virtual_brand"}
    keys = set(ms.project_keys or ())
    site_cc: set[str] = set()
    for p in refs.projects:
        if p.surface != 2 or p.project_key not in keys:
            continue
        c = refs.country_by_key(p.site_geo_key)
        if c is not None and c.code and ctx.scope.site_allowed(refs, p.site_brand_bit, c.code):
            site_cc.add(c.code.upper())
    return tuple(sorted(real | site_cc))


async def acr_options(conn: Any, ctx: ReadContext, ms: MeasureScope, win: Window) -> AcrOptions:
    """ACR 모집단 언어·국가 옵션(BG-33, 현행 listMeasuredAcrLanguages scope-aggregates.ts:7740 과 같은 모집단 = ACR 셀).
    언어 = langs_scope(스코프 브랜드·국가·기간만, 검증 D5), 국가 = geo 축을 계정 국가 스코프(option_scope_countries)로 바꾼 셀 선택
    (요청 국가로 좁히지 않되 스코프 밖은 없다)에서 숨김 국가를 뺀 것(검증 D2).
    project 표면은 계정 국가 스코프를 답변 축에 걸지 않으므로(core resolve_read_context) 국가 축 없음."""
    lq = q.option_langs_sql(langs_scope(ms, ctx.refs), win)
    scope_c = option_scope_countries(ctx, ms)
    geo = None if scope_c is None else tuple(sorted(k for k in (ctx.refs.geo_key(c) for c in scope_c) if k is not None))
    cq = q.option_countries_sql(dataclasses.replace(ms, geo_keys=geo), win)
    hidden = hidden_countries(ctx)
    return AcrOptions(langs=[r["code"] for r in await fetch_all(conn, lq.text, lq.params)],
                      countries=[r["code"] for r in await fetch_all(conn, cq.text, cq.params) if r["code"].upper() not in hidden])


async def _trend(conn: Any, ctx: ReadContext, ms: MeasureScope, win: Window, params: AcrParams, *, today: date | None,
                 brand_rows: list[dict[str, Any]] | None) -> AcrTrend:
    """회차 버킷 추이. 창 끝에서 거꾸로 trend_cycles 개 게이트 통과 회차, ACR 셀이 없는 회차는 gap.
    시리즈 = 당사 우선 + 상위 trend_series 개. brand_rows 가 None(창에 셀 없음)이면 추이 창 전체의 브랜드 순위에서 고른다(검증 D3).
    brand_rows 는 명부 제외를 거르기 전 브랜드 표 행이다(현행 filterAcr 는 brands 만 거른다)."""
    candidates = await resolve_window(conn, surface=ctx.surface, project_keys=ctx.project_keys, date_from=_EPOCH,
                                      date_to=win.hi, today=today, project_ids=ctx.project_ids)
    tw = trend_window(win, candidates, params.trend_cycles)
    if tw.empty:
        return AcrTrend(series_brands=[], buckets=[])
    if brand_rows is None:
        bq = q.brands_sql(ms, tw, limit=params.top_brands)
        brand_rows = await fetch_all(conn, bq.text, bq.params)
    ordered = [r for r in brand_rows if r["is_ours"]] + [r for r in brand_rows if not r["is_ours"]]
    series = ordered[: params.trend_series]
    den: dict[date, int] = {}
    num: dict[tuple[date, int], int] = {}
    # 시리즈가 비어도 분모(회차별 Σvalid_acr)는 읽는다: gap 판정이 분모 기준이다
    rq = q.trend_sql(ms, tw, series_brand_keys=[int(r["brand_key"]) for r in series])
    for r in await fetch_all(conn, rq.text, rq.params):
        if r["brand_key"] is None:
            den[r["round_date"]] = int(r["n"])
        else:
            num[(r["round_date"], int(r["brand_key"]))] = int(r["n"])
    return AcrTrend(series_brands=[r["brand"] for r in series],
                    buckets=[AcrTrendBucket(round_date=d, gap=den.get(d, 0) == 0, den=den.get(d, 0),
                                            series=[AcrTrendPoint(brand=s["brand"], num=num.get((d, int(s["brand_key"])), 0))
                                                    for s in series])
                             for d in tw.round_dates])


async def build(conn: Any, ctx: ReadContext, params: AcrParams, *, today: date | None = None) -> Envelope[AcrData]:
    refs = ctx.refs
    ms = ctx.measure()
    win = await ctx.window(conn, today=today)
    catalog = await catalog_acr_prompts(conn, ctx, ms)

    def meta(**suppressed: str) -> Meta:
        return build_meta(mode=win.mode, window=win, ctx=ctx, suppressed=suppressed or None)

    if win.empty:
        if win.hidden("mentions"):
            return Envelope(data=empty_data(catalog), meta=meta(**{"*": SUPPRESS_HIDDEN}))
        if ctx.surface != "global" and catalog == 0:
            return Envelope(data=empty_data(catalog), meta=meta(**{"*": SUPPRESS_SOURCE_PENDING}))
        return Envelope(data=empty_data(catalog), meta=meta(**({"*": SUPPRESS_NO_SNAPSHOT} if win.mode == "snapshot" else {})))
    if win.hidden("mentions"):
        return Envelope(data=empty_data(catalog), meta=meta(**{"*": SUPPRESS_HIDDEN}))

    # 0 옵션(BG-33): 데이터와 같은 셀 선택에서 자기 축만 뺀다. 고른 언어에 셀이 없어도 다른 언어 옵션은 남는다.
    options = await acr_options(conn, ctx, ms, win)

    # 1 총량
    tq = q.totals_sql(ms, win)
    t = await fetch_one(conn, tq.text, tq.params) or {}
    totals = AcrTotals(prompt_runs=int(t.get("prompt_runs") or 0), prompts=int(t.get("prompts") or 0),
                       iterations=int(t.get("iterations") or 0),
                       engines=sorted(c for c in (_engine_code(refs, int(k)) for k in (t.get("engine_keys") or [])) if c),
                       catalog_acr_prompts=catalog)
    if totals.prompt_runs == 0:
        pending = ctx.surface != "global" and catalog == 0
        data0 = empty_data(catalog).model_copy(update={"totals": totals, "options": options})
        if not pending:
            # 창(스냅샷 회차)에 셀이 없어도 추이는 낸다: 이전 게이트 회차는 값, 이 회차는 gap(검증 D3).
            # 시리즈 브랜드는 스냅샷 브랜드가 없으므로 추이 창 전체의 브랜드 순위에서 고른다.
            data0.trend = await _trend(conn, ctx, ms, win, params, today=today, brand_rows=None)
        return Envelope(data=data0, meta=meta(**({"*": "source_pending"} if pending else {})))

    # 2 브랜드: 상위 top_brands 에서 명부 제외 키 행만 뺀다(채우지 않음, 값·분모 그대로 = 현행 filterAcr)
    bq = q.brands_sql(ms, win, limit=params.top_brands)
    brand_rows = await fetch_all(conn, bq.text, bq.params)
    excluded = await excluded_brand_keys(conn)
    table_rows = [r for r in brand_rows if keep(r["brand_key"], is_own=bool(r["is_ours"]), excluded=excluded)]
    brands = [AcrBrand(brand=r["brand"], is_ours=bool(r["is_ours"]), choice=int(r["choice"]), appearance=int(r["appearance"]),
                       cells=int(r["cells"]), choice_share=ratio(r["choice"], totals.iterations),
                       coverage=ratio(r["cells"], totals.prompt_runs)) for r in table_rows]

    # 3 추이: 당사 우선 + 상위(현행 topBrands.slice(0, 5)), 명부 제외를 거르기 전 행에서
    trend = await _trend(conn, ctx, ms, win, params, today=today, brand_rows=brand_rows)

    # 4 배틀: 프롬프트별 셀 묶음, 엔진 코드 순, 프롬프트는 선택 합 내림차순(동률은 문구·id 순) 후 상한
    gq = q.battle_sql(ms, win)
    by_prompt: dict[str, AcrBattleRow] = {}
    for r in await fetch_all(conn, gq.text, gq.params):
        row = by_prompt.setdefault(r["prompt_id"], AcrBattleRow(prompt_id=r["prompt_id"], prompt_text=r["prompt_text"], cells=[]))
        row.cells.append(AcrBattleCell(engine=_engine_code(refs, int(r["engine_key"])), winner_brand=r["winner_brand"],
                                       winner_is_ours=bool(r["winner_is_ours"]), choice=int(r["choice"])))
    for row in by_prompt.values():
        row.cells.sort(key=lambda c: c.engine)
    battle = sorted(by_prompt.values(), key=lambda x: (-sum(c.choice for c in x.cells), x.prompt_text or "", x.prompt_id))
    battle = battle[: params.battle_limit]

    # 5 차종 전환율
    mq = q.models_sql(ms, win, limit=params.model_limit)
    models = [AcrModelRow(brand=r["brand"], model=r["model"], is_ours=bool(r["is_ours"]), conversion=ratio(r["choice"], r["cell_vacr"]),
                          cells=int(r["cells"]), top1=int(r["choice"])) for r in await fetch_all(conn, mq.text, mq.params)]

    # 6 점유 맵
    yq = q.territory_sql(ms, win, limit=params.territory_limit)
    sheets: dict[tuple[int, int], AcrTerritorySheet] = {}
    for r in await fetch_all(conn, yq.text, yq.params):
        k = (int(r["geo_key"]), int(r["engine_key"]))
        if k not in sheets:
            c = refs.country_by_key(k[0])
            sheets[k] = AcrTerritorySheet(country=c.code if c and c.code else None, engine=_engine_code(refs, k[1]), rows=[])
        sheets[k].rows.append(AcrTerritoryRow(prompt_id=r["prompt_id"], prompt_text=r["prompt_text"], valid_acr=int(r["valid_acr"]),
                                              entries=[AcrTerritoryEntry(**e) for e in _json(r["entries"])]))

    data = AcrData(totals=totals, brands=brands, trend=trend, battle=battle, model_conversion=models, territory=list(sheets.values()),
                   options=options)
    return Envelope(data=data, meta=meta())

