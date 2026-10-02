"""analytics.answers.detail 답변 상세 라우터. 경로는 /v1 접두 포함 전체 경로."""
import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES
from app.features.analytics.answers.detail.schemas import AnswerDetail, AnswerDetailQuery
from app.features.analytics.answers.detail.service import answer_detail

router = APIRouter(tags=["analytics.answers"])


@router.get("/v1/answers/{job_id}", response_model=Envelope[AnswerDetail], responses=ERROR_RESPONSES,
            summary="served 답변 1건 상세(헤더·원문·언급 브랜드 rd.answer_brand·모델·당사 감성 스팬·스탠스 근거 대조·인용). 표면별 스코프 게이트, 실패는 전부 404. 헤더 1 + json_agg 번들 1 왕복")
async def get_answers_by_id_0(job_id: uuid.UUID, request: Request, q: Annotated[AnswerDetailQuery, Query()], p: CurrentUser,
                              conn: RoConn) -> Envelope[AnswerDetail]:
    """analytics.answers.detail: 답변 원문 모달(AN-2). 원문 열람은 접근 감사(data_access) 대상."""
    return await answer_detail(conn, p, job_id, q, set(request.query_params.keys()))
