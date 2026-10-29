-- scope_citations 인용 URL 정규화 컬럼 승격 (2026-09-03).
--
-- 배경(PR #178 §5, 프로덕션 EXPLAIN ANALYZE): website 인용 계열 3함수와 KPI⑤·⑥
-- 인용 집계는 요청마다 `regexp_replace` 7단(tracked) / 5단(base) 정규화를 인용
-- 행 위에서 돌린다. #178 이 그것을 DISTINCT url 당 1회로 접어 4~6배를 벌었지만
-- (⑥카드 42s→6.9s · ⑥추이 100s→24.9s · 타겟률 74s→12.6s), 남은 비용의 대부분이
-- 여전히 "조회 시점 정규화"(⑥추이 기준 distinct url 51.7만 건 + 되붙이기 정렬)다.
-- 정규화 결과를 **동기화 시점에 컬럼으로 저장**하면 그 비용 자체가 사라진다.
--
-- additive-only: 기존 컬럼 타입 변경·삭제 없음(0007 prod 장애 전례 준수).
-- NULL 허용은 백필 재개 키다 — `WHERE url_norm IS NULL` 로 배치를 이어받는다.
--
-- 컬럼 3개인 이유(정규화가 2종이다):
--   url_norm      — KPI⑥ tracked 정규화. 쿼리스트링 **보존**(자원 식별), 트래킹
--                   파라미터 제거, fragment 제거. scope-aggregates.ts
--                   citationTrackedNormSql 과 1:1.
--   url_host      — split_part(url_norm, '/', 1). ownedBasePrefixClause 의 호스트
--                   사전필터가 쓰는 값.
--   url_base_norm — KPI⑤ base 정규화. 쿼리·fragment **제거**. citationBaseNormSql
--                   과 1:1. url_norm 에서 유도(= split_part(url_norm,'?',1))하는
--                   안은 기각했다 — 첫 '?' 앞에 '&<tracking>=' 가 오는 URL에서 두
--                   식이 갈리므로(구조적 비등가) 데이터 의존 등가에 기대게 된다.
--
-- 왜 GENERATED ALWAYS ... STORED 가 아닌가:
--   생성 컬럼 추가는 **테이블 전체 재작성**(ACCESS EXCLUSIVE 장기 보유)이다.
--   scope_citations 는 294만행·1,103MB 이고 미러 동기화 크론이 20분마다 돈다 —
--   재작성 창을 만들 수 없다. 일반 컬럼 ADD 는 PG11+ 에서 메타데이터 전용이라
--   락 보유가 순간이다. 대신 채우는 책임이 sync + 백필로 넘어간다.
--
-- 왜 IMMUTABLE SQL 함수인가:
--   정규화 정의를 **DB 쪽 정본 하나**로 고정하기 위해서다. sync 삽입·백필·
--   폴백 경로가 전부 같은 함수를 부른다(앱에서 계산해 넣지 않는다). SQL 함수는
--   플래너가 인라인하므로 플랜은 식을 직접 쓴 것과 같다.
--   TS 쌍둥이(citationTrackedNormSql/citationBaseNormSql)와의 일치는
--   lib/db/repositories/scope-aggregates.citation-norm-columns.test.ts 가
--   이 파일을 읽어 컴파일된 식과 대조해 강제한다.
--
-- 적용: npm run db:apply -- 0052   (운영자 실행. drizzle-kit migrate 금지)
-- 적용 후: npx tsx --env-file=.env.local scripts/db/backfill-citation-norm.ts

-- 락 대기 상한. `ADD COLUMN IF NOT EXISTS` 도 **no-op 이어도 ACCESS EXCLUSIVE 를
-- 먼저 잡는다** — 미러 sync 트랜잭션과 겹치면 무기한 대기하며 뒤를 막는다.
-- 짧게 끊고 재시도하는 편이 안전하다(재실행 안전 = 이 파일 전체가 멱등).
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint

-- 카탈로그 선확인 — 이미 있으면 ALTER 자체를 발행하지 않아 락을 잡지 않는다.
DO $do$
BEGIN
  IF to_regclass('public.scope_citations') IS NULL THEN
    RAISE NOTICE 'scope_citations 없음 — 컬럼 추가 건너뜀';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.scope_citations'::regclass
      AND attname = 'url_norm' AND NOT attisdropped
  ) THEN
    ALTER TABLE scope_citations ADD COLUMN url_norm text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.scope_citations'::regclass
      AND attname = 'url_host' AND NOT attisdropped
  ) THEN
    ALTER TABLE scope_citations ADD COLUMN url_host text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.scope_citations'::regclass
      AND attname = 'url_base_norm' AND NOT attisdropped
  ) THEN
    ALTER TABLE scope_citations ADD COLUMN url_base_norm text;
  END IF;
END
$do$;
--> statement-breakpoint

-- KPI⑥ tracked 정규화 — citationTrackedNormSql 의 SQL 정본.
-- 트림 → lower → scheme → 선행 www. → fragment → 트래킹 파라미터 3패스 → 끝 슬래시.
CREATE OR REPLACE FUNCTION citation_url_norm(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $fn$
SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(regexp_replace($1, '^\s+|\s+$', '', 'g')), '^https?://', ''), '^www\.', ''), '#.*$', ''), '&(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*', '', 'g'), '\?(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*&', '?'), '\?(utm[a-z_]*|msockid|fbclid|gclid|gbraid|wbraid|srsltid|yclid|igshid|mc_cid|mc_eid|_ga|cmpid)=[^&]*$', ''), '/+$', '')
$fn$;
--> statement-breakpoint

-- KPI⑤ base 정규화 — citationBaseNormSql 의 SQL 정본.
-- ⚠️ E' \t\n\r\f\013' 의 \013(8진) = 수직탭(0x0B). PG 의 E'' 는 \v 를 escape 로
-- 인식하지 않고 문자 'v' 로 접는다 — \v 라고 쓰면 트림 집합이 조용히 바뀐다.
CREATE OR REPLACE FUNCTION citation_url_base_norm(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $fn$
SELECT rtrim(split_part(split_part(regexp_replace(regexp_replace(lower(btrim($1, E' \t\n\r\f\013')), '^https?://', ''), '^www\.', ''), '?', 1), '#', 1), '/')
$fn$;
--> statement-breakpoint

-- 호스트부 — url_norm 에서 유도한다(정의를 두 벌로 만들지 않는다).
CREATE OR REPLACE FUNCTION citation_url_host(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $fn$
SELECT split_part(citation_url_norm($1), '/', 1)
$fn$;
--> statement-breakpoint

-- 보상통제(이 리포는 RLS 대신 grant 로 막는다) — 서버 전용.
REVOKE ALL ON FUNCTION citation_url_norm(text) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION citation_url_base_norm(text) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON FUNCTION citation_url_host(text) FROM PUBLIC, anon, authenticated;

-- 인덱스는 이 마이그레이션에 넣지 않는다.
--   근거: 이 컬럼을 읽는 소비처는 전부 스냅샷 job 집합(`snap`/`_answer_set`)으로
--   먼저 좁힌 뒤 scope_citations 를 읽는다 — 실제 접근 경로는 이미
--   scope_citations_job_idx 이고(#178 신 플랜 실측), url_norm/url_host 는 그
--   결과 행에 대한 **투영·필터**라 별도 인덱스가 탈 자리가 없다. EXPLAIN 근거
--   없는 인덱스는 294만행 × 300MB+ 의 쓰기·저장 비용만 남긴다.
--   나중에 근거가 생기면 CREATE INDEX CONCURRENTLY 로 **이 파일 밖에서** 만든다 —
--   scripts/db/apply-migration.ts 는 파일 전체를 한 트랜잭션으로 감싸므로
--   CONCURRENTLY 는 여기서 실행 자체가 불가능하다.
