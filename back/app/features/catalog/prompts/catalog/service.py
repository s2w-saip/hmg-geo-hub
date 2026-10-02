"""catalog.prompts.catalog 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

흐름: 라우트 게이트(표면별 역할 ∧ 메뉴 그룹) → resolve_read_context(스코프 ∩ 요청, dropped·ignored) → 표면별 조회 → 봉투·내보내기.
- global : app.prompt 루트 카탈로그. 스코프 = 브랜드 ∪ 엄브렐러·NULL, 대상 시장 3분기(B1). 키셋(depth1..3, text, prompt_id), Q19.
- website: app.website_site(스코프: 사이트 브랜드 비트 ∈ ReadContext.bgrps, DataScope.site_allowed, 요청 국가 축은 ReadContext.website_site_ok
           행 필터: ISO ∪ 가상 브랜드 합집합) ⋈ app.website_prompt. 사이트 해석은 카탈로그 전용(app.website_site 기준, catalog #10 처분).
           측정 메타 = rd.answer(surface 2) 원시 카운트, 게이트 없는 측정 회차 전부(발행·노출일·숨김 무관, 현행 패리티 catalog #11).
           정렬이 측정 메타(answers·last_measured)면 모양 B(전 범위 집계 후 키셋), 아니면 모양 A(행 키셋 후 페이지 키만 집계).
- csv·xlsx: 같은 필터·정렬, 상한 50,000(초과 시 X-Export-Truncated), 다운로드 접근 감사(Q4 kind download).
  columns=screen(website 전용, BG-35) = 현행 화면 파일 모양(8열·locale 라벨·표시명, screen_export).
- global all=true(BG-34) = 전량 모드: 같은 키셋 한 페이지를 상한 GLOBAL_ALL_MAX 까지(넘으면 next_cursor 로 이어 받는다).
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi.responses import Response

from app.core import errors
from app.core.auth import Principal, check_menu_group, check_role
from app.core.codes import Refs, load_refs
from app.core.cycles import Window, resolve_window
from app.core.db import fetch_all, fetch_val
from app.core.envelope import Envelope, ListData, Page, build_meta
from app.core.export import export_response
from app.core.filters import (
    DEPTH4_AXIS,
    TAXONOMY_AXES,
    FilterSupport,
    ReadContext,
    catalog_brand_scope,
    catalog_market_filter,
    catalog_market_scope,
    resolve_read_context,
    split_geo_pseudo,
)
from app.core.pagination import clamp_limit, decode_cursor, fetch_keyset, filter_hash, keyset_page, keyset_predicate
from app.core.sqlb import Binder
from app.core.write import access_audit
from app.features.catalog.prompts.catalog import queries as Q
from app.features.catalog.prompts.catalog import screen_export as SX
from app.features.catalog.prompts.catalog.schemas import (
    GLOBAL_COLUMNS,
    WEBSITE_COLUMNS,
    CatalogQuery,
    GlobalPromptRow,
    WebsitePromptRow,
)

# 라우트 게이트(route-policy.ts:28·32): 표준 = 내부 4역할 ∧ 메뉴 standard, 웹사이트 = + website 역할 ∧ 메뉴 website. vendor 는 둘 다 403.
STANDARD_ROLES = ("hq", "region", "country", "admin")
WEBSITE_ROLES = (*STANDARD_ROLES, "website")

# 표면별 지원 축(모듈-프롬프트.md 2-1). engine·from·to 는 website 측정 렌즈(행을 거르지 않는다), global 은 ignored.
# depth4 는 global 전용 모듈 인자(_global_where 가 app.prompt.depth4 로 직접 비교). 공통 축이 된 뒤(BG-03) core 가 비선언 축을 ignored 로
# 적으므로 global 에 선언해 "적용했는데 ignored" 이중 표식을 막는다(bg-kpi-filters 검증 D2). website 는 종전처럼 ignored.
CATALOG_SUPPORT = FilterSupport.of(
    global_=("brand", "country", "lang", *TAXONOMY_AXES, DEPTH4_AXIS),
    website=("brand", "country", "lang", "engine", "period"),
)
_TAX_COL = {"funnel": "p.funnel_stage", "list_type": "p.list_type", "depth1": "p.depth1", "depth2": "p.depth2", "depth3": "p.depth3"}
WEBSITE_LIMIT_MAX = 200
GLOBAL_LIMIT_DEFAULT = 500
# 전량 모드(all=true) 한 응답 상한(BG-34). 현행 2,431행(front website/prompts/page.tsx:36 주석 시점)·10배 약 2.4만 행을 한 번에 담는다.
# 무상한 금지(1초 목표·응답 크기): 넘으면 keyset 과 같은 next_cursor 로 이어 받는다. EXPLAIN 근거는 README '구현 요약'.
GLOBAL_ALL_MAX = 25_000

CatalogEnvelope = Envelope[ListData[GlobalPromptRow | WebsitePromptRow]]


def check_route(p: Principal, surface: str) -> None:
    """표면별 라우트 게이트(core.auth.check_role·check_menu_group: require_* 와 같은 판정·코드). 표면이 쿼리 값이라 라우터 dependencies= 로 못 건다."""
    if surface == "website":
        check_role(p, *WEBSITE_ROLES)
        check_menu_group(p, "website")
    else:
        check_role(p, *STANDARD_ROLES)
        check_menu_group(p, "standard")


def umbrella_codes(refs: Refs) -> list[str]:
    return [b.code for b in refs.brands if b.is_umbrella]


def _fh(q: CatalogQuery) -> str:
    # 페이지 크기·출력 모양 파라미터(all·columns·locale)는 행 집합·정렬을 바꾸지 않으므로 해시에서 뺀다(추가 전 커서와 해시가 같다)
    return filter_hash(q.model_dump(mode="json", exclude={"cursor", "limit", "format", "all", "columns", "locale"}))


def _module_ignored(q: CatalogQuery) -> list[str]:
    """CommonFilters 밖 모듈 파라미터 중 이 표면이 쓰지 않는 것(조용히 무시하지 않고 meta.ignored_filters 에 드러낸다).
    공통 축(global 의 project_id 포함)은 core resolve_read_context 가 ReadContext.ignored_filters 로 센다."""
    # locale 은 columns=screen 내보내기만 쓴다. 그 밖(json 목록 포함)은 무시하고 드러낸다(검증 m4: front 링크가 늘 싣는 값, 추가 전 200 보존)
    loc = ["locale"] if q.locale is not None and q.columns != "screen" else []
    if q.surface == "global":
        # 전량 모드(all=true)는 limit 을 쓰지 않는다: 준 limit 은 형식만 검증(clamp_limit 422)하고 여기서 드러낸다(검증 m-1)
        return [n for n in ("sort", "dir") if getattr(q, n) is not None] + (["limit"] if q.all and q.limit is not None else []) + loc
    return [n for n in ("kind", "depth4", "all") if getattr(q, n)] + loc


async def list_catalog(conn: Any, p: Principal, q: CatalogQuery) -> CatalogEnvelope | Response:
    check_route(p, q.surface)
    refs = await load_refs(conn)
    # website 의 project_id(사이트 좁히기)는 core 에 넘기지 않는다: core 는 사이트를 rd.dim_project(측정 이력이 있는 사이트, 분석용)로
    # 해석해 카탈로그에 보이는 미측정 사이트를 404 로 막는다(검증 D7). 카탈로그 전용 해석(catalog #10 처분: core 이관 기각)으로
    # _scoped_sites 가 같은 스코프(ReadContext.bgrps·스코프 국가) 안에서 app.website_site 로 풀고, 스코프 밖·없는 사이트는 404(N1: 요청 국가는 행 필터).
    # 택소노미 축은 rd.dim_taxon 사전으로 풀지 않는다(catalog #8: app.prompt 열 값 그대로, front prompt-list-readonly.tsx:172-182).
    cq = q.model_copy(update={"project_id": None}) if q.surface == "website" and q.project_id is not None else q
    pseudo: list[str] = []
    real_given = bool(q.country)
    if q.surface == "global" and q.country:
        # catalog #7(메인 결정 = front 현행): 지리 의사 시장 코드(x:WW·x:EU·x:ME)는 국가가 아니라 시장 필터 값이다(스코프 검사 없음, 정확 매칭).
        rest, pseudo = split_geo_pseudo(q.country)
        real_given = bool(rest)
        cq = cq.model_copy(update={"country": rest})
    ctx = await resolve_read_context(conn, p, cq, support=CATALOG_SUPPORT, refs=refs, resolve_taxonomy=False)
    if q.surface == "global":
        return await _global(conn, p, q, ctx, pseudo, real_given)
    return await _website(conn, p, q, ctx)


def _meta(q: CatalogQuery, ctx: ReadContext, *, generation: int | None, page: Page | None) -> Any:
    m = build_meta(mode="catalog", surface=q.surface, ctx=ctx, generation=generation, page=page)
    m.ignored_filters = sorted(set(m.ignored_filters) | set(_module_ignored(q)))
    return m


def _audit_export(p: Principal, q: CatalogQuery, n: int, truncated: bool) -> None:
    detail: dict[str, Any] = {"format": q.format, "rows": n, "truncated": truncated, "fh": _fh(q)}
    if q.columns != "api":
        detail |= {"columns": q.columns, "locale": q.locale or SX.DEFAULT_LOCALE}
    access_audit(p, "download", "catalog.prompts.export", target=q.surface, detail=detail)


def _export(p: Principal, q: CatalogQuery, columns: tuple[str, ...], rows: list[dict[str, Any]], truncated: bool) -> Response:
    _audit_export(p, q, len(rows), truncated)
    return export_response(q.format, columns, rows, basename=f"prompts-{q.surface}", truncated=truncated, sheet="prompts")


# ════════════════════════════════════════════════════════════════════════════
# 글로벌
# ════════════════════════════════════════════════════════════════════════════
def _global_where(q: CatalogQuery, ctx: ReadContext, root: uuid.UUID, b: Binder, presence_sql: str,
                  pseudo: list[str] | None = None, real_given: bool = True) -> list[str]:
    sup = CATALOG_SUPPORT.for_surface("global")
    given = q.provided()
    where = [f"p.project_id = {b.v(root, 'uuid')}", "p.deleted_at IS NULL",
             catalog_brand_scope("p", ctx.own_brands, umbrella_codes(ctx.refs), b)]
    ms = catalog_market_scope("p", ctx.scope.countries, b)
    if ms:
        where.append(ms)
    if "country" in given and "country" in sup:
        # 실국가(스코프 교집합, core) ∪ 지리 의사 시장 코드(요청 그대로). 실국가를 안 줬으면 ctx.countries 는 스코프라 쓰지 않는다
        real = (ctx.countries or ()) if real_given else ()
        where.append(catalog_market_filter("p", [*real, *(pseudo or ())], b))
    if ctx.langs is not None:
        where.append(f"lower(p.lang) = ANY({b.v(list(ctx.langs), 'text[]')})")
    for axis in TAXONOMY_AXES:                 # 요청 값을 app.prompt 열에 그대로(사전 밖 값도 dropped 없이 비교: 미발행 행 전용 값 매칭)
        if axis in given and axis in sup:
            col = presence_sql if axis == "brand_presence" else _TAX_COL[axis]
            where.append(f"{col} = ANY({b.v(sorted(set(getattr(q, axis))), 'text[]')})")
    if q.depth4:
        where.append(f"p.depth4 = ANY({b.v(sorted(set(q.depth4)), 'text[]')})")
    if q.kind:
        where.append(f"p.kind = ANY({b.v(sorted(set(q.kind)), 'text[]')})")
    if q.measured is not None:
        where.append("p.scope_prompt_id IS NOT NULL" if q.measured else "p.scope_prompt_id IS NULL")
    if q.search:
        where.append(f"p.text ILIKE {b.v(Q.like_pattern(q.search))}")
    return where


def _global_row(r: dict[str, Any]) -> GlobalPromptRow:
    return GlobalPromptRow(**{k: r[k] for k in GLOBAL_COLUMNS})


def _global_key(r: dict[str, Any]) -> tuple[Any, ...]:
    return (r["k1n"], r["k1"], r["k2n"], r["k2"], r["k3n"], r["k3"], r["kt"], r["prompt_id"])


async def _global(conn: Any, p: Principal, q: CatalogQuery, ctx: ReadContext, pseudo: list[str] | None = None,
                  real_given: bool = True) -> CatalogEnvelope | Response:
    root = await fetch_val(conn, Q.ROOT_PROJECT_SQL)
    if root is None:
        raise errors.not_found("표준 루트 카탈로그 없음")
    b = Binder()
    presence_sql = Q.presence_effective("p", umbrella_codes(ctx.refs), b)
    where = _global_where(q, ctx, root, b, presence_sql, pseudo, real_given)
    if q.format != "json":
        rows = await fetch_all(conn, Q.global_select(where, presence_sql) + f" LIMIT {b.v(Q.EXPORT_MAX_ROWS + 1)}", b.params)
        truncated = len(rows) > Q.EXPORT_MAX_ROWS
        return _export(p, q, GLOBAL_COLUMNS, [_global_row(r).model_dump() for r in rows[: Q.EXPORT_MAX_ROWS]], truncated)
    # limit 형식(1~500)은 전량 모드에서도 검증한다(-5·501 은 422, 검증 m-1). 전량 모드는 그 값을 쓰지 않고 상한 고정 + meta.ignored_filters
    limit = clamp_limit(q.limit, GLOBAL_LIMIT_DEFAULT)
    if q.all:
        limit = GLOBAL_ALL_MAX
    fh = _fh(q)
    cur = decode_cursor(q.cursor, sort="catalog", dir="asc", fh=fh, types=Q.GLOBAL_SORT_TYPES)
    total = int(await fetch_val(conn, Q.global_count(where), b.params) or 0)
    pred = keyset_predicate(Q.GLOBAL_SORT_COLS, "asc", cur, b)
    page_where = [*where, pred] if pred else where
    rows = await fetch_keyset(conn, Q.global_select(page_where, presence_sql) + f" LIMIT {b.v(limit + 1)}", b.params, cursor=cur)
    page, nxt = keyset_page(rows, limit, _global_key, sort="catalog", dir="asc", fh=fh)
    return CatalogEnvelope(data=ListData(items=[_global_row(r) for r in page]),
                           meta=_meta(q, ctx, generation=None, page=Page(next_cursor=nxt, limit=limit, total=total)))


# ════════════════════════════════════════════════════════════════════════════
# 웹사이트
# ════════════════════════════════════════════════════════════════════════════
async def _scoped_sites(conn: Any, q: CatalogQuery, ctx: ReadContext) -> list[dict[str, Any]]:
    """스코프·요청(브랜드·국가·사이트)을 통과한 사이트(10배 약 1,280행). 브랜드 = 사이트 브랜드 비트 ∈ bgrps(가상 브랜드 코드 반영).
    카탈로그 전용 해석(app.website_site 기준, 측정 이력 없는 사이트 포함): catalog #10 처분(core 는 분석용 측정 이력 기준이라 이관 기각).

    404 판정(project_id)은 스코프만으로 한다: 브랜드 bgrps + 스코프 국가(ctx.scope.site_allowed: country_code ∈ 스코프 실 코드 ∨ 사이트
    브랜드 ∈ 스코프 브랜드 가상 코드, 현행 websiteScopeCountryCondition, 동기화 S1 BE-8 = 현대 N 계정은 현대 N 사이트). 요청 국가 축은 사이트를
    해석한 뒤 ReadContext.website_site_ok(국가, 사이트 브랜드 비트) 행 필터로 건다(ISO ∪ 가상 브랜드 합집합, front websiteSiteGeoPred, catalog #9).
    스코프 안 사이트와 요청 국가가 어긋나면 200 빈 목록이다(검증 catalog N1: 요청 국가까지 404 판정에 섞이면 '스코프 밖·없는 사이트'
    와 같은 404 가 났다)."""
    sql = Q.WEBSITE_SITES_SQL
    params: dict[str, Any] = {"bits": list(ctx.bgrps or ())}
    if q.project_id is not None:                # 사이트 id 또는 그 사이트의 Scope 프로젝트 id(core 해석과 같은 두 형태)
        sql += " AND (ws.site_id = CAST(:sid AS uuid) OR ws.scope_project_id = CAST(:sid AS uuid))"
        params["sid"] = str(q.project_id)
    rows = [r for r in await fetch_all(conn, sql, params)
            if ctx.scope.site_allowed(ctx.refs, int(r["brand_bit"]), r["country_code"])]
    if q.project_id is not None and not rows:
        raise errors.not_found("사이트 없음")
    return [r for r in rows if ctx.website_site_ok(r["country_code"], int(r["brand_bit"]))]


def _site_project_keys(refs: Refs, site_ids: set[str]) -> tuple[int, ...]:
    return tuple(sorted({d.project_key for d in refs.projects if d.surface == 2 and d.site_id and str(d.site_id) in site_ids}))


async def _lens_window(conn: Any, ctx: ReadContext, project_keys: tuple[int, ...]) -> Window:
    """측정 렌즈 창(현행 패리티, catalog #11: front website-sites.ts:386-407 websitePromptLens 는 앵커 축 기본 off 에서 발행·노출일·숨김
    게이트 없이 a.status = completed + 기간만 건다). 요청 from/to(round_date) 가 있으면 그 기간, 없으면 측정 회차 전부(all_visible:
    lo·hi = 실제 회차 최소·최대라 파티션 가지치기가 된다). ungated = 발행(servable)·노출일 게이트 없음, 숨김은 lens_cte 가
    Window.all_keys() 로 무시한다."""
    return await resolve_window(conn, surface="website", project_keys=project_keys, date_from=ctx.date_from, date_to=ctx.date_to,
                                all_visible=True, ungated=True)


def _website_row_where(ctx: ReadContext, q: CatalogQuery, b: Binder) -> list[str]:
    w: list[str] = []
    if ctx.langs is not None:
        w.append(f"lower(wp.lang_code) = ANY({b.v(list(ctx.langs), 'text[]')})")
    if q.measured is not None:
        w.append("wp.scope_prompt_id IS NOT NULL" if q.measured else "wp.scope_prompt_id IS NULL")
    if q.search:
        pat = b.v(Q.like_pattern(q.search))
        w.append(f"(wp.prompt_text ILIKE {pat} OR wp.target_url ILIKE {pat})")
    return w


def _website_row(r: dict[str, Any], meta: dict[str, Any] | None, engine_code: dict[int, str]) -> WebsitePromptRow:
    m = meta if meta is not None else r
    keys = m.get("engine_keys") or []
    return WebsitePromptRow(
        website_prompt_id=r["website_prompt_id"], prompt_text=r["prompt_text"], brand_code=r["brand_code"],
        country_code=r["country_code"], lang_code=r["lang_code"], target_url=r["target_url"], domain=r["domain"],
        owned_base_url=r["owned_base_url"], scope_prompt_id=r["scope_prompt_id"], measured=r["scope_prompt_id"] is not None,
        answers=int(m.get("answers") or 0), last_measured=m.get("last_rd"),
        engines=sorted(engine_code[k] for k in keys if k in engine_code))


def _website_key(r: dict[str, Any]) -> tuple[Any, ...]:
    return (r["sn"], r["sk"], r["website_prompt_id"])


async def _website(conn: Any, p: Principal, q: CatalogQuery, ctx: ReadContext) -> CatalogEnvelope | Response:
    engine_code = {k: code for code, (k, _) in ctx.refs.engines.items()}
    sites = await _scoped_sites(conn, q, ctx)
    site_ids = [str(s["site_id"]) for s in sites]
    sort_name = q.sort or "last_measured"
    direction = q.dir or "desc"
    spec = Q.WEBSITE_SORTS[sort_name]
    d = direction.upper()
    order = ", ".join(f"{c} {d}" for c in Q.WEBSITE_KEY_COLS)

    b = Binder()
    rows_cte = Q.website_rows_cte(_website_row_where(ctx, q, b), b, site_ids)

    if q.format != "json":
        win = await _lens_window(conn, ctx, _site_project_keys(ctx.refs, set(site_ids)))
        inner = Q.website_joined(rows_cte, Q.lens_cte(win, b, ctx.engine_keys), spec, direction)
        # 내보내기는 키셋이 아니므로 동점을 명세·현행 파일과 같게 website_prompt_id ASC 로 가른다
        # (front website-sites.ts:500-504 '정렬식 dir NULLS LAST, wp.id ASC', 검증 m1). 키셋 목록 경로는 README 다른 점 2(같은 방향).
        export_order = f"{Q.WEBSITE_KEY_COLS[0]} {d}, {Q.WEBSITE_KEY_COLS[1]} {d}, {Q.WEBSITE_KEY_COLS[2]} ASC"
        sql = f"SELECT z.* FROM ({inner}) z ORDER BY {export_order} LIMIT {b.v(Q.EXPORT_MAX_ROWS + 1)}"
        rows = await fetch_all(conn, sql, b.params)
        truncated = len(rows) > Q.EXPORT_MAX_ROWS
        out = [_website_row(r, None, engine_code).model_dump() for r in rows[: Q.EXPORT_MAX_ROWS]]
        if q.columns == "screen":
            _audit_export(p, q, len(out), truncated)
            return SX.screen_response(q.format, out, q.locale or SX.DEFAULT_LOCALE, truncated=truncated)
        return _export(p, q, WEBSITE_COLUMNS, out, truncated)

    limit = clamp_limit(q.limit, 50)
    if limit > WEBSITE_LIMIT_MAX:
        raise errors.unprocessable(f"website limit 은 1~{WEBSITE_LIMIT_MAX}", details={"field": "limit"})
    fh = _fh(q)
    total = int(await fetch_val(conn, Q.website_count(rows_cte), b.params) or 0)

    if spec.aggregate:
        # 모양 B: 렌즈 창의 측정 회차 전부를 prompt_key 로 해시 집계한 뒤 파생 정렬 키로 키셋. 세대가 바뀌면 순위가 흔들리므로 커서에 세대를 싣는다.
        win = await _lens_window(conn, ctx, _site_project_keys(ctx.refs, set(site_ids)))
        gen = win.generation
        cur = decode_cursor(q.cursor, sort=sort_name, dir=direction, fh=fh, types=spec.key_types(), generation=gen)
        inner = Q.website_joined(rows_cte, Q.lens_cte(win, b, ctx.engine_keys), spec, direction)
        pred = keyset_predicate(Q.WEBSITE_KEY_COLS, direction, cur, b)
        sql = (f"SELECT z.* FROM ({inner}) z" + (f" WHERE {pred}" if pred else "")
               + f" ORDER BY {order} LIMIT {b.v(limit + 1)}")
        rows = await fetch_keyset(conn, sql, b.params, cursor=cur)
        page, nxt = keyset_page(rows, limit, _website_key, sort=sort_name, dir=direction, fh=fh, generation=gen)
        items = [_website_row(r, None, engine_code) for r in page]
    else:
        # 모양 A: 카탈로그 네이티브 열로 행을 먼저 자르고, 그 페이지의 prompt_key 만 측정 메타를 집계한다.
        cur = decode_cursor(q.cursor, sort=sort_name, dir=direction, fh=fh, types=spec.key_types())
        inner = Q.website_rows_only(rows_cte, spec, direction)
        pred = keyset_predicate(Q.WEBSITE_KEY_COLS, direction, cur, b)
        sql = (f"SELECT z.* FROM ({inner}) z" + (f" WHERE {pred}" if pred else "")
               + f" ORDER BY {order} LIMIT {b.v(limit + 1)}")
        rows = await fetch_keyset(conn, sql, b.params, cursor=cur)
        page, nxt = keyset_page(rows, limit, _website_key, sort=sort_name, dir=direction, fh=fh)
        win = await _lens_window(conn, ctx, _site_project_keys(ctx.refs, {str(r["site_id"]) for r in page}))
        gen = win.generation
        metas = await _page_meta(conn, ctx, win, page)
        items = [_website_row(r, metas.get(r["scope_prompt_id"], {}), engine_code) for r in page]
    return CatalogEnvelope(data=ListData(items=items),
                           meta=_meta(q, ctx, generation=gen, page=Page(next_cursor=nxt, limit=limit, total=total)))


async def _page_meta(conn: Any, ctx: ReadContext, win: Window, page: list[dict[str, Any]]) -> dict[Any, dict[str, Any]]:
    """페이지 행(≤200)의 scope_prompt_id → prompt_key → 측정 메타(answer_prompt_idx 탐침)."""
    ids = sorted({str(r["scope_prompt_id"]) for r in page if r["scope_prompt_id"] is not None})
    if not ids or Q.lens_empty(win):
        return {}
    keymap = {int(r["prompt_key"]): r["prompt_id"] for r in await fetch_all(conn, Q.PAGE_PROMPT_KEYS_SQL, {"ids": ids})}
    if not keymap:
        return {}
    b = Binder()
    rows = await fetch_all(conn, Q.website_page_meta(Q.lens_cte(win, b, ctx.engine_keys, prompt_keys=sorted(keymap))), b.params)
    return {keymap[int(r["prompt_key"])]: r for r in rows}
