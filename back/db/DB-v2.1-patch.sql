-- ============================================================================
-- hmg-geo 재설계 DB-v2.1 보완 패치 (PostgreSQL 17, 2026-09-28)
-- 적용 순서: DB-v2.sql 적용 직후 이 파일 1회(트랜잭션 1개, ON_ERROR_STOP 통과 전제). DB-v2.sql 자체는 수정하지 않는다.
-- 입력: modules/전체-통합.json read_schema [채택] 1~18, modules/DECISIONS-API.md Q2·Q3·Q4·Q14·Q17, DESIGN-CONTRACT.md §3.
--
-- 반영 목록
--   P01 judgment_change.kind 에 dfs_fetch·ga4_property·ga4_tracked_event 추가(채택 1·2)
--   P02 loader 의 judgment_change INSERT(채택 3: scope_prompt 는 적재기가 스스로 넣는다)
--   P03 outbox 워커(loader) 열 단위 UPDATE + app.actor() EXECUTE(채택 4)
--   P04 트리거 본문(채택 5, Q3): app.project AFTER UPDATE → judgment_change 'project_setting',
--       app.prompt tg_catalog_change → prompt_audit_log + judgment_change 'catalog'|'prompt_kind'. SECURITY DEFINER,
--       행위자 app.actor(), batch_id = GUC app.batch_id, 행위자 유형 = GUC app.actor_type('user' 기본 | 'system')
--   P05 rd.dim_project.regions + ing.sync_cursor.regions(채택 6)
--   P06 rd.cycle.hidden_reason(채택 7) + Q2 카운터 4열(ing.cycle 1:1 투영, 새 합산 없음)
--   P07 COMMENT ON COLUMN rd.cycle.status·rd.answer.analysis_state 외(채택 8)
--   P08 rd.job job_qa_list_idx NULLS LAST 교체(채택 9)
--   P09 문서형 뷰 확장 3건(채택 10) + 운영 조회 뷰 3개(채택 11). 소유자 loader_ro, api_ro SELECT
--   P10 ing.stage_* (load_id, job_id) 인덱스(채택 12)
--   P11 rd.answer CHECK (NOT tgt_cited OR own_url_cited)(채택 13)
--   P12 rd.dim_source (domain) 인덱스(채택 14), 앱·ext 인덱스 5건(채택 15)
--   P13 제약 2건(채택 16): app.prompt.status 6값, app.member_audit_log.action 7값
--       (현행 코드 확인: lib/db/migrations/0006_member_audit_logs.sql:6-14 ENUM 7값, lib/db/schema.ts:274-282.
--        관리자 승계는 별도 action 이 아니라 action='promote' + context 'orphan-succession ...'(app/[locale]/(dash)/admin/_actions.ts:240-246))
--   P14 rd.ga4_dim_property.conv_basis(채택 17), app.ctx_generated_prompt 4열 + seed_key UNIQUE(채택 18)
--   P15 Q4: app.access_audit_log append-only(행 트리거, 파티션 leaf 로 복제) + api_rw UPDATE·DELETE 회수
--   P16 Q17: 검수 게이트 전용 롤 qa_gate(NOLOGIN)
--
-- Q14 (DB-v2.sql 주석 정정, DDL 변경 없음)
--   DB-v2.sql §8 의 주석 "ext.webgeo_*: 현행 정의 그대로 정적 이관(+ webgeo_pages (raw_html_path) 인덱스). crawl_*: S3 + mig.archive_manifest(G-13)."
--   는 다음으로 대체한다: "crawl_*·webgeo_* 모두 S3 보관(mig.archive_manifest), 새 DB 에 올리지 않음(2026-09-28 Q14)".
--   DB-v2.sql 에 webgeo_* 실 DDL 은 없으므로 이 패치에서 지울 객체도 없다. 리포 밖 사용처가 나오면 archive_manifest 로 복원한다.
--
-- 규약 확인
--   D8: 사전 집계·요약 표·매트뷰·결과 캐시·새 누적 카운터 없음. rd.cycle 카운터 4열은 ing.cycle 과 1:1 투영(Q2 개정, D8 예외 ③).
--   HOT: 새 btree 는 재판정 제자리 UPDATE 대상 열을 포함하지 않는다(rd.cycle 카운터·hidden_reason 도 어떤 인덱스에도 넣지 않는다).
--   소유자: 이 패치는 superuser 로 적용되므로 새 함수는 hmg_owner, 새 뷰는 loader_ro 로 소유자를 명시 이전하고 권한을 명시 부여한다
--          (ALTER DEFAULT PRIVILEGES FOR ROLE hmg_owner 는 hmg_owner 가 만든 객체에만 적용되기 때문).
--   조건부 보류(RDS 실측 게이트) 항목과 기각 항목은 넣지 않았다.
-- ============================================================================
BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- P01. 재판정·운영 요청 큐 kind 확장
--   dfs_fetch        : 운영자 DataForSEO 수집 요청(Q13). 적재기(loader) 빠른 경로가 claim → ext.dfs_call·rd.kw_* 를 한 트랜잭션으로 쓰고 상태 전이
--   ga4_property     : GA4 속성 매핑 변경. 적재기가 해당 속성 전 기간 rd.ga4_row 재투영
--   ga4_tracked_event: 추적 이벤트 변경. is_conv·conv_basis 전 기간 재투영('최근 3일 교체'로는 과거 행이 안 바뀜)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE app.judgment_change DROP CONSTRAINT judgment_change_kind_check;
ALTER TABLE app.judgment_change ADD CONSTRAINT judgment_change_kind_check CHECK (kind IN (
    'catalog','prompt_kind','entity','brand_rule','competitor_token','hidden_market','citation_override','owned_base',
    'website_catalog','project_setting','project_owned_base','project_target_url','rule_param','scope_prompt',
    'cycle_admin','anchor_pin','answer_drop','report_publication',
    'dfs_fetch','ga4_property','ga4_tracked_event'));

-- ════════════════════════════════════════════════════════════════════════════
-- P02·P03. loader 권한 보강
--   P02: DB-v2.sql:81 "scope_prompt 는 적재기가 스스로 넣는다" 인데 loader 는 상태 열 UPDATE(:861)만 있었다.
--   P03: outbox 워커(hmg.ingest.worker outbox 루프, loader 롤). SET LOCAL app.actor_id = 시스템 사용자 uuid,
--        SET LOCAL app.actor_type = 'system'. Scope 반영 후 scope_*_id 되쓰기. app.prompt 되쓰기의 prompt_audit_log·
--        judgment_change('catalog') 는 P04 트리거가 남긴다(워커가 직접 쓰지 않는다).
-- ════════════════════════════════════════════════════════════════════════════
GRANT INSERT ON app.judgment_change TO loader;
GRANT UPDATE (attempts, next_attempt_at, done_at, last_error) ON app.scope_outbox TO loader;
GRANT UPDATE (scope_project_id, updated_at) ON app.project TO loader;
GRANT UPDATE (scope_prompt_id, status, updated_by, updated_at) ON app.prompt TO loader;
GRANT EXECUTE ON FUNCTION app.actor() TO loader;

-- ════════════════════════════════════════════════════════════════════════════
-- P13 (트리거보다 먼저). 제약 2건
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE app.prompt ADD CONSTRAINT prompt_status_check
  CHECK (status IN ('draft','queued','running','done','failed','paused'));          -- lib/db/schema.ts:335-342 (0004 + 0038 paused)
ALTER TABLE app.member_audit_log ADD CONSTRAINT member_audit_action_check
  CHECK (action IN ('invite','cancel_invite','remove','promote','demote','accept','reject'));   -- 0006 ENUM 7값, 승계 = 'promote'+context

-- ════════════════════════════════════════════════════════════════════════════
-- P04. 트리거 본문 (Q3 혼합: app.project·app.prompt 는 DB 트리거, 그 밖의 kind 는 앱 core.write.enqueue_change 명시 INSERT)
--   앱은 'catalog'·'prompt_kind' 와 app.project 4열 변경의 'project_setting' 을 직접 INSERT 하지 않는다(이중 기록 금지).
--   tracked_* 변경의 'project_setting' 은 앱이 명시 INSERT 한다(전체-통합 채택 5).
-- ════════════════════════════════════════════════════════════════════════════

-- P04-a. app.project AFTER UPDATE: domain·brand_code·country_code·ai_engines 변경 → judgment_change('project_setting')
CREATE FUNCTION app.tg_project_setting_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
BEGIN
  INSERT INTO app.judgment_change (kind, subject_uuids, payload, requested_by)
  VALUES ('project_setting', ARRAY[NEW.project_id],
          jsonb_build_object('op', 'update', 'project_id', NEW.project_id, 'scope_project_id', NEW.scope_project_id,
            'old', jsonb_build_object('domain', OLD.domain, 'brand_code', OLD.brand_code, 'country_code', OLD.country_code, 'ai_engines', OLD.ai_engines),
            'new', jsonb_build_object('domain', NEW.domain, 'brand_code', NEW.brand_code, 'country_code', NEW.country_code, 'ai_engines', NEW.ai_engines)),
          app.actor());                                        -- 행위자 필수: 미설정이면 UPDATE 전체 거부
  RETURN NULL;
END $f$;
CREATE TRIGGER project_setting_change
  AFTER UPDATE OF domain, brand_code, country_code, ai_engines ON app.project
  FOR EACH ROW
  WHEN ((OLD.domain, OLD.brand_code, OLD.country_code, OLD.ai_engines) IS DISTINCT FROM (NEW.domain, NEW.brand_code, NEW.country_code, NEW.ai_engines))
  EXECUTE FUNCTION app.tg_project_setting_change();

-- P04-b. app.prompt tg_catalog_change: 전 프로젝트 대상(v1 초안의 standard_root 한정 폐기)
--   1) prompt_audit_log 1행(행 변경 1건 = 이벤트 1건, 바뀐 필드는 changes 에 합산. 현행 _actions.ts:664 의 "이벤트 분열 방지" 계승)
--      event_type 우선순위: restored·deleted > kind_changed > text_updated > enabled_changed > meta_updated
--      changes 형식 = {필드: {old: text|null, new: text|null}} (현행 lib/standards/audit.ts PromptAuditChanges)
--        INSERT → created {text}, DELETE → deleted {deleted, purged}, deleted_at 전환 → deleted|restored {deleted},
--        status 가 'paused' 로/에서 전환 → enabled_changed {enabled}. draft→queued→running→done·failed 수명 전이만 있으면 감사 행 없음.
--   2) judgment_change: 옛·새 scope_prompt_id 중 NULL 아닌 것이 있을 때만(rd 는 Scope prompt_id 로만 이 행을 안다)
--        UPDATE 에서 kind 변경 → 'prompt_kind'
--        INSERT·DELETE, 또는 UPDATE 에서 brand_code·brand_presence·list_type·depth1~4·funnel_stage·scope_prompt_id·deleted_at 변경 → 'catalog'
--      payload = {op, prompt_id, project_id, old:{…}, new:{…}}. rd 는 쓰지 않는다(B4).
--   행위자 = app.actor()(미설정이면 app.prompt 쓰기 전체 거부), actor_type = GUC app.actor_type, batch_id = GUC app.batch_id.
CREATE FUNCTION app.tg_catalog_change() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
DECLARE
  v_actor uuid := app.actor();
  v_type  text := coalesce(nullif(current_setting('app.actor_type', true), ''), 'user');
  v_batch uuid := nullif(current_setting('app.batch_id', true), '')::uuid;
  o jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  n jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  diff_f text[] := ARRAY['text','kind','prompt_type','category','brand_code','brand_presence','list_type',
                         'depth1','depth2','depth3','depth4','funnel_stage','lang','regions','scope_prompt_id'];
  cat_f  text[] := ARRAY['brand_code','brand_presence','list_type','depth1','depth2','depth3','depth4',
                         'funnel_stage','scope_prompt_id','deleted_at'];
  f text; ch jsonb := '{}'::jsonb; ev text; was_del bool; is_del bool; was_on bool; is_on bool;
  subj uuid[]; pl jsonb;
BEGIN
  IF v_type NOT IN ('user','system') THEN
    RAISE EXCEPTION 'app.actor_type 은 user|system 만 허용: %', v_type;
  END IF;

  -- 1) 감사
  IF TG_OP = 'INSERT' THEN
    ev := 'created';
    ch := jsonb_build_object('text', jsonb_build_object('old', NULL, 'new', n->>'text'));
  ELSIF TG_OP = 'DELETE' THEN
    ev := 'deleted';
    ch := jsonb_build_object('deleted', jsonb_build_object('old', ((o->>'deleted_at') IS NOT NULL)::text, 'new', 'true'),
                             'purged',  jsonb_build_object('old', 'false', 'new', 'true'));
  ELSE
    FOREACH f IN ARRAY diff_f LOOP
      IF (o->f) IS DISTINCT FROM (n->f) THEN
        ch := ch || jsonb_build_object(f, jsonb_build_object('old', o->>f, 'new', n->>f));
      END IF;
    END LOOP;
    was_del := OLD.deleted_at IS NOT NULL;  is_del := NEW.deleted_at IS NOT NULL;
    IF was_del <> is_del THEN
      ch := ch || jsonb_build_object('deleted', jsonb_build_object('old', was_del::text, 'new', is_del::text));
    END IF;
    was_on := OLD.status <> 'paused';  is_on := NEW.status <> 'paused';
    IF was_on <> is_on THEN
      ch := ch || jsonb_build_object('enabled', jsonb_build_object('old', was_on::text, 'new', is_on::text));
    END IF;
    ev := CASE WHEN was_del AND NOT is_del THEN 'restored'
               WHEN is_del AND NOT was_del THEN 'deleted'
               WHEN ch ? 'kind'    THEN 'kind_changed'
               WHEN ch ? 'text'    THEN 'text_updated'
               WHEN ch ? 'enabled' THEN 'enabled_changed'
               WHEN ch <> '{}'::jsonb THEN 'meta_updated' END;
  END IF;
  IF ev IS NOT NULL THEN
    INSERT INTO app.prompt_audit_log (prompt_id, project_id, actor_id, actor_type, event_type, changes, batch_id)
    VALUES ((coalesce(n, o)->>'prompt_id')::uuid, (coalesce(n, o)->>'project_id')::uuid, v_actor, v_type, ev, ch, v_batch);
  END IF;

  -- 2) 재판정 요청
  subj := ARRAY(SELECT DISTINCT x::uuid FROM unnest(ARRAY[o->>'scope_prompt_id', n->>'scope_prompt_id']) x WHERE x IS NOT NULL);
  IF cardinality(subj) > 0 THEN
    pl := jsonb_build_object('op', lower(TG_OP), 'prompt_id', coalesce(n, o)->'prompt_id', 'project_id', coalesce(n, o)->'project_id',
            'old', (SELECT jsonb_object_agg(k, o->k) FROM unnest(cat_f || 'kind'::text) k WHERE o IS NOT NULL),
            'new', (SELECT jsonb_object_agg(k, n->k) FROM unnest(cat_f || 'kind'::text) k WHERE n IS NOT NULL));
    IF TG_OP = 'UPDATE' AND (o->'kind') IS DISTINCT FROM (n->'kind') THEN
      INSERT INTO app.judgment_change (kind, subject_uuids, payload, requested_by) VALUES ('prompt_kind', subj, pl, v_actor);
    END IF;
    IF TG_OP <> 'UPDATE' OR EXISTS (SELECT 1 FROM unnest(cat_f) k WHERE (o->k) IS DISTINCT FROM (n->k)) THEN
      INSERT INTO app.judgment_change (kind, subject_uuids, payload, requested_by) VALUES ('catalog', subj, pl, v_actor);
    END IF;
  END IF;
  RETURN NULL;
END $f$;
CREATE TRIGGER prompt_catalog_change AFTER INSERT OR UPDATE OR DELETE ON app.prompt
  FOR EACH ROW EXECUTE FUNCTION app.tg_catalog_change();

ALTER FUNCTION app.tg_project_setting_change() OWNER TO hmg_owner;
ALTER FUNCTION app.tg_catalog_change() OWNER TO hmg_owner;
REVOKE EXECUTE ON FUNCTION app.tg_project_setting_change(), app.tg_catalog_change() FROM PUBLIC;
-- 감사 원장의 쓰기 주체는 트리거 하나(Q3 "누락 불가", 채택 5 "이중 기록 금지"). 앱의 명시 INSERT 잔존분은 권한 오류로 드러나게 한다.
REVOKE INSERT ON app.prompt_audit_log FROM api_rw;

-- ════════════════════════════════════════════════════════════════════════════
-- P05. regions 투영(채택 6): Scope getProject 시장 설정 → ing.sync_cursor.regions(원본) → rd.dim_project.regions(1:1 투영)
--   프로젝트 로테이션 때 적재기가 갱신, 변경 시 judgment_change('scope_prompt') 경로와 같은 트랜잭션.
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE ing.sync_cursor ADD COLUMN regions text[];
ALTER TABLE rd.dim_project  ADD COLUMN regions text[];

-- ════════════════════════════════════════════════════════════════════════════
-- P06. rd.cycle 투영 열
--   hidden_reason(채택 7): ing.cycle.hidden_reason 코드 투영. hidden_scope 와 짝(ing.cycle CHECK :344 와 같은 불변식)
--   Q2(제품 책임자 개정): expected_units·completed_units·completed_answers·gap_answers = ing.cycle 같은 이름 열 1:1 투영(새 합산 없음, NULL 허용)
--     K-2 가중 누락 비중·AD-4 진행률 분모에 쓴다. 제자리 UPDATE 열이므로 어떤 인덱스에도 넣지 않는다(HOT).
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE rd.cycle
  ADD COLUMN hidden_reason int2 NOT NULL DEFAULT 0 CONSTRAINT rd_cycle_hidden_reason_code CHECK (hidden_reason BETWEEN 0 AND 2),
  ADD COLUMN expected_units int,
  ADD COLUMN completed_units int,
  ADD COLUMN completed_answers int,
  ADD COLUMN gap_answers int,
  ADD CONSTRAINT rd_cycle_hidden_pair CHECK ((hidden_scope = 0) = (hidden_reason = 0)),
  ADD CONSTRAINT rd_cycle_gap_le_completed CHECK (gap_answers IS NULL OR completed_answers IS NULL OR gap_answers <= completed_answers);

-- ════════════════════════════════════════════════════════════════════════════
-- P07. 코드 주석(채택 8)
-- ════════════════════════════════════════════════════════════════════════════
COMMENT ON COLUMN rd.cycle.status IS '0 open 1 closed 2 published 3 stale (ing.cycle.status 코드 투영)';
COMMENT ON COLUMN rd.cycle.hidden_scope IS '0 없음 1 all 2 citations 3 mentions (3 은 값만 두고 운영 도구 미노출, Q18)';
COMMENT ON COLUMN rd.cycle.hidden_reason IS '0 없음 1 collection_error 2 operator (ing.cycle.hidden_reason 투영, hidden_scope 와 짝)';
COMMENT ON COLUMN rd.cycle.expected_units IS 'ing.cycle.expected_units 1:1 투영(Q2 개정 D8 예외 ③, 새 합산 없음)';
COMMENT ON COLUMN rd.cycle.completed_units IS 'ing.cycle.completed_units 1:1 투영(Q2)';
COMMENT ON COLUMN rd.cycle.completed_answers IS 'ing.cycle.completed_answers 1:1 투영(Q2)';
COMMENT ON COLUMN rd.cycle.gap_answers IS 'ing.cycle.gap_answers 1:1 투영(Q2)';
COMMENT ON COLUMN rd.answer.analysis_state IS
  '0 분석됨·언급 있음 1 분석됨·언급 0 2 분석 미도착 3 분석 실패·스킵 (G-05 (a): Scope analysis.status completed·partial = 분석됨). gap = (>= 2), std_in 은 < 2 만';
COMMENT ON COLUMN rd.job.analysis_code IS 'rd.answer.analysis_state 와 같은 코드(비완료 job 은 0)';
COMMENT ON COLUMN rd.dim_project.regions IS 'ing.sync_cursor.regions(Scope getProject 시장 설정) 1:1 투영';
COMMENT ON COLUMN ing.sync_cursor.regions IS 'Scope getProject 시장 설정 원본(프로젝트 로테이션 때 갱신)';

-- ════════════════════════════════════════════════════════════════════════════
-- P08. QA 목록 키셋 인덱스(채택 9): 현행 정렬 measured_at DESC NULLS LAST(qa-review.ts:357)와 방향 일치
-- ════════════════════════════════════════════════════════════════════════════
DROP INDEX rd.job_qa_list_idx;
CREATE INDEX job_qa_list_idx ON rd.job (surface, measured_at DESC NULLS LAST, answer_key DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- P09. 뷰(채택 10·11). 저장 없음(D8 적합). answer_key 등치 조회 전용 규약은 문서형 뷰와 같다.
-- ════════════════════════════════════════════════════════════════════════════
-- P09-a. v_answer_mention_raw: ing.mention 감성 4·유형 5 열을 끝에 추가(QA P-Q2, qa-review.ts:544-565)
CREATE OR REPLACE VIEW rd.v_answer_mention_raw WITH (security_barrier) AS
  SELECT j.answer_key, j.surface, j.project_key, j.geo_key, j.bgrp, mt.ord, mt.entity_id, e.entity_key, e.registry_role, mt.display_name,
         mt.entity_type, mt.mention_count, mt.avg_position, mt.brand_rollup_entity_id, mt.surfaces,
         mt.sentiment_positive, mt.sentiment_neutral, mt.sentiment_negative, mt.sentiment_mixed,
         mt.type_mention, mt.type_recommendation, mt.type_comparison, mt.type_definition, mt.type_final_choice
    FROM rd.job j JOIN ing.answer_key_map m ON m.job_id = j.job_id
    JOIN ing.mention mt ON mt.run_month = m.run_month AND mt.job_id = m.job_id LEFT JOIN rd.dim_entity e ON e.entity_id = mt.entity_id;

-- P09-b. v_answer_registry: 앵커 고정·드롭의 source_measured_at 2열(QA P-Q4, qa-review.ts:633-646)
CREATE OR REPLACE VIEW rd.v_answer_registry WITH (security_barrier) AS
  SELECT j.answer_key, j.surface, j.project_key, j.geo_key, j.bgrp, p.anchor AS pin_anchor, p.reason AS pin_reason, d.reason AS drop_reason, d.dropped_at,
         p.source_measured_at AS pin_source_measured_at, d.source_measured_at AS drop_source_measured_at
    FROM rd.job j LEFT JOIN ing.answer_anchor_pin p ON p.job_id = j.job_id LEFT JOIN ing.answer_drop d ON d.job_id = j.job_id;

-- P09-c. v_answer_citation_raw(새, QA P-Q3): 인용 원소 원본(ref_index·저장 분류 포함). rd.job 기준이라 드롭·비완료 job 포함(G-24).
--        목록 citation_count 는 이 뷰의 answer_key = ANY(페이지) 등치 count(현행 행 count, qa-review.ts:345-346 과 같은 값)
CREATE VIEW rd.v_answer_citation_raw WITH (security_barrier) AS
  SELECT j.answer_key, j.surface, j.project_key, j.geo_key, j.bgrp, c.ord, c.url, c.title, c.ref_index, c.scope_category, c.host, c.domain_label
    FROM rd.job j JOIN ing.answer_key_map m ON m.job_id = j.job_id
    JOIN ing.citation c ON c.run_month = m.run_month AND c.job_id = m.job_id;

-- P09-d. 운영 조회 뷰(ingest 제안 1, GET /v1/admin/ingest/*). 원장 행 발췌와 조회 시 count 만(저장 없음).
--        ing.cycle 카운터는 여기 넣지 않았다: Q2 로 rd.cycle 에 같은 값이 투영되므로 운영 화면은 rd.cycle 을 읽는다.
CREATE VIEW rd.v_ingest_status WITH (security_barrier) AS
  SELECT c.scope_project_id, c.surface, c.last_attempt_at, c.last_success_at, c.last_error, c.prompts_updated_to, c.regions,
         r.open_runs, r.blocked_runs
    FROM ing.sync_cursor c
    CROSS JOIN LATERAL (SELECT count(*) FILTER (WHERE x.unresolved_jobs > 0 OR x.analysis_pending > 0) AS open_runs,
                               count(*) FILTER (WHERE x.sync_state = 'blocked') AS blocked_runs
                          FROM ing.run x WHERE x.scope_project_id = c.scope_project_id) r;
CREATE VIEW rd.v_ingest_backlog WITH (security_barrier) AS            -- R12 경보 대상: 재확인 창이 닫혔는데 미해소, 또는 blocked
  SELECT r.run_id, r.scope_project_id, c.surface, r.sync_state, r.status, r.total_jobs, r.unresolved_jobs, r.analysis_pending,
         r.recheck_until, r.analysis_recheck_until, r.attempts, r.next_attempt_at, r.last_error, r.started_at
    FROM ing.run r LEFT JOIN ing.sync_cursor c ON c.scope_project_id = r.scope_project_id
   WHERE r.sync_state = 'blocked'
      OR (r.unresolved_jobs  > 0 AND r.recheck_until          <= now())
      OR (r.analysis_pending > 0 AND r.analysis_recheck_until <= now());
CREATE VIEW rd.v_ingest_load WITH (security_barrier) AS               -- 키셋 load_id DESC
  SELECT l.load_id, l.kind, l.run_id, l.status, l.rule_ver, l.jobs_fetched, l.jobs_changed, l.jobs_removed, l.rd_answers_upserted,
         l.rd_gate_propagated, l.rd_rep_flips, l.rd_children_rows, l.started_at, l.finished_at, l.error
    FROM ing.load l;

-- 소유자 loader_ro(ing SELECT 보유), 읽기 롤 SELECT. CREATE OR REPLACE 한 두 뷰는 소유자·권한이 유지되지만 명시적으로 다시 맞춘다.
DO $$ DECLARE v text; BEGIN
  FOREACH v IN ARRAY ARRAY['rd.v_answer_mention_raw','rd.v_answer_registry','rd.v_answer_citation_raw',
                           'rd.v_ingest_status','rd.v_ingest_backlog','rd.v_ingest_load'] LOOP
    EXECUTE format('ALTER VIEW %s OWNER TO loader_ro', v);
    EXECUTE format('GRANT SELECT ON %s TO api_ro, admin_long', v);
  END LOOP; END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- P10. 스테이지 인덱스(채택 12, 적재 내부 전용)
-- ════════════════════════════════════════════════════════════════════════════
CREATE INDEX stage_mention_idx    ON ing.stage_mention    (load_id, job_id);
CREATE INDEX stage_occurrence_idx ON ing.stage_occurrence (load_id, job_id);
CREATE INDEX stage_stance_idx     ON ing.stage_stance     (load_id, job_id);
CREATE INDEX stage_citation_idx   ON ing.stage_citation   (load_id, job_id);

-- ════════════════════════════════════════════════════════════════════════════
-- P11. rd.answer 불변식(채택 13): 타깃 URL 인용이면 자사 URL 인용이다(own_url_cited = owned_base_hit OR target_hit, scope-aggregates.ts:9036-9037)
--   파티션 부모에 선언 → 하위 파티션 부모·이후 ensure_leaf 가 만드는 leaf 에 상속
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE rd.answer ADD CONSTRAINT answer_tgt_implies_own_url CHECK (NOT tgt_cited OR own_url_cited);

-- ════════════════════════════════════════════════════════════════════════════
-- P12. 인덱스(채택 14·15)
-- ════════════════════════════════════════════════════════════════════════════
CREATE INDEX dim_source_domain_idx        ON rd.dim_source (domain);                          -- domain 은 재구축으로만 바뀜
CREATE INDEX member_audit_project_idx     ON app.member_audit_log (project_id, created_at DESC);
CREATE INDEX scope_outbox_aggregate_idx   ON app.scope_outbox (aggregate, aggregate_id, created_at DESC);
CREATE INDEX permission_audit_target_idx  ON app.permission_audit_log (target_user_id, created_at DESC);
CREATE INDEX prompt_candidate_project_idx ON app.prompt_candidate (project_id, created_at DESC);
CREATE INDEX ctx_drive_requirement_idx    ON ext.ctx_drive (snapshot_id, requirement_id);

-- ════════════════════════════════════════════════════════════════════════════
-- P14. 열 추가(채택 17·18)
-- ════════════════════════════════════════════════════════════════════════════
-- conv_basis: GA4 적재자가 app.ga4_tracked_event 존재 여부로 판정. 변경은 'ga4_tracked_event' kind 로 전 기간 재투영
ALTER TABLE rd.ga4_dim_property ADD COLUMN conv_basis int2 NOT NULL CONSTRAINT ga4_dim_property_conv_basis_code CHECK (conv_basis IN (1, 2));
COMMENT ON COLUMN rd.ga4_dim_property.conv_basis IS '1 key events 폴백 2 추적 이벤트 event_count';
-- 생성 프롬프트 속성(현행 components/social-scraping/types.ts:187-204 GeneratedPrompt) + 동시 생성 중복 방지선 seed_key
--   seed_key = 현행 시드 id(l1-<ctx>, l2-<cond>, l3-<a>:<b>, l3-<ctx>-<cond>, selection-seeds.ts:14-17)를 조합쌍 정렬로 정규화한 값.
--   쓰기 주체 api_rw. seed_key 반영 전 IN-2 생성 엔드포인트 비공개.
ALTER TABLE app.ctx_generated_prompt
  ADD COLUMN layer text CONSTRAINT ctx_generated_prompt_layer_check CHECK (layer IN ('L1-context','L2-condition','L3-intersection')),
  ADD COLUMN funnel_stage text,
  ADD COLUMN priority int2,
  ADD COLUMN origin text CONSTRAINT ctx_generated_prompt_origin_check CHECK (origin IS NULL OR origin = 'composed'),
  ADD COLUMN seed_key text NOT NULL,
  ADD CONSTRAINT ctx_generated_prompt_seed_uq UNIQUE (project_id, seed_key);

-- ════════════════════════════════════════════════════════════════════════════
-- P15. Q4 접근 감사 append-only
--   기록 대상 = data_access·download·scope_call(api_read 는 기록 안 함, Q4). 쓰기 = api_rw 풀이 응답 후 묶어서 INSERT.
--   행 트리거로 둔다: 파티션 부모의 행 트리거는 기존·이후 leaf 에 복제되므로 leaf 를 직접 UPDATE·DELETE 해도 막힌다
--   (문장 트리거는 복제되지 않는다). 보존 기간 정리는 DELETE 가 아니라 leaf DETACH·DROP(소유자 DDL)로 한다.
-- ════════════════════════════════════════════════════════════════════════════
CREATE TRIGGER access_audit_ao BEFORE UPDATE OR DELETE ON app.access_audit_log
  FOR EACH ROW EXECUTE FUNCTION app.tg_append_only();
REVOKE UPDATE, DELETE ON app.access_audit_log FROM api_rw;           -- api_rw 는 INSERT·SELECT 만

-- ════════════════════════════════════════════════════════════════════════════
-- P16. Q17 검수 게이트 전용 롤 qa_gate (NOLOGIN 정의, 운영에서는 로그인 롤이 멤버십으로 상속)
--   계정 없는 외부 검수자(HMAC 세션 쿠키 게이트)의 QA 경로 전용. role 스코프 체계 밖이므로 app 의 다른 표·ing 는 권한 없음.
--   읽기: rd.job·rd.dim_*·rd.acr_*·rd.answer·rd.answer_brand·rd.citation·rd.v_*   쓰기: app.qa_* 4표
--   (statement_timeout 등 롤 설정은 로그인 롤에 둔다: 롤 설정은 멤버십으로 상속되지 않는다)
-- ════════════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qa_gate') THEN CREATE ROLE qa_gate NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA rd, app TO qa_gate;
GRANT SELECT ON rd.job, rd.answer, rd.answer_brand, rd.citation TO qa_gate;
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.oid::regclass AS obj FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'rd' AND NOT c.relispartition
              AND ((c.relkind IN ('r','p') AND (c.relname LIKE 'dim\_%' OR c.relname LIKE 'acr\_%'))
                   OR (c.relkind = 'v' AND c.relname LIKE 'v\_%')) LOOP
    EXECUTE format('GRANT SELECT ON %s TO qa_gate', r.obj);
  END LOOP; END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.qa_review_session, app.qa_answer_review, app.qa_review_note, app.qa_answer_lock TO qa_gate;

COMMIT;
