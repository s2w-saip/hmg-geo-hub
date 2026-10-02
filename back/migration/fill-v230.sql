-- ============================================================================
-- 1회 채우기: DB-v2.30(가번호 DB-vNEXT-pick-basis) P148 ing.cycle_ops_gap + P149 rd.cycle_pick_basis 전체 계산.
-- 무엇을: ① 이관 회차(ing.cycle origin = summary_cycles)의 현행 갭 원값·상태를 mig_src.summary_cycles 에서 P148 로(이관 때 status ≠ open 인 회차만,
--   generating 은 그대로 적는다: 원장 투영은 closed 로 접었지만 현행 판정에서 구멍이 아니다). mig_src 가 없으면(새 개발 DB·합성 픽스처) ① 은 건너뛴다.
--   ② rd.refresh_cycle_pick_basis(NULL). ③ 단언: 원장 회차 수 = P149 행 수, 이관 회차의 재계산 함대 가시 = 원장 fleet_visible(현행 값) 불일치 수 보고.
-- 드라이런이 기본: 같은 쓰기를 한 트랜잭션에서 해 보고 개수만 낸 뒤 ROLLBACK(commit=1 이면 COMMIT). 롤 = migrator.
--   psql -X -v ON_ERROR_STOP=1 -f fill-v230.sql
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 -f fill-v230.sql
-- 재구축에도 같은 파일(멱등: P148 은 덮어쓰기, P149 는 바뀐 행만).
-- ============================================================================
\if :{?commit}
\else
  \set commit 0
\endif
SET statement_timeout = '30min';
SET lock_timeout = '30s';
BEGIN;
DO $v$ BEGIN
  IF to_regprocedure('rd.refresh_cycle_pick_basis(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.30 패치가 먼저 적용돼야 한다(rd.refresh_cycle_pick_basis 없음)';
  END IF;
  IF to_regclass('mig_src.summary_cycles') IS NOT NULL THEN
    EXECUTE $q$
      INSERT INTO ing.cycle_ops_gap AS g (cycle_id, analysis_gap_ratio, ops_status)
      SELECT s.cycle_id, s.analysis_gap_ratio, s.status
        FROM mig_src.summary_cycles s JOIN ing.cycle c ON c.cycle_id = s.cycle_id AND c.origin = 'summary_cycles'
       WHERE s.status <> 'open'
      ON CONFLICT (cycle_id) DO UPDATE SET analysis_gap_ratio = EXCLUDED.analysis_gap_ratio, ops_status = EXCLUDED.ops_status
      WHERE (g.analysis_gap_ratio, g.ops_status) IS DISTINCT FROM (EXCLUDED.analysis_gap_ratio, EXCLUDED.ops_status)$q$;
  END IF;
END $v$;
SELECT 'ops_gap' AS step, count(*) AS n, count(*) FILTER (WHERE analysis_gap_ratio IS NULL) AS gap_null FROM ing.cycle_ops_gap;
SELECT 'refresh' AS step, rd.refresh_cycle_pick_basis(NULL) AS n;
DO $v$ BEGIN
  IF (SELECT count(*) FROM rd.cycle_pick_basis) <> (SELECT count(*) FROM ing.cycle) THEN
    RAISE EXCEPTION 'P149 행 수가 원장 회차 수와 다르다';
  END IF;
END $v$;
SELECT 'fleet_vs_ledger' AS step, c.surface, count(*) FILTER (WHERE p.fleet_visible = c.fleet_visible) AS same,
       count(*) FILTER (WHERE p.fleet_visible <> c.fleet_visible) AS diff
  FROM ing.cycle c JOIN rd.cycle_pick_basis p ON p.cyc_key = c.cyc_key
 WHERE c.origin = 'summary_cycles' GROUP BY c.surface ORDER BY c.surface;
\if :commit
COMMIT;
\else
ROLLBACK;
\endif
