"""qa.review.sessions 검수 세션 라우터. 경로는 /v1 접두 포함 전체 경로.

POST /v1/qa/sessions 는 검수 게이트 입장(쿠키 발급)이라 게이트 앞에 있다(공유 비밀번호가 인증). 나머지는 쿠키 게이트 뒤.
로그아웃(현행 DELETE /api/qa/session 이식, D2)은 PATCH /v1/qa/sessions/{session_id} 본문 {"logout": true} 로 한다. 전용 DELETE 경로(qa R8)는
기각(메인 결정, 이유: DDL 없이 같은 결과·경로 계약 고정). PATCH 는 core.auth.QaConn(행 확인 없음)이라 이미 폐기된 세션도 쿠키를 지울 수 있고,
갱신(touch)은 행이 없으면 서비스가 401 을 낸다.
쿠키는 세션 쿠키(max-age 없음: 브라우저 종료 시 소멸, 교대 PC 운용)이고 12시간 하드 만료는 core.auth.verify_qa_cookie 가 강제한다.
GET /v1/qa/sessions/current(BG-45)는 부작용 없는 현재 세션 조회다: 쿠키 서명·만료 + 세션 행 존재를 확인하고 행을 돌려준다
(last_seen_at 을 갱신하지 않는다). 검수 게이트 레이아웃·입장 페이지가 매 렌더에 부른다(200 이면 입장 상태, 401 이면 게이트 폼).
"""
import uuid

from fastapi import APIRouter, Request, Response

from app.core.auth import QA_COOKIE, QaConn, QaUser
from app.core.config import get_settings
from app.core.envelope import Envelope
from app.core.errors import ERROR_RESPONSES, ErrorBody
from app.features.qa.answers.list.scope import qa_meta
from app.features.qa.review.sessions import service
from app.features.qa.review.sessions.schemas import QaLoginIn, QaLogoutOut, QaSessionOut, QaSessionPatch

router = APIRouter(tags=["qa.review"], responses=ERROR_RESPONSES)


@router.post("/v1/qa/sessions", summary="탭 단위 검수 세션 발급", status_code=201, response_model=Envelope[QaSessionOut],
             responses={429: {"model": ErrorBody, "description": "rate_limited"}})
async def post_qa_sessions_0(body: QaLoginIn, request: Request, response: Response) -> Envelope[QaSessionOut]:
    out, cookie = await service.login(request, body.name, body.password)
    response.set_cookie(QA_COOKIE, cookie, httponly=True, secure=not get_settings().is_dev, samesite="lax", path="/")
    response.headers["Cache-Control"] = "no-store"
    return Envelope(data=out, meta=qa_meta())


@router.get("/v1/qa/sessions/current", summary="현재 검수 세션 조회(부작용 없음: 쿠키 + 세션 행 확인, last_seen_at 갱신 안 함)",
            response_model=Envelope[QaSessionOut])
async def get_qa_sessions_current_2(reviewer: QaUser, conn: QaConn, response: Response) -> Envelope[QaSessionOut]:
    response.headers["Cache-Control"] = "no-store"
    return Envelope(data=await service.current(conn, reviewer), meta=qa_meta())


@router.patch("/v1/qa/sessions/{session_id}",
              summary="세션 last_seen_at 갱신. 본문 {\"logout\": true} 면 로그아웃(락 해제·세션 행 폐기·쿠키 삭제)",
              response_model=Envelope[QaSessionOut | QaLogoutOut])
async def patch_qa_sessions_by_id_1(session_id: uuid.UUID, reviewer: QaUser, conn: QaConn, response: Response,
                                    body: QaSessionPatch | None = None) -> Envelope[QaSessionOut | QaLogoutOut]:
    if body is not None and body.logout:
        out = await service.logout(conn, reviewer, session_id)
        response.delete_cookie(QA_COOKIE, path="/", httponly=True, secure=not get_settings().is_dev, samesite="lax")
        response.headers["Cache-Control"] = "no-store"
        return Envelope(data=out, meta=qa_meta())
    return Envelope(data=await service.touch(conn, reviewer, session_id), meta=qa_meta())
