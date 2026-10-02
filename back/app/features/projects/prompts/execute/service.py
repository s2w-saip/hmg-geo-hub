"""projects.prompts.execute 업무 규칙(현행 prompt/_actions.ts executePrompts 이식, 동기 Scope 푸시 → outbox 비동기 전환).

한 트랜잭션: 프로젝트 단위 advisory 잠금(동시 실행 직렬화, 검증 D4) → 대상 행 FOR UPDATE → 행마다 발행 요청(publisher = outbox) → draft 를 queued 로. 대상 0 이면 409 nothing_to_execute.
publisher 가 실패하면 예외가 트랜잭션을 되돌린다(부분 발행·부분 전이 없음).
payload 의 scope_project_id 는 게이트 결과 core ProjectAccess.scope_project_id(링크 전 None: 워커가 프로젝트 링크 뒤로 미룬다).
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import ProjectAccess
from app.core.db import fetch_all

from . import queries as q
from .publisher import ScopePublisher, payload_of
from .schemas import ExecuteResult


async def execute(rw: AsyncConnection, acc: ProjectAccess, publisher: ScopePublisher) -> ExecuteResult:
    project_id = acc.project_id
    await rw.execute(text(q.EXECUTE_LOCK_SQL), {"pid": project_id})
    rows = await fetch_all(rw, q.TARGETS_SQL, {"pid": project_id})
    todo = [r for r in rows if r["status"] == "draft" or not r["pending"]]
    skipped = len(rows) - len(todo)
    if not todo:
        raise errors.conflict("nothing_to_execute", "실행할 프롬프트가 없다", {"skipped_pending": skipped})
    sp = acc.scope_project_id
    for r in todo:
        await publisher.publish(rw, "create", r["prompt_id"], payload_of(
            r, project_id, sp, text=r["text"], kind=r["kind"], brand_code=r["brand_code"], category=r["category"], lang=r["lang"],
            regions=list(r["regions"]) if r["regions"] is not None else None))
    drafts = [str(r["prompt_id"]) for r in todo if r["status"] == "draft"]
    if drafts:
        await rw.execute(text(q.MARK_QUEUED_SQL), {"pid": project_id, "ids": drafts})
    return ExecuteResult(queued=len(todo), recovered=len(todo) - len(drafts), skipped_pending=skipped)
