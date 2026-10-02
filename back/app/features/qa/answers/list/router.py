"""qa.answers.list 목록·진행률·이웃·필터 라우터. 경로는 /v1 접두 포함 전체 경로.

인증: 검수 게이트(Q17) = core.auth.QaLiveConn(require_qa_reviewer 쿠키 → qa_gate 풀 + 세션 행 존재 확인). 일반 계정 JWT 로는 들어올 수 없다.
정적 경로(/answers/progress)를 경로 변수(/answers/{job_id}, qa.answers.detail) 보다 먼저 등록한다(레지스트리 순서).
"""
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.auth import QaLiveConn
from app.core.envelope import Envelope, ListData
from app.core.errors import ERROR_RESPONSES
from app.features.qa.answers.list import service
from app.features.qa.answers.list.schemas import QaFilterOptions, QaListRow, QaNeighbors, QaProgress
from app.features.qa.answers.list.scope import QaFilter, QaListQuery, qa_filter

router = APIRouter(tags=["qa.answers"], responses=ERROR_RESPONSES)


@router.get("/v1/qa/answers", summary="검수 목록 2구간 키셋(measured_at DESC NULLS LAST, answer_key DESC), 표면별 UNION ALL 병합",
            response_model=Envelope[ListData[QaListRow]])
async def get_qa_answers_0(conn: QaLiveConn, filters: Annotated[QaListQuery, Depends(qa_filter(QaListQuery))]) -> Envelope[ListData[QaListRow]]:
    items, meta = await service.list_answers(conn, filters, filters.cursor, filters.limit)
    return Envelope(data=ListData(items=items), meta=meta)


@router.get("/v1/qa/answers/progress", summary="scoped·total 진행률, 매 요청 계산(현행 unstable_cache 제거, D8)",
            response_model=Envelope[QaProgress])
async def get_qa_answers_progress_1(conn: QaLiveConn, filters: Annotated[QaFilter, Depends(qa_filter(QaFilter))]) -> Envelope[QaProgress]:
    data, meta = await service.progress(conn, filters)
    return Envelope(data=data, meta=meta)


@router.get("/v1/qa/answers/{job_id}/neighbors", summary="같은 필터·정렬 이전/다음 job_id", response_model=Envelope[QaNeighbors])
async def get_qa_answers_by_id_neighbors_2(job_id: uuid.UUID, conn: QaLiveConn,
                                           filters: Annotated[QaFilter, Depends(qa_filter(QaFilter))]) -> Envelope[QaNeighbors]:
    data, meta = await service.neighbors(conn, filters, job_id)
    return Envelope(data=data, meta=meta)


@router.get("/v1/qa/filters", summary="필터 드롭다운 옵션(차원 표 직접)", response_model=Envelope[QaFilterOptions])
async def get_qa_filters_3(conn: QaLiveConn) -> Envelope[QaFilterOptions]:
    data, meta = await service.filter_options(conn)
    return Envelope(data=data, meta=meta)
