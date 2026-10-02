-- 2차 수정(N2 포기 회차 고정 고지·N4 자사 관측 표면 전역 차단 대조) 시험 준비·정리 문장(test_ad_entities_versions_fix2.py 가
-- load_named_sql 로 읽는다). ing 쓰기·rd 쓰기는 API 문장 정적 가드 대상이 아니라 이 데이터 파일에 둔다(back/tests/README.md 6절).

-- name: own_surface_mention
-- 자사(Hyundai) 엔티티의 Scope 관측 표면 변형(원문). 답변·적재 행 없이 언급 행 1개만(뷰 rd.v_entity_mention_surface 는 ing.mention 만 읽는다)
INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, surfaces, type_mention)
VALUES ('2026-09-01', '9f000000-0000-4000-8000-0000000000a4', 1, $1, 'Hyundai', 'Brand', 1, ARRAY['Hyundai Motor Co', 'HMC Group'], 1)

-- name: own_surface_cleanup
DELETE FROM ing.mention WHERE job_id = '9f000000-0000-4000-8000-0000000000a4'

-- name: cycle_pin
-- 적재기 포기 절 흉내: 범위 회차를 반영 전 버전에 고정
UPDATE rd.cycle SET ecat_ver = $2::int2 WHERE cyc_key = ANY($1::int4[])

-- name: cycle_unpin
UPDATE rd.cycle SET ecat_ver = NULL WHERE cyc_key = ANY($1::int4[])
