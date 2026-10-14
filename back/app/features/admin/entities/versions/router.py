"""admin.entities.versions 엔티티 버전 관리 라우터(E6). 경로는 /v1 접두 포함 전체 경로. 전 엔드포인트 admin 전용 + 메뉴 admin.

읽기(api_ro): 버전 목록·상세·비교, 반영 목록·상세(미리보기 결과 포함), 검토 대기함, 감사, 언급 표본(기간을 주면 admin_long).
  선택 파라미터(기본값 = 종전 응답): 목록 view=gate(활성·초안 번호만), 상세 view=lint(요약·지문·린트만), 초안 생성·수정 return=minimal(요약만).
쓰기(api_rw, 같은 트랜잭션 감사 app.ecat_audit_log): 초안 생성·수정·폐기, 초안 엔티티·표면 편집, 린트·L2 확인, 반영 요청(범위 선택)·
재미리보기·승인·거절·재개·포기·되돌리기, 검토 대기함 처리. 업무 규칙과 오류 코드는 service 머리 주석.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Path, Query

from app.core.auth import CurrentUser, require_admin, require_menu_group
from app.core.codes import Surface
from app.core.db import RoConn
from app.core.envelope import Envelope, build_meta
from app.core.errors import ERROR_RESPONSES, ERROR_RESPONSES_EXTRA
from app.core.filters import PgLine
from app.core.write import RwConn, access_audit
from app.features.admin.entities.versions import service as svc
from app.features.admin.entities.versions.schemas import (
    ApplyCreateBody,
    ApplyDetail,
    ApplyList,
    ApplyStatus,
    DraftCreateBody,
    DraftPatchBody,
    DraftWrite,
    EcatAuditList,
    EntityBody,
    EntityWrite,
    HubEntityBody,
    LintAckBody,
    LintState,
    MentionSamples,
    OptionalReasonBody,
    ReasonBody,
    ReviewDecision,
    ReviewDecisionBody,
    ReviewKind,
    ReviewList,
    ReviewStatus,
    SurfaceBody,
    SurfaceWrite,
    VersionDetail,
    VersionDiff,
    VersionList,
    VersionStatus,
)

router = APIRouter(tags=["admin.entities"], dependencies=[require_admin, require_menu_group("admin")],
                   responses={**ERROR_RESPONSES, **ERROR_RESPONSES_EXTRA})

V = "/v1/admin/entities/versions"
A = "/v1/admin/entities/applies"
R = "/v1/admin/entities/review"
Ver = Annotated[int, Path(ge=1, le=2_147_483_647)]
ApplyId = Annotated[int, Path(ge=1, le=9_223_372_036_854_775_807)]
Limit = Annotated[int, Query(ge=1, le=500, description="기본 100, 최대 500")]
WriteReturn = Annotated[Literal["full", "minimal"], Query(alias="return", description=(
    "full(기본) = 종전 버전 상세 전체. minimal = 버전 요약(version)만: content_md5·lint = null, entities·surfaces = [](화면이 번호만 쓰고 다시 읽을 때)"))]


# ── 버전 ──
@router.get(V, summary="엔티티 버전 목록(최신순) + 활성·초안 번호. 버전마다 덮어쓰기 행 수·표면 수·최근 반영", response_model=Envelope[VersionList])
async def get_versions(ro: RoConn, status: Annotated[VersionStatus | None, Query()] = None, limit: Limit = 100,
                       view: Annotated[Literal["full", "gate"], Query(description=(
                           "full(기본) = 종전 목록. gate = 활성·초안 번호만(items = [], status·limit 무시): 하위 화면 게이트 용도"))] = "full",
                       ) -> Envelope[VersionList]:
    items, active, draft = await svc.list_versions(ro, status=status, limit=limit, gate=view == "gate")
    return Envelope[VersionList](data=VersionList(items=items, active_ver=active, draft_ver=draft), meta=build_meta(mode="admin"))


@router.post(V, summary="초안 생성(활성 버전 복사). 초안이 있으면 409 ECAT_DRAFT_EXISTS, 활성 없음(v1 이관 전) 409 ECAT_NO_ACTIVE",
             response_model=Envelope[VersionDetail])
async def post_versions(body: DraftCreateBody, ro: RoConn, rw: RwConn, return_: WriteReturn = "full") -> Envelope[VersionDetail]:
    data = await svc.create_draft(ro, rw, title=body.title, reason=body.reason, minimal=return_ == "minimal")
    return Envelope[VersionDetail](data=data, meta=build_meta(mode="crud"))


@router.get(V + "/{ver}", summary="버전 상세: 덮어쓰기 엔티티(관측 대표 표기·표시 브랜드 포함)·켠 표면·마지막 린트(낡음 표시)·내용 지문",
            response_model=Envelope[VersionDetail])
async def get_version(ver: Ver, ro: RoConn,
                      view: Annotated[Literal["full", "lint"], Query(description=(
                          "full(기본) = 종전 상세. lint = 버전 요약·content_md5·lint 만(값은 full 과 같다), entities·surfaces = [](반영 상세 화면 보조)"))] = "full",
                      ) -> Envelope[VersionDetail]:
    data = await (svc.version_lint(ro, ver) if view == "lint" else svc.version_detail(ro, ver))
    return Envelope[VersionDetail](data=data, meta=build_meta(mode="admin"))


@router.patch(V + "/{ver}", summary="초안 제목·사유 수정(초안만, 409 ECAT_VERSION_STATE)", response_model=Envelope[VersionDetail])
async def patch_version(ver: Ver, body: DraftPatchBody, ro: RoConn, rw: RwConn, return_: WriteReturn = "full") -> Envelope[VersionDetail]:
    data = await svc.patch_draft(ro, rw, ver, title=body.title, reason=body.reason, fields=set(body.model_fields_set),
                                 minimal=return_ == "minimal")
    return Envelope[VersionDetail](data=data, meta=build_meta(mode="crud"))


@router.post(V + "/{ver}/discard", summary="초안 폐기(status discarded, 내용 보존). 그 초안의 열린 반영 요청은 rejected",
             response_model=Envelope[DraftWrite])
async def post_version_discard(ver: Ver, body: OptionalReasonBody, rw: RwConn) -> Envelope[DraftWrite]:
    return Envelope[DraftWrite](data=await svc.discard_draft(rw, ver, reason=body.reason), meta=build_meta(mode="crud"))


@router.get(V + "/{ver}/diff", summary="두 버전 차이(엔티티 행·표면). against 생략 = based_on", response_model=Envelope[VersionDiff])
async def get_version_diff(ver: Ver, ro: RoConn,
                           against: Annotated[int | None, Query(ge=1, le=2_147_483_647, description="비교 기준 버전")] = None
                           ) -> Envelope[VersionDiff]:
    return Envelope[VersionDiff](data=await svc.version_diff(ro, ver, against), meta=build_meta(mode="admin"))


@router.put(V + "/{ver}/entities/{entity_id}",
            summary="초안 엔티티 덮어쓰기(역할 own·competitor·hidden·removed, 병합·모 브랜드·메모). 기본값(경쟁·병합 없음)이면 행 삭제. "
                    "사슬 422 ECAT_MERGE_CHAIN", response_model=Envelope[EntityWrite])
async def put_version_entity(ver: Ver, entity_id: uuid.UUID, body: EntityBody, ro: RoConn, rw: RwConn) -> Envelope[EntityWrite]:
    return Envelope[EntityWrite](data=await svc.put_entity(ro, rw, ver, entity_id, body), meta=build_meta(mode="crud"))


@router.post(V + "/{ver}/entities", summary="허브 엔티티 추가(Scope 가 못 잡은 엔티티, 허브 발급 uuid, origin hub)",
             response_model=Envelope[EntityWrite])
async def post_version_entity(ver: Ver, body: HubEntityBody, ro: RoConn, rw: RwConn) -> Envelope[EntityWrite]:
    return Envelope[EntityWrite](data=await svc.create_hub_entity(ro, rw, ver, body), meta=build_meta(mode="crud"))


@router.delete(V + "/{ver}/entities/{entity_id}", summary="초안 엔티티 덮어쓰기 행 삭제(= Scope 기본값 복귀). 허브 엔티티가 참조되면 409 ECAT_ENTITY_IN_USE",
               response_model=Envelope[EntityWrite])
async def delete_version_entity(ver: Ver, entity_id: uuid.UUID, rw: RwConn) -> Envelope[EntityWrite]:
    return Envelope[EntityWrite](data=await svc.delete_entity(rw, ver, entity_id), meta=build_meta(mode="crud"))


@router.post(V + "/{ver}/surfaces", summary="초안 표면 켜기: add(저장 본문 재매칭, 엔티티 필수) · block(엔티티 한정 또는 전역). 정의는 재사용(불변)",
             response_model=Envelope[SurfaceWrite])
async def post_version_surface(ver: Ver, body: SurfaceBody, ro: RoConn, rw: RwConn) -> Envelope[SurfaceWrite]:
    return Envelope[SurfaceWrite](data=await svc.add_surface(ro, rw, ver, body), meta=build_meta(mode="crud"))


@router.delete(V + "/{ver}/surfaces/{surface_id}", summary="초안 표면 끄기", response_model=Envelope[SurfaceWrite])
async def delete_version_surface(ver: Ver, surface_id: Annotated[int, Path(ge=1, le=2_147_483_647)], rw: RwConn) -> Envelope[SurfaceWrite]:
    return Envelope[SurfaceWrite](data=await svc.remove_surface(rw, ver, surface_id), meta=build_meta(mode="crud"))


@router.post(V + "/{ver}/lint", summary="초안 린트(L1 차단·L2 확인·L3 구조) 실행·저장. 확인 키는 여전히 L2 인 것만 유지", response_model=Envelope[LintState])
async def post_version_lint(ver: Ver, p: CurrentUser, ro: RoConn, rw: RwConn) -> Envelope[LintState]:
    return Envelope[LintState](data=await svc.lint(ro, rw, ver, p.user_id), meta=build_meta(mode="crud"))


@router.put(V + "/{ver}/lint/acks", summary="L2 확인 저장(키 전체 교체). 린트 뒤 초안이 바뀌었으면 409 ECAT_LINT_STALE", response_model=Envelope[LintState])
async def put_version_lint_acks(ver: Ver, body: LintAckBody, rw: RwConn) -> Envelope[LintState]:
    return Envelope[LintState](data=await svc.ack_lint(rw, ver, list(body.keys)), meta=build_meta(mode="crud"))


# ── 반영 ──
@router.get(A, summary="반영 요청 목록(최신순, 미리보기 본문 제외)", response_model=Envelope[ApplyList])
async def get_applies(ro: RoConn, status: Annotated[ApplyStatus | None, Query()] = None,
                      ver: Annotated[int | None, Query(ge=1, le=2_147_483_647)] = None,
                      before_id: Annotated[int | None, Query(ge=1, description="이 apply_id 보다 작은 것(다음 페이지)")] = None,
                      limit: Limit = 100) -> Envelope[ApplyList]:
    items = await svc.list_applies(ro, status=status, ver=ver, before=before_id, limit=limit)
    return Envelope[ApplyList](data=ApplyList(items=items), meta=build_meta(mode="admin"))


@router.post(A, summary="반영 요청(범위 unexposed|from_round|all 선택, 사유 필수) = 미리보기 큐 투입. L1·L3 422 ECAT_LINT_BLOCKED, "
                        "미확인 L2 422 ECAT_LINT_UNACKED, 진행 중 반영 409 ECAT_APPLY_RUNNING", response_model=Envelope[ApplyDetail])
async def post_applies(body: ApplyCreateBody, p: CurrentUser, ro: RoConn, rw: RwConn) -> Envelope[ApplyDetail]:
    return Envelope[ApplyDetail](data=await svc.request_apply(ro, rw, body, p.user_id), meta=build_meta(mode="crud"))


@router.get(A + "/{apply_id}", summary="반영 상세: 상태·오류 코드·미리보기 결과(회차×국가×엔진 KPI 전후·브랜드·표본·근사)·큐·가능한 동작",
            response_model=Envelope[ApplyDetail])
async def get_apply(apply_id: ApplyId, p: CurrentUser, ro: RoConn) -> Envelope[ApplyDetail]:
    return Envelope[ApplyDetail](data=await svc.apply_detail(ro, apply_id, p.user_id, ro=ro), meta=build_meta(mode="admin"))


@router.post(A + "/{apply_id}/preview", summary="다시 미리보기(draft·previewed·approved, 승인은 풀린다)", response_model=Envelope[ApplyDetail])
async def post_apply_preview(apply_id: ApplyId, p: CurrentUser, ro: RoConn, rw: RwConn) -> Envelope[ApplyDetail]:
    return Envelope[ApplyDetail](data=await svc.re_preview(ro, rw, apply_id, p.user_id), meta=build_meta(mode="crud"))


@router.post(A + "/{apply_id}/approve",
             summary="승인(previewed → approved, 반영 큐 투입). 노출 회차 포함이면 승인자 외 403 ECAT_EXPOSED_REQUIRES_APPROVAL, 낡은 미리보기 409 ECAT_PREVIEW_STALE",
             response_model=Envelope[ApplyDetail])
async def post_apply_approve(apply_id: ApplyId, body: OptionalReasonBody, p: CurrentUser, rw: RwConn) -> Envelope[ApplyDetail]:
    return Envelope[ApplyDetail](data=await svc.approve(rw, apply_id, p.user_id, note=body.reason), meta=build_meta(mode="crud"))


@router.post(A + "/{apply_id}/reject", summary="거절(draft·previewed·approved → rejected, 사유 필수)", response_model=Envelope[ApplyDetail])
async def post_apply_reject(apply_id: ApplyId, body: ReasonBody, p: CurrentUser, rw: RwConn) -> Envelope[ApplyDetail]:
    return Envelope[ApplyDetail](data=await svc.reject(rw, apply_id, p.user_id, reason=body.reason), meta=build_meta(mode="crud"))


@router.post(A + "/{apply_id}/resume", summary="재개(failed → op resume, 첫 청크 실패로 멈춘 approved → op apply)", response_model=Envelope[ApplyDetail])
async def post_apply_resume(apply_id: ApplyId, p: CurrentUser, rw: RwConn) -> Envelope[ApplyDetail]:
    return Envelope[ApplyDetail](data=await svc.resume(rw, apply_id, p.user_id), meta=build_meta(mode="crud"))


@router.post(A + "/{apply_id}/abandon",
             summary="포기(failed → op abandon: 범위 회차를 반영 전 버전으로 되돌려 투영한 뒤 rejected, 활성 버전은 그대로). 사유 필수",
             response_model=Envelope[ApplyDetail])
async def post_apply_abandon(apply_id: ApplyId, body: ReasonBody, p: CurrentUser, ro: RoConn, rw: RwConn) -> Envelope[ApplyDetail]:
    return Envelope[ApplyDetail](data=await svc.abandon(ro, rw, apply_id, p.user_id, reason=body.reason), meta=build_meta(mode="crud"))


@router.post(A + "/{apply_id}/rollback",
             summary="되돌리기: applied 반영의 이전 버전 내용으로 origin rollback 초안 + 같은 범위 반영 요청(미리보기 자동). 초안 있으면 409 ECAT_DRAFT_EXISTS",
             response_model=Envelope[ApplyDetail])
async def post_apply_rollback(apply_id: ApplyId, body: ReasonBody, p: CurrentUser, ro: RoConn, rw: RwConn) -> Envelope[ApplyDetail]:
    return Envelope[ApplyDetail](data=await svc.rollback(ro, rw, apply_id, p.user_id, reason=body.reason), meta=build_meta(mode="crud"))


# ── 검토 대기함 ──
@router.get(R, summary="검토 대기함(Scope 새 엔티티·새 표면, 최신순). 기본 status pending", response_model=Envelope[ReviewList])
async def get_review(ro: RoConn, status: Annotated[ReviewStatus | Literal["all"], Query(description="all = 전체")] = "pending",
                     kind: Annotated[ReviewKind | None, Query()] = None,
                     q: Annotated[PgLine | None, Query(max_length=200, description="표시명·표면 부분일치")] = None,
                     before_id: Annotated[int | None, Query(ge=1)] = None, limit: Limit = 100) -> Envelope[ReviewList]:
    items = await svc.list_reviews(ro, status=None if status == "all" else status, kind=kind, q_text=(q or "").strip() or None, before=before_id, limit=limit)
    return Envelope[ReviewList](data=ReviewList(items=items), meta=build_meta(mode="admin"))


@router.post(R + "/{review_id}/decision", summary="검토 처리: register(초안에 엔티티 역할·병합 또는 표면 block/add) · dismiss(무시)",
             response_model=Envelope[ReviewDecision])
async def post_review_decision(review_id: ApplyId, body: ReviewDecisionBody, ro: RoConn, rw: RwConn) -> Envelope[ReviewDecision]:
    return Envelope[ReviewDecision](data=await svc.decide_review(ro, rw, review_id, body), meta=build_meta(mode="crud"))


# ── 감사·표본 ──
@router.get("/v1/admin/entities/audit", summary="엔티티 버전 관리 감사(app.ecat_audit_log, 최신순)", response_model=Envelope[EcatAuditList])
async def get_entities_audit(ro: RoConn, ver: Annotated[int | None, Query(ge=1, le=2_147_483_647)] = None,
                             apply_id: Annotated[int | None, Query(ge=1)] = None, before_id: Annotated[int | None, Query(ge=1)] = None,
                             limit: Limit = 100) -> Envelope[EcatAuditList]:
    items = await svc.list_audit(ro, ver=ver, apply_id=apply_id, before=before_id, limit=limit)
    return Envelope[EcatAuditList](data=EcatAuditList(items=items), meta=build_meta(mode="audit"))


@router.get("/v1/admin/entities/{entity_id}/mentions",
            summary="엔티티 언급 표본 문맥(최근 답변 우선, 발생 행 문맥 또는 저장 본문 창). surface_text 로 표면 한정. 기간 지정 시 admin_long",
            response_model=Envelope[MentionSamples])
async def get_entity_mentions(entity_id: uuid.UUID, p: CurrentUser, ro: RoConn,
                              surface: Annotated[Surface, Query(description="global|website|project")],
                              date_from: Annotated[date | None, Query(alias="from")] = None,
                              date_to: Annotated[date | None, Query(alias="to")] = None,
                              surface_text: Annotated[PgLine | None, Query(max_length=200, description="이 표면(정규형 동치)만")] = None,
                              limit: Annotated[int, Query(ge=1, le=50)] = 20) -> Envelope[MentionSamples]:
    data, win, pool = await svc.mention_samples(ro, entity_id=entity_id, surface=surface, date_from=date_from, date_to=date_to,
                                                surface_text=surface_text, limit=limit)
    access_audit(p, "data_access", "admin.entities.mentions", target=str(entity_id), detail={"surface": surface, "n": len(data.items)})
    meta = build_meta(mode="admin", surface=surface, window=win, source={"pool": pool, "grain": "sample"})
    return Envelope[MentionSamples](data=data, meta=meta)
