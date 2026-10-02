-- 0070 — 회차 **원장 숨김**(수집 오류 회차를 화면에서 내리되 데이터는 남긴다).
--
-- 배경(2026-09-10 제품 책임자): 글로벌 8/25 앵커 회차(cycle_week 2026-08-24)가 정원의 **1/4**
-- 만 수집된 채 `closed` 로 굳었다(실측: expected=completed **9,652** vs 정원 38,748,
-- `analysis_gap_ratio` 0.093 → 생성기가 뽑아 갈 수 있는 값이라 미발행이 아니다).
-- 집계층 회차 축 추이에서는 기간 게이트가 이미 걸러 내지만(`cycle-set.ts` skipped),
-- **미러 리더**(인용 화면 주별 상위 10 도메인·언급 주별·경쟁사 brand/rank 추이)는
-- run 단위로 읽으므로 그 416 run · 13,816 답변이 8/24 주에 그대로 찍혀 **골짜기**가 된다.
-- 값이 낮은 것이 아니라 그 주의 수집이 깨진 것인데, 차트는 둘을 구분해 주지 못한다.
--
-- 왜 삭제(0054 `scope_answer_drops`)가 아니라 숨김인가:
--   · **가역** — 사유를 지우면 그대로 돌아온다. 드롭은 답변을 지우므로 되돌릴 수 없다.
--   · **사유 보존** — "왜 안 보이나" 에 원장이 답한다. 드롭은 그 기록이 다른 표에 있다.
--   · **모수 보존** — 미러(scope_answers)는 measured_at 오염 사고(2026-07-21)의 복구
--     소스다. 화면에서 내리는 일로 그 소스를 건드리지 않는다.
--
-- 규약 (0064·0067 과 동일):
--   · additive-only — 기존 테이블 ALTER 는 컬럼 **추가**뿐(0007 prod 장애 전례).
--   · 멱등 — 재실행 안전. **`ADD COLUMN IF NOT EXISTS` 를 쓰지 않는다**: no-op 이어도
--     ACCESS EXCLUSIVE 를 **먼저 잡는다**(797초 대기·44세션 적체 실증) → 카탈로그 선확인.
--   · 한 파일 = 한 트랜잭션(scripts/db/apply-migration.ts) → `CONCURRENTLY` 불가.
--   · `summary_*` 계열이라 `schema.ts`·`meta/_journal.json` 에 넣지 않는다(0059~0069 과 같은 자세).
--
-- 락·소요: `summary_cycles` 는 **파티션이 아닌 단일 표**이고 실측 96행이다(global 1 +
--   website 95). `ADD COLUMN <type>`(DEFAULT 없음)은 PG 11+ 에서 메타데이터 전용이라
--   테이블을 다시 쓰지 않는다 — 밀리초. `lock_timeout='3s'` 가 대기 상한을 준다.
--   ⚠️ ACCESS EXCLUSIVE 는 읽기까지 막는다 — 관제·생성 러너가 도는 중이면 그동안
--      대기하고, 못 잡으면 파일 전체가 깨끗이 중단된다(재시도 가능).
--
-- ⚠️ **CHECK 제약을 NOT VALID 로 붙이지 않는다.** 기존 96행은 전부 `hidden_reason`
--    이 NULL 로 태어나므로(방금 추가한 컬럼) 검증할 행이 없다 — 즉시 VALID 로 붙여도
--    풀 스캔이 없고, 96행짜리 표라 어차피 무의미하다.
--
-- 적용 후 절차: 이 파일만으로는 **아무 회차도 숨겨지지 않는다**(전 행 NULL).
--   숨김은 운영자 스크립트로 한 행씩 찍는다 —
--     bash notes/hmg-db-exec.sh <워크트리> npx tsx --tsconfig scripts/summary/tsconfig.json \
--       scripts/summary/hide-cycle.ts <cycle_id> --reason=collection_error --yes
--   (인자 없이 = dry-run. 끝에 revalidate 안내가 출력된다.)

SET LOCAL lock_timeout = '3s';

-- ── ⓪ 트랜잭션 블록 가드 (0065·0066·0067 과 동일) ────────────────────────────
-- `SET LOCAL` 은 tx 밖에서 WARNING(25P01) 만 내고 값이 0(무제한)으로 남는다(실측).
-- 그 상태로 ACCESS EXCLUSIVE 를 걸면 무한 대기다.
DO $do$
BEGIN
  IF current_setting('lock_timeout') <> '3s' THEN
    RAISE EXCEPTION '0070: 트랜잭션 블록 밖에서 적용 중이다(lock_timeout=%) — npm run db:apply 를 쓸 것', current_setting('lock_timeout');
  END IF;
END
$do$;

-- ── ① summary_cycles.hidden_reason / hidden_at ───────────────────────────────
-- 두 컬럼은 **한 쌍**이다: 사유가 있으면 시각이 있고, 없으면 둘 다 NULL 이다.
-- 그 불변식은 CHECK 하나로 묶어 못 박는다 — 스크립트가 한쪽만 쓰는 사고를 DB 가 막는다.
DO $do$
BEGIN
  IF to_regclass('public.summary_cycles') IS NULL THEN
    RAISE EXCEPTION '0070: summary_cycles 가 없다 — 0059 를 먼저 적용할 것';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.summary_cycles'::regclass
      AND attname = 'hidden_reason' AND attnum > 0 AND NOT attisdropped
  ) THEN
    -- DEFAULT 를 붙이지 않는다 — NULL 이 "숨기지 않음" 이고, 그것이 기존 96행의 진실이다.
    EXECUTE 'ALTER TABLE public.summary_cycles ADD COLUMN hidden_reason text';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.summary_cycles'::regclass
      AND attname = 'hidden_at' AND attnum > 0 AND NOT attisdropped
  ) THEN
    EXECUTE 'ALTER TABLE public.summary_cycles ADD COLUMN hidden_at timestamptz';
  END IF;

  -- 어휘 + 쌍 불변식. 제약 이름으로 존재를 판정한다(카탈로그 선확인 — 위와 같은 자세).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.summary_cycles'::regclass
      AND conname = 'summary_cycles_hidden_reason_ck'
  ) THEN
    EXECUTE $c$
      ALTER TABLE public.summary_cycles
        ADD CONSTRAINT summary_cycles_hidden_reason_ck CHECK (
          (hidden_reason IS NULL AND hidden_at IS NULL)
          OR (hidden_reason IN ('collection_error','operator') AND hidden_at IS NOT NULL)
        )
    $c$;
  END IF;
END
$do$;

COMMENT ON COLUMN summary_cycles.hidden_reason IS
  '원장 숨김 사유. NULL = 숨기지 않음(기본). collection_error = 수집이 깨진 회차(부분 수집·엔진 장애 등) — 화면은 그 회차를 값 대신 "오류로 인해 수집되지 않음" 음영 슬롯으로 그린다. operator = 운영 판단으로 내린 회차. 리더 술어 정본은 lib/db/repositories/scope-aggregates.ts::excludeHiddenCycleRuns(미러)와 lib/summary/read/cycle-set.ts(집계층 skipped). 데이터는 지우지 않는다 — 사유를 NULL 로 되돌리면 그대로 복귀한다.';

COMMENT ON COLUMN summary_cycles.hidden_at IS
  '숨긴 시각. hidden_reason 과 한 쌍(CHECK summary_cycles_hidden_reason_ck) — 한쪽만 채우면 DB 가 거절한다.';

-- ── ② 관제·생성기·스왑은 이 두 컬럼을 건드리지 않는다 ────────────────────────
-- 확인함(2026-09-10 소스 대조): summary_cycles 에 쓰는 문장은 6개뿐이고 전부 **컬럼을
-- 명시**한다 — `SELECT *`·`INSERT … VALUES` 무열거가 하나도 없다.
--   · summary-cycles.ts:972  INSERT (surface, project_id, cycle_anchor_at, cycle_week,
--                                    anchor_source, status, fleet_visible)
--   · summary-cycles.ts:1006/1030/1069  UPDATE … SET <열거된 열>   (귀속·카운터·종결)
--   · summary-cycles.ts:1115 UPDATE … SET fleet_visible = r.want   (5단계 함대 가시성)
--   · generate/cycle.ts:23   INSERT (… generator_version)  · :78/:124/:209 UPDATE SET <열거>
--   · generate/swap.ts:87    UPDATE SET active_generation_id, view_anchor_at, status, stale_since
-- 즉 `runCycleControl` 이 매 실행 재계산하는 `fleet_visible` 과 달리 이 두 컬럼은
-- **사람이 찍은 값이 그대로 남는다**. 이 불변식은 소스 대조 테스트가 고정한다
-- (lib/db/schema.migration-0070.test.ts).

-- ── ③ ACL ────────────────────────────────────────────────────────────────────
-- 새 표·함수를 만들지 않았다(컬럼 2개뿐) — 컬럼 추가는 표 ACL 을 바꾸지 않는다.
-- 그래도 0059·0064·0065·0066·0067 관례대로 한 번 더 닫는다. summary_cycles 는
-- 파티션이 아니므로 자식 순회가 없다.
DO $do$
BEGIN
  EXECUTE 'REVOKE ALL ON public.summary_cycles FROM PUBLIC, anon, authenticated';
END
$do$;

-- ── 롤백 (참고 — 실행하려면 별도 파일로) ──────────────────────────────────────
--   ⚠️ 락 가드를 함께 넣을 것 — DROP COLUMN 도 ACCESS EXCLUSIVE 다.
--   ⚠️ 순서: 제약을 먼저 지운다(컬럼을 지우면 제약도 함께 사라지지만, 두 컬럼 중
--      하나만 되돌릴 때 제약이 남아 있으면 그 뒤 INSERT 가 죽는다).
--   SET LOCAL lock_timeout = '3s';
--   ALTER TABLE summary_cycles DROP CONSTRAINT summary_cycles_hidden_reason_ck;
--   ALTER TABLE summary_cycles DROP COLUMN hidden_at;
--   ALTER TABLE summary_cycles DROP COLUMN hidden_reason;
--   -- 롤백하면 숨김이 전부 풀린다 = 8/24 골짜기가 화면에 돌아온다. 코드는 컬럼
--   -- 프로브(column-availability.ts::hiddenCycleColumnsAvailable)로 없는 상태를
--   -- 견디므로 500 은 나지 않는다.
