\echo == 'late' 귀속 run 수·답변(ing.cycle_run attributed_by='late')
SELECT c.surface, c.round_date, count(DISTINCT cr.run_id) AS runs, cy.servable, cy.cyc_key
  FROM ing.cycle_run cr JOIN ing.cycle c ON c.cycle_id = cr.cycle_id JOIN rd.cycle cy ON cy.cycle_id = c.cycle_id
 WHERE cr.attributed_by = 'late' GROUP BY 1,2,4,5 ORDER BY 1,2;
\echo == late run 답변의 rd 게이트 분포(표면·round_date·elig·dflt·std_in, 현대 모집단 여부)
SELECT a.surface, a.round_date, a.elig, a.dflt, a.std_in, (a.bgrp & 9) <> 0 AS hy_pop, count(*),
       count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM mig_src.scope_answer_cycle_anchors x WHERE x.job_id = j.job_id)) AS no_current_anchor
  FROM ing.cycle_run cr JOIN rd.answer a ON a.run_key = (SELECT run_key FROM ing.run r WHERE r.run_id = cr.run_id)
  JOIN rd.job j ON j.answer_key = a.answer_key
 WHERE cr.attributed_by = 'late' GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,3,4,5,6;
\echo == rd 에만 있는 답변(현행 앵커 없음) 표면·round_date 분포 상위
SELECT a.surface, a.round_date, a.elig, count(*)
  FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key
 WHERE NOT EXISTS (SELECT 1 FROM mig_src.scope_answer_cycle_anchors x WHERE x.job_id = j.job_id)
 GROUP BY 1,2,3 ORDER BY 4 DESC LIMIT 20;
