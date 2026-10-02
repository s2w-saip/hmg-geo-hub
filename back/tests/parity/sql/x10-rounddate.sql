\echo == round_date 불일치 job 분해(rd.answer vs mig_src.scope_answer_cycle_anchors)
WITH _mm AS MATERIALIZED (
SELECT j.job_id, a.surface, a.project_key, a.round_date AS rd_rd, a.anchor_date AS rd_ad, a.anchor_src, a.cyc_key,
       c.round_date AS ca_rd, c.anchor_date AS ca_ad, c.source AS ca_src, c.cycle_id AS ca_cycle, c.anchor_at AS ca_anchor_at, c.run_id,
       cy.cycle_id AS rd_cycle, cy.ledger_backed, cy.servable, cy.status AS rd_status, ic.origin AS rd_origin, ic.anchor_source AS rd_anchor_source,
       ic.cycle_anchor_at AS rd_anchor_at, icr.attributed_by
  FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key AND j.surface = a.surface AND j.round_date = a.round_date
  JOIN mig_src.scope_answer_cycle_anchors c ON c.job_id = j.job_id
  JOIN rd.cycle cy ON cy.cyc_key = a.cyc_key
  JOIN ing.cycle ic ON ic.cycle_id = cy.cycle_id
  LEFT JOIN ing.cycle_run icr ON icr.run_id = c.run_id
 WHERE a.round_date <> c.round_date
)
SELECT count(*) AS mismatches FROM _mm;
\echo == 차이일수 × ca 출처 × rd 회차 출처 × 귀속 × anchor 일치 여부
WITH _mm AS MATERIALIZED (
SELECT j.job_id, a.surface, a.project_key, a.round_date AS rd_rd, a.anchor_date AS rd_ad, a.anchor_src, a.cyc_key,
       c.round_date AS ca_rd, c.anchor_date AS ca_ad, c.source AS ca_src, c.cycle_id AS ca_cycle, c.anchor_at AS ca_anchor_at, c.run_id,
       cy.cycle_id AS rd_cycle, cy.ledger_backed, cy.servable, cy.status AS rd_status, ic.origin AS rd_origin, ic.anchor_source AS rd_anchor_source,
       ic.cycle_anchor_at AS rd_anchor_at, icr.attributed_by
  FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key AND j.surface = a.surface AND j.round_date = a.round_date
  JOIN mig_src.scope_answer_cycle_anchors c ON c.job_id = j.job_id
  JOIN rd.cycle cy ON cy.cyc_key = a.cyc_key
  JOIN ing.cycle ic ON ic.cycle_id = cy.cycle_id
  LEFT JOIN ing.cycle_run icr ON icr.run_id = c.run_id
 WHERE a.round_date <> c.round_date
)
SELECT surface, rd_rd - ca_rd AS diff, ca_src, rd_origin, rd_anchor_source, attributed_by, anchor_src,
       (rd_ad = ca_ad) AS same_anchor_date, (rd_cycle = ca_cycle) AS same_cycle, servable, count(*), count(DISTINCT project_key) AS projects,
       min(rd_rd), max(rd_rd)
  FROM _mm GROUP BY 1,2,3,4,5,6,7,8,9,10 ORDER BY 11 DESC;
\echo == -1일 사례: 좌석 원장 매핑(ing.cycle_round = scope_cycle_rounds) 대조
WITH _mm AS MATERIALIZED (
SELECT j.job_id, a.surface, a.project_key, a.round_date AS rd_rd, a.anchor_date AS rd_ad, a.anchor_src, a.cyc_key,
       c.round_date AS ca_rd, c.anchor_date AS ca_ad, c.source AS ca_src, c.cycle_id AS ca_cycle, c.anchor_at AS ca_anchor_at, c.run_id,
       cy.cycle_id AS rd_cycle, cy.ledger_backed, cy.servable, cy.status AS rd_status, ic.origin AS rd_origin, ic.anchor_source AS rd_anchor_source,
       ic.cycle_anchor_at AS rd_anchor_at, icr.attributed_by
  FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key AND j.surface = a.surface AND j.round_date = a.round_date
  JOIN mig_src.scope_answer_cycle_anchors c ON c.job_id = j.job_id
  JOIN rd.cycle cy ON cy.cyc_key = a.cyc_key
  JOIN ing.cycle ic ON ic.cycle_id = cy.cycle_id
  LEFT JOIN ing.cycle_run icr ON icr.run_id = c.run_id
 WHERE a.round_date <> c.round_date
)
SELECT m.rd_ad, m.ca_ad, m.rd_rd, m.ca_rd, cr_rd.round_date AS seat_for_rd_ad, cr_rd.basis AS basis_rd_ad, cr_ca.round_date AS seat_for_ca_ad, cr_ca.basis AS basis_ca_ad,
       count(*), count(DISTINCT m.project_key)
  FROM _mm m JOIN rd.dim_project dp ON dp.project_key = m.project_key
  LEFT JOIN mig_src.scope_cycle_rounds cr_rd ON cr_rd.project_id = dp.scope_project_id AND cr_rd.anchor_date = m.rd_ad
  LEFT JOIN mig_src.scope_cycle_rounds cr_ca ON cr_ca.project_id = dp.scope_project_id AND cr_ca.anchor_date = m.ca_ad
 GROUP BY 1,2,3,4,5,6,7,8 ORDER BY 9 DESC LIMIT 20;
\echo == 예시 5건
WITH _mm AS MATERIALIZED (
SELECT j.job_id, a.surface, a.project_key, a.round_date AS rd_rd, a.anchor_date AS rd_ad, a.anchor_src, a.cyc_key,
       c.round_date AS ca_rd, c.anchor_date AS ca_ad, c.source AS ca_src, c.cycle_id AS ca_cycle, c.anchor_at AS ca_anchor_at, c.run_id,
       cy.cycle_id AS rd_cycle, cy.ledger_backed, cy.servable, cy.status AS rd_status, ic.origin AS rd_origin, ic.anchor_source AS rd_anchor_source,
       ic.cycle_anchor_at AS rd_anchor_at, icr.attributed_by
  FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key AND j.surface = a.surface AND j.round_date = a.round_date
  JOIN mig_src.scope_answer_cycle_anchors c ON c.job_id = j.job_id
  JOIN rd.cycle cy ON cy.cyc_key = a.cyc_key
  JOIN ing.cycle ic ON ic.cycle_id = cy.cycle_id
  LEFT JOIN ing.cycle_run icr ON icr.run_id = c.run_id
 WHERE a.round_date <> c.round_date
)
SELECT job_id, rd_rd, ca_rd, rd_ad, ca_ad, ca_src, rd_origin, rd_anchor_source, rd_anchor_at, ca_anchor_at, attributed_by FROM _mm ORDER BY rd_rd DESC LIMIT 5;
\echo == -35일 사례
WITH _mm AS MATERIALIZED (
SELECT j.job_id, a.surface, a.project_key, a.round_date AS rd_rd, a.anchor_date AS rd_ad, a.anchor_src, a.cyc_key,
       c.round_date AS ca_rd, c.anchor_date AS ca_ad, c.source AS ca_src, c.cycle_id AS ca_cycle, c.anchor_at AS ca_anchor_at, c.run_id,
       cy.cycle_id AS rd_cycle, cy.ledger_backed, cy.servable, cy.status AS rd_status, ic.origin AS rd_origin, ic.anchor_source AS rd_anchor_source,
       ic.cycle_anchor_at AS rd_anchor_at, icr.attributed_by
  FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key AND j.surface = a.surface AND j.round_date = a.round_date
  JOIN mig_src.scope_answer_cycle_anchors c ON c.job_id = j.job_id
  JOIN rd.cycle cy ON cy.cyc_key = a.cyc_key
  JOIN ing.cycle ic ON ic.cycle_id = cy.cycle_id
  LEFT JOIN ing.cycle_run icr ON icr.run_id = c.run_id
 WHERE a.round_date <> c.round_date
)
SELECT job_id, rd_rd, ca_rd, rd_ad, ca_ad, ca_src, rd_origin, rd_anchor_source, rd_anchor_at, ca_anchor_at, attributed_by, anchor_src
  FROM _mm WHERE rd_rd - ca_rd < -7 LIMIT 5;
