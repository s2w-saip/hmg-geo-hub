-- A project added on the hub server (T6.3) gets its dim_project row from the load job, so its answers have a key when its snapshots come.
GRANT SELECT,INSERT ON gold.dim_project TO hmg_query_loader;
