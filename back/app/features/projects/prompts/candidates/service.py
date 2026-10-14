"""projects.prompts.candidates 업무 규칙(현행 prompt/_actions.ts selectFromCandidates·deleteCandidate(s) 이식).

- 후보 생성 파이프라인(키워드·소셜 → 후보)은 이 기능 밖이다(intent.candidates.submit). 여기는 읽기·승격·삭제만(PJ-3 open ③ 가정).
- 다른 프로젝트 후보 id 는 매칭되지 않을 뿐(IDOR 은폐): 한 건도 해당하지 않으면 404, 일부면 not_found 로 돌려준다.
- 승격한 프롬프트는 draft. app.prompt INSERT 는 트리거가 'created' 감사를 남긴다(Q3).
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.db import fetch_all, fetch_val
from app.core.pagination import clamp_limit, decode_cursor, fetch_keyset, filter_hash, keyset_page

from . import queries as q
from .schemas import CandidateItem, CandidateList, DeleteResult, SelectResult


async def list_candidates(conn: AsyncConnection, project_id: uuid.UUID, cursor: str | None,
                          limit: int | None, *, include_total: bool = True) -> tuple[CandidateList, int | None, int]:
    """키셋 목록. include_total=False 면 COUNT 를 건너뛰고 total = None(행·커서는 같다)."""
    lim = clamp_limit(limit, default=200)
    fh = filter_hash({"project": str(project_id)})
    cur = decode_cursor(cursor, sort=q.LIST_SORT, dir="desc", fh=fh, types=q.LIST_KEY_TYPES)
    sql, params = q.list_sql(project_id, cur, lim)
    rows = await fetch_keyset(conn, sql, params)
    page, nxt = keyset_page(rows, lim, lambda r: (r["created_at"], r["candidate_id"]), sort=q.LIST_SORT, dir="desc", fh=fh)
    total = int(await fetch_val(conn, q.COUNT_SQL, {"pid": project_id}) or 0) if include_total else None
    return CandidateList(items=[CandidateItem(**r) for r in page], next_cursor=nxt), total, lim


async def select_candidates(rw: AsyncConnection, project_id: uuid.UUID, ids: list[uuid.UUID]) -> SelectResult:
    rows = await fetch_all(rw, q.SELECT_SQL, {"pid": project_id, "ids": [str(x) for x in ids]})
    if not rows:
        raise errors.not_found("선택한 후보가 이 프로젝트에 없다", code="candidate_not_found")
    hit = {str(r["candidate_id"]) for r in rows}
    return SelectResult(created=len(rows), prompt_ids=[uuid.UUID(str(r["prompt_id"])) for r in rows],
                        not_found=[x for x in ids if str(x) not in hit])


async def delete_one(rw: AsyncConnection, project_id: uuid.UUID, candidate_id: uuid.UUID) -> None:
    rows = await fetch_all(rw, q.DELETE_ONE_SQL, {"pid": project_id, "cid": candidate_id})
    if not rows:
        raise errors.not_found("후보 없음", code="candidate_not_found")


async def delete_many(rw: AsyncConnection, project_id: uuid.UUID, ids: list[uuid.UUID]) -> DeleteResult:
    rows = await fetch_all(rw, q.DELETE_MANY_SQL, {"pid": project_id, "ids": [str(x) for x in ids]})
    if not rows:
        raise errors.not_found("삭제할 후보가 이 프로젝트에 없다", code="candidate_not_found")
    hit = {str(r["candidate_id"]) for r in rows}
    return DeleteResult(deleted=len(rows), not_found=[x for x in ids if str(x) not in hit])
