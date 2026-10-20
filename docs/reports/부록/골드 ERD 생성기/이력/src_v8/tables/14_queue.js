/* ── BE 요청 큐 ── */
tbl('app_inputs', { s: 'applist', name: 'app 입력 설정', fam: 'queue', grain: '데이터 분석팀이 판정에 읽는 GEO HUB 설정', cols: [
  ['owned_base · project_owned_base', '', '자사 판정'], ['project_tracked_url · website_report_unit', '', '타겟 URL · 웹 보고 유닛'], ['website_prompt · website_site', '', '웹 카탈로그 · 사이트'], ['citation_category · citation_domain_override', '', '출처 분류'],
  ['brand · brand_display_alias · brand_name_prefix', '', '브랜드 표기'], ['competitor_domain_token · non_competitor_name', '', '경쟁 판정'], ['ecat_{version,entity,surface,surface_def,apply}', '', '엔티티 카탈로그'], ['entity_registry · entity_alias', '', '엔티티 명부 · 별칭'],
  ['prompt · project', '', '카탈로그 · 프로젝트'], ['hidden_market · rhq_region_country', '', '숨김 시장 · 국가 표기'], ['rule_param · rule_set', '', '규칙 값 · 규칙 세트'], ['report_publication · report_site_fact', '', '발행 리포트'] ], d: {
  grain: 'GEO HUB app 스키마 중 현행 적재기(back/ingest)가 판정에 읽는 테이블 묶음입니다.', pk: '—', inputs: 'BE 관리 · 프로젝트 설정 쓰기 (쓰기 경로 없는 표는 규칙 참조)',
  triggers: 'DB 트리거는 app.prompt · app.project 둘. 그 밖은 BE 서비스가 enqueue_change 로 judgment_change 적재',
  uses: '현행 적재기 판정 · 재판정 입력 (골드에서는 데이터 분석팀)', cur: 'app 스키마 (현행 그대로)',
  rules: ['현행 BE 쓰기 경로 없음: owned_base · brand · brand_display_alias · brand_name_prefix · competitor_domain_token · non_competitor_name · hidden_market · rhq_region_country · rule_param · rule_set · website_prompt · website_site · website_report_unit · citation_category · report_publication · report_site_fact · entity_alias.',
    '현행 적재기 쓰기: judgment_change 상태 · scope_prompt 행, project.scope_project_id, prompt.scope_prompt_id, ecat_apply · ecat_review · ecat_audit_log, app.ecat_activate(ecat_version · entity_registry · entity_alias), scope_outbox 처리 표시, access_audit_log 파티션.'] } });
tbl('judgment_change', { s: 'app', name: 'judgment_change', fam: 'queue', grain: '재판정 · 운영 · 수집 요청 1건', cols: [
  ['change_id', 'PK', ''], ['kind', 'FK', '현행 22종 + ctx_research', 'judgment_kind'], ['subject_uuids · subject_texts', '', '요청 대상'], ['payload', '', 'jsonb'], ['requested_by · requested_at', '', ''],
  ['status', '', 'pending · running · applied · failed · escalated_rebuild'], ['claimed_at · applied_at', '', ''], ['applied_build_id', 'FK', '현행 applied_load_id', 'build'], ['error', '', ''] ], d: {
  grain: '재판정 · 운영 · 외부 수집 요청 1건 = 1행.', pk: 'change_id', inputs: 'BE enqueue_change · DB 트리거 2개(app.prompt · app.project) · 적재기(scope_prompt)',
  triggers: '현행 적재기 60초 큐 소비: running → applied · failed · escalated_rebuild (ga4_* 는 대기 유지)',
  uses: '쓰기 API 202 change_id, 대기 상태(프롬프트 상세 · GA4 · 엔티티 반영 · 키워드 수집), /v1/admin/changes(Admin › Keyword tools 수집 대기)', cur: 'app.judgment_change (applied_load_id → applied_build_id)',
  rules: ['payload 필수: cycle_admin · anchor_pin · answer_drop(CHECK), entity_version(apply_id · op CHECK), dfs_fetch(BE 계약).', 'scope_prompt 행은 적재기 수집 감시가 투영 공백을 채울 때만 넣습니다. Scope 쪽 regions · lang · kind 변경은 큐 없이 바로 재판정합니다.'] } });
tbl('judgment_kind', { s: 'key', name: '요청 종류 23', fam: 'queue', grain: 'judgment_change.kind 값', cols: [
  ['카탈로그 · 프롬프트', '', 'catalog · prompt_kind · website_catalog · scope_prompt'], ['엔티티 · 브랜드', '', 'entity · entity_version · brand_rule · competitor_token'], ['출처 · 자사 판정', '', 'citation_override · owned_base · project_owned_base · project_target_url'],
  ['프로젝트 · 노출', '', 'project_setting · hidden_market · rule_param'], ['회차 · 답변 운영', '', 'cycle_admin · anchor_pin · answer_drop'], ['발행', '', 'report_publication'], ['외부 수집 요청', '', 'dfs_fetch · ga4_property · ga4_tracked_event · ctx_research (신규)'] ], d: {
  grain: 'judgment_change.kind 값 23개(현행 22 + 리서치 실행 요청 ctx_research 1)를 7개 묶음으로 나눈 것입니다 (CHECK 제약).', pk: '—', inputs: '—', uses: 'kind 별 처리기 선택 (현행 적재기 _dispatch)', cur: 'app.judgment_change kind CHECK 22종',
  rules: ['DB 트리거 생산: catalog · prompt_kind (app.prompt), project_setting (app.project, BE tracked_targets 도 넣음).', 'BE 생산: entity · entity_version · citation_override · project_owned_base · project_target_url · cycle_admin · anchor_pin · answer_drop · dfs_fetch · ga4_property · ga4_tracked_event.',
    '적재기 생산: scope_prompt (1회 보정 스크립트 fix-sync-s1-rules.sql 도 넣음).', 'BE · 적재기 런타임 생산자 없음: website_catalog · brand_rule · competitor_token · owned_base · hidden_market · rule_param · report_publication. owned_base · hidden_market 은 1회 보정 스크립트(fix-sync-s1-rules.sql)만 넣고, report_publication 발행 행은 시드로만 들어옵니다.', '현행 적재기가 처리하지 않음: ga4_property · ga4_tracked_event (대기 유지).', 'ctx_research 는 골드 신규 요청입니다 (리서치 실행, BE 쓰기).'] } });
