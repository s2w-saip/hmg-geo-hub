"""admin.entities.versions 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.filters import PgLine, PgText

VersionStatus = Literal["draft", "active", "retired", "discarded"]
VersionOrigin = Literal["cutover", "admin", "rollback"]
EcatRole = Literal["own", "competitor", "hidden", "removed"]
SurfaceAction = Literal["add", "block"]
ScopeKind = Literal["unexposed", "from_round", "all"]
ApplyStatus = Literal["draft", "previewed", "approved", "running", "applied", "rejected", "failed", "rolled_back"]
ReviewStatus = Literal["pending", "resolved", "dismissed"]
ReviewKind = Literal["new_entity", "new_surface"]


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ── 버전 ──
class ApplyBrief(BaseModel):
    apply_id: int
    status: ApplyStatus
    scope_kind: ScopeKind
    from_round_date: date | None = None
    requested_at: datetime
    finished_at: datetime | None = None


class VersionSummary(BaseModel):
    ver: int
    status: VersionStatus
    based_on: int | None = None
    title: str
    reason: str | None = None
    origin: VersionOrigin
    created_by: uuid.UUID
    created_at: datetime
    submitted_at: datetime | None = Field(None, description="마지막 반영 요청 시각(초안)")
    activated_at: datetime | None = None
    retired_at: datetime | None = None
    entity_rows: int = Field(description="덮어쓰기 엔티티 행 수(행 없음 = Scope 값·기본 경쟁)")
    surface_rows: int = Field(description="켠 표면 수(add·block)")
    last_apply: ApplyBrief | None = Field(None, description="이 버전의 가장 최근 반영 요청")


class VersionList(BaseModel):
    items: list[VersionSummary]
    active_ver: int | None = Field(None, description="활성 버전(없으면 v1 이관 전: 편집·반영 불가)")
    draft_ver: int | None = Field(None, description="초안(최대 1개, 제품 결정 29)")


class EntityOverride(BaseModel):
    entity_id: uuid.UUID
    origin: Literal["scope", "hub"]
    name: str | None = None
    entity_type: str | None = None
    role: EcatRole
    brand_code: str | None = None
    merge_into: uuid.UUID | None = None
    parent_brand_id: uuid.UUID | None = None
    note: str | None = None
    updated_by: uuid.UUID | None = None
    updated_at: datetime | None = None
    observed: bool = Field(description="rd.dim_entity 에 있는 엔티티(허브 추가 엔티티는 관측 전이면 false)")
    rep_name: str | None = Field(None, description="관측 대표 표기(rd.dim_entity.rep_name)")
    brand_name: str | None = Field(None, description="현재 귀속 표시 브랜드(rd.dim_brand_name, 활성 투영 기준)")
    effective_own_brand: str | None = Field(None, description="이 버전 기준 유효 귀속: 이 엔티티 언급이 집계되는 자사 브랜드(app.brand.brand_code), "
                                                              "자사 아님 = null. lint.RollupRule.entity_own(덮어쓰기·병합·제거는 이 버전, "
                                                              "그 밖은 활성 투영 차원의 표시 브랜드)")


class SurfaceItem(BaseModel):
    surface_id: int
    entity_id: uuid.UUID | None = Field(None, description="null = 전역 차단 표면")
    surface: str
    surface_norm: str = Field(description="정규형(app.core.ecat.text.normalize_surface)")
    lang: str | None = None
    action: SurfaceAction
    created_by: uuid.UUID
    created_at: datetime


class LintFinding(BaseModel):
    level: Literal["L1", "L2", "L3", "INFO"] = Field(description="L1·L3 차단, L2 확인 필요, INFO = 기준 버전에 이미 있던 구조 문제(정보성)")
    code: str
    target: str
    key: str = Field(description="L2 확인 키(code|target|내용 지문: 대상 행·detail 이 바뀌면 달라져 확인이 풀린다)")
    detail: str = ""
    entity_id: str | None = None
    surface_id: int | None = None
    escalate: bool = Field(description="자사(추적) 엔티티 관련: 일괄 확인 불가, 표본 문맥 확인 뒤 항목별 확인")


class LintState(BaseModel):
    blocked: bool = Field(description="L1 또는 L3 있음 → 반영 요청 422 ECAT_LINT_BLOCKED")
    counts: dict[str, int]
    escalated: int
    findings: list[LintFinding]
    acked: list[str] = Field(default_factory=list, description="확인한 L2 키")
    unacked: list[str] = Field(default_factory=list, description="남은 L2 키(있으면 반영 요청 422 ECAT_LINT_UNACKED)")
    content_md5: str | None = Field(None, description="린트 당시 버전 내용 지문")
    stale: bool = Field(False, description="린트 뒤 초안이 바뀜(다시 린트)")
    linted_at: datetime | None = None
    linted_by: uuid.UUID | None = None
    observed_source: str | None = Field(None, description="관측 표면 충돌 판정에 쓴 원천(근사 범위)")


class VersionDetail(BaseModel):
    version: VersionSummary
    content_md5: str | None = Field(None, description="현재 내용 지문(app.ecat_content_md5)")
    entities: list[EntityOverride]
    surfaces: list[SurfaceItem]
    lint: LintState | None = None


class DiffEntity(BaseModel):
    entity_id: uuid.UUID
    change: Literal["added", "removed", "changed"]
    fields: list[str] = Field(default_factory=list, description="changed 일 때 바뀐 열")
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None


class DiffSurface(BaseModel):
    surface_id: int
    entity_id: uuid.UUID | None = None
    surface: str
    change: Literal["added", "removed", "changed"]
    before_action: SurfaceAction | None = None
    after_action: SurfaceAction | None = None


class VersionDiff(BaseModel):
    ver: int
    against: int | None = Field(None, description="비교 기준(기본 = based_on, 없으면 빈 버전)")
    entities: list[DiffEntity]
    surfaces: list[DiffSurface]
    counts: dict[str, int]


class DraftCreateBody(_Body):
    title: PgLine = Field(min_length=1, max_length=200)
    reason: PgText | None = Field(None, max_length=2000)


class DraftPatchBody(_Body):
    title: PgLine | None = Field(None, max_length=200)
    reason: PgText | None = Field(None, max_length=2000)


class EntityBody(_Body):
    role: EcatRole
    brand_code: PgLine | None = Field(None, max_length=100, description="own 필수(app.brand, 엄브렐러 불가)")
    name: PgLine | None = Field(None, max_length=300, description="own·hidden 필수(생략하면 기존 값 또는 관측 대표 표기)")
    entity_type: PgLine | None = Field(None, max_length=100)
    merge_into: uuid.UUID | None = Field(None, description="A → B 접기(자기 자신·사슬 금지)")
    parent_brand_id: uuid.UUID | None = Field(None, description="브랜드 롤업 덮어쓰기")
    note: PgText | None = Field(None, max_length=2000)


class HubEntityBody(_Body):
    name: PgLine = Field(min_length=1, max_length=300)
    entity_type: PgLine = Field("Brand", max_length=100)
    role: EcatRole = "competitor"
    brand_code: PgLine | None = Field(None, max_length=100)
    parent_brand_id: uuid.UUID | None = None
    note: PgText | None = Field(None, max_length=2000)


class SurfaceBody(_Body):
    entity_id: uuid.UUID | None = Field(None, description="null = 전역 차단(block 만)")
    surface: PgLine = Field(min_length=1, max_length=200)
    lang: PgLine | None = Field(None, max_length=16, description="언어 한정(생략 = 전 언어)")
    action: SurfaceAction


class LintAckBody(_Body):
    keys: list[PgLine] = Field(max_length=2000, description="확인할 L2 키 전체(교체)")


class EntityWrite(BaseModel):
    ver: int
    entity: EntityOverride | None = Field(None, description="쓰기 뒤 행(삭제·기본값 복귀면 null)")
    changed: bool
    stale_applies: list[int] = Field(default_factory=list, description="낡음 표시한 열린 미리보기(다시 미리보기 필요)")


class SurfaceWrite(BaseModel):
    ver: int
    surface: SurfaceItem | None = None
    changed: bool
    stale_applies: list[int] = Field(default_factory=list)


class DraftWrite(BaseModel):
    ver: int
    status: VersionStatus
    rejected_applies: list[int] = Field(default_factory=list)


# ── 반영 ──
class QueueItem(BaseModel):
    change_id: int
    op: str | None = None
    status: str
    requested_at: datetime
    applied_at: datetime | None = None
    error: str | None = None


class ApplyItem(BaseModel):
    apply_id: int
    ver: int
    from_ver: int | None = None
    scope_kind: ScopeKind
    from_round_date: date | None = None
    status: ApplyStatus
    requested_by: uuid.UUID
    requested_at: datetime
    approved_by: uuid.UUID | None = None
    approved_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    reason: str
    affected_answers: int | None = None
    cycle_keys: list[int] | None = None
    has_preview: bool
    requires_approval: bool = Field(description="미리보기 결과 범위에 노출(또는 고정) 회차가 있음 → 승인자(app.rule_param ecat_approvers)만 승인")
    error: str | None = None
    error_code: str | None = Field(None, description="error 앞 코드(ECAT_PREVIEW_STALE 등)")


class ApplyList(BaseModel):
    items: list[ApplyItem]


class AbandonCycle(BaseModel):
    cyc_key: int
    round_date: date
    surface: Literal["global", "website", "project"] | None = None
    exposed: bool = Field(description="지금 노출 회차(servable ∧ view_date ≤ 오늘 KST)")
    pin_ver: int = Field(description="포기 뒤(또는 포기 중) 이 회차가 고정되는 버전")


class AbandonPins(BaseModel):
    """포기(abandon)가 범위 회차를 반영 전 버전에 고정한 결과(또는 예정). 고정된 회차는 이후 unexposed 반영 대상에서 빠지고,
    그 회차를 범위에 넣는 반영은 승인자 승인이 필요하다(적재기 범위 술어: 고정 = 노출과 같게 취급)."""
    state: Literal["planned", "abandoning", "abandoned"] = Field(description="planned = 포기 전 예정(pins_before 기준), 그 밖 = rd.cycle 실측")
    new_ver: int = Field(description="이 반영의 새 버전(활성으로 남는다)")
    active_ver: int | None = None
    cycles: list[AbandonCycle] = Field(default_factory=list, description="고정되는(된) 회차, cyc_key 순")
    unexposed: int = Field(0, description="그중 노출 전 회차 수(이후 unexposed 반영에서 빠진다)")
    requires_approval_later: bool = Field(description="이 회차들을 범위에 넣는 반영은 승인자 승인이 필요하다")


class ApplyDetail(ApplyItem):
    preview: dict[str, Any] | None = Field(None, description="적재기 E4 미리보기(ecat_engine.compute_preview 모양, v=1)")
    queue: list[QueueItem] = Field(default_factory=list, description="이 반영의 큐 요청(최신순 20)")
    can_approve: bool = Field(description="지금 이 사용자가 승인할 수 있는가(상태·낡음·승인자 판정)")
    approver_required: bool = Field(description="승인자 목록에 있어야 승인 가능(노출 회차 포함)")
    actions: list[str] = Field(default_factory=list, description="가능한 동작(preview·approve·reject·resume·abandon·rollback)")
    abandon_pins: AbandonPins | None = Field(None, description="포기 가능(failed)·포기 중·포기로 닫힌 반영의 회차 고정(상세 GET·포기 응답에만)")


class ApplyCreateBody(_Body):
    ver: int | None = Field(None, ge=1, description="반영할 버전(생략 = 초안). 활성 버전을 주면 범위 확장")
    scope_kind: ScopeKind
    from_round_date: date | None = Field(None, description="from_round 필수(그 round_date 이후), 그 밖은 생략")
    reason: PgText = Field(min_length=1, max_length=2000)


class ReasonBody(_Body):
    reason: PgText = Field(min_length=1, max_length=2000)


class OptionalReasonBody(_Body):
    reason: PgText | None = Field(None, max_length=2000)


# ── 검토 대기함 ──
class ReviewItem(BaseModel):
    review_id: int
    kind: ReviewKind
    entity_id: uuid.UUID
    surface: str | None = None
    surface_norm: str | None = None
    display_name: str | None = None
    entity_type: str | None = None
    first_seen_at: datetime
    last_seen_at: datetime
    n_mentions: int
    n_answers: int
    status: ReviewStatus
    resolved_ver: int | None = None
    decided_by: uuid.UUID | None = None
    decided_at: datetime | None = None
    note: str | None = None
    alert_grade: int | None = None


class ReviewList(BaseModel):
    items: list[ReviewItem]


class ReviewDecisionBody(_Body):
    action: Literal["register", "dismiss"] = Field(description="register = 초안에 반영(엔티티 역할·병합 또는 표면 add/block), dismiss = 무시")
    role: EcatRole | None = Field(None, description="new_entity register: 역할(기본 competitor)")
    brand_code: PgLine | None = Field(None, max_length=100)
    name: PgLine | None = Field(None, max_length=300)
    merge_into: uuid.UUID | None = None
    parent_brand_id: uuid.UUID | None = None
    surface_action: SurfaceAction | None = Field(None, description="new_surface register: 기본 block")
    note: PgText | None = Field(None, max_length=2000)


class ReviewDecision(BaseModel):
    review: ReviewItem
    ver: int | None = Field(None, description="register 가 쓴 초안")
    entity: EntityOverride | None = None
    surface: SurfaceItem | None = None


# ── 언급 표본 ──
class MentionSample(BaseModel):
    answer_key: int
    round_date: date
    source: Literal["occurrence", "body"] = Field(description="occurrence = Scope 발생 행 문맥, body = 저장 본문 창(발생 행 없는 6~8월 적재분)")
    turn_index: int | None = None
    surface_text: str | None = None
    context: str | None = None
    highlight: list[int] | None = Field(None, description="context 안 [start, end)")
    sentiment: str | None = None
    mention_role: str | None = None


class SurfaceCount(BaseModel):
    surface: str
    n: int


class MentionSamples(BaseModel):
    entity_id: uuid.UUID
    name: str | None = None
    entity_type: str | None = None
    brand_name: str | None = None
    items: list[MentionSample]
    surfaces: list[SurfaceCount] = Field(default_factory=list, description="표본 답변에서 본 표면 상위 30(ing.mention.surfaces, 표본 한정)")


# ── 감사 ──
class EcatAuditItem(BaseModel):
    audit_id: int
    ts: datetime
    actor_id: uuid.UUID
    action: str
    ver: int | None = None
    apply_id: int | None = None
    review_id: int | None = None
    entity_id: uuid.UUID | None = None
    surface_id: int | None = None
    detail: dict[str, Any] | None = None
    request_id: uuid.UUID | None = None


class EcatAuditList(BaseModel):
    items: list[EcatAuditItem]
