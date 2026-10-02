"""analytics.kpi.summary 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

창(Q1·A1·D1): from/to 없으면 함대 스냅샷(core.cycles.resolve_window, cycle_offset 0 최신 · 1 직전), 있으면 round_date 기간 누적.
억제(meta.suppressed, 지표 키 → 사유)
  hidden              창에 회차는 있는데 그 계열(언급 {1,3} · 인용 {1,2})이 전부 숨김
  no_data             분모 0
  not_website_surface M06·M07·인용 정확도를 그 지표가 없는 표면(global)에서 요청
  analysis_gap: hidden  창의 언급 계열이 전부 숨김이면 A16 쌍은 {0,0} 이고 hidden 을 적는다(M6)
  '*': no_active_snapshot  스냅샷인데 노출 회차가 없음(응답 전체)
M06·M07·인용 정확도(website·project, Q5): core.measure.url_rates. 분모 = cit_in 답변(website 는 web_reg, project 는 게이트 없음).
url_prompts(결정 6, website 만, 추가형): 같은 url_rates 의 프롬프트 단위 (측정·타겟·자사) 프롬프트 수. 발행값이면 발행 프롬프트 합, 라이브면 core part
  'url_prompts'(측정 단위 카드와 같은 모수 답변의 서로 다른 프롬프트). 억제 키 'url_prompts': global·project not_website_surface, 인용 숨김 hidden,
  빈 창·측정 프롬프트 0 no_data.
R09(웹사이트 발행값)는 스냅샷 또는 회차 하나를 고른 기간(from = to)에서만 접고(D-R09), 헤드라인 풀 규칙은 core 가 적용한다.
meta.source = 명명 스키마 SummarySource(fe-u4 요청 1: url_rates report|live, reason 라이브 사유(core R09_*), publications 합산 발행물,
  발행값이면 round_date·site_count·publication_details·헤드라인 라벨 cycle_label·cycle_label_en, 아니면 null. 순서 = order_publications). 인용 정확도 = 타겟 ∧ 자사 / 자사(라이브).
  발행값(report)이면 BG-26 표식을 더한다(추가형): round_date(발행 회차), site_count(합산에 실제로 들어간 발행 유닛 수 = 헤드라인 풀
  규칙 뒤, 현행 publishedSubtotal.siteCount), publication_details[{slug, cycle_label, cycle_label_en, round_date}].
prompts_without_brand(BG-06): 세 표면 모두 measured_prompts − 관점 브랜드 언급 프롬프트 수(숨김 hidden, 빈 창·측정 프롬프트 0 은 null no_data).
measured_by_funnel(BG-08, by_funnel=true 일 때만): 측정 프롬프트를 퍼널 코드로 나눈 수(합 = measured_prompts).
미측정 목록(BG-04, GET /v1/kpi/unmeasured-prompts): 카드와 같은 창·필터·술어(적용 집합 − 측정 집합), 상한 200, total = 절단 전 수.
"""
from __future__ import annotations

import dataclasses
from datetime import date
from typing import Any

from app.core.cycles import Window
from app.core.db import fetch_all
from app.core.envelope import (
    SUPPRESS_HIDDEN,
    SUPPRESS_NO_DATA,
    SUPPRESS_NO_SNAPSHOT,
    Envelope,
    ListData,
    Meta,
    Page,
    Ratio,
    UrlPromptCounts,
    build_meta,
    rank_avg_or_none,
    ratio_or_none,
)
from app.core.filters import DEPTH4_AXIS, TAXONOMY_AXES, CommonFilters, ReadContext
from app.core.measure import (
    MeasureScope,
    accuracy_counts,
    accuracy_mode,
    fetch_counts,
    legacy_accuracy,
    prompt_counts,
    ratios,
    report_values_sql,
    url_hits_uncovered,
    url_rates,
)

from .queries import PUBLICATION_LABELS_SQL, SUMMARY_PARTS, CatalogRowGate, funnel_measured_sql, unmeasured_sql
from .schemas import (
    AnalysisGap,
    FunnelPrompts,
    PublicationDetail,
    SummaryData,
    SummaryMeta,
    SummaryParams,
    SummaryResponse,
    SummarySource,
    UnmeasuredPrompt,
)

URL_METRICS = ("target_url_rate", "owned_url_rate", "citation_accuracy")
URL_SURFACES = ("website", "project")     # Q5: 프로젝트 표면도 M06·M07 을 채운다


def _gate(sup: dict[str, str], key: str, value: Any, *, hidden: bool) -> Any:
    """숨김이면 값 없이 hidden, 값이 없으면(분모 0) no_data."""
    if hidden:
        sup[key] = "hidden"
        return None
    if value is None:
        sup[key] = "no_data"
    return value


def ignored_offset(ctx: ReadContext, cycle_offset: int) -> list[str]:
    """cycle_offset 은 스냅샷 전용이다. 기간 모드에서 1 을 주면 조용히 버리지 않고 ignored_filters 에 적는다."""
    return ["cycle_offset"] if ctx.date_from is not None and cycle_offset != 0 else []


async def _publication_marks(conn: Any, ctx: ReadContext, ms: MeasureScope, win: Window, slugs: list[str],
                             cell: dict[str, Any] | None = None) -> dict[str, Any]:
    """BG-26: 발행값 카드의 표식. site_count 는 core 발행값 문장(report_values_sql, url_rates 와 같은 입력·같은 스냅샷)의 units.
    현행 프로필 web_url_rate(WU-7): url_rates 칸이 현행 선택의 site_count·round_date(from = to 날짜)를 싣고 오면 그 값(현행 publication.siteCount)."""
    if cell is not None and "site_count" in cell:
        units, rd0 = int(cell["site_count"]), cell["round_date"]
    else:
        q = report_values_sql([win.lo], ctx.own_brands, ctx.countries, ctx.langs, project_keys=ms.project_keys,  # type: ignore[list-item]
                              geo_keys=ms.geo_keys)
        units, rd0 = sum(int(r["units"] or 0) for r in await fetch_all(conn, q.text, q.params)), win.lo
    labels = await fetch_all(conn, PUBLICATION_LABELS_SQL, {"slugs": list(slugs)}) if slugs else []
    return {"round_date": rd0, "site_count": units,
            "publication_details": [{"slug": r["slug"], "cycle_label": r["cycle_label"], "cycle_label_en": r["cycle_label_en"],
                                     "round_date": r["round_date"]} for r in labels]}


def order_publications(details: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """발행물이 여럿일 때 카드 라벨 순서(fe-u4 요청 2, 계약): round_date 내림차순 → slug 오름차순. 첫 원소가 SummarySource.cycle_label.
    카드 발행값은 회차 하나(R09 스냅샷·from = to)라 실제로는 slug 순이다(종전 PUBLICATION_LABELS_SQL ORDER BY slug 와 같다).
    현행 front 는 정해진 순서가 없다: loadPublishedWebsiteRound(report-publications.ts:210-217)가 ORDER BY 없이 LIMIT 1 이고, 활성 부분 유일 색인
    (surface, round_date, brand_scope)(0080_report_publications.sql:111) 이라 brand_scope 가 다른 활성 발행물이 한 회차에 둘 이상일 수 있다
    (주석 :192 의 '최대 1건' 은 brand_scope 가 하나일 때만 맞다). 그래서 결정적 규칙을 계약으로 정했다."""
    return sorted(details, key=lambda d: (-d["round_date"].toordinal(), d["slug"]))


def _source(src: dict[str, Any] | None) -> SummarySource | None:
    """meta.source dict → 명명 스키마(SummarySource). 발행물 목록은 order_publications 순서, 라벨 한 쌍 = 첫 원소."""
    if src is None:
        return None
    details = [PublicationDetail(**d) for d in order_publications(list(src.get("publication_details") or []))]
    order = {d.slug: i for i, d in enumerate(details)}
    pubs = sorted(src.get("publications") or [], key=lambda s: (order.get(s, len(order)), s))
    head = details[0] if details else None
    return SummarySource(url_rates=src["url_rates"], reason=src.get("reason"), publications=pubs, round_date=src.get("round_date"),
                         site_count=src.get("site_count"), publication_details=details,
                         cycle_label=head.cycle_label if head else None, cycle_label_en=head.cycle_label_en if head else None)


async def _measured_by_funnel(conn: Any, ctx: ReadContext, ms: MeasureScope, win: Window) -> list[FunnelPrompts]:
    """BG-08: 퍼널 코드별 측정 프롬프트 수. 빈 창이면 문장 없이 []. 키 0·사전 밖 키는 미분류(null)로 합친다."""
    if win.empty:
        return []
    q = funnel_measured_sql(ms, win)
    rows = await fetch_all(conn, q.text, q.params)
    taxa = {int(r["taxon_key"]): r["code"] for r in await fetch_all(
        conn, "SELECT taxon_key, code FROM rd.dim_taxon WHERE axis = 'funnel'")}
    acc: dict[str | None, int] = {}
    for r in rows:
        code = taxa.get(int(r["funnel_key"] or 0))
        acc[code] = acc.get(code, 0) + int(r["measured_prompts"] or 0)
    items = sorted(acc.items(), key=lambda kv: (kv[0] is None, -kv[1], kv[0] or ""))
    return [FunnelPrompts(funnel=k, measured_prompts=v) for k, v in items]


async def _accuracy_current(conn: Any, ctx: ReadContext, ms: MeasureScope, win: Window, *, offset: int,
                            today: date | None) -> tuple[int, int]:
    """현행 ⑥(web_accuracy_flat, CACC6): core.measure.accuracy_mode 경로. screen 이고 카드 요청이면 비카드 창(자리 대표 없음 = 현행 미러
    누적 기간)을 다시 푼다. 반환 = (분자 tgt_own_hits, 분모 own_url_hits)."""
    mode = accuracy_mode(ctx.card, ctx.date_from is not None or ctx.date_to is not None)
    w = win if mode == "unit" or not ctx.card else await dataclasses.replace(ctx, card=False).window(conn, offset=offset, today=today)
    r = (await accuracy_counts(conn, ms, w, mode=mode))[0]
    return int(r["tgt_own_hits"] or 0), int(r["own_url_hits"] or 0)


async def get_summary(conn: Any, ctx: ReadContext, *, cycle_offset: int, today: date | None,
                      by_funnel: bool = False) -> SummaryResponse:
    ctx, win = await ctx.card_window(conn, route="kpi", offset=cycle_offset if ctx.date_from is None else 0, today=today)   # 동결 판정(S4)
    ms = ctx.measure()
    # 현행 자사·타겟 URL 인용률 2종은 고른 회차 세대 중 하나라도 summary_url_hit_generations 에 없으면 그 2장만 미러로 간다
    # (server.ts:5527-5542 url-hits-uncovered, summary-website-aggregates.ts:1273-1297 covered < wanted). 허브 = 그 계열만 비카드(S4b).
    # 그때는 동결 스캔에서 URL 칸을 빼 같은 값을 두 번 세지 않는다
    url_live = bool(ctx.frz_ok and ctx.surface == "website" and win.mode == "snapshot" and await url_hits_uncovered(conn, win))
    parts = SUMMARY_PARTS + (("urls",) if ctx.surface in URL_SURFACES and not url_live else ())   # urls 도 같은 스캔에서(core 가 빈 창이면 0 행)
    if ctx.surface == "website" and not url_live:
        parts += ("url_prompts",)                                                    # 결정 6: 프롬프트 단위(별도 count DISTINCT 문장)
    row = (await fetch_counts(conn, ms, win, parts=parts))[0]
    applied = await prompt_counts(conn, ms)
    r = ratios(row)
    sup: dict[str, str] = {}
    m_hidden = win.hidden("mentions")
    c_hidden = win.hidden("citations")

    vis = _gate(sup, "visibility", ratio_or_none(*r["visibility"]), hidden=m_hidden)
    sov = _gate(sup, "share_of_voice", ratio_or_none(*r["share_of_voice"]), hidden=m_hidden)
    sen = _gate(sup, "sentiment", ratio_or_none(*r["sentiment"]), hidden=m_hidden)
    pos = _gate(sup, "position", rank_avg_or_none(*r["position"]), hidden=m_hidden)
    cit = _gate(sup, "citation_share", ratio_or_none(*r["citation_share"]), hidden=c_hidden)

    tgt: Ratio | None = None
    own: Ratio | None = None
    acc: Ratio | None = None
    source: dict[str, Any] | None = None
    without_brand: int | None = None
    url_prompts: UrlPromptCounts | None = None
    if ctx.surface != "website":
        sup["url_prompts"] = "not_website_surface"
    if ctx.surface in URL_SURFACES:
        if c_hidden:
            for k in URL_METRICS:
                sup[k] = "hidden"
            if ctx.surface == "website":
                sup["url_prompts"] = SUPPRESS_HIDDEN
        elif win.empty:
            for k in URL_METRICS:
                sup[k] = "no_data"
            if ctx.surface == "website":
                sup["url_prompts"] = SUPPRESS_NO_DATA
        else:
            uctx, ums, uwin, ulive = ctx, ms, win, [row]
            if url_live:                                                                 # 위 url_live(S4b): URL 인용률 계열만 비카드
                uctx = dataclasses.replace(ctx, card=False, frz_ok=False, frz_keys=None)
                ums, uwin, ulive = uctx.measure(), await uctx.window(conn, offset=cycle_offset, today=today), None
            u = (await url_rates(conn, ums, uwin, brands=ctx.own_brands, countries=ctx.countries, langs=ctx.langs, live=ulive,
                                 prompt_units=ctx.surface == "website", req=ctx.r09))[None]
            source = {"url_rates": u["origin"], "reason": u["reason"], "publications": u["publications"]}
            if u["origin"] == "report":
                source.update(await _publication_marks(conn, uctx, ums, uwin, list(u["publications"]), cell=u))
            tgt = _gate(sup, "target_url_rate", ratio_or_none(*u["target"]), hidden=False)
            own = _gate(sup, "owned_url_rate", ratio_or_none(*u["owned"]), hidden=False)
            acc = _gate(sup, "citation_accuracy", ratio_or_none(*u["accuracy"]), hidden=False)
            if legacy_accuracy(ms):         # 현행 ⑥(web_accuracy_flat, WU-12): 카드·기간 없음 = 유닛 flat 타겟, 그 밖 = 미러 정의(비카드 모수)
                acc_pair = await _accuracy_current(conn, ctx, ms, win, offset=cycle_offset if ctx.date_from is None else 0, today=today)
                sup.pop("citation_accuracy", None)
                acc = _gate(sup, "citation_accuracy", ratio_or_none(*acc_pair), hidden=False)
            if ctx.surface == "website":
                mp, tp, op = u["prompts"]
                url_prompts = UrlPromptCounts(measured_prompts=mp, target_prompts=tp, owned_prompts=op) if mp > 0 else None
                if url_prompts is None:
                    sup["url_prompts"] = SUPPRESS_NO_DATA
    else:
        for k in URL_METRICS:
            sup[k] = "not_website_surface"
    # BG-06: 세 표면 모두(현행 프로젝트 요약 카드 missingPrompts·표준 미언급 = 측정 − 관점 언급)
    if m_hidden:
        sup["prompts_without_brand"] = "hidden"
    elif win.empty or int(row["measured_prompts"]) == 0:
        # M6: 노출 회차 없는 창은 0 이 아니라 null. 창이 있어도 측정 프롬프트 0(필터·스코프로 비었음)이면 null(검증 D3:
        # 현행 scope-aggregates.ts:3344 promptsWithoutBrand = prompts > 0 ? missing : null, mentions-view.tsx:363 '—')
        sup["prompts_without_brand"] = "no_data"
    else:
        without_brand = int(row["measured_prompts"]) - int(row["mentioned_prompts"])
    funnel: list[FunnelPrompts] | None = None
    if by_funnel:
        funnel = [] if m_hidden else await _measured_by_funnel(conn, ctx, ms, win)
        if m_hidden:
            sup["measured_by_funnel"] = SUPPRESS_HIDDEN

    data = SummaryData(
        visibility=vis, share_of_voice=sov, sentiment=sen, position=pos, citation_share=cit,
        target_url_rate=tgt, owned_url_rate=own, citation_accuracy=acc, url_prompts=url_prompts,
        params=SummaryParams(answers=int(row["answers"]), measured_prompts=int(row["measured_prompts"]), applied_prompts=applied,
                             prompts_without_brand=without_brand, measured_by_funnel=funnel),
        analysis_gap=AnalysisGap(gap_answers=int(row["gap_answers"]), base_answers=int(row["gap_base"])),
    )
    if m_hidden:
        sup["analysis_gap"] = "hidden"                   # M6: 언급 숨김 회차만 있는 창의 {0,0} 은 결손 0 이 아니다
    if win.mode == "snapshot" and win.empty:
        sup["*"] = SUPPRESS_NO_SNAPSHOT
    base: Meta = build_meta(mode=win.mode, ctx=ctx, window=win, suppressed=sup)
    base.ignored_filters += ignored_offset(ctx, cycle_offset)
    meta = SummaryMeta(**base.model_dump(exclude={"source"}), source=_source(source))
    return SummaryResponse(data=data, meta=meta)


def catalog_row_gate(ctx: ReadContext, filters: CommonFilters) -> CatalogRowGate:
    """global 미측정 목록의 카탈로그 행 게이트(GET /v1/prompts 와 같은 행 술어: 브랜드 스코프·계정 대상 시장 + 실제로 적용된 택소노미·depth4 축).
    적용 여부 = 준 축이고 ignored 가 아님(core 가 지원 선언 밖 축을 ignored_filters 에 적는다). dropped 값은 사전·행에 없어 맞지 않는다."""
    applied = [a for a in (*TAXONOMY_AXES, DEPTH4_AXIS) if getattr(filters, a) and a not in ctx.ignored_filters]
    return CatalogRowGate(
        countries=ctx.scope.countries, own_brands=tuple(ctx.own_brands),
        umbrella=tuple(br.code for br in ctx.refs.brands if br.is_umbrella),
        taxonomy={a: tuple(getattr(filters, a)) for a in applied if a != DEPTH4_AXIS},
        depth4=tuple(filters.depth4) if DEPTH4_AXIS in applied else (),
    )


async def get_unmeasured(conn: Any, ctx: ReadContext, *, cycle_offset: int, today: date | None,
                         limit: int, filters: CommonFilters) -> Envelope[ListData[UnmeasuredPrompt]]:
    """BG-04: 적용 − 측정 프롬프트 목록(카드와 같은 창·필터·술어). 스냅샷 노출 회차 없음 = '*' no_active_snapshot 빈 목록,
    창의 언급 계열이 전부 숨김 = items hidden 빈 목록(카드 measured 도 숨김이라 "전부 미측정"으로 읽히지 않게)."""
    win: Window = await ctx.window(conn, offset=cycle_offset if ctx.date_from is None else 0, today=today)
    sup: dict[str, str] = {}
    items: list[UnmeasuredPrompt] = []
    total = 0
    if win.mode == "snapshot" and win.empty:
        sup["*"] = SUPPRESS_NO_SNAPSHOT
    elif win.hidden("mentions"):
        sup["items"] = SUPPRESS_HIDDEN
    else:
        pid = ctx.project.project_id if ctx.project is not None else None
        q = unmeasured_sql(ctx.measure(), win, project_id=pid, limit=limit,
                           gate=catalog_row_gate(ctx, filters) if ctx.sf == 1 else None)
        rows = await fetch_all(conn, q.text, q.params)
        total = int(rows[0]["total"]) if rows else 0
        items = [UnmeasuredPrompt(prompt_id=r["prompt_id"], scope_prompt_id=r["scope_prompt_id"], text=r["text"],
                                  list_type=r["list_type"], depth1=r["depth1"], depth2=r["depth2"], funnel_stage=r["funnel_stage"])
                 for r in rows]
    meta = build_meta(mode=win.mode, ctx=ctx, window=win, suppressed=sup, page=Page(limit=limit, total=total))
    meta.ignored_filters += ignored_offset(ctx, cycle_offset)
    return Envelope[ListData[UnmeasuredPrompt]](data=ListData[UnmeasuredPrompt](items=items), meta=meta)
