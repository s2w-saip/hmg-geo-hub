-- core 10라운드 시험 준비 문장(소유자 실행, tests.support.staged 롤백 전용). "-- name:" 블록 단위로 읽는다.

-- name: genesis_only_taxon
-- 결정 7: 프롬프트 1 의 제네시스 카탈로그 행(비트 4)에만 있는 depth2 값 'D2gen'. 현대 행(비트 1)은 D2a 그대로(같은 prompt_key 공유).
INSERT INTO rd.dim_taxon (taxon_key, axis, code, parent_key) VALUES (11, 'depth2', 'D2gen', 8);
UPDATE rd.catalog_entry SET depth2_key = 11 WHERE catalog_row_id = 'c1000000-0000-4000-8000-000000000011' AND brand_bit = 4;
