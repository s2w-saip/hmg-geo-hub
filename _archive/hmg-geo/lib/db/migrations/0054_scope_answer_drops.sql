-- 0054: 답변 드롭 레지스트리 — 중복 회차 제외를 재싱크가 소비하는 입력으로 승격.
-- 적용: npm run db:apply -- 0054   (운영자 실행. drizzle-kit migrate 금지)
--
-- ── 왜 ────────────────────────────────────────────────────────────────────────
-- 0053(회차 앵커 레지스트리)의 쌍둥이. 앵커는 "날짜를 옮긴다", 드롭은 "미러에서 뺀다".
--
-- 같은 주에 같은 사이트가 두 번 측정된 중복 회차는 접어도 해결되지 않는다 —
-- 2026-08-17~19 소규모 측정(37사이트 7,130건)은 **전부** 8/21 정규 회차에도 측정된
-- 사이트의 것이라, 8/21 로 접으면 그 주에 같은 사이트의 답변이 두 배가 되어 KPI 가중이
-- 왜곡된다. Kia/IT 7/20(112건)도 같은 형태다 — 7/13 에 자체 회차가 있어 7월 3주로 접으면
-- 이중이 된다. 유일한 처리는 **제외**다(2026-09-03 운영 결정, GGMD "기준선 9개" 요청).
--
-- 그런데 미러 행을 한 번 DELETE 하고 끝내면 `scope_mirror.ts::replaceRun`(run 단위
-- delete + insert)이 그 run 을 다시 훑는 순간 되살아난다 — 앵커가 2026-08-31 회수
-- 재싱크에서 겪은 것(18,890행 원복)과 정확히 같은 형태다. 그래서 드롭도 **레지스트리 +
-- 매 삽입 후 재적용**으로 둔다. 이후 몇 번을 재싱크해도 등록된 job 은 미러에 없다(멱등).
--
-- additive-only: 신규 테이블 1개 + 신규 함수 1개. 기존 테이블 ALTER 없음.
-- scope 원본은 무변경 — 미러는 파생본이다. 원복 = 레지스트리 행 삭제 + 그 run 재싱크.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "scope_answer_drops" (
  "job_id" uuid PRIMARY KEY,
  -- 드롭 직전의 scope 원본 measured_at. UTC 날짜가 곧 "어느 측정일을 뺐나".
  "source_measured_at" timestamp with time zone,
  "dropped_at" timestamp with time zone NOT NULL DEFAULT now(),
  -- 어느 드롭 배치가 등록했는지. 배치 단위 롤백의 키 — 사유 없는 드롭은 등록 불가.
  "reason" text NOT NULL
);--> statement-breakpoint

-- ⚠️ LOCKDOWN COVERAGE (0053 과 동일): 신규 테이블은 lockdown.sql 재실행 전까지
-- anon/authenticated 가드가 없다. 적용 후 확인:
--   SELECT has_table_privilege('anon','public.scope_answer_drops','SELECT');  -- expect false
REVOKE ALL ON "scope_answer_drops" FROM PUBLIC, anon, authenticated;--> statement-breakpoint

-- 삭제 범위·순서의 **정본**. 한 run 안에서 레지스트리에 등록된 job 의 미러 행을
-- citations → mentions → answers 순으로 지운다(answers 의 job_id 가 앞 두 테이블의
-- 귀속 키라 answers 를 먼저 지우면 앞 두 테이블을 좁힐 근거가 사라진다).
-- 소비처: ① scope-mirror.ts::dropReapplySql (재싱크 재적용 — 삽입이 모두 끝난 뒤)
--        ② 수동 드롭 절차 (아래) — run 을 모르면 scope_answers 에서 run_id 를 뽑아 부른다
-- TS 로 세 테이블 delete 를 한 벌 더 쓰지 않는다 — 두 벌이 갈리는 순간 mentions 만
-- 남는 식의 고아가 생긴다.
--
-- ACR 롤업(scope_acr_rollups)은 job 이 아니라 prompt-run 키라 여기서 다루지 않는다 —
-- 드롭 대상 회차의 ACR 은 회차 단위 표면이 아니므로 영향이 없다(website KPI 추이는
-- scope_answers·mentions·citations 만 읽는다).
--
-- 반환 = 지운 answers 행수(감사·검증용). SECURITY INVOKER(기본) — 호출자 권한으로 돈다.
CREATE OR REPLACE FUNCTION scope_answer_drop_apply(p_run_id uuid)
RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  n integer;
BEGIN
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
--   -- 1) 레지스트리에 있는데 미러에 남아 있는 행 = 0 이어야 한다 (재싱크 직후에도)
--   SELECT count(*) FROM scope_answer_drops d JOIN scope_answers a USING (job_id);
--   -- 2) 고아 = 0 (answers 없이 남은 mentions/citations)
--   SELECT count(*) FROM scope_mentions m LEFT JOIN scope_answers a USING (job_id) WHERE a.job_id IS NULL;
--   SELECT count(*) FROM scope_citations c LEFT JOIN scope_answers a USING (job_id) WHERE a.job_id IS NULL;
--
-- ── 회차를 드롭할 때 (수동) ──────────────────────────────────────────────────
-- DELETE 를 직접 쓰지 말고 **레지스트리에 등록한 뒤 함수를 부른다**.
--
--   INSERT INTO scope_answer_drops (job_id, source_measured_at, reason)
--   SELECT a.job_id, a.measured_at, 'drop:<YYYY-MM-DD> <사유>'
--     FROM scope_answers a WHERE <드롭 조건>
--   ON CONFLICT (job_id) DO NOTHING;
--
--   SELECT sum(scope_answer_drop_apply(run_id)) FROM (
--     SELECT DISTINCT a.run_id FROM scope_answers a JOIN scope_answer_drops d USING (job_id)
--   ) r;
--
-- 드롭 판정 규칙: 같은 사이트가 **같은 주 버킷(월요일 시작)** 에 두 회차를 가지면
-- 함대 정규 회차(사이트 수가 많은 쪽)를 남기고 나머지를 드롭한다. 접기(0053)는
-- 회차의 꼬리·조각용이고, 회차 자체가 둘이면 드롭이다.
