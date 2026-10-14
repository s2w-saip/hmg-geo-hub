"""projects.prompts.execute 업무 규칙(현행 prompt/_actions.ts executePrompts 이식, 동기 Scope 푸시 → outbox 비동기 전환).

한 트랜잭션: 프로젝트 단위 advisory 잠금(동시 실행 직렬화, 검증 D4) → 대상 행 FOR UPDATE → 행마다 발행 요청(publisher = outbox) → draft 를 queued 로. 대상 0 이면 409 nothing_to_execute.
publisher 가 실패하면 예외가 트랜잭션을 되돌린다(부분 발행·부분 전이 없음).
payload 의 scope_project_id 는 게이트 결과 core ProjectAccess.scope_project_id(링크 전 None: 워커가 프로젝트 링크 뒤로 미룬다).
기본 publisher(OutboxPublisher)는 대상 전부를 일괄 문장 2개 이하로 적재한다(_enqueue_creates: 행별 enqueue_scope 와 같은 행·payload·순서).
주입한 publisher(시험 가짜 등)는 종전처럼 행마다 부른다.
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import ProjectAccess
from app.core.contracts import check_outbox
from app.core.db import fetch_all

from . import queries as q
from .publisher import OutboxPublisher, ScopePublisher, payload_of
from .schemas import ExecuteResult


async def _enqueue_creates(rw: AsyncConnection, items: list[tuple[dict[str, Any], dict[str, Any]]]) -> None:
    """(대상 행, payload) 목록 → outbox(prompt:create). 행마다 core.write.enqueue_scope 를 부른 것과 같은 결과:
    미완료 create 가 있으면 가장 최근 그 행의 payload 를 바꾸고, 없으면 대상 순서대로 새 행. 문장은 병합 1(필요할 때만) + INSERT 1."""
    for _, pl in items:
        check_outbox("prompt", "create", pl)
    pls = {str(r["prompt_id"]): json.dumps(pl, default=str) for r, pl in items}
    merged: set[str] = set()
    pending = [str(r["prompt_id"]) for r, _ in items if r["pending"]]
    if pending:
        rows = await fetch_all(rw, q.OUTBOX_MERGE_CREATE_SQL, {"ids": pending, "pls": [pls[i] for i in pending]})
        merged = {str(x["aggregate_id"]) for x in rows}
    fresh = [str(r["prompt_id"]) for r, _ in items if str(r["prompt_id"]) not in merged]
    if fresh:
        await rw.execute(text(q.OUTBOX_INSERT_CREATE_SQL), {"ids": fresh, "pls": [pls[i] for i in fresh]})


async def execute(rw: AsyncConnection, acc: ProjectAccess, publisher: ScopePublisher) -> ExecuteResult:
    project_id = acc.project_id
    await rw.execute(text(q.EXECUTE_LOCK_SQL), {"pid": project_id})
    rows = await fetch_all(rw, q.TARGETS_SQL, {"pid": project_id})
    todo = [r for r in rows if r["status"] == "draft" or not r["pending"]]
    skipped = len(rows) - len(todo)
    if not todo:
        raise errors.conflict("nothing_to_execute", "실행할 프롬프트가 없다", {"skipped_pending": skipped})
    sp = acc.scope_project_id
    items = [(r, payload_of(r, project_id, sp, text=r["text"], kind=r["kind"], brand_code=r["brand_code"], category=r["category"],
                            lang=r["lang"], regions=list(r["regions"]) if r["regions"] is not None else None)) for r in todo]
    if isinstance(publisher, OutboxPublisher):
        await _enqueue_creates(rw, items)
    else:
        for r, pl in items:
            await publisher.publish(rw, "create", r["prompt_id"], pl)
    drafts = [str(r["prompt_id"]) for r in todo if r["status"] == "draft"]
    if drafts:
        await rw.execute(text(q.MARK_QUEUED_SQL), {"pid": project_id, "ids": drafts})
    return ExecuteResult(queued=len(todo), recovered=len(todo) - len(drafts), skipped_pending=skipped)
