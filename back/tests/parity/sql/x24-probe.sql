\echo == C10 09-18 자리(현대 US 웹): 셀 대표를 재제출 run 을 뺀 답변셋에서 고르면 현행(297/300, 2132/2789, 545, 2486/6174)과 같은가
WITH ghost_runs AS (   -- 수정 전 09-17 유령 회차에 귀속됐던 run(= 원장상 09-17 03:xxZ 회차 귀속 run)
  SELECT r.run_key FROM ing.cycle_run cr JOIN ing.cycle c ON c.cycle_id = cr.cycle_id JOIN ing.run r ON r.run_id = cr.run_id
   WHERE c.surface = 'website' AND c.round_date = '2026-09-17'),
a AS (SELECT a.*, j.measured_at, (a.run_key IN (SELECT run_key FROM ghost_runs)) AS resub
        FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key
       WHERE a.surface = 2 AND a.round_date = '2026-09-18' AND a.bgrp = 1 AND a.dflt AND a.elig
         AND a.geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = 'US')),
v AS (SELECT 'rep_all' AS v, * FROM (SELECT DISTINCT ON (cyc_key, prompt_key, engine_key, geo_key) * FROM a ORDER BY cyc_key, prompt_key, engine_key, geo_key, measured_at DESC, answer_key DESC) x
      UNION ALL
      SELECT 'rep_no_resub', * FROM (SELECT DISTINCT ON (cyc_key, prompt_key, engine_key, geo_key) * FROM a WHERE NOT resub ORDER BY cyc_key, prompt_key, engine_key, geo_key, measured_at DESC, answer_key DESC) y)
SELECT v, count(*) n, count(*) FILTER (WHERE own_mask & 1 <> 0) vis, sum(ment_h) sov_n, sum(ment_total) sov_d, sum(sent_pos_h) sp,
       count(*) FILTER (WHERE resub) AS resub_reps, min(measured_at) FILTER (WHERE resub) AS resub_first
  FROM v GROUP BY v;
