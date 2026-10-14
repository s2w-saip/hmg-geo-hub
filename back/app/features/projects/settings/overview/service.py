"""projects.settings.overview 업무 규칙(PJ-4). 활성 멤버 또는 admin(비멤버 404). 한 api_ro 스냅샷에서 설정 묶음을 읽는다.

문장 수: 접근 판정(core resolve_project) 뒤 프로젝트 행·추적 URL 건수·자사 브랜드 별칭 행·기본 엔진을 한 문장(PROJECT_BUNDLE)으로 읽고,
목록 표(owned base·경쟁사·차종)만 따로 읽는다. view=card(홈 KPI 카드)는 카드가 쓰는 값만: 차종·별칭·엔진은 읽지 않고(null),
경쟁사는 지정 비교 브랜드(is_target) 행만.
"""
from __future__ import annotations

import uuid
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal, can_operate_project
from app.core.db import fetch_all, fetch_one
from app.features.projects.project.core.shared import engine_vocab, project_access
from app.features.projects.settings.overview import queries as Q
from app.features.projects.settings.tracked_targets.queries import COMP_COLS
from app.features.projects.settings.tracked_targets.service import aliases_without_canonical

BundleView = Literal["full", "card"]

# 프로젝트 행 + 추적 URL 건수(tracked_urls COUNT) + 자사 브랜드 별칭 행(tracked_targets BRAND_ROW) + 기본 엔진(shared.default_engines)을 한 문장으로.
# 각 스칼라 하위 질의는 PK 1행 조회(project_tracked_url 은 PK 접두 범위 count).
PROJECT_BUNDLE = """
SELECT p.domain, p.brand_code, p.ai_engines,
       (SELECT count(*) FROM app.project_tracked_url u WHERE u.project_id = p.project_id) AS tracked_url_count,
       (SELECT b.aliases FROM app.project_tracked_brand b WHERE b.project_id = p.project_id AND b.canonical_name = p.brand_code)
         AS brand_aliases,
       (SELECT r.value FROM app.rule_param r WHERE r.key = 'default_engines') AS default_engines
  FROM app.project p WHERE p.project_id = :pid
"""

TARGET_COMPETITOR = f"SELECT {COMP_COLS} FROM app.project_tracked_competitor c WHERE c.project_id = :pid AND c.is_target ORDER BY c.brand_name"


def _engines_value(v: Any) -> list[str]:
    """app.rule_param default_engines 값 → 엔진 코드 목록(shared.default_engines 와 같은 해석)."""
    return [str(x) for x in v] if isinstance(v, list) else []


async def bundle(ro: AsyncConnection, p: Principal, project_id: uuid.UUID, view: BundleView = "full") -> dict[str, Any]:
    acc, refs = await project_access(ro, p, project_id, "active_member")
    pr = await fetch_one(ro, PROJECT_BUNDLE, {"pid": project_id})
    if pr is None:
        raise errors.not_found("프로젝트 없음")
    can_edit = p.is_admin or acc.member_role == "owner"
    out: dict[str, Any] = {
        "project_id": project_id, "domain": pr["domain"], "my_role": acc.member_role,
        "can_edit": can_edit,
        "owned_bases": await fetch_all(ro, Q.OWNED_BASES, {"pid": project_id}),
        "tracked_url_count": int(pr["tracked_url_count"] or 0),
    }
    if view == "card":
        out.update(engines=None, brand_aliases=None, vehicles=None,
                   competitors=await fetch_all(ro, TARGET_COMPETITOR, {"pid": project_id}))
        return out
    stored = list(pr["ai_engines"]) if pr["ai_engines"] is not None else None
    brand = pr["brand_code"]
    # 엔진 변경은 Owner ∧ 운영자(core resolve_project 'owner_and_operate')라 설정 편집 권한과 따로 알린다(검증 D6)
    can_edit_engines = can_edit and can_operate_project(p, acc.member_role is not None)
    out.update(
        engines={"stored": stored, "effective": stored if stored is not None else _engines_value(pr["default_engines"]),
                 "allowed": engine_vocab(refs), "can_edit": can_edit_engines},
        brand_aliases={"brand_code": brand,
                       "aliases": aliases_without_canonical(brand, pr["brand_aliases"]) if brand and pr["brand_aliases"] is not None else []},
        competitors=await fetch_all(ro, Q.LIST_COMPETITORS, {"pid": project_id}),
        vehicles=await fetch_all(ro, Q.LIST_VEHICLES, {"pid": project_id}),
    )
    return out
