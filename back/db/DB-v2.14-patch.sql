-- ============================================================================
-- hmg-geo 재설계 DB-v2.14 보완 패치 (PostgreSQL 17, 2026-09-30) · 원장 발행 게이트(제품 결정 16~18)
-- 적용 순서: DB-v2.13.sql 뒤 이 파일 1회(트랜잭션 1개). 합본 DB-v2.14.sql = DB-v2.13.sql + 이 파일. 추가형(기존 열·값·권한 불변, 새 표 2·함수 1·NULL 열 1).
-- 근거: notes/hgh-impl/a4-decisions-batch.md 16~18, 설계 메모 publish-gate-design-20260930.md.
--   16 분모 = 회차 시작 시점 카탈로그의 활성 유닛(활성 프롬프트 × 프로젝트 엔진 × 측정 국가, 구조적 측정 불가 조합·도중 비활성 프롬프트 제외).
--      발송·싱크 누락은 분모에 남아 드러나야 한다(현행 expected_units = 답변 행이 있는 셀 수라 누락이 분모에서 사라진다).
--   17 자동 발행 = 활성 유닛 100% 완료(봉인 제외) ∧ 분석 비율 ≥ analysis_publish_ratio. 미달이면 알림, 운영자가 재측정·봉인(사유)·강제 발행(사유·감사).
--   18 적용 표면 = global·website. project 는 현행처럼 마감 즉시 노출.
--
-- P81 ing.cycle_unit  회차 계획(= 회차 개설 시점의 활성 유닛 스냅샷). 적재기가 회차를 열 때(ingest.cycles.ledger.attribute) 기록한다
--     (plan_source 'open'). 계획이 없는 미발행 게이트 회차(이관 origin summary_cycles·배포 창에 옛 코드가 연 회차)는 재평가 틱이 처음 볼 때
--     현재 카탈로그로 채운다(plan_source 'backfill', 앵커 뒤에 카탈로그에 들어온 프롬프트는 뺀다). 봉인 = sealed_* (사유 필수, 분모 제외,
--     운영 summary_cycles.sealed_units 와 같은 개념). 발행 뒤에는 쓰지 않는다(동결).
-- P82 ing.cycle_gate  회차별 게이트 상태(계획·활성·완료·봉인·도중 제외·빠짐 수, 판정 pass|blocked|forced, 강제 발행 감사 열, 알림 시각).
--     quiet = 이관 당시 이미 닫혀 있던 이관 회차(운영에서 발행하지 않은 잔여): 알림·노출 지체·발행 대기 감시에서 뺀다.
-- P83 ing.active_units(scope_project_id) 현재 카탈로그의 활성 유닛(프롬프트·엔진·국가, listed_at = 카탈로그 첫 등록 시각).
--       프롬프트  글로벌·고객 = app.prompt(그 Scope 프로젝트의 app.project, deleted_at NULL, scope_prompt_id 있음, scope_prompt_id 로 중복 제거)
--                 웹사이트    = app.website_prompt(그 Scope 프로젝트의 app.website_site, scope_prompt_id 있음)
--       국가      ing.prompt.regions(Scope 프롬프트 시장), NULL·빈 배열이면 ing.sync_cursor.regions(Scope 프로젝트 시장)
--                 (적재 판정 elig 과 같은 규약: ingest/project/apply/queries.py p_regions). app.prompt.regions 는 쓰지 않는다(가상 코드 x:* 포함).
--       엔진      app.project.ai_engines(비어 있지 않을 때) → app.rule_param default_engines
--       제외      app.rule_param unmeasurable_units = [{"target": "chatgpt", "region": "CN"}, …] (키 없으면 빈 목록, 대소문자 무시),
--                 ing.prompt.enabled = false(Scope 에서 꺼 둔 프롬프트, P84)
--     STABLE·호출자 권한(loader·migrator 실행). 발행 게이트 판정은 계획 ∩ 이 함수의 현재 결과 − 봉인 = 분모(도중 비활성 = 계획 ∖ 현재).
--
-- P84 ing.prompt.enabled bool NULL(제품 결정 21, 2026-10-01) = Scope 코어 prompts.enabled(Scope API 프롬프트 응답의 enabled). NULL = 모름
--     (활성으로 취급, 기존 동작 유지), false = 운영자가 Scope 에서 꺼 둔 프롬프트 → ing.active_units 에서 뺀다. 카탈로그(app.prompt·
--     app.website_prompt)와 화면은 바꾸지 않는다. 적재기 pull(ingest/pull/sync PROMPT_UPSERT)이 채우고, 이관 전 행은
--     back/migration/fill-prompt-enabled.sql 이 코어 값으로 1회 채운다. 추가형: NULL 허용·기본값 없음 열 추가(메타데이터만, 표 재작성 없음,
--     ACCESS EXCLUSIVE 순간 잠금 = lock_timeout 30s 안).
--     회차 도중 꺼진 프롬프트는 게이트 판정의 "계획 ∩ 현재 활성" 규칙으로 도중 제외(withdrawn)된다.
--
-- 쓰는 곳: ingest/cycles/ledger(attribute·reevaluate·cycle_admin seal·force_publish), ingest/cycles/watch(publish_gate 점검).
-- judgment_change 'cycle_admin' payload 확장(DDL 변경 없음, 계약 = app/core/contracts.py CycleAdmin):
--   {cycle_id, op: seal, reason, units?: [{prompt_id, target, region}]} · {cycle_id, op: force_publish, reason}
--
-- 적용 절차(stg·prod): ① 이 패치(migrator 또는 superuser) ② back 배포(적재기가 새 표·열을 쓴다)
--   ③ Scope 활성 여부 1회 채움(back/migration/fill-prompt-enabled.sql 머리말: 코어 SELECT 결과 → ing.prompt.enabled, 드라이런 → commit=1)
--   ④ 적재 틱 1회(python -m ingest.cli tick: 미발행 게이트 회차 계획 채움 + 판정, stg 는 워커·타이머가 없어 수동)
--   ①~② 사이 옛 적재기는 새 표·열을 모른다(무해): 그 사이 열린 회차는 ④ 에서 backfill 계획을 받는다.
--   ③ 을 ④ 보다 먼저 한다: 꺼진 프롬프트가 backfill 계획에 들어가지 않게(뒤에 채워도 "계획 ∩ 현재 활성"으로 빠지지만 plan_units 가 부풀어 보인다).
-- 결과 캐시: rd 를 바꾸지 않는다(rd.cycle 투영 열 불변). 규약: D8(사전 집계 없음) 준수, 새 표는 원장(ing) 판정 근거다.
-- ============================================================================
BEGIN;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '30s';

DO $v$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 'cit_off' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.13 이 먼저 적용돼야 한다';
  END IF;
  IF to_regclass('ing.cycle_unit') IS NOT NULL OR to_regclass('ing.cycle_gate') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'ing.prompt'::regclass AND attname = 'enabled' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'DB-v2.14 이미 적용됨(ing.cycle_unit·ing.cycle_gate 존재)';
  END IF;
END $v$;

-- ── P81 ─────────────────────────────────────────────────────────────────────
CREATE TABLE ing.cycle_unit (cycle_id uuid NOT NULL REFERENCES ing.cycle, prompt_id uuid NOT NULL, target text NOT NULL, region text NOT NULL,
  sealed_at timestamptz, seal_reason text, seal_change_id bigint, sealed_by uuid,
  PRIMARY KEY (cycle_id, prompt_id, target, region),
  CONSTRAINT cycle_unit_seal_pair CHECK ((sealed_at IS NULL) = (seal_reason IS NULL)),
  CONSTRAINT cycle_unit_seal_reason CHECK (seal_reason IS NULL OR length(btrim(seal_reason)) > 0));
COMMENT ON TABLE ing.cycle_unit IS '회차 계획 = 개설 시점 활성 유닛 스냅샷(발행 게이트 분모의 재료). 봉인 = 분모 제외(사유 필수). DB-v2.14 P81';

-- ── P82 ─────────────────────────────────────────────────────────────────────
CREATE TABLE ing.cycle_gate (cycle_id uuid PRIMARY KEY REFERENCES ing.cycle,
  plan_source text NOT NULL CHECK (plan_source IN ('open','backfill')), planned_at timestamptz NOT NULL DEFAULT now(),
  plan_units int NOT NULL DEFAULT 0, active_units int, done_units int, sealed_units int, withdrawn_units int, missing_units int,
  verdict text CHECK (verdict IN ('pass','blocked','forced')), evaluated_at timestamptz,
  quiet bool NOT NULL DEFAULT false, alerted_at timestamptz,
  forced_at timestamptz, forced_reason text, forced_by uuid, force_change_id bigint,
  CONSTRAINT cycle_gate_forced_pair CHECK ((forced_at IS NULL) = (forced_reason IS NULL)),
  CONSTRAINT cycle_gate_forced_reason CHECK (forced_reason IS NULL OR length(btrim(forced_reason)) > 0),
  CONSTRAINT cycle_gate_forced_verdict CHECK (verdict IS DISTINCT FROM 'forced' OR forced_at IS NOT NULL));
COMMENT ON TABLE ing.cycle_gate IS
  '발행 게이트 상태(global·website 비파생 회차). pass = 활성 유닛(계획 ∩ 현재 카탈로그 − 봉인) 전부 완료. forced = 운영자 강제 발행(사유·요청자). DB-v2.14 P82';

-- ── P84 (P83 함수 본문이 이 열을 참조하므로 먼저 만든다) ─────────────────────────
ALTER TABLE ing.prompt ADD COLUMN enabled bool;
COMMENT ON COLUMN ing.prompt.enabled IS
  'Scope 코어 prompts.enabled. NULL = 모름(활성 취급), false = Scope 에서 꺼 둠 → 발행 게이트 활성 유닛 제외(제품 결정 21). DB-v2.14 P84';

-- ── P83 ─────────────────────────────────────────────────────────────────────
CREATE FUNCTION ing.active_units(p_scope_project_id uuid)
RETURNS TABLE (prompt_id uuid, target text, region text, listed_at timestamptz)
LANGUAGE sql STABLE AS $f$
WITH cat AS (
  SELECT x.prompt_id, min(x.created_at) AS listed_at FROM (
    SELECT p.scope_prompt_id AS prompt_id, p.created_at FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id
     WHERE pr.scope_project_id = p_scope_project_id AND p.deleted_at IS NULL AND p.scope_prompt_id IS NOT NULL
    UNION ALL
    SELECT wp.scope_prompt_id, wp.created_at FROM app.website_prompt wp JOIN app.website_site s ON s.site_id = wp.site_id
     WHERE s.scope_project_id = p_scope_project_id AND wp.scope_prompt_id IS NOT NULL) x
  GROUP BY x.prompt_id),
eng AS (
  SELECT DISTINCT e.target FROM unnest(coalesce(
    (SELECT pr.ai_engines FROM app.project pr WHERE pr.scope_project_id = p_scope_project_id AND cardinality(pr.ai_engines) > 0),
    (SELECT ARRAY(SELECT jsonb_array_elements_text(rp.value)) FROM app.rule_param rp
      WHERE rp.key = 'default_engines' AND jsonb_typeof(rp.value) = 'array'),
    ARRAY[]::text[])) AS e(target)
   WHERE e.target IS NOT NULL AND e.target <> ''),
proj AS (SELECT (SELECT nullif(sc.regions, '{}'::text[]) FROM ing.sync_cursor sc WHERE sc.scope_project_id = p_scope_project_id) AS regions),
ex AS (
  SELECT lower(x ->> 'target') AS target, upper(x ->> 'region') AS region
    FROM app.rule_param rp
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(rp.value) = 'array' THEN rp.value ELSE '[]'::jsonb END) x
   WHERE rp.key = 'unmeasurable_units')
SELECT DISTINCT c.prompt_id, e.target, r.region, c.listed_at
  FROM cat c
  LEFT JOIN ing.prompt ip ON ip.scope_prompt_id = c.prompt_id
  CROSS JOIN proj
  CROSS JOIN LATERAL unnest(coalesce(nullif(ip.regions, '{}'::text[]), proj.regions)) AS r(region)
  CROSS JOIN eng e
 WHERE r.region IS NOT NULL AND r.region <> ''
   AND ip.enabled IS DISTINCT FROM false
   AND NOT EXISTS (SELECT 1 FROM ex WHERE ex.target = lower(e.target) AND ex.region = upper(r.region))
$f$;
COMMENT ON FUNCTION ing.active_units(uuid) IS
  '현재 카탈로그 활성 유닛(프롬프트 × 엔진 × 국가, 구조적 불가 조합 제외). 발행 게이트 분모의 재료. DB-v2.14 P83';

-- ── 소유자·권한(이 패치는 superuser·migrator 로 적용되므로 명시 이전·부여) ──
ALTER TABLE ing.cycle_unit OWNER TO hmg_owner;
ALTER TABLE ing.cycle_gate OWNER TO hmg_owner;
ALTER FUNCTION ing.active_units(uuid) OWNER TO hmg_owner;
GRANT SELECT, INSERT, UPDATE, DELETE ON ing.cycle_unit, ing.cycle_gate TO loader, migrator;
GRANT SELECT ON ing.cycle_unit, ing.cycle_gate TO loader_ro;
REVOKE EXECUTE ON FUNCTION ing.active_units(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ing.active_units(uuid) TO loader, migrator;

-- ── 사후 단언 ───────────────────────────────────────────────────────────────
DO $v$ BEGIN
  IF pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'ing.cycle_unit'::regclass)) <> 'hmg_owner'
     OR pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'ing.cycle_gate'::regclass)) <> 'hmg_owner'
     OR pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'ing.active_units(uuid)'::regprocedure)) <> 'hmg_owner' THEN
    RAISE EXCEPTION 'P81~P83 실패: 소유자';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'ing.prompt'::regclass AND attname = 'enabled' AND NOT attisdropped
                  AND atttypid = 'bool'::regtype AND NOT attnotnull AND NOT atthasdef) THEN
    RAISE EXCEPTION 'P84 실패: ing.prompt.enabled bool NULL 허용·기본값 없음';
  END IF;
  IF NOT has_table_privilege('loader', 'ing.cycle_unit', 'insert') OR NOT has_table_privilege('loader', 'ing.cycle_gate', 'update')
     OR NOT has_function_privilege('loader', 'ing.active_units(uuid)', 'execute')
     OR has_function_privilege('api_ro', 'ing.active_units(uuid)', 'execute') THEN
    RAISE EXCEPTION 'P81~P83 실패: 권한';
  END IF;
  -- 함수가 컴파일되고 빈 프로젝트에 빈 결과를 낸다
  PERFORM 1 FROM ing.active_units('00000000-0000-0000-0000-000000000000'::uuid);
END $v$;

COMMIT;
