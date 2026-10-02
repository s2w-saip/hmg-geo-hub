"""FastAPI 앱 진입점: 기능 라우터를 레지스트리 순서로 등록한다.

기동(lifespan): DB 풀 초기화(접속은 첫 요청 때) → JWKS 선로드 → 접근 감사 배치 라이터 시작. 종료: 라이터 flush → 풀 정리.
오류는 core.errors 가 {error:{code, message, details}} 로 통일한다.
"""
import importlib
import logging
import os
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.routing import APIRoute

from app.core.auth import get_verifier
from app.core.config import get_settings
from app.core.db import close_db, init_db
from app.core.errors import install_error_handlers
from app.core.reqid import RequestIdMiddleware, install_log_record_factory
from app.core.upload import UploadLimitMiddleware
from app.core.write import get_audit_writer
from app.features import FEATURE_ROUTERS

log = logging.getLogger("hgh")

API_DESCRIPTION = """HMG-GEO-HUB 백엔드 API. 응답 봉투 {data, meta}, 오류 {error:{code, message, details}}.

- 요청 ID: 요청 헤더 X-Request-Id(UUID 표준 표기)를 받으면 그 값을, 없거나 형식이 틀리면 새 UUID v4 를 쓴다. 모든 응답 헤더 X-Request-Id 로
  돌려주고 서버 로그·접근 감사(app.access_audit_log.request_id)에 같은 값을 남긴다.
- 공통 필터(분석 읽기): surface·project_id·brand·country·lang·engine·from·to·funnel·brand_presence·list_type·depth1~4·source.
  리스트 축은 같은 이름을 반복한다(?country=US&country=GB). 엔드포인트가 지원하지 않는 축은 무시하고 meta.ignored_filters 에,
  권한 밖·알 수 없는 값은 meta.dropped_filters 에 적는다. from·to 는 한쪽만 줘도 된다(빠진 to = 최신 회차, 빠진 from = 최초 회차:
  GET /v1/filters/dates 기본 family 의 latest_round_date·first_measured_date).
- 커스텀 필드 필터 cf.<field_uuid>=값(OpenAPI 매개변수로 나타나지 않는 동적 키): project 표면 전용(다른 표면은 meta.ignored_filters 'custom').
  같은 키를 반복해 값을 여럿 준다. 한 필드 안의 값들은 OR, 필드끼리는 AND. 키 형식이 틀리면 422, 빈 값만 준 필드는 결과 0.
- operationId = <method>_<경로>(경로 매개변수는 by_<이름>). 라우터 등록 순서가 바뀌어도 그대로다.
"""


def stable_operation_id(route: APIRoute) -> str:
    """안정 operationId(fe-u1 요청 3): FastAPI 기본(함수 이름 + 경로 + 메서드, 함수 이름에 등록 순번 포함)을 <method>_<경로> 로 바꾼다.
    경로 매개변수 {x} 는 by_x. 라우트가 operation_id 를 직접 주면 FastAPI 가 그 값을 먼저 쓴다(listPrompts 등)."""
    method = sorted(route.methods or {"get"})[0].lower()
    path = re.sub(r"\{([^}]+)\}", r"by_\1", route.path_format)
    return f"{method}_{re.sub(r'[^0-9A-Za-z]+', '_', path).strip('_')}"


DOCS_ENVS = ("local", "test")                   # D-1: API 문서 경로를 여는 환경


def docs_urls(env: str | None) -> dict[str, str | None]:
    """D-1(2026-09-30): /openapi.json·/docs·/redoc 는 개발 환경(HGH_ENV local·test, 미설정 = local)에서만 연다. stg·prod(와 알 수 없는 값)는
    세 경로를 등록하지 않는다(404, 무인증 공개 금지). 스키마 자체(app.openapi())는 환경과 무관하게 만들어진다: front 계약 생성
    (front/scripts/gen-api-types.mjs)은 프로세스 안에서 app.openapi() 를 부르므로 영향이 없다. 값은 import 시점의 HGH_ENV(systemd 유닛)."""
    on = (env or "local").strip() in DOCS_ENVS
    return {"openapi_url": "/openapi.json" if on else None, "docs_url": "/docs" if on else None, "redoc_url": "/redoc" if on else None}


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    log.info("기동 %s", settings)
    init_db(settings)
    await get_verifier().preload()
    writer = get_audit_writer() if settings.access_audit else None
    if writer is not None:
        writer.start()
    try:
        yield
    finally:
        if writer is not None:
            await writer.stop()
        await close_db()


install_log_record_factory()                    # 모든 로그 레코드에 request_id(core.reqid)
app = FastAPI(title="HMG-GEO-HUB API", version="0.1.0", lifespan=lifespan, description=API_DESCRIPTION,
              generate_unique_id_function=stable_operation_id, **docs_urls(os.environ.get("HGH_ENV")))
install_error_handlers(app)
app.add_middleware(UploadLimitMiddleware)       # 업로드 본문 상한(core.config.upload_max_bytes): 폼 파싱 전에 끊는다
app.add_middleware(RequestIdMiddleware)         # 가장 바깥(나중에 더한 미들웨어가 바깥): 업로드 상한 413·400 응답에도 X-Request-Id


@app.get("/healthz", include_in_schema=False)
async def healthz() -> dict:
    return {"ok": True}


for _fid, _mod in FEATURE_ROUTERS:
    app.include_router(importlib.import_module(_mod).router)
