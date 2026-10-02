"""projects.settings.owned_bases 업무 규칙(PJ-4). 현행 addProjectOwnedBaseAction·removeProjectOwnedBaseAction(setting/_actions.ts:586·612) 이식.

활성 Owner 또는 admin. 한 트랜잭션: owned base 추가·삭제 → 대표 도메인 재동기화(shared.resync_project_domain; 값이 바뀌면
app.project 트리거가 'project_setting' 을 남긴다) → judgment_change('project_owned_base', core.write.enqueue_change: Q5 재판정)
→ 도메인이 바뀌었으면 outbox(project:update).
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal
from app.core.db import fetch_one
from app.core.urls import canonical_http_url, normalize_url_for_match
from app.core.write import enqueue_change
from app.features.projects.project.core.shared import (
    JUDGMENT_DEDUPE,
    enqueue_project_update,
    project_access,
    resync_project_domain,
)
from app.features.projects.settings.owned_bases import queries as Q


async def _after_change(rw: AsyncConnection, project_id: uuid.UUID, before_domain: str | None, op: str, norm: str
                        ) -> tuple[str | None, int]:
    domain = await resync_project_domain(rw, project_id)
    # 매 편집 1행(대기 행 합치기를 쓰지 않는 이유: shared.JUDGMENT_DEDUPE 주석)
    change_id = await enqueue_change(rw, "project_owned_base", subject_uuids=[project_id],
                                     payload={"op": op, "project_id": str(project_id), "base_norm": norm}, dedupe=JUDGMENT_DEDUPE)
    if domain != before_domain:
        await enqueue_project_update(rw, project_id)
    return domain, change_id


async def add(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, base_url: str, label: str | None
              ) -> dict[str, Any]:
    await project_access(ro, p, project_id, "owner")
    url = canonical_http_url(base_url, field="base_url")
    norm = normalize_url_for_match(url)
    if not norm:
        raise errors.unprocessable("owned base 형식 오류", code="invalid_url", details={"field": "base_url"})
    before = await fetch_one(rw, Q.DOMAIN, {"pid": project_id})
    if before is None:
        raise errors.not_found("프로젝트 없음")
    row = await fetch_one(rw, Q.INSERT, {"pid": project_id, "url": url, "norm": norm, "label": (label or "").strip() or None,
                                         "uid": p.user_id})
    if row is None:
        raise errors.conflict("duplicate_owned_base", "이미 등록된 owned base", {"base_norm": norm})
    domain, change_id = await _after_change(rw, project_id, before["domain"], "add", norm)
    return {"owned_base": row, "base_norm": norm, "domain": domain, "change_id": change_id}


async def remove(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, base_norm: str) -> dict[str, Any]:
    await project_access(ro, p, project_id, "owner")
    before = await fetch_one(rw, Q.DOMAIN, {"pid": project_id})
    if before is None:
        raise errors.not_found("프로젝트 없음")
    r = await fetch_one(rw, Q.DELETE, {"pid": project_id, "norm": base_norm})
    if r is None:
        raise errors.not_found("owned base 없음", code="owned_base_not_found")
    domain, change_id = await _after_change(rw, project_id, before["domain"], "remove", base_norm)
    return {"owned_base": None, "base_norm": base_norm, "domain": domain, "change_id": change_id}
