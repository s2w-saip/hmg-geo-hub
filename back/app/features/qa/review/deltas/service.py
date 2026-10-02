"""qa.review.deltas 업무 규칙: 목록 화면 10초 폴링(락·판정 상태만, 전체 리로드 회피).

모두 PK·UNIQUE 등치(최대 200). 서버 검수 범위 밖 job 은 결과에 싣지 않는다.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.db import fetch_all
from app.features.qa.answers.list.scope import LOCK_TTL_SECONDS, QaLock, qa_meta
from app.features.qa.review.deltas import queries as Q
from app.features.qa.review.deltas.schemas import MAX_IDS, QaDeltas, QaReviewDelta


def parse_ids(raw: list[str]) -> tuple[list[uuid.UUID], list[str]]:
    """반복·쉼표 혼용 → 고유 UUID(입력 순서). 형식 오류는 422, 200 초과분은 (무시, 목록)."""
    vals = [v.strip() for chunk in raw for v in chunk.split(",") if v.strip()]
    out: list[uuid.UUID] = []
    for v in vals:
        try:
            u = uuid.UUID(v)
        except ValueError as e:
            raise errors.unprocessable("job_ids 는 UUID", details={"field": "job_ids"}) from e
        if u not in out:
            out.append(u)
    return out[:MAX_IDS], [str(u) for u in out[MAX_IDS:]]


async def deltas(conn: AsyncConnection, raw: list[str]) -> tuple[QaDeltas, Any]:
    ids, over = parse_ids(raw)
    meta = qa_meta()
    if over:
        meta.dropped_filters = {"job_ids": over}
    if not ids:
        return QaDeltas(locks=[], reviews=[]), meta
    s = [str(i) for i in ids]
    lq, rq = Q.locks_sql(s, LOCK_TTL_SECONDS), Q.reviews_sql(s)
    locks = [QaLock(**r) for r in await fetch_all(conn, lq.text, lq.params)]
    reviews = [QaReviewDelta(**r) for r in await fetch_all(conn, rq.text, rq.params)]
    return QaDeltas(locks=locks, reviews=reviews), meta
