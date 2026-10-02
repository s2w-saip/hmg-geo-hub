"""qa.review.verdict 업무 규칙: 현재 판정 조회·섹션 판정 저장.

저장(PUT)은 한 트랜잭션(qa_gate)에서: job 범위 확인 → 세션 확인 → 락 재확인(재획득 upsert) → 판정 upsert.
락을 잃었으면(상세를 연 채 TTL 넘게 자리를 비워 남이 가져감) 409 lock_lost 로 판정을 저장하지 않는다(남의 작업을 조용히 덮지 않게).
판정 행의 검수자 = 쿠키 세션 이름 스냅샷(reviewer_id 는 계정이 없어 NULL, Q17).
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.auth import QaReviewer, assert_qa_session
from app.core.db import fetch_one
from app.features.qa.answers.list.scope import assert_job_in_scope
from app.features.qa.review.lock.service import lock_conflict, try_acquire
from app.features.qa.review.verdict import queries as Q
from app.features.qa.review.verdict.schemas import SECTIONS, QaReview, QaSectionFlags


def to_review(row: dict[str, Any]) -> QaReview:
    return QaReview(job_id=row["job_id"], status=row["status"],
                    section_flags=QaSectionFlags(**{s: row[f"flag_{s}"] for s in SECTIONS}), reviewer_name=row["reviewer_name"],
                    session_id=row["session_id"], reviewed_at=row["reviewed_at"], updated_at=row["updated_at"])


async def get_review(conn: AsyncConnection, job_id: uuid.UUID) -> QaReview | None:
    await assert_job_in_scope(conn, job_id)
    row = await fetch_one(conn, Q.GET_REVIEW_SQL, {"job_id": job_id})
    return to_review(row) if row else None


async def save_review(conn: AsyncConnection, reviewer: QaReviewer, job_id: uuid.UUID, flags: QaSectionFlags) -> QaReview:
    await assert_job_in_scope(conn, job_id)
    await assert_qa_session(conn, reviewer)
    lock, holder = await try_acquire(conn, reviewer, job_id)
    if lock is None:
        raise lock_conflict("lock_lost", holder)
    row = await fetch_one(conn, Q.UPSERT_REVIEW_SQL, {
        "job_id": job_id, **{f"f_{s}": getattr(flags, s) for s in SECTIONS}, "name": reviewer.name,
        "sid": uuid.UUID(reviewer.session_id)})
    return to_review(row)  # type: ignore[arg-type]
