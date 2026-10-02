-- 0079: `scope_runs (project_id, cycle_anchor_at)` 복합 인덱스. **값은 바뀌지 않는다**(인덱스만).
--
-- ⚠️⚠️ 적용 절차 (0045·0050·0051·0068 과 **동일 규약** — 이 파일만 db:apply 하면 락에 걸린다)
--   ⚠️ 락 등급 정정(2026-09-20 재검증 N5): 비CONCURRENT `CREATE INDEX` 는 대상 표에
--   **SHARE** 락을 잡는다(읽기는 허용, **쓰기를 막는다**). ACCESS EXCLUSIVE 는
--   `ALTER TABLE`·`DROP INDEX`·`REINDEX` 쪽이다. 초판 주석의 "ACCESS EXCLUSIVE" 는
--   틀렸다 — 다만 **운영 지시는 어느 쪽이든 같다**: SHARE 도 그 표의 쓰기를 전부 막고,
--   `IF NOT EXISTS` 는 no-op 이어도 그 락을 먼저 요청한다(0045 실측: 797초 대기).
--   미러 싱크가 `scope_runs` 에 계속 쓰므로 인덱스 생성은 반드시 CONCURRENTLY 다.
--   그리고 `db:apply` 는 파일 전체를 한 트랜잭션으로 감싸므로
--   (scripts/db/apply-migration.ts:52 `sql.begin` + `tx.unsafe(body)`)
--   `CONCURRENTLY` 를 이 파일에 넣을 수 없다(트랜잭션 블록 안에서 금지된다).
--   → 프로덕션에는 **아래 문장을 손으로, 트랜잭션 밖에서** 먼저 돌린다:
--
--       CREATE INDEX CONCURRENTLY IF NOT EXISTS scope_runs_project_cycle_idx
--         ON public.scope_runs (project_id, cycle_anchor_at);
--
--       -- 통계. **필수** — 새 인덱스는 통계 없이 태어난다.
--       ANALYZE public.scope_runs;
--
--   그 다음 `npm run db:apply -- 0079` 를 돌리면 아래 DO 블록이 카탈로그를 **먼저 확인**하고
--   락을 **아예 요청하지 않고** 통과한다. (새 환경 구축에서는 DO 블록이 실제로 만든다 —
--   그때는 표가 비어 있어 락이 무료다.)
--
--   ⚠️ `CREATE INDEX CONCURRENTLY` 가 실패하면 **INVALID 인덱스가 남는다.** 그러면
--      `DROP INDEX CONCURRENTLY scope_runs_project_cycle_idx;` 로 지우고 다시 만든다.
--      아래 DO 블록은 `to_regclass` 로만 존재를 보므로 INVALID 도 "있다"로 본다 —
--      즉 **이 파일은 그 상태를 막지 못한다.** 기계 점검은 두 곳으로 분리했다
--      (이 파일은 이미 적용돼 본문을 고칠 수 없다 — 2026-09-20 재검증 N3):
--        · 적용 직후 1회:  scripts/db/check-index-validity.sql   (읽기 전용)
--        · 매일:           scripts/db/answer-cycle-anchors-audit.sql 의 `invalid_index`
--                          항목(severity 2)
--      한 줄로 보려면:
--        SELECT indisvalid, indisready, indislive FROM pg_index
--         WHERE indexrelid = 'public.scope_runs_project_cycle_idx'::regclass;
--
-- ── 왜 (근거) ───────────────────────────────────────────────────────────────
-- 회차 확장·회차 run 집합 조회의 **유일한 진입 경로**가 이 두 컬럼 조인이다:
--
--   JOIN scope_runs r ON r.project_id = c.project_id AND r.cycle_anchor_at = c.cycle_anchor_at
--
-- 0077 의 `expanded` CTE 와 0078 의 `cyc_runs`·확장 seed 가 전부 같은 형태다.
-- 그런데 `scope_runs` 의 인덱스는 PK `(run_id)` 와 `scope_runs_project_idx (project_id)`
-- 둘뿐이고(0020 · schema.ts), `cycle_anchor_at` 에는 어떤 인덱스도 없다
-- (0058 은 컬럼만 추가했다). 그래서 **매 호출 그 프로젝트의 run 전부**를 훑은 뒤
-- `cycle_anchor_at` 으로 걸러낸다.
--
-- 0078 이 회차 **답변 수**(최대 56,383) 비례 항을 없앴지만, 이 조인의 프로젝트 run 수
-- 비례 항은 그대로 남는다. 글로벌 루트 프로젝트는 run 누적이 가장 큰 프로젝트이고
-- 드레인 중 run 1,304개가 차례로 들어오므로, 이 인덱스가 그 마지막 비례 항을 끊는다.
--
-- ⚠️ **EXPLAIN 미측정.** 0051·0068 은 프로덕션 EXPLAIN ANALYZE 수치를 근거로 달았지만
-- 이 인덱스는 DB 접속이 막힌 상태에서 설계됐다. 적용 전에 아래를 돌려 "그 프로젝트 run
-- 수 - 회차 run 수" 만큼의 `Rows Removed by Filter` 가 실제로 나오는지 확인할 것:
--
--   EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
--   SELECT count(*) FROM scope_runs r
--    WHERE r.project_id = :'PROJ' AND r.cycle_anchor_at = :'ANCHOR';
--
-- 크기 전망: `scope_runs` 는 28,078행 규모라 인덱스는 1~2 MB 수준이다(실측 아님).
--
-- ── additive-only ───────────────────────────────────────────────────────────
-- 인덱스 하나뿐이다. 기존 인덱스를 지우지 않는다 — `scope_runs_project_idx
-- (project_id)` 는 `project_id` 단독 조회가 따로 있으므로 그대로 둔다(이 복합 인덱스가
-- 접두사로 대체할 수 있지만, 지우는 것은 되돌리기 비싼 변경이라 이 판의 범위 밖이다).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

DO $idx$
BEGIN
  IF to_regclass('public.scope_runs') IS NULL THEN
    RAISE NOTICE '0079 건너뜀: scope_runs 가 아직 없다(신규 환경). scripts/db/scope-mirror.sql 선행.';
    RETURN;
  END IF;
  -- 카탈로그 선확인 — 이미 있으면 `CREATE INDEX IF NOT EXISTS` 조차 부르지 않는다
  -- (`IF NOT EXISTS` 는 no-op 이어도 ACCESS EXCLUSIVE 를 먼저 잡는다).
  IF to_regclass('public.scope_runs_project_cycle_idx') IS NULL THEN
    CREATE INDEX scope_runs_project_cycle_idx
      ON public.scope_runs (project_id, cycle_anchor_at);
  END IF;
END
$idx$;
