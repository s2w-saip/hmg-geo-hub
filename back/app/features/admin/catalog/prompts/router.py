"""admin.catalog.prompts 표준 프롬프트 CRUD 라우터. 경로는 /v1 접두 포함 전체 경로.

권한: admin 전용(core.auth.require_admin, 현행 requireCatalogEditor = admin 고정) + 메뉴 그룹 admin(require_menu_group, 현행 route-policy
/admin/standards/prompts group admin, 검증 D3). 관리자는 전량을 보므로 데이터 스코프 교집합은 없다.
읽기 = api_ro(요청 공용 커넥션), 쓰기 = api_rw(RwConn, 행위자 GUC). rd(시장 어휘)는 api_ro 로 먼저 읽는다.
{prompt_id} 는 uuid 변환기로 받아 같은 접두의 고정 경로(/prompts/export 등, admin.catalog.bulk)와 겹치지 않게 한다.
"""
from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Request

from app.core import errors
from app.core.auth import require_admin, require_menu_group
from app.core.db import RoConn
from app.core.envelope import Envelope, build_meta, crud_meta
from app.core.errors import ERROR_RESPONSES
from app.core.filters import PgLine
from app.core.write import RwConn
from app.features.admin.catalog.prompts import service as svc
from app.features.admin.catalog.prompts.admin_common import check_values, clean_text
from app.features.admin.catalog.prompts.schemas import (
    LABEL_FIELDS,
    CatalogListData,
    CatalogPromptDetail,
    CreatePromptBody,
    Kind,
    KindBody,
    LabelsBody,
    PromptWriteResult,
    RegionsBody,
    TextBody,
)
from app.features.catalog.prompts.catalog.screen import CatalogScreenPage, CatalogScreenQuery, catalog_screen

router = APIRouter(tags=["admin.catalog"], dependencies=[require_admin, require_menu_group("admin")],
                   responses=ERROR_RESPONSES)

# 목록이 지원하는 공통 필터 축(app.prompt 열 대응). 그 밖의 공통 축은 meta.ignored_filters.
LIST_AXES = ("brand", "funnel", "brand_presence", "list_type", "depth1", "depth2", "depth3")
ACR_WARNING = "acr_measurement_cost"     # single→acr: 다음 측정부터 2턴 × acr_iterations(기본 10) 측정, 셀당 약 20배


@router.post("/v1/admin/catalog/prompts/screen", response_model=Envelope[CatalogScreenPage])
async def read_admin_screen(ro: RoConn, body: CatalogScreenQuery) -> Envelope[CatalogScreenPage]:
    return Envelope(data=await catalog_screen(ro, None, body, admin=True), meta=crud_meta(mode="admin"))


async def _write_result(rw: RwConn, new: dict, changes: dict, change_ids: list[int], outbox: int | None, *,
                        warnings: list[str] | None = None) -> PromptWriteResult:
    """쓰기 응답. prompt 의 outbox_pending·outbox_error 는 목록·상세와 같은 술어로 쓰기 트랜잭션 안에서 채운다(검증 D4:
    null 을 false 로 읽는 어댑터가 '대기 없음' 으로 보이지 않게). 변경 없는 요청(applied=false)도 기존 대기 행을 그대로 보인다."""
    pending = bool(change_ids) or outbox is not None
    flags = await svc.outbox_flags(rw, uuid.UUID(str(new["prompt_id"])))
    return PromptWriteResult(prompt=svc.to_model({**new, **flags}), change_id=change_ids[0] if change_ids else None,
                             change_ids=change_ids, outbox_id=outbox, propagation="pending" if pending else "none",
                             applied=bool(changes), warnings=warnings or [])


@router.get("/v1/admin/catalog/prompts", summary="표준 루트 카탈로그 목록 + stats, 공통 필터 중 app.prompt 열 대응 축, 키셋",
            response_model=Envelope[CatalogListData])
async def get_admin_catalog_prompts_0(
        request: Request, ro: RoConn,
        q: Annotated[PgLine | None, Query(max_length=200, description="본문 부분일치(ILIKE)")] = None,
        kind: Annotated[Kind | None, Query()] = None,
        include_deleted: Annotated[bool, Query()] = False,
        brand: Annotated[list[str], Query(max_length=20, description="카탈로그 소속 브랜드(brand_code)")] = [],  # noqa: B006
        funnel: Annotated[list[str], Query(max_length=100)] = [],  # noqa: B006
        brand_presence: Annotated[list[str], Query(max_length=10)] = [],  # noqa: B006
        list_type: Annotated[list[str], Query(max_length=100)] = [],  # noqa: B006
        depth1: Annotated[list[str], Query(max_length=200)] = [],  # noqa: B006
        depth2: Annotated[list[str], Query(max_length=200)] = [],  # noqa: B006
        depth3: Annotated[list[str], Query(max_length=200)] = [],  # noqa: B006
        cursor: Annotated[str | None, Query(max_length=4096)] = None,
        limit: Annotated[int | None, Query(description="기본 100, 최대 500")] = None,
) -> Envelope[CatalogListData]:
    axes = {"brand": brand, "funnel": funnel, "brand_presence": brand_presence, "list_type": list_type,
            "depth1": depth1, "depth2": depth2, "depth3": depth3}
    for k, v in axes.items():
        check_values(k, v)
    qt = clean_text(q, field="q", max_len=200)
    data, page = await svc.list_catalog(ro, q_text=qt, kind=kind, include_deleted=include_deleted, axes=axes, cursor=cursor, limit=limit)
    return Envelope[CatalogListData](data=data, meta=crud_meta(request.query_params, mode="admin", page=page, support=LIST_AXES))


@router.post("/v1/admin/catalog/prompts", status_code=201,
             summary="카탈로그 프롬프트 생성: app.prompt INSERT + outbox(prompt,create). prompt_audit_log·judgment_change 는 tg_catalog_change 트리거",
             response_model=Envelope[PromptWriteResult])
async def post_admin_catalog_prompts_1(body: CreatePromptBody, ro: RoConn, rw: RwConn) -> Envelope[PromptWriteResult]:
    text = svc.text_or_422(body.text)
    labels = svc.clean_labels(body.model_dump(), LABEL_FIELDS)
    svc.labels_or_422(labels, await svc.known_brands(ro))
    _, vocab = await svc.root_dim(ro)
    regions = svc.regions_or_422(body.regions, vocab)
    lang = svc.lang_or_422(body.lang)
    root = await svc.root_project_id(rw)
    row, outbox = await svc.create(rw, root=root, text=text, labels=labels, kind=body.kind, lang=lang, regions=regions)
    ids = await svc.tx_change_ids(rw, row["prompt_id"])
    res = await _write_result(rw, row, {"text": {"old": None, "new": text}}, ids, outbox)
    return Envelope[PromptWriteResult](data=res, meta=build_meta(mode="crud"))


@router.get("/v1/admin/catalog/prompts/{prompt_id:uuid}", summary="단건 상세 + 대기 중 변경 요청",
            response_model=Envelope[CatalogPromptDetail])
async def get_admin_catalog_prompts_by_id_2(prompt_id: uuid.UUID, ro: RoConn) -> Envelope[CatalogPromptDetail]:
    return Envelope[CatalogPromptDetail](data=await svc.detail(ro, prompt_id), meta=build_meta(mode="admin"))


@router.patch("/v1/admin/catalog/prompts/{prompt_id:uuid}/text", summary="본문 수정 + outbox", response_model=Envelope[PromptWriteResult])
async def patch_admin_catalog_prompts_by_id_text_3(prompt_id: uuid.UUID, body: TextBody, rw: RwConn) -> Envelope[PromptWriteResult]:
    text = svc.text_or_422(body.text)
    root = await svc.root_project_id(rw)
    new, _, changes, outbox = await svc.apply_patch(rw, root=root, prompt_id=prompt_id, patch={"text": text})
    ids = await svc.tx_change_ids(rw, prompt_id) if changes else []
    return Envelope[PromptWriteResult](data=await _write_result(rw, new, changes, ids, outbox), meta=build_meta(mode="crud"))


@router.patch("/v1/admin/catalog/prompts/{prompt_id:uuid}/labels", summary="택소노미 라벨 수정(트리거가 judgment_change catalog)",
              response_model=Envelope[PromptWriteResult])
async def patch_admin_catalog_prompts_by_id_labels_4(prompt_id: uuid.UUID, body: LabelsBody, ro: RoConn, rw: RwConn
                                                     ) -> Envelope[PromptWriteResult]:
    fields = [f for f in LABEL_FIELDS if f in body.model_fields_set]
    if not fields:
        raise errors.unprocessable("바꿀 라벨이 없다", details={"field": "body"})
    labels = svc.clean_labels(body.model_dump(), fields)
    svc.labels_or_422(labels, await svc.known_brands(ro))
    root = await svc.root_project_id(rw)
    new, _, changes, outbox = await svc.apply_patch(rw, root=root, prompt_id=prompt_id, patch=labels)
    ids = await svc.tx_change_ids(rw, prompt_id) if changes else []
    return Envelope[PromptWriteResult](data=await _write_result(rw, new, changes, ids, outbox), meta=build_meta(mode="crud"))


@router.patch("/v1/admin/catalog/prompts/{prompt_id:uuid}/regions",
              summary="시장·언어 수정 + outbox. 어휘 = rd.dim_project.regions(제안 채택)", response_model=Envelope[PromptWriteResult])
async def patch_admin_catalog_prompts_by_id_regions_5(prompt_id: uuid.UUID, body: RegionsBody, ro: RoConn, rw: RwConn
                                                      ) -> Envelope[PromptWriteResult]:
    given = body.model_fields_set & {"regions", "lang"}
    if not given:
        raise errors.unprocessable("regions·lang 중 하나는 필요", details={"field": "body"})
    patch: dict = {}
    if "regions" in given:
        _, vocab = await svc.root_dim(ro)
        patch["regions"] = svc.regions_or_422(body.regions, vocab)
    if "lang" in given:
        patch["lang"] = svc.lang_or_422(body.lang)
    root = await svc.root_project_id(rw)
    new, _, changes, outbox = await svc.apply_patch(rw, root=root, prompt_id=prompt_id, patch=patch)
    ids = await svc.tx_change_ids(rw, prompt_id) if changes else []
    return Envelope[PromptWriteResult](data=await _write_result(rw, new, changes, ids, outbox), meta=build_meta(mode="crud"))


@router.patch("/v1/admin/catalog/prompts/{prompt_id:uuid}/kind", summary="single↔acr 전환(트리거가 prompt_kind) + outbox, dry_run",
              response_model=Envelope[PromptWriteResult])
async def patch_admin_catalog_prompts_by_id_kind_6(prompt_id: uuid.UUID, body: KindBody, rw: RwConn) -> Envelope[PromptWriteResult]:
    root = await svc.root_project_id(rw)
    warnings = [ACR_WARNING] if body.kind == "acr" else []
    if body.dry_run:
        row = await svc.lock_row(rw, root, prompt_id)
        if row is None:
            raise errors.not_found("카탈로그 행 없음")
        if row["deleted_at"] is not None:
            raise errors.conflict("state_mismatch", "삭제된 행", {"deleted": True})
        changes = svc.diff(row, {"kind": body.kind})
        res = await _write_result(rw, row, {}, [], None, warnings=warnings if changes else [])
        return Envelope[PromptWriteResult](data=res, meta=build_meta(mode="crud"))
    new, _, changes, outbox = await svc.apply_patch(rw, root=root, prompt_id=prompt_id, patch={"kind": body.kind})
    ids = await svc.tx_change_ids(rw, prompt_id) if changes else []
    return Envelope[PromptWriteResult](data=await _write_result(rw, new, changes, ids, outbox, warnings=warnings if changes else []),
                                       meta=build_meta(mode="crud"))


@router.delete("/v1/admin/catalog/prompts/{prompt_id:uuid}", summary="소프트삭제 + outbox", response_model=Envelope[PromptWriteResult])
async def delete_admin_catalog_prompts_by_id_7(prompt_id: uuid.UUID, rw: RwConn) -> Envelope[PromptWriteResult]:
    root = await svc.root_project_id(rw)
    new, _, changes, outbox = await svc.apply_patch(rw, root=root, prompt_id=prompt_id, patch={}, deleted_at="delete")
    ids = await svc.tx_change_ids(rw, prompt_id)
    return Envelope[PromptWriteResult](data=await _write_result(rw, new, changes, ids, outbox), meta=build_meta(mode="crud"))


@router.post("/v1/admin/catalog/prompts/{prompt_id:uuid}/restore", summary="복원 + outbox", response_model=Envelope[PromptWriteResult])
async def post_admin_catalog_prompts_by_id_restore_8(prompt_id: uuid.UUID, rw: RwConn) -> Envelope[PromptWriteResult]:
    root = await svc.root_project_id(rw)
    new, _, changes, outbox = await svc.apply_patch(rw, root=root, prompt_id=prompt_id, patch={}, deleted_at="restore")
    ids = await svc.tx_change_ids(rw, prompt_id)
    return Envelope[PromptWriteResult](data=await _write_result(rw, new, changes, ids, outbox), meta=build_meta(mode="crud"))
