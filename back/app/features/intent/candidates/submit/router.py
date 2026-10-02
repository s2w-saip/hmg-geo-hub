"""intent.candidates.submit 후보 등록(공용) 라우터. 경로는 /v1 접두 포함 전체 경로.

프로젝트 화면 전용: project 표면 게이트(core.auth.require_surface_gate: 역할 천장 PROJECT_VIEWERS + 메뉴 그룹 project, 검증 m-7)
+ 운영 권한(core.auth.resolve_project operate).
"""
import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core import auth
from app.core.auth import CurrentUser
from app.core.codes import load_refs
from app.core.db import RoConn
from app.core.errors import ERROR_RESPONSES
from app.core.write import RwConn
from app.features.intent.candidates.submit import service as svc
from app.features.intent.candidates.submit.schemas import CandidateEnvelope, CandidateIn
from app.features.intent.keywords.research.intent_common import intent_meta

router = APIRouter(tags=["intent.candidates"], dependencies=[auth.require_surface_gate("project")], responses=ERROR_RESPONSES)


@router.post("/v1/intent/candidates", status_code=201, summary="후보 풀 추가(source google_keyword|social_scraping, 앱 단 dedup)",
             response_model=CandidateEnvelope)
async def post_intent_candidates_0(request: Request, p: CurrentUser, conn: RoConn, rw: RwConn,
                                   project_id: Annotated[uuid.UUID, Query()], body: CandidateIn) -> CandidateEnvelope:
    acc = await auth.resolve_project(conn, p, await load_refs(conn), project_id, "operate")
    data = await svc.submit(rw, acc.project_id, body)
    return CandidateEnvelope(data=data, meta=intent_meta(request, mode="crud", consumed=frozenset({"project_id"})))
