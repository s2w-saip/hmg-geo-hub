\echo == dim_engine
SELECT * FROM rd.dim_engine ORDER BY 1;
\echo == dim_project (global·website 요약)
SELECT surface, is_root, count(*), min(project_key), max(project_key) FROM rd.dim_project GROUP BY 1,2 ORDER BY 1,2;
SELECT project_key, scope_project_id, surface, is_root, site_brand_bit, site_geo_key FROM rd.dim_project WHERE surface = 1;
\echo == app.brand
SELECT * FROM app.brand ORDER BY 1;
\echo == dim_brand_name own
SELECT brand_key, name, bare, kind, own_bit FROM rd.dim_brand_name WHERE own_bit <> 0 OR kind <> 2 ORDER BY brand_key LIMIT 40;
\echo == rd.cycle global 최근
SELECT cyc_key, project_key, ledger_backed, round_date, anchor_date, status, servable, view_date, hidden_scope, expected_units, completed_answers
  FROM rd.cycle WHERE surface = 1 ORDER BY round_date DESC LIMIT 20;
\echo == rd.cycle website 최근 round_date 분포
SELECT round_date, count(*) AS projects, count(*) FILTER (WHERE servable) AS servable, count(*) FILTER (WHERE view_date <= rd.today_kst()) AS viewable,
       min(view_date), max(view_date), string_agg(DISTINCT hidden_scope::text, ',')
  FROM rd.cycle WHERE surface = 2 GROUP BY 1 ORDER BY 1 DESC LIMIT 25;
\echo == today_kst
SELECT rd.today_kst(), now();
\echo == surface_generation
SELECT * FROM rd.surface_generation;
\echo == dim_country 일부
SELECT geo_key, code, region_key, kind, virtual_brand_bit, hidden_standard FROM rd.dim_country ORDER BY geo_key LIMIT 120;
