-- 0072 — 답변 단위 브랜드 스탠스 미러 (scope_answer_stances).
-- 적용: npm run db:apply -- 0072   (제품 책임자 실행. drizzle-kit migrate 금지)
--
-- ── 왜 새 테이블인가 ─────────────────────────────────────────────────────────
-- 발생(occurrence) 단위 감성은 **브랜드 표면이 있는 절**만 채점한다. 그래서 대명사·
-- "제조사"·"이 업데이트"로 이어지는 비판은 어느 멘션의 절에도 속하지 않아 감성이
-- 붙지 않고, 화면이 발생 단위로 세므로 그 부정이 사라진다.
-- 스탠스는 **답변 전문**을 읽고 (답변 × 브랜드) 하나의 태도를 낸다.
--
-- 파일럿 실측(2026-09-14, hmg 신차 센티먼트 23 프로젝트 · 416 답변 · 실패 0):
--   자사 스탠스 positive 196 · mixed 107 · negative 105 · neutral 8
--   기존 발생 라벨의 no_mention 19건 중 14건이 스탠스에서 non-neutral 로 회수됐다.
--   evidence 원문 완전일치 79.2% · 불일치 8.6% → 오프셋이 있는 행만 "원문 대조됨"이다.
--
-- scope_mentions 에 컬럼을 더하지 않는 이유: 단위가 (턴 × 브랜드)라 멘션 행과
-- 카디널리티가 다르다. 멘션 테이블에 넣으면 같은 브랜드의 멘션 5개에 같은 스탠스가
-- 5번 복제되고 발생 단위 집계(sum(sentiment_*))가 조용히 오염된다.
--
-- additive-only · 멱등. 기존 테이블 ALTER 없음(신규 테이블 1개 + 기존 함수 1개의
-- 삭제 범위 확장). 읽기·쓰기는 answerStancesAvailable() 프로브 뒤에만 —
-- 머지 = 무인 배포라 코드가 db:apply 보다 먼저 갈 수 있고, 그 창에서 42P01 로
-- 답변 모달·우호도 탭이 죽으면 안 된다.
--
-- 정본 스펙: internal-kb/scope-answer-brand-stance-spec-2026-09-14.md §3.3 · §5.2

SET LOCAL lock_timeout = '5s';--> statement-breakpoint

-- 트랜잭션 밖에서 적용되면 `SET LOCAL` 이 조용히 무효가 된다(경고만). 그러면 아래
-- DDL 이 무제한 대기로 들어가 미러 싱크·읽기와 교착할 수 있다 — 0070·0071 과 같은
-- 가드로 **적용 경로 자체를 단언**한다(npm run db:apply 는 항상 tx 안이다).
DO $guard$
BEGIN
  IF current_setting('lock_timeout') <> '5s' THEN
    RAISE EXCEPTION '0072: 트랜잭션 블록 밖에서 적용 중 — npm run db:apply -- 0072 로 적용할 것';
  END IF;
END
$guard$;--> statement-breakpoint

-- PK = (job_id, turn_index, entity_id).
--   · entity_id 는 멘션 엔티티가 아니라 **브랜드 롤업 엔티티**다(제품 멘션 5건이 같은
--     브랜드면 스탠스는 1행).
--   · turn_index 는 scope_mentions 의 (job_id, entity_id) 에 더한 축 — 멀티턴 답변에서
--     턴마다 태도가 다를 수 있다. 코어가 안 실으면 0.
-- FK 는 걸지 않는다 — scope_* 미러 전반의 규약(replaceRun 이 run 단위 delete+insert 라
-- 부모/자식 삭제 순서를 코드가 쥔다. schema.ts 의 같은 주석 참조).
CREATE TABLE IF NOT EXISTS "scope_answer_stances" (
  "job_id" uuid NOT NULL,
  "turn_index" integer DEFAULT 0 NOT NULL,
  "entity_id" uuid NOT NULL,
  -- 코어가 LLM 프롬프트에 실제로 넘긴 이름. 모델이 돌려준 키를 되짚는 축이자,
  -- 미러에 그 브랜드의 멘션 행이 없을 때의 표시명 폴백.
  "brand_label" text,
  -- 코어가 판정한 tracked 여부. ⚠️ hmg 의 당사 판정(단위 컨텍스트 ∩ 자사 명부 ∩
  -- 표기 접두 교정)과 **같지 않다** — KPI 분모는 이 컬럼이 아니라 canonRollupSql 로
  -- 판정한다. 여기 두는 것은 진단·대조용이다.
  "is_tracked" boolean DEFAULT false NOT NULL,
  "stance" text NOT NULL,           -- positive | negative | mixed | neutral
  "confidence" real,
  "evidence_text" text,
  -- **코드포인트** 오프셋. **코어가** 답변 원문에서 evidence_text 를 정확히 1회 찾았을
  -- 때만 쌍으로 채운다(0회·2회 이상이면 둘 다 NULL — 코어 FR4).
  -- ⚠️ 이 컬럼이 채워졌다는 것은 "코어가 찾았다"는 뜻이지 "미러 원문에 있다"가 아니다.
  -- 화면의 대조 판정은 lib/answer-sentiment/stance-evidence.ts 가 미러 원문
  -- (scope_answers.answer_text)과 직접 비교해 내린다 — 파일럿 실측에서 모델 인용의
  -- 8.6% 가 원문과 불일치였고, 오프셋 존재만 믿으면 그 8.6% 를 "원문"으로 표기하게 된다.
  -- 또 미러는 1턴 원문만 가지므로 turn_index > 0 은 대조 자체가 불가능하다.
  "evidence_start" integer,
  "evidence_end" integer,
  "reason" text,
  "model_slug" text,
  CONSTRAINT "scope_answer_stances_pkey" PRIMARY KEY ("job_id", "turn_index", "entity_id")
);--> statement-breakpoint

-- ⚠️ LOCKDOWN COVERAGE (0053·0054·0061 과 동일): 신규 테이블은 lockdown.sql 재실행
-- 전까지 anon/authenticated 가드가 없다. 적용 후 확인:
--   SELECT has_table_privilege('anon','public.scope_answer_stances','SELECT');  -- expect false
REVOKE ALL ON "scope_answer_stances" FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- 드롭 레지스트리(0054) 정합 — 새 테이블을 **삭제 범위에 등재**한다.
-- 0054 본문을 그대로 두고 stances 삭제를 맨 앞에 더한 것뿐이다(순서: 자식 → answers).
-- 등재하지 않으면 드롭된 job 의 스탠스가 고아로 남고, 재싱크가 그것을 되살리지도
-- 지우지도 못한다(앵커 2026-08-31 원복 사고와 같은 형태).
--
-- ⚠️ 여전히 scope_mention_occurrences 는 이 함수가 모른다(0061 이후 남은 결손).
-- 이번 마이그레이션의 범위를 넘어서므로 그대로 둔다 — 별도 마이그레이션 몫.
CREATE OR REPLACE FUNCTION scope_answer_drop_apply(p_run_id uuid)
RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  n integer;
BEGIN
  DELETE FROM scope_answer_stances s
   USING scope_answers a JOIN scope_answer_drops d USING (job_id)
   WHERE s.job_id = a.job_id AND a.run_id = p_run_id;
  DELETE FROM scope_citations c
   USING scope_answers a JOIN scope_answer_drops d USING (job_id)
   WHERE c.job_id = a.job_id AND a.run_id = p_run_id;
  DELETE FROM scope_mentions m
   USING scope_answers a JOIN scope_answer_drops d USING (job_id)
   WHERE m.job_id = a.job_id AND a.run_id = p_run_id;
  DELETE FROM scope_answers a
   USING scope_answer_drops d
   WHERE a.job_id = d.job_id AND a.run_id = p_run_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION scope_answer_drop_apply(uuid) FROM PUBLIC, anon, authenticated;

-- ── 적용 후 검증 (읽기) ───────────────────────────────────────────────────────
--   -- 1) 테이블·PK 존재
--   SELECT to_regclass('public.scope_answer_stances');            -- not null
--   SELECT conname FROM pg_constraint WHERE conrelid = 'scope_answer_stances'::regclass;
--   -- 2) anon 차단 (lockdown 재실행 후)
--   SELECT has_table_privilege('anon','public.scope_answer_stances','SELECT');  -- false
--   -- 3) 드롭 고아 0 (드롭 레지스트리가 있는 환경에서)
--   SELECT count(*) FROM scope_answer_stances s JOIN scope_answer_drops d USING (job_id);
--   -- 4) 고아 0 (answers 없이 남은 스탠스)
--   SELECT count(*) FROM scope_answer_stances s
--     LEFT JOIN scope_answers a USING (job_id) WHERE a.job_id IS NULL;
--   -- 5) 어휘 이탈 0 (코어가 새 라벨을 내기 시작하면 화면 색이 중립으로 접힌다)
--   SELECT stance, count(*) FROM scope_answer_stances GROUP BY 1 ORDER BY 2 DESC;
--   -- 6) 오프셋 쌍 정합 — 한쪽만 채워진 행 0
--   SELECT count(*) FROM scope_answer_stances
--    WHERE (evidence_start IS NULL) <> (evidence_end IS NULL);
--   -- 7) 오프셋이 미러 원문과 실제로 맞는가 (turn 0 만 — 화면 판정과 같은 질문)
--   --    코드포인트 기준이라 SQL substring 은 근사다. 정본 판정은 애플리케이션 측
--   --    (stance-evidence.ts). 이 쿼리는 규모 감시용이다.
--   SELECT count(*) FILTER (WHERE a.answer_text IS NOT NULL AND position(s.evidence_text in a.answer_text) = 0) AS not_in_text,
--          count(*) AS with_evidence
--     FROM scope_answer_stances s JOIN scope_answers a USING (job_id)
--    WHERE s.turn_index = 0 AND s.evidence_text IS NOT NULL;
--
-- ── 원복 ─────────────────────────────────────────────────────────────────────
-- 미러는 파생본이므로 DROP TABLE scope_answer_stances 로 되돌릴 수 있다(scope 원본
-- 무변경). 단 scope_answer_drop_apply() 는 0054 본문으로 함께 되돌려야 한다 —
-- 테이블 없이 함수만 남으면 드롭 재적용이 42P01 로 죽고 **미러 싱크 트랜잭션 전체가
-- 실패**한다. 두 개는 한 세트다.
