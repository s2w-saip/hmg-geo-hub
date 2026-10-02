-- ============================================================================
-- 1회 이관: 현행 명부 → 엔티티 버전 v1 (DB-v2.17 P99 app.ecat_cutover_v1) · 제품 결정 26~29 (2026-10-01)
-- **작성만, 실행은 제품 책임자 승인 배치에서**. 대상 = 새 DB(stg·prod) T0(설계 6절). DB-v2.17 패치 뒤, E6(초안 편집 API) 배포와 같은 창.
--
-- 무엇을: app.entity_registry(own·excluded) ∪ app.entity_alias 를 app.ecat_version v1(ver 1, origin cutover, 활성)로 옮긴다.
--   own → own(brand_code 그대로), excluded → hidden(순위·목록에서만 숨김, KPI 불변 = 현행 의미), 별칭 alias → canon = merge_into.
--   명부와 별칭에 같은 id 가 있으면 한 엔티티 행(역할 + merge_into). 이름 = 명부 이름, 별칭만 있으면 rd.dim_entity.rep_name.
--   활성화 뒤 기존 두 표는 활성 버전의 투영이 된다(읽는 SQL 무변경). 이관이 기존 표를 바꾸지 않았음을 함수가 단언한다:
--   기존 표 md5·행 수 이관 전 = 후, 바뀐 행 0, 엔티티 행 수 = 명부 + 별칭 − 겹침.
-- 효과(주의): 실행(commit) 순간부터 기존 표 직접 쓰기가 거부된다(ECAT_LEGACY_WRITE): 현 관리 PUT /v1/admin/entities 가 DB 예외로 실패한다.
--   그래서 E6 배포(PUT → 초안 편집)와 같은 창에서 돌린다. rd 는 바꾸지 않는다(v1 = 현행 명부라 투영 결과 불변, 결과 캐시 무효화 불필요).
-- 멱등: 버전이 하나라도 있으면 거부(ECAT_CUTOVER_DONE). 드라이런 = 같은 함수를 끝까지 돌리고 ROLLBACK(단언까지 리허설).
-- 롤: migrator(EXECUTE app.ecat_cutover_v1) 또는 superuser. 행위자 = 이관 수행자 계정 uuid(app.ecat_version.created_by).
--
-- 사용(드라이런이 기본. 접속 URL 은 env 로만):
--   psql -X -v ON_ERROR_STOP=1 -v actor=<uuid> -f ecat-v1-cutover.sql
--   psql -X -v ON_ERROR_STOP=1 -v actor=<uuid> -v commit=1 -f ecat-v1-cutover.sql
-- 출력 = 개수·md5 만(엔티티 id·이름 없음).
-- ============================================================================
\if :{?commit}
\else
  \set commit 0
\endif
\if :{?actor}
\else
  \set actor
\endif
SET statement_timeout = '5min';
SET lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('app.ecat_version') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.17 이 먼저 적용돼야 한다(app.ecat_version 없음)';
  END IF;
END $v$;

SELECT (SELECT count(*) FROM app.entity_registry) AS registry_rows,
       (SELECT count(*) FROM app.entity_registry WHERE role = 'own') AS own_rows,
       (SELECT count(*) FROM app.entity_registry WHERE role = 'excluded') AS excluded_rows,
       (SELECT count(*) FROM app.entity_alias) AS alias_rows,
       (SELECT count(*) FROM app.entity_registry r JOIN app.entity_alias a ON a.alias_entity_id = r.entity_id) AS overlap_rows,
       (SELECT count(*) FROM app.ecat_version) AS versions_before;

-- 이관 1회(사유 = 함수 기본값 'T0 운영 명부 이관'). 드라이런이면 아래 ROLLBACK 으로 전부 되돌린다
BEGIN;
SELECT * FROM app.ecat_cutover_v1(nullif(:'actor', '')::uuid);
SELECT v.ver, v.status, v.origin, encode(v.content_md5, 'hex') AS content_md5,
       (SELECT count(*) FROM app.ecat_entity e WHERE e.ver = v.ver) AS entity_rows
  FROM app.ecat_version v ORDER BY v.ver;
\if :commit
COMMIT;
\else
ROLLBACK;
\endif
