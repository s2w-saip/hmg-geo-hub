"""qa.answers.list 업무 규칙: 검수 목록(2구간 키셋)·진행률·이웃·필터 옵션.

QA 는 지표 API 가 아니라 원시 색인·검수 큐라 core.cycles·core.measure(모수·회차 창)를 쓰지 않는다(모듈-검수-콘솔 §1).
커서는 core.pagination(서명 없는 불투명 토큰 + 필터 해시), 봉투는 core.envelope 다.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.codes import SURFACE_NAME
from app.core.db import fetch_all, fetch_one
from app.core.envelope import Page
from app.core.pagination import decode_cursor, fetch_keyset, filter_hash, keyset_page
from app.core.sqlb import Binder
from app.features.qa.answers.list import queries as Q
from app.features.qa.answers.list.schemas import (
    QaFilterOptions,
    QaListRow,
    QaNeighbors,
    QaProgress,
    QaProgressCounts,
)
from app.features.qa.answers.list.scope import (
    JOB_STATUS,
    LOCK_TTL_SECONDS,
    QaFilter,
    QaLock,
    QaRefs,
    QaResolved,
    assert_job_in_scope,
    coords,
    get_qa_scope,
    load_qa_refs,
    qa_meta,
    resolve_filter,
    scope_predicates,
)

SORT = "qa_list"
_NULL_TS = datetime(1970, 1, 1, tzinfo=UTC)          # NULL 구간 커서의 자리 채움 값(비교에 쓰지 않는다)
CURSOR_TYPES = ("bool", "timestamptz", "int4")


def list_fh(f: QaFilter) -> str:
    return filter_hash({"f": f.fingerprint(), "scope": get_qa_scope().fingerprint()})


async def _segment(conn: AsyncConnection, r: QaResolved, *, null_segment: bool, dir: Q.Dir, bound: Q.Bound | None,
                   limit: int) -> list[dict[str, Any]]:
    if limit <= 0 or not r.surfaces:
        return []
    q = Q.segment_sql(r, null_segment=null_segment, dir=dir, bound=bound, limit=limit)
    return await fetch_keyset(conn, q.text, q.params)


async def page_rows(conn: AsyncConnection, r: QaResolved, bound: Q.Bound | None, in_null: bool, n: int) -> list[dict[str, Any]]:
    """목록 순서로 bound 뒤 n 행(비NULL 구간 → NULL 구간)."""
    rows: list[dict[str, Any]] = []
    if not in_null:
        rows = await _segment(conn, r, null_segment=False, dir="desc", bound=bound, limit=n)
    if len(rows) < n:
        rows += await _segment(conn, r, null_segment=True, dir="desc", bound=bound if in_null else None, limit=n - len(rows))
    return rows


async def locks_for(conn: AsyncConnection, job_ids: list[uuid.UUID]) -> dict[uuid.UUID, QaLock]:
    if not job_ids:
        return {}
    rows = await fetch_all(conn, Q.LOCKS_SQL, {"ids": [str(x) for x in job_ids], "ttl": LOCK_TTL_SECONDS})
    return {uuid.UUID(str(x["job_id"])): QaLock(**x) for x in rows}


async def enrich(conn: AsyncConnection, rows: list[dict[str, Any]], refs: QaRefs) -> list[QaListRow]:
    """페이지 배치 조회 5개(프롬프트 텍스트·락·노트 수·멘션 수·인용 수)로 행을 채운다. 모두 PK·등치 = ANY(페이지)."""
    if not rows:
        return []
    keys = [int(x["answer_key"]) for x in rows]
    ids = [uuid.UUID(str(x["job_id"])) for x in rows]
    pkeys = sorted({int(x["prompt_key"]) for x in rows})
    texts = {int(x["prompt_key"]): x["text"] for x in await fetch_all(conn, Q.PROMPT_TEXT_SQL, {"keys": pkeys})}
    notes = {uuid.UUID(str(x["job_id"])): int(x["n"]) for x in await fetch_all(conn, Q.NOTE_COUNT_SQL, {"ids": [str(i) for i in ids]})}
    ments = {int(x["answer_key"]): int(x["n"]) for x in await fetch_all(conn, Q.MENTION_COUNT_SQL, {"keys": keys})}
    cits = {int(x["answer_key"]): int(x["n"]) for x in await fetch_all(conn, Q.CITATION_COUNT_SQL, {"keys": keys})}
    locks = await locks_for(conn, ids)
    out = []
    for x in rows:
        jid = uuid.UUID(str(x["job_id"]))
        c = coords(x, refs)
        out.append(QaListRow(
            job_id=jid, prompt_text=texts.get(int(x["prompt_key"])), surface=c.surface, brand=c.brand, country=c.country,
            engine=c.engine, lang=c.lang, measured_at=x["measured_at"], job_status=JOB_STATUS.get(int(x["status_code"]), "other"),  # type: ignore[arg-type]
            dropped=bool(x["dropped"]), mention_count=ments.get(int(x["answer_key"]), 0), citation_count=cits.get(int(x["answer_key"]), 0),
            note_count=notes.get(jid, 0), review_status=x["review_status"] or "unreviewed", reviewer_name=x["reviewer_name"],
            lock=locks.get(jid)))
    return out


async def list_answers(conn: AsyncConnection, f: QaFilter, cursor: str | None, limit: int) -> tuple[list[QaListRow], Any]:
    refs = await load_qa_refs(conn)
    r = resolve_filter(f, refs)
    fh = list_fh(f)
    c = decode_cursor(cursor, sort=SORT, dir="desc", fh=fh, types=CURSOR_TYPES)
    rows: list[dict[str, Any]] = []
    if not r.empty:
        bound, in_null = None, False
        if c is not None:
            in_null = bool(c.key[0])
            bound = Q.Bound(None if in_null else c.key[1], int(c.key[2]))
        rows = await page_rows(conn, r, bound, in_null, limit + 1)
    page, nxt = keyset_page(rows, limit, lambda x: (x["measured_at"] is None, x["measured_at"] or _NULL_TS, int(x["answer_key"])),
                            sort=SORT, dir="desc", fh=fh)
    items = await enrich(conn, page, refs)
    return items, qa_meta(r, page=Page(next_cursor=nxt, limit=limit))


async def _counts(conn: AsyncConnection, r: QaResolved) -> QaProgressCounts:
    if r.empty or not r.surfaces:
        return QaProgressCounts(total=0, reviewed=0, issues=0, notes=0)
    q = Q.progress_sql(r)
    row = await fetch_one(conn, q.text, q.params) or {}
    return QaProgressCounts(**{k: int(row.get(k) or 0) for k in ("total", "reviewed", "issues", "notes")})


def _same_counts(a: QaResolved, b: QaResolved) -> bool:
    """두 범위의 집계 SQL·바인드가 같으면 같은 수다. 빈 범위(empty) 판정은 SQL 밖이라 둘 다 비지 않았을 때만 비교한다."""
    return not (a.empty or b.empty or not a.surfaces or not b.surfaces) and Q.progress_sql(a) == Q.progress_sql(b)


async def progress(conn: AsyncConnection, f: QaFilter) -> tuple[QaProgress, Any]:
    """scoped = 요청 필터, total = 서버 검수 범위 전체. 매 요청 계산(현행 unstable_cache 30초 제거, D8).
    요청 필터가 범위를 좁히지 않으면(필터 없음 등) 같은 집계를 두 번 돌리지 않고 scoped 를 total 로 쓴다."""
    refs = await load_qa_refs(conn)
    r = resolve_filter(f, refs)
    whole = resolve_filter(QaFilter(), refs)
    scoped = await _counts(conn, r)
    total = scoped if _same_counts(r, whole) else await _counts(conn, whole)
    return QaProgress(scoped=scoped, total=total), qa_meta(r)


async def neighbors(conn: AsyncConnection, f: QaFilter, job_id: uuid.UUID) -> tuple[QaNeighbors, Any]:
    """같은 필터·정렬에서 이전/다음 job_id. 기준 job 은 필터를 만족하지 않아도 되지만 서버 검수 범위 안이어야 한다(404)."""
    anchor = await assert_job_in_scope(conn, job_id)
    refs = await load_qa_refs(conn)
    r = resolve_filter(f, refs)
    if r.empty:
        return QaNeighbors(prev=None, next=None), qa_meta(r)
    ts, k = anchor["measured_at"], int(anchor["answer_key"])
    if ts is not None:
        nxt = await page_rows(conn, r, Q.Bound(ts, k), False, 1)
        prv = await _segment(conn, r, null_segment=False, dir="asc", bound=Q.Bound(ts, k), limit=1)
    else:
        nxt = await page_rows(conn, r, Q.Bound(None, k), True, 1)
        prv = await _segment(conn, r, null_segment=True, dir="asc", bound=Q.Bound(None, k), limit=1)
        if not prv:                               # NULL 구간의 첫 행이면 이전은 비NULL 구간의 마지막 행
            prv = await _segment(conn, r, null_segment=False, dir="asc", bound=None, limit=1)

    def first(rows: list[dict[str, Any]]) -> uuid.UUID | None:
        return uuid.UUID(str(rows[0]["job_id"])) if rows else None
    return QaNeighbors(prev=first(prv), next=first(nxt)), qa_meta(r)


async def filter_options(conn: AsyncConnection) -> tuple[QaFilterOptions, Any]:
    refs = await load_qa_refs(conn)
    b = Binder()
    rsql = Q.REVIEWERS_SQL.format(scope=" AND ".join(scope_predicates(b)))
    reviewers = [x["reviewer_name"] for x in await fetch_all(conn, rsql, b.params)]
    opts = QaFilterOptions(
        brand=[code for code, _ in refs.brands],
        country=sorted(c[1] for c in refs.countries.values()),
        engine=sorted(refs.engines), lang=sorted(refs.langs), reviewer=reviewers,
        surface=[SURFACE_NAME[s] for s in get_qa_scope().surfaces],  # type: ignore[misc]
    )
    return opts, qa_meta()
