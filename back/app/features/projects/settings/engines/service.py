"""projects.settings.engines 업무 규칙(PJ-4). 현행 updateProjectEngines(setting/_actions.ts:319) 이식.

- 게이트: Owner ∧ 운영자(core resolve_project level='owner_and_operate', 2026-08-18 비용 레버 결정).
- 어휘: rd.dim_engine 코드(카탈로그 순서 정규화, 모르는 코드는 422). 빈 목록 = 수집 중단.
- 변경 시 한 트랜잭션: ai_engines 교체(트리거가 judgment_change 'project_setting') + engine_history 1행 + outbox(schedule:set_targets).
  레거시(NULL)는 같은 값이어도 첫 명시 저장을 이력에 남긴다. 명시값이 같으면 no-op.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal
from app.core.db import fetch_one
from app.core.pagination import clamp_limit, decode_cursor, fetch_keyset, filter_hash, keyset_page, keyset_predicate
from app.core.sqlb import Binder
from app.core.write import enqueue_scope
from app.features.projects.project.core.shared import normalize_engines, project_access
from app.features.projects.settings.engines import queries as Q

HISTORY_DEFAULT, HISTORY_MAX = 50, 200


async def put_engines(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, engines: list[str]
                      ) -> dict[str, Any]:
    _, refs = await project_access(ro, p, project_id, "owner_and_operate")
    nxt = normalize_engines(engines, refs)
    r = await fetch_one(rw, Q.LOCK, {"pid": project_id})
    if r is None:
        raise errors.not_found("프로젝트 없음")
    before = list(r["ai_engines"]) if r["ai_engines"] is not None else None
    if before is not None and before == nxt:
        return {"engines": nxt, "changed": False, "reenable": False, "outbox_id": None, "propagation": "none"}
    await rw.execute(text(Q.SET_ENGINES), {"pid": project_id, "engines": nxt})
    await rw.execute(text(Q.INSERT_HISTORY), {"pid": project_id, "engines": nxt, "uid": p.user_id})
    reenable = before is not None and len(before) == 0 and len(nxt) > 0
    oid = await enqueue_scope(rw, "schedule", project_id, "set_targets",
                              {"project_id": str(project_id), "engines": nxt, "reenable": reenable})
    return {"engines": nxt, "changed": True, "reenable": reenable, "outbox_id": oid, "propagation": "pending"}


async def history(ro: AsyncConnection, p: Principal, project_id: uuid.UUID, cursor: str | None, limit: int | None
                  ) -> tuple[list[dict[str, Any]], str | None, int]:
    await project_access(ro, p, project_id, "active_member")
    lim = clamp_limit(limit, HISTORY_DEFAULT)
    fh = filter_hash({"project_id": str(project_id)})
    cur = decode_cursor(cursor, sort="history_id", dir="desc", fh=fh, types=("int8",))
    b = Binder("k")
    ks = keyset_predicate(Q.SORT_COLS, "desc", cur, b)
    rows = await fetch_keyset(ro, Q.history_sql(ks), {"pid": project_id, "lim": lim + 1, **b.params})
    page, nxt = keyset_page(rows, lim, lambda r: (int(r["history_id"]),), sort="history_id", dir="desc", fh=fh)
    return [{**r, "history_id": str(r["history_id"]), "engines": list(r["engines"])} for r in page], nxt, lim
