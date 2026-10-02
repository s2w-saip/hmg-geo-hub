\echo == dim_url / dim_source 샘플(hyundai 계열)
SELECT u.url_key, u.host, u.domain AS u_domain, s.domain AS s_domain, s.skey, u.owner_key, u.source_key FROM rd.dim_url u LEFT JOIN rd.dim_source s USING (source_key)
 WHERE u.host LIKE '%hyundai%' OR u.host LIKE '%reddit%' LIMIT 12;
SELECT count(*) AS urls, count(*) FILTER (WHERE u.domain IS DISTINCT FROM s.domain) AS domain_diff FROM rd.dim_url u LEFT JOIN rd.dim_source s USING (source_key);
\echo == report_publication
SELECT id, surface, brand_scope, round_date, prev_round_date, status, excluded_fs, engines FROM app.report_publication;
SELECT round_date, count(*), sum(measured_prompts), sum(target_hit_prompts), sum(owned_prompts), sum(owned_prompts_den) FROM rd.report_unit_value GROUP BY 1;
\echo == website 09-25 fs별(web_unit) Hyundai
SELECT w.file_seq, dp.site_brand_bit, count(*) FROM rd.answer a JOIN rd.dim_project dp USING (project_key) LEFT JOIN rd.web_unit w ON w.project_key = a.project_key
 WHERE a.surface = 2 AND a.round_date = '2026-09-25' AND w.file_seq IN (71,94,97) GROUP BY 1,2;
\echo == C08 target_rate 후보: 1년 누적 프롬프트(web_reg), 09-25 스냅샷 프롬프트
SELECT count(DISTINCT prompt_key) FILTER (WHERE web_reg) reg_p, count(DISTINCT prompt_key) FILTER (WHERE web_reg AND tgt_cited) tgt_p,
       count(DISTINCT prompt_key) FILTER (WHERE web_reg AND own_url_cited) own_p
  FROM rd.answer WHERE surface = 2 AND bgrp = 1 AND dflt AND elig AND round_date BETWEEN '2025-09-28' AND '2026-09-27';
SELECT round_date, count(DISTINCT prompt_key) FILTER (WHERE web_reg) reg_p, count(DISTINCT prompt_key) FILTER (WHERE web_reg AND tgt_cited) tgt_p
  FROM rd.answer WHERE surface = 2 AND bgrp = 1 AND dflt AND elig AND round_date >= '2026-09-01' GROUP BY 1 ORDER BY 1;
\echo == 엔진 분포 global 09-14
SELECT engine_key, count(*) FROM rd.answer WHERE surface = 1 AND round_date = '2026-09-14' GROUP BY 1;
\echo == website 엔진 분포 09-25
SELECT engine_key, count(*) FROM rd.answer WHERE surface = 2 AND round_date = '2026-09-25' GROUP BY 1;
\echo == job measured_at null
SELECT surface, count(*) FILTER (WHERE measured_at IS NULL), count(*) FROM rd.job GROUP BY 1;
