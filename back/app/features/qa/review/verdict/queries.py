"""qa.review.verdict SQL(SQLAlchemy Core text). app.qa_answer_review 만.

status 는 DB GENERATED 열(하나라도 issue 면 issue)이라 앱은 섹션 플래그만 쓴다(현행 TS 파생 로직 제거).
미지정 섹션은 NULL 로 덮는다(현행 section_flags 전체 교체와 같다).
"""
REVIEW_COLS = ("job_id, status, flag_answer, flag_prompt, flag_mentions, flag_citations, flag_acr, flag_meta, reviewer_name, session_id, "
               "reviewed_at, updated_at")

GET_REVIEW_SQL = f"SELECT {REVIEW_COLS} FROM app.qa_answer_review WHERE job_id = :job_id"

UPSERT_REVIEW_SQL = f"""
INSERT INTO app.qa_answer_review (job_id, flag_answer, flag_prompt, flag_mentions, flag_citations, flag_acr, flag_meta,
                                  reviewer_id, reviewer_name, session_id)
VALUES (:job_id, :f_answer, :f_prompt, :f_mentions, :f_citations, :f_acr, :f_meta, NULL, :name, :sid)
ON CONFLICT (job_id) DO UPDATE SET flag_answer = EXCLUDED.flag_answer, flag_prompt = EXCLUDED.flag_prompt,
       flag_mentions = EXCLUDED.flag_mentions, flag_citations = EXCLUDED.flag_citations, flag_acr = EXCLUDED.flag_acr,
       flag_meta = EXCLUDED.flag_meta, reviewer_id = EXCLUDED.reviewer_id, reviewer_name = EXCLUDED.reviewer_name,
       session_id = EXCLUDED.session_id, updated_at = now()
RETURNING {REVIEW_COLS}"""
