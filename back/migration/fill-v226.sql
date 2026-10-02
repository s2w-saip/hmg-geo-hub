-- ============================================================================
-- 1회 채우기: DB-v2.26 P138 ing.entity_brand_name(롤업 대표 표기 원장, 현행 프로필 NAME, be/int3-name 2026-10-02). 번호는 통합 때
-- 패치와 함께 바꾼다.
-- 무엇을:
--   ① rd.refresh_entity_brand_name(): 지금 ing.mention 의 Brand 표기를 원장에 넣는다(없는 쌍만).
--   ② (이관 원천이 있을 때만) 운영 동결 세대 근거 보충: 이관 사본(mig_src.scope_mentions_0930·mig_src.scope_mentions)의 Brand 쌍 중
--      지금 ing.mention 에 Brand 행이 하나도 없는 엔티티(원천 정리로 사라짐)의 것이면서, 그 표기가 운영 동결 세대 브랜드 이름
--      (mig_src.frz_ops_sum_brand.brand_name)으로 실제로 쓰인 것만 넣는다(동결 세대 브랜드 표에는 엔티티 id 가 없어 이름으로 맞춘다:
--      frz_ops_brand.brand_id 는 34 개 관리 브랜드뿐).
--      왜 이 범위인가(stg hmg_r2 실측 2026-10-02, 읽기 전용):
--        · 운영 생성기 이름 = 생성 시점 미러 scope_mentions 의 Brand 행 전부(ROLLUP_NAMES, 답변 유무 무관). 동결 세대 924 개 중 920 개가
--          2026-10-01 13:53~14:49 UTC 에 생성됐다. 그때 Wahl·Sharp·Arrival 은 답변 없는 고아 Brand 행(104·48·5)만 남아 있었고, 운영은 그 행으로
--          'Wahl'·'Sharp'·'Arrival' 을 썼다(허브 ing 에는 없음).
--        · 사본 전체를 넣으면 틀린다: 0930 사본 전체는 5 이름 회귀(Victory·Phoenix Racing·Ampere·Squadra Tuning·Vanguard 의 Brand 행은
--          동결 때 이미 없었고 운영은 제품 표기를 썼다), 1002 사본 전체는 7 이름 회귀(Velgen·Grant·2M·Vibe Audio 의 Brand 행은 동결 뒤
--          16:22~21:40 UTC 에 동기화됐다).
--        · "운영 동결 세대가 이름으로 실제로 쓴 Brand 표기"만 넣으면 시점 판정 없이 동결 때 미러 상태와 같아진다: 보충 3쌍(Wahl·Sharp·
--          Arrival), 새 키 후보 대 운영 동결 이름 1,902 중 1,902 정확 일치(사본 전체 보충은 1,897·1,895).
--      first_job = 사본 행의 job(허브에 없는 job 일 수 있다: 이름 변경 감지에서 "이번 적재 밖"의 옛 표기로 읽힌다).
-- 드라이런이 기본: 같은 쓰기를 한 트랜잭션에서 해 보고 개수만 낸 뒤 ROLLBACK(commit=1 이면 COMMIT).
-- 롤 = hmg_owner(원장 쓰기는 소유자·트리거만, loader·migrator 는 SELECT 만).
--   psql -X -v ON_ERROR_STOP=1 -f fill-v226.sql
--   psql -X -v ON_ERROR_STOP=1 -v commit=1 -f fill-v226.sql
-- 이 뒤 현행 프로필(NAME 켜짐)로 bulk 재투영(seed-30·seed-40)이 필요하다: NAME 키가 모든 브랜드의 dim_brand_name.bare 를 바꾼다.
-- ============================================================================
\if :{?commit}
\else
  \set commit 0
\endif
SET statement_timeout = '30min';
SET lock_timeout = '30s';
BEGIN;
DO $v$ BEGIN
  IF to_regclass('ing.entity_brand_name') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.26 롤업 대표 표기 원장 패치가 먼저 적용돼야 한다(ing.entity_brand_name 없음)';
  END IF;
END $v$;
SELECT 'before' AS step, count(*) AS n FROM ing.entity_brand_name;
SELECT 'refresh' AS step, rd.refresh_entity_brand_name() AS n;

SELECT to_regclass('mig_src.frz_ops_sum_brand') IS NOT NULL
   AND to_regclass('mig_src.scope_mentions') IS NOT NULL
   AND to_regclass('mig_src.scope_mentions_0930') IS NOT NULL AS has_src \gset
\if :has_src
CREATE TEMP TABLE _ebn_bf ON COMMIT DROP AS
  SELECT DISTINCT ON (x.entity_id, x.brand) x.entity_id, x.brand AS display_name, x.job_id
    FROM (SELECT entity_id, brand, job_id FROM mig_src.scope_mentions_0930 WHERE entity_type = 'Brand' AND brand IS NOT NULL
          UNION ALL SELECT entity_id, brand, job_id FROM mig_src.scope_mentions WHERE entity_type = 'Brand' AND brand IS NOT NULL) x
   WHERE EXISTS (SELECT 1 FROM mig_src.frz_ops_sum_brand f WHERE f.brand_name = x.brand)
     AND NOT EXISTS (SELECT 1 FROM ing.mention m WHERE m.entity_id = x.entity_id AND m.entity_type = 'Brand' AND m.display_name IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM ing.entity_brand_name b WHERE b.entity_id = x.entity_id AND md5(b.display_name) = md5(x.brand) AND b.display_name = x.brand)
   ORDER BY x.entity_id, x.brand, x.job_id;
SELECT 'frz_backfill' AS step, count(*) AS n, count(DISTINCT entity_id) AS entities FROM _ebn_bf;
SELECT 'frz_backfill_name' AS step, display_name FROM _ebn_bf ORDER BY 2;
INSERT INTO ing.entity_brand_name (entity_id, display_name, first_job) SELECT entity_id, display_name, job_id FROM _ebn_bf;
\else
SELECT 'frz_backfill' AS step, 'skip: 이관 원천(mig_src) 없음' AS note;
\endif

-- 사후 단언: 지금 Brand 행 쌍은 모두 원장에 있다
DO $v$ BEGIN
  IF EXISTS (SELECT 1 FROM ing.mention m WHERE m.entity_type = 'Brand' AND m.display_name IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM ing.entity_brand_name b WHERE b.entity_id = m.entity_id AND md5(b.display_name) = md5(m.display_name)
                                   AND b.display_name = m.display_name)) THEN
    RAISE EXCEPTION 'fill-v226 실패: ing.mention Brand 쌍이 원장에 빠졌다';
  END IF;
END $v$;
SELECT 'after' AS step, count(*) AS n, count(DISTINCT (entity_id, display_name)) AS pairs FROM ing.entity_brand_name;
\if :commit
COMMIT;
\else
ROLLBACK;
\endif
