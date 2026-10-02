\echo == C10 시드 결함 보정 모사: 09-17 유령 회차(비노출) 답변을 09-18 좌석으로 되돌려 새 정의로 계산 (old vis 597/608 sov 4333/5675 cit 4281/11218)
WITH ghost AS (SELECT cyc_key FROM rd.cycle WHERE surface = 2 AND round_date = '2026-09-17'),
live AS (SELECT cyc_key FROM rd.cycle WHERE surface = 2 AND round_date BETWEEN '2026-09-13' AND '2026-09-27' AND servable AND view_date <= '2026-09-27' AND hidden_scope NOT IN (1,3)),
a AS (SELECT a.* FROM rd.answer a WHERE a.surface = 2 AND a.round_date BETWEEN '2026-09-13' AND '2026-09-27' AND a.bgrp = 1 AND a.dflt
         AND a.geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = 'US')
         AND (a.cyc_key IN (SELECT cyc_key FROM live) OR a.cyc_key IN (SELECT cyc_key FROM ghost)))
SELECT 'new+fix' AS v, count(*) FILTER (WHERE std_in) AS n, count(*) FILTER (WHERE std_in AND (own_mask & 1) <> 0) AS vis,
       sum(ment_h) FILTER (WHERE std_in) AS sov_n, sum(ment_total) FILTER (WHERE std_in) AS sov_d,
       count(*) FILTER (WHERE cit_in) AS cit_answers, count(*) FILTER (WHERE gap) AS gap_n,
       (SELECT count(*) FROM rd.citation c JOIN a ON a.answer_key = c.answer_key AND a.round_date = c.round_date WHERE c.surface = 2 AND c.cit_in AND c.source_key <> 0) AS cit,
       (SELECT count(*) FROM rd.citation c JOIN a ON a.answer_key = c.answer_key AND a.round_date = c.round_date WHERE c.surface = 2 AND c.cit_in AND c.source_key <> 0 AND (c.loc_owned OR c.tgt_hit)) AS cit_own
  FROM a;
