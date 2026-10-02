"""projects.prompts.io 가져오기·내보내기 라우터. 경로는 /v1 접두 포함 전체 경로.

권한: 내보내기 = 프로젝트 가시(member, 읽기 전용·비용 없음), 가져오기 = 활성 Owner 또는 admin(owner).
내보내기는 xlsx 바이너리 응답(봉투 없음, PJ-3 open ⑤ 를 taxonomy "xlsx 스트림"으로 확정). 무시된 공통 필터는 X-HGH-Ignored-Filters 헤더.
접근 감사: 내보내기 = kind download(Q4).
가져오기 본문: multipart/form-data 의 file 필드(현행 FormData) 또는 xlsx 본문 그대로(하위 호환). core.upload.read_upload_request
(python-multipart, 상한 = min(core 10MiB, 이 기능 5MB), 넘으면 413 payload_too_large)로 읽는다. 권한 판정 뒤에 읽으려고
UploadFile 인자(FastAPI 가 핸들러 전에 폼을 읽는다) 대신 요청에서 직접 읽는다.
"""
from __future__ import annotations

import uuid
from urllib.parse import quote

from fastapi import APIRouter, Request, Response
from starlette.concurrency import run_in_threadpool

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.filters import ignored_axes
from app.core.upload import UPLOAD_RESPONSES, read_upload_request
from app.core.write import RwConn, access_audit
from app.features.projects.prompts.crud.common import PJ3_CONSUMED, ROUTER_DEPS, project_gate

from . import service
from .schemas import MAX_ROWS, MAX_UPLOAD_BYTES, XLSX_MIME, ImportSummary

router = APIRouter(tags=["projects.prompts"], dependencies=ROUTER_DEPS, responses=ERROR_RESPONSES)

_IMPORT_BODY = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {"schema": {"type": "object", "required": ["file"],
                                               "properties": {"file": {"type": "string", "format": "binary"}}}},
            XLSX_MIME: {"schema": {"type": "string", "format": "binary"}},
        },
    }
}


@router.get("/v1/projects/{project_id}/prompts/export", summary="xlsx 스트림(id+text+태그)",
            response_class=Response, responses={200: {"content": {XLSX_MIME: {}}, "description": "xlsx 파일"}})
async def get_projects_by_id_prompts_export_0(project_id: uuid.UUID, request: Request, p: CurrentUser, conn: RoConn) -> Response:
    await project_gate(conn, p, project_id, "active_member")      # 멤버 전용 읽기(front prompt/page.tsx:43, 메인 정정 2026-09-28)
    data, filename, n = await service.export_xlsx(conn, project_id)
    access_audit(p, "download", "projects.prompts.export", target=str(project_id), detail={"rows": n})
    headers = {"Content-Disposition": f"attachment; filename=\"{filename}\"; filename*=UTF-8''{quote(filename)}"}
    ignored = ignored_axes(request.query_params, None, "project", consumed=PJ3_CONSUMED)
    if ignored:
        headers["X-HGH-Ignored-Filters"] = ",".join(ignored)
    return Response(content=data, media_type=XLSX_MIME, headers=headers)


@router.post("/v1/projects/{project_id}/prompts/import", summary="xlsx multipart 가져오기(행 상한)", response_model=Envelope[ImportSummary],
             openapi_extra=_IMPORT_BODY, responses=UPLOAD_RESPONSES, description=f"데이터 행 상한 {MAX_ROWS}. 초과·형식 오류는 422, 5MB 초과 413.")
async def post_projects_by_id_prompts_import_1(project_id: uuid.UUID, request: Request, p: CurrentUser, conn: RoConn,
                                               rw: RwConn) -> Envelope[ImportSummary]:
    await project_gate(conn, p, project_id, "owner")
    data = await read_upload_request(request, max_bytes=MAX_UPLOAD_BYTES)
    # 압축 해제·XML 파싱은 CPU 작업이라 이벤트 루프 밖(스레드 풀)에서 한다(검증 D3).
    rows, tag_headers, warnings = await run_in_threadpool(service.parse_rows, data)
    res = await service.import_rows(rw, project_id, rows, tag_headers, warnings)
    return Envelope[ImportSummary](data=res, meta=crud_meta(surface="project"))
