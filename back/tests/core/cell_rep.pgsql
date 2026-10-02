-- WU-2 셀 대표(A1) 시험 준비 문장(롤백 전용, tests/core/test_cell_rep.py). 소유자로 실행한다.

-- name: fill_children
-- 자식 is_rep = 부모 사본(패치 직후 false 인 상태를 채운다)
SELECT rd.fill_child_is_rep(ARRAY(SELECT answer_key FROM rd.job WHERE served ORDER BY answer_key));

-- name: deelig_non_reps
-- 대표 아닌 답변의 elig 를 끈다 → OFF(std_in·cit_in) 모수 = 셀 대표만(cell_rep 켜짐과 같아야 하는 변성 상태).
-- 카탈로그 밖 사유로 끄는 것이므로 카탈로그 무관 게이트 elig_nc·모수 열도 같이 끈다(DB-v2.15 P89 CHECK answer_nc_rule, WU-4)
UPDATE rd.answer SET elig = false, elig_nc = false, std_in_nc = false, cit_in_nc = false WHERE NOT is_rep AND elig;

-- name: propagate_all
-- 게이트 사본(std_in·elig·cit_in·is_rep)을 자식 표로
SELECT rd.propagate_answer_gates(ARRAY(SELECT answer_key FROM rd.job WHERE served ORDER BY answer_key));

-- name: boundary_latest_non_elig
-- 경계: 답변 3건 이상인 셀에서 최신 답변(현재 대표)을 elig 거짓으로 → hub 규칙 = 이전 elig 답변, 현행 규칙 = 셀 대표 없음. 대상 셀 1개
WITH c AS (SELECT a.surface, a.cyc_key, a.prompt_key, a.engine_key, a.geo_key
             FROM rd.answer a GROUP BY 1, 2, 3, 4, 5 HAVING count(*) FILTER (WHERE a.elig) >= 2
            ORDER BY 1, 2, 3, 4, 5 LIMIT 1)
UPDATE rd.answer a SET elig = false, elig_nc = false, std_in_nc = false, cit_in_nc = false   -- 카탈로그 밖 사유(P89 elig_nc 도, WU-4)
  FROM c WHERE a.surface = c.surface AND a.cyc_key = c.cyc_key AND a.prompt_key = c.prompt_key AND a.engine_key = c.engine_key
   AND a.geo_key = c.geo_key AND a.is_rep
RETURNING a.answer_key;

-- name: reset_children
-- 패치 직후 상태(자식 is_rep 미채움 = false)로 되돌린다(채우기 SQL 시험)
UPDATE rd.answer_brand SET is_rep = false WHERE is_rep;
UPDATE rd.answer_stance SET is_rep = false WHERE is_rep;
UPDATE rd.citation SET is_rep = false WHERE is_rep;
