"""analytics.answers.detail 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

흐름(모듈-답변-드릴다운 §3.2·§6, DECISIONS-API Q4)
1. job_id 로 표면·프로젝트만 찾는다(LOCATE). 없으면 404. surface 질의가 있고 다르면 404.
2. 표면 경로 게이트(역할 × 메뉴 그룹). surface 를 질의로 줬으면 403, 안 줬으면 존재를 드러내지 않게 404.
3. 스코프 = core.filters.resolve_read_context(관점 입력 없이, 접근 범위 계산). 표면별 게이트:
     global  project_key = 루트 ∧ bgrp = ANY(스코프 브랜드 ∪ 엄브렐러 마스크) ∧ geo_key = ANY(허용 국가)
     website project_key = ANY(스코프 사이트)(답변 geo 로 거르지 않는다)
     project resolve_project(멤버 ∨ 스코프 안, 없음·비가시 404)
   brand[](global·website)는 관점(당사 배지·밑줄·스탠스 own) 입력일 뿐 접근 범위를 바꾸지 않는다.
   선택 게이트(화면 BFF 가 게이트한 범위, 없으면 위 계정 스코프만 = 종전): 현행 getMirrorAnswerBody 의 IDOR 게이트와 같은 범위로 더 좁힌다.
     project project_id ≠ 답변 프로젝트(LOCATE) → 404(현행 fetchProjectAnswerBody 의 그 프로젝트 run 소속 게이트, 스코프·멤버십 조회 전)
     global  gate_country[]·gate_brand[] = 같은 resolve_read_context 에 country·brand 로 넣은 교집합(스코프 밖 값은 버림): 답변 geo ∈ 국가,
             bgrp = 그 브랜드 카탈로그 마스크(엄브렐러 제외, 현행 prompts.brand IN f.brand)
     website gate_brand[] = 그 브랜드 사이트 project_key(현행 narrowScopeBrands → website project ids). gate_country 는 쓰지 않는다
             (현행 라우트가 region 을 websiteCountry 로 옮겨 답변 region 게이트가 없다: app/api/scope/answer/route.ts 2026-09-04)
   website 의 당사 비트 = 요청 관점(계정 스코프 ∩ brand[], 없으면 스코프 전체: core ReadContext.own_bits). 목록(analytics.answers.list)과
   같은 규칙이고 현행 front 와 같다(scope-aggregates.ts:7954 trackedEntityIdsFor(contextBrand ?? brand), withWebsite 가 contextBrand =
   스코프 ∩ brand[] 를 넣는다: server.ts:4173-4182). 답변 사이트 브랜드로 고정하던 이전 규칙은 걷었다.
4. 헤더(노출 R03·숨김 all R04·served·스코프, 실패 404) → 번들 1문장 → 서버 계산(감성 span·스탠스 근거 대조·정렬).
5. 언급 계열 숨김(hidden_scope 3)이면 언급·감성·스탠스를, 인용 계열 숨김(2)이면 인용을 비우고 meta.suppressed 에 적는다.
   분석 결손(gap)이면 언급 계열이 비고 사유 analysis_gap. 원문이 없으면(body.available=false) 이하 섹션 전부 빈 값(현행 계약).
   lite 면 모달이 쓰지 않는 값(카탈로그·cycle_id·anchor_date·model_slug·is_rep·acr_iter_rank·인용 owned·target_hit)을 계산하지 않고 null.
6. 응답 후 접근 감사(Q4: 답변 원문 = data_access, core.write.access_audit 비동기 배치).
"""
from __future__ import annotations

import uuid
from typing import Any

from app.core import errors
from app.core.auth import Principal, surface_denial
from app.core.codes import HIDDEN_EXCLUDE, STANCE_CODE, SURFACE_NAME, load_refs
from app.core.config import get_settings
from app.core.db import fetch_all, fetch_one
from app.core.envelope import Envelope, build_meta
from app.core.filters import CommonFilters, FilterSupport, ReadContext, ignored_axes, resolve_read_context
from app.core.write import access_audit
from app.features.analytics.answers.detail import queries as Q
from app.features.analytics.answers.detail.render import (
    OccurrenceInput,
    build_sentiment_spans,
    norm_sentiment,
    verify_stance_evidence,
)
from app.features.analytics.answers.detail.schemas import (
    AnswerDetail,
    AnswerDetailQuery,
    Body,
    BrandMention,
    CatalogInfo,
    Citation,
    Header,
    Mentions,
    ModelMention,
    PromptInfo,
    SentimentBlock,
    SentimentEvidence,
    SentimentSpan,
    Stance,
)

# 상세가 받는 공통 축: global·website 의 brand(관점)만. 그 밖의 공통 축(cf.* = custom, project_id 포함)은 meta.ignored_filters
# (core.filters.ignored_axes, surface 는 이 엔드포인트 자체 파라미터라 축으로 세지 않는다. project 표면의 project_id 는 선택 게이트라 쓴다).
DETAIL_SUPPORT = FilterSupport.of(global_=("brand",), website=("brand",))
# 선택 게이트(gate_country[]·gate_brand[])를 계정 스코프와 교차할 때의 축: global 은 국가·브랜드, website 는 브랜드(사이트)만.
GATE_SUPPORT = FilterSupport.of(global_=("brand", "country"), website=("brand",))


def pick_catalog(entries: list[dict[str, Any]] | None, ctx: ReadContext) -> CatalogInfo | None:
    """프롬프트의 카탈로그 행 중 관점 브랜드 비트 행을 먼저, 없으면 엄브렐러(공통), 없으면 첫 행."""
    if not entries:
        return None
    own = set(ctx.pop_bits)
    pick = next((e for e in entries if int(e["brand_bit"]) in own and int(e["brand_bit"]) != ctx.refs.umbrella_bit), None) \
        or next((e for e in entries if int(e["brand_bit"]) == ctx.refs.umbrella_bit), None) or entries[0]
    return CatalogInfo(brand=ctx.refs.brand_code_of_bit(int(pick["brand_bit"])), presence=pick.get("presence"),
                       list_type=pick.get("list_type"), depth1=pick.get("depth1"), depth2=pick.get("depth2"), depth3=pick.get("depth3"))


def fold_brands(rows: list[dict[str, Any]], own_bits: tuple[int, ...]) -> list[BrandMention]:
    """rd.answer_brand(표시 브랜드 × 경쟁 여부) → 표시명별 합산. rank = 경쟁 행 rk(0 은 순위 없음), own = own_bit ∈ 관점 비트."""
    agg: dict[str, dict[str, Any]] = {}
    for r in rows:
        cur = agg.setdefault(r["name"], {"n": 0, "rank": None, "own": False})
        cur["n"] += int(r["mention_count"] or 0)
        rk = int(r["rk"] or 0)
        if r["competitive"] and rk > 0:
            cur["rank"] = rk if cur["rank"] is None else min(cur["rank"], rk)
        cur["own"] = cur["own"] or int(r["own_bit"] or 0) in own_bits
    out = [BrandMention(name=k, mention_count=v["n"], rank=v["rank"], own=v["own"]) for k, v in agg.items()]
    return sorted(out, key=lambda m: (-m.mention_count, m.name.casefold()))


def fold_models(rows: list[dict[str, Any]]) -> list[ModelMention]:
    """원본 뷰의 비브랜드 엔티티(모델 등). 소속 브랜드 = 롤업 엔티티의 정본 표시명(rd.dim_brand_name), 없으면 같은 답변 브랜드 표기."""
    brand_disp = {r["entity_id"]: r["name"] for r in rows if r.get("entity_type") == "Brand" and r.get("name")}
    out = []
    for r in rows:
        if r.get("entity_type") == "Brand" or not r.get("name"):
            continue
        parent = r.get("rollup_brand") or (brand_disp.get(r["rollup_id"]) if r.get("rollup_id") else None)
        out.append(ModelMention(name=r["name"], mention_count=int(r["mention_count"] or 0), avg_position=r.get("avg_position"),
                                parent_brand=parent))
    return sorted(out, key=lambda m: (-m.mention_count, m.name.casefold()))


def build_sentiment(text: str, occ: list[dict[str, Any]], mention_raw: list[dict[str, Any]], own_bits: tuple[int, ...]) -> SentimentBlock:
    rollup_own = {r["entity_id"]: int(r.get("rollup_own_bit") or 0) for r in mention_raw}
    rollup_brand = {r["entity_id"]: r.get("rollup_brand") for r in mention_raw}
    inputs = []
    for o in occ:
        own = int(o.get("own_bit") or 0) in own_bits or rollup_own.get(o["entity_id"], 0) in own_bits
        inputs.append(OccurrenceInput(
            own=own, brand_name=o.get("brand") or rollup_brand.get(o["entity_id"]),
            source_start=int(o["source_start"]), source_end=int(o["source_end"]), surface_text=o["surface_text"] or "",
            sentiment=norm_sentiment(o.get("sentiment")), assertion=o.get("assertion"), context_snippet=o.get("context_snippet"),
            descriptors=tuple(o.get("descriptors") or ()), criteria=tuple(o.get("criteria") or ()), turn_index=o.get("turn_index")))
    spans, skipped = build_sentiment_spans(text, inputs)
    return SentimentBlock(spans=[SentimentSpan(start=s.start, end=s.end, sentiment=s.sentiment,
                                               evidence=[SentimentEvidence(**e) for e in s.evidence]) for s in spans], skipped=skipped)


def build_stances(text: str | None, rows: list[dict[str, Any]], own_bits: tuple[int, ...]) -> list[Stance]:
    out = []
    for r in rows:
        stance = r.get("stance")
        if stance not in STANCE_CODE:     # 어휘 밖은 버린다(중립 접힘 금지, 현행 F3)
            continue
        ti = int(r["turn_index"] or 0)
        out.append(Stance(
            turn_index=ti, entity_id=r["entity_id"], brand=r.get("brand") or r.get("brand_label") or str(r["entity_id"]),
            own=int(r["own_bit"] or 0) in own_bits, stance=stance, confidence=r.get("confidence"), evidence_text=r.get("evidence_text"),
            evidence_match=verify_stance_evidence(text, ti, r.get("evidence_text"), r.get("evidence_start"), r.get("evidence_end")),
            reason=r.get("reason")))
    return sorted(out, key=lambda s: (s.turn_index, not s.own, s.brand.casefold()))


async def answer_detail(conn: Any, p: Principal, job_id: uuid.UUID, q: AnswerDetailQuery, query_keys: set[str]) -> Envelope[AnswerDetail]:
    if q.surface is not None:
        code = surface_denial(p, q.surface)        # core 표면 경로 게이트(route-policy 표): 표면을 준 요청은 403
        if code is not None:
            raise errors.forbidden("이 표면을 볼 권한 없음", code=code)
    loc = await fetch_one(conn, Q.LOCATE_SQL, {"jid": job_id})
    if loc is None or int(loc["surface"]) not in SURFACE_NAME:
        raise errors.not_found("답변 없음")
    surface = SURFACE_NAME[int(loc["surface"])]
    if q.surface is not None and q.surface != surface:
        raise errors.not_found("답변 없음")
    if surface_denial(p, surface) is not None:   # 표면 없이 부른 답변이 경로 밖 표면이면 404(존재 은폐)
        raise errors.not_found("답변 없음")
    # 선택 게이트 project_id: 화면이 게이트한 프로젝트 밖 답변은 존재를 드러내지 않는다(현행 run 소속 게이트). 스코프·멤버십 조회 전에 끊는다
    if surface == "project" and q.project_id is not None and str(loc["project_id"]) != str(q.project_id):
        raise errors.not_found("답변 없음")

    refs = await load_refs(conn)
    base = CommonFilters(surface=surface, project_id=loc["project_id"] if surface == "project" else None)
    gate = await resolve_read_context(conn, p, base, support=DETAIL_SUPPORT, refs=refs)   # project 비가시·없음 = 404(resolve_project)
    view = gate                                  # 관점(own) 문맥: brand[] 는 접근 게이트(gate)를 바꾸지 않는다
    if surface in ("global", "website") and q.brand:
        view = await resolve_read_context(conn, p, base.model_copy(update={"brand": list(q.brand)}), support=DETAIL_SUPPORT, refs=refs)
    # 선택 게이트 gate_country[](global)·gate_brand[](global·website): 계정 스코프 ∩ 화면 URL 필터(스코프 밖 값은 버림 = 넓어지지 않는다).
    # 없으면 계정 스코프(gate) 그대로(종전).
    hdr = gate
    narrow: dict[str, list[str]] = {}
    if surface in ("global", "website") and q.gate_brand:
        narrow["brand"] = list(q.gate_brand)
    if surface == "global" and q.gate_country:
        narrow["country"] = list(q.gate_country)
    if narrow:
        hdr = await resolve_read_context(conn, p, base.model_copy(update=narrow), support=GATE_SUPPORT, refs=refs)

    hs = Q.header_sql(str(job_id), hdr.project_keys, hdr.bgrps if surface == "global" else None,
                      hdr.geo_keys if surface == "global" else None, lite=q.lite)
    h = await fetch_one(conn, hs.text, hs.params)
    if h is None:
        raise errors.not_found("답변 없음")

    hidden = int(h["hidden_scope"])
    ment_hidden = hidden in HIDDEN_EXCLUDE["mentions"]
    cit_hidden = hidden in HIDDEN_EXCLUDE["citations"]
    x = Q.BundleInput(answer_key=int(h["answer_key"]), sf=int(h["surface"]), project_key=int(h["project_key"]), round_date=h["round_date"],
                      cyc_key=int(h["cyc_key"]), prompt_key=int(h["prompt_key"]), with_catalog=surface == "global" and not q.lite,
                      with_mentions=not ment_hidden, with_citations=not cit_hidden, lite=q.lite)
    bs = Q.bundle_sql(x, view.measure())
    rows = await fetch_all(conn, bs.text, bs.params)
    bd = rows[0]
    ans = bd["answer"] or {}
    body_row = bd["body"] or {}
    text = body_row.get("answer_text")
    available = bool(text)
    gap = bool(ans.get("gap", False))

    engines = {k: code for code, (k, _d) in refs.engines.items()}
    geos = {c.geo_key: c.code for c in refs.countries.values()}
    langs = {k: code for code, k in refs.langs.items()}
    pr = bd["prompt"] or {}
    header = Header(
        surface=surface, cycle_id=h["cycle_id"], round_date=h["round_date"], anchor_date=h["anchor_date"], measured_at=h["measured_at"],
        engine=engines.get(int(h["engine_key"]), ""), country=geos.get(int(h["geo_key"])) or None, lang=langs.get(int(h["lang_key"])) or None,
        prompt=PromptInfo(prompt_id=pr.get("prompt_id"), text=pr.get("text"), funnel=pr.get("funnel"), kind=pr.get("kind") or "single"),
        catalog=pick_catalog(bd["catalog"], view) if surface == "global" else None,
        analysis_state=int(ans.get("analysis_state", 0)), gap=gap, is_acr=bool(ans.get("is_acr", False)),
        is_rep=None if q.lite else bool(ans.get("is_rep", False)), acr_iter_rank=None if q.lite else int(ans.get("acr_iter_rank", 1)),
        model_slug=body_row.get("model_slug"))

    suppressed: dict[str, str] = {}
    mentions = Mentions()
    sentiment = SentimentBlock()
    stances: list[Stance] = []
    citations: list[Citation] = []
    if ment_hidden:
        suppressed["mentions"] = "hidden"
    elif gap:
        suppressed["mentions"] = "analysis_gap"
    if cit_hidden:
        suppressed["citations"] = "hidden"
    # 당사 판정 비트(§3.2 3단계): project = 프로젝트 브랜드(core), global·website = 요청 관점(brand[] ∩ 스코프, 없으면 스코프 전체: view).
    # 목록(analytics.answers.list 의 ctx.own_bits)과 같은 규칙. 인용 owned 는 자사 URL 베이스(owner scope) 판정이라 별개.
    own_bits = view.own_bits
    if available:
        if not ment_hidden and not gap:
            mraw = bd["mention_raw"] or []
            mentions = Mentions(brands=fold_brands(bd["brands"] or [], own_bits), models=fold_models(mraw))
            sentiment = build_sentiment(text, bd["occurrences"] or [], mraw, own_bits)
            stances = build_stances(text, bd["stances"] or [], own_bits)
        if not cit_hidden:
            citations = [Citation(**c) for c in (bd["citations"] or [])]

    data = AnswerDetail(id=h["job_id"], header=header, body=Body(available=available, answer_text=text if available else None),
                        mentions=mentions, sentiment=sentiment, stances=stances, citations=citations)
    meta = build_meta(mode="snapshot", surface=surface, ctx=view, generation=h["generation"], suppressed=suppressed)
    meta.as_of = h["round_date"]
    meta.cycles = [h["round_date"]]
    meta.ignored_filters = ignored_axes(query_keys, DETAIL_SUPPORT, surface,
                                        consumed=("surface", "project_id") if surface == "project" else ("surface",))
    if get_settings().access_audit:
        access_audit(p, "data_access", "answers.detail", target=str(h["job_id"]),
                     detail={"surface": surface, "available": available})
    return Envelope[AnswerDetail](data=data, meta=meta)
