"""qa.answers.detail 검수 상세 라우터. 경로는 /v1 접두 포함 전체 경로. 인증: 검수 게이트(Q17, core.auth.QaLiveConn: 쿠키 + 세션 행 확인).
원문 열람은 민감 조회라 성공 응답 뒤 core.write.access_audit_qa(kind data_access)로 감사한다(Q4, 거부·404 는 기록하지 않는다)."""
import uuid

from fastapi import APIRouter

from app.core.auth import QaLiveConn, QaUser
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES
from app.core.write import access_audit_qa
from app.features.qa.answers.detail import service
from app.features.qa.answers.detail.schemas import QaAnswerDetail

router = APIRouter(tags=["qa.answers"], responses=ERROR_RESPONSES)


@router.get("/v1/qa/answers/{job_id}", summary="상세 낱알 전량(비served 포함, 멘션·인용·ACR·앵커/드롭), answers.load_job_header 비served 변형 + render 재사용",
            response_model=Envelope[QaAnswerDetail])
async def get_qa_answers_by_id_0(job_id: uuid.UUID, reviewer: QaUser, conn: QaLiveConn) -> Envelope[QaAnswerDetail]:
    data, meta = await service.get_detail(conn, job_id)
    access_audit_qa(reviewer, "data_access", "qa.answers.detail", target=str(job_id))
    return Envelope(data=data, meta=meta)
