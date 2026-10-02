"""admin.integrations.keyword_tools 키워드 도구 라우터. 경로는 /v1 접두 포함 전체 경로.

모든 엔드포인트: 인증 + role=admin + 메뉴 그룹 admin(유료 외부 API 뒤라 현행도 admin 전용, 판정·코드 = require_admin·require_menu_group).
검색량은 수집된 rd.kw_* 를 읽고 부족분은 judgment_change('dfs_fetch') 로 수집을 요청한다(202). LLM 은 core.llm(LlmDep, 테스트는
app.dependency_overrides[core.llm.get_llm]). LLM 을 부르는 엔드포인트(to-prompt·prompt-to-volume)는 CurrentUserDetached 로 받아 요청
커넥션을 쥐지 않는다: 게이트는 같은 Detached principal 로(AdminDetached), 읽기는 호출 뒤 RoSession(짧은 api_ro).
"""
from __future__ import annotations

from fastapi import APIRouter, Response

from app.core.auth import AdminDetached, CurrentUser, require_admin, require_menu_group
from app.core.db import RoConn, RoSession
from app.core.envelope import Envelope, build_meta
from app.core.errors import ERROR_RESPONSES
from app.core.llm import LLM_RESPONSES, LlmDep, request_deadline

from . import service
from .schemas import PromptToVolumeBody, PromptToVolumeData, ToPromptBody, ToPromptData, VolumeBody, VolumeData

router = APIRouter(tags=["admin.integrations"], responses=ERROR_RESPONSES)
# LLM 요청 기한(D-7): BFF 는 185초에 끊는다(front/lib/hgh/adapters/admin.ts KEYWORD_LLM_TIMEOUT_MS). LLM 뒤 검색량 읽기·수집 요청과 응답 몫 10초.
KEYWORD_LLM_DEADLINE_S = 175.0
GATE = [require_admin, require_menu_group("admin")]          # 요청 커넥션(CurrentUser → RoConn)을 쓰는 엔드포인트 게이트




def _status(response: Response, fetch_status: str) -> None:
    response.status_code = 200 if fetch_status == "fresh" else 202


@router.post("/v1/admin/keyword-tools/volume", dependencies=GATE, summary="(단위 설계 필요) 키워드 검색량 조회(dfs_fetch 큐)")
async def post_admin_keyword_tools_volume_0(p: CurrentUser, conn: RoConn, body: VolumeBody, response: Response) -> Envelope[VolumeData]:
    """수집된 값을 즉시 돌려주고, 없거나 7일 넘은 키워드는 수집 요청(202, data.fetch.change_id 로 /v1/admin/changes 에서 확인)."""
    d = await service.volume(conn, p, body)
    _status(response, d.fetch.status)
    return Envelope[VolumeData](data=d, meta=build_meta(mode="external", source={"volumes": "rd.kw_volume_monthly", "fresh_days": 7}))


@router.post("/v1/admin/keyword-tools/to-prompt", summary="(단위 설계 필요) 키워드 → 프롬프트 변환",
             dependencies=[request_deadline(KEYWORD_LLM_DEADLINE_S)], responses=LLM_RESPONSES)
async def post_admin_keyword_tools_to_prompt_1(p: AdminDetached, llm: LlmDep, body: ToPromptBody) -> Envelope[ToPromptData]:
    """LLM 으로 키워드(또는 '[kw1,kw2]-제목 - 설명' 행)를 AI 질문으로. volume 은 keyword_volume_map 에서 붙인다."""
    return Envelope[ToPromptData](data=await service.to_prompt(llm, body), meta=build_meta(mode="external"))


@router.post("/v1/admin/keyword-tools/prompt-to-volume", summary="(단위 설계 필요) 프롬프트 → 키워드 검색량",
             dependencies=[request_deadline(KEYWORD_LLM_DEADLINE_S)], responses=LLM_RESPONSES)
async def post_admin_keyword_tools_prompt_to_volume_2(p: AdminDetached, open_ro: RoSession, llm: LlmDep, body: PromptToVolumeBody,
                                                      response: Response) -> Envelope[PromptToVolumeData]:
    """LLM 이 프롬프트에서 키워드 1~2개를 뽑고 수집된 검색량 최댓값을 돌려준다. 부족분은 수집 요청(202)."""
    d = await service.prompt_to_volume(open_ro, p, llm, body)
    _status(response, d.fetch.status)
    return Envelope[PromptToVolumeData](data=d, meta=build_meta(mode="external"))
