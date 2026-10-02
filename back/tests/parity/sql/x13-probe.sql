\echo == C08 자사 인용 -4: 같은 프롬프트의 다른 웹 유닛(여러 사이트·file_seq 에 등록) 기준으로는 자사인 인용(A4 #5 후보)
WITH s AS (SELECT a.answer_key, a.round_date, a.prompt_key FROM rd.answer a
            WHERE a.surface = 2 AND a.round_date = '2026-09-25' AND a.bgrp = 1 AND a.dflt AND a.elig AND a.is_rep),
units AS (SELECT DISTINCT dp.prompt_key, w.unit_key, w.base, w.sibs, w.home_host, w.turls
            FROM rd.dim_prompt dp JOIN app.website_prompt wp ON wp.scope_prompt_id = dp.prompt_id
            JOIN rd.dim_project pj ON pj.site_id = wp.site_id JOIN rd.web_unit w ON w.project_key = pj.project_key AND w.file_seq = wp.file_seq
           WHERE dp.surface = 2 AND w.base IS NOT NULL)
SELECT count(DISTINCT (c.answer_key, c.ord)) AS other_unit_owned, count(DISTINCT dp.prompt_key) AS prompts
  FROM rd.citation c JOIN s ON s.answer_key = c.answer_key AND s.round_date = c.round_date
  JOIN rd.dim_url u ON u.url_key = c.url_key JOIN rd.dim_prompt dp ON dp.prompt_key = c.prompt_key
  JOIN units x ON x.prompt_key = c.prompt_key AND x.unit_key IS DISTINCT FROM dp.unit_key
 WHERE c.surface = 2 AND NOT (c.loc_owned OR c.tgt_hit)
   AND ((split_part(u.url_base_norm, '/', 1) = split_part(x.base, '/', 1)
         AND ((u.url_base_norm = x.base OR starts_with(u.url_base_norm, x.base || '/') OR u.url_base_norm = x.base || '.html')
              AND NOT EXISTS (SELECT 1 FROM unnest(x.sibs) q WHERE u.url_base_norm = q OR starts_with(u.url_base_norm, q || '/'))
              OR (x.home_host IS NOT NULL AND rtrim(split_part(u.url_base_norm, '?', 1), '/') = x.home_host)))
        OR (coalesce(u.url_norm, '') <> '' AND u.url_norm = ANY (x.turls)));
\echo == 다중 유닛 프롬프트 수(웹 표면)
SELECT count(*) FROM (SELECT dp.prompt_key FROM rd.dim_prompt dp JOIN app.website_prompt wp ON wp.scope_prompt_id = dp.prompt_id
  WHERE dp.surface = 2 GROUP BY 1 HAVING count(DISTINCT (wp.site_id, wp.file_seq)) > 1) x;
