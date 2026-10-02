"""admin.cycles.jobs 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

규칙(모듈-관리자 §2.5, 현행 0054 드롭·앵커 고정 운영 SQL 을 요청 API 로 이식)
- 조회: rd.job(job_id 유니크) → rd.v_answer_registry(answer_key 등치). 대기 요청(anchor_pin·answer_drop)을 함께 낸다.
- 앵커 고정: judgment_change('anchor_pin', subject_uuids=[job_id], payload{job_id, op: set, anchor, reason, old}). anchor 는 오늘(KST) 이하.
- 드롭: judgment_change('answer_drop', subject_uuids=[job_id], payload{job_id, op: drop, reason}). confirm=true 필수(dry_run 제외),
  이미 드롭된 job 은 409 state_mismatch. 반영(rd.job.dropped·rd.answer 삭제·게이트 전파)은 적재기.
- api_rw 는 rd 를 못 읽으므로 대상 확인은 api_ro 로 먼저 한다. 같은 job·같은 종류 대기 요청이 있으면 409 duplicate_pending.
- payload 는 core.contracts(AnchorPin·AnswerDrop) 계약: op 는 계약 기본값(set·drop)과 같지만 소비자가 읽기 쉽게 명시한다.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.codes import SURFACE_NAME
from app.core.db import fetch_all, fetch_one, fetch_val
from app.core.write import enqueue_change

from . import queries
from .schemas import ANALYSIS, JOB_STATUS, AnchorPinBody, Drop, DropBody, JobRegistry, JobRequestResult, PendingChange, Pin


async def get_registry(conn: AsyncConnection, job_id: uuid.UUID) -> JobRegistry:
    j = await fetch_one(conn, queries.JOB_SQL, {"jid": job_id})
    if j is None:
        raise errors.not_found("job 없음")
    reg: dict[str, Any] = await fetch_one(conn, queries.REGISTRY_SQL, {"ak": int(j["answer_key"])}) or {}
    pend = await fetch_all(conn, queries.PENDING_SQL, {"jid": job_id})
    completed = int(j["status_code"]) == 0
    return JobRegistry(
        job_id=j["job_id"], surface=SURFACE_NAME[int(j["surface"])], cycle_id=j["cycle_id"], round_date=j["round_date"],
        measured_at=j["measured_at"], status=JOB_STATUS.get(int(j["status_code"]), "other"),
        analysis_state=ANALYSIS.get(int(j["analysis_code"])) if completed else None, dropped=j["dropped"], served=j["served"],
        pin=Pin(anchor=reg["pin_anchor"], reason=reg.get("pin_reason"), source_measured_at=reg.get("pin_source_measured_at"))
        if reg.get("pin_anchor") else None,
        drop=Drop(reason=reg.get("drop_reason"), dropped_at=reg.get("dropped_at"), source_measured_at=reg.get("drop_source_measured_at"))
        if (reg.get("drop_reason") or reg.get("dropped_at")) else None,
        pending=[PendingChange(**p) for p in pend])


async def anchor_pin(ro: AsyncConnection, rw: AsyncConnection, job_id: uuid.UUID, body: AnchorPinBody) -> JobRequestResult:
    cur = await get_registry(ro, job_id)
    today: date = await fetch_val(ro, queries.TODAY_SQL)
    if body.anchor > today:
        raise errors.unprocessable("앵커는 오늘(KST) 이하", code="anchor_in_future", details={"field": "anchor", "today": today.isoformat()})
    if cur.pin is not None and cur.pin.anchor == body.anchor:
        raise errors.conflict("state_mismatch", "이미 같은 앵커로 고정돼 있다")
    warnings = []
    if cur.status != "completed":
        warnings.append(f"비완료 job(status {cur.status}): 완료되기 전에는 서빙 답변이 없어 고정 효과가 화면에 나타나지 않는다.")
    if cur.dropped:
        warnings.append("드롭된 job 이다: 고정해도 드롭을 해제하기 전에는 서빙되지 않는다.")
    if body.anchor != cur.round_date:
        warnings.append(f"앵커 {body.anchor.isoformat()} 는 현재 회차 날짜 {cur.round_date.isoformat()} 와 다르다: 적재기가 회차 귀속을 다시 계산한다.")
    change_id = None
    if not body.dry_run:
        change_id = await enqueue_change(rw, "anchor_pin", subject_uuids=[job_id], payload={
            "job_id": str(job_id), "op": "set", "anchor": body.anchor.isoformat(), "reason": body.reason.strip(),
            "old": {"anchor": cur.pin.anchor.isoformat(), "reason": cur.pin.reason} if cur.pin else None})
    return JobRequestResult(job_id=job_id, kind="anchor_pin", dry_run=body.dry_run, change_id=change_id,
                            propagation="none" if body.dry_run else "pending", current=cur, warnings=warnings)


async def drop(ro: AsyncConnection, rw: AsyncConnection, job_id: uuid.UUID, body: DropBody) -> JobRequestResult:
    if not body.dry_run and not body.confirm:
        raise errors.unprocessable("드롭은 confirm=true 필수", code="confirm_required", details={"field": "confirm"})
    cur = await get_registry(ro, job_id)
    if cur.dropped:
        raise errors.conflict("state_mismatch", "이미 드롭된 job 이다")
    warnings = []
    if cur.served:
        warnings.append("서빙 중인 답변이다: 반영되면 이 답변이 모든 지표 모수에서 빠진다(과거 회차 값이 바뀐다).")
    else:
        warnings.append(f"서빙되지 않는 job(status {cur.status}): 드롭은 이후 완료돼도 서빙하지 않게 막는다.")
    change_id = None
    if not body.dry_run:
        change_id = await enqueue_change(rw, "answer_drop", subject_uuids=[job_id], payload={
            "job_id": str(job_id), "op": "drop", "reason": body.reason.strip()})
    return JobRequestResult(job_id=job_id, kind="answer_drop", dry_run=body.dry_run, change_id=change_id,
                            propagation="none" if body.dry_run else "pending", current=cur, warnings=warnings)
