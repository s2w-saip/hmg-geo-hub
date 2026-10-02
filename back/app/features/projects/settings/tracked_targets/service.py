"""projects.settings.tracked_targets 업무 규칙(PJ-4). 현행 setting/_actions.ts 추적 대상 액션(:466~584)과 updateProject 의
브랜드 별칭 분기(:265-292) 이식. 활성 Owner 또는 admin.

- 별칭·경쟁사·차종 쓰기 → shared.rebuild_tracked_brand(추적 브랜드 정본 재구성) → judgment_change('project_setting',
  core.write.enqueue_change: 트리거 대상 밖 판정 입력은 앱이 같은 트랜잭션에서 넣는다, Q3·전체-통합 채택 5).
- 비교 기준 브랜드(is_target) 지정은 집계 시점 설정이라 재판정 없음(현행 :507-519).
- 현행 flagPromptsForReanalysis(needs_reanalysis 열)는 DB-v2 에 없어 폐기, 응답은 change_id 로 대체(모듈 consistency_fixes[8]).
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal
from app.core.db import fetch_one
from app.core.write import enqueue_change
from app.features.projects.project.core.shared import JUDGMENT_DEDUPE, clean_aliases, project_access, rebuild_tracked_brand
from app.features.projects.settings.tracked_targets import queries as Q


def aliases_without_canonical(canonical: str, aliases: list[str] | None) -> list[str]:
    return [a for a in (aliases or []) if a != canonical]


async def _lock_brand(rw: AsyncConnection, project_id: uuid.UUID) -> str | None:
    r = await fetch_one(rw, Q.LOCK_PROJECT, {"pid": project_id})
    if r is None:
        raise errors.not_found("프로젝트 없음")
    return r["brand_code"]


async def _rebuild_and_enqueue(rw: AsyncConnection, project_id: uuid.UUID, op: str, detail: dict[str, Any]) -> dict[str, Any]:
    brands = await rebuild_tracked_brand(rw, project_id)
    # 매 편집 1행(대기 행 합치기를 쓰지 않는 이유: shared.JUDGMENT_DEDUPE 주석)
    cid = await enqueue_change(rw, "project_setting", subject_uuids=[project_id],
                               payload={"op": op, "project_id": str(project_id), "source": "tracked_targets", **detail},
                               dedupe=JUDGMENT_DEDUPE)
    return {"tracked_brands": [b["canonical_name"] for b in brands], "change_id": cid, "propagation": "pending"}


def _nonblank(v: str, field: str) -> str:
    s = (v or "").strip()
    if not s:
        raise errors.unprocessable(f"{field} 를 입력해야 한다", code="required", details={"field": field})
    return s


async def put_brand_aliases(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, brand_code: str,
                            aliases: list[str]) -> dict[str, Any]:
    await project_access(ro, p, project_id, "owner")
    current = await _lock_brand(rw, project_id)
    if current is None:
        raise errors.conflict("no_project_brand", "브랜드가 없는 프로젝트에는 별칭을 둘 수 없다")
    if brand_code.strip() != current:          # 화면이 본 브랜드와 지금 브랜드가 다르면(동시 변경) 반영하지 않는다(현행 :268-270)
        raise errors.conflict("brand_mismatch", "프로젝트 브랜드가 바뀌었다: 다시 불러온 뒤 저장", {"brand_code": current})
    al = clean_aliases(aliases)
    if al:
        await rw.execute(text(Q.UPSERT_BRAND), {"pid": project_id, "name": current, "aliases": al})
    else:
        await rw.execute(text(Q.DELETE_BRAND), {"pid": project_id, "name": current})
    out = await _rebuild_and_enqueue(rw, project_id, "brand_aliases", {"brand_code": current})
    row = await fetch_one(rw, Q.BRAND_ROW, {"pid": project_id, "name": current})
    out["brand_aliases"] = {"brand_code": current, "aliases": aliases_without_canonical(current, row["aliases"] if row else [])}
    return out


async def add_competitor(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, body: Any) -> dict[str, Any]:
    await project_access(ro, p, project_id, "owner")
    name = _nonblank(body.brand_name, "brand_name")
    await _lock_brand(rw, project_id)
    row = await fetch_one(rw, Q.INSERT_COMPETITOR, {"pid": project_id, "name": name, "aliases": clean_aliases(body.aliases),
                                                    "notes": (body.notes or "").strip() or None})
    if row is None:
        raise errors.conflict("duplicate_competitor", "이미 추가된 브랜드", {"brand_name": name})
    out = await _rebuild_and_enqueue(rw, project_id, "competitor_add", {"brand_name": name})
    out["competitor"] = row
    return out


async def remove_competitor(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, brand_name: str
                            ) -> dict[str, Any]:
    await project_access(ro, p, project_id, "owner")
    await _lock_brand(rw, project_id)
    if await fetch_one(rw, Q.DELETE_COMPETITOR, {"pid": project_id, "name": brand_name}) is None:
        raise errors.not_found("경쟁 브랜드 없음", code="competitor_not_found")
    return await _rebuild_and_enqueue(rw, project_id, "competitor_remove", {"brand_name": brand_name})


async def set_target(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, brand_name: str | None
                     ) -> dict[str, Any]:
    await project_access(ro, p, project_id, "owner")
    await _lock_brand(rw, project_id)
    await rw.execute(text(Q.CLEAR_TARGET), {"pid": project_id})
    name = (brand_name or "").strip() or None
    if name is not None and await fetch_one(rw, Q.SET_TARGET, {"pid": project_id, "name": name}) is None:
        raise errors.not_found("경쟁 브랜드 없음", code="competitor_not_found")      # 롤백 = 이전 지정 유지
    return {"target_brand": name, "change_id": None, "propagation": "none"}


async def add_vehicle(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, body: Any) -> dict[str, Any]:
    await project_access(ro, p, project_id, "owner")
    brand, model = _nonblank(body.brand, "brand"), _nonblank(body.model, "model")
    project_brand = await _lock_brand(rw, project_id)
    row = await fetch_one(rw, Q.INSERT_VEHICLE, {"pid": project_id, "brand": brand, "model": model,
                                                 "segment": (body.segment or "").strip() or None, "aliases": clean_aliases(body.aliases)})
    if row is None:
        raise errors.conflict("duplicate_vehicle", "이미 추가된 모델", {"brand": brand, "model": model})
    if brand != project_brand:               # 차종 브랜드를 경쟁 브랜드 목록에도 자동 등록(프로젝트 브랜드 제외, 현행 :544-561)
        await rw.execute(text(Q.AUTO_COMPETITOR), {"pid": project_id, "name": brand})
    out = await _rebuild_and_enqueue(rw, project_id, "vehicle_add", {"brand": brand, "model": model})
    out["vehicle"] = row
    return out


async def remove_vehicle(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, brand: str, model: str
                         ) -> dict[str, Any]:
    await project_access(ro, p, project_id, "owner")
    await _lock_brand(rw, project_id)
    if await fetch_one(rw, Q.DELETE_VEHICLE, {"pid": project_id, "brand": brand, "model": model}) is None:
        raise errors.not_found("추적 차종 없음", code="vehicle_not_found")
    return await _rebuild_and_enqueue(rw, project_id, "vehicle_remove", {"brand": brand, "model": model})
