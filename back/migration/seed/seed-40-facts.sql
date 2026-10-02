-- ============================================================================
-- seed-40-facts.sql : ing·app·rd 차원 → rd 사실 표 투영 + 불변식 단언   (빌더 B, 2026-09-28)
--   rd.cycle · rd.surface_generation · rd.job · rd.answer · rd.answer_brand · rd.answer_stance · rd.citation
--   · rd.acr_cell · rd.acr_cell_job · rd.acr_choice · rd.report_unit_value
-- 전제: seed-30-dims.sql 적용 완료(같은 ing·app 입력). 포함 파일은 seed-30 과 같다.
-- 재실행 가능: 트랜잭션 1개, 사실 표 TRUNCATE 후 INSERT...SELECT(차원 키는 건드리지 않는다).
-- 순서(DB-보정.md §4 적재 흐름을 시드 1회로): 회차 투영 → job 좌표·귀속(R02) → 답변 판정(R07·A15·R13·A16·기본 엔진)
--   → 언급 접기(G-01)·당사 요약(G-03) → 스탠스 → 인용 판정(M05·M06·M07) → 대표(R05) → 한 번씩 INSERT
--   → rd.propagate_answer_gates(5만 청크) + rd.assert_answer_cit_counts(G-25 인용 수 = 자식 합, 같은 청크)
--   → 불변식 단언(당사 합 = 답변 열, 게이트 동치, 위치·유일성) → ACR·발행값 → 마감.
-- 전제 DDL: DB-v2.5(= DB-v2.1 + v2.2 rd.answer 인용 수 열 cit_* 11개 + … + v2.5 rd.answer_stance.cyc_key).
-- D8: 사전 집계·요약 표·캐시 없음. rd.answer 당사 열(G-03)·인용 수 열(G-25)·rd.answer_brand 그레인(G-01)·rd.cycle 카운터(Q2)는 계약서 §3 예외.
-- 코드 값: surface 1 global 2 website 3 project. rd.cycle.status 0 open 1 closed 2 published 3 stale. hidden_scope 0/1 all/2 citations/3 mentions.
--   hidden_reason 0/1 collection_error/2 operator. rd.job.status_code 0 completed 1 pending·running 2 failed 3 기타.
--   analysis_state 0 분석됨·언급 있음 1 분석됨·언급 0 2 분석 미도착 3 분석 실패·스킵. stance 1 pos 2 neu 3 mix 4 neg.
--   rd.answer.anchor_src 1 수작업 고정(pin) 2 원장 회차 3 run 앵커 회차 4 측정일 파생 회차 5 운영자 회차(이 파일 정의).
-- ============================================================================
\set ON_ERROR_STOP on
\set VERBOSITY terse
SET client_min_messages = warning;
SET TIME ZONE 'UTC';
\if :{?work_mem}
SET work_mem = :'work_mem';
\else
SET work_mem = '512MB';
\endif
SET maintenance_work_mem = '1GB';
SET statement_timeout = 0;
\timing on
-- R05 대표 규칙(현행 프로필 rep_pick_latest_first, WU-2): -v rep_latest_first=1 이면 현행 규칙(셀 최신 1건을 게이트 전에 굳힘), 기본 0 = hub 규칙.
--   적재기(ingest.project.apply rep_update)·rd.rep_expected(DB-v2.15 P85)와 같은 식이다. 적재 워커의 HGH_LEGACY_PROFILE 과 맞춰 준다.
\if :{?rep_latest_first}
\else
\set rep_latest_first 0
\endif
-- 답변분석 경로 셀 대표(현행 프로필 rep_round_date_cell, DB-v2.19 P109·P110, WU-12): -v rep_round_date_cell=1 이면 §8 앞에서
--   is_rep := 답변분석 규칙(round_date 셀, 원본 시각 DESC, job_id DESC, 후보 = elig_nc ∧ 서빙 ∧ 숨김 아님)으로 다시 고르고 rd.rep_cit_delta(인용 계열 보정)를
--   채운다(rd.reselect_rep_seat 전체 범위 = 적재기 REP_UPDATE_SEAT·fill-v219-rep.sql 과 같은 함수). 켜지 않으면 보정 표는 비운다.
\if :{?rep_round_date_cell}
\else
\set rep_round_date_cell 0
\endif
-- R02 답변 회차 귀속(현행 프로필 resub_phantom_exclude, WU-3b): -v attrib_member=1 이면 답변 회차 = run 원장 멤버십(ing.cycle_run, 현행 앵커 표
--   cycle_id 규칙), 기본 0 = hub 코호트 규칙. 적재기(ingest.project.apply runc_sql)와 같은 식이다. 적재 워커의 HGH_LEGACY_PROFILE 과 맞춰 준다.
\if :{?attrib_member}
\else
\set attrib_member 0
\endif
-- 인용 판정 투영 스위치(현행 프로필, WU-5). 적재기 ingest.project.apply queries.fact_src_sql 과 같은 규칙, 적재 워커 HGH_LEGACY_PROFILE 과 맞춘다.
--   -v cit_row_host=1 = cit_hostless_per_row(G21A): 인용 행 자신의 도메인(ing.citation.domain_label)이 NULL·빈 값이면 source_key 0.
--   -v web_tgt_base=1 = web_owned_target_base(OWN4): 웹사이트 loc_owned 타겟 항 = base NORM ∈ 유닛 타겟 base NORM(Scope 등록 프롬프트만).
\if :{?cit_row_host}
\else
\set cit_row_host 0
\endif
\if :{?web_tgt_base}
\else
\set web_tgt_base 0
\endif
-- 동결 층 보관 관문(DB-v2.21 P117, 결정 32): 기본 = 사실 표를 비우기 전에 동결 답변의 지금 행을 보관(src bulk)하고 seed-40 끝에서 값이 같은 것을 정리.
--   -v frz_no_keep=1 = 보관 안 함(이관 작업 명시 모드: 열 백필·패치 채우기처럼 값을 "고치는" 재구축은 동결 값도 바뀌어야 한다. 위험·판단 = 설계 12.11).
\if :{?frz_no_keep}
\else
\set frz_no_keep 0
\endif
\ir seed-00-fn.sql
\ir seed-3x-rules.sql

BEGIN;
SET LOCAL lock_timeout = '60s';
DO $a$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM rd.dim_prompt WHERE prompt_key = 0) THEN RAISE EXCEPTION 'seed-30-dims 먼저'; END IF;
  IF to_regprocedure('rd.assert_answer_cit_counts(int4[])') IS NULL THEN RAISE EXCEPTION 'DB-v2.2 패치(G-25 인용 수 열) 먼저'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer_stance'::regclass AND attname = 'cyc_key' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.5 패치(rd.answer_stance.cyc_key) 먼저'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 'cit_off' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.13 패치(rd.answer.cit_off 공식 인용 수 열) 먼저'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.citation'::regclass AND attname = 'is_rep' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.15 패치(자식 표 is_rep 사본, P85) 먼저'; END IF;
  IF to_regprocedure('rd.assert_answer_nc(int4[])') IS NULL THEN
    RAISE EXCEPTION 'DB-v2.15 패치(P89 rd.answer.elig_nc·std_in_nc·cit_in_nc·answer_brand.rid_n) 먼저'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 'ecat_ver' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.17 패치(엔티티 버전 rd.answer.ecat_ver·app.ecat_*) 먼저'; END IF;
END $a$;
SELECT max(rule_ver) AS rv FROM app.rule_set \gset
INSERT INTO ing.load (kind, scope_ref, rule_ver, status)
VALUES ('rebuild', jsonb_build_object('step', 'seed-40-facts', 'builder', 'B'), :rv, 'running')
RETURNING load_id AS l40 \gset

-- 엔티티 버전 고정(E1): 노출 회차의 rd.cycle.ecat_ver. 직전 seed-30 이 rd.cycle 을 비웠으면 그 적재 원장 행(ecat_pins)에서 되살린다
--   (그 seed-30 이 마지막 seed-40 뒤에 돈 경우만). §4(seed-3x-common) 가 이 표를 버전 집합에 넣는다.
DROP VIEW IF EXISTS _meff;
CREATE TEMP TABLE IF NOT EXISTS _ecat_pin_extra (cycle_id uuid, ver int4);
TRUNCATE _ecat_pin_extra;
INSERT INTO _ecat_pin_extra (cycle_id, ver)
SELECT (x ->> 0)::uuid, (x ->> 1)::int4
  FROM (SELECT l.scope_ref FROM ing.load l
         WHERE l.kind = 'rebuild' AND l.scope_ref ->> 'step' = 'seed-30-dims' AND l.status = 'committed'
           AND l.load_id > coalesce((SELECT max(l2.load_id) FROM ing.load l2
                                      WHERE l2.kind = 'rebuild' AND l2.scope_ref ->> 'step' = 'seed-40-facts' AND l2.load_id < :l40), 0)
         ORDER BY l.load_id DESC LIMIT 1) z
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(z.scope_ref -> 'ecat_pins', '[]'::jsonb)) x;

\ir seed-3x-common.sql

DROP TABLE IF EXISTS _ecat_pin_all;
CREATE TEMP TABLE _ecat_pin_all AS
SELECT DISTINCT ON (cycle_id) cycle_id, ver FROM (
  SELECT cycle_id, ecat_ver::int4 AS ver, 1 AS pri FROM rd.cycle WHERE ecat_ver IS NOT NULL
  UNION ALL SELECT cycle_id, ver, 2 FROM _ecat_pin_extra) x ORDER BY cycle_id, pri;

-- 동결 층(DB-v2.21 P117): 비우기 직전 동결 답변의 지금 행 보관(bulk, 보관 관문 명시 단계. frz 가 없는 DB 는 건너뛴다)
\if :frz_no_keep
\else
DO $frz$ BEGIN
  IF to_regprocedure('frz.keep_rewrite(int4[], text)') IS NOT NULL THEN
    PERFORM frz.keep_rewrite((SELECT array_agg(DISTINCT c.answer_key) FROM frz.cell c
                                JOIN frz.generation g ON g.gen_key = c.gen_key AND g.state = 'active'), 'bulk');
  END IF;
END $frz$;
\endif
TRUNCATE rd.job, rd.answer, rd.answer_brand, rd.answer_stance, rd.citation, rd.cycle, rd.surface_generation,
         rd.acr_cell, rd.acr_cell_job, rd.acr_choice, rd.report_unit_value;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. rd.cycle: ing.cycle 1:1 투영(A17). Q2 카운터 4열 1:1(새 합산 없음).
--    servable = published ∧ fleet_visible, project 표면은 항상 true(프로젝트 가상 회차, DB-측정-코어 cycle 정의·모듈-적재-파이프라인 IG-3).
--    view_date = 원장 노출 시각의 KST 날짜(hmg_anchor_view_date ① 0077:258), 없고 project 표면이면 anchor_date + 표면 지연(② :262,
--      app.rule_param view_delay_days_by_surface.project = 1), 그 밖은 NULL(비노출, ③ 철회 :255).
--    ledger_backed = anchor_source <> 'derived'(모듈-적재-파이프라인.json IG 코드 정의).
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO rd.cycle (cyc_key, cycle_id, surface, project_key, ledger_backed, round_date, anchor_date, status, servable, view_date,
                      hidden_scope, generation, hidden_reason, expected_units, completed_units, completed_answers, gap_answers, ecat_ver)
SELECT c.cyc_key, c.cycle_id, sf.s, dp.project_key, c.anchor_source <> 'derived', c.round_date, c.anchor_date,
       (CASE c.status WHEN 'open' THEN 0 WHEN 'closed' THEN 1 WHEN 'published' THEN 2 WHEN 'stale' THEN 3 END)::int2,
       CASE WHEN sf.s = 3 THEN true ELSE c.status = 'published' AND c.fleet_visible END,
       coalesce((c.view_anchor_at AT TIME ZONE 'Asia/Seoul')::date,
                CASE WHEN sf.s = 3 THEN c.anchor_date + coalesce((SELECT (value ->> 'project')::int FROM app.rule_param
                                                                   WHERE key = 'view_delay_days_by_surface'), 1) END),
       (CASE c.hidden_scope WHEN 'all' THEN 1 WHEN 'citations' THEN 2 WHEN 'mentions' THEN 3 ELSE 0 END)::int2,
       c.generation,
       (CASE c.hidden_reason WHEN 'collection_error' THEN 1 WHEN 'operator' THEN 2 ELSE 0 END)::int2,
       c.expected_units, c.completed_units, c.completed_answers, c.gap_answers,
       (SELECT p.ver FROM _ecat_pin_all p WHERE p.cycle_id = c.cycle_id)::int2
  FROM ing.cycle c
  CROSS JOIN LATERAL (SELECT (CASE c.surface WHEN 'global' THEN 1 WHEN 'website' THEN 2 ELSE 3 END)::int2 AS s) sf
  JOIN rd.dim_project dp ON dp.scope_project_id = c.scope_project_id;
DO $a$ BEGIN
  IF (SELECT count(*) FROM rd.cycle) <> (SELECT count(*) FROM ing.cycle) THEN RAISE EXCEPTION 'rd.cycle ↔ ing.cycle 행 수 불일치(dim_project 누락)'; END IF;
END $a$;
-- 창 판정용 함대 가시·판정 갭(DB-v2.30 P149·P150). 패치 전 DB 에서는 건너뛴다(동적 호출 = 함수 없음이 파싱 오류가 되지 않게)
DO $pb$ BEGIN
  IF to_regprocedure('rd.refresh_cycle_pick_basis(uuid[])') IS NOT NULL THEN
    EXECUTE 'SELECT rd.refresh_cycle_pick_basis(NULL)';
  END IF;
END $pb$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. run 회차 귀속(R02): 우선순위 수작업 고정(pin) → 원장 → run 앵커 → 측정일(refresh_answer_cycle_anchors 0077:893-1040)
--    현행은 회차 키 = (프로젝트, run cycle_anchor_at)(앵커 없는 run 은 run 단독) 코호트 단위로 앵커를 정한다(:960-963, :1000-1017):
--      ① 코호트 안 완료 job 의 pin 중 가장 이른 날짜(cyc_reg :1001) → 같은 프로젝트 원장 회차 중 UTC 날짜가 그 날(cyc_utc :985),
--         없으면 KST 날짜(cyc_kst :990). 원장이 아닌 회차(적재기 파생)는 KST 날짜 = pin 인 회차로만 붙인다(현행은 이때 UTC 날짜를 유지,
--         anchor-tz:utc-date-kept :1037). 어느 회차에도 못 붙으면 ②로 떨어지고 NOTICE 로 건수를 낸다.
--      ② 그 밖은 ing.cycle_run 귀속(빌더 A: 원장 → run 앵커 → 측정일 파생)에서 코호트당 회차 1개를 0078 결함 B 규칙으로 고른다
--         (0078_answer_cycle_anchor_hot_path.sql:62-66 규칙, :566-576 led_grp·led): 원장 회차 우선, 그 안에서
--         ① 원장 앵커 = 코호트 run 앵커(cycle_anchor_at) ② 그 회차에 귀속된 run 수 최다 ③ 이른 앵커(동률이면 cyc_key).
--         (종전 0077 cyc_led min(:1008)은 재제출 run 이 붙은 유령 회차를 골라 웹 6개 프로젝트 09-18 좌석 1,743답변을
--          비노출 09-17 회차로 보냈다: parity/sql/x10-rounddate.sql 2026-09-28 stg 실측)
--    답변의 anchor_date·round_date = 그 회차 값(현행 round_date = hmg_round_date_of(project, anchor_date) :1046 와 같은 원장 좌석).
-- ════════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS _run_c;
CREATE TEMP TABLE _run_c AS
WITH r AS (
  SELECT run_id, run_key, scope_project_id, status, cycle_anchor_at,
         scope_project_id::text || '|' || coalesce(cycle_anchor_at::text, 'run:' || run_id::text) AS cohort
    FROM ing.run),
coh_grp AS (   -- 코호트 × 귀속 회차: 귀속 run 수, 그 회차 앵커가 코호트 run 앵커와 같은가(0078 led_grp :566-571)
  SELECT r.cohort, c.cyc_key, c.origin, c.anchor_source, c.cycle_anchor_at,
         count(DISTINCT r.run_id) AS runs,
         bool_or(c.cycle_anchor_at IS NOT DISTINCT FROM r.cycle_anchor_at) AS matches_run
    FROM r JOIN ing.cycle_run cr ON cr.run_id = r.run_id JOIN ing.cycle c ON c.cycle_id = cr.cycle_id
   GROUP BY r.cohort, c.cyc_key, c.origin, c.anchor_source, c.cycle_anchor_at),
coh AS (       -- 0078 led :573-576 ORDER BY matches_run DESC, runs DESC, ledger_anchor_at ASC (원장 회차가 파생 회차보다 우선: 원장 → run 앵커)
  SELECT DISTINCT ON (g.cohort) g.cohort, g.cyc_key, g.origin, g.anchor_source
    FROM coh_grp g
   ORDER BY g.cohort, (g.origin = 'summary_cycles') DESC, g.matches_run DESC, g.runs DESC, g.cycle_anchor_at, g.cyc_key),
pin AS (
  SELECT r.cohort, r.scope_project_id, min(p.anchor) AS pin_anchor, bool_or(p.origin = 'operator') AS op_pin
    FROM r JOIN ing.answer a ON a.run_id = r.run_id AND a.status = 'completed'
    JOIN ing.answer_anchor_pin p ON p.job_id = a.job_id
   GROUP BY r.cohort, r.scope_project_id),
pc AS (
  SELECT pin.cohort, pin.pin_anchor, pin.op_pin, coalesce(
           (SELECT c.cyc_key FROM ing.cycle c WHERE c.scope_project_id = pin.scope_project_id AND c.origin = 'summary_cycles'
               AND (c.cycle_anchor_at AT TIME ZONE 'UTC')::date = pin.pin_anchor ORDER BY c.cycle_anchor_at, c.cyc_key LIMIT 1),
           (SELECT c.cyc_key FROM ing.cycle c WHERE c.scope_project_id = pin.scope_project_id AND c.origin = 'summary_cycles'
               AND c.anchor_date = pin.pin_anchor ORDER BY c.cycle_anchor_at, c.cyc_key LIMIT 1),
           (SELECT c.cyc_key FROM ing.cycle c WHERE c.scope_project_id = pin.scope_project_id
               AND c.anchor_date = pin.pin_anchor ORDER BY c.cycle_anchor_at, c.cyc_key LIMIT 1)) AS pin_cyc
    FROM pin)
SELECT r.run_id, r.run_key, r.scope_project_id, r.status AS run_status,
       coalesce(pc.pin_cyc, coh.cyc_key) AS cyc_key,
       (CASE WHEN pc.pin_cyc IS NOT NULL THEN 1
             WHEN coh.origin = 'summary_cycles' THEN 2
             WHEN coh.anchor_source = 'scope' THEN 3
             WHEN coh.anchor_source = 'derived' THEN 4
             WHEN coh.anchor_source = 'operator' THEN 5 END)::int2 AS anchor_src,
       (pc.pin_anchor IS NOT NULL AND pc.pin_cyc IS NULL) AS pin_unresolved,
       (coalesce(pc.op_pin, false) AND pc.pin_cyc IS NOT NULL) AS op_pin_kept
  FROM r LEFT JOIN coh ON coh.cohort = r.cohort LEFT JOIN pc ON pc.cohort = r.cohort;
CREATE UNIQUE INDEX ON _run_c (run_id);
-- 2b. 현행 프로필 resub_phantom_exclude(-v attrib_member=1): 답변 회차 = run 원장 멤버십(ing.cycle_run). 현행 앵커 표 cycle_id 는 run 의
--     summary_cycle_runs 회차(0078 refresh_answer_cycle_anchors run_ctx :821-845 의 run 수준 값)이고 사실표 생성기도 회차의 멤버 run 만 읽는다(lib/summary/generate/cycle.ts:316-323). 코호트 규칙
--     (pin → 원장 선택)은 앵커 날짜(anchor_src)에만 남는다. 그래서 재제출 run 은 원장 유령 회차(미발행)에, 원장 08-01·08-02 회차 멤버인데
--     pin 으로 07-24 에 접힌 run 은 그 원장 회차에 선다(stg hmg_r2 2026-10-01: 13,853 답변 = 39 + 13,814). 좌석은 회차 값(ing.cycle.round_date,
--     원장 이관 회차의 현행 좌석은 seed-20 §7-3 -v attrib_member=1). 예외: 운영자 pin(origin 'operator')이 회차로 풀린 코호트는 hub pin 규칙 유지.
\if :attrib_member
UPDATE _run_c rc SET cyc_key = m.cyc_key
  FROM ing.cycle_run cr JOIN ing.cycle m ON m.cycle_id = cr.cycle_id
 WHERE cr.run_id = rc.run_id AND NOT rc.op_pin_kept AND rc.cyc_key IS DISTINCT FROM m.cyc_key;
\endif
DO $a$ DECLARE v bigint; BEGIN
  SELECT count(*) INTO v FROM _run_c WHERE cyc_key IS NULL;
  IF v <> 0 THEN RAISE EXCEPTION '회차 미귀속 run %(ing.cycle_run 누락)', v; END IF;
  SELECT count(*) INTO v FROM _run_c WHERE pin_unresolved;
  IF v <> 0 THEN RAISE WARNING 'R02 pin 회차 미해소 run %건: 원장·파생 회차에 KST 날짜가 같은 회차가 없어 run 귀속 회차를 유지', v; END IF;
END $a$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. job 좌표(rd.job 원천, 모든 status·드롭 포함 G-24)
--    engine_key = target(dim_engine), prompt_key = prompt_id(없으면 0).
--    geo_key: global·project = 답변 region(scope_answers.region), website = 프롬프트 사이트 국가(가상 코드 포함, 0056·DB-측정-코어
--      "website geo = 사이트 국가") → 사이트 없으면 프로젝트 사이트 국가 → 답변 region.
--    lang_key = dim_prompt.lang_key(표면별 원천, seed-30 §7). cat_mask = dim_prompt.cat_mask.
--    bgrp: global = cat_mask(카탈로그 브랜드, standard-filters.ts:64 모수 규칙), website = 사이트 브랜드 비트(프롬프트 사이트 → 프로젝트 사이트),
--      project = 프로젝트 브랜드 비트(app.project.brand_code). 근거: DB-측정-코어.md §5 brand[] 행.
--    status_code: completed 0 · pending/running/queued/processing/in_progress 1 · failed/error/timeout 2 · 그 밖 3
--      (빌더 A run 카운터 unresolved 술어 seed-20 1-8 과 같은 어휘). dropped = ing.answer_drop 등재(0054 드롭 레지스트리).
-- ════════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS _job;
CREATE TEMP TABLE _job AS
SELECT a.answer_key, a.job_id, a.run_month, a.run_id, a.prompt_id, a.target, a.region, a.status, a.measured_at,
       a.analysis_status, a.n_mentions, a.n_citations,
       rc.run_key, rc.run_status, rc.cyc_key, rc.anchor_src, c.round_date, c.anchor_date,
       dp.surface, dp.project_key,
       coalesce(pr.prompt_key, 0) AS prompt_key, coalesce(pr.kind, 'single') AS kind, coalesce(pr.cat_mask, 0::int2) AS cat_mask,
       coalesce(pr.lang_key, 0::int2) AS lang_key, coalesce(pr.in_root_catalog, false) AS in_root_catalog,
       coalesce(pr.is_korean, false) AS is_korean, pr.regions AS p_regions, coalesce(pr.web_reg, false) AS p_web_reg,
       pr.unit_key, coalesce(pr.targets, '{}') AS targets,
       coalesce(e.engine_key, 0::int2) AS engine_key, coalesce(e.is_default, false) AS dflt,
       (CASE WHEN dp.surface = 2 THEN coalesce(ws.geo_key, nullif(dp.site_geo_key, 0), gr.geo_key, 0)
             ELSE coalesce(gr.geo_key, 0) END)::int2 AS geo_key,
       coalesce(gr.hidden_standard, false) AS region_hidden,
       -- region_geo_key(DB-v2.15 P87, WU-7 GEOAX): 답변 region 의 geo_key(사이트 국가 우선 없이, 없으면 0). 정본 rd.answer_region_geo,
       --   적재기 apply FACT_SRC 와 같은 식. global·project 는 geo_key 와 같다(CHECK answer_region_geo_same)
       coalesce(gr.geo_key, 0)::int2 AS region_geo_key,
       (CASE dp.surface WHEN 1 THEN coalesce(pr.cat_mask, 0)
                        WHEN 2 THEN coalesce(wb.brand_bit, nullif(dp.site_brand_bit, 0), 0)
                        ELSE coalesce(pb.brand_bit, 0) END)::int2 AS bgrp,
       (CASE WHEN a.status = 'completed' THEN 0
             WHEN a.status IN ('pending', 'running', 'queued', 'processing', 'in_progress') THEN 1
             WHEN a.status IN ('failed', 'error', 'timeout') THEN 2 ELSE 3 END)::int2 AS status_code,
       EXISTS (SELECT 1 FROM ing.answer_drop d WHERE d.job_id = a.job_id) AS dropped,
       coalesce(CASE WHEN NOT cfg.force THEN c.ecat_ver::int4 END, cfg.dv) AS ecat_ver   -- 답변 버전(E1): 회차 고정 → 기준 버전
  FROM ing.answer a
  CROSS JOIN _ecat_cfg cfg
  JOIN _run_c rc ON rc.run_id = a.run_id
  JOIN rd.cycle c ON c.cyc_key = rc.cyc_key
  JOIN rd.dim_project dp ON dp.scope_project_id = rc.scope_project_id
  LEFT JOIN rd.dim_prompt pr ON pr.prompt_id = a.prompt_id
  LEFT JOIN rd.dim_engine e ON e.code = a.target
  LEFT JOIN rd.dim_country gr ON upper(gr.code) = upper(a.region)
  LEFT JOIN _wp_pick wpk ON wpk.scope_prompt_id = a.prompt_id AND dp.surface = 2
  LEFT JOIN rd.dim_country ws ON upper(ws.code) = upper(wpk.country_code)
  LEFT JOIN app.brand wb ON wb.brand_code = wpk.brand_code
  LEFT JOIN app.project pj ON pj.project_id = dp.project_id AND dp.surface = 3
  LEFT JOIN app.brand pb ON pb.brand_code = pj.brand_code;
CREATE UNIQUE INDEX ON _job (answer_key);
DO $a$ BEGIN
  IF (SELECT count(*) FROM _job) <> (SELECT count(*) FROM ing.answer) THEN RAISE EXCEPTION '_job ↔ ing.answer 행 수 불일치'; END IF;
END $a$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. 답변 판정(rd.answer 원천 = 완료·비드롭 job)
--    elig(R07): run 상태 completed·partial_failed(scope-aggregates.ts:822·827) ∧ global 이면
--      루트 카탈로그 소속(rootCatalogGate :921) ∧ 숨김 표준 국가 아님(rootHiddenRegionsExclusion :1023, region NULL 도 NOT IN 이 NULL → 제외)
--      ∧ NOT(region <> 'KR' ∧ 한국어 프롬프트 ∧ (태그 없음 ∨ measured_at < 2026-08-19T00:00Z ∨ measured_at NULL))
--        (한국어 비-KR 제외, 3치 논리 그대로. 동기화 S1 BE-1 = hmg-geo 2670a16 #302 태그 우선: scope-aggregates.ts@2670a16 rootKoreanNonKrPred
--         :1076-1110, scripts/summary/global-predicates.ts koreanNonKrPred :65, 경계 = lib/scope/region-tagging.ts:17. 태그 있음 ∧ 태깅 이후는
--         다음 태그 술어가 판정) ∧ 태그 시장 안(rootRegionTagPred :1118: 태그 없음 = 전체).
--      website·project 는 run 상태만(DB-측정-코어 R07 scope_ok "website·project 는 true").
--    dflt = 기본 엔진(0077 hmg_anchor_default_engines :202 → app.rule_param default_engines).
--    is_acr = dim_prompt.kind = 'acr'. acr_iter_rank(R13·A15) = 같은 run-셀(run, prompt, target, region: cellKeyForJob sync.ts:966) 안
--      measured_at DESC, answer_key DESC 순번. 분석(acr_summary) 유무에 의존하지 않는다. ACR 아닌 답변은 1.
--    analysis_state(A16·G-05): Scope analysis.status completed·partial = 분석됨(언급 행 있으면 0, 없으면 1), pending = 2, failed·skipped = 3.
--      status 가 NULL 이면(미러 시드는 전부 NULL, 빌더 A seed-20 1-7) 대용식 = 현행 분석 갭 술어(lib/summary/generate/cycle.ts:124-126:
--      언급·인용 행이 모두 없으면 결손) → 언급 있음 0, 인용만 있음 1, 둘 다 없음 2.
--    web_reg = website 답변 ∧ 웹사이트 카탈로그 등록 프롬프트(websitePromptUrlHitJobFlagsSql registered :9051).
-- ════════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS _ans;
CREATE TEMP TABLE _ans AS
SELECT j.*,
       (j.run_status IN ('completed', 'partial_failed')
        AND (j.surface <> 1 OR (
              j.in_root_catalog
              AND NOT (j.region_hidden OR (j.region IS NULL AND EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.surface = 'global')))
              AND coalesce(NOT (j.region <> 'KR' AND j.is_korean
                                AND (j.measured_at IS NULL OR j.measured_at < TIMESTAMPTZ '2026-08-19 00:00:00+00'
                                     OR j.p_regions IS NULL OR cardinality(j.p_regions) = 0)), false)
              AND (j.p_regions IS NULL OR cardinality(j.p_regions) = 0 OR coalesce(j.region = ANY (j.p_regions), false))))) AS elig,
       -- elig_nc(DB-v2.15 P89, A41): 위 elig 에서 루트 카탈로그 소속 항만 뺀 식(apply.project FACT_SRC·rd.answer_elig_nc 와 같다)
       (j.run_status IN ('completed', 'partial_failed')
        AND (j.surface <> 1 OR (
              NOT (j.region_hidden OR (j.region IS NULL AND EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.surface = 'global')))
              AND coalesce(NOT (j.region <> 'KR' AND j.is_korean
                                AND (j.measured_at IS NULL OR j.measured_at < TIMESTAMPTZ '2026-08-19 00:00:00+00'
                                     OR j.p_regions IS NULL OR cardinality(j.p_regions) = 0)), false)
              AND (j.p_regions IS NULL OR cardinality(j.p_regions) = 0 OR coalesce(j.region = ANY (j.p_regions), false))))) AS elig_nc,
       (j.kind = 'acr') AS is_acr,
       (CASE WHEN j.analysis_status IN ('completed', 'partial') THEN CASE WHEN j.n_mentions > 0 THEN 0 ELSE 1 END
             WHEN j.analysis_status = 'pending' THEN 2
             WHEN j.analysis_status IN ('failed', 'skipped') THEN 3
             WHEN j.n_mentions > 0 THEN 0 WHEN j.n_citations > 0 THEN 1 ELSE 2 END)::int2 AS analysis_state,
       (j.surface = 2 AND j.p_web_reg) AS web_reg
  FROM _job j WHERE j.status_code = 0 AND NOT j.dropped;
CREATE UNIQUE INDEX ON _ans (answer_key);
ALTER TABLE _ans ADD COLUMN acr_iter_rank int2 NOT NULL DEFAULT 1, ADD COLUMN is_rep bool NOT NULL DEFAULT false;
UPDATE _ans a SET acr_iter_rank = x.rk
  FROM (SELECT answer_key, row_number() OVER (PARTITION BY run_key, prompt_key, engine_key, coalesce(region, '')
                                              ORDER BY measured_at DESC NULLS LAST, answer_key DESC)::int2 AS rk
          FROM _ans WHERE is_acr) x
 WHERE x.answer_key = a.answer_key;
-- R05 is_rep: 회차 내부 (cyc_key, prompt, engine, geo) 셀 대표 1건. 회차 상태 비의존.
--   hub(rep_latest_first=0): elig 후보 중 measured_at DESC NULLS LAST, answer_key DESC(DDL rd.answer.is_rep 주석)
--   현행(rep_latest_first=1): 셀 전부에서 measured_at DESC NULLS FIRST, job_id 1건을 먼저 굳히고 elig_nc 가 아니면 대표 없음
--     (카탈로그 무관 게이트: 현행 CAT_CTE 는 삭제 행도 카탈로그로 보고 카탈로그 게이트는 조회 때 건다 → hub 는 scope_where. WU-4)
--     (hmg-geo 2670a16 surface-global.ts:464-478·surface-website.ts:307-317, 게이트는 조회 때 summary-trend-aggregates.ts:674-700)
\if :rep_latest_first
UPDATE _ans a SET is_rep = true
  FROM (SELECT answer_key, row_number() OVER (PARTITION BY surface, cyc_key, prompt_key, engine_key, geo_key
                                              ORDER BY measured_at DESC NULLS FIRST, job_id) AS rn
          FROM _ans) x
 WHERE x.answer_key = a.answer_key AND x.rn = 1 AND a.elig_nc;   -- 게이트 = 카탈로그 무관 elig_nc(DB-v2.15 P89, WU-4 A41)
\else
UPDATE _ans a SET is_rep = true
  FROM (SELECT answer_key, row_number() OVER (PARTITION BY surface, cyc_key, prompt_key, engine_key, geo_key
                                              ORDER BY measured_at DESC NULLS LAST, answer_key DESC) AS rn
          FROM _ans WHERE elig) x
 WHERE x.answer_key = a.answer_key AND x.rn = 1;
\endif
ALTER TABLE _ans ADD COLUMN acr_in bool, ADD COLUMN gap bool, ADD COLUMN std_in bool, ADD COLUMN cit_in bool,
                 ADD COLUMN std_in_nc bool, ADD COLUMN cit_in_nc bool;
UPDATE _ans SET acr_in = NOT (is_acr AND acr_iter_rank > 1), gap = analysis_state >= 2,
                std_in = elig AND NOT (is_acr AND acr_iter_rank > 1) AND analysis_state < 2,
                cit_in = elig AND NOT (is_acr AND acr_iter_rank > 1),   -- rd.answer 생성 열과 같은 식(DB-v2.1 :468-471)
                std_in_nc = elig_nc AND NOT (is_acr AND acr_iter_rank > 1) AND analysis_state < 2,   -- DB-v2.15 P89(A41)
                cit_in_nc = elig_nc AND NOT (is_acr AND acr_iter_rank > 1);
ANALYZE _ans;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. 언급 접기(G-01 (a)): 답변 × 표시 브랜드 × 경쟁 여부. 롤업 NULL 행은 싣지 않는다(canonRollupSql NULL 보존 :307).
--    표시 브랜드·경쟁 여부 = _bn_pair(seed-3x-common §6: J1 rid · J2 표시명 · J3 비경쟁). 이름 없음 = brand_key 0, competitive false.
--    rk(M04) = 답변 안 competitive ∧ 이름 있음 ∧ avg_position 있는 브랜드들을 min(avg_position) 으로 접어 rank()(ownBrandRankPerJobSql :493-538).
--    own_bit = dim_brand_name.own_bit(G-20 표시 브랜드 수준).
-- ════════════════════════════════════════════════════════════════════════════
-- 5-0 유효 언급(E1 엔티티 버전 오버레이, 설계 2-3 _ig_meff): 답변 버전 v 의 규칙을 원본 언급에 적용한다(적용 순서 고정).
--    ① 제거: 엔티티(또는 그 병합 대상)가 removed 인 언급을 뺀다 ② 관계: 모 브랜드 덮어쓰기(_ecat_x.parent, 병합 대상 것 포함)로 롤업을 바꾼다
--    ③ 롤업 대상이 removed 면 롤업 NULL(브랜드 귀속을 잃어 answer_brand 에 안 든다) ④ 차단·재매칭 보정(seed-4x-ecat.sql: _ecat_madj 값으로
--    바꾸거나 빼고, _ecat_hnew 새 언급을 더한다) ⑤ 병합은 표기 쌍의 rid(버전별 _alias_map)에서 접힌다(G20: 답변 × 표시 브랜드 1행, rid_n = 롤업 id 수).
--    v1(= 운영 명부 그대로)·legacy 는 ①~④ 입력이 비어 원본 언급과 같다(수용 기준: 현행 rd 와 md5 차이 0).
DROP TABLE IF EXISTS _ecat_in;
CREATE TEMP TABLE _ecat_in AS
SELECT s.answer_key, s.run_month, s.job_id, s.ecat_ver, a.content_hash,
       (CASE WHEN a.prompt_run_id IS NOT NULL THEN 2 ELSE 1 END)::int2 AS body_turn
  FROM _ans s JOIN ing.answer a ON a.run_month = s.run_month AND a.job_id = s.job_id
 WHERE (SELECT EXISTS (SELECT 1 FROM _ecat_blk) OR EXISTS (SELECT 1 FROM _ecat_add));
CREATE UNIQUE INDEX ON _ecat_in (answer_key);
ANALYZE _ecat_in;
\ir seed-4x-ecat.sql
DROP VIEW IF EXISTS _meff;
CREATE TEMP VIEW _meff AS
SELECT s.answer_key, s.ecat_ver AS ver, m.display_name AS disp, (xe.parent IS NOT NULL) AS ovr,
       CASE WHEN xr.entity_id IS NOT NULL THEN NULL ELSE coalesce(xe.parent, m.brand_rollup_entity_id) END AS rollup,
       coalesce(j.cnt, m.mention_count) AS mention_count,
       coalesce(j.s_pos, m.sentiment_positive) AS sentiment_positive, coalesce(j.s_neu, m.sentiment_neutral) AS sentiment_neutral,
       coalesce(j.s_neg, m.sentiment_negative) AS sentiment_negative, coalesce(j.s_mix, m.sentiment_mixed) AS sentiment_mixed,
       coalesce(j.t_mention, m.type_mention) AS type_mention, coalesce(j.t_recommendation, m.type_recommendation) AS type_recommendation,
       coalesce(j.t_comparison, m.type_comparison) AS type_comparison, coalesce(j.t_definition, m.type_definition) AS type_definition,
       coalesce(j.t_final_choice, m.type_final_choice) AS type_final_choice, m.avg_position
  FROM _ans s
  JOIN ing.mention m ON m.run_month = s.run_month AND m.job_id = s.job_id
  LEFT JOIN _ecat_x xe ON xe.ver = s.ecat_ver AND xe.entity_id = m.entity_id
  LEFT JOIN _ecat_x xr ON xr.ver = s.ecat_ver AND xr.entity_id = coalesce(xe.parent, m.brand_rollup_entity_id) AND xr.removed
  LEFT JOIN _ecat_madj j ON j.answer_key = s.answer_key AND j.ord = m.ord
 WHERE NOT coalesce(xe.removed, false) AND NOT coalesce(j.dropm, false)
UNION ALL
SELECT h.answer_key, s.ecat_ver, h.disp, h.ovr, h.rollup, h.cnt, 0, 0, 0, 0, h.cnt, 0, 0, 0, 0, h.avg_position
  FROM _ecat_hnew h JOIN _ans s ON s.answer_key = h.answer_key;
DROP TABLE IF EXISTS _mr;
CREATE TEMP TABLE _mr AS
SELECT e.answer_key, b.brand_key, p.competitive, b.own_bit, p.rid_bit, p.rid,
       e.mention_count, e.sentiment_positive, e.sentiment_neutral, e.sentiment_negative, e.sentiment_mixed,
       e.type_mention, e.type_recommendation, e.type_comparison, e.type_definition, e.type_final_choice, e.avg_position
  FROM _meff e
  JOIN _bn_pair p ON p.ver = e.ver AND p.dkey = coalesce(e.disp, '') AND p.dnull = (e.disp IS NULL) AND p.rollup = e.rollup AND p.ovr = e.ovr
  JOIN rd.dim_brand_name b ON b.bare = p.bare
 WHERE e.rollup IS NOT NULL;
DROP TABLE IF EXISTS _ab;
CREATE TEMP TABLE _ab AS
SELECT answer_key, brand_key, competitive, max(own_bit)::int2 AS own_bit,
       count(*)::int2 AS entity_rows, count(DISTINCT rid)::int2 AS rid_n, sum(mention_count)::int2 AS mention_count,
       sum(sentiment_positive)::int2 AS s_pos, sum(sentiment_neutral)::int2 AS s_neu,
       sum(sentiment_negative)::int2 AS s_neg, sum(sentiment_mixed)::int2 AS s_mix,
       sum(type_mention)::int2 AS t_mention, sum(type_recommendation)::int2 AS t_recommendation, sum(type_comparison)::int2 AS t_comparison,
       sum(type_definition)::int2 AS t_definition, sum(type_final_choice)::int2 AS t_final_choice,
       min(avg_position) AS tp
  FROM _mr GROUP BY answer_key, brand_key, competitive;
ALTER TABLE _ab ADD COLUMN rk int2 NOT NULL DEFAULT 0;
UPDATE _ab a SET rk = x.rk
  FROM (SELECT answer_key, brand_key, rank() OVER (PARTITION BY answer_key ORDER BY tp)::int2 AS rk
          FROM _ab WHERE competitive AND brand_key <> 0 AND tp IS NOT NULL) x
 WHERE x.answer_key = a.answer_key AND x.brand_key = a.brand_key AND a.competitive;
CREATE UNIQUE INDEX ON _ab (answer_key, brand_key, competitive);

-- 당사 요약(G-03, 답변 열): own_mask(M01) = 자사 행 비트 OR, own_rk_*(M04) = 자사 브랜드 행 rk 최소(0 제외),
--   ment_total(M02 분모) = competitive 행 언급 합, ment_*(M02 분자) = competitive ∧ 자사 행 언급 합,
--   sent_*(M03, A3 mixed 는 분모 포함·긍정 제외) = 자사 행 감성 합(현행 우호도는 경쟁 여부 필터 없음 :2936-2945).
DROP TABLE IF EXISTS _own;
CREATE TEMP TABLE _own AS
SELECT answer_key,
       coalesce(bit_or(own_bit) FILTER (WHERE own_bit <> 0), 0)::int2 AS own_mask,
       coalesce(min(rk) FILTER (WHERE own_bit = 1 AND rk > 0), 0)::int2 AS own_rk_h,
       coalesce(min(rk) FILTER (WHERE own_bit = 2 AND rk > 0), 0)::int2 AS own_rk_k,
       coalesce(min(rk) FILTER (WHERE own_bit = 4 AND rk > 0), 0)::int2 AS own_rk_g,
       coalesce(sum(mention_count) FILTER (WHERE competitive), 0)::int2 AS ment_total,
       coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 1), 0)::int2 AS ment_h,
       coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 2), 0)::int2 AS ment_k,
       coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 4), 0)::int2 AS ment_g,
       coalesce(sum(s_pos) FILTER (WHERE own_bit = 1), 0)::int2 AS sent_pos_h,
       coalesce(sum(s_pos) FILTER (WHERE own_bit = 2), 0)::int2 AS sent_pos_k,
       coalesce(sum(s_pos) FILTER (WHERE own_bit = 4), 0)::int2 AS sent_pos_g,
       coalesce(sum(s_neg) FILTER (WHERE own_bit = 1), 0)::int2 AS sent_neg_h,
       coalesce(sum(s_neg) FILTER (WHERE own_bit = 2), 0)::int2 AS sent_neg_k,
       coalesce(sum(s_neg) FILTER (WHERE own_bit = 4), 0)::int2 AS sent_neg_g,
       coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 1), 0)::int2 AS sent_all_h,
       coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 2), 0)::int2 AS sent_all_k,
       coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 4), 0)::int2 AS sent_all_g,
       -- DB-v2.18 P105 당사 언급 유형 마스크(비트 5b+i, 경쟁 여부·게이트 무관). 정본 rd.answer_t_own, 적재기 _ig_own 과 같은 식
       coalesce(bit_or(rd.t_own_bits(own_bit, t_mention, t_recommendation, t_comparison, t_definition, t_final_choice)), 0)::int2 AS t_own
  FROM _ab GROUP BY answer_key;
CREATE UNIQUE INDEX ON _own (answer_key);

-- ════════════════════════════════════════════════════════════════════════════
-- 6. 인용 판정(rd.citation 원천 = 완료·비드롭 job 의 ing.citation 전 행, G-02 원소 1:1)
--    url_key·source_key·owner_key = rd.dim_url(seed-30 §11). url NULL → url_key 0, 도메인 없음 → source_key 0(G-21 a).
--    loc_owned(표면 로컬 자사):
--      website = 유닛 판정 websiteUnitOwnedTargetClause lib/scope/website-owned-unit.ts:119 (base 항: 호스트 일치 ∧ ((base 접두 ∧ ¬형제 접두)
--        ∨ 루트 홈) — websiteUnitOwnedClause :96, 타겟 항: tracked NORM ∈ 유닛 turls). base 없는 유닛·유닛 없는 프롬프트는 false(wup 부재 :8480).
--      project = ownedBasePrefixClause scope-aggregates.ts:716 (프로젝트 접두 P = 설정 base ∪ (설정 없을 때) owned_prefix(project.domain)
--        ∪ 카탈로그 brand×country base, lib/scope/server.ts:866-890; 형제 모집단 = 전역 카탈로그 base 전량(GEO_OWNED_BASE_PREFIXES :736)).
--      global = false(전역 자사는 owner_key + 허용 배열, P1 예외).
--    tgt_hit: website = cited tracked NORM ∈ 그 프롬프트 자신의 타겟(targetMatchSql lib/scope/url-match-sql.ts:20, 빈 값 가드),
--      project = cited tracked NORM ∈ app.project_tracked_url.url_norm(Q5), global = false.
--    scope_key: global = 루트 project_key, website = unit_key(없으면 0), project = project_key(DB-인용 r.citation 정의).
--    src_first = (answer, source_key) 안 최소 ord(DB-인용 판정 '출처 첫 행', 현행 count(DISTINCT job_id) :6871 대체).
-- ════════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS _pprefix;
CREATE TEMP TABLE _pprefix AS   -- 프로젝트 표면 자사 접두
WITH pj AS (SELECT dp.project_key, p.project_id, p.domain, p.brand_code, p.country_code
              FROM rd.dim_project dp JOIN app.project p ON p.project_id = dp.project_id WHERE dp.surface = 3),
cfg AS (SELECT pj.project_key, pob.base_norm AS prefix FROM pj JOIN app.project_owned_base pob ON pob.project_id = pj.project_id)
SELECT DISTINCT project_key, prefix FROM (
  SELECT project_key, prefix FROM cfg
  UNION ALL SELECT pj.project_key, pg_temp.owned_prefix(pj.domain) FROM pj
   WHERE NOT EXISTS (SELECT 1 FROM cfg WHERE cfg.project_key = pj.project_key)
  UNION ALL SELECT pj.project_key, o.prefix FROM pj JOIN app.owned_base o
    ON o.kind = 'base' AND o.brand_code = pj.brand_code AND o.geo_code = pj.country_code) x
 WHERE coalesce(prefix, '') <> '';
DROP TABLE IF EXISTS _psib;
CREATE TEMP TABLE _psib AS      -- 선택되지 않은 더 긴 카탈로그 base(longerSiblings :736-741)
SELECT DISTINCT p.project_key, o.prefix AS q
  FROM _pprefix p JOIN app.owned_base o ON o.kind = 'base' AND length(o.prefix) > length(p.prefix) AND starts_with(o.prefix, p.prefix || '/')
 WHERE NOT EXISTS (SELECT 1 FROM _pprefix s WHERE s.project_key = p.project_key AND s.prefix = o.prefix);
CREATE INDEX ON _pprefix (project_key); CREATE INDEX ON _psib (project_key);

DROP TABLE IF EXISTS _cr;
CREATE TEMP TABLE _cr AS
SELECT s.answer_key, s.surface, s.round_date, s.cyc_key, s.prompt_key, s.project_key, s.engine_key, s.geo_key, s.lang_key, s.bgrp,
       s.unit_key, s.targets, s.cit_in, s.gap, s.dflt, s.cit_in_nc,
       c.ord, coalesce(u.url_key, 0) AS url_key, coalesce(u.source_key, 0) AS source_key, coalesce(u.owner_key, 0)::int2 AS owner_key,
       u.url_norm, u.url_base_norm, c.domain_label AS row_domain
  FROM _ans s
  JOIN ing.citation c ON c.run_month = s.run_month AND c.job_id = s.job_id
  LEFT JOIN rd.dim_url u ON c.url IS NOT NULL AND u.url_hash = sha256(convert_to(c.url, 'UTF8'));
\if :cit_row_host
-- G21A 행 단위 호스트 없는 인용(현행 그룹 키 COALESCE(lower(scope_citations.domain), '') = '', citation-group-key.ts:57)
UPDATE _cr SET source_key = 0 WHERE coalesce(row_domain, '') = '' AND source_key <> 0;
\endif
ALTER TABLE _cr ADD COLUMN loc_owned bool NOT NULL DEFAULT false, ADD COLUMN tgt_hit bool NOT NULL DEFAULT false,
                ADD COLUMN src_first bool NOT NULL DEFAULT false, ADD COLUMN scope_key int2 NOT NULL DEFAULT 0;
-- website
\if :web_tgt_base
-- OWN4 현행 타겟 비교 키 = base NORM(unitOwnedSql surface-website.ts:244-256). 유닛 타겟 base = turls(tracked NORM)에서 쿼리·끝 '/' 제거(적재기 WEB_TGT_ON)
UPDATE _cr c SET
  loc_owned = coalesce(
      (split_part(c.url_base_norm, '/', 1) = split_part(w.base, '/', 1)
       AND (((c.url_base_norm = w.base OR starts_with(c.url_base_norm, w.base || '/') OR c.url_base_norm = w.base || '.html')
             AND NOT EXISTS (SELECT 1 FROM unnest(w.sibs) q
                              WHERE c.url_base_norm = q OR starts_with(c.url_base_norm, q || '/') OR c.url_base_norm = q || '.html'))
            OR (w.home_host IS NOT NULL AND rtrim(split_part(c.url_base_norm, '?', 1), '/') = w.home_host)))
      OR (coalesce(c.url_base_norm, '') <> ''
          AND c.url_base_norm = ANY (ARRAY(SELECT rtrim(split_part(t, '?', 1), '/') FROM unnest(w.turls) t))), false),
  scope_key = w.unit_key
  FROM rd.web_unit w
 WHERE c.surface = 2 AND w.unit_key = c.unit_key AND w.base IS NOT NULL;
\else
UPDATE _cr c SET
  loc_owned = coalesce(
      (split_part(c.url_base_norm, '/', 1) = split_part(w.base, '/', 1)
       AND (((c.url_base_norm = w.base OR starts_with(c.url_base_norm, w.base || '/') OR c.url_base_norm = w.base || '.html')
             AND NOT EXISTS (SELECT 1 FROM unnest(w.sibs) q
                              WHERE c.url_base_norm = q OR starts_with(c.url_base_norm, q || '/') OR c.url_base_norm = q || '.html'))
            OR (w.home_host IS NOT NULL AND rtrim(split_part(c.url_base_norm, '?', 1), '/') = w.home_host)))
      OR (coalesce(c.url_norm, '') <> '' AND c.url_norm = ANY (w.turls)), false),
  scope_key = w.unit_key
  FROM rd.web_unit w
 WHERE c.surface = 2 AND w.unit_key = c.unit_key AND w.base IS NOT NULL;
\endif
UPDATE _cr c SET scope_key = coalesce(c.unit_key, 0) WHERE c.surface = 2 AND c.scope_key = 0;
UPDATE _cr c SET tgt_hit = coalesce(c.url_norm, '') <> '' AND c.url_norm = ANY (c.targets) WHERE c.surface = 2;
-- project
UPDATE _cr c SET
  loc_owned = coalesce(
      split_part(c.url_base_norm, '/', 1) IN (SELECT split_part(p.prefix, '/', 1) FROM _pprefix p WHERE p.project_key = c.project_key)
      AND ((EXISTS (SELECT 1 FROM _pprefix p WHERE p.project_key = c.project_key
                     AND (c.url_base_norm = p.prefix OR starts_with(c.url_base_norm, p.prefix || '/') OR c.url_base_norm = p.prefix || '.html'))
            AND NOT EXISTS (SELECT 1 FROM _psib q WHERE q.project_key = c.project_key
                     AND (c.url_base_norm = q.q OR starts_with(c.url_base_norm, q.q || '/') OR c.url_base_norm = q.q || '.html')))
           OR rtrim(split_part(c.url_base_norm, '?', 1), '/') IN (
                SELECT split_part(p.prefix, '/', 1) FROM _pprefix p WHERE p.project_key = c.project_key
                   AND split_part(p.prefix, '/', 1) NOT IN (SELECT host FROM _r_shared_host))), false),
  tgt_hit = coalesce(c.url_norm, '') <> '' AND EXISTS (
      SELECT 1 FROM app.project_tracked_url t JOIN rd.dim_project dp ON dp.project_id = t.project_id
       WHERE dp.project_key = c.project_key AND t.url_norm = c.url_norm),
  scope_key = c.project_key
 WHERE c.surface = 3;
-- global
UPDATE _cr c SET scope_key = c.project_key WHERE c.surface = 1;
UPDATE _cr c SET src_first = true
  FROM (SELECT answer_key, ord, row_number() OVER (PARTITION BY answer_key, source_key ORDER BY ord) AS rn FROM _cr) x
 WHERE x.answer_key = c.answer_key AND x.ord = c.ord AND x.rn = 1;
CREATE UNIQUE INDEX ON _cr (answer_key, ord);

-- 답변 단위 인용 판정(M06·M07 A2 측정 단위, websitePromptUrlHitJobFlagsSql :9051-9054): 호스트 있는 인용만(G-21 a)
--   has_cit = 인용 있음, tgt_cited = 타겟 일치 인용 있음, own_url_cited = 자사(로컬) 또는 타겟 일치 인용 있음(owned_hit = owned_base_hit ∨ target_hit).
DROP TABLE IF EXISTS _citf;
CREATE TEMP TABLE _citf AS
SELECT answer_key, bool_or(source_key <> 0) AS has_cit,
       coalesce(bool_or(tgt_hit) FILTER (WHERE source_key <> 0), false) AS tgt_cited,
       coalesce(bool_or(loc_owned OR tgt_hit) FILTER (WHERE source_key <> 0), false) AS own_url_cited
  FROM _cr GROUP BY answer_key;
CREATE UNIQUE INDEX ON _citf (answer_key);

-- 답변당 인용 수 열(G-25, DB-v2.2 P21): 호스트 있는 인용(source_key <> 0)만 센다(M05 분모·G-21 a).
--   cit_own_h/k/g = owner_key 브랜드별(글로벌 자사 판정식 owner_key = ANY(허용 배열)의 브랜드 분해),
--   *c = 소유 베이스 geo_code = 답변 국가 코드(국가 필터로 좁힌 허용 배열), cit_own_x = 3사 중 국가 있고 답변 국가와 다름,
--   cit_loc·cit_tgt·cit_loc_tgt = 프로젝트 자사·타겟·웹사이트 자사, cit_off = 출처 카테고리(rd.dim_source.category_key, seed-30 §11 이 이미 채움)가
--   Official (HMG) 인 수(DB-v2.13 P71, 글로벌 ⑤ 분자 hmg-geo #320·#321). 정본 식은 rd.answer_cit_counts(DB-v2.2 P22·v2.13 P72) 이고
--   8절 청크마다 rd.assert_answer_cit_counts 가 이 값과 대조한다(두 구현 교차 검증).
--   DB-v2.15 P86(WU-5): cit_n_all = 모든 인용 원소(호스트 없는 인용 포함, G21A ⑤ 분모), cit_c<k> = 호스트 있는 인용 중 출처 카테고리 k 인 수
--   (인용 성능 수정안 B, 합 = cit_n). 정본 rd.answer_cit_ext, 8절에서 cit 열·region_geo_key(P87, 3절 _job)를 정본 재계산과 각각 대조.
DROP TABLE IF EXISTS _citc;
CREATE TEMP TABLE _citc AS
SELECT c.answer_key,
       count(*) FILTER (WHERE c.source_key <> 0)::int2 AS cit_n,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit = 1)::int2 AS cit_own_h,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit = 2)::int2 AS cit_own_k,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit = 4)::int2 AS cit_own_g,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit = 1 AND ob.geo = upper(g.code))::int2 AS cit_own_hc,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit = 2 AND ob.geo = upper(g.code))::int2 AS cit_own_kc,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit = 4 AND ob.geo = upper(g.code))::int2 AS cit_own_gc,
       count(*) FILTER (WHERE c.source_key <> 0 AND ob.bit IN (1, 2, 4) AND ob.geo IS NOT NULL AND ob.geo IS DISTINCT FROM upper(g.code))::int2 AS cit_own_x,
       count(*) FILTER (WHERE c.source_key <> 0 AND c.loc_owned)::int2 AS cit_loc,
       count(*) FILTER (WHERE c.source_key <> 0 AND c.tgt_hit)::int2 AS cit_tgt,
       count(*) FILTER (WHERE c.source_key <> 0 AND (c.loc_owned OR c.tgt_hit))::int2 AS cit_loc_tgt,
       count(*) FILTER (WHERE c.source_key <> 0
                          AND s.category_key = (SELECT cc.category_key FROM app.citation_category cc WHERE cc.name = 'Official (HMG)'))::int2
         AS cit_off,
       count(*)::int2 AS cit_n_all,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 1)::int2 AS cit_c1,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 2)::int2 AS cit_c2,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 3)::int2 AS cit_c3,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 4)::int2 AS cit_c4,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 5)::int2 AS cit_c5,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 6)::int2 AS cit_c6,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 7)::int2 AS cit_c7,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 8)::int2 AS cit_c8,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 9)::int2 AS cit_c9,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 10)::int2 AS cit_c10,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 11)::int2 AS cit_c11,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 12)::int2 AS cit_c12,
       count(*) FILTER (WHERE c.source_key <> 0 AND s.category_key = 13)::int2 AS cit_c13
  FROM _cr c
  LEFT JOIN (SELECT o.owner_key, b.brand_bit AS bit, upper(o.geo_code) AS geo
               FROM app.owned_base o JOIN app.brand b ON b.brand_code = o.brand_code) ob ON ob.owner_key = c.owner_key
  LEFT JOIN rd.dim_country g ON g.geo_key = c.geo_key
  LEFT JOIN rd.dim_source s ON s.source_key = c.source_key
 GROUP BY c.answer_key;
CREATE UNIQUE INDEX ON _citc (answer_key);

-- ════════════════════════════════════════════════════════════════════════════
-- 7. leaf 선생성(rd.ensure_leaf: global·website 월, project 분기) → INSERT
-- ════════════════════════════════════════════════════════════════════════════
SELECT count(*) AS leaves_needed FROM (SELECT DISTINCT surface, date_trunc('month', round_date) FROM _ans) x;
DO $l$ DECLARE r record; BEGIN
  FOR r IN SELECT DISTINCT surface, date_trunc('month', round_date)::date AS m FROM _ans ORDER BY 1, 2 LOOP
    PERFORM rd.ensure_leaf(r.surface, r.m);
  END LOOP;
END $l$;

INSERT INTO rd.job (answer_key, job_id, run_key, prompt_key, cyc_key, round_date, measured_at, surface, project_key, engine_key, geo_key,
                    lang_key, bgrp, status_code, analysis_code, dropped, served, load_id)
SELECT j.answer_key, j.job_id, j.run_key, j.prompt_key, j.cyc_key, j.round_date, j.measured_at, j.surface, j.project_key, j.engine_key,
       j.geo_key, j.lang_key, j.bgrp, j.status_code, coalesce(a.analysis_state, 0), j.dropped, (j.status_code = 0 AND NOT j.dropped), :l40
  FROM _job j LEFT JOIN _ans a ON a.answer_key = j.answer_key;

INSERT INTO rd.answer (round_date, answer_key, anchor_date, cyc_key, run_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key,
                       cat_mask, bgrp, anchor_src, acr_iter_rank, analysis_state,
                       own_mask, own_rk_h, own_rk_k, own_rk_g, ment_total, ment_h, ment_k, ment_g,
                       sent_pos_h, sent_pos_k, sent_pos_g, sent_neg_h, sent_neg_k, sent_neg_g, sent_all_h, sent_all_k, sent_all_g, t_own,
                       elig, dflt, is_acr, is_rep, web_reg, has_cit, tgt_cited, own_url_cited, rule_ver, load_id,
                       cit_n, cit_own_h, cit_own_k, cit_own_g, cit_own_hc, cit_own_kc, cit_own_gc, cit_own_x, cit_loc, cit_tgt, cit_loc_tgt,
                       cit_off, elig_nc, std_in_nc, cit_in_nc,
                       cit_n_all, cit_c1, cit_c2, cit_c3, cit_c4, cit_c5, cit_c6, cit_c7, cit_c8, cit_c9, cit_c10, cit_c11, cit_c12, cit_c13, ecat_ver,
                       region_geo_key)
SELECT a.round_date, a.answer_key, a.anchor_date, a.cyc_key, a.run_key, a.prompt_key, a.surface, a.project_key, a.engine_key, a.geo_key,
       a.lang_key, a.cat_mask, a.bgrp, a.anchor_src, a.acr_iter_rank, a.analysis_state,
       coalesce(o.own_mask, 0), coalesce(o.own_rk_h, 0), coalesce(o.own_rk_k, 0), coalesce(o.own_rk_g, 0),
       coalesce(o.ment_total, 0), coalesce(o.ment_h, 0), coalesce(o.ment_k, 0), coalesce(o.ment_g, 0),
       coalesce(o.sent_pos_h, 0), coalesce(o.sent_pos_k, 0), coalesce(o.sent_pos_g, 0),
       coalesce(o.sent_neg_h, 0), coalesce(o.sent_neg_k, 0), coalesce(o.sent_neg_g, 0),
       coalesce(o.sent_all_h, 0), coalesce(o.sent_all_k, 0), coalesce(o.sent_all_g, 0), coalesce(o.t_own, 0),
       a.elig, a.dflt, a.is_acr, a.is_rep, a.web_reg,
       coalesce(f.has_cit, false), coalesce(f.tgt_cited, false), coalesce(f.own_url_cited, false), :rv, :l40,
       coalesce(t.cit_n, 0), coalesce(t.cit_own_h, 0), coalesce(t.cit_own_k, 0), coalesce(t.cit_own_g, 0),
       coalesce(t.cit_own_hc, 0), coalesce(t.cit_own_kc, 0), coalesce(t.cit_own_gc, 0), coalesce(t.cit_own_x, 0),
       coalesce(t.cit_loc, 0), coalesce(t.cit_tgt, 0), coalesce(t.cit_loc_tgt, 0), coalesce(t.cit_off, 0), a.elig_nc, a.std_in_nc, a.cit_in_nc,
       coalesce(t.cit_n_all, 0), coalesce(t.cit_c1, 0), coalesce(t.cit_c2, 0), coalesce(t.cit_c3, 0), coalesce(t.cit_c4, 0), coalesce(t.cit_c5, 0), coalesce(t.cit_c6, 0), coalesce(t.cit_c7, 0), coalesce(t.cit_c8, 0), coalesce(t.cit_c9, 0), coalesce(t.cit_c10, 0), coalesce(t.cit_c11, 0), coalesce(t.cit_c12, 0), coalesce(t.cit_c13, 0),
       a.ecat_ver::int2, a.region_geo_key
  FROM _ans a LEFT JOIN _own o ON o.answer_key = a.answer_key LEFT JOIN _citf f ON f.answer_key = a.answer_key
  LEFT JOIN _citc t ON t.answer_key = a.answer_key;

INSERT INTO rd.answer_brand (round_date, answer_key, brand_key, cyc_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key, bgrp,
                             own_bit, entity_rows, mention_count, rk, s_pos, s_neu, s_neg, s_mix,
                             t_mention, t_recommendation, t_comparison, t_definition, t_final_choice,
                             competitive, std_in, elig, dflt, rule_ver, std_in_nc, rid_n, is_rep)
SELECT a.round_date, b.answer_key, b.brand_key, a.cyc_key, a.prompt_key, a.surface, a.project_key, a.engine_key, a.geo_key, a.lang_key, a.bgrp,
       b.own_bit, b.entity_rows, b.mention_count, b.rk, b.s_pos, b.s_neu, b.s_neg, b.s_mix,
       b.t_mention, b.t_recommendation, b.t_comparison, b.t_definition, b.t_final_choice,
       b.competitive, a.std_in, a.elig, a.dflt, :rv, a.std_in_nc, b.rid_n, a.is_rep
  FROM _ab b JOIN _ans a ON a.answer_key = b.answer_key;

-- 스탠스(1:1): entity_key = dim_entity, 표시 브랜드·own_bit = (brand_label, entity_id) 쌍의 J1·J2(aggregateAnswerStanceDistributionFromMirror
--   :7401-7407 이 canonRollupSql 을 (entity_id, brand_label) 로 재사용), first_turn = (답변, 엔티티) 안 최저 turn_index(:7401 DISTINCT ON).
--   cyc_key = rd.answer.cyc_key 사본(DB-v2.5 P42, answer_brand·citation 과 같은 투영 규칙).
INSERT INTO rd.answer_stance (round_date, answer_key, entity_key, brand_key, surface, turn_index, own_bit, stance, first_turn, std_in, cyc_key,
                              std_in_nc, is_rep)
SELECT a.round_date, a.answer_key, e.entity_key, coalesce(b.brand_key, 0), a.surface, st.turn_index, coalesce(b.own_bit, 0),
       (CASE st.stance WHEN 'positive' THEN 1 WHEN 'neutral' THEN 2 WHEN 'mixed' THEN 3 WHEN 'negative' THEN 4 END)::int2,
       st.turn_index = min(st.turn_index) OVER (PARTITION BY a.answer_key, st.entity_id),
       a.std_in, a.cyc_key, a.std_in_nc, a.is_rep
  FROM _ans a
  JOIN ing.answer_stance st ON st.run_month = a.run_month AND st.job_id = a.job_id
  JOIN rd.dim_entity e ON e.entity_id = st.entity_id
  LEFT JOIN _ecat_x xs ON xs.ver = a.ecat_ver AND xs.entity_id = st.entity_id AND xs.removed      -- E1: 제거 엔티티 스탠스 제외
  LEFT JOIN _bn_pair p ON p.ver = a.ecat_ver AND NOT p.ovr
                      AND p.dkey = coalesce(st.brand_label, '') AND p.dnull = (st.brand_label IS NULL) AND p.rollup = st.entity_id
  LEFT JOIN rd.dim_brand_name b ON b.bare = p.bare
 WHERE xs.entity_id IS NULL;

INSERT INTO rd.citation (round_date, answer_key, url_key, source_key, cyc_key, prompt_key, surface, ord, project_key, engine_key, geo_key,
                         lang_key, bgrp, scope_key, owner_key, cit_in, gap, dflt, loc_owned, tgt_hit, src_first, rule_ver, cit_in_nc, is_rep)
SELECT c.round_date, c.answer_key, c.url_key, c.source_key, c.cyc_key, c.prompt_key, c.surface, c.ord, c.project_key, c.engine_key, c.geo_key,
       c.lang_key, c.bgrp, c.scope_key, c.owner_key, c.cit_in, c.gap, c.dflt, c.loc_owned, c.tgt_hit, c.src_first, :rv, c.cit_in_nc, a.is_rep
  FROM _cr c JOIN _ans a ON a.answer_key = c.answer_key;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. 게이트 전파(B3) 5만 청크 → 불변식 단언
-- ════════════════════════════════════════════════════════════════════════════
-- 같은 트랜잭션에서 방금 채운 leaf 는 통계가 없다 → 전파 함수의 조인이 중첩 루프로 퇴화한다(로컬 10만 답변에서 5만 청크 1회가 10분 초과 실측).
--   ANALYZE 는 트랜잭션 안에서 허용되며 커밋 전 통계로 계획을 세우게 한다.
ANALYZE rd.job, rd.answer, rd.answer_brand, rd.answer_stance, rd.citation;
-- 답변분석 경로 셀 대표(WU-12): 위 §4 의 회차 셀 대표를 round_date 셀 규칙으로 다시 고르고 인용 계열 보정 표를 채운다. 자식 사본은 바로 아래 게이트 전파가 맞춘다.
DO $r$ BEGIN IF to_regclass('rd.rep_cit_delta') IS NOT NULL THEN TRUNCATE rd.rep_cit_delta; END IF; END $r$;
\if :rep_round_date_cell
SELECT count(*) AS seat_rep_flips FROM rd.reselect_rep_seat(NULL, NULL, NULL, NULL);
\endif
DROP TABLE IF EXISTS _prop;
CREATE TEMP TABLE _prop (chunk int, n int, cit_checked int);
DO $p$ DECLARE lo int := 0; k int[]; n int; c int; i int := 0; BEGIN
  LOOP
    SELECT array_agg(answer_key ORDER BY answer_key) INTO k
      FROM (SELECT answer_key FROM rd.job WHERE served AND answer_key > lo ORDER BY answer_key LIMIT 50000) x;
    EXIT WHEN k IS NULL;
    n := rd.propagate_answer_gates(k);
    c := rd.assert_answer_cit_counts(k);   -- G-25 ① 자식 합 = 답변 인용 수 열(적재기와 같은 단언 경로)
    PERFORM rd.assert_answer_nc(k);        -- DB-v2.15 P89(A41 모수 열 = 재계산, 자식 사본 = 부모. 적재기와 같은 단언 경로)
    -- DB-v2.15 P86(WU-5 cit_n_all·cit_c1..13 = 정본 재계산 rd.answer_cit_ext. 적재기 ASSERT_CIT_EXT 와 같은 식)
    IF EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
                 LEFT JOIN rd.answer_cit_ext(k) x ON x.surface = j.surface AND x.round_date = j.round_date AND x.answer_key = j.answer_key
                WHERE j.answer_key = ANY (k) AND j.served
                  AND (a.cit_n_all, a.cit_c1, a.cit_c2, a.cit_c3, a.cit_c4, a.cit_c5, a.cit_c6, a.cit_c7, a.cit_c8, a.cit_c9, a.cit_c10, a.cit_c11, a.cit_c12, a.cit_c13)
                      IS DISTINCT FROM (coalesce(x.cit_n_all, 0)::int2, coalesce(x.cit_c1, 0)::int2, coalesce(x.cit_c2, 0)::int2, coalesce(x.cit_c3, 0)::int2, coalesce(x.cit_c4, 0)::int2, coalesce(x.cit_c5, 0)::int2, coalesce(x.cit_c6, 0)::int2, coalesce(x.cit_c7, 0)::int2, coalesce(x.cit_c8, 0)::int2, coalesce(x.cit_c9, 0)::int2, coalesce(x.cit_c10, 0)::int2, coalesce(x.cit_c11, 0)::int2, coalesce(x.cit_c12, 0)::int2, coalesce(x.cit_c13, 0)::int2)) THEN
      RAISE EXCEPTION '불변식 위반: cit_n_all·cit_c1..13 ≠ 재계산(DB-v2.15 P86)';
    END IF;
    -- DB-v2.15 P87(WU-7 region_geo_key = 정본 재계산 rd.answer_region_geo, NULL 금지. 적재기 ASSERT_REGION_GEO 와 같은 식)
    IF EXISTS (SELECT 1 FROM rd.job j JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
                 LEFT JOIN rd.answer_region_geo(k) g ON g.surface = j.surface AND g.round_date = j.round_date AND g.answer_key = j.answer_key
                WHERE j.answer_key = ANY (k) AND j.served AND a.region_geo_key IS DISTINCT FROM g.region_geo_key) THEN
      RAISE EXCEPTION '불변식 위반: region_geo_key ≠ 재계산(DB-v2.15 P87)';
    END IF;
    i := i + 1; INSERT INTO _prop VALUES (i, n, c);
    lo := k[cardinality(k)];
  END LOOP;
END $p$;
DO $a$ BEGIN
  IF (SELECT coalesce(sum(cit_checked), 0) FROM _prop) <> (SELECT count(*) FROM rd.answer) THEN
    RAISE EXCEPTION '불변식 위반: G-25 인용 수 단언이 서빙 답변 전부를 덮지 않음';
  END IF;
END $a$;

DO $a$ DECLARE v bigint; BEGIN
  -- ① 위치: served ⇔ rd.answer 존재(같은 좌표), analysis_code 일치
  SELECT count(*) INTO v FROM rd.job j LEFT JOIN rd.answer a ON a.surface = j.surface AND a.round_date = j.round_date AND a.answer_key = j.answer_key
   WHERE j.served <> (a.answer_key IS NOT NULL) OR (a.answer_key IS NOT NULL AND (j.analysis_code, j.cyc_key) IS DISTINCT FROM (a.analysis_state, a.cyc_key));
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: rd.job ↔ rd.answer 위치·코드 %', v; END IF;
  -- ② answer_key 전역 유일(파티션 표라 DB 제약 불가, DB-v2.1 :581-583)
  SELECT count(*) INTO v FROM (SELECT answer_key FROM rd.answer GROUP BY 1 HAVING count(*) > 1) x;
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: rd.answer answer_key 중복 %', v; END IF;
  -- ③ 답변 좌표 = 회차 좌표(round_date·anchor_date)
  SELECT count(*) INTO v FROM rd.answer a JOIN rd.cycle c ON c.cyc_key = a.cyc_key
   WHERE (a.round_date, a.anchor_date, a.surface, a.project_key) IS DISTINCT FROM (c.round_date, c.anchor_date, c.surface, c.project_key);
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: rd.answer ↔ rd.cycle 좌표 %', v; END IF;
  -- ④ 당사 합 불변식(G-03): answer_brand 자사 행 합 = rd.answer 당사 열(자식 없는 답변은 0)
  SELECT count(*) INTO v FROM rd.answer a
    LEFT JOIN (SELECT surface, round_date, answer_key,
                      coalesce(bit_or(own_bit) FILTER (WHERE own_bit <> 0), 0) AS own_mask,
                      coalesce(min(rk) FILTER (WHERE own_bit = 1 AND rk > 0), 0) AS rk_h,
                      coalesce(min(rk) FILTER (WHERE own_bit = 2 AND rk > 0), 0) AS rk_k,
                      coalesce(min(rk) FILTER (WHERE own_bit = 4 AND rk > 0), 0) AS rk_g,
                      coalesce(sum(mention_count) FILTER (WHERE competitive), 0) AS mt,
                      coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 1), 0) AS mh,
                      coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 2), 0) AS mk,
                      coalesce(sum(mention_count) FILTER (WHERE competitive AND own_bit = 4), 0) AS mg,
                      coalesce(sum(s_pos) FILTER (WHERE own_bit = 1), 0) AS ph, coalesce(sum(s_pos) FILTER (WHERE own_bit = 2), 0) AS pk,
                      coalesce(sum(s_pos) FILTER (WHERE own_bit = 4), 0) AS pg,
                      coalesce(sum(s_neg) FILTER (WHERE own_bit = 1), 0) AS nh, coalesce(sum(s_neg) FILTER (WHERE own_bit = 2), 0) AS nk,
                      coalesce(sum(s_neg) FILTER (WHERE own_bit = 4), 0) AS ng,
                      coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 1), 0) AS ah,
                      coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 2), 0) AS ak,
                      coalesce(sum(s_pos + s_neu + s_neg + s_mix) FILTER (WHERE own_bit = 4), 0) AS ag,
                      coalesce(bit_or(rd.t_own_bits(own_bit, t_mention, t_recommendation, t_comparison, t_definition, t_final_choice)), 0) AS tw
                 FROM rd.answer_brand GROUP BY 1, 2, 3) b
      ON b.surface = a.surface AND b.round_date = a.round_date AND b.answer_key = a.answer_key
   WHERE (a.own_mask, a.own_rk_h, a.own_rk_k, a.own_rk_g, a.ment_total, a.ment_h, a.ment_k, a.ment_g,
          a.sent_pos_h, a.sent_pos_k, a.sent_pos_g, a.sent_neg_h, a.sent_neg_k, a.sent_neg_g, a.sent_all_h, a.sent_all_k, a.sent_all_g, a.t_own)
         IS DISTINCT FROM
         (coalesce(b.own_mask, 0), coalesce(b.rk_h, 0), coalesce(b.rk_k, 0), coalesce(b.rk_g, 0), coalesce(b.mt, 0), coalesce(b.mh, 0),
          coalesce(b.mk, 0), coalesce(b.mg, 0), coalesce(b.ph, 0), coalesce(b.pk, 0), coalesce(b.pg, 0), coalesce(b.nh, 0), coalesce(b.nk, 0),
          coalesce(b.ng, 0), coalesce(b.ah, 0), coalesce(b.ak, 0), coalesce(b.ag, 0), coalesce(b.tw, 0));
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: 당사 합 ≠ 답변 열 %', v; END IF;
  -- ⑤ 게이트 동치(전파 함수가 answer_brand·citation 을 단언, 여기서 answer_stance 와 자식 고아까지)
  SELECT count(*) INTO v FROM rd.answer_stance s LEFT JOIN rd.answer a ON a.surface = s.surface AND a.round_date = s.round_date AND a.answer_key = s.answer_key
   WHERE a.answer_key IS NULL OR (s.std_in, s.cyc_key) IS DISTINCT FROM (a.std_in, a.cyc_key);
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: answer_stance 게이트·고아 %', v; END IF;
  SELECT count(*) INTO v FROM rd.answer_brand s LEFT JOIN rd.answer a ON a.surface = s.surface AND a.round_date = s.round_date AND a.answer_key = s.answer_key
   WHERE a.answer_key IS NULL OR (s.std_in, s.elig, s.dflt, s.cyc_key) IS DISTINCT FROM (a.std_in, a.elig, a.dflt, a.cyc_key);
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: answer_brand 게이트·고아 %', v; END IF;
  SELECT count(*) INTO v FROM rd.citation s LEFT JOIN rd.answer a ON a.surface = s.surface AND a.round_date = s.round_date AND a.answer_key = s.answer_key
   WHERE a.answer_key IS NULL OR (s.cit_in, s.gap, s.dflt, s.cyc_key) IS DISTINCT FROM (a.cit_in, a.gap, a.dflt, a.cyc_key);
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: citation 게이트·고아 %', v; END IF;
  -- ⑥ 1:1 그레인: 인용·스탠스 행 수 = 서빙 답변의 원본 행 수
  SELECT (SELECT count(*) FROM ing.citation c JOIN _ans a ON a.run_month = c.run_month AND a.job_id = c.job_id)
         - (SELECT count(*) FROM rd.citation) INTO v;
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: rd.citation ↔ ing.citation 1:1 %', v; END IF;
  SELECT (SELECT count(*) FROM ing.answer_stance c JOIN _ans a ON a.run_month = c.run_month AND a.job_id = c.job_id
            WHERE NOT EXISTS (SELECT 1 FROM _ecat_x x WHERE x.ver = a.ecat_ver AND x.entity_id = c.entity_id AND x.removed))
         - (SELECT count(*) FROM rd.answer_stance) INTO v;
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: rd.answer_stance ↔ ing.answer_stance(제거 엔티티 제외) 1:1 %', v; END IF;
  -- ⑦ 언급 보존: 롤업 있는 유효 언급(E1 오버레이 뒤) 행 수·언급 합 = answer_brand entity_rows·mention_count 합
  IF (SELECT (count(*), coalesce(sum(m.mention_count), 0)) FROM _meff m WHERE m.rollup IS NOT NULL)
     IS DISTINCT FROM (SELECT (coalesce(sum(entity_rows), 0), coalesce(sum(mention_count), 0)) FROM rd.answer_brand) THEN
    RAISE EXCEPTION '불변식 위반: 언급 접기 행·합 보존';
  END IF;
  -- ⑧ 답변 인용 불리언 = 자식 인용 판정(호스트 있는 행)
  SELECT count(*) INTO v FROM rd.answer a
    LEFT JOIN (SELECT surface, round_date, answer_key, bool_or(source_key <> 0) AS hc,
                      coalesce(bool_or(tgt_hit) FILTER (WHERE source_key <> 0), false) AS tc,
                      coalesce(bool_or(loc_owned OR tgt_hit) FILTER (WHERE source_key <> 0), false) AS oc
                 FROM rd.citation GROUP BY 1, 2, 3) c ON c.surface = a.surface AND c.round_date = a.round_date AND c.answer_key = a.answer_key
   WHERE (a.has_cit, a.tgt_cited, a.own_url_cited) IS DISTINCT FROM (coalesce(c.hc, false), coalesce(c.tc, false), coalesce(c.oc, false));
  IF v <> 0 THEN RAISE EXCEPTION '불변식 위반: 답변 인용 불리언 ≠ 인용 판정 %', v; END IF;
END $a$;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. ACR(rd.acr_cell · rd.acr_cell_job · rd.acr_choice): ing.acr_prompt_run·acr_rollup_row 와 1:1
--    회차 = run 귀속 회차(ACR 롤업에는 job_id 가 없어 run 축, anchorRunClause 사용 :9243 주석). 셀 축·bgrp 는 답변과 같은 규칙.
--    acr_in(R07·G-11) = run 상태 ∧ 프롬프트 kind = 'acr' ∧ (global 이면 답변 elig 와 같은 카탈로그·시장 게이트, 한국어 비-KR 의 태깅 경계는
--      prompt-run measured_at). 현행 acrWhere(:9218) 는
--      기본 카탈로그 게이트가 없다(A4 고지). is_rep = 회차 내부 셀(cyc, prompt, engine, geo) acr_in 후보 중 measured_at DESC, acr_cell_key DESC 1건
--      (latestAcrPromptRunIds :9306 의 셀 스냅샷 규칙, prompt_run_id 대신 acr_cell_key).
--    acr_choice: level brand 1·product 2·company 3, brand_key = level 1 표시 브랜드(_acr_nm), parent_brand_key = product 소속 브랜드,
--      own_bit = acrIsOurs 행 수준 비트, name_own = 표시 브랜드(dim_brand_name) 자사 비트, keep = 비경쟁 제외(:9342).
-- ════════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS _acr;
CREATE TEMP TABLE _acr AS
SELECT p.acr_cell_key, p.prompt_run_id, p.run_id, p.target, p.region, p.measured_at, p.planned_iterations, p.valid_turn1_iterations,
       p.valid_acr_iterations, p.co_single_entity, p.co_conditional_multiple, p.co_generic_category, p.co_resolved_off_shortlist,
       p.co_unresolved_choice, p.co_none, p.source_job_ids,
       rc.cyc_key, c.round_date, c.anchor_date, dp.surface, dp.project_key, rc.run_status,
       coalesce(pr.prompt_key, 0) AS prompt_key, coalesce(pr.kind, 'single') AS kind, coalesce(pr.cat_mask, 0::int2) AS cat_mask,
       coalesce(pr.lang_key, 0::int2) AS lang_key, coalesce(pr.in_root_catalog, false) AS in_root_catalog, coalesce(pr.is_korean, false) AS is_korean,
       pr.regions AS p_regions, coalesce(e.engine_key, 0::int2) AS engine_key,
       (CASE WHEN dp.surface = 2 THEN coalesce(ws.geo_key, nullif(dp.site_geo_key, 0), gr.geo_key, 0) ELSE coalesce(gr.geo_key, 0) END)::int2 AS geo_key,
       coalesce(gr.hidden_standard, false) AS region_hidden,
       (CASE dp.surface WHEN 1 THEN coalesce(pr.cat_mask, 0) WHEN 2 THEN coalesce(wb.brand_bit, nullif(dp.site_brand_bit, 0), 0)
                        ELSE coalesce(pb.brand_bit, 0) END)::int2 AS bgrp,
       coalesce(CASE WHEN NOT cfg.force THEN c.ecat_ver::int4 END, cfg.dv) AS ecat_ver   -- E1: prompt-run 버전 = run 회차 고정 → 기준 버전
  FROM ing.acr_prompt_run p
  CROSS JOIN _ecat_cfg cfg
  JOIN _run_c rc ON rc.run_id = p.run_id
  JOIN rd.cycle c ON c.cyc_key = rc.cyc_key
  JOIN rd.dim_project dp ON dp.project_key = c.project_key
  LEFT JOIN rd.dim_prompt pr ON pr.prompt_id = p.prompt_id
  LEFT JOIN rd.dim_engine e ON e.code = p.target
  LEFT JOIN rd.dim_country gr ON upper(gr.code) = upper(p.region)
  LEFT JOIN _wp_pick wpk ON wpk.scope_prompt_id = p.prompt_id AND dp.surface = 2
  LEFT JOIN rd.dim_country ws ON upper(ws.code) = upper(wpk.country_code)
  LEFT JOIN app.brand wb ON wb.brand_code = wpk.brand_code
  LEFT JOIN app.project pj ON pj.project_id = dp.project_id AND dp.surface = 3
  LEFT JOIN app.brand pb ON pb.brand_code = pj.brand_code;
ALTER TABLE _acr ADD COLUMN acr_in bool, ADD COLUMN is_rep bool NOT NULL DEFAULT false;
UPDATE _acr SET acr_in =
  run_status IN ('completed', 'partial_failed') AND kind = 'acr'
  AND (surface <> 1 OR (in_root_catalog
       AND NOT (region_hidden OR (region IS NULL AND EXISTS (SELECT 1 FROM app.hidden_market h WHERE h.surface = 'global')))
       AND coalesce(NOT (region <> 'KR' AND is_korean
                         AND (measured_at IS NULL OR measured_at < TIMESTAMPTZ '2026-08-19 00:00:00+00'
                              OR p_regions IS NULL OR cardinality(p_regions) = 0)), false)
       AND (p_regions IS NULL OR cardinality(p_regions) = 0 OR coalesce(region = ANY (p_regions), false))));
UPDATE _acr a SET is_rep = true
  FROM (SELECT acr_cell_key, row_number() OVER (PARTITION BY cyc_key, prompt_key, engine_key, geo_key
                                                ORDER BY measured_at DESC NULLS LAST, acr_cell_key DESC) AS rn
          FROM _acr WHERE acr_in) x
 WHERE x.acr_cell_key = a.acr_cell_key AND x.rn = 1;

INSERT INTO rd.acr_cell (acr_cell_key, round_date, cyc_key, prompt_key, surface, bgrp, project_key, engine_key, geo_key, lang_key, cat_mask,
                         planned, valid_turn1, valid_acr, co_single, co_conditional, co_generic, co_off_shortlist, co_unresolved, co_none,
                         is_rep, acr_in, measured_date, rule_ver)
SELECT acr_cell_key, round_date, cyc_key, prompt_key, surface, bgrp, project_key, engine_key, geo_key, lang_key, cat_mask,
       planned_iterations, valid_turn1_iterations, valid_acr_iterations, co_single_entity, co_conditional_multiple, co_generic_category,
       co_resolved_off_shortlist, co_unresolved_choice, co_none, is_rep, acr_in,
       coalesce((measured_at AT TIME ZONE 'Asia/Seoul')::date, anchor_date), :rv
  FROM _acr;
INSERT INTO rd.acr_cell_job (answer_key, acr_cell_key)
SELECT DISTINCT k.answer_key, a.acr_cell_key
  FROM _acr a CROSS JOIN LATERAL unnest(a.source_job_ids) sj(job_id) JOIN ing.answer_key_map k ON k.job_id = sj.job_id;
INSERT INTO rd.acr_choice (acr_cell_key, entity_key, brand_key, parent_brand_key, level, own_bit, name_own,
                           appearance, choice, cond_choice, off_shortlist, unresolved, generic, keep)
SELECT p.acr_cell_key, e.entity_key,
       CASE WHEN r.rollup_level = 'brand' THEN coalesce(b.brand_key, 0) ELSE 0 END,
       CASE WHEN r.rollup_level = 'product' THEN coalesce(pb.brand_key, 0) ELSE 0 END,
       (CASE r.rollup_level WHEN 'brand' THEN 1 WHEN 'product' THEN 2 ELSE 3 END)::int2,
       n.own_bit,
       (CASE WHEN r.rollup_level = 'brand' THEN coalesce(b.own_bit, 0) WHEN r.rollup_level = 'product' THEN coalesce(pb.own_bit, 0) ELSE 0 END)::int2,
       r.appearance_count, r.choice_count, r.conditional_choice_count, r.off_shortlist_choice_count, r.unresolved_choice_count,
       r.generic_choice_count, n.keep
  FROM ing.acr_rollup_row r
  JOIN ing.acr_prompt_run p ON p.prompt_run_id = r.prompt_run_id
  JOIN _acr ax ON ax.prompt_run_id = r.prompt_run_id
  JOIN rd.dim_entity e ON e.entity_id = r.entity_id
  JOIN _acr_nm n ON n.ver = ax.ecat_ver AND n.prompt_run_id = r.prompt_run_id AND n.entity_id = r.entity_id AND n.rollup_level = r.rollup_level
  LEFT JOIN rd.dim_brand_name b ON b.bare = n.bare AND n.bare <> ''
  LEFT JOIN rd.dim_brand_name pb ON pb.bare = n.parent_bare AND n.parent_bare <> ''
 WHERE NOT n.dropped;                                    -- E1: 제거 엔티티(또는 병합 대상 제거)의 롤업 행 제외
DO $a$ BEGIN
  IF (SELECT count(*) FROM rd.acr_cell) <> (SELECT count(*) FROM ing.acr_prompt_run) THEN RAISE EXCEPTION 'rd.acr_cell ↔ ing.acr_prompt_run 1:1'; END IF;
  IF (SELECT count(*) FROM rd.acr_choice)
     <> (SELECT count(*) FROM ing.acr_rollup_row r JOIN _acr ax ON ax.prompt_run_id = r.prompt_run_id
          WHERE NOT EXISTS (SELECT 1 FROM _ecat_x x WHERE x.ver = ax.ecat_ver AND x.entity_id = r.entity_id AND x.removed)) THEN
    RAISE EXCEPTION 'rd.acr_choice ↔ ing.acr_rollup_row(제거 엔티티 제외) 1:1'; END IF;
END $a$;

-- ════════════════════════════════════════════════════════════════════════════
-- 10. rd.report_unit_value(R09·A5): 활성 발행(app.report_publication status 'active') × 유닛 사실 1:1.
--     키 (round_date, file_seq): 같은 날 브랜드 범위가 다른 활성 발행이 같은 file_seq 를 가지면 충돌(모듈-적재-파이프라인 §9 열린 질문 4) →
--     published_on·ingested_at 최신 1건만 두고 NOTICE. cyc_key = file_seq 의 웹 유닛 프로젝트에서 같은 round_date 인 website 회차(없으면 NULL).
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO rd.report_unit_value (round_date, file_seq, cyc_key, pub_id, brand, country_code, lang_code, in_headline_pool,
                                  target_hit_prompts, measured_prompts, owned_prompts, owned_prompts_den,
                                  prev_target_hit_prompts, prev_measured_prompts, prev_owned_prompts, prev_owned_prompts_den, load_id)
SELECT DISTINCT ON (p.round_date, f.file_seq) p.round_date, f.file_seq,
       (SELECT c.cyc_key FROM rd.web_unit w JOIN rd.cycle c ON c.project_key = w.project_key AND c.surface = 2 AND c.round_date = p.round_date
         WHERE w.file_seq = f.file_seq ORDER BY c.cyc_key LIMIT 1),
       p.id, f.brand, f.country_code, f.lang_code, f.in_headline_pool, f.target_hit_prompts, f.measured_prompts, f.owned_prompts, f.owned_prompts_den,
       f.prev_target_hit_prompts, f.prev_measured_prompts, f.prev_owned_prompts, f.prev_owned_prompts_den, :l40
  FROM app.report_publication p JOIN app.report_site_fact f ON f.publication_id = p.id
 WHERE p.status = 'active'
 ORDER BY p.round_date, f.file_seq, p.published_on DESC NULLS LAST, p.ingested_at DESC, p.id;
DO $a$ DECLARE v bigint; BEGIN
  SELECT count(*) - (SELECT count(*) FROM rd.report_unit_value) INTO v
    FROM app.report_publication p JOIN app.report_site_fact f ON f.publication_id = p.id WHERE p.status = 'active';
  IF v > 0 THEN RAISE WARNING 'report_unit_value (round_date, file_seq) 충돌로 버린 발행 행 %', v; END IF;
END $a$;

-- ════════════════════════════════════════════════════════════════════════════
-- 11. 세대·마감. rd.surface_generation.as_of = 노출 가능한 최신 round_date(servable ∧ view_date ≤ 오늘 KST, 숨김 all 제외).
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO rd.surface_generation (surface, generation, last_load_id, rule_ver, as_of)
SELECT s, 1, :l40, :rv,
       (SELECT max(round_date) FROM rd.cycle c WHERE c.surface = s AND c.servable AND c.view_date <= rd.today_kst() AND c.hidden_scope <> 1)
  FROM (VALUES (1::int2), (2::int2), (3::int2)) v(s);

-- 진단(A4 대조용, 관찰만): 표시 브랜드 수준 자사(G-20) vs 현행 행 수준(rid ∈ 명부) 판정이 갈린 언급 행 수
SELECT 'own_bit(표시) <> rid_bit(현행)' AS diag, count(*) AS mention_rows, coalesce(sum(mention_count), 0) AS mentions
  FROM _mr WHERE own_bit <> rid_bit;

-- 동결 층(DB-v2.21 P117, 결정 32): 비우기 직전(seed-30·위 §0) 보관한 동결 답변 중 재구축 값이 같은 것은 보관을 푼다(값이 달라진 답변만
-- 옛 값으로 남는다, 2만 개 단위 답변 비교). frz 가 없는 DB(v2.21 전)·-v frz_no_keep=1(이관 명시 모드)은 건너뛴다.
\if :frz_no_keep
\else
DO $frz$ BEGIN
  IF to_regprocedure('frz.keep_settle(int4[], text)') IS NOT NULL THEN
    PERFORM frz.keep_settle(NULL, 'bulk');
  END IF;
END $frz$;
\endif

UPDATE ing.load SET status = 'committed', finished_at = clock_timestamp(),
       jobs_fetched = (SELECT count(*) FROM rd.job), jobs_changed = (SELECT count(*) FROM rd.answer), jobs_removed = 0,
       rd_answers_upserted = (SELECT count(*) FROM rd.answer),
       rd_gate_propagated = (SELECT coalesce(sum(n), 0) FROM _prop),
       rd_rep_flips = (SELECT count(*) FROM rd.answer WHERE is_rep),
       rd_children_rows = (SELECT count(*) FROM rd.answer_brand) + (SELECT count(*) FROM rd.answer_stance) + (SELECT count(*) FROM rd.citation)
 WHERE load_id = :l40;
COMMIT;

ANALYZE rd.job, rd.answer, rd.answer_brand, rd.answer_stance, rd.citation, rd.cycle, rd.acr_cell, rd.acr_cell_job, rd.acr_choice, rd.report_unit_value;

-- 요약(읽기)
SELECT 'rd.job' AS t, count(*) AS n FROM rd.job
UNION ALL SELECT 'rd.answer', count(*) FROM rd.answer
UNION ALL SELECT 'rd.answer std_in', count(*) FROM rd.answer WHERE std_in
UNION ALL SELECT 'rd.answer gap', count(*) FROM rd.answer WHERE gap
UNION ALL SELECT 'rd.answer is_rep', count(*) FROM rd.answer WHERE is_rep
UNION ALL SELECT 'rd.answer_brand', count(*) FROM rd.answer_brand
UNION ALL SELECT 'rd.answer_stance', count(*) FROM rd.answer_stance
UNION ALL SELECT 'rd.citation', count(*) FROM rd.citation
UNION ALL SELECT 'rd.cycle', count(*) FROM rd.cycle
UNION ALL SELECT 'rd.acr_cell', count(*) FROM rd.acr_cell
UNION ALL SELECT 'rd.acr_choice', count(*) FROM rd.acr_choice
UNION ALL SELECT 'rd.report_unit_value', count(*) FROM rd.report_unit_value
UNION ALL SELECT 'gate_propagated', rd_gate_propagated FROM ing.load WHERE load_id = :l40;
