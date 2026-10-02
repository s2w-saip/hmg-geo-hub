BEGIN READ ONLY;
SHOW transaction_read_only;
SELECT n.nspname || '.' || c.relname AS tbl, c.relkind,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total, c.reltuples::bigint AS est_rows
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
 ORDER BY pg_total_relation_size(c.oid) DESC;
COMMIT;
