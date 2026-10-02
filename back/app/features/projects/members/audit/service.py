"""projects.members.audit 업무 규칙(PJ-2). 활성 멤버 또는 admin 만(비멤버 404). (created_at DESC, audit_id DESC) 키셋."""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.auth import Principal
from app.core.pagination import clamp_limit, decode_cursor, fetch_keyset, filter_hash, keyset_page, keyset_predicate
from app.core.sqlb import Binder
from app.features.projects.members.audit import queries as Q
from app.features.projects.project.core.shared import project_access

DEFAULT_LIMIT, MAX_LIMIT = 20, 200
_SORT = "created_at"


async def list_audit(ro: AsyncConnection, p: Principal, project_id: uuid.UUID, cursor: str | None, limit: int | None
                     ) -> tuple[list[dict[str, Any]], str | None, int]:
    await project_access(ro, p, project_id, "active_member")
    lim = clamp_limit(limit, DEFAULT_LIMIT)
    fh = filter_hash({"project_id": str(project_id)})
    cur = decode_cursor(cursor, sort=_SORT, dir="desc", fh=fh, types=("timestamptz", "int8"))
    b = Binder("k")
    ks = keyset_predicate(Q.SORT_COLS, "desc", cur, b)
    rows = await fetch_keyset(ro, Q.list_sql(ks), {"pid": project_id, "lim": lim + 1, **b.params})
    page, nxt = keyset_page(rows, lim, lambda r: (r["created_at"], int(r["audit_id"])), sort=_SORT, dir="desc", fh=fh)
    return [{**r, "audit_id": str(r["audit_id"])} for r in page], nxt, lim
