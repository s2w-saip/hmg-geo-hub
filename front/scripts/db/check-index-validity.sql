-- 앵커 축 트랙이 만든 인덱스의 **유효성 점검** — 읽기 전용. 쓰기·DDL 이 한 줄도 없다.
--
-- 왜: `CREATE INDEX CONCURRENTLY` 가 실패하면 **INVALID 인덱스가 남는다.** 카탈로그에는
-- 이름이 있으므로 `to_regclass` 선확인을 하는 마이그레이션 DO 블록(0045·0051·0068·0079
-- 공통 규약)은 "이미 있다"로 보고 **조용히 통과한다.** 플래너는 INVALID 인덱스를 쓰지
-- 않으므로 결과는 "적용은 됐는데 성능 수리는 안 된" 상태가 된다.
--
-- 0079 는 이미 프로덕션에 적용됐으므로 본문을 고칠 수 없다(적용된 파일을 고치면 리포와
-- DB 가 갈린다). 그래서 그 점검을 **이 파일**로 분리한다. 0079 머리말이 여기를 가리킨다.
--
-- 실행 (적용 절차의 단계 2 · 그리고 CONCURRENTLY 를 돌린 뒤에는 언제나):
--   BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '1min';
--   \i scripts/db/check-index-validity.sql
--   COMMIT;
--
-- 판정: `severity` 가 하나라도 2 면 그 인덱스를 다시 만든다 —
--   DROP INDEX CONCURRENTLY <이름>;            -- 트랜잭션 **밖**
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS …; -- 0079 머리말의 원문 그대로
--   ANALYZE public.<표>;
--
-- ⚠️ `indisready`/`indislive` 도 함께 본다. CONCURRENTLY 는 3단계(준비 → 빌드 → 유효)
-- 라 중간에 죽으면 `indisvalid=false` 뿐 아니라 `indisready=false` 로도 남을 수 있다.
--
-- 같은 점검이 야간 감사(`answer-cycle-anchors-audit.sql` 의 `invalid_index`)에도 항목
-- 하나로 들어 있다. 이 파일은 **적용 직후 사람이 한 번 보는 용도**이고, 감사는 그것을
-- 매일 되풀이하는 자리다. 대상 집합의 정의는 두 곳이 같아야 한다.

SELECT ic.relname::text                                   AS index_name,
       tc.relname::text                                   AS table_name,
       i.indisvalid,
       i.indisready,
       i.indislive,
       pg_size_pretty(pg_relation_size(i.indexrelid))     AS size,
       CASE WHEN i.indisvalid AND i.indisready AND i.indislive THEN 0 ELSE 2 END AS severity,
       CASE WHEN i.indisvalid AND i.indisready AND i.indislive
              THEN '정상'
            ELSE 'INVALID — DROP INDEX CONCURRENTLY 후 재생성할 것(머리말 참조)'
       END                                                AS note
  FROM pg_index i
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_class tc ON tc.oid = i.indrelid
  JOIN pg_namespace n ON n.oid = ic.relnamespace
 WHERE n.nspname = 'public'
   -- 이 트랙이 만든 인덱스 = 트랙이 만든 표의 인덱스 전부 + 0079 가 기존 표에 붙인 것 하나.
   AND (tc.relname IN ('scope_answer_cycle_anchors',   -- 0077
                       'scope_cycle_rounds',           -- 0077
                       'scope_cycle_anchor_state',     -- 0078
                       'scope_cycle_registry_runs')    -- 0078
        OR ic.relname = 'scope_runs_project_cycle_idx' -- 0079
       )
 ORDER BY severity DESC, tc.relname, ic.relname;
