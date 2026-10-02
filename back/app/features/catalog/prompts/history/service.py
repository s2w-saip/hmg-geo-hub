"""catalog.prompts.history 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

- 라우트 게이트: 표준 카탈로그와 같다(hq·region·country·admin ∧ 메뉴 standard, vendor·website 역할 403).
  관리 카탈로그 타임라인(list_prompt_timeline_admin, U8-7)만 admin ∧ 메뉴 admin(라우터)이고 표준 메뉴 게이트를 걸지 않는다.
- 스코프: 카탈로그(P-1)와 같은 술어 한 벌(core.filters catalog_*: 브랜드 ∪ 엄브렐러·NULL, 대상 시장 3분기 B1). 스코프가 전체가 아니거나 brand·country 를
  요청하면 app.prompt 행이 없는 감사 행(하드 삭제 이력)은 브랜드·시장을 판정할 수 없어 뺀다(fail-closed: changes 에 옛 본문이 들어 있다).
- prompt_id 타임라인도 같은 스코프(현행 listForPrompt 의 스코프 미적용 결함 해소). 스코프 밖이면 빈 목록 + meta.dropped_filters.prompt_id.
- 기간: created_at 의 KST 달력일 [from, to]. 기본 from = 오늘(KST) - 90일(현행 AUDIT_WINDOW_DAYS), to 없음.
- 키셋 (created_at DESC, audit_id DESC). csv 는 상한 5,000(X-Export-Truncated), 다운로드 접근 감사(Q4).
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Any, cast
from zoneinfo import ZoneInfo

from fastapi.responses import Response

from app.core import errors
from app.core.auth import Principal, check_admin
from app.core.codes import load_refs
from app.core.db import fetch_all, fetch_val
from app.core.envelope import Envelope, ListData, Page, build_meta
from app.core.export import export_response
from app.core.filters import (
    DATE_MAX,
    DATE_MIN,
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
from app.features.catalog.prompts.catalog import queries as CQ
from app.features.catalog.prompts.catalog.service import check_route, umbrella_codes
from app.features.catalog.prompts.history import queries as Q
from app.features.catalog.prompts.history.schemas import HISTORY_COLUMNS, HistoryQuery, HistoryRow

HISTORY_SUPPORT = FilterSupport.of(global_=("brand", "country", "period"))
KST = ZoneInfo("Asia/Seoul")
DEFAULT_DAYS = 90
HistoryEnvelope = Envelope[ListData[HistoryRow]]


def today_kst() -> date:
    return datetime.now(KST).date()


def _kst_start(d: date) -> datetime:
    return datetime.combine(d, time(0, 0), tzinfo=KST)


def _scope_preds(ctx: ReadContext, b: Binder, *, brands: tuple[str, ...], with_request_country: bool,
                 require_prompt: bool, pseudo: list[str] | None = None, real_given: bool = True) -> list[str]:
    """스코프(+요청) 술어. brands = 관점 브랜드(스코프 ∩ 요청) 또는 스코프 브랜드 전부.
    require_prompt: app.prompt 행이 있어야 한다(브랜드·시장을 판정할 수 없는 하드 삭제 이력 제외)."""
    w = ["p.prompt_id IS NOT NULL"] if require_prompt else []
    w.append(catalog_brand_scope("p", brands, umbrella_codes(ctx.refs), b))
    ms = catalog_market_scope("p", ctx.scope.countries, b)
    if ms:
        w.append(ms)
    if with_request_country:      # 실국가(스코프 교집합) ∪ 지리 의사 시장 코드(catalog #7, P-1 과 같다)
        real = (ctx.countries or ()) if real_given else ()
        w.append(catalog_market_filter("p", [*real, *(pseudo or ())], b))
    return w


def _row(r: dict[str, Any]) -> HistoryRow:
    return HistoryRow(**{k: r[k] for k in HISTORY_COLUMNS})


async def list_history(conn: Any, p: Principal, q: HistoryQuery) -> HistoryEnvelope | Response:
    check_route(p, "history")
    return await _list_history(conn, p, q, surface_gate=True)


# 관리 카탈로그 타임라인(U8-7, known_diff U8-N21): 현행 fetchPromptAuditTimeline 의 admin 자리(/admin/standards/prompts = admin ∧ 메뉴 admin)는
# listForPrompt(prompt-audit-logs.ts:82-88: 기간 없음, 최신 100)를 읽었다. 기간 없음 = 운영 범위 전체(CommonFilters DATE_MIN~DATE_MAX).
ADMIN_TIMELINE_LIMIT = 100


async def list_prompt_timeline_admin(conn: Any, p: Principal, prompt_id: Any, *, cursor: str | None,
                                     limit: int | None) -> HistoryEnvelope:
    """GET /v1/admin/catalog/prompts/{prompt_id}/history. 라우터가 require_admin·require_menu_group('admin') 을 건다(관리 카탈로그 자리 게이트).
    표준 메뉴 그룹 게이트(check_route·표면 게이트)는 걸지 않는다(resolve_read_context(surface_gate=False) 선례: admin.citation_sources).
    admin 은 DataScope 전체라 스코프 판정·하드 삭제 제외가 없다(삭제된 프롬프트 이력 포함). 값은 /v1/prompts/history?prompt_id 를
    같은 admin 이 운영 범위 전체 기간으로 부른 결과와 같다. admin 이 아니면(라우터 밖 호출 방어) 403 admin_only(check_admin)."""
    check_admin(p)
    q = HistoryQuery.model_validate({"prompt_id": prompt_id, "from": DATE_MIN, "to": DATE_MAX, "cursor": cursor,
                                     "limit": ADMIN_TIMELINE_LIMIT if limit is None else limit})
    return cast(HistoryEnvelope, await _list_history(conn, p, q, surface_gate=False))   # format 기본값 json: Response 가 아니다


async def _list_history(conn: Any, p: Principal, q: HistoryQuery, *, surface_gate: bool) -> HistoryEnvelope | Response:
    refs = await load_refs(conn)
    # catalog #7(front 현행): 지리 의사 시장 코드(x:WW·x:EU·x:ME)는 국가가 아니라 시장 필터 값(스코프 검사 없음, 정확 매칭)
    rest, pseudo = split_geo_pseudo(q.country)
    ctx = await resolve_read_context(conn, p, q.model_copy(update={"country": rest}), support=HISTORY_SUPPORT, refs=refs,
                                     surface_gate=surface_gate)
    real_given = bool(rest)
    root = await fetch_val(conn, CQ.ROOT_PROJECT_SQL)
    if root is None:
        raise errors.not_found("표준 루트 카탈로그 없음")
    country_req = "country" in q.provided() and "country" in HISTORY_SUPPORT.for_surface("global")
    limit = clamp_limit(q.limit, 100 if q.prompt_id is not None else 500)
    fh = filter_hash(q.model_dump(mode="json", exclude={"cursor", "limit", "format"}))
    dropped = {k: list(v) for k, v in ctx.dropped_filters.items()}

    if q.prompt_id is not None and not ctx.scope.all:
        scope_brands = ctx.scope.brands if ctx.scope.brands is not None else tuple(x.code for x in refs.real_brands)
        vb = Binder()
        vis = [f"p.project_id = {vb.v(root, 'uuid')}", f"p.prompt_id = {vb.v(q.prompt_id, 'uuid')}",
               *_scope_preds(ctx, vb, brands=scope_brands, with_request_country=False, require_prompt=True)]
        if await fetch_val(conn, Q.PROMPT_VISIBLE_HEAD + " AND ".join(vis), vb.params) is None:
            dropped["prompt_id"] = [str(q.prompt_id)]
            meta = build_meta(mode="audit", surface="global", ctx=ctx, page=Page(next_cursor=None, limit=limit, total=None))
            meta.dropped_filters = dropped
            if q.format == "csv":
                return _export(p, q, [], False)
            return HistoryEnvelope(data=ListData(items=[]), meta=meta)

    b = Binder()
    lo = ctx.date_from or (today_kst() - timedelta(days=DEFAULT_DAYS))
    where = [f"pal.project_id = {b.v(root, 'uuid')}", f"pal.created_at >= {b.v(_kst_start(lo), 'timestamptz')}"]
    if ctx.date_to is not None:
        where.append(f"pal.created_at < {b.v(_kst_start(ctx.date_to + timedelta(days=1)), 'timestamptz')}")
    if q.prompt_id is not None:
        where.append(f"pal.prompt_id = {b.v(q.prompt_id, 'uuid')}")
    if q.event_type:
        where.append(f"pal.event_type = ANY({b.v(sorted(set(q.event_type)), 'text[]')})")
    brand_req = "brand" in q.provided() and "brand" in HISTORY_SUPPORT.for_surface("global")
    where += _scope_preds(ctx, b, brands=ctx.own_brands, with_request_country=country_req,
                          require_prompt=not ctx.scope.all or brand_req or country_req, pseudo=pseudo, real_given=real_given)

    if q.format == "csv":
        rows = await fetch_all(conn, Q.history_select(where) + f" LIMIT {b.v(Q.EXPORT_MAX_ROWS + 1)}", b.params)
        truncated = len(rows) > Q.EXPORT_MAX_ROWS
        return _export(p, q, [_row(r).model_dump() for r in rows[: Q.EXPORT_MAX_ROWS]], truncated)

    cur = decode_cursor(q.cursor, sort="history", dir="desc", fh=fh, types=Q.SORT_TYPES)
    pred = keyset_predicate(Q.SORT_COLS, "desc", cur, b)
    rows = await fetch_keyset(conn, Q.history_select([*where, pred] if pred else where) + f" LIMIT {b.v(limit + 1)}", b.params, cursor=cur)
    page, nxt = keyset_page(rows, limit, lambda r: (r["created_at"], r["audit_id"]), sort="history", dir="desc", fh=fh)
    meta = build_meta(mode="audit", surface="global", ctx=ctx, page=Page(next_cursor=nxt, limit=limit, total=None))
    meta.dropped_filters = dropped                    # 감사 원장은 표준 루트 고정: project_id 는 core 가 ignored_filters 에 적는다(global)
    return HistoryEnvelope(data=ListData(items=[_row(r) for r in page]), meta=meta)


def _export(p: Principal, q: HistoryQuery, rows: list[dict[str, Any]], truncated: bool) -> Response:
    access_audit(p, "download", "catalog.prompts.history.export", target="global",
                 detail={"format": q.format, "rows": len(rows), "truncated": truncated})
    return export_response("csv", HISTORY_COLUMNS, rows, basename="prompt-history", truncated=truncated)
