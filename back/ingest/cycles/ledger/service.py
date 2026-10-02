"""ingest.cycles.ledger: 회차 귀속·재평가(IG-3 FUNC, DB-보정 §4 3·9단계)와 회차 운영 요청 처리.

FUNC 표면(HTTP 없음. 회차 운영 HTTP 는 AD-4 소관이고 이 모듈은 그 큐의 소비자)
  attribute(conn, ctx, run_ids)          3단계: 미귀속 run → 회차 개설(ON CONFLICT DO NOTHING)·좌석 배정(R02)·ing.cycle_run 귀속
  reevaluate(conn, ctx, cycle_ids, now)  9단계: 카운터 → 게이트 계획 채움 → 종결(R01 3팔) → 게이트 판정 → 발행(R08)·노출일 → rd.cycle 투영
  project_cycles(conn, ctx, cycle_ids)   rd.cycle 1:1 투영. 좌석(round_date)이 바뀐 회차의 run 목록을 돌려준다(사실 행 재투영 대상)
  handle_cycle_admin / handle_report_publication / handle_anchor_pin / handle_answer_drop  judgment_change 운영 kind 처리

회차 상태 코드·노출 규칙은 조회 시 판정(R03 view_date ≤ 오늘, hidden_scope)이라 여기서는 원장 값만 투영한다.

발행 게이트(DB-v2.14, 제품 결정 16~18: global·website 비파생 회차만, project 는 현행처럼 닫히면 노출)
  계획   회차를 여는 순간 ing.active_units 스냅샷 → ing.cycle_unit(plan_source 'open'). 계획 없는 미발행 대상 회차는 재평가가 처음 볼 때
         현재 카탈로그로 채운다('backfill', 앵커 뒤 등록 프롬프트 제외, 이관 당시 이미 닫힌 이관 회차는 quiet).
  판정   분모 = 계획 ∩ 현재 활성 − 봉인, pass = 빠짐 0. R08 = forced ∨ (pass ∧ 분석 비율). 미달 알림은 cycles.watch publish_gate.
  운영   cycle_admin seal(빠진 유닛 전부 또는 지정, 사유 필수) · force_publish(사유 필수, 열려 있으면 운영자 마감 뒤 발행).
"""
from __future__ import annotations

import datetime as dt
import logging
import uuid
from typing import Any

import asyncpg

from ingest.common.db import LoadContext

from . import queries as q

log = logging.getLogger("hgh.ingest.cycles")

CANONICAL_DOW = {"global": 1, "website": 5, "project": None}     # hmg_round_canonical_dow(0077:163): 표준 월·웹사이트 금·프로젝트 없음
HIDE_SCOPES = ("all", "citations", "mentions")
GATED_SURFACES = ("global", "website")                         # 제품 결정 18
ADMIN_OPS = ("hide", "unhide", "close", "set_view_date", "seal", "force_publish", "regenerate")


def canonical_dow(surface: str) -> int | None:
    return CANONICAL_DOW.get(surface)


def prev_canonical(d: dt.date, dow: int) -> dt.date:
    """d 이전(엄격)의 가장 가까운 정규 요일(hmg_round_prev_canonical). d 자신이 정규 요일이면 7일 전."""
    diff = (d.isoweekday() - dow + 7) % 7
    return d - dt.timedelta(days=diff or 7)


def next_canonical(d: dt.date, dow: int) -> dt.date:
    diff = (dow - d.isoweekday() + 7) % 7
    return d + dt.timedelta(days=diff or 7)


async def assign_seat(conn: asyncpg.Connection, scope_project_id: Any, surface: str, anchor_date: dt.date) -> tuple[dt.date, str]:
    """R02 좌석 배정(과거 배정은 재계산하지 않는다: 매핑이 있으면 그대로). 자리 점유 = 그 프로젝트에 그 날짜로 귀속된 회차."""
    have = await conn.fetchrow(q.SEAT_OF, scope_project_id, anchor_date)
    if have:
        return have["round_date"], have["basis"]
    dow = canonical_dow(surface)
    if dow is None:
        rd_, basis = anchor_date, "project"
    elif anchor_date.isoweekday() == dow:
        rd_, basis = anchor_date, "canonical"
    else:
        prev, nxt = prev_canonical(anchor_date, dow), next_canonical(anchor_date, dow)
        prev_taken = bool(await conn.fetchval(q.SEAT_TAKEN, scope_project_id, prev))
        next_taken = bool(await conn.fetchval(q.SEAT_TAKEN, scope_project_id, nxt))
        if not prev_taken and next_taken:
            rd_, basis = prev, "prev_empty"
        elif prev_taken and not next_taken:
            rd_, basis = nxt, "next_empty"
        else:
            rd_ = prev if (anchor_date - prev) <= (nxt - anchor_date) else nxt
            basis = "merged" if prev_taken else "nearest"
    await conn.execute(q.INSERT_SEAT, scope_project_id, anchor_date, surface, rd_, basis)
    return rd_, basis


def _kst_date(t: dt.datetime) -> dt.date:
    return (t.astimezone(dt.timezone(dt.timedelta(hours=9)))).date()


async def attribute(conn: asyncpg.Connection, ctx: LoadContext, run_ids: list[Any]) -> set[Any]:
    """미귀속 run 을 회차에 붙인다. 반환 = 건드린 cycle_id(새 회차·새 멤버).
    원장 회차가 이미 닫혔으면(closed·published·stale) 'late' 귀속, 발행 회차면 stale_since 표시(값은 재발행 전까지 유지)."""
    touched: set[Any] = set()
    if not run_ids:
        return touched
    rows = await conn.fetch(q.UNATTRIBUTED_RUNS, list(run_ids))
    for r in rows:
        pid, surface = r["scope_project_id"], r["surface"]
        cyc = None
        if r["cycle_anchor_at"] is not None:
            anchor, has_scope_anchor = r["cycle_anchor_at"], True
            cyc = await conn.fetchrow(q.FIND_CYCLE, pid, anchor)
        else:
            has_scope_anchor = False
            anchor = r["first_at"]
            if anchor is None:
                raise ValueError(f"run {r['run_id']}: 앵커·측정 시각·시작 시각이 모두 없어 회차를 정할 수 없다")
            cyc = await conn.fetchrow(q.FIND_DERIVED, pid, anchor)
        if cyc is None:
            anchor_date = _kst_date(anchor)
            round_date, _ = await assign_seat(conn, pid, surface, anchor_date)
            source = "derived" if (surface == "project" or not has_scope_anchor) else "scope"
            cid = await conn.fetchval(q.INSERT_CYCLE, pid, anchor, surface, source, round_date)
            if cid is None:                                       # 동시 개설: 이미 있다
                cyc = await conn.fetchrow(q.FIND_CYCLE, pid, anchor)
                cid = cyc["cycle_id"]
            elif surface in GATED_SURFACES and source == "scope":  # 발행 게이트 계획 = 개설 시점 카탈로그(제품 결정 16)
                await ensure_plans(conn, [cid], source="open")
            by = "derived" if source == "derived" else "scope"
        else:
            cid = cyc["cycle_id"]
            if cyc["status"] in ("closed", "published", "stale"):
                by = "late"
                await conn.execute(q.MARK_STALE, cid)
            else:
                by = "derived" if cyc["anchor_source"] == "derived" else "scope"
        await conn.execute(q.INSERT_CYCLE_RUN, r["run_id"], cid, by)
        touched.add(cid)
    ctx.touched_cycle_ids |= touched
    return touched


async def project_cycles(conn: asyncpg.Connection, ctx: LoadContext, cycle_ids: set[Any] | list[Any]) -> list[Any]:
    """rd.cycle 투영. 반환 = 좌석이 바뀐 회차의 run_id(사실 행 파티션 이동 → IG-2 reproject)."""
    ids = list(cycle_ids)
    if not ids:
        return []
    before = {r["cyc_key"]: r["round_date"] for r in await conn.fetch(q.CYCLE_ROUND_BEFORE, ids)}
    from app.core.profile import active_profile

    prof = active_profile()
    seat_before = {r["cyc_key"]: tuple(r) for r in await conn.fetch(q.CYCLE_SEAT_STATE, ids)} if prof.rep_round_date_cell else {}
    rows = await conn.fetch(q.PROJECT_CYCLES, ids)
    moved: list[Any] = []
    for r in rows:
        ctx.surfaces.add(int(r["surface"]))
        ctx.touched_cycle_ids.add(r["cycle_id"])
        ctx.rd_changed = True
    if rows:
        # 창 판정(core.cycles.pick_holes)이 읽는 함대 가시·판정 갭. 개설·귀속·카운터·종결·발행이 모두 이 투영을 지난다
        await conn.execute(q.REFRESH_PICK_BASIS, ids)
        after = {r["cyc_key"]: r["round_date"] for r in await conn.fetch(q.CYCLE_ROUND_BEFORE, ids)}
        moved_cyc = [k for k, v in after.items() if k in before and before[k] != v]
        if moved_cyc:
            moved = [r["run_id"] for r in await conn.fetch(
                "SELECT cr.run_id FROM ing.cycle_run cr JOIN ing.cycle c ON c.cycle_id = cr.cycle_id WHERE c.cyc_key = ANY($1::int4[])", moved_cyc)]
        if prof.rep_round_date_cell:
            await _reselect_changed_seats(conn, ids, seat_before)
    return moved


async def _reselect_changed_seats(conn: asyncpg.Connection, ids: list[Any], seat_before: dict[int, tuple]) -> None:
    """답변분석 경로 셀 대표(현행 프로필 rep_round_date_cell, WU-12): 대표 후보(서빙 ∧ 숨김 아님)나 좌석이 바뀐 회차의 자리(옛·새)를 다시 고르고
    (인용 계열 보정 rd.rep_cit_delta 도 같은 함수가 교체) is_rep 이 바뀐 답변의 자식 사본을 맞춘다. 새 회차(투영 전 행 없음)는 답변이 들어올 때 적재기 REP_UPDATE_SEAT 가 고른다."""
    seats: set[tuple[int, Any]] = set()
    for r in await conn.fetch(q.CYCLE_SEAT_STATE, ids):
        old = seat_before.get(r["cyc_key"])
        if old is None or old == tuple(r):
            continue
        seats.add((int(old[1]), old[2]))
        seats.add((int(r["surface"]), r["round_date"]))
    if not seats:
        return
    sv = sorted(seats)
    flipped = [int(x["answer_key"]) for x in await conn.fetch(q.SEAT_RESELECT, [s for s, _ in sv], [d for _, d in sv])]
    if flipped:
        await conn.execute("SELECT rd.propagate_answer_gates($1::int4[])", flipped)


async def ensure_plans(conn: asyncpg.Connection, cycle_ids: list[Any], *, source: str, now: dt.datetime | None = None) -> list[Any]:
    """계획(ing.cycle_unit + ing.cycle_gate)이 없는 게이트 대상 회차에 계획을 만든다. source = open | backfill. 반환 = 새로 만든 회차."""
    if not cycle_ids:
        return []
    if source not in ("open", "backfill"):
        raise ValueError(f"plan source: {source}")
    return [r[0] for r in await conn.fetch(q.ENSURE_PLAN, list(cycle_ids), source, now or dt.datetime.now(dt.UTC))]


async def missing_units(conn: asyncpg.Connection, cycle_id: Any) -> list[asyncpg.Record]:
    """빠진 유닛(계획 ∩ 현재 활성 − 봉인 − 완료). (prompt_id, target, region)."""
    return list(await conn.fetch(q.MISSING_UNITS, cycle_id))


async def reevaluate(conn: asyncpg.Connection, ctx: LoadContext, cycle_ids: set[Any] | list[Any], *, now: dt.datetime | None = None) -> dict[str, list[Any]]:
    """카운터 → 게이트 계획 채움 → 종결(R01) → 게이트 판정 → 발행(R08) → rd.cycle 투영.
    반환 = {counters, closed, planned(새 계획), gate(판정이 바뀐 회차), published, moved_runs}."""
    ids = list(cycle_ids)
    out: dict[str, list[Any]] = {"counters": [], "closed": [], "planned": [], "gate": [], "published": [], "moved_runs": []}
    if not ids:
        return out
    now = now or dt.datetime.now(dt.UTC)
    quiet = int(await conn.fetchval("SELECT coalesce((SELECT (value #>> '{}')::int FROM app.rule_param WHERE key = 'cycle_complete_quiet_hours'), 36)"))
    recheck = int(await conn.fetchval("SELECT coalesce((SELECT (value #>> '{}')::int FROM app.rule_param WHERE key = 'run_recheck_days'), 3)"))
    out["counters"] = [r[0] for r in await conn.fetch(q.COUNTERS, ids)]
    # 계획 채움은 종결 전에: 이번 재평가 전부터 닫혀 있던 이관 회차만 quiet 가 된다(이번에 닫히는 회차는 알림 대상)
    out["planned"] = await ensure_plans(conn, ids, source="backfill", now=now)
    out["closed"] = [r[0] for r in await conn.fetch(q.CLOSE_OPEN, ids, now, quiet, recheck)]
    out["gate"] = [r[0] for r in await conn.fetch(q.GATE_EVAL, ids, now)]
    out["published"] = [r[0] for r in await conn.fetch(q.PUBLISH, ids, now)]
    out["moved_runs"] = await project_cycles(conn, ctx, ids)
    return out


# ════════════════════════════════════════════════════════════════════════════
# 운영 요청(judgment_change) 처리. 반환 = 재투영이 필요한 대상(run·답변 키)
# ════════════════════════════════════════════════════════════════════════════
class BadRequest(ValueError):
    """페이로드 형식 오류(큐 행을 failed 로 기록)."""


async def handle_cycle_admin(conn: asyncpg.Connection, ctx: LoadContext, payload: dict[str, Any], *, change_id: int | None = None,
                             requested_by: Any = None) -> list[Any]:
    """{cycle_id, op: hide|unhide|close|set_view_date|seal|force_publish, hidden_scope, reason, view_date, units}.
    사실 행은 바뀌지 않는다(숨김·노출은 조회 시 판정). seal·force_publish 는 발행 게이트 원장만 쓰고, 발행은 호출자가 이어서 부르는 재평가가 한다."""
    cid = payload.get("cycle_id")
    op = payload.get("op")
    if not cid or op not in ADMIN_OPS:
        raise BadRequest(f"cycle_admin payload: cycle_id·op({'|'.join(ADMIN_OPS)}) 필요")
    row = await conn.fetchrow(q.CYCLE_EXISTS, cid)
    if row is None:
        raise BadRequest(f"cycle_admin: 회차 없음 {cid}")
    if op in ("seal", "force_publish"):
        await _gate_admin(conn, row["cycle_id"], op, payload, change_id=change_id, requested_by=requested_by)
    elif op == "regenerate":
        await _regenerate(conn, row["cycle_id"], payload)
    elif op == "hide":
        scope = payload.get("hidden_scope") or "all"
        if scope not in HIDE_SCOPES:
            raise BadRequest(f"hidden_scope: {scope}")
        reason = payload.get("reason") if payload.get("reason") in ("collection_error", "operator") else "operator"
        await conn.fetch(q.ADMIN_HIDE, cid, scope, reason)
    elif op == "unhide":
        await conn.fetch(q.ADMIN_UNHIDE, cid)
    elif op == "close":
        await conn.fetch(q.ADMIN_CLOSE, cid)
    else:
        vd = payload.get("view_date")
        if not vd:
            raise BadRequest("set_view_date: view_date 필요")
        await conn.fetch(q.ADMIN_VIEW_DATE, cid, dt.date.fromisoformat(str(vd)))
    return await project_cycles(conn, ctx, [row["cycle_id"]])


async def _regenerate(conn: asyncpg.Connection, cid: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """동결 세대 재생성(운영 --cycle --reinterpret 대응, 결정 32·DB-v2.22): 사유 필수, 재해석만. 발행된 global·website 회차만.
    활성 세대를 해제(보관 삭제)하고 지금 판정으로 다시 동결한다. 재해석 없는 재생성은 거부(허브는 판정을 사실 열에 굽는다)."""
    from ingest.frz.freeze import regenerate

    reason = _reason(payload, "regenerate")
    if payload.get("reinterpret") is not True:
        raise BadRequest("regenerate: 재해석 재생성만 지원한다(reinterpret=true). 재해석 없는 재생성은 거부")
    st = await conn.fetchrow("SELECT surface, status FROM ing.cycle WHERE cycle_id = $1", cid)
    if st["surface"] not in GATED_SURFACES or st["status"] != "published":
        raise BadRequest(f"regenerate: 발행된 global·website 회차만(surface {st['surface']}, status {st['status']})")
    out = await regenerate(conn, cid, reason)
    if out.get("status") != "frozen":
        raise BadRequest(f"regenerate: 동결 세대를 만들지 못했다({out.get('status')})")
    log.info("동결 세대 재생성 cycle=%s gen=%s", str(cid)[:8], out.get("gen_key"))
    return out


def _reason(payload: dict[str, Any], op: str) -> str:
    r = payload.get("reason")
    if not isinstance(r, str) or not r.strip():
        raise BadRequest(f"{op}: reason(사유) 필수")
    return r.strip()


async def _gate_admin(conn: asyncpg.Connection, cid: Any, op: str, payload: dict[str, Any], *, change_id: int | None,
                      requested_by: Any) -> None:
    """발행 게이트 운영 요청(제품 결정 17 (b) 봉인·(c) 강제 발행). 게이트 대상(global·website 비파생 미발행)만."""
    reason = _reason(payload, op)
    g = await conn.fetchrow(q.CYCLE_GATE_OF, cid)
    if g["surface"] not in GATED_SURFACES or g["anchor_source"] == "derived":
        raise BadRequest(f"{op}: 발행 게이트 대상이 아니다(surface {g['surface']}, anchor_source {g['anchor_source']})")
    if g["status"] not in ("open", "closed"):
        raise BadRequest(f"{op}: 발행 전(open·closed) 회차만(현재 {g['status']})")
    if g["verdict"] is None:                                   # 계획이 아직 없으면 재평가와 같은 backfill 계획을 먼저 만든다
        await ensure_plans(conn, [cid], source="backfill")
    if op == "seal":
        units = payload.get("units")
        if units:
            try:
                cols = ([uuid.UUID(str(u["prompt_id"])) for u in units], [str(u["target"]) for u in units], [str(u["region"]) for u in units])
            except (KeyError, TypeError, ValueError) as e:
                raise BadRequest(f"seal units: prompt_id·target·region 필요({type(e).__name__})") from None
            if await conn.fetchval(q.PLAN_HAS, cid, *cols):
                raise BadRequest("seal units: 회차 계획에 없는 유닛이 있다")
        else:
            miss = await missing_units(conn, cid)
            cols = ([m["prompt_id"] for m in miss], [m["target"] for m in miss], [m["region"] for m in miss])
        await conn.fetch(q.SEAL_UNITS, cid, *cols, reason, change_id, requested_by)
    else:
        if g["status"] == "open":
            await conn.fetch(q.ADMIN_CLOSE, cid)
        await conn.fetch(q.FORCE_GATE, cid, reason, requested_by, change_id)


async def handle_report_publication(conn: asyncpg.Connection, ctx: LoadContext, subject_uuids: list[Any] | None,
                                    payload: dict[str, Any] | None) -> int:
    """rd.report_unit_value 를 발행 round_date 단위로 교체(supersede 된 pub_id 행 포함). 반환 = 새 행 수."""
    ids = list(subject_uuids or [])
    if payload and payload.get("publication_id"):
        ids.append(payload["publication_id"])
    if not ids:
        raise BadRequest("report_publication: 발행 id 필요(subject_uuids 또는 payload.publication_id)")
    dates = [r[0] for r in await conn.fetch(q.REPORT_DATES, ids)]
    if not dates:
        return 0
    await conn.execute(q.REPORT_DELETE, dates)
    tag = await conn.execute(q.REPORT_INSERT, dates, ctx.load_id)
    dropped = await conn.fetchval(q.REPORT_DROPPED, dates)
    if dropped:
        log.warning("report_unit_value (round_date, file_seq) 충돌로 버린 발행 행 %s", dropped)
    ctx.rd_changed = True
    ctx.surfaces.add(2)
    return int(str(tag).split()[-1])


async def handle_anchor_pin(conn: asyncpg.Connection, ctx: LoadContext, payload: dict[str, Any], change_id: int | None) -> list[Any]:
    """{job_id, anchor, reason, op?: set|remove}. 반환 = 재귀속 대상 run(IG-2 reproject 가 코호트 회차를 다시 판정)."""
    job = await _job(conn, payload)
    if payload.get("op", "set") == "remove":
        await conn.execute(q.PIN_DELETE, job["job_id"])
    else:
        if not payload.get("anchor"):
            raise BadRequest("anchor_pin: anchor 필요")
        await conn.execute(q.PIN_UPSERT, job["job_id"], dt.date.fromisoformat(str(payload["anchor"])), job["measured_at"],
                           str(payload.get("reason") or "operator"), change_id)
    return [job["run_id"]]


async def handle_answer_drop(conn: asyncpg.Connection, ctx: LoadContext, payload: dict[str, Any], change_id: int | None) -> list[int]:
    """{job_id, reason, op?: drop|restore}. 반환 = 재투영 답변 키."""
    job = await _job(conn, payload)
    if payload.get("op", "drop") == "restore":
        await conn.execute(q.DROP_DELETE, job["job_id"])
    else:
        await conn.execute(q.DROP_UPSERT, job["job_id"], job["measured_at"], str(payload.get("reason") or "operator"), change_id)
    return [int(job["answer_key"])]


async def _job(conn: asyncpg.Connection, payload: dict[str, Any]) -> asyncpg.Record:
    jid = payload.get("job_id")
    if not jid:
        raise BadRequest("job_id 필요")
    row = await conn.fetchrow(q.JOB_OF, jid)
    if row is None:
        raise BadRequest(f"job 없음 {jid}")
    return row
