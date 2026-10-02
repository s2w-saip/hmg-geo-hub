"""파일 업로드(python-multipart, FastAPI UploadFile) 공용: 크기 상한 한 곳.

- 상한 = core.config.upload_max_bytes(HGH_UPLOAD_MAX_BYTES, 기본 10 MiB). 기능은 더 좁은 상한(max_bytes)만 줄 수 있다(넓힐 수 없다).
- UploadLimitMiddleware(app.main 이 건다): multipart/form-data·xlsx·octet-stream 본문은 읽는 도중 상한 + 여유(64 KiB, multipart
  경계·헤더)를 넘는 순간 413 payload_too_large 로 끊는다. Starlette 는 파일 파트를 끝까지 임시 파일로 받은 뒤 핸들러를 부르므로
  핸들러 안 검사만으로는 거대 업로드가 디스크·시간을 먼저 쓴다. Content-Length 가 상한을 넘으면 본문을 읽지 않고 바로 413.
- read_upload_file(file, max_bytes=…): 64 KiB 조각으로 읽어 상한을 넘으면 413, 비었으면 422 invalid_upload.
- read_upload_request(request, …): 예전 계약(본문 = xlsx 원본 바이트)도 받는 가져오기 경로용. multipart 는 file 필드.
"""
from __future__ import annotations

from typing import Any

from fastapi import Request, UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core import errors
from app.core.config import get_settings

# 업로드 경로 OpenAPI 응답 선언(fe-u1 요청 4): 라우터 공통 ERROR_RESPONSES(401·403·404·422·503)에 더한다. 실제로 내는 코드와 같다
# (UploadLimitMiddleware 400·413, read_upload_request 413·415).
UPLOAD_RESPONSES: dict[int | str, dict[str, Any]] = {
    400: {"model": errors.ErrorBody, "description": "invalid_upload(Content-Type·Content-Length 헤더 중복 등 업로드 요청 형식 오류)"},
    413: {"model": errors.ErrorBody, "description": "payload_too_large(업로드 상한 초과: 본문 수신 중 끊는다)"},
    415: {"model": errors.ErrorBody, "description": "unsupported_media_type(multipart/form-data 의 file 또는 xlsx 본문만)"},
}

__all__ = ["UPLOAD_SLACK", "XLSX_MIME", "UploadLimitMiddleware", "read_upload_file", "read_upload_request", "upload_limit"]

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
UPLOAD_SLACK = 64 * 1024
_LIMITED_TYPES = ("multipart/form-data", XLSX_MIME, "application/octet-stream")
_CHUNK = 64 * 1024


def upload_limit(max_bytes: int | None = None) -> int:
    g = get_settings().upload_max_bytes
    return min(g, max_bytes) if max_bytes else g


def too_large(limit: int) -> errors.ApiError:
    return errors.ApiError(413, "payload_too_large", f"업로드는 {limit // (1024 * 1024) or 1}MB 까지")


async def read_upload_file(file: UploadFile | None, *, max_bytes: int | None = None, field: str = "file") -> bytes:
    if file is None:
        raise errors.unprocessable(f"{field} 필드가 없다", code="invalid_upload", details={"field": field})
    limit = upload_limit(max_bytes)
    buf = bytearray()
    while True:
        chunk = await file.read(_CHUNK)
        if not chunk:
            break
        buf += chunk
        if len(buf) > limit:
            raise too_large(limit)
    if not buf:
        raise errors.unprocessable("업로드된 파일이 비었다", code="invalid_upload", details={"field": field})
    return bytes(buf)


async def read_upload_request(request: Request, *, max_bytes: int | None = None, field: str = "file",
                              raw_types: tuple[str, ...] = (XLSX_MIME, "application/octet-stream")) -> bytes:
    """multipart/form-data(field) 또는 본문 원본(raw_types). 그 밖의 Content-Type 은 415 unsupported_media_type."""
    ct = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    limit = upload_limit(max_bytes)
    if ct == "multipart/form-data":
        form = await request.form()
        f = form.get(field)
        if not hasattr(f, "read"):
            raise errors.unprocessable(f"{field} 필드가 없다", code="invalid_upload", details={"field": field})
        return await read_upload_file(f, max_bytes=limit, field=field)  # type: ignore[arg-type]
    if ct in raw_types:
        buf = bytearray()
        async for chunk in request.stream():
            buf += chunk
            if len(buf) > limit:
                raise too_large(limit)
        if not buf:
            raise errors.unprocessable("업로드된 파일이 비었다", code="invalid_upload", details={"field": field})
        return bytes(buf)
    raise errors.ApiError(415, "unsupported_media_type", "multipart/form-data(file) 또는 xlsx 본문만 받는다")


class UploadLimitMiddleware:
    """업로드 본문 상한(ASGI). 제한 대상 Content-Type 만 센다(JSON 등은 통과).
    Content-Type·Content-Length 헤더가 둘 이상이면 어느 쪽으로 해석하든 우회가 되므로(마지막 값만 보면 앞의 multipart 가 상한 밖으로
    파싱된다: 검증 m-1) 요청 전체를 400 invalid_upload 로 거부한다."""

    def __init__(self, app: Any):
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        raw = [(k.decode("latin-1").lower(), v.decode("latin-1")) for k, v in scope.get("headers") or []]
        for name in ("content-type", "content-length"):
            if sum(1 for k, _ in raw if k == name) > 1:
                await _send_error(send, 400, "invalid_upload", f"{name} 헤더가 둘 이상")
                return
        headers = dict(raw)
        ct = (headers.get("content-type") or "").split(";", 1)[0].strip().lower()
        if ct not in _LIMITED_TYPES:
            await self.app(scope, receive, send)
            return
        cap = get_settings().upload_max_bytes + UPLOAD_SLACK
        cl = headers.get("content-length")
        if cl is not None and cl.isdigit() and int(cl) > cap:
            await _reject(send, cap - UPLOAD_SLACK)
            return
        seen = 0
        responded = False

        async def limited_receive() -> dict[str, Any]:
            nonlocal seen
            msg = await receive()
            if msg.get("type") == "http.request":
                seen += len(msg.get("body") or b"")
                if seen > cap:
                    raise _TooLarge()
            return msg

        async def tracking_send(msg: dict[str, Any]) -> None:
            nonlocal responded
            if msg.get("type") == "http.response.start":
                responded = True
            await send(msg)

        try:
            await self.app(scope, limited_receive, tracking_send)
        except _TooLarge:
            if not responded:
                await _reject(send, cap - UPLOAD_SLACK)


class _TooLarge(StarletteHTTPException):
    """본문 상한 초과. HTTPException 이라 FastAPI 본문 파싱(폼)이 400 으로 뭉개지 않고 core 처리기가 413 payload_too_large 로 낸다."""

    def __init__(self) -> None:
        super().__init__(413, "업로드 상한 초과")


async def _reject(send: Any, limit: int) -> None:
    await _send_error(send, 413, "payload_too_large", f"업로드는 {limit // (1024 * 1024) or 1}MB 까지")


async def _send_error(send: Any, status: int, code: str, message: str) -> None:
    import json

    body = json.dumps({"error": {"code": code, "message": message, "details": None}}, ensure_ascii=False).encode()
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                            (b"connection", b"close")]})
    await send({"type": "http.response.body", "body": body})
