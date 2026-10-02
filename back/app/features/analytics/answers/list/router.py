"""analytics.answers.list 답변 목록 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES, ErrorBody
from app.core.filters import parse_custom_fields
from app.features.analytics.answers.list.schemas import AnswerListData, AnswerListQuery
from app.features.analytics.answers.list.service import list_answers

router = APIRouter(tags=["analytics.answers"])


@router.get("/v1/answers", response_model=Envelope[AnswerListData], responses={**ERROR_RESPONSES, 409: {"model": ErrorBody, "description": "cursor_stale"}},
            summary="완료 답변 키셋 목록(공통 필터 + prompt_id·project_id·mention_brand·signal·domain·source[]·q·include_gap·collapse). 페이지당 조회 창 상한 92일.")
async def get_answers_0(request: Request, q: Annotated[AnswerListQuery, Query()], p: CurrentUser, conn: RoConn) -> Envelope[AnswerListData]:
    """analytics.answers.list: 답변 드릴다운 공용 목록(AN-1). 공개 id = job_id, 원문은 상세(AN-2)만."""
    custom = parse_custom_fields(request.query_params)      # project 밖 표면이면 resolve_read_context 가 ignored_filters 로 보낸다
    return await list_answers(conn, p, q, custom)
