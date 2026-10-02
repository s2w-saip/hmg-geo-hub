-- ============================================================================
-- fix-u95-competitor-aliases.sql : 이관된 DB 1회 보정(core 9 U9-5). 실행하지 않은 채 커밋한다(운영 담당이 stg 에 따로 돌린다).
--
-- 무엇: 경쟁사 별칭(app.project_tracked_competitor.aliases)에 같은 프로젝트·같은 이름(canonical_name = brand_name)의
--       tracked_brand 별칭(app.project_tracked_brand.aliases)을 합집합으로 덧붙인다. 현행 설정 화면은 경쟁사 별칭 자리에
--       tracked_brands 별칭을 보여 줬는데(setting/page.tsx:99-103) 이관(seed-10-app.sql 4-8)은 두 표를 따로 옮겼다.
--       새 이관은 seed-10-app.sql 4-8b 가 같은 식으로 처리한다(이 파일은 이미 이관된 DB 용).
-- 규칙(core shared.clean_aliases 와 같게): 경쟁사 별칭은 원래 순서 그대로, tracked_brand 별칭 중 앞뒤 공백을 뗀 값이 비지 않고
--       정본 이름과 다르며 경쟁사 별칭(공백 뗀 값)에 없는 것만 tracked_brand 순서대로 덧붙인다(중복 제거, 대소문자 구분).
-- 안전: 트랜잭션 1개. 대상 행 수를 NOTICE 로 먼저 찍고, UPDATE 행 수가 대상 수와 다르거나 갱신 뒤 남은 대상이 있으면 예외(전체 롤백).
--       멱등(두 번째 실행은 대상 0, 갱신 0). 별칭 값·프로젝트 id 는 출력하지 않는다(행 수만).
--       app.project_tracked_competitor 에는 트리거가 없다(판정 재계산 불요: rebuild_tracked_brand 는 경쟁사 별칭을 tracked_brand 로
--       모으는 방향이고, 덧붙이는 별칭은 이미 그 tracked_brand 에 있다).
-- 사용: psql -X -v ON_ERROR_STOP=1 -d hmg -f back/migration/fix-u95-competitor-aliases.sql   (표 소유자 hmg_owner 권한 롤·마스터 계정. loader 는 이 표 UPDATE 권한 없음)
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SET LOCAL app.actor_id = '5eed0000-0000-4000-8000-000000000001';   -- 시스템 사용자(seed-10-app.sql 과 같은 안전망)
SET LOCAL app.actor_type = 'system';

CREATE TEMP TABLE _u95 ON COMMIT DROP AS
SELECT c2.project_id, c2.brand_name,
       ARRAY(SELECT d.a FROM (SELECT DISTINCT ON (t.a) t.a, t.ord
                                FROM (SELECT regexp_replace(u.v, '^[[:space:]]+|[[:space:]]+$', '', 'g') AS a, u.ord
                                        FROM unnest(b.aliases) WITH ORDINALITY AS u(v, ord)) t
                               WHERE t.a <> '' AND t.a <> c2.brand_name
                                 AND NOT EXISTS (SELECT 1 FROM unnest(c2.aliases) AS e(v)
                                                  WHERE regexp_replace(e.v, '^[[:space:]]+|[[:space:]]+$', '', 'g') = t.a)
                               ORDER BY t.a, t.ord) d
             ORDER BY d.ord) AS add
  FROM app.project_tracked_competitor c2
  JOIN app.project_tracked_brand b ON b.project_id = c2.project_id AND b.canonical_name = c2.brand_name;
DELETE FROM _u95 WHERE cardinality(add) = 0;

DO $u95$
DECLARE
  target int;
  added int;
  updated int;
  remaining int;
BEGIN
  SELECT count(*), coalesce(sum(cardinality(add)), 0) INTO target, added FROM _u95;
  RAISE NOTICE 'u95 대상 경쟁사 행 %, 덧붙일 별칭 %', target, added;
  UPDATE app.project_tracked_competitor c
     SET aliases = c.aliases || u.add
    FROM _u95 u
   WHERE c.project_id = u.project_id AND c.brand_name = u.brand_name;
  GET DIAGNOSTICS updated = ROW_COUNT;
  IF updated <> target THEN
    RAISE EXCEPTION 'u95 갱신 행 % <> 대상 %', updated, target;
  END IF;
  SELECT count(*) INTO remaining
    FROM app.project_tracked_competitor c2
    JOIN app.project_tracked_brand b ON b.project_id = c2.project_id AND b.canonical_name = c2.brand_name
   WHERE EXISTS (SELECT 1 FROM unnest(b.aliases) AS u(v)
                  WHERE regexp_replace(u.v, '^[[:space:]]+|[[:space:]]+$', '', 'g') NOT IN ('', c2.brand_name)
                    AND NOT EXISTS (SELECT 1 FROM unnest(c2.aliases) AS e(v)
                                     WHERE regexp_replace(e.v, '^[[:space:]]+|[[:space:]]+$', '', 'g')
                                           = regexp_replace(u.v, '^[[:space:]]+|[[:space:]]+$', '', 'g')));
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'u95 갱신 뒤 남은 대상 %', remaining;
  END IF;
  RAISE NOTICE 'u95 갱신 행 %, 남은 대상 0', updated;
END
$u95$;

COMMIT;
