-- ============================================================================
-- hmg-geo 재설계 보완 패치 DB-v2.22 (PostgreSQL 17, 2026-10-01) · 카드 경로 동결 층 S2: 발행 때 생성기(제품 결정 31·32)
-- 번호: P120~P123. 적용 순서: DB-v2.21 뒤 1회(트랜잭션 1개). 합본 DB-v2.22.sql = DB-v2.21.sql + 이 파일(바이트 연결).
-- 근거: card-snapshot-design.md 12.5·12.7(S2), 보류 커밋 18a12559(in_full_cycle 규칙 이식, app.cycle_prompt_full 은 만들지 않는다: frz.prompt 가 대신).
--
-- 현행 규칙(hmg-geo 2670a16)과 이 패치의 대응
--   셀 집합   글로벌 scripts/summary/surface-global.ts:466-478: 회차 run 의 completed 답변, prompt_id·region 있는 것, DISTINCT ON (prompt, target,
--             region) ORDER BY measured_at DESC(= NULLS FIRST). 웹사이트 surface-website.ts:296-317 cellSelectSql + :725-732: DISTINCT ON (prompt,
--             target, country = coalesce(사이트 country_code, region)) ORDER BY measured_at DESC, job_id. 사이트 조인은 회차 프로젝트 사이트만.
--             measured_at = 미러 시각(원본을 앵커 핀으로 접은 값) → 허브 rd.rep_order_at(원본, ing.answer_mirror_time, ing.answer_anchor_pin)
--             (DB-v2.19 P108, 72e73583). 동률은 job_id(글로벌 현행은 순서 미지정이라 결정적 순서를 더한다). 회차 run = ing.cycle_run(원장 귀속).
--             미러는 삭제(drop) 답변을 담지 않는다(lib/scope/mirror/bulk-run.ts:125) → 허브 후보 = rd.job.served(completed ∧ 삭제 아님).
--   in_full_cycle  글로벌 global-predicates.ts:110-169 fullCycleCte + :70-113(18a12559 의 ing.full_cycle_expected 본문 그대로, stg 대 운영 동결값
--             15/15 회차 해시 일치 실측). 셀 프롬프트 중 fc 행이 없으면 false·expected NULL·window = 셀 수(surface-global.ts:541-546).
--             웹사이트는 in_full_cycle = 1 고정(surface-website.ts:9·404·925-938: 웹은 표준 게이트를 안 탄다), expected NULL, window = 셀 수.
--   프롬프트 축 카탈로그 비트·루트 카탈로그: 글로벌 CAT_CTE(surface-global.ts:117-135)는 삭제 행을 넣는다 → rd.dim_prompt.cat_mask_all·
--             in_root_catalog_all(DB-v2.15 P88), 웹 cat(surface-website.ts:906-918)은 삭제 행을 빼고 root 는 넣는다 → cat_mask·in_root_catalog_all.
--             퍼널 = rd.dim_prompt.funnel_key, 그 밖 축 키 = rd.catalog_entry 최솟값(전 행은 src.catalog_entries 에 그대로), report_fs = rd.web_report_prompt.
--   판정 입력  사실 열에 구운 판정은 S1 보관 훅이 고정한다. 세대에는 버전 포인터(활성 엔티티 버전·회차 핀·규칙 세트·적재 번호·프로필 스위치)만.
--
-- P120 ing.full_cycle_expected(cycle_id)  읽기 전용, 글로벌 회차가 아니면 0행(18a12559 P110 본문)
-- P121 frz._keep_seat(gen_key)  셀 답변의 rd 좌석이 셀 좌석과 다르면 지금 rd 행을 그 세대 보관(src 'seat')으로 둔다(S1 이관과 같은 규칙, 위치 = rd.job)
-- P122 frz.freeze_cycle(cycle_id, judgment jsonb) · frz.regenerate(cycle_id, reason, judgment jsonb)
--      freeze: 발행된 global·website 회차만, 활성 세대가 있으면 할 일 없음(멱등). 세대 → 셀 → 좌석 보관 → 프롬프트 축 → 활성화 → 구조 단언.
--      regenerate: 사유 필수, 활성 세대를 frz.release(보관 해제) 뒤 다시 freeze(재해석 = 지금 판정으로 다시 동결). 둘 다 호출자 트랜잭션 안.
-- P123 권한(loader·migrator 실행, SECURITY DEFINER: loader 는 frz 쓰기 권한이 없다) · 사후 단언
-- 락: 새 함수뿐(표 생성·ALTER 없음). 호출은 원장 발행 트랜잭션 안: frz 행 INSERT 와 ing·rd 읽기만, rd 쓰기 없음.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF to_regnamespace('frz') IS NULL OR to_regprocedure('rd.rep_order_at(timestamptz, timestamptz, date)') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.21(frz)·DB-v2.19(rd.rep_order_at) 가 먼저 적용돼야 한다';
  END IF;
  IF to_regprocedure('frz.freeze_cycle(uuid, jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'DB-v2.22 이미 적용됨(frz.freeze_cycle 존재)';
  END IF;
END $v$;

-- ── P120 ─────────────────────────────────────────────────────────────────────
-- 현행 fullCycleCte(global-predicates.ts:134-169)·koreanNonKrPred(:70-97)·regionTagPred(:100-113)를 ing 표로 옮긴 것(18a12559 P110 그대로).
--   scope_answers → ing.answer, scope_runs → ing.run(scope_project_id = 회차 프로젝트), scope_prompts → ing.prompt, mem(runsMemCte) → ing.cycle_run.
--   숨김 국가(HIDDEN_STANDARD_REGIONS)는 2670a16 에서 빈 목록이라 절이 없다. REGION_TAGGING_CUTOFF = 2026-08-19T00:00:00Z(lib/scope/region-tagging.ts:17).
--   한국어 판정 = ing.prompt.text ~ '[가-힣]'(현행 scope_prompts.is_korean 열과 같은 식, rd.dim_prompt.is_korean 과 같다).
CREATE FUNCTION ing.full_cycle_expected(p_cycle uuid)
RETURNS TABLE (prompt_id uuid, cyc_key int4, in_full_cycle bool, expected_cells int, window_cells int)
LANGUAGE sql STABLE SET search_path = pg_catalog AS $f$
WITH cyc AS (
  SELECT c.cycle_id, c.cyc_key, c.scope_project_id FROM ing.cycle c WHERE c.cycle_id = p_cycle AND c.surface = 'global'),
mem AS (SELECT cr.run_id FROM ing.cycle_run cr WHERE cr.cycle_id = p_cycle),
kor AS (SELECT p.scope_prompt_id FROM ing.prompt p WHERE coalesce(p.text ~ '[가-힣]', false)),
tagged AS (SELECT p.scope_prompt_id FROM ing.prompt p
            WHERE p.scope_prompt_id IS NOT NULL AND p.regions IS NOT NULL AND cardinality(p.regions) > 0),
tag_pairs AS (SELECT p.scope_prompt_id, r FROM ing.prompt p, unnest(p.regions) AS r
               WHERE p.scope_prompt_id IS NOT NULL AND p.regions IS NOT NULL AND cardinality(p.regions) > 0),
fc_cells AS (
  SELECT a.prompt_id, a.target, a.region,
         bool_or(a.run_id IN (SELECT run_id FROM mem)) AS w,
         min(a.measured_at) AS first_at,
         max(a.measured_at) FILTER (WHERE a.run_id IN (SELECT run_id FROM mem)) AS w_last
    FROM ing.answer a
    JOIN ing.run r ON r.run_id = a.run_id
    JOIN cyc ON r.scope_project_id = cyc.scope_project_id
   WHERE r.status IN ('completed', 'partial_failed') AND a.status = 'completed'
     AND NOT (
           a.region <> 'KR'
       AND a.prompt_id IS NOT NULL
       AND a.prompt_id IN (SELECT scope_prompt_id FROM kor)
       AND (a.measured_at IS NULL
            OR a.measured_at < TIMESTAMPTZ '2026-08-19 00:00:00+00'
            OR a.prompt_id NOT IN (SELECT scope_prompt_id FROM tagged)))
     AND (a.prompt_id IS NULL
          OR a.prompt_id NOT IN (SELECT scope_prompt_id FROM tagged)
          OR (a.prompt_id, a.region) IN (SELECT scope_prompt_id, r FROM tag_pairs))
   GROUP BY 1, 2, 3),
fc_active AS (SELECT DISTINCT target, region FROM fc_cells WHERE w),
fc AS (
  SELECT c.prompt_id,
         count(*) FILTER (
           WHERE (c.target, c.region) IN (SELECT ac.target, ac.region FROM fc_active ac)
             AND (c.w OR c.first_at IS NULL
                  OR c.first_at <= (SELECT coalesce(max(w_last), 'infinity'::timestamptz) FROM fc_cells))
         )::int AS expected_cells,
         count(*) FILTER (WHERE c.w)::int AS window_cells
    FROM fc_cells c
   GROUP BY c.prompt_id)
SELECT fc.prompt_id, cyc.cyc_key, fc.window_cells >= fc.expected_cells AS in_full_cycle, fc.expected_cells, fc.window_cells
  FROM fc CROSS JOIN cyc
 WHERE fc.prompt_id IS NOT NULL AND fc.window_cells > 0
$f$;
COMMENT ON FUNCTION ing.full_cycle_expected(uuid) IS
  '현행 in_full_cycle 규칙(2670a16 global-predicates.ts:110-169 fullCycleCte + :70-113, mem = 회차 귀속 run)의 결과 행(측정된 프롬프트만). '
  '글로벌 회차가 아니면 0행. 읽기 전용. 18a12559 P110 이식. DB-v2.22 P120';

-- ── P121 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION frz._keep_seat(p_gen int4) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE ks int4[];
BEGIN
  SELECT array_agg(c.answer_key) INTO ks
    FROM frz.cell c JOIN rd.job j ON j.answer_key = c.answer_key
   WHERE c.gen_key = p_gen
     AND NOT EXISTS (SELECT 1 FROM rd.answer x WHERE x.surface = c.surface AND x.round_date = c.round_date AND x.cyc_key = c.cyc_key
                                                AND x.answer_key = c.answer_key)
     AND NOT EXISTS (SELECT 1 FROM frz.kept p WHERE p.gen_key = c.gen_key AND p.answer_key = c.answer_key);
  IF ks IS NULL THEN RETURN 0; END IF;
  ks := frz._claim(p_gen, ks, 'seat');
  IF cardinality(ks) = 0 THEN RETURN 0; END IF;
  INSERT INTO frz.keep_answer SELECT x.*, p_gen FROM rd.job j
    JOIN rd.answer x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key WHERE j.answer_key = ANY (ks);
  INSERT INTO frz.keep_answer_brand SELECT x.*, p_gen FROM rd.job j
    JOIN rd.answer_brand x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key WHERE j.answer_key = ANY (ks);
  INSERT INTO frz.keep_citation SELECT x.*, p_gen FROM rd.job j
    JOIN rd.citation x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key WHERE j.answer_key = ANY (ks);
  RETURN cardinality(ks);
END $f$;
COMMENT ON FUNCTION frz._keep_seat(int4) IS
  '셀 답변의 rd 좌석(surface·round_date·cyc_key)이 셀 좌석과 다르면 지금 rd 행(위치 = rd.job)을 보관(src seat). 반환 = 보관한 답변 수. DB-v2.22 P121';

-- ── P122 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION frz.freeze_cycle(p_cycle uuid, p_judgment jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE c record; g int4; n_cell int; n_dup int; n_seat int; n_prompt int; n_fc_fail int; st jsonb; t0 timestamptz := clock_timestamp();
BEGIN
  SELECT i.cycle_id, i.cyc_key, i.surface AS surf, i.scope_project_id, i.status, rc.surface, rc.round_date
    INTO c FROM ing.cycle i JOIN rd.cycle rc ON rc.cyc_key = i.cyc_key WHERE i.cycle_id = p_cycle;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'frz.freeze_cycle: 회차 % 없음(ing.cycle·rd.cycle)', p_cycle;
  END IF;
  IF c.surf NOT IN ('global', 'website') OR c.status <> 'published' THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'surface_or_status', 'surface', c.surf, 'cycle_status', c.status);
  END IF;
  SELECT gen_key INTO g FROM frz.generation WHERE cyc_key = c.cyc_key AND state = 'active';
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'already', 'gen_key', g);
  END IF;

  INSERT INTO frz.generation (cyc_key, surface, source, judgment)
  VALUES (c.cyc_key, c.surface, 'hub',
          coalesce(p_judgment, '{}'::jsonb) || jsonb_build_object(
            'cycle_id', c.cycle_id,
            'ecat_active_ver', (SELECT ver FROM app.ecat_version WHERE status = 'active'),
            'ecat_cycle_pin', (SELECT ecat_ver FROM rd.cycle WHERE cyc_key = c.cyc_key),
            'rule_ver', (SELECT max(rule_ver) FROM app.rule_set),
            'surface_generation', (SELECT generation FROM rd.surface_generation WHERE surface = c.surface),
            'max_load_id', (SELECT max(load_id) FROM ing.load WHERE status = 'committed')))
  RETURNING gen_key INTO g;

  -- 셀 집합: 회차 run 의 서빙 답변에서 셀당 1건(미러 시각 DESC NULLS FIRST, job_id). 같은 답변이 두 셀에 들면(웹 사이트 조인 갈래) 앞 셀만
  CREATE TEMP TABLE _frz_cand ON COMMIT DROP AS
  SELECT DISTINCT ON (a.prompt_id, a.target, ck.cell_country)
         j.answer_key, j.prompt_key, j.engine_key, j.geo_key
    FROM ing.cycle_run cr
    JOIN ing.answer a ON a.run_id = cr.run_id AND a.status = 'completed'
    JOIN rd.job j ON j.job_id = a.job_id AND j.served
    LEFT JOIN ing.answer_mirror_time mt ON mt.job_id = a.job_id
    LEFT JOIN ing.answer_anchor_pin pin ON pin.job_id = a.job_id
    LEFT JOIN app.website_prompt wp ON c.surf = 'website' AND wp.scope_prompt_id = a.prompt_id
    LEFT JOIN app.website_site ws ON ws.site_id = wp.site_id AND ws.scope_project_id = c.scope_project_id
    CROSS JOIN LATERAL (SELECT CASE WHEN c.surf = 'website' THEN coalesce(ws.country_code, a.region) ELSE a.region END AS cell_country) ck
   WHERE cr.cycle_id = c.cycle_id
     AND (c.surf = 'website' OR (a.prompt_id IS NOT NULL AND a.region IS NOT NULL))
   ORDER BY a.prompt_id, a.target, ck.cell_country, rd.rep_order_at(a.measured_at, mt.measured_at, pin.anchor) DESC NULLS FIRST, a.job_id;
  INSERT INTO frz.cell (gen_key, answer_key, surface, cyc_key, round_date, prompt_key, engine_key, geo_key)
  SELECT DISTINCT ON (answer_key) g, answer_key, c.surface, c.cyc_key, c.round_date, prompt_key, engine_key, geo_key FROM _frz_cand ORDER BY answer_key;
  GET DIAGNOSTICS n_cell = ROW_COUNT;
  n_dup := (SELECT count(*) FROM _frz_cand) - n_cell;
  DROP TABLE _frz_cand;

  n_seat := frz._keep_seat(g);

  -- 프롬프트 축(셀 프롬프트만)
  INSERT INTO frz.prompt (gen_key, prompt_key, cyc_key, in_full_cycle, expected_cells, window_cells, in_root_catalog, catalog_deleted, cat_mask,
                          funnel_key, presence_key, list_type_key, depth1_key, depth2_key, depth3_key, regions, is_korean, report_fs, src)
  SELECT g, nc.prompt_key, c.cyc_key,
         CASE WHEN c.surf = 'website' THEN true ELSE coalesce(fc.in_full_cycle, false) END,
         CASE WHEN c.surf = 'website' THEN NULL ELSE fc.expected_cells END,
         CASE WHEN c.surf = 'website' THEN nc.cells ELSE coalesce(fc.window_cells, nc.cells) END,
         coalesce(d.in_root_catalog_all, d.in_root_catalog, false),
         coalesce(d.in_root_catalog_all AND NOT d.in_root_catalog, false),
         coalesce(CASE WHEN c.surf = 'website' THEN d.cat_mask ELSE coalesce(d.cat_mask_all, d.cat_mask) END, 0),
         coalesce(d.funnel_key, 0), ce.presence_key, ce.list_type_key, ce.depth1_key, ce.depth2_key, ce.depth3_key,
         d.regions, d.is_korean, wr.report_fs,
         jsonb_strip_nulls(jsonb_build_object('catalog_entries', ce.entries, 'cat_mask_live', d.cat_mask, 'in_root_catalog_live', d.in_root_catalog,
                                              'prompt_id', d.prompt_id))
    FROM (SELECT prompt_key, count(*)::int AS cells FROM frz.cell WHERE gen_key = g GROUP BY 1) nc
    LEFT JOIN rd.dim_prompt d ON d.prompt_key = nc.prompt_key                 -- prompt_id 없는 웹 답변(키 0)도 축 행을 둔다
    LEFT JOIN ing.full_cycle_expected(c.cycle_id) fc ON fc.prompt_id = d.prompt_id
    LEFT JOIN rd.web_report_prompt wr ON c.surf = 'website' AND wr.prompt_key = nc.prompt_key
    LEFT JOIN LATERAL (
      SELECT min(e.presence_key) AS presence_key, min(e.list_type_key) AS list_type_key, min(e.depth1_key) AS depth1_key,
             min(e.depth2_key) AS depth2_key, min(e.depth3_key) AS depth3_key,
             jsonb_agg(jsonb_build_object('brand_bit', e.brand_bit, 'presence', e.presence_key, 'funnel', e.funnel_key, 'list_type', e.list_type_key,
                                          'depth1', e.depth1_key, 'depth2', e.depth2_key, 'depth3', e.depth3_key, 'kind', e.kind)
                       ORDER BY e.catalog_row_id) AS entries
        FROM rd.catalog_entry e WHERE e.prompt_key = nc.prompt_key) ce ON true;
  GET DIAGNOSTICS n_prompt = ROW_COUNT;
  n_fc_fail := (SELECT count(*) FROM frz.prompt WHERE gen_key = g AND NOT in_full_cycle);

  PERFORM frz.activate(g);
  st := frz.assert_generation(g);
  UPDATE frz.generation
     SET row_counts = jsonb_build_object('cells', n_cell, 'dup_answer_cells', n_dup, 'kept_seat', n_seat, 'prompts', n_prompt,
                                         'prompts_not_full_cycle', n_fc_fail),
         verify = jsonb_build_object('structure', st, 'ms', round(extract(epoch FROM clock_timestamp() - t0) * 1000))
   WHERE gen_key = g;
  RETURN jsonb_build_object('status', 'frozen', 'gen_key', g, 'cells', n_cell, 'dup_answer_cells', n_dup, 'kept_seat', n_seat, 'prompts', n_prompt,
                            'prompts_not_full_cycle', n_fc_fail, 'ms', round(extract(epoch FROM clock_timestamp() - t0) * 1000));
END $f$;
COMMENT ON FUNCTION frz.freeze_cycle(uuid, jsonb) IS
  '발행 회차(global·website)의 동결 세대 생성: 셀 집합(미러 시각 셀 대표)·좌석 보관·프롬프트 축(in_full_cycle 포함)·판정 입력 포인터 → 활성화 → '
  '구조 단언. 활성 세대가 있으면 할 일 없음(멱등). 호출자 트랜잭션 안(원장 발행). DB-v2.22 P122';

CREATE FUNCTION frz.regenerate(p_cycle uuid, p_reason text, p_judgment jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE k int4; g int4; rel jsonb;
BEGIN
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'frz.regenerate: 사유 필수';
  END IF;
  SELECT cyc_key INTO k FROM ing.cycle WHERE cycle_id = p_cycle;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'frz.regenerate: 회차 % 없음', p_cycle;
  END IF;
  SELECT gen_key INTO g FROM frz.generation WHERE cyc_key = k AND state = 'active' FOR UPDATE;
  IF FOUND THEN
    rel := frz.release(g, 'regenerate: ' || btrim(p_reason));
  END IF;
  RETURN jsonb_build_object('released', rel) || frz.freeze_cycle(p_cycle, coalesce(p_judgment, '{}'::jsonb) || jsonb_build_object('regenerate_reason', btrim(p_reason)));
END $f$;
COMMENT ON FUNCTION frz.regenerate(uuid, text, jsonb) IS
  '재생성(운영 --cycle --reinterpret 대응): 활성 세대 해제(보관 삭제) 뒤 지금 판정으로 다시 동결. 사유 필수. 재해석 없는 재생성은 없다(호출자가 거부). DB-v2.22 P122';

-- ── P123 소유자·권한 ─────────────────────────────────────────────────────────
ALTER FUNCTION ing.full_cycle_expected(uuid) OWNER TO hmg_owner;
ALTER FUNCTION frz._keep_seat(int4) OWNER TO hmg_owner;
ALTER FUNCTION frz.freeze_cycle(uuid, jsonb) OWNER TO hmg_owner;
ALTER FUNCTION frz.regenerate(uuid, text, jsonb) OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION ing.full_cycle_expected(uuid), frz._keep_seat(int4), frz.freeze_cycle(uuid, jsonb), frz.regenerate(uuid, text, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ing.full_cycle_expected(uuid), frz.freeze_cycle(uuid, jsonb), frz.regenerate(uuid, text, jsonb) TO loader, migrator;
GRANT EXECUTE ON FUNCTION frz._keep_seat(int4) TO migrator;

DO $v$ BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'frz.freeze_cycle(uuid, jsonb)'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'frz.regenerate(uuid, text, jsonb)'::regprocedure)
     OR NOT has_function_privilege('loader', 'frz.freeze_cycle(uuid, jsonb)', 'execute')
     OR NOT has_function_privilege('loader', 'frz.regenerate(uuid, text, jsonb)', 'execute')
     OR has_function_privilege('api_ro', 'frz.freeze_cycle(uuid, jsonb)', 'execute')
     OR has_function_privilege('loader', 'frz._keep_seat(int4)', 'execute')
     OR has_table_privilege('loader', 'frz.cell', 'insert') THEN
    RAISE EXCEPTION 'P120~P122 실패: 소유자·권한';
  END IF;
END $v$;

COMMIT;
