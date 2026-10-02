"""qa.notes.notes 업무 규칙: 낱알 노트 작성·조회·목록·건수·CSV 내보내기·수정·삭제.

- 작성자 = 쿠키 세션 이름 스냅샷(reviewer_id 는 계정이 없어 NULL, Q17). 쓰기 전에 세션 행이 살아 있는지 확인한다(core.auth.assert_qa_session).
- Q17 "노트 수정·삭제 작성자 제한은 세션 reviewer_name 기준": 본문·severity 수정과 삭제는 작성자 이름과 같은 세션만(403 not_author).
  resolved 토글은 검수 흐름상 다른 검수자도 처리하므로 허용하고 resolved_by 에 처리자 이름을 남긴다(해석, 보고에 적음).
- 삭제는 하드 삭제(현행 계승, 모듈 열린 질문 5).
- 목록·건수·내보내기는 같은 술어(답변 필터 job_predicates + 노트 3축). 기본은 미해결만.
- 내보내기: core.export(CSV: 선두 BOM(Excel 한글)·CRLF·수식 주입 방지 작은따옴표 접두), 상한 10,000행(넘으면 잘라서 X-Export-Truncated).
  다운로드 감사(Q4)는 라우터가 core.write.access_audit_qa(kind download)로 남긴다.
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import QaReviewer, assert_qa_session
from app.core.db import fetch_all, fetch_one
from app.core.envelope import Meta, Page
from app.core.pagination import decode_cursor, fetch_keyset, filter_hash, keyset_page
from app.features.qa.answers.list.scope import (
    QaNoteFilter,
    QaRefs,
    assert_job_in_scope,
    coords,
    get_qa_scope,
    load_qa_refs,
    qa_meta,
    resolve_filter,
)
from app.features.qa.notes.notes import queries as Q
from app.features.qa.notes.notes.schemas import QaNote, QaNoteDeleted, QaNoteIn, QaNotePatch, QaNoteRow

SORT = "qa_notes"
CURSOR_TYPES = ("timestamptz", "uuid")
CSV_COLUMNS = ("created_at", "reviewer", "job_id", "target_kind", "target_key", "target_label", "severity", "body", "prompt",
               "surface", "resolved_at", "resolved_by")                                 # 현행 export/route.ts 열 계승(열 키 = 머리글)
_NOTE_FIELDS = tuple(QaNote.model_fields)


def _note(row: dict[str, Any]) -> QaNote:
    return QaNote(**{k: row[k] for k in _NOTE_FIELDS})


async def _rows(conn: AsyncConnection, rows: list[dict[str, Any]], refs: QaRefs) -> list[QaNoteRow]:
    pkeys = sorted({int(r["prompt_key"]) for r in rows})
    texts = {int(x["prompt_key"]): x["text"] for x in await fetch_all(conn, Q.PROMPT_TEXT_SQL, {"keys": pkeys})} if pkeys else {}
    out = []
    for r in rows:
        c = coords(r, refs)
        out.append(QaNoteRow(**{k: r[k] for k in _NOTE_FIELDS}, prompt_text=texts.get(int(r["prompt_key"])), surface=c.surface,
                             brand=c.brand, country=c.country, engine=c.engine, lang=c.lang))
    return out


async def job_notes(conn: AsyncConnection, job_id: uuid.UUID) -> list[QaNote]:
    await assert_job_in_scope(conn, job_id)
    return [_note(r) for r in await fetch_all(conn, Q.JOB_NOTES_SQL, {"job_id": job_id})]


async def create(conn: AsyncConnection, reviewer: QaReviewer, job_id: uuid.UUID, body: QaNoteIn) -> QaNote:
    await assert_job_in_scope(conn, job_id)
    await assert_qa_session(conn, reviewer)
    row = await fetch_one(conn, Q.INSERT_NOTE_SQL, {
        "job_id": job_id, "kind": body.target_kind, "key": body.target_key, "label": body.target_label, "severity": body.severity,
        "body": body.body, "name": reviewer.name, "sid": uuid.UUID(reviewer.session_id)})
    return _note(row)  # type: ignore[arg-type]


def _fh(f: QaNoteFilter) -> str:
    return filter_hash({"f": f.fingerprint(), "scope": get_qa_scope().fingerprint()})


async def list_notes(conn: AsyncConnection, f: QaNoteFilter, cursor: str | None, limit: int) -> tuple[list[QaNoteRow], Any]:
    refs = await load_qa_refs(conn)
    r = resolve_filter(f, refs)
    fh = _fh(f)
    c = decode_cursor(cursor, sort=SORT, dir="desc", fh=fh, types=CURSOR_TYPES)
    rows: list[dict[str, Any]] = []
    if not r.empty and r.surfaces:
        q = Q.list_sql(r, c, limit + 1)
        rows = await fetch_keyset(conn, q.text, q.params)
    page, nxt = keyset_page(rows, limit, lambda x: (x["created_at"], uuid.UUID(str(x["note_id"]))), sort=SORT, dir="desc", fh=fh)
    return await _rows(conn, page, refs), qa_meta(r, page=Page(next_cursor=nxt, limit=limit))


async def counts(conn: AsyncConnection, f: QaNoteFilter) -> tuple[dict[str, int], Any]:
    refs = await load_qa_refs(conn)
    r = resolve_filter(f, refs)
    if r.empty or not r.surfaces:
        return {}, qa_meta(r)
    q = Q.counts_sql(r)
    return {x["target_kind"]: int(x["n"]) for x in await fetch_all(conn, q.text, q.params)}, qa_meta(r)


async def export_rows(conn: AsyncConnection, f: QaNoteFilter) -> tuple[list[dict[str, Any]], bool, Meta]:
    """(CSV 행(열 키 CSV_COLUMNS), 상한에서 잘렸는지, meta). 상한 10,000행 + 1행을 읽어 넘침을 판정한다."""
    refs = await load_qa_refs(conn)
    r = resolve_filter(f, refs)
    notes: list[QaNoteRow] = []
    truncated = False
    if not r.empty and r.surfaces:
        q = Q.export_sql(r)
        raw = await fetch_all(conn, q.text, q.params)
        truncated = len(raw) > Q.EXPORT_LIMIT
        notes = await _rows(conn, raw[: Q.EXPORT_LIMIT], refs)
    rows = [{"created_at": n.created_at, "reviewer": n.reviewer_name, "job_id": n.job_id, "target_kind": n.target_kind,
             "target_key": n.target_key, "target_label": n.target_label, "severity": n.severity, "body": n.body,
             "prompt": n.prompt_text, "surface": n.surface, "resolved_at": n.resolved_at, "resolved_by": n.resolved_by} for n in notes]
    return rows, truncated, qa_meta(r)


async def _owned_note(conn: AsyncConnection, note_id: uuid.UUID) -> dict[str, Any]:
    """노트가 있고 그 job 이 서버 검수 범위 안이면 행. 아니면 404."""
    row = await fetch_one(conn, Q.GET_NOTE_SQL, {"note_id": note_id})
    if row is None:
        raise errors.not_found("노트 없음", code="note_not_found")
    try:
        await assert_job_in_scope(conn, uuid.UUID(str(row["job_id"])))
    except errors.ApiError as e:
        raise errors.not_found("노트 없음", code="note_not_found") from e
    return row


async def patch(conn: AsyncConnection, reviewer: QaReviewer, note_id: uuid.UUID, body: QaNotePatch) -> QaNote:
    await assert_qa_session(conn, reviewer)
    row = await _owned_note(conn, note_id)
    sets = {k: v for k, v in (("body", body.body), ("severity", body.severity)) if v is not None}
    if sets and row["reviewer_name"] != reviewer.name:
        raise errors.forbidden("작성자만 본문·severity 를 고친다", code="not_author")
    q = Q.update_sql(note_id, sets, body.resolved, reviewer.name)
    return _note(await fetch_one(conn, q.text, q.params))  # type: ignore[arg-type]


async def delete(conn: AsyncConnection, reviewer: QaReviewer, note_id: uuid.UUID) -> QaNoteDeleted:
    await assert_qa_session(conn, reviewer)
    row = await _owned_note(conn, note_id)
    if row["reviewer_name"] != reviewer.name:
        raise errors.forbidden("작성자만 삭제한다", code="not_author")
    gone = await fetch_one(conn, Q.DELETE_NOTE_SQL, {"note_id": note_id})
    return QaNoteDeleted(note_id=note_id, deleted=gone is not None)
