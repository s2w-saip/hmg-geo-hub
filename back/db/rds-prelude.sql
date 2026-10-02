-- RDS 전용 전처리: 마스터(hmgadmin)는 rds_superuser 라 superuser 가 아니다.
-- ALTER ... OWNER TO <롤>·SET ROLE 은 그 롤의 멤버여야 하므로 설계 롤을 미리 만들고 마스터에 멤버십을 준다(테스트 DB 한정).
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['hmg_owner','loader','loader_ro','api_ro','api_rw','admin_long','migrator','qa_gate'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF;
    EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', r);
  END LOOP; END $$;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser, version();
