"""Scope 반영 어댑터(주입 가능). 요청 경로는 Scope HTTP 를 부르지 않고 app.scope_outbox 에 적재만 한다(A10 변형, core.write 규약).

- 기본 구현 OutboxPublisher 는 core.write.enqueue_scope(같은 트랜잭션)로 한 행을 남긴다. 실제 Scope 호출·scope_prompt_id 회수는
  적재기 outbox 워커(loader 롤)가 한다.
- 테스트는 app.dependency_overrides[get_publisher] 로 가짜를 주입한다(실패 주입으로 트랜잭션 롤백을 확인).
- op 어휘(aggregate='prompt'): create(측정 발행) · disable(중지) · enable(재개) · delete(완전 삭제). payload 에 project_id 를 항상 싣는다.
- 토글 op(disable·enable)는 순서가 의미를 가진다. core.enqueue_scope 기본 동작은 같은 (aggregate, id, op) 미완료 행에 병합하므로
  pause→resume→pause 가 [disable(옛 id), enable] 로 남아 워커 순서 처리 시 최종 상태가 뒤집힌다(검증 D1).
  그래서 토글은 enqueue_scope(..., supersede=TOGGLE_OPS) 로 적재한다: 같은 프롬프트의 미완료 disable·enable 을 전부 superseded 로
  닫고(done_at=now(), last_error='superseded') 새 행을 넣는다. 결과: 미완료 토글은 항상 최신 1행이고 그 outbox_id 가 가장 크다
  (6라운드 core 반영, pj-prompts §7 처분. 워커 완료 표시는 done_at IS NULL 조건이라 superseded 를 덮지 않는다).
"""
from __future__ import annotations

import uuid
from typing import Any, Literal, Protocol

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.write import enqueue_scope

PromptOp = Literal["create", "disable", "enable", "delete"]
TOGGLE_OPS = ("disable", "enable")


class ScopePublisher(Protocol):
    async def publish(self, conn: AsyncConnection, op: PromptOp, prompt_id: uuid.UUID, payload: dict[str, Any]) -> int:
        """같은 트랜잭션에 Scope 반영 요청 1건을 남기고 식별자(outbox_id)를 돌려준다."""
        ...


class OutboxPublisher:
    async def publish(self, conn: AsyncConnection, op: PromptOp, prompt_id: uuid.UUID, payload: dict[str, Any]) -> int:
        # 토글은 미완료 토글을 닫고 항상 새 행(가장 큰 outbox_id), 그 밖 op 는 core 기본(같은 op 미완료 행에 병합)
        return await enqueue_scope(conn, "prompt", prompt_id, op, payload, supersede=TOGGLE_OPS if op in TOGGLE_OPS else ())


_default = OutboxPublisher()


def get_publisher() -> ScopePublisher:
    return _default


def payload_of(row: dict[str, Any], project_id: uuid.UUID, scope_project_id: uuid.UUID | None, **extra: Any) -> dict[str, Any]:
    """outbox payload(JSON). 워커가 Scope 요청을 조립할 수 있는 최소 필드."""
    d: dict[str, Any] = {
        "prompt_id": str(row["prompt_id"]),
        "project_id": str(project_id),
        "scope_project_id": str(scope_project_id) if scope_project_id else None,
        "scope_prompt_id": str(row["scope_prompt_id"]) if row.get("scope_prompt_id") else None,
    }
    d.update(extra)
    return d
