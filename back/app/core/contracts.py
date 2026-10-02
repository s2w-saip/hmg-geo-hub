"""운영 요청 큐(app.judgment_change)·Scope 아웃박스(app.scope_outbox) payload 계약: 생산자(API 기능)와 소비자(ingest 워커) 한 벌.

- 생산자는 core.write.enqueue_change·enqueue_scope 를 거치며 여기 모델로 검증된다(틀리면 ValueError = 코드 결함, 500).
- 소비자(ingest.cycles.ledger·workers)는 parse_change·parse_outbox 로 읽는다(틀리면 ContractError → 큐 행 failed).
- 모델은 소비자가 판정에 쓰는 열을 타입으로 고정하고, 이력용 정보 열(old·new·expected_generation 등)은 extra='allow' 로 싣는다.
- kind 가 여기 없으면(트리거 소관 catalog·prompt_kind 등, 주체만 쓰는 kind) 검증하지 않는다(payload 자유, 대개 None).

dfs_fetch(운영자 키워드 도구 AD-4·고객 관심 IN-1 공용, 2026-09-28 통일)
  subject_texts = 정렬된 DB 정규화(app.term_norm, core.kw.db_term_norms) 목록, payload.terms = 원문 term(같은 순서 아님, 중복 없음)
  fetch: volume(검색량만: search_volume) | insight(search_volume + serp_organic depth) | related(keyword_suggestions)
         | search(keyword_suggestions + include_seed, seed 행 is_seed)
"""
from __future__ import annotations

import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

__all__ = ["CHANGE_MODELS", "DFS_ENDPOINTS", "OUTBOX_MODELS", "ContractError", "check_change", "check_outbox", "parse_change",
           "parse_outbox"]


class ContractError(ValueError):
    """payload 가 계약과 다르다(소비자: 큐 행 failed, 생산자: 코드 결함)."""


class _P(BaseModel):
    model_config = ConfigDict(extra="allow", frozen=True)


# ── judgment_change ──────────────────────────────────────────────────────────────
class GateUnit(_P):
    """발행 게이트 유닛(ing.cycle_unit 키)."""
    prompt_id: uuid.UUID
    target: str = Field(min_length=1)
    region: str = Field(min_length=1)


class CycleAdmin(_P):
    cycle_id: uuid.UUID
    op: Literal["hide", "unhide", "close", "set_view_date", "seal", "force_publish", "regenerate"]
    hidden_scope: Literal["all", "citations", "mentions"] | None = None
    reason: str | None = None                       # hide: collection_error|operator(없으면 소비자가 operator), close: 자유 사유,
                                                    # seal·force_publish: 자유 사유 필수(감사, 제품 결정 17)
    view_date: dt.date | None = None
    units: list[GateUnit] | None = Field(None, max_length=100_000)   # seal: 봉인할 유닛(없으면 현재 빠진 유닛 전부)
    expected_generation: int | None = None
    reinterpret: bool | None = None                 # regenerate: 재해석 재생성만(참 필수). 동결 세대를 지금 판정으로 다시 만든다(DB-v2.22)

    @model_validator(mode="after")
    def _op_fields(self) -> CycleAdmin:
        if self.op == "hide":
            if self.hidden_scope is None:
                raise ValueError("hide 는 hidden_scope 필수")
            if self.reason not in (None, "collection_error", "operator"):
                raise ValueError("hide 사유는 collection_error|operator")
        if self.op == "set_view_date" and self.view_date is None:
            raise ValueError("set_view_date 는 view_date 필수")
        if self.op in ("seal", "force_publish", "regenerate") and not (self.reason or "").strip():
            raise ValueError(f"{self.op} 는 reason(사유) 필수")
        if self.op == "regenerate" and self.reinterpret is not True:
            raise ValueError("regenerate 는 재해석 재생성만 지원한다(reinterpret=true): 허브는 판정을 사실 열에 굽기 때문에 옛 판정으로 다시 만들 수 없다")
        if self.reinterpret is not None and self.op != "regenerate":
            raise ValueError("reinterpret 는 regenerate 에만")
        if self.units is not None and self.op != "seal":
            raise ValueError("units 는 seal 에만")
        return self


class AnchorPin(_P):
    job_id: uuid.UUID
    op: Literal["set", "remove"] = "set"
    anchor: dt.date | None = None
    reason: str = "operator"

    @model_validator(mode="after")
    def _anchor(self) -> AnchorPin:
        if self.op == "set" and self.anchor is None:
            raise ValueError("anchor_pin set 은 anchor 필수")
        return self


class AnswerDrop(_P):
    job_id: uuid.UUID
    op: Literal["drop", "restore"] = "drop"
    reason: str = "operator"


DFS_ENDPOINTS: dict[str, tuple[str, ...]] = {
    "volume": ("search_volume",),
    "insight": ("search_volume", "serp_organic"),
    "related": ("keyword_suggestions",),
    "search": ("keyword_suggestions",),
}


class DfsFetch(_P):
    fetch: Literal["volume", "insight", "related", "search"]
    terms: list[str] = Field(min_length=1, max_length=1000)
    location_code: int
    language_code: str = Field(min_length=1, max_length=16)
    country: str | None = None                       # 프리셋 id(core.kw), 있으면
    depth: int = Field(10, ge=1, le=100)             # insight 의 serp_organic 깊이
    project_id: uuid.UUID | None = None
    force: bool = False
    requested_via: str | None = None

    @property
    def endpoints(self) -> tuple[str, ...]:
        return DFS_ENDPOINTS[self.fetch]

    @property
    def include_seed(self) -> bool:
        return self.fetch == "search"


class CitationOverride(_P):
    op: Literal["set", "clear"]
    domain: str = Field(min_length=1)
    category_key: int | None = None


class Ga4Property(_P):
    op: Literal["upsert", "delete"]
    property_id: str = Field(min_length=1)


class Ga4TrackedEvent(_P):
    op: Literal["replace"]
    property_id: str = Field(min_length=1)
    new: list[str]


class Entity(_P):
    op: Literal["upsert", "delete"]
    entity_id: uuid.UUID


class EntityVersion(_P):
    """엔티티 버전 반영(DB-v2.17 app.ecat_apply 한 건, 적재기 ingest.project.apply.ecat_engine 이 처리).
    op: preview(영향·KPI 전후 계산 → previewed) · apply(approved → running → 청크 반복 → applied) · resume(failed → running 이어받기) ·
    abandon(failed → 범위 회차를 반영 전 버전으로 되돌려 투영 → rejected, 청크 반복 중에는 failed 유지)."""
    apply_id: int = Field(ge=1)
    op: Literal["preview", "apply", "resume", "abandon"]


class ProjectOwnedBase(_P):
    op: Literal["add", "remove"]
    project_id: uuid.UUID
    base_norm: str


class ProjectTargetUrl(_P):
    op: Literal["add", "remove", "import", "update"]
    project_id: uuid.UUID


class ProjectSetting(_P):
    op: str = Field(min_length=1)
    project_id: uuid.UUID
    source: str | None = None                        # 'tracked_targets'(앱) | 트리거 행은 source 없음


class ReportPublication(_P):
    publication_id: uuid.UUID | None = None


CHANGE_MODELS: dict[str, type[_P]] = {
    "cycle_admin": CycleAdmin, "anchor_pin": AnchorPin, "answer_drop": AnswerDrop, "dfs_fetch": DfsFetch,
    "citation_override": CitationOverride, "ga4_property": Ga4Property, "ga4_tracked_event": Ga4TrackedEvent, "entity": Entity,
    "entity_version": EntityVersion,
    "project_owned_base": ProjectOwnedBase, "project_target_url": ProjectTargetUrl, "project_setting": ProjectSetting,
    "report_publication": ReportPublication,
}
# payload 가 없으면 소비자가 처리할 수 없는 kind(그 밖의 kind 는 주체만으로 재판정하므로 payload 가 없어도 된다. 있으면 검증한다)
_CHANGE_REQUIRED = frozenset({"cycle_admin", "anchor_pin", "answer_drop", "dfs_fetch", "entity_version"})


# ── scope_outbox ────────────────────────────────────────────────────────────────
class ProjectOut(_P):
    project_id: uuid.UUID
    scope_project_id: uuid.UUID | None = None


class ScheduleOut(_P):
    project_id: uuid.UUID
    engines: list[str]
    reenable: bool = False
    scope_project_id: uuid.UUID | None = None


class PromptOut(_P):
    prompt_id: uuid.UUID
    project_id: uuid.UUID | None = None             # 표준 카탈로그(관리) 행은 project='standard_root' 이고 project_id 가 없다
    scope_project_id: uuid.UUID | None = None
    scope_prompt_id: uuid.UUID | None = None


OUTBOX_MODELS: dict[tuple[str, str], type[_P]] = {
    ("project", "create"): ProjectOut, ("project", "update"): ProjectOut, ("project", "delete"): ProjectOut,
    ("schedule", "set_targets"): ScheduleOut,
    ("prompt", "create"): PromptOut, ("prompt", "update"): PromptOut, ("prompt", "disable"): PromptOut,
    ("prompt", "enable"): PromptOut, ("prompt", "delete"): PromptOut,
}


def _validate(model: type[_P], payload: Any, what: str) -> _P:
    try:
        return model.model_validate(payload or {})
    except ValidationError as e:
        errs = "; ".join(f"{'.'.join(str(x) for x in er['loc'])}: {er['msg']}" for er in e.errors()[:5])
        raise ContractError(f"{what} payload 계약 위반: {errs}") from e


def parse_change(kind: str, payload: Any) -> _P | None:
    """큐 행 payload → 계약 모델(소비자). 모델이 없는 kind·payload 없는 선택 kind 는 None. 필수 kind 인데 payload 가 비면 ContractError."""
    model = CHANGE_MODELS.get(kind)
    if model is None:
        return None
    if not payload:
        if kind in _CHANGE_REQUIRED:
            raise ContractError(f"{kind} 는 payload 필수")
        return None
    return _validate(model, payload, kind)


def check_change(kind: str, payload: dict[str, Any] | None) -> None:
    """생산자 검증(enqueue_change 가 부른다)."""
    parse_change(kind, payload)


def parse_outbox(aggregate: str, op: str, payload: Any) -> _P:
    model = OUTBOX_MODELS.get((aggregate, op))
    if model is None:
        raise ContractError(f"알 수 없는 아웃박스 op: {aggregate}:{op}")
    return _validate(model, payload, f"{aggregate}:{op}")


def check_outbox(aggregate: str, op: str, payload: dict[str, Any]) -> None:
    parse_outbox(aggregate, op, payload)
