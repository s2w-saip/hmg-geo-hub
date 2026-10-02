\echo == 'late' 귀속 2026-06 글로벌 run(594) 답변이 모든 조합 모수 밖인 이유
WITH lr AS (SELECT r.run_key FROM ing.cycle_run cr JOIN ing.run r ON r.run_id = cr.run_id JOIN ing.cycle c ON c.cycle_id = cr.cycle_id
             WHERE cr.attributed_by = 'late' AND c.surface = 'global' AND c.round_date < '2026-07-01')
SELECT count(DISTINCT a.run_key) AS runs, count(*) AS answers, a.cat_mask, dp.in_root_catalog, a.elig, a.dflt, (a.geo_key = 0) AS no_geo,
       ir.status AS run_status
  FROM rd.answer a JOIN lr ON lr.run_key = a.run_key JOIN rd.dim_prompt dp ON dp.prompt_key = a.prompt_key
  JOIN ing.run ir ON ir.run_key = a.run_key
 WHERE a.surface = 1 GROUP BY 3,4,5,6,7,8 ORDER BY 2 DESC;
