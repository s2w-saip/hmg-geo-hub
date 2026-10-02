-- ============================================================================
-- hmg-geo 재설계 보완 패치 DB-v2.26 · 롤업 엔티티 대표 표기 원장(현행 프로필 NAME = display_name_latin, be/int3-name 2026-10-02)
-- 적용 순서: DB-v2.25 뒤 1회(트랜잭션 1개). 합본 DB-v2.26.sql = DB-v2.25.sql + 이 파일(바이트 연결). 기존 표·열은 바꾸지 않는다(새 표·함수·트리거만).
-- 근거: stg 4차 동결 세대 이관 시험(924 회차 중 40 실패, frz-fail40-20261002) 원인 2 "롤업 엔티티 대표 이름 대체".
--
-- 운영 규칙(hmg-geo 2670a16): 표시 브랜드 이름 = canonBrandNameSql(COALESCE(names[롤업 id], 자기 표기))
--     lib/summary/generate/context.ts:134-145 brandExprs(rawName = COALESCE(n.brand, m.brand)), load.ts:79-98(names = ROLLUP_NAMES 를 롤업 id 로 조인,
--     bg 를 (job, brand_id, brand_name) 으로 접음), names = lib/db/repositories/scope-aggregates.ts:238-254 ROLLUP_NAMES
--     (scope_mentions 의 entity_type 'Brand' 행 표기를 엔티티마다 라틴 우선 → 사전순 1개). 생성기는 생성 시점의 미러 행을 읽는다.
--   Scope 정리(S5)가 Wahl·Sharp·Arrival 등 62개 엔티티의 Brand 행을 지우자, 허브는 그 엔티티로 롤업된 제품 행 표기(Opel XER Motor 등)로 이름을
--   지었다(names 가 비어 자기 표기로 떨어짐). 운영 동결 세대는 Brand 행이 있던 때 생성돼 'Wahl'·'Sharp' 이고, 이 이름은 비경쟁 명부
--   (app.non_competitor_name wahl·sharp)에 걸려 경쟁에서 빠진다. 허브는 제품 이름이라 경쟁으로 세어 all_mentions·순위 합이 밀렸다.
--
-- P138 ing.entity_brand_name(entity_id, display_name, first_job, first_seen): 적재가 본 적 있는 (엔티티, Brand 행 표기) 쌍의 원장.
--     insert 전용(지우지 않는다): 원천에서 Brand 행이 사라져도 대표 표기 후보가 남는다. 현행 프로필 NAME 이 켜지면 names 원천 =
--     지금 ing.mention Brand 행 ∪ 이 원장(seed-3x-common §5 _names, ingest.project.apply _ig_names·PRIOR_NAMES·NAME_CHANGED). 꺼짐은 읽지 않는다.
--     first_job = 그 쌍을 처음 들인 답변(이름 변경 감지 NAME_CHANGED 가 "이번 적재가 새로 들인 표기"를 가르는 데 쓴다. 다시 받은 답변이면
--     보수적으로 변경 후보가 된다 = 더 많이 재투영, 덜 하지 않는다).
--     유일 제약을 두지 않는다(일반 색인만): 유일 색인이면 같은 새 표기를 처음 들이는 두 적재가 서로의 미커밋 행에 막히고(커밋까지 대기),
--     문장 순서가 엇갈리면 교착한다(test_entity_mention_total CE24 가 실제로 멈췄다). 쓰기는 "커밋된 원장에 없을 때만" 넣으므로 중복은
--     동시에 처음 본 경우에만 생기고, 읽는 쪽은 모두 UNION(중복 제거)이라 의미가 같다.
-- P139 트리거 entity_brand_name_ins·upd(ing.mention 부모 문장 트리거, 전이 표): 새·바뀐 언급의 Brand 표기 중 원장에 없는 쌍을 더한다(대기 없음).
--     트리거 밖 쓰기(seed-20 이관·leaf 직접 쓰기, 소유자 실행)는 끝에 rd.refresh_entity_brand_name() 을 부른다(DB-v2.25 P134 와 같은 규약).
-- P140 rd.refresh_entity_brand_name() → 지금 ing.mention 의 Brand 표기를 원장에 더한다(없는 쌍만). 반환 = 넣은 행 수. 이관·재구축·복구용.
--     원천에서 이미 지워진 표기(stg: 운영 동결 세대가 이름으로 쓴 S5 유실 엔티티 표기 Wahl·Sharp·Arrival)는 migration/fill-v226.sql 이 넣는다.
-- 락: 새 표·함수 생성, ing.mention 에 트리거를 거는 데 SHARE ROW EXCLUSIVE 를 잠깐 잡는다(적재를 멈춘 창에 적용).
-- 적용 절차(stg·prod): ① 이 패치 ② migration/fill-v226.sql(refresh + 이관 원천이 있으면 동결 근거 보충) ③ NAME 켠 프로필로 bulk 재투영.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('rd.entity_mention_total') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.25(rd.entity_mention_total) 가 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('ing.entity_brand_name') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.26 롤업 대표 표기 원장 이미 적용됨(ing.entity_brand_name 존재)';
  END IF;
END $v$;

-- ── P138 ──────────────────────────────────────────────────────────────────────
CREATE TABLE ing.entity_brand_name (
  entity_id uuid NOT NULL,
  display_name text NOT NULL,
  first_job uuid NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now());
-- 색인 키 = (엔티티, md5(표기)): 표기 원문을 btree 키로 두면 긴 표기(btree 행 상한 2,704 바이트)에서 ing.mention 트리거·적재가 실패한다
--   (적재기 _ig_prior_url 과 같은 결함 유형, be/int3-prior). 조건부 삽입은 md5 일치 + 원문 일치로 찾는다(stg 실측 표기 최대 54 바이트).
CREATE INDEX entity_brand_name_pair_idx ON ing.entity_brand_name (entity_id, md5(display_name));
COMMENT ON TABLE ing.entity_brand_name IS
  '적재가 본 (엔티티, Brand 행 표기) 원장(insert 전용). 현행 프로필 NAME 의 롤업 대표 표기 원천 = ing.mention Brand 행 ∪ 이 표. DB-v2.26 P138';

-- ── P139 ──────────────────────────────────────────────────────────────────────
CREATE FUNCTION ing.tg_entity_brand_name() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
BEGIN
  INSERT INTO ing.entity_brand_name (entity_id, display_name, first_job)
  SELECT DISTINCT ON (n.entity_id, n.display_name) n.entity_id, n.display_name, n.job_id FROM em_bn n
   WHERE n.entity_type = 'Brand' AND n.display_name IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ing.entity_brand_name b WHERE b.entity_id = n.entity_id AND md5(b.display_name) = md5(n.display_name)
                       AND b.display_name = n.display_name)
   ORDER BY n.entity_id, n.display_name, n.job_id;
  RETURN NULL;
END $f$;
CREATE TRIGGER entity_brand_name_ins AFTER INSERT ON ing.mention REFERENCING NEW TABLE AS em_bn
  FOR EACH STATEMENT EXECUTE FUNCTION ing.tg_entity_brand_name();
CREATE TRIGGER entity_brand_name_upd AFTER UPDATE ON ing.mention REFERENCING NEW TABLE AS em_bn
  FOR EACH STATEMENT EXECUTE FUNCTION ing.tg_entity_brand_name();

-- ── P140 ──────────────────────────────────────────────────────────────────────
CREATE FUNCTION rd.refresh_entity_brand_name() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE n int;
BEGIN
  INSERT INTO ing.entity_brand_name (entity_id, display_name, first_job)
  SELECT DISTINCT ON (m.entity_id, m.display_name) m.entity_id, m.display_name, m.job_id FROM ing.mention m
   WHERE m.entity_type = 'Brand' AND m.display_name IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ing.entity_brand_name b WHERE b.entity_id = m.entity_id AND md5(b.display_name) = md5(m.display_name)
                       AND b.display_name = m.display_name)
   ORDER BY m.entity_id, m.display_name, m.job_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $f$;
COMMENT ON FUNCTION rd.refresh_entity_brand_name() IS
  '지금 ing.mention 의 Brand 표기를 원장(ing.entity_brand_name)에 더한다(없는 쌍만, 지우지 않는다). 반환 = 넣은 행 수. DB-v2.26 P140';

-- ── 소유자·권한 ─────────────────────────────────────────────────────────────
ALTER TABLE ing.entity_brand_name OWNER TO hmg_owner;
ALTER FUNCTION ing.tg_entity_brand_name() OWNER TO hmg_owner;
ALTER FUNCTION rd.refresh_entity_brand_name() OWNER TO hmg_owner;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ing.entity_brand_name FROM loader, migrator;   -- 쓰기 = 트리거(소유자 권한)·refresh 만
GRANT SELECT ON ing.entity_brand_name TO loader, migrator;
REVOKE EXECUTE ON FUNCTION ing.tg_entity_brand_name(), rd.refresh_entity_brand_name() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.refresh_entity_brand_name() TO loader, migrator;

-- ── 사후 단언(구조) ─────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'ing.entity_brand_name'::regclass)) <> 'hmg_owner'
     OR NOT has_table_privilege('loader', 'ing.entity_brand_name', 'select')
     OR has_table_privilege('loader', 'ing.entity_brand_name', 'insert')
     OR has_table_privilege('loader', 'ing.entity_brand_name', 'delete')
     OR NOT has_function_privilege('loader', 'rd.refresh_entity_brand_name()', 'execute') THEN
    RAISE EXCEPTION 'P138~P140 실패: 소유자·권한';
  END IF;
  IF position('md5(display_name)' in coalesce((SELECT indexdef FROM pg_indexes WHERE schemaname = 'ing' AND indexname = 'entity_brand_name_pair_idx'), '')) = 0 THEN
    RAISE EXCEPTION 'P138 실패: 원장 색인 키(entity_id, md5(display_name))';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'entity_brand_name_%' AND tgrelid = 'ing.mention'::regclass) <> 2 THEN
    RAISE EXCEPTION 'P139 실패: 원장 트리거';
  END IF;
END $v$;

COMMIT;
