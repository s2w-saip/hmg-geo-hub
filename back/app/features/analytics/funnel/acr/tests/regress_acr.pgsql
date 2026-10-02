-- acr 회귀 테스트(test_acr_regress.py) 조각(소유자 실행 준비, API 문장 아님. core 세이브포인트 안에서 넣고 시험 끝에 되돌린다). '-- @이름' 줄로 조각을 나눈다.
-- 회차 키 9918 만 쓴다(픽스처 회차 10·11·12·21·31 과 겹치지 않음).

-- @d3
-- 글로벌 루트(project_key 1)에 ACR 셀이 하나도 없는 노출 회차 2026-09-18(서빙·노출일 09-20, 숨김 없음). 스냅샷이 이 회차로 바뀐다
INSERT INTO rd.cycle (cyc_key, cycle_id, surface, project_key, ledger_backed, round_date, anchor_date, status, servable, view_date,
                      hidden_scope, generation)
VALUES (9918, 'a9000000-0000-4000-8000-000000009918', 1, 1, true, DATE '2026-09-18', DATE '2026-09-18', 2, true, DATE '2026-09-20', 0, 1);
