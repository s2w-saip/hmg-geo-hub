-- 3차 수정(N4 잔여: 자사로 롤업되는 엔티티 표면의 전역 차단 대조) 시험 준비·정리 문장(test_ad_entities_versions_fix3.py 가
-- load_named_sql 로 읽는다). ing 쓰기는 API 문장 정적 가드 대상이 아니라 이 데이터 파일에 둔다(back/tests/README.md 6절).

-- name: rollup_mentions
-- Creta(제품) = Scope 롤업 Hyundai(자사), Fortwo(제품) = Scope 롤업 smart(자사 아님), Tata = 표면 없는 언급(롤업 Hyundai: 이름 대조 경로)
INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, surfaces, brand_rollup_entity_id, type_mention)
VALUES ('2026-09-01', '9f000000-0000-4000-8000-0000000000b1', 1, '71000000-0000-4000-8000-000000000004', 'Hyundai Creta', 'Product', 1,
        ARRAY['Creta', 'Hyundai Creta'], '00000000-0000-0000-0000-000000000301', 1),
       ('2026-09-01', '9f000000-0000-4000-8000-0000000000b1', 2, '71000000-0000-4000-8000-000000000007', 'Smart Fortwo', 'Product', 1,
        ARRAY['Fortwo'], '71000000-0000-4000-8000-000000000006', 1),
       ('2026-09-01', '9f000000-0000-4000-8000-0000000000b1', 3, '71000000-0000-4000-8000-000000000005', 'Tata', 'Brand', 1,
        NULL, '00000000-0000-0000-0000-000000000301', 1)

-- name: rollup_cleanup
DELETE FROM ing.mention WHERE job_id = '9f000000-0000-4000-8000-0000000000b1'
