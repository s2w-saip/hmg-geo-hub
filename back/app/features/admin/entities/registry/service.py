"""admin.entities.registry 업무 규칙(AD-2).

읽기(G-18 a·G-23 a, 모듈-관리자 §2.3)
- 기간 필수 규칙: from/to 가 없으면 최신 노출 회차(함대 스냅샷, core.cycles.resolve_window). 기간은 366일 이하(초과 422).
- 커넥션 하나에서 창 해석(resolve_window, rd.today_kst())과 집계를 같이 한다(같은 스냅샷: 두 풀 모두 READ ONLY REPEATABLE READ).
  기본 창(최신 노출 회차 1개) = 요청 공용 api_ro(5초). 기간(from·to)을 주면 = admin_long(30초, Q16 1초 SLO 제외) 트랜잭션 하나.
  admin_long 의 rd.today_kst() 실행 권한은 DB-v2.6 P46. meta.source.pool 로 어느 풀에서 셌는지 드러낸다.
- 수치 = 엔티티별 전 기간 합계(rd.entity_mention_total, 운영 listDiscoveredBrands 정의). 창·게이트와 무관하고 meta.source.count_grain
  = 'entity_all_time' 으로 드러낸다.
- 관리자는 전량을 본다(스코프 교집합 없음). 공통 필터 중 지원 축은 없다(surface·period 는 이 엔드포인트의 필수·기간 인자).
- 유효 귀속(own_brand) = versions.service.active_own_brands(활성 버전 스냅샷은 버전 키로 메모, B083). own_brand=False(fields=names,
  이름·유형만 쓰는 검토함 병합 후보, B088)면 판정하지 않는다(null). 행·순서·수치·커서는 같다.

쓰기(판정 입력: 전 화면 당사 판정의 원천)
- own·excluded = app.entity_registry upsert, competitor = 행 삭제(파생 기본값). 같은 트랜잭션에서
  core.write.enqueue_change('entity', subject_uuids=[entity_id], payload{op, entity_id, old, new}). 같은 엔티티의 대기 중 요청이
  있으면 409 duplicate_pending(쓰기 전체 롤백). rd 반영(dim_brand_name.own_bit·dim_entity.registry_role·leaf 재구축)은 적재기가 비동기로 한다.
- 컷오버 뒤(활성 app.ecat_version 있음): PUT 은 409 ECAT_LEGACY_WRITE(쓰기 0). 명부는 활성 버전의 투영이고 편집은 초안(admin.entities.versions, E6).
  컷오버 전(버전 없음)은 위 동작 그대로.
"""
from __future__ import annotations

import uuid
from datetime import date
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.codes import SURFACE_CODE
from app.core.cycles import Window, resolve_window
from app.core.db import fetch_all, fetch_one, get_db
from app.core.envelope import Page
from app.core.pagination import clamp_limit, decode_cursor, fetch_keyset, filter_hash, keyset_page, keyset_predicate
from app.core.sqlb import Binder
from app.core.write import enqueue_change
from app.features.admin.catalog.prompts.admin_common import brand_codes, clean_text, like_pattern
from app.features.admin.entities.registry import queries as q
from app.features.admin.entities.registry.schemas import EntityList, EntityRow, RoleBody, RoleResult
from app.features.admin.entities.versions.dberr import ecat_db_errors

MAX_SPAN_DAYS = 366
FAMILY = "mentions"
# 수치 정의(5차 항목 1, B안·결정 25): 운영 listDiscoveredBrands 그대로(전 기간·게이트 없음, rd.entity_mention_total). 이전 결정(메인 2026-09-28
# 게이트 std_in ∧ dflt·창 집계, mig.known_diff 'AD-2')은 이 지시로 대체됐다(AD-2 행은 DB-v2.25 P137 이 지운다). 창(win)은 키셋 커서 세대·meta 에만 쓴다.


def check_period(date_from: date | None, date_to: date | None) -> None:
    if (date_from is None) != (date_to is None):
        raise errors.unprocessable("from·to 는 둘 다 주거나 둘 다 생략", details={"field": "from"})
    if date_from is not None and date_to is not None:
        if date_from > date_to:
            raise errors.unprocessable("from ≤ to", details={"field": "from"})
        if (date_to - date_from).days + 1 > MAX_SPAN_DAYS:
            raise errors.unprocessable(f"기간은 {MAX_SPAN_DAYS}일 이하", code="period_too_long", details={"field": "to"})


async def window_for(ro: AsyncConnection, surface: str, date_from: date | None, date_to: date | None) -> Window:
    rows = await fetch_all(ro, q.PROJECT_KEYS_SQL, {"sf": SURFACE_CODE[surface]})
    return await resolve_window(ro, surface=surface, project_keys=tuple(int(r["project_key"]) for r in rows),
                                date_from=date_from, date_to=date_to)


def list_sql(win: Window, *, role: str | None, q_text: str | None, sort: str, cursor: Any, limit: int) -> tuple[str, dict[str, Any]]:
    cols, dir_, _, _ = q.SORTS[sort]
    b = Binder()
    outer = ["true"]
    if role:
        outer.append(f"x.role = {b.v(role)}")
    if q_text:
        outer.append(f"x.name ILIKE {b.v(like_pattern(q_text))}")
    kp = keyset_predicate(list(cols), dir_, cursor, b)
    if kp:
        outer.append(kp)
    order = ", ".join(f"{c} {dir_.upper()}" for c in cols)
    sql = q.LIST_TEMPLATE.format(outer=" AND ".join(outer), order=order, limit=b.v(limit + 1, "int4"))
    return sql, b.params


async def list_entities(ro: AsyncConnection, *, surface: str, date_from: date | None, date_to: date | None, role: str | None,
                        q_text: str | None, sort: str, cursor: str | None, limit: int | None,
                        own_brand: bool = True) -> tuple[EntityList, Window, Page, str]:
    """(목록, 창, 페이지, 풀 이름). 기본 창은 요청 공용 api_ro, 기간을 주면 admin_long 트랜잭션 하나에서 창 해석·집계.
    own_brand=False = 유효 귀속 판정 생략(own_brand null, fields=names)."""
    check_period(date_from, date_to)
    n = clamp_limit(limit, default=100)
    args = {"surface": surface, "date_from": date_from, "date_to": date_to, "role": role, "q_text": q_text, "sort": sort,
            "cursor": cursor, "n": n, "own_brand": own_brand}
    if date_from is None:
        data, win, page = await _list_on(ro, **args)
        return data, win, page, "api_ro"
    async with get_db().read("admin_long") as conn:
        data, win, page = await _list_on(conn, **args)
    return data, win, page, "admin_long"


async def _list_on(conn: AsyncConnection, *, surface: str, date_from: date | None, date_to: date | None, role: str | None,
                   q_text: str | None, sort: str, cursor: str | None, n: int, own_brand: bool) -> tuple[EntityList, Window, Page]:
    win = await window_for(conn, surface, date_from, date_to)
    cols, dir_, types, keys = q.SORTS[sort]
    fh = filter_hash({"s": surface, "f": date_from, "t": date_to, "role": role, "q": q_text})
    cur = decode_cursor(cursor, sort=sort, dir=dir_, fh=fh, types=types, generation=win.generation)
    sql, params = list_sql(win, role=role, q_text=q_text, sort=sort, cursor=cur, limit=n)
    rows = await fetch_keyset(conn, sql, params)
    page, nxt = keyset_page(rows, n, lambda r: [r[k] for k in keys], sort=sort, dir=dir_, fh=fh, generation=win.generation)
    # 유효 귀속 = 드로어와 같은 RollupRule 판정(검증 5차 CE25). 함수 안 import = 순환 회피(versions 가 registry 를 쓴다)
    from app.features.admin.entities.versions.service import active_own_brands

    own = await active_own_brands(conn, [r["entity_id"] for r in page]) if own_brand else {}
    items = [EntityRow(entity_id=r["entity_id"], entity_type=r["entity_type"], name=r["name"], brand_name=r["brand_name"],
                       role=r["role"], brand_code=r["brand_code"], registered=r["registered"], answers=int(r["answers"]),
                       mentions=int(r["mentions"]), updated_at=r["updated_at"], own_brand=own.get(str(r["entity_id"]))) for r in page]
    return EntityList(items=items), win, Page(next_cursor=nxt, limit=n)


def _state(r: dict[str, Any] | None) -> dict[str, Any] | None:
    return None if r is None else {"role": r["role"], "brand_code": r["brand_code"], "name": r["name"]}


async def set_role(ro: AsyncConnection, rw: AsyncConnection, entity_id: uuid.UUID, body: RoleBody) -> RoleResult:
    if await fetch_one(rw, q.ACTIVE_ECAT_SQL) is not None:
        # 컷오버(v1 이관) 뒤 명부는 활성 엔티티 버전의 투영이다(DB-v2.17 P98 가드 ECAT_LEGACY_WRITE). 편집 = 초안(admin.entities.versions)
        raise errors.conflict("ECAT_LEGACY_WRITE", "엔티티 버전 관리로 전환됐다: 초안 편집(/v1/admin/entities/versions)으로 바꾸고 반영한다",
                              {"use": "/v1/admin/entities/versions"})
    dim = await fetch_one(ro, q.DIM_ENTITY_SQL, {"id": entity_id})
    reg = await fetch_one(rw, q.LOCK_REGISTRY_SQL, {"id": entity_id})
    if dim is None and reg is None:
        raise errors.not_found("엔티티 없음")
    old = _state(reg)
    if body.role == "competitor":
        new = None
    else:
        brand = clean_text(body.brand_code, field="brand_code", max_len=100)
        if brand is not None:
            known = await brand_codes(ro)
            if brand not in known or known[brand]:
                raise errors.unprocessable("알 수 없는 브랜드이거나 엄브렐러", code="invalid_brand", details={"field": "brand_code"})
        if body.role == "own" and brand is None:
            raise errors.unprocessable("own 은 brand_code 필수", code="brand_required", details={"field": "brand_code"})
        name = clean_text(body.name, field="name", max_len=300) or (reg["name"] if reg else None) or (dim["rep_name"] if dim else None)
        if not name:
            raise errors.unprocessable("등재명 필요", code="name_required", details={"field": "name"})
        new = {"role": body.role, "brand_code": brand, "name": name}
    if old == new:
        return RoleResult(entity_id=entity_id, name=(new or old or {}).get("name"), role=body.role,
                          brand_code=(new or {}).get("brand_code"), applied=False, propagation="none")
    with ecat_db_errors():                                     # 가드 경쟁(검사 뒤 이관) = 409 ECAT_LEGACY_WRITE
        if new is None:
            await fetch_one(rw, q.DELETE_SQL, {"id": entity_id})
        else:
            await fetch_one(rw, q.UPSERT_SQL, {"id": entity_id, **new})
    change_id = await enqueue_change(rw, "entity", subject_uuids=[entity_id],
                                     payload={"op": "delete" if new is None else "upsert", "entity_id": str(entity_id),
                                              "old": old, "new": new})
    return RoleResult(entity_id=entity_id, name=(new or old or {}).get("name"), role=body.role,
                      brand_code=(new or {}).get("brand_code"), applied=True, change_id=change_id, propagation="pending",
                      warnings=["full_rebuild"])
