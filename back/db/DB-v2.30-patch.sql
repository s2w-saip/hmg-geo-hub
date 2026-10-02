-- ============================================================================
-- hmg-geo 재설계 보완 패치 DB-v2.30 · 동결 층 창 판정의 "생성 대기 회차 = 구멍"(현행 judgeCycleRange)
-- 적용 순서: DB-v2.29 뒤 1회(트랜잭션 1개). 합본 DB-v2.30.sql = DB-v2.29.sql + 이 파일(바이트 연결). 기존 표·열은 바꾸지 않는다(새 표 2개·함수 1개·
--   결과 캐시 추적·권한). 가번호 DB-vNEXT-pick-basis PB1~PB4 → P148~P151(be/int4 통합). 채우기 = migration/fill-v230.sql.
-- 근거: 제품 결정 25(현행 재현), int3 검증 미검증 항목(isGeneratorSkipped 허브 대응)과 그 조사에서 드러난 반대 방향 차이(A안, 2026-10-02 조율 지시).
--
-- 현행 정의(hmg-geo 2670a16)
--   구멍(lib/summary/read/cycle-set.ts:345-357 classifyCycleRange): 기간 창의 summary_cycles 행(웹은 fleet_visible 술어,
--     lib/db/repositories/summary-cycles.ts:558) 중 비렌더 ∧ status ∉ {open, generating} ∧ 노출 대기 아님 ∧ 면제 아님. 면제 = 숨김 ∨
--     isGeneratorSkipped(:967-971 = closed ∧ 비렌더 ∧ NOT (analysis_gap_ratio <= 0.05), 3값 논리: 갭 NULL 도 면제). 구멍이 하나라도 있으면
--     요청 전체 미러(:400-401 unpublished-cycle-in-range). 즉 closed ∧ 갭 0.05 이하 ∧ 세대 없음(생성기 --pending 이 곧 뽑을 회차,
--     lib/summary/generate/cycle.ts:288)은 구멍이다.
--   함대 가시(summary-cycles.ts:1577-1597 cycleFleetSql): (표면, 프로젝트, 주)마다 순위 1 회차만 참. 순위 = 지금 노출 중
--     (view_anchor_at <= now) 먼저 → 노출 앵커 있음 → expected_units 큰 쪽 → 앵커 늦은 쪽. 주 = cycle_week(웹·프로젝트 = 앵커의 UTC 월요일
--     lib/period/sql-day.ts:73 weekStartSql·day-arith.ts:21 ANCHOR_DAY_TZ, 글로벌 = KST 월요일 summary-cycles.ts:1189-1199).
--   갭(analysis_gap_ratio): open 동안 카운터 round(gap_answers / completed_answers, 5)(summary-cycles.ts:1503 cycleCountersSql, 종결 뒤 동결),
--     재생성(generating) 진입 때 round(gap_jobs / sealed_jobs, 5)(lib/summary/generate/cycle.ts:132).
-- 허브 사정
--   rd.cycle 에는 함대 가시가 없다(servable = 발행 ∧ 원장 fleet_visible 로 접혀 있다). 허브 창 후보는 servable ∧ 노출일이라 닫힌 회차는
--   창 행에 오지 않아, 현행 구멍(닫힘 ∧ 갭 이하 ∧ 세대 없음)을 못 본다(stg hmg_r2 2026-10-02: 웹 2건 81b57005·43125e03).
--   허브 원장 카운터는 시드 답변으로 다시 센 값이라 현행 갭과 다를 수 있다(fca32e3e: 현행 0.05556 면제, 허브 5/178 = 0.0281).
--   이관 회차는 현행 갭 원값을 보존해 그것으로 판정하고(P148), 허브가 연 회차(이관 뒤)는 허브 카운터(같은 식)로 판정한다.
--
-- P148 ing.cycle_ops_gap(cycle_id, analysis_gap_ratio, ops_status): 이관 회차(summary_cycles, 이관 때 status ≠ open)의 현행 갭 원값·상태.
--     seed-20 7-3 뒤와 fill-v230.sql 이 mig_src.summary_cycles 에서 채운다. 이관 때 open 이던 회차는 허브가 종결·계수하므로 행이 없다.
-- P149 rd.cycle_pick_basis(cyc_key, fleet_visible, gap_ratio, gap_src, ops_status): 회차별 함대 가시(현행 cycleFleetSql 재계산)와 판정 갭
--     (P148 행이 있으면 그 값 = 'ops', 없으면 rd.cycle 카운터 round(gap_answers / completed_answers, 5) = 'hub'). 파생 회차(anchor_source derived,
--     허브 전용·현행 원장에 없음)는 순위에서 빼고 거짓. API 는 ing 를 못 읽으므로 rd 투영 표로 둔다.
-- P150 rd.refresh_cycle_pick_basis(ids uuid[]): ids 회차가 속한 (표면, 프로젝트, 주) 묶음 전부를 다시 계산(NULL = 전체, 사라진 회차 행 삭제).
--     원장 투영(ingest.cycles.ledger.service.project_cycles: 개설·귀속·카운터·종결·발행 모두 이 투영을 지난다) 직후 같은 트랜잭션에서 부른다.
--     순위의 now 의존(지금 노출 중 대 노출 앵커만 있음)은 판정 대상인 닫힌 회차(노출 앵커 없음)의 가시에 영향이 없다: 노출 앵커가 있는 회차는
--     두 단 모두 닫힌 회차보다 앞이다. 그래서 투영 시점 계산으로 충분하다(판정은 core.cycles.pick_holes).
-- P151 결과 캐시 추적(DB-v2.11 P67 규약: 문장 트리거 4개): 창 판정이 바로 읽는 표다.
-- 락: 새 표·함수 생성뿐(기존 표 무접촉). 적용 절차(stg·prod): ① 이 패치 ② psql -f back/migration/fill-v230.sql(P148 채우기 + 전체 계산).
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regclass('rd.dim_brand_name_name_md5_uq') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.29(rd.dim_brand_name_name_md5_uq) 가 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('rd.cycle_pick_basis') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.30 창 판정 기초 이미 적용됨(rd.cycle_pick_basis 존재)';
  END IF;
END $v$;

-- ── P148 ────────────────────────────────────────────────────────────────────
CREATE TABLE ing.cycle_ops_gap (
  cycle_id uuid PRIMARY KEY,                             -- = ing.cycle.cycle_id(FK 없음: seed-20 이 ing.cycle 을 TRUNCATE 로 다시 쓴다, 같은 자리에서 이 표도 비운다)
  analysis_gap_ratio numeric(6,5),                       -- 현행 summary_cycles.analysis_gap_ratio 원값(NULL = 현행도 NULL = 생성기 미선택)
  ops_status text NOT NULL CHECK (ops_status IN ('closed', 'generating', 'published')),
  imported_at timestamptz NOT NULL DEFAULT now());
COMMENT ON TABLE ing.cycle_ops_gap IS '이관 회차의 현행 갭 원값·상태(DB-v2.30 P148). 허브 카운터와 정의가 달라 창 판정(구멍)에 현행 값을 쓴다';

-- ── P149 ────────────────────────────────────────────────────────────────────
CREATE TABLE rd.cycle_pick_basis (
  cyc_key int4 PRIMARY KEY,                              -- = rd.cycle.cyc_key(FK 없음: seed-40 재투영이 rd.cycle 을 비우고 다시 쓴다)
  fleet_visible bool NOT NULL,
  gap_ratio numeric(6,5),
  gap_src text NOT NULL CHECK (gap_src IN ('ops', 'hub')),
  ops_status text,
  updated_at timestamptz NOT NULL DEFAULT now());
COMMENT ON TABLE rd.cycle_pick_basis IS '창 판정용 회차 함대 가시(현행 cycleFleetSql)·판정 갭(이관 = 현행 원값, 허브 = 카운터). DB-v2.30 P149';

-- ── P150 ────────────────────────────────────────────────────────────────────
CREATE FUNCTION rd.refresh_cycle_pick_basis(p_ids uuid[]) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET TimeZone = 'UTC' AS $f$
DECLARE n int;
BEGIN
  WITH base AS (
    SELECT c.cyc_key, c.cycle_id, c.surface, c.scope_project_id, c.anchor_source, c.view_anchor_at, c.expected_units, c.cycle_anchor_at,
           c.completed_answers, c.gap_answers,
           CASE c.surface WHEN 'global' THEN date_trunc('week', c.cycle_anchor_at AT TIME ZONE 'Asia/Seoul')::date
                          ELSE date_trunc('week', c.cycle_anchor_at AT TIME ZONE 'UTC')::date END AS wk
      FROM ing.cycle c),
  tgt AS (
    SELECT b.* FROM base b
     WHERE p_ids IS NULL
        OR EXISTS (SELECT 1 FROM base t WHERE t.cycle_id = ANY(p_ids)
                    AND t.surface = b.surface AND t.scope_project_id = b.scope_project_id AND t.wk = b.wk)),
  ranked AS (
    SELECT t.cyc_key, t.cycle_id, t.completed_answers, t.gap_answers,
           CASE WHEN t.anchor_source = 'derived' THEN false
                ELSE row_number() OVER (PARTITION BY t.surface, t.scope_project_id, t.wk, (t.anchor_source = 'derived')
                                        ORDER BY (t.view_anchor_at IS NOT NULL AND t.view_anchor_at <= now()) DESC,
                                                 (t.view_anchor_at IS NOT NULL) DESC, coalesce(t.expected_units, 0) DESC,
                                                 t.cycle_anchor_at DESC) = 1 END AS fleet_visible
      FROM tgt t),
  src AS (
    SELECT r.cyc_key, r.fleet_visible,
           CASE WHEN g.cycle_id IS NOT NULL THEN g.analysis_gap_ratio
                WHEN r.completed_answers > 0 THEN round(r.gap_answers::numeric / r.completed_answers, 5) END AS gap_ratio,
           CASE WHEN g.cycle_id IS NOT NULL THEN 'ops' ELSE 'hub' END AS gap_src, g.ops_status
      FROM ranked r LEFT JOIN ing.cycle_ops_gap g ON g.cycle_id = r.cycle_id),
  up AS (
    INSERT INTO rd.cycle_pick_basis AS p (cyc_key, fleet_visible, gap_ratio, gap_src, ops_status)
    SELECT cyc_key, fleet_visible, gap_ratio, gap_src, ops_status FROM src
    ON CONFLICT (cyc_key) DO UPDATE SET fleet_visible = EXCLUDED.fleet_visible, gap_ratio = EXCLUDED.gap_ratio, gap_src = EXCLUDED.gap_src,
                                        ops_status = EXCLUDED.ops_status, updated_at = now()
    WHERE (p.fleet_visible, p.gap_ratio, p.gap_src, p.ops_status)
          IS DISTINCT FROM (EXCLUDED.fleet_visible, EXCLUDED.gap_ratio, EXCLUDED.gap_src, EXCLUDED.ops_status)
    RETURNING 1)
  SELECT count(*) INTO n FROM up;
  IF p_ids IS NULL THEN
    DELETE FROM rd.cycle_pick_basis p WHERE NOT EXISTS (SELECT 1 FROM ing.cycle c WHERE c.cyc_key = p.cyc_key);
  END IF;
  RETURN n;
END $f$;
COMMENT ON FUNCTION rd.refresh_cycle_pick_basis(uuid[]) IS
  'ids 회차의 (표면, 프로젝트, 주) 묶음 함대 가시·판정 갭 재계산(NULL = 전체). 반환 = 바뀐 행 수. DB-v2.30 P150';

-- ── 소유자·권한 ─────────────────────────────────────────────────────────────
ALTER TABLE ing.cycle_ops_gap OWNER TO hmg_owner;
ALTER TABLE rd.cycle_pick_basis OWNER TO hmg_owner;
ALTER FUNCTION rd.refresh_cycle_pick_basis(uuid[]) OWNER TO hmg_owner;
GRANT SELECT ON ing.cycle_ops_gap TO loader, migrator;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON ing.cycle_ops_gap TO migrator;
GRANT SELECT ON rd.cycle_pick_basis TO api_ro, admin_long, loader, migrator;
REVOKE EXECUTE ON FUNCTION rd.refresh_cycle_pick_basis(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd.refresh_cycle_pick_basis(uuid[]) TO loader, migrator;

-- ── P151 결과 캐시 추적 ────────────────────────────────────────────────────────
DO $v$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rd.cycle_pick_basis'] LOOP
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

-- ── 사후 단언(구조) ─────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'rd.cycle_pick_basis'::regclass)) <> 'hmg_owner'
     OR NOT has_table_privilege('api_ro', 'rd.cycle_pick_basis', 'select')
     OR has_table_privilege('api_ro', 'rd.cycle_pick_basis', 'insert')
     OR has_table_privilege('api_ro', 'ing.cycle_ops_gap', 'select')
     OR NOT has_function_privilege('loader', 'rd.refresh_cycle_pick_basis(uuid[])', 'execute')
     OR has_function_privilege('api_ro', 'rd.refresh_cycle_pick_basis(uuid[])', 'execute') THEN
    RAISE EXCEPTION 'P148~P150 실패: 소유자·권한';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'rd.cycle_pick_basis'::regclass AND tgname LIKE 'rcache_bump_%') <> 4 THEN
    RAISE EXCEPTION 'P151 실패: 결과 캐시 추적 트리거';
  END IF;
END $v$;
COMMIT;
