-- N1 회귀 준비 문장(롤백 전용, test_n1_shadows_owned_index.py 가 load_named_sql 로 읽는다).
-- rd 쓰기·ANALYZE 는 API 문장 정적 가드 대상이 아니라 이 데이터 파일에 둔다(back/tests/README.md 6절).

-- name: dim_source_synthetic
-- 비당사 합성 출처 키 $1 개(owned_brand_bit 0). 오버라이드 도메인 www<g>.n1s<g>.n1syn.example 의 접미 후보가 이 키와 등호로 만난다.
INSERT INTO rd.dim_source (skey, domain, is_social, category_key, category_src, owned_brand_bit, rule_ver)
SELECT 'n1s' || g || '.n1syn.example', 'n1s' || g || '.n1syn.example', false, 1, 3, 0, 1
  FROM generate_series(1, $1::int) g

-- name: dim_source_edge
-- 보강 경로 ② 경계: 당사 비트 출처 키 하나, 당사 비트가 있어도 소셜이라 빠지는 키 하나.
INSERT INTO rd.dim_source (skey, domain, is_social, category_key, category_src, owned_brand_bit, rule_ver)
VALUES ('n1own.example', 'n1own.example', false, 1, 3, 1, 1),
       ('n1soc.example', 'n1soc.example', true, 1, 3, 1, 1)

-- name: analyze
ANALYZE rd.dim_source, app.citation_domain_override
