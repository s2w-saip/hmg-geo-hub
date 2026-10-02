-- scope_prompts.is_korean — 한글 프롬프트 판별을 정규식에서 저장 컬럼으로 승격.
--
-- 배경: 표준(루트) 스냅샷 rootFullCycleAnswerIds 의 koreanNonKrExclusion 이
--   EXISTS (SELECT 1 FROM scope_prompts sp WHERE sp.prompt_id = a.prompt_id
--           AND sp.text ~ '[가-힣]')
-- 형태였다. 이 EXISTS 는 `NOT (... AND EXISTS ...)` 안에 있어 플래너가 semi-join
-- 으로 끌어올리지 못하고 **상관 SubPlan** 으로 남는다 → 프로덕션 실측에서
-- 92,651 loops(cell_counts 83,497 + 본 쿼리 9,154), buffer hit 277,953
-- (전체 340,253 의 82%). 정규식이라 인덱스도 못 탄다.
--
-- 저장 컬럼으로 올리면 술어를 비상관 서브리스트
--   a.prompt_id IN (SELECT prompt_id FROM scope_prompts WHERE is_korean)
-- 로 쓸 수 있고, 플래너가 hashed SubPlan(1회 평가)으로 접는다.
--
-- 왜 GENERATED ALWAYS ... STORED 인가:
--   * 드리프트 불가능 — text 가 갱신되면 PG 가 자동 재계산한다. 미러 upsert
--     (scope-mirror.ts::upsertPrompts)가 새 컬럼을 몰라도 값이 절대 낡지 않는다.
--   * 미러 쓰기 경로가 안 깨진다 — drizzle 은 generatedAlwaysAs 컬럼을 INSERT
--     컬럼 목록에서 제외한다(drizzle-orm column.cjs::shouldDisableInsert:
--     generated.type !== 'byDefault' → true). onConflictDoUpdate 의 set 에도
--     없으므로 UPDATE 경로 역시 PG 가 재계산한다.
--   * 표현식이 IMMUTABLE 이어야 하는데 textregexeq(`~`) 는 IMMUTABLE 이다
--     (프로덕션 실측: pg_proc.provolatile = 'i').
--
-- ⚠️ ADD COLUMN ... STORED 는 테이블 재작성 + ACCESS EXCLUSIVE 락을 잡는다.
--    scope_prompts 는 16,110 행(2026-08-27 실측)이라 순간이지만, IF NOT EXISTS
--    는 no-op 이어도 락을 먼저 잡으므로(797초 대기 실증, 0045 헤더 참조)
--    카탈로그 선확인 DO 블록으로 "이미 있으면 락 없이 통과"하게 둔다.
--
-- 판정 불변: is_korean 은 종전 술어와 **같은 식**이다. NULL text 는 양쪽 다
--    NULL → 제외로 동일하게 떨어진다.
--
-- 배포 순서 안전망: 이 리포는 머지 = 무인 프로덕션 배포이고 migrate 단계가 없다
--    (`build` = `next build`). 그래서 앱은 이 컬럼의 **부재를 견딘다** —
--    scope-aggregates.ts 가 pg_attribute 로 존재 여부를 프로세스당 1회 판정해
--    (실측 0.081ms) 없으면 종전 인라인 정규식 술어를 쓴다. 즉 코드가 먼저
--    배포돼도 42703 장애가 나지 않고, 이 마이그레이션을 적용하면 재배포 없이
--    (최대 60초 뒤 재판정) 저장 컬럼 경로로 넘어간다.
--    ⚠️ 그래도 권장 순서는 "마이그레이션 먼저, 머지 나중"이다.

DO $$
BEGIN
  IF to_regclass('public.scope_prompts') IS NULL THEN
    RETURN; -- 테이블 미생성 환경(신규 부트스트랩 순서) — 다음 실행에서 처리
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.scope_prompts'::regclass
      AND attname = 'is_korean'
      AND NOT attisdropped
  ) THEN
    RETURN; -- 이미 적용됨 (out-of-band 선적용 포함) — 락 잡지 않고 통과
  END IF;

  ALTER TABLE public.scope_prompts
    ADD COLUMN is_korean boolean GENERATED ALWAYS AS (text ~ '[가-힣]') STORED;
END $$;
