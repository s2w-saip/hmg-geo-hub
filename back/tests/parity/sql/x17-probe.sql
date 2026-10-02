\echo == C08 beijing-hyundai.com.cn 비자사 인용(old 881 자사 vs rd 877)
WITH s AS (SELECT a.answer_key, a.round_date, a.prompt_key FROM rd.answer a WHERE a.surface = 2 AND a.round_date = '2026-09-25' AND a.bgrp = 1 AND a.dflt AND a.elig AND a.is_rep)
SELECT u.url_base_norm, u.url_norm, w.base, w.home_host, c.loc_owned, c.tgt_hit, count(*)
  FROM rd.citation c JOIN s ON s.answer_key = c.answer_key AND s.round_date = c.round_date
  JOIN rd.dim_url u ON u.url_key = c.url_key JOIN rd.dim_source ds ON ds.source_key = c.source_key
  JOIN rd.dim_prompt dp ON dp.prompt_key = s.prompt_key LEFT JOIN rd.web_unit w ON w.unit_key = dp.unit_key
 WHERE c.surface = 2 AND ds.domain = 'beijing-hyundai.com.cn' AND NOT (c.loc_owned OR c.tgt_hit)
 GROUP BY 1,2,3,4,5,6 ORDER BY 7 DESC LIMIT 20;
