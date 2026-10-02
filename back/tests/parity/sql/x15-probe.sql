\echo == F03 노출(answerCount) 변형: C01 셀 대표(873, Hyundai 모집단) — old BMW 4610 Tesla 6498 Toyota 5544 Mercedes-Benz 3459 Kia 5759
WITH s AS (SELECT a.answer_key, a.round_date FROM rd.answer a WHERE a.surface = 1 AND a.cyc_key = 873 AND a.dflt AND a.elig AND a.is_rep AND (a.cat_mask & 9) <> 0)
SELECT n.name, count(*) FILTER (WHERE b.competitive) AS comp_rows, count(DISTINCT b.answer_key) AS any_rows,
       sum(b.entity_rows) FILTER (WHERE b.competitive) AS comp_entity_rows, sum(b.mention_count) FILTER (WHERE b.competitive) AS m
  FROM rd.answer_brand b JOIN s ON s.answer_key = b.answer_key AND s.round_date = b.round_date JOIN rd.dim_brand_name n ON n.brand_key = b.brand_key
 WHERE b.surface = 1 AND n.name IN ('BMW', 'Tesla', 'Toyota', 'Mercedes-Benz', 'Kia', 'Honda') GROUP BY 1 ORDER BY 1;
\echo == KGM 표시명
SELECT brand_key, name, bare, kind, own_bit FROM rd.dim_brand_name WHERE bare ILIKE 'kg%' OR name ILIKE '%KGM%' OR name ILIKE '%쌍용%' OR name ILIKE '%ssangyong%';
