-- 관리 엔티티 목록 수치 독립 재계산(test_ad_entities_registry.py 가 load_named_sql 로 읽는다). ing 읽기는 API 문장 정적 가드 대상이 아니라 이 파일에 둔다.

-- name: prod_definition
-- 운영 hmg-geo 2670a16 lib/db/repositories/entity-registry.ts:118-136 listDiscoveredBrands 를 그대로 옮긴 식(scope_mentions = ing.mention,
-- brand = display_name, 드롭 답변 미러 삭제 = ing.answer_drop 제외). 허브 함수(rd.entity_mention_total_expected)를 쓰지 않는다.
SELECT m.entity_id, count(DISTINCT m.job_id)::int8 AS answers, sum(m.mention_count)::int8 AS mentions
  FROM ing.mention m
 WHERE m.entity_type = 'Brand' AND m.display_name IS NOT NULL
   AND m.job_id NOT IN (SELECT d.job_id FROM ing.answer_drop d)
 GROUP BY m.entity_id

-- name: drop_one
-- Kia 언급이 든 답변 하나를 드롭 등록(운영 미러는 그 답변 언급을 지운다 = 합계에서 빠진다)
INSERT INTO ing.answer_drop (job_id, reason, origin)
SELECT m.job_id, 'entity totals test', 'operator' FROM ing.mention m WHERE m.entity_id = '00000000-0000-0000-0000-000000000302' ORDER BY m.job_id LIMIT 1

-- name: undrop
DELETE FROM ing.answer_drop WHERE reason = 'entity totals test'

-- name: flush
SELECT rd.flush_entity_mention_total()
