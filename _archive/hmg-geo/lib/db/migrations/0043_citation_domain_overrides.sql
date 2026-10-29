-- 0043: 인용 출처 카테고리 도메인 오버라이드 (feature: citation-category-override).
-- Applied via `npm run db:apply -- 0043` (0021+는 수동 멱등 SQL — apply-migration.ts).
--
-- ⚠️ `npm run db:generate` 로 만들지 않았다. drizzle 스냅샷은 meta/ 에 0000~0002
-- 만 있고 _journal.json 은 0020 에서 멈춰 있다 — generate 를 돌리면 0002 기준으로
-- 20여 개 마이그레이션 분량을 다시 뱉으려다 컬럼 rename 대화형 프롬프트에서 죽는다
-- (2026-08-21 실행 확인: `promptColumnsConflicts … requires a TTY`). 0021 이후의
-- 이 레포 관행대로 손으로 쓰고 멱등(IF NOT EXISTS)으로 만든다. 적용 여부 판정도
-- 저널이 아니라 DB 실측으로:
--   SELECT to_regclass('public.citation_domain_overrides');  -- NULL 이면 미적용
--
-- 설계: 분류(lib/citation-categorizer)는 read-time 파생이라 행이 생기는 순간
-- 백필 없이 전 이력이 재분류되고, 행을 지우면 기본 분류로 원복된다.
-- additive-only: 기존 테이블 ALTER 없음 — 신규 테이블 1개뿐.
--
-- domain: **정규화된 registrable domain** (lowercase + 선행 www. 제거).
--   categorizeDomain() 이 조회 전에 같은 정규화를 하므로 키가 어긋나면 오버라이드가
--   에러 없이 조용히 무시된다 — 쓰기는 반드시 리포지터리(citation-overrides.ts)를
--   통과할 것(normalizeCitationDomain 강제).
-- category: 택소노미 11종(lib/citation-categorizer/taxonomy.ts). CHECK 를 걸지
--   않는 이유 = 택소노미가 코드 정본이라 값이 늘 때마다 ALTER 가 필요해지고
--   (additive-only 규율과 충돌), 로드 시점에 isCitationCategory 로 걸러진다.
-- updated_by = profiles.id (no FK — schema 이식성 방침, 0033·0037·0041·0042 선례).
--
-- ⚠️ LOCKDOWN COVERAGE (0033·0042 선례와 동일): 신규 테이블은 lockdown.sql
-- 재실행 전까지 anon/authenticated 가드가 없다. 적용 후 재실행 + 확인:
--   SELECT has_table_privilege('anon','public.citation_domain_overrides','SELECT');  -- expect false
CREATE TABLE IF NOT EXISTS "citation_domain_overrides" (
  "domain" text PRIMARY KEY,
  "category" text NOT NULL,
  "note" text,
  "updated_by" uuid,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
-- 목록 화면은 최근 수정 순으로 읽는다 (행 수는 큐레이션 규모 = 수백 단위).
CREATE INDEX IF NOT EXISTS "citation_domain_overrides_updated_idx"
  ON "citation_domain_overrides" ("updated_at" DESC);
