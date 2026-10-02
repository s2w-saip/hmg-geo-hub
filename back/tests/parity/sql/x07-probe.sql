\echo == 소프트삭제 카탈로그 행만 가진 프롬프트(현행 포함·rd 제외, A4 #1)의 873 회차 답변
WITH root AS (SELECT p.scope_prompt_id, p.deleted_at, coalesce(b.brand_bit, 8) AS bit
                FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
                LEFT JOIN app.brand b ON b.brand_code = p.brand_code WHERE p.scope_prompt_id IS NOT NULL),
oldcat AS (SELECT scope_prompt_id, bit_or(bit) AS old_mask, bool_and(deleted_at IS NOT NULL) AS only_deleted,
                  bit_or(bit) FILTER (WHERE deleted_at IS NULL) AS live_mask FROM root GROUP BY 1)
SELECT g.code, e.code AS eng, o.old_mask, o.live_mask, o.only_deleted, count(*) AS answers, count(DISTINCT dp.prompt_key) AS prompts
  FROM rd.answer a JOIN rd.dim_prompt dp ON dp.prompt_key = a.prompt_key JOIN oldcat o ON o.scope_prompt_id = dp.prompt_id
  JOIN rd.dim_country g ON g.geo_key = a.geo_key JOIN rd.dim_engine e ON e.engine_key = a.engine_key
 WHERE a.surface = 1 AND a.cyc_key = 873 AND (o.only_deleted OR o.old_mask <> coalesce(o.live_mask, 0))
 GROUP BY 1,2,3,4,5 ORDER BY 6 DESC LIMIT 40;
\echo == C03 모사: 현행 카탈로그(삭제행 포함) 모집단, 셀 대표(측정 최신)
WITH root AS (SELECT p.scope_prompt_id, coalesce(b.brand_bit, 8) AS bit
                FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
                LEFT JOIN app.brand b ON b.brand_code = p.brand_code WHERE p.scope_prompt_id IS NOT NULL),
oldcat AS (SELECT scope_prompt_id, bit_or(bit) AS old_mask FROM root GROUP BY 1),
a AS (SELECT a.*, j.measured_at FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key JOIN rd.dim_prompt dp ON dp.prompt_key = a.prompt_key
        JOIN oldcat o ON o.scope_prompt_id = dp.prompt_id
       WHERE a.surface = 1 AND a.cyc_key = 873 AND (o.old_mask & 12) <> 0 AND a.engine_key = 2 AND a.geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = 'KR')),
r AS (SELECT DISTINCT ON (prompt_key, engine_key, geo_key) * FROM a ORDER BY prompt_key, engine_key, geo_key, measured_at DESC, answer_key DESC)
SELECT count(*) n, count(*) FILTER (WHERE own_mask & 4 <> 0) vis, sum(ment_g) sov_n, sum(ment_total) sov_d, sum(sent_pos_g) sp FROM r;
