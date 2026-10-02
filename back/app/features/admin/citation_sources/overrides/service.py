"""admin.citation_sources.overrides 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

규칙(AD-3 명세, 모듈-관리자 §2.4, DB 결정 G-18)
- 후보(candidates): 관리 기능이라 표면 경로 게이트를 걸지 않는다(resolve_read_context(surface_gate=False): 라우터가 require_admin·
  require_menu_group('admin') 으로 이미 막는다. 관리 메뉴만 가진 admin 도 surface=global 후보를 본다, V1). 데이터 스코프는 그대로.
  기간 필수 창(기본 = 최신 노출 회차 1개, core.cycles 함대 스냅샷). from/to 는 최대 366일(초과 422 window_too_large).
  창이 날짜 하나면 요청의 api_ro(5s), 여러 날짜면 admin_long(30s) 커넥션으로 센다(관리 화면 1초 SLO 제외, Q16).
  인용 모수 = cit_in, 호스트 있는 인용(source_key <> 0)만. 인용 계열 숨김 회차({1,2})는 core 창이 뺀다.
  공통 필터는 period·source(= 인용 출처 카테고리 slug, 명세의 category[])만 지원하고 나머지는 meta.ignored_filters 로 드러낸다
  (cf.* 는 core 가 request.query_params 에서 읽어 custom 으로, global 표면의 project_id 는 core 가 project_id 로 싣는다).
- 쓰기: app.citation_domain_override 원본 + (분류가 바뀌면) 같은 트랜잭션에서 judgment_change('citation_override').
  변경 원장 = judgment_change.payload {op, old, new, category_key}. 같은 도메인 대기 요청이 있으면 409 duplicate_pending(롤백).
  노트만 바뀌면 판정 입력이 아니라 요청을 남기지 않는다(propagation none).
"""
from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import date
from typing import Any

from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal
from app.core.cycles import Window
from app.core.db import fetch_all, fetch_one, get_db
from app.core.envelope import Meta, build_meta
from app.core.filters import CommonFilters, FilterSupport, resolve_read_context
from app.core.pagination import decode_cursor, fetch_keyset, filter_hash, keyset_page, keyset_predicate
from app.core.sqlb import Binder
from app.core.write import enqueue_change

from . import queries
from .schemas import (
    CATEGORY_SRC,
    CandidateItem,
    Category,
    CategoryItem,
    OverrideCleared,
    OverrideInfo,
    OverrideItem,
    OverridePut,
    OverrideWritten,
)

CANDIDATE_SUPPORT = FilterSupport.of(global_=("period", "source"), website=("period", "source"), project=("period", "source"))
MAX_WINDOW_DAYS = 366
LIST_SORT = "updated_at,domain"
_LABEL = r"[a-z0-9¡-￿](?:[a-z0-9¡-￿-]{0,61}[a-z0-9¡-￿])?"
_DOMAIN_RE = re.compile(rf"^{_LABEL}(?:\.{_LABEL})+$")


# ── 도메인 정규화(현행 _actions.ts 정규화 + DB CHECK: 소문자·선행 www. 없음) ──
def normalize_domain(raw: str) -> str:
    d = (raw or "").strip().lower().rstrip(".")
    while d.startswith("www."):
        d = d[4:]
    if not d or len(d) > 253 or not _DOMAIN_RE.match(d):
        raise errors.unprocessable("도메인 형식 오류(호스트만, 스킴·경로 없이)", code="invalid_domain", details={"field": "domain"})
    return d


# ── 읽기 ──
async def list_categories(conn: AsyncConnection) -> list[CategoryItem]:
    rows = await fetch_all(conn, queries.CATEGORIES_SQL)
    return [CategoryItem(key=r["category_key"], name=r["name"], slug=r["slug"], ord=r["ord"]) for r in rows]


async def list_overrides(conn: AsyncConnection, *, cursor: str | None, limit: int) -> tuple[list[OverrideItem], str | None]:
    fh = filter_hash({})
    cur = decode_cursor(cursor, sort=LIST_SORT, dir="desc", fh=fh, types=["timestamptz", "text"])
    b = Binder()
    pred = keyset_predicate(["o.updated_at", "o.domain"], "desc", cur, b) or "true"
    rows = await fetch_keyset(conn, queries.LIST_SQL.format(keyset=pred), {**b.params, "lim": limit + 1})
    page, nxt = keyset_page(rows, limit, lambda r: (r["updated_at"], r["domain"]), sort=LIST_SORT, dir="desc", fh=fh)
    return [OverrideItem(domain=r["domain"], category=Category(key=r["category_key"], name=r["name"], slug=r["slug"]),
                         note=r["note"], updated_by=r["updated_by"], updated_by_email=r["updated_by_email"],
                         updated_at=r["updated_at"]) for r in page], nxt


def _check_window(lo: date | None, hi: date | None) -> None:
    """기간 상한. 한쪽만 준 기간은 resolve_read_context 가 닫은 뒤(ReadContext.date_from·date_to)에 잰다."""
    if lo is not None and hi is not None and (hi - lo).days > MAX_WINDOW_DAYS:
        raise errors.unprocessable(f"기간은 최대 {MAX_WINDOW_DAYS}일", code="window_too_large",
                                   details={"max_days": MAX_WINDOW_DAYS})


def _candidate(r: dict[str, Any]) -> CandidateItem:
    ov = None
    if r["has_override"]:
        ov_cat = Category(key=r["ov_category_key"], name=r["ov_name"], slug=r["ov_slug"])
        ov = OverrideInfo(category=ov_cat, note=r["ov_note"], updated_by=r["ov_updated_by"], updated_at=r["ov_updated_at"],
                          propagated=bool(r["in_dim_source"]) and r["category_src"] == 1 and r["category_key"] == r["ov_category_key"])
    return CandidateItem(domain=r["domain"], citations=int(r["citations"]),
                         category=Category(key=r["category_key"], name=r["name"], slug=r["slug"]),
                         source=CATEGORY_SRC[int(r["category_src"])], in_dim_source=bool(r["in_dim_source"]), override=ov,
                         shadows_owned=bool(r["shadows_owned"]))


def candidates_sql(win: Window) -> tuple[str, dict[str, Any], bool]:
    """(SQL, 바인드, 사실 표 읽음 여부). 인용 계열 회차 키가 없으면 사실 표를 읽지 않고 오버라이드 도메인만."""
    b = Binder()
    if win.empty or not win.cyc_keys("citations"):
        return queries.CANDIDATES_SQL.format(cte=queries.EMPTY_CTE), {}, False
    where = " AND ".join(win.where("c", "citations", b))
    return queries.CANDIDATES_SQL.format(cte=queries.WEIGHTED_CTE.format(where=where)), b.params, True


async def list_candidates(conn: AsyncConnection, p: Principal, filters: CommonFilters, *, limit: int,
                          query_params: Mapping[str, Any] | None = None,
                          today: date | None = None) -> tuple[list[CandidateItem], Meta]:
    _check_window(filters.from_, filters.to)
    ctx = await resolve_read_context(conn, p, filters, support=CANDIDATE_SUPPORT, surface_gate=False, query_params=query_params)
    _check_window(ctx.date_from, ctx.date_to)
    win = await ctx.window(conn, today=today)
    sql, params, reads_facts = candidates_sql(win)
    cats = None if ctx.source_category_keys is None else sorted(ctx.source_category_keys)
    params = {**params, "lim": limit, "cats": cats}
    long_window = reads_facts and win.lo != win.hi
    if long_window:
        async with get_db().read("admin_long") as lc:
            rows = await fetch_all(lc, sql, params)
    else:
        rows = await fetch_all(conn, sql, params)
    suppressed = {"citations": "hidden"} if win.hidden("citations") else {}
    meta = build_meta(mode=win.mode, window=win, ctx=ctx, suppressed=suppressed,
                      source={"from": win.lo.isoformat() if win.lo else None, "to": win.hi.isoformat() if win.hi else None,
                              "default_window": ctx.date_from is None, "pool": "admin_long" if long_window else "api_ro",
                              "max_days": MAX_WINDOW_DAYS})
    return [_candidate(r) for r in rows], meta


# ── 쓰기(api_rw) ──
async def _category(conn: AsyncConnection, body: OverridePut) -> Category:
    if body.category_key is not None:
        r = await fetch_one(conn, queries.CATEGORY_BY_KEY_SQL, {"k": body.category_key})
    else:
        r = await fetch_one(conn, queries.CATEGORY_BY_LABEL_SQL, {"v": body.category})
    if r is None:
        raise errors.unprocessable("알 수 없는 카테고리", code="unknown_category", details={"field": "category"})
    return Category(key=r["category_key"], name=r["name"], slug=r["slug"])


async def put_override(conn: AsyncConnection, raw_domain: str, body: OverridePut) -> OverrideWritten:
    domain = normalize_domain(raw_domain)
    cat = await _category(conn, body)
    note = body.note.strip() if body.note and body.note.strip() else None
    old = await fetch_one(conn, queries.OLD_SQL, {"d": domain})
    try:
        row = await fetch_one(conn, queries.UPSERT_SQL, {"d": domain, "k": cat.key, "note": note})
    except DBAPIError as e:
        mapped = errors.from_db_error(e, write=True)   # 23514·23503 → 422 constraint_violation, 입력 유래 22xxx → 422 invalid_value(details 없음)
        raise (mapped or e) from e
    assert row is not None
    change_id = None
    if old is None or old["category_key"] != cat.key:
        change_id = await enqueue_change(conn, "citation_override", subject_texts=[domain], payload={
            "op": "set", "domain": domain, "category_key": cat.key,
            "old": None if old is None else {"category_key": old["category_key"], "note": old["note"]},
            "new": {"category_key": cat.key, "note": note}})
    return OverrideWritten(domain=domain, category=cat, note=row["note"], updated_by=row["updated_by"],
                           updated_at=row["updated_at"], change_id=change_id,
                           propagation="pending" if change_id is not None else "none")


async def delete_override(conn: AsyncConnection, raw_domain: str) -> OverrideCleared:
    domain = normalize_domain(raw_domain)
    old = await fetch_one(conn, queries.DELETE_SQL, {"d": domain})
    if old is None:
        raise errors.not_found("오버라이드 없음")
    change_id = await enqueue_change(conn, "citation_override", subject_texts=[domain], payload={
        "op": "clear", "domain": domain, "category_key": None,
        "old": {"category_key": old["category_key"], "note": old["note"]}, "new": None})
    return OverrideCleared(domain=domain, change_id=change_id)
