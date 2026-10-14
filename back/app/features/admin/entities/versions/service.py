"""admin.entities.versions 업무 규칙(E6: 엔티티 버전 관리 API. 설계 hmg-entity-management-versioning-design-20261001.md 3·7·8절, 제품 결정 26~29).

권한: 라우터가 전 엔드포인트에 require_admin + require_menu_group('admin') 을 건다. 이 모듈은 그 뒤의 업무 규칙만 본다.
노출 회차 포함 반영의 승인 = app.rule_param ecat_approvers(JSON 배열 또는 {"users": [...]}, 사용자 uuid) 에 있는 사용자만
(403 ECAT_EXPOSED_REQUIRES_APPROVAL). 미노출만이면 요청한 관리자 자신도 승인할 수 있다(결정 27). 적재기(E5 _start)가 같은 판정을 다시 한다.

버전(app.ecat_version): 활성 1·초안 1. 초안 = 활성 복사(based_on = 활성). 편집은 초안에만(DB 트리거가 최종 강제, 여기서는 409 ECAT_VERSION_STATE
로 먼저 막는다). 폐기 = status discarded(행·내용은 남는다: 감사). 활성화는 적재기(ecat_activate)만.
편집 → 그 초안의 열린 반영 요청(draft·previewed·approved)을 낡음 표시(approved → previewed, error ECAT_PREVIEW_STALE): 바뀐 내용으로
승인되지 않게. 미리보기 전(draft) 요청도 포함한다: 요청 때 린트를 통과한 내용이 미리보기 전에 바뀔 수 있다(승인 때 린트 지문을 다시 본다).
되돌리기 초안(origin rollback)은 내용 편집 불가(409 ECAT_ROLLBACK_IMMUTABLE): 되돌릴 버전 내용 그대로여야 린트 게이트 면제가 성립한다.
제목·사유 수정·폐기·린트 실행·확인은 된다. 다른 내용을 원하면 폐기하고 새 초안을 만든다.

린트(app.core.ecat.lint): 초안 × 기준 버전(based_on) × 테넌트 설정(app.rule_param ecat_lint) × 관측 표면. 관측 표면은 ing 를 읽지 않고
닿는 범위만 쓴다(활성·초안 add 표면 정의, 검토 대기함 새 표면, rd.dim_entity 대표 표기): ing.mention.surfaces 전수 충돌은 적재기 몫(미포함, 근사).
결과는 ecat_version.lint 에 {LintReport.as_json(), acked, unacked, content_md5, linted_at, linted_by, observed_source}.
반영 요청·다시 미리보기(초안) 때 린트를 다시 돌려 L1·L3 → 422 ECAT_LINT_BLOCKED, 확인 안 된 L2 → 422 ECAT_LINT_UNACKED.
면제는 되돌리기 초안이면서 내용 지문(ecat_content_md5)이 기준(되돌릴) 버전과 같을 때뿐이다(편집 불가와 이중 방어: 어떤 길로든 내용이 바뀌면
면제가 풀린다). 승인(초안) 때는 저장된 린트의 내용 지문이 지금 내용과 같고 차단·미확인이 없어야 한다(아니면 409 ECAT_LINT_STALE·
422 ECAT_LINT_BLOCKED·ECAT_LINT_UNACKED): 요청 뒤 편집된 내용이 미리보기만 거쳐 린트 없이 승인되지 않게.
L2 확인 키에는 내용 지문이 들어 있어(app.core.ecat.lint) 대상 행이 바뀌면 옛 확인이 저절로 풀린다.

반영(app.ecat_apply, 계약 = ingest/project/apply/ecat_engine.py 머리 주석): 요청 = INSERT(from_ver = 활성) + enqueue_change('entity_version',
{apply_id, op 'preview'}). 승인 previewed → approved + op 'apply'. 거절 draft·previewed·approved → rejected. 재개 failed → op 'resume'
(첫 청크 실패로 approved 에 오류만 남은 경우는 op 'apply' 재투입). 포기 failed → op 'abandon'(사유 필수, 적재기가 범위 회차를 반영 전
버전으로 되돌려 투영한 뒤 rejected ECAT_APPLY_ABANDONED, 포기가 시작된 반영은 재개 불가). 되돌리기 = 되돌릴 반영의 from_ver 내용으로
origin rollback 초안 + 같은 범위 요청. 요청·승인·재개·되돌리기 전에 running·failed 반영이 있으면 409 ECAT_APPLY_RUNNING.

감사: 모든 쓰기는 같은 트랜잭션에서 app.ecat_audit_log 한 행 이상(DB-v2.17 P102). 쓰기가 롤백되면 감사 행도 없다. 변경 없음(no-op)은 쓰기도 감사도 없다.
"""
from __future__ import annotations

import dataclasses
import datetime as dt
import json
import re
import uuid
from collections import Counter
from collections.abc import Iterable, Mapping
from typing import Any

from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.cycles import Window
from app.core.db import fetch_all, fetch_one, fetch_val, get_db
from app.core.ecat.lint import (
    EntityRow,
    LintConfig,
    LintReport,
    RollupRule,
    SurfaceRow,
    VersionSnapshot,
    lint_version,
    removed_ids,
    rollup_edit_targets,
    tracked_ids,
)
from app.core.ecat.matcher import SurfaceSpec, compile_surfaces, scan_text
from app.core.ecat.text import normalize_surface
from app.core.reqid import current_request_id
from app.core.sqlb import Binder
from app.core.write import enqueue_change
from app.features.admin.catalog.prompts.admin_common import brand_codes, clean_text
from app.features.admin.entities.registry.service import check_period, window_for
from app.features.admin.entities.versions import queries as q
from app.features.admin.entities.versions.dberr import ecat_db_errors
from app.features.admin.entities.versions.schemas import (
    AbandonCycle,
    AbandonPins,
    ApplyBrief,
    ApplyCreateBody,
    ApplyDetail,
    ApplyItem,
    DiffEntity,
    DiffSurface,
    DraftWrite,
    EcatAuditItem,
    EntityBody,
    EntityOverride,
    EntityWrite,
    HubEntityBody,
    LintFinding,
    LintState,
    MentionSample,
    MentionSamples,
    QueueItem,
    ReviewDecision,
    ReviewDecisionBody,
    ReviewItem,
    SurfaceBody,
    SurfaceCount,
    SurfaceItem,
    SurfaceWrite,
    VersionDetail,
    VersionDiff,
    VersionSummary,
)

OBSERVED_SOURCE = "app.ecat_surface_def(활성·초안 add) ∪ app.ecat_review(new_surface) ∪ rd.dim_entity.rep_name (ing.mention.surfaces 전수 아님)"
# 새 전역 차단 표면만 자사(추적) 엔티티의 Scope 관측 표면(rd.v_entity_mention_surface, P104)과 대조한다(검증 N4). 최근 N개월(설정
# ecat_lint.own_surface_lookback_months, 기본 3)·원문 distinct 상한·admin_long(30s). 실패(시간 초과 등)는 린트를 막지 않고 원천 문구에 남긴다
OWN_SURFACE_MONTHS = 3
OWN_SURFACE_LIMIT = 5000
OWN_CANDIDATE_LIMIT = 20000                  # 자사 귀속 후보 엔티티(차원 표) 상한
STALE_MSG = "ECAT_PREVIEW_STALE: 미리보기 뒤 초안이 바뀌었다(다시 미리보기)"
ENTITY_FIELDS = ("origin", "name", "entity_type", "role", "brand_code", "merge_into", "parent_brand_id", "note")
_CODE = re.compile(r"^([A-Z][A-Z0-9_]+):")
SAMPLE_MAX = 50
CONTEXT = 80


def _j(v: Any) -> Any:
    return json.loads(v) if isinstance(v, str) else v


def _s(v: Any) -> str | None:
    return None if v is None else str(v)


def error_code(err: str | None) -> str | None:
    m = _CODE.match(err or "")
    return m.group(1) if m else None


async def audit(rw: AsyncConnection, action: str, *, ver: int | None = None, apply_id: int | None = None, review_id: int | None = None,
                entity_id: uuid.UUID | str | None = None, surface_id: int | None = None, detail: Mapping[str, Any] | None = None) -> int:
    """감사 한 행(같은 쓰기 트랜잭션). actor_id = app.actor()(DB 기본값)."""
    rid = current_request_id()
    return int(await fetch_val(rw, q.AUDIT_INSERT, {
        "action": action, "ver": ver, "apply_id": apply_id, "review_id": review_id, "entity_id": _s(entity_id), "surface_id": surface_id,
        "detail": json.dumps(dict(detail), ensure_ascii=False, default=str) if detail is not None else None, "rid": _s(rid)}))


# ════════════════════════════════════════════════════════════════════════════
# 버전 읽기
# ════════════════════════════════════════════════════════════════════════════
async def _active(conn: AsyncConnection) -> int | None:
    v = await fetch_val(conn, q.ACTIVE_VER)
    return None if v is None else int(v)


async def _draft(conn: AsyncConnection) -> int | None:
    v = await fetch_val(conn, q.DRAFT_VER)
    return None if v is None else int(v)


async def _version(conn: AsyncConnection, ver: int, *, lock: bool = False) -> dict[str, Any]:
    r = await fetch_one(conn, q.VERSION_FOR_UPDATE if lock else q.VERSION, {"ver": ver})
    if r is None:
        raise errors.not_found("버전 없음", code="ECAT_VERSION_NOT_FOUND")
    return r


async def _require_draft(rw: AsyncConnection, ver: int, *, content: bool = False) -> dict[str, Any]:
    """초안 잠금. content = 엔티티·표면 내용 편집(되돌리기 초안은 409 ECAT_ROLLBACK_IMMUTABLE)."""
    v = await _version(rw, ver, lock=True)
    if v["status"] != "draft":
        raise errors.conflict("ECAT_VERSION_STATE", f"초안만 편집한다(버전 {ver} 은 {v['status']})", {"ver": ver, "status": v["status"]})
    if content and v["origin"] == "rollback":
        raise errors.conflict("ECAT_ROLLBACK_IMMUTABLE", "되돌리기 초안은 내용을 편집하지 않는다(폐기하고 새 초안을 만든다)",
                              {"ver": ver, "based_on": v["based_on"]})
    return v


async def _lint_exempt(rw: AsyncConnection, v: Mapping[str, Any]) -> bool:
    """린트 게이트 면제 = 되돌리기 초안 ∧ 내용 지문 = 기준(되돌릴) 버전 지문."""
    if v["origin"] != "rollback" or v["based_on"] is None:
        return False
    mine = await fetch_val(rw, q.CONTENT_MD5, {"ver": int(v["ver"])})
    base = await fetch_val(rw, q.CONTENT_MD5, {"ver": int(v["based_on"])})
    return mine is not None and mine == base


def _brief(r: Mapping[str, Any] | None) -> ApplyBrief | None:
    if r is None:
        return None
    return ApplyBrief(apply_id=int(r["apply_id"]), status=r["status"], scope_kind=r["scope_kind"], from_round_date=r["from_round_date"],
                      requested_at=r["requested_at"], finished_at=r["finished_at"])


async def _summaries(conn: AsyncConnection, rows: list[dict[str, Any]]) -> list[VersionSummary]:
    vers = [int(r["ver"]) for r in rows]
    last = {int(r["ver"]): r for r in await fetch_all(conn, q.LAST_APPLY_OF, {"vers": vers})} if vers else {}
    out = []
    for r in rows:
        ents = r.get("entity_rows")
        surfs = r.get("surface_rows")
        out.append(VersionSummary(ver=int(r["ver"]), status=r["status"], based_on=r["based_on"], title=r["title"], reason=r["reason"],
                                  origin=r["origin"], created_by=r["created_by"], created_at=r["created_at"], submitted_at=r["submitted_at"],
                                  activated_at=r["activated_at"], retired_at=r["retired_at"], entity_rows=int(ents or 0),
                                  surface_rows=int(surfs or 0), last_apply=_brief(last.get(int(r["ver"])))))
    return out


async def list_versions(ro: AsyncConnection, *, status: str | None, limit: int,
                        gate: bool = False) -> tuple[list[VersionSummary], int | None, int | None]:
    """gate = 활성·초안 번호만(view=gate, B084: 버전 행·행별 수·최근 반영을 읽지 않는다, items = []). 하위 화면 게이트 용도."""
    if gate:
        return [], await _active(ro), await _draft(ro)
    rows = await fetch_all(ro, q.VERSIONS, {"status": status, "lim": limit})
    return await _summaries(ro, rows), await _active(ro), await _draft(ro)


async def _summary_only(c: AsyncConnection, v: Mapping[str, Any]) -> VersionSummary:
    """버전 요약만(version_detail 의 version 과 같은 값), 덮어쓰기·표면 행을 읽지 않고. 활성·초안은 상태마다 1개(DB 고유 색인
    ecat_version_one_active·one_draft)라 목록 질의(VERSIONS, 행별 count)를 그 상태로 좁혀 행 수를 받는다. 보관·폐기는 행을 센다."""
    ver = int(v["ver"])
    if v["status"] in ("active", "draft"):
        rows = await fetch_all(c, q.VERSIONS, {"status": v["status"], "lim": 1})
        if rows and int(rows[0]["ver"]) == ver:
            return (await _summaries(c, rows))[0]
    ents, surfs = await _entities(c, ver), await _surfaces(c, ver)
    return (await _summaries(c, [{**v, "entity_rows": len(ents), "surface_rows": len(surfs)}]))[0]


async def _entities(conn: AsyncConnection, ver: int) -> list[dict[str, Any]]:
    return await fetch_all(conn, q.ENTITIES_OF, {"ver": ver})


async def _surfaces(conn: AsyncConnection, ver: int) -> list[dict[str, Any]]:
    return await fetch_all(conn, q.SURFACES_OF, {"ver": ver})


async def _dims(ro: AsyncConnection, ids: Iterable[Any]) -> dict[str, dict[str, Any]]:
    ids = sorted({str(i) for i in ids if i is not None})
    if not ids:
        return {}
    return {str(r["entity_id"]): r for r in await fetch_all(ro, q.DIM_ENTITIES, {"ids": ids})}


def _override(r: Mapping[str, Any], dims: Mapping[str, Mapping[str, Any]]) -> EntityOverride:
    d = dims.get(str(r["entity_id"]))
    return EntityOverride(entity_id=r["entity_id"], origin=r["origin"], name=r["name"], entity_type=r["entity_type"], role=r["role"],
                          brand_code=r["brand_code"], merge_into=r["merge_into"], parent_brand_id=r["parent_brand_id"], note=r["note"],
                          updated_by=r.get("updated_by"), updated_at=r.get("updated_at"), observed=d is not None,
                          rep_name=d["rep_name"] if d else None, brand_name=d["brand_name"] if d else None)


def _surface_item(r: Mapping[str, Any]) -> SurfaceItem:
    return SurfaceItem(surface_id=int(r["surface_id"]), entity_id=r["entity_id"], surface=r["surface"], surface_norm=r["surface_norm"],
                       lang=r["lang"], action=r["action"], created_by=r["created_by"], created_at=r["created_at"])


def _lint_state(raw: Any, current_md5: str | None) -> LintState | None:
    d = _j(raw)
    if not d:
        return None
    return LintState(blocked=bool(d.get("blocked")), counts=d.get("counts") or {}, escalated=int(d.get("escalated") or 0),
                     findings=[LintFinding(**f) for f in d.get("findings") or []], acked=list(d.get("acked") or []),
                     unacked=list(d.get("unacked") or []), content_md5=d.get("content_md5"),
                     stale=d.get("content_md5") != current_md5, linted_at=d.get("linted_at"), linted_by=d.get("linted_by"),
                     observed_source=d.get("observed_source"))


async def _own_scope(ro: AsyncConnection, ids: Iterable[Any]) -> tuple[dict[str, str], dict[str, str]]:
    """(scope_own {엔티티: 덮어쓰기 없을 때 귀속 자사 엔티티}, labels {자사 엔티티: 브랜드 코드}). 활성 투영 차원 기준(api_ro)."""
    labels = {str(r["own_id"]): r["brand_code"] for r in await fetch_all(ro, q.OWN_BRANDS)}
    ids = sorted({str(i) for i in ids if i is not None})
    scope = {str(r["entity_id"]): str(r["own_id"]) for r in await fetch_all(ro, q.OWN_SCOPE_ATTRIBUTION, {"ids": ids})} if ids else {}
    return scope, labels


async def _rollup_sets(ro: AsyncConnection, targets: Iterable[Any], ids: Iterable[Any]) -> dict[str, set[str]]:
    """{엔티티: Scope 롤업 id 들} 중 롤업이 targets(제거 엔티티)에 걸리는 ids 만(검증 N8, RollupRule.entity_own 의 scope_rollups). 전 기간."""
    ts, xs = sorted({str(t) for t in targets if t is not None}), sorted({str(i) for i in ids if i is not None})
    out: dict[str, set[str]] = {}
    if not ts or not xs:
        return out
    for r in await fetch_all(ro, q.ROLLUP_SETS_FOR_IDS, {"targets": ts, "ids": xs, "lim": OWN_SURFACE_LIMIT}):
        out.setdefault(str(r["entity_id"]), set()).add(str(r["rollup"]))
    return out


async def _rollup_dependents(targets: Iterable[Any], months: int) -> tuple[dict[str, set[str]], str]:
    """린트 역방향(검증 N8): 제거·병합 편집 대상을 Scope 롤업으로 두는 엔티티와 그 롤업들. 최근 months 개월·상한, admin_long, 실패해도 린트는
    계속한다(근사 원천에 남긴다: 전역 차단 대조와 같은 비차단 규칙)."""
    ts = sorted({str(t) for t in targets if t is not None})
    if not ts:
        return {}, ""
    try:
        async with get_db().read("admin_long") as conn:
            rows = await fetch_all(conn, q.ROLLUP_DEPENDENTS, {"targets": ts, "months": months, "lim": OWN_SURFACE_LIMIT})
    except DBAPIError as e:
        return {}, f", 롤업 역조회 실패({type(e.orig).__name__ if e.orig is not None else type(e).__name__})"
    out: dict[str, set[str]] = {}
    for r in rows:
        out.setdefault(str(r["entity_id"]), set()).add(str(r["rollup"]))
    cap = ", 상한 도달" if len(rows) >= OWN_SURFACE_LIMIT else ""
    return out, f", 롤업 역조회 편집 대상 {len(ts)}개·의존 엔티티 {len(out)}개{cap}"


def _with_own(cfg: LintConfig, labels: Mapping[str, str]) -> LintConfig:
    """추적 집합에 자사 브랜드 정본 엔티티를 더한다(설정이 비어도 자사 귀속 판정이 정본으로 접히게)."""
    return dataclasses.replace(cfg, tracked_entity_ids=frozenset(cfg.tracked_entity_ids) | frozenset(labels))


# 활성 버전 스냅샷 메모(B083). 관리 목록은 페이지(최대 500행)마다 같은 활성 버전 내용(ENTITIES_OF·SURFACES_OF)을 다시 읽었다. 초안이 아닌 버전의
# 내용은 불변(DB 트리거 tg_ecat_draft_only·tg_ecat_version_guard: 바뀌면 새 버전)이라 버전 행 지문(ver·created_at·activated_at·행 수)을 키로
# 프로세스 안에 하나만 둔다. 같은 번호로 다시 만든 버전(정리 뒤 재이관)은 created_at·activated_at 이 달라 키가 갈린다.
# 자사 브랜드(app.brand)·린트 설정(app.rule_param)·차원 귀속은 바뀔 수 있어 메모하지 않고 요청마다 읽는다.
_ACTIVE_SNAPSHOT: dict[tuple[Any, ...], VersionSnapshot] = {}


async def _active_snapshot(conn: AsyncConnection) -> VersionSnapshot:
    """활성 버전 스냅샷(없으면 빈 버전). 버전 행 1문장(VERSIONS status=active) + 메모가 없을 때만 내용 2문장."""
    rows = await fetch_all(conn, q.VERSIONS, {"status": "active", "lim": 1})
    if not rows:
        return VersionSnapshot()
    r = rows[0]
    key = (int(r["ver"]), r["created_at"], r["activated_at"], int(r["entity_rows"] or 0), int(r["surface_rows"] or 0))
    snap = _ACTIVE_SNAPSHOT.get(key)
    if snap is None:
        snap = await _snapshot(conn, int(r["ver"]))
        _ACTIVE_SNAPSHOT.clear()
        _ACTIVE_SNAPSHOT[key] = snap
    return snap


async def active_own_brands(conn: AsyncConnection, ids: Iterable[Any]) -> dict[str, str | None]:
    """엔티티별 유효 귀속 자사 브랜드(활성 버전 기준). 관리 목록 배지(admin.entities.registry)와 버전 상세 드로어(effective_own_brand)가 같은
    판정을 쓴다: RollupRule.entity_own(활성 버전 행 = 제거·병합·모 브랜드 덮어쓰기, 그 밖은 투영 차원의 표시 브랜드 = 덮어쓰기 없는 원본 쌍의
    접두 교정·롤업·별칭 결과). 활성 버전이 없으면(이관 전) 빈 버전으로 본다(차원만). conn 은 app·rd 를 읽을 수 있는 읽기 커넥션.
    활성 버전 스냅샷은 버전 키 메모(_active_snapshot)를 쓴다."""
    ids = sorted({str(i) for i in ids if i is not None})
    if not ids:
        return {}
    snap = await _active_snapshot(conn)
    scope, labels = await _own_scope(conn, ids)
    rups = await _rollup_sets(conn, removed_ids(snap), ids)
    rule = RollupRule(snap, tracked_ids(snap, _with_own(await lint_config(conn), labels)))
    out: dict[str, str | None] = {}
    for i in ids:
        own = rule.entity_own(i, scope, rups)
        out[i] = labels.get(str(own)) if own is not None else None
    return out


async def version_detail(ro: AsyncConnection, ver: int, *, conn: AsyncConnection | None = None) -> VersionDetail:
    """conn = 버전 표를 읽을 커넥션(쓰기 뒤 같은 트랜잭션 결과를 돌려줄 때 rw). rd 차원은 항상 ro.
    엔티티 행마다 이 버전 기준 유효 귀속(effective_own_brand, RollupRule.entity_own)을 붙인다.
    린트 판정용 스냅샷은 본문용으로 읽은 행에서 만든다(ENTITIES_OF·SURFACES_OF 1회씩, B086)."""
    c = conn or ro
    v = await _version(c, ver)
    ents = await _entities(c, ver)
    surfs = await _surfaces(c, ver)
    md5 = await fetch_val(c, q.CONTENT_MD5, {"ver": ver})
    dims = await _dims(ro, [e["entity_id"] for e in ents])
    summ = (await _summaries(c, [{**v, "entity_rows": len(ents), "surface_rows": len(surfs)}]))[0]
    snap = _snapshot_of(ents, surfs)
    scope, labels = await _own_scope(ro, [e["entity_id"] for e in ents])
    rups = await _rollup_sets(ro, removed_ids(snap), [e["entity_id"] for e in ents])
    rule = RollupRule(snap, tracked_ids(snap, _with_own(await lint_config(c), labels)))
    out = []
    for e in ents:
        o = _override(e, dims)
        own = rule.entity_own(str(e["entity_id"]), scope, rups)
        o.effective_own_brand = labels.get(str(own)) if own is not None else None
        out.append(o)
    return VersionDetail(version=summ, content_md5=md5, entities=out, surfaces=[_surface_item(s) for s in surfs],
                         lint=_lint_state(v["lint"], md5))


async def version_lint(ro: AsyncConnection, ver: int) -> VersionDetail:
    """view=lint(B087, 반영 상세 화면 보조): 버전 요약·현재 내용 지문·마지막 린트만(값은 version_detail 과 같다). 덮어쓰기 엔티티·표면 목록은
    비운다([]): 귀속 판정·차원·롤업 조회를 하지 않는다."""
    v = await _version(ro, ver)
    md5 = await fetch_val(ro, q.CONTENT_MD5, {"ver": ver})
    return VersionDetail(version=await _summary_only(ro, v), content_md5=md5, entities=[], surfaces=[], lint=_lint_state(v["lint"], md5))


async def _written(ro: AsyncConnection, rw: AsyncConnection, ver: int, minimal: bool) -> VersionDetail:
    """초안 생성·수정 응답. minimal(return=minimal, B085) = 버전 요약만(content_md5·lint null, entities·surfaces []): 화면은 번호만 쓰고
    router.refresh 로 다시 읽는다. 기본 = 종전 version_detail 전체."""
    if not minimal:
        return await version_detail(ro, ver, conn=rw)
    return VersionDetail(version=await _summary_only(rw, await _version(rw, ver)), content_md5=None, entities=[], surfaces=[], lint=None)


def _ent_key(r: Mapping[str, Any]) -> dict[str, Any]:
    return {k: _s(r[k]) if k in ("merge_into", "parent_brand_id") else r[k] for k in ENTITY_FIELDS}


async def version_diff(ro: AsyncConnection, ver: int, against: int | None) -> VersionDiff:
    v = await _version(ro, ver)
    base = against if against is not None else v["based_on"]
    if base is not None:
        await _version(ro, base)
    a_ents = {str(e["entity_id"]): _ent_key(e) for e in (await _entities(ro, base) if base is not None else [])}
    b_ents = {str(e["entity_id"]): _ent_key(e) for e in await _entities(ro, ver)}
    ents: list[DiffEntity] = []
    for eid in sorted(set(a_ents) | set(b_ents)):
        a, b = a_ents.get(eid), b_ents.get(eid)
        if a == b:
            continue
        if a is None:
            ents.append(DiffEntity(entity_id=uuid.UUID(eid), change="added", after=b))
        elif b is None:
            ents.append(DiffEntity(entity_id=uuid.UUID(eid), change="removed", before=a))
        else:
            ents.append(DiffEntity(entity_id=uuid.UUID(eid), change="changed", fields=[k for k in ENTITY_FIELDS if a[k] != b[k]], before=a, after=b))
    a_s = {int(s["surface_id"]): s for s in (await _surfaces(ro, base) if base is not None else [])}
    b_s = {int(s["surface_id"]): s for s in await _surfaces(ro, ver)}
    surfs: list[DiffSurface] = []
    for sid in sorted(set(a_s) | set(b_s)):
        a, b = a_s.get(sid), b_s.get(sid)
        if a is not None and b is not None and a["action"] == b["action"]:
            continue
        r = b or a
        change = "added" if a is None else "removed" if b is None else "changed"
        surfs.append(DiffSurface(surface_id=sid, entity_id=r["entity_id"], surface=r["surface"], change=change,
                                 before_action=a["action"] if a else None, after_action=b["action"] if b else None))
    counts = Counter([f"entity_{d.change}" for d in ents] + [f"surface_{d.change}" for d in surfs])
    return VersionDiff(ver=ver, against=base, entities=ents, surfaces=surfs, counts=dict(sorted(counts.items())))


# ════════════════════════════════════════════════════════════════════════════
# 초안 쓰기
# ════════════════════════════════════════════════════════════════════════════
async def _copy_version(rw: AsyncConnection, src: int, dst: int) -> tuple[int, int]:
    with ecat_db_errors():
        ne = await rw.execute(_t(q.COPY_ENTITIES), {"src": src, "dst": dst})
        ns = await rw.execute(_t(q.COPY_SURFACES), {"src": src, "dst": dst})
    return int(ne.rowcount or 0), int(ns.rowcount or 0)


def _t(sql: str) -> Any:
    from sqlalchemy import text
    return text(sql)


async def _new_draft(rw: AsyncConnection, *, based_on: int, copy_from: int, title: str, reason: str | None, origin: str) -> tuple[int, int, int]:
    existing = await _draft(rw)
    if existing is not None:
        raise errors.conflict("ECAT_DRAFT_EXISTS", "초안이 이미 있다(초안 1개: 반영하거나 폐기한 뒤 만든다)", {"ver": existing})
    with ecat_db_errors():
        ver = int(await fetch_val(rw, q.INSERT_DRAFT, {"based_on": based_on, "title": title, "reason": reason, "origin": origin}))
    ne, ns = await _copy_version(rw, copy_from, ver)
    return ver, ne, ns


async def create_draft(ro: AsyncConnection, rw: AsyncConnection, *, title: str, reason: str | None, minimal: bool = False) -> VersionDetail:
    active = await _active(rw)
    if active is None:
        raise errors.conflict("ECAT_NO_ACTIVE", "활성 엔티티 버전이 없다(v1 이관 전: 명부는 기존 화면으로 편집)")
    t = clean_text(title, field="title", max_len=200, required=True)
    ver, ne, ns = await _new_draft(rw, based_on=active, copy_from=active, title=t or "", reason=clean_text(reason, field="reason", max_len=2000),
                                   origin="admin")
    await audit(rw, "draft.create", ver=ver, detail={"based_on": active, "title": t, "entities": ne, "surfaces": ns})
    return await _written(ro, rw, ver, minimal)


async def patch_draft(ro: AsyncConnection, rw: AsyncConnection, ver: int, *, title: str | None, reason: str | None,
                      fields: set[str], minimal: bool = False) -> VersionDetail:
    v = await _require_draft(rw, ver)
    new_title = clean_text(title, field="title", max_len=200, required=True) if "title" in fields else v["title"]
    new_reason = clean_text(reason, field="reason", max_len=2000) if "reason" in fields else v["reason"]
    if (new_title, new_reason) != (v["title"], v["reason"]):
        with ecat_db_errors():
            await fetch_one(rw, q.UPDATE_DRAFT_META, {"ver": ver, "title": new_title, "reason": new_reason})
        await audit(rw, "draft.update", ver=ver, detail={"old": {"title": v["title"], "reason": v["reason"]},
                                                         "new": {"title": new_title, "reason": new_reason}})
    return await _written(ro, rw, ver, minimal)


async def discard_draft(rw: AsyncConnection, ver: int, *, reason: str | None) -> DraftWrite:
    await _require_draft(rw, ver)
    why = clean_text(reason, field="reason", max_len=2000)
    rejected = [int(r["apply_id"]) for r in await fetch_all(rw, q.REJECT_OPEN, {"ver": ver, "err": "ECAT_VERSION_DISCARDED: 초안 폐기"})]
    with ecat_db_errors():
        await fetch_one(rw, q.DISCARD, {"ver": ver})
    await audit(rw, "draft.discard", ver=ver, detail={"reason": why, "rejected_applies": rejected})
    return DraftWrite(ver=ver, status="discarded", rejected_applies=rejected)


async def _stale_open(rw: AsyncConnection, ver: int) -> list[int]:
    return sorted(int(r["apply_id"]) for r in await fetch_all(rw, q.STALE_OPEN, {"ver": ver, "err": STALE_MSG}))


async def _known_entity(ro: AsyncConnection, rw: AsyncConnection, ver: int, entity_id: uuid.UUID) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """(rd.dim_entity 행, 초안의 ecat_entity 행). 둘 다 없으면 404."""
    dims = await _dims(ro, [entity_id])
    row = await fetch_one(rw, q.ENTITY_IN_VER, {"ver": ver, "id": entity_id})
    return dims.get(str(entity_id)), row


async def _ref_exists(ro: AsyncConnection, rw: AsyncConnection, ver: int, ref: uuid.UUID | None, field: str) -> None:
    if ref is None:
        return
    dim, row = await _known_entity(ro, rw, ver, ref)
    if dim is None and row is None:
        raise errors.unprocessable(f"{field} 대상 엔티티 없음(관측 엔티티 또는 이 초안의 허브 엔티티)", code="ECAT_UNKNOWN_ENTITY",
                                   details={"field": field})


async def _check_brand(rw: AsyncConnection, role: str, brand: str | None) -> None:
    if brand is not None:
        known = await brand_codes(rw)
        if brand not in known or known[brand]:
            raise errors.unprocessable("알 수 없는 브랜드이거나 엄브렐러", code="invalid_brand", details={"field": "brand_code"})
    if role == "own" and brand is None:
        raise errors.unprocessable("own 은 brand_code 필수", code="brand_required", details={"field": "brand_code"})


def _is_default(r: Mapping[str, Any]) -> bool:
    """Scope 엔티티의 기본값(행 없음과 같은 의미): 경쟁, 병합·롤업·메모 없음."""
    return r["origin"] == "scope" and r["role"] == "competitor" and r["merge_into"] is None and r["parent_brand_id"] is None and not r["note"]


async def _write_entity(ro: AsyncConnection, rw: AsyncConnection, ver: int, entity_id: uuid.UUID, fields: Mapping[str, Any], *,
                        origin: str | None = None, allow_unobserved: bool = False, action: str = "entity.upsert",
                        extra_detail: Mapping[str, Any] | None = None) -> EntityWrite:
    """초안 엔티티 행 upsert(기본값이면 삭제). fields = role·brand_code·name·entity_type·merge_into·parent_brand_id·note."""
    old = await fetch_one(rw, q.ENTITY_ROW_FOR_UPDATE, {"ver": ver, "id": entity_id})
    dims = await _dims(ro, [entity_id])
    dim = dims.get(str(entity_id))
    if old is None and dim is None and not allow_unobserved:
        raise errors.not_found("엔티티 없음(관측 전 엔티티는 허브 엔티티 추가로 만든다)", code="ECAT_UNKNOWN_ENTITY")
    role = fields["role"]
    brand = clean_text(fields.get("brand_code"), field="brand_code", max_len=100)
    await _check_brand(rw, role, brand)
    merge_into, parent = fields.get("merge_into"), fields.get("parent_brand_id")
    if merge_into == entity_id:
        raise errors.unprocessable("자기 자신으로 병합 불가", code="ECAT_MERGE_SELF", details={"field": "merge_into"})
    if parent == entity_id:
        raise errors.unprocessable("자기 자신을 모 브랜드로 둘 수 없다", code="ECAT_PARENT_SELF", details={"field": "parent_brand_id"})
    await _ref_exists(ro, rw, ver, merge_into, "merge_into")
    await _ref_exists(ro, rw, ver, parent, "parent_brand_id")
    name = clean_text(fields.get("name"), field="name", max_len=300) or (old["name"] if old else None) or (dim["rep_name"] if dim else None)
    if role in ("own", "hidden") and not name:
        raise errors.unprocessable("own·hidden 은 이름 필요", code="name_required", details={"field": "name"})
    etype = clean_text(fields.get("entity_type"), field="entity_type", max_len=100) or (old["entity_type"] if old else None) \
        or (dim["entity_type"] if dim else None)
    new = {"origin": origin or (old["origin"] if old else "scope"), "name": name, "entity_type": etype, "role": role, "brand_code": brand,
           "merge_into": merge_into, "parent_brand_id": parent, "note": clean_text(fields.get("note"), field="note", max_len=2000)}
    before = _ent_key(old) if old else None
    delete = _is_default(new)
    after = None if delete else _ent_key(new)
    if before == after:
        row = await fetch_one(rw, q.ENTITY_ONE, {"ver": ver, "id": entity_id})
        return EntityWrite(ver=ver, entity=_override(row, dims) if row else None, changed=False)
    with ecat_db_errors():
        if delete:
            await fetch_one(rw, q.DELETE_ENTITY, {"ver": ver, "id": entity_id})
        else:
            await fetch_one(rw, q.UPSERT_ENTITY, {"ver": ver, "id": entity_id, **new})
    stale = await _stale_open(rw, ver)
    await audit(rw, "entity.delete" if delete and action == "entity.upsert" else action, ver=ver, entity_id=entity_id,
                detail={"old": before, "new": after, "stale_applies": stale, **(extra_detail or {})})
    row = None if delete else await fetch_one(rw, q.ENTITY_ONE,
                                              {"ver": ver, "id": entity_id})
    return EntityWrite(ver=ver, entity=_override(row, dims) if row else None, changed=True, stale_applies=stale)


async def put_entity(ro: AsyncConnection, rw: AsyncConnection, ver: int, entity_id: uuid.UUID, body: EntityBody) -> EntityWrite:
    await _require_draft(rw, ver, content=True)
    return await _write_entity(ro, rw, ver, entity_id, body.model_dump())


async def create_hub_entity(ro: AsyncConnection, rw: AsyncConnection, ver: int, body: HubEntityBody) -> EntityWrite:
    await _require_draft(rw, ver, content=True)
    eid = uuid.uuid4()
    fields = body.model_dump()
    fields.setdefault("merge_into", None)
    return await _write_entity(ro, rw, ver, eid, fields, origin="hub", allow_unobserved=True, action="entity.create")


async def delete_entity(rw: AsyncConnection, ver: int, entity_id: uuid.UUID) -> EntityWrite:
    await _require_draft(rw, ver, content=True)
    old = await fetch_one(rw, q.ENTITY_ROW_FOR_UPDATE, {"ver": ver, "id": entity_id})
    if old is None:
        raise errors.not_found("초안에 이 엔티티 행이 없다", code="ECAT_ENTITY_NOT_IN_DRAFT")
    if old["origin"] == "hub":
        refs = await fetch_one(rw, q.ENTITY_REFS, {"ver": ver, "id": entity_id})
        if int(refs["entity_refs"]) or int(refs["surface_refs"]):
            raise errors.conflict("ECAT_ENTITY_IN_USE", "허브 엔티티를 가리키는 병합·롤업·표면이 초안에 있다(먼저 지운다)",
                                  {"entity_refs": int(refs["entity_refs"]), "surface_refs": int(refs["surface_refs"])})
    with ecat_db_errors():
        await fetch_one(rw, q.DELETE_ENTITY, {"ver": ver, "id": entity_id})
    stale = await _stale_open(rw, ver)
    await audit(rw, "entity.delete", ver=ver, entity_id=entity_id, detail={"old": _ent_key(old), "new": None, "stale_applies": stale})
    return EntityWrite(ver=ver, entity=None, changed=True, stale_applies=stale)


async def _surface_row(rw: AsyncConnection, ver: int, sid: int) -> dict[str, Any] | None:
    return await fetch_one(rw, q.SURFACE_ONE, {"ver": ver, "sid": sid})


async def _put_surface(ro: AsyncConnection, rw: AsyncConnection, ver: int, *, entity_id: uuid.UUID | None, surface: str, lang: str | None,
                       action: str, extra_detail: Mapping[str, Any] | None = None) -> SurfaceWrite:
    if action == "add" and entity_id is None:
        raise errors.unprocessable("add 는 엔티티 필수(전역 표면은 block 만)", code="ECAT_SURFACE_ADD_GLOBAL", details={"field": "entity_id"})
    if entity_id is not None:
        dim, row = await _known_entity(ro, rw, ver, entity_id)
        if dim is None and row is None:
            raise errors.not_found("엔티티 없음", code="ECAT_UNKNOWN_ENTITY")
    text_ = clean_text(surface, field="surface", max_len=200, required=True) or ""
    norm = normalize_surface(text_)
    if not norm:
        raise errors.unprocessable("정규화하면 빈 표면", code="ECAT_SURFACE_EMPTY", details={"field": "surface"})
    lg = clean_text(lang, field="lang", max_len=16)
    lg = lg.lower() if lg else None
    if lg is not None and not re.fullmatch(r"[a-z]{2,3}(-[a-z0-9]{2,8})?", lg):
        raise errors.unprocessable("lang 형식(ko·en·zh-hans 등)", code="unprocessable", details={"field": "lang"})
    params = {"eid": _s(entity_id), "norm": norm, "lang": lg}
    sid = await fetch_val(rw, q.FIND_SURFACE_DEF, params)
    created = False
    if sid is None:
        with ecat_db_errors():
            sid = await fetch_val(rw, q.INSERT_SURFACE_DEF, {**params, "surface": text_})
        created = sid is not None
        if sid is None:                                    # 동시 생성 경쟁(DO NOTHING) → 다시 찾는다
            sid = await fetch_val(rw, q.FIND_SURFACE_DEF, params)
    sid = int(sid)
    prev = await fetch_one(rw, q.SURFACE_IN_VER, {"ver": ver, "sid": sid})
    if prev is not None and prev["action"] == action:
        return SurfaceWrite(ver=ver, surface=_surface_item(await _surface_row(rw, ver, sid) or {}), changed=False)
    with ecat_db_errors():
        await fetch_one(rw, q.UPSERT_SURFACE, {"ver": ver, "sid": sid, "action": action})
    stale = await _stale_open(rw, ver)
    await audit(rw, f"surface.{action}", ver=ver, entity_id=entity_id, surface_id=sid,
                detail={"surface": text_, "surface_norm": norm, "lang": lg, "previous_action": prev["action"] if prev else None,
                        "def_created": created, "stale_applies": stale, **(extra_detail or {})})
    row = await _surface_row(rw, ver, sid)
    return SurfaceWrite(ver=ver, surface=_surface_item(row) if row else None, changed=True, stale_applies=stale)


async def add_surface(ro: AsyncConnection, rw: AsyncConnection, ver: int, body: SurfaceBody) -> SurfaceWrite:
    await _require_draft(rw, ver, content=True)
    return await _put_surface(ro, rw, ver, entity_id=body.entity_id, surface=body.surface, lang=body.lang, action=body.action)


async def remove_surface(rw: AsyncConnection, ver: int, surface_id: int) -> SurfaceWrite:
    await _require_draft(rw, ver, content=True)
    row = await _surface_row(rw, ver, surface_id)
    if row is None:
        raise errors.not_found("초안에 이 표면이 없다", code="ECAT_SURFACE_NOT_IN_DRAFT")
    with ecat_db_errors():
        await fetch_one(rw, q.DELETE_SURFACE, {"ver": ver, "sid": surface_id})
    stale = await _stale_open(rw, ver)
    await audit(rw, "surface.remove", ver=ver, entity_id=row["entity_id"], surface_id=surface_id,
                detail={"surface": row["surface"], "surface_norm": row["surface_norm"], "lang": row["lang"], "previous_action": row["action"],
                        "stale_applies": stale})
    return SurfaceWrite(ver=ver, surface=None, changed=True, stale_applies=stale)


# ════════════════════════════════════════════════════════════════════════════
# 린트
# ════════════════════════════════════════════════════════════════════════════
def _snapshot_of(ents: Iterable[Mapping[str, Any]], surfs: Iterable[Mapping[str, Any]]) -> VersionSnapshot:
    """ENTITIES_OF·SURFACES_OF 행 → 린트 스냅샷(이미 읽은 행을 다시 읽지 않게 분리)."""
    return VersionSnapshot(
        entities=tuple(EntityRow(entity_id=str(e["entity_id"]), role=e["role"], name=e["name"] or "", brand_code=e["brand_code"],
                                 merge_into=_s(e["merge_into"]), parent_brand_id=_s(e["parent_brand_id"])) for e in ents),
        surfaces=tuple(SurfaceRow(surface_id=int(s["surface_id"]), entity_id=_s(s["entity_id"]), surface=s["surface"], action=s["action"],
                                  lang=s["lang"]) for s in surfs))


async def _snapshot(conn: AsyncConnection, ver: int | None) -> VersionSnapshot:
    if ver is None:
        return VersionSnapshot()
    return _snapshot_of(await _entities(conn, ver), await _surfaces(conn, ver))


def _uuid_str(x: Any) -> str | None:
    try:
        return str(uuid.UUID(str(x)))
    except (ValueError, TypeError):
        return None


async def _lint_settings(conn: AsyncConnection) -> tuple[LintConfig, int]:
    """(린트 설정, 자사 관측 표면 조회 개월 수). 원천 app.rule_param ecat_lint."""
    d = _j(await fetch_val(conn, q.LINT_CONFIG)) or {}
    if not isinstance(d, dict):
        d = {}
    tracked = [u for u in (_uuid_str(x) for x in d.get("tracked_entity_ids") or []) if u]
    cfg = LintConfig.build(short_ascii_allowlist=d.get("short_ascii_allowlist") or (), generic_words=d.get("generic_words") or {},
                           tracked_entity_ids=tracked)
    try:
        months = max(1, min(int(d.get("own_surface_lookback_months") or OWN_SURFACE_MONTHS), 240))
    except (TypeError, ValueError):
        months = OWN_SURFACE_MONTHS
    return cfg, months


async def lint_config(conn: AsyncConnection) -> LintConfig:
    return (await _lint_settings(conn))[0]


async def _rollup_observed(blocks: set[str], rule: RollupRule, name_hits: Mapping[str, set[str]],
                           months: int) -> tuple[dict[str, set[str]], dict[str, set[tuple[str, str | None, str | None]]], str]:
    """새 전역 차단 정규형 ∩ (자사 엔티티 ∪ 자사로 롤업되는 엔티티)의 Scope 관측 표면(검증 N4).
    반환 (자사 직접 관측 {정규형: 자사 id}, 롤업 관측 {정규형: (엔티티, Scope 롤업, 접두 교정 id)}, 원천 문구). 자사 판정은 lint.RollupRule
    (엔티티 엔진과 같은 규칙). 조회 대상 = 대상 엔티티·자사 귀속 후보 엔티티(차원 표시 브랜드가 자사이거나 대표 표기가 3사 접두 후보)의 언급 ∪
    롤업이 대상인 언급. 언급 단위 접두 교정(J1) = app.ecat_hmg_prefix_id(적중 행만).
    name_hits = 대표 표기·표면 정의·대기함이 차단과 같은 엔티티(정규형별): 그 엔티티의 Scope 롤업을 읽어 롤업 관측에 더한다."""
    if not blocks:
        return {}, {}, "생략(새 전역 차단 없음)"
    ids = sorted(str(x) for x in rule.query_ids())
    cands = sorted({e for n in blocks for e in name_hits.get(n, set())})
    direct: dict[str, set[str]] = {}
    rolled: dict[str, set[tuple[str, str | None, str | None]]] = {n: {(e, None, None) for e in name_hits.get(n, set())}
                                                                  for n in blocks if name_hits.get(n)}
    try:
        async with get_db().read("admin_long") as conn:
            cand = [str(r["entity_id"]) for r in await fetch_all(conn, q.OWN_CANDIDATE_ENTITIES, {"lim": OWN_CANDIDATE_LIMIT})]
            eids = sorted(set(ids) | set(cand))
            rows = await fetch_all(conn, q.ROLLUP_OBSERVED_SURFACES, {"eids": eids, "ids": ids, "months": months, "norms": sorted(blocks),
                                                                      "lim": OWN_SURFACE_LIMIT}) if eids else []
            crow = await fetch_all(conn, q.ENTITY_SCOPE_ROLLUPS, {"ids": cands, "months": months, "lim": OWN_SURFACE_LIMIT}) if cands else []
    except DBAPIError as e:                                   # 시간 초과 등: 린트는 계속한다(근사 원천에 남긴다)
        return {}, rolled, f"조회 실패({type(e.orig).__name__ if e.orig is not None else type(e).__name__})"
    for r in rows:
        n = normalize_surface(r["surface"] or "")
        if n not in blocks:
            continue
        eid, rup, pfx = str(r["entity_id"]), _s(r["rollup"]), _s(r["pfx"])
        folded = rule.fold(eid)
        if folded is not None and not rule.removed(eid):
            direct.setdefault(n, set()).add(str(folded))
        else:
            rolled.setdefault(n, set()).add((eid, rup, pfx))
    scope_rollups: dict[str, set[tuple[str | None, str | None]]] = {}
    for r in crow:
        scope_rollups.setdefault(str(r["entity_id"]), set()).add((_s(r["rollup"]), _s(r["pfx"])))
    for n in blocks:
        for e in name_hits.get(n, set()):
            rolled.setdefault(n, set()).update((e, x, y) for x, y in scope_rollups.get(e, set()))
    cap = ", 상한 도달" if len(rows) >= OWN_SURFACE_LIMIT or len(crow) >= OWN_SURFACE_LIMIT or len(cand) >= OWN_CANDIDATE_LIMIT else ""
    return direct, rolled, f"최근 {months}개월, 대상 엔티티 {len(ids)}개·자사 귀속 후보 {len(cand)}개, 적중 원문 {len(rows)}개{cap}"


async def _observed(ro: AsyncConnection, rw: AsyncConnection, norms: set[str]) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    if not norms:
        return out
    ns = sorted(norms)
    for r in await fetch_all(rw, q.OBSERVED_DEFS, {"norms": ns}) + await fetch_all(rw, q.OBSERVED_REVIEW, {"norms": ns}):
        out.setdefault(r["surface_norm"], set()).add(str(r["entity_id"]))
    for r in await fetch_all(ro, q.OBSERVED_NAMES, {"names": sorted({n.lower() for n in ns})}):
        n = normalize_surface(r["rep_name"] or "")
        if n in norms:
            out.setdefault(n, set()).add(str(r["entity_id"]))
    return out


async def run_lint(ro: AsyncConnection, rw: AsyncConnection, v: Mapping[str, Any], actor: uuid.UUID) -> tuple[LintReport, dict[str, Any]]:
    """초안 린트 + ecat_version.lint 저장(확인 키는 여전히 L2 인 것만 유지). 반환 (보고서, 저장한 JSON)."""
    ver = int(v["ver"])
    draft = await _snapshot(rw, ver)
    base = await _snapshot(rw, v["based_on"])
    base_keys = {(s.surface_id, s.action) for s in base.surfaces}
    # 새 add 표면(충돌 대조) ∪ 새 전역 차단 표면(자사·추적 엔티티 표면과 대조, lint 전역 분기)
    new_norms = {normalize_surface(s.surface) for s in draft.surfaces
                 if (s.surface_id, s.action) not in base_keys and (s.action == "add" or s.entity_id is None)}
    new_norms.discard("")
    observed = await _observed(ro, rw, new_norms)
    cfg, months = await _lint_settings(rw)
    lint_ids = ([e.entity_id for e in (*draft.entities, *base.entities)]
                + [s.entity_id for s in draft.surfaces if s.action == "block" and s.entity_id is not None])
    # Scope 롤업 대상 제거(검증 N8): 대상 행의 롤업(전 기간, 배지·드로어와 같은 원천) ∪ 제거·병합 편집 대상을 롤업으로 두는 엔티티(역방향, 비차단)
    rups = await _rollup_sets(ro, removed_ids(draft) | removed_ids(base), lint_ids)
    deps, dep_note = await _rollup_dependents(rollup_edit_targets(draft, base), months)
    for d, rs in deps.items():
        rups.setdefault(d, set()).update(rs)
    scope, labels = await _own_scope(ro, lint_ids + sorted(deps))
    cfg = _with_own(cfg, labels)
    blocks = {normalize_surface(s.surface) for s in draft.surfaces
              if s.action == "block" and s.entity_id is None and (s.surface_id, s.action) not in base_keys} - {""}
    rule = RollupRule(draft, tracked_ids(draft, cfg, base))
    direct, rolled, own_note = await _rollup_observed(blocks, rule, {n: set(observed.get(n, set())) for n in blocks}, months)
    for n, ids in direct.items():
        observed.setdefault(n, set()).update(ids)
    report = lint_version(draft, cfg, base=base, observed_surfaces=observed, rollup_observed=rolled, scope_own=scope, own_labels=labels,
                          scope_rollups=rups)
    prev = _j(v["lint"]) or {}
    acked = [k for k in prev.get("acked") or [] if k in set(report.needs_ack)]
    md5 = await fetch_val(rw, q.CONTENT_MD5, {"ver": ver})
    doc = {**report.as_json(), "acked": acked, "unacked": list(report.unacked(acked)), "content_md5": md5,
           "linted_at": dt.datetime.now(dt.UTC).isoformat(), "linted_by": str(actor),
           "observed_source": f"{OBSERVED_SOURCE} ∪ 전역 차단 대조 rd.v_entity_mention_surface(자사·자사 롤업 엔티티, {own_note}{dep_note})"}
    with ecat_db_errors():
        await fetch_one(rw, q.SET_LINT, {"ver": ver, "lint": json.dumps(doc, ensure_ascii=False)})
    return report, doc


async def lint(ro: AsyncConnection, rw: AsyncConnection, ver: int, actor: uuid.UUID) -> LintState:
    v = await _require_draft(rw, ver)
    report, doc = await run_lint(ro, rw, v, actor)
    await audit(rw, "lint.run", ver=ver, detail={"counts": doc["counts"], "blocked": doc["blocked"], "unacked": len(doc["unacked"]),
                                                 "content_md5": doc["content_md5"]})
    return _lint_state(doc, doc["content_md5"])  # type: ignore[return-value]


async def ack_lint(rw: AsyncConnection, ver: int, keys: list[str]) -> LintState:
    v = await _require_draft(rw, ver)
    doc = _j(v["lint"])
    md5 = await fetch_val(rw, q.CONTENT_MD5, {"ver": ver})
    if not doc or doc.get("content_md5") != md5:
        raise errors.conflict("ECAT_LINT_STALE", "린트가 없거나 린트 뒤 초안이 바뀌었다(다시 린트)")
    needs = [f["key"] for f in doc.get("findings") or [] if f.get("level") == "L2"]
    ks = list(dict.fromkeys(keys))
    unknown = [k for k in ks if k not in set(needs)]
    if unknown:
        raise errors.unprocessable("L2 확인 키가 아니다", code="ECAT_LINT_UNKNOWN_KEY", details={"keys": unknown[:50]})
    old = list(doc.get("acked") or [])
    if set(old) == set(ks):                                    # 변경 없음(순서만 다름 포함) = 쓰기도 감사도 없다
        return _lint_state(doc, md5)  # type: ignore[return-value]
    doc["acked"] = ks
    doc["unacked"] = [k for k in dict.fromkeys(needs) if k not in set(ks)]
    with ecat_db_errors():
        await fetch_one(rw, q.SET_LINT, {"ver": ver, "lint": json.dumps(doc, ensure_ascii=False)})
    await audit(rw, "lint.ack", ver=ver, detail={"acked": ks, "previous": old, "content_md5": md5})
    return _lint_state(doc, md5)  # type: ignore[return-value]


async def _lint_fresh(rw: AsyncConnection, v: Mapping[str, Any]) -> None:
    """승인 전 확인(ro 없이): 저장된 린트가 지금 내용의 것이고 차단·미확인이 없어야 한다. 새 린트는 다시 미리보기가 돌린다."""
    doc = _j(v["lint"]) or {}
    md5 = await fetch_val(rw, q.CONTENT_MD5, {"ver": int(v["ver"])})
    if not doc or doc.get("content_md5") != md5:
        raise errors.conflict("ECAT_LINT_STALE", "요청 뒤 초안 내용이 바뀌어 린트가 낡았다(다시 미리보기)",
                              {"lint_md5": doc.get("content_md5"), "content_md5": md5})
    if doc.get("blocked"):
        raise errors.unprocessable("린트 L1·L3 가 있어 승인할 수 없다", code="ECAT_LINT_BLOCKED", details={"counts": doc.get("counts")})
    if doc.get("unacked"):
        raise errors.unprocessable("확인하지 않은 린트 L2 가 있다", code="ECAT_LINT_UNACKED", details={"unacked": list(doc["unacked"])[:100]})


async def _lint_gate(ro: AsyncConnection, rw: AsyncConnection, v: Mapping[str, Any], actor: uuid.UUID) -> dict[str, Any]:
    report, doc = await run_lint(ro, rw, v, actor)
    if report.blocked:
        keys = [f.key for f in report.findings if f.level in ("L1", "L3")]
        raise errors.unprocessable("린트 L1·L3 가 있어 반영(미리보기)을 요청할 수 없다", code="ECAT_LINT_BLOCKED",
                                   details={"counts": doc["counts"], "keys": keys[:100]})
    if doc["unacked"]:
        raise errors.unprocessable("확인하지 않은 린트 L2 가 있다", code="ECAT_LINT_UNACKED", details={"unacked": doc["unacked"][:100]})
    return doc


# ════════════════════════════════════════════════════════════════════════════
# 반영
# ════════════════════════════════════════════════════════════════════════════
def approvers_of(value: Any) -> set[str]:
    """app.rule_param ecat_approvers → 소문자 uuid 문자열 집합(ecat_engine._approvers 와 같은 해석)."""
    v = _j(value)
    if isinstance(v, dict):
        v = v.get("users") or []
    if not isinstance(v, list):
        return set()
    return {str(x).lower() for x in v}


def _item_fields(r: Mapping[str, Any]) -> dict[str, Any]:
    return dict(apply_id=int(r["apply_id"]), ver=int(r["ver"]), from_ver=r["from_ver"], scope_kind=r["scope_kind"],
                from_round_date=r["from_round_date"], status=r["status"], requested_by=r["requested_by"], requested_at=r["requested_at"],
                approved_by=r["approved_by"], approved_at=r["approved_at"], started_at=r["started_at"], finished_at=r["finished_at"],
                reason=r["reason"], affected_answers=r["affected_answers"], cycle_keys=list(r["cycle_keys"]) if r["cycle_keys"] else None,
                has_preview=bool(r["has_preview"]), requires_approval=bool(r["requires_approval"]), error=r["error"],
                error_code=error_code(r["error"]))


async def list_applies(conn: AsyncConnection, *, status: str | None, ver: int | None, before: int | None, limit: int) -> list[ApplyItem]:
    rows = await fetch_all(conn, q.APPLIES, {"status": status, "ver": ver, "before": before, "lim": limit})
    return [ApplyItem(**_item_fields(r)) for r in rows]


async def _load_apply(conn: AsyncConnection, apply_id: int, *, lock: bool = False) -> dict[str, Any]:
    r = await fetch_one(conn, q.APPLY_FOR_UPDATE if lock else q.APPLY, {"id": apply_id})
    if r is None:
        raise errors.not_found("반영 없음", code="ECAT_APPLY_NOT_FOUND")
    return r


async def _open_queue(conn: AsyncConnection, apply_id: int) -> dict[str, Any] | None:
    return await fetch_one(conn, q.QUEUE_OPEN, {"pl": json.dumps({"apply_id": apply_id})})


SURFACE_NAMES = {1: "global", 2: "website", 3: "project"}


async def _abandon_pins(ro: AsyncConnection, r: Mapping[str, Any], active: int | None) -> AbandonPins | None:
    """포기의 회차 고정(검증 N2 고지). failed(포기 전) = 예정: 적재기 _abandon 과 같은 규칙으로 pins_before 에서 계산
    (반영 전 버전 = 새 버전인 회차는 반영 전 고정값, 그 밖은 반영 전 버전, 기록 없으면 from_ver). 포기 중·포기로 닫힘 = rd.cycle.ecat_ver 실측.
    고정된 회차는 적재기 범위 술어에서 노출과 같게 취급된다(unexposed 대상 밖, 범위에 넣으면 requires_approval)."""
    pv = _j(r["preview"]) or {}
    abandoning = bool(pv.get("abandon"))
    if r["status"] == "failed":
        state = "abandoning" if abandoning else "planned"
    elif r["status"] == "rejected" and error_code(r["error"]) == "ECAT_APPLY_ABANDONED":
        state = "abandoned"
    else:
        return None
    b = int(r["ver"])
    keys = [int(k) for k in (r["cycle_keys"] or [])]
    rows = {int(x["cyc_key"]): x for x in await fetch_all(ro, q.ABANDON_CYCLES, {"keys": keys})} if keys else {}
    pins: dict[int, int] = {}
    if state == "planned":
        before = pv.get("pins_before") if isinstance(pv.get("pins_before"), dict) else {}
        base = int(r["from_ver"]) if r["from_ver"] is not None else b
        for k in keys:
            if k not in rows:                                  # 회차가 사라졌다: 적재기도 건너뛴다
                continue
            rec = before.get(str(k)) if isinstance(before.get(str(k)), dict) else {}
            prior = int(rec["ver"]) if rec.get("ver") is not None else base
            pin = (int(rec["pin"]) if rec.get("pin") is not None else None) if prior == b else prior
            if pin is not None:
                pins[k] = pin
    else:
        pins = {k: int(x["pin"]) for k, x in rows.items() if x["pin"] is not None}
    cycles = [AbandonCycle(cyc_key=k, round_date=rows[k]["round_date"], surface=SURFACE_NAMES.get(int(rows[k]["surface"])),
                           exposed=bool(rows[k]["exposed"]), pin_ver=v) for k, v in sorted(pins.items())]
    return AbandonPins(state=state, new_ver=b, active_ver=active, cycles=cycles, unexposed=sum(1 for c in cycles if not c.exposed),
                       requires_approval_later=bool(cycles))


async def apply_detail(conn: AsyncConnection, apply_id: int, actor: uuid.UUID, *, ro: AsyncConnection | None = None) -> ApplyDetail:
    """ro = rd 를 읽을 커넥션(api_ro). 주면 포기 회차 고정(abandon_pins)을 채운다(api_rw 는 rd 권한이 없다)."""
    r = await _load_apply(conn, apply_id)
    queue = [QueueItem(change_id=int(x["change_id"]), op=x["op"], status=x["status"], requested_at=x["requested_at"], applied_at=x["applied_at"],
                       error=x["error"]) for x in await fetch_all(conn, q.QUEUE_OF, {"pl": json.dumps({"apply_id": apply_id})})]
    open_q = next((x for x in queue if x.status in ("pending", "running")), None)
    approvers = approvers_of(await fetch_val(conn, q.APPROVERS))
    req = bool(r["requires_approval"])
    active = await _active(conn)
    can = (r["status"] == "previewed" and bool(r["has_preview"]) and r["error"] is None and open_q is None
           and (not req or str(actor).lower() in approvers))
    actions: list[str] = []
    if r["status"] in ("draft", "previewed", "approved"):
        actions += ["preview", "reject"]
    if can:
        actions.append("approve")
    abandoning = bool((_j(r["preview"]) or {}).get("abandon"))
    if (r["status"] == "failed" and not abandoning) or (r["status"] == "approved" and r["error"] is not None and open_q is None):
        actions.append("resume")
    if r["status"] == "failed":
        actions.append("abandon")
    if r["status"] == "applied" and active is not None and int(r["ver"]) == active:
        actions.append("rollback")
    pins = await _abandon_pins(ro, r, active) if ro is not None else None
    return ApplyDetail(**_item_fields(r), preview=_j(r["preview"]), queue=queue, can_approve=can, approver_required=req, actions=sorted(actions),
                       abandon_pins=pins)


async def _busy(rw: AsyncConnection, apply_id: int | None) -> None:
    b = await fetch_one(rw, q.BUSY, {"id": apply_id})
    if b is not None:
        raise errors.conflict("ECAT_APPLY_RUNNING", "다른 반영이 진행 중이거나 실패 상태다(끝내거나 재개한 뒤 요청)",
                              {"apply_id": int(b["apply_id"]), "status": b["status"]})


async def _enqueue(rw: AsyncConnection, apply_id: int, op: str) -> int:
    return await enqueue_change(rw, "entity_version", payload={"apply_id": apply_id, "op": op}, dedupe="raise",
                                dedupe_key={"apply_id": apply_id})


def _check_scope(scope_kind: str, from_round_date: dt.date | None) -> None:
    if (scope_kind == "from_round") != (from_round_date is not None):
        raise errors.unprocessable("from_round 는 from_round_date 필수, 그 밖 범위는 생략", code="ECAT_SCOPE_INVALID",
                                   details={"field": "from_round_date"})


async def _insert_apply(rw: AsyncConnection, *, ver: int, from_ver: int, scope_kind: str, from_round_date: dt.date | None, reason: str) -> int:
    open_ = await fetch_one(rw, q.OPEN_FOR_VER, {"ver": ver})
    if open_ is not None:
        raise errors.conflict("ECAT_APPLY_OPEN", "이 버전의 열린 반영 요청이 있다(그 요청을 미리보기·승인하거나 거절한다)",
                              {"apply_id": int(open_["apply_id"]), "status": open_["status"]})
    with ecat_db_errors():
        return int(await fetch_val(rw, q.INSERT_APPLY, {"ver": ver, "from_ver": from_ver, "scope_kind": scope_kind,
                                                        "from_round_date": from_round_date, "reason": reason}))


async def request_apply(ro: AsyncConnection, rw: AsyncConnection, body: ApplyCreateBody, actor: uuid.UUID) -> ApplyDetail:
    await fetch_val(rw, q.APPLY_LOCK)
    active = await _active(rw)
    if active is None:
        raise errors.conflict("ECAT_NO_ACTIVE", "활성 엔티티 버전이 없다(v1 이관 전)")
    _check_scope(body.scope_kind, body.from_round_date)
    ver = body.ver if body.ver is not None else await _draft(rw)
    if ver is None:
        raise errors.unprocessable("반영할 초안이 없다(ver 를 주거나 초안을 만든다)", code="ECAT_NO_DRAFT", details={"field": "ver"})
    v = await _version(rw, ver, lock=True)
    if not (v["status"] == "draft" or (v["status"] == "active" and ver == active)):
        raise errors.conflict("ECAT_VERSION_STATE", f"반영은 초안 또는 활성 버전(범위 확장)만(버전 {ver} 은 {v['status']})",
                              {"ver": ver, "status": v["status"]})
    await _busy(rw, None)
    reason = clean_text(body.reason, field="reason", max_len=2000, required=True) or ""
    lint_doc = None
    if v["status"] == "draft" and not await _lint_exempt(rw, v):
        lint_doc = await _lint_gate(ro, rw, v, actor)
    apply_id = await _insert_apply(rw, ver=ver, from_ver=active, scope_kind=body.scope_kind, from_round_date=body.from_round_date, reason=reason)
    if v["status"] == "draft":
        await fetch_one(rw, q.MARK_SUBMITTED, {"ver": ver})
    cid = await _enqueue(rw, apply_id, "preview")
    await audit(rw, "apply.request", ver=ver, apply_id=apply_id,
                detail={"from_ver": active, "scope_kind": body.scope_kind, "from_round_date": body.from_round_date, "reason": reason,
                        "change_id": cid, "range_extension": v["status"] == "active",
                        "lint": None if lint_doc is None else {"counts": lint_doc["counts"], "acked": lint_doc["acked"],
                                                               "content_md5": lint_doc["content_md5"]}})
    return await apply_detail(rw, apply_id, actor)


async def re_preview(ro: AsyncConnection, rw: AsyncConnection, apply_id: int, actor: uuid.UUID) -> ApplyDetail:
    await fetch_val(rw, q.APPLY_LOCK)
    r = await _load_apply(rw, apply_id, lock=True)
    if r["status"] not in ("draft", "previewed", "approved"):
        raise errors.conflict("ECAT_APPLY_STATE", f"미리보기는 draft·previewed·approved 에서만(현재 {r['status']})", {"status": r["status"]})
    active = await _active(rw)
    v = await _version(rw, int(r["ver"]), lock=True)
    if active != r["from_ver"]:
        raise errors.conflict("ECAT_BASE_CHANGED", "요청 뒤 활성 버전이 바뀌었다(거절하고 새로 요청)", {"from_ver": r["from_ver"], "active": active})
    if not (v["status"] == "draft" or (v["status"] == "active" and int(r["ver"]) == active)):
        raise errors.conflict("ECAT_VERSION_STATE", f"버전 {r['ver']} 은 {v['status']}", {"status": v["status"]})
    await _busy(rw, apply_id)
    if v["status"] == "draft" and not await _lint_exempt(rw, v):
        await _lint_gate(ro, rw, v, actor)
    if r["status"] == "approved":
        with ecat_db_errors():
            await fetch_one(rw, q.BACK_TO_PREVIEWED, {"id": apply_id})
    cid = await _enqueue(rw, apply_id, "preview")
    await audit(rw, "apply.preview", ver=int(r["ver"]), apply_id=apply_id, detail={"previous_status": r["status"], "change_id": cid})
    return await apply_detail(rw, apply_id, actor)


async def approve(rw: AsyncConnection, apply_id: int, actor: uuid.UUID, *, note: str | None) -> ApplyDetail:
    await fetch_val(rw, q.APPLY_LOCK)
    r = await _load_apply(rw, apply_id, lock=True)
    if r["status"] != "previewed":
        raise errors.conflict("ECAT_APPLY_STATE", f"승인은 previewed 에서만(현재 {r['status']})", {"status": r["status"]})
    if not r["has_preview"] or r["error"] is not None:
        raise errors.conflict("ECAT_PREVIEW_STALE", "미리보기가 없거나 낡았다(다시 미리보기)", {"error_code": error_code(r["error"])})
    oq = await _open_queue(rw, apply_id)
    if oq is not None:
        raise errors.conflict("ECAT_PREVIEW_PENDING", "처리 대기 중인 큐 요청이 있다(미리보기 결과를 기다린다)",
                              {"change_id": int(oq["change_id"]), "op": oq["op"]})
    active = await _active(rw)
    if active != r["from_ver"]:
        raise errors.conflict("ECAT_BASE_CHANGED", "요청 뒤 활성 버전이 바뀌었다(거절하고 새로 요청)", {"from_ver": r["from_ver"], "active": active})
    v = await _version(rw, int(r["ver"]), lock=True)
    if not (v["status"] == "draft" or (v["status"] == "active" and int(r["ver"]) == active)):
        raise errors.conflict("ECAT_VERSION_STATE", f"버전 {r['ver']} 은 {v['status']}", {"status": v["status"]})
    if v["status"] == "draft" and not await _lint_exempt(rw, v):
        await _lint_fresh(rw, v)
    required = bool(r["requires_approval"])
    if required and str(actor).lower() not in approvers_of(await fetch_val(rw, q.APPROVERS)):
        pv = _j(r["preview"]) or {}
        raise errors.forbidden("노출 회차가 범위에 있어 승인자(app.rule_param ecat_approvers)만 승인한다",
                               code="ECAT_EXPOSED_REQUIRES_APPROVAL",
                               details={"exposed_in_scope": len((pv.get("cycles") or {}).get("exposed_in_scope") or [])})
    await _busy(rw, apply_id)
    with ecat_db_errors():
        ok = await fetch_one(rw, q.SET_APPROVED, {"id": apply_id})
    if ok is None:
        raise errors.conflict("ECAT_APPLY_STATE", "승인 직전에 상태가 바뀌었다")
    cid = await _enqueue(rw, apply_id, "apply")
    await audit(rw, "apply.approve", ver=int(r["ver"]), apply_id=apply_id,
                detail={"requires_approval": required, "self_approval": str(r["requested_by"]).lower() == str(actor).lower(),
                        "note": clean_text(note, field="reason", max_len=2000), "change_id": cid})
    return await apply_detail(rw, apply_id, actor)


async def reject(rw: AsyncConnection, apply_id: int, actor: uuid.UUID, *, reason: str) -> ApplyDetail:
    r = await _load_apply(rw, apply_id, lock=True)
    if r["status"] not in ("draft", "previewed", "approved"):
        raise errors.conflict("ECAT_APPLY_STATE", f"거절은 draft·previewed·approved 에서만(현재 {r['status']}, failed 는 재개한다)",
                              {"status": r["status"]})
    why = clean_text(reason, field="reason", max_len=2000, required=True)
    with ecat_db_errors():
        await fetch_one(rw, q.SET_REJECTED, {"id": apply_id, "err": f"ECAT_REJECTED: {why}"})
    await audit(rw, "apply.reject", ver=int(r["ver"]), apply_id=apply_id, detail={"previous_status": r["status"], "reason": why})
    return await apply_detail(rw, apply_id, actor)


async def resume(rw: AsyncConnection, apply_id: int, actor: uuid.UUID) -> ApplyDetail:
    await fetch_val(rw, q.APPLY_LOCK)
    r = await _load_apply(rw, apply_id, lock=True)
    oq = await _open_queue(rw, apply_id)
    if r["status"] == "failed" and (_j(r["preview"]) or {}).get("abandon"):
        raise errors.conflict("ECAT_APPLY_STATE", "포기가 시작된 반영은 재개하지 않는다(포기를 마저 진행한다)", {"status": r["status"]})
    if r["status"] == "failed":
        op = "resume"
    elif r["status"] == "approved" and r["error"] is not None and oq is None:
        op = "apply"                                       # 첫 청크 실패(활성화까지 롤백): 같은 승인으로 다시 시작
    else:
        raise errors.conflict("ECAT_APPLY_STATE", f"재개는 failed(또는 오류로 멈춘 approved)에서만(현재 {r['status']})", {"status": r["status"]})
    if oq is not None:
        raise errors.conflict("duplicate_pending", "같은 반영의 큐 요청이 이미 대기 중", {"change_id": int(oq["change_id"])})
    await _busy(rw, apply_id)
    cid = await _enqueue(rw, apply_id, op)
    await audit(rw, "apply.resume", ver=int(r["ver"]), apply_id=apply_id, detail={"op": op, "previous_error": r["error"], "change_id": cid})
    return await apply_detail(rw, apply_id, actor)


async def abandon(ro: AsyncConnection, rw: AsyncConnection, apply_id: int, actor: uuid.UUID, *, reason: str) -> ApplyDetail:
    """failed 반영 포기: op 'abandon' 투입(적재기 ecat_engine 포기 절). 활성 버전은 그대로, 범위 회차는 반영 전 버전으로 고정·투영."""
    await fetch_val(rw, q.APPLY_LOCK)
    r = await _load_apply(rw, apply_id, lock=True)
    if r["status"] != "failed":
        raise errors.conflict("ECAT_APPLY_STATE", f"포기는 failed 반영만(현재 {r['status']})", {"status": r["status"]})
    oq = await _open_queue(rw, apply_id)
    if oq is not None:
        raise errors.conflict("duplicate_pending", "같은 반영의 큐 요청이 이미 대기 중", {"change_id": int(oq["change_id"])})
    why = clean_text(reason, field="reason", max_len=2000, required=True)
    cid = await _enqueue(rw, apply_id, "abandon")
    await audit(rw, "apply.abandon", ver=int(r["ver"]), apply_id=apply_id,
                detail={"reason": why, "previous_error": r["error"], "change_id": cid})
    return await apply_detail(rw, apply_id, actor, ro=ro)


async def rollback(ro: AsyncConnection, rw: AsyncConnection, apply_id: int, actor: uuid.UUID, *, reason: str) -> ApplyDetail:
    """applied 반영 X(ver b, from_ver a) 되돌리기: a 내용의 새 초안(origin rollback, based_on a) + X 와 같은 범위 요청(from_ver = 활성 b)."""
    await fetch_val(rw, q.APPLY_LOCK)
    x = await _load_apply(rw, apply_id, lock=True)
    if x["status"] != "applied":
        raise errors.conflict("ECAT_APPLY_STATE", f"되돌리기는 applied 반영만(현재 {x['status']})", {"status": x["status"]})
    active = await _active(rw)
    b, a = int(x["ver"]), x["from_ver"]
    if active != b:
        raise errors.conflict("ECAT_BASE_CHANGED", "되돌릴 반영의 버전이 지금 활성 버전이 아니다(최근 반영부터 되돌린다)", {"ver": b, "active": active})
    if a is None or a == b:
        raise errors.conflict("ECAT_VERSION_STATE", "되돌릴 이전 버전이 없다(범위 확장 반영은 되돌리기 대상이 아니다)", {"from_ver": a})
    await _busy(rw, None)
    why = clean_text(reason, field="reason", max_len=2000, required=True) or ""
    ver, ne, ns = await _new_draft(rw, based_on=int(a), copy_from=int(a), title=f"v{b} 되돌리기(v{a} 내용)", reason=why, origin="rollback")
    v = await _version(rw, ver)
    _, doc = await run_lint(ro, rw, v, actor)                                       # 기록만(되돌리기는 린트 게이트 없음: 직전 활성 내용)
    new_id = await _insert_apply(rw, ver=ver, from_ver=b, scope_kind=x["scope_kind"], from_round_date=x["from_round_date"], reason=why)
    await fetch_one(rw, q.MARK_SUBMITTED, {"ver": ver})
    cid = await _enqueue(rw, new_id, "preview")
    await audit(rw, "draft.create", ver=ver, detail={"based_on": a, "origin": "rollback", "entities": ne, "surfaces": ns,
                                                     "rollback_of_apply": apply_id})
    await audit(rw, "apply.rollback", ver=ver, apply_id=new_id,
                detail={"rollback_of_apply": apply_id, "restore_ver": a, "from_ver": b, "scope_kind": x["scope_kind"],
                        "from_round_date": x["from_round_date"], "reason": why, "change_id": cid, "lint_counts": doc["counts"]})
    return await apply_detail(rw, new_id, actor)


# ════════════════════════════════════════════════════════════════════════════
# 검토 대기함
# ════════════════════════════════════════════════════════════════════════════
def _review(r: Mapping[str, Any]) -> ReviewItem:
    return ReviewItem(review_id=int(r["review_id"]), kind=r["kind"], entity_id=r["entity_id"], surface=r["surface"], surface_norm=r["surface_norm"],
                      display_name=r["display_name"], entity_type=r["entity_type"], first_seen_at=r["first_seen_at"],
                      last_seen_at=r["last_seen_at"], n_mentions=int(r["n_mentions"]), n_answers=int(r["n_answers"]), status=r["status"],
                      resolved_ver=r["resolved_ver"], decided_by=r["decided_by"], decided_at=r["decided_at"], note=r["note"],
                      alert_grade=r["alert_grade"])


async def list_reviews(conn: AsyncConnection, *, status: str | None, kind: str | None, q_text: str | None, before: int | None,
                       limit: int) -> list[ReviewItem]:
    from app.features.admin.catalog.prompts.admin_common import like_pattern
    rows = await fetch_all(conn, q.REVIEWS, {"status": status, "kind": kind, "q": like_pattern(q_text) if q_text else None,
                                             "before": before, "lim": limit})
    return [_review(r) for r in rows]


async def decide_review(ro: AsyncConnection, rw: AsyncConnection, review_id: int, body: ReviewDecisionBody) -> ReviewDecision:
    r = await fetch_one(rw, q.REVIEW_FOR_UPDATE, {"id": review_id})
    if r is None:
        raise errors.not_found("검토 항목 없음", code="ECAT_REVIEW_NOT_FOUND")
    if r["status"] != "pending":
        raise errors.conflict("ECAT_REVIEW_DECIDED", f"이미 처리된 항목({r['status']})", {"status": r["status"]})
    note = clean_text(body.note, field="note", max_len=2000)
    ent = surf = None
    ver = None
    if body.action == "register":
        ver = await _draft(rw)
        if ver is None:
            raise errors.conflict("ECAT_NO_DRAFT", "등록할 초안이 없다(초안을 먼저 만든다)")
        await _require_draft(rw, ver, content=True)
        extra = {"review_id": review_id}
        if r["kind"] == "new_entity":
            fields = {"role": body.role or "competitor", "brand_code": body.brand_code, "name": body.name or r["display_name"],
                      "entity_type": r["entity_type"], "merge_into": body.merge_into, "parent_brand_id": body.parent_brand_id, "note": note}
            ent = (await _write_entity(ro, rw, ver, r["entity_id"], fields, allow_unobserved=True, extra_detail=extra)).entity
        else:
            surf = (await _put_surface(ro, rw, ver, entity_id=r["entity_id"], surface=r["surface"] or r["surface_norm"], lang=None,
                                       action=body.surface_action or "block", extra_detail=extra)).surface
    status = "resolved" if body.action == "register" else "dismissed"
    with ecat_db_errors():
        ok = await fetch_one(rw, q.DECIDE_REVIEW, {"id": review_id, "status": status, "ver": ver, "note": note})
    if ok is None:
        raise errors.conflict("ECAT_REVIEW_DECIDED", "처리 직전에 상태가 바뀌었다")
    await audit(rw, f"review.{body.action}", ver=ver, review_id=review_id, entity_id=r["entity_id"],
                detail={"kind": r["kind"], "surface_norm": r["surface_norm"], "role": body.role, "surface_action": body.surface_action,
                        "note": note})
    row = await fetch_one(rw, q.REVIEW_FOR_UPDATE, {"id": review_id})
    return ReviewDecision(review=_review(row or r), ver=ver, entity=ent, surface=surf)


# ════════════════════════════════════════════════════════════════════════════
# 감사 읽기
# ════════════════════════════════════════════════════════════════════════════
async def list_audit(conn: AsyncConnection, *, ver: int | None, apply_id: int | None, before: int | None, limit: int) -> list[EcatAuditItem]:
    rows = await fetch_all(conn, q.AUDITS, {"ver": ver, "apply_id": apply_id, "before": before, "lim": limit})
    return [EcatAuditItem(audit_id=int(r["audit_id"]), ts=r["ts"], actor_id=r["actor_id"], action=r["action"], ver=r["ver"], apply_id=r["apply_id"],
                      review_id=r["review_id"], entity_id=r["entity_id"], surface_id=r["surface_id"], detail=_j(r["detail"]),
                      request_id=r["request_id"]) for r in rows]


# ════════════════════════════════════════════════════════════════════════════
# 언급 표본(엔티티·표면별 문맥)
# ════════════════════════════════════════════════════════════════════════════
def _highlight(ctx: str | None, needle: str | None) -> list[int] | None:
    if not ctx or not needle:
        return None
    i = ctx.lower().find(needle.lower())
    return None if i < 0 else [i, i + len(needle)]


async def _samples_on(conn: AsyncConnection, *, entity_id: uuid.UUID, surface: str, date_from: dt.date | None, date_to: dt.date | None,
                      surface_text: str | None, limit: int) -> tuple[MentionSamples, Window]:
    dim = await fetch_one(conn, q.DIM_ENTITY, {"id": entity_id})
    if dim is None:
        raise errors.not_found("엔티티 없음(관측된 엔티티만 표본이 있다)", code="ECAT_UNKNOWN_ENTITY")
    win = await window_for(conn, surface, date_from, date_to)
    out = MentionSamples(entity_id=entity_id, name=dim["rep_name"], entity_type=dim["entity_type"], brand_name=dim["brand_name"], items=[])
    bk = int(dim["brand_key"] or 0)
    if win.empty or bk == 0:
        return out, win
    b = Binder()
    w = win.where("ab", "mentions", b)
    params = {**b.params, "bk": bk, "lim": min(limit * 4, 200)}
    keys = await fetch_all(conn, q.SAMPLE_KEYS.format(w=" AND ".join(w)), params)
    if not keys:
        return out, win
    rd_of = {int(k["answer_key"]): k["round_date"] for k in keys}
    klist = sorted(rd_of, reverse=True)
    target = normalize_surface(surface_text) if surface_text else None
    items: list[MentionSample] = []
    occ = await fetch_all(conn, q.SAMPLE_OCC, {"keys": klist, "id": entity_id})
    with_occ = {int(o["answer_key"]) for o in occ}
    for o in occ:
        if target and normalize_surface(o["surface_text"] or "") != target:
            continue
        items.append(MentionSample(answer_key=int(o["answer_key"]), round_date=rd_of[int(o["answer_key"])], source="occurrence",
                                   turn_index=o["turn_index"], surface_text=o["surface_text"], context=o["context_snippet"],
                                   highlight=_highlight(o["context_snippet"], o["surface_text"]), sentiment=o["sentiment"],
                                   mention_role=o["mention_role"]))
    ment = await fetch_all(conn, q.SAMPLE_MENTIONS, {"keys": klist, "id": entity_id})
    seen: Counter[str] = Counter()
    forms: dict[int, set[str]] = {}
    for m in ment:
        fs = {s for s in (m["surfaces"] or []) if s}
        forms.setdefault(int(m["answer_key"]), set()).update(fs)
        seen.update(fs)
    out.surfaces = [SurfaceCount(surface=s, n=n) for s, n in seen.most_common(30)]
    rest = [k for k in klist if k not in with_occ and forms.get(k)]
    if len(items) < limit and rest:                        # 발생 행 없는 답변(6~8월 적재분): 저장 본문에서 표면 창
        bodies = {int(r["answer_key"]): r["answer_text"] for r in await fetch_all(conn, q.SAMPLE_BODIES, {"keys": rest[:limit]})}
        for k in rest[:limit]:
            text_ = bodies.get(k) or ""
            cand = sorted(forms[k])
            if target:
                cand = [s for s in cand if normalize_surface(s) == target]
            specs = [SurfaceSpec(i + 1, str(entity_id), s) for i, s in enumerate(cand) if normalize_surface(s)]
            if not text_ or not specs:
                continue
            scans = scan_text(text_, compile_surfaces(specs))
            if not scans:
                continue
            first = min(scans.values(), key=lambda sc: sc.first_start)
            s0, e0 = first.starts[0], first.ends[0]
            lo, hi = max(0, s0 - CONTEXT), min(len(text_), e0 + CONTEXT)
            items.append(MentionSample(answer_key=k, round_date=rd_of[k], source="body", surface_text=text_[s0:e0], context=text_[lo:hi],
                                       highlight=[s0 - lo, e0 - lo]))
    items.sort(key=lambda x: (x.round_date, x.answer_key), reverse=True)
    out.items = items[:limit]
    return out, win


async def mention_samples(ro: AsyncConnection, *, entity_id: uuid.UUID, surface: str, date_from: dt.date | None, date_to: dt.date | None,
                          surface_text: str | None, limit: int | None) -> tuple[MentionSamples, Window, str]:
    check_period(date_from, date_to)
    n = max(1, min(int(limit or 20), SAMPLE_MAX))
    st = clean_text(surface_text, field="surface_text", max_len=200)
    if date_from is None:
        data, win = await _samples_on(ro, entity_id=entity_id, surface=surface, date_from=None, date_to=None, surface_text=st, limit=n)
        return data, win, "api_ro"
    async with get_db().read("admin_long") as conn:
        data, win = await _samples_on(conn, entity_id=entity_id, surface=surface, date_from=date_from, date_to=date_to, surface_text=st, limit=n)
    return data, win, "admin_long"
