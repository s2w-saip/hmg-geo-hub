-- /sources 유형 플래그 답변 열(DB-v2.18 P105 rd.answer.t_own) 동치 시험(test_t_own_path.py) 준비·독립 기대값(고객 데이터 아님).
-- tests.support.staged 로 소유자가 실행하고 블록 끝에 ROLLBACK. '-- name: x' 로 나눠 load_named_sql 로 읽는다.

-- name: fill
-- 준비가 직접 넣은 답변(적재기 밖)까지 t_own 을 정본 재계산으로 채운다 = 적재기 재투영과 같은 값
SELECT rd.fill_answer_t_own(coalesce((SELECT array_agg(answer_key) FROM rd.job WHERE served), '{}'::int4[]));

-- name: rep_typed
-- cell_rep 프로필에서도 유형 값이 비지 않게: 유형 신호가 있는 글로벌 답변을 셀 대표로(자식 사본까지 같이). 두 경로가 같은 행을 읽으므로
-- 셀당 대표 1개 규칙(rd.assert_rep)은 이 시험의 대상이 아니다
UPDATE rd.answer SET is_rep = true WHERE surface = 1 AND t_own <> 0 AND NOT is_rep;
UPDATE rd.answer_brand c SET is_rep = a.is_rep FROM rd.answer a
 WHERE a.surface = c.surface AND a.round_date = c.round_date AND a.answer_key = c.answer_key AND c.is_rep IS DISTINCT FROM a.is_rep;
UPDATE rd.answer_stance c SET is_rep = a.is_rep FROM rd.answer a
 WHERE a.surface = c.surface AND a.round_date = c.round_date AND a.answer_key = c.answer_key AND c.is_rep IS DISTINCT FROM a.is_rep;
UPDATE rd.citation c SET is_rep = a.is_rep FROM rd.answer a
 WHERE a.surface = c.surface AND a.round_date = c.round_date AND a.answer_key = c.answer_key AND c.is_rep IS DISTINCT FROM a.is_rep;

-- name: unfill
-- 미채움 폴백: 유형 신호가 있는 글로벌 답변 3건의 t_own 을 NULL 로(DB-v2.18 채우기 전 행)
UPDATE rd.answer a SET t_own = NULL
  FROM (SELECT answer_key FROM rd.answer WHERE surface = 1 AND t_own <> 0 ORDER BY answer_key LIMIT 3) x
 WHERE a.answer_key = x.answer_key;

-- name: served_null
SELECT count(*) AS n FROM rd.job j
  JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
 WHERE j.served AND a.t_own IS NULL;

-- name: all_null
SELECT count(*) AS n FROM rd.answer WHERE t_own IS NULL;

-- name: expect
-- 독립 기대값: rd.t_own_bits 를 쓰지 않는 식(곱셈·덧셈)으로 자식 행에서 센 마스크
SELECT j.answer_key, coalesce(bit_or(
         ((CASE WHEN b.t_mention > 0 THEN 1 ELSE 0 END) + (CASE WHEN b.t_recommendation > 0 THEN 2 ELSE 0 END)
          + (CASE WHEN b.t_comparison > 0 THEN 4 ELSE 0 END) + (CASE WHEN b.t_definition > 0 THEN 8 ELSE 0 END)
          + (CASE WHEN b.t_final_choice > 0 THEN 16 ELSE 0 END))
         * (CASE b.own_bit WHEN 1 THEN 1 WHEN 2 THEN 32 WHEN 4 THEN 1024 ELSE 0 END)), 0) AS want, a.t_own
  FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
  LEFT JOIN rd.answer_brand b ON b.surface = j.surface AND b.round_date = j.round_date AND b.answer_key = j.answer_key
 WHERE j.served GROUP BY j.answer_key, a.t_own;

-- name: assert_all
SELECT rd.assert_answer_t_own(NULL) AS n;

-- name: bits
SELECT rd.t_own_bits($1::int2, $2::int2, $3::int2, $4::int2, $5::int2, $6::int2) AS v;
