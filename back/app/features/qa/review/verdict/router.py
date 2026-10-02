"""qa.review.verdict 판정 저장 라우터. 경로는 /v1 접두 포함 전체 경로. 인증: 검수 게이트(Q17, core.auth.QaUser·QaLiveConn: 쿠키 + 세션 행 확인)."""
import uuid

from fastapi import APIRouter

from app.core.auth import QaLiveConn, QaUser
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES, ErrorBody
from app.features.qa.answers.list.scope import qa_meta
from app.features.qa.review.verdict import service
from app.features.qa.review.verdict.schemas import QaReview, QaReviewIn

router = APIRouter(tags=["qa.review"], responses=ERROR_RESPONSES)


@router.get("/v1/qa/answers/{job_id}/review", summary="현재 판정", response_model=Envelope[QaReview | None])
async def get_qa_answers_by_id_review_0(job_id: uuid.UUID, conn: QaLiveConn) -> Envelope[QaReview | None]:
    return Envelope(data=await service.get_review(conn, job_id), meta=qa_meta())


@router.put("/v1/qa/answers/{job_id}/review", summary="섹션 판정 저장(락 재확인, 잃으면 409 lock_lost)", response_model=Envelope[QaReview],
            responses={409: {"model": ErrorBody, "description": "lock_lost(details.held_by)"}})
async def put_qa_answers_by_id_review_1(job_id: uuid.UUID, body: QaReviewIn, reviewer: QaUser, conn: QaLiveConn) -> Envelope[QaReview]:
    return Envelope(data=await service.save_review(conn, reviewer, job_id, body.section_flags), meta=qa_meta())
