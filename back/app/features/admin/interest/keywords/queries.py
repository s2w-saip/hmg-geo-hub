"""admin.interest.keywords SQL(SQLAlchemy Core text). app.standard_keyword 만(사실 표 없음). 쓰기 = api_rw."""

COLS = "k.keyword_id, k.term, k.source_type, k.brand_code, k.enabled, k.notes, k.created_by, k.created_at, k.updated_at"

# 현행 정렬: source_type asc, created_at desc(standardKeywordRepository.list). 키 동률 안정화 = keyword_id
LIST_SELECT = f"SELECT {COLS} FROM app.standard_keyword k"
LIST_ORDER = " ORDER BY k.source_type, k.created_at DESC, k.keyword_id"

INSERT_SQL = f"""
INSERT INTO app.standard_keyword AS k (term, source_type, brand_code, notes, enabled, created_by)
VALUES (:term, :source_type, :brand_code, :notes, :enabled, app.actor())
RETURNING {COLS}"""

UPDATABLE = frozenset({"term", "source_type", "brand_code", "notes", "enabled"})

DELETE_SQL = "DELETE FROM app.standard_keyword k WHERE k.keyword_id = :id RETURNING k.keyword_id"
