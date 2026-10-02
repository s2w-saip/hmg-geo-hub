"""qa.answers.list 읽기 SQL(SQLAlchemy Core text). rd·app 만(ing 금지).

rd.job 은 사실 표가 아니라 job 색인(비파티션)이다. 목록은 job_qa_list_idx(surface, measured_at DESC NULLS LAST, answer_key DESC)를
표면별 분기로 타고(표면 등치 + 정렬 일치), 분기를 UNION ALL 로 모아 바깥에서 병합한다(모듈-검수-콘솔 §3.1).
키셋은 2구간이다: 비NULL 구간((measured_at, answer_key) 행 비교) → NULL 구간(answer_key 만).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from app.core.sqlb import Binder, Sql
from app.features.qa.answers.list.scope import QaResolved, job_predicates

Dir = Literal["desc", "asc"]
ROW_COLS = ("j.answer_key, j.job_id, j.prompt_key, j.measured_at, j.surface, j.bgrp, j.geo_key, j.engine_key, j.lang_key, "
            "j.status_code, j.dropped, rv.status AS review_status, rv.reviewer_name")


@dataclass(frozen=True)
class Bound:
    """키셋 경계. ts=None 이면 NULL 구간 안의 경계(answer_key 만 비교)."""
    ts: datetime | None
    answer_key: int


def segment_sql(r: QaResolved, *, null_segment: bool, dir: Dir, bound: Bound | None, limit: int) -> Sql:
    """한 구간(비NULL 또는 NULL)의 표면별 분기 UNION ALL → 병합 정렬 LIMIT.
    dir=desc: 목록 순서(다음 방향), asc: 역순(이전 방향). bound 가 있으면 그 행 '뒤'(dir 기준)만."""
    b = Binder()
    base = job_predicates(r, b)
    op = "<" if dir == "desc" else ">"
    order_dir = "DESC NULLS LAST" if dir == "desc" else "ASC NULLS FIRST"
    key_dir = "DESC" if dir == "desc" else "ASC"
    branches = []
    # 두 구간 모두 인덱스 순서 그대로 정렬한다(NULL 구간도 measured_at 을 선두에 두어야 인덱스가 정렬을 대신한다: EXPLAIN 확인)
    order = f"j.measured_at {order_dir}, j.answer_key {key_dir}"
    for s in r.surfaces:
        w = [f"j.surface = {b.v(s, 'int2')}", *base]
        if null_segment:
            w.append("j.measured_at IS NULL")
            if bound is not None:
                w.append(f"j.answer_key {op} {b.v(bound.answer_key, 'int4')}")
        else:
            w.append("j.measured_at IS NOT NULL")
            if bound is not None and bound.ts is not None:
                w.append(f"(j.measured_at, j.answer_key) {op} ({b.v(bound.ts, 'timestamptz')}, {b.v(bound.answer_key, 'int4')})")
        branches.append(f"(SELECT {ROW_COLS} FROM rd.job j LEFT JOIN app.qa_answer_review rv ON rv.job_id = j.job_id "
                        f"WHERE {' AND '.join(w)} ORDER BY {order} LIMIT {b.v(limit, 'int4')})")
    outer = f"x.measured_at {order_dir}, x.answer_key {key_dir}"
    return Sql(f"SELECT x.* FROM ({' UNION ALL '.join(branches)}) x ORDER BY {outer} LIMIT {b.v(limit, 'int4')}", b.params)


def progress_sql(r: QaResolved) -> Sql:
    b = Binder()
    w = [f"j.surface = ANY({b.ints(r.surfaces)})", *job_predicates(r, b)]
    return b.sql(f"""
        SELECT count(*) AS total, count(rv.job_id) AS reviewed,
               count(*) FILTER (WHERE rv.status = 'issue') AS issues,
               count(*) FILTER (WHERE EXISTS (SELECT 1 FROM app.qa_review_note pn WHERE pn.job_id = j.job_id)) AS notes
          FROM rd.job j LEFT JOIN app.qa_answer_review rv ON rv.job_id = j.job_id
         WHERE {' AND '.join(w)}""")


# ── 페이지 배치 조회(모두 등치 = ANY(페이지)) ──
PROMPT_TEXT_SQL = "SELECT prompt_key, text FROM rd.dim_prompt WHERE prompt_key = ANY(CAST(:keys AS int4[]))"
NOTE_COUNT_SQL = "SELECT job_id, count(*) AS n FROM app.qa_review_note WHERE job_id = ANY(CAST(:ids AS uuid[])) GROUP BY job_id"
MENTION_COUNT_SQL = ("SELECT answer_key, count(*) AS n FROM rd.v_answer_mention_raw WHERE answer_key = ANY(CAST(:keys AS int4[])) "
                     "GROUP BY answer_key")
CITATION_COUNT_SQL = ("SELECT answer_key, count(*) AS n FROM rd.v_answer_citation_raw WHERE answer_key = ANY(CAST(:keys AS int4[])) "
                      "GROUP BY answer_key")
# 유효 락 = heartbeat_at 이 TTL 안(qa.review.lock 의 LOCK_TTL_SECONDS 와 같은 값, 바인드로 받는다)
LOCKS_SQL = """
SELECT job_id, session_id, reviewer_name, acquired_at, heartbeat_at FROM app.qa_answer_lock
 WHERE job_id = ANY(CAST(:ids AS uuid[])) AND heartbeat_at > now() - CAST(:ttl AS int4) * interval '1 second'"""
ANCHOR_SQL = "SELECT j.answer_key, j.measured_at FROM rd.job j WHERE j.job_id = :job_id"

# ── 필터 옵션(차원표 직접, 현재 0건 값 포함: 모듈-검수-콘솔 열린 질문 1) ──
# 검수자 옵션: 서버 검수 범위(Q17) 안 job 을 판정한 이름만(D7). {scope} = scope_predicates(j) 결합
REVIEWERS_SQL = """
SELECT DISTINCT rv.reviewer_name FROM app.qa_answer_review rv
WHERE EXISTS (SELECT 1 FROM rd.job j WHERE j.job_id = rv.job_id AND {scope})
ORDER BY rv.reviewer_name"""
