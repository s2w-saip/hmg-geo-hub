"""intent.social.prompts 생성 프롬프트 라우터. 경로는 /v1 접두 포함 전체 경로.

프로젝트 화면 전용: 메뉴 그룹 project 게이트 + core.auth.resolve_project(목록 member, 생성·삭제 operate).
생성(POST)은 LLM 을 기다리므로 요청 커넥션을 쥐지 않는다(core.db 규약): 계정은 CurrentUserDetached, 권한·시드 읽기는 RoSession
짧은 트랜잭션, 쓰기 트랜잭션은 LLM 뒤에 service 가 연다. 그래서 메뉴 게이트를 라우터 dependencies(CurrentUser → RoConn 을 요청 끝까지
연다) 대신 경로별로 건다: GET·DELETE 는 require_surface_gate("project"), POST 는 핸들러 안 require_surface(같은 판정·코드: 역할 천장
PROJECT_VIEWERS + 메뉴 project, 검증 m-7).
"""
import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core import auth
from app.core.auth import CurrentUser, CurrentUserDetached
from app.core.codes import load_refs
from app.core.db import RoConn, RoSession
from app.core.envelope import ListData
from app.core.errors import ERROR_RESPONSES
from app.core.llm import LLM_RESPONSES, LlmDep, request_deadline
from app.core.write import RwConn
from app.features.intent.keywords.research.intent_common import intent_meta
from app.features.intent.social.prompts import service as svc
from app.features.intent.social.prompts.schemas import GenerateEnvelope, GenerateIn, PromptListEnvelope, Removed, RemovedEnvelope

router = APIRouter(tags=["intent.social"], responses=ERROR_RESPONSES)
# LLM 요청 기한(D-7): BFF 는 110초 기다린다(front/lib/hgh/adapters/intent.ts SOCIAL_GENERATE_TIMEOUT_MS). 응답·쓰기 몫 5초.
SOCIAL_GENERATE_DEADLINE_S = 105.0

ProjectId = Annotated[uuid.UUID, Query(description="프로젝트")]
_CONSUMED = frozenset({"project_id", "ids"})
_MENU = [auth.require_surface_gate("project")]          # 역할 천장 PROJECT_VIEWERS + 메뉴 project(검증 m-7)


@router.get("/v1/intent/social/prompts", summary="생성 프롬프트 목록, similar_to 조회 시 계산", response_model=PromptListEnvelope,
            dependencies=_MENU)
async def get_intent_social_prompts_0(request: Request, p: CurrentUser, conn: RoConn, project_id: ProjectId) -> PromptListEnvelope:
    acc = await auth.resolve_project(conn, p, await load_refs(conn), project_id, "member")
    items = await svc.list_prompts(conn, acc.project_id)
    return PromptListEnvelope(data=ListData(items=items), meta=intent_meta(request, mode="crud", consumed=_CONSUMED))


@router.post("/v1/intent/social/prompts",
             summary="프롬프트 생성(시드 api_ro → LLM → INSERT ON CONFLICT(project_id, seed_key)). seed_key 제안 반영 전 출시 금지",
             response_model=GenerateEnvelope, dependencies=[request_deadline(SOCIAL_GENERATE_DEADLINE_S)], responses=LLM_RESPONSES)
async def post_intent_social_prompts_1(request: Request, p: CurrentUserDetached, open_ro: RoSession, project_id: ProjectId,
                                       body: GenerateIn, llm: LlmDep) -> GenerateEnvelope:
    auth.require_surface(p, "project")
    data = await svc.generate(open_ro, llm, p, project_id, body)
    return GenerateEnvelope(data=data, meta=intent_meta(request, mode="crud", consumed=_CONSUMED))


@router.delete("/v1/intent/social/prompts", summary="생성 프롬프트 소프트 삭제", response_model=RemovedEnvelope, dependencies=_MENU)
async def delete_intent_social_prompts_2(request: Request, p: CurrentUser, conn: RoConn, rw: RwConn, project_id: ProjectId,
                                         ids: Annotated[list[uuid.UUID], Query(min_length=1, max_length=svc.MAX_REMOVE)]
                                         ) -> RemovedEnvelope:
    acc = await auth.resolve_project(conn, p, await load_refs(conn), project_id, "operate")
    n = await svc.remove(rw, acc.project_id, ids)
    return RemovedEnvelope(data=Removed(removed_count=n), meta=intent_meta(request, mode="crud", consumed=_CONSUMED))
