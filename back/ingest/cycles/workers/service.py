"""ingest.cycles.workers: 워커 루프의 한 틱 단위 함수(로컬에서 한 틱씩 시험 가능).

  cycles_tick(db, now, daily)     20분: 시간만 흘러 바뀌는 판정(R01 정온·재확인 창 종결, R08 발행, 노출일) → rd.cycle 투영·세대.
                                   daily: rd 사실 표 leaf(표면별, 3개월 앞)·ing 원본·GA4·접근 감사(app.access_audit_log)·DataForSEO 월 leaf 선생성
  run_queue(db, ..., limit)       60초: app.judgment_change 소비(FOR UPDATE SKIP LOCKED, change_id 순). 한 행 = 한 트랜잭션.
                                   성공 applied(applied_load_id), 실패는 롤백 뒤 새 트랜잭션에서 failed·error, 상한 초과는 escalated_rebuild.
  run_outbox(db, source, ...)     app.scope_outbox 드레인(Scope 쓰기, 외부 호출은 트랜잭션 밖). 생성 응답의 Scope id 를 app 에 되쓴다
                                   (행위자 = 시스템 사용자, app.prompt 트리거가 감사·판정 큐를 남긴다).
  run_dfs(db, dfs, ...)           dfs_fetch 빠른 경로: claim(running) → DataForSEO 호출(트랜잭션 밖) → ext.dfs_call·rd.kw_* 한 트랜잭션.
큐 kind 소유: IG-2 재판정 14종(+scope_prompt), IG-3 운영 4종(cycle_admin·report_publication·anchor_pin·answer_drop), dfs_fetch,
엔티티 버전 반영 entity_version(E4·E5, ingest.project.apply.ecat_engine: 한 처리 = 한 청크 트랜잭션, 남으면 행을 pending 으로 두고 다시 집는다).
ga4_property·ga4_tracked_event 는 외부 적재(IG-4, 소유 미정)라 이 워커가 집지 않는다(대기 유지).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

import asyncpg

from app.core.contracts import parse_change, parse_outbox
from ingest.common.config import get_ingest_settings
from ingest.common.db import (
    LoadContext,
    LoaderDB,
    begin_load,
    describe_error,
    finalize,
    lock_surface_exclusive,
    lock_surface_shared,
    try_lock_project,
)
from ingest.cycles.ledger import service as ledger
from ingest.frz.freeze import freeze_published
from ingest.project.apply import ecat_engine
from ingest.project.apply.rejudge import GLOBAL_KINDS, IG2_KINDS, PROJECT_KINDS, rejudge
from ingest.project.apply.service import Escalated, apply, reproject

from . import queries as q
from .dfs import DfsSource, legacy_dfs, plan_calls, write_dfs

log = logging.getLogger("hgh.ingest.workers")
DFS_TIMEOUT_S = 600

IG3_KINDS = frozenset({"cycle_admin", "report_publication", "anchor_pin", "answer_drop"})
ECAT_KIND = "entity_version"
QUEUE_KINDS = tuple(sorted(IG2_KINDS | IG3_KINDS | {ECAT_KIND}))
LOAD_KIND = {"cycle_admin": "cycle_admin", "report_publication": "report", "anchor_pin": "cycle_admin", "answer_drop": "cycle_admin"}


class _NoChange(Exception):
    """틱에서 바뀐 것이 없으면 트랜잭션을 되돌려 빈 ing.load 행을 남기지 않는다."""


@dataclass
class TickReport:
    closed: list[Any] = field(default_factory=list)
    published: list[Any] = field(default_factory=list)
    counters: list[Any] = field(default_factory=list)
    moved_runs: list[Any] = field(default_factory=list)
    planned: list[Any] = field(default_factory=list)          # 발행 게이트 계획을 새로 만든 회차(backfill)
    gate: list[Any] = field(default_factory=list)             # 게이트 판정 값이 바뀐 회차
    load_id: int | None = None
    leaves_created: int = 0
    frozen: dict[str, Any] = field(default_factory=dict)      # 발행 회차 동결 세대 생성(DB-v2.22 frz.freeze_cycle)


def _months(today: dt.date, ahead: int = 3) -> list[dt.date]:
    out = []
    y, m = today.year, today.month
    for _ in range(ahead + 1):
        out.append(dt.date(y, m, 1))
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


async def ensure_partitions(conn: asyncpg.Connection, today: dt.date, ahead: int = 3) -> int:
    """leaf 선생성(RANGE 파티션, DEFAULT 없음: 없으면 첫 INSERT 부터 실패). 반환 = 새로 생긴 leaf 수."""
    before = int(await conn.fetchval(q.LEAF_COUNT))
    for m in _months(today, ahead):
        for s in (1, 2, 3):
            await conn.execute("SELECT rd.ensure_leaf($1::int2, $2::date)", s, m)
        for parent in q.MONTH_PARENTS:
            await conn.execute("SELECT rd.ensure_month_leaf($1::regclass, $2::date)", parent, m)
        await conn.execute("SELECT rd.ensure_hub_match_leaf($1::date)", m)      # ing.hub_match 월 leaf(DB-v2.17 P100)
    return int(await conn.fetchval(q.LEAF_COUNT)) - before


async def cycles_tick(db: LoaderDB, *, now: dt.datetime | None = None, daily: bool = False) -> TickReport:
    now = now or dt.datetime.now(dt.UTC)
    rep = TickReport()
    async with db.session() as conn:
        if daily:
            async with db.tx(conn):
                rep.leaves_created = await ensure_partitions(conn, (now + dt.timedelta(hours=9)).date())
        try:
            async with db.tx(conn):
                ctx = await begin_load(conn, "cycle_admin", scope_ref={"source": "cycles_tick", "now": now.isoformat()})
                ids = [r[0] for r in await conn.fetch(ledger.q.TICK_CANDIDATES)]
                rv = await ledger.reevaluate(conn, ctx, ids, now=now)
                rep.closed, rep.published, rep.counters, rep.moved_runs = rv["closed"], rv["published"], rv["counters"], rv["moved_runs"]
                rep.planned, rep.gate = rv["planned"], rv["gate"]
                if rv["moved_runs"]:
                    await apply(conn, ctx, [], extra_runs=rv["moved_runs"])
                rep.frozen = await freeze_published(conn, rv["published"])      # 발행 직후 동결 세대(좌석 이동 재투영 뒤, 같은 트랜잭션)
                if not ctx.rd_changed and not (rv["closed"] or rv["published"] or rv["counters"] or rv["planned"] or rv["gate"]):
                    raise _NoChange
                await finalize(conn, ctx)
                rep.load_id = ctx.load_id
        except _NoChange:
            pass
    return rep


# ════════════════════════════════════════════════════════════════════════════
# judgment_change 큐
# ════════════════════════════════════════════════════════════════════════════
@dataclass
class QueueOutcome:
    change_id: int
    kind: str
    status: str                 # applied | failed | escalated_rebuild | deferred | progress(entity_version 청크가 남음: 행 pending 유지)
    load_id: int | None = None
    error: str | None = None


async def _dispatch(conn: asyncpg.Connection, ctx: LoadContext, row: asyncpg.Record) -> ecat_engine.EcatStep | None:
    kind = row["kind"]
    payload = row["payload"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    model = parse_change(kind, payload)              # core.contracts: 생산자와 같은 계약(위반 = ContractError → 이 행 failed)
    if model is not None and kind in IG3_KINDS:
        payload = model.model_dump(mode="json")      # 기본값(op 등) 채운 형태로 처리기에 넘긴다
    subj = list(row["subject_uuids"] or [])
    texts = list(row["subject_texts"] or [])
    if kind == ECAT_KIND:
        return await ecat_engine.handle(conn, ctx, model.model_dump(mode="json"))       # 계약 = core.contracts.EntityVersion
    if kind in IG2_KINDS:
        await rejudge(conn, ctx, kind, subject_uuids=subj, subject_texts=texts or None, payload=payload)
    elif kind == "cycle_admin":
        moved = await ledger.handle_cycle_admin(conn, ctx, payload or {}, change_id=row["change_id"], requested_by=row["requested_by"])
        published: list[Any] = []
        if (payload or {}).get("op") in ("close", "seal", "force_publish"):       # 마감·봉인·강제 발행은 곧바로 재평가(발행 게이트 → R08)
            rv = await ledger.reevaluate(conn, ctx, [payload["cycle_id"]])
            moved += rv["moved_runs"]
            published = rv["published"]
        if moved:
            await reproject(conn, ctx, [], extra_runs=moved)
        if published:
            await freeze_published(conn, published)                              # 발행 직후 동결 세대(재투영 뒤, 같은 트랜잭션)
    elif kind == "report_publication":
        await ledger.handle_report_publication(conn, ctx, subj, payload)
    elif kind == "anchor_pin":
        runs = await ledger.handle_anchor_pin(conn, ctx, payload or {}, row["change_id"])
        await reproject(conn, ctx, [], extra_runs=runs)
    elif kind == "answer_drop":
        keys = await ledger.handle_answer_drop(conn, ctx, payload or {}, row["change_id"])
        await reproject(conn, ctx, keys)
    else:
        raise ValueError(f"처리하지 않는 kind: {kind}")
    return None


async def _lock_for(conn: asyncpg.Connection, kind: str, row: asyncpg.Record) -> bool:
    """잠금 규약: 전역 규칙 = 표면 배타(1→2→3), 프로젝트 한정 = 프로젝트 표면 공유 + 프로젝트 try, 그 밖 = 전 표면 공유.
    entity_version: 반영·재개 = 전역 규칙과 같이 표면 배타, 미리보기 = 표면 공유(rd 사실 행을 쓰지 않는다: 적재와 함께 돈다)."""
    if kind in GLOBAL_KINDS or (kind == ECAT_KIND and ecat_engine.op_of(row["payload"]) != "preview"):
        for s in (1, 2, 3):
            await lock_surface_exclusive(conn, s)
        return True
    for s in (1, 2, 3):
        await lock_surface_shared(conn, s)
    if kind in PROJECT_KINDS:
        for pid in row["subject_uuids"] or []:
            sp = await conn.fetchval("SELECT scope_project_id FROM app.project WHERE project_id = $1", pid)
            if not await try_lock_project(conn, sp or pid):
                return False
    return True


async def process_change(db: LoaderDB, conn: asyncpg.Connection, *, kinds: tuple[str, ...] = QUEUE_KINDS,
                         change_id: int | None = None, skip: set[int] | None = None) -> QueueOutcome | None:
    """대기 요청 1건 처리(없으면 None). entity_version 은 한 처리 = 한 청크: 남으면 행을 pending 으로 두고 status 'progress' 를 돌려준다
    (run_queue 가 같은 행을 다시 집는다). 거절(지문 불일치 등)은 반영 원장 쓰기를 커밋하고 행을 failed 로, 다른 반영이 진행 중이면 deferred."""
    cid: int | None = None
    kind = ""
    if ECAT_KIND in kinds:           # 미리보기 전 add 표면 재스캔(자기 트랜잭션들, 큐 트랜잭션 밖: 긴 스캔 동안 큐 행·잠금을 쥐지 않는다)
        peek = await (conn.fetchrow(q.PEEK_ONE, change_id) if change_id is not None else conn.fetchrow(q.PEEK, list(kinds), sorted(skip or ())))
        if peek is not None and peek["kind"] == ECAT_KIND:
            try:
                await ecat_engine.prepare(db, peek["payload"])
            except Exception as e:  # noqa: BLE001  재스캔 실패 = 그 요청만 실패(큐는 계속). 미리보기를 낡은 적중으로 계산하지 않는다
                pid = int(peek["change_id"])
                msg = "ECAT_SCAN_FAILED: " + describe_error(e)
                log.warning("judgment_change %s(entity_version) 재스캔 실패: %s", pid, msg)
                async with db.tx(conn):
                    await conn.execute(q.FAILED, pid, msg)
                    await ecat_engine.mark_failed(conn, pid, msg)
                return QueueOutcome(pid, ECAT_KIND, "failed", error=msg)
    try:
        async with db.tx(conn):
            row = await (conn.fetchrow(q.CLAIM_ONE, change_id) if change_id is not None
                         else conn.fetchrow(q.CLAIM, list(kinds), sorted(skip or ())))
            if row is None:
                return None
            cid, kind = int(row["change_id"]), row["kind"]
            if not await _lock_for(conn, kind, row):
                raise _Deferred
            ctx = await begin_load(conn, LOAD_KIND.get(kind, "judgment"),
                                   scope_ref={"source": "judgment_change", "change_ids": [cid], "kind": kind})
            step = await _dispatch(conn, ctx, row)
            await finalize(conn, ctx)
            if step is not None and step.error:
                await conn.execute(q.FAILED, cid, step.error)
                return QueueOutcome(cid, kind, "failed", ctx.load_id, error=step.error)
            if step is not None and not step.done:
                await conn.execute(q.PROGRESS, cid, ctx.load_id)
                return QueueOutcome(cid, kind, "progress", ctx.load_id)
            await conn.execute(q.APPLIED, cid, ctx.load_id)
            return QueueOutcome(cid, kind, "applied", ctx.load_id)
    except (_Deferred, ecat_engine.EcatBusy) as e:
        return QueueOutcome(cid or 0, kind, "deferred", error=str(e) if isinstance(e, ecat_engine.EcatBusy) else None)
    except Escalated as e:
        async with db.tx(conn):
            await conn.execute(q.ESCALATED, cid, describe_error(e))
            if kind == ECAT_KIND:                                    # 청크 하나가 상한을 넘음(HGH_ECAT_CHUNK 설정 오류): 반영 failed
                await ecat_engine.mark_failed(conn, cid, "ECAT_ESCALATED: " + describe_error(e))
        return QueueOutcome(cid or 0, kind, "escalated_rebuild", error=str(e))
    except Exception as e:  # noqa: BLE001  실패 기록은 새 트랜잭션(롤백으로 사라지지 않게)
        if cid is None:
            raise
        msg = describe_error(e)
        log.warning("judgment_change %s(%s) 실패: %s", cid, kind, msg)
        async with db.tx(conn):
            await conn.execute(q.FAILED, cid, msg)
            if kind == ECAT_KIND:
                await ecat_engine.mark_failed(conn, cid, msg)        # 반영 running → failed(재개 = op resume)
        return QueueOutcome(cid, kind, "failed", error=msg)


class _Deferred(Exception):
    """프로젝트 잠금을 못 잡음: 요청은 대기로 남기고 다음 틱에 다시 집는다."""


async def run_queue(db: LoaderDB, *, limit: int = 50, kinds: tuple[str, ...] = QUEUE_KINDS) -> list[QueueOutcome]:
    out: list[QueueOutcome] = []
    deferred: set[int] = set()
    async with db.session() as conn:
        for _ in range(limit):
            r = await process_change(db, conn, kinds=kinds, skip=deferred)
            if r is None:
                break
            out.append(r)
            if r.status == "deferred":
                deferred.add(r.change_id)          # 이번 틱에는 다시 집지 않는다(대기 유지)
    return out


# ════════════════════════════════════════════════════════════════════════════
# 아웃박스(app.scope_outbox → Scope)
# ════════════════════════════════════════════════════════════════════════════
@dataclass
class OutboxOutcome:
    outbox_id: int
    status: str                 # done | failed
    error: str | None = None


async def run_outbox(db: LoaderDB, source: Any, *, limit: int = 20, now: dt.datetime | None = None,
                     system_actor: uuid.UUID | None = None) -> list[OutboxOutcome]:
    actor = system_actor or get_ingest_settings().system_actor
    out: list[OutboxOutcome] = []
    seen: list[int] = []
    async with db.session() as conn:
        for _ in range(limit):
            async with db.tx(conn):
                rows = await conn.fetch(q.OUTBOX_CLAIM, now, 1, seen)
            if not rows:
                break
            r = rows[0]
            seen.append(int(r["outbox_id"]))
            lease = r["next_attempt_at"]
            creating = r["op"] == "create" and r["aggregate"] in ("project", "prompt")
            dispatched = False
            try:
                payload = r["payload"] if isinstance(r["payload"], dict) else json.loads(r["payload"])
                parse_outbox(r["aggregate"], r["op"], payload)       # core.contracts(생산자와 같은 계약)
                payload = await _fill_scope_ids(conn, r["aggregate"], r["aggregate_id"], payload)
                need = {"project": ["scope_project_id"], "schedule": ["scope_project_id"],
                        "prompt": ["scope_project_id", "scope_prompt_id"]}.get(r["aggregate"], [])
                if r["op"] == "create":
                    need = ["scope_project_id"] if r["aggregate"] == "prompt" else []
                missing = [k for k in need if not payload.get(k)]
                if missing:                                # 선행 생성(아웃박스 앞 행)이 아직 Scope id 를 되쓰지 않았다: 백오프 후 재시도
                    raise RuntimeError(f"Scope id 대기: {','.join(missing)}")
                if creating:
                    if actor is None:
                        raise RuntimeError("HGH_INGEST_SYSTEM_ACTOR 미설정: Scope id 되쓰기 행위자 없음")
                    async with db.tx(conn):
                        if not await conn.fetchval(q.OUTBOX_DISPATCH, r["outbox_id"], lease):
                            raise RuntimeError("Scope outbox lease lost")
                    dispatched = True
                async with asyncio.timeout(120):
                    resp = await source.write(r["aggregate"], r["op"], str(r["aggregate_id"]), payload)
                new_id = None
                if creating:
                    key = "project_id" if r["aggregate"] == "project" else "prompt_id"
                    try:
                        new_id = uuid.UUID(str(resp.get(key))) if isinstance(resp, dict) else None
                    except (ValueError, TypeError, AttributeError):
                        new_id = None
                    if not new_id or new_id.int == 0:
                        raise ValueError(f"Scope create response missing valid {key}")
                async with db.tx(conn):
                    if not await conn.fetchval(q.OUTBOX_OWNED, r["outbox_id"], lease):
                        raise RuntimeError("Scope outbox lease lost")
                    if creating:
                        await conn.execute(q.SYSTEM_ACTOR, str(actor))
                        sql = q.SET_PROJECT_SCOPE if r["aggregate"] == "project" else q.SET_PROMPT_SCOPE
                        if not await conn.fetchval(sql, r["aggregate_id"], new_id):
                            raise RuntimeError("Scope create local target missing")
                    await conn.fetchval(q.OUTBOX_DONE, r["outbox_id"], lease)
                out.append(OutboxOutcome(int(r["outbox_id"]), "done"))
            except Exception as e:  # noqa: BLE001  재시도(지수 백오프). 오류는 코드·경로만(비밀 없음)
                msg = describe_error(e)
                async with db.tx(conn):
                    if dispatched:
                        msg = f"scope_outcome_unknown: {msg}; reconcile before retry"
                        await conn.execute(q.OUTBOX_UNKNOWN, r["outbox_id"], lease, msg)
                    else:
                        await conn.execute(q.OUTBOX_FAIL, r["outbox_id"], msg, lease)
                out.append(OutboxOutcome(int(r["outbox_id"]), "failed", msg))
    return out


async def _fill_scope_ids(conn: asyncpg.Connection, aggregate: str, aggregate_id: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """갱신·삭제 페이로드에 Scope id 가 없으면 app 에서 채운다(생성 직후 같은 대상의 갱신이 줄 선 경우)."""
    p = dict(payload)
    if aggregate in ("project", "schedule") and not p.get("scope_project_id"):
        p["scope_project_id"] = await conn.fetchval(q.PROJECT_SCOPE_ID, aggregate_id)
    if aggregate == "prompt" and (not p.get("scope_prompt_id") or not p.get("scope_project_id")):
        row = await conn.fetchrow(q.PROMPT_SCOPE_IDS, aggregate_id)
        if row:
            p.setdefault("scope_prompt_id", row["scope_prompt_id"])
            p.setdefault("scope_project_id", row["scope_project_id"])
            p["scope_prompt_id"] = p["scope_prompt_id"] or row["scope_prompt_id"]
            p["scope_project_id"] = p["scope_project_id"] or row["scope_project_id"]
    return {k: (str(v) if isinstance(v, uuid.UUID) else v) for k, v in p.items()}


# ════════════════════════════════════════════════════════════════════════════
# dfs_fetch 빠른 경로
# ════════════════════════════════════════════════════════════════════════════
async def run_dfs(db: LoaderDB, dfs: DfsSource, *, limit: int = 5, now: dt.datetime | None = None) -> list[QueueOutcome]:
    """dfs_fetch 빠른 경로: 요청 1건 = DataForSEO 호출 여러 번(트랜잭션 밖, core.contracts.DfsFetch.endpoints × term) → 한 트랜잭션에
    ext.dfs_call·rd.kw_* 전부. 호출 하나라도 HTTP 오류면 그 요청 전체를 실패로 둔다(부분 적재 없음)."""
    out: list[QueueOutcome] = []
    async with db.session() as conn:
        async with db.tx(conn):
            expired = await conn.fetch(q.DFS_RECOVER, now)
            out.extend(QueueOutcome(int(r["change_id"]), "dfs_fetch", "failed", error="dfs_outcome_unknown: worker lease expired") for r in expired)
        for _ in range(limit):
            async with db.tx(conn):
                row = await conn.fetchrow(q.CLAIM, ["dfs_fetch"], [])
                if row is None:
                    break
                lease = await conn.fetchval(q.RUNNING, row["change_id"])
            cid = int(row["change_id"])
            try:
                p = row["payload"] if isinstance(row["payload"], dict) else json.loads(row["payload"] or "null")
                only: tuple[str, ...] | None = None
                legacy = legacy_dfs(p, list(row["subject_texts"] or []))
                if legacy is not None:                               # 옛 형식(전환 전 적재된 행): 1회 변환(검증 m-6)
                    p, only = legacy
                    log.warning("dfs_fetch %s: 옛 payload(endpoint=%s)를 새 계약으로 변환해 처리", cid, only[0])
                d = parse_change("dfs_fetch", p)
                calls = []
                async with asyncio.timeout(DFS_TIMEOUT_S):  # 외부 호출은 15분 임대보다 짧게. 유료 호출 자동 재시도 없음.
                    for endpoint, keywords, req in plan_calls(d, only):
                        status, body, cost = await dfs.call(endpoint, req)        # 트랜잭션 밖
                        calls.append((endpoint, keywords, req, status, body, cost))
                at = now or dt.datetime.now(dt.UTC)
                async with db.tx(conn):
                    if not await conn.fetchval(q.DFS_OWNED, cid, lease):
                        raise RuntimeError("dfs_outcome_unknown: worker lease lost")
                    ctx = await begin_load(conn, "dfs", scope_ref={"source": "dfs_fetch", "change_ids": [cid], "fetch": d.fetch})
                    for endpoint, keywords, req, status, body, cost in calls:
                        await write_dfs(conn, endpoint=endpoint, keywords=keywords, loc=d.location_code, lang=d.language_code, request=req,
                                        status=status, body=body, cost=cost, requested_by=row["requested_by"],
                                        project_id=str(d.project_id) if d.project_id else None, now=at)
                        if status >= 400:
                            raise RuntimeError(f"DataForSEO HTTP {status} ({endpoint})")
                    await finalize(conn, ctx)
                    await conn.execute(q.APPLIED, cid, ctx.load_id)
                out.append(QueueOutcome(cid, "dfs_fetch", "applied", ctx.load_id))
            except Exception as e:  # noqa: BLE001
                msg = describe_error(e)
                if isinstance(e, TimeoutError):
                    msg = "dfs_outcome_unknown: request deadline exceeded; reconcile before retry"
                async with db.tx(conn):
                    await conn.execute(q.DFS_FAILED, cid, lease, msg)
                out.append(QueueOutcome(cid, "dfs_fetch", "failed", error=msg))
    return out
