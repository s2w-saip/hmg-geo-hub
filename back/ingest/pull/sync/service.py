"""ingest.pull.sync: 20분 pull 패스(IG-1 오케스트레이터, DB-보정 §4 0~2·10단계)와 CLI sync.

패스(run_pass)
  0 프로젝트 등록 동기화(app.project·app.website_site → ing.sync_cursor·rd.dim_project) → 커서 임대 1개(또는 --project 지정)
    → 프롬프트 증분(ing.prompt UPSERT, regions·lang·kind·text 변경분은 별도 트랜잭션에서 rejudge('scope_prompt') 직접 호출:
      loader 가 판정 입력 큐를 거치지 않는 경로. 감사는 ing.load kind 'judgment', scope_ref.source 'scope_prompt')
  1 run 대조(R12): 건너뜀 = 이전 상태 있음 ∧ status·total_jobs 동일 ∧ (미해소 0 ∧ 분석 대기 0 ∨ now > 두 재확인 창).
    순서 신규 > 상태·총수 변경 > 재확인, 재확인만 프로젝트당 25(RECHECK_MAX_RUNS_PER_PASS), --max-runs 는 전체 상한.
  2 run 1개 = 적재 트랜잭션 1개: open_load(짧은 별도 트랜잭션) → 스테이지 전량 수신(페이지마다 stage_cursor 저장, 중단 뒤 재개)
    → 표면 공유 잠금 + 프로젝트 try 잠금 → Scope 관측 상태(run 상태·총수) 기록 → 해시 diff·ing 반영(자식 행 교체 전 capture_prior) → IG-3 attribute → rd.cycle 투영 → IG-2 apply → IG-3 reevaluate
    → finalize(세대 +1·load committed·스테이지 삭제) → COMMIT → 건드린 leaf ANALYZE. 실패는 롤백 후 fail_load·attempts+1·지수 백오프
    (연속 max_attempts 회면 blocked + 경보).
재개: 이미 반영한 run(해시 동일)은 쓰기 0(DN-7). 크래시 뒤 재실행은 staging 상태 run 의 stage_cursor 에서 이어받는다
(UNLOGGED 스테이지가 유실됐으면 처음부터: 멱등).
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

import asyncpg

from ingest.common.alerts import AlertSink, get_alert_sink
from ingest.common.config import IngestSettings, get_ingest_settings
from ingest.common.db import (
    LoadContext,
    LoaderDB,
    analyze,
    begin_load,
    delete_stage,
    describe_error,
    fail_load,
    finalize,
    lock_dims,
    lock_surface_shared,
    open_load,
    try_lock_project,
)
from ingest.common.rules import refresh_app_rules
from ingest.cycles.ledger import service as ledger
from ingest.ecat import scan as ecat_scan
from ingest.frz.freeze import freeze_published
from ingest.project.apply import queries as aq
from ingest.project.apply.rejudge import rejudge
from ingest.project.apply.service import apply, capture_prior, capture_prior_acr

from . import queries as q
from .source import ScopeError, ScopeSource
from .stage import _ts, acr_payload, job_rows

log = logging.getLogger("hgh.ingest.pull")
SURFACE_CODE = {"global": 1, "website": 2, "project": 3}


@dataclass
class RunOutcome:
    run_id: Any
    status: str                       # committed | skipped | failed | deferred
    load_id: int | None = None
    jobs_fetched: int = 0
    jobs_changed: int = 0
    jobs_removed: int = 0
    rd_answers: int = 0
    error: str | None = None


@dataclass
class PassReport:
    scope_project_id: Any = None
    registered: int = 0
    prompts_changed: int = 0
    runs: list[RunOutcome] = field(default_factory=list)
    skipped_runs: int = 0
    error: str | None = None


def _run_candidates(scope_runs: list[dict[str, Any]], ing_runs: dict[Any, asyncpg.Record], *, now: dt.datetime, force: bool,
                    recheck_cap: int) -> list[tuple[str, dict[str, Any]]]:
    """R12 워터마크 판정 → (kind, run) 목록. kind: run(신규·상태·총수 변경) | recheck(재확인 창 안 미해소)."""
    new, changed, recheck = [], [], []
    for r in scope_runs:
        rid = r["measurement_run_id"]
        prev = ing_runs.get(_uuid(rid))
        if prev is None:
            new.append(("run", r))
            continue
        same = prev["status"] == r.get("status") and prev["total_jobs"] == r.get("total_jobs")
        if prev["sync_state"] in ("staging", "new", "deferred"):   # 재개·재시도(크래시·수신 중단·적재 실패). 백오프 시각 전이면 다음 패스
            if force or prev["next_attempt_at"] is None or prev["next_attempt_at"] <= now:
                changed.append(("run", r))
            continue
        if prev["sync_state"] == "blocked" and not force:
            continue
        if not same:
            changed.append(("run", r))
            continue
        if force:
            recheck.append(("recheck", r))
            continue
        settled = prev["unresolved_jobs"] == 0 and prev["analysis_pending"] == 0
        windows_closed = all(w is not None and now > w for w in (prev["recheck_until"], prev["analysis_recheck_until"]))
        if settled or windows_closed:
            continue
        if prev["next_attempt_at"] is not None and prev["next_attempt_at"] > now:
            continue
        recheck.append(("recheck", r))
    new.sort(key=lambda x: str(x[1].get("started_at") or ""))
    changed.sort(key=lambda x: str(x[1].get("started_at") or ""))
    recheck.sort(key=lambda x: str(x[1].get("started_at") or ""))
    if not force:
        recheck = recheck[:recheck_cap]
    return new + changed + recheck


def _uuid(v: Any) -> Any:
    import uuid as _u
    return v if isinstance(v, _u.UUID) else _u.UUID(str(v))


async def register_projects(db: LoaderDB) -> int:
    """app 프로젝트·웹사이트 사이트의 Scope 프로젝트 → ing.sync_cursor·rd.dim_project(app 유래 국가 차원 포함)."""
    async with db.session() as conn, db.tx(conn):
        rows = await conn.fetch(q.REGISTER)
        ids = [r[0] for r in rows]
        if ids:
            await refresh_app_rules(conn)
            await lock_dims(conn)
            await conn.execute(aq.DIM_COUNTRY, [r[0] for r in await conn.fetch(aq.APP_COUNTRY_CODES)])
            await conn.execute(aq.DIM_PROJECT, ids)
    return len(ids)


async def lease(db: LoaderDB, project: Any = None) -> asyncpg.Record | None:
    async with db.session() as conn, db.tx(conn):
        if project is not None:
            return await conn.fetchrow(q.LEASE_ONE, _uuid(project))
        return await conn.fetchrow(q.LEASE_NEXT)


def _enabled(p: dict[str, Any]) -> bool | None:
    """Scope 프롬프트 응답의 enabled(코어 prompts.enabled, lib/prompts/store.ts serialize). 없거나 불리언이 아니면 None(모름 = 활성 취급).
    응답의 active 는 '삭제 아님'(deleted_at IS NULL)이라 쓰지 않는다: 삭제된 프롬프트는 목록에 나오지 않는다."""
    v = p.get("enabled")
    return v if isinstance(v, bool) else None


async def sync_prompts(db: LoaderDB, source: ScopeSource, cur: asyncpg.Record) -> int:
    """프롬프트 증분 + 시장 설정. 판정 입력이 바뀐 프롬프트와 새 프롬프트(rd.dim_prompt 없음)는 별도 트랜잭션에서
    rejudge('scope_prompt') 를 직접 부른다(loader 가 판정 입력 큐를 거치지 않는 경로, ing.load kind 'judgment')."""
    pid = cur["scope_project_id"]
    frm = cur["prompts_updated_to"].isoformat() if cur["prompts_updated_to"] else None
    prompts = await source.list_prompts(str(pid), updated_from=frm)
    project = await source.get_project(str(pid))
    targets: list[Any] = []
    async with db.session() as conn:
        async with db.tx(conn):
            if prompts:
                cols = list(zip(*[(
                    _uuid(p["prompt_id"]), pid, p.get("text"), p.get("funnel_stage"), p.get("lang"), p.get("kind"),
                    _ts(p.get("updated_at") or p.get("created_at")),
                    json.dumps(p["regions"]) if p.get("regions") is not None else None, _enabled(p)) for p in prompts], strict=True))
                changed = [r[0] for r in await conn.fetch(q.PROMPT_UPSERT, *[list(c) for c in cols])]
                fresh = [r[0] for r in await conn.fetch(
                    "SELECT x FROM unnest($1::uuid[]) x WHERE NOT EXISTS (SELECT 1 FROM rd.dim_prompt d WHERE d.prompt_id = x)", list(cols[0]))]
                targets = sorted(set(changed) | set(fresh), key=str)
                hi = max((_ts(p.get("updated_at") or p.get("created_at")) for p in prompts), default=None)
                if hi is not None:
                    await conn.execute(q.PROMPTS_CURSOR, pid, hi)
            regions = project.get("regions")
            if regions is not None and await conn.fetch(q.CURSOR_REGIONS, pid, list(regions)):
                await conn.execute(q.DIM_PROJECT_REGIONS, pid, list(regions))
        if targets:
            async with db.tx(conn):
                ctx = await begin_load(conn, "judgment", scope_ref={"source": "scope_prompt", "scope_project_id": str(pid),
                                                                    "prompts": [str(x) for x in targets]})
                await rejudge(conn, ctx, "scope_prompt", subject_uuids=targets)
                await finalize(conn, ctx)
    return len(targets)


async def run_pass(db: LoaderDB, source: ScopeSource, *, project: Any = None, force: bool = False, max_runs: int | None = None,
                   now: dt.datetime | None = None, settings: IngestSettings | None = None, alerts: AlertSink | None = None) -> PassReport:
    """pull 패스 1회(프로젝트 1개). 워커 루프·CLI 가 같은 함수를 부른다."""
    s = settings or get_ingest_settings()
    alerts = alerts or get_alert_sink()
    rep = PassReport()
    t0 = time.monotonic()
    rep.registered = await register_projects(db)
    cur = await lease(db, project)
    if cur is None:
        rep.error = "no_cursor" if project is not None else None
        return rep
    pid = cur["scope_project_id"]
    rep.scope_project_id = pid
    err: str | None = None
    try:
        rep.prompts_changed = await sync_prompts(db, source, cur)
        scope_runs = await source.list_runs(str(pid))
        async with db.session() as conn:
            ing_runs = {r["run_id"]: r for r in await conn.fetch(q.RUNS_OF_PROJECT, pid)}
        now_ = now or dt.datetime.now(dt.UTC)
        cands = _run_candidates(scope_runs, ing_runs, now=now_, force=force, recheck_cap=s.recheck_max_runs)
        rep.skipped_runs = len(scope_runs) - len(cands)
        if max_runs is not None:
            cands = cands[:max_runs]
        for kind, r in cands:
            if time.monotonic() - t0 > s.pass_budget_s:
                log.info("패스 예산 소진: 남은 run %d 은 다음 패스", len(cands))
                break
            out = await load_run(db, source, pid, cur["surface"], r, kind=kind, force=force, settings=s, alerts=alerts, now=now_)
            rep.runs.append(out)
            if out.status == "failed":
                err = out.error
    except ScopeError as e:
        err = describe_error(e)
    except Exception as e:  # noqa: BLE001  커서에 사유를 남기고 다음 패스로(워커를 죽이지 않는다)
        err = describe_error(e)
        log.exception("pull 패스 실패 project=%s", pid)
    async with db.session() as conn, db.tx(conn):
        await conn.execute(q.CURSOR_DONE, pid, err)
    rep.error = err
    return rep


async def _stage_run(db: LoaderDB, source: ScopeSource, pid: Any, run: asyncpg.Record, ctx: LoadContext) -> tuple[int, list[Any]]:
    """스테이지 전량 수신. 페이지마다 stage_cursor = {load_id, cursor} 저장(재개). 반환 = (job 수, 본문 보충 실패 job)."""
    cursor: str | None = None
    if run["sync_state"] == "staging" and run["stage_cursor"]:
        try:
            sc = json.loads(run["stage_cursor"])
        except ValueError:
            sc = {}
        if sc.get("load_id") == ctx.load_id:
            cursor = sc.get("cursor")
    unresolved: list[Any] = []
    async with db.session() as conn:
        await conn.execute(q.ENSURE_ING_MONTH, run["run_month"])
        for _ in range(100_000):
            jobs, nxt = await source.list_run_jobs(str(pid), str(run["run_id"]), cursor)
            rows: dict[str, list[tuple]] = {"answer": [], "mention": [], "occurrence": [], "stance": [], "citation": []}
            prs: dict[str, dict[str, Any]] = {}
            for job in jobs:
                result = job.get("result")
                fallback = False
                if result is None and job.get("status") == "completed":
                    try:
                        result = (await source.get_query_run(job["job_id"])).get("result")
                        fallback = result is not None
                    except ScopeError:
                        unresolved.append(_uuid(job["job_id"]))
                jr = job_rows(job, run_id=run["run_id"], run_month=run["run_month"], load_id=ctx.load_id, result=result, fallback=fallback)
                for k, v in jr.items():
                    rows[k].extend(v)
                p = acr_payload(job)
                if p:
                    _merge_acr(prs.setdefault(p["prompt_run_id"], {**p, "job_ids": [], "names": {}}), p)
            async with conn.transaction():
                await conn.execute(q.STAGE_CLEAR_JOBS, ctx.load_id, [_uuid(j["job_id"]) for j in jobs])
                if rows["answer"]:
                    await conn.executemany(q.STAGE_ANSWER, rows["answer"])
                for key, sql in (("mention", q.STAGE_MENTION), ("occurrence", q.STAGE_OCC), ("stance", q.STAGE_STANCE),
                                 ("citation", q.STAGE_CIT)):
                    if rows[key]:
                        await conn.executemany(sql, rows[key])
                for prid, p in prs.items():          # 페이지를 넘는 prompt-run(반복 job 이 여러 페이지)은 스테이지에서 합친다(재개 안전)
                    old = await conn.fetchval("DELETE FROM ing.stage_acr WHERE load_id = $1 AND prompt_run_id = $2 RETURNING payload",
                                              ctx.load_id, _uuid(prid))
                    if old:
                        prev = json.loads(old) if isinstance(old, str) else old
                        _merge_acr(p, prev)
                    await conn.execute(q.STAGE_ACR, ctx.load_id, _uuid(prid), json.dumps(p, default=str))
                await conn.execute(q.RUN_STAGING, run["run_id"], json.dumps({"load_id": ctx.load_id, "cursor": nxt}))
            cursor = nxt
            if not nxt:
                break
        n = int(await conn.fetchval(q.STAGE_COUNT, ctx.load_id))
    return n, unresolved


def _merge_acr(into: dict[str, Any], p: dict[str, Any]) -> None:
    """같은 prompt-run 의 반복 job 들: job_ids 합집합, 이름 사전 합치기, rows·measured_at 은 가장 늦은 측정 job 의 값."""
    ids = list(dict.fromkeys([*into.get("job_ids", []), *([p["job_id"]] if p.get("job_id") else []), *p.get("job_ids", [])]))
    into["job_ids"] = ids
    names = dict(into.get("names") or {})
    names.update(p.get("names") or {})
    into["names"] = names
    if str(p.get("measured_at") or "") >= str(into.get("measured_at") or ""):
        into["measured_at"] = p.get("measured_at")
        into["rows"] = p.get("rows") or []


async def _write_acr(conn: asyncpg.Connection, ctx: LoadContext, run_id: Any, changed_jobs: set[Any]) -> list[Any]:
    """바뀐 job 이 속한 prompt-run 을 ing.acr_prompt_run·acr_rollup_row 에 반영(현행 acrRollupRows sync.ts:1150-1216).
    다시 쓸 prompt-run 은 이번 load 스테이지 payload 중 job_ids 가 바뀐 job 과 겹치는 것이다. 롤업 행을 지우기 전에 그 목록 그대로
    옛 롤업 엔티티를 스냅샷한다(capture_prior_acr, 결함 N1: 롤업에서만 나오던 엔티티가 빠지면 dim_entity 고아가 남는다)."""
    out: list[Any] = []
    targets: list[dict[str, Any]] = []
    for rec in await conn.fetch(q.STAGE_ACR_ROWS, ctx.load_id):
        p = json.loads(rec["payload"]) if isinstance(rec["payload"], str) else rec["payload"]
        if {_uuid(j) for j in p["job_ids"]} & changed_jobs:
            targets.append(p)
    if targets:
        await capture_prior_acr(conn, [_uuid(p["prompt_run_id"]) for p in targets])
    for p in targets:
        rows = p.get("rows") or []
        head = rows[0] if rows else {}
        co = head.get("choiceOutcomeBreakdown") or {}
        planned = int(head.get("plannedIterations") or 0)
        t1 = min(int(head.get("validTurn1Iterations") or 0), planned)
        acr_v = min(int(head.get("validAcrIterations") or 0), t1)
        await conn.fetchval(q.ACR_UPSERT, _uuid(p["prompt_run_id"]), run_id, _uuid(p["prompt_id"]) if p.get("prompt_id") else None,
                            p.get("target") or "", p.get("region"), _ts(p.get("measured_at")), planned, t1, acr_v,
                            int(co.get("single_entity") or 0), int(co.get("conditional_multiple") or 0), int(co.get("generic_category") or 0),
                            int(co.get("resolved_off_shortlist") or 0), int(co.get("unresolved_choice") or 0), int(co.get("none") or 0),
                            [_uuid(j) for j in p["job_ids"]], json.dumps({"prompt_run_id": p["prompt_run_id"], "rows": rows}), ctx.load_id)
        await conn.execute(q.ACR_ROWS_DELETE, _uuid(p["prompt_run_id"]))
        names = p.get("names") or {}
        seen: set[tuple] = set()
        for r in sorted(rows, key=lambda x: 0 if x.get("rollupLevel") == "brand" else 1):
            key = (r.get("entityId"), r.get("rollupLevel") or "brand")
            if not key[0] or key in seen:
                continue
            seen.add(key)
            nm = names.get(key[0]) or {}
            brand_id = nm.get("brand")
            parent = (names.get(brand_id) or {}).get("name") if brand_id and brand_id != key[0] else nm.get("name")
            await conn.execute(q.ACR_ROW_INSERT, _uuid(p["prompt_run_id"]), _uuid(key[0]), key[1], run_id, nm.get("name"),
                               _uuid(brand_id) if brand_id else None, parent, None,
                               int(r.get("appearanceCount") or 0), int(r.get("choiceCount") or 0), int(r.get("conditionalChoiceCount") or 0),
                               int(r.get("offShortlistChoiceCount") or 0), int(r.get("unresolvedChoiceCount") or 0),
                               int(r.get("genericChoiceCount") or 0), r.get("appearanceRate"), r.get("acr"), r.get("overallChoiceShare"))
        out.append(p["prompt_run_id"])
    return out


async def load_run(db: LoaderDB, source: ScopeSource, pid: Any, surface: str, r: dict[str, Any], *, kind: str = "run", force: bool = False,
                   settings: IngestSettings | None = None, alerts: AlertSink | None = None, now: dt.datetime | None = None) -> RunOutcome:
    """run 1개 = 적재 트랜잭션 1개. 실패하면 롤백하고 attempts·백오프·경보를 남긴다."""
    s = settings or get_ingest_settings()
    alerts = alerts or get_alert_sink()
    run_id = _uuid(r["measurement_run_id"])
    observed = (run_id, pid, r.get("status") or "unknown", r.get("trigger"), r.get("targets"), r.get("regions"), r.get("total_jobs"),
                _ts(r.get("started_at")), _ts(r.get("completed_at")), _ts(r.get("cycle_anchor_at")))
    # 새 run 만 원장에 먼저 넣는다(스테이지 상태·재개 커서를 적을 행). 기존 run 의 Scope 관측 상태(상태·총수·완료 시각·앵커)는 적재
    # 트랜잭션에서만 기록한다: 적재 전에 커밋하면 그 사이 죽었을 때 R12 가 "이미 본 상태"로 보고 처리하지 않은 run 을 건너뛴다(결함 D3).
    async with db.session() as conn, db.tx(conn):
        prev = await conn.fetchrow(q.RUN_OF, run_id)
        if prev is None:
            await conn.fetchrow(q.RUN_UPSERT, *observed)
        run = await conn.fetchrow(q.RUN_OF, run_id)
    status_changed = prev is not None and prev["status"] != observed[2]
    ctx: LoadContext | None = None
    resume = None
    if run["sync_state"] == "staging" and run["stage_cursor"]:
        try:
            resume = json.loads(run["stage_cursor"]).get("load_id")
        except ValueError:
            resume = None
    if resume:
        async with db.session() as conn:
            st = await conn.fetchrow("SELECT load_id, status, kind, rule_ver FROM ing.load WHERE load_id = $1", resume)
            staged = await conn.fetchval(q.STAGE_COUNT, resume)
        if st and st["status"] == "running" and (staged or 0) > 0:
            ctx = LoadContext(load_id=int(st["load_id"]), kind=st["kind"], rule_ver=int(st["rule_ver"]), scope_project_id=pid)
        elif st and st["status"] == "running":       # UNLOGGED 스테이지 유실(크래시 재기동): 옛 load 는 실패로 닫고 처음부터(멱등)
            await fail_load(db, int(st["load_id"]), "stage lost: 처음부터 다시 수신")
    if ctx is None:
        ctx = await open_load(db, kind, run_id=run_id, scope_project_id=pid,
                              scope_ref={"scope_project_id": str(pid), "surface": surface, "run_status": observed[2],
                                         "total_jobs": observed[6], "force": force, "source": "scope_api"})
    out = RunOutcome(run_id=run_id, status="failed", load_id=ctx.load_id)
    try:
        fetched, unresolved = await _stage_run(db, source, pid, run, ctx)
    except Exception as e:  # noqa: BLE001  수신 중단: 받은 페이지가 있으면 스테이지·load 를 남기고(재개) run 만 백오프
        out.error = describe_error(e)
        log.warning("run %s 수신 중단(다음 패스 재개): %s", run_id, out.error)
        async with db.session() as conn:
            staged = int(await conn.fetchval(q.STAGE_COUNT, ctx.load_id))
        if not staged:                               # 첫 페이지부터 실패: 이어받을 것이 없다 → load 실패로 닫고 재시도 대기
            await fail_load(db, ctx.load_id, e)
        async with db.session() as conn, db.tx(conn):
            st = await conn.fetchrow(q.RUN_STAGE_FAIL if staged else q.RUN_FAIL, run_id, out.error, s.max_attempts, now)
        if st and st["sync_state"] == "blocked":
            await alerts.send("live", f"run 수신 {st['attempts']}회 연속 실패로 blocked: run={run_id} project={pid}", {"error": out.error})
        return out
    out.jobs_fetched = fetched
    ctx.counters["jobs_fetched"] = fetched
    try:
        async with db.session() as conn:
            async with db.tx(conn):
                await lock_surface_shared(conn, SURFACE_CODE.get(surface, 3))
                if not await try_lock_project(conn, pid):
                    out.status = "deferred"          # 같은 프로젝트의 큐 처리·재판정과 충돌: 스테이지를 두고 다음 패스
                    return out
                await conn.fetchrow(q.RUN_UPSERT, *observed)   # Scope 관측 상태: RUN_LOADED 와 같은 커밋(D3)
                await conn.execute(q.KEYS, ctx.load_id)
                await conn.execute(q.FILL_KEYS, ctx.load_id)
                await conn.execute(q.CHANGED.format(load_id=int(ctx.load_id)))
                changed_jobs = {x[0] for x in await conn.fetch(q.CHANGED_JOBS)}
                changed_keys = [int(x[0]) for x in await conn.fetch(q.CHANGED_KEYS)]
                out.jobs_changed = len(changed_keys)
                out.jobs_removed = int(await conn.fetchval(q.REMOVED, run_id, ctx.load_id))
                ctx.counters["jobs_changed"] = out.jobs_changed
                ctx.counters["jobs_removed"] = out.jobs_removed
                if changed_keys:
                    await capture_prior(conn, changed_keys)      # 자식 행을 지우기 전: 줄어드는 방향의 전역 판정 복귀(D2)
                    await conn.execute(q.UPSERT_ANSWER, ctx.load_id)
                    await conn.execute(q.CHILDREN.format(load_id=int(ctx.load_id)))
                    await ecat_scan.on_load(conn, ctx)           # 허브 추가 표면 재스캔(새 답변·본문 해시 변경, E2)
                await _write_acr(conn, ctx, run_id, changed_jobs)
                await conn.execute(q.RUN_COUNTERS, run_id, ctx.load_id, unresolved)
                # 3단계(IG-3) → 투영(IG-2) → 9단계(IG-3)
                new_cyc = await ledger.attribute(conn, ctx, [run_id])
                cyc = {x[0] for x in await conn.fetch(ledger.q.CYCLES_OF_RUNS, [run_id])} | new_cyc
                moved = await ledger.project_cycles(conn, ctx, cyc)
                if changed_keys or status_changed or new_cyc or moved:
                    res = await apply(conn, ctx, changed_keys, extra_runs=[run_id] if (status_changed or new_cyc or moved) else None)
                    out.rd_answers = res.answers
                    for w in res.warnings:
                        log.warning("run %s: %s", run_id, w)
                rv = await ledger.reevaluate(conn, ctx, cyc, now=now)
                if rv["moved_runs"]:
                    await apply(conn, ctx, [], extra_runs=rv["moved_runs"])
                await freeze_published(conn, rv["published"])                    # 발행 직후 동결 세대(DB-v2.22, 같은 트랜잭션)
                await conn.execute(q.RUN_LOADED, run_id, ctx.load_id)
                await finalize(conn, ctx)
            if ctx.rd_changed:
                await analyze(conn, ("rd.job", "rd.answer", "rd.answer_brand", "rd.answer_stance", "rd.citation"))
        out.status = "committed"
        return out
    except Exception as e:  # noqa: BLE001  적재 트랜잭션 실패: 롤백됐다. load failed·스테이지 삭제·run 백오프(처음부터 다시 수신)
        out.error = describe_error(e)
        log.warning("run %s 적재 실패: %s", run_id, out.error)
        await fail_load(db, ctx.load_id, e)
        async with db.session() as conn, db.tx(conn):
            await delete_stage(conn, ctx.load_id)
            st = await conn.fetchrow(q.RUN_FAIL, run_id, out.error, s.max_attempts, now)
        if st and st["sync_state"] == "blocked":
            await alerts.send("live", f"run 적재 {st['attempts']}회 연속 실패로 blocked: run={run_id} project={pid}", {"error": out.error})
        return out
