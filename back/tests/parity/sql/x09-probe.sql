\echo == 비 elig 서빙 답변의 사유 분해(글로벌, dflt, old 카탈로그 Hyundai 모집단, 2025-09-28~2026-09-27)
WITH root AS (SELECT p.scope_prompt_id, bit_or(coalesce(b.brand_bit, 8)) AS m, bool_or(p.deleted_at IS NULL) AS live
                FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root'
                LEFT JOIN app.brand b ON b.brand_code = p.brand_code WHERE p.scope_prompt_id IS NOT NULL GROUP BY 1),
x AS (SELECT a.answer_key, a.round_date, a.elig, a.cyc_key, c.servable, r.status AS run_status, g.code AS region, g.hidden_standard,
             dp.in_root_catalog, o.live, dp.is_korean, dp.regions, (a.round_date >= '2026-08-28') AS in_c04
        FROM rd.answer a JOIN rd.cycle c USING (cyc_key) JOIN rd.dim_prompt dp ON dp.prompt_key = a.prompt_key
        JOIN root o ON o.scope_prompt_id = dp.prompt_id
        JOIN rd.job j ON j.answer_key = a.answer_key JOIN ing.answer_key_map m ON m.job_id = j.job_id
        JOIN ing.answer ia ON ia.job_id = m.job_id AND ia.run_month = m.run_month JOIN ing.run r ON r.run_id = ia.run_id
        LEFT JOIN rd.dim_country g ON g.geo_key = a.geo_key
       WHERE a.surface = 1 AND a.round_date BETWEEN '2025-09-28' AND '2026-09-27' AND a.dflt AND (o.m & 9) <> 0)
SELECT in_c04, elig, servable, run_status, hidden_standard, in_root_catalog, live,
       (is_korean AND region <> 'KR') AS ko_nonkr, (regions IS NOT NULL AND cardinality(regions) > 0 AND NOT coalesce(region = ANY(regions), false)) AS off_tag,
       count(*)
  FROM x WHERE NOT elig OR NOT servable GROUP BY 1,2,3,4,5,6,7,8,9 ORDER BY 1, 10 DESC;
