-- 0063(구 0061 — 0061 은 #231 scope_mention_occurrences 가 선점, 프로덕션에는 이미 0061 파일명으로 적용됨) — brandPresence 축을 **집합(presence_set)** 으로 굳힌다.
--
-- 왜: 미러(정본) 경로는 brandPresence 를 카탈로그 원값이 아니라 **유도값**으로 판정하고,
-- 게다가 카탈로그 중복 행에 대해 any-match 다.
--   미러: `COALESCE(prompts.brand_presence,
--          CASE WHEN brand = 'HMG' THEN 'unbranded' WHEN brand IS NOT NULL THEN 'branded' END)`
--         (lib/db/repositories/scope-aggregates.ts::brandPresenceResolvedSql, 프롬프트 세미조인)
--   사실표(0059): `(array_agg(p.brand_presence ORDER BY updated_at DESC))[1]` = **원값 1행**
-- 이 차이가 실제로 값을 갈랐다(2026-09-06 패리티, 글로벌 8/31 회차 실측):
--   · 루트 카탈로그 12,006 프롬프트 중 2,330 행이 brand_presence NULL · brand non-null
--     → 유도하면 branded/unbranded 가 되는데 사실표에는 NULL 로 굳어 있었다.
--   · `brandPresence=branded` 격자: 답변 12,776(사실표) vs 20,712(미러), ① 88.3 vs 81.4,
--     ② 76.0 vs 62.7, ⑤ 18.0 vs 16.2, 퍼널 프롬프트 3,896 vs 6,113 — 114개 항목 불일치.
--   · 분해: NULL→branded 7,586 · NULL→양쪽(중복 행) 132 · fact=unbranded 인데 미러
--     any-match 로 branded 도 되는 218.
--
-- 그래서 스칼라 한 값이 아니라 **그 프롬프트의 모든 카탈로그 행에서 유도한 distinct 집합**을
-- 싣는다. 조회는 `presence_set && $sel::text[]` — 미러의 any-match 세미조인과 동치다.
-- 종전 `brand_presence_resolved`(최신 1행 원값)는 남긴다(감사·대조용, 읽기는 안 쓴다).
--
-- additive-only · 멱등(IF NOT EXISTS) · 한 트랜잭션.
-- 파티션 부모에 ADD COLUMN 하면 자식이 상속하므로 파티션별 반복이 필요 없다.
-- 기본값이 상수라 rewrite 없는 fast-default 경로다(락 보유 시간 = 카탈로그 갱신뿐).
-- ⚠️ 0060 과 달리 지금은 웹사이트 표면이 라이브로 읽힌다(summary_settings.read_enabled='1')
--    — ACCESS EXCLUSIVE 를 짧게라도 잡으므로 `lock_timeout` 으로 대기를 끊는다.
-- `summary_target_hits` 는 제외한다: 이 표에는 brandPresence 축 컬럼 자체가 없고(0059:147-155)
--    조회도 job 조인으로만 좁힌다 — 축을 새로 심을 이유가 없다.
SET LOCAL lock_timeout = '5s';

ALTER TABLE summary_prompt_dim        ADD COLUMN IF NOT EXISTS presence_set text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE summary_answers           ADD COLUMN IF NOT EXISTS presence_set text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE summary_brand_mentions    ADD COLUMN IF NOT EXISTS presence_set text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE summary_domain_citations  ADD COLUMN IF NOT EXISTS presence_set text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint

-- 조회 술어(`presence_set && $sel`)가 도는 유일한 표 = summary_answers(모수 술어).
-- 나머지 두 사실표는 job 집합 조인으로만 좁혀지므로 인덱스를 달지 않는다
-- (catalog_brands 가 answers·brand_mentions 양쪽에 gin 을 가진 것과 다른 이유가 이것이다 —
--  brand 축은 미러 대조용으로 brand_mentions 에서도 직접 걸린 전례가 있었다).
CREATE INDEX IF NOT EXISTS summary_answers_presence_idx ON summary_answers USING gin (presence_set);
