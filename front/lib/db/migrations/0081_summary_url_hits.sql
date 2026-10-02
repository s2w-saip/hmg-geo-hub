-- 0081: 자사·타겟 URL 인용률(GGMD-61) 사실표 2개 (summary_url_hits · summary_url_hit_generations).
-- 적용: npm run db:apply -- 0081   (제품 책임자 실행. drizzle-kit migrate 금지)
--
-- ── 왜 ───────────────────────────────────────────────────────────────────────
-- 웹사이트 대시보드 KPI 카드 3종은 한 Promise.all 로 기다린다(app/.../website/_data/live.ts).
-- 둘(①~⑤·⑥)은 이미 사실표(summary_*)를 읽는데 자사·타겟 URL 인용률 2종만 미러를 라이브로
-- 집계한다(`aggregateWebsiteTargetHitRate`). 2026-09-27 라이브 EXPLAIN(읽기 전용):
--   · 함대 무필터  실행 11.3 s: 인용 39.6만 행 정렬·프롬프트 bool_or 가 9.5 s
--   · Kia × MX     실행 87.0 s: 인용 4,182 행 × CTE `wup` 12,685 행 Nested Loop(5,300만 비교)
-- 판정(URL 정규화·유닛 자사·프롬프트 타겟 정확 일치)은 필터와 무관한 job 고유값이므로
-- 생성 시점에 job 단위 플래그로 굳히고, 조회는 job 을 고르고 프롬프트로 bool_or 만 한다.
--
-- ── 무엇 ─────────────────────────────────────────────────────────────────────
-- ① summary_url_hits: (generation, job) 1행. 판정 빌더 정본:
--    lib/db/repositories/scope-aggregates.ts::websitePromptUrlHitJobFlagsSql
-- ② summary_url_hit_generations: "이 generation 의 ①은 빠짐없이 적재됐다" 는 원장.
--    리더는 고른 회차의 generation 이 **전부** 여기 있을 때만 ①을 쓴다. 이 마이그레이션
--    이전에 만들어진 generation 은 행이 없으므로 조회는 종전 미러 경로로 간다(값 불변).
--
-- ── additive-only ────────────────────────────────────────────────────────────
-- 신규 테이블 2개뿐. 기존 테이블 ALTER 없음(0007 prod 장애 교훈): summary_answers 에
-- 컬럼을 더하면 파티션 부모에 ACCESS EXCLUSIVE 가 걸려 라이브 조회와 경합한다.
-- 파티션이 아닌 이유: 세부층 6표의 주 파티션 선생성 함수(0064)를 고쳐야 하고, 행 규모가
-- 작다(웹사이트 회차 1개 ≈ 200 job, 함대 주 ≈ 2만 행). 옛 generation 행은 생성기가 스왑
-- 뒤 지운다(세부층과 같은 자리). FK 를 두지 않는 것은 summary_* 계열의 규율이다.
--
-- ── 멱등 ─────────────────────────────────────────────────────────────────────
-- 전부 신규 객체라 `CREATE … IF NOT EXISTS` 가 맞다(존재하지 않는 객체에는 잡을 락이 없다 :
-- 0080 과 같은 판단). 재적용은 no-op 이고 pglite 테스트가 2회 적용으로 단언한다.

SET LOCAL lock_timeout = '5s';--> statement-breakpoint

DO $guard$
BEGIN
  IF current_setting('lock_timeout') <> '5s' THEN
    RAISE EXCEPTION '0081: 트랜잭션 블록 밖에서 적용 중: npm run db:apply -- 0081 로 적용할 것';
  END IF;
END
$guard$;--> statement-breakpoint

-- ── ① job 단위 플래그 ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "summary_url_hits" (
  "cycle_week" date NOT NULL,
  "cycle_id" uuid NOT NULL,
  "generation_id" uuid NOT NULL,
  "job_id" uuid NOT NULL,
  "prompt_id" uuid NOT NULL,
  -- 그 job 의 프롬프트가 소속 프로젝트 사이트의 website_prompts 에 등록돼 있다(두 카드 분모 자격).
  "registered" boolean NOT NULL,
  -- 유닛 자사 판정 또는 target_hit (미러 쌍둥이 `owned_base_hit OR target_hit`).
  "owned_hit" boolean NOT NULL,
  -- 그 프롬프트의 타겟 URL 과 정확 일치하는 인용이 있다.
  "target_hit" boolean NOT NULL,
  CONSTRAINT "summary_url_hits_pk" PRIMARY KEY ("generation_id", "job_id"),
  -- 타겟 ⊂ 자사(2026-09-06 결정) · 미등록 프롬프트는 어느 분자에도 못 들어간다.
  CONSTRAINT "summary_url_hits_target_owned_ck" CHECK (NOT "target_hit" OR "owned_hit"),
  CONSTRAINT "summary_url_hits_registered_ck" CHECK ("registered" OR NOT "owned_hit")
);--> statement-breakpoint

-- 옛 generation 정리(`cycle_id = … AND generation_id <> …`)용.
CREATE INDEX IF NOT EXISTS "summary_url_hits_cycle_idx"
  ON "summary_url_hits" ("cycle_id", "generation_id");--> statement-breakpoint

-- ── ② 적재 완료 원장 ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "summary_url_hit_generations" (
  "generation_id" uuid PRIMARY KEY NOT NULL,
  "cycle_id" uuid NOT NULL,
  "cycle_week" date NOT NULL,
  -- 같은 문장에서 ①에 넣은 행 수. summary_cycle_jobs 의 그 generation 행 수와 같아야 한다.
  "jobs" integer NOT NULL,
  "generator_version" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "summary_url_hit_generations_cycle_idx"
  ON "summary_url_hit_generations" ("cycle_id");--> statement-breakpoint

-- 앱 롤 이외 접근 차단(0059 관례: summary_* 는 전부 닫는다).
REVOKE ALL ON "summary_url_hits" FROM PUBLIC, anon, authenticated;--> statement-breakpoint
REVOKE ALL ON "summary_url_hit_generations" FROM PUBLIC, anon, authenticated;
