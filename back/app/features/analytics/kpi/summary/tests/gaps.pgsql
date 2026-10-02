-- 값 갭 보강(BG-03·BG-26) 테스트용 준비 문장(소유자 실행, API 문장 아님). test_gaps.py 가 "-- name:" 단위로 읽어
-- core 롤백 전용 준비(tests.support.staged, actor 지정: app.prompt 감사 트리거)로 실행한다. 블록이 끝나면 ROLLBACK.

-- name: depth4_marks
-- 루트 카탈로그 행 c1..01(best suv, 현대, prompt_key 1)·c1..04(현대 SUV 추천, prompt_key 4)와 고객 프로젝트 프롬프트(cust q)에 depth4 를 단다.
UPDATE app.prompt SET depth4 = 'D4x' WHERE prompt_id = 'c1000000-0000-4000-8000-000000000001';
UPDATE app.prompt SET depth4 = 'D4y' WHERE prompt_id = 'c1000000-0000-4000-8000-000000000004';
UPDATE app.prompt SET depth4 = 'P4' WHERE prompt_id = 'c3000000-0000-4000-8000-000000000031';

-- name: pub_labels
-- 웹사이트 회차 21 인용 숨김 해제(R09 경로) + 발행물 rep-0918 회차 라벨.
UPDATE rd.cycle SET hidden_scope = 0, hidden_reason = 0 WHERE cyc_key = 21;
UPDATE app.report_publication SET cycle_label = '9월 3주차', cycle_label_en = 'Sep W3' WHERE slug = 'rep-0918';

-- name: pool_one
-- 유닛 102 를 헤드라인 풀 밖으로: 풀 = {101} 만 합산(현행 publishedSubtotal: 풀 유닛이 있으면 풀만).
UPDATE rd.report_unit_value SET in_headline_pool = false WHERE round_date = '2026-09-18' AND file_seq = 102;

-- name: regions_us_only
-- 검증 D1: Kia 루트 카탈로그 행 'us only'(c1..06)의 대상 시장 = US 만. 계정 대상 시장 밖이면 목록 본문에 나오면 안 된다.
UPDATE app.prompt SET regions = ARRAY['US'] WHERE prompt_id = 'c1000000-0000-4000-8000-000000000006';

-- name: regions_common_kr
-- 검증 D1(KIA_US 쪽): 공통 행 'common q'(c1..02, 엄브렐러 비트)의 대상 시장 = KR 만.
UPDATE app.prompt SET regions = ARRAY['KR'] WHERE prompt_id = 'c1000000-0000-4000-8000-000000000002';

-- name: soft_delete_us_only
-- 검증 D1(soft-delete): 'us only' 를 삭제 표시만(재판정 전이라 rd.catalog_entry 행은 남는다). 목록은 삭제 행 본문을 내지 않는다.
UPDATE app.prompt SET deleted_at = now() WHERE prompt_id = 'c1000000-0000-4000-8000-000000000006';

-- name: depth4_genesis
-- 검증 D5: Genesis 루트 카탈로그 행 'best suv (G)'(c1..11)에만 depth4 D4z. 현대 관점(HQ)의 카탈로그 행 범위에는 없다.
UPDATE app.prompt SET depth4 = 'D4z' WHERE prompt_id = 'c1000000-0000-4000-8000-000000000011';

-- name: regions_d1_repro
-- 검증 D1 재현(2차 검증 절차 그대로): 'us only'(c1..06) 대상 시장 = US, 'common q'(c1..02) 대상 시장 = KR.
-- KIA_EU 는 카탈로그 목록 = ['acr q'], KIA_US 는 'common q' 가 목록 밖이다. 미측정 목록은 목록의 부분집합이어야 한다.
UPDATE app.prompt SET regions = ARRAY['US'] WHERE prompt_id = 'c1000000-0000-4000-8000-000000000006';
UPDATE app.prompt SET regions = ARRAY['KR'] WHERE prompt_id = 'c1000000-0000-4000-8000-000000000002';

-- name: sibling_rows_key6
-- 검증 D3: Genesis 카탈로그 행 'best suv (G)'(c1..11, 퍼널 F1)를 프롬프트 키 6 으로 옮겨 키 6 에 형제 행 둘을 만든다
-- (c1..06 'us only' 퍼널 F2 = prompt_id 가 더 작다). 키 6 은 미측정이다. depth4 D4g 는 c1..11 에만.
UPDATE rd.catalog_entry SET prompt_key = 6 WHERE catalog_row_id = 'c1000000-0000-4000-8000-000000000011';
UPDATE app.prompt SET depth4 = 'D4g' WHERE prompt_id = 'c1000000-0000-4000-8000-000000000011';
