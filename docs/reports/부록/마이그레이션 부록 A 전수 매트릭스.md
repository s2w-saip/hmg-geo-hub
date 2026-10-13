# A. 레거시 HMG GEO Supabase 테이블 79개 — 이관 더블체크 매트릭스

작성 2026-10-07 · 기준 코드 `hmg-geo-hub-share/front` (`lib/db/schema.ts` pgTable 69개 + `lib/db/migrations/*.sql` CREATE TABLE 74개 + `scripts/db/scope-mirror.sql` 6개 → 합집합 **79개**) · 대조 문서 앤서 「AI 답변 데이터와 이관 대상」 3장(`scratchpad/pdf/handover-data.txt:460-543`) · 앤서 도구 `back/migration/export.py`(BIG 6·SMALL 51·`--frz` 동결층 14질의), `back/migration/seed/seed-10-app.sql`·`seed-20-ing.sql`.

행 수는 앤서 PDF 의 n_live_tup 추정치(2026-10-06)만 옮겼고, 코드로는 확인할 수 없다.

## 범례

- 경로 약어: `S`=`lib/db/schema.ts` · `M`=`lib/db/migrations` · `R`=`lib/db/repositories` · `SA`=`R/scope-aggregates.ts` · `SM`=`R/scope-mirror.ts` · `SC`=`R/summary-cycles.ts` · `G`=`lib/summary/generate` · `sc`=`scripts` · `sql`=`scripts/db/scope-mirror.sql` · `exp`=`back/migration/export.py` · `seed10/20`=`back/migration/seed/seed-10-app.sql`/`seed-20-ing.sql` · 화면 경로는 `app/[locale]/(dash)/` 생략.
- 데이터 출처: 사람 입력 | 운영자 결정 | Scope 싱크(원본) | Scope 싱크(가공) | 파생/집계 | 외부 캐시 | 내부 상태 | 폐기.
- 재생성: 불가 | 가능(원천) | 조건부(필요 입력 명시).
- 판정: **이관 필수** | **이관 권장** | 선택 | 불요.

---

## A-1. 앤서 3-1 「기존 목록」 24

### 컨텍스트 매핑 6

| 테이블 | 정의 | 용도 | 데이터 출처(근거) | 재생성 | 컨슈머 | 앤서 | 판정 |
|---|---|---|---|---|---|---|---|
| scope_context_entities | S:1388 · M/0027:8 | Scope 자동차 산업 ConsumerContext/Requirement 코퍼스 1회 미러(236,781 발화, 2026-07-07) | Scope 싱크(원본·1회). 리포에 쓰기 코드 0 — Scope 라이브 PG에서 직접 적재(M/0027:1-6, S:1379-1387) | 조건부 — Scope DB 직접 접근 필요(API 는 타임아웃 S:1382-1385). Scope 측 코퍼스 현존 여부 미확인 | R/scope-context-map.ts:167,324,508 → projects/[id]/intent/social-scraping/page.tsx, app/api/context-map/route.ts | 3-1 컨텍스트 | **이관 필수** — 재적재 경로가 리포에 없다 |
| scope_context_drives | S:1407 · 0027:21 | 맥락→조건 공동언급 | 동상 | 동상 | scope-context-map.ts:357,364,464 | 3-1 | **이관 필수** |
| scope_context_combinations | S:1422 · 0027:29 | 조건↔조건 조합 | 동상 | 동상 | :241,258,617 | 3-1 | **이관 필수** |
| scope_context_evidence | S:1435 · 0027:36 | 엔티티별 근거 인용 ≤8 | 동상 | 동상 | :335 | 3-1 | **이관 필수** |
| scope_context_domains | S:1451 · 0027:47 | 엔티티별 소스 호스트 수 | 동상 | 동상 | :349 | 3-1 | **이관 필수** |
| scope_context_prompt_cache | S:1468 · 0028:8 | 프로젝트별 LLM(OpenRouter) 생성 후보 프롬프트 jsonb + 낙관 락 version | 외부 캐시 + 사람 입력 혼합 — 생성은 LLM(S:1462-1467), "더 생성"·"선택 삭제" 는 사용자 편집(S:1475-1478; R/scope-context-prompts.ts:71,79) | 조건부 — LLM 재생성은 비결정, 사용자 삭제 결과 복원 불가 | scope-context-prompts.ts:42 → projects/[id]/intent/_actions.ts:184-297 | 3-1 | **이관 필수**(작음) |

### 업무 데이터 15

| 테이블 | 정의 | 용도 | 데이터 출처(근거) | 재생성 | 컨슈머 | 앤서 | 판정 |
|---|---|---|---|---|---|---|---|
| tracked_brands | S:636 · 0008:75 | 프로젝트 자사 브랜드 별칭(0008 유물이지만 현행 사용) | 사람 입력 R/tracked-entities.ts:210,224 ← projects/[id]/setting/_components/tracked-entities.tsx:68,230 | 불가 | tracked-entities.ts:203; lib/scope/project-sync.ts:75(Scope 프로젝트 동기화 입력) | 3-1 업무 | **이관 필수** |
| tracked_competitors | S:479 · 0007:9 | 지정 경쟁사(+is_target KPI#16) | 사람 입력 tracked-entities.ts:58,72,79,89 | 불가 | tracked-entities.ts:51,104 → setting/page.tsx, analysis/mention | 3-1 | **이관 필수** |
| tracked_vehicles | S:498 · 0007:20 | 추적 차종 | 사람 입력 tracked-entities.ts:166,181 | 불가 | :144,160 | 3-1 | **이관 필수** |
| entity_registry | S:1257 · 0023:8 | "누가 자사인가" 전사 명부(role own/excluded) | 운영자 결정 R/entity-registry.ts:82,101 ← admin/standards/entities/_actions.ts | 불가 | entity-registry.ts:46-77; G/context.ts:132 OWN_ROSTER_SQL(생성기 판정 입력); lib/scope/result-adapter.ts:515; qa-review.ts:689 | 3-1 | **이관 필수** |
| citation_domain_overrides | S:1600 · 0043_citation_domain_overrides:28 | 인용 카테고리 운영자 교정층(read-time 파생 재분류) | 운영자 결정 R/citation-overrides.ts:104,126 ← admin/standards/citation-sources | 불가 | citation-overrides.ts:67; qa-review.ts:704; sc/citations/seed-curation.ts:37 | 3-1 | **이관 필수** |
| projects | S:84 · 0002:14 | 프로젝트(브랜드·국가·scope_project_id·ga4_property_id·ai_engines) | 사람 입력 R/projects.ts:225,276-295 ← projects/new, setting | 불가 | projects.ts:139-172; lib/scope/mirror/sync.ts(프로젝트 필터); 전 프로젝트 화면 | 3-1 | **이관 필수** |
| website_sites | S:1328 · 0019:3 | 웹사이트 유닛(brand×country)→scope_project_id | 사람 입력(xlsx 시드)+운영 sc/db/seed-website-prompts.ts:320,339; push-website-scope.ts:170; R/website-sites.ts:709,725 | 불가(scope_project_id 는 Scope 등록 결과) | SA:975,5147,8586-9213; qa-review.ts:206; R/report-publications.ts:139; website/answer-analysis/citation/page.tsx | 3-1 | **이관 필수** |
| project_owned_bases | S:139 · 0021:8 | 프로젝트 자사 base(KPI⑤⑥ 게이트) | 사람 입력 R/project-owned-bases.ts:43,60; sc/db/backfill-project-owned-bases.ts:64 | 불가 | project-owned-bases.ts:23,74 → projects/[id]/_data/live.ts; 생성기 base_universe | 3-1 | **이관 필수** |
| project_members | S:242 · 0002:3 | 프로젝트 멤버·초대(status pending/active, invited_by) | 사람 입력 R/project-members.ts:230,248,266,283,331; projects.ts:245 | 불가 | project-members.ts:111-317 → projects 목록·member 탭 | 3-1 | **이관 필수** — 단 앤서 시드는 `app.project_member(미이관)`(seed/verify-seed.sql:61) → 확인 요청 |
| project_custom_fields | S:178 · 0024:5 | 프로젝트 커스텀 태그 정의 | 사람 입력 R/project-custom-fields.ts:38,51,58,71 | 불가 | :22,30; app/api/filters/options/route.ts | 3-1 | **이관 필수** |
| prompts | S:344 · 0004:21 | 프로젝트·표준 카탈로그 프롬프트(brand·depth·lang·regions·kind·scope_prompt_id·soft-delete) | 사람 입력(+import) R/prompts.ts:287-388; R/prompt-audit-logs.ts:214,251,276; sc/db/load-standard-prompts*.sql | 불가 | SA 카탈로그 조인 다수(:2374 등); 생성기 in_root_catalog; standard/prompts/page.tsx | 3-1 | **이관 필수** |
| scope_prompts | S:1214 · sql:65 (+0046 is_korean GENERATED, 0048 lang·regions) | Scope 프롬프트 미러(관측값) | Scope 싱크(원본) SM:851 upsertPrompts ← cron sync-mirror(20분); 로컬 INSERT sc/db/apply-hyundai-v14.ts:216, split-ioniq-project.ts:134 | 가능(원천: Scope API prompts; 조건: Scope 접근, 워터마크 무시 전량 읽기) | SA:957,1099-1157,1495-1551; qa-review.ts:220; R/standards.ts | 3-1(정본 질의) | **이관 권장** — 정본은 Scope(ing.prompt) 로 두되 미러 사본 동봉. `is_korean` 은 생성 컬럼이라 COPY 시 제외 |
| prompt_candidates | S:307 · 0004:10 | 후보 풀(google_keyword/social/manual) | 사람 입력+LLM 산출 R/prompts.ts:76 ← intent/_actions.ts:117 | 불가 | prompts.ts:61,69 → projects/[id]/prompt | 3-1 | **이관 필수** |
| prompt_audit_logs | S:1575 · 0041:11 | 표준 카탈로그 감사 원장(append-only) | 사람 입력 이력 R/prompt-audit-logs.ts:143,223,264 | 불가 | :76,129 → standard/prompts/page.tsx; seed10:1223-1225 | 3-1 | **이관 필수** |
| website_prompts | S:1347 · 0019:19 | 유닛별 프롬프트+target_url+owned_base_url+scope_prompt_id(file_seq 가 report_* 와의 유일 키) | 사람 입력(xlsx)+운영 R/website-sites.ts:741,763; sc/db/seed-website-prompts.ts:355,388; push-website-scope.ts:96; fix-lang-codes.ts:19 | 불가 | SA:954-975,5146,8585-9212; R/summary-website-aggregates.ts:1158; R/report-publications.ts:138 | 3-1 | **이관 필수** |

### 공급 DB 원시 3 (앤서 "별도 항목")

| 테이블 | 정의 | 용도 | 데이터 출처(근거) | 재생성 | 컨슈머 | 앤서 | 판정 |
|---|---|---|---|---|---|---|---|
| scope_runs | S:682 · sql:6 (+0020 project_id, 0058 cycle_anchor_at) | Scope 측정 run 미러; `synced_at` 은 로컬 드리프트 지문 | Scope 싱크(원본) SM:389 ← lib/scope/mirror/sync.ts:2166(cycle_anchor_at) ← app/api/cron/sync-mirror | 가능(원천 Scope API runs; 조건: Scope 보존·접근). `synced_at` 은 재생성 시 바뀜(summary_cycle_runs.synced_at_seen 대조 깨짐) | SA:818-911,1708,1846; SC; qa-review.ts:205; 0077/0078 함수 입력 | 별도 | **이관 필수** |
| scope_answers | S:791 · sql:15 | 답변 미러(job 단위). `measured_at` 은 **앵커로 접힌 값**(S:813-815) | Scope 싱크(가공) SM:303-315 + anchorReapplySql(SM:117-121, `scope_anchor_fold`) + dropReapplySql(SM:387, `scope_answer_drop_apply`) | 조건부 — Scope 재싱크 + scope_answer_anchors·scope_answer_drops + 함수 2종이 있어야 현재 값 수렴(0053:16-18) | SA:817-1845(전 KPI); qa-review; 생성기 G/load.ts; 0077 refresh | 별도 | **이관 필수** |
| scope_citations | S:1130 · sql:46 (+0052 url_norm/url_host/url_base_norm, 0016 category) | 인용 미러 + 정규화 컬럼(0052 함수) + domain(PSL lib/public-suffix) | Scope 싱크(가공) SM:324 citationValues(SM:89-94); sc/db/backfill-citation-norm.ts:71 | 조건부 — 재싱크 + citation_url_* 함수 + 같은 PSL 버전 | SA:3064-5427; R/citation-key-universe.ts:27; qa-review.ts:703; 답변 모달 | 별도 | **이관 필수** |

---

## A-2. 앤서 3-2 「추가 이관 13」

| 테이블 | 정의 | 용도 | 데이터 출처(근거) | 재생성 | 컨슈머 | 앤서 | 판정 |
|---|---|---|---|---|---|---|---|
| prompt_custom_field_values (6,823) | S:203 · 0024:19 | 프롬프트×필드 값 | 사람 입력 R/project-custom-fields.ts:91,105,115 | 불가 | :84,129; SA:2374,5126,6526 | 3-2 | **이관 필수** |
| project_tracked_urls (447) | S:159 · 0015:5 | KPI⑥ 타겟 URL(정확 경로 일치) | 사람 입력 R/project-tracked-urls.ts:54,75,95; sc/db/seed-kia-italy-tracked-urls.ts:171 | 불가 | project-tracked-urls.ts:27 → setting, _data/live.ts; 생성기 target_universe | 3-2 | **이관 필수** |
| tracked_keywords (109) | S:516 · 0018:8 | 프로젝트 구글 키워드 추적 | 사람 입력 R/tracked-entities.ts:263,277,291 | 불가 | :256 → intent/google-keyword | 3-2 | **이관 필수** |
| standard_prompts (8) | S:405 · 0005:9 | admin 표준 프롬프트 카탈로그 | 운영자 R/standards.ts:72,95,105 | 불가 | standards.ts:66 | 3-2 | **이관 필수** |
| standard_keywords (9) | S:429 · 0005:24 | 표준 키워드 | 운영자 standards.ts:449,472,482 | 불가 | :443 → admin/standards/customer-interest | 3-2 | **이관 필수** |
| standard_sources (10) | S:455 · 0005:42 | 표준 출처 allowlist | 운영자 standards.ts:524,547,557 | 불가 | :518 | 3-2 | **이관 필수** |
| ga4_properties (1) | S:1534 · 0036:13 | brand×country→GA4 property(status) | 운영자 R/ga4-properties.ts:52,82,88 ← admin/ga4 | 불가 | :26,36 → lib/ga4/property-map(resolveProperty) | 3-2 | **이관 필수** (OAuth 주체·토큰은 env `lib/ga4/auth.ts` — DB 밖) |
| ga4_tracked_events (0) | S:1559 · 0037:13 | 전환 이벤트 선택 | 운영자 R/ga4-tracked-events.ts:55,59 | 불가 | :18,35 | 3-2 | **이관 필수**(0행이면 스키마만) |
| report_publications (1) | S:1706 · 0080:55 | 발행 리포트 원장(sha256 신원, superseded 정정) | 운영자 결정 sc/reports/ingest-publication.ts:233(INSERT), :225(superseded) — `--yes` 수동 | 불가 — 발행 HTML 원본이 있으면 재적재는 가능 | R/report-publications.ts:213 → website 인용 화면 "발행 회차는 발행값"; sc/reports/verify-parity.ts:94 | 3-2 | **이관 필수** |
| report_site_facts (105) | S:1751 · 0080:126 | 사이트 단위 정수 쌍(동결, raw jsonb) | ingest-publication.ts:276 | 동상 | report-publications.ts:227 | 3-2 | **이관 필수** |
| report_site_engine_facts (202) | S:1788 · 0080:195 | 엔진별 분자(감사용) | ingest-publication.ts:289 | 동상 | 앱 리더 없음(0080:192-194 감사용); sc/db/0080-rollback.sql:39 | 3-2 | **이관 필수**(작음) |
| project_engine_history (82) | S:127 · 0042:13 | 엔진 선택 변경 이력(append-only, 전체 집합 스냅샷) | 사람 입력 이력 R/projects.ts:259,301 | 불가 | projects.ts:317 → setting "엔진 변경 이력" | 3-2 | **이관 필수** |
| profiles (128) | S:55 · 0000:2 (+0013 operator, 0039 menu_groups) | 사용자 role·scope(brands/regions/countries)·operator·menu_groups. `id = auth.users.id`, FK 없음(S:52-54) | 사람 입력 R/profiles.ts:112,145,161 ← admin/_actions.ts:103-116(auth.users 생성과 한 쌍); sc/db/seed.ts:174-184 | 불가 — auth.users 없이는 로그인 불가(계정 매핑 키로만 쓸 수 있음) | profiles.ts:62-167 → lib/auth session, (dash)/layout.tsx:127; project-members join | 3-2 | **이관 필수** + `auth.users` 내보내기 별도 요청. 앤서 seed10:25-27 은 "profiles 는 이관 대상이 아니다"(시스템 사용자 치환) → PDF 3-2 와 상충, 확인 |

---

## A-3. 앤서 3-3 「확인 후 회신」 7

| 테이블 | 정의 | 용도 | 데이터 출처(근거) | 재생성 | 컨슈머 | 앤서 | 판정 |
|---|---|---|---|---|---|---|---|
| scope_answer_anchors (177,007) | S:826 · 0053:29 | 회차 앵커 레지스트리 — measured_at 접기의 **정본 저장소**(anchor·source_measured_at 원복 근거·reason=접기 배치명) | 운영자 결정 — 앱·스크립트 쓰기 0건. 0053:83-100 시드(`_bak_anchor_fold`) + 수동 INSERT 절차(0053:112-126, "새 회차를 접을 때 (지금은 수동)") | 불가 — 접기 결정과 원복 근거가 여기만 있음 | SM:121 anchorReapplySql(매 재싱크 소비, 0053:16-18); 0077/0078 refresh 의 'registry' **고정(pinned)** 출처(S:886-887, 0078:40-49); qa-review.ts:720; sc/db/backfill-answer-cycle-anchors.ts:374-757 | 3-3 | **이관 필수** — PDF 1장 N1 자인. 앤서 seed20:312-314 `ing.answer_anchor_pin` 원천 |
| scope_answer_drops (14,182) | S:1016 · 0054:24 | 드롭 레지스트리(reason NOT NULL, 배치 롤백 키) | 운영자 결정 — 코드 쓰기 0건; 수동 절차 0054:80-90 | 불가 | SM:145,387 dropReapplySql(`scope_answer_drop_apply`); lib/scope/mirror/bulk-run.ts:125; qa-review.ts:721 | 3-3 | **이관 필수** — seed20:315-316 `ing.answer_drop` 원천 |
| qa_review_sessions (9) | S:1618 · 0055:22 | 검수 세션(락 소유자, ip_hash) | 사람 입력 R/qa-review.ts:159,171 ← app/api/qa/session | 불가 | 앱 리더 없음(reviews/notes.session_id 참조만) | 3-3 | **이관 권장**(작음; 검수 인수 시) |
| qa_answer_reviews (29) | S:1632 · 0055:33 | 답변별 검수 결과(section_flags → status 파생) | 사람 입력 qa-review.ts:882 ← api/qa/review | 불가 | qa-review.ts:223,502,865-1123 → raw-data-qa/answers | 3-3 | **이관 권장**(검수 인수 시 필수) |
| qa_review_notes (70) | S:1654 · 0055:48 | 검수 노트(target_label 스냅샷 — 재싱크 후 citation id 바뀜) | 사람 입력 qa-review.ts:1068,1096,1104 | 불가 | :253-1045 → raw-data-qa/notes; api/qa/notes/export | 3-3 | **이관 권장** |
| member_audit_logs (142) | S:284 · 0006:16 | 멤버 변경 감사(append-only, 7 액션) | 사람 입력 이력 R/member-audit-logs.ts:77 | 불가 | :66 → projects/[id]/member/_components/audit-log.tsx | 3-3 | **이관 권장**(작음) — 앤서 seed10:1226-1228 이 이미 적재 |
| bff_audit_logs (162,063) | S:1510 · 0033:30 | BFF 감사 싱크(scope_call ScopeFilter 스냅샷 / data_access; actor_role 시점 스냅샷) | 사람 행위 이력 R/bff-audit-logs.ts:35 ← lib/audit.ts | 불가 | **리더 없음**(bff-audit-logs.ts:5-7 "INSERT only, no read method") | 3-3 | 조건부 권장 — 보존 의무(HMG·이노션) 확인 전까지 덤프 보관. HUB 시드 미적재 |

---

## A-4. 앤서 3-4 「이관 불요」

### 분석 결과 4 (검산용 1회 덤프)

| 테이블 | 정의 | 용도 | 데이터 출처(근거) | 재생성 | 컨슈머 | 앤서 | 판정 |
|---|---|---|---|---|---|---|---|
| scope_mentions (6,787,327) | S:1029 · sql:30 (+0044 유형 컬럼) | job×entity 멘션 롤업(감성·유형·surfaces) | Scope 싱크(가공: Scope 분류 결과) SM:316; 로컬 보정 sc/db/backfill-seat-mention-correction.ts:64,80, lib/scope/mirror/case-sensitive-brands.ts | 조건부 — Scope 재싱크(Scope 보존) + 로컬 보정 재적용 | SA:240-3303(멘션 KPI 전부); R/entity-registry.ts:57,131; qa-review.ts:688 | 3-4 분석 | **이관 권장**(적재 가능 덤프) — 앤서 seed20:216-226 `ing.mention` 원천(HUB 결정 37 v0 이력) |
| scope_mention_occurrences (7,876,641) | S:1065 · 0061:4 · sql:74 | 발생 단위(답변 원문 밑줄) | Scope 싱크(가공) SM:318 | 조건부(재싱크) | SA:8144(답변 모달) | 3-4 | **이관 권장**(덤프) — seed20:232-237 |
| scope_answer_stances (958,476) | S:1101 · 0072:46 | 답변×턴×브랜드 스탠스 | Scope 싱크(가공) SM:321 | 조건부 | SA:7624,8147 | 3-4 | **이관 권장**(덤프) — seed20:243-247 |
| scope_acr_rollups (1,077,813) | S:1170 · 0025:16 | ACR prompt-run×엔티티 롤업 | Scope 싱크(가공) SM:359 | 조건부 | SA:7987,9510-9763(AI funnel ACR); bulk-run.ts:143 | 3-4 | **이관 권장**(덤프) — seed20:271-300 `ing.acr_*`. ⚠ 드롭 함수가 ACR 은 안 지움(0054:46-48) |

### 재계산 가능 — summary_* 17

| 테이블 | 정의 | 용도 | 데이터 출처(근거) | 재생성 | 컨슈머 | 앤서 | 판정 |
|---|---|---|---|---|---|---|---|
| summary_cycles (≈924 활성, exp 주석) | 0059:12 (+0070 hidden_reason/hidden_at, 0071 hidden_scope, 0062/0064 없음) | **회차 원장** | 혼합. 관제 파생: SC:1447 INSERT(anchor_source='scope'), :1481-1508 귀속·카운터, :1547-1550 `closed_by=판정·closed_at·sealed_units=마감 시점 스냅샷`, :1593 fleet_visible. **운영자 결정**: sc/summary/hide-cycle.ts:184,193 hidden_reason/hidden_at/hidden_scope(0070:111-113 "사람이 찍은 값이 그대로 남는다"); G/cycle.ts:23-26 수동 개설 anchor_source='operator', :80,:126 closed_by='operator'; G/swap.ts:96-98 `view_anchor_at` = 최초 노출 시각(COALESCE 보존)·status published | 불가 — hidden_*·view_anchor_at·closed_at/by·sealed_units·anchor_source='operator' 는 시점·판단 값 | SA:1426-1647(앵커 축 원장 조인), :4012-4199 excludeHiddenCycleRuns; R/cycle-fingerprint.ts:126-140; R/scope-answer-anchors.ts:286,355; SC 픽(pickGlobalCycle/pickWebsiteCycles); 0078:479-480 refresh 원장 입력; summary-settings.ts:134 | 3-4 재계산 | **이관 필수** — 앤서 seed20:341-368 `ing.cycle` 원천, HUB DB-v2.32 `rd.cycle.hidden_reason` |
| summary_cycle_runs | 0059:42 | 회차↔run 귀속 원장(attributed_by scope/derived/operator/late, synced_at_seen) | 관제 파생 SC:1475 + 운영자 G/cycle.ts:229-230('operator') | 불가 — 'late'·'operator' 귀속과 synced_at_seen(생성 시점 지문)은 재계산 불가 | G/swap.ts:34-45 driftCheckSql; SA:4011-4199; scope-answer-anchors.ts:115; R/scope-mirror-bulk-cycles.ts:129-371; exp `_DRIFT` | 3-4 | **이관 필수** — seed20:357-359 `ing.cycle_run` |
| summary_settings | 0059:51 | 키-값 4키: `read_enabled`·`read_screens`(0059:57-58; sc/summary/read-switch.ts:64,68), `website_excluded_fs`(set-excluded-units.ts:10), `period_compare_epoch`(summary-settings.ts:153; sc/db/enable-period-compare-screen.sql:49) | 운영자 결정 | 불가(값 4개 — 기록으로 대체 가능) | R/summary-settings.ts:36,76,134,168(전 summary 리더 게이트) | 3-4 재계산 · 운영 내부 | 선택 — `website_excluded_fs`(보고서 제외 유닛) 는 업무 규칙으로 문서 인계 |
| summary_generations | 0059:60 (+0064 timings) | 세대 원장 + 판정 입력 스냅샷(roster_snapshot=entity_registry+상수, base_universe, target_universe, noise_snapshot) | 파생 G/cycle.ts:46-47(INSERT), :154-221, swap.ts:48-106(상태). 스냅샷은 **생성 시점 운영자 입력의 사본**(lib/summary/tenant/hmg.ts:59-61 "재해석 방지") | 조건부 — 재생성하면 최신 명부로 '재해석'(generate-cycle.ts:213-233 `--reinterpret`); 과거 세대 스냅샷 복원 불가 | G/cycle.ts:212,292,331(스냅샷 재사용); R/summary-cycle-health.ts:379; bulk-cycles:365 | 3-4 재계산 · 운영 내부 | **이관 권장**(활성 세대 행만) — 앤서 exp `--frz` `frz_ops_generation` 이 roster/base/target/noise 를 이미 내보냄(mig_src_frz.sql:12-15, DB-v2.21 `frz-import-ops`) ↔ PDF 는 운영 내부 |
| summary_cycle_jobs | 0059:78 (주 파티션) | 회차 셀 목록 | 파생 sc/summary/surface-global.ts:465, surface-website.ts:707 | 가능 — 원천 scope_answers/scope_runs + summary_cycle_runs + prompts/website_prompts; 조건: 세대 스냅샷·generator_version 동일, 주 파티션 선생성(`summary_ensure_week_partitions`); 13주 보존(0059:7) | G/cycle.ts:143; exp frz_ops_cell | 3-4 | 불요(재생성) — 활성 세대 셀 집합은 앤서 `--frz` 로 전달 |
| summary_answers | 0059:88 (+0060/0063/0066 report_fs·presence_set·unit_owned/target) | 답변 사실표 | 파생 G/load.ts:56 | 가능(동상) | R/summary-global-aggregates.ts:298-598; R/summary-website-aggregates.ts:245-999; R/summary-citation-read.ts:216; SA:1427-1648 | 3-4 | 불요 — 단 0080:19-21 "발행 시점≠생성 시점이면 값 다름" → 활성 세대 동결값은 frz_ops_answer/changed 로 |
| summary_brand_mentions | 0059:106 | 브랜드 멘션 사실표 | G/load.ts:99 | 가능 | summary-global:268-645; summary-website:343-1037 | 3-4 | 불요(frz_ops_brand) |
| summary_domain_citations | 0059:128 (+0067 report_fs) | 도메인 인용 사실표 | G/load.ts:140 | 가능 | summary-citation-read:105; global:406-619; website:910-1101 | 3-4 | 불요 |
| summary_target_hits | 0059:147 | 타겟 인용 사실표 | G/load.ts:167 | 가능 | summary-website:1193,1607 | 3-4 | 불요 |
| summary_prompt_dim | 0059:159 (+0060 report_fs·unit_base) | 프롬프트 차원 | surface-global.ts:529; surface-website.ts:922 | 가능 | SA:1427,1561,1648 | 3-4 | 불요(frz_ops_prompt) |
| summary_ga4 | 0059:176 | GA4 ⑦ (1차 롤아웃 비어 있음) | **쓰기 0·읽기 0**(코드 검색) | — | 없음 | 3-4 | 불요(0행·미사용, 스키마도 불필요) |
| summary_trend_answers | 0059:184 (+0065/0066) | 집계층(답변 키 그레인) | 파생 G/fold.ts:279-298(`--refold` 재생성) | 가능(원천: 세부층) | R/summary-trend-aggregates.ts:872; R/summary-pre-catalog-cycles.ts:98-103 | 3-4 | 불요(frz_ops_sum_cycle 합이 단언값) |
| summary_trend_brands | 0059:195 (+0069 comp_rank) | 집계층 브랜드 | fold.ts:299-536 | 가능 | trend-aggregates:997 | 3-4 | 불요 |
| summary_trend_domains | 0059:211 | 집계층 도메인 | fold.ts:537-572 | 가능 | summary-citation-read:146; trend-aggregates:583,1136 | 3-4 | 불요 |
| summary_trend_own | 0059:223 (+0065 KPI 엔진 7컬럼, 0067 own_negative) | 집계층 당사(KPI 엔진) | fold.ts:573-804 | 가능 | trend-aggregates:825; R/summary-period-compare.ts:272,721 | 3-4 | 불요 |
| summary_url_hits | 0081:42 | job 단위 자사·타겟 URL 인용 플래그 | 파생 G/load.ts:195(generate-cycle `--url-hits`) | 가능(원천 scope_citations + website_prompts; SA websitePromptUrlHitJobFlagsSql) | summary-website-aggregates(0081:5-11) 경유 | 3-4 | 불요(frz_ops_web) |
| summary_url_hit_generations | 0081:65 | url_hits 적재 완료 원장 | 파생 G/load.ts:202 | 가능 | R/summary-cycle-health.ts:401; summary-website:1253; generate-cycle.ts:574 | 3-4 · 운영 내부 | 불요 |

### 재계산 가능 — 회차 4

| 테이블 | 정의 | 용도 | 데이터 출처(근거) | 재생성 | 컨슈머 | 앤서 | 판정 |
|---|---|---|---|---|---|---|---|
| scope_answer_cycle_anchors (BIG, 완료 답변 1행) | S:856 · 0077:448 | 답변별 회차 앵커 전수(anchor_date·round_date·cycle_id·source registry/ledger/run/fallback) | 파생 — 쓰기는 DB 함수 `refresh_answer_cycle_anchors` 뿐(S:851-855; 0077:893, 0078:711). 호출: SM:173(재싱크), G/swap.ts·SC(원장 전파), R/scope-answer-anchors-catchup.ts(크론 따라잡기), sc/db/backfill-answer-cycle-anchors.ts | 조건부 — 함수 20여 종 이식 + scope_runs(cycle_anchor_at·project_id) + scope_answer_anchors + summary_cycles/cycle_runs(노출일) + scope_cycle_rounds(귀속) + 루트 프로젝트 id env 가 전부 있어야 `--apply --recompute` 로 동일값 | SA:1382-1646(앵커 축 기간 술어); scope-answer-anchors.ts:442(달력); summary-period-compare.ts:586; lib/scope/anchor-worklist.ts | 3-4 재계산 | **이관 권장** — 앤서 exp BIG 가 이미 내보내고 seed20:347,413 이 읽는다. 함수 이식·재계산 비용보다 덤프가 싸다 |
| scope_cycle_rounds (≈1,000) | S:918 · 0077:527 | 회차→정규 요일 귀속 매핑(basis canonical/prev_empty/next_empty/nearest/merged/project) | 혼합: 함수 `hmg_assign_cycle_rounds` 가 **미배정 회차만 차례 배정**(0077:517-519 "과거 배정은 재계산하지 않는다") + 운영자 재배정 sc/db/reassign-cycle-rounds.ts:246,254 | 불가(실질) — 차례·합침(merged) 배정이 적용 시점 순서에 의존, 0053 접기로 옮겨진 회차의 옛 자리 등 이력 의존(reassign-cycle-rounds.ts:16-20) | SC:70,145(roundDate 픽); R/trend-grid-slots.ts; 0077 `hmg_round_date_of` | 3-4 | **이관 필수** — seed20:329-331 `ing.cycle_round` 원천 |
| scope_cycle_anchor_state (≈1,000) | S:945 · 0078:168 | 회차 해소 결과 캐시(조건부 확장 판정) | 파생 — `hmg_sync_cycle_anchor_state` 만(0078:159-160 "손으로 고치지 않는다") | 가능(refresh 재호출) | R/cycle-fingerprint.ts:79(앵커 축 지문); sc/db/answer-cycle-anchors-audit.sql:255 | 3-4 | 선택 — 앵커 전수표와 한 묶음으로 받아야 일관(exp SMALL 포함) |
| scope_cycle_registry_runs | S:987 · 0078:231 | run 단위 0053 요약(reg_anchor_min/max) | 파생 `hmg_refresh_cycle_registry_runs`(0078:264) | 가능(0053 + scope_answers) | audit.sql:305-317 뿐 | 3-4 | 선택(동상) |

### 외부 조회 캐시 2

| 테이블 | 정의 | 용도 | 데이터 출처(근거) | 재생성 | 컨슈머 | 앤서 | 판정 |
|---|---|---|---|---|---|---|---|
| keyword_cache (270) | S:1311 · 0012:11 | DataForSEO/OpenRouter 페이로드 캐시(expires_at) | 외부 캐시 R/keyword-cache.ts:30 | 가능(재조회 비용) | keyword-cache.ts:16 → app/api/keyword/* | 3-4 캐시 | 선택 |
| keyword_volume_cache (167) | S:1273 · 0011:15 | 검색량 캐시 | 외부 캐시 R/keyword-volume-cache.ts:146,153 | 가능 | :67; lib/keyword/service.ts:15 | 3-4 캐시 | 선택 |

### 0행·폐기 (코드에 정의된 5)

| 테이블 | 정의 | 용도 | 데이터 출처(근거) | 재생성 | 컨슈머 | 앤서 | 판정 |
|---|---|---|---|---|---|---|---|
| ai_responses | S:563 · 0008:17 | 구 분석 파이프라인(0008) | 폐기 — 쓰기·읽기 0(코드 전역 검색) | — | 없음 | 3-4 0행 | 불요 |
| brand_mentions | S:592 · 0008:35 | 동 | 폐기 | — | 없음 | 3-4 | 불요 |
| citation_analysis | S:612 · 0008:55 | 동 | 폐기 | — | 없음 | 3-4 | 불요 |
| youtube_video_metadata | S:653 · 0008:89 | 동 | 폐기 | — | 없음 | 3-4 | 불요 |
| scope_mirror_progress | S:768 · 0073:7 | run 단위 벌크 싱크 재개 체크포인트 | 내부 상태 R/scope-mirror-progress.ts:128,204,272,299(bulk-* 워커) | 가능(재싱크 시 생성) | R/scope-mirror-bulk-cycles.ts:167-370; scope-mirror-progress-read.ts:22; SM:453 | 3-4 0행·폐기 | 불요 — 단 '폐기'가 아니라 현행 0073 기능의 상태표(벌크 싱크 중이면 0행 아님) |

### 운영 내부 (summary_* 에 겹치지 않는 3)

| 테이블 | 정의 | 용도 | 데이터 출처(근거) | 재생성 | 컨슈머 | 앤서 | 판정 |
|---|---|---|---|---|---|---|---|
| scope_sync_cursors | S:720 · 0043_scope_sync_cursors:17 | 프로젝트별 마지막 **시도** 시각·last_error(로테이션 키) | 내부 상태 SM:512,529 | 가능(첫 패스에 재생성) | SM:487; sync.ts:894-917 | 운영 내부 | 선택(참고본) — seed20:458-462 `ing.sync_cursor` 가 읽음 |
| scope_sync_watermarks | S:741 · 0082:26 | 증분 읽기 워터마크(prompts_synced_through·resume_*·runs_floor_run_ids) | 내부 상태 SM:601,631,640,663 | 가능(없으면 전량 읽기, 0082:21) | SM:568; sync.ts:408-476 | 운영 내부 | 불요 |
| qa_answer_locks | S:1680 · 0055:71 | 검수 동시성 락(TTL 180s) | 내부 상태 R/qa-review.ts:85,123,133 | 가능(휘발) | :111,141 | 운영 내부 | 불요 |

(앤서 문서의 `drizzle.__drizzle_migrations`·`_bak_anchor_fold`·`crawl_*`·`webgeo_*` 는 코드에 정의가 없어 79개 밖. `_bak_anchor_fold` 는 0053:21-22 가 "지우지 않는다 — 8/25·09-01 접기의 원본 measured_at 정본" 이라 **덤프 보관 선택**.)

**집계**: 이관 필수 41 · 이관 권장 12 · 선택 6 · 불요 20 = 79.
(필수 41 = 컨텍스트 6 + 업무 14 + 공급 원시 3 + 3-2 13 + 앵커·드롭 2 + summary_cycles·summary_cycle_runs 2 + scope_cycle_rounds 1 / 권장 12 = scope_prompts·qa 3·member_audit·bff·분석 4·summary_generations·scope_answer_cycle_anchors / 선택 6 = summary_settings·anchor_state·registry_runs·캐시 2·scope_sync_cursors / 불요 20 = summary 13·폐기 5·watermarks·qa_answer_locks)

---

## B. 마이그레이션이 만든 DB 객체와 "읽기 시점" 의존

트리거·뷰는 없다(`CREATE TRIGGER|VIEW` 검색 0). 아래가 전부다.

| 객체 | 정의 | 쓰기 경로에서 호출 | **읽기 시점** 호출(화면이 의존) | 이식 판단 |
|---|---|---|---|---|
| `citation_url_norm` / `citation_url_base_norm` / `citation_url_host` (IMMUTABLE) | 0052:81-97 | SM:94 citationValues(싱크 삽입); sc/db/backfill-citation-norm.ts:11 | **있음** — SA:645-649 `coalesce(url_norm, citation_url_norm(url))` 폴백, SA:586-698, 8940, 9113(KPI⑤⑥) | 레거시 대시보드를 살리면 필수. 데이터만 이관하면 url_norm 컬럼이 채워져 있어 폴백 미발동(단 NULL 행은 틀림) |
| `scope_anchor_fold(ts,date)` STABLE | 0053:59 | SM:117-121 anchorReapplySql; column-availability.ts:288 프로브 | 없음 | 재싱크 경로 유지 시만 |
| `scope_answer_drop_apply(uuid)` | 0054:51 → 0072:86 재정의(stances 포함; occurrences 미포함 0072:84) | SM:145,387 | 없음 | 동상 |
| `summary_report_norm(text)` | 0060:23 (=citation_url_norm 위임) | sc/summary/surface-website.ts:165-811(생성기) | 없음 | 생성기 유지 시만 |
| `summary_ensure_cycle_gen_stats()` + CREATE STATISTICS | 0062:34,60 | G/fold.ts:930; SC:1691 | 없음(성능) | 선택 |
| `summary_ensure_week_partitions(date,date)` | 0064:59 | SC:1730,1741(크론 관제, 4주 선생성) | 없음 — 단 **자식 파티션 없으면 INSERT 실패**(0064:9-10) | summary_* 세부층 6표를 이관하면 주 파티션 자식(라이브 summary_ 계열 135표, drift-sql.ts:26,119)을 먼저 만들어야 함 |
| `hmg_anchor_timezone/anchor_date/anchor_today/anchor_utc_midnight/anchor_week/anchor_month/round_canonical_dow/round_prev_canonical/round_next_canonical/anchor_default_engines/anchor_is_pinned/anchor_keep_existing/anchor_view_date/round_date_of/assign_cycle_rounds/propagate_cycle_rounds/refresh_answer_cycle_anchors` | 0077:83-893 | SM:173; SC·G/swap.ts 전파; catch-up; backfill·reassign 스크립트 | **있음** — `hmg_anchor_week`·`hmg_round_canonical_dow` R/trend-grid-slots.ts:156,216, lib/summary/read/trend-grid-buckets.ts:210; `hmg_anchor_view_date`·`hmg_anchor_today` R/cycle-fingerprint.ts:75,151,167 | 앵커 축 화면(추이 격자·노출 게이트)을 살리면 5개 함수 필수. 값 자체는 테이블에 굳어 있어 **데이터 이관만이면 불필요**(대신 재계산 불가) |
| `hmg_cycle_key` / `hmg_refresh_cycle_registry_runs` / `hmg_prune_cycle_registry_runs` / `hmg_sync_cycle_anchor_state` + `refresh_answer_cycle_anchors`·`hmg_propagate_cycle_rounds` 재정의 | 0078:145-711 | refresh 내부 | `hmg_cycle_key` 는 S:948 PK 정의 주석만 | 동상 |
| GENERATED 컬럼 `scope_prompts.is_korean` | 0046 | PG 자동 | SA:1108 술어 | COPY/INSERT 시 컬럼 제외 필요 |
| ENUM 14종 (role, operator_scope, project_member_role/status, member_audit_action, prompt_source/type/status, standard_keyword_source, standard_source_channel, ai_provider, funnel_stage, mention_type, bff_audit_kind) | 0000-0008, 0013, 0033 | — | 열 타입 | 앤서 mig_src.sql 이 타입을 포함(`mig_src.prompt_type` 등) |
| 파티션 RANGE(cycle_week) 세부층 6표 + ACL 미상속 | 0059:85-173,246-271 | — | — | 위 참조 |
| REVOKE anon/authenticated (`scripts/db/lockdown.sql:16-17`) | Supabase 전용 | — | — | 비Supabase 에서는 무의미 |

---

## C. 불일치 목록 (S2W 판정 ≠ 앤서 3장)

| # | 테이블 | 앤서 | S2W | 근거 요약 |
|---|---|---|---|---|
| 1 | summary_cycles | 3-4 재계산 가능 | **이관 필수** | hidden_reason/hidden_at/hidden_scope(hide-cycle.ts:184,193; 0070:111-113), view_anchor_at 최초 노출 시각(swap.ts:97), closed_by/closed_at/sealed_units 마감 시점 스냅샷(SC:1547-1550), anchor_source='operator'(G/cycle.ts:26). 앤서 seed20:341-368 자신이 원천으로 씀 |
| 2 | summary_cycle_runs | 3-4 재계산 가능 | **이관 필수** | attributed_by 'late'/'operator'·synced_at_seen(SC:1475; G/cycle.ts:229); seed20:357-359 |
| 3 | scope_cycle_rounds | 3-4 재계산 가능 | **이관 필수** | 차례 배정·과거 미재계산(0077:517-519), 운영자 재배정(reassign-cycle-rounds.ts); seed20:329-331 |
| 4 | scope_answer_cycle_anchors | 3-4 재계산 가능 | **이관 권장**(덤프) | 재계산엔 함수 20여 종 + 입력 5종 필요; exp BIG 가 이미 내보냄 |
| 5 | scope_cycle_anchor_state / scope_cycle_registry_runs | 3-4 재계산 가능 | 선택(앵커 전수표와 묶음) | 파생 캐시이나 "손으로 고치지 않는다"(0078:159-160) — 전수표를 받으면 같이 받는 게 일관 |
| 6 | scope_answer_anchors / scope_answer_drops | 3-3 보류 | **이관 필수** | 코드 쓰기 0 = 전부 운영자 수작업 레지스트리(0053:112-126, 0054:80-90); 매 재싱크의 입력(SM:121,387); seed20:312-316 |
| 7 | qa_review_sessions / qa_answer_reviews / qa_review_notes | 3-3 보류 | **이관 권장** | 사람 입력 검수 이력(qa-review.ts:159,882,1068); 검수 콘솔 인수 시 필수 |
| 8 | member_audit_logs | 3-3 보류 | **이관 권장** | 142행, 화면 리더 있음(audit-log.tsx); 앤서 seed10:1226 이 이미 적재 |
| 9 | bff_audit_logs | 3-3 보류 | 조건부 권장 | 리더 없음(INSERT only) — 보존 의무 확인 전까지 덤프 보관 |
| 10 | scope_mentions / scope_mention_occurrences / scope_answer_stances / scope_acr_rollups | 3-4 검산용 덤프 | **이관 권장**(적재 가능 덤프, 전환일 직전) | HUB 시드가 `ing.mention/mention_occurrence/answer_stance/acr_*` 원천으로 씀(seed20:216-300) |
| 11 | summary_generations | 3-4 운영 내부 | **이관 권장**(활성 세대) | roster/base/target/noise 스냅샷은 재해석 방지용 입력 사본(hmg.ts:59-61); 앤서 exp `--frz frz_ops_generation` 이 이미 내보냄 — PDF 에 동결층(결정 32) 언급 자체가 없음 |
| 12 | summary 세부층·집계층 활성 세대 셀 | 3-4 "재계산 가능" 만 기재 | 동의(불요) + 문서 보완 요청 | 0080:19-21 "발행 시점≠생성 시점이면 값이 다르다" — 앤서 도구는 frz_ops_cell/prompt/answer/brand/sum_* 로 동결값을 뽑는데 PDF 3-4 는 이를 안 적음 |
| 13 | profiles | 3-2 이관 | 이관 필수 + 확인 | 앤서 seed10:25-27 "profiles 는 이관 대상이 아니다"(시스템 사용자 치환) — PDF 와 도구가 상충. auth.users 내보내기 별도 |
| 14 | project_members | 3-1 기존 목록 | 이관 필수 + 확인 | 앤서 verify-seed.sql:61 `app.project_member(미이관)` — 목록에는 있고 시드는 안 옮김 |
| 15 | scope_mirror_progress | 0행·폐기 | 불요(동의) 단 '폐기' 아님 | 현행 0073 벌크 싱크 상태표(progress.ts:128-299) |
| 16 | summary_ga4 | summary_* 재계산 가능 | 불요(미사용) | 쓰기·읽기 코드 0 — 스키마도 가져올 이유 없음 |
| 17 | scope_sync_cursors | 운영 내부 | 선택 | 앤서 seed20:458-462 가 `ing.sync_cursor` 원천으로 씀 |
| 18 | summary_settings | 운영 내부 | 선택 | `website_excluded_fs`(보고서 제외 유닛 71,94,97) 는 업무 규칙 — 값 인계 필요 |
| 19 | scope_prompts | 3-1 정본 질의 | 이관 권장 | 정본 Scope, 미러 사본 동봉. `is_korean` GENERATED 컬럼 제외 |

---

## D. 코드만으로 판정하지 못한 것

1. 실제 행 수(`count(*)`) — PDF 추정치만 있음. 3-1 24개는 행 수 자체가 문서에 없다.
2. `scope_context_*` 원 적재 스크립트가 리포에 없다(0027:1-6 "Scope 라이브 PG 직접") — Scope 측 코퍼스(industry 401) 현존 여부와 재추출 가능성 미확인.
3. `_bak_anchor_fold`·`crawl_*`·`webgeo_*`·`drizzle.__drizzle_migrations` — 코드에 정의 없음(라이브 전용), 내용 미확인.
4. summary 세부층 13주 보존(0059:7)의 실제 DROP 운영 — 코드에 자동 DROP 없음(`generate-cycle.ts:498,605` 는 "창 밖" 처리만). 과거 주 파티션이 실제로 남아 있는지는 라이브 확인 필요.
5. 앤서 `frz-import-ops`(back/ingest/frz) 가 `frz_ops_generation` 스냅샷을 HUB 판정에 실제 쓰는지 — DB-v2.21:5136-5200 선언만 확인, 적재기 본문 미정독.
6. bff_audit_logs 보존 의무 — 고객(HMG·이노션) 확인 사항.
7. `hmg_anchor_date` 의 읽기 시점 SQL 호출 — lib/period/day-arith.ts:41 은 주석(JS 짝). SQL 읽기 호출이 확인된 함수는 `hmg_anchor_week`·`hmg_round_canonical_dow`·`hmg_anchor_view_date`·`hmg_anchor_today`·`citation_url_norm`·`citation_url_base_norm` 6종.
8. 과제 지시문의 "schema.ts pgTable 28개" 는 실측 69개(여러 줄 `pgTable(\n "name"` 포함). 합집합 79개는 동일.
