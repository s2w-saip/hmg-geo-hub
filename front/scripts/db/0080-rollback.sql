-- 0080 롤백 — 발행 리포트 사실표 3개를 되돌린다 (0078-rollback.sql 선례 형식).
--
--   npm run db:apply 는 마이그레이션 전용이므로 이 파일은 psql 또는 SQL 편집기로 돌린다:
--     psql "$DATABASE_URL" -f scripts/db/0080-rollback.sql
--
-- ⚠️ **이것은 마지막 수단이다.** 0080 은 신규 표 3개뿐이라 기존 데이터를 건드리지
--    않으므로, 운영에서 되돌릴 일이 생기면 **표를 지우기 전에** 더 싼 레버 둘을 먼저 쓴다:
--
--   ① 화면 키를 내린다 (즉시·배포 불필요·데이터 보존)
--      scripts/summary/read-switch.ts screens '["S4.dashboard","S1.dashboard","S3.citation","S6.citation"]'
--      → `X.reportTruth` 를 빼면 리더가 이 표를 **읽지조차 않는다**.
--   ② 그 회차만 되돌린다 (데이터 보존)
--      UPDATE report_publications SET status = 'rolled_back'
--       WHERE surface = 'website' AND round_date = '2026-09-11' AND status = 'active';
--      → 그 회차가 자동으로 라이브 폴백으로 돌아간다.
--
-- 아래 DROP 은 **감사 원본(`report_site_facts.raw`)까지 지운다.** 발행물 HTML 이
-- 남아 있으면 `npm run report:ingest` 로 재적재할 수 있지만, 그 전에 원본 파일이
-- 실제로 있는지 확인할 것.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 지우기 전에 무엇을 지우는지 남긴다(운영 로그에 찍힌다).
DO $notice$
DECLARE
  n_pub int := 0;
  n_site int := 0;
  n_eng int := 0;
BEGIN
  IF to_regclass('public.report_publications') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM report_publications' INTO n_pub;
  END IF;
  IF to_regclass('public.report_site_facts') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM report_site_facts' INTO n_site;
  END IF;
  IF to_regclass('public.report_site_engine_facts') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM report_site_engine_facts' INTO n_eng;
  END IF;
  RAISE NOTICE '0080 롤백: 발행물 %행 · 사이트 %행 · 엔진 %행 을 지운다', n_pub, n_site, n_eng;
END
$notice$;

-- 자식부터. FK 가 없으므로 순서가 강제되지는 않지만 선례(0078)의 자세를 따른다.
DROP TABLE IF EXISTS report_site_engine_facts;
DROP TABLE IF EXISTS report_site_facts;
DROP TABLE IF EXISTS report_publications;

-- 인덱스는 표와 함께 사라진다. 남은 것이 없는지 단언한다.
DO $verify$
BEGIN
  IF to_regclass('public.report_publications') IS NOT NULL
     OR to_regclass('public.report_site_facts') IS NOT NULL
     OR to_regclass('public.report_site_engine_facts') IS NOT NULL THEN
    RAISE EXCEPTION '0080 롤백 실패: 표가 남아 있다';
  END IF;
  IF to_regclass('public.report_publications_active_uq') IS NOT NULL
     OR to_regclass('public.report_site_facts_fs_idx') IS NOT NULL THEN
    RAISE EXCEPTION '0080 롤백 실패: 인덱스가 남아 있다';
  END IF;
END
$verify$;

COMMIT;

-- 롤백 후 코드 쪽: `reportTruthTablesAvailable()` 프로브가 60초 안에 false 로 바뀌어
-- 발행값 경로가 통째로 꺼진다(표가 없어도 42P01 로 죽지 않는다 — 그것이 프로브의 목적).
