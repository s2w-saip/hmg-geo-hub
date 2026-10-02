"""ingest.pull.ops 업무 규칙: 적재 운영 조회 3종(admin 전용, 고객 테넌트 무관이라 데이터 스코프·공통 필터 없음).

- 권한: role='admin' 하나(core.auth.require_admin, 현행 /admin ADMIN_ONLY lib/auth/route-policy.ts:236-239). operator 축은 비용 액션용이라 쓰지 않는다.
- 공통 필터: 지원 축 없음(FilterSupport 빈 선언). 들어온 공통 필터 키는 조용히 버리지 않고 meta.ignored_filters 에 축 이름으로 적는다
  (core.filters.ignored_axes).
  surface 는 status·backlog 의 자체 파라미터로 받고(원장 표면 좁히기), loads 에서는 무시 목록에 들어간다.
- 페이지: backlog 키셋(started_at, run_id), loads 키셋(load_id DESC). 커서 = core.pagination(필터 해시 대조, 변조 422).
"""
from __future__ import annotations

import datetime as dt
from collections.abc import Mapping
from typing import Any

from app.core import pagination as pg
from app.core.db import fetch_all
from app.core.envelope import ListData, Page, build_meta
from app.core.errors import unprocessable
from app.core.filters import FilterSupport, ignored_axes
from app.core.sqlb import Binder

from . import queries as qs
from .schemas import BacklogRow, IngestStatusRow, LoadRow

SUPPORT = FilterSupport.of()           # 공통 필터 축 지원 없음(모든 축 ignored)
BACKLOG_MAX = 200
LOADS_MAX = 200
LOAD_KINDS = ("run", "recheck", "judgment", "cycle_admin", "rebuild", "ga4", "dfs", "report", "seed")
LOAD_STATUSES = ("running", "committed", "failed")


def _utc(t: dt.datetime | None) -> dt.datetime | None:
    """시간대 없는 입력은 UTC 로 본다(원장 시각은 timestamptz)."""
    return t.replace(tzinfo=dt.UTC) if t is not None and t.tzinfo is None else t


def ignored_filters(query_params: Mapping[str, Any], *, surface_supported: bool) -> list[str]:
    """들어온 공통 필터 축(core.filters.ignored_axes: 쿼리 이름 → 축 이름표는 core 한 벌, ingest R13 반영).
    surface 를 자체 파라미터로 받는 엔드포인트(status·backlog)는 consumed 로 뺀다."""
    return ignored_axes(query_params, SUPPORT, consumed=("surface",) if surface_supported else ())


async def status(conn: Any, *, surface: str | None, ignored: list[str]) -> tuple[ListData[IngestStatusRow], Any]:
    b = Binder()
    where = ["true"]
    if surface:
        where.append(f"surface = {b.v(surface)}")
    rows = await fetch_all(conn, qs.STATUS.format(where=" AND ".join(where)), b.params)
    meta = build_meta(mode="admin", surface=surface)
    meta.ignored_filters = ignored
    return ListData[IngestStatusRow](items=[IngestStatusRow(**r) for r in rows]), meta


async def backlog(conn: Any, *, surface: str | None, limit: int | None, cursor: str | None, ignored: list[str]) -> tuple[ListData[BacklogRow], Any]:
    lim = pg.clamp_limit(limit, 50)
    if lim > BACKLOG_MAX:
        raise unprocessable(f"limit 은 1~{BACKLOG_MAX}", details={"field": "limit"})
    fh = pg.filter_hash({"surface": surface, "ep": "backlog"})
    cur = pg.decode_cursor(cursor, sort="started_at", dir="asc", fh=fh, types=("timestamptz", "uuid"))
    b = Binder()
    where = ["true"]
    if surface:
        where.append(f"surface = {b.v(surface)}")
    kp = pg.keyset_predicate(list(qs.BACKLOG_KEY), "asc", cur, b)
    if kp:
        where.append(kp)
    rows = await pg.fetch_keyset(conn, qs.BACKLOG.format(where=" AND ".join(where), limit=lim + 1), b.params)
    page, nxt = pg.keyset_page(rows, lim, lambda r: (r["k_started"], r["run_id"]), sort="started_at", dir="asc", fh=fh)
    meta = build_meta(mode="admin", surface=surface, page=Page(next_cursor=nxt, limit=lim))
    meta.ignored_filters = ignored
    return ListData[BacklogRow](items=[BacklogRow(**{k: v for k, v in r.items() if k != "k_started"}) for r in page]), meta


async def loads(conn: Any, *, kinds: list[str], statuses: list[str], started_from: dt.datetime | None, started_to: dt.datetime | None,
                limit: int | None, cursor: str | None, ignored: list[str]) -> tuple[ListData[LoadRow], Any]:
    lim = pg.clamp_limit(limit, 50)
    if lim > LOADS_MAX:
        raise unprocessable(f"limit 은 1~{LOADS_MAX}", details={"field": "limit"})
    bad = [k for k in kinds if k not in LOAD_KINDS] + [s for s in statuses if s not in LOAD_STATUSES]
    if bad:
        raise unprocessable("kind·status 값 오류", details={"values": bad})
    started_from, started_to = _utc(started_from), _utc(started_to)
    if started_from and started_to and started_from > started_to:
        raise unprocessable("started_from ≤ started_to", details={"field": "started_from"})
    fh = pg.filter_hash({"kind": sorted(kinds), "status": sorted(statuses), "from": started_from, "to": started_to, "ep": "loads"})
    cur = pg.decode_cursor(cursor, sort="load_id", dir="desc", fh=fh, types=("int8",))
    b = Binder()
    where = ["true"]
    if kinds:
        where.append(f"kind = ANY({b.v(sorted(set(kinds)), 'text[]')})")
    if statuses:
        where.append(f"status = ANY({b.v(sorted(set(statuses)), 'text[]')})")
    if started_from:
        where.append(f"started_at >= {b.v(started_from, 'timestamptz')}")
    if started_to:
        where.append(f"started_at <= {b.v(started_to, 'timestamptz')}")
    kp = pg.keyset_predicate(["load_id"], "desc", cur, b)
    if kp:
        where.append(kp)
    rows = await pg.fetch_keyset(conn, qs.LOADS.format(where=" AND ".join(where), limit=lim + 1), b.params)
    page, nxt = pg.keyset_page(rows, lim, lambda r: (r["load_id"],), sort="load_id", dir="desc", fh=fh)
    meta = build_meta(mode="admin", page=Page(next_cursor=nxt, limit=lim))
    meta.ignored_filters = ignored
    return ListData[LoadRow](items=[LoadRow(**r) for r in page]), meta
