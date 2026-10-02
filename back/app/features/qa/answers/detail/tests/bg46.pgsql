-- BG-46 테스트 준비·기대값 문장(소유자 접속, qa_support.db_* 로 실행). ing 참조가 있어 .pgsql 로 둔다(정적 가드 스캔 대상 밖).

-- name: nonserved_citation_insert
-- 비서빙(드롭) job 에 원문 인용 4행을 더한다($1 = job_id). 테스트가 끝나면 nonserved_citation_delete 로 지운다.
-- ord 1 = 추적 파라미터, 2 = 쿼리·조각·끝 슬래시·대문자·앞뒤 공백(검증 D-01 재현), 3 = URL 없음(NULL), 4 = 빈 문자열
INSERT INTO ing.citation (run_month, job_id, ord, url, title, host, domain_label, scope_category)
SELECT m.run_month, m.job_id, v.ord, v.url, 't', 'www.drop.test', 'drop.test', 'blog'
  FROM ing.answer_key_map m
 CROSS JOIN (VALUES (1::int2, 'https://www.drop.test/a?utm_source=x'),
                    (2::int2, E'  HTTP://WWW.Drop.Test/B/?q=1&fbclid=z#frag/\t'),
                    (3::int2, NULL::text),
                    (4::int2, '')) v(ord, url)
 WHERE m.job_id = $1

-- name: nonserved_citation_urls
-- 위에서 더한 원문 url(기대값 계산 입력, $1 = job_id)
SELECT c.ord, c.url FROM ing.citation c WHERE c.job_id = $1 ORDER BY c.ord

-- name: nonserved_citation_delete
DELETE FROM ing.citation WHERE job_id = $1 AND ord IN (1, 2, 3, 4)

-- name: nonserved_citation_insert_one
-- 비서빙 job 에 원문 인용 1행을 더한다($1 = job_id, $2 = ord, $3 = url). 검증 BG46-NONSERVED 재현(ord 99, dim_url 에 이미 있는 URL).
INSERT INTO ing.citation (run_month, job_id, ord, url, title, host, domain_label, scope_category)
SELECT m.run_month, m.job_id, $2::int2, $3::text, 't', 'known.test', 'known.test', 'blog'
  FROM ing.answer_key_map m
 WHERE m.job_id = $1

-- name: nonserved_citation_delete_one
DELETE FROM ing.citation WHERE job_id = $1 AND ord = $2::int2

-- name: dim_url_insert
-- 적재기 키 규칙(url_hash = sha256(원문 url UTF-8))으로 dim_url 한 행을 더한다($1 = url, $2 = url_norm, $3 = url_base_norm). url_key 반환
INSERT INTO rd.dim_url (url_hash, url, url_norm, url_base_norm, host, domain, rule_ver)
VALUES (sha256(convert_to($1::text, 'UTF8')), $1::text, $2::text, $3::text, 'nbsp.test', 'nbsp.test', 1)
RETURNING url_key

-- name: dim_url_delete
DELETE FROM rd.dim_url WHERE url_key = $1
