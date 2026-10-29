-- 0009 콜 원장 `task` 어휘에 **stance** 추가 — 답변 단위 브랜드 스탠스 태스크(WU2).
--
-- 정본: docs/engineering/scope/scope-answer-brand-stance-spec-2026-09-14.md §4.1 · §8.2 WU2
--
-- ── 왜 지금인가 (아직 그 태스크를 부르지도 않는데)
--
--   `contracts/v1.ts` `AnalysisTaskSchema` 와 이 CHECK 는 **같은 어휘의 두 사본**이다. WU2 는
--   계약 쪽만 넓히는 PR 이지만, 둘을 갈라 두면 그 드리프트는 **WU6 에서 라이브로** 터진다:
--   스탠스 콜이 처음 나가는 순간 `analysis_call_usage` INSERT 가
--   `new row ... violates check constraint` 로 죽는다. 그 실패는 콜 원장 쓰기에서 나므로
--   **LLM 실비는 이미 나간 뒤**이고, 정산 경로에 따라 티켓 전체를 끌고 내려간다.
--   어휘를 넓히는 쪽이 한 줄이고 되돌릴 것도 없다.
--
--   `tests/stance-contract.test.ts` 의 "task 어휘의 두 사본이 같다" 가 이 두 사본이 다시
--   갈리는 것을 게이트한다 — 다음에 태스크가 늘면 거기서 먼저 깨진다.
--
-- ── 왜 `DROP CONSTRAINT IF EXISTS <이름>` 이 아니라 **카탈로그에서 이름을 찾는가**
--
--   0003 은 컬럼 인라인 CHECK 라 PG 가 이름을 자동 생성했고(`analysis_call_usage_task_check`),
--   그 이름은 **추정이지 보장이 아니다.** 라이브가 다른 이름을 갖고 있으면
--   `DROP CONSTRAINT IF EXISTS analysis_call_usage_task_check` 는 **조용히 no-op** 이 되고,
--   그 다음 ADD 도 "이미 task CHECK 가 있다" 로 건너뛰어 **옛 4값 제약이 살아남는다.**
--   마이그레이션은 성공으로 기록되고, 실패는 WU6 의 첫 스탠스 콜에서 나타난다 — 정확히
--   이 파일이 막으려던 그 실패가, 이 파일을 적용하고도 남는 것이다.
--   그래서 이름이 아니라 **정의(pg_get_constraintdef)로 찾아 이름으로 지운다.**
--
--   같은 이유로 `IF NOT EXISTS` 류를 안 쓴다 — no-op 이어도 락을 **먼저** 잡는다
--   (workspace 룰: PG 마이그레이션 락 함정, 2026-07-31 797초 대기·44세션 적체 실증).
--   카탈로그를 먼저 보고 **필요할 때만** ALTER 한다(0006~0008 관례).
--
-- ── 락
--
--   CHECK 를 **넓히는** 변경이라 기존 행은 전부 새 조건을 만족한다. 그래도
--   DROP/ADD CONSTRAINT 는 `ACCESS EXCLUSIVE` 를 요구하므로 `lock_timeout` 을 짧게 걸어
--   **못 잡으면 빨리 실패**시킨다(0007·0008 헤더와 같은 규율 — 배포가 서는 것이 라이브
--   INSERT 를 오래 막는 것보다 낫다). `NOT VALID` 로 **기존 행 전수 스캔을 생략**한다:
--   넓히는 방향이라 검증할 것이 없고, 새 행은 NOT VALID 제약도 그대로 검사받는다.
SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  v_rel oid := to_regclass('analysis_call_usage');
  v_name text;
BEGIN
  -- ⚠️ `information_schema` 가 아니라 `to_regclass` 다 — search_path 를 그대로 따르므로
  --    러너가 실제로 고칠 그 테이블을 본다(0007·0008 관례).
  IF v_rel IS NULL THEN
    RAISE EXCEPTION 'analysis_call_usage 가 없다 — 0003 이 적용되지 않았다';
  END IF;

  -- ① `task` 를 제약하는데 stance 를 모르는 CHECK 를 **이름으로** 지운다. 이미 넓어져
  --    있으면 이 루프가 0회 돌고 아래 ② 도 건너뛴다 = **락을 아예 안 잡는다**(재실행 안전).
  FOR v_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = v_rel
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%task%'
       AND pg_get_constraintdef(oid) NOT ILIKE '%''stance''%'
  LOOP
    EXECUTE format('ALTER TABLE analysis_call_usage DROP CONSTRAINT %I', v_name);
  END LOOP;

  -- ② 남은 task CHECK 가 하나도 없을 때만 새로 만든다.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = v_rel AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%task%'
  ) THEN
    EXECUTE 'ALTER TABLE analysis_call_usage ADD CONSTRAINT analysis_call_usage_task_check '
         || 'CHECK (task IN (''extract'',''resolve'',''semantics'',''citation'',''stance'')) NOT VALID';
  END IF;
END
$$;

-- ── 사후 단언 — "적용됐다" 가 아니라 **"그 결과가 맞다"** 를 본다.
--
--   위 DO 가 조용히 아무것도 안 하고 끝나는 경로(이름 못 찾음·정의 매칭 실패)가 남으면
--   이 마이그레이션은 성공으로 기록되고 라이브는 옛 4값 제약을 그대로 들고 간다. 그 결손은
--   WU6 의 첫 스탠스 콜에서야 드러나고, 그때는 LLM 실비가 이미 나간 뒤다.
--   마이그레이션 전체가 한 트랜잭션이므로(`app/migrate.ts` applyMigrations) 여기서 던지면
--   **0009 만이 아니라 그 배치 전체가 롤백**된다 — 절반만 적용된 상태가 남지 않는다.
DO $$
DECLARE
  v_cnt int;
  v_def text;
BEGIN
  SELECT count(*), max(pg_get_constraintdef(oid))
    INTO v_cnt, v_def
    FROM pg_constraint
   WHERE conrelid = to_regclass('analysis_call_usage')
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%task%';

  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'analysis_call_usage 의 task CHECK 가 %개다(1개여야 한다) — 옛 제약이 남았거나 중복 생성됐다', v_cnt;
  END IF;
  IF v_def NOT ILIKE '%''stance''%' THEN
    RAISE EXCEPTION 'task CHECK 가 stance 를 모른다: % — DROP 이 no-op 이었다', v_def;
  END IF;
END
$$;

-- SET LOCAL 은 트랜잭션 끝까지 산다. 마이그레이터가 미적용분 전체를 **한 트랜잭션**에서
-- 돌리므로(`app/migrate.ts` applyMigrations), 되돌리지 않으면 다음 마이그레이션이 이 10s 를
-- 그대로 상속한다 — 자기가 정한 적 없는 상한으로 죽는다(0002·0007·0008 관례).
RESET lock_timeout;
