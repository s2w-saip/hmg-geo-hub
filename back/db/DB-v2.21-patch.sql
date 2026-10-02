-- ============================================================================
-- hmg-geo 재설계 보완 패치 DB-v2.21 (PostgreSQL 17, 2026-10-01) · 카드 경로 동결 층 S1(제품 결정 31·32)
-- 번호: P114~P119. 적용 순서: DB-v2.20 뒤 1회(트랜잭션 1개). 합본 DB-v2.21.sql = DB-v2.20.sql + 이 파일(바이트 연결).
-- 근거: 설계 card-snapshot-design.md 12장(결정 32: 사실 행 전체 복사 기각, 회차별 집계 대상 목록 고정 + 생성 뒤 바뀐 답변만 옛 행 보관).
--
-- 무엇을 위한가: 운영 생성기(hmg-geo 2670a16 lib/summary/generate)는 회차 발행 때 셀 집합(셀당 대표 답변 1건)·프롬프트 축(in_full_cycle 등)·
--   판정 입력을 세대로 굳힌다. 발행 뒤 바뀐 측정·분석·판정은 카드 값에 들어가지 않는다(재생성 --cycle 때만). 허브 카드 경로가 같은 값을
--   내려면 같은 것을 굳혀야 한다. 사실 행 전체 사본(약 1.35GB) 대신 아래만 둔다.
--     · 회차 셀 집합(frz.cell)과 회차 × 프롬프트 축(frz.prompt), 세대 메타(frz.generation, 판정 입력 버전 포인터 포함)
--     · 보관(frz.kept + frz.keep_answer·keep_answer_brand·keep_citation): 동결된 답변의 rd 사실 행이 처음 다시 쓰이기 직전 값 한 벌, (세대, 답변) 단위.
--       사실 쓰기의 단일 관문(적재 ingest.project.apply.service._write_facts, bulk 재구축 seed-30·40)이 다시 쓰기 직전에 frz.keep_rewrite 로
--       복사하고, 쓰기 뒤 값이 같으면 frz.keep_settle 로 정리한다(비용 ∝ 다시 쓰는 동결 답변 수). rd 사실 표에 트리거는 없다(설계 12.11).
--   읽기(S3): frz.answer·frz.answer_brand·frz.citation 뷰 = 활성 세대 셀의 rd 행(그 세대 보관 없음) ∪ 그 세대 보관 행. 열 모양은 rd 와 같다
--   (is_rep 은 참, 회차 좌석 round_date·cyc_key 는 셀 값). core.facts 의 표 이름 자리만 바꾸면 같은 SQL 이 돈다.
--
-- P114 frz 스키마 · frz.generation(세대, 회차 동결 표시 = state 'active') · frz.cell(셀 집합) · frz.prompt(프롬프트 축) · frz.ops_judgment(운영 판정 입력 사본)
-- P115 frz.kept(보관 표시, (세대, 답변)당 1행 = 첫 보관만) · frz.keep_answer·keep_answer_brand·keep_citation(LIKE rd.* + gen_key)
-- P116 frz.answer·frz.answer_brand·frz.citation 동결 읽기 뷰(열 목록은 이 DB 의 rd 카탈로그에서 만든다)
-- P117 보관 관문(명시 호출): frz.keep_rewrite(키, src)·frz.keep_settle(키, src) + frz._claim(세대, 키, src)(이관 ops·seat) + frz._value_cols.
--      SECURITY DEFINER(hmg_owner): rd 를 쓰는 롤에 frz 쓰기 권한을 주지 않는다. 비교에서 빼는 장부 열 = is_rep·load_id·ecat_ver·rule_ver.
-- P118 운영 함수: frz.activate(세대) · frz.release(세대, 사유)(재생성 때만 그 세대 보관 해제) · frz.assert_generation(세대)(구조 단언)
--      · frz.assert_shape()(보관 표·뷰 열 = rd 열, rd 사실 표 frz 트리거 없음, 하위 파티션 쓰기 권한 없음)
-- P119 소유자·권한 · rd 사실 표 하위 파티션 쓰기 권한 회수(loader·migrator, rd.ensure_leaf 새 리프 포함) · 결과 캐시 추적(frz.generation) · 사후 단언
--
-- 규모(운영 미러 2026-10-01 읽기 전용 실측, 활성 세대 924): 셀 472,083 · 프롬프트 축 362,209 · 판정 입력 사본 3.3MB.
--   생성 뒤 바뀐 답변: 동기화 지문이 바뀐 run 의 답변 1,066(0.23%) 중 값이 실제로 다른 답변 562(0.12%, 전부 언급 계열, 인용 변화 0).
-- 락: 새 스키마·표·뷰·함수 + rd 사실 표 하위 파티션 REVOKE(카탈로그만) + rd.ensure_leaf 교체. 기존 표 ALTER·트리거 없음. lock_timeout 30s.
-- 비용: 관문 밖 rd 쓰기에는 비용이 없다(트리거 없음). 관문 비용 = 다시 쓰는 답변 중 동결 셀 답변 수에 비례(복사·비교 2만 개 단위).
-- 한계(문서화, 설계 12.11): 관문 밖 쓰기(직접 SQL·DB 채우기 함수·fill-v2xx 이관 스크립트·한 문장 다표 데이터 변경 CTE)는 보관하지 않는다.
--   API 는 SQL 경계 가드 G6, 적재 코드는 정적 가드(tests/core/test_frz_keep_gate.py), 리프 직접 쓰기는 권한(P119)이 막는다. superuser·소유자는 막지 않는다.
--   rd 사실 표에 열을 더하는 뒤 패치는 frz.keep_* 와 뷰를 같이 갱신해야 한다(frz.assert_shape 가 CI 에서 잡는다).
-- 적용 절차(stg·prod): ① 적재 워커 정지 ② 이 패치(migrator 또는 superuser) ③ SELECT frz.assert_shape() ④ 워커 재개(이 패치를 아는 코드 배포 뒤).
--   이관 적재(운영 세대 → frz)는 python -m ingest.cli frz-import-ops(드라이런 기본, migrator) 로 따로 한다(제품 책임자 승인 배치).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('rd.web_target_url') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.20(rd.web_target_url) 이 먼저 적용돼야 한다';
  END IF;
  IF to_regnamespace('frz') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.21 이미 적용됨(frz 스키마 존재)';
  END IF;
END $v$;

-- ── P114 ─────────────────────────────────────────────────────────────────────
CREATE SCHEMA frz;
COMMENT ON SCHEMA frz IS '카드 경로 동결 층(결정 31·32): 회차 셀 집합·프롬프트 축·세대 + 생성 뒤 바뀐 답변의 옛 행 보관. DB-v2.21';

CREATE TABLE frz.generation (
  gen_key int4 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cyc_key int4 NOT NULL,                                  -- rd.cycle.cyc_key(= ing.cycle.cyc_key). FK 없음(bulk 시드의 rd.cycle TRUNCATE 를 막지 않게)
  surface int2 NOT NULL CHECK (surface IN (1, 2, 3)),
  source text NOT NULL CHECK (source IN ('ops', 'hub')),  -- ops = 운영 summary 활성 세대 이관, hub = 허브 발행(S2)
  state text NOT NULL DEFAULT 'building' CHECK (state IN ('building', 'active', 'retired')),
  ops_cycle_id uuid, ops_generation_id uuid, ops_generator_version text, ops_started_at timestamptz, ops_finished_at timestamptz,
  judgment jsonb NOT NULL DEFAULT '{}'::jsonb,            -- 판정 입력 버전 포인터(ops: 운영 세대 id·스냅샷 md5, hub: ecat 활성 버전·rule_ver)
  row_counts jsonb,                                       -- 세대 행 수(셀·프롬프트·보관 출처별)
  verify jsonb,                                           -- 이관 단언 결과(축 합 대조)
  created_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz, retired_at timestamptz, retired_reason text,
  CHECK ((source = 'ops') = (ops_generation_id IS NOT NULL)),
  CHECK (state <> 'active' OR (activated_at IS NOT NULL AND retired_at IS NULL)),
  CHECK (state <> 'retired' OR retired_at IS NOT NULL));
CREATE UNIQUE INDEX generation_active_uq ON frz.generation (cyc_key) WHERE state = 'active';
CREATE UNIQUE INDEX generation_building_uq ON frz.generation (cyc_key) WHERE state = 'building';
CREATE INDEX generation_ops_idx ON frz.generation (ops_generation_id) WHERE ops_generation_id IS NOT NULL;
COMMENT ON TABLE frz.generation IS '동결 세대(회차당 활성 1개 = 회차 동결 표시). 운영 summary_generations 대응. DB-v2.21 P114';

CREATE TABLE frz.cell (
  gen_key int4 NOT NULL REFERENCES frz.generation,
  answer_key int4 NOT NULL,                               -- 셀 대표 답변(rd.job·rd.answer 키)
  surface int2 NOT NULL, cyc_key int4 NOT NULL,
  round_date date NOT NULL,                               -- 동결 좌석(rd.cycle.round_date). rd 행이 다른 좌석이면 이관 때 보관(src 'seat')으로 옮긴다
  prompt_key int4 NOT NULL, engine_key int2 NOT NULL, geo_key int2 NOT NULL,
  PRIMARY KEY (gen_key, answer_key));
CREATE INDEX cell_answer_idx ON frz.cell (answer_key);
CREATE INDEX cell_seat_idx ON frz.cell (surface, cyc_key, round_date) INCLUDE (answer_key, gen_key);
COMMENT ON TABLE frz.cell IS '회차 셀 집합(셀당 대표 답변 1건, 운영 summary_cycle_jobs 대응). 게이트는 읽을 때 건다. DB-v2.21 P114';

CREATE TABLE frz.prompt (
  gen_key int4 NOT NULL REFERENCES frz.generation,
  prompt_key int4 NOT NULL, cyc_key int4 NOT NULL,
  in_full_cycle bool NOT NULL, expected_cells int4, window_cells int4,
  in_root_catalog bool NOT NULL, catalog_deleted bool NOT NULL,
  cat_mask int2 NOT NULL DEFAULT 0,                        -- 카탈로그 브랜드 비트(운영 catalog_brands, 삭제 행 포함 = 운영 조회 필터와 같은 집합)
  funnel_key int2 NOT NULL DEFAULT 0, presence_key int2, list_type_key int2, depth1_key int2, depth2_key int2, depth3_key int2,
  regions text[], is_korean bool, report_fs int4,
  src jsonb NOT NULL DEFAULT '{}'::jsonb,                  -- 운영 원값(코드 문자열·사이트·유닛 base 등 감사·대조용)
  PRIMARY KEY (gen_key, prompt_key));
CREATE INDEX prompt_cyc_idx ON frz.prompt (cyc_key, prompt_key);
COMMENT ON TABLE frz.prompt IS '회차 × 프롬프트 축(in_full_cycle·카탈로그·퍼널·depth·report_fs, 운영 summary_prompt_dim 대응). DB-v2.21 P114';

CREATE TABLE frz.ops_judgment (
  gen_key int4 PRIMARY KEY REFERENCES frz.generation,
  roster_snapshot jsonb, base_universe jsonb, target_universe jsonb, noise_snapshot jsonb);
COMMENT ON TABLE frz.ops_judgment IS '운영 세대 판정 입력 사본(감사용, 읽기 경로는 쓰지 않는다). DB-v2.21 P114';

-- ── P115 ─────────────────────────────────────────────────────────────────────
-- 보관 키 = (세대, 답변). 같은 답변이 두 활성 세대의 셀이면 세대마다 따로 보관한다(뒤에 동결한 세대가 앞 세대의 옛 보관 값을 읽지 않는다).
CREATE TABLE frz.kept (
  gen_key int4 NOT NULL REFERENCES frz.generation,
  answer_key int4 NOT NULL,
  src text NOT NULL CHECK (src IN ('apply', 'bulk', 'ops', 'seat')),
  kept_at timestamptz NOT NULL DEFAULT now(), txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  PRIMARY KEY (gen_key, answer_key));
CREATE INDEX kept_answer_idx ON frz.kept (answer_key);
COMMENT ON TABLE frz.kept IS
  '보관 표시(이 세대의 이 답변은 rd 대신 frz.keep_* 를 읽는다, (세대, 답변)당 1행 = 첫 보관만). apply = 적재 관문(_write_facts)의 다시 쓰기 직전, '
  'bulk = bulk 재구축(seed-30·40) 직전, ops = 운영 세부층 이관, seat = rd 좌석이 동결 좌석과 다름. DB-v2.21 P115';

-- 보관 행 = rd 와 같은 열(같은 순서) + 끝에 gen_key. 생성 열은 없다(rd 사실 표에 생성 열이 없다)
CREATE TABLE frz.keep_answer (LIKE rd.answer, gen_key int4 NOT NULL);
CREATE TABLE frz.keep_answer_brand (LIKE rd.answer_brand, gen_key int4 NOT NULL);
CREATE TABLE frz.keep_citation (LIKE rd.citation, gen_key int4 NOT NULL);
CREATE INDEX keep_answer_key_idx ON frz.keep_answer (gen_key, answer_key);
CREATE INDEX keep_answer_brand_key_idx ON frz.keep_answer_brand (gen_key, answer_key);
CREATE INDEX keep_citation_key_idx ON frz.keep_citation (gen_key, answer_key);
COMMENT ON TABLE frz.keep_answer IS '보관 답변 행(rd.answer 와 같은 열 + gen_key). DB-v2.21 P115';
COMMENT ON TABLE frz.keep_answer_brand IS '보관 답변 브랜드 행(rd.answer_brand 와 같은 열 + gen_key). DB-v2.21 P115';
COMMENT ON TABLE frz.keep_citation IS '보관 인용 행(rd.citation 와 같은 열 + gen_key). DB-v2.21 P115';

-- ── P116 동결 읽기 뷰 ─────────────────────────────────────────────────────────
-- rd 갈래: 활성 세대 셀 ∧ 그 세대 보관 없음. 좌석(round_date·cyc_key)을 조인 조건에 넣어 읽기 술어가 rd 파티션 가지치기·색인으로 내려간다
--   (보관 관문·이관이 "보관 없는 셀의 rd 행 좌석 = 셀 좌석" 을 지킨다: 좌석을 옮기는 다시 쓰기는 관문이 옮기기 직전 값을 보관한다).
--   보관 갈래: 그 세대 보관 행, 좌석은 셀 값. 두 갈래 모두 is_rep = 참. 열 목록 = rd 열(보관 표의 gen_key 는 내지 않는다).
DO $v$
DECLARE t text; rd_cols text; kp_cols text;
BEGIN
  FOREACH t IN ARRAY '{answer,answer_brand,citation}'::text[] LOOP
    SELECT string_agg(CASE WHEN a.attname = 'is_rep' THEN 'true AS is_rep' ELSE 'x.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum),
           string_agg(CASE a.attname WHEN 'is_rep' THEN 'true AS is_rep' WHEN 'round_date' THEN 'c.round_date'
                                     WHEN 'cyc_key' THEN 'c.cyc_key' ELSE 'k.' || quote_ident(a.attname) END, ', ' ORDER BY a.attnum)
      INTO rd_cols, kp_cols
      FROM pg_attribute a WHERE a.attrelid = format('rd.%I', t)::regclass AND a.attnum > 0 AND NOT a.attisdropped;
    EXECUTE format(
      'CREATE VIEW frz.%1$I AS '
      'SELECT %2$s FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = ''active'' '
      'JOIN rd.%1$I x ON x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key AND x.answer_key = c.answer_key '
      'WHERE NOT EXISTS (SELECT 1 FROM frz.kept p WHERE p.gen_key = c.gen_key AND p.answer_key = c.answer_key) '
      'UNION ALL '
      'SELECT %3$s FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = ''active'' '
      'JOIN frz.%4$I k ON k.gen_key = c.gen_key AND k.answer_key = c.answer_key',
      t, rd_cols, kp_cols, 'keep_' || t);
    EXECUTE format('COMMENT ON VIEW frz.%I IS %L', t,
                   format('동결 읽기(rd.%s 와 같은 열): 활성 세대 셀의 rd 행(그 세대 보관 없음) ∪ 그 세대 보관 행. is_rep 참, 좌석 = 셀. DB-v2.21 P116', t));
  END LOOP;
END $v$;

-- ── P117 보관 관문(명시 호출) ──────────────────────────────────────────────────
-- 사실 쓰기의 단일 관문(ingest.project.apply.service._write_facts, bulk 재구축 seed-30·40)이 다시 쓰기 직전·직후에 부른다. rd 사실 표에 트리거는
-- 없다(S1 첫 판의 문장 트리거·BEFORE TRUNCATE 를 걷어냈다: 운영 규모에서 전이 표 비용이 동결 셀 유무와 무관하게 전 문장에 붙었다, 설계 12.11).
--   frz.keep_rewrite(키, src)  다시 쓸 답변 ∩ 활성 세대 셀 ∩ 그 세대 보관 없음 ∩ 셀 좌석에 rd 답변 행 있음 → 보관 표시 + 지금 rd 세 표 행 복사.
--                              비용 ∝ 넘긴 키 중 동결 답변 수(frz.cell (answer_key) 색인, rd 는 셀 좌석 PK 접두로 찾는다).
--   frz.keep_settle(키, src)   그 키의 같은 src 보관 중 지금 rd 값(장부 열 제외)이 보관과 같은 것을 정리. apply 는 이 트랜잭션에서 잡은 것만,
--                              bulk 는 src 'bulk' 전부(seed-30 과 seed-40 은 트랜잭션이 다르다). 비교 = 답변 단위로 2만 개씩 끊은 다중집합 차(EXCEPT ALL).
--   장부 열(값 비교에서 뺀다, 조회가 읽지 않는다): is_rep(동결 뷰는 참 고정)·load_id(적재 번호)·ecat_ver(엔티티 반영 원장)·rule_ver(규칙 세트 번호).
-- 관문 밖 쓰기(직접 SQL·DB 채우기 함수·fill-v2xx 이관 스크립트·다표 데이터 변경 CTE)는 보관하지 않는다: 문서(설계 12.11)·SQL 경계 가드 G6(API)·
--   적재 코드 정적 가드(tests/core/test_frz_keep_gate.py)·리프 DML 권한 회수(P119)로 막는다. 이관 작업은 보관 비대상이 의도다(12.11 위험).

-- 값 비교 열(장부 열 제외, rd 열 순서). 표마다 동적 SQL 에 쓴다
CREATE FUNCTION frz._value_cols(p_tbl text, p_alias text) RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $f$
  SELECT string_agg(p_alias || '.' || quote_ident(a.attname), ', ' ORDER BY a.attnum)
    FROM pg_attribute a
   WHERE a.attrelid = format('rd.%I', p_tbl)::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('is_rep', 'load_id', 'ecat_ver', 'rule_ver')
$f$;

-- 보관 선점(세대 단위, 이관 ops·좌석 seat 경로): 아직 보관 없는 (세대, 답변)만 표시를 넣고 이번에 넣은 답변 키를 돌려준다
CREATE FUNCTION frz._claim(p_gen int4, p_keys int4[], p_src text) RETURNS int4[]
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
  WITH ins AS (
    INSERT INTO frz.kept (gen_key, answer_key, src)
    SELECT DISTINCT p_gen, k, p_src FROM unnest(p_keys) k
    ON CONFLICT (gen_key, answer_key) DO NOTHING
    RETURNING answer_key)
  SELECT coalesce(array_agg(answer_key ORDER BY answer_key), '{}'::int4[]) FROM ins
$f$;

CREATE FUNCTION frz.keep_rewrite(p_keys int4[], p_src text) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE n int;
BEGIN
  IF p_src NOT IN ('apply', 'bulk') THEN
    RAISE EXCEPTION 'frz.keep_rewrite: src 는 apply·bulk(이관 ops·seat 는 frz._claim)';
  END IF;
  IF p_keys IS NULL OR cardinality(p_keys) = 0 OR NOT EXISTS (SELECT 1 FROM frz.generation WHERE state = 'active') THEN
    RETURN 0;
  END IF;
  WITH t AS (
    SELECT c.gen_key, c.answer_key, c.surface, c.round_date, c.cyc_key
      FROM frz.cell c JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = 'active'
     WHERE c.answer_key = ANY (p_keys)
       AND NOT EXISTS (SELECT 1 FROM frz.kept p WHERE p.gen_key = c.gen_key AND p.answer_key = c.answer_key)
       AND EXISTS (SELECT 1 FROM rd.answer x WHERE x.surface = c.surface AND x.round_date = c.round_date AND x.answer_key = c.answer_key
                                               AND x.cyc_key = c.cyc_key)),
  k AS (INSERT INTO frz.kept (gen_key, answer_key, src) SELECT gen_key, answer_key, p_src FROM t
        ON CONFLICT (gen_key, answer_key) DO NOTHING RETURNING gen_key, answer_key),
  s AS (SELECT t.* FROM t JOIN k USING (gen_key, answer_key)),
  ka AS (INSERT INTO frz.keep_answer SELECT x.*, s.gen_key FROM s
           JOIN rd.answer x ON x.surface = s.surface AND x.round_date = s.round_date AND x.answer_key = s.answer_key AND x.cyc_key = s.cyc_key),
  kb AS (INSERT INTO frz.keep_answer_brand SELECT x.*, s.gen_key FROM s
           JOIN rd.answer_brand x ON x.surface = s.surface AND x.round_date = s.round_date AND x.answer_key = s.answer_key AND x.cyc_key = s.cyc_key),
  kc AS (INSERT INTO frz.keep_citation SELECT x.*, s.gen_key FROM s
           JOIN rd.citation x ON x.surface = s.surface AND x.round_date = s.round_date AND x.answer_key = s.answer_key AND x.cyc_key = s.cyc_key)
  SELECT count(*) INTO n FROM k;
  RETURN n;
END $f$;
COMMENT ON FUNCTION frz.keep_rewrite(int4[], text) IS
  '보관 관문 앞: 다시 쓸 답변 ∩ 활성 세대 셀 ∩ 그 세대 보관 없음 → 보관 표시 + 지금 rd 세 표 행 복사. 반환 = 보관한 (세대, 답변) 수. DB-v2.21 P117';

CREATE FUNCTION frz.keep_settle(p_keys int4[], p_src text) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE gs int4[]; ks int4[]; cg int4[]; ck int4[]; dg int4[]; dk int4[]; i int := 1; step int := 20000; n int := 0; m int;
        t text; q text := ''; part text;
BEGIN
  IF p_src NOT IN ('apply', 'bulk') THEN
    RAISE EXCEPTION 'frz.keep_settle: src 는 apply·bulk';
  END IF;
  IF p_keys IS NULL AND p_src <> 'bulk' THEN
    RAISE EXCEPTION 'frz.keep_settle: apply 는 키 필수';
  END IF;
  SELECT array_agg(p.gen_key ORDER BY p.gen_key, p.answer_key), array_agg(p.answer_key ORDER BY p.gen_key, p.answer_key) INTO gs, ks
    FROM frz.kept p
   WHERE p.src = p_src AND (p_keys IS NULL OR p.answer_key = ANY (p_keys))
     AND (p_src = 'bulk' OR p.txid = pg_current_xact_id());
  IF gs IS NULL THEN RETURN 0; END IF;
  -- 다른 (세대, 답변) = 세 표 중 하나라도 보관 행 다중집합 ≠ 셀 좌석의 지금 rd 행 다중집합(장부 열 제외)
  FOREACH t IN ARRAY '{answer,answer_brand,citation}'::text[] LOOP
    part := format(
      'SELECT gen_key, answer_key FROM ((SELECT k.gen_key, %1$s FROM frz.%3$I k JOIN cand USING (gen_key, answer_key) '
      'EXCEPT ALL SELECT s.gen_key, %2$s FROM seat s JOIN rd.%4$I x ON x.surface = s.surface AND x.round_date = s.round_date '
      'AND x.answer_key = s.answer_key AND x.cyc_key = s.cyc_key) '
      'UNION ALL (SELECT s.gen_key, %2$s FROM seat s JOIN rd.%4$I x ON x.surface = s.surface AND x.round_date = s.round_date '
      'AND x.answer_key = s.answer_key AND x.cyc_key = s.cyc_key '
      'EXCEPT ALL SELECT k.gen_key, %1$s FROM frz.%3$I k JOIN cand USING (gen_key, answer_key))) d',
      frz._value_cols(t, 'k'), frz._value_cols(t, 'x'), 'keep_' || t, t);
    q := q || CASE WHEN q = '' THEN '' ELSE ' UNION ' END || part;
  END LOOP;
  q := 'WITH cand AS (SELECT * FROM unnest($1::int4[], $2::int4[]) AS u(gen_key, answer_key)), '
       'seat AS (SELECT c.gen_key, c.answer_key, c.surface, c.round_date, c.cyc_key FROM frz.cell c JOIN cand USING (gen_key, answer_key)), '
       'diff AS (' || q || ') '
       'SELECT array_agg(c.gen_key), array_agg(c.answer_key) FROM cand c WHERE NOT EXISTS (SELECT 1 FROM diff d WHERE d.gen_key = c.gen_key '
       'AND d.answer_key = c.answer_key)';
  WHILE i <= cardinality(gs) LOOP
    cg := gs[i:i + step - 1];
    ck := ks[i:i + step - 1];
    EXECUTE q INTO dg, dk USING cg, ck;
    IF dg IS NOT NULL THEN
      DELETE FROM frz.keep_answer k USING unnest(dg, dk) AS u(g, a) WHERE k.gen_key = u.g AND k.answer_key = u.a;
      DELETE FROM frz.keep_answer_brand k USING unnest(dg, dk) AS u(g, a) WHERE k.gen_key = u.g AND k.answer_key = u.a;
      DELETE FROM frz.keep_citation k USING unnest(dg, dk) AS u(g, a) WHERE k.gen_key = u.g AND k.answer_key = u.a;
      DELETE FROM frz.kept k USING unnest(dg, dk) AS u(g, a) WHERE k.gen_key = u.g AND k.answer_key = u.a;
      GET DIAGNOSTICS m = ROW_COUNT;
      n := n + m;
    END IF;
    i := i + step;
  END LOOP;
  RETURN n;
END $f$;
COMMENT ON FUNCTION frz.keep_settle(int4[], text) IS
  '보관 관문 뒤: 그 키의 같은 src 보관 중 지금 rd 값(장부 열 is_rep·load_id·ecat_ver·rule_ver 제외)이 같은 것을 정리. apply = 이 트랜잭션에서 '
  '잡은 것만, bulk = 전부(키 NULL 허용). 2만 (세대, 답변)씩 끊어 비교. 반환 = 정리한 수. DB-v2.21 P117';

-- ── P118 운영 함수 ────────────────────────────────────────────────────────────
-- 활성화: 같은 회차의 활성 세대가 남아 있으면 거부(재생성은 release → 새 세대 → activate 를 한 트랜잭션으로).
CREATE FUNCTION frz.activate(p_gen int4) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE g record;
BEGIN
  SELECT * INTO g FROM frz.generation WHERE gen_key = p_gen FOR UPDATE;
  IF NOT FOUND OR g.state <> 'building' THEN
    RAISE EXCEPTION 'frz.activate: 세대 % 이(가) building 이 아니다', p_gen;
  END IF;
  IF EXISTS (SELECT 1 FROM frz.generation WHERE cyc_key = g.cyc_key AND state = 'active') THEN
    RAISE EXCEPTION 'frz.activate: 회차 % 에 활성 세대가 있다(먼저 frz.release)', g.cyc_key;
  END IF;
  UPDATE frz.generation SET state = 'active', activated_at = now() WHERE gen_key = p_gen;
END $f$;

-- 해제(재생성 때만): 이 세대의 보관을 지운다(보관은 세대 단위라 다른 세대 보관은 그대로) → 셀·프롬프트 삭제 → retired.
CREATE FUNCTION frz.release(p_gen int4, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE n_cell int; n_prompt int; n_kept int; st text;
BEGIN
  SELECT state INTO st FROM frz.generation WHERE gen_key = p_gen FOR UPDATE;
  IF st IS NULL OR st = 'retired' THEN
    RAISE EXCEPTION 'frz.release: 세대 % 없음 또는 이미 retired', p_gen;
  END IF;
  IF coalesce(p_reason, '') = '' THEN
    RAISE EXCEPTION 'frz.release: 사유 필수(재생성·재해석 등)';
  END IF;
  DELETE FROM frz.keep_answer WHERE gen_key = p_gen;
  DELETE FROM frz.keep_answer_brand WHERE gen_key = p_gen;
  DELETE FROM frz.keep_citation WHERE gen_key = p_gen;
  DELETE FROM frz.kept WHERE gen_key = p_gen;
  GET DIAGNOSTICS n_kept = ROW_COUNT;
  DELETE FROM frz.cell WHERE gen_key = p_gen;
  GET DIAGNOSTICS n_cell = ROW_COUNT;
  DELETE FROM frz.prompt WHERE gen_key = p_gen;
  GET DIAGNOSTICS n_prompt = ROW_COUNT;
  DELETE FROM frz.ops_judgment WHERE gen_key = p_gen;
  UPDATE frz.generation SET state = 'retired', retired_at = now(), retired_reason = p_reason WHERE gen_key = p_gen;
  RETURN jsonb_build_object('gen_key', p_gen, 'cells', n_cell, 'prompts', n_prompt, 'kept_released', n_kept);
END $f$;

-- 세대 구조 단언(활성·빌드 중 모두): 셀마다 답변 행 정확히 1개(rd 갈래 또는 보관 갈래), 보관 표시 셀은 보관 답변 행 1개, 셀 프롬프트 축 존재.
-- 위반이면 예외. 반환 = 개수 jsonb.
CREATE FUNCTION frz.assert_generation(p_gen int4) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE r record;
BEGIN
  WITH c AS (SELECT * FROM frz.cell WHERE gen_key = p_gen),
  a AS (
    SELECT c.answer_key,
           (SELECT count(*) FROM rd.answer x WHERE x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key
                                              AND x.answer_key = c.answer_key) AS n_rd,
           EXISTS (SELECT 1 FROM frz.kept p WHERE p.gen_key = c.gen_key AND p.answer_key = c.answer_key) AS kept,
           (SELECT count(*) FROM frz.keep_answer k WHERE k.gen_key = c.gen_key AND k.answer_key = c.answer_key) AS n_keep,
           EXISTS (SELECT 1 FROM frz.prompt q WHERE q.gen_key = c.gen_key AND q.prompt_key = c.prompt_key) AS has_prompt
      FROM c)
  SELECT count(*) AS cells,
         count(*) FILTER (WHERE NOT kept AND n_rd = 1) AS from_rd,
         count(*) FILTER (WHERE kept AND n_keep = 1) AS from_keep,
         count(*) FILTER (WHERE (kept AND n_keep <> 1) OR (NOT kept AND n_rd <> 1)) AS broken,
         count(*) FILTER (WHERE NOT has_prompt) AS no_prompt
    INTO r FROM a;
  IF r.broken > 0 OR r.no_prompt > 0 THEN
    RAISE EXCEPTION 'frz.assert_generation(%): 답변 행 없음·중복 % 셀, 프롬프트 축 없음 % 셀', p_gen, r.broken, r.no_prompt;
  END IF;
  RETURN jsonb_build_object('cells', r.cells, 'from_rd', r.from_rd, 'from_keep', r.from_keep);
END $f$;

-- 모양 단언: 보관 표 열 = rd 사실 표 열 + 끝에 gen_key, 동결 뷰 열 = rd 열, rd 사실 표에 보관 트리거 없음(관문은 명시 호출),
-- rd 사실 표 하위 파티션에 loader·migrator 쓰기 권한 없음(P119). 뒤 패치가 rd 열을 더하고 frz 를 안 고치면 예외.
CREATE FUNCTION frz.assert_shape() RETURNS int
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
DECLARE t text; a text; b text; v text; n int := 0; bad text;
BEGIN
  FOREACH t IN ARRAY '{answer,answer_brand,citation}'::text[] LOOP
    SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) INTO a
      FROM pg_attribute WHERE attrelid = format('rd.%I', t)::regclass AND attnum > 0 AND NOT attisdropped;
    SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) INTO b
      FROM pg_attribute WHERE attrelid = format('frz.keep_%s', t)::regclass AND attnum > 0 AND NOT attisdropped;
    SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) INTO v
      FROM pg_attribute WHERE attrelid = format('frz.%I', t)::regclass AND attnum > 0 AND NOT attisdropped;
    IF b IS DISTINCT FROM a || ',gen_key:integer' OR a IS DISTINCT FROM v THEN
      RAISE EXCEPTION 'frz.assert_shape: rd.% 열과 frz.keep_%(+gen_key)·frz.% 열이 다르다(rd 열을 더한 패치는 frz 보관 표·뷰를 같이 갱신)', t, t, t;
    END IF;
    n := n + 1;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'frz%'
               AND tgrelid IN ('rd.answer'::regclass, 'rd.answer_brand'::regclass, 'rd.citation'::regclass)) THEN
    RAISE EXCEPTION 'frz.assert_shape: rd 사실 표에 frz 트리거가 있다(보관은 명시 관문 frz.keep_rewrite·keep_settle)';
  END IF;
  SELECT string_agg(p.relid::regclass::text, ', ') INTO bad
    FROM unnest('{rd.answer,rd.answer_brand,rd.answer_stance,rd.citation}'::regclass[]) r(root)
    CROSS JOIN LATERAL pg_partition_tree(r.root) p
   WHERE p.level > 0 AND (has_table_privilege('loader', p.relid, 'INSERT') OR has_table_privilege('loader', p.relid, 'UPDATE')
                          OR has_table_privilege('loader', p.relid, 'DELETE') OR has_table_privilege('loader', p.relid, 'TRUNCATE')
                          OR has_table_privilege('migrator', p.relid, 'INSERT') OR has_table_privilege('migrator', p.relid, 'UPDATE')
                          OR has_table_privilege('migrator', p.relid, 'DELETE') OR has_table_privilege('migrator', p.relid, 'TRUNCATE'));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'frz.assert_shape: rd 사실 표 하위 파티션에 loader·migrator 쓰기 권한이 있다: %', bad;
  END IF;
  RETURN n;
END $f$;

-- ── P119 소유자·권한 ─────────────────────────────────────────────────────────
ALTER SCHEMA frz OWNER TO hmg_owner;
DO $v$
DECLARE o record;
BEGIN
  FOR o IN SELECT c.oid::regclass AS obj, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'frz' AND c.relkind IN ('r', 'v') LOOP
    EXECUTE format('ALTER %s %s OWNER TO hmg_owner', CASE o.relkind WHEN 'v' THEN 'VIEW' ELSE 'TABLE' END, o.obj);
  END LOOP;
  FOR o IN SELECT p.oid::regprocedure AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'frz' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO hmg_owner', o.fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', o.fn);
  END LOOP;
END $v$;
GRANT USAGE ON SCHEMA frz TO api_ro, admin_long, loader, migrator;
GRANT SELECT ON ALL TABLES IN SCHEMA frz TO api_ro, admin_long, loader, migrator;
-- 쓰기: 이관·발행(migrator) 은 세대·셀·프롬프트·판정 사본을 직접 쓴다. 보관(kept·keep_*)은 SECURITY DEFINER 관문으로(적재기 loader·bulk 시드 migrator)
GRANT INSERT, UPDATE, DELETE ON frz.generation, frz.cell, frz.prompt, frz.ops_judgment TO migrator;
GRANT EXECUTE ON FUNCTION frz.activate(int4), frz.release(int4, text), frz.assert_generation(int4), frz.assert_shape(),
  frz._claim(int4, int4[], text), frz.keep_rewrite(int4[], text), frz.keep_settle(int4[], text), frz._value_cols(text, text) TO migrator;
GRANT EXECUTE ON FUNCTION frz.keep_rewrite(int4[], text), frz.keep_settle(int4[], text), frz.assert_shape(), frz._value_cols(text, text) TO loader;
-- 이관 ops 보관(운영 세부층 변환 행)은 migrator 가 직접 넣는다(kept 표시와 같은 트랜잭션, 이관기만)
GRANT INSERT, DELETE ON frz.kept, frz.keep_answer, frz.keep_answer_brand, frz.keep_citation TO migrator;

-- 결과 캐시 추적(DB-v2.11 P67 규약: 문장 트리거 4개). 동결 뷰 출력은 rd 쓰기에 불변(보관 관문)이고 세대 교체(활성화·해제)에서만 바뀐다 →
-- 세대 표 하나로 덮는다(활성화·해제·이관은 모두 frz.generation 행을 바꾼다).
DO $v$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['frz.generation'] LOOP
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

-- rd 사실 표 하위 파티션(표면 파티션·월 리프)의 쓰기 권한 회수: loader·migrator 는 루트로만 쓴다(파티션 라우팅은 루트 권한만 본다).
-- 리프를 직접 쓰는 문장은 권한 오류다(보관 관문을 우회하는 경로 차단, 검증 반례 P2). 새 리프는 rd.ensure_leaf 가 같은 규칙으로 만든다.
-- (기본 권한 ALTER DEFAULT PRIVILEGES … GRANT … TO loader 가 새 리프에 쓰기 권한을 주므로 ensure_leaf 가 만든 직후 회수한다.)
DO $v$
DECLARE r record;
BEGIN
  FOR r IN SELECT p.relid FROM unnest('{rd.answer,rd.answer_brand,rd.answer_stance,rd.citation}'::regclass[]) x(root)
             CROSS JOIN LATERAL pg_partition_tree(x.root) p WHERE p.level > 0 LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %s FROM loader, migrator', r.relid::regclass);
  END LOOP;
END $v$;

CREATE OR REPLACE FUNCTION rd.ensure_leaf(p_surface int2, p_from date) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, rd AS $f$   -- 부모 소유자만 파티션을 만들 수 있다(스모크 T1)
DECLARE t text; leaf text; sfx text := CASE p_surface WHEN 1 THEN 'g' WHEN 2 THEN 'w' ELSE 'p' END;
        lo date := CASE WHEN p_surface = 3 THEN date_trunc('quarter', p_from)::date ELSE date_trunc('month', p_from)::date END;
        hi date := CASE WHEN p_surface = 3 THEN (lo + interval '3 months')::date ELSE (lo + interval '1 month')::date END;
BEGIN
  FOREACH t IN ARRAY ARRAY['answer','answer_brand','answer_stance','citation'] LOOP
    leaf := format('%s_%s_%s', t, sfx, to_char(lo, 'YYYYMM'));
    IF to_regclass('rd.' || leaf) IS NULL THEN
      EXECUTE format('CREATE TABLE rd.%I PARTITION OF rd.%I FOR VALUES FROM (%L) TO (%L)
                      WITH (fillfactor = 90, parallel_workers = 4, autovacuum_vacuum_insert_scale_factor = 0.02,
                            autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02)', leaf, t || '_' || sfx, lo, hi);
      -- DB-v2.21 P119: 리프 직접 쓰기 금지(루트로만, 보관 관문 우회 차단). 기본 권한이 준 loader 쓰기를 회수한다
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON rd.%I FROM loader, migrator', leaf);
      IF t = 'answer' THEN
        EXECUTE format('CREATE STATISTICS rd.%I (dependencies, mcv) ON bgrp, cat_mask, engine_key, geo_key, lang_key, dflt, std_in FROM rd.%I', leaf || '_x', leaf);
        EXECUTE format('CREATE STATISTICS rd.%I (dependencies) ON round_date, anchor_date, cyc_key FROM rd.%I', leaf || '_t', leaf);
      ELSIF t = 'answer_brand' THEN
        EXECUTE format('CREATE STATISTICS rd.%I (dependencies, mcv) ON bgrp, std_in, engine_key, geo_key, competitive, own_bit FROM rd.%I', leaf || '_x', leaf);
      ELSIF t = 'citation' THEN
        EXECUTE format('CREATE STATISTICS rd.%I (dependencies, mcv) ON bgrp, cit_in, engine_key, geo_key, owner_key, loc_owned, tgt_hit FROM rd.%I', leaf || '_x', leaf);
      END IF;
    END IF;
  END LOOP;
END $f$;

-- ── 사후 단언(구조) ─────────────────────────────────────────────────────────
DO $v$ BEGIN
  PERFORM frz.assert_shape();
  IF pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'frz.cell'::regclass)) <> 'hmg_owner'
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'frz.answer'::regclass)) <> 'hmg_owner'
     OR NOT has_table_privilege('api_ro', 'frz.answer', 'select')
     OR has_table_privilege('api_ro', 'frz.cell', 'insert')
     OR has_table_privilege('loader', 'frz.kept', 'insert')
     OR has_table_privilege('loader', 'frz.keep_answer', 'insert')
     OR NOT has_table_privilege('migrator', 'frz.cell', 'insert')
     OR NOT has_function_privilege('migrator', 'frz.release(int4, text)', 'execute')
     OR NOT has_function_privilege('loader', 'frz.keep_rewrite(int4[], text)', 'execute')
     OR NOT has_function_privilege('loader', 'frz.keep_settle(int4[], text)', 'execute')
     OR has_function_privilege('api_ro', 'frz.keep_rewrite(int4[], text)', 'execute')
     OR has_function_privilege('api_ro', 'frz.release(int4, text)', 'execute')
     OR has_function_privilege('loader', 'frz.release(int4, text)', 'execute')
     OR has_function_privilege('loader', 'frz._claim(int4, int4[], text)', 'execute')
     OR NOT has_table_privilege('loader', 'rd.answer', 'update') THEN
    RAISE EXCEPTION 'P114~P119 실패: 소유자·권한';
  END IF;
  IF NOT (SELECT bool_and(prosecdef) FROM pg_proc WHERE oid IN ('frz.keep_rewrite(int4[], text)'::regprocedure,
                                                                 'frz.keep_settle(int4[], text)'::regprocedure, 'frz._claim(int4, int4[], text)'::regprocedure)) THEN
    RAISE EXCEPTION 'P117 실패: 보관 관문이 SECURITY DEFINER 가 아니다';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'frz.generation'::regclass AND tgname LIKE 'rcache_bump_%') <> 4 THEN
    RAISE EXCEPTION 'P119 실패: 결과 캐시 추적 트리거';
  END IF;
END $v$;

COMMIT;
