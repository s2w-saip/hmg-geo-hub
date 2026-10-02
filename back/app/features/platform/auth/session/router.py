"""platform.auth.session 세션·스코프 라우터. 경로는 /v1 접두 포함 전체 경로."""
from fastapi import APIRouter, Request, Response

from app.core.auth import CurrentUser
from app.core.codes import load_refs
from app.core.db import RoConn
from app.core.envelope import Envelope, crud_meta
from app.core.errors import ERROR_RESPONSES

from .schemas import SessionData
from .service import build_session

router = APIRouter(tags=["platform.auth"])

# 401(토큰·계정) · 503(JWKS 장애 auth_unavailable, core.auth). 401·403 응답의 Cache-Control: no-store 는 core 오류 처리기가 붙인다.
_RESPONSES: dict[int | str, dict] = {401: ERROR_RESPONSES[401], 503: ERROR_RESPONSES[503]}


@router.get("/v1/auth/me", response_model=Envelope[SessionData], responses=_RESPONSES,
            summary="JWT(JWKS) 검증된 사용자 세션(role·operator·scope·menu_groups·is_qa_reviewer). 프론트 GNB·SNB 분기")
async def get_auth_me_0(request: Request, response: Response, p: CurrentUser, conn: RoConn) -> Envelope[SessionData]:
    """현재 사용자 세션. 스코프는 core.auth.DataScope 계산값(Q10 유효 국가·Q16 admin 전체·vendor 빈 브랜드 무제한).

    공통 필터는 지원하지 않는다: 들어오면 meta.ignored_filters 에 적는다(core.envelope.crud_meta = core.filters.ignored_axes).
    회차·표면 개념이 없어 meta 는 mode=session, 나머지 null·빈 값. 개인 세션이라 공유 캐시 금지(Cache-Control: private, no-store).
    """
    refs = await load_refs(conn)
    meta = crud_meta(request.query_params, mode="session")
    response.headers["Cache-Control"] = "private, no-store"
    return Envelope[SessionData](data=build_session(p, refs), meta=meta)
