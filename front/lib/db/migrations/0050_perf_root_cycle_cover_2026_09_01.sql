-- 표준(글로벌) full-cycle 게이트의 heap 스캔 제거용 커버링 인덱스 (2026-09-01)
--
-- ⚠️ **적용 순서 (0045 와 동일 규약)**
--    `IF NOT EXISTS` 든 아니든 `CREATE INDEX` 는 ACCESS EXCLUSIVE 를 잡는다
--    (0045 실측: no-op 인데 797초 대기). 그리고 `db:apply` 는 파일 전체를 하나의
--    트랜잭션으로 감싸므로(scripts/db/apply-migration.ts) `CONCURRENTLY` 를 이
--    파일에 넣을 수 없다.
--    → 프로덕션에는 **아래 문장을 손으로 먼저** 돌린다(트랜잭션 밖, 온라인):
--
--        CREATE INDEX CONCURRENTLY IF NOT EXISTS scope_answers_run_cycle_idx
--          ON public.scope_answers (run_id, prompt_id, region, target, measured_at DESC)
--          INCLUDE (job_id)
--          WHERE status = 'completed';
--        ANALYZE public.scope_answers;
--
--    그 다음 `npm run db:apply -- 0050` 를 돌리면 아래 DO 블록이 카탈로그를 먼저
--    확인하고 **락 없이 통과**한다. (새 환경 구축에서는 DO 블록이 실제로 만든다.)
--
-- ── 왜 (근거) ───────────────────────────────────────────────────────────────
-- `rootFullCycleAnswerIds`(lib/db/repositories/scope-aggregates.ts)는 루트 프로젝트의
-- 답변 전 이력을 훑어 프롬프트별 셀 수를 센다. 그런데 `scope_answers` 는
-- **1,010 MB · 66,244 페이지**다 — `answer_text` 가 평균 2,063 B × 361,497 행을
-- 차지하기 때문이다. 이 집계는 answer_text 를 **한 번도 읽지 않는데도** heap
-- 스캔이라 통째로 끌고 온다.
--
-- 프로덕션 실측 (2026-09-01, EXPLAIN ANALYZE BUFFERS):
--   · 현재 플래너 선택 = Parallel Seq Scan   ~330 ms · shared hit 73,326 (워커 3)
--   · run_id 네스티드 루프 강제(heap 접근 **포함**) 217 ms · shared hit 55,371
--     (그중 55,168 이 heap fetch — 커버링 인덱스가 없애려는 바로 그 부분)
--   · 참고: 같은 테이블의 Index Only Scan 361k 행 = 66 ms vs Bitmap Heap 234 ms
--
-- 즉 네스티드 루프 경로는 heap 을 아직 물고도 이미 더 빠르다. 플래너가 그걸 안
-- 고르는 이유는 추정 비용이 근소하게 뒤지기 때문이고(83,489 vs 77,179), 커버링
-- 인덱스로 inner 를 Index Only 로 만들면 그 차이가 뒤집힌다.
--
-- ⚠️ **효과는 예측이지 실측이 아니다.** 이 세션의 DB 접근은 읽기 전용이라 인덱스를
--    만들어 전후를 잴 수 없었다. 적용 후 반드시 아래로 확인할 것:
--
--      EXPLAIN (ANALYZE, BUFFERS) <rootFullCycleAnswerIds 전개형>;
--      -- 기대: `Index Only Scan using scope_answers_run_cycle_idx`,
--      --       Heap Fetches 가 작고, shared hit 가 225,564 보다 뚜렷이 감소.
--
--    플래너가 여전히 Seq Scan 을 고르면 이 인덱스는 이득이 없다 —
--    되돌리기는 `DROP INDEX CONCURRENTLY scope_answers_run_cycle_idx;` 한 줄이고
--    데이터·판정에는 아무 영향이 없다(읽기 경로만 바뀐다).
--
-- 열 순서 근거:
--   run_id      … 루트 판정은 scope_runs.project_id 경유뿐이다(scope_answers 에
--                 project_id 가 없다). 선두에 두어야 루트 런 4,750개에서
--                 네스티드 루프로 진입할 수 있다.
--   prompt_id, region, target … 게이트 술어(한국어/시장태그 제외)와 셀 그룹핑이
--                 쓰는 열. 키에 두어 인덱스 튜플만으로 필터가 끝난다.
--   measured_at DESC … 셀별 최신 1건 DISTINCT ON 의 정렬 방향.
--   INCLUDE (job_id) … 산출 열. 키에 넣을 이유가 없어 페이로드로만 싣는다.
-- 부분 인덱스(status='completed')는 기존 4종(0045)과 같은 규약이며 크기를 줄인다.
-- 추정 크기 ≈ 28 MB (열 폭 ~79 B × 361,497 행) — 원본 1,010 MB 대비 무시할 만하다.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'scope_answers_run_cycle_idx') THEN
    CREATE INDEX scope_answers_run_cycle_idx
      ON public.scope_answers (run_id, prompt_id, region, target, measured_at DESC)
      INCLUDE (job_id)
      WHERE status = 'completed';
  END IF;
END $$;
