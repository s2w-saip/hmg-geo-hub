-- 0060 — 보고서 v2.4(HMG-GEO-web_geo_status_report) 유닛 플래그를 사실표에 굳힌다.
--
-- 왜: 보고서 값의 정본은 scripts/reports/extract-citation-data.mts + report-spec.json(109 유닛)
-- 이고, 그 판정 규칙은 **전부 유닛(사이트×언어) 고유**다 — 화면 필터와 무관하므로 생성
-- 시점에 행 플래그로 굳힐 수 있다(대조 정본: (내부 작업 파일)).
--   · 유닛 소속   = spec(brand, cc, langCode) + urlLike/urlNotLike (NORM(target_url) 기준)
--   · 유닛 BASE   = 그 유닛이 **선언한** owned_base_url 의 최빈값(0049) — 선언이 없을 때만
--                   종전 휴리스틱(타겟 최빈 host, hyundai/kia/genesis.com 만 host/1seg)
--   · owned      = ① 선언 base 접두 − 같은 호스트의 더 긴 선언 base(형제) 제외 (#215)
--                  ② 이 유닛 타겟 URL 과 일치 (타겟 ⊂ 자사, #213)
--                  ③ 사이트 루트 홈(공유 글로벌 호스트 제외) (#216)
--   · target     = NORM(citation.url) ∈ 그 유닛의 타겟 집합(flat)
--
-- additive-only · 멱등(IF NOT EXISTS / CREATE OR REPLACE) · 한 트랜잭션.
-- 파티션 부모에 ADD COLUMN 하면 자식이 상속하므로 파티션별 반복이 필요 없다.
-- summary_* 는 아직 어떤 화면도 읽지 않는다(summary_settings.read_enabled='0') —
-- ACCESS EXCLUSIVE 를 잡아도 라이브 조회를 막지 않는다.
SET LOCAL lock_timeout = '5s';

-- 보고서 NORM = 추출기의 정규식 사슬 = 0052 의 citation_url_norm 과 **문자적으로 같다**
-- (추출기 주석: "citationTrackedNormSql 과 동일한 규칙"). 정의를 두 벌로 만들지 않으려고
-- 여기서는 위임만 한다 — 0052 를 고치면 이쪽도 자동으로 따라간다.
CREATE OR REPLACE FUNCTION summary_report_norm(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $fn$
SELECT citation_url_norm($1)
$fn$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION summary_report_norm(text) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint

-- 프롬프트 차원 — 유닛 소속·BASE·보고서 NORM 타겟
ALTER TABLE summary_prompt_dim ADD COLUMN IF NOT EXISTS report_fs int;
--> statement-breakpoint
ALTER TABLE summary_prompt_dim ADD COLUMN IF NOT EXISTS unit_base text;
--> statement-breakpoint
ALTER TABLE summary_prompt_dim ADD COLUMN IF NOT EXISTS target_url_norm_report text;
--> statement-breakpoint

-- 답변 — 유닛 소속 + 유닛 BASE 자사 인용 보유 + 자기 타겟 URL 인용 보유
ALTER TABLE summary_answers ADD COLUMN IF NOT EXISTS report_fs int;
--> statement-breakpoint
ALTER TABLE summary_answers ADD COLUMN IF NOT EXISTS unit_owned int;
--> statement-breakpoint
ALTER TABLE summary_answers ADD COLUMN IF NOT EXISTS unit_target int;
--> statement-breakpoint

-- 인용 — 그 행 그룹(job × group_key × matched_base) 안의 유닛 BASE 매칭 인용 수
ALTER TABLE summary_domain_citations ADD COLUMN IF NOT EXISTS unit_owned_citations int;
--> statement-breakpoint

-- 유닛 단위 집계 경로(report_fs 로 좁힌 뒤 job 조인)를 위한 인덱스.
CREATE INDEX IF NOT EXISTS summary_answers_report_fs_idx
  ON summary_answers (cycle_id, generation_id, report_fs);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS summary_prompt_dim_report_fs_idx
  ON summary_prompt_dim (cycle_id, generation_id, report_fs);
