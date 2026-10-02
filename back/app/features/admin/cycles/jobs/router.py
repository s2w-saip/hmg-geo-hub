"""admin.cycles.jobs 측정 앵커 고정·드롭 라우터. 경로는 /v1 접두 포함 전체 경로.

모든 엔드포인트: 인증 + role=admin + 메뉴 그룹 admin. 대상 확인은 api_ro, 요청 기록은 api_rw. 요청을 남기면 202, dry_run 이면 200.
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Path, Response

from app.core.auth import CurrentUser, require_admin, require_menu_group
from app.core.db import RoConn
from app.core.envelope import Envelope, build_meta
from app.core.errors import ERROR_RESPONSES
from app.core.write import RwConn

from . import service
from .schemas import AnchorPinBody, DropBody, JobRegistry, JobRequestResult

router = APIRouter(tags=["admin.cycles"], dependencies=[require_admin, require_menu_group("admin")], responses=ERROR_RESPONSES)

JobId = Annotated[uuid.UUID, Path(description="Scope job_id")]


def _written(res: JobRequestResult, response: Response) -> Envelope[JobRequestResult]:
    response.status_code = 200 if res.dry_run else 202
    return Envelope[JobRequestResult](data=res, meta=build_meta(mode="admin", surface=res.current.surface))


@router.get("/v1/admin/jobs/{job_id}/registry", summary="앵커 고정·드롭 사유(rd.v_answer_registry)")
async def get_admin_jobs_by_id_registry_0(p: CurrentUser, conn: RoConn, job_id: JobId) -> Envelope[JobRegistry]:
    reg = await service.get_registry(conn, job_id)
    return Envelope[JobRegistry](data=reg, meta=build_meta(mode="admin", surface=reg.surface))


@router.post("/v1/admin/jobs/{job_id}/anchor-pin", status_code=202, summary="앵커 고정 요청 judgment_change(anchor_pin)")
async def post_admin_jobs_by_id_anchor_pin_1(p: CurrentUser, conn: RoConn, rw: RwConn, job_id: JobId, body: AnchorPinBody,
                                             response: Response) -> Envelope[JobRequestResult]:
    return _written(await service.anchor_pin(conn, rw, job_id, body), response)


@router.post("/v1/admin/jobs/{job_id}/drop", status_code=202, summary="답변 드롭 요청 judgment_change(answer_drop), confirm 필수")
async def post_admin_jobs_by_id_drop_2(p: CurrentUser, conn: RoConn, rw: RwConn, job_id: JobId, body: DropBody,
                                       response: Response) -> Envelope[JobRequestResult]:
    return _written(await service.drop(conn, rw, job_id, body), response)
