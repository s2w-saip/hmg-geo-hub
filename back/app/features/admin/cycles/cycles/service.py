"""admin.cycles.cycles 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

규칙(모듈-관리자 §2.5, DECISIONS-API Q2·Q18, 현행 scripts/summary/hide-cycle.ts·hide-cycle-warning.ts 이식)
- 읽기는 rd.cycle(회차 원장 투영). 목록 기본 창 = 최근 26주(오늘 KST 기준), (round_date, cycle_id) DESC 키셋.
- 상세 진행률 = rd.cycle 카운터(Q2 투영) + rd.job 분포 + rd.answer 분석 상태(조회 시 계산, admin_long). 숨김과 무관하게 센다.
- 쓰기는 요청만: app.judgment_change('cycle_admin', subject_uuids=[cycle_id], payload{cycle_id, op, …, old}: core.contracts.CycleAdmin).
  rd 반영은 적재기. api_rw 는 rd 를 못 읽으므로 대상 확인·경고 계산은 api_ro 로 먼저 한다. dry_run 은 요청을 남기지 않는다.
  중복 판정은 같은 회차·같은 op 의 대기 요청만(dedupe_key={"op": op}): 숨김 대기 중에도 노출일 요청은 받는다(ad-ops R6 dedupe_on_op).
  expected_generation 이 rd.cycle.generation 과 다르면 409 generation_mismatch, 이미 그 상태면 409 state_mismatch.
- 경로 이름 {cyc_key} 는 taxonomy 경로 계약 고정(메인 결정, ad-ops R9 기각): cycle_id(uuid) 와 정수 cyc_key 를 둘 다 받고 응답에는 cycle_id 만.
- 목록 meta.ignored_filters = core.filters.ignored_axes(요청 쿼리, 지원 축 period, surface·project_id 는 이 목록이 쓰는 파라미터).
- 숨김 범위는 all·citations 만(Q18). 사유 collection_error 만 추이에 갭 슬롯을 만든다(hide-cycle.ts:26-28).
"""
from __future__ import annotations

import uuid
from collections.abc import Mapping
from datetime import date, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.codes import SURFACE_CODE, SURFACE_NAME
from app.core.cycles import CycleRow, build_window
from app.core.db import fetch_all, fetch_one, fetch_val
from app.core.envelope import Meta, Page, build_meta
from app.core.filters import FilterSupport, ignored_axes
from app.core.pagination import decode_cursor, fetch_keyset, filter_hash, keyset_page, keyset_predicate
from app.core.sqlb import Binder
from app.core.write import enqueue_change

from . import queries
from .schemas import (
    HIDDEN_REASON_NAME,
    HIDDEN_SCOPE_NAME,
    STATUS_NAME,
    AnswerDistribution,
    CloseBody,
    Counters,
    CycleDetail,
    CycleItem,
    CycleListQuery,
    CycleRequestResult,
    CycleState,
    HideBody,
    JobDistribution,
    Op,
    PendingChange,
    UnhideBody,
    ViewDateBody,
)

LIST_SUPPORT = FilterSupport.of(global_=("period",), website=("period",), project=("period",))
DEFAULT_WEEKS = 26
LIST_SORT = "round_date,cycle_id"
_SCOPE_CODE = {"none": 0, "all": 1, "citations": 2, "mentions": 3}
_REASON_CODE = {"none": 0, "collection_error": 1, "operator": 2}


# ── 경로 식별자 ──
def parse_cycle_ref(raw: str) -> tuple[uuid.UUID | None, int | None]:
    """경로 {cyc_key}: cycle_id(uuid, 공개 식별자) 또는 정수 cyc_key(운영 스크립트 호환)."""
    s = (raw or "").strip()
    try:
        return uuid.UUID(s), None
    except ValueError:
        pass
    if s.isdigit() and 0 < int(s) < 2 ** 31:
        return None, int(s)
    raise errors.unprocessable("회차 식별자는 cycle_id(uuid) 또는 정수", code="invalid_cycle_ref", details={"field": "cyc_key"})


async def load_cycle(conn: AsyncConnection, raw: str) -> dict[str, Any]:
    cid, ck = parse_cycle_ref(raw)
    r = await fetch_one(conn, queries.BY_ID_SQL if cid else queries.BY_KEY_SQL, {"cid": cid} if cid else {"ck": ck})
    if r is None:
        raise errors.not_found("회차 없음")
    return r


def _state(r: dict[str, Any]) -> CycleState:
    return CycleState(status=STATUS_NAME.get(int(r["status"]), "stale"), view_date=r["view_date"],
                      hidden_scope=HIDDEN_SCOPE_NAME[int(r["hidden_scope"])], hidden_reason=HIDDEN_REASON_NAME[int(r["hidden_reason"])])


def _item(r: dict[str, Any], pending: list[PendingChange]) -> dict[str, Any]:
    return {"cycle_id": r["cycle_id"], "surface": SURFACE_NAME[int(r["surface"])], "project_id": r["project_id"], "site_id": r["site_id"],
            "ledger_backed": r["ledger_backed"], "round_date": r["round_date"], "anchor_date": r["anchor_date"],
            "status": STATUS_NAME.get(int(r["status"]), "stale"), "servable": r["servable"], "view_date": r["view_date"],
            "hidden_scope": HIDDEN_SCOPE_NAME[int(r["hidden_scope"])], "hidden_reason": HIDDEN_REASON_NAME[int(r["hidden_reason"])],
            "generation": int(r["generation"]), "pending": pending}


async def _pending(conn: AsyncConnection, ids: list[uuid.UUID]) -> dict[uuid.UUID, list[PendingChange]]:
    out: dict[uuid.UUID, list[PendingChange]] = {}
    if not ids:
        return out
    rows = await fetch_all(conn, queries.PENDING_SQL, {"ids": [str(i) for i in ids]})
    want = set(ids)
    for r in rows:
        pc = PendingChange(change_id=r["change_id"], op=r["op"], status=r["status"], requested_by=r["requested_by"],
                           requested_at=r["requested_at"])
        for u in r["subject_uuids"] or []:
            if u in want:
                out.setdefault(u, []).append(pc)
    return out


# ── 읽기 ──
async def list_cycles(conn: AsyncConnection, q: CycleListQuery, *,
                      query_params: Mapping[str, Any] | None = None) -> tuple[list[CycleItem], Meta]:
    sf = SURFACE_CODE[q.surface]
    today = await fetch_val(conn, queries.TODAY_SQL)
    default_window = q.from_ is None
    lo, hi = (today - timedelta(weeks=DEFAULT_WEEKS), today) if default_window else (q.from_, q.to)
    pks = None
    if q.project_id is not None:
        pks = [int(r["project_key"]) for r in await fetch_all(conn, queries.PROJECT_KEYS_SQL, {"sf": sf, "pid": q.project_id})]
        if not pks:
            raise errors.not_found("프로젝트·사이트 없음")
    fh = filter_hash({"sf": sf, "lo": lo, "hi": hi, "pks": pks})
    cur = decode_cursor(q.cursor, sort=LIST_SORT, dir="desc", fh=fh, types=["date", "uuid"])
    b = Binder()
    pred = keyset_predicate(["c.round_date", "c.cycle_id"], "desc", cur, b) or "true"
    rows = await fetch_keyset(conn, queries.LIST_SQL.format(keyset=pred),
                              {**b.params, "sf": sf, "lo": lo, "hi": hi, "pks": pks, "lim": q.limit + 1})
    page, nxt = keyset_page(rows, q.limit, lambda r: (r["round_date"], r["cycle_id"]), sort=LIST_SORT, dir="desc", fh=fh)
    pend = await _pending(conn, [r["cycle_id"] for r in page])
    items = [CycleItem(**_item(r, pend.get(r["cycle_id"], []))) for r in page]
    gen = max((i.generation for i in items), default=None)
    meta = build_meta(mode="admin", surface=q.surface, generation=gen, page=Page(next_cursor=nxt, limit=q.limit),
                      source={"from": lo.isoformat(), "to": hi.isoformat(), "default_window": default_window,
                              "default_weeks": DEFAULT_WEEKS})
    # 공통 필터 축 중 period 밖(cf.* = custom 포함, 검증 D3)은 조용히 버리지 않고 드러낸다. surface·project_id 는 이 목록의 파라미터
    meta.ignored_filters = ignored_axes(query_params or (), LIST_SUPPORT, q.surface, consumed=("surface", "project_id"))
    return items, meta


async def get_cycle(conn: AsyncConnection, long_conn: AsyncConnection, raw: str) -> CycleDetail:
    """회차 행·대기 요청은 api_ro, 진행률(rd.job·rd.answer 스캔)은 admin_long(30s)."""
    r = await load_cycle(conn, raw)
    pend = await _pending(conn, [r["cycle_id"]])
    jobs = await fetch_one(long_conn, queries.JOB_DIST_SQL, {"sf": int(r["surface"]), "rd": r["round_date"], "ck": int(r["cyc_key"])})
    # 회차 1개의 사실 표 술어(surface·round_date·cyc_key)는 core 창 빌더로 만든다. 관리 진행률은 숨김과 무관하게 세므로 hidden 0 으로 넘긴다.
    win = build_window(surface=SURFACE_NAME[int(r["surface"])], mode="cumulative",
                       rows=[CycleRow(int(r["cyc_key"]), int(r["project_key"]), r["round_date"], 0)],
                       lo=r["round_date"], hi=r["round_date"], generation=int(r["generation"]), project_keys=(int(r["project_key"]),))
    b = Binder()
    ans = await fetch_one(long_conn, queries.ANSWER_DIST_SQL.format(where=" AND ".join(win.where("a", "row", b))), b.params)
    return CycleDetail(**_item(r, pend.get(r["cycle_id"], [])),
                       counters=Counters(expected_units=r["expected_units"], completed_units=r["completed_units"],
                                         completed_answers=r["completed_answers"], gap_answers=r["gap_answers"]),
                       jobs=JobDistribution(**jobs), answers=AnswerDistribution(**ans))  # type: ignore[arg-type]


# ── 숨김 경고(hide-cycle-warning.ts hideCycleWarnings 이식, 순수 함수) ──
def hide_cycle_warnings(*, cycle_week: str, remaining_visible_in_week: int, newer_visible: int, reason: str, scope: str = "all") -> list[str]:
    notes: list[str] = []
    if scope == "citations":
        notes.append("범위 = citations → 인용 계열만 내려간다(인용 화면 추이·인용 점유율·인용 도메인/카테고리·인용 정확도). "
                     "언급 계열(노출률·점유율·우호도·우선 노출도·브랜드 언급 추이·ACR)은 값을 그대로 낸다. "
                     "회차 집합 판정(집계 창·스냅샷 픽·측정 기준일)은 범위와 무관하게 이 회차를 뺀다.")
    if remaining_visible_in_week > 0:
        return [*notes, f"같은 주({cycle_week})에 숨기지 않은 회차가 {remaining_visible_in_week}개 남아 있다 → 갭 슬롯은 안 생기고 "
                        "주 축은 유지된다(그 주의 값이 남으므로). 회차 축에서는 숨긴 회차 하나만 빠진다."]
    if newer_visible == 0:
        return [*notes, f"같은 주({cycle_week})에 남는 회차가 없고 이것이 가장 최근 회차였다 → 갭 슬롯이 생기지 않는다(갭은 축 안쪽에만 끼운다). "
                        "주 축과 회차 축이 각각 한 칸 짧아지고 화면의 측정 기준일이 직전 비숨김 회차로 물러난다(음영·툴팁 없이 조용히 바뀐다)."]
    if reason == "collection_error":
        return [*notes, f"같은 주({cycle_week})에 남는 회차가 없지만 더 최신 비숨김 회차가 {newer_visible}개 있다 → 축 안쪽이므로 "
                        "갭 슬롯이 생겨 주 축은 유지된다. 회차 축에서는 숨긴 회차 하나가 빠진다."]
    return [*notes, f"같은 주({cycle_week})에 남는 회차가 없고 사유가 operator 다 → 갭 슬롯은 생기지 않는다. "
                    "주 축에서는 그 주의 측정점이 빠지고, 회차 축에서는 숨긴 회차 하나가 빠진다."]


# ── 쓰기(요청) ──
def _check_generation(r: dict[str, Any], expected: int | None) -> None:
    if expected is not None and int(r["generation"]) != expected:
        raise errors.conflict("generation_mismatch", "회차 세대가 바뀌었다: 다시 조회 후 요청",
                              {"generation": int(r["generation"])})


def _state_mismatch(msg: str) -> errors.ApiError:
    return errors.conflict("state_mismatch", msg)


async def _submit(rw: AsyncConnection, r: dict[str, Any], op: Op, body: Any, payload: dict[str, Any], requested: CycleState,
                  warnings: list[str]) -> CycleRequestResult:
    current = _state(r)
    change_id = None
    if not body.dry_run:
        change_id = await enqueue_change(rw, "cycle_admin", subject_uuids=[r["cycle_id"]], dedupe_key={"op": op}, payload={
            "cycle_id": str(r["cycle_id"]), "op": op, **payload, "expected_generation": int(r["generation"]),
            "old": current.model_dump(mode="json")})
    return CycleRequestResult(cycle_id=r["cycle_id"], op=op, dry_run=body.dry_run, change_id=change_id,
                              propagation="none" if body.dry_run else "pending", current=current, requested=requested,
                              warnings=warnings)


async def hide(ro: AsyncConnection, rw: AsyncConnection, raw: str, body: HideBody) -> CycleRequestResult:
    r = await load_cycle(ro, raw)
    _check_generation(r, body.expected_generation)
    if int(r["hidden_scope"]) == _SCOPE_CODE[body.hidden_scope] and int(r["hidden_reason"]) == _REASON_CODE[body.reason]:
        raise _state_mismatch("이미 같은 범위·사유로 숨겨져 있다")
    ctx = await fetch_one(ro, queries.HIDE_CONTEXT_SQL, {"rd": r["round_date"], "sf": int(r["surface"]), "pk": int(r["project_key"]),
                                                          "ck": int(r["cyc_key"])})
    assert ctx is not None
    warnings = hide_cycle_warnings(cycle_week=ctx["week"].isoformat(), remaining_visible_in_week=int(ctx["rest"]),
                                   newer_visible=int(ctx["newer"]), reason=body.reason, scope=body.hidden_scope)
    requested = _state(r).model_copy(update={"hidden_scope": body.hidden_scope, "hidden_reason": body.reason})
    return await _submit(rw, r, "hide", body, {"hidden_scope": body.hidden_scope, "reason": body.reason}, requested, warnings)


async def unhide(ro: AsyncConnection, rw: AsyncConnection, raw: str, body: UnhideBody) -> CycleRequestResult:
    r = await load_cycle(ro, raw)
    _check_generation(r, body.expected_generation)
    if int(r["hidden_scope"]) == 0:
        raise _state_mismatch("숨겨진 회차가 아니다")
    requested = _state(r).model_copy(update={"hidden_scope": "none", "hidden_reason": "none"})
    return await _submit(rw, r, "unhide", body, {}, requested, [])


async def close(ro: AsyncConnection, rw: AsyncConnection, raw: str, body: CloseBody) -> CycleRequestResult:
    r = await load_cycle(ro, raw)
    _check_generation(r, body.expected_generation)
    if not r["ledger_backed"]:
        raise _state_mismatch("원장 없는 가상 회차(프로젝트)는 마감하지 않는다")
    if int(r["status"]) != 0:
        raise _state_mismatch("열린(open) 회차만 마감할 수 있다")
    requested = _state(r).model_copy(update={"status": "closed"})
    return await _submit(rw, r, "close", body, {"reason": body.reason.strip(), "closed_by": "operator"}, requested,
                         close_warnings(r["expected_units"], r["completed_units"], r["gap_answers"]))


def close_warnings(expected: int | None, completed: int | None, gap: int | None) -> list[str]:
    """마감 경고(Q2 카운터 투영 사용, 순수 함수). 카운터가 없으면(원장 투영 전) 경고 없음."""
    out = []
    if expected is not None and completed is not None and completed < expected:
        out.append(f"완료 유닛 {completed}/{expected}: 마감하면 미완료 {expected - completed}유닛은 이 회차의 결손으로 남는다.")
    if gap:
        out.append(f"분석 결손 답변 {gap}건이 남아 있다(언급 계열 모수에서 빠진다).")
    return out


async def set_view_date(ro: AsyncConnection, rw: AsyncConnection, raw: str, body: ViewDateBody) -> CycleRequestResult:
    r = await load_cycle(ro, raw)
    _check_generation(r, body.expected_generation)
    if body.view_date < r["round_date"]:
        raise errors.unprocessable("노출일은 회차 날짜(round_date) 이후여야 한다", code="view_date_before_round",
                                   details={"field": "view_date", "round_date": r["round_date"].isoformat()})
    if r["view_date"] == body.view_date:
        raise _state_mismatch("이미 같은 노출일이다")
    today: date = await fetch_val(ro, queries.TODAY_SQL)
    warnings = []
    if not r["servable"]:
        warnings.append("servable 거짓 회차다: 노출일이 지나도 적재기가 서빙 가능으로 바꾸기 전에는 화면에 나오지 않는다.")
    if body.view_date <= today:
        warnings.append(f"노출일 {body.view_date.isoformat()} ≤ 오늘({today.isoformat()}): 반영 즉시 화면 스냅샷 후보가 된다.")
    requested = _state(r).model_copy(update={"view_date": body.view_date})
    return await _submit(rw, r, "set_view_date", body, {"view_date": body.view_date.isoformat()}, requested, warnings)
