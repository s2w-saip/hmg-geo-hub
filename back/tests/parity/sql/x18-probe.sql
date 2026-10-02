\echo == C11 F05 잔여 가설: 비기본 엔진(deepseek) 포함 — 차이 old-emu = 2460/2615
SELECT e.code, count(*), sum(a.ment_h), sum(a.ment_total) FROM rd.answer a JOIN rd.dim_engine e USING (engine_key)
 WHERE a.surface = 2 AND a.bgrp = 1 AND a.round_date BETWEEN '2025-09-28' AND '2026-09-27' AND NOT a.dflt GROUP BY 1;
\echo == C05 EG: 신규 모수에서 빠진 이유(서빙 답변, 현대 old 카탈로그, dflt)
SELECT a.elig, a.std_in, c.servable, dp.is_korean, dp.regions, count(*)
  FROM rd.answer a JOIN rd.cycle c USING (cyc_key) JOIN rd.dim_prompt dp ON dp.prompt_key = a.prompt_key
 WHERE a.surface = 1 AND a.geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = 'EG') AND a.dflt AND (a.cat_mask & 9) <> 0
   AND a.round_date BETWEEN '2025-09-28' AND '2026-09-27' GROUP BY 1,2,3,4,5 ORDER BY 6 DESC LIMIT 10;
