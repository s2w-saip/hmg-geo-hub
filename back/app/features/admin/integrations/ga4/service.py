"""admin.integrations.ga4 업무 규칙. 공통 술어는 app.core.cycles·app.core.measure 를 쓴다(모듈별 재구현 금지).

규칙(현행 admin/ga4 _actions.ts·tracked-events-service.ts 이식, DECISIONS-API Q12, 전체-통합 채택 kind ga4_property·ga4_tracked_event)
- 속성 원본 = app.ga4_property(PK property_id, brand_code·country_code 매핑, status active|pending_grant|unmapped).
  같은 (브랜드, 국가)를 두 속성이 가리키지 못하게 409 market_taken(현행 유니크 인덱스 brand×country 계승). 사전 조회(친절한 메시지·
  상대 속성 id)를 먼저 하고, 동시 요청 경합은 DB 부분 유니크 ga4_property_market_uq(DB-v2.6 P45)의 23505 를 409 market_taken 으로 바꾼다.
  매핑·상태가 바뀌면 같은 트랜잭션에서 judgment_change('ga4_property') → 적재기가 그 속성 전 기간 rd.ga4_row 재투영.
- verify=true: GA4 Data API 최소 보고서로 읽기 권한 확인(외부 호출은 DB 커넥션 밖, 먼저: 핸들러는 CurrentUserDetached, 읽기는
  RoSession 짧은 api_ro) → 성공이면 active, 실패면 저장하지 않는다.
- 추적 이벤트: 통째 교체. 집합이 바뀌면 judgment_change('ga4_tracked_event') → is_conv·conv_basis 전 기간 재투영.
- 이벤트 목록 = 적재된 rd.ga4_row events 보고서(최근 90일, 오늘 KST 기준) ∪ 추적 중 이벤트. 정렬: 추적 우선 → 수 DESC → 이름.
  (현행은 GA4 API 를 화면에서 직접 불렀다: 새 설계는 요청 경로에서 외부 호출 없이 적재된 행을 읽는다. 적재 전 속성은 추적 이벤트만.)
- verified_at(DB-v2.9 P60, bg-admin R1): verify 성공 때만 now(). 매핑이 바뀌어도 유지(현행 upsertGa4Mapping 은 건드리지 않았다).
- 속성 없는 시장(DB-v2.9 P61, bg-admin R2 (a)): app.ga4_market_pending. 현행은 속성 id 없이 브랜드·국가만 먼저 등록하고(status unmapped)
  브랜드×국가 유일 인덱스로 같은 시장의 속성 행과 공존하지 못했다. 그래서 대기 등록은 같은 시장에 속성이 매핑돼 있으면 409 market_taken,
  속성 매핑(PUT properties)은 같은 트랜잭션에서 그 시장의 대기 행을 지운다. 두 쓰기 모두 시장 단위 트랜잭션 잠금을 먼저 잡는다.
"""
from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal
from app.core.db import RoOpener, fetch_all, fetch_one, fetch_val, get_db
from app.core.pagination import decode_cursor, fetch_keyset, filter_hash, keyset_page, keyset_predicate
from app.core.sqlb import Binder
from app.core.write import enqueue_change

from . import queries
from .adapters import Ga4Access, Ga4AccessError
from .schemas import (
    CONV_BASIS,
    EventItem,
    EventsData,
    EventsPut,
    EventsWritten,
    Ga4Fields,
    Ga4Property,
    MarketDeleted,
    MarketPut,
    MarketWritten,
    PendingChange,
    PendingMarket,
    ProjectOverride,
    ProjectOverrideItem,
    PropertyDeleted,
    PropertyPut,
    PropertyWritten,
)

EVENT_WINDOW_DAYS = 90
_DB_CODES = {"ga4_property_market_uq": "market_taken"}      # core.errors.from_db_error: 23505 → 409 market_taken(DB-v2.6 P45)


async def _app_rows(conn: AsyncConnection, *, pid: str | None = None, brand: str | None = None, country: str | None = None,
                    status: str | None = None) -> list[dict[str, Any]]:
    return await fetch_all(conn, queries.LIST_SQL, {"pid": pid, "brand": brand, "country": country, "status": status})


async def _pending(conn: AsyncConnection, pids: list[str]) -> dict[str, list[PendingChange]]:
    out: dict[str, list[PendingChange]] = {}
    if not pids:
        return out
    for r in await fetch_all(conn, queries.PENDING_SQL, {"pids": pids}):
        pc = PendingChange(change_id=r["change_id"], kind=r["kind"], status=r["status"], requested_at=r["requested_at"])
        for t in r["subject_texts"] or []:
            if t in pids:
                out.setdefault(t, []).append(pc)
    return out


async def _dims(ro: AsyncConnection, pids: list[str]) -> dict[str, dict[str, Any]]:
    if not pids:
        return {}
    return {r["property_id"]: r for r in await fetch_all(ro, queries.DIMS_SQL, {"pids": pids})}


def _prop(r: dict[str, Any], dim: dict[str, Any] | None, pending: list[PendingChange]) -> Ga4Property:
    ov = r["project_overrides"]
    ov = json.loads(ov) if isinstance(ov, str) else (ov or [])
    return Ga4Property(property_id=r["property_id"], brand_code=r["brand_code"], country_code=r["country_code"], status=r["status"],
                       verified_at=r["verified_at"], updated_by=r["updated_by"], updated_by_email=r["updated_by_email"], updated_at=r["updated_at"],
                       tracked_events=int(r["tracked_events"]), loaded=dim is not None,
                       conv_basis=CONV_BASIS.get(int(dim["conv_basis"])) if dim else None,
                       project_overrides=[ProjectOverride(**x) for x in ov], pending=pending)


def _registry_prop(r: dict[str, Any]) -> Ga4Property:
    """fields=registry 행: 화면 표 열만(추적 이벤트 수·적재 투영·전환 기준·프로젝트 직접 지정·대기 요청은 null)."""
    return Ga4Property(property_id=r["property_id"], brand_code=r["brand_code"], country_code=r["country_code"], status=r["status"],
                       verified_at=r["verified_at"], updated_by=r["updated_by"], updated_by_email=r["updated_by_email"], updated_at=r["updated_at"],
                       tracked_events=None, loaded=None, conv_basis=None, project_overrides=None, pending=None)


# ── 읽기 ──
async def list_properties(ro: AsyncConnection, *, brand: str | None, country: str | None, status: str | None,
                          fields: Ga4Fields = "full") -> list[Ga4Property]:
    if fields == "registry":                              # 화면 표 열만: 상관 서브쿼리·적재 투영(DIMS)·대기 요청(PENDING) 문장을 건너뛴다
        rows = await fetch_all(ro, queries.REGISTRY_SQL, {"pid": None, "brand": brand, "country": country.upper() if country else None,
                                                          "status": status})
        return [_registry_prop(r) for r in rows]
    rows = await _app_rows(ro, brand=brand, country=country.upper() if country else None, status=status)
    pids = [r["property_id"] for r in rows]
    dims, pend = await _dims(ro, pids), await _pending(ro, pids)
    return [_prop(r, dims.get(r["property_id"]), pend.get(r["property_id"], [])) for r in rows]


async def list_events(ro: AsyncConnection, pid: str) -> EventsData:
    if await fetch_one(ro, queries.PROP_SQL, {"pid": pid}) is None:
        raise errors.not_found("GA4 속성 없음")
    return await load_events(ro, pid)


async def load_events(ro: AsyncConnection, pid: str) -> EventsData:
    """이벤트 목록 본체(레지스트리 존재 검사 없음). admin 경로는 list_events(레지스트리 행 필수), 비관리자 경로
    (analytics.funnel.conversion /v1/funnel/conversion/events, BG-29)는 자기 권한 판정 뒤 이것을 부른다(env·프로젝트 직접 지정 속성도
    적재 투영이 있으면 수를 보여 준다. 추적 이벤트는 레지스트리 속성에만 있다)."""
    today = await fetch_val(ro, queries.TODAY_SQL)
    lo, hi = today - timedelta(days=EVENT_WINDOW_DAYS), today
    dim = (await _dims(ro, [pid])).get(pid)
    counts: dict[str, int] = {}
    if dim is not None:
        for r in await fetch_all(ro, queries.EVENT_COUNTS_SQL, {"pk": int(dim["prop_key"]), "lo": lo, "hi": hi}):
            counts[r["event_name"]] = int(r["cnt"] or 0)
    tracked = {r["event_name"] for r in await fetch_all(ro, queries.TRACKED_SQL, {"pid": pid})}
    items = [EventItem(event_name=n, count=counts.get(n, 0), tracked=n in tracked) for n in set(counts) | tracked]
    items.sort(key=lambda e: (not e.tracked, -e.count, e.event_name))
    return EventsData(property_id=pid, window_from=lo, window_to=hi, loaded=dim is not None,
                      conv_basis=CONV_BASIS.get(int(dim["conv_basis"])) if dim else None, items=items)


PO_SORT = "created_at,project_id"


async def list_project_overrides(ro: AsyncConnection, *, property_id: str | None, registered: bool | None, cursor: str | None,
                                 limit: int) -> tuple[list[ProjectOverrideItem], str | None]:
    """GA4 속성을 직접 지정한 프로젝트 목록(BG-43). 레지스트리 밖 속성 지정도 포함. (created_at, project_id) DESC 키셋."""
    fh = filter_hash({"pid": property_id, "registered": registered})
    cur = decode_cursor(cursor, sort=PO_SORT, dir="desc", fh=fh, types=["timestamptz", "uuid"])
    b = Binder()
    pred = keyset_predicate(["p.created_at", "p.project_id"], "desc", cur, b) or "true"
    rows = await fetch_keyset(ro, queries.PROJECT_OVERRIDES_SQL.format(keyset=pred),
                              {**b.params, "pid": property_id, "registered": registered, "lim": limit + 1})
    page, nxt = keyset_page(rows, limit, lambda r: (r["created_at"], r["project_id"]), sort=PO_SORT, dir="desc", fh=fh)
    return [ProjectOverrideItem(project_id=r["project_id"], name=r["name"], kind=r["kind"], brand_code=r["brand_code"],
                                country_code=r["country_code"], property_id=r["property_id"], registered=bool(r["registered"]),
                                property_status=r["property_status"], created_at=r["created_at"]) for r in page], nxt


# ── 쓰기 ──
async def put_property(open_ro: RoOpener, p: Principal, ga4: Ga4Access, pid: str, body: PropertyPut, *,
                       minimal: bool = False) -> PropertyWritten:
    """minimal=True(return=minimal): 쓰기·판정 요청은 같고 응답용 재조회(LIST·PENDING·DIMS)만 생략한다(property = null)."""
    verified: bool | None = None
    row: dict[str, Any] | None = None
    pend: list[PendingChange] = []
    async with open_ro() as ro:                          # 짧은 api_ro(외부 확인 전에 반납)
        waiting = [pc for pc in (await _pending(ro, [pid])).get(pid, []) if pc.kind == "ga4_property"]
    if waiting:                                           # 대기 요청이 있으면 외부 확인 전에 거절(쓰기 때 enqueue_change 가 다시 막는다)
        raise errors.conflict("duplicate_pending", "같은 대상의 요청이 이미 대기 중", {"change_id": waiting[0].change_id})
    if body.verify:                                       # 외부 호출은 쓰기 트랜잭션을 열기 전에
        try:
            await ga4.check_access(pid)
            verified = True
        except Ga4AccessError as e:
            if e.kind == "denied":
                raise errors.unprocessable("GA4 속성 읽기 권한 확인 실패(자격증명 계정의 속성 권한·속성 id 확인)", code="ga4_verify_failed",
                                           details={"property_id": pid}) from e
            if e.kind == "unconfigured":
                raise errors.unavailable("GA4 자격증명 설정 없음", code="ga4_unconfigured") from e
            raise errors.upstream("GA4 Data API 오류", code="upstream_ga4") from e
    mapped = body.brand_code is not None
    try:
        async with get_db().write(p.user_id) as rw:
            old = await fetch_one(rw, queries.PROP_LOCK_SQL, {"pid": pid})
            if mapped:
                await rw.execute(text(queries.MARKET_LOCK_SQL), {"brand": body.brand_code, "country": body.country_code})
                other = await fetch_one(rw, queries.MARKET_TAKEN_SQL, {"brand": body.brand_code, "country": body.country_code, "pid": pid})
                if other is not None:
                    raise errors.conflict("market_taken", "같은 브랜드·국가에 다른 GA4 속성이 이미 매핑돼 있다",
                                          {"property_id": other["property_id"]})
            same_map = old is not None and (old["brand_code"], old["country_code"]) == (body.brand_code, body.country_code)
            if not mapped:
                status = "unmapped"
            elif verified:
                status = "active"
            elif same_map and old["status"] != "unmapped":  # type: ignore[index]
                status = old["status"]  # type: ignore[index]
            else:
                status = "pending_grant"
            await rw.execute(text(queries.UPSERT_SQL), {"pid": pid, "brand": body.brand_code, "country": body.country_code,
                                                         "status": status, "verified": bool(verified)})
            cleared = mapped and bool(await fetch_all(rw, queries.MARKET_DELETE_SQL,
                                                      {"brand": body.brand_code, "country": body.country_code}))
            change_id = None
            if old is None or not same_map or old["status"] != status:
                change_id = await enqueue_change(rw, "ga4_property", subject_texts=[pid], payload={
                    "op": "upsert", "property_id": pid,
                    "old": None if old is None else {k: old[k] for k in ("brand_code", "country_code", "status")},
                    "new": {"brand_code": body.brand_code, "country_code": body.country_code, "status": status}})
            if not minimal:
                row = (await _app_rows(rw, pid=pid))[0]
                pend = (await _pending(rw, [pid])).get(pid, [])
    except DBAPIError as e:
        if errors.db_error_info(e)[0] == "23503":
            raise errors.unprocessable("알 수 없는 brand_code", code="unknown_brand", details={"field": "brand_code"}) from e
        raise (errors.from_db_error(e, messages=_DB_CODES, write=True) or e) from e
    prop: Ga4Property | None = None
    if row is not None:
        async with open_ro() as ro:                      # rd 투영(api_rw 는 rd 권한 없음)
            dim = (await _dims(ro, [pid])).get(pid)
        prop = _prop(row, dim, pend)
    return PropertyWritten(property=prop, verified=verified, change_id=change_id,
                           propagation="pending" if change_id is not None else "none", pending_market_cleared=cleared)


async def delete_property(rw: AsyncConnection, pid: str) -> PropertyDeleted:
    events = [r["event_name"] for r in await fetch_all(rw, queries.DELETE_EVENTS_SQL, {"pid": pid})]
    old = await fetch_one(rw, queries.DELETE_PROP_SQL, {"pid": pid})
    if old is None:
        raise errors.not_found("GA4 속성 없음")
    overrides = int((await fetch_one(rw, queries.OVERRIDE_COUNT_SQL, {"pid": pid}) or {"n": 0})["n"])
    change_id = await enqueue_change(rw, "ga4_property", subject_texts=[pid], payload={
        "op": "delete", "property_id": pid, "old": {**{k: old[k] for k in ("brand_code", "country_code", "status")},
                                                    "tracked_events": sorted(events)}, "new": None})
    return PropertyDeleted(property_id=pid, removed_tracked_events=len(events), project_overrides=overrides, change_id=change_id)


async def put_events(rw: AsyncConnection, pid: str, body: EventsPut) -> EventsWritten:
    if await fetch_one(rw, queries.PROP_LOCK_SQL, {"pid": pid}) is None:
        raise errors.not_found("GA4 속성 없음")
    old = [r["event_name"] for r in await fetch_all(rw, queries.TRACKED_SQL, {"pid": pid})]
    new = body.event_names
    if sorted(old) == new:
        return EventsWritten(property_id=pid, event_names=new, change_id=None, propagation="none")
    await rw.execute(text(queries.DELETE_EVENTS_SQL), {"pid": pid})
    if new:
        await rw.execute(text(queries.INSERT_EVENTS_SQL), {"pid": pid, "names": new})
    change_id = await enqueue_change(rw, "ga4_tracked_event", subject_texts=[pid], payload={
        "op": "replace", "property_id": pid, "old": sorted(old), "new": new})
    return EventsWritten(property_id=pid, event_names=new, change_id=change_id, propagation="pending")


# ── 속성 없는 시장(대기) ──
def _market(r: dict[str, Any]) -> PendingMarket:
    return PendingMarket(brand_code=r["brand_code"], country_code=r["country_code"], note=r["note"], updated_by=r["updated_by"],
                         updated_by_email=r["updated_by_email"], updated_at=r["updated_at"])


async def list_markets(ro: AsyncConnection, *, brand: str | None, country: str | None) -> list[PendingMarket]:
    return [_market(r) for r in await fetch_all(ro, queries.MARKETS_SQL, {"brand": brand, "country": country.upper() if country else None})]


async def get_market(ro: AsyncConnection, brand: str, country: str) -> PendingMarket:
    rows = await fetch_all(ro, queries.MARKETS_SQL, {"brand": brand, "country": country.upper()})
    if not rows:
        raise errors.not_found("대기 시장 없음")
    return _market(rows[0])


async def put_market(rw: AsyncConnection, brand: str, country: str, body: MarketPut) -> MarketWritten:
    cc = country.upper()
    await rw.execute(text(queries.MARKET_LOCK_SQL), {"brand": brand, "country": cc})
    taken = await fetch_one(rw, queries.MARKET_MAPPED_SQL, {"brand": brand, "country": cc})
    if taken is not None:
        raise errors.conflict("market_taken", "같은 브랜드·국가에 GA4 속성이 이미 매핑돼 있다", {"property_id": taken["property_id"]})
    try:
        row = await fetch_one(rw, queries.MARKET_UPSERT_SQL, {"brand": brand, "country": cc, "note": body.note})
    except DBAPIError as e:                               # 요청 트랜잭션은 RwConn 이 되돌린다
        if errors.db_error_info(e)[0] == "23503":
            raise errors.unprocessable("알 수 없는 brand_code", code="unknown_brand", details={"field": "brand_code"}) from e
        raise (errors.from_db_error(e, write=True) or e) from e
    return MarketWritten(market=await get_market(rw, brand, cc), created=bool(row and row["created"]))


async def delete_market(rw: AsyncConnection, brand: str, country: str) -> MarketDeleted:
    cc = country.upper()
    await rw.execute(text(queries.MARKET_LOCK_SQL), {"brand": brand, "country": cc})
    if not await fetch_all(rw, queries.MARKET_DELETE_SQL, {"brand": brand, "country": cc}):
        raise errors.not_found("대기 시장 없음")
    return MarketDeleted(brand_code=brand, country_code=cc)
