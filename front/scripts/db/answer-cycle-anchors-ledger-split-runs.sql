-- 원장 회차 둘 이상에 걸친 회차의 **회수 대상 run 목록** — 읽기 전용. 쓰기·DDL 이 한 줄도 없다.
--
-- 왜: 0078 이 원장 출처 앵커 선택을 `min()` 에서 "①run 앵커 일치 ②run 수 최다 ③이른
-- 앵커" 로 바꿨다. 이미 0077 의 `min()` 으로 쓰인 회차는 **그 회차의 run 하나**를
-- `refresh_answer_cycle_anchors` 에 넘겨야 다시 쓰인다.
--
-- ⚠️ "그 프로젝트의 run 아무거나" 가 아니다. 확장 seed 는
--    `SELECT DISTINCT project_id, cycle_anchor_at FROM scope_runs WHERE run_id = ANY(...)`
--    이므로 **넘긴 run 이 속한 회차만** 넓어진다. 그래서 이 쿼리가 회차마다 run 을
--    정확히 하나씩 뽑는다.
--
-- 실행 (읽기 전용 보장은 세션에서 건다 — Supavisor 가 startup 파라미터를 버린다):
--   BEGIN; SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = '5min';
--   \i scripts/db/answer-cycle-anchors-ledger-split-runs.sql
--   COMMIT;
--
-- 결과 열:
--   project_id          회차의 프로젝트
--   run_cycle_anchor_at 회차 키(`scope_runs.cycle_anchor_at`)
--   ledger_variants     이 회차의 run 들이 걸친 원장 회차 수 (2 이상)
--   picked_ledger_at    0078 규칙이 고를 원장 앵커
--   picked_anchor_date  그 앵커의 KST 일자 (= 회수 후 `anchor_date` 가 될 값)
--   current_anchor_date 지금 답변 행에 적힌 `anchor_date` (0077 의 min 결과)
--   needs_recovery      두 값이 다른가 (true 인 회차만 회수하면 된다)
--   recover_run_id      **이 회차를 회수할 때 넘길 run 하나**
--   answers             이 회차의 앵커 행 수 (회수 시 다시 쓰일 행 수의 상한)
--
-- 회수 실행 예 (제품 책임자 승인 배치. 회차마다 한 번씩, 또는 run 목록을 한 번에):
--   SELECT refresh_answer_cycle_anchors(ARRAY['<recover_run_id>']::uuid[],
--                                       '<SCOPE_ROOT_PROJECT_ID>'::uuid);
-- 여러 회차를 한 호출로 넘겨도 된다 — 0078 은 배치의 회차를 각각 넓힌다.
-- 회수 뒤 `scripts/db/answer-cycle-anchors-audit.sql` 의 `ledger_anchor_drift` 가 0 이
-- 되는지 확인한다(`cycle_ledger_split` 은 **주의 등급으로 그대로 남는 것이 정상**이다 —
-- 그것은 결함이 아니라 "원장이 갈렸다" 는 규모 지표다).

WITH
-- 0078·dry-run·감사와 **같은 선택 규칙**이다. 정렬 문자열이 네 곳에서 문자 단위로
-- 같아야 하고, 0078 테스트가 그 사본 수를 고정한다.
ledger_pick AS (
  SELECT DISTINCT ON (cycle_key) cycle_key, project_id, run_anchor_at,
         ledger_anchor_at, variants
    FROM (
      SELECT r.project_id::text || '|' ||
               COALESCE(r.cycle_anchor_at::text, 'run:' || r.run_id::text) AS cycle_key,
             r.project_id,
             r.cycle_anchor_at AS run_anchor_at,
             y.cycle_anchor_at AS ledger_anchor_at,
             count(*) AS runs,
             bool_or(y.cycle_anchor_at IS NOT DISTINCT FROM r.cycle_anchor_at) AS matches_run,
             count(*) OVER (PARTITION BY r.project_id::text || '|' ||
                              COALESCE(r.cycle_anchor_at::text, 'run:' || r.run_id::text))
               AS variants
        FROM scope_runs r
        JOIN summary_cycle_runs scr ON scr.run_id = r.run_id
        JOIN summary_cycles     y   ON y.cycle_id = scr.cycle_id
       WHERE r.project_id IS NOT NULL AND y.cycle_anchor_at IS NOT NULL
       GROUP BY 1, 2, 3, 4
    ) g
   WHERE variants > 1
   ORDER BY cycle_key, matches_run DESC, runs DESC, ledger_anchor_at ASC
),
-- 그 회차의 앵커 행에서 현재 값과 회수용 run 하나를 뽑는다.
-- `min(run_id)` 를 쓰지 않는다 — **이 DB 에 `min(uuid)` 집계가 없다**(PostgreSQL 17.6).
-- 대신 `(run_id::text)` 의 min 을 취하고 uuid 로 되돌린다(결정적).
cur AS (
  SELECT r.project_id::text || '|' ||
           COALESCE(r.cycle_anchor_at::text, 'run:' || r.run_id::text) AS cycle_key,
         min(c.anchor_date)              AS anchor_date_min,
         max(c.anchor_date)              AS anchor_date_max,
         min(c.run_id::text)::uuid       AS recover_run_id,
         count(*)                        AS answers
    FROM scope_answer_cycle_anchors c
    JOIN scope_runs r ON r.run_id = c.run_id
   WHERE c.source = 'ledger'
   GROUP BY 1
)
SELECT p.project_id::text                      AS project_id,
       p.run_anchor_at                         AS run_cycle_anchor_at,
       p.variants::int                         AS ledger_variants,
       p.ledger_anchor_at                      AS picked_ledger_at,
       -- ⚠️ 날짜는 **text 로** 낸다. date 를 그대로 내면 클라이언트가 자기 타임존으로
       -- 렌더링해 하루 어긋나 보일 수 있다(이 계열이 이미 겪은 형태다).
       hmg_anchor_date(p.ledger_anchor_at)::text AS picked_anchor_date,
       c.anchor_date_min::text                 AS current_anchor_date,
       (c.anchor_date_min IS DISTINCT FROM hmg_anchor_date(p.ledger_anchor_at)
        OR c.anchor_date_min IS DISTINCT FROM c.anchor_date_max) AS needs_recovery,
       c.recover_run_id::text                  AS recover_run_id,
       c.answers::int                          AS answers
  FROM ledger_pick p
  JOIN cur c ON c.cycle_key = p.cycle_key
 ORDER BY needs_recovery DESC, c.answers DESC, p.run_anchor_at;
