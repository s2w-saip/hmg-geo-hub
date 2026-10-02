\echo == C04 변형 (old vis 38612/64074 sov 231493/866779 sent 122272/231493 cit 34152/313325)
WITH cyc AS (SELECT cyc_key, servable, view_date FROM rd.cycle WHERE surface = 1),
a AS (SELECT a.*, c.servable, c.view_date FROM rd.answer a JOIN cyc c USING (cyc_key)
       WHERE a.surface = 1 AND a.round_date BETWEEN '2026-08-01' AND '2026-09-30' AND (a.cat_mask & 9) <> 0 AND a.dflt)
SELECT v, count(*) AS den, count(*) FILTER (WHERE own_mask & 1 <> 0) AS vis, sum(ment_h) sov_n, sum(ment_total) sov_d, sum(sent_pos_h) sp
  FROM (SELECT 'rd_all_elig' v, * FROM a WHERE elig AND round_date BETWEEN '2026-08-28' AND '2026-09-27'
        UNION ALL SELECT 'rd_serv_elig', * FROM a WHERE elig AND servable AND view_date <= '2026-09-27' AND round_date BETWEEN '2026-08-28' AND '2026-09-27'
        UNION ALL SELECT 'rd_serv_std', * FROM a WHERE std_in AND servable AND view_date <= '2026-09-27' AND round_date BETWEEN '2026-08-28' AND '2026-09-27'
        UNION ALL SELECT 'ad_all_elig', * FROM a WHERE elig AND anchor_date BETWEEN '2026-08-28' AND '2026-09-27'
        UNION ALL SELECT 'ad_serv_elig', * FROM a WHERE elig AND servable AND anchor_date BETWEEN '2026-08-28' AND '2026-09-27'
        UNION ALL SELECT 'rd_serv_rep', * FROM a WHERE elig AND is_rep AND servable AND round_date BETWEEN '2026-08-28' AND '2026-09-27') x
 GROUP BY v ORDER BY v;
\echo == C04 회차별(rd, elig, 서빙여부)
SELECT a.round_date, a.cyc_key, c.servable, c.view_date, count(*) AS n
  FROM rd.answer a JOIN rd.cycle c USING (cyc_key)
 WHERE a.surface = 1 AND a.round_date BETWEEN '2026-08-20' AND '2026-09-30' AND (a.cat_mask & 9) <> 0 AND a.dflt AND a.elig
 GROUP BY 1,2,3,4 ORDER BY 1,2;
\echo == C08 변형 (old vis 7903/8250 sov 61435/76272 sent 20348/61435 pos 1.3 cit 48473/145786 tgt 3595/5587)
WITH a AS (SELECT a.* FROM rd.answer a JOIN rd.cycle c USING (cyc_key)
            WHERE a.surface = 2 AND a.round_date = '2026-09-25' AND a.bgrp = 1 AND a.dflt AND c.servable)
SELECT v, count(*) AS den, count(*) FILTER (WHERE own_mask & 1 <> 0) AS vis, sum(ment_h) sov_n, sum(ment_total) sov_d, sum(sent_pos_h) sp,
       count(*) FILTER (WHERE web_reg) reg, count(*) FILTER (WHERE tgt_cited AND web_reg) tgt,
       count(DISTINCT prompt_key) FILTER (WHERE web_reg) reg_p, count(DISTINCT prompt_key) FILTER (WHERE tgt_cited AND web_reg) tgt_p
  FROM (SELECT 'all_std' v, * FROM a WHERE std_in
        UNION ALL SELECT 'all_elig', * FROM a WHERE elig
        UNION ALL SELECT 'rep_elig', * FROM a WHERE elig AND is_rep
        UNION ALL SELECT 'rep_std', * FROM a WHERE std_in AND is_rep) x GROUP BY v ORDER BY v;
\echo == website 09-25 bgrp 분포
SELECT bgrp, count(*), count(DISTINCT project_key) FROM rd.answer WHERE surface = 2 AND round_date = '2026-09-25' GROUP BY 1 ORDER BY 1;
\echo == C02 (Kia US; old vis 546/832 sov 4673/17562 cit 173/6394)
WITH a AS (SELECT a.* FROM rd.answer a WHERE a.surface = 1 AND a.round_date = '2026-09-14' AND a.cyc_key = 873 AND (a.cat_mask & 10) <> 0 AND a.dflt
            AND a.geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = 'US'))
SELECT v, count(*) AS den, count(*) FILTER (WHERE own_mask & 2 <> 0) AS vis, sum(ment_k) sov_n, sum(ment_total) sov_d, sum(sent_pos_k) sp, sum(sent_all_k) sa
  FROM (SELECT 'all_std' v, * FROM a WHERE std_in UNION ALL SELECT 'rep_elig', * FROM a WHERE elig AND is_rep) x GROUP BY v ORDER BY v;
\echo == C03 (Genesis KR gemini; old vis 101/155 sov 709/1762 sent 321/709 pos 2 cit 65/781)
WITH a AS (SELECT a.* FROM rd.answer a WHERE a.surface = 1 AND a.round_date = '2026-09-14' AND a.cyc_key = 873 AND (a.cat_mask & 12) <> 0
            AND a.engine_key = 2 AND a.geo_key = (SELECT geo_key FROM rd.dim_country WHERE code = 'KR'))
SELECT v, count(*) AS den, count(*) FILTER (WHERE own_mask & 4 <> 0) AS vis, sum(ment_g) sov_n, sum(ment_total) sov_d, sum(sent_pos_g) sp, sum(sent_all_g) sa,
       sum(own_rk_g) FILTER (WHERE own_rk_g > 0) rks, count(*) FILTER (WHERE own_rk_g > 0) rkn
  FROM (SELECT 'all_std' v, * FROM a WHERE std_in UNION ALL SELECT 'rep_elig', * FROM a WHERE elig AND is_rep) x GROUP BY v ORDER BY v;
