-- 4차 수정(N7: 표시명 접두 교정으로 자사에 귀속되는 제품 표면의 전역 차단 대조) 시험 준비·정리 문장(test_ad_entities_versions_fix4.py 가
-- load_named_sql 로 읽는다). ing 쓰기는 API 문장 정적 가드 대상이 아니라 이 데이터 파일에 둔다(back/tests/README.md 6절).

-- name: prefix_surfaces
-- 픽스처 Creta 언급(표시명 'Hyundai Creta', Scope 롤업 Tata)·Fortwo 언급(표시명 'Smart Fortwo', Scope 롤업 smart)에 표면을 단다
UPDATE ing.mention SET surfaces = CASE entity_id WHEN '71000000-0000-4000-8000-000000000004'::uuid THEN ARRAY['Creta']
                                                 ELSE ARRAY['Fortwo'] END
 WHERE entity_id IN ('71000000-0000-4000-8000-000000000004', '71000000-0000-4000-8000-000000000007')

-- name: prefix_cleanup
UPDATE ing.mention SET surfaces = NULL WHERE entity_id IN ('71000000-0000-4000-8000-000000000004', '71000000-0000-4000-8000-000000000007')
