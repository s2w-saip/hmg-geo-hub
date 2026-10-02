"""admin.interest.sources SQL(SQLAlchemy Core text). app.standard_source 만(사실 표 없음). 쓰기 = api_rw."""

COLS = "k.source_id, k.url, k.channel, k.brand_code, k.enabled, k.notes, k.created_by, k.created_at, k.updated_at"

# 현행 정렬: channel asc, created_at desc(standardSourceRepository.list). 키 동률 안정화 = source_id
LIST_SELECT = f"SELECT {COLS} FROM app.standard_source k"
LIST_ORDER = " ORDER BY k.channel, k.created_at DESC, k.source_id"

INSERT_SQL = f"""
INSERT INTO app.standard_source AS k (url, channel, brand_code, notes, enabled, created_by)
VALUES (:url, :channel, :brand_code, :notes, :enabled, app.actor())
RETURNING {COLS}"""

UPDATABLE = frozenset({"url", "channel", "brand_code", "notes", "enabled"})

DELETE_SQL = "DELETE FROM app.standard_source k WHERE k.source_id = :id RETURNING k.source_id"
