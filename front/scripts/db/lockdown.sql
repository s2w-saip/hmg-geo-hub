-- data-access-security: RLS is intentionally OFF in this project. Supabase, by
-- default, exposes tables to the `anon` / `authenticated` roles via PostgREST —
-- which without RLS would mean open data. We don't use that path at all (the
-- app reaches Postgres only via the server-side connection string + Drizzle), so
-- we revoke those grants to make the tables unreachable except from the server.
--
-- Run this AFTER applying migrations, and re-run whenever new tables are added
-- (the ALTER DEFAULT PRIVILEGES lines cover future tables/sequences too).
--
--   psql "$DATABASE_URL" -f scripts/db/lockdown.sql
--
-- 최근 추가분(재실행이 필요한 표): 0055 의 qa_review_sessions / qa_answer_reviews /
-- qa_review_notes / qa_answer_locks. 검수 콘솔은 로그인 없는 공개 라우트를 쓰므로
-- 이 네 표의 anon 차단이 특히 중요하다.

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM anon, authenticated;
