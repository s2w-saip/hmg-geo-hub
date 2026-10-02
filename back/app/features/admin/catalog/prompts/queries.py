"""admin.catalog.prompts SQL(SQLAlchemy Core text). 읽기는 rd·app·ext 만(사실 표 없음), 쓰기는 app 만(api_rw).

- 표준 루트 = app.project(kind='standard_root', project_one_root 로 유일) / rd.dim_project(surface 1, is_root).
- rd.dim_prompt 는 루트 project_key 로 먼저 가지친다(10배 약 12만 행, dim_prompt_text_trgm_hint(surface, project_key)).
- app.prompt 쓰기의 감사(prompt_audit_log)·재판정(judgment_change catalog·prompt_kind)은 트리거 tg_catalog_change 가 남긴다.
  앱은 prompt_audit_log 에 INSERT 하지 않는다(DB-v2.4 P04: api_rw INSERT 회수).
"""

# app.prompt 응답 열(별칭 p). scope_text 는 읽기(api_ro) 조인에서만 채운다.
PROMPT_COLS = """p.prompt_id, p.text, p.prompt_type, p.category, p.brand_code, p.brand_presence, p.list_type,
       p.depth1, p.depth2, p.depth3, p.depth4, p.funnel_stage, p.kind, p.lang, p.regions, p.scope_prompt_id,
       p.status, p.created_at, p.updated_at, p.deleted_at"""

ROOT_PROJECT_SQL = "SELECT project_id FROM app.project WHERE kind = 'standard_root'"

ROOT_DIM_SQL = "SELECT project_key, regions FROM rd.dim_project WHERE surface = 1 AND is_root ORDER BY project_key LIMIT 1"

# 목록 정렬 = (depth1, depth2, depth3, text, prompt_id), NULL 은 뒤(현행 ORDER BY asc 의 NULLS LAST). 키셋은 같은 식의 행 비교.
# text 는 커서 크기 상한(512자) 때문에 앞 256자로 정렬한다.
SORT_EXPRS: tuple[str, ...] = (
    "(p.depth1 IS NULL)", "coalesce(p.depth1, '')", "(p.depth2 IS NULL)", "coalesce(p.depth2, '')",
    "(p.depth3 IS NULL)", "coalesce(p.depth3, '')", "left(p.text, 256)", "p.prompt_id")
SORT_TYPES = ("bool", "text", "bool", "text", "bool", "text", "text", "uuid")

# Scope 반영 대기·오류 요약(BG-44). 미완료(done_at IS NULL) outbox 가 있으면 대기, 그중 가장 최근 행의 last_error 가 오류.
# 완료 행(적용·superseded)은 보지 않는다. scope_outbox_aggregate_idx(aggregate, aggregate_id, created_at DESC) 접두 조회(행당 2회).
OUTBOX_COLS = """EXISTS (SELECT 1 FROM app.scope_outbox o
                WHERE o.aggregate = 'prompt' AND o.aggregate_id = p.prompt_id AND o.done_at IS NULL) AS outbox_pending,
       (SELECT o.last_error FROM app.scope_outbox o
         WHERE o.aggregate = 'prompt' AND o.aggregate_id = p.prompt_id AND o.done_at IS NULL AND o.last_error IS NOT NULL
         ORDER BY o.created_at DESC, o.outbox_id DESC LIMIT 1) AS outbox_error"""

# 쓰기 응답용 단건 표식(검증 D4). 쓰기 트랜잭션(api_rw) 안에서 읽어 방금 적재한 outbox 행까지 본다. 목록·상세와 같은 술어.
OUTBOX_FLAGS_SQL = f"""SELECT {OUTBOX_COLS} FROM app.prompt p WHERE p.prompt_id = :pid"""

LIST_SELECT = f"""SELECT {PROMPT_COLS}, dp.text AS scope_text, {OUTBOX_COLS},
       {', '.join(f'{e} AS k{i}' for i, e in enumerate(SORT_EXPRS))}
  FROM app.prompt p
  LEFT JOIN rd.dim_prompt dp ON dp.prompt_id = p.scope_prompt_id"""

STATS_SQL = """
SELECT count(*) FILTER (WHERE p.deleted_at IS NULL) AS total,
       count(*) FILTER (WHERE p.deleted_at IS NULL AND p.scope_prompt_id IS NOT NULL) AS tracked,
       count(*) FILTER (WHERE p.deleted_at IS NULL AND p.kind = 'acr') AS acr,
       count(*) FILTER (WHERE p.deleted_at IS NOT NULL) AS deleted
  FROM app.prompt p
 WHERE p.project_id = :root"""

# 드리프트: Scope 루트 프롬프트 중 어떤 app.prompt 도(프로젝트·삭제 무관, 현행 동일) 연결하지 않은 수
SCOPE_ORPHANS_SQL = """
SELECT count(*) AS n
  FROM rd.dim_prompt d
 WHERE d.surface = 1 AND d.project_key = :rk
   AND NOT EXISTS (SELECT 1 FROM app.prompt p WHERE p.scope_prompt_id = d.prompt_id)"""

DETAIL_SQL = f"""
SELECT {PROMPT_COLS}, dp.text AS scope_text, {OUTBOX_COLS}
  FROM app.prompt p
  LEFT JOIN rd.dim_prompt dp ON dp.prompt_id = p.scope_prompt_id
 WHERE p.prompt_id = :pid AND p.project_id = :root"""

PENDING_CHANGES_SQL = """
SELECT change_id, kind, status, requested_at
  FROM app.judgment_change
 WHERE status IN ('pending', 'running') AND kind IN ('catalog', 'prompt_kind') AND payload->>'prompt_id' = :pid
 ORDER BY change_id"""

PENDING_OUTBOX_SQL = """
SELECT outbox_id, op, attempts, created_at, last_error
  FROM app.scope_outbox
 WHERE aggregate = 'prompt' AND aggregate_id = :pid AND done_at IS NULL
 ORDER BY outbox_id"""

# ── 쓰기(api_rw, app 만) ──
LOCK_ROW_SQL = f"""
SELECT {PROMPT_COLS}
  FROM app.prompt p
 WHERE p.prompt_id = :pid AND p.project_id = :root
 FOR UPDATE"""

INSERT_SQL = f"""
INSERT INTO app.prompt AS p (project_id, text, prompt_type, category, brand_code, brand_presence, list_type,
                             depth1, depth2, depth3, depth4, funnel_stage, kind, lang, regions, created_by, updated_by)
VALUES (:root, :text, :prompt_type, :category, :brand_code, :brand_presence, :list_type,
        :depth1, :depth2, :depth3, :depth4, :funnel_stage, :kind, :lang, CAST(:regions AS text[]), app.actor(), app.actor())
RETURNING {PROMPT_COLS}"""

# UPDATE 에 쓸 수 있는 열(값은 바인드). deleted_at 은 service 가 now()/NULL 상수 조각을 고른다.
UPDATABLE = frozenset({"text", "prompt_type", "category", "brand_code", "brand_presence", "list_type", "depth1", "depth2",
                       "depth3", "depth4", "funnel_stage", "kind", "lang", "regions"})
DELETED_AT_SET = {"delete": "now()", "restore": "NULL"}

# 이번 트랜잭션에서 트리거가 남긴 재판정 요청(requested_at 기본값 now() = 트랜잭션 시각)
TX_CHANGES_SQL = """
SELECT change_id FROM app.judgment_change
 WHERE requested_at = now() AND kind IN ('catalog', 'prompt_kind') AND payload->>'prompt_id' = :pid
 ORDER BY change_id"""

PENDING_CREATE_SQL = """
SELECT outbox_id FROM app.scope_outbox
 WHERE aggregate = 'prompt' AND aggregate_id = :pid AND op = 'create' AND done_at IS NULL
 LIMIT 1"""
