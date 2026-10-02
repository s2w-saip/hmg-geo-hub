"""projects.settings.tracked_urls 추적 URL 라우터. 경로는 /v1 접두 포함 전체 경로."""
import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import StreamingResponse

from app.core.auth import CurrentUser
from app.core.db import RoConn
from app.core.envelope import Envelope, Page, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.export import xlsx_response
from app.core.filters import PgLine
from app.core.upload import UPLOAD_RESPONSES, XLSX_MIME, read_upload_request
from app.core.write import RwConn, access_audit
from app.features.projects.project.core.shared import CRUD_CONSUMED, project_access
from app.features.projects.settings.tracked_urls import service as S
from app.features.projects.settings.tracked_urls.schemas import TrackedUrlCreate, TrackedUrlImport, TrackedUrlList, TrackedUrlWrite

router = APIRouter(tags=["projects.settings"], responses=ERROR_RESPONSES)
XLSX = XLSX_MIME
_IMPORT_BODY = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {"schema": {"type": "object", "required": ["file"],
                                               "properties": {"file": {"type": "string", "format": "binary"}}}},
            XLSX: {"schema": {"type": "string", "format": "binary"}},     # 하위 호환: 본문 = xlsx 원본 바이트
        },
    }
}


@router.get("/v1/projects/{project_id}/settings/tracked-urls", response_model=Envelope[TrackedUrlList], summary="추적 URL 목록(키셋)")
async def get_projects_by_id_settings_tracked_urls_0(project_id: uuid.UUID, request: Request, p: CurrentUser, ro: RoConn,
                                                     cursor: str | None = Query(None, max_length=4096),
                                                     limit: int | None = Query(None, ge=1, le=500)) -> Envelope[TrackedUrlList]:
    items, nxt, lim, total = await S.list_urls(ro, p, project_id, cursor, limit)
    return Envelope[TrackedUrlList](data=TrackedUrlList(items=items, next_cursor=nxt, total=total),
                                    meta=crud_meta(request.query_params, surface="project", consumed=CRUD_CONSUMED, page=Page(next_cursor=nxt, limit=lim, total=total)))


@router.post("/v1/projects/{project_id}/settings/tracked-urls", status_code=201, response_model=Envelope[TrackedUrlWrite],
             summary="추적 URL 추가 + judgment_change(project_target_url)")
async def post_projects_by_id_settings_tracked_urls_1(project_id: uuid.UUID, body: TrackedUrlCreate, p: CurrentUser, ro: RoConn,
                                                      rw: RwConn) -> Envelope[TrackedUrlWrite]:
    out = await S.add(ro, rw, p, project_id, body.url, body.label)
    return Envelope[TrackedUrlWrite](data=TrackedUrlWrite(**out), meta=crud_meta(surface="project"))


@router.delete("/v1/projects/{project_id}/settings/tracked-urls", response_model=Envelope[TrackedUrlWrite],
               summary="추적 URL 삭제(?url_norm=)")
async def delete_projects_by_id_settings_tracked_urls_2(project_id: uuid.UUID, p: CurrentUser, ro: RoConn, rw: RwConn,
                                                        url_norm: Annotated[PgLine, Query(min_length=1, max_length=2048)]
                                                        ) -> Envelope[TrackedUrlWrite]:
    out = await S.remove(ro, rw, p, project_id, url_norm)
    return Envelope[TrackedUrlWrite](data=TrackedUrlWrite(**out), meta=crud_meta(surface="project"))


@router.get("/v1/projects/{project_id}/settings/tracked-urls/export", summary="추적 URL xlsx",
            response_class=StreamingResponse, responses={200: {"content": {XLSX: {}}, "description": "xlsx 파일(열: url_norm, url, label)"}})
async def get_projects_by_id_settings_tracked_urls_export_3(project_id: uuid.UUID, p: CurrentUser, ro: RoConn) -> StreamingResponse:
    rows = await S.export_rows(ro, p, project_id)
    access_audit(p, "download", "tracked_urls.export", target=str(project_id), detail={"rows": len(rows)})
    name = f"tracked-urls-{str(project_id)[:8]}-{date.today():%Y%m%d}.xlsx"
    return xlsx_response([S.export_sheet(rows)], filename=name)


@router.post("/v1/projects/{project_id}/settings/tracked-urls/import", response_model=Envelope[TrackedUrlImport],
             summary="추적 URL xlsx 가져오기(multipart file 또는 xlsx 본문) + judgment_change 1건", openapi_extra=_IMPORT_BODY,
             responses=UPLOAD_RESPONSES,
             description=f"업로드 {S.MAX_UPLOAD // S.MiB}MB 초과 413 payload_too_large, 데이터 행 {S.MAX_ROWS}개·형식 오류는 422.")
async def post_projects_by_id_settings_tracked_urls_import_4(project_id: uuid.UUID, request: Request, p: CurrentUser, ro: RoConn,
                                                             rw: RwConn) -> Envelope[TrackedUrlImport]:
    # 권한 판정을 본문(최대 5MB)을 읽기 전에 한다: viewer 403·비멤버 404 는 업로드를 받지 않는다(검증 D7).
    # 그래서 UploadFile 인자(FastAPI 가 핸들러 전에 폼을 읽는다) 대신 판정 뒤 core.upload.read_upload_request 로 읽는다.
    await project_access(ro, p, project_id, "owner")
    data = await read_upload_request(request, max_bytes=S.MAX_UPLOAD)
    out = await S.import_xlsx(ro, rw, p, project_id, data)
    return Envelope[TrackedUrlImport](data=TrackedUrlImport(**out), meta=crud_meta(surface="project"))
