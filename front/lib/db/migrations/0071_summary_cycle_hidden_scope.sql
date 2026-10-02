-- 0071 — 회차 숨김의 **범위**(0070 의 후속).
--
-- 배경(2026-09-11 제품 책임자): "8/24 인용만 누락된거라 멘션에 대한 부분은 살려줘야해."
-- 0070 은 글로벌 8/25 앵커 회차(cycle_week 2026-08-24 · cycle_id 1045851c-e47d-4977-bda1-550c56d74705)
-- 를 **통째로** 내렸는데, 읽기 전용 실측(2026-09-11)은 깨진 칸이 **하나뿐**이라고 말한다.
--
--   회차 8/25 · status completed 답변 기준 (scope_answers)
--     chatgpt  5,446 답변 중 인용 있는 답변 **209 = 3.8%**   ← 여기만 깨졌다
--     gemini   4,890 답변 중 인용 있는 답변 3,576 = **73.1%** (정상)
--     chatgpt  언급 있는 답변 4,565 = **83.8%** (정상)
--     gemini   언급 있는 답변 4,572 = **93.5%** (정상)
--   이웃 회차(8/18)의 인용률은 chatgpt 80.0% · gemini 71.5% 다. 9개 지역이 균일하게
--   깨졌으므로(US 1.0% · KR 3.6% · CA 1.2%) 지역·프롬프트 편중이 아니라 **엔진 단위
--   수집 실패**이고, 언급 계열 KPI(노출률 65.6% · 점유율 27.6% · 우호도 52.3%)는
--   이웃 주 밴드(68.2~77.9% / 27.2~33.9% / 51.0~58.0%) 안이다.
--
-- 그래서 숨김을 **계열(family)** 로 좁힌다: 인용 계열만 내리고 언급 계열은 값을 낸다.
--
-- 왜 컬럼 하나(`hidden_scope`)인가 — 기각한 대안:
--   · `hidden_metrics text[]` : 어휘가 안 닫힌다(오타·중복·순서). CHECK 가 약해지고
--     모든 리더가 배열 포함 판정을 하게 된다. 계열이 셋 이상 생기면 그때 승격.
--   · `hidden_reason` 어휘 확장(`collection_error_citations`) : 사유(왜)와 범위(무엇을)를
--     한 칸에 섞는다. `operator × citations` 가 필요해지면 곱집합으로 터진다.
--   · 회차×계열 별도 표 : 870행짜리 원장에 조인 하나를 더한다. 계열 2개인 지금 이득 0.
--
-- 왜 `NOT NULL DEFAULT 'all'` 이 아닌가: 0070 이 "NULL = 숨기지 않음" 을 이 표의 진실로
--   못 박았다. 같은 표에서 한 칸만 반대 자세를 쓰면 읽는 사람이 헷갈린다. 그리고 NULL
--   허용이 **0071 미적용 코드/DB 교차 배포**에서 자동으로 오늘 동작(= 회차 전체 숨김)이 된다.
--
-- 규약 (0070 과 동일):
--   · additive-only — 기존 테이블 ALTER 는 컬럼 **추가**뿐(0007 prod 장애 전례).
--   · 멱등 — **`ADD COLUMN IF NOT EXISTS` 를 쓰지 않는다**: no-op 이어도 ACCESS EXCLUSIVE 를
--     **먼저 잡는다**(797초 대기·44세션 적체 실증) → 카탈로그 선확인.
--   · 한 파일 = 한 트랜잭션(scripts/db/apply-migration.ts) → `CONCURRENTLY` 불가.
--   · `summary_*` 계열이라 `schema.ts`·`meta/_journal.json` 에 넣지 않는다(0059~0070 과 같은 자세).
--
-- 락·소요: `summary_cycles` 는 파티션이 아닌 단일 표이고 **실측 870행**이다(2026-09-11
--   읽기 전용 대조. 0070 헤더의 "96행" 은 2026-09-10 시점 값이라 이미 낡았다 — 함대가
--   늘면서 website 회차가 불어났다). `ADD COLUMN <type>`(DEFAULT 없음)은 PG 11+ 에서
--   메타데이터 전용이라 표를 다시 쓰지 않는다 — 행 수와 무관하게 밀리초다.
--   `lock_timeout='3s'` 가 대기 상한을 준다.
--   ⚠️ ACCESS EXCLUSIVE 는 읽기까지 막는다 — 관제·생성 러너가 도는 중이면 그동안
--      대기하고, 못 잡으면 파일 전체가 깨끗이 중단된다(재시도 가능).
--
-- ⚠️ CHECK 을 NOT VALID 로 붙이지 않는다. 기존 870행은 방금 추가한 컬럼이 전부 NULL 이라
--    CHECK 의 첫 항(`hidden_scope IS NULL`)으로 즉시 참이다 — 검증 스캔이 있어도 870행이고,
--    같은 tx 에서 이미 ACCESS EXCLUSIVE 를 쥔 상태다(0070 과 같은 근거).
--
-- 적용 후 절차: 이 파일만으로는 **아무 회차의 범위도 바뀌지 않는다**(전 행 NULL = 'all').
--   범위는 운영자 스크립트로 한 행씩 찍는다 —
--     bash notes/hmg-db-exec.sh <워크트리> npx tsx --tsconfig scripts/summary/tsconfig.json \
--       scripts/summary/hide-cycle.ts <cycle_id> --reason=collection_error --scope=citations --yes
--   (`--yes` 가 없으면 dry-run. 같은 사유·같은 회차면 `hidden_at` 은 **보존**된다.)

SET LOCAL lock_timeout = '3s';

-- ── ⓪ 트랜잭션 블록 가드 (0065~0070 과 동일) ────────────────────────────────
-- `SET LOCAL` 은 tx 밖에서 WARNING(25P01) 만 내고 값이 0(무제한)으로 남는다(실측).
-- 그 상태로 ACCESS EXCLUSIVE 를 걸면 무한 대기다.
DO $do$
BEGIN
  IF current_setting('lock_timeout') <> '3s' THEN
    RAISE EXCEPTION '0071: 트랜잭션 블록 밖에서 적용 중이다(lock_timeout=%) — npm run db:apply 를 쓸 것', current_setting('lock_timeout');
  END IF;
END
$do$;

-- ── ① summary_cycles.hidden_scope ────────────────────────────────────────────
-- 범위는 **숨긴 회차에만** 존재한다(0070 의 사유·시각 쌍과 같은 자세의 불변식).
DO $do$
BEGIN
  IF to_regclass('public.summary_cycles') IS NULL THEN
    RAISE EXCEPTION '0071: summary_cycles 가 없다 — 0059 를 먼저 적용할 것';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.summary_cycles'::regclass
      AND attname = 'hidden_reason' AND attnum > 0 AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '0071: hidden_reason 이 없다 — 0070 을 먼저 적용할 것';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.summary_cycles'::regclass
      AND attname = 'hidden_scope' AND attnum > 0 AND NOT attisdropped
  ) THEN
    -- DEFAULT 를 붙이지 않는다 — NULL 이 'all' 이고, 그것이 기존 870행의 진실이다.
    EXECUTE 'ALTER TABLE public.summary_cycles ADD COLUMN hidden_scope text';
  END IF;

  -- 어휘 + "범위는 숨긴 회차에만 존재한다" 불변식.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.summary_cycles'::regclass
      AND conname = 'summary_cycles_hidden_scope_ck'
  ) THEN
    EXECUTE $c$
      ALTER TABLE public.summary_cycles
        ADD CONSTRAINT summary_cycles_hidden_scope_ck CHECK (
          hidden_scope IS NULL
          OR (hidden_reason IS NOT NULL AND hidden_scope IN ('all','citations'))
        )
    $c$;
  END IF;
END
$do$;

COMMENT ON COLUMN summary_cycles.hidden_scope IS
  '숨김 **범위**(계열). NULL = all(기본 — 0070 의 종전 동작). all = 회차 전체를 숨긴다. citations = 인용 계열만 숨긴다(인용 화면 추이·인용 점유율·인용 도메인/카테고리·인용 정확도) — 언급 계열(노출률·점유율·우호도·우선 노출도·브랜드 언급 추이·ACR)은 값을 그대로 낸다. 판정 정본: lib/db/repositories/scope-aggregates.ts::excludeHiddenCycleRuns(family) 와 lib/summary/read/trend-gaps.ts. 리더는 COALESCE(hidden_scope, ''all'') 로 읽는다. 회차 **집합** 판정(cycle-set.ts skipped · pickGlobalCycle)은 범위와 무관하게 전부 제외한다 — 회차는 7 KPI 를 한 덩어리로 싣는 그레인이라 반쪽만 넣을 수 없다.';

-- ── ② 관제·생성기·스왑은 이 컬럼을 건드리지 않는다 ──────────────────────────
-- 0070 과 같은 불변식이다. `summary_cycles` 에 쓰는 문장은 전부 컬럼을 명시하고
-- (`SELECT *`·무열거 INSERT 가 하나도 없다), 그 사실은 소스 대조 테스트가 고정한다
-- (lib/db/schema.migration-0070.test.ts · lib/db/schema.migration-0071.test.ts).

-- ── ③ ACL ────────────────────────────────────────────────────────────────────
-- 새 표·함수를 만들지 않았지만(컬럼 1개), 0059·0064~0070 관례대로 한 번 더 닫는다.
DO $do$
BEGIN
  EXECUTE 'REVOKE ALL ON public.summary_cycles FROM PUBLIC, anon, authenticated';
END
$do$;

-- ── 롤백 (참고 — 실행하려면 별도 파일로) ──────────────────────────────────────
--   ⚠️ 락 가드를 함께 넣을 것 — DROP COLUMN 도 ACCESS EXCLUSIVE 다.
--   ⚠️ 제약을 먼저 지운다(0070 롤백 주석과 같은 이유).
--   SET LOCAL lock_timeout = '3s';
--   ALTER TABLE summary_cycles DROP CONSTRAINT summary_cycles_hidden_scope_ck;
--   ALTER TABLE summary_cycles DROP COLUMN hidden_scope;
--   -- 롤백하면 8/25 가 다시 **회차 전체 숨김**으로 돌아간다(= 0071 이전 화면).
--   -- 코드는 컬럼 프로브(column-availability.ts::hiddenCycleScopeAvailable)로 없는
--   -- 상태를 견디므로 42703·500 은 나지 않는다.
