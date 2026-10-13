# B. 앤서(前 벤더) HUB 코드·설계가 정한 레거시 → HMG-GEO-HUB 이관 매핑 (읽기 전용 조사, 2026-10-07)

조사 대상 리포: `C:\Users\tae_h\OneDrive\바탕 화면\HMG-GEO_scope-analysis_20260922\hmg-geo-hub-share` (README:3 "2026-10-02 기준 외부 검토용 스냅샷"). 아래 경로는 리포 루트 기준. 줄 번호는 이 스냅샷 기준.

## 0. 이관 파이프라인 한눈에

| 단계 | 도구 | 하는 일 | 근거 |
| --- | --- | --- | --- |
| 추출 | `back/migration/export.py` | 운영 Supabase 미러를 읽기 전용 COPY 로 `snap/<table>/*.csv.gz` 추출. BIG 6 + SMALL 51 = **57 표**. `--frz` 는 summary 활성 세대만 15개 질의로 추출 | export.py:24-37 (BIG/SMALL), :49-135 (FRZ 질의) |
| 스테이지 DDL | `back/migration/mig_src.sql`, `mig_src_frz.sql` | 새 DB 에 `mig_src.*` (원천 pg_dump 를 스키마명만 바꾼 57 표) + `mig_src.frz_ops_*` 15 표 | mig_src.sql:1-1082 (CREATE TABLE 57건), mig_src_frz.sql:7-85 |
| S9 적재 | `back/migration/s9-load.tpl.sh` (= `infra/ops/s9-load.tpl.sh`) | RDS `hmg` DB 에 rds-prelude·DB-v2.1·mig_src(.frz) 적용 뒤 S3 `snap/` 을 `\copy mig_src.<t>` 로 적재 | s9-load.tpl.sh:14, :24-31, :33-38 |
| app 시드 | `back/migration/seed/seed-10-app.sql` (생성기 gen_seed10.py) | `mig_src → app.*` 1:1 이관 25 표 + 현행 TS 상수 → 판정 규칙 표 | seed-10-app.sql:1024-1228 |
| ing 시드 | `seed/seed-20-ing.sql` | `mig_src → ing.*` (Scope 원본·운영자 레지스트리·회차 원장) | seed-20-ing.sql:30-490 |
| rd 투영 | `seed/seed-30-dims.sql`, `seed-40-facts.sql` | `ing → rd` 재계산(mig_src 를 읽지 않음) | BUILDER-B-REPORT.md:1-27 |
| 동결 층 | `python -m ingest.cli frz-import-ops` (`back/ingest/frz/ops_import.py`) | `mig_src.frz_ops_* → frz.*` (결정 32) | ingest/cli.py:12-15, ops_import.py:1-28 |
| 엔티티 버전 | `back/migration/ecat-v1-cutover.sql` | `app.entity_registry ∪ app.entity_alias → app.ecat_version v1` (작성만, 승인 배치) | ecat-v1-cutover.sql:1-12 |
| 1회 보정·채움 | `fill-v219/v226/v230/attrib-member-seat.sql`, `fix-core10-account-scope.sql` | 이미 적재된 stg 에 mig_src 를 다시 읽어 보충 | 각 파일 머리말 |
| 대조 원장 | `mig.*` (DB-v2.32.sql:746-788) | run 지문·앵커 오라클·parity·known_diff·screen_group·archive_manifest | 모듈-적재-파이프라인.md:114-120 |

설계 원칙: D4 "이관 범위 전체"(DESIGN-CONTRACT.md:6), G-10 "미러 COPY 시드 + 새 로더는 Scope API 직접 pull"(DECISIONS.md:173-187), G-09 "summary_cycles·summary_cycle_runs 는 ing.cycle·cycle_run 으로 이관하고 표는 폐기"(DECISIONS.md:157-169), G-13/Q14 "crawl_*·webgeo_* S3 보관(mig.archive_manifest), 컨텍스트 맵은 ext 정적 스냅샷"(DECISIONS.md:226-240, DECISIONS-API.md:20, DB-v2.32.sql:910-912).

## 1. 매핑표 (레거시 표 → HUB 목적지 → 도구 → 비고)

범례: **app/ing/rd/frz/ext** = 새 DB 스키마. "스테이지만" = export.py 가 mig_src 에 올리지만 어떤 시드·채움 스크립트도 읽지 않음. "미접촉" = export.py 목록에도 없고 리포 안 어떤 도구도 읽지 않음.

### 1-1. 앱 설정·카탈로그 (mig_src → app, seed-10)

| 레거시 표 | HUB 목적지 | 도구 (file:line) | 비고 |
| --- | --- | --- | --- |
| projects | app.project | export.py:32; seed-10-app.sql:1027-1035 | kind standard_root/customer 판정, brand→brand_code |
| prompts | app.prompt | seed-10-app.sql:1045-1057 | 소속 프로젝트 없는 행 제외(verify-seed.sql:21-22). `enabled` 는 별도 2단계: Scope 운영 DB `prompts.enabled` 를 prompt-enabled-core-export.sql:1-15 → fill-prompt-enabled.sql 로 채움(작성만) |
| prompt_candidates | app.prompt_candidate | seed-10-app.sql:1040-1043 | |
| project_custom_fields | app.project_custom_field | seed-10-app.sql:1059-1062 | |
| prompt_custom_field_values | app.prompt_custom_field_value | seed-10-app.sql:1063-1067 | |
| project_engine_history | app.project_engine_history | seed-10-app.sql:1069-1073 | history_id IDENTITY 재발급 |
| project_owned_bases | app.project_owned_base | seed-10-app.sql:1075-1083 | base_norm = ownedBasePrefixFromUrl 쌍둥이 |
| project_tracked_urls | app.project_tracked_url | seed-10-app.sql:1085-1092 | url_norm 정규화, 충돌은 첫 행 |
| tracked_brands | app.project_tracked_brand | seed-10-app.sql:1094-1098 | |
| tracked_competitors | app.project_tracked_competitor | seed-10-app.sql:1099-1121 | 4-8b 별칭 병합(U9-5), 보정 fix-u95-competitor-aliases.sql |
| tracked_vehicles | app.project_tracked_vehicle | seed-10-app.sql:1122-1125 | |
| tracked_keywords | app.project_tracked_keyword | seed-10-app.sql:1126-1129 | term_norm 생성열(DB-v2.6 P44) |
| website_sites | app.website_site | seed-10-app.sql:1131-1141 | scope_project_id text→uuid, UNIQUE 충돌 사이트는 NULL(verify-seed.sql:44-46) |
| website_prompts | app.website_prompt | seed-10-app.sql:1142-1146 | |
| standard_keywords | app.standard_keyword | seed-10-app.sql:1149-1151 | |
| standard_sources | app.standard_source | seed-10-app.sql:1152-1154 | |
| **standard_prompts** | **대상 표 없음** (카탈로그 정본 = 표준 루트 프로젝트의 app.prompt) | export.py:35 (스테이지); seed-10-app.sql:1148; verify-seed.sql:49 | 스테이지만, 버림 |
| ga4_properties | app.ga4_property + app.ga4_market_pending(property_id NULL 행) | seed-10-app.sql:1156-1167; DB-v2.32.sql:2091, 2154-2180 (P60·P61) | verified_at 계승 |
| ga4_tracked_events | app.ga4_tracked_event | seed-10-app.sql:1169-1171 | |
| report_publications | app.report_publication | seed-10-app.sql:1173-1180; DB-v2.32.sql:190 "현행 0080 … 1:1" | |
| report_site_facts | app.report_site_fact | seed-10-app.sql:1181-1187 | |
| report_site_engine_facts | app.report_site_engine_fact | seed-10-app.sql:1188-1189 | → rd.report_unit_value 는 seed-40 §10 재계산(아래 §3-4) |
| citation_domain_overrides | app.citation_domain_override | seed-10-app.sql:1191-1198 | 도메인 소문자·www 제거, 카테고리 이름→category_key |
| entity_registry | app.entity_registry → (cutover 뒤) app.ecat_version v1 투영 | seed-10-app.sql:1199-1220; ecat-v1-cutover.sql:1-12; DB-v2.32.sql:3900-3909, 4295 | own→own, excluded→hidden; cutover 뒤 기존 표 직접 쓰기 거부(ECAT_LEGACY_WRITE) |
| prompt_audit_logs | app.prompt_audit_log (append-only) | seed-10-app.sql:1222-1225; DB-v2.32.sql:221-231 | actor_id 원값 보존(FK 없음) |
| member_audit_logs | app.member_audit_log (append-only) | seed-10-app.sql:1226-1228 | |
| **project_members** | **app.project_member 미이관** | export.py:32 (스테이지); verify-seed.sql:61-62 | 사유: user_id·invited_by 가 app.user_account FK 인데 profiles 미이관(시스템 사용자 1행만). 계정 별도 이관 뒤 재시도 여부 미기재 |
| **profiles** | app.user_account (리포 밖 스크립트) | export.py 목록 **없음**; DECISIONS.md:557, DECISIONS-API.md:270 "이관 스크립트(인프라 스크래치 acct/load-accounts.tpl.sh `_acct`)"; fix-core10-account-scope.sql:5, :37-38, :49 (`mig_src.profiles` 존재 전제) | seed-10-app.sql:25-27 "profiles 는 이관 대상이 아니다 … 추후 profiles 이관 시 연결". 즉 **계정 이관은 리포 밖 별도 스크립트**가 mig_src.profiles 를 올려 수행(stg 에는 이미 적재됨: DECISIONS-API.md:270 "stg 2026-09-30 실측") |

### 1-2. Scope 미러 원본 (mig_src → ing, seed-20; ing → rd 는 seed-30/40 재계산)

| 레거시 표 | HUB 목적지 | 도구 (file:line) | 비고 |
| --- | --- | --- | --- |
| scope_runs | ing.run (+ ing.load.scope_ref.w0_synced_at = max(synced_at)) | export.py:26; seed-20-ing.sql:38-44, 82-96, 114-122 | run_month = started_at KST 월 파티션 |
| scope_prompts | ing.prompt | seed-20-ing.sql:98-112 | scope_project_id 복원 불가 행 제외; ACR 롤업 있으면 kind='acr' |
| scope_answers | ing.answer (+ 예외 ing.answer_mirror_time) | seed-20-ing.sql:135-185 (키 발급·원본), :317-326 (7-1'); fill-v219.sql:1-10 | measured_at 은 앵커로 접힌 값이라 **원복**(scope_answer_cycle_anchors.measured_at_orig → scope_answer_anchors.source_measured_at → 미러 값); 접힌 미러 값은 rd.rep_order_at 로 재현 안 되는 행만 answer_mirror_time 에 보관(stg 166행) |
| scope_mentions | ing.mention | seed-20-ing.sql:215-226 | 2번째 사본 `mig_src.scope_mentions_0930` 도 존재(fill-v226.sql:6, :43-47) → ing.entity_brand_name 보충 |
| scope_mention_occurrences | ing.mention_occurrence | seed-20-ing.sql:231-237 | |
| scope_answer_stances | ing.answer_stance | seed-20-ing.sql:242-247 | |
| scope_citations | ing.citation | seed-20-ing.sql:252-258 | host·domain_label 재계산(PSL 근사, ingest.md R6) |
| scope_acr_rollups | ing.acr_prompt_run + ing.acr_rollup_row | seed-20-ing.sql:164-166, 270-300 | prompt_run_id 가 미러에 없어 셀 좌표로 복원 |
| scope_answer_anchors | ing.answer_anchor_pin (origin 'mirror_seed') | seed-20-ing.sql:310-314 | 운영자 원장: job 이 미러에 없어도 전량 보존 |
| scope_answer_drops | ing.answer_drop (origin 'mirror_seed') | seed-20-ing.sql:315-316 | |
| scope_answer_cycle_anchors | **표로는 미이관, 재계산** (측정 시각 원복 입력 + 선택적 좌석 입력 + parity 오라클) | seed-20-ing.sql:149 (measured_at_orig), :346-347 (`-v attrib_member=1` 좌석); fill-attrib-member-seat.sql:1-13; DB-v2.32.sql:773 (mig.row_oracle_diff oracle 'scope_answer_cycle_anchors'); 모듈-적재-파이프라인.md:117 "앵커 오라클 100% 일치 확인 뒤 현행 앵커 표 폐기" | 좌석·앵커는 ingest.cycles.ledger 가 재산출(hmg_assign_cycle_rounds 이식) |
| scope_cycle_rounds | ing.cycle_round (좌석 배정 원장) | seed-20-ing.sql:328-331 | 'standard'→'global' |
| scope_sync_cursors | ing.sync_cursor | seed-20-ing.sql:455-466 | 미러 커서 ∪ 앱 등록 ∪ run 소속 |
| **scope_mirror_progress** | **스테이지만** (대체 = ing.load·ing.stage_*) | export.py:28 | 어떤 시드도 읽지 않음 |
| **scope_cycle_anchor_state** | **스테이지만** (대체 = ing.cycle 상태·cycles_tick) | export.py:27 | 읽는 곳 없음 |
| **scope_cycle_registry_runs** | **스테이지만** (대체 = ing.cycle_run) | export.py:27 | 읽는 곳 없음 |
| **scope_sync_watermarks** | **미접촉** | (export.py 목록 없음) | 현행 0082 신규 표. HUB 는 ing.sync_cursor.prompts_updated_to·R12 워터마크로 대체 |

### 1-3. 회차 원장·summary 집계층

| 레거시 표 | HUB 목적지 | 도구 (file:line) | 비고 |
| --- | --- | --- | --- |
| summary_cycles | ing.cycle (origin='summary_cycles', cycle_id 보존) + ing.cycle_ops_gap(analysis_gap_ratio·status, 이관 때 status≠open) + run 프로젝트 귀속 입력 | seed-20-ing.sql:84, :333-355, :362-372; fill-v230.sql:1-5, :21-28; DB-v2.32.sql:342 (origin CHECK), :7341-7342 (P148); DECISIONS.md:157-169 (G-09) | 'generating'→'closed'; completed_answers·gap_answers 는 시드 답변으로 재계산(7-6); expected/completed_units 는 원장값 보존 |
| summary_cycle_runs | ing.cycle_run | seed-20-ing.sql:84, :357-359 | |
| summary_generations | frz.generation(source='ops', ops_* 열) + frz.ops_judgment | export.py:51-53 (frz_ops_generation); ops_import.py:72-77; DB-v2.32.sql:5155-5172, 5198-5200 | **활성 세대만** (active_generation_id) |
| summary_cycle_jobs | frz.cell | export.py:54-56 (frz_ops_cell); ops_import.py:4, :96 | 활성 세대 셀 집합만(stg 실측 472,083 셀, mig_src_frz.sql:5) |
| summary_prompt_dim | frz.prompt (+ frz.prompt_axis P128) | export.py:57-61 (frz_ops_prompt); ops_import.py:6, :129; DB-v2.32.sql:5185-5196, 5981 | 활성 세대만 |
| summary_answers | frz_ops_changed·frz_ops_answer·frz_ops_web → frz.kept/keep_* (생성 뒤 바뀐 답변만) + frz.cell_web(웹 유닛 플래그) | export.py:62-84, :109-114; ops_import.py:8-11, :146, :187-189; DB-v2.32.sql:6052-6067 (P127) | 세부층 **전체 복사 금지**(결정 32); 바뀐 답변 후보 1,066 (export.py:42) |
| summary_brand_mentions | frz_ops_brand → frz.keep_answer_brand (바뀐 답변만) + frz.brand_name(P129, 생성 시점 표시명) | export.py:85-89; ops_import.py:202-217; DB-v2.32.sql:5984, 6135-6142; fill-v226.sql:7-8 (frz_ops_sum_brand.brand_name 으로 이름 보충) | |
| summary_url_hits | frz_ops_web.url_* → frz.cell_web | export.py:107-114; DB-v2.32.sql:6067 | |
| summary_url_hit_generations | frz_ops_url_cov → frz.generation.verify 플래그(커버리지) | export.py:131-133; ops_import.py:567 | 웹 활성 세대 902 중 94 만 url_hits 있음 |
| summary_trend_answers | frz_ops_sum_cycle(회차 합) = **단언 기준값만** | export.py:90-98; ops_import.py:329 | 표 자체 미이관, 축 합 대조용 |
| summary_trend_domains | frz_ops_sum_cycle.domain_citations = 단언 기준값만 | export.py:95-96 | 동상 |
| summary_trend_brands | frz_ops_sum_brand / _x = 단언 기준값만 | export.py:99-102, :117-121; ops_import.py:342, :395 | 동상 |
| summary_trend_own | frz_ops_sum_own / _x / sum_comp = 단언 기준값만 | export.py:103-106, :122-130; ops_import.py:362, :412, :464 | 동상 |
| summary_settings | **스테이지만**; 값 2개만 코드·채움으로 이식: website_excluded_fs [71,94,97] → app.website_report_excluded(fill-v216), period_compare_epoch → 코드 상수 | export.py:30; gen_fill_v216.py:4, :15; fill-v216.sql:3; DB-v2.32.sql:3713, 3757 (P92); back/app/features/analytics/kpi/compare/logic.py:12 | 표 자체는 읽지 않음(하드코딩) |
| **summary_domain_citations** | **미접촉** | (export.py 목록·frz 질의 모두 없음) | 인용 도메인 집계는 rd.citation 에서 조회 시 계산(D8) |
| **summary_target_hits** | **미접촉** | 동상 | 타겟 인용률은 rd.answer tgt_cited·frz.cell_web 로 대체 |
| **summary_ga4** | **미접촉** | 동상 | GA4 는 rd.ga4_row 새 적재(§3-8) |

### 1-4. QA·감사·계정·기타

| 레거시 표 | HUB 목적지 | 도구 (file:line) | 비고 |
| --- | --- | --- | --- |
| qa_answer_reviews | app.qa_answer_review **미이관** | export.py:37 (스테이지); verify-seed.sql:63 "이관 범위 밖(지시 목록 외)" | 설계(모듈-검수-콘솔.json:214)는 section_flags→flag_* 6열 이관을 적었으나 구현 없음 |
| qa_review_notes | app.qa_review_note **미이관** | export.py:37; verify-seed.sql:64 | 동상 |
| qa_answer_locks | **스테이지만** | export.py:37 | 설계: "이관 시점에 살아 있는 락은 버림"(모듈-검수-콘솔.json:214) |
| **qa_review_sessions** | **미접촉** | (export.py 목록 없음) | app.qa_review_session 표는 존재(DB-v2.32.sql:236) |
| **bff_audit_logs** | **미접촉** (대응 표 = 신설 app.access_audit_log, 데이터 이관 없음) | AD-5-계정-권한.json:16 "auditDataAccess → bff_audit_logs, v2 app.access_audit_log 대응"; DB-v2.32.sql:217; DECISIONS-API.md Q4 | 접근 감사는 민감 조회만 비동기 기록 |
| keyword_cache | **스테이지만** (폐기) | export.py:37; 모듈-고객-관심.md:130 "현행 캐시(keyword_cache)는 폐기 대상" | rd.kw_*·ext.dfs_call 은 신규 dfs_fetch 로 채움 |
| keyword_volume_cache | **스테이지만** | export.py:37; keyword_tools/service.py:5 (TTL 7일 규칙만 참조) | BUILDER-B-REPORT.md:27 "미투영: rd.ga4_*·rd.kw_*(ing 원천 없음)" |
| scope_context_entities / _drives / _combinations / _evidence / _domains / _prompt_cache (6) | 설계: ext.ctx_snapshot·ctx_entity·ctx_drive·ctx_combination·ctx_evidence·ctx_domain 정적 스냅샷(G-13); **적재 도구 없음 = 스테이지만** | export.py:28-29; DB-v2.32.sql:724-740; 모듈-고객-관심.md:12, :77, :85; ext.ctx_* INSERT 는 테스트 픽스처뿐(back/app/features/intent/keywords/research/tests/intent_fixtures.py:219-225) | "활성 스냅샷이 없으면 준비 중"(모듈-고객-관심.md:77). scope_context_prompt_cache 의 대응 app.ctx_generated_prompt 는 seed-10:299 가 TRUNCATE 만 하고 채우지 않음 |
| **ai_responses** | **미접촉** | (front 0008 레거시 표, back/docs 언급 0) | |
| **brand_mentions** | **미접촉** | (front 0008 레거시 표; docs 의 `brand_mentions` 는 AD-2 응답 필드명) | |
| **citation_analysis** | **미접촉** | 동상 | |
| **youtube_video_metadata** | **미접촉** | 동상 | |
| crawl_pages / crawl_links (목록 밖) | S3 보관 + mig.archive_manifest(kind s3_table), 새 DB 없음 | DECISIONS.md:226-240 (G-13); DECISIONS-API.md:20 (Q14); DB-v2.32.sql:741, :910-912 | 03-db-live-catalog.md:41-45 (6 GB). **manifest 를 채우는 도구 없음** |
| webgeo_pages / webgeo_page_seo / webgeo_sites / webgeo_raw_html_objects (목록 밖) | G-13 "ext 정적" → Q14 로 **S3 보관으로 변경**, 새 DB·API 없음 | DB-v2.32.sql:910-912; 전체-통합.md:32 "webgeo 소비자 0건, 제거 권고", :163 (S11 WG-1 표 S3 보관) | ext.webgeo_* DDL 없음 |
| _bak_anchor_fold (목록 밖, 백업 표) | archive.bak_anchor_fold (원천 pg_dump 정의 그대로 생성 후 COPY, 삭제 금지) | DB-v2.32.sql:789 (주석뿐); 03-db-live-catalog.md:254 | 실제 생성·COPY 스크립트 없음 |
| messages (목록 밖, 파티션 0) | 언급 없음 | 03-db-live-catalog.md:124 | |

## 2. HUB 리포 도구가 전혀 건드리지 않는 레거시 표 (79개 대비)

### 2-1. 완전 미접촉 (export.py 목록에도 없고, 어떤 시드·채움·DDL 주석도 읽지 않음): 10개
`ai_responses`, `bff_audit_logs`, `brand_mentions`, `citation_analysis`, `qa_review_sessions`, `scope_sync_watermarks`, `summary_domain_citations`, `summary_ga4`, `summary_target_hits`, `youtube_video_metadata`

### 2-2. 리포 도구 밖에서만 다룸: 1개
`profiles` : export.py 에 없음. `mig_src.profiles` 는 리포에 없는 `acct/load-accounts.tpl.sh`(인프라 스크래치) 가 올리고 app.user_account 로 이관(DECISIONS.md:557, DECISIONS-API.md:270). 리포 안에는 그 결과를 보정하는 `fix-core10-account-scope.sql` 만 있다(:37-38 에서 mig_src.profiles 존재를 전제).

### 2-3. mig_src 에 스테이지만 하고 어떤 HUB 표로도 옮기지 않음 (export.py 에는 있음): 15개
`keyword_cache`, `keyword_volume_cache`, `project_members`(미이관 사유: profiles FK), `qa_answer_locks`, `qa_answer_reviews`, `qa_review_notes`, `scope_context_combinations`, `scope_context_domains`, `scope_context_drives`, `scope_context_entities`, `scope_context_evidence`, `scope_context_prompt_cache`, `scope_cycle_anchor_state`, `scope_cycle_registry_runs`, `scope_mirror_progress`
(+ `standard_prompts` : 대상 표 없음으로 명시 버림, `summary_settings` : 값 2개만 하드코딩, `scope_answer_cycle_anchors` : 표 미이관·입력으로만 사용, `summary_trend_*` 4개 : 합계만 단언용)

### 2-4. 요약 수치
79개 중 app/ing/frz 어딘가에 **행 단위로 실제 들어가는 표 = 41개** (app 25 - standard_prompts - project_members = 23, ing 12: scope_runs·prompts·answers·mentions·mention_occurrences·answer_stances·citations·acr_rollups·answer_anchors·answer_drops·cycle_rounds·sync_cursors + summary_cycles·summary_cycle_runs = 14, frz 로 부분 이관 4: summary_generations·cycle_jobs·prompt_dim·answers(+brand_mentions·url_hits·url_hit_generations 부분) ). 나머지는 재계산·단언용·스테이지만·미접촉.

## 3. 특수 그룹 8종의 처리

| # | 그룹 | HUB 처리 | 근거 |
| --- | --- | --- | --- |
| 1 | **사용자 계정** | 인증 = Supabase Auth 유지 + FastAPI 가 JWT(JWKS) 검증(A8). 계정 표 = `app.user_account`(신규 CHECK 다수: ua_scope_nonempty·ua_region_scope·ua_country_scope, 현행 profiles 에는 없음). 데이터 = **profiles → app.user_account 는 리포 밖 `load-accounts.tpl.sh`** 가 수행(R2 권역 전개 규칙·R3 정본 표기); seed-10 은 profiles 를 이관하지 않고 시스템 사용자 1행(5eed…0001, suspended)만 만들어 FK 자리에 쓴다. stg 보정 = fix-core10-account-scope.sql(결정 3·4). is_qa_reviewer 는 신규 열 | DESIGN-CONTRACT.md:10; DB-v2.32.sql:101-111; seed-10-app.sql:25-32; DECISIONS.md:552, :557; DECISIONS-API.md:269-270; AD-5-계정-권한.json:86, :96, :109 |
| 2 | **QA 표** | 표는 app 스키마에 있음(app.qa_review_session·qa_answer_review·qa_review_note·qa_answer_lock, 전용 롤 qa_gate). 인증 = 계정 없는 별도 HMAC 게이트(Q17). **데이터 이관은 없음**: verify-seed 가 qa_answer_reviews·qa_review_notes 를 "미이관(지시 목록 외)"로 기록, qa_answer_locks 스테이지만, qa_review_sessions 미추출. 단위 설계는 이관을 전제했음(section_flags→flag_* 6열, reviewer_id NULL) → **설계와 구현 불일치** | DB-v2.32.sql:236-256, 1236; DECISIONS-API.md Q17; DECISIONS.md:323 (G-18 "QA = Supabase 계정 + is_qa_reviewer"); verify-seed.sql:63-64; 모듈-검수-콘솔.json:214 |
| 3 | **감사 로그** | prompt_audit_logs → app.prompt_audit_log, member_audit_logs → app.member_audit_log(둘 다 append-only, 원본 그대로, actor_id 원값 보존). bff_audit_logs 는 이관하지 않고 신설 app.access_audit_log(민감 조회만 비동기, Q4) 가 역할을 대체. app.permission_audit_log 신설(계정 변경 트리거) | seed-10-app.sql:1222-1228; DB-v2.32.sql:217-231, 842; AD-5-계정-권한.json:16; DECISIONS-API.md:10 (Q4) |
| 4 | **리포트 발행값** | report_publications·report_site_facts·report_site_engine_facts → app.report_* 1:1(FK 없음 유지). `rd.report_unit_value` 는 **report_* 에서 직접 복사하지 않고 seed-40 §10 이 활성 발행(app.report_publication status 'active') × 유닛 사실로 재계산**; 이후 쓰기 주체 = 적재기(judgment_change 'report_publication', supersede 된 pub_id 행 삭제). G-22: 발행 회차는 모든 모드에서 대체 | seed-10-app.sql:1173-1189; DB-v2.32.sql:190, :708-712; seed-40-facts.sql:895-913; 모듈-적재-파이프라인.md:73; DECISIONS.md:387-402 |
| 5 | **회차 원장** | summary_cycles → ing.cycle(origin 'summary_cycles', cycle_id·expected/completed_units·fleet_visible·hidden_* 보존, generating→closed, published_at NULL) ; summary_cycle_runs → ing.cycle_run ; scope_cycle_rounds → ing.cycle_round(좌석 원장, 재계산 안 함) ; summary_cycles.analysis_gap_ratio/status → ing.cycle_ops_gap(P148: 창 판정은 현행 갭 원값 사용). completed_answers·gap_answers 는 시드 답변으로 다시 셈(7-6). rd.cycle 은 ing.cycle 투영. scope_cycle_anchor_state·scope_cycle_registry_runs 는 스테이지만(허브 cycles_tick 이 대체). 원장에 없는 run 은 파생(derived) 회차 신설(7-4) | seed-20-ing.sql:328-372, :374-453; DB-v2.32.sql:342, :7341-7372; fill-v230.sql; DECISIONS.md:157-169 (G-09) |
| 6 | **앵커·드롭** | scope_answer_anchors → ing.answer_anchor_pin(origin 'mirror_seed', reason 없으면 합성 문구) ; scope_answer_drops → ing.answer_drop. scope_answer_cycle_anchors 는 표로 옮기지 않고 (a) measured_at_orig 로 **측정 시각 원복**, (b) 선택 스위치 attrib_member=1 때 원장 회차 좌석 입력, (c) mig.row_oracle_diff 앵커 오라클 → 100% 일치 뒤 폐기 방침. 접힌 미러 measured_at 는 ing.answer_mirror_time 예외 표(P107)에만 보관 | seed-20-ing.sql:135-150, :310-326, :346-347; fill-attrib-member-seat.sql:1-13; fill-v219.sql:1-10; DB-v2.32.sql:773, :4777, :4789; 모듈-적재-파이프라인.md:117 |
| 7 | **키워드 캐시** | keyword_cache·keyword_volume_cache 는 mig_src 에 올리기만 하고 **어디에도 투영 안 함**("폐기 대상", "rd.kw_* 미투영: ing 원천 없음"). 앞으로는 운영자 dfs_fetch(judgment_change) → ext.dfs_call + rd.kw_volume/kw_serp/kw_suggestion 을 적재기가 채움(Q13). TTL 7일 규칙만 코드로 계승 | export.py:37; BUILDER-B-REPORT.md:27; 모듈-고객-관심.md:130; DB-v2.32.sql:699-706, :717-723, :925; DECISIONS-API.md:19 (Q13); keyword_tools/service.py:5 |
| 8 | **GA4** | 설정만 이관: ga4_properties → app.ga4_property(+ property_id NULL 행은 app.ga4_market_pending), ga4_tracked_events → app.ga4_tracked_event. 데이터(summary_ga4)는 미접촉. rd.ga4_row·rd.ga4_dim_property 는 "GA4 적재자(IG-4)" 가 새로 채우되 **소유 미정**이라 워커가 큐 kind ga4_property·ga4_tracked_event 를 집지 않음; stg 는 GA4 없이 진행 결정 | seed-10-app.sql:1156-1171; DB-v2.32.sql:2154-2180, :1194; ingest.md:96-98 (R12); DECISIONS-API.md:272 (결정 6(b)); DECISIONS.md:208-222 (G-12) |
| 9 | **컨텍스트 코퍼스** | 설계 = scope_context_* → ext.ctx_snapshot(활성 1개)·ctx_entity·ctx_drive·ctx_combination·ctx_evidence·ctx_domain 정적 스냅샷(G-13 "컨텍스트 맵 스냅샷"). **적재 스크립트가 리포에 없음**: 6표는 mig_src 스테이지만, ext.ctx_* 를 채우는 코드는 테스트 픽스처뿐. 활성 스냅샷 없으면 API 가 "준비 중". scope_context_prompt_cache → app.ctx_generated_prompt 도 TRUNCATE 만 | export.py:28-29; DB-v2.32.sql:724-740; 모듈-고객-관심.md:12, :77, :85, :139; intent_fixtures.py:219-225; seed-10-app.sql:299 |
| 10 | **엔티티 레지스트리(ecat)** | entity_registry → app.entity_registry(own 행 brand_code = resolveHmgBrandName 쌍둥이, seed-10 4-14) + app.entity_alias(코드 상수 HMG_BRAND_ALIAS_ENTITY_IDS, 3-5) → ecat-v1-cutover.sql 이 둘을 app.ecat_version v1(origin cutover) 로 1회 이관(own→own, excluded→hidden, alias→merge_into); 활성화 뒤 기존 두 표는 활성 버전의 투영이 되고 직접 쓰기 거부(ecat_legacy_guard). rd.dim_entity.registry_role 은 투영. **cutover 는 작성만, 승인 배치 대기** | seed-10-app.sql:627-636, :1199-1220; ecat-v1-cutover.sql:1-12; DB-v2.32.sql:3900-3909, :4257-4267, :4295, :4372-4385 |
| 11 | **레거시 PostgreSQL 함수** | 현행 front 마이그레이션의 public 함수 29개(아래 목록; 03-db-live-catalog.md:141 "public 함수 30개, 트리거 0"). **mig.archive_manifest(kind table/function/cron/runner/s3_table) 는 DDL 에 정의만 있고 채우는 도구·행이 리포에 없음**(DB-v2.32.sql:786-788; 그 밖 언급은 Q14 주석뿐). 함수는 아카이브가 아니라 **필요한 것만 Python/SQL 로 이식**: hmg_assign_cycle_rounds → ingest/cycles/ledger/queries.py:6(좌석 R02); hmg_round_canonical_dow·hmg_round_prev_canonical → ingest/cycles/ledger/service.py:32, :43; hmg_anchor_view_date → ledger/queries.py:150(R08·노출일); refresh_answer_cycle_anchors → ingest/project/apply/queries.py:95, core/profile.py:202(attrib_member 프로필); hmg_anchor_date·hmg_round_date_of·hmg_cycle_key → seed-20-ing.sql:333-355(ing.cycle 좌석·anchor_date KST); hmg_anchor_default_engines → app.rule_param default_engines(seed-10 3-8); scope_anchor_fold → rd.rep_order_at(DB-v2.32.sql:4789) + ing.answer_mirror_time; scope_answer_drop_apply → ing.answer_drop + rd.job.dropped; citation_url_norm/host/base_norm → pg_temp.cit_norm·cit_base_norm(seed-3x-common.sql §1), rd.report_url_norm(DB-v2.32.sql:3765), ingest/pull/sync/stage.py:33, core/urls.py:6; summary_report_norm → rd.report_url_norm(DB-v2.32.sql:3773). **이식·언급이 전혀 없는 함수 14개**: hmg_anchor_is_pinned, hmg_anchor_keep_existing, hmg_anchor_month, hmg_anchor_timezone, hmg_anchor_today, hmg_anchor_utc_midnight, hmg_anchor_week, hmg_propagate_cycle_rounds, hmg_prune_cycle_registry_runs, hmg_refresh_cycle_registry_runs, hmg_round_next_canonical, hmg_sync_cycle_anchor_state, summary_ensure_cycle_gen_stats, summary_ensure_week_partitions (대부분 미러 동기화·레지스트리·파티션 유틸이라 HUB 적재기 구조에서 불필요한 것으로 보이나 명시 결정 없음). 크론(Vercel cron sync-mirror·cycle-chain-watch)은 폐기하고 워커 루프·watch 태스크로 대체(모듈-적재-파이프라인.md:28-33) | 위 각 file:line |

레거시 함수 29개 원천 목록(front/lib/db/migrations/*.sql CREATE FUNCTION): citation_url_base_norm, citation_url_host, citation_url_norm, hmg_anchor_date, hmg_anchor_default_engines, hmg_anchor_is_pinned, hmg_anchor_keep_existing, hmg_anchor_month, hmg_anchor_timezone, hmg_anchor_today, hmg_anchor_utc_midnight, hmg_anchor_view_date, hmg_anchor_week, hmg_assign_cycle_rounds, hmg_cycle_key, hmg_propagate_cycle_rounds, hmg_prune_cycle_registry_runs, hmg_refresh_cycle_registry_runs, hmg_round_canonical_dow, hmg_round_date_of, hmg_round_next_canonical, hmg_round_prev_canonical, hmg_sync_cycle_anchor_state, refresh_answer_cycle_anchors, scope_anchor_fold, scope_answer_drop_apply, summary_ensure_cycle_gen_stats, summary_ensure_week_partitions, summary_report_norm.

## 4. 일정·단계(Phase)·stg 적재 상태에 관한 문서 진술

| 항목 | 진술 | 근거 |
| --- | --- | --- |
| 단계표 | S0 DB-v2.1 보완 → S1 core/auth → **S2 ingest + 이관 시드 + app 단방향 동기화(전제: Scope 이중 pull 수용)** → S3 RDS 실측 게이트 → S4~S8 화면 그룹 G1~G5 순차 전환 → **S9 G6 프로젝트·고객 관심(outbox E2E, 쓰기 동결 원자 전환)** → **S10 G7 운영(판정 입력 쓰기 정본 이관, 동기화 종료)** → **S11 종료(AU-1 확인, decommission, WG-1 표 S3 보관)**. 달력 날짜 없음 | 전체-통합.md:150-165 |
| 전환 게이트 | 그룹 순차, **연속 2회차 무결점**(하네스 불일치 0 또는 known_diff 등록), R12 재수집 먼저; mig.screen_group.gate_cycles_required 기본 2, state old→shadow→candidate→switched→decommissioned | DECISIONS.md:334-348 (G-19); DB-v2.32.sql:775-783 |
| 병행 운영 | A13 병행 운영·화면 그룹 순차 전환; Q15: Scope 이중 pull 수용, 구 시스템→새 app 표 **단방향 동기화 잡 = ingest 소유**, 화면 그룹 전환 시 해당 표 동결·원자 전환. **구현 상태: 미구현(R8 보류, 메인 결정 2026-09-28 "병행 운영 전환 단계", stg 배포는 막지 않음)**; 원천 어댑터(구 DB 스냅샷 vs mig_src, export.py·seed-10 재사용 여부) 미정 | DESIGN-CONTRACT.md:10; DECISIONS-API.md:21, :112; ingest.md:58-64; back/ingest/README.md "app 단방향 동기화 잡(Q15) 미구현" |
| 인프라 S8/S9 | S8 = RDS 에 hmg_smoke DB 만들고 DB-v2.1 적용·스모크; S9 = RDS `hmg` DB 에 mig_src COPY(S3 snap/). 템플릿만 있고 실행 일자 없음. 스크립트가 DB-v2.1 을 적용하므로 초기(9월 말) 시점 산출물 | infra/ops/s8-apply.tpl.sh:1-31; s9-load.tpl.sh:2-3, :14, :24-38 |
| 스냅샷 시각 | 시드 워터마크 w0_synced_at = mig_src.scope_runs.synced_at 최댓값(값은 리포에 없음). stg 에는 미러 사본이 **둘 이상**: `mig_src.scope_mentions_0930`(09-30 사본)과 "1002 사본"(10-02) ; frz 추출 실측 2026-10-01(활성 세대 924, 셀 472,083, 프롬프트 362,209, 바뀐 답변 후보 1,066); 운영 동결 세대 924 중 920 이 2026-10-01 13:53~14:49 UTC 생성 | seed-20-ing.sql:38-41; fill-v226.sql:6, :10-15, :43; export.py:42, :108, :127; mig_src_frz.sql:5 |
| stg RDS 상태 | DB 이름 `hmg_r2`(2차 적재 추정, 백엔드 56dc4161) 에 seed 적재 완료 + frz ops 이관 완료(세대 924 전부 active, 통계 10-02); "stg 는 적재 워커·타이머가 없어(유닛 = api·dfs·warm-cache, **ing.load 이력 = seed·rebuild 뿐**)"; stg 규모(2026-09-30): rd.answer 537,167행(leaf 8)·rd.citation 433만; 프로젝트 9개(customer 8 + standard_root 1); 계정은 2026-09-30 이전에 이관됨(결정 3·4 실측); stg 는 GA4 없이 진행 | DB-v2.32.sql:4966, :7337, :7512-7516; DECISIONS-API.md:269-270, :272, :287; DECISIONS.md:580 |
| 미실행(승인 대기) 스크립트 | ecat-v1-cutover.sql, fill-attrib-member-seat.sql(+reproject-attrib-member.py), fill-v219.sql, fix-core10-account-scope.sql, prompt-enabled-core-export.sql/fill-prompt-enabled.sql, fix-sync-s1-rules.sql, fix-u95-competitor-aliases.sql: 모두 "작성만, 실행은 제품 책임자 승인 배치" | 각 파일 머리말 (ecat-v1-cutover.sql:3; fill-attrib-member-seat.sql:4; fill-v219.sql:3; fix-core10-account-scope.sql:2; prompt-enabled-core-export.sql:3; DECISIONS-API.md:218, :286) |
| 리포 스냅샷 | 2026-10-02 기준 외부 검토용 스냅샷 | README.md:3 |

## 5. 미확정·주의 사항

1. **mig.archive_manifest 는 비어 있다**: crawl_*·webgeo_*·레거시 함수·크론을 S3 보관했다는 기록(dump_uri·sha256)을 남길 도구가 리포에 없다. S3 보관 자체의 수행 여부는 리포로 판단 불가.
2. **계정 이관 스크립트(load-accounts.tpl.sh)·account-migration.md 는 리포 밖**(인프라 스크래치). mig_src.profiles 의 열·규칙(R2·R3)은 간접 인용만 있다.
3. **QA 표·project_members**: 설계는 이관, 구현은 미이관. project_members 는 계정 이관 뒤 재시도 계획이 문서에 없다.
4. **컨텍스트 맵(ext.ctx_*)** 적재 스크립트 없음: 6개 scope_context_* 표가 mig_src 에 올라가 있을 뿐이며 활성 스냅샷이 없으면 화면은 "준비 중".
5. **summary 세부층은 "활성 세대 + 바뀐 답변" 만** frz 로 옮긴다(결정 32). 과거 세대·비활성 세대·summary_trend_* 행 자체는 새 DB 에 없다(합계만 단언용). 현행 카드 값 재현은 frz 뷰 + rd 재계산 조합에 의존.
6. `mig_src.profiles`, `mig_src.scope_mentions_0930` 처럼 export.py 밖에서 만들어진 mig_src 표가 stg 에 존재한다. 즉 stg mig_src 의 실제 표 집합은 export.py 57 + frz 15 보다 많다(정확한 집합은 DB 조회 필요).
7. 함수 14개(hmg_anchor_* 유틸·cycle_registry·summary_ensure_*)는 이식·폐기 어느 쪽 결정 기록도 없다.
8. 모든 날짜는 문서 안 "실측" 주석에서 역산한 것이고, S9 적재 실행 일자·병행 운영 시작·종료 일자는 어느 문서에도 없다.
