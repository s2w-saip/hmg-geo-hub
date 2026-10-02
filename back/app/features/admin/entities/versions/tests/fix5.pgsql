-- 5차 수정(명부 밖 자사 귀속 엔티티의 유효 귀속 표시·린트) 시험 준비·정리 문장(test_ad_entities_versions_fix5.py 가 load_named_sql 로 읽는다).
-- rd 쓰기는 API 문장 정적 가드 대상이 아니라 이 데이터 파일에 둔다(back/tests/README.md 6절).

-- name: india_dim
-- 'Hyundai India' 류: 명부 밖 Brand 엔티티, 투영 차원 표시 브랜드 = hyundai(접두 교정으로 자사 귀속). 키는 대소문자 무시로 찾는다
-- (현행 프로필 NAME 의 bare = 정본 표시명 'Hyundai')
INSERT INTO rd.dim_entity (entity_id, entity_type, rep_name, brand_key)
SELECT 'ad000000-0000-4000-8000-000000000001', 'Brand', 'Hyundai India', b.brand_key FROM rd.dim_brand_name b WHERE lower(b.bare) = 'hyundai' ORDER BY b.brand_key LIMIT 1

-- name: hmi_dim
-- 검증 5차 CE25: 명부 밖 자사 귀속 Brand 엔티티(표시 브랜드 hyundai, 목록 행은 Brand 만). 활성 버전에서 제거하면 목록 배지도 자사 아님이어야 한다.
INSERT INTO rd.dim_entity (entity_id, entity_type, rep_name, brand_key)
SELECT 'ad000000-0000-4000-8000-000000000002', 'Brand', 'Hyundai Motor India', b.brand_key FROM rd.dim_brand_name b WHERE lower(b.bare) = 'hyundai' ORDER BY b.brand_key LIMIT 1

-- name: india_cleanup
DELETE FROM rd.dim_entity WHERE entity_id IN ('ad000000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000002')
