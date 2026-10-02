\echo == 웹사이트 Hyundai 프로젝트: round_date 별 회차 수(합쳐진 좌석) · 답변 · 셀 대표 수(회차 단위) vs 셀 수(round 단위)
SELECT c.round_date, count(DISTINCT c.cyc_key) AS cycles, count(DISTINCT c.project_key) AS projects,
       (SELECT count(*) FROM rd.answer a WHERE a.surface = 2 AND a.round_date = c.round_date AND a.bgrp = 1 AND a.dflt AND a.elig AND a.is_rep) AS rep_per_cycle,
       (SELECT count(DISTINCT (a.prompt_key, a.engine_key, a.geo_key)) FROM rd.answer a WHERE a.surface = 2 AND a.round_date = c.round_date AND a.bgrp = 1 AND a.dflt AND a.elig) AS cells_per_round
  FROM rd.cycle c JOIN rd.dim_project dp ON dp.project_key = c.project_key
 WHERE c.surface = 2 AND dp.site_brand_bit = 1 AND c.round_date >= '2026-07-01' AND c.servable
 GROUP BY 1 ORDER BY 1;
