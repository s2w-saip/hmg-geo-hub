\echo == F03 노출 가설: 현행 집계층은 (답변, 롤업 엔티티) 단위로 셈 — old BMW 4610 Tesla 6498 Toyota 5544 Mercedes-Benz 3459 Kia 5759 Honda 4373
WITH s AS (SELECT DISTINCT ON (a.cyc_key, a.prompt_key, a.engine_key, a.geo_key) a.answer_key, a.round_date
             FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key
            WHERE a.surface = 1 AND a.cyc_key = 873 AND a.dflt AND a.elig AND (a.cat_mask & 9) <> 0 AND j.measured_at <= '2026-09-15 17:12:04+00'
            ORDER BY a.cyc_key, a.prompt_key, a.engine_key, a.geo_key, j.measured_at DESC, a.answer_key DESC),
m AS (SELECT v.answer_key, v.brand_rollup_entity_id AS rid, v.display_name, v.mention_count
        FROM rd.v_answer_mention_raw v JOIN s ON s.answer_key = v.answer_key WHERE v.brand_rollup_entity_id IS NOT NULL)
SELECT n.name, count(DISTINCT m.answer_key) AS answers, count(DISTINCT (m.answer_key, m.rid)) AS answer_rid, count(DISTINCT m.rid) AS rids,
       sum(m.mention_count) AS mentions
  FROM m JOIN rd.dim_entity e ON e.entity_id = m.rid JOIN rd.dim_brand_name n ON n.brand_key = e.brand_key
 WHERE n.name IN ('BMW', 'Tesla', 'Toyota', 'Mercedes-Benz', 'Kia', 'Honda') GROUP BY 1 ORDER BY 1;
