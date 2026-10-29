-- website_sites: (brand × country_code) = scope 프로젝트 1개.
-- 동일 국가 내 언어 복수(캐나다 en/fr 등)는 website_prompts.lang_code 로 구분.
CREATE TABLE IF NOT EXISTS "website_sites" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "brand"            text NOT NULL,
  "country_code"     text NOT NULL,
  "scope_project_id" text,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "website_sites_brand_country_idx"
  ON "website_sites" ("brand", "country_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_sites_scope_project_idx"
  ON "website_sites" ("scope_project_id");

-- website_prompts: xlsx 1행 = 1 row. target_url = KPI #6 타겟 출처인용율 기준값.
CREATE TABLE IF NOT EXISTS "website_prompts" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "site_id"         uuid NOT NULL REFERENCES "website_sites" ("id") ON DELETE CASCADE,
  "file_seq"        integer NOT NULL,
  "domain"          text NOT NULL,
  "lang_code"       text NOT NULL,
  "seq_no"          integer NOT NULL,
  "target_url"      text NOT NULL,
  "prompt_text"     text NOT NULL,
  "scope_prompt_id" text,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "website_prompts_site_file_seq_idx"
  ON "website_prompts" ("site_id", "file_seq", "seq_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_prompts_site_id_idx"
  ON "website_prompts" ("site_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_prompts_lang_idx"
  ON "website_prompts" ("site_id", "lang_code");
