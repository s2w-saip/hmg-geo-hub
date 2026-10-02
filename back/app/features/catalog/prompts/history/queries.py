"""catalog.prompts.history 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

사실 표(rd)를 읽지 않는다: app.prompt_audit_log(관리자 저빈도 편집 원장) ⋈ app.prompt(스코프 판정) ⋈ app.user_account(행위자 표시).
스코프 술어는 카탈로그(P-1)와 한 벌(catalog.queries.catalog_brand_scope·catalog_market_scope·catalog_market_filter)이다.
"""
from __future__ import annotations

from collections.abc import Sequence

EXPORT_MAX_ROWS = 5_000
SORT_COLS = ("pal.created_at", "pal.audit_id")
SORT_TYPES = ("timestamptz", "int8")

PROMPT_VISIBLE_HEAD = "SELECT 1 AS ok FROM app.prompt p WHERE "


def history_select(where: Sequence[str]) -> str:
    return (
        "SELECT pal.audit_id, pal.prompt_id, pal.event_type, pal.changes, pal.actor_id, pal.actor_type, pal.batch_id, pal.created_at,"
        " ua.email::text AS actor_email, p.text AS prompt_text, p.brand_code AS prompt_brand"
        " FROM app.prompt_audit_log pal"
        " LEFT JOIN app.prompt p ON p.prompt_id = pal.prompt_id"
        " LEFT JOIN app.user_account ua ON ua.user_id = pal.actor_id"
        " WHERE " + " AND ".join(where)
        + " ORDER BY pal.created_at DESC, pal.audit_id DESC")
