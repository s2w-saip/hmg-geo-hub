"""admin.catalog.bulk SQL(SQLAlchemy Core text). 읽기는 app 만(표준 루트 활성 행), 쓰기는 admin.catalog.prompts.service 를 거친다."""
from app.features.admin.catalog.prompts.queries import PROMPT_COLS, SORT_EXPRS

# 표준 루트 활성 행(내보내기 순서 = 목록 정렬과 같다)
LIVE_ROWS_SQL = f"""
SELECT {PROMPT_COLS}
  FROM app.prompt p
 WHERE p.project_id = :root AND p.deleted_at IS NULL
 ORDER BY {', '.join(SORT_EXPRS)}"""
