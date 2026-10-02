-- 0064 — 회차 관제 운영 DDL (PR① A1 / T7).
--
-- 두 가지뿐이다:
--   ① `summary_generations.timings jsonb` — 생성 러너(A2/T9)가 표별 소요를 남길 자리
--   ② `summary_ensure_week_partitions(date, date)` — 주 파티션 선생성 **함수**
--
-- 왜 ②가 필요한가 (2026-09-10 실측):
-- 0059 는 1차 롤아웃 4주(08-24 / 08-31 / 09-07 / 09-14)를 **1회성 DO 블록**으로 만들었다.
-- RANGE 파티션은 대상 자식이 없으면 INSERT 가 그냥 **실패한다** — 즉 주가 넘어가는
-- 순간 생성이 죽는다. 그 사이 누군가 손으로 09-21~10-12 를 더 만들어 두어(현재 자식
-- 42개) 당장은 안 죽지만, 손이 멈추면 같은 벼랑이 다시 온다. 그래서 재사용 가능한
-- 함수로 굳히고, 회차 관제(sync 크론 말미, 20분)가 4주 앞까지 밀어 둔다.
--
-- ⚠️ 새 파티션에는 확장 통계가 **없다**. 0062 가 고친 그 병목(웹사이트 KPI 36.1s →
-- 3.9s, Sub-KPI 는 120s 타임아웃 → 2.6s)이 파티션 단위로 되돌아온다. 그래서 이 함수는
-- 파티션을 **하나라도 만들었을 때** `summary_ensure_cycle_gen_stats()` 를 호출한다.
--   · 조건부인 이유: 그 함수는 summary_* 테이블 **전부에 ANALYZE** 를 돈다(현재 60개
--     통계 객체). 20분마다 무조건 돌리면 그 자체가 부하다. 파티션 생성은 주 1회
--     6개뿐이므로, "만들었을 때만" 이 곧 "필요할 때만" 이다.
--
-- ⚠️ 파티션은 부모의 ACL 을 **상속하지 않는다**(0059 말미 REVOKE 블록이 그 이유로 있다).
-- 함수가 만드는 자식에도 같은 자리에서 REVOKE 를 건다 — 나중에 도는 일괄 REVOKE 에
-- 기대면 그 사이에 노출 창이 열린다.
--
-- 규약:
--   · additive-only — 기존 테이블 ALTER 는 컬럼 **추가**뿐(0007 prod 장애 전례).
--   · 멱등 — 재실행이 안전해야 한다(이 리포의 적용 경로는 손으로 도는 db:apply 다).
--   · **`IF NOT EXISTS` 를 믿지 않는다.** `ALTER TABLE … ADD COLUMN IF NOT EXISTS` 는
--     no-op 이어도 ACCESS EXCLUSIVE 를 **먼저 잡는다**(797초 대기·44세션 적체 실증).
--     그래서 카탈로그를 먼저 보고, 진짜 필요할 때만 ALTER 를 낸다.
--   · 한 파일 = 한 트랜잭션(scripts/db/apply-migration.ts).
--
-- 이 파일은 `summary_*` 계열이라 `schema.ts` 에 반영하지 않는다 — 0059·0060·0062·0063
-- 과 같은 자세다(그 표들은 drizzle 스키마 밖의 out-of-band 자산이고, `db:drift` 는
-- "DB 에만 있는 테이블" 로 참고 출력만 낸다). 같은 이유로 `meta/_journal.json` 에도
-- 넣지 않는다(0059~0063 전부 저널에 없다).
SET LOCAL lock_timeout = '3s';

-- ── ① summary_generations.timings ────────────────────────────────────────────
DO $do$
BEGIN
  IF to_regclass('public.summary_generations') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid = 'public.summary_generations'::regclass
         AND attname = 'timings' AND attnum > 0 AND NOT attisdropped
     )
  THEN
    EXECUTE 'ALTER TABLE public.summary_generations ADD COLUMN timings jsonb';
  END IF;
  -- COMMENT 도 표가 있을 때만 — 0059 미적용 환경에서 파일 전체가 죽으면 안 된다.
  IF to_regclass('public.summary_generations') IS NOT NULL THEN
    EXECUTE $c$COMMENT ON COLUMN summary_generations.timings IS '생성 러너의 표별 소요(ms). 예: {"cycle_jobs":1200,"answers":38000}. A2/T9 가 채운다.'$c$;
  END IF;
END
$do$;

-- ── ② summary_ensure_week_partitions(date, date) ─────────────────────────────
CREATE OR REPLACE FUNCTION summary_ensure_week_partitions(p_from date, p_to date)
RETURNS int
LANGUAGE plpgsql AS $fn$
DECLARE
  t       text;
  w       date;
  part    text;
  created int := 0;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RETURN 0;
  END IF;
  -- 상한 — 실수로 넓은 창을 넘겨 수백 개를 만드는 것을 막는다(1년 = 52주).
  IF p_to - p_from > 370 THEN
    RAISE EXCEPTION 'summary_ensure_week_partitions: 창이 너무 넓다 (% ~ %)', p_from, p_to;
  END IF;

  FOREACH t IN ARRAY ARRAY['summary_cycle_jobs','summary_answers','summary_brand_mentions',
                           'summary_domain_citations','summary_target_hits','summary_prompt_dim'] LOOP
    -- 부모가 없는 배포(0059 미적용)에서는 조용히 건너뛴다.
    CONTINUE WHEN to_regclass(format('public.%I', t)) IS NULL;
    -- 주 경계 = UTC 월요일. 인자가 date 라 date_trunc 는 타임존을 타지 않는다
    -- (설계 §2-5 의 `(ts AT TIME ZONE 'UTC')::date` 규약과 같은 값이 된다).
    w := date_trunc('week', p_from::timestamp)::date;
    WHILE w <= p_to LOOP
      part := t || '_' || to_char(w, 'YYYYMMDD');
      IF to_regclass(format('public.%I', part)) IS NULL THEN
        EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                       part, t, w, w + 7);
        -- 파티션은 부모 ACL 을 상속하지 않는다 — 만든 자리에서 바로 닫는다(0059 관례).
        EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, anon, authenticated', part);
        created := created + 1;
      END IF;
      w := w + 7;
    END LOOP;
  END LOOP;

  -- 새 파티션에는 (cycle_id, generation_id) 확장 통계가 없다 → 0062 병목 재발.
  -- 만든 게 있을 때만 재계산한다(그 함수는 summary_* 전부에 ANALYZE 를 돈다).
  IF created > 0 AND to_regprocedure('public.summary_ensure_cycle_gen_stats()') IS NOT NULL THEN
    PERFORM summary_ensure_cycle_gen_stats();
  END IF;

  RETURN created;
END
$fn$;

COMMENT ON FUNCTION summary_ensure_week_partitions(date, date) IS
  '[p_from, p_to] 를 덮는 UTC 월요일 주 파티션을 세부층 6표에 만든다(멱등). 만든 게 있으면 summary_ensure_cycle_gen_stats() 를 호출한다. 회차 관제(sync 크론)가 4주 앞까지 호출한다 — 0064 머리 주석 참조.';

-- 앱 롤 이외 실행 차단 (0059·0062 관례 — DDL 을 내는 함수다).
REVOKE ALL ON FUNCTION summary_ensure_week_partitions(date, date) FROM PUBLIC, anon, authenticated;

-- ── ③ 인덱스 ────────────────────────────────────────────────────────────────
-- 없다. 회차 판정은 2026-09-10 실측으로 **826~1,600 ms**(미귀속 run 26,188 / 165 프로젝트)
-- 이고, 그 안에서 인덱스가 병목이라는 근거가 나오지 않았다.
-- 인덱스를 근거 없이 얹지 않는다 — "성능 수정은 EXPLAIN 근거 없이 배포 금지".
-- 필요해지면 CONCURRENTLY 로 **별도 파일**에서(한 파일 1 tx 안에서는 못 만든다).
