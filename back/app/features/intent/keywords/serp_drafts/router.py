"""intent.keywords.serp_drafts SERP 프롬프트 초안 라우터. 경로는 /v1 접두 포함 전체 경로.

LLM 을 기다리는 핸들러라 요청 커넥션을 쥐지 않는다(core.db 규약): 계정은 CurrentUserDetached(자체 짧은 api_ro 트랜잭션),
읽기는 RoSession 으로 service.plan 까지만, 쓰기 트랜잭션은 LLM 호출이 끝난 뒤 service.save 가 연다(RoConn·RwConn·CurrentUser 미사용).
"""
from fastapi import APIRouter, Request

from app.core.auth import CurrentUserDetached
from app.core.db import RoSession
from app.core.errors import ERROR_RESPONSES
from app.core.llm import LLM_RESPONSES, LlmDep, request_deadline
from app.features.intent.keywords.research.intent_common import intent_meta
from app.features.intent.keywords.serp_drafts import service as svc
from app.features.intent.keywords.serp_drafts.schemas import DraftEnvelope, DraftIn

router = APIRouter(tags=["intent.keywords"], responses=ERROR_RESPONSES)
# LLM 요청 기한(D-7): BFF 는 이 호출을 최대 70초(HGH_TIMEOUTS.external, 라우트 남은 시간이 적으면 더 짧게) 기다린다
# (front/lib/hgh/adapters/intent.ts serpDraftTimeoutMs). 짧게 기다리는 호출은 X-HGH-Timeout-Ms 로 기한을 더 줄인다.
SERP_DRAFT_DEADLINE_S = 65.0


@router.post("/v1/intent/serp-drafts", summary="SERP 행 LLM 프롬프트 초안(트랜잭션 밖 LLM → app.kw_prompt_draft)",
             response_model=DraftEnvelope, dependencies=[request_deadline(SERP_DRAFT_DEADLINE_S)], responses=LLM_RESPONSES)
async def post_intent_serp_drafts_0(request: Request, p: CurrentUserDetached, open_ro: RoSession, body: DraftIn,
                                    llm: LlmDep) -> DraftEnvelope:
    data = await svc.run(open_ro, llm, p, body)
    return DraftEnvelope(data=data, meta=intent_meta(request, mode="crud"))
