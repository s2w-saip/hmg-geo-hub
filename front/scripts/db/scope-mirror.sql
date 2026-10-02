-- scope_* — local mirror of scope's raw measurement surface (STANDARD/root
-- project). HMG KPIs are computed here via SQL; see lib/db/schema.ts + lib/scope/mirror/*.
-- Idempotent. Run once per env (or via Supabase MCP apply_migration):
--   psql "$DATABASE_URL" -f scripts/db/scope-mirror.sql

CREATE TABLE IF NOT EXISTS scope_runs (
  run_id       uuid PRIMARY KEY,
  status       text,
  started_at   timestamptz,
  completed_at timestamptz,
  total_jobs   integer,
  synced_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scope_answers (
  job_id      uuid PRIMARY KEY,
  run_id      uuid NOT NULL,
  prompt_id   uuid,
  target      text NOT NULL,
  region      text,
  status      text,
  measured_at timestamptz,
  model_slug  text,
  answer_text text
);
CREATE INDEX IF NOT EXISTS scope_answers_run_idx    ON scope_answers (run_id);
CREATE INDEX IF NOT EXISTS scope_answers_target_idx ON scope_answers (target);
CREATE INDEX IF NOT EXISTS scope_answers_region_idx ON scope_answers (region);

CREATE TABLE IF NOT EXISTS scope_mentions (
  job_id             uuid NOT NULL,
  entity_id          uuid NOT NULL,
  brand              text,
  entity_type        text,
  mention_count      integer NOT NULL DEFAULT 0,
  sentiment_positive integer NOT NULL DEFAULT 0,
  sentiment_neutral  integer NOT NULL DEFAULT 0,
  sentiment_negative integer NOT NULL DEFAULT 0,
  sentiment_mixed    integer NOT NULL DEFAULT 0,
  avg_position       real,
  PRIMARY KEY (job_id, entity_id)
);
CREATE INDEX IF NOT EXISTS scope_mentions_brand_idx ON scope_mentions (brand);
CREATE INDEX IF NOT EXISTS scope_mentions_job_idx   ON scope_mentions (job_id);

CREATE TABLE IF NOT EXISTS scope_citations (
  id        bigserial PRIMARY KEY,
  job_id    uuid NOT NULL,
  url       text,
  domain    text,
  title     text,
  ref_index integer,
  -- URL 정규화 승격 컬럼 (migration 0052). 값은 sync 삽입 시점에 채워지고,
  -- 기존 행은 scripts/db/backfill-citation-norm.ts 가 채운다. 정규화 정의의
  -- DB 정본은 0052 가 만드는 citation_url_norm()/citation_url_base_norm()/
  -- citation_url_host() 이므로, 이 파일만 돌린 신규 환경에서는 그 함수가 없다
  -- → **0052 를 함께 적용해야 한다**(신규 환경 재현 순서: 이 파일 → 0052).
  url_norm      text,
  url_host      text,
  url_base_norm text
);
CREATE INDEX IF NOT EXISTS scope_citations_job_idx    ON scope_citations (job_id);
CREATE INDEX IF NOT EXISTS scope_citations_domain_idx ON scope_citations (domain);

CREATE TABLE IF NOT EXISTS scope_prompts (
  prompt_id    uuid PRIMARY KEY,
  text         text,
  funnel_stage text
);

-- 답변 원문 감성 밑줄용 발생 단위 언급 미러 (migration 0061, scope#632).
-- 한 행 = (답변 job × 언급 발생) — scope_mentions 가 job×entity 로 접힌 카운트라면
-- 이건 그 카운트를 이루는 낱개다. 오프셋은 코드포인트 기준.
CREATE TABLE IF NOT EXISTS scope_mention_occurrences (
  id                     bigserial PRIMARY KEY,
  job_id                 uuid NOT NULL,
  entity_id              uuid NOT NULL,
  brand_rollup_entity_id uuid,
  turn_index             integer,
  source_start           integer NOT NULL,
  source_end             integer NOT NULL,
  surface_text           text NOT NULL,
  sentiment              text NOT NULL, -- positive | negative | mixed | neutral
  mention_role           text,
  assertion              text,
  context_snippet        text,
  descriptors            text[] NOT NULL DEFAULT '{}',
  criteria               text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS scope_mention_occurrences_job_idx ON scope_mention_occurrences (job_id);

-- Compensating control (no RLS): server-only, same as every other table.
REVOKE ALL ON TABLE scope_runs, scope_answers, scope_mentions, scope_citations, scope_prompts,
  scope_mention_occurrences
  FROM anon, authenticated;
REVOKE ALL ON SEQUENCE scope_citations_id_seq FROM anon, authenticated;
REVOKE ALL ON SEQUENCE scope_mention_occurrences_id_seq FROM anon, authenticated;
