-- DB-v2.1 보완 패치 스모크: 빈 PG17 에 DB-v2.1.sql(= DB-v2.sql + DB-v2.1-patch.sql) 이상(v2.2·v2.3 합본 포함) 적용 후 실행. 합성 행만 쓴다(고객 데이터 없음).
-- 기존 smoke.sql 과 같은 DB 에서 이어 돌려도 키가 겹치지 않게 고유 uuid·answer_key 990001 대역을 쓴다. 두 번 돌리면 중복 키로 오염된다.
-- 결과는 NOTICE 'OK …' / 'FAIL …'. ON_ERROR_STOP 은 끄고 돌린다. 기대 실패는 DO 블록 EXCEPTION 으로 잡아 'OK …' 를 낸다.
-- 고정 식별자
--   사용자 a0000000-…-01, 시스템 행위자 a0000000-…-ff, 배치 b0000000-…-01, 프로젝트 c0000000-…-01, 프롬프트 c1000000-…-01
--   Scope 프롬프트 d1000000-…-01, Scope 프로젝트 e0000000-…-01(outbox 되쓰기)·e0000000-…-02(운영 뷰), job f0000000-…-01
\pset footer off
SET client_min_messages = notice;

\echo ===== V0 준비: 참조 행(소유자로), leaf 생성(적재기)
INSERT INTO app.brand (brand_code, brand_bit, sort_order) VALUES ('H', 1, 1), ('K', 2, 2);
SELECT set_config('app.actor_id', 'a0000000-0000-0000-0000-0000000000ff', false);   -- DB-v2.3: 계정 쓰기 행위자 필수(감사 트리거)
INSERT INTO app.user_account (user_id, email, role, scope_all) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'smoke-user@example.invalid', 'admin', true),
  ('a0000000-0000-0000-0000-0000000000ff', 'smoke-system@example.invalid', 'admin', true);
RESET app.actor_id;
INSERT INTO app.project (project_id, kind, name, domain, brand_code, country_code, created_by)
  VALUES ('c0000000-0000-0000-0000-000000000001', 'customer', 'smoke-v21', 'x.example', 'H', 'KR', 'a0000000-0000-0000-0000-000000000001');
SET ROLE loader;
DO $$ DECLARE p regclass; BEGIN
  FOREACH p IN ARRAY ARRAY['ing.answer','ing.mention','ing.mention_occurrence','ing.answer_stance','ing.citation']::regclass[] LOOP
    PERFORM rd.ensure_month_leaf(p, date '2026-09-15');
  END LOOP;
  PERFORM rd.ensure_leaf(3::int2, date '2026-09-01');
  RAISE NOTICE 'OK V0 leaf 준비(ing 2026-09, rd surface 3 분기 leaf)';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V0 leaf 준비: %', SQLERRM; END $$;
RESET ROLE;

\echo ===== V1 judgment_change.kind 확장(dfs_fetch·ga4_property·ga4_tracked_event)
SET ROLE api_rw;
DO $$ BEGIN
  INSERT INTO app.judgment_change (kind, payload) VALUES ('dfs_fetch', '{"endpoint":"search_volume","keywords":["smoke"]}'),
                                                         ('ga4_property', '{"property_id":"p-smoke"}'),
                                                         ('ga4_tracked_event', '{"property_id":"p-smoke","event_name":"lead"}');
  RAISE NOTICE 'OK V1 새 kind 3종 INSERT(api_rw)';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V1 새 kind INSERT: %', SQLERRM; END $$;
DO $$ BEGIN INSERT INTO app.judgment_change (kind) VALUES ('bogus_kind'); RAISE NOTICE 'FAIL V1 목록 밖 kind 통과';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK V1 목록 밖 kind 거부';
          WHEN others THEN RAISE NOTICE 'FAIL V1 목록 밖 kind 다른 오류: %', SQLERRM; END $$;
RESET ROLE;

\echo ===== V2 loader 의 judgment_change INSERT(scope_prompt) / 상태 전이 / DELETE 거부
SET ROLE loader;
DO $$ BEGIN
  INSERT INTO app.judgment_change (kind, subject_uuids, payload) VALUES ('scope_prompt', ARRAY['d1000000-0000-0000-0000-000000000099'::uuid], '{"field":"regions"}');
  RAISE NOTICE 'OK V2 loader scope_prompt INSERT';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V2 loader INSERT: %', SQLERRM; END $$;
DO $$ BEGIN
  UPDATE app.judgment_change SET status = 'running', claimed_at = now() WHERE kind = 'dfs_fetch' AND status = 'pending';
  UPDATE app.judgment_change SET status = 'applied', applied_at = now() WHERE kind = 'dfs_fetch' AND status = 'running';
  RAISE NOTICE 'OK V2 loader 상태 전이(dfs_fetch pending → running → applied)';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V2 loader 상태 전이: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE app.judgment_change SET kind = 'catalog' WHERE kind = 'dfs_fetch'; RAISE NOTICE 'FAIL V2 loader 가 kind 열을 바꿈';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V2 loader kind 열 UPDATE 거부';
          WHEN others THEN RAISE NOTICE 'FAIL V2 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN DELETE FROM app.judgment_change WHERE kind = 'scope_prompt'; RAISE NOTICE 'FAIL V2 loader 가 큐를 지움';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V2 loader 큐 DELETE 거부';
          WHEN others THEN RAISE NOTICE 'FAIL V2 다른 오류: %', SQLERRM; END $$;
RESET ROLE;

\echo ===== V3 트리거 + outbox 워커: api_rw 가 프롬프트 생성(배치 GUC) → loader 가 outbox 처리·scope_*_id 되쓰기
SET ROLE api_rw;
SET app.actor_id = 'a0000000-0000-0000-0000-000000000001';
SET app.batch_id = 'b0000000-0000-0000-0000-000000000001';
DO $$ BEGIN
  INSERT INTO app.prompt (prompt_id, project_id, text, brand_code, kind, created_by)
    VALUES ('c1000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', '합성 프롬프트 v1', 'H', 'single',
            'a0000000-0000-0000-0000-000000000001');
  INSERT INTO app.scope_outbox (aggregate, aggregate_id, op, payload)
    VALUES ('prompt', 'c1000000-0000-0000-0000-000000000001', 'create', '{"text":"합성 프롬프트 v1"}'),
           ('project', 'c0000000-0000-0000-0000-000000000001', 'create', '{}');
  RAISE NOTICE 'OK V3 api_rw 프롬프트·outbox INSERT';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V3 api_rw 준비: %', SQLERRM; END $$;
SET app.batch_id = '';
RESET ROLE;

SET ROLE loader;
SET app.actor_id = 'a0000000-0000-0000-0000-0000000000ff';
SET app.actor_type = 'system';
DO $$ BEGIN
  UPDATE app.scope_outbox SET attempts = attempts + 1, next_attempt_at = now(), done_at = now(), last_error = NULL WHERE done_at IS NULL;
  RAISE NOTICE 'OK V3 loader outbox 상태 열 UPDATE';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V3 loader outbox UPDATE: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE app.scope_outbox SET payload = '{}'; RAISE NOTICE 'FAIL V3 loader 가 outbox payload 를 바꿈';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V3 loader outbox payload UPDATE 거부';
          WHEN others THEN RAISE NOTICE 'FAIL V3 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN
  UPDATE app.prompt SET scope_prompt_id = 'd1000000-0000-0000-0000-000000000001', status = 'queued',
                        updated_by = app.actor(), updated_at = now()
   WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';
  UPDATE app.project SET scope_project_id = 'e0000000-0000-0000-0000-000000000001', updated_at = now()
   WHERE project_id = 'c0000000-0000-0000-0000-000000000001';
  RAISE NOTICE 'OK V3 loader scope_prompt_id·scope_project_id 되쓰기(app.actor() 실행 포함)';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V3 loader 되쓰기: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE app.prompt SET text = '적재기가 본문 수정' WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';
  RAISE NOTICE 'FAIL V3 loader 가 프롬프트 본문을 바꿈';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V3 loader app.prompt.text UPDATE 거부';
          WHEN others THEN RAISE NOTICE 'FAIL V3 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE app.project SET name = '적재기가 이름 수정'; RAISE NOTICE 'FAIL V3 loader 가 프로젝트 이름을 바꿈';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V3 loader app.project.name UPDATE 거부';
          WHEN others THEN RAISE NOTICE 'FAIL V3 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN INSERT INTO app.prompt_audit_log (prompt_id, project_id, event_type) VALUES (gen_random_uuid(), gen_random_uuid(), 'created');
  RAISE NOTICE 'FAIL V3 loader 가 감사 원장에 직접 씀';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V3 loader 감사 원장 직접 INSERT 거부(트리거 경유만)';
          WHEN others THEN RAISE NOTICE 'FAIL V3 다른 오류: %', SQLERRM; END $$;
SET app.actor_type = '';
RESET ROLE;

\echo ===== V4 트리거: api_rw 편집 연쇄 → prompt_audit_log·judgment_change
SET ROLE api_rw;
SET app.actor_id = 'a0000000-0000-0000-0000-000000000001';
DO $$ BEGIN
  UPDATE app.prompt SET text = '합성 프롬프트 v2' WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';   -- text_updated, 큐 없음
  UPDATE app.prompt SET kind = 'acr'              WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';   -- kind_changed + prompt_kind
  UPDATE app.prompt SET brand_code = 'K'          WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';   -- meta_updated + catalog
  UPDATE app.prompt SET status = 'paused'         WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';   -- enabled_changed
  UPDATE app.prompt SET status = 'queued'         WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';   -- enabled_changed
  UPDATE app.prompt SET status = 'running'        WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';   -- 수명 전이만: 감사 없음
  UPDATE app.prompt SET deleted_at = now()        WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';   -- deleted + catalog
  UPDATE app.prompt SET deleted_at = NULL         WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';   -- restored + catalog
  RAISE NOTICE 'OK V4 api_rw 편집 연쇄 8건';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V4 편집 연쇄: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE app.prompt SET status = 'bogus' WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';
  RAISE NOTICE 'FAIL V4 status 목록 밖 값 통과';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK V4 app.prompt.status 6값 CHECK';
          WHEN others THEN RAISE NOTICE 'FAIL V4 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN INSERT INTO app.prompt_audit_log (prompt_id, project_id, event_type) VALUES (gen_random_uuid(), gen_random_uuid(), 'created');
  RAISE NOTICE 'FAIL V4 api_rw 가 감사 원장에 직접 씀(이중 기록 가능)';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V4 api_rw 감사 원장 직접 INSERT 거부';
          WHEN others THEN RAISE NOTICE 'FAIL V4 다른 오류: %', SQLERRM; END $$;
SET app.actor_type = 'robot';
DO $$ BEGIN UPDATE app.prompt SET text = '잘못된 행위자 유형' WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';
  RAISE NOTICE 'FAIL V4 actor_type 검증 없음';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'OK V4 actor_type 값 검증: %', SQLERRM;
          WHEN others THEN RAISE NOTICE 'FAIL V4 다른 오류: %', SQLERRM; END $$;
SET app.actor_type = '';
SET app.actor_id = '';
DO $$ BEGIN UPDATE app.prompt SET text = '행위자 없음' WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';
  RAISE NOTICE 'FAIL V4 행위자 없는 프롬프트 쓰기 통과';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'OK V4 행위자 없는 app.prompt 쓰기 거부: %', SQLERRM;
          WHEN others THEN RAISE NOTICE 'FAIL V4 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE app.project SET domain = 'nobody.example' WHERE project_id = 'c0000000-0000-0000-0000-000000000001';
  RAISE NOTICE 'FAIL V4 행위자 없는 프로젝트 설정 변경 통과';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'OK V4 행위자 없는 app.project 설정 변경 거부';
          WHEN others THEN RAISE NOTICE 'FAIL V4 다른 오류: %', SQLERRM; END $$;
SET app.actor_id = 'a0000000-0000-0000-0000-000000000001';
DO $$ BEGIN
  UPDATE app.project SET domain = 'y.example', ai_engines = ARRAY['chatgpt','gemini'] WHERE project_id = 'c0000000-0000-0000-0000-000000000001';
  UPDATE app.project SET name = '이름만 변경', description = '설명' WHERE project_id = 'c0000000-0000-0000-0000-000000000001';   -- 큐 없음
  DELETE FROM app.prompt WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';                                           -- deleted(purged) + catalog
  RAISE NOTICE 'OK V4 프로젝트 설정·이름 변경, 프롬프트 하드 삭제';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V4 프로젝트·삭제: %', SQLERRM; END $$;
RESET ROLE;

\echo -- 트리거 기록 결과(관찰)
SELECT audit_id, event_type, actor_type, (batch_id IS NOT NULL) AS has_batch, actor_id = 'a0000000-0000-0000-0000-0000000000ff' AS by_system, changes
  FROM app.prompt_audit_log WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001' ORDER BY audit_id;
SELECT change_id, kind, subject_uuids, payload->>'op' AS op, payload->'old'->>'brand_code' AS old_brand, payload->'new'->>'brand_code' AS new_brand,
       payload->'new'->>'kind' AS new_kind, requested_by = 'a0000000-0000-0000-0000-0000000000ff' AS by_system
  FROM app.judgment_change WHERE kind IN ('catalog','prompt_kind','project_setting') AND (payload->>'prompt_id' = 'c1000000-0000-0000-0000-000000000001'
        OR payload->>'project_id' = 'c0000000-0000-0000-0000-000000000001') ORDER BY change_id;
DO $$ DECLARE ev text[]; ty text[]; bt bool[]; jc text[]; ps int; pl jsonb; BEGIN
  SELECT array_agg(event_type ORDER BY audit_id), array_agg(actor_type ORDER BY audit_id), array_agg(batch_id IS NOT NULL ORDER BY audit_id)
    INTO ev, ty, bt FROM app.prompt_audit_log WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001';
  IF ev = ARRAY['created','meta_updated','text_updated','kind_changed','meta_updated','enabled_changed','enabled_changed','deleted','restored','deleted']
  THEN RAISE NOTICE 'OK V4 감사 이벤트 순서 10건 = %', ev; ELSE RAISE NOTICE 'FAIL V4 감사 이벤트 순서 = %', ev; END IF;
  IF ty = ARRAY['user','system','user','user','user','user','user','user','user','user'] AND bt[1] AND NOT bt[2]
  THEN RAISE NOTICE 'OK V4 행위자 유형(outbox 되쓰기 = system)·batch_id(생성 배치만)'; ELSE RAISE NOTICE 'FAIL V4 행위자·배치 = % / %', ty, bt; END IF;
  SELECT array_agg(kind ORDER BY change_id) INTO jc FROM app.judgment_change
   WHERE kind IN ('catalog','prompt_kind') AND payload->>'prompt_id' = 'c1000000-0000-0000-0000-000000000001';
  IF jc = ARRAY['catalog','prompt_kind','catalog','catalog','catalog','catalog']
  THEN RAISE NOTICE 'OK V4 재판정 요청 6건(되쓰기 catalog, kind → prompt_kind, 브랜드·삭제·복원·하드삭제 catalog) = %', jc;
  ELSE RAISE NOTICE 'FAIL V4 재판정 요청 = %', jc; END IF;
  SELECT count(*), (array_agg(payload))[1] INTO ps, pl FROM app.judgment_change WHERE kind = 'project_setting' AND 'c0000000-0000-0000-0000-000000000001' = ANY(subject_uuids);
  IF ps = 1 AND pl->'old'->>'domain' = 'x.example' AND pl->'new'->>'domain' = 'y.example' AND pl->>'op' = 'update'
  THEN RAISE NOTICE 'OK V4 project_setting 1건(되쓰기·이름 변경은 큐 없음) old/new = % → %', pl->'old'->>'domain', pl->'new'->>'domain';
  ELSE RAISE NOTICE 'FAIL V4 project_setting % 건 %', ps, pl; END IF;
  IF (SELECT changes ? 'purged' FROM app.prompt_audit_log WHERE prompt_id = 'c1000000-0000-0000-0000-000000000001' ORDER BY audit_id DESC LIMIT 1)
  THEN RAISE NOTICE 'OK V4 하드 삭제는 purged 표시'; ELSE RAISE NOTICE 'FAIL V4 하드 삭제 표시 없음'; END IF;
END $$;

\echo ===== V5 Q4 app.access_audit_log append-only (파티션 표)
SET ROLE loader;
DO $$ BEGIN PERFORM rd.ensure_month_leaf('app.access_audit_log'::regclass, date '2026-10-15'); RAISE NOTICE 'OK V5 감사 leaf 2026-10 생성';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V5 leaf: %', SQLERRM; END $$;
RESET ROLE;
SET ROLE api_rw;
DO $$ BEGIN
  INSERT INTO app.access_audit_log (ts, actor_id, actor_role, kind, action, target)
    VALUES ('2026-10-10 00:00+00', 'a0000000-0000-0000-0000-000000000001', 'hq', 'data_access', 'smoke-v21', 'answer:990001');
  PERFORM 1 FROM app.access_audit_log WHERE action = 'smoke-v21';
  RAISE NOTICE 'OK V5 api_rw INSERT·SELECT';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V5 api_rw INSERT: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE app.access_audit_log SET action = 'tampered' WHERE action = 'smoke-v21'; RAISE NOTICE 'FAIL V5 api_rw UPDATE 통과';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V5 api_rw UPDATE 권한 거부';
          WHEN others THEN RAISE NOTICE 'FAIL V5 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN DELETE FROM app.access_audit_log WHERE action = 'smoke-v21'; RAISE NOTICE 'FAIL V5 api_rw DELETE 통과';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V5 api_rw DELETE 권한 거부';
          WHEN others THEN RAISE NOTICE 'FAIL V5 다른 오류: %', SQLERRM; END $$;
RESET ROLE;
\echo -- 권한을 우회하는 superuser 로도 트리거가 막는지(부모 경유·leaf 직접)
DO $$ BEGIN UPDATE app.access_audit_log SET action = 'tampered' WHERE action = 'smoke-v21'; RAISE NOTICE 'FAIL V5 superuser 부모 UPDATE 통과';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'OK V5 부모 경유 UPDATE 트리거 거부: %', SQLERRM; END $$;
DO $$ BEGIN DELETE FROM app.access_audit_log WHERE action = 'smoke-v21'; RAISE NOTICE 'FAIL V5 superuser 부모 DELETE 통과';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'OK V5 부모 경유 DELETE 트리거 거부: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE app.access_audit_log_202610 SET action = 'tampered' WHERE action = 'smoke-v21'; RAISE NOTICE 'FAIL V5 leaf 직접 UPDATE 통과';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'OK V5 leaf 직접 UPDATE 트리거 거부: %', SQLERRM; END $$;
DO $$ BEGIN DELETE FROM app.access_audit_log_202610 WHERE action = 'smoke-v21'; RAISE NOTICE 'FAIL V5 leaf 직접 DELETE 통과';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'OK V5 leaf 직접 DELETE 트리거 거부: %', SQLERRM; END $$;
DO $$ DECLARE n int; BEGIN
  PERFORM rd.ensure_month_leaf('app.access_audit_log'::regclass, date '2026-11-15');
  SELECT count(*) INTO n FROM pg_trigger WHERE tgrelid = 'app.access_audit_log_202611'::regclass AND tgname = 'access_audit_ao' AND tgparentid <> 0;
  INSERT INTO app.access_audit_log (ts, actor_id, actor_role, kind, action) VALUES ('2026-11-02 00:00+00', gen_random_uuid(), 'hq', 'download', 'smoke-v21-nov');
  BEGIN
    UPDATE app.access_audit_log_202611 SET action = 'tampered';
    RAISE NOTICE 'FAIL V5 나중 leaf 에 트리거 없음(복제 %건)', n;
  EXCEPTION WHEN raise_exception THEN
    IF n = 1 THEN RAISE NOTICE 'OK V5 트리거 뒤에 만든 leaf 도 복제 트리거로 거부(복제 %건)', n; ELSE RAISE NOTICE 'FAIL V5 복제 트리거 수 %', n; END IF;
  END;
END $$;
SELECT (SELECT count(*) FROM app.access_audit_log WHERE action LIKE 'smoke-v21%') AS audit_rows_intact,
       has_table_privilege('api_rw', 'app.access_audit_log', 'INSERT') AS rw_ins, has_table_privilege('api_rw', 'app.access_audit_log', 'SELECT') AS rw_sel,
       has_table_privilege('api_rw', 'app.access_audit_log', 'UPDATE') AS rw_upd, has_table_privilege('api_rw', 'app.access_audit_log', 'DELETE') AS rw_del;

\echo ===== V6 문서형·운영 조회 뷰(적재기가 합성 원본을 쓰고 api_ro 가 뷰로 읽음)
SET ROLE loader;
DO $$ DECLARE k int4; BEGIN
  INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ('f0000000-0000-0000-0000-000000000001', '2026-09-01') RETURNING answer_key INTO k;
  -- 비완료(failed)·비서빙 job: G-24 모집단(드롭·비완료 포함)이 뷰에 나오는지 본다
  INSERT INTO rd.job (answer_key, job_id, run_key, cyc_key, round_date, measured_at, surface, project_key, engine_key, geo_key, lang_key, bgrp,
                      status_code, served, load_id)
    VALUES (k, 'f0000000-0000-0000-0000-000000000001', 1, 1, '2026-09-07', NULL, 1, 1, 1, 1, 1, 1, 2, false, 1);
  INSERT INTO ing.citation (run_month, job_id, ord, url, title, ref_index, scope_category, host, domain_label)
    VALUES ('2026-09-01', 'f0000000-0000-0000-0000-000000000001', 0, 'https://news.example/a', '합성 기사', 3, 'news', 'news.example', 'news.example'),
           ('2026-09-01', 'f0000000-0000-0000-0000-000000000001', 1, 'https://blog.example/b', '합성 블로그', 7, 'blog', 'blog.example', 'blog.example');
  INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count, sentiment_positive, sentiment_negative, type_recommendation)
    VALUES ('2026-09-01', 'f0000000-0000-0000-0000-000000000001', 0, 'f1000000-0000-0000-0000-000000000001', '합성 브랜드', 'Brand', 3, 2, 1, 1);
  INSERT INTO ing.answer_anchor_pin (job_id, anchor, source_measured_at, reason) VALUES ('f0000000-0000-0000-0000-000000000001', '2026-09-07', '2026-09-08 01:00+00', 'smoke');
  INSERT INTO ing.answer_drop (job_id, source_measured_at, reason) VALUES ('f0000000-0000-0000-0000-000000000001', '2026-09-08 02:00+00', 'smoke');
  INSERT INTO ing.sync_cursor (scope_project_id, surface, last_attempt_at, last_success_at, regions)
    VALUES ('e0000000-0000-0000-0000-000000000002', 'global', now(), now(), ARRAY['KR','US']);
  INSERT INTO ing.run (run_id, scope_project_id, run_month, status, unresolved_jobs, analysis_pending, recheck_until, analysis_recheck_until, sync_state, started_at) VALUES
    ('f2000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002', '2026-09-01', 'completed', 2, 0, now() - interval '1 day', NULL, 'loaded', now() - interval '5 day'),
    ('f2000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000002', '2026-09-01', 'running',   0, 0, NULL, NULL, 'blocked', now() - interval '4 day'),
    ('f2000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000002', '2026-09-01', 'running',   1, 0, now() + interval '2 day', NULL, 'staging', now() - interval '1 day');
  INSERT INTO ing.load (kind, rule_ver, status, jobs_fetched) VALUES ('run', 1, 'committed', 42);
  RAISE NOTICE 'OK V6 합성 원본 적재(answer_key %)', k;
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V6 합성 원본: %', SQLERRM; END $$;
RESET ROLE;

SET ROLE api_ro;
DO $$ DECLARE k int4; n int; r record; BEGIN
  SELECT answer_key INTO k FROM rd.job WHERE job_id = 'f0000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO n FROM rd.v_answer_citation_raw WHERE answer_key = k;
  SELECT * INTO r FROM rd.v_answer_citation_raw WHERE answer_key = k AND ord = 0;
  IF n = 2 AND r.ref_index = 3 AND r.scope_category = 'news' THEN RAISE NOTICE 'OK V6 v_answer_citation_raw 비서빙 job 인용 2건(ref_index·저장 분류 포함)';
  ELSE RAISE NOTICE 'FAIL V6 v_answer_citation_raw n=% r=%', n, r; END IF;
  SELECT * INTO r FROM rd.v_answer_mention_raw WHERE answer_key = k;
  IF r.sentiment_positive = 2 AND r.sentiment_negative = 1 AND r.type_recommendation = 1 AND r.sentiment_mixed = 0 AND r.type_final_choice = 0
  THEN RAISE NOTICE 'OK V6 v_answer_mention_raw 감성 4·유형 5 열'; ELSE RAISE NOTICE 'FAIL V6 v_answer_mention_raw %', r; END IF;
  SELECT * INTO r FROM rd.v_answer_registry WHERE answer_key = k;
  IF r.pin_source_measured_at IS NOT NULL AND r.drop_source_measured_at IS NOT NULL AND r.pin_reason = 'smoke'
  THEN RAISE NOTICE 'OK V6 v_answer_registry source_measured_at 2열'; ELSE RAISE NOTICE 'FAIL V6 v_answer_registry %', r; END IF;
  SELECT * INTO r FROM rd.v_ingest_status WHERE scope_project_id = 'e0000000-0000-0000-0000-000000000002';
  IF r.open_runs = 2 AND r.blocked_runs = 1 AND r.regions = ARRAY['KR','US'] THEN RAISE NOTICE 'OK V6 v_ingest_status open 2·blocked 1·regions';
  ELSE RAISE NOTICE 'FAIL V6 v_ingest_status %', r; END IF;
  SELECT count(*) INTO n FROM rd.v_ingest_backlog WHERE scope_project_id = 'e0000000-0000-0000-0000-000000000002';
  IF n = 2 THEN RAISE NOTICE 'OK V6 v_ingest_backlog 2건(창 닫힘 미해소 + blocked, 창 열린 run 제외)'; ELSE RAISE NOTICE 'FAIL V6 v_ingest_backlog %', n; END IF;
  SELECT count(*) INTO n FROM rd.v_ingest_load WHERE jobs_fetched = 42;
  IF n = 1 THEN RAISE NOTICE 'OK V6 v_ingest_load'; ELSE RAISE NOTICE 'FAIL V6 v_ingest_load %', n; END IF;
  SELECT count(*) INTO n FROM rd.cycle WHERE expected_units IS NULL OR expected_units IS NOT NULL;   -- 새 열 읽기 권한
  SELECT count(*) INTO n FROM rd.dim_project WHERE regions IS NULL;
  RAISE NOTICE 'OK V6 api_ro rd.cycle 카운터·rd.dim_project.regions 읽기';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V6 api_ro 뷰 읽기: %', SQLERRM; END $$;
DO $$ BEGIN PERFORM 1 FROM ing.citation LIMIT 1; RAISE NOTICE 'FAIL V6 api_ro 가 ing.citation 을 직접 읽음';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V6 api_ro ing.citation 직접 읽기 거부(뷰 경유만)';
          WHEN others THEN RAISE NOTICE 'FAIL V6 다른 오류: %', SQLERRM; END $$;
RESET ROLE;
SELECT c.relname AS view, pg_get_userbyid(c.relowner) AS owner, c.reloptions,
       has_table_privilege('api_ro', c.oid, 'SELECT') AS api_ro, has_table_privilege('admin_long', c.oid, 'SELECT') AS admin_long,
       has_table_privilege('qa_gate', c.oid, 'SELECT') AS qa_gate
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'rd' AND c.relkind = 'v' ORDER BY 1;
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'rd' AND c.relkind = 'v' AND pg_get_userbyid(c.relowner) = 'loader_ro' AND c.reloptions @> ARRAY['security_barrier=true']
     AND has_table_privilege('api_ro', c.oid, 'SELECT');
  IF n = 9 THEN RAISE NOTICE 'OK V6 rd 뷰 9개 전부 소유자 loader_ro·security_barrier·api_ro SELECT'; ELSE RAISE NOTICE 'FAIL V6 뷰 규약 충족 %/9', n; END IF;
END $$;

\echo ===== V7 Q17 qa_gate: app.qa_* 쓰기, rd 읽기, 그 밖 거부
SET ROLE qa_gate;
DO $$ DECLARE s uuid; k int4; n int; BEGIN
  INSERT INTO app.qa_review_session (reviewer_name, user_agent) VALUES ('외부검수자A', 'smoke') RETURNING session_id INTO s;
  INSERT INTO app.qa_answer_review (job_id, flag_answer, flag_citations, reviewer_name, session_id)
    VALUES ('f0000000-0000-0000-0000-000000000001', 'ok', 'issue', '외부검수자A', s);
  UPDATE app.qa_answer_review SET flag_citations = 'ok', updated_at = now() WHERE job_id = 'f0000000-0000-0000-0000-000000000001';
  INSERT INTO app.qa_review_note (job_id, target_kind, target_key, body, reviewer_name, session_id)
    VALUES ('f0000000-0000-0000-0000-000000000001', 'citation', 'f0000000-0000-0000-0000-000000000001:0', '합성 노트', '외부검수자A', s);
  UPDATE app.qa_review_note SET resolved_at = now(), resolved_by = '외부검수자A' WHERE job_id = 'f0000000-0000-0000-0000-000000000001';
  INSERT INTO app.qa_answer_lock (job_id, session_id, reviewer_name) VALUES ('f0000000-0000-0000-0000-000000000001', s, '외부검수자A');
  UPDATE app.qa_answer_lock SET heartbeat_at = now() WHERE job_id = 'f0000000-0000-0000-0000-000000000001';
  DELETE FROM app.qa_answer_lock WHERE job_id = 'f0000000-0000-0000-0000-000000000001';
  DELETE FROM app.qa_review_note WHERE job_id = 'f0000000-0000-0000-0000-000000000001' AND reviewer_name = '외부검수자A';
  UPDATE app.qa_review_session SET last_seen_at = now() WHERE session_id = s;
  RAISE NOTICE 'OK V7 qa_gate app.qa_* 4표 INSERT·UPDATE·DELETE';
  SELECT answer_key INTO k FROM rd.job WHERE job_id = 'f0000000-0000-0000-0000-000000000001';
  PERFORM 1 FROM rd.answer LIMIT 1;  PERFORM 1 FROM rd.answer_brand LIMIT 1;  PERFORM 1 FROM rd.citation LIMIT 1;
  PERFORM 1 FROM rd.dim_prompt LIMIT 1;  PERFORM 1 FROM rd.dim_entity LIMIT 1;  PERFORM 1 FROM rd.dim_country LIMIT 1;
  PERFORM 1 FROM rd.acr_cell LIMIT 1;  PERFORM 1 FROM rd.acr_cell_job LIMIT 1;  PERFORM 1 FROM rd.acr_choice LIMIT 1;
  PERFORM 1 FROM rd.v_answer_body WHERE answer_key = k;
  SELECT count(*) INTO n FROM rd.v_answer_citation_raw WHERE answer_key = k;
  RAISE NOTICE 'OK V7 qa_gate rd.job·answer·answer_brand·citation·dim_*·acr_*·v_* 읽기(인용 원본 % 건)', n;
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V7 qa_gate 허용 경로: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE app.project SET name = 'qa 가 바꿈'; RAISE NOTICE 'FAIL V7 qa_gate app.project UPDATE 통과';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V7 qa_gate app.project UPDATE 거부'; WHEN others THEN RAISE NOTICE 'FAIL V7 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN INSERT INTO app.judgment_change (kind) VALUES ('entity'); RAISE NOTICE 'FAIL V7 qa_gate 큐 INSERT 통과';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V7 qa_gate app.judgment_change INSERT 거부'; WHEN others THEN RAISE NOTICE 'FAIL V7 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN PERFORM 1 FROM app.user_account LIMIT 1; RAISE NOTICE 'FAIL V7 qa_gate app.user_account 읽음';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V7 qa_gate app.user_account 읽기 거부'; WHEN others THEN RAISE NOTICE 'FAIL V7 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN PERFORM 1 FROM ing.answer LIMIT 1; RAISE NOTICE 'FAIL V7 qa_gate ing 읽음';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V7 qa_gate ing.answer 읽기 거부'; WHEN others THEN RAISE NOTICE 'FAIL V7 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN INSERT INTO ing.load (kind, rule_ver) VALUES ('run', 1); RAISE NOTICE 'FAIL V7 qa_gate ing 씀';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V7 qa_gate ing.load INSERT 거부'; WHEN others THEN RAISE NOTICE 'FAIL V7 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE rd.job SET dropped = dropped WHERE false; RAISE NOTICE 'FAIL V7 qa_gate rd.job UPDATE 통과';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V7 qa_gate rd.job UPDATE 거부'; WHEN others THEN RAISE NOTICE 'FAIL V7 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN PERFORM 1 FROM rd.cycle LIMIT 1; RAISE NOTICE 'FAIL V7 qa_gate 목록 밖 rd.cycle 읽음';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V7 qa_gate 목록 밖 rd.cycle 읽기 거부'; WHEN others THEN RAISE NOTICE 'FAIL V7 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN PERFORM 1 FROM app.prompt LIMIT 1; RAISE NOTICE 'FAIL V7 qa_gate 목록 밖 app.prompt 읽음';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'OK V7 qa_gate 목록 밖 app.prompt 읽기 거부'; WHEN others THEN RAISE NOTICE 'FAIL V7 다른 오류: %', SQLERRM; END $$;
RESET ROLE;

\echo ===== V8 rd.answer CHECK (NOT tgt_cited OR own_url_cited): 패치 뒤 만든 leaf 에서
--   DB-v2.2 이후 인용 수 열(G-25)과 불리언 동치 CHECK(answer_cit_flags)가 함께 걸리므로 행은 cit_* 를 불리언과 맞춰 넣는다.
--   tgt_cited ∧ ¬own_url_cited 는 answer_tgt_implies_own_url 과 answer_cit_bounds(cit_loc_tgt ≥ cit_tgt) 둘 다 위반이다.
SET ROLE loader;
DO $$ BEGIN
  INSERT INTO rd.answer (round_date, answer_key, anchor_date, cyc_key, run_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key,
                         cat_mask, bgrp, anchor_src, analysis_state, elig, dflt, has_cit, tgt_cited, own_url_cited, cit_n, cit_tgt, rule_ver, load_id)
    VALUES ('2026-09-07', 990001, '2026-09-07', 1, 1, 1, 3, 1, 1, 1, 1, 0, 1, 1, 0, true, true, true, true, false, 1, 1, 1, 1);
  RAISE NOTICE 'FAIL V8 tgt_cited ∧ NOT own_url_cited 통과';
EXCEPTION WHEN check_violation THEN
            IF SQLERRM ~ '(answer_tgt_implies_own_url|answer_cit_bounds|answer_cit_flags)' THEN RAISE NOTICE 'OK V8 불변식 위반 거부: %', SQLERRM;
            ELSE RAISE NOTICE 'FAIL V8 다른 CHECK: %', SQLERRM; END IF;
          WHEN others THEN RAISE NOTICE 'FAIL V8 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN
  INSERT INTO rd.answer (round_date, answer_key, anchor_date, cyc_key, run_key, prompt_key, surface, project_key, engine_key, geo_key, lang_key,
                         cat_mask, bgrp, anchor_src, analysis_state, elig, dflt, has_cit, tgt_cited, own_url_cited,
                         cit_n, cit_tgt, cit_loc_tgt, rule_ver, load_id)
    VALUES ('2026-09-07', 990001, '2026-09-07', 1, 1, 1, 3, 1, 1, 1, 1, 0, 1, 1, 0, true, true, true, true, true, 1, 1, 1, 1, 1);
  RAISE NOTICE 'OK V8 tgt_cited ∧ own_url_cited 허용';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V8 정상 행 거부: %', SQLERRM; END $$;
RESET ROLE;
SELECT conrelid::regclass AS rel, conname FROM pg_constraint WHERE conname = 'answer_tgt_implies_own_url' ORDER BY 1::text;

\echo ===== V9 rd.cycle Q2 카운터·hidden_reason
SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
 WHERE table_schema = 'rd' AND table_name = 'cycle' AND column_name IN ('expected_units','completed_units','completed_answers','gap_answers','hidden_reason')
 ORDER BY ordinal_position;
SET ROLE loader;
DO $$ BEGIN
  INSERT INTO rd.cycle (cyc_key, cycle_id, surface, project_key, ledger_backed, round_date, anchor_date, status, servable, view_date, hidden_scope, generation,
                        expected_units, completed_units, completed_answers, gap_answers)
    VALUES (990001, gen_random_uuid(), 1, 1, true, '2026-09-07', '2026-09-07', 1, true, '2026-09-09', 0, 1, 120, 110, 110, 3);
  UPDATE rd.cycle SET completed_units = 112, completed_answers = 112, gap_answers = 2 WHERE cyc_key = 990001;   -- 제자리 투영 갱신
  RAISE NOTICE 'OK V9 rd.cycle 카운터 투영 INSERT·UPDATE';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V9 rd.cycle 카운터: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE rd.cycle SET gap_answers = 999 WHERE cyc_key = 990001; RAISE NOTICE 'FAIL V9 gap > completed 통과';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK V9 gap_answers <= completed_answers CHECK'; WHEN others THEN RAISE NOTICE 'FAIL V9 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE rd.cycle SET hidden_scope = 1 WHERE cyc_key = 990001; RAISE NOTICE 'FAIL V9 숨김 사유 없는 숨김 통과';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK V9 hidden_scope·hidden_reason 짝 CHECK'; WHEN others THEN RAISE NOTICE 'FAIL V9 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN UPDATE rd.cycle SET hidden_scope = 2, hidden_reason = 2 WHERE cyc_key = 990001; RAISE NOTICE 'OK V9 인용 숨김(operator) 투영';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V9 숨김 투영: %', SQLERRM; END $$;
RESET ROLE;
SET ROLE api_ro;
SELECT cyc_key, expected_units, completed_units, completed_answers, gap_answers, hidden_scope, hidden_reason FROM rd.cycle WHERE cyc_key = 990001;
RESET ROLE;

\echo ===== V10 기타 열·제약·인덱스·주석·소유자
SET ROLE api_rw;
SET app.actor_id = 'a0000000-0000-0000-0000-000000000001';
DO $$ BEGIN
  INSERT INTO app.member_audit_log (project_id, actor_id, target_user_id, action, context)
    VALUES ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'promote', 'orphan-succession (smoke)');
  RAISE NOTICE 'OK V10 member_audit_log action=promote(관리자 승계 표기)';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V10 member_audit_log: %', SQLERRM; END $$;
DO $$ BEGIN
  INSERT INTO app.member_audit_log (project_id, actor_id, target_user_id, action)
    VALUES ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'succeed');
  RAISE NOTICE 'FAIL V10 action 목록 밖 값 통과';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK V10 member_audit_log.action 7값 CHECK'; WHEN others THEN RAISE NOTICE 'FAIL V10 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN
  INSERT INTO app.ctx_generated_prompt (project_id, batch_no, text, layer, funnel_stage, priority, origin, seed_key)
    VALUES ('c0000000-0000-0000-0000-000000000001', 1, '합성 생성 프롬프트', 'L3-intersection', 'consideration', 1, 'composed', 'l3-a:b');
  RAISE NOTICE 'OK V10 ctx_generated_prompt 새 열 INSERT';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V10 ctx_generated_prompt: %', SQLERRM; END $$;
DO $$ BEGIN
  INSERT INTO app.ctx_generated_prompt (project_id, batch_no, text, seed_key) VALUES ('c0000000-0000-0000-0000-000000000001', 2, '동시 생성 중복', 'l3-a:b');
  RAISE NOTICE 'FAIL V10 seed_key 중복 통과';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'OK V10 (project_id, seed_key) UNIQUE'; WHEN others THEN RAISE NOTICE 'FAIL V10 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN
  INSERT INTO app.ctx_generated_prompt (project_id, batch_no, text) VALUES ('c0000000-0000-0000-0000-000000000001', 2, 'seed_key 없음');
  RAISE NOTICE 'FAIL V10 seed_key NULL 통과';
EXCEPTION WHEN not_null_violation THEN RAISE NOTICE 'OK V10 seed_key NOT NULL'; WHEN others THEN RAISE NOTICE 'FAIL V10 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN
  INSERT INTO app.ctx_generated_prompt (project_id, batch_no, text, layer, seed_key) VALUES ('c0000000-0000-0000-0000-000000000001', 2, 'x', 'L9', 'l1-z');
  RAISE NOTICE 'FAIL V10 layer 목록 밖 통과';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK V10 layer CHECK'; WHEN others THEN RAISE NOTICE 'FAIL V10 다른 오류: %', SQLERRM; END $$;
RESET ROLE;
SET ROLE loader;
DO $$ BEGIN INSERT INTO rd.ga4_dim_property (prop_key, property_id, status, source) VALUES (901, 'p-smoke-1', 'active', 'registry');
  RAISE NOTICE 'FAIL V10 conv_basis NULL 통과';
EXCEPTION WHEN not_null_violation THEN RAISE NOTICE 'OK V10 conv_basis NOT NULL'; WHEN others THEN RAISE NOTICE 'FAIL V10 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN INSERT INTO rd.ga4_dim_property (prop_key, property_id, status, source, conv_basis) VALUES (901, 'p-smoke-1', 'active', 'registry', 3);
  RAISE NOTICE 'FAIL V10 conv_basis 3 통과';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'OK V10 conv_basis 1|2 CHECK'; WHEN others THEN RAISE NOTICE 'FAIL V10 다른 오류: %', SQLERRM; END $$;
DO $$ BEGIN INSERT INTO rd.ga4_dim_property (prop_key, property_id, status, source, conv_basis) VALUES (901, 'p-smoke-1', 'active', 'registry', 2);
  UPDATE ing.sync_cursor SET regions = ARRAY['DE'] WHERE scope_project_id = 'e0000000-0000-0000-0000-000000000002';
  INSERT INTO rd.dim_project (project_key, scope_project_id, surface, is_root, regions) VALUES (901, 'e0000000-0000-0000-0000-000000000002', 1, false, ARRAY['DE']);
  RAISE NOTICE 'OK V10 conv_basis=2·sync_cursor.regions·dim_project.regions 쓰기';
EXCEPTION WHEN others THEN RAISE NOTICE 'FAIL V10 적재 열: %', SQLERRM; END $$;
RESET ROLE;
DO $$ DECLARE n int; d text; BEGIN
  SELECT count(*) INTO n FROM pg_indexes WHERE (schemaname, indexname) IN (
    ('ing','stage_mention_idx'),('ing','stage_occurrence_idx'),('ing','stage_stance_idx'),('ing','stage_citation_idx'),
    ('rd','dim_source_domain_idx'),('app','member_audit_project_idx'),('app','scope_outbox_aggregate_idx'),
    ('app','permission_audit_target_idx'),('app','prompt_candidate_project_idx'),('ext','ctx_drive_requirement_idx'),('rd','job_qa_list_idx'));
  d := pg_get_indexdef('rd.job_qa_list_idx'::regclass);
  IF n = 11 AND d LIKE '%measured_at DESC NULLS LAST, answer_key DESC%' THEN RAISE NOTICE 'OK V10 인덱스 11개, job_qa_list_idx = %', d;
  ELSE RAISE NOTICE 'FAIL V10 인덱스 %/11, %', n, d; END IF;
  IF col_description('rd.cycle'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'rd.cycle'::regclass AND attname = 'status')) LIKE '0 open%'
     AND col_description('rd.answer'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid = 'rd.answer'::regclass AND attname = 'analysis_state')) LIKE '0 분석됨%'
  THEN RAISE NOTICE 'OK V10 rd.cycle.status·rd.answer.analysis_state 코드 주석';
  ELSE RAISE NOTICE 'FAIL V10 코드 주석 없음'; END IF;
  SELECT count(*) INTO n FROM pg_proc p WHERE p.oid IN ('app.tg_catalog_change()'::regprocedure, 'app.tg_project_setting_change()'::regprocedure)
     AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'hmg_owner' AND NOT has_function_privilege('api_ro', p.oid, 'EXECUTE');
  IF n = 2 THEN RAISE NOTICE 'OK V10 트리거 함수 2개 SECURITY DEFINER·소유자 hmg_owner·PUBLIC 실행 회수'; ELSE RAISE NOTICE 'FAIL V10 트리거 함수 규약 %/2', n; END IF;
  IF has_table_privilege('loader', 'app.judgment_change', 'INSERT') AND NOT has_table_privilege('loader', 'app.judgment_change', 'DELETE')
     AND has_column_privilege('loader', 'app.scope_outbox', 'done_at', 'UPDATE') AND NOT has_column_privilege('loader', 'app.scope_outbox', 'payload', 'UPDATE')
     AND has_column_privilege('loader', 'app.prompt', 'scope_prompt_id', 'UPDATE') AND NOT has_column_privilege('loader', 'app.prompt', 'text', 'UPDATE')
     AND has_column_privilege('loader', 'app.project', 'scope_project_id', 'UPDATE') AND NOT has_column_privilege('loader', 'app.project', 'domain', 'UPDATE')
     AND has_function_privilege('loader', 'app.actor()', 'EXECUTE')
     AND NOT has_table_privilege('api_rw', 'app.prompt_audit_log', 'INSERT')
  THEN RAISE NOTICE 'OK V10 loader 큐 INSERT·outbox 열 단위 권한, api_rw 감사 원장 INSERT 회수';
  ELSE RAISE NOTICE 'FAIL V10 권한 표 불일치'; END IF;
  SELECT count(*) INTO n FROM pg_roles WHERE rolname = 'qa_gate' AND NOT rolcanlogin;
  IF n = 1 THEN RAISE NOTICE 'OK V10 qa_gate NOLOGIN'; ELSE RAISE NOTICE 'FAIL V10 qa_gate 롤'; END IF;
END $$;
\echo ===== 끝
