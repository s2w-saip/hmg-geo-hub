\echo == 결함 식 vs 교정 식 (C01: 글로벌 최신 회차 873, 현대 계정 = bgrp ∈ {v | v & 9 <> 0}, 기본 엔진)
\echo -- M-1: own_bit = 0 이면 형제 HMG 브랜드(기아·제네시스)가 경쟁 행에서 사라진다
SELECT n.name, sum(b.mention_count) FILTER (WHERE b.own_bit = 0) AS m_design, sum(b.mention_count) FILTER (WHERE b.own_bit <> 1) AS m_fixed
  FROM rd.answer_brand b JOIN rd.dim_brand_name n ON n.brand_key = b.brand_key
 WHERE b.surface = 1 AND b.round_date = '2026-09-14' AND b.cyc_key = ANY('{873}') AND b.bgrp = ANY('{1,3,5,7,8,9,10,11,12,13,14,15,17,19,21,23,24,25,26,27,28,29,30,31}'::int2[])
   AND b.dflt AND b.std_in AND b.competitive AND n.name IN ('Kia', 'Genesis', 'Tesla')
 GROUP BY 1 ORDER BY 1;
\echo -- C-1: owner_key <> 0 은 어느 HMG 브랜드 base 든 자사로 센다(현대 관점에서 kia.com 이 자사)
SELECT s.domain, count(*) FILTER (WHERE c.owner_key <> 0) AS own_design,
       count(*) FILTER (WHERE c.owner_key = ANY(ARRAY(SELECT owner_key FROM app.owned_base WHERE brand_code = 'Hyundai'))) AS own_fixed
  FROM rd.citation c JOIN rd.dim_source s ON s.source_key = c.source_key
 WHERE c.surface = 1 AND c.round_date = '2026-09-14' AND c.cyc_key = ANY('{873}') AND c.bgrp = ANY('{1,3,5,7,8,9,10,11,12,13,14,15,17,19,21,23,24,25,26,27,28,29,30,31}'::int2[])
   AND c.dflt AND c.cit_in AND c.source_key <> 0 AND s.domain IN ('hyundai.com', 'kia.com', 'genesis.com')
 GROUP BY 1 ORDER BY 1;
\echo -- G-1: 글로벌 표면은 loc_owned·tgt_hit 가 적재 시 false(seed-40 §6 global) → 자사 인용 0
SELECT count(*) AS cit, count(*) FILTER (WHERE c.loc_owned OR c.tgt_hit) AS own_design,
       count(*) FILTER (WHERE c.owner_key = ANY(ARRAY(SELECT owner_key FROM app.owned_base WHERE brand_code = 'Hyundai'))) AS own_fixed
  FROM rd.citation c
 WHERE c.surface = 1 AND c.round_date = '2026-09-14' AND c.cyc_key = ANY('{873}') AND c.bgrp = ANY('{1,3,5,7,8,9,10,11,12,13,14,15,17,19,21,23,24,25,26,27,28,29,30,31}'::int2[])
   AND c.dflt AND c.cit_in AND c.source_key <> 0;
