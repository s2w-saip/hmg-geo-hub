"""admin.changes.queue 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

- 목록: change_id DESC 키셋(core.pagination 커서). 필터(kind[]·status[]·requested_by·subject)는 커서 해시에 묶는다.
- subject: UUID 로 읽히면 subject_uuids 원소, 아니면 subject_texts 원소와 등치 비교한다.
- 회차 개념이 없는 관리 원장이라 공통 필터 모델(CommonFilters)은 받지 않는다(표면·기간 축 없음).
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.db import fetch_one
from app.core.pagination import decode_cursor, fetch_keyset, filter_hash, keyset_page

from . import queries
from .schemas import ChangeItem

SORT = "change_id"


def _row(r: dict[str, Any]) -> ChangeItem:
    return ChangeItem(**{**r, "subject_uuids": list(r["subject_uuids"] or []), "subject_texts": list(r["subject_texts"] or [])})


def split_subject(subject: str | None) -> tuple[uuid.UUID | None, str | None]:
    if subject is None:
        return None, None
    try:
        return uuid.UUID(subject), None
    except ValueError:
        return None, subject


async def list_changes(conn: AsyncConnection, *, kinds: list[str], statuses: list[str], requested_by: uuid.UUID | None,
                       subject: str | None, cursor: str | None, limit: int) -> tuple[list[ChangeItem], str | None]:
    su, st = split_subject(subject)
    fh = filter_hash({"k": sorted(set(kinds)), "s": sorted(set(statuses)), "r": str(requested_by or ""), "subj": subject or ""})
    cur = decode_cursor(cursor, sort=SORT, dir="desc", fh=fh, types=["int8"])
    rows = await fetch_keyset(conn, queries.LIST_SQL, {
        "kinds": sorted(set(kinds)) or None, "statuses": sorted(set(statuses)) or None, "requested_by": requested_by,
        "subject_uuid": su, "subject_text": st, "after": cur.key[0] if cur else None, "lim": limit + 1})
    page, nxt = keyset_page(rows, limit, lambda r: (int(r["change_id"]),), sort=SORT, dir="desc", fh=fh)
    return [_row(r) for r in page], nxt


async def get_change(conn: AsyncConnection, change_id: int) -> ChangeItem:
    r = await fetch_one(conn, queries.ONE_SQL, {"change_id": change_id})
    if r is None:
        raise errors.not_found("변경 요청 없음")
    return _row(r)
