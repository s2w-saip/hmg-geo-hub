-- scope_context_prompt_cache 낙관적 잠금 컬럼 (2026-07-15)
-- openspec/changes/2026-07-15-add-context-map-query — tasks 5 (lost-update 경합)
--
-- 왜: 프롬프트 blob 은 프로젝트당 1행(jsonb)이고, "더 생성"/"선택 삭제" 둘 다
-- get() → JS에서 수정 → set() 전체 덮어쓰기다. 락도 버전도 없어서 두 조작이
-- 겹치면 나중 것이 앞선 것을 조용히 덮어쓴다("삭제했는데 다시 생김").
--
-- 왜 새 컬럼인가 (design.md D6 정정): D6 은 기존 generated_at 을 토큰으로
-- 재사용하자고 했지만 실측 결과 쓸 수 없다. timestamptz 는 마이크로초 정밀도인데
-- (프로덕션 행에 .597198 / .645339 / .745603 존재) JS Date 는 밀리초까지만이라
-- 왕복하면 값이 깎여 WHERE 가 절대 일치하지 않는다 → 모든 쓰기가 충돌로 오인된다.
-- 정수 버전은 그런 손실이 없다.
--
-- 적용: npm run db:apply -- 0030
-- 멱등(IF NOT EXISTS) — 이 리포는 0020부터 수동 SQL 관리라 재실행 안전이 전제.

ALTER TABLE "scope_context_prompt_cache"
  ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN "scope_context_prompt_cache"."version" IS
  'Optimistic lock token. Readers carry it; writers require it to match and bump it. Never reuse generated_at for this — timestamptz microseconds do not survive a JS Date round-trip.';
