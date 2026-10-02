-- scope_context_* 조회 인덱스 (2026-07-15) — openspec/changes/2026-07-15-add-context-map-query
--
-- 왜: 컨텍스트 맵 조회가 "전체 Top-350 번들 1회"에서 "페이지 단위 질의"로 바뀐다.
-- 모든 목록 질의가 `WHERE type = ? ORDER BY mention_count DESC LIMIT n OFFSET m` 형태인데,
-- 지금은 type 단일 인덱스만 있어 매 페이지마다 해당 type 전체(1.7k~2.4k행)를 정렬한다.
-- 복합 인덱스로 정렬을 인덱스 순회로 대체한다.
--
-- DESC 를 명시하는 이유: 정렬 방향이 인덱스와 일치해야 Postgres 가 추가 sort 없이
-- 인덱스를 그대로 훑는다. 오름차순 정렬(사용자가 헤더를 토글한 경우)은 같은 인덱스를
-- 역방향으로 훑으면 되므로 별도 인덱스가 필요 없다.
--
-- 검색(canonical_name ILIKE '%q%')용 trigram 인덱스는 의도적으로 넣지 않는다:
-- 4,136행 seq scan 은 수 ms 수준이고, pg_trgm 확장 + GIN 은 운영 복잡도를 더한다.
-- 이 테이블은 읽기 전용 미러라 행 수가 급증할 계획도 없다. 실측 후 필요하면 추가한다.
-- (openspec design.md D3)
--
-- 적용: npm run db:apply -- 0029
-- 이 리포는 0020부터 수동 SQL 관리라 drizzle 저널 밖이며, 파일은 idempotent 여야 한다.

-- 목록: WHERE type = ? ORDER BY mention_count DESC
CREATE INDEX IF NOT EXISTS "scope_context_entities_type_mentions_idx"
  ON "scope_context_entities" ("type", "mention_count" DESC);

-- 컴비네이션 목록: ORDER BY co_count DESC. 5,739행이라 지금도 견디지만, 페이징하면
-- 매 페이지가 전체 정렬을 돌리므로 목록 질의 형태에 맞춰 둔다.
CREATE INDEX IF NOT EXISTS "scope_context_combinations_cocount_idx"
  ON "scope_context_combinations" ("co_count" DESC);

-- 상세 lazy 로드: getEntityDetail(id) 이 evidence 를 엔티티 단위로 조회한다.
-- entity_id 인덱스는 0027 에 이미 있으므로 추가하지 않는다.
-- domains 는 (entity_id, host) 복합 PK 의 선두 컬럼이 entity_id 라 그대로 커버된다.
-- drives 는 (context_id, requirement_id) PK + requirement_id 인덱스로 양방향 커버된다.
