\echo == 1. 고정(pin) 답변: 회차 655·772·873 (글로벌) — 원래 측정시각 vs 미러 measured_at(접힌 값)
SELECT a.cyc_key, date_trunc('week', j.measured_at AT TIME ZONE 'UTC')::date AS wk_rd, date_trunc('week', sa.measured_at AT TIME ZONE 'UTC')::date AS wk_mirror,
       p.anchor, count(*)
  FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key
  JOIN mig_src.scope_answers sa ON sa.job_id = j.job_id
  LEFT JOIN ing.answer_anchor_pin p ON p.job_id = j.job_id
 WHERE a.surface = 1 AND a.cyc_key IN (655, 772, 873) AND (j.measured_at IS DISTINCT FROM sa.measured_at)
 GROUP BY 1,2,3,4 ORDER BY 1,2,3 LIMIT 30;
\echo == 2. C05 인용: 숨김(citations) 회차 551 의 인용 행(현대 old 카탈로그 모집단, dflt)
SELECT count(*) AS cit, count(*) FILTER (WHERE ob.brand_code = 'Hyundai') AS own
  FROM rd.citation c JOIN rd.answer a ON a.surface = c.surface AND a.round_date = c.round_date AND a.answer_key = c.answer_key
  LEFT JOIN app.owned_base ob ON ob.owner_key = c.owner_key AND c.owner_key <> 0
 WHERE c.surface = 1 AND c.cyc_key = 551 AND a.dflt
   AND a.prompt_key IN (SELECT dp.prompt_key FROM rd.dim_prompt dp JOIN (SELECT p.scope_prompt_id AS pid, bit_or(coalesce(b.brand_bit, 8)) AS m
        FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id AND pr.kind = 'standard_root' LEFT JOIN app.brand b ON b.brand_code = p.brand_code
        WHERE p.scope_prompt_id IS NOT NULL GROUP BY 1) o ON o.pid = dp.prompt_id WHERE (o.m & 9) <> 0)
   AND a.geo_key NOT IN (SELECT geo_key FROM rd.dim_country WHERE hidden_standard) AND a.geo_key <> 0;
\echo == 3. C10 ⑥ 후보: 창 안 한 번이라도 적중(프롬프트) vs 최신 round
WITH a AS (SELECT a.prompt_key, a.round_date, a.tgt_cited FROM rd.answer a
            WHERE a.surface = 2 AND a.bgrp = 1 AND a.dflt AND a.web_reg AND a.round_date BETWEEN '2026-09-13' AND '2026-09-27'
              AND a.geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = 'US'))
SELECT count(DISTINCT prompt_key) AS prompts, count(DISTINCT prompt_key) FILTER (WHERE tgt_cited) AS hit_ever,
       string_agg(DISTINCT round_date::text, ',') AS rounds FROM a;
\echo == 4. C08 자사 인용 -4 후보: 유닛 호스트는 같은데 자사 판정 아닌 인용의 url_base_norm 형태
WITH s AS (SELECT a.answer_key, a.round_date FROM rd.answer a WHERE a.surface = 2 AND a.round_date = '2026-09-25' AND a.bgrp = 1 AND a.dflt AND a.elig AND a.is_rep)
SELECT CASE WHEN u.url_base_norm ~ '\.html$' AND position('/' in u.url_base_norm) = 0 THEN 'host.html'
            WHEN u.url_norm IS NULL THEN 'url_norm null' ELSE 'other' END AS form, count(*)
  FROM rd.citation c JOIN s ON s.answer_key = c.answer_key AND s.round_date = c.round_date
  JOIN rd.dim_url u ON u.url_key = c.url_key JOIN rd.dim_prompt dp ON dp.prompt_key = c.prompt_key JOIN rd.web_unit w ON w.unit_key = dp.unit_key
 WHERE c.surface = 2 AND NOT (c.loc_owned OR c.tgt_hit) AND split_part(u.url_base_norm, '/', 1) = split_part(w.base, '/', 1)
 GROUP BY 1;
