"""요청 ID(X-Request-Id, fe-u1 요청 2): 요청마다 UUID 하나를 정해 응답 헤더·로그·접근 감사(app.access_audit_log.request_id)에 같은 값을 남긴다.

- 들어온 X-Request-Id 가 UUID 형식(하이픈 포함 36자 표준 표기)이면 그 값을 쓰고, 없거나 형식이 틀리면 새 UUID v4 를 만든다
  (프론트는 HTTP 시도마다 v4 를 보내고 재시도는 새 ID 다: front lib/hgh/client.ts). 들어온 값은 로그에 그대로 찍지 않고 파싱한 UUID 만 쓴다.
- 응답 헤더 X-Request-Id 는 모든 응답(업로드 상한 413·400 처럼 미들웨어가 직접 내는 응답 포함)에 붙인다. 처리되지 않은 예외의 500 은
  Starlette ServerErrorMiddleware 가 이 미들웨어 바깥에서 만들므로 core.errors 전역 처리기가 scope state 의 값을 헤더로 붙인다.
- 로그: 레코드 팩토리가 모든 로그 레코드에 request_id 속성(요청 밖은 '-')을 단다. 형식 문자열에서 %(request_id)s 로 쓴다.
  배포 로깅 설정은 back/logging.json(uvicorn --log-config, 핸들러 필터 RequestIdFilter 가 팩토리 설치 전 레코드에도 기본값을 단다).
  요청 한 건마다 'hgh.access' INFO 한 줄 `<메서드> <경로> <상태> <ms>ms rid=<요청 ID>` 을 남긴다(메시지 자체에 rid 를 넣어 형식 문자열이
  %(request_id)s 를 안 써도 남는다: 검증 V6-3). 경로·메서드는 safe_path 로 퍼센트 인코딩한다(검증 V6-2: 경로의 %0A 가 디코딩돼 scope path 에
  줄바꿈으로 들어오면 가짜 로그 줄을 만들 수 있었다. uvicorn 접근 로그와 같은 urllib.parse.quote). 쿼리 문자열은 남기지 않는다.
- X-Request-Id 는 상관관계(로그·감사·프론트 오류 대조)용이다. 클라이언트가 고를 수 있어 유일성·무결성을 보장하지 않는다(인증·중복 판정에 쓰지 않는다).
- 접근 감사: core.write.AccessAuditWriter 가 request_id 인자를 받지 않은 기록에 현재 요청 ID 를 넣는다.
"""
from __future__ import annotations

import logging
import re
import time
import uuid
from contextvars import ContextVar
from typing import Any
from urllib.parse import quote

HEADER = "x-request-id"
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_CURRENT: ContextVar[uuid.UUID | None] = ContextVar("hgh_request_id", default=None)
access_log = logging.getLogger("hgh.access")


def current_request_id() -> uuid.UUID | None:
    """지금 처리 중인 요청의 ID(요청 밖이면 None)."""
    return _CURRENT.get()


def parse_request_id(value: str | None) -> uuid.UUID | None:
    """표준 표기 UUID 만 받는다(대소문자 무관, 중괄호·URN·하이픈 없는 표기 거부). 틀리면 None."""
    if not value or len(value) != 36 or not _UUID_RE.match(value):
        return None
    return uuid.UUID(value)


def safe_path(value: Any, limit: int = 2048) -> str:
    """로그에 싣는 경로·메서드 표기: 퍼센트 인코딩(uvicorn 접근 로그와 같은 quote, '/' 만 그대로)으로 제어 문자·공백·비ASCII 를 없애고
    길이를 자른다. 로그 줄 위조(CR·LF)와 거대 경로를 막는다."""
    s = quote(str(value or ""), safe="/")
    return s if len(s) <= limit else s[:limit] + "…"


def request_id_of_scope(scope: dict[str, Any]) -> str | None:
    """ASGI scope 에 미들웨어가 남긴 요청 ID(전역 500 처리기처럼 컨텍스트 밖에서 읽을 때)."""
    st = scope.get("state")
    v = st.get("request_id") if isinstance(st, dict) else None
    return str(v) if v else None


class RequestIdMiddleware:
    """순수 ASGI 미들웨어(스트리밍 응답을 감싸지 않는다). 가장 바깥에 둔다(업로드 상한 미들웨어보다 밖)."""

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        raw = next((v.decode("latin-1") for k, v in scope.get("headers") or [] if k.decode("latin-1").lower() == HEADER), None)
        rid = parse_request_id(raw) or uuid.uuid4()
        scope.setdefault("state", {})["request_id"] = str(rid)
        token = _CURRENT.set(rid)
        status = 0
        t0 = time.perf_counter()

        async def send_with_id(message: dict[str, Any]) -> None:
            nonlocal status
            if message.get("type") == "http.response.start":
                status = int(message.get("status") or 0)
                headers = [(k, v) for k, v in message.get("headers") or [] if k.decode("latin-1").lower() != HEADER]
                headers.append((b"x-request-id", str(rid).encode("latin-1")))
                message = {**message, "headers": headers}
            await send(message)

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            access_log.info("%s %s %s %.0fms rid=%s", safe_path(scope.get("method"), 16), safe_path(scope.get("path")), status or "-",
                            (time.perf_counter() - t0) * 1000, rid)
            _CURRENT.reset(token)


class RequestIdFilter(logging.Filter):
    """핸들러 필터(back/logging.json): 레코드에 request_id 가 없으면(팩토리 설치 전 uvicorn 기동 로그 등) 현재 값 또는 '-' 를 단다.
    형식 문자열의 %(request_id)s 가 KeyError 로 로그를 잃지 않게 한다."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "request_id"):
            rid = _CURRENT.get()
            record.request_id = str(rid) if rid is not None else "-"
        return True


_installed = False


def install_log_record_factory() -> None:
    """모든 로그 레코드에 request_id 속성을 단다(한 번만). 핸들러 형식에서 %(request_id)s 로 쓴다."""
    global _installed
    if _installed:
        return
    base = logging.getLogRecordFactory()

    def factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        rec = base(*args, **kwargs)
        rid = _CURRENT.get()
        rec.request_id = str(rid) if rid is not None else "-"
        return rec

    logging.setLogRecordFactory(factory)
    _installed = True
