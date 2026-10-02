\echo == owned_base 요약
SELECT kind, brand_code, count(*), count(*) FILTER (WHERE geo_code IS NULL) AS no_geo, min(prefix), max(prefix) FROM app.owned_base GROUP BY 1,2 ORDER BY 1,2;
SELECT owner_key, kind, prefix, host, brand_code, geo_code, language FROM app.owned_base WHERE kind = 'root_home' ORDER BY owner_key LIMIT 30;
\echo == global 09-14 cat_mask 분포
SELECT cat_mask, count(*), count(*) FILTER (WHERE std_in) std_in, count(*) FILTER (WHERE is_rep) rep, count(*) FILTER (WHERE elig) elig, count(*) FILTER (WHERE dflt) dflt
  FROM rd.answer WHERE surface = 1 AND round_date = '2026-09-14' GROUP BY 1 ORDER BY 1;
\echo == C01 변형(Hyundai 계정: cat_mask & 9 <> 0, dflt)
WITH a AS (SELECT * FROM rd.answer WHERE surface = 1 AND round_date = '2026-09-14' AND cyc_key = 873 AND (cat_mask & 9) <> 0 AND dflt)
SELECT v, count(*) AS den, count(*) FILTER (WHERE own_mask & 1 <> 0) AS vis, sum(ment_h) sov_n, sum(ment_total) sov_d, sum(sent_pos_h) sp, sum(sent_all_h) sa,
       sum(own_rk_h) FILTER (WHERE own_rk_h > 0) rks, count(*) FILTER (WHERE own_rk_h > 0) rkn
  FROM (SELECT 'all_std_in' v, * FROM a WHERE std_in
        UNION ALL SELECT 'rep_std_in', * FROM a WHERE std_in AND is_rep
        UNION ALL SELECT 'rep_elig', * FROM a WHERE elig AND is_rep
        UNION ALL SELECT 'all_elig', * FROM a WHERE elig
        UNION ALL SELECT 'rep_cit_in', * FROM a WHERE cit_in AND is_rep) x GROUP BY v ORDER BY v;
\echo == old C01: vis 13131/17990 sov 77631/299487 sent 42397/77631 pos 3 cit 14477/119971
\echo == C01 인용(rep, cit_in / elig) owner brand
WITH a AS (SELECT answer_key FROM rd.answer WHERE surface = 1 AND round_date = '2026-09-14' AND cyc_key = 873 AND (cat_mask & 9) <> 0 AND dflt AND is_rep AND elig)
SELECT count(*) AS cit, count(*) FILTER (WHERE ob.brand_code = 'Hyundai') AS own_h, count(*) FILTER (WHERE ob.brand_code = 'Hyundai' AND ob.kind = 'base') AS own_h_base,
       count(*) FILTER (WHERE c.source_key <> 0) AS cit_host, count(*) FILTER (WHERE c.cit_in) cit_in
  FROM rd.citation c JOIN a USING (answer_key) LEFT JOIN app.owned_base ob ON ob.owner_key = c.owner_key AND c.owner_key <> 0
 WHERE c.surface = 1 AND c.round_date = '2026-09-14';
