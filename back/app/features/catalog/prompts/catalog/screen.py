"""Bounded reads for the existing standard/admin tables. Scope precedes every count, facet and page."""
from __future__ import annotations

import json
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core import errors
from app.core.codes import load_refs
from app.core.db import fetch_all, fetch_one, fetch_val
from app.core.filters import resolve_read_context
from app.core.sqlb import Binder
from app.features.admin.catalog.prompts.schemas import CatalogStats

AXES = {"listType": "list_type", "depth1": "depth1", "depth2": "depth2", "depth3": "depth3", "depth4": "depth4",
        "funnel": "funnel_stage", "kind": "kind", "lang": "lang"}
NORMAL_MARKET = "CASE WHEN lower(btrim(m)) LIKE 'x:%' THEN 'x:' || upper(substr(btrim(m), 3)) ELSE upper(btrim(m)) END"
MARKETS = f"ARRAY(SELECT DISTINCT {NORMAL_MARKET} FROM unnest(p.regions) m WHERE btrim(m) <> '' ORDER BY 1)"


class CatalogScreenFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    listType: str = "all"
    depth1: str = "all"
    depth2: str = "all"
    depth3: str = "all"
    depth4: str = "all"
    funnel: str = "all"
    presence: str = "all"
    kind: str = "all"
    market: str = "all"
    lang: str = "all"
    status: str = "all"
    view: Literal["active", "deleted"] = "active"


class CatalogScreenQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    filters: CatalogScreenFilters = Field(default_factory=CatalogScreenFilters)
    draft: CatalogScreenFilters = Field(default_factory=CatalogScreenFilters)
    search: str = Field("", max_length=5000)
    sort: Literal["text", "brand", "presence", "listType", "depth1", "depth2", "depth3", "depth4", "funnel", "kind", "market", "lang", "status", "tracked"] = "depth1"
    asc: bool = True
    offset: int = Field(0, ge=0, le=10_000_000)
    limit: int = Field(50, ge=1, le=500)
    collation: Literal["en", "ko"] = "en"
    market_labels: dict[str, str] = Field(default_factory=dict, max_length=400)
    include_meta: bool = Field(True, description=(
        "false = rows·total 만 계산한다(count·facets·columns·stats 는 null). 이 값들은 범위와 draft 에만 의존하므로 "
        "같은 draft 의 페이지 넘김·필터·검색·정렬·내보내기는 직전 값을 재사용한다"))


class CatalogScreenRow(BaseModel):
    id: str
    text: str
    promptType: str | None
    category: str | None
    brand: str | None
    brandPresence: str | None
    listType: str | None
    depth1: str | None
    depth2: str | None
    depth3: str | None
    depth4: str | None
    funnelStage: str | None
    kind: str
    lang: str | None
    regions: list[str] | None
    scopePromptId: str | None
    scopeText: str | None
    deletedAt: datetime | None


class CatalogScreenPage(BaseModel):
    rows: list[CatalogScreenRow]
    total: int
    count: int | None = Field(None, description="범위 전체 건수(include_meta=false 면 null)")
    offset: int
    limit: int
    facets: dict[str, list[str]] | None = Field(None, description="필터 선택지(include_meta=false 면 null)")
    columns: list[str] | None = Field(None, description="값이 있는 분류 열(include_meta=false 면 null)")
    stats: CatalogStats | None = None


def row_model(r):
    names = {"id": "prompt_id", "promptType": "prompt_type", "brand": "brand_code", "brandPresence": "brand_presence",
             "listType": "list_type", "funnelStage": "funnel_stage", "scopePromptId": "scope_prompt_id", "scopeText": "scope_text", "deletedAt": "deleted_at"}
    values = {k: r.get(names.get(k, k)) for k in CatalogScreenRow.model_fields}
    for key in ("id", "scopePromptId"):
        if values[key] is not None:
            values[key] = str(values[key])
    return CatalogScreenRow(**values)


async def catalog_screen(conn, principal, request: CatalogScreenQuery, *, admin=False) -> CatalogScreenPage:
    from app.features.admin.catalog.prompts import service as admin_svc
    from app.features.catalog.prompts.catalog import queries as cq
    from app.features.catalog.prompts.catalog import service as svc
    from app.features.catalog.prompts.catalog.schemas import CatalogQuery

    if not admin:
        svc.check_route(principal, "global")
    b = Binder()
    root = await fetch_val(conn, cq.ROOT_PROJECT_SQL)
    if root is None:
        raise errors.not_found("표준 루트 카탈로그 없음")
    refs = await load_refs(conn)
    presence = cq.presence_effective("p", svc.umbrella_codes(refs), b)
    if admin:
        base = [f"p.project_id = {b.v(root, 'uuid')}"]
    else:
        q = CatalogQuery(surface="global")
        ctx = await resolve_read_context(conn, principal, q, support=svc.CATALOG_SUPPORT, refs=refs, resolve_taxonomy=False)
        base = svc._global_where(q, ctx, root, b, presence)
    base_where = " AND ".join(base)
    filters = request.filters
    where = list(base)
    if admin:
        where.append("p.deleted_at IS NOT NULL" if filters.view == "deleted" else "p.deleted_at IS NULL")
    for key, col in AXES.items():
        value = getattr(filters, key)
        if value != "all":
            where.append(f"p.{col} = {b.v(value)}")
    if filters.presence != "all":
        where.append(f"{presence} = {b.v(filters.presence)}")
    if filters.status in ("measured", "tracked"):
        where.append("p.scope_prompt_id IS NOT NULL")
    elif filters.status in ("unmeasured", "untracked"):
        where.append("p.scope_prompt_id IS NULL")
    if filters.market != "all":
        target = filters.market.strip()
        target = "x:" + target[2:].upper() if target.lower().startswith("x:") else target.upper()
        where.append(f"{b.v(target)} = ANY({MARKETS})")
    if request.search.strip():
        where.append(f"strpos(lower(p.text), {b.v(request.search.strip().lower())}) > 0")
    filtered = " AND ".join(where)
    total = int(await fetch_val(conn, f"SELECT count(*) FROM app.prompt p WHERE {filtered}", b.params))
    offset = min(request.offset, max(0, (total - 1) // request.limit * request.limit))

    # 범위(base)·draft 에만 의존하는 메타: include_meta=false 면 계산하지 않는다(화면이 같은 draft 의 직전 값을 쓴다).
    count: int | None = None
    options: dict[str, list[str]] | None = None
    columns: list[str] | None = None
    if request.include_meta:
        facets = []
        parents = []
        for key in ("listType", "depth1", "depth2", "depth3", "depth4", "funnel", "lang"):
            col = AXES[key]
            restrict = " AND " + " AND ".join(parents) if parents and key.startswith("depth") else ""
            facets.append(f"array_agg(DISTINCT p.{col}) FILTER (WHERE p.{col} IS NOT NULL AND p.{col} <> ''{restrict}) AS \"{key}\"")
            if key in ("listType", "depth1", "depth2", "depth3") and getattr(request.draft, key) != "all":
                parents.append(f"p.{col} = {b.v(getattr(request.draft, key))}")
        flags = ", ".join(f"bool_or(p.{AXES[key]} IS NOT NULL AND p.{AXES[key]} <> '') AS \"has_{key}\"" for key in ("listType", "depth1", "depth2", "depth3", "depth4"))
        meta = await fetch_one(conn, f"SELECT count(*) AS count, {', '.join(facets)}, {flags} FROM app.prompt p WHERE {base_where}", b.params)
        markets = await fetch_all(conn, f"SELECT DISTINCT {NORMAL_MARKET} AS code FROM app.prompt p CROSS JOIN LATERAL unnest(p.regions) m WHERE {base_where} AND btrim(m) <> ''", b.params)
        count = int(meta["count"])
        options = {key: sorted(meta[key] or []) for key in ("listType", "depth1", "depth2", "depth3", "depth4", "funnel", "lang")}
        codes = {r["code"] for r in markets}
        options["market"] = sorted(c for c in codes if not c.startswith("x:")) + sorted(c for c in codes if c in ("x:WW", "x:EU", "x:ME"))
        options["marketSort"] = sorted(codes)
        columns = [key[4:] for key, value in meta.items() if key.startswith("has_") and value]

    sorts = {key: f"coalesce(p.{col}, '~')" for key, col in AXES.items()}
    sorts |= {"text": "p.text", "brand": "coalesce(p.brand_code, '')", "presence": f"coalesce({presence}, '~')",
              "kind": "CASE WHEN p.kind = 'acr' THEN 1 ELSE 0 END", "status": "(p.scope_prompt_id IS NOT NULL)", "tracked": "(p.scope_prompt_id IS NOT NULL)"}
    if request.sort == "market":
        first = f"(SELECT code FROM unnest({MARKETS}) code ORDER BY (code LIKE 'x:%'), code LIMIT 1)"
        labels = b.v(json.dumps(request.market_labels), "jsonb")
        sorts["market"] = f"coalesce({labels} ->> {first}, {first}, '~')"
    order = sorts[request.sort]
    if request.sort not in ("kind", "status", "tracked"):
        order += ' COLLATE "ko-x-icu"' if request.collation == "ko" else ' COLLATE "en-x-icu"'
    order += " ASC" if request.asc else " DESC"
    # Stable ties retain the former catalog feed's ordering.
    order += ", p.depth1, p.depth2, p.depth3, left(p.text, 256), p.prompt_id"
    rows = await fetch_all(conn, "SELECT p.*, dp.text AS scope_text FROM app.prompt p LEFT JOIN rd.dim_prompt dp ON dp.prompt_id = p.scope_prompt_id"
                           f" WHERE {filtered} ORDER BY {order} LIMIT {b.v(request.limit, 'int4')} OFFSET {b.v(offset, 'int4')}", b.params)
    stats = None
    if admin and request.include_meta:
        stat_page, _ = await admin_svc.list_catalog(conn, q_text=None, kind=None, include_deleted=True, axes={}, cursor=None, limit=1)
        stats = stat_page.stats
    return CatalogScreenPage(rows=[row_model(r) for r in rows], total=total, count=count, offset=offset, limit=request.limit,
                             facets=options, columns=columns, stats=stats)
