"""projects.settings.tracked_urls SQL(app 만). PK(project_id, url_norm). 목록은 (created_at DESC, url_norm DESC) 키셋."""
from __future__ import annotations

URL_COLS = "u.url, u.url_norm, u.label, u.created_by, u.created_at"
SORT_COLS = ("u.created_at", "u.url_norm")


def list_sql(keyset: str | None) -> str:
    where = "u.project_id = :pid" + (f" AND {keyset}" if keyset else "")
    return f"SELECT {URL_COLS} FROM app.project_tracked_url u WHERE {where} ORDER BY u.created_at DESC, u.url_norm DESC LIMIT :lim"


COUNT = "SELECT count(*) AS n FROM app.project_tracked_url WHERE project_id = :pid"
ALL = f"SELECT {URL_COLS} FROM app.project_tracked_url u WHERE u.project_id = :pid ORDER BY u.created_at DESC, u.url_norm DESC"
LOCK_PROJECT = "SELECT project_id FROM app.project WHERE project_id = :pid FOR UPDATE"

INSERT = f"""
INSERT INTO app.project_tracked_url AS u (project_id, url, url_norm, label, created_by)
VALUES (:pid, :url, :norm, :label, :uid)
ON CONFLICT (project_id, url_norm) DO NOTHING
RETURNING {URL_COLS}
"""

DELETE = "DELETE FROM app.project_tracked_url WHERE project_id = :pid AND url_norm = :norm RETURNING url_norm"

UPDATE = """
UPDATE app.project_tracked_url SET url = :url, url_norm = :new_norm, label = :label
 WHERE project_id = :pid AND url_norm = :norm
   AND NOT EXISTS (SELECT 1 FROM app.project_tracked_url x WHERE x.project_id = :pid AND x.url_norm = :new_norm AND :new_norm <> :norm)
RETURNING url_norm
"""

# 가져오기 일괄 적용(B026). 행 판정은 service.import_xlsx 가 프로젝트 잠금 뒤 읽은 현재 행(ALL)으로 행 순서대로 끝내고,
# 결과(정본 행별 최종 값)만 한 문장씩 쓴다. 다른 쓰기와 엇갈린 행은 RETURNING 에 없다(그 행은 건너뜀으로 센다).
BULK_UPDATE = """
UPDATE app.project_tracked_url u SET url = x.url, url_norm = x.new_norm, label = x.label
  FROM unnest(CAST(:norms AS text[]), CAST(:new_norms AS text[]), CAST(:urls AS text[]), CAST(:labels AS text[]))
       AS x(norm, new_norm, url, label)
 WHERE u.project_id = :pid AND u.url_norm = x.norm
RETURNING x.norm
"""

BULK_INSERT = f"""
INSERT INTO app.project_tracked_url AS u (project_id, url, url_norm, label, created_by)
SELECT :pid, x.url, x.norm, x.label, :uid
  FROM unnest(CAST(:urls AS text[]), CAST(:norms AS text[]), CAST(:labels AS text[])) WITH ORDINALITY AS x(url, norm, label, ord)
 ORDER BY x.ord
ON CONFLICT (project_id, url_norm) DO NOTHING
RETURNING {URL_COLS}
"""
