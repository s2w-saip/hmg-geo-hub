"""admin.catalog.bulk 일괄 편집·가져오기·내보내기 라우터. 경로는 /v1 접두 포함 전체 경로. admin 전용.

- import/preview 는 multipart/form-data 의 file 필드(현행 FormData) 또는 하위 호환으로 본문 = xlsx 원본 바이트
  (Content-Type application/vnd.openxmlformats-officedocument.spreadsheetml.sheet 또는 application/octet-stream).
  읽기 = core.upload.read_upload_request(상한 5MB 초과 413, 빈 파일 422 invalid_upload, 그 밖 Content-Type 415).
- export 는 xlsx 파일 응답(봉투 없음, core.export.xlsx_response 스트리밍: Content-Disposition·no-store). 다운로드는 접근 감사(kind=download, Q4).
"""
from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Request
from fastapi.responses import Response

from app.core.auth import CurrentUser, require_admin, require_menu_group
from app.core.db import RoConn
from app.core.envelope import Envelope, build_meta
from app.core.errors import ERROR_RESPONSES
from app.core.export import XLSX_MEDIA, xlsx_response
from app.core.upload import UPLOAD_RESPONSES, read_upload_request
from app.core.write import RwConn, access_audit
from app.features.admin.catalog.bulk import service as svc
from app.features.admin.catalog.bulk.schemas import ApplyBody, ApplyResult, BulkRegionsBody, BulkRegionsResult, PreviewData
from app.features.admin.catalog.prompts import service as ps

router = APIRouter(tags=["admin.catalog"], dependencies=[require_admin, require_menu_group("admin")],
                   responses=ERROR_RESPONSES)
_BINARY = {"schema": {"type": "string", "format": "binary"}}
_XLSX_BODY = {"requestBody": {"required": True, "content": {
    "multipart/form-data": {"schema": {"type": "object", "required": ["file"], "properties": {"file": {"type": "string", "format": "binary"}}}},
    XLSX_MEDIA: _BINARY, "application/octet-stream": _BINARY}}}


@router.post("/v1/admin/catalog/prompts/bulk/regions", summary="시장 일괄 설정(행마다 SAVEPOINT, batch_id GUC)",
             response_model=Envelope[BulkRegionsResult])
async def post_admin_catalog_prompts_bulk_regions_0(body: BulkRegionsBody, ro: RoConn, rw: RwConn) -> Envelope[BulkRegionsResult]:
    _, vocab = await ps.root_dim(ro)
    root = await ps.root_project_id(rw)
    res = await svc.bulk_regions(rw, root=root, ids=body.prompt_ids, regions=body.regions, vocab=vocab)
    return Envelope[BulkRegionsResult](data=res, meta=build_meta(mode="crud"))


@router.post("/v1/admin/catalog/prompts/import/preview", summary="엑셀 파싱 → 행별 diff(쓰기 없음). multipart file 또는 xlsx 본문",
             response_model=Envelope[PreviewData], openapi_extra=_XLSX_BODY, responses=UPLOAD_RESPONSES)
async def post_admin_catalog_prompts_import_preview_1(request: Request, ro: RoConn) -> Envelope[PreviewData]:
    data = await read_upload_request(request, max_bytes=svc.MAX_UPLOAD)
    return Envelope[PreviewData](data=await svc.preview(ro, data), meta=build_meta(mode="crud"))


@router.post("/v1/admin/catalog/prompts/bulk/apply", summary="diff 적용(요청당 200건, 행마다 SAVEPOINT 부분 성공)",
             response_model=Envelope[ApplyResult])
async def post_admin_catalog_prompts_bulk_apply_2(body: ApplyBody, ro: RoConn, rw: RwConn) -> Envelope[ApplyResult]:
    _, vocab = await ps.root_dim(ro)
    brands = await ps.known_brands(ro)
    root = await ps.root_project_id(rw)
    res = await svc.apply_items(rw, root=root, batch_id=body.batch_id, items=body.items, brands=brands, vocab=vocab)
    return Envelope[ApplyResult](data=res, meta=build_meta(mode="crud"))


@router.get("/v1/admin/catalog/prompts/export", summary="카탈로그 xlsx", response_class=Response,
            responses={200: {"content": {XLSX_MEDIA: {}}, "description": "xlsx 파일(삭제 행 제외)"}})
async def get_admin_catalog_prompts_export_3(ro: RoConn, p: CurrentUser) -> Response:
    sheet, n = await svc.export_sheet(ro)
    stamp = datetime.now(UTC).strftime("%Y%m%d")
    access_audit(p, "download", "admin.catalog.export", target="standard_root", detail={"rows": n})
    return xlsx_response([sheet], filename=f"global-catalog-{stamp}.xlsx")
