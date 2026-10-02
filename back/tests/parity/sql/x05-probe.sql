\echo == A: C01 F02 old 모사(측정 주 버킷, 버킷 내 셀 최신 1건) old: 08-31 11488/17990, 09-07 13150/17990, 09-14 296/362, 09-21 12/12, 08-17 2638/3744, 08-10 1485/2014
WITH a AS (
  SELECT a.answer_key, a.prompt_key, a.engine_key, a.geo_key, a.own_mask, a.cyc_key, j.measured_at,
         date_trunc('week', j.measured_at AT TIME ZONE 'UTC')::date AS wk
    FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key
   WHERE a.surface = 1 AND a.round_date >= '2026-05-01' AND (a.cat_mask & 9) <> 0 AND a.dflt AND a.elig),
s AS (SELECT DISTINCT ON (wk, prompt_key, engine_key, geo_key) * FROM a ORDER BY wk, prompt_key, engine_key, geo_key, measured_at DESC, answer_key DESC)
SELECT wk, count(*) n, count(*) FILTER (WHERE own_mask & 1 <> 0) vis, string_agg(DISTINCT cyc_key::text, ',') cycs FROM s GROUP BY wk ORDER BY wk;
\echo == A2: KST 주 버킷
WITH a AS (
  SELECT a.answer_key, a.prompt_key, a.engine_key, a.geo_key, a.own_mask, j.measured_at,
         date_trunc('week', j.measured_at AT TIME ZONE 'Asia/Seoul')::date AS wk
    FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key
   WHERE a.surface = 1 AND a.round_date >= '2026-08-01' AND (a.cat_mask & 9) <> 0 AND a.dflt AND a.elig),
s AS (SELECT DISTINCT ON (wk, prompt_key, engine_key, geo_key) * FROM a ORDER BY wk, prompt_key, engine_key, geo_key, measured_at DESC, answer_key DESC)
SELECT wk, count(*) n, count(*) FILTER (WHERE own_mask & 1 <> 0) vis FROM s GROUP BY wk ORDER BY wk;
\echo == B: C08 target_rate 모사(프롬프트별 전 기간 최신 측정, old 3595/5587)
WITH a AS (SELECT a.prompt_key, a.tgt_cited, a.round_date, a.answer_key, j.measured_at FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key
            WHERE a.surface = 2 AND a.bgrp = 1 AND a.dflt AND a.elig AND a.web_reg AND a.round_date <= '2026-09-25'),
p AS (SELECT prompt_key, bool_or(tgt_cited) FILTER (WHERE round_date = (SELECT max(round_date) FROM a a2 WHERE a2.prompt_key = a.prompt_key)) AS hit_latest_round,
             bool_or(tgt_cited) AS hit_ever FROM a GROUP BY prompt_key)
SELECT count(*) prompts, count(*) FILTER (WHERE hit_latest_round) hit_latest_round, count(*) FILTER (WHERE hit_ever) hit_ever FROM p;
\echo == C: 드롭 시각 분포(08:14Z 이후)
SELECT date_trunc('hour', dropped_at) h, count(*) FROM mig_src.scope_answer_drops WHERE dropped_at >= '2026-09-26' GROUP BY 1 ORDER BY 1;
