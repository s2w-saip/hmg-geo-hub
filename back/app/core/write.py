"""쓰기 공용: 재판정·운영 요청 큐(enqueue_change), Scope 아웃박스(enqueue_scope),
접근 감사(access_audit: 민감 조회만 비동기 배치, Q4). 계정 감사는 DB 트리거가 한다(아래 주석).

사용 규칙
- 쓰기 라우터는 RwConn(= Depends(get_rw_conn)) 하나로 app 만 쓴다. 트랜잭션 시작 시 app.actor_id 가 심겨 있다(app.actor()).
- rd·ing 는 쓰지 않는다. 판정 입력이 바뀌면 같은 트랜잭션에서 enqueue_change 로 app.judgment_change 한 행을 남긴다
  (예외: app.project 4열·app.prompt 는 DB 트리거가 남긴다: 'catalog'·'prompt_kind' 와 트리거 소관 'project_setting' 을 앱이 직접 넣지 않는다).
- Scope 반영이 필요한 변경은 같은 트랜잭션에서 enqueue_scope(app.scope_outbox). 외부 호출은 워커가 한다(요청 경로에서 Scope API 금지).
- 접근 감사는 kind data_access·download·scope_call 만(api_read 기록 안 함). 응답을 기다리게 하지 않고 api_rw 배치로 쓴다.
  프로세스 크래시 시 수 초분 유실 허용(Q4). app.access_audit_log 는 월 파티션이라 적재기 월간 잡이 leaf 를 미리 만든다.
  계정 없는 검수자(Q17)는 access_audit_qa(actor_id = 검수 세션 id, actor_role = 'vendor'(외부 검수자, DDL 없이 기존 역할 값),
  detail.actor_kind = 'qa_reviewer' + reviewer_name).
- payload 는 kind 별 계약(core.contracts)으로 검증한다(생산자·ingest 소비자 한 벌). 계약 위반은 코드 결함(ValueError → 500).
- 중복 판정(enqueue_change dedupe)
    raise(기본)        같은 kind·주체(+ dedupe_key 가 payload 에 포함)의 pending·running 행이 있으면 409 duplicate_pending
    coalesce_pending   같은 조건의 pending 행이 있으면 그 change_id 를 돌려주고 새 행을 넣지 않는다(running 이면 새 행: 적재기가 옛 상태를 읽었을 수 있다)
                       주의: IG-2 재판정 워커는 행을 FOR UPDATE SKIP LOCKED 로 잡고 같은 트랜잭션에서 처리한 뒤 applied 로 바꾼다(처리 중에도
                       다른 트랜잭션에는 pending). 행 잠금 없이 고르는 이 모드는 처리 중 행을 재사용해 편집이 묻힐 수 있으므로, 적재기가
                       재판정하는 kind(project_owned_base·project_target_url·project_setting 등)에는 쓰지 않는다(off). api_rw 에 행 잠금
                       권한(UPDATE 열 하나)을 주거나 SECURITY DEFINER 잠금 함수를 두면 풀린다(다음 DB 패치 후보).
    coalesce_active    pending·running 행을 재사용(같은 요청이 진행 중이면 그 결과를 기다리면 된다: 유료 수집 중복 방지)
    off                항상 새 행
  raise·coalesce_* 는 트랜잭션 advisory 잠금(kind·주체·dedupe_key)으로 동시 요청을 직렬화한다. reusable(행 → bool) 을 주면 재사용
  후보를 거른다(예: 요청자가 상태를 볼 수 있는 행만). enqueue_change_result 는 (change_id, created) 를 돌려준다.
- enqueue_scope(supersede=ops): 같은 aggregate·id 의 미완료 행 중 op ∈ ops 를 done_at = now(), last_error = 'superseded' 로 닫고
  항상 새 행을 넣는다(순서가 의미 있는 토글: disable·enable). 기본은 같은 (aggregate, id, op) 미완료 행에 payload 병합.
- 행 단위 부분 성공(bulk)은 savepoint(conn) 블록으로 감싼다(SQL 가드 G5 가 SAVEPOINT·RELEASE·ROLLBACK TO 만 허용).
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Annotated, Any, Literal

from fastapi import Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import CurrentUser, Principal, QaReviewer
from app.core.contracts import check_change, check_outbox
from app.core.db import fetch_all, fetch_one, fetch_val, get_db

log = logging.getLogger("hgh.write")

ChangeKind = Literal[
    "catalog", "prompt_kind", "entity", "brand_rule", "competitor_token", "hidden_market", "citation_override", "owned_base",
    "website_catalog", "project_setting", "project_owned_base", "project_target_url", "rule_param", "scope_prompt",
    "cycle_admin", "anchor_pin", "answer_drop", "report_publication", "dfs_fetch", "ga4_property", "ga4_tracked_event",
    "entity_version"]
# 트리거·적재기 소관(앱 직접 INSERT 금지): app.prompt 트리거(catalog·prompt_kind), 적재기 자체 발행(scope_prompt)
_APP_FORBIDDEN_KINDS = frozenset({"catalog", "prompt_kind", "scope_prompt"})
_PAYLOAD_REQUIRED = frozenset({"cycle_admin", "anchor_pin", "answer_drop", "entity_version"})


class WriteAccepted(BaseModel):
    """비동기 반영 쓰기의 응답(재판정 큐·아웃박스). propagation = pending(적재기 반영 대기) | none."""
    change_id: int | None = None
    propagation: Literal["pending", "none"] = "none"


# ── 쓰기 트랜잭션 의존성 ──
async def get_rw_conn(p: CurrentUser) -> AsyncIterator[AsyncConnection]:
    """api_rw 트랜잭션(행위자 = 세션 사용자). 핸들러가 정상 반환하면 응답 전에 COMMIT 된다(scope='function')."""
    async with get_db().write(p.user_id) as conn:
        yield conn


RwConn = Annotated[AsyncConnection, Depends(get_rw_conn, scope="function")]


DedupeMode = Literal["raise", "coalesce_pending", "coalesce_active", "off"]


@dataclass(frozen=True)
class Enqueued:
    change_id: int
    created: bool                    # False = 기존 대기 행 재사용(coalesce_*)


def _dedupe_mode(dedupe: DedupeMode | bool) -> DedupeMode:
    if dedupe is True:
        return "raise"
    if dedupe is False:
        return "off"
    if dedupe not in ("raise", "coalesce_pending", "coalesce_active", "off"):
        raise ValueError(f"dedupe: {dedupe}")
    return dedupe


async def enqueue_change_result(conn: AsyncConnection, kind: ChangeKind, *, payload: dict[str, Any] | None = None,
                                subject_uuids: list[uuid.UUID] | None = None, subject_texts: list[str] | None = None,
                                requested_by: uuid.UUID | None = None, dedupe: DedupeMode | bool = "raise",
                                dedupe_key: Mapping[str, Any] | None = None,
                                reusable: Callable[[dict[str, Any]], Awaitable[bool]] | None = None) -> Enqueued:
    """app.judgment_change 한 행(같은 트랜잭션) 또는 기존 대기 행 재사용. requested_by 를 안 주면 app.actor()(트랜잭션 행위자).
    dedupe_key: 중복 판정에 더할 payload 부분(payload @> dedupe_key, 예 {"op": "hide"}·{"fetch": "insight", "location_code": 2410}).
    reusable: 재사용 후보 행(change_id·requested_by·status·payload)을 거르는 판정(coalesce_* 전용)."""
    if kind in _APP_FORBIDDEN_KINDS:
        raise ValueError(f"'{kind}' 는 트리거·적재기 소관이라 앱이 넣지 않는다")
    if kind in _PAYLOAD_REQUIRED and not payload:
        raise ValueError(f"'{kind}' 는 payload 필수")
    check_change(kind, payload)
    mode = _dedupe_mode(dedupe)
    subj_u = [str(u) for u in subject_uuids] if subject_uuids else None
    dk = json.dumps(dict(dedupe_key), sort_keys=True, default=str) if dedupe_key else None
    if mode != "off":
        lock_key = json.dumps([kind, subj_u, subject_texts, dk], default=str)
        await fetch_val(conn, "SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))) x", {"k": lock_key})
        statuses = ["pending"] if mode == "coalesce_pending" else ["pending", "running"]
        rows = await fetch_all(conn, """
            SELECT change_id, requested_by, status, payload FROM app.judgment_change
             WHERE kind = :kind AND status = ANY(CAST(:sts AS text[]))
               AND subject_uuids IS NOT DISTINCT FROM CAST(:su AS uuid[]) AND subject_texts IS NOT DISTINCT FROM CAST(:st AS text[])
               AND (CAST(:dk AS jsonb) IS NULL OR payload @> CAST(:dk AS jsonb))
             ORDER BY change_id LIMIT 50""", {"kind": kind, "sts": statuses, "su": subj_u, "st": subject_texts, "dk": dk})
        if mode == "raise" and rows:
            raise errors.conflict("duplicate_pending", "같은 대상의 요청이 이미 대기 중", {"change_id": rows[0]["change_id"]})
        for r in rows:
            if reusable is None or await reusable(r):
                return Enqueued(int(r["change_id"]), False)
    r = await fetch_one(conn, """
        INSERT INTO app.judgment_change (kind, subject_uuids, subject_texts, payload, requested_by)
        VALUES (:kind, CAST(:su AS uuid[]), CAST(:st AS text[]), CAST(:pl AS jsonb), coalesce(CAST(:rb AS uuid), app.actor()))
        RETURNING change_id""",
        {"kind": kind, "su": subj_u, "st": subject_texts, "pl": json.dumps(payload, default=str) if payload is not None else None,
         "rb": str(requested_by) if requested_by else None})
    return Enqueued(int(r["change_id"]), True)  # type: ignore[index]


async def enqueue_change(conn: AsyncConnection, kind: ChangeKind, *, payload: dict[str, Any] | None = None,
                         subject_uuids: list[uuid.UUID] | None = None, subject_texts: list[str] | None = None,
                         requested_by: uuid.UUID | None = None, dedupe: DedupeMode | bool = "raise",
                         dedupe_key: Mapping[str, Any] | None = None,
                         reusable: Callable[[dict[str, Any]], Awaitable[bool]] | None = None) -> int:
    """enqueue_change_result 의 change_id 만. dedupe=True/False 는 raise/off 와 같다(하위 호환)."""
    res = await enqueue_change_result(conn, kind, payload=payload, subject_uuids=subject_uuids, subject_texts=subject_texts,
                                      requested_by=requested_by, dedupe=dedupe, dedupe_key=dedupe_key, reusable=reusable)
    return res.change_id


async def enqueue_scope(conn: AsyncConnection, aggregate: Literal["project", "prompt", "schedule"], aggregate_id: uuid.UUID,
                        op: str, payload: dict[str, Any], *, supersede: Iterable[str] = ()) -> int:
    """app.scope_outbox 한 행. 기본: 같은 (aggregate, id, op) 의 미완료 행이 있으면 그 행의 payload 를 최신으로 바꾸고 id 를 돌려준다.
    supersede 를 주면(순서가 의미 있는 토글) 같은 aggregate·id 의 미완료 행 중 op ∈ supersede 를 superseded 로 닫고 항상 새 행을 넣는다
    (워커는 done_at 있는 행을 집지 않고, 처리 완료 표시는 done_at IS NULL 조건이라 superseded 를 덮지 않는다)."""
    check_outbox(aggregate, op, payload)
    sup = sorted(set(supersede))
    pl = json.dumps(payload, default=str)
    if sup:
        await conn.execute(_text("""
            UPDATE app.scope_outbox SET done_at = now(), last_error = 'superseded'
             WHERE aggregate = :ag AND aggregate_id = :id AND done_at IS NULL AND op = ANY(CAST(:ops AS text[]))"""),
            {"ag": aggregate, "id": aggregate_id, "ops": sup})
    else:
        r = await fetch_one(conn, """
            UPDATE app.scope_outbox SET payload = CAST(:pl AS jsonb), next_attempt_at = now()
             WHERE outbox_id = (SELECT outbox_id FROM app.scope_outbox
                                 WHERE aggregate = :ag AND aggregate_id = :id AND op = :op AND done_at IS NULL
                                 ORDER BY outbox_id DESC LIMIT 1 FOR UPDATE)
            RETURNING outbox_id""", {"ag": aggregate, "id": aggregate_id, "op": op, "pl": pl})
        if r is not None:
            return int(r["outbox_id"])
    r = await fetch_one(conn, """
        INSERT INTO app.scope_outbox (aggregate, aggregate_id, op, payload) VALUES (:ag, :id, :op, CAST(:pl AS jsonb))
        RETURNING outbox_id""", {"ag": aggregate, "id": aggregate_id, "op": op, "pl": pl})
    return int(r["outbox_id"])  # type: ignore[index]


def _text(sql: str) -> Any:
    from sqlalchemy import text
    return text(sql)


@contextlib.asynccontextmanager
async def savepoint(conn: AsyncConnection) -> AsyncIterator[AsyncConnection]:
    """행 단위 부분 성공: 블록 안 DB 오류는 이 SAVEPOINT 까지만 되돌리고 예외를 다시 던진다(바깥 트랜잭션은 계속 쓸 수 있다).
    SQLAlchemy begin_nested(SAVEPOINT·RELEASE·ROLLBACK TO: SQL 가드 G5 허용)."""
    async with conn.begin_nested():
        yield conn


# 계정·권한 감사(AD-5): app.permission_audit_log 의 쓰기 주체는 DB 트리거 app.tg_user_account_audit 하나다(DB-v2.3 P31,
#   api_rw INSERT 회수). 앱은 RwConn(행위자 GUC 가 심긴 트랜잭션)에서 app.user_account 를 INSERT·UPDATE·DELETE 만 하면 된다.
#   스코프 값 참조 오류는 SQLSTATE 23503, admin 의 scope_all 거짓은 CHECK ua_admin_scope_all(23514)로 거부된다.


# ════════════════════════════════════════════════════════════════════════════
# 접근 감사(Q4): 민감 조회만, 응답 후 비동기 배치(api_rw)
# ════════════════════════════════════════════════════════════════════════════
AuditKind = Literal["data_access", "download", "scope_call"]


@dataclass(frozen=True)
class AuditEvent:
    actor_id: uuid.UUID
    actor_role: str
    kind: str
    action: str
    target: str | None
    detail: dict[str, Any] | None
    request_id: uuid.UUID | None


class AccessAuditWriter:
    """프로세스 내 버퍼 + 백그라운드 태스크. ≤ flush_s 초 또는 batch 건 중 먼저 도달 시 한 트랜잭션 벌크 INSERT.
    실패한 배치는 로그만 남기고 버린다(요청 경로를 막지 않는다, Q4 유실 허용)."""

    def __init__(self, *, flush_s: float = 2.0, batch: int = 500, max_buffer: int = 20_000):
        self.flush_s, self.batch, self.max_buffer = flush_s, batch, max_buffer
        self._buf: list[AuditEvent] = []
        self._task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._stopping = False
        self.dropped = 0
        self.written = 0

    def record(self, p: Principal, kind: AuditKind, action: str, *, target: str | None = None,
               detail: dict[str, Any] | None = None, request_id: uuid.UUID | None = None) -> None:
        self.record_actor(p.user_id, p.role, kind, action, target=target, detail=detail, request_id=request_id)

    def record_actor(self, actor_id: uuid.UUID, actor_role: str, kind: AuditKind, action: str, *, target: str | None = None,
                     detail: dict[str, Any] | None = None, request_id: uuid.UUID | None = None) -> None:
        if kind not in ("data_access", "download", "scope_call"):
            raise ValueError("접근 감사는 data_access·download·scope_call 만(Q4: api_read 기록 안 함)")
        if len(self._buf) >= self.max_buffer:
            self.dropped += 1
            return
        if request_id is None:                            # 요청 경로의 기록은 그 요청의 X-Request-Id(core.reqid)를 같이 남긴다
            from app.core.reqid import current_request_id

            request_id = current_request_id()
        self._buf.append(AuditEvent(actor_id, actor_role, kind, action[:200], target[:500] if target else None, detail, request_id))
        if len(self._buf) >= self.batch:
            self._wake.set()

    def pending(self) -> tuple[AuditEvent, ...]:
        """아직 기록되지 않은 버퍼의 읽기 전용 스냅샷(테스트가 '민감 조회 1건 = 감사 1건'을 단언할 때)."""
        return tuple(self._buf)

    def start(self) -> None:
        if self._task is None:
            self._stopping = False
            self._task = asyncio.create_task(self._run(), name="access-audit-writer")

    async def stop(self) -> None:
        self._stopping = True
        self._wake.set()
        if self._task is not None:
            await self._task
            self._task = None

    async def _run(self) -> None:
        while True:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=self.flush_s)
            self._wake.clear()
            await self.flush()
            if self._stopping:
                await self.flush()
                return

    async def flush(self) -> int:
        n_total = 0
        while self._buf:
            chunk, self._buf = self._buf[: self.batch], self._buf[self.batch:]
            try:
                async with get_db().transaction("api_rw") as conn:
                    await conn.execute(_audit_insert(), _audit_params(chunk))
                self.written += len(chunk)
                n_total += len(chunk)
            except Exception as e:  # noqa: BLE001
                self.dropped += len(chunk)
                log.warning("접근 감사 배치 %d건 유실: %s", len(chunk), type(e).__name__)
        return n_total


def _audit_insert() -> Any:
    from sqlalchemy import text
    return text("""
        INSERT INTO app.access_audit_log (actor_id, actor_role, kind, action, target, detail, request_id)
        SELECT a, CAST(r AS app.user_role), k, ac, t, CAST(d AS jsonb), q
          FROM unnest(CAST(:a AS uuid[]), CAST(:r AS text[]), CAST(:k AS text[]), CAST(:ac AS text[]), CAST(:t AS text[]),
                      CAST(:d AS text[]), CAST(:q AS uuid[])) AS x(a, r, k, ac, t, d, q)""")


def _audit_params(chunk: list[AuditEvent]) -> dict[str, Any]:
    return {"a": [str(e.actor_id) for e in chunk], "r": [e.actor_role for e in chunk], "k": [e.kind for e in chunk],
            "ac": [e.action for e in chunk], "t": [e.target for e in chunk],
            "d": [json.dumps(e.detail, default=str) if e.detail is not None else None for e in chunk],
            "q": [str(e.request_id) if e.request_id else None for e in chunk]}


_writer: AccessAuditWriter | None = None


def get_audit_writer() -> AccessAuditWriter:
    global _writer
    if _writer is None:
        _writer = AccessAuditWriter()
    return _writer


def access_audit(p: Principal, kind: AuditKind, action: str, *, target: str | None = None, detail: dict[str, Any] | None = None,
                 request_id: uuid.UUID | None = None) -> None:
    """민감 조회(답변 원문·다운로드·Scope 호출) 뒤 호출. 즉시 반환, 기록은 배치."""
    get_audit_writer().record(p, kind, action, target=target, detail=detail, request_id=request_id)


QA_AUDIT_ROLE = "vendor"      # 외부 검수자(Q17). app.user_role 에 검수자 값이 없어 기존 값을 쓰고 detail.actor_kind 로 구분(DDL 없음)


def access_audit_qa(reviewer: QaReviewer, kind: Literal["data_access", "download"], action: str, *, target: str | None = None,
                    detail: dict[str, Any] | None = None, request_id: uuid.UUID | None = None) -> None:
    """계정 없는 검수자(QA 콘솔)의 민감 조회 감사. actor_id = 검수 세션 id(로그아웃 뒤에도 reviewer_name 으로 추적)."""
    try:
        sid = uuid.UUID(reviewer.session_id)
    except ValueError:
        return
    d = {"actor_kind": "qa_reviewer", "reviewer_name": reviewer.name, **(detail or {})}
    get_audit_writer().record_actor(sid, QA_AUDIT_ROLE, kind, action, target=target, detail=d, request_id=request_id)
