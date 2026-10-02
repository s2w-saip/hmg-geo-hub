-- ============================================================================
-- 1회 채우기(stg·이미 이관된 DB): DB-v2.19 P107 ing.answer_mirror_time(현행 미러 measured_at 예외). 현행 값 재현 WU-12(제품 결정 19·25).
-- **작성만, 실행은 제품 책임자 승인 배치**(쓰기 = 새 표 INSERT 뿐, stg 실측 예상 166행).
--
-- 무엇을: 현행 미러 사본(mig_src.scope_answers.measured_at) 중 계산식 rd.rep_order_at(원본 ing.answer.measured_at, NULL, 앵커 핀
--   ing.answer_anchor_pin.anchor)으로 재현되지 않는 답변만 그 미러 값을 넣는다(값이 같거나 이미 있는 행은 건너뜀 = 멱등).
--   seed-20-ing.sql §7 과 같은 식이다(새 이관은 시드가 채운다. 이 파일은 시드를 다시 돌리지 않는 이미 적재된 DB 용).
-- 단언(커밋 전, 같은 트랜잭션): 채운 뒤 mig_src 에 있는 모든 답변에서 rd.rep_order_at(원본, 예외, 핀) = 미러 값(NULL 미러 제외) 위반 0.
--   위반이 있으면 예외로 롤백한다.
-- 쓰임: 동결 스냅샷 층(제품 결정 31, card-snapshot-design.md 9장)이 발행 때 카드 셀 대표 정렬 시각 = rd.rep_order_at(원본, 예외, 핀)으로 쓴다.
--   rd.answer.is_rep 에는 쓰지 않는다(is_rep = 답변분석 경로 규칙, 원본 시각: 현행 프로필 rep_round_date_cell, fill-v219-rep.sql).
-- 전제: DB-v2.19 적용, mig_src(이관 원본 스테이지) 존재. 롤 = migrator(ing.answer_mirror_time INSERT 권한, mig_src·ing 읽기).
-- 락: 새 표 INSERT 뿐(ing.answer·ing.answer_anchor_pin 은 읽기).
--
-- 첫 SELECT = 분해(읽기): mirror_differs(미러 ≠ 원본) = by_pin_fold(핀 접기로 재현) + 예외 쪽, outside_pins(핀 없는 차이 = 예외로 들어간다),
--   exceptions(넣을 대상), mirror_null(미러 NULL·원본 있음: 넣지 않는다), already(이미 있는 행).
-- 사용(드라이런이 기본: 넣을 행 수·미러 차이 분해만 센다, 쓰기 없음):
--   psql -X -v ON_ERROR_STOP=1 -f fill-v219.sql
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 -f fill-v219.sql
-- 출력 = 개수만(답변 키·본문 없음).
-- ============================================================================
\if :{?commit}
\else
  \set commit 0
\endif
SET statement_timeout = 0;
SET lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('ing.answer_mirror_time') IS NULL OR to_regprocedure('rd.rep_order_at(timestamptz, timestamptz, date)') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.19 가 먼저 적용돼야 한다(ing.answer_mirror_time·rd.rep_order_at 없음)';
  END IF;
  IF to_regclass('mig_src.scope_answers') IS NULL THEN
    RAISE EXCEPTION 'mig_src.scope_answers(현행 미러 사본) 없음';
  END IF;
END $v$;

SELECT count(*) FILTER (WHERE m.measured_at IS DISTINCT FROM a.measured_at) AS mirror_differs,
       count(*) FILTER (WHERE m.measured_at IS DISTINCT FROM a.measured_at AND p.job_id IS NOT NULL
                          AND rd.rep_order_at(a.measured_at, NULL, p.anchor) IS NOT DISTINCT FROM m.measured_at) AS by_pin_fold,
       count(*) FILTER (WHERE m.measured_at IS DISTINCT FROM a.measured_at AND p.job_id IS NULL) AS outside_pins,
       count(*) FILTER (WHERE m.measured_at IS NOT NULL
                          AND rd.rep_order_at(a.measured_at, NULL, p.anchor) IS DISTINCT FROM m.measured_at) AS exceptions,
       count(*) FILTER (WHERE m.measured_at IS NULL AND a.measured_at IS NOT NULL) AS mirror_null,
       (SELECT count(*) FROM ing.answer_mirror_time) AS already
  FROM ing.answer a
  JOIN mig_src.scope_answers m ON m.job_id = a.job_id
  LEFT JOIN ing.answer_anchor_pin p ON p.job_id = a.job_id;

\if :commit
BEGIN;
INSERT INTO ing.answer_mirror_time (job_id, measured_at, origin)
SELECT a.job_id, m.measured_at, 'fill'
  FROM ing.answer a
  JOIN mig_src.scope_answers m ON m.job_id = a.job_id
  LEFT JOIN ing.answer_anchor_pin p ON p.job_id = a.job_id
 WHERE m.measured_at IS NOT NULL
   AND rd.rep_order_at(a.measured_at, NULL, p.anchor) IS DISTINCT FROM m.measured_at
ON CONFLICT (job_id) DO NOTHING;
DO $a$
DECLARE bad bigint;
BEGIN
  SELECT count(*) INTO bad
    FROM ing.answer a
    JOIN mig_src.scope_answers m ON m.job_id = a.job_id
    LEFT JOIN ing.answer_mirror_time t ON t.job_id = a.job_id
    LEFT JOIN ing.answer_anchor_pin p ON p.job_id = a.job_id
   WHERE m.measured_at IS NOT NULL AND rd.rep_order_at(a.measured_at, t.measured_at, p.anchor) IS DISTINCT FROM m.measured_at;
  IF bad <> 0 THEN
    RAISE EXCEPTION 'fill-v219 단언 실패: 정렬 시각 ≠ 미러 값 % 건', bad;
  END IF;
END $a$;
COMMIT;
SELECT count(*) AS mirror_time_rows, count(*) FILTER (WHERE origin = 'fill') AS filled FROM ing.answer_mirror_time;
\else
\echo '드라이런: 쓰기 없음. 실행은 -v commit=1'
\endif
