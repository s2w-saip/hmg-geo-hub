"""qa.review.deltas 변경 알림 라우터. 경로는 /v1 접두 포함 전체 경로. 인증: 검수 게이트(Q17, core.auth.QaLiveConn: 쿠키 + 세션 행 확인)."""
from typing import Annotated

from fastapi import APIRouter, Query

from app.core.auth import QaLiveConn
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES
from app.features.qa.review.deltas import service
from app.features.qa.review.deltas.schemas import QaDeltas, QaDeltasQuery

router = APIRouter(tags=["qa.review"], responses=ERROR_RESPONSES)


@router.get("/v1/qa/deltas", summary="10초 폴링: job_ids(≤200) 유효 락·판정 상태", response_model=Envelope[QaDeltas])
async def get_qa_deltas_0(conn: QaLiveConn, q: Annotated[QaDeltasQuery, Query()]) -> Envelope[QaDeltas]:
    data, meta = await service.deltas(conn, q.job_ids)
    return Envelope(data=data, meta=meta)
