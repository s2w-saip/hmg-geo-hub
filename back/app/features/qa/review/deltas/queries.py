"""qa.review.deltas SQL(SQLAlchemy Core text). app.qa_answer_lock·app.qa_answer_review PK 등치 + rd.job(job_id UNIQUE) 범위 확인."""
from app.core.sqlb import Binder, Sql
from app.features.qa.answers.list.scope import scope_predicates


def locks_sql(ids: list[str], ttl: int) -> Sql:
    b = Binder()
    w = [f"l.job_id = ANY({b.v(ids, 'uuid[]')})", f"l.heartbeat_at > now() - {b.v(ttl, 'int4')} * interval '1 second'",
         *scope_predicates(b)]
    return b.sql("SELECT l.job_id, l.session_id, l.reviewer_name, l.acquired_at, l.heartbeat_at "
                 f"FROM app.qa_answer_lock l JOIN rd.job j ON j.job_id = l.job_id WHERE {' AND '.join(w)} ORDER BY l.job_id")


def reviews_sql(ids: list[str]) -> Sql:
    b = Binder()
    w = [f"rv.job_id = ANY({b.v(ids, 'uuid[]')})", *scope_predicates(b)]
    return b.sql("SELECT rv.job_id, rv.status, rv.reviewer_name, rv.updated_at "
                 f"FROM app.qa_answer_review rv JOIN rd.job j ON j.job_id = rv.job_id WHERE {' AND '.join(w)} ORDER BY rv.job_id")
