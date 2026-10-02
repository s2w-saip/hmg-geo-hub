\echo == anchor_date 불일치(round_date 는 일치) 분해
WITH m AS (
  SELECT j.job_id, a.surface, a.project_key, a.round_date, a.anchor_date AS rd_ad, a.anchor_src, a.cyc_key,
         c.anchor_date AS ca_ad, c.source AS ca_src, c.cycle_id AS ca_cycle, cy.cycle_id AS rd_cycle, ic.origin, ic.cycle_anchor_at AS rd_at, c.anchor_at AS ca_at
    FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key AND j.surface = a.surface AND j.round_date = a.round_date
    JOIN mig_src.scope_answer_cycle_anchors c ON c.job_id = j.job_id
    JOIN rd.cycle cy ON cy.cyc_key = a.cyc_key JOIN ing.cycle ic ON ic.cycle_id = cy.cycle_id
   WHERE a.anchor_date <> c.anchor_date)
SELECT surface, round_date, rd_ad, ca_ad, ca_src, anchor_src, origin, (rd_cycle = ca_cycle) AS same_cycle, count(*), count(DISTINCT project_key),
       min(rd_at), min(ca_at)
  FROM m GROUP BY 1,2,3,4,5,6,7,8 ORDER BY 9 DESC LIMIT 20;
