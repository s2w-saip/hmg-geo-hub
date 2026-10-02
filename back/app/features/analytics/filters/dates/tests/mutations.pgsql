-- dates(F-2) 회귀 테스트용 준비 문장(소유자 실행, API 문장 아님). test_dates.py 가 "-- name:" 단위로 읽어 core 롤백 전용 준비
-- (tests.support.staged)로 실행한다. 준비 SQL 은 데이터 파일로 둔다(back/tests/README.md 6절). 블록이 끝나면 ROLLBACK.

-- name: hide_cycle_11
UPDATE rd.cycle SET hidden_scope = $1::int2, hidden_reason = CASE WHEN $1::int2 = 0 THEN 0 ELSE 1 END WHERE cyc_key = 11;

-- name: gate_cycle_12
-- $1 servable · $2 노출일 = 오늘(KST) + $2 일
UPDATE rd.cycle SET servable = $1, view_date = rd.today_kst() + $2::int4 WHERE cyc_key = 12;
