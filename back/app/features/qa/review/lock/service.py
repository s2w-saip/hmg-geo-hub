"""qa.review.lock 업무 규칙: 답변 락 획득·heartbeat·해제.

- 락 소유자 = 쿠키 세션(app.qa_review_session). 탭이 둘이어도 같은 로그인이면 같은 소유자다(현행 동작).
- 획득 실패 = 남이 TTL(180초) 안에 heartbeat 한 락 → 409 lock_held(details.held_by). 락을 못 잡아도 상세는 읽기 전용으로 열린다(현행 §6.3).
- 해제·heartbeat 는 본인 세션 행만 건드린다(남의 락을 지우는 경로가 없다). sendBeacon(?release=1) 경로는 폐지, 프론트는 fetch keepalive.
- 세션 last_seen 갱신은 부수 효과라 실패가 락 응답을 막지 않게 같은 트랜잭션의 마지막 UPDATE 로 둔다(행이 없으면 0행).
"""
from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import QaReviewer, assert_qa_session
from app.core.db import fetch_one
from app.features.qa.answers.list.scope import LOCK_TTL_SECONDS, QaLock, assert_job_in_scope
from app.features.qa.review.lock import queries as Q
from app.features.qa.review.lock.schemas import QaLockHeld, QaLockHolder, QaLockReleased
from app.features.qa.review.sessions.service import touch_quiet


async def try_acquire(conn: AsyncConnection, reviewer: QaReviewer, job_id: uuid.UUID) -> tuple[QaLock | None, QaLockHolder | None]:
    """단일 upsert 로 획득 시도 → (락, None) 또는 (None, 보유자). 진 직후 상대가 놓아 행이 사라졌으면 한 번만 다시 시도한다."""
    params = {"job_id": job_id, "sid": uuid.UUID(reviewer.session_id), "name": reviewer.name, "ttl": LOCK_TTL_SECONDS}
    for _ in range(2):
        won = await fetch_one(conn, Q.LOCK_UPSERT_SQL, params)
        if won is not None:
            return QaLock(**won), None
        held = await fetch_one(conn, Q.LOCK_HOLDER_SQL, {"job_id": job_id})
        if held is not None:
            return None, QaLockHolder(reviewer_name=held["reviewer_name"], acquired_at=held["acquired_at"])
    return None, None


def lock_conflict(code: str, holder: QaLockHolder | None) -> errors.ApiError:
    return errors.conflict(code, "다른 검수자가 이 답변을 잡고 있다" if code == "lock_held" else "락을 잃었다",
                           {"held_by": holder.model_dump(mode="json") if holder else None})


async def acquire(conn: AsyncConnection, reviewer: QaReviewer, job_id: uuid.UUID) -> QaLock:
    await assert_job_in_scope(conn, job_id)
    await assert_qa_session(conn, reviewer)
    lock, holder = await try_acquire(conn, reviewer, job_id)
    if lock is None:
        raise lock_conflict("lock_held", holder)
    await touch_quiet(conn, reviewer)
    return lock


async def heartbeat(conn: AsyncConnection, reviewer: QaReviewer, job_id: uuid.UUID) -> QaLockHeld:
    await assert_job_in_scope(conn, job_id)
    row = await fetch_one(conn, Q.HEARTBEAT_SQL, {"job_id": job_id, "sid": uuid.UUID(reviewer.session_id)})
    return QaLockHeld(held=row is not None, lock=QaLock(**row) if row else None)


async def release(conn: AsyncConnection, reviewer: QaReviewer, job_id: uuid.UUID) -> QaLockReleased:
    await assert_job_in_scope(conn, job_id)
    row = await fetch_one(conn, Q.RELEASE_SQL, {"job_id": job_id, "sid": uuid.UUID(reviewer.session_id)})
    return QaLockReleased(released=row is not None)
