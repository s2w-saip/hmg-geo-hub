\echo == C05·C04 창: 현행 앵커(ca, standard) 행을 rd 상태로 분류 (Hyundai 모집단은 old 카탈로그 비트, dflt)
WITH root AS (SELECT p.scope_prompt_id, bit_or(coalesce(b.brand_bit, 8)) AS m
                FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
                LEFT JOIN app.brand b ON b.brand_code = p.brand_code WHERE p.scope_prompt_id IS NOT NULL GROUP BY 1),
ca AS (SELECT c.job_id, c.round_date, c.is_default_engine, c.source FROM mig_src.scope_answer_cycle_anchors c
        WHERE c.surface = 'standard' AND c.round_date BETWEEN '2025-09-28' AND '2026-09-27'),
x AS (SELECT ca.*, j.answer_key, j.served, j.dropped, j.status_code, j.round_date AS rd_rd, a.elig, a.std_in, cyc.servable,
             (o.m & 9) <> 0 AS hy_old, (j.bgrp & 9) <> 0 AS hy_new, ca.round_date >= '2026-08-28' AS in_c04
        FROM ca LEFT JOIN rd.job j ON j.job_id = ca.job_id
        LEFT JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
        LEFT JOIN rd.cycle cyc ON cyc.cyc_key = j.cyc_key
        LEFT JOIN rd.dim_prompt dp ON dp.prompt_key = j.prompt_key LEFT JOIN root o ON o.scope_prompt_id = dp.prompt_id)
SELECT in_c04, is_default_engine AS dflt, hy_old, (answer_key IS NOT NULL) AS in_rdjob, served, elig, servable, source, count(*)
  FROM x WHERE is_default_engine AND hy_old GROUP BY 1,2,3,4,5,6,7,8 ORDER BY 1,9 DESC;
\echo == 드롭·미완료(served=false) 사유
WITH ca AS (SELECT c.job_id FROM mig_src.scope_answer_cycle_anchors c WHERE c.surface = 'standard' AND c.round_date BETWEEN '2025-09-28' AND '2026-09-27' AND c.is_default_engine)
SELECT j.dropped, j.status_code, count(*) FROM ca JOIN rd.job j ON j.job_id = ca.job_id WHERE NOT j.served GROUP BY 1,2;
