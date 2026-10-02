\echo == 1. round_date -1일 6개 프로젝트(09-17 유령 회차)의 사이트 브랜드·국가
SELECT c.cyc_key, c.project_key, c.round_date, c.anchor_date, c.servable, dp.site_brand_bit, g.code AS site_geo,
       (SELECT count(*) FROM rd.answer a WHERE a.surface = 2 AND a.cyc_key = c.cyc_key) AS answers
  FROM rd.cycle c JOIN rd.dim_project dp ON dp.project_key = c.project_key LEFT JOIN rd.dim_country g ON g.geo_key = dp.site_geo_key
 WHERE c.surface = 2 AND c.round_date = '2026-09-17' ORDER BY 1;
\echo == 2. Hyundai 웹 08-21·08-28·09-04 에만 있는 셀(09-11 대비 +16)
WITH r AS (SELECT DISTINCT a.round_date, a.project_key, a.prompt_key, a.engine_key, a.geo_key FROM rd.answer a
            WHERE a.surface = 2 AND a.bgrp = 1 AND a.dflt AND a.elig AND a.round_date IN ('2026-08-28', '2026-09-11'))
SELECT x.project_key, dp.site_geo_key, count(*) AS extra_cells, count(DISTINCT x.prompt_key) AS prompts,
       bool_and(p.web_reg) AS reg, min(p.unit_key) AS unit
  FROM r x JOIN rd.dim_project dp ON dp.project_key = x.project_key JOIN rd.dim_prompt p ON p.prompt_key = x.prompt_key
 WHERE x.round_date = '2026-08-28' AND NOT EXISTS (SELECT 1 FROM r y WHERE y.round_date = '2026-09-11' AND (y.project_key, y.prompt_key, y.engine_key, y.geo_key) = (x.project_key, x.prompt_key, x.engine_key, x.geo_key))
 GROUP BY 1,2;
\echo == 3. C08 beijing 자사 -4: 같은 인용 URL 이 다른 답변에서는 자사로 판정된 경우(판정이 프롬프트 유닛에 따라 갈림)
WITH s AS (SELECT a.answer_key, a.round_date FROM rd.answer a WHERE a.surface = 2 AND a.round_date = '2026-09-25' AND a.bgrp = 1 AND a.dflt AND a.elig AND a.is_rep),
cc AS (SELECT c.url_key, bool_or(c.loc_owned OR c.tgt_hit) AS any_owned, bool_and(c.loc_owned OR c.tgt_hit) AS all_owned, count(*) AS n
         FROM rd.citation c JOIN s ON s.answer_key = c.answer_key AND s.round_date = c.round_date JOIN rd.dim_source ds ON ds.source_key = c.source_key
        WHERE c.surface = 2 AND ds.domain = 'beijing-hyundai.com.cn' GROUP BY 1)
SELECT u.url_norm, cc.n, cc.any_owned, cc.all_owned FROM cc JOIN rd.dim_url u USING (url_key) WHERE cc.any_owned AND NOT cc.all_owned LIMIT 10;
