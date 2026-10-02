\echo == C08 -4 가설 A: 같은 사이트(프로젝트) 다른 유닛의 타겟 URL 과 일치하는 비자사 인용
WITH s AS (SELECT a.answer_key, a.round_date, a.project_key FROM rd.answer a
            WHERE a.surface = 2 AND a.round_date = '2026-09-25' AND a.bgrp = 1 AND a.dflt AND a.elig AND a.is_rep),
pt AS (SELECT w.project_key, t AS turl FROM rd.web_unit w CROSS JOIN LATERAL unnest(w.turls) t
       UNION SELECT dp.project_key, t FROM rd.dim_prompt dp CROSS JOIN LATERAL unnest(dp.targets) t WHERE dp.surface = 2)
SELECT count(*) AS n, count(DISTINCT c.answer_key) AS answers
  FROM rd.citation c JOIN s ON s.answer_key = c.answer_key AND s.round_date = c.round_date
  JOIN rd.dim_url u ON u.url_key = c.url_key
 WHERE c.surface = 2 AND NOT (c.loc_owned OR c.tgt_hit) AND coalesce(u.url_norm, '') <> ''
   AND EXISTS (SELECT 1 FROM pt WHERE pt.project_key = s.project_key AND pt.turl = u.url_norm);
\echo == 가설 B: 유닛 없는 프롬프트(unit_key NULL) 또는 base 없는 유닛의 인용 중 호스트가 사이트 홈과 같은 것
WITH s AS (SELECT a.answer_key, a.round_date, a.prompt_key, a.project_key FROM rd.answer a
            WHERE a.surface = 2 AND a.round_date = '2026-09-25' AND a.bgrp = 1 AND a.dflt AND a.elig AND a.is_rep)
SELECT (dp.unit_key IS NULL) AS no_unit, count(*) AS cits, count(*) FILTER (WHERE c.loc_owned OR c.tgt_hit) AS owned
  FROM rd.citation c JOIN s ON s.answer_key = c.answer_key AND s.round_date = c.round_date JOIN rd.dim_prompt dp ON dp.prompt_key = s.prompt_key
 WHERE c.surface = 2 GROUP BY 1;
