-- ============================================================================
-- hmg-geo 재설계 보완 패치 DB-v2.25 · 엔티티 목록 수치 = 엔티티별 전 기간 합계(엔티티 관리 5차 항목 1, B안) + ing 하위 파티션 쓰기 권한 회수
-- 번호: be/int3 통합(2026-10-01)에서 배정(가번호 DB-vNEXT-entity-mention-total PE1~PE4 → P132~P135) + P136(통합 공통 처리).
-- 적용 순서: DB-v2.24 뒤 1회(트랜잭션 1개). 합본 DB-v2.25.sql = DB-v2.24.sql + 이 파일(바이트 연결). 기존 표·열은 바꾸지 않는다
-- (P136 은 권한 회수와 파티션 생성 함수 rd.ensure_month_leaf·rd.ensure_hub_match_leaf 의 CREATE OR REPLACE, 본문 같고 생성 직후 REVOKE 추가).
-- 근거: 메인 지시(2026-10-01) "항목 1 은 B안: 운영(listDiscoveredBrands)처럼 전 기간 엔티티별 합계", 제품 결정 25(현행 재현).
--
-- 운영 정의(hmg-geo 2670a16): lib/db/repositories/entity-registry.ts:118-136 listDiscoveredBrands
--     SELECT entity_id, sum(mention_count) AS mentions, count(DISTINCT job_id) AS answers FROM scope_mentions
--      WHERE entity_type = 'Brand' AND brand IS NOT NULL GROUP BY entity_id                 (기간·상태·모수 게이트 없음, 전 기간)
--   scope_mentions = 미러된 답변의 (job × entity) 언급(lib/db/schema.ts:1029-1056, brand = display_name). 드롭 답변은 미러 행이 지워진다
--   (lib/db/repositories/scope-mirror.ts:128-145·387 dropReapplySql → scope_answer_drop_apply: citations → mentions → answers 삭제).
--   허브 대응: ing.mention(display_name = brand) − ing.answer_drop 답변. 엔티티 관리(버전 병합·제거)는 원천 합이라 영향이 없다(운영과 같다).
--
-- P132 rd.entity_mention_total(entity_id, answers, mentions, updated_at): 위 정의의 엔티티별 합계(합계 0 = 행 없음).
-- P133 증분 원장 ing.entity_mention_delta(insert 전용): ing.mention·ing.answer_drop 의 문장 트리거가 바뀐 엔티티의 (답변 수, 언급 수) 차분을
--     쌓는다. 적재 마무리(ingest.common.db.finalize)가 rd.flush_entity_mention_total() 로 합계에 더하고 원장을 비운다.
--     재계산(엔티티 전 기간 재집계) 대신 차분인 이유: 거의 모든 적재가 자사(대형) 엔티티 언급을 바꾸므로 적재마다 그 엔티티 전 기간을
--     다시 세면 적재가 느려진다. 차분 원장은 insert 전용이라 동시 적재가 같은 합계 행에서 기다리지 않는다(합계 행 잠금은 finalize 짧은 구간).
--     차분이 정확한 조건: 적재기는 job 의 언급을 통째로 지우고 다시 넣는다(ingest/pull/sync/queries.py CHILDREN), (job, entity) 는 한 행
--     (운영 미러 PK (job_id, entity_id) 와 같은 원천 계약). 전수 동치는 rd.assert_entity_mention_total() 이 단언한다.
-- P134 rd.entity_mention_total_expected(ids)·rd.refresh_entity_mention_total(ids)(NULL = 전체 재계산, 이관·재구축·복구)·
--     rd.flush_entity_mention_total()(finalize)·rd.assert_entity_mention_total()(증분 = 전체 단언). flush·refresh 는 같은 권고 잠금
--     (hashtextextended('rd.entity_mention_total', 0), 트랜잭션 끝까지)으로 직렬화한다(동시 적재 검증 CE24).
--     트리거 밖 쓰기(TRUNCATE·leaf 파티션 직접 쓰기)는 차분을 남기지 않는다: 그런 경로(seed-20 이관, 소유자 실행)는 끝에 refresh(NULL) 를 부르고,
--     leaf 직접 쓰기는 tests/core/test_entity_total_writers.py 가 정적으로 금지하고 P136 이 권한으로 막는다.
-- P135 결과 캐시 추적(DB-v2.11 P67 규약: 문장 트리거 4개). 관리 목록이 바로 읽는 표다.
-- P136 ing 하위 파티션(월 leaf, ing.answer·mention·mention_occurrence·answer_stance·citation·ga4_row·hub_match) 쓰기 권한 회수(loader·migrator,
--     INSERT·UPDATE·DELETE·TRUNCATE). 엔티티 합계 트리거는 ing.mention 부모 문장 트리거라 leaf 직접 쓰기가 차분을 우회한다(rd 사실 표는 DB-v2.21 P119).
--     부모 경유 쓰기(INSERT·UPDATE·DELETE·COPY)는 파티션 라우팅이 부모 권한만 보므로 적재에 영향 없다. 새 월 leaf 는 생성 함수가 만든 직후 같은
--     회수를 한다(기본 권한 ALTER DEFAULT PRIVILEGES … TO loader 가 새 leaf 에 쓰기를 주므로). 기본 권한 자체는 그대로 둔다(일반 ing 표 생성에 필요).
-- P137 mig.known_diff AD-2 행 삭제(DB-v2.6 P52, 엔티티 수치에 모수 게이트·창 집계를 거는 정의 변경 고지). 제품 결정 25(현행 재현)와 엔티티 관리
--     5차 항목 1(B안: 운영 listDiscoveredBrands 그대로 전 기간·게이트 없음, P132)로 대체돼 현행과 다르지 않다 = 고지 대상 아님.
-- 락: 새 표·함수·트리거 생성. ing.mention·ing.answer_drop 에 트리거를 거는 데 SHARE ROW EXCLUSIVE 를 잠깐 잡는다(적재를 멈춘 창에 적용).
-- 적용 절차(stg·prod): ① 이 패치 ② psql -f back/migration/fill-v225.sql(전체 재계산 + 단언).
--   ①과 ② 사이에 적재가 돌면 그 차분은 ②가 전체 재계산하며 비운다(재계산이 원장을 같이 비운다).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('frz.cell_web') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.24(frz.cell_web) 가 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('rd.entity_mention_total') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.25 엔티티 합계 이미 적용됨(rd.entity_mention_total 존재)';
  END IF;
END $v$;

-- ── P132 ──────────────────────────────────────────────────────────────────────
CREATE TABLE rd.entity_mention_total (
  entity_id uuid PRIMARY KEY,
  answers int4 NOT NULL CHECK (answers >= 0),             -- count(DISTINCT job_id)
  mentions int8 NOT NULL CHECK (mentions >= 0),           -- sum(mention_count)
  updated_at timestamptz NOT NULL DEFAULT now());
COMMENT ON TABLE rd.entity_mention_total IS
  '엔티티별 전 기간 합계(운영 listDiscoveredBrands 정의: Brand·표시명 있음, 드롭 답변 제외, 기간·게이트 없음). 관리 엔티티 목록 전용. DB-v2.25 P132';

-- ── P133 ──────────────────────────────────────────────────────────────────────
CREATE TABLE ing.entity_mention_delta (
  delta_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id uuid NOT NULL,
  d_answers int4 NOT NULL,
  d_mentions int8 NOT NULL);
COMMENT ON TABLE ing.entity_mention_delta IS
  'rd.entity_mention_total 증분 원장(insert 전용, ing.mention·ing.answer_drop 문장 트리거). finalize 가 flush 로 비운다. DB-v2.25 P133';

-- 언급 쓰기: 새 행은 더하고 옛 행은 뺀다(드롭 답변 행은 세지 않는다)
CREATE FUNCTION ing.tg_mention_total_delta() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO ing.entity_mention_delta (entity_id, d_answers, d_mentions)
    SELECT n.entity_id, count(DISTINCT n.job_id)::int4, coalesce(sum(n.mention_count), 0)::int8 FROM em_new n
     WHERE n.entity_type = 'Brand' AND n.display_name IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ing.answer_drop d WHERE d.job_id = n.job_id)
     GROUP BY n.entity_id;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    INSERT INTO ing.entity_mention_delta (entity_id, d_answers, d_mentions)
    SELECT o.entity_id, -count(DISTINCT o.job_id)::int4, -coalesce(sum(o.mention_count), 0)::int8 FROM em_old o
     WHERE o.entity_type = 'Brand' AND o.display_name IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ing.answer_drop d WHERE d.job_id = o.job_id)
     GROUP BY o.entity_id;
  END IF;
  RETURN NULL;
END $f$;
CREATE TRIGGER entity_total_ins AFTER INSERT ON ing.mention REFERENCING NEW TABLE AS em_new
  FOR EACH STATEMENT EXECUTE FUNCTION ing.tg_mention_total_delta();
CREATE TRIGGER entity_total_del AFTER DELETE ON ing.mention REFERENCING OLD TABLE AS em_old
  FOR EACH STATEMENT EXECUTE FUNCTION ing.tg_mention_total_delta();
CREATE TRIGGER entity_total_upd AFTER UPDATE ON ing.mention REFERENCING OLD TABLE AS em_old NEW TABLE AS em_new
  FOR EACH STATEMENT EXECUTE FUNCTION ing.tg_mention_total_delta();

-- 드롭 등록·해제: 그 답변의 언급을 빼고 더한다(ing.answer_key_map 으로 run_month 를 찾아 언급 PK 로 간다)
CREATE FUNCTION ing.tg_drop_total_delta() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO ing.entity_mention_delta (entity_id, d_answers, d_mentions)
    SELECT m.entity_id, -count(DISTINCT m.job_id)::int4, -coalesce(sum(m.mention_count), 0)::int8
      FROM (SELECT DISTINCT job_id FROM dr_new) d JOIN ing.answer_key_map k ON k.job_id = d.job_id
      JOIN ing.mention m ON m.run_month = k.run_month AND m.job_id = d.job_id
     WHERE m.entity_type = 'Brand' AND m.display_name IS NOT NULL
     GROUP BY m.entity_id;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    INSERT INTO ing.entity_mention_delta (entity_id, d_answers, d_mentions)
    SELECT m.entity_id, count(DISTINCT m.job_id)::int4, coalesce(sum(m.mention_count), 0)::int8
      FROM (SELECT DISTINCT job_id FROM dr_old) d JOIN ing.answer_key_map k ON k.job_id = d.job_id
      JOIN ing.mention m ON m.run_month = k.run_month AND m.job_id = d.job_id
     WHERE m.entity_type = 'Brand' AND m.display_name IS NOT NULL
     GROUP BY m.entity_id;
  END IF;
  RETURN NULL;
END $f$;
CREATE TRIGGER entity_total_ins AFTER INSERT ON ing.answer_drop REFERENCING NEW TABLE AS dr_new
  FOR EACH STATEMENT EXECUTE FUNCTION ing.tg_drop_total_delta();
CREATE TRIGGER entity_total_del AFTER DELETE ON ing.answer_drop REFERENCING OLD TABLE AS dr_old
  FOR EACH STATEMENT EXECUTE FUNCTION ing.tg_drop_total_delta();
CREATE TRIGGER entity_total_upd AFTER UPDATE ON ing.answer_drop REFERENCING OLD TABLE AS dr_old NEW TABLE AS dr_new
  FOR EACH STATEMENT EXECUTE FUNCTION ing.tg_drop_total_delta();

-- ── P134 ──────────────────────────────────────────────────────────────────────
CREATE FUNCTION rd.entity_mention_total_expected(p_ids uuid[])
  RETURNS TABLE (entity_id uuid, answers int4, mentions int8) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $f$
SELECT m.entity_id, count(DISTINCT m.job_id)::int4, coalesce(sum(m.mention_count), 0)::int8
  FROM ing.mention m
 WHERE m.entity_type = 'Brand' AND m.display_name IS NOT NULL
   AND (p_ids IS NULL OR m.entity_id = ANY (p_ids))
   AND NOT EXISTS (SELECT 1 FROM ing.answer_drop d WHERE d.job_id = m.job_id)
 GROUP BY m.entity_id
$f$;
COMMENT ON FUNCTION rd.entity_mention_total_expected(uuid[]) IS
  'rd.entity_mention_total 기대값(운영 listDiscoveredBrands 정의). 범위: 엔티티 집합, NULL = 전체. DB-v2.25 P134';

CREATE FUNCTION rd.refresh_entity_mention_total(p_ids uuid[]) RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE n_ins int; n_del int; n_upd int;
BEGIN
  IF p_ids IS NOT NULL AND cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;
  -- flush 와 같은 잠금(합계 표 쓰기 직렬화, 트랜잭션 끝까지). flush 안에서 부를 때는 이미 잡혀 있다(재진입)
  PERFORM pg_advisory_xact_lock(hashtextextended('rd.entity_mention_total', 0));
  CREATE TEMP TABLE IF NOT EXISTS _emt_exp (entity_id uuid PRIMARY KEY, answers int4, mentions int8) ON COMMIT DROP;
  TRUNCATE _emt_exp;
  INSERT INTO _emt_exp SELECT * FROM rd.entity_mention_total_expected(p_ids);
  -- 범위 재계산이 반영한 원장 차분은 지운다(전체면 원장 전부): 같은 변화를 두 번 더하지 않게
  IF p_ids IS NULL THEN
    DELETE FROM ing.entity_mention_delta;
  ELSE
    DELETE FROM ing.entity_mention_delta WHERE entity_id = ANY (p_ids);
  END IF;
  DELETE FROM rd.entity_mention_total t
   WHERE (p_ids IS NULL OR t.entity_id = ANY (p_ids))
     AND NOT EXISTS (SELECT 1 FROM _emt_exp e WHERE e.entity_id = t.entity_id);
  GET DIAGNOSTICS n_del = ROW_COUNT;
  UPDATE rd.entity_mention_total t SET answers = e.answers, mentions = e.mentions, updated_at = now()
    FROM _emt_exp e WHERE e.entity_id = t.entity_id AND (t.answers, t.mentions) IS DISTINCT FROM (e.answers, e.mentions);
  GET DIAGNOSTICS n_upd = ROW_COUNT;
  INSERT INTO rd.entity_mention_total (entity_id, answers, mentions)
  SELECT e.entity_id, e.answers, e.mentions FROM _emt_exp e ON CONFLICT (entity_id) DO NOTHING;
  GET DIAGNOSTICS n_ins = ROW_COUNT;
  RETURN n_ins + n_del + n_upd;
END $f$;
COMMENT ON FUNCTION rd.refresh_entity_mention_total(uuid[]) IS
  'rd.entity_mention_total 를 기대값으로 맞춘다(범위 안 바뀐 행만, NULL = 전체 재계산·원장 비움). 반환 = 바뀐 행 수. DB-v2.25 P134';

CREATE FUNCTION rd.flush_entity_mention_total() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE n int; n_ins int; fix uuid[]; n_fix int := 0;
BEGIN
  -- 동시 적재의 flush 직렬화(검증 CE24): 트랜잭션 끝까지 잡는 권고 잠금. 뒤 flush 는 앞 적재의 커밋을 기다린 뒤 문장마다 새 스냅샷(READ
  -- COMMITTED)으로 앞 적재가 만든 행을 본다. 잠금이 없으면 둘 다 같은 새 엔티티를 '없음'으로 보고, 늦은 쪽 INSERT 가 건너뛰거나 실패했다.
  -- 합계 행 갱신 순서가 하나로 고정되어 동시 flush 교착도 생기지 않는다. 잠금 구간 = finalize 끝 ~ 커밋(짧다)
  PERFORM pg_advisory_xact_lock(hashtextextended('rd.entity_mention_total', 0));
  CREATE TEMP TABLE IF NOT EXISTS _emt_d (entity_id uuid PRIMARY KEY, a int8, m int8) ON COMMIT DROP;
  TRUNCATE _emt_d;
  WITH d AS (DELETE FROM ing.entity_mention_delta RETURNING entity_id, d_answers, d_mentions)
  INSERT INTO _emt_d SELECT d.entity_id, sum(d.d_answers), sum(d.d_mentions) FROM d GROUP BY d.entity_id
   HAVING sum(d.d_answers) <> 0 OR sum(d.d_mentions) <> 0;
  -- 차분을 더하면 음수가 되는 엔티티 = 합계가 원천과 어긋나 있었다(전체 재계산 전 차분, 트리거 밖 쓰기). 적재를 실패시키지 않고 그 엔티티만
  -- 원천에서 다시 센다(정확한 값으로 복구)
  SELECT array_agg(x.entity_id) INTO fix FROM _emt_d x LEFT JOIN rd.entity_mention_total t ON t.entity_id = x.entity_id
   WHERE coalesce(t.answers, 0) + x.a < 0 OR coalesce(t.mentions, 0) + x.m < 0;
  IF fix IS NOT NULL THEN
    DELETE FROM _emt_d WHERE entity_id = ANY (fix);
    n_fix := rd.refresh_entity_mention_total(fix);
    RAISE WARNING 'rd.entity_mention_total: 음수가 되는 차분 % 엔티티 → 원천 재계산', cardinality(fix);
  END IF;
  -- 기존 행은 UPDATE(차분이 음수일 수 있다: INSERT … ON CONFLICT 는 제안 행에 CHECK 를 먼저 걸어 음수 차분이 실패한다), 새 엔티티는
  -- INSERT … ON CONFLICT DO UPDATE(가산): 잠금 밖 쓰기가 있어도 새 엔티티 몫이 사라지지 않는다(이 경로의 차분은 음수 검사를 지난 양수다)
  UPDATE rd.entity_mention_total t SET answers = t.answers + x.a::int4, mentions = t.mentions + x.m, updated_at = now()
    FROM _emt_d x WHERE x.entity_id = t.entity_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO rd.entity_mention_total AS t (entity_id, answers, mentions)
  SELECT x.entity_id, x.a::int4, x.m FROM _emt_d x
   WHERE NOT EXISTS (SELECT 1 FROM rd.entity_mention_total t2 WHERE t2.entity_id = x.entity_id) AND x.a >= 0 AND x.m >= 0
  ORDER BY x.entity_id
  ON CONFLICT (entity_id) DO UPDATE SET answers = t.answers + EXCLUDED.answers, mentions = t.mentions + EXCLUDED.mentions, updated_at = now();
  GET DIAGNOSTICS n_ins = ROW_COUNT;
  n := n + n_ins;
  DELETE FROM rd.entity_mention_total t USING _emt_d x WHERE t.entity_id = x.entity_id AND t.answers = 0 AND t.mentions = 0;
  RETURN n + n_fix;
END $f$;
COMMENT ON FUNCTION rd.flush_entity_mention_total() IS
  '증분 원장(ing.entity_mention_delta)을 합계에 더하고 비운다(적재 마무리 finalize 가 부른다). 반환 = 바뀐 엔티티 수. DB-v2.25 P134';

CREATE FUNCTION rd.assert_entity_mention_total() RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE bad int; n int;
BEGIN
  IF EXISTS (SELECT 1 FROM ing.entity_mention_delta) THEN
    RAISE EXCEPTION 'ing.entity_mention_delta 에 반영 전 차분이 있다(rd.flush_entity_mention_total() 뒤 단언)';
  END IF;
  SELECT count(*) INTO bad FROM (
    (SELECT entity_id, answers, mentions FROM rd.entity_mention_total EXCEPT SELECT * FROM rd.entity_mention_total_expected(NULL))
    UNION ALL
    (SELECT * FROM rd.entity_mention_total_expected(NULL) EXCEPT SELECT entity_id, answers, mentions FROM rd.entity_mention_total)) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'rd.entity_mention_total ≠ 기대값: % 행(refresh_entity_mention_total(NULL) 필요)', bad;
  END IF;
  SELECT count(*) INTO n FROM rd.entity_mention_total;
  RETURN n;
END $f$;
COMMENT ON FUNCTION rd.assert_entity_mention_total() IS 'rd.entity_mention_total = 기대값(전체) 단언. 반환 = 행 수. DB-v2.25 P134';

-- ── 소유자·권한 ─────────────────────────────────────────────────────────────
ALTER TABLE rd.entity_mention_total OWNER TO hmg_owner;
ALTER TABLE ing.entity_mention_delta OWNER TO hmg_owner;
ALTER FUNCTION ing.tg_mention_total_delta() OWNER TO hmg_owner;
ALTER FUNCTION ing.tg_drop_total_delta() OWNER TO hmg_owner;
ALTER FUNCTION rd.entity_mention_total_expected(uuid[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.refresh_entity_mention_total(uuid[]) OWNER TO hmg_owner;
ALTER FUNCTION rd.flush_entity_mention_total() OWNER TO hmg_owner;
ALTER FUNCTION rd.assert_entity_mention_total() OWNER TO hmg_owner;
GRANT SELECT ON rd.entity_mention_total TO api_ro, admin_long, loader, migrator;
GRANT SELECT ON ing.entity_mention_delta TO loader, migrator;
REVOKE EXECUTE ON FUNCTION ing.tg_mention_total_delta(), ing.tg_drop_total_delta(), rd.entity_mention_total_expected(uuid[]),
  rd.refresh_entity_mention_total(uuid[]), rd.flush_entity_mention_total(), rd.assert_entity_mention_total() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.entity_mention_total_expected(uuid[]), rd.refresh_entity_mention_total(uuid[]), rd.flush_entity_mention_total(),
  rd.assert_entity_mention_total() TO loader, migrator;

-- ── P135 결과 캐시 추적 ───────────────────────────────────────────────────────
DO $v$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rd.entity_mention_total'] LOOP
    INSERT INTO rcache.data_version (tbl, version) VALUES (t, 0);
    EXECUTE format('CREATE TRIGGER rcache_bump_ins AFTER INSERT ON %s REFERENCING NEW TABLE AS rc_rows '
                   'FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
    EXECUTE format('CREATE TRIGGER rcache_bump_upd AFTER UPDATE ON %s REFERENCING NEW TABLE AS rc_rows '
                   'FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
    EXECUTE format('CREATE TRIGGER rcache_bump_del AFTER DELETE ON %s REFERENCING OLD TABLE AS rc_rows '
                   'FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
    EXECUTE format('CREATE TRIGGER rcache_bump_trunc AFTER TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION rcache.tg_bump()', t);
  END LOOP;
END $v$;

-- ── P136 ing 하위 파티션 쓰기 권한 회수 ───────────────────────────────────────
DO $v$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.relid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             CROSS JOIN LATERAL pg_partition_tree(c.oid) p
            WHERE n.nspname = 'ing' AND c.relkind = 'p' AND NOT c.relispartition AND p.level > 0 LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %s FROM loader, migrator', r.relid::regclass);
  END LOOP;
END $v$;

-- 월 leaf 생성 함수(본문 = DB-v2.1 6-5·DB-v2.17 P100 그대로 + ing leaf 생성 직후 회수). 허용 목록·소유·권한 부여는 그대로다.
CREATE OR REPLACE FUNCTION rd.ensure_month_leaf(p_parent regclass, p_month date) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET TimeZone = 'UTC' AS $f$
DECLARE lo date := date_trunc('month', p_month)::date; hi date := (date_trunc('month', p_month) + interval '1 month')::date;
        nsp text; rel text; leaf text;
BEGIN
  IF p_parent NOT IN ('ing.answer'::regclass, 'ing.mention'::regclass, 'ing.mention_occurrence'::regclass, 'ing.answer_stance'::regclass,
                      'ing.citation'::regclass, 'ing.ga4_row'::regclass, 'rd.ga4_row'::regclass, 'app.access_audit_log'::regclass,
                      'ext.dfs_call'::regclass) THEN
    RAISE EXCEPTION 'ensure_month_leaf 허용 목록 밖: %', p_parent;
  END IF;
  SELECT n.nspname, c.relname INTO nsp, rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = p_parent;
  leaf := rel || '_' || to_char(lo, 'YYYYMM');
  IF to_regclass(format('%I.%I', nsp, leaf)) IS NULL THEN
    EXECUTE format('CREATE TABLE %I.%I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)', nsp, leaf, p_parent, lo, hi);
    IF nsp = 'ing' THEN    -- DB-v2.25 P136: ing leaf 직접 쓰기 금지(부모로만, 엔티티 합계 트리거 우회 차단)
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I.%I FROM loader, migrator', nsp, leaf);
    END IF;
  END IF;
END $f$;

CREATE OR REPLACE FUNCTION rd.ensure_hub_match_leaf(p_month date) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE lo date := date_trunc('month', p_month)::date; hi date := (date_trunc('month', p_month) + interval '1 month')::date;
        leaf text := 'hub_match_' || to_char(date_trunc('month', p_month), 'YYYYMM');
BEGIN
  IF to_regclass('ing.' || leaf) IS NULL THEN                -- 카탈로그 선확인(IF NOT EXISTS 는 락을 먼저 잡는다)
    EXECUTE format('CREATE TABLE ing.%I PARTITION OF ing.hub_match FOR VALUES FROM (%L) TO (%L)', leaf, lo, hi);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ing.%I FROM loader, migrator', leaf);   -- DB-v2.25 P136
  END IF;
END $f$;

-- ── P137 mig.known_diff AD-2 정리 ─────────────────────────────────────────────
DELETE FROM mig.known_diff WHERE rule_id = 'AD-2' AND feature_id = 'admin.entities.registry';

-- ── 사후 단언(구조) ─────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'rd.entity_mention_total'::regclass)) <> 'hmg_owner'
     OR NOT has_table_privilege('api_ro', 'rd.entity_mention_total', 'select')
     OR has_table_privilege('api_ro', 'rd.entity_mention_total', 'insert')
     OR NOT has_function_privilege('loader', 'rd.flush_entity_mention_total()', 'execute')
     OR has_function_privilege('api_ro', 'rd.flush_entity_mention_total()', 'execute') THEN
    RAISE EXCEPTION 'P132~P134 실패: 소유자·권한';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'entity_total_%'
        AND tgrelid IN ('ing.mention'::regclass, 'ing.answer_drop'::regclass)) <> 6 THEN
    RAISE EXCEPTION 'P133 실패: 증분 트리거';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'rd.entity_mention_total'::regclass AND tgname LIKE 'rcache_bump_%') <> 4 THEN
    RAISE EXCEPTION 'P135 실패: 결과 캐시 추적 트리거';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace CROSS JOIN LATERAL pg_partition_tree(c.oid) p
              CROSS JOIN unnest('{loader,migrator}'::text[]) u(r)
             WHERE n.nspname = 'ing' AND c.relkind = 'p' AND NOT c.relispartition AND p.level > 0
               AND (has_table_privilege(u.r, p.relid, 'INSERT') OR has_table_privilege(u.r, p.relid, 'UPDATE')
                    OR has_table_privilege(u.r, p.relid, 'DELETE') OR has_table_privilege(u.r, p.relid, 'TRUNCATE')))
     OR NOT has_table_privilege('loader', 'ing.mention', 'insert') OR NOT has_table_privilege('loader', 'ing.mention', 'delete') THEN
    RAISE EXCEPTION 'P136 실패: ing 하위 파티션 쓰기 권한';
  END IF;
  IF EXISTS (SELECT 1 FROM mig.known_diff WHERE rule_id = 'AD-2') THEN
    RAISE EXCEPTION 'P137 실패: AD-2 행 남음';
  END IF;
END $v$;

COMMIT;
