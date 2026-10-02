"""qa.review.lock 답변 락 라우터. 경로는 /v1 접두 포함 전체 경로. 인증: 검수 게이트(Q17, core.auth.QaUser·QaLiveConn: 쿠키 + 세션 행 확인)."""
import uuid

from fastapi import APIRouter

from app.core.auth import QaLiveConn, QaUser
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES, ErrorBody
from app.features.qa.answers.list.scope import QaLock, qa_meta
from app.features.qa.review.lock import service
from app.features.qa.review.lock.schemas import QaLockHeld, QaLockReleased

router = APIRouter(tags=["qa.review"], responses=ERROR_RESPONSES)
_409 = {409: {"model": ErrorBody, "description": "lock_held(details.held_by)"}}


@router.post("/v1/qa/answers/{job_id}/lock", summary="락 획득·만료 탈취(단일 upsert)", response_model=Envelope[QaLock], responses=_409)
async def post_qa_answers_by_id_lock_0(job_id: uuid.UUID, reviewer: QaUser, conn: QaLiveConn) -> Envelope[QaLock]:
    return Envelope(data=await service.acquire(conn, reviewer, job_id), meta=qa_meta())


@router.patch("/v1/qa/answers/{job_id}/lock", summary="heartbeat 30초", response_model=Envelope[QaLockHeld])
async def patch_qa_answers_by_id_lock_1(job_id: uuid.UUID, reviewer: QaUser, conn: QaLiveConn) -> Envelope[QaLockHeld]:
    return Envelope(data=await service.heartbeat(conn, reviewer, job_id), meta=qa_meta())


@router.delete("/v1/qa/answers/{job_id}/lock", summary="락 해제(fetch keepalive, sendBeacon 폐지)", response_model=Envelope[QaLockReleased])
async def delete_qa_answers_by_id_lock_2(job_id: uuid.UUID, reviewer: QaUser, conn: QaLiveConn) -> Envelope[QaLockReleased]:
    return Envelope(data=await service.release(conn, reviewer, job_id), meta=qa_meta())
