"""projects.settings.overview 업무 규칙(PJ-4). 활성 멤버 또는 admin(비멤버 404). 한 api_ro 스냅샷에서 설정 묶음을 읽는다."""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal, can_operate_project
from app.core.db import fetch_all, fetch_one, fetch_val
from app.features.projects.project.core.shared import default_engines, engine_vocab, project_access
from app.features.projects.settings.overview import queries as Q
from app.features.projects.settings.tracked_targets.service import aliases_without_canonical


async def bundle(ro: AsyncConnection, p: Principal, project_id: uuid.UUID) -> dict[str, Any]:
    acc, refs = await project_access(ro, p, project_id, "active_member")
    pr = await fetch_one(ro, Q.PROJECT, {"pid": project_id})
    if pr is None:
        raise errors.not_found("프로젝트 없음")
    stored = list(pr["ai_engines"]) if pr["ai_engines"] is not None else None
    brand = pr["brand_code"]
    alias_row = await fetch_one(ro, Q.BRAND_ROW, {"pid": project_id, "name": brand}) if brand else None
    can_edit = p.is_admin or acc.member_role == "owner"
    # 엔진 변경은 Owner ∧ 운영자(core resolve_project 'owner_and_operate')라 설정 편집 권한과 따로 알린다(검증 D6)
    can_edit_engines = can_edit and can_operate_project(p, acc.member_role is not None)
    return {
        "project_id": project_id, "domain": pr["domain"], "my_role": acc.member_role,
        "can_edit": can_edit,
        "engines": {"stored": stored, "effective": stored if stored is not None else await default_engines(ro), "allowed": engine_vocab(refs),
                    "can_edit": can_edit_engines},
        "owned_bases": await fetch_all(ro, Q.OWNED_BASES, {"pid": project_id}),
        "brand_aliases": {"brand_code": brand, "aliases": aliases_without_canonical(brand, alias_row["aliases"]) if alias_row else []},
        "competitors": await fetch_all(ro, Q.LIST_COMPETITORS, {"pid": project_id}),
        "vehicles": await fetch_all(ro, Q.LIST_VEHICLES, {"pid": project_id}),
        "tracked_url_count": int(await fetch_val(ro, Q.TRACKED_URL_COUNT, {"pid": project_id}) or 0),
    }
