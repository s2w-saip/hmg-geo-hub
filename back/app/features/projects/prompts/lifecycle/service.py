"""projects.prompts.lifecycle 업무 규칙(현행 prompt/_actions.ts getPromptLifecycleImpact·pausePrompt·resumePrompt·deletePromptCascade 이식).

순서 불변식(현행 :222-230)은 outbox 순서로 옮겼다: Scope 중단·삭제는 워커가 outbox_id 순으로 처리하고, 로컬은 같은 트랜잭션에서 바뀐다.
- pause: status ∈ {queued, running, done, failed} 만(그 외 409 invalid_status). 공유 행 > 0 이면 409 shared_prompt.
  outbox(prompt:disable) + status='paused'(트리거가 enabled_changed 감사).
- resume: paused 만. outbox(prompt:enable) + status='done'(현행 :339). 단 Scope 미발행(scope_prompt_id NULL) 행은 'queued'
  로 되돌려 실행(execute)의 복구 대상이 되게 한다(현행은 done 으로 두어 재실행 경로가 막혔다).
- hard-delete: 공유 0 ∧ 발행 이력(scope_prompt_id 또는 draft 아님)이면 outbox(prompt:delete). 공유 > 0 이면 로컬만.
  로컬은 soft delete(deleted_at, 모듈-프로젝트 §2). 트리거가 'deleted' 감사 + judgment_change('catalog', 옛 scope_prompt_id)를
  남기고 적재기가 rd·ing 를 정리한다(B4).
- impact: rd 는 api_ro 로만 읽는다. scope_prompt_id NULL 이면 전부 0.
- outbox payload 의 scope_project_id 는 게이트 결과 core ProjectAccess.scope_project_id(링크 전 None: 워커가 app.project 에서 다시 채운다).
"""
from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import ProjectAccess
from app.core.codes import SURFACE_CODE
from app.core.cycles import CycleRow, build_window
from app.core.db import fetch_all, fetch_one, fetch_val
from app.features.projects.prompts.crud.common import count_shared, get_prompt, lock_prompt
from app.features.projects.prompts.execute.publisher import ScopePublisher, payload_of

from . import queries as q
from .schemas import LifecycleImpact, LifecycleResult

PAUSABLE = ("queued", "running", "done", "failed")
SF = SURFACE_CODE["project"]


async def impact(conn: AsyncConnection, acc: ProjectAccess, prompt_id: uuid.UUID) -> LifecycleImpact:
    row = await get_prompt(conn, acc.project_id, prompt_id)
    sp = row["scope_prompt_id"]
    shared = await count_shared(conn, sp, prompt_id)
    zero = LifecycleImpact(prompt_id=prompt_id, published=sp is not None, answers=0, mentions=0, citations=0, shared_rows=shared)
    if sp is None or not acc.project_keys:
        return zero
    pks = list(acc.project_keys)
    pk = await fetch_val(conn, q.PROMPT_KEY_SQL, {"sp": sp, "sf": SF, "pks": pks})
    if pk is None:
        return zero
    cyc = [CycleRow(int(r["cyc_key"]), int(r["project_key"]), r["round_date"], 0)
           for r in await fetch_all(conn, q.CYCLES_SQL, {"sf": SF, "pks": pks})]
    if not cyc:
        return zero
    w = build_window(surface="project", mode="cumulative", rows=cyc, lo=min(c.round_date for c in cyc),
                     hi=max(c.round_date for c in cyc), generation=None, project_keys=acc.project_keys)
    sql, params = q.impact_sql(w, int(pk), acc.project_keys)
    r = await fetch_one(conn, sql, params)
    assert r is not None
    return LifecycleImpact(prompt_id=prompt_id, published=True, answers=int(r["answers"]), mentions=int(r["mentions"]),
                           citations=int(r["citations"]), shared_rows=shared)


async def pause(rw: AsyncConnection, acc: ProjectAccess, prompt_id: uuid.UUID, publisher: ScopePublisher) -> LifecycleResult:
    project_id = acc.project_id
    row = await lock_prompt(rw, project_id, prompt_id)
    if row["status"] not in PAUSABLE:
        raise errors.conflict("invalid_status", "측정 중인 프롬프트만 중지할 수 있다", {"status": row["status"]})
    shared = await count_shared(rw, row["scope_prompt_id"], prompt_id)
    if shared > 0:
        raise errors.conflict("shared_prompt", "다른 행과 측정을 공유하는 프롬프트는 개별로 중지할 수 없다", {"shared_rows": shared})
    oid = await publisher.publish(rw, "disable", prompt_id, payload_of(row, project_id, acc.scope_project_id))
    await rw.execute(text(q.PAUSE_SQL), {"pid": project_id, "id": prompt_id})
    return LifecycleResult(prompt_id=prompt_id, status="paused", propagation="pending", outbox_id=oid)


async def resume(rw: AsyncConnection, acc: ProjectAccess, prompt_id: uuid.UUID, publisher: ScopePublisher) -> LifecycleResult:
    project_id = acc.project_id
    row = await lock_prompt(rw, project_id, prompt_id)
    if row["status"] != "paused":
        raise errors.conflict("invalid_status", "측정 중지된 프롬프트만 재개할 수 있다", {"status": row["status"]})
    oid = await publisher.publish(rw, "enable", prompt_id, payload_of(row, project_id, acc.scope_project_id))
    new_status = "done" if row["scope_prompt_id"] is not None else "queued"
    await rw.execute(text(q.RESUME_SQL), {"pid": project_id, "id": prompt_id, "st": new_status})
    return LifecycleResult(prompt_id=prompt_id, status=new_status, propagation="pending", outbox_id=oid)


async def hard_delete(rw: AsyncConnection, acc: ProjectAccess, prompt_id: uuid.UUID, publisher: ScopePublisher) -> LifecycleResult:
    project_id = acc.project_id
    row = await lock_prompt(rw, project_id, prompt_id)
    shared = await count_shared(rw, row["scope_prompt_id"], prompt_id)
    oid: int | None = None
    if shared == 0 and (row["scope_prompt_id"] is not None or row["status"] != "draft"):
        oid = await publisher.publish(rw, "delete", prompt_id, payload_of(row, project_id, acc.scope_project_id,
                                                                          was_paused=row["status"] == "paused"))
    await rw.execute(text(q.SOFT_DELETE_SQL), {"pid": project_id, "id": prompt_id})
    return LifecycleResult(prompt_id=prompt_id, status=row["status"], deleted=True, shared_rows=shared,
                           propagation="pending" if oid is not None else "none", outbox_id=oid)
