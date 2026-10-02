"""오류 모델 {error:{code, message, details}}.

- 기능 코드는 ApiError(또는 아래 생성 함수)만 던진다. HTTPException 을 직접 쓰지 않는다.
- 404 는 존재·권한·노출 실패를 통일한다(IDOR 은폐). 한국어 문구는 프론트 i18n 이 code 로 매핑하므로 message 는 개발자용이다.
- 내부 예외는 500 internal 로 감싸고 원문(쿼리·값)을 응답에 싣지 않는다.
- DB 오류 최후 방어(전역 처리기, 메인 결정 2026-09-28, 검증 m-3 로 좁힘): 기능이 사전 검증을 빠뜨려도 500 이 아니라
    입력 유래 22xxx: 22001(길이 초과)·22P02(형식)·22007(날짜 형식)·22008(날짜 범위)·22021(문자, 클라이언트 인코딩 오류 포함),
                    쓰기 요청의 22003(수 범위)                                            → 422 invalid_value
    그 밖 22xxx(22012 나눗셈 0 등: 서버 산식 결함)                                       → 500 internal + WARNING(exc_info)
    23505(유일)                                                                          → 409 conflict
    23503(FK)·23514(CHECK)·23502(NOT NULL)                                               → 422 constraint_violation
    쓰기 요청의 40001(직렬화 실패)·40P01(교착)                                           → 409 retry_conflict(재시도 가능)
  응답 details 에 제약 이름을 싣지 않는다(DB 내부 이름 비노출, 로그에만). 의미 있는 충돌 코드가 필요한 기능은
  from_db_error(e, messages={제약 이름: 코드}) 로 명시 매핑한다(details 없음).
- 인증 실패(401)·권한 없음(403) 응답은 Cache-Control: no-store(세션 엔드포인트 성공 응답과 같은 캐시 정책).
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.exc import DBAPIError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.reqid import request_id_of_scope, safe_path

log = logging.getLogger("hgh.errors")


class ErrorDetail(BaseModel):
    code: str = Field(description="오류 코드(unauthenticated, forbidden, not_found, conflict, unprocessable, upstream, internal 또는 세부 코드)")
    message: str
    details: dict[str, Any] | list[Any] | None = None


class ErrorBody(BaseModel):
    error: ErrorDetail


class ApiError(Exception):
    """HTTP 상태 + 오류 코드. details 에는 식별자·필드명만(비밀·원문 쿼리 금지)."""

    def __init__(self, status: int, code: str, message: str = "", details: dict[str, Any] | list[Any] | None = None):
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.message = message or code
        self.details = details

    def body(self) -> dict[str, Any]:
        return ErrorBody(error=ErrorDetail(code=self.code, message=self.message, details=self.details)).model_dump()


def unauthenticated(message: str = "인증 필요", code: str = "unauthenticated") -> ApiError:
    return ApiError(401, code, message)


def forbidden(message: str = "권한 없음", code: str = "forbidden", details: dict[str, Any] | None = None) -> ApiError:
    return ApiError(403, code, message, details)


def not_found(message: str = "없음", code: str = "not_found") -> ApiError:
    return ApiError(404, code, message)


def conflict(code: str, message: str = "충돌", details: dict[str, Any] | None = None) -> ApiError:
    return ApiError(409, code, message, details)


def unprocessable(message: str, code: str = "unprocessable", details: dict[str, Any] | list[Any] | None = None) -> ApiError:
    return ApiError(422, code, message, details)


def upstream(message: str = "외부 서비스 오류", code: str = "upstream") -> ApiError:
    return ApiError(502, code, message)


def unavailable(message: str = "일시적으로 사용할 수 없음", code: str = "unavailable") -> ApiError:
    return ApiError(503, code, message)


def gateway_timeout(message: str = "외부 서비스 시간 초과", code: str = "upstream_timeout") -> ApiError:
    """504: 요청 기한 안에 외부 호출이 끝나지 않았다(재시도하지 않음, core.llm D-7)."""
    return ApiError(504, code, message)


# OpenAPI 에 붙일 공통 오류 응답(라우터 responses= 에 펼쳐 쓴다). 503 = CurrentUser 의 JWKS 장애(auth_unavailable). 409 는 기능이 골라 쓴다.
ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    401: {"model": ErrorBody, "description": "unauthenticated"},
    403: {"model": ErrorBody, "description": "forbidden"},
    404: {"model": ErrorBody, "description": "not_found"},
    422: {"model": ErrorBody, "description": "unprocessable"},
    503: {"model": ErrorBody, "description": "unavailable(auth_unavailable: JWKS 장애 포함)"},
}
ERROR_RESPONSES_EXTRA: dict[int | str, dict[str, Any]] = {
    409: {"model": ErrorBody, "description": "conflict"},
}


# ════════════════════════════════════════════════════════════════════════════
# DB 오류 → API 오류
# ════════════════════════════════════════════════════════════════════════════
_CLIENT_CAUSE_STATE = ((UnicodeError, "22021"), (OverflowError, "22003"), (ValueError, "22P02"), (TypeError, "22P02"))


def db_error_info(e: BaseException) -> tuple[str | None, str | None]:
    """(SQLSTATE, 제약 이름). SQLAlchemy DBAPIError·asyncpg 예외 사슬을 따라가 찾는다.
    서버 왕복 전 asyncpg 인자 인코딩 실패(클래스 기본 SQLSTATE 22000 + 원인 예외)는 원인으로 구체화한다: 인코딩(짝 없는 서로게이트) 22021,
    정수 범위 22003, 그 밖 값 형식 22P02(전부 입력 유래)."""
    cur: BaseException | None = e
    state = constraint = None
    for _ in range(6):
        if cur is None:
            break
        if state in (None, "22000"):
            for cls, st in _CLIENT_CAUSE_STATE:
                if isinstance(cur, cls):
                    return st, constraint
        st = getattr(cur, "sqlstate", None) or getattr(cur, "pgcode", None)
        if isinstance(st, str) and state is None:
            state = st
        cn = getattr(cur, "constraint_name", None)
        if isinstance(cn, str) and constraint is None:
            constraint = cn
        nxt = getattr(cur, "orig", None)
        cur = nxt if isinstance(nxt, BaseException) and nxt is not cur else cur.__cause__
    return state, constraint


INPUT_DATA_STATES = frozenset({"22001", "22P02", "22007", "22008", "22021"})   # 입력 값 유래 데이터 예외(요청 무관)
WRITE_INPUT_STATES = frozenset({"22003"})                                     # 쓰기 요청에서만 입력 유래로 본다(수 범위)
RETRYABLE_STATES = frozenset({"40001", "40P01"})                              # 쓰기 요청의 직렬화 실패·교착: 같은 요청을 다시 보내면 된다


def from_db_error(e: BaseException, *, messages: dict[str, str] | None = None, write: bool = False) -> ApiError | None:
    """DB 오류를 API 오류로(해당 없으면 None = 500). messages = {제약 이름: 오류 코드} 로 기능이 제약별 코드를 줄 수 있다
    (예 {'ga4_property_market_uq': 'market_taken'}, 23505 면 409 나머지 422). write = 쓰기 요청(22003 을 입력 유래로 보고,
    40001·40P01 을 409 retry_conflict 로: 커밋 때 발동하는 지연 제약 트리거의 동시성 충돌 포함, 검증 N-1).
    응답 details 는 싣지 않는다(제약 이름은 로그만). 전역 처리기도 이 함수를 쓴다."""
    state, constraint = db_error_info(e)
    if state is None:
        return None
    if messages and constraint in messages:
        return ApiError(409 if state == "23505" else 422, messages[constraint], "제약 위반")
    if state in INPUT_DATA_STATES or (write and state in WRITE_INPUT_STATES):
        return ApiError(422, "invalid_value", "입력 값을 저장할 수 없음(형식·문자·범위)")
    if state == "23505":
        return ApiError(409, "conflict", "이미 있는 값")
    if state in ("23503", "23514", "23502"):
        return ApiError(422, "constraint_violation", "제약 위반")
    if write and state in RETRYABLE_STATES:
        return ApiError(409, "retry_conflict", "동시 변경과 충돌했다: 같은 요청을 다시 보내면 된다")
    return None


_NO_STORE = {"Cache-Control": "no-store"}

_STATUS_CODE = {400: "bad_request", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 405: "method_not_allowed",
                409: "conflict", 413: "payload_too_large", 415: "unsupported_media_type", 422: "unprocessable", 429: "rate_limited", 501: "not_implemented", 502: "upstream", 503: "unavailable"}


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status, content=exc.body(), headers=_NO_STORE if exc.status in (401, 403) else None)

    @app.exception_handler(DBAPIError)
    async def _db_error(request: Request, exc: DBAPIError) -> JSONResponse:
        state, constraint = db_error_info(exc)
        mapped = from_db_error(exc, write=request.method not in ("GET", "HEAD", "OPTIONS"))
        if mapped is None:
            if state is not None and state.startswith("22"):      # 입력 유래가 아닌 데이터 예외 = 서버 산식 결함(경고, 원인 추적용 exc_info)
                log.warning("db data error %s %s %s", state, request.method, safe_path(request.url.path), exc_info=exc)
            else:
                log.exception("unhandled db error %s %s", request.method, safe_path(request.url.path))
            return JSONResponse(status_code=500, content=ErrorBody(error=ErrorDetail(code="internal", message="서버 오류")).model_dump())
        log.info("db error → %s %s (sqlstate %s constraint %s, %s %s)", mapped.status, mapped.code, state, constraint,
                 request.method, safe_path(request.url.path))
        return JSONResponse(status_code=mapped.status, content=mapped.body())

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = [{"loc": list(e.get("loc", ())), "msg": e.get("msg"), "type": e.get("type")} for e in exc.errors()]
        body = ErrorBody(error=ErrorDetail(code="unprocessable", message="요청 검증 실패", details=details)).model_dump()
        return JSONResponse(status_code=422, content=body)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_CODE.get(exc.status_code, "error")
        msg = exc.detail if isinstance(exc.detail, str) else code
        headers = dict(getattr(exc, "headers", None) or {})
        if exc.status_code in (401, 403):
            headers.update(_NO_STORE)
        return JSONResponse(status_code=exc.status_code, content=ErrorBody(error=ErrorDetail(code=code, message=msg)).model_dump(),
                            headers=headers or None)

    @app.exception_handler(Exception)
    async def _internal(request: Request, exc: Exception) -> JSONResponse:
        # 이 처리기는 ServerErrorMiddleware(요청 ID 미들웨어 바깥)가 부른다: 요청 ID 는 scope state 에서 읽어 로그·헤더에 싣는다
        rid = request_id_of_scope(request.scope)
        log.exception("unhandled %s %s request_id=%s", request.method, safe_path(request.url.path), rid or "-")
        return JSONResponse(status_code=500, content=ErrorBody(error=ErrorDetail(code="internal", message="서버 오류")).model_dump(),
                            headers={"X-Request-Id": rid} if rid else None)
