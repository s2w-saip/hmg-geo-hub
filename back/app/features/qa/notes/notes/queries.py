"""qa.notes.notes SQL(SQLAlchemy Core text). app.qa_review_note 쓰기, rd.job(job_id UNIQUE) 조인으로 답변 필터·범위.

노트 목록 드라이버는 app.qa_review_note(qa_note_cursor_idx: created_at DESC, note_id)이고 rd.job 은 job_id UNIQUE 등치로 붙인다
(노트는 사람이 만든 소량 데이터라 10배 대상이 아니다). 답변 술어는 qa.answers.list 의 job_predicates 하나를 공유한다.
인덱스 방향: 정렬은 (created_at DESC, note_id DESC) 라 note_id ASC 인 인덱스 위에 Incremental Sort 가 붙는다. 소량이라
인덱스 교정(qa R5)은 보류(메인 결정)다.
"""
from app.core.pagination import Cursor, keyset_predicate
from app.core.sqlb import Binder, Sql
from app.features.qa.answers.list.scope import QaResolved, job_predicates, note_predicates

NOTE_COLS = ("n.note_id, n.job_id, n.target_kind, n.target_key, n.target_label, n.severity, n.body, n.reviewer_name, n.session_id, "
             "n.created_at, n.resolved_at, n.resolved_by")
EXPORT_LIMIT = 10_000          # 현행 QA_NOTE_EXPORT_LIMIT(qa-review.ts:1002). export_sql 은 +1 행을 읽어 넘침(X-Export-Truncated)을 판정한다

JOB_NOTES_SQL = f"SELECT {NOTE_COLS} FROM app.qa_review_note n WHERE n.job_id = :job_id ORDER BY n.created_at, n.note_id"

INSERT_NOTE_SQL = f"""
INSERT INTO app.qa_review_note AS n (job_id, target_kind, target_key, target_label, severity, body, reviewer_id, reviewer_name, session_id)
VALUES (:job_id, :kind, :key, :label, :severity, :body, NULL, :name, :sid)
RETURNING {NOTE_COLS}"""

GET_NOTE_SQL = f"SELECT {NOTE_COLS} FROM app.qa_review_note n WHERE n.note_id = :note_id"

DELETE_NOTE_SQL = "DELETE FROM app.qa_review_note WHERE note_id = :note_id RETURNING note_id"

PROMPT_TEXT_SQL = "SELECT prompt_key, text FROM rd.dim_prompt WHERE prompt_key = ANY(CAST(:keys AS int4[]))"

_JOB_COLS = "j.prompt_key, j.surface, j.bgrp, j.geo_key, j.engine_key, j.lang_key"


def _from_where(r: QaResolved, b: Binder) -> tuple[str, list[str]]:
    frm = ("FROM app.qa_review_note n JOIN rd.job j ON j.job_id = n.job_id "
           "LEFT JOIN app.qa_answer_review rv ON rv.job_id = j.job_id")
    w = [f"j.surface = ANY({b.ints(r.surfaces)})", *job_predicates(r, b), *note_predicates(r, b)]
    return frm, w


def list_sql(r: QaResolved, cursor: Cursor | None, limit: int) -> Sql:
    b = Binder()
    frm, w = _from_where(r, b)
    kp = keyset_predicate(["n.created_at", "n.note_id"], "desc", cursor, b)
    if kp:
        w.append(kp)
    return b.sql(f"SELECT {NOTE_COLS}, {_JOB_COLS} {frm} WHERE {' AND '.join(w)} "
                 f"ORDER BY n.created_at DESC, n.note_id DESC LIMIT {b.v(limit, 'int4')}")


def counts_sql(r: QaResolved) -> Sql:
    b = Binder()
    frm, w = _from_where(r, b)
    return b.sql(f"SELECT n.target_kind, count(*) AS n {frm} WHERE {' AND '.join(w)} GROUP BY n.target_kind ORDER BY n.target_kind")


def export_sql(r: QaResolved) -> Sql:
    b = Binder()
    frm, w = _from_where(r, b)
    return b.sql(f"SELECT {NOTE_COLS}, {_JOB_COLS} {frm} WHERE {' AND '.join(w)} "
                 f"ORDER BY n.created_at DESC, n.note_id DESC LIMIT {b.v(EXPORT_LIMIT + 1, 'int4')}")


def update_sql(note_id: object, sets: dict[str, object], resolve: bool | None, name: str) -> Sql:
    """부분 갱신. sets 키는 코드 상수(body·severity)만. resolve=True 면 resolved_at=now()·resolved_by=이름, False 면 둘 다 NULL."""
    b = Binder()
    parts = [f"{col} = {b.v(val)}" for col, val in sets.items() if col in ("body", "severity")]
    if resolve is True:
        parts.append(f"resolved_at = now(), resolved_by = {b.v(name)}")
    elif resolve is False:
        parts.append("resolved_at = NULL, resolved_by = NULL")
    return b.sql(f"UPDATE app.qa_review_note AS n SET {', '.join(parts)} WHERE n.note_id = {b.v(note_id)} RETURNING {NOTE_COLS}")
