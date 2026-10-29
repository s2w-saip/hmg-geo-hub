-- 카탈로그 조인 키 `prompts.scope_prompt_id` 인덱스 (2026-09-01)
--
-- ⚠️ **적용 순서 (0045·0049 와 동일 규약)**
--    `CREATE INDEX` 는 `IF NOT EXISTS` 여도 ACCESS EXCLUSIVE 를 먼저 잡고(0045
--    실측: no-op 인데 797초 대기), `db:apply` 는 파일 전체를 한 트랜잭션으로
--    감싸므로 `CONCURRENTLY` 를 이 파일에 넣을 수 없다.
--    → 프로덕션에는 **아래 문장을 손으로 먼저** 돌린다(트랜잭션 밖, 온라인):
--
--        CREATE INDEX CONCURRENTLY IF NOT EXISTS prompts_scope_prompt_id_idx
--          ON public.prompts (scope_prompt_id) INCLUDE (funnel_stage);
--
--    그 다음 `npm run db:apply -- 0050` 을 돌리면 아래 DO 블록이 카탈로그를 먼저
--    확인하고 **락 없이 통과**한다. (새 환경 구축에서는 DO 블록이 실제로 만든다.)
--    2026-09-01 프로덕션 선적용 완료 — 소요 1,642 ms.
--
-- ── 왜 (근거) ───────────────────────────────────────────────────────────────
-- `prompts` 는 14,870행 6 MB 로 작지만, **조인 키에 인덱스가 하나도 없었다**
-- (기존: pkey(id) · project_idx(project_id) · project_brand_presence_idx).
-- 그래서 `scope_prompt_id` 로 찾는 두 경로가 각각 파국적인 플랜을 골랐다
-- (프로덕션 EXPLAIN ANALYZE, admin 무필터, 2026-09-01):
--
-- ① aggregatePromptTopicFromMirror — 상관 스칼라 서브쿼리
--      (SELECT p.funnel_stage FROM prompts p WHERE p.scope_prompt_id = a.prompt_id …)
--    가 프롬프트 그룹 11,302개마다 `prompts` 를 Seq Scan 했다.
--      Buffers: shared hit **5,097,020**  →  18,233 ms
--    인덱스 적용 후 **694 ms** (26배). 산출 동일(3행).
--
-- ② latestMeasureDays — `a.prompt_id IN (SELECT scope_prompt_id FROM prompts …)`
--    가 `LIMIT 2` 때문에 Nested Loop Semi Join + Materialize 로 풀렸고, 인덱스가
--    없어 Join Filter 전수 비교가 됐다.
--      Rows Removed by Join Filter: **332,120,490**  →  47,097 ms
--    인덱스 적용 후 **348 ms** (135배). 이 호출은 콜드 로드에서 2회 발생한다.
--    (코드 쪽에도 `OFFSET 0` 배리어를 함께 넣어 인덱스 없이도 333 ms 가 되게
--     이중화했다 — scope-aggregates.ts::latestMeasureDays 주석 참조.)
--
-- INCLUDE (funnel_stage) 는 ①을 index-only 로 만들기 위한 것이다.
-- `scope_prompt_id` 는 UNIQUE 가 아니다(13,437 non-null / 13,157 distinct,
-- 중복 248건) — 그래서 UNIQUE 제약이 아니라 평범한 btree 다.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'prompts_scope_prompt_id_idx') THEN
    CREATE INDEX prompts_scope_prompt_id_idx
      ON public.prompts (scope_prompt_id) INCLUDE (funnel_stage);
  END IF;
END $$;
