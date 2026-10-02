"""analytics.mentions.prompts 프롬프트별 언급 라우터. 경로는 /v1 접두 포함 전체 경로."""
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, build_meta
from app.core.errors import ERROR_RESPONSES
from app.core.filters import parse_custom_fields
from app.features.analytics.mentions.brands.common import read_scope, suppression
from app.features.analytics.mentions.prompts.schemas import PromptsData, PromptsQuery
from app.features.analytics.mentions.prompts.service import mention_prompts

router = APIRouter(tags=["analytics.mentions"])


@router.get("/v1/mentions/prompts", response_model=Envelope[PromptsData], responses=ERROR_RESPONSES,
            summary="프롬프트별 언급 드릴다운 mode=brand|signal, 키셋(generation·필터 해시 포함 커서), 프롬프트당 대표 답변 job_id")
async def get_mentions_prompts_0(request: Request, p: CurrentUser, conn: RoConn,
                                 q: Annotated[PromptsQuery, Query()]) -> Envelope[PromptsData]:
    """브랜드 언급 또는 당사 신호가 나온 프롬프트 목록과 셀 대표 답변 참조(명세: README.md, 모듈-언급 §3.3)."""
    ctx, win = await read_scope(conn, p, q, request)
    data, page = await mention_prompts(conn, ctx, win, q, custom=parse_custom_fields(request.query_params))
    return Envelope[PromptsData](data=data, meta=build_meta(mode=win.mode, window=win, ctx=ctx, suppressed=suppression(win), page=page))
