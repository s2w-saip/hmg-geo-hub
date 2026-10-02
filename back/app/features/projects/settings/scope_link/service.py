"""projects.settings.scope_link 업무 규칙(PJ-4, admin 전용: 현행 setting/page.tsx:62).

현행 diagnoseProjectAnalysisConnection(lib/scope/server.ts:679 라이브 probe)을 DB 진단으로 대체(모듈 consistency_fixes[12]·[13]):
  미연결(scope_project_id NULL) → 아웃박스 오류 있으면 link_error, 미완료 create 가 있으면 pending_link, 아니면 unlinked.
  연결 → 최신 회차(rd.cycle) job 이 0 이면 no_data, served < total 이면 partial, 전부 서빙이면 healthy.
프로젝트 표면 키는 core resolve_project 의 project_keys(rd.dim_project surface 3).
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal
from app.core.codes import CYCLE_STATUS
from app.core.db import fetch_all, fetch_one
from app.core.envelope import ratio
from app.features.projects.project.core.shared import project_access
from app.features.projects.settings.scope_link import queries as Q

_STATUS_NAME = {v: k for k, v in CYCLE_STATUS.items()}


def link_state(linked: bool, ob: dict[str, Any], jobs: dict[str, Any] | None) -> str:
    if not linked:
        if ob["erroring"]:
            return "link_error"
        return "pending_link" if ob["pending_create"] else "unlinked"
    if not jobs or not jobs["total"]:
        return "no_data"
    return "healthy" if jobs["served"] == jobs["total"] else "partial"


async def diagnose(ro: AsyncConnection, p: Principal, project_id: uuid.UUID) -> dict[str, Any]:
    acc, _ = await project_access(ro, p, project_id, "active_member")  # 라우터가 admin 을 먼저 거른다. 없음·루트 404
    pr = await fetch_one(ro, Q.PROJECT, {"pid": project_id})
    if pr is None:
        raise errors.not_found("프로젝트 없음")
    sp = pr["scope_project_id"]
    keys = list(acc.project_keys)
    latest = jobs = None
    if keys:
        c = await fetch_one(ro, Q.LATEST_ROUND, {"keys": keys})
        if c is not None:
            latest = {"round_date": c["round_date"], "status": _STATUS_NAME.get(int(c["status"]), str(c["status"])),
                      "servable": c["servable"], "view_date": c["view_date"]}
            j = await fetch_one(ro, Q.JOBS, {"keys": keys, "rd": c["round_date"]})
            assert j is not None
            jobs = {"total": int(j["total"]), "served": int(j["served"]), "in_progress": int(j["in_progress"]),
                    "failed": int(j["failed"]), "served_ratio": ratio(j["served"], j["total"]), "last_measured_at": j["last_measured_at"]}
    ob = await fetch_one(ro, Q.OUTBOX_COUNTS, {"pid": project_id}) or {"pending": 0, "erroring": 0, "pending_create": 0}
    prompt_pending = await fetch_one(ro, Q.PROMPT_OUTBOX_PENDING, {"pid": project_id})
    recent = await fetch_all(ro, Q.OUTBOX_RECENT, {"pid": project_id})
    return {"project_id": project_id, "scope_project_id": sp, "linked": sp is not None, "state": link_state(sp is not None, ob, jobs),
            "latest_round": latest, "jobs": jobs,
            "outbox": {"pending": int(ob["pending"]), "erroring": int(ob["erroring"]),
                       "prompt_pending": int(prompt_pending["n"]) if prompt_pending else 0, "recent": recent}}
