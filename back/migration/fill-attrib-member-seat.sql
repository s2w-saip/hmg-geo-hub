-- ============================================================================
-- 1회 채우기(stg·이미 적재된 DB): 현행 프로필 resub_phantom_exclude(RESUB, WU-3b) 1단계 = 원장 이관 회차의 현행 좌석 이관.
-- 새 DB 는 seed-20 -v attrib_member=1 이 같은 값을 넣는다(§7-3). 현행 재현 되돌림(제품 결정 19·25).
-- **작성만, 실행은 제품 책임자 승인 배치**(ing.cycle 쓰기. stg hmg_r2 2026-10-01 읽기 전용 실측: 대상 30행 = 웹 원장 08-01·08-02 회차 24개(좌석
--   08-01·08-02 → 07-24) + 재제출 유령 회차 6개(09-17 → 09-18). 그 회차들에 지금 투영된 rd 답변은 0건(hub 규칙이 다른 회차에 넣었다)).
--
-- 무엇을
--   현행 좌석 = 앵커 표(mig_src.scope_answer_cycle_anchors)에서 그 회차(cycle_id) 답변의 최소 round_date(현행 사실표 경로의 회차 자리:
--   hmg-geo 2670a16 lib/period/anchor-axis.ts:254-266 → summary-cycles.ts:166, 앵커 행이 없으면 앵커 KST 일자 = hub 값과 같음).
--   원장 이관 회차(origin 'summary_cycles') 중 그 값이 ing.cycle.round_date 와 다른 행만 바꾼다. rd 는 건드리지 않는다:
--   rd.cycle 좌석·답변 귀속은 2단계 reproject-attrib-member.py(적재기 경로, 트랜잭션 1개)가 바꾼다. 두 단계 사이에는 적재 워커를 멈춰 둔다
--   (1단계 뒤 rd.cycle 은 옛 좌석이지만 그 회차의 rd 답변이 0건이라 화면 값은 그대로다. 워커가 먼저 돌면 그 회차를 재평가할 때 좌석이
--   rd.cycle 로 투영되고 스위치가 꺼진 워커면 그 회차는 빈 채로 옮겨진다: 값 변화 없음, 2단계가 이어받는다).
-- 멱등: 다시 돌리면 0행. 되돌리기(스위치를 끌 때) = revert=1: 좌석 원장 매핑(ing.cycle_round, 없으면 anchor_date)으로 되돌린다.
-- 락: ing.cycle 대상 행 ROW EXCLUSIVE(행 잠금만, 30행). 소요 = 앵커 표 집계 1회(stg 약 70만 행, 수 초).
-- 롤: migrator(mig_src SELECT·ing.cycle UPDATE). loader 롤은 mig_src 권한이 없다.
--
-- 사용(드라이런이 기본: 대상 행 수·좌석 쌍만 센다, 쓰기 없음):
--   psql -X -v ON_ERROR_STOP=1 -f fill-attrib-member-seat.sql
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 -v expect=30 -f fill-attrib-member-seat.sql     (expect = 드라이런 대상 수, 다르면 롤백)
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 -v revert=1 -v expect=N -f fill-attrib-member-seat.sql
-- 출력 = 개수·회차 키·날짜만.
-- ============================================================================
\if :{?commit}
\else
  \set commit 0
\endif
\if :{?revert}
\else
  \set revert 0
\endif
\if :{?expect}
\else
  \set expect -1
\endif
SET statement_timeout = '600s';
SET lock_timeout = '10s';
SELECT set_config('fill.revert', :'revert', false) AS revert, set_config('fill.expect', :'expect', false) AS expect;

BEGIN;
DO $v$ BEGIN
  IF current_setting('fill.revert') = '0' AND to_regclass('mig_src.scope_answer_cycle_anchors') IS NULL THEN
    RAISE EXCEPTION 'mig_src.scope_answer_cycle_anchors 없음: 현행 좌석 원천이 없다(새 DB 는 seed-20 -v attrib_member=1)';
  END IF;
END $v$;

\if :revert
CREATE TEMP TABLE _seat ON COMMIT DROP AS
SELECT c.cycle_id, c.cyc_key, c.surface, c.round_date AS old_rd,
       coalesce(r.round_date, c.anchor_date) AS new_rd
  FROM ing.cycle c
  LEFT JOIN ing.cycle_round r ON r.scope_project_id = c.scope_project_id AND r.anchor_date = c.anchor_date
 WHERE c.origin = 'summary_cycles' AND c.round_date IS DISTINCT FROM coalesce(r.round_date, c.anchor_date);
\else
-- 앵커 표 집계 1회(cycle_id 별 최소 round_date, 행 단위 상관 서브쿼리 없음: mig_src 에 cycle_id 인덱스가 없을 수 있다)
CREATE TEMP TABLE _seat ON COMMIT DROP AS
WITH x AS (SELECT cycle_id, min(round_date) AS rd FROM mig_src.scope_answer_cycle_anchors WHERE cycle_id IS NOT NULL GROUP BY cycle_id)
SELECT c.cycle_id, c.cyc_key, c.surface, c.round_date AS old_rd, x.rd AS new_rd
  FROM ing.cycle c JOIN x ON x.cycle_id = c.cycle_id
 WHERE c.origin = 'summary_cycles' AND c.round_date IS DISTINCT FROM x.rd;
\endif

SELECT 'targets' AS k, count(*) AS n FROM _seat;
SELECT 'pair' AS k, surface, old_rd, new_rd, count(*) AS cycles, min(cyc_key) AS min_key, max(cyc_key) AS max_key
  FROM _seat GROUP BY surface, old_rd, new_rd ORDER BY surface, old_rd;
-- 지금 그 회차에 투영된 rd 답변(1단계 뒤 2단계가 좌석과 함께 옮긴다. stg 실측 0)
SELECT 'rd_answers_in_targets' AS k, count(*) AS n FROM rd.answer a WHERE a.cyc_key IN (SELECT cyc_key FROM _seat);

\if :commit
UPDATE ing.cycle c SET round_date = s.new_rd, updated_at = now() FROM _seat s WHERE s.cycle_id = c.cycle_id;
DO $a$ DECLARE n bigint; e bigint := current_setting('fill.expect')::bigint; BEGIN
  SELECT count(*) INTO n FROM _seat;
  IF e >= 0 AND n <> e THEN RAISE EXCEPTION '대상 % 행 ≠ expect %: 롤백', n, e; END IF;
  IF EXISTS (SELECT 1 FROM ing.cycle c JOIN _seat s ON s.cycle_id = c.cycle_id WHERE c.round_date IS DISTINCT FROM s.new_rd) THEN
    RAISE EXCEPTION '좌석 갱신 누락: 롤백';
  END IF;
  RAISE NOTICE '좌석 이관 % 행', n;
END $a$;
COMMIT;
\else
ROLLBACK;
\endif
