"""추가 표면 재스캔(ing.hub_match 쓰기): CLI 재스캔 · 적재 훅 · leaf 준비.

행 계약(ing.hub_match, DB-v2.17 P100)
  1행 = app.core.ecat.matcher.SurfaceScan 1건 = (surface_id, run_month, job_id, turn_index). 스캔 단위 = (job, 본문 턴) 본문 하나:
  저장 본문은 job 의 마지막 턴(단일 턴 = 1, ACR = 2, queries.BODY_TURN). ACR 1턴은 본문이 없어 행이 생기지 않는다.
  n_occ = len(starts), first_start = starts[0], starts·ends = 원문 코드포인트 오프셋·끝 배타(= PostgreSQL substr(answer_text, s+1, e-s)),
  answer_hash = 스캔 당시 ing.answer.content_hash, load_id = 그 행을 쓴 load(스캔 load 또는 적재 load).
  **유효 행 = answer_hash 가 지금 ing.answer.content_hash 와 같은 행.** 본문이 바뀐 뒤 재스캔 전의 옛 행은 읽는 쪽이 버린다(rematch).

완결성(표면 s 의 적중이 전 기간 다 있다)
  ing.hub_match_scan.scanned_to_load_id = W 이면 "load_id ≤ W 인 load 가 쓴 본문은 다 스캔했다"(W = 스캔 시작 때 커밋이 끝난 경계,
  queries.WATERMARK). W 뒤에 바뀐 본문은 적재 훅(활성·초안·회차 고정 버전의 add 표면)이 같은 트랜잭션에서 스캔하고, 그 밖(훅 당시 꺼져 있던 표면)은
  따라잡기(load_id > W 인 답변만 재스캔)가 채운다. 읽기 전에 ensure_scanned(표면들)을 부르면 전체 스캔(처음) 또는 따라잡기를 한다.

멱등·재개
  전체 스캔은 (run_month, job_id) 키셋 청크마다 트랜잭션 1개: 그 구간의 이 표면 행을 지우고(범위 삭제) 새로 쓴다. 커서·진행 수는
  자기 ing.load(kind 'rebuild', scope_ref.source 'ecat_scan') 의 scope_ref 에 같은 트랜잭션으로 남긴다. 중단 뒤 같은 표면 집합으로
  다시 부르면 그 load 의 커서에서 이어받는다(워터마크도 처음 값 그대로). 같은 입력을 몇 번 돌려도 load_id 말고는 같은 행이 된다.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import time
import uuid
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any

import asyncpg

from app.core.ecat.matcher import CompiledSurface, SurfaceSpec, compile_surfaces, scan_text
from ingest.common.db import LoadContext, LoaderDB, finalize, open_load

from . import queries as q

log = logging.getLogger("hgh.ingest.ecat")

CURSOR0 = (dt.date(1, 1, 1), uuid.UUID(int=0))
DEFAULT_CHUNK = 2000
Progress = Callable[[dict[str, Any]], None]


class ScanInputError(ValueError):
    """표면 지정 오류(없는 surface_id·전역 차단 표면·빈 집합). CLI 종료 코드 2."""


@dataclass
class ScanReport:
    surfaces: list[int] = field(default_factory=list)
    full_surfaces: list[int] = field(default_factory=list)
    catchup_surfaces: list[int] = field(default_factory=list)
    status: str = "done"                    # done | partial(max_chunks 로 멈춤, 재개 가능) | noop
    load_ids: list[int] = field(default_factory=list)
    resumed_from: list[Any] | None = None   # 이어받은 커서 [run_month, job_id]
    watermark: int | None = None
    answers_scanned: int = 0                # 이번 호출이 훑은 본문 수
    rows_written: int = 0                   # 이번 호출이 쓴 ing.hub_match 행 수
    chunks: int = 0
    seconds: float = 0.0


# ── 공용 ─────────────────────────────────────────────────────────────────────

def compile_rows(rows: Iterable[asyncpg.Record]) -> tuple[CompiledSurface, ...]:
    specs = []
    for r in rows:
        if r["entity_id"] is None:
            raise ScanInputError(f"surface_id={r['surface_id']} 는 전역 차단 표면이라 스캔 대상이 아니다(add 표면만)")
        specs.append(SurfaceSpec(int(r["surface_id"]), r["entity_id"], r["surface"]))
    return compile_surfaces(specs)


def scan_records(rows: Iterable[asyncpg.Record], compiled: Sequence[CompiledSurface], load_id: int) -> tuple[list[tuple], int]:
    """본문 행 → ing.hub_match 레코드(queries.HUB_COLUMNS 순서). 반환 = (레코드, 훑은 본문 수)."""
    out: list[tuple] = []
    n = 0
    for r in rows:
        n += 1
        for sid, sc in scan_text(r["answer_text"], compiled).items():
            out.append((sid, r["run_month"], r["job_id"], r["turn_index"], sc.entity_id, sc.n_occ, sc.first_start,
                        list(sc.starts), list(sc.ends), r["content_hash"], load_id))
    return out, n


async def _copy(conn: asyncpg.Connection, recs: list[tuple]) -> None:
    if recs:
        await conn.copy_records_to_table("hub_match", schema_name="ing", columns=list(q.HUB_COLUMNS), records=recs)


async def ensure_leaves(conn: asyncpg.Connection, months: Iterable[dt.date], seen: set[dt.date] | None = None) -> None:
    """ing.hub_match 월 leaf(rd.ensure_hub_match_leaf: 카탈로그 선확인이라 있으면 잠금 없음)."""
    for m in sorted(set(months)):
        if seen is not None and m in seen:
            continue
        await conn.execute(q.ENSURE_LEAF, m)
        if seen is not None:
            seen.add(m)


async def surfaces_for(conn: asyncpg.Connection, surface_ids: Sequence[int] | None = None, ver: int | None = None) -> list[asyncpg.Record]:
    """표면 집합: surface_ids 지정 > 버전의 add 표면 > (둘 다 없음) 활성·초안 버전의 add 표면."""
    if surface_ids:
        ids = sorted({int(x) for x in surface_ids})
        rows = await conn.fetch(q.SURFACES_BY_ID, ids)
        missing = sorted(set(ids) - {int(r["surface_id"]) for r in rows})
        if missing:
            raise ScanInputError(f"없는 surface_id: {missing}")
        return list(rows)
    if ver is not None:
        return list(await conn.fetch(q.SURFACES_OF_VER, int(ver)))
    return list(await conn.fetch(q.SURFACES_LIVE))


# ── 적재 훅 ──────────────────────────────────────────────────────────────────

async def on_load(conn: asyncpg.Connection, ctx: LoadContext) -> int:
    """적재 트랜잭션 안(pull 서비스 load_run, ing 원본 반영 직후): 이번 load 에서 바뀐 답변(_pl_changed = 새 답변·content_hash 변경)을
    활성·초안 버전과 회차가 고정한 버전(rd.cycle.ecat_ver)의 add 표면으로 다시 스캔한다. 그 표면들의 해당 답변 행을 지우고 새로 쓴다(멱등). 반환 = 쓴 행 수.
    켜진 add 표면이 없으면 질의 1회로 끝난다. DB-v2.17 전제(월 leaf 준비 ENSURE_ING_MONTH 도 같은 전제라 여기서 따로 확인하지 않는다)."""
    rows = await conn.fetch(q.SURFACES_LIVE)
    if not rows:
        return 0
    compiled = compile_rows(rows)
    sids = [c.surface_id for c in compiled]
    await ensure_leaves(conn, [r[0] for r in await conn.fetch(q.CHANGED_MONTHS)])
    await conn.execute(q.DELETE_CHANGED, sids)
    recs, _ = scan_records(await conn.fetch(q.CHANGED_BODIES), compiled, ctx.load_id)
    await _copy(conn, recs)
    return len(recs)


# ── CLI 재스캔 ───────────────────────────────────────────────────────────────

def _emit(on_progress: Progress | None, **kw: Any) -> None:
    log.info("ecat-scan %s", kw)
    if on_progress is not None:
        on_progress(kw)


async def _ctx_of(conn: asyncpg.Connection, load_id: int) -> LoadContext:
    r = await conn.fetchrow("SELECT load_id, kind, rule_ver FROM ing.load WHERE load_id = $1", load_id)
    return LoadContext(load_id=int(r["load_id"]), kind=r["kind"], rule_ver=int(r["rule_ver"]))


async def _full(db: LoaderDB, conn: asyncpg.Connection, compiled: Sequence[CompiledSurface], rep: ScanReport, *, chunk: int,
                max_chunks: int | None, on_progress: Progress | None) -> bool:
    """전체 스캔(재개 가능). 반환 = 끝까지 갔는가."""
    sids = [c.surface_id for c in compiled]
    key = json.dumps(sids)
    prev = await conn.fetchrow(q.RESUMABLE, "full", key)
    if prev is not None:
        load_id = int(prev["load_id"])
        ref = json.loads(prev["scope_ref"]) if isinstance(prev["scope_ref"], str) else prev["scope_ref"]
        wm = int(ref["watermark"])
        cur = (dt.date.fromisoformat(ref["cursor"][0]), uuid.UUID(ref["cursor"][1])) if ref.get("cursor") else CURSOR0
        done_answers, done_rows = int(ref.get("answers") or 0), int(ref.get("rows") or 0)
        rep.resumed_from = [cur[0].isoformat(), str(cur[1])]
    else:
        ctx = await open_load(db, "rebuild", scope_ref={"source": "ecat_scan", "mode": "full", "surfaces": sids})
        load_id = ctx.load_id
        async with db.tx(conn):
            wm = int(await conn.fetchval(q.WATERMARK, load_id))
            await conn.execute(q.LOAD_PROGRESS, load_id, json.dumps({"watermark": wm, "cursor": None, "answers": 0, "rows": 0}))
            await conn.execute(q.SCAN_BEGIN, sids)
        cur, done_answers, done_rows = CURSOR0, 0, 0
    rep.load_ids.append(load_id)
    rep.watermark = wm
    total = int(await conn.fetchval(q.COUNT_BODIES))
    seen: set[dt.date] = set()
    t0 = time.monotonic()
    n_chunks = 0
    while True:
        rows = await conn.fetch(q.FULL_CHUNK, cur[0], cur[1], chunk)
        if not rows:
            async with db.tx(conn):
                await conn.execute(q.DELETE_TAIL, sids, cur[0], cur[1])
                await conn.execute(q.SCAN_DONE, sids, wm, done_answers, False)
                await finalize(conn, await _ctx_of(conn, load_id))
            _emit(on_progress, phase="full", event="done", surfaces=sids, answers=done_answers, rows=done_rows, watermark=wm,
                  seconds=round(time.monotonic() - t0, 1))
            return True
        if max_chunks is not None and n_chunks >= max_chunks:
            _emit(on_progress, phase="full", event="paused", surfaces=sids, answers=done_answers, total=total,
                  cursor=[cur[0].isoformat(), str(cur[1])])
            return False
        recs, n = scan_records(rows, compiled, load_id)
        last = (rows[-1]["run_month"], rows[-1]["job_id"])
        done_answers += n
        done_rows += len(recs)
        async with db.tx(conn):
            await ensure_leaves(conn, (r["run_month"] for r in rows), seen)
            await conn.execute(q.DELETE_RANGE, sids, cur[0], cur[1], last[0], last[1])
            await _copy(conn, recs)
            await conn.execute(q.LOAD_PROGRESS, load_id, json.dumps(
                {"cursor": [last[0].isoformat(), str(last[1])], "answers": done_answers, "rows": done_rows}))
        cur = last
        n_chunks += 1
        rep.chunks += 1
        rep.answers_scanned += n
        rep.rows_written += len(recs)
        el = time.monotonic() - t0
        rate = rep.answers_scanned / el if el > 0 else 0.0
        _emit(on_progress, phase="full", event="chunk", surfaces=sids, answers=done_answers, total=total, rows=done_rows,
              rate_per_s=round(rate), eta_s=round((total - done_answers) / rate) if rate else None)


async def _catchup(db: LoaderDB, conn: asyncpg.Connection, compiled: Sequence[CompiledSurface], since: int, rep: ScanReport, *,
                   chunk: int, on_progress: Progress | None) -> None:
    """따라잡기: load_id > since 로 바뀐 답변만 다시 스캔(본문이 사라진 답변은 옛 행만 지운다). 중단되면 처음부터(워터마크 불변 = 안전)."""
    sids = [c.surface_id for c in compiled]
    ctx = await open_load(db, "rebuild", scope_ref={"source": "ecat_scan", "mode": "catchup", "surfaces": sids, "since": since})
    rep.load_ids.append(ctx.load_id)
    async with db.tx(conn):
        wm = int(await conn.fetchval(q.WATERMARK, ctx.load_id))
        await conn.execute(q.LOAD_PROGRESS, ctx.load_id, json.dumps({"watermark": wm}))
    keys = [(r[0], r[1]) for r in await conn.fetch(q.CATCHUP_KEYS, since)]
    seen: set[dt.date] = set()
    n_ans = 0
    t0 = time.monotonic()
    for i in range(0, len(keys), chunk):
        part = keys[i:i + chunk]
        ms, js = [k[0] for k in part], [k[1] for k in part]
        recs, n = scan_records(await conn.fetch(q.BODIES_OF_KEYS, ms, js), compiled, ctx.load_id)
        async with db.tx(conn):
            await ensure_leaves(conn, ms, seen)
            await conn.execute(q.DELETE_KEYS, sids, ms, js)
            await _copy(conn, recs)
        n_ans += n
        rep.answers_scanned += n
        rep.rows_written += len(recs)
        rep.chunks += 1
        _emit(on_progress, phase="catchup", event="chunk", surfaces=sids, answers=n_ans, keys=len(keys))
    async with db.tx(conn):
        await conn.execute(q.SCAN_DONE, sids, wm, n_ans, True)
        await finalize(conn, ctx)
    rep.watermark = wm
    _emit(on_progress, phase="catchup", event="done", surfaces=sids, since=since, watermark=wm, answers=n_ans,
          seconds=round(time.monotonic() - t0, 1))


async def scan(db: LoaderDB, *, surface_ids: Sequence[int] | None = None, ver: int | None = None, full: bool = False,
               chunk: int = DEFAULT_CHUNK, max_chunks: int | None = None, on_progress: Progress | None = None) -> ScanReport:
    """표면 집합을 저장 본문 전체에 맞춘다(ensure_scanned 와 같은 동작, full=True 면 이미 끝난 표면도 처음부터).

    - 진행 원장이 없거나 미완인 표면(또는 full) → 전체 스캔(재개 가능: 같은 표면 집합의 미완 load 커서에서 이어받는다)
    - 그 뒤 집합 전체를 가장 낮은 워터마크부터 따라잡기(전체 스캔 중에 바뀐 본문 포함)
    max_chunks: 전체 스캔을 청크 N개 뒤 멈춘다(status partial, 다시 부르면 이어받는다). 운영 창을 나눠 돌리거나 시험용."""
    if chunk < 1:
        raise ScanInputError("chunk 는 1 이상")
    t0 = time.monotonic()
    rep = ScanReport()
    async with db.session() as conn:
        if not await conn.fetchval(q.SCHEMA_READY):
            raise RuntimeError("DB-v2.17(ing.hub_match·app.ecat_surface) 미적용")
        compiled = compile_rows(await surfaces_for(conn, surface_ids, ver))
        if not compiled:
            rep.status = "noop"
            return rep
        rep.surfaces = [c.surface_id for c in compiled]
        state = {int(r[0]): r[1] for r in await conn.fetch(q.SCAN_STATE, rep.surfaces)}
        full_c = [c for c in compiled if full or state.get(c.surface_id) is None]
        rep.full_surfaces = [c.surface_id for c in full_c]
        rep.catchup_surfaces = [c.surface_id for c in compiled if c not in full_c]
        if full_c and not await _full(db, conn, full_c, rep, chunk=chunk, max_chunks=max_chunks, on_progress=on_progress):
            rep.status = "partial"
            rep.seconds = round(time.monotonic() - t0, 3)
            return rep
        state = {int(r[0]): r[1] for r in await conn.fetch(q.SCAN_STATE, rep.surfaces)}
        since = min(int(state[s]) for s in rep.surfaces)
        await _catchup(db, conn, compiled, since, rep, chunk=chunk, on_progress=on_progress)
    rep.seconds = round(time.monotonic() - t0, 3)
    return rep


ensure_scanned = scan
