-- T12.2 (2026-11-07): the Gold import is gone. Its account keeps no privilege, and no login (manage.py install_input); the role stays because the earlier migrations name it on a new install.
REVOKE ALL ON ALL TABLES IN SCHEMA catalog,publication FROM hmg_catalog_writer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA catalog,publication FROM hmg_catalog_writer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA catalog,publication FROM hmg_catalog_writer;
REVOKE ALL ON SCHEMA catalog,publication FROM hmg_catalog_writer;
REVOKE CONNECT ON DATABASE input_db FROM hmg_catalog_writer;
