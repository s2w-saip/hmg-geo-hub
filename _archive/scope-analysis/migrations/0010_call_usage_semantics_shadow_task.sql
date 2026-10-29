-- 0010 콜 원장 `task` 어휘에 **semantics_shadow** 추가 — 감성 V2 섀도 병행 패스(PR-L1).
--
-- 정본: docs/engineering/scope/scope-sentiment-v2-shadow-dual-store-plan-2026-09-18.md §3.2 · §5-6
--
-- ── 왜 지금인가 (아직 그 태스크를 부르지도 않는데)
--
--   0009 헤더와 **같은 이유**다. `contracts/v1.ts` `AnalysisTaskSchema` 와 이 CHECK 는 같은
--   어휘의 두 사본이고, PR-L1 은 계약 쪽만 넓히는 PR 이다. 둘을 갈라 두면 그 드리프트는
--   **PR-L2(벤더 재동기 + seam 배선)에서 라이브로** 터진다: 섀도 콜이 처음 나가는 순간
--   `analysis_call_usage` INSERT 가 `violates check constraint` 로 죽고, 그 실패는 콜 원장
--   쓰기에서 나므로 **LLM 실비는 이미 나간 뒤**다. 어휘를 넓히는 쪽이 한 줄이다.
--
--   `tests/stance-contract.test.ts` 의 "task 어휘의 두 사본이 같다" 가 이 두 사본을 게이트한다.
--
-- ── 이 태스크는 **코어에 없다** (0009 의 stance 와 다른 점)
--
--   섀도 V2 의 벤더 요청 task 는 현행과 같은 `measurement.analysis.mention_semantics` 다.
--   그대로 두면 V0 감성 비용과 섀도 비용이 같은 원장 행 종류로 뭉개져 플랜 §5 수용 기준 6
--   (`analysis_call_usage.task='semantics_shadow'` 로 섀도 비용이 따로 집계된다)을 판정할 수
--   없다. 그래서 lane 이 원장 태스크만 갈아끼운다(`withTaskOverride`) — **모델·풀은 안 갈린다**
--   (`TASK_ROUTING_ALIAS` 가 `mention_semantics` 라우팅을 그대로 태운다).
--
-- ── 왜 `DROP CONSTRAINT IF EXISTS <이름>` 이 아니라 **카탈로그에서 이름을 찾는가**
--
--   0009 헤더 그대로다. 0003 은 컬럼 인라인 CHECK 라 PG 가 이름을 자동 생성했고, 그 이름은
--   추정이지 보장이 아니다. 이름으로 지우면 라이브가 다른 이름을 가졌을 때 **조용히 no-op**
--   이 되고, 그 다음 ADD 도 "이미 task CHECK 가 있다" 로 건너뛰어 **옛 어휘가 살아남는다.**
--   마이그레이션은 성공으로 기록되고 실패는 첫 섀도 콜에서 나타난다.
--   같은 이유로 `IF NOT EXISTS` 류를 안 쓴다 — no-op 이어도 락을 **먼저** 잡는다
--   (workspace 룰: PG 마이그레이션 락 함정).
--
-- ── 락 — **언제 잡히는가** (이 리포는 코어와 다르다)
--
--   ⚠️ 코어(scope)는 "머지 = 무인 배포 = migrate 선행" 이지만 **이 리포는 아니다.** 여기 CI
--      (`.github/workflows/ci.yml`)에는 `cdk deploy` 도 `update-service` 도 없고, 이미지 push 는
--      `workflow_dispatch` 전용이다(`push-images-stage.yml`). 마이그레이션은 **api·worker 컨테이너
--      기동 시** `migrate(db)` 로 적용된다(`worker/main.ts:963` · `app/main.ts:72`).
--      → 이 파일이 락을 잡는 순간은 **머지 시점이 아니라 이미지 push + cdk deploy 직후 첫 태스크
--        기동 시점**이다. 장기 트랜잭션 0 확인도 그 시점 기준으로 해야 한다.
--
--   CHECK 를 **넓히는** 변경이라 기존 행은 전부 새 조건을 만족한다. 그래도 DROP/ADD CONSTRAINT
--   는 `ACCESS EXCLUSIVE` 를 요구하므로 `lock_timeout` 을 짧게 걸어 **못 잡으면 빨리 실패**시킨다
--   (0007·0008·0009 와 같은 규율). 롤링 중 선두 태스크가 최대 10초 기다리고, 실패하면 그 태스크는
--   `process.exit(1)` 로 죽는다(`worker/main.ts` `main().catch`) — 재기동 때 다시 시도한다.
--   라이브 INSERT 를 오래 막는 것보다 태스크 하나가 빨리 죽는 쪽이 낫다.
--   `NOT VALID` 로 기존 행 전수 스캔을 생략한다 — 넓히는 방향이라 검증할 것이 없고, 새 행은
--   NOT VALID 제약도 그대로 검사받는다.
SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  v_rel oid := to_regclass('analysis_call_usage');
  v_name text;
BEGIN
  -- ⚠️ `information_schema` 가 아니라 `to_regclass` 다 — search_path 를 그대로 따르므로
  --    러너가 실제로 고칠 그 테이블을 본다(0007·0008·0009 관례).
  IF v_rel IS NULL THEN
    RAISE EXCEPTION 'analysis_call_usage 가 없다 — 0003 이 적용되지 않았다';
  END IF;

  -- ① `task` 를 제약하는데 semantics_shadow 를 모르는 CHECK 를 **이름으로** 지운다. 이미 넓어져
  --    있으면 이 루프가 0회 돌고 아래 ② 도 건너뛴다 = **락을 아예 안 잡는다**(재실행 안전).
  --
  --    ⚠️ 매칭 술어가 `'%''semantics''%'` 가 아니라 `'%''semantics_shadow''%'` 인 것이 중요하다.
  --       `'semantics'` 로 보면 0009 가 만든 5값 제약이 이미 그 문자열을 포함하므로
  --       (`'semantics'`) 루프가 0회 돌고 **옛 5값 제약이 그대로 남는다.** 넓히는 대상은
  --       이번에 추가되는 값이므로 술어도 그 값으로 쓴다.
  FOR v_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = v_rel
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%task%'
       AND pg_get_constraintdef(oid) NOT ILIKE '%''semantics_shadow''%'
  LOOP
    EXECUTE format('ALTER TABLE analysis_call_usage DROP CONSTRAINT %I', v_name);
  END LOOP;

  -- ② 남은 task CHECK 가 하나도 없을 때만 새로 만든다.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = v_rel AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%task%'
  ) THEN
    EXECUTE 'ALTER TABLE analysis_call_usage ADD CONSTRAINT analysis_call_usage_task_check '
         || 'CHECK (task IN (''extract'',''resolve'',''semantics'',''citation'',''stance'',''semantics_shadow'')) NOT VALID';
  END IF;
END
$$;

-- ── 사후 단언 — "적용됐다" 가 아니라 **"그 결과가 맞다"** 를 본다(0009 와 같은 규율).
--
--   위 DO 가 조용히 아무것도 안 하고 끝나는 경로(이름 못 찾음·정의 매칭 실패)가 남으면 이
--   마이그레이션은 성공으로 기록되고 라이브는 옛 어휘를 그대로 들고 간다. 그 결손은 PR-L2 의
--   첫 섀도 콜에서야 드러나고, 그때는 LLM 실비가 이미 나간 뒤다.
--   마이그레이션 전체가 한 트랜잭션이므로(`app/migrate.ts` applyMigrations) 여기서 던지면
--   **0010 만이 아니라 그 배치 전체가 롤백**된다.
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
  IF v_def NOT ILIKE '%''semantics_shadow''%' THEN
    RAISE EXCEPTION 'task CHECK 가 semantics_shadow 를 모른다: % — DROP 이 no-op 이었다', v_def;
  END IF;
  -- 넓히는 변경이므로 **옛 어휘가 하나도 빠지면 안 된다** — 빠지면 그 태스크의 원장이 죽는다.
  IF v_def NOT ILIKE '%''stance''%' OR v_def NOT ILIKE '%''citation''%' THEN
    RAISE EXCEPTION 'task CHECK 가 좁아졌다: % — 넓히는 변경인데 옛 값이 사라졌다', v_def;
  END IF;
END
$$;

-- SET LOCAL 은 트랜잭션 끝까지 산다. 마이그레이터가 미적용분 전체를 **한 트랜잭션**에서
-- 돌리므로, 되돌리지 않으면 다음 마이그레이션이 이 10s 를 그대로 상속한다(0002·0007~0009 관례).
RESET lock_timeout;
