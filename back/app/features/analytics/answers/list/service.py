"""analytics.answers.list 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

흐름(모듈-답변-드릴다운 §3.1, DECISIONS-API Q1·Q19)
1. core.filters.resolve_read_context: 표면 경로 게이트(core.auth.require_surface, route-policy 역할 × 메뉴 그룹) → 스코프 ∩ 요청(default-deny).
2. 창 = core.cycles.resolve_window(함대 스냅샷 | round_date 기간). 기간 모드는 한 페이지가 훑는 창을 92일로 끊어 뒤에서부터 걷는다.
   창 안에서 limit 을 못 채우면 부분 페이지와 창 경계 커서를 돌려준다(빈 날짜 구간은 회차 목록으로 건너뛴다). 이 페이지가 훑은 창 =
   meta.page.window_from·window_to(core envelope.Page).
3. 추가 축(prompt_id·q·mention_brand·domain)은 차원 표에서 키로 풀어 상수 배열로 건다. 모르는 값은 meta.dropped_filters + 빈 결과.
4. 회차 계열: 답변 행 = row({1} 제외), 언급 술어(mention_brand·signal)가 있으면 mentions({1,3} 제외), 인용 술어(domain·source[])가 있으면
   citations({1,2} 제외) 교집합. 행의 mentions·citations 필드는 그 회차가 해당 계열에서 숨김이면 null + meta.suppressed.
   계열 술어 때문에 창의 회차가 전부 빠지면 사유 'hidden', 일부만 빠지면 'partial_hidden'(core envelope.window_suppression(partial=True)).
5. 모수: 기본 std_in, include_gap 이면 cit_in(분석 결손 포함). 인용 술어는 c.cit_in, 언급 술어는 ab.std_in.
6. 키셋 = (round_date, answer_key) 내림차순(core.pagination). 커서 = (창 상한, round_date, answer_key), 필터 해시·세대(409) 대조.
일반 목록 조회라 접근 감사는 남기지 않는다(Q4: 원문을 싣지 않는다).
"""
from __future__ import annotations

import dataclasses
from datetime import date, timedelta
from typing import Any

from app.core.auth import Principal
from app.core.codes import BRAND_OWN_COLS
from app.core.cycles import Window
from app.core.db import fetch_all
from app.core.envelope import SUPPRESS_NO_SNAPSHOT, Envelope, Page, build_meta, window_suppression
from app.core.filters import TAXONOMY_AXES, FilterSupport, ReadContext, resolve_read_context
from app.core.pagination import Cursor, decode_cursor, encode_cursor, fetch_keyset, filter_hash
from app.features.analytics.answers.list import queries as Q
from app.features.analytics.answers.list.schemas import (
    AnswerListData,
    AnswerListQuery,
    AnswerRow,
    BrandSentiment,
    BrandTypes,
    MatchedBrand,
    MatchedDomain,
    OwnMention,
    PromptRef,
    RowCitations,
    RowMentions,
)

# 표면별 지원 축. lang[] 은 website·project 만(global 은 KPI 와 같이 lang 축 없음), 카탈로그 축은 global·project, source[] 는 인용 술어.
LIST_SUPPORT = FilterSupport.of(
    global_=("brand", "country", "engine", "period", *TAXONOMY_AXES, "source"),
    website=("brand", "country", "lang", "engine", "period", "source"),
    project=("country", "lang", "engine", "period", *TAXONOMY_AXES, "source", "custom"),
)
WINDOW_DAYS = 92
SORT = "round_date"
CURSOR_TYPES = ("date", "date", "int4")

def own_mention(r: dict[str, Any], own_bits: tuple[int, ...]) -> OwnMention:
    """관점 비트의 당사 열(ment_*·own_rk_*)에서 언급 수 합과 순위(0 을 뺀 최솟값, 계약 §3 M04)를 고른다."""
    cols = [BRAND_OWN_COLS[b] for b in own_bits if b in BRAND_OWN_COLS]
    cnt = sum(int(r[f"ment_{c}"] or 0) for c in cols)
    ranks = [int(r[f"own_rk_{c}"]) for c in cols if int(r[f"own_rk_{c}"] or 0) > 0]
    return OwnMention(count=cnt, rank=min(ranks) if ranks else None)


def family_hidden_reason(win: Window, family: str) -> str | None:
    """계열 술어가 걸린 목록에서 창의 회차가 그 계열 숨김으로 빠질 때의 억제 사유(D4). 판정은 core envelope.window_suppression
    (전부 숨김 = 'hidden', 일부만 = 'partial_hidden'). 행 회차가 없는 창(전체 숨김뿐)은 행 계열에서 이미 빠져 사유 없음."""
    if not win.cyc_keys("row"):
        return None
    return window_suppression(win, family, partial=True)


def page_window(win: Window, fam: set[int], wh: date | None, *, slice_days: int | None) -> tuple[date, date, tuple[int, ...], bool] | None:
    """이 페이지가 훑을 창. (lo, hi, 회차 키, 창 아래에 더 남은 회차가 있는가). 남은 회차가 없으면 None.
    slice_days=None 이면 창 전체(스냅샷·collapse=cell)."""
    if win.lo is None or win.hi is None:
        return None
    rd_of = {c.cyc_key: c.round_date for c in win.cycles}
    top = win.hi if wh is None else min(wh, win.hi)
    dates = sorted({rd_of[k] for k in fam if k in rd_of and win.lo <= rd_of[k] <= top})
    if not dates:
        return None
    hi = dates[-1]
    lo = win.lo if slice_days is None else max(win.lo, hi - timedelta(days=slice_days - 1))
    keys = tuple(sorted(k for k in fam if k in rd_of and lo <= rd_of[k] <= hi))
    more_below = any(d < lo for d in dates)
    return lo, hi, keys, more_below


def _codes(ctx: ReadContext) -> tuple[dict[int, str], dict[int, str], dict[int, str]]:
    refs = ctx.refs
    engines = {k: code for code, (k, _d) in refs.engines.items()}
    geos = {c.geo_key: c.code for c in refs.countries.values()}
    langs = {k: code for code, k in refs.langs.items()}
    return engines, geos, langs


def _empty(ctx: ReadContext, win: Window | None, q: AnswerListQuery, dropped: dict[str, list[str]],
           suppressed: dict[str, str]) -> Envelope[AnswerListData]:
    meta = build_meta(mode=win.mode if win is not None else ("cumulative" if (q.from_ or q.to) else "snapshot"), window=win, ctx=ctx,
                      suppressed=suppressed, page=Page(next_cursor=None, limit=q.limit))
    for k, v in dropped.items():
        meta.dropped_filters.setdefault(k, []).extend(v)
    return Envelope[AnswerListData](data=AnswerListData(items=[]), meta=meta)


async def list_answers(conn: Any, p: Principal, q: AnswerListQuery, custom: dict[str, list[str]]) -> Envelope[AnswerListData]:
    ctx = await resolve_read_context(conn, p, q, support=LIST_SUPPORT, custom_fields=custom)
    win = await ctx.window(conn)
    fh = filter_hash({"q": q.model_dump(mode="json", exclude={"cursor", "limit"}), "cf": custom})
    cur = decode_cursor(q.cursor, sort=SORT, dir="desc", fh=fh, types=CURSOR_TYPES, generation=win.generation)

    dropped: dict[str, list[str]] = {}
    suppressed: dict[str, str] = {}
    if win.empty:
        if win.mode == "snapshot":
            suppressed["*"] = SUPPRESS_NO_SNAPSHOT
        return _empty(ctx, win, q, dropped, suppressed)

    # ── 추가 축 → 키 ──
    prompt_keys = ctx.prompt_keys
    q_pattern = None
    empty = False
    if q.prompt_id is not None:
        rs = await fetch_all(conn, Q.RESOLVE_PROMPT_SQL, {"pid": q.prompt_id, "sf": ctx.sf, "pks": list(ctx.project_keys)})
        pk = {int(r["prompt_key"]) for r in rs}
        if not pk:
            dropped["prompt_id"] = [str(q.prompt_id)]
            empty = True
        prompt_keys = tuple(sorted(pk if prompt_keys is None else pk & set(prompt_keys)))
    if q.q is not None and not empty:
        pat = Q.like_pattern(q.q)
        rs = await fetch_all(conn, Q.SEARCH_PROMPT_SQL, {"sf": ctx.sf, "pks": list(ctx.project_keys), "pat": pat, "cap": Q.Q_KEYS_CAP + 1})
        if len(rs) > Q.Q_KEYS_CAP:
            q_pattern = pat                      # 상수 배열 상한 초과 → 차원 semi-join
        else:
            qk = {int(r["prompt_key"]) for r in rs}
            prompt_keys = tuple(sorted(qk if prompt_keys is None else qk & set(prompt_keys)))
    brand_key = brand_name = None
    if q.mention_brand is not None:
        r = (await fetch_all(conn, Q.RESOLVE_BRAND_SQL, {"n": q.mention_brand}))
        if not r:
            dropped["mention_brand"] = [q.mention_brand]
            empty = True
        else:
            brand_key, brand_name = int(r[0]["brand_key"]), r[0]["name"]
    source_keys = None
    domain_norm = None
    if q.domain is not None:
        domain_norm = Q.normalize_domain(q.domain)
        rs = await fetch_all(conn, Q.RESOLVE_DOMAIN_SQL, {"d": domain_norm})
        source_keys = tuple(int(r["source_key"]) for r in rs)
        if not source_keys:
            dropped["domain"] = [q.domain]
            empty = True
    category_keys = ctx.source_category_keys
    if category_keys == () or prompt_keys == ():
        empty = True
    if empty:
        return _empty(ctx, win, q, dropped, suppressed)

    ms = dataclasses.replace(ctx.measure(), prompt_keys=prompt_keys)
    signal_col = Q.SIGNAL_COLUMNS[q.signal] if q.signal is not None else None
    has_ment = brand_key is not None or signal_col is not None
    has_cit = source_keys is not None or category_keys is not None

    # ── 계열 교집합 → 이 페이지 창 ──
    fam = set(win.cyc_keys("row"))
    if has_ment:
        fam &= set(win.cyc_keys("mentions"))
    if has_cit:
        fam &= set(win.cyc_keys("citations"))
    for flag, family in ((has_ment, "mentions"), (has_cit, "citations")):
        if flag and (why := family_hidden_reason(win, family)):
            suppressed[family] = why
    cell = q.collapse == "cell"
    wh = cur.key[0] if cur is not None else None
    slice_days = WINDOW_DAYS if (win.mode == "cumulative" and not cell) else None
    pw = page_window(win, fam, wh, slice_days=slice_days)
    if pw is None:
        return _empty(ctx, win, q, dropped, suppressed)
    lo, hi, keys, more_below = pw
    sub = dataclasses.replace(win, lo=lo, hi=hi)
    plan = Q.ListPlan(ms=ms, keys=keys, include_gap=q.include_gap, own_bits=ctx.own_bits, limit=q.limit, q_pattern=q_pattern,
                      mention_brand_key=brand_key, signal_col=signal_col, source_keys=source_keys, category_keys=category_keys,
                      cursor_key=(cur.key[1], cur.key[2]) if cur is not None else None, collapse_cell=cell)
    sql = Q.list_sql(plan, sub)
    rows = await fetch_keyset(conn, sql.text, sql.params, cursor=cur)
    has_more = len(rows) > q.limit
    page = rows[: q.limit]
    nxt = None
    if has_more and page:
        last = page[-1]
        nxt = encode_cursor(Cursor(sort=SORT, dir="desc", key=(hi, last["round_date"], int(last["answer_key"])), fh=fh, g=win.generation))
    elif more_below and slice_days is not None:
        nxt = encode_cursor(Cursor(sort=SORT, dir="desc", key=(lo - timedelta(days=1), lo, 0), fh=fh, g=win.generation))

    # ── 페이지 2차 소형 조회(matched_brand·matched_domain) ──
    aks = [int(r["answer_key"]) for r in page]
    mb: dict[int, dict[str, Any]] = {}
    md: dict[int, int] = {}
    if page and brand_key is not None:
        s = Q.matched_brand_sql(sub, keys, aks, lo, hi, brand_key, ms=plan.ms)
        mb = Q.fold_matched_brand(await fetch_all(conn, s.text, s.params))
    if page and source_keys is not None:
        s = Q.matched_domain_sql(sub, keys, aks, lo, hi, source_keys, ms=plan.ms)
        md = {int(r["answer_key"]): int(r["n"]) for r in await fetch_all(conn, s.text, s.params)}

    engines, geos, langs = _codes(ctx)
    ment_ok = set(win.cyc_keys("mentions"))
    cit_ok = set(win.cyc_keys("citations"))
    items: list[AnswerRow] = []
    for r in page:
        ak = int(r["answer_key"])
        ck = int(r["cyc_key"])
        mentions = None
        if ck not in ment_ok:
            suppressed.setdefault("mentions", "hidden")
        elif not r["gap"]:
            mentions = RowMentions(total=int(r["ment_total"]), own=own_mention(r, ctx.own_bits))
        citations = None
        if ck not in cit_ok:
            suppressed.setdefault("citations", "hidden")
        else:
            citations = RowCitations(has_cit=r["has_cit"], tgt_cited=r["tgt_cited"], own_url_cited=r["own_url_cited"])
        matched_brand = None
        if brand_key is not None and ak in mb:
            m = mb[ak]
            matched_brand = MatchedBrand(
                name=brand_name, mention_count=m["mention_count"], rank=m["rank"],  # type: ignore[arg-type]
                sentiment=BrandSentiment(pos=m["s_pos"], neu=m["s_neu"], neg=m["s_neg"], mix=m["s_mix"]),
                types=BrandTypes(mention=m["t_mention"], recommendation=m["t_recommendation"], comparison=m["t_comparison"],
                                 definition=m["t_definition"], final_choice=m["t_final_choice"]))
        matched_domain = MatchedDomain(domain=domain_norm, citations=md.get(ak, 0)) if domain_norm is not None else None
        items.append(AnswerRow(
            id=r["job_id"], round_date=r["round_date"], anchor_date=r["anchor_date"], measured_at=r["measured_at"],
            prompt=PromptRef(prompt_id=r["prompt_id"], text=r["prompt_text"]),
            engine=engines.get(int(r["engine_key"]), ""), country=geos.get(int(r["geo_key"])) or None,
            lang=langs.get(int(r["lang_key"])) or None, is_rep=r["is_rep"], is_acr=r["is_acr"],
            acr_iter_rank=int(r["acr_iter_rank"]), gap=r["gap"], mentions=mentions, citations=citations,
            matched_brand=matched_brand, matched_domain=matched_domain, runs=int(r["runs"]) if r["runs"] is not None else None))

    meta = build_meta(mode=win.mode, window=win, ctx=ctx, suppressed=suppressed,
                      page=Page(next_cursor=nxt, limit=q.limit, window_from=lo, window_to=hi))
    for k, v in dropped.items():
        meta.dropped_filters.setdefault(k, []).extend(v)
    return Envelope[AnswerListData](data=AnswerListData(items=items), meta=meta)
