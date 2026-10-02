\echo == 1. website 09-18 숨김 회차와 hidden_at
SELECT c.cyc_key, c.project_key, c.round_date, c.hidden_scope, sc.hidden_reason, sc.hidden_at, sc.hidden_scope AS src_scope, dp.site_brand_bit, g.code AS site_geo
  FROM rd.cycle c JOIN mig_src.summary_cycles sc ON sc.cycle_id = c.cycle_id JOIN rd.dim_project dp ON dp.project_key = c.project_key
  LEFT JOIN rd.dim_country g ON g.geo_key = dp.site_geo_key
 WHERE c.hidden_scope <> 0 ORDER BY c.round_date DESC LIMIT 20;
\echo == 2. 글로벌 873 회차: 드롭 job(현재 rd 에 없음)의 모집단별 분포와 드롭 시각
SELECT (j.bgrp & 12) <> 0 AS gen_pop, (j.bgrp & 9) <> 0 AS hy_pop, g.code, e.code AS eng, date_trunc('hour', d.dropped_at) AS dropped_h, count(*)
  FROM rd.job j JOIN mig_src.scope_answer_drops d ON d.job_id = j.job_id
  JOIN rd.dim_country g ON g.geo_key = j.geo_key JOIN rd.dim_engine e ON e.engine_key = j.engine_key
 WHERE j.surface = 1 AND j.cyc_key = 873 GROUP BY 1,2,3,4,5 ORDER BY 6 DESC LIMIT 25;
\echo == 3. C03 셀(Genesis 모집단 KR gemini, 873) 중 드롭으로 elig 답변이 0 이 된 셀
WITH jj AS (SELECT j.*, (d.job_id IS NOT NULL) AS drp, d.dropped_at FROM rd.job j LEFT JOIN mig_src.scope_answer_drops d ON d.job_id = j.job_id
             WHERE j.surface = 1 AND j.cyc_key = 873 AND (j.bgrp & 12) <> 0 AND j.engine_key = 2
               AND j.geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = 'KR'))
SELECT prompt_key, count(*) AS jobs, count(*) FILTER (WHERE status_code = 0) AS completed, count(*) FILTER (WHERE drp) AS dropped,
       count(*) FILTER (WHERE served) AS served, min(dropped_at), bool_or(prompt_key IN (SELECT prompt_key FROM rd.answer WHERE surface = 1 AND cyc_key = 873 AND elig)) AS any_elig
  FROM jj GROUP BY 1 HAVING count(*) FILTER (WHERE served) = 0 ORDER BY 1 LIMIT 30;
\echo == 4. C03 elig 이 아닌 served 답변(카탈로그·지역 게이트)
SELECT a.elig, count(*) FROM rd.answer a WHERE a.surface = 1 AND a.cyc_key = 873 AND (a.bgrp & 12) <> 0 AND a.engine_key = 2
   AND a.geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = 'KR') GROUP BY 1;
\echo == 5. 873 회차 셀 대표가 summary 생성(2026-09-15 17:12:04Z) 이후 측정된 답변인 셀 수(모집단별)
SELECT (a.bgrp & 9) <> 0 AS hy, (a.bgrp & 12) <> 0 AS gen, count(*) AS rep_after_gen
  FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key
 WHERE a.surface = 1 AND a.cyc_key = 873 AND a.is_rep AND a.elig AND a.dflt AND j.measured_at > '2026-09-15 17:12:04+00' GROUP BY 1,2;
