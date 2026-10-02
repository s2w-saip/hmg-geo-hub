-- ============================================================================
-- hmg-geo 재설계 보완 패치 DB-v2.29 · rd.dim_brand_name 표시명 키 길이 상한 해소(be/int3-longkey, 검증 D'')
-- 적용 순서: DB-v2.28 뒤 1회(트랜잭션 1개). 합본 DB-v2.29.sql = DB-v2.28.sql + 이 파일(바이트 연결). 가번호 DB-vNEXT-dim-brand-name-hash
--   PH1~PH3 → P145~P147(be/int4 통합). 5차 묶음 순서: 이 패치(적재 차단 해소) → DB-v2.30(창 판정 기초) → DB-v2.31(재동결 감사 권한).
-- 결함: rd.dim_brand_name 의 name·bare UNIQUE 는 표시명 원문 btree 다. Scope 표시명은 길이 보장이 없어, 비압축 2.7KB 를 넘는 표기가 표시 브랜드
--   이름 자체가 되면 적재(ingest.project.apply 의 dim_brand_name 삽입)·bulk 시드(seed-30 §9)가 'index row size … exceeds btree version 4
--   maximum 2704 for index "dim_brand_name_name_key"' 로 실패한다(재시도마다 반복 = run blocked). 임시 표 쪽(_ig_pairs·_bn_pair)은 8dbe433b 가 고쳤다.
-- P145 md5 유일 색인 dim_brand_name_name_md5_uq(md5(name))·dim_brand_name_bare_md5_uq(md5(bare)): 유일성은 그대로(md5 충돌이 없는 한 같은 뜻).
-- P146 원문 등치 조회 해시 색인 dim_brand_name_name_h(name)·dim_brand_name_bare_h(bare): 원문 등치 조회(적재 dim_brand_name 조인 b.bare = p.bare,
--     pick NOT EXISTS (bare = … OR name = …) 등)가 쓰던 btree 자리. 해시 색인은 키 길이 상한이 없다. analytics 브랜드 키 조회
--     (citations/domains/queries.py BRAND_KEY_SQL: name = :n OR lower(bare) = lower(:n))는 lower(bare) 가 식이라 OR 전체가 패치 전 btree 로도
--     이 색인으로도 색인을 못 타고 차원 표 순차 훑기다(패치 전후 같음, 2만 행 합성 EXPLAIN 확인).
-- P147 기존 제약 dim_brand_name_name_key·dim_brand_name_bare_key 삭제. 이 제약을 ON CONFLICT·제약 이름으로 쓰는 코드는 없다(be/int3-longkey grep).
-- 성격: 기존 표 제약 교체(additive-only 예외, 5차 승인 묶음). 작은 차원 표(수천 행): 색인 생성·제약 삭제가 ACCESS EXCLUSIVE 를 짧게 잡는다
--   (적재를 멈춘 창에 적용). 되돌리기 = UNIQUE (name)·(bare) 를 다시 걸고 이 색인 4개 삭제(긴 표기 행이 생겼다면 되돌리기 전에 정리).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('ing.entity_brand_name') IS NULL
     OR to_regprocedure('frz.keep_fold(int4, jsonb)') IS NULL
     OR position('I7 순위 순서' in pg_get_functiondef(to_regprocedure('frz.keep_fold(int4, jsonb)'))) = 0 THEN
    RAISE EXCEPTION 'DB-v2.28(frz.keep_fold 불변식, DB-v2.26 ing.entity_brand_name 포함) 이 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('rd.dim_brand_name_name_md5_uq') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.29 dim_brand_name 해시 키 이미 적용됨(rd.dim_brand_name_name_md5_uq 존재)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'rd.dim_brand_name'::regclass AND conname = 'dim_brand_name_name_key' AND contype = 'u')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'rd.dim_brand_name'::regclass AND conname = 'dim_brand_name_bare_key' AND contype = 'u') THEN
    RAISE EXCEPTION 'rd.dim_brand_name 원문 UNIQUE 제약(dim_brand_name_name_key·dim_brand_name_bare_key)이 예상과 다르다';
  END IF;
END $v$;

-- ── P145 ─────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX dim_brand_name_name_md5_uq ON rd.dim_brand_name (md5(name));
CREATE UNIQUE INDEX dim_brand_name_bare_md5_uq ON rd.dim_brand_name (md5(bare));

-- ── P146 ─────────────────────────────────────────────────────────────────────
CREATE INDEX dim_brand_name_name_h ON rd.dim_brand_name USING hash (name);
CREATE INDEX dim_brand_name_bare_h ON rd.dim_brand_name USING hash (bare);

-- ── P147 ─────────────────────────────────────────────────────────────────────
ALTER TABLE rd.dim_brand_name DROP CONSTRAINT dim_brand_name_name_key, DROP CONSTRAINT dim_brand_name_bare_key;

-- ── 사후 단언(구조) ─────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'rd.dim_brand_name'::regclass)) <> 'hmg_owner'
     OR (SELECT count(*) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
          WHERE x.indrelid = 'rd.dim_brand_name'::regclass AND i.relname IN ('dim_brand_name_name_md5_uq', 'dim_brand_name_bare_md5_uq')
            AND x.indisunique AND x.indisvalid) <> 2
     OR (SELECT count(*) FROM pg_class i JOIN pg_am am ON am.oid = i.relam AND am.amname = 'hash'
          WHERE i.relname IN ('dim_brand_name_name_h', 'dim_brand_name_bare_h') AND i.relnamespace = 'rd'::regnamespace) <> 2 THEN
    RAISE EXCEPTION 'P145~P146 실패: 소유자·색인';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_am am ON am.oid = i.relam AND am.amname = 'btree'
              CROSS JOIN LATERAL unnest(x.indkey[0:x.indnkeyatts - 1]) k(attnum)
              JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
             WHERE x.indrelid = 'rd.dim_brand_name'::regclass AND a.attname IN ('name', 'bare')) THEN
    RAISE EXCEPTION 'P147 실패: name·bare 원문 btree 색인이 남았다';
  END IF;
END $v$;

COMMIT;
