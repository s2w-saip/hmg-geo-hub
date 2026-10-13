# C. 공개 테이블 밖의 이관 자산 검증 + 앤서 인수인계 PDF(2026-10-06) 사실 확인

작성 2026-10-07 · 읽기 전용 조사 · 표기: **사실**(코드·문서 줄 근거) / **추정**(근거로 추론) / **미확인**(확인 수단은 있으나 이번에 못 돌림)

경로 약어
- `front/` = `ROOT\hmg-geo-hub-share\front` (레거시 대시보드, 최신 브랜치)
- `arch/` = `ROOT\_archive\hmg-geo` (인수인계 zip 사본; `scripts/setup/**`, `scripts/reports/*.py` 는 여기에만 있음)
- `hub/` = `ROOT\hmg-geo-hub-share` (HUB; `back/db/DB-v2.32.sql`, `back/migration/**`, `docs/**`, `ANALYSIS-ENGINE-DESIGN.md`)
- `PDF` = 앤서 "S2W 전달 문서: AI 답변 데이터와 이관 대상"(2026-10-06) 텍스트 추출본 (`scratchpad/pdf/handover-data.txt`, 줄 번호는 추출본 기준)

비밀값은 적지 않는다(토큰·키·이메일·URL 값 없음, env **이름**과 위치만).

---

## 1. Supabase Auth — 계정 데이터의 소재와 이관 요건

### 1.1 profiles.id ↔ auth.users.id
- **사실** `profiles.id` 는 Supabase `auth.users.id` 와 같은 uuid 이지만 **FK 가 없다**(이식성 방침). `front/lib/db/schema.ts:48-56` ("id = Supabase auth.users.id … Deliberately NO hard FK to auth.users"), `front/lib/db/repositories/profiles.ts:157` ("No FK to auth.users"), 생성 DDL `front/lib/db/migrations/0000_mute_deathbird.sql:2-12`.
- **사실** role·scope(brands/regions/countries)·operator·menu_groups 는 전부 `profiles` 컬럼이며 `user_metadata`/`app_metadata` 에는 **아무것도 두지 않는다**. `schema.ts:49-51`, `front/lib/auth/session.ts:17-19` ("role + allowed scope from the server-controlled profiles table (NOT user_metadata)"). 컬럼 추가 이력: operator(`0013`), role 'vendor'(`0001`)·'website'(`0034`), menu_groups(`0039`).

### 1.2 계정 생성·로그인 경로
- **사실** 로그인 = `supabase.auth.signInWithPassword` (`front/lib/auth/actions.ts:23-27`), 세션 검증 = `auth.getClaims()`(JWT 로컬 검증, `session.ts:37-41`), 세션 저장 = httpOnly 쿠키(`front/utils/supabase/server.ts:5-8`, `@supabase/ssr`). DB 쪽 `auth.sessions`/`auth.identities`/`auth.refresh_tokens` 를 읽는 코드는 없다(front 전체 grep: `auth.users` 언급만 주석·admin 액션에 있음).
- **사실** 계정 생성 경로 3개:
  1. 관리자 콘솔 `createUser` 서버 액션 → Supabase **Admin API** `POST /auth/v1/admin/users`(`email_confirm:true`, 임시 비밀번호 생성) → `profiles` insert(기본 role 'country') → 실패 시 Admin API 로 롤백. `front/app/[locale]/(dash)/admin/_actions.ts:63-140`, `front/lib/supabase/admin.ts:36-61,118-129`.
  2. 초기 관리자 스크립트 `arch/scripts/setup/admin.ts:43-67` (`auth.admin.createUser` + `insert into public.profiles(... 'admin', scope_all true, operator 'global')`, `--promote-existing` 로 기존 Auth 계정 승격). `front/` 에는 `scripts/setup/` 이 없다(zip 전용).
  3. 데모 시드 `front/scripts/db/seed.ts`(비밀번호는 env `SEED_PASSWORD`, `.env.example` 끝부분).
  - HGH 전환 플래그 `HGH_SOURCE_G7=api` 이면 백엔드가 같은 일을 한다(`_actions.ts:66-69,78-91`; HUB `back/app/core/config.py:35` `HGH_SUPABASE_URL·HGH_SUPABASE_SERVICE_ROLE_KEY` "계정 관리(Supabase Admin)").
- **사실** 관리자 목록 화면은 `profiles` + Admin API `GET /auth/v1/admin/users?per_page=200` 의 `created_at·last_sign_in_at` 를 조인해 보여준다(`admin.ts:85-113`, `admin/_components/user-list.tsx:9-35`). 즉 "마지막 로그인" 은 **auth 스키마에만** 있다.
- **사실** 비밀번호 재설정·초대 메일 흐름은 없다(front grep `resetPasswordForEmail|inviteUserByEmail|generateLink` 0건; HUB 도 "Q16: 비밀번호 재발급 미도입" `hub/docs/design/taxonomy/build_taxonomy.py:100`).

### 1.3 project_members 초대 토큰
- **사실** 초대 토큰 없음. `project_members` 는 (project_id, user_id, role, status pending|active, invited_by, invited_at, accepted_at) 뿐(`0002_public_hammerhead.sql:3-12`, `schema.ts:242-273`). 초대는 "이미 존재하는 사용자만" 가능(`profiles.ts:90-94` getByEmail 주석). 이력은 `member_audit_logs`(`0006`).

### 1.4 HUB 쪽 계정 모델
- **사실** HUB 도 Supabase Auth 를 IdP 로 유지한다: `HGH_JWKS_URL`(Supabase JWKS)·`HGH_JWT_AUDIENCE`·`HGH_JWT_ISSUER` (`hub/back/app/core/config.py:14-16`), `app.user_account.user_id = JWT sub = legacy profiles.id`(`front/lib/hgh/adapters/session.ts:8`). DDL `hub/back/db/DB-v2.32.sql:101-111` (`app.user_account`: user_id, email citext, display_name, role, operator, scope_all, scope_brands/regions/countries, menu_groups, is_qa_reviewer, status, row_version).
- **사실** HUB 이관 시드는 **profiles 를 옮기지 않는다**: `hub/back/migration/seed/seed-10-app.sql:26-29` ("profiles 는 이관 대상이 아니다 … 시스템 사용자로 채운다 … 추후 profiles 이관 시 연결"), `hub/back/migration/export.py:21-37` SMALL 목록에 `profiles` 없음, `mig_src.sql` 에도 없음.

### 1.5 계정 이관에 필요한 것 (판단)
| 시나리오 | 필요한 것 | 근거/표기 |
| --- | --- | --- |
| 같은 Supabase 프로젝트 유지(HUB 현 설계) | auth 쪽 이관 없음. `profiles`(128행) → `app.user_account` 매핑 1회(역할·범위·menu_groups) + `project_members`·`member_audit_logs`·`*.created_by/invited_by/actor_id/changed_by` 의 uuid 를 **그대로** 보존 | 사실(1.4) |
| 다른 Supabase 프로젝트로 이사 | `auth.users` 를 **DB 수준**으로 내보내야 한다(id·email·encrypted_password 해시·email_confirmed_at·last_sign_in_at). Admin API 는 비밀번호 해시를 주지 않으므로 pg_dump(auth 스키마) 또는 Supabase 지원 경로 필요. **uuid 를 보존**해야 profiles·project_members 등 FK 없는 참조가 살아남는다 | 추정(절차는 리포 밖) |
| 다른 IdP(Azure Entra 등) | 비밀번호 해시 재사용 불가 → 전원 재등록 또는 매직링크. 유지할 데이터는 `profiles` 의 role·scope·operator·menu_groups 와 uuid 매핑표뿐 | 추정 |
- **이관 항목 추가 여부**: PDF 3-2 의 `profiles 128` 외에 **`auth.users` 자체**(해시·확인시각·마지막 로그인)와 **uuid 보존 규칙**을 항목으로 추가해야 한다. 초대 토큰·세션·identities 는 없음(추가 불요).

---

## 2. GA4 — 자격증명·설정·수집 데이터의 소재

### 2.1 OAuth 자격증명 위치
- **사실** env 3개(서버 전용): `GA4_OAUTH_CLIENT_ID`, `GA4_OAUTH_CLIENT_SECRET`, `GA4_OAUTH_REFRESH_TOKEN`; 폴백으로 파일 `.ga4-token.json`(gitignored) 의 `refresh_token`. `front/lib/ga4/auth.ts:13-39`, `.env.example` GA4 절, `.gitignore`("GA4 OAuth token cache … contains a refresh token"). 파일은 `scripts/ga4/probe.ts:31,63-71` 이 대화식 인증 후 쓴다. **DB 에는 없다**.
- **사실** 주체는 "사용자 계정" OAuth(Desktop app 클라이언트, 대화식 승인)이며 계정 교체는 토큰 파일 삭제로 한다(`probe.ts:666`). 속성 접근은 "OAuth 계정의 뷰어 권한" 으로 게이트된다(`0017_project_ga4_property.sql:9-10`, `0036_ga4_properties.sql:7`).
- **사실** GSC 도 같은 패턴(`.gsc-token.json`, `.gitignore`).
- HUB 는 `HGH_GA4_CREDENTIALS_JSON`(service_account 또는 authorized_user JSON, `config.py:36`) 으로 바뀐다 → S2W 는 **자기 주체를 새로 만들고 HMG 가 속성마다 뷰어를 부여**해야 한다(추정: 앤서 계정의 refresh token 은 이관 대상이 아니고 이관해서도 안 됨).

### 2.2 설정 테이블
- **사실** `ga4_properties`(brand, country_code, property_id NULL 허용, status active|pending_grant|unmapped, granted_at, verified_at, created_by) `0036:13-31`, `schema.ts:1534-1552`. `ga4_tracked_events`(property_id, event_name, created_by) `0037:13-22`. `projects.ga4_property_id`(프로젝트 오버라이드) `0017:12`. 해석 순서 = DB 레지스트리 우선, 없으면 코드 상수 MAP(Kia/IT → env `GA4_PROPERTY_ID_KIA_IT`, 구 `GA4_PROPERTY_ID`) `front/lib/ga4/property-map.ts:37-48,59-80`.

### 2.3 수집(pulled) 데이터
- **사실** 런타임 KPI 는 GA4 Data API `runReport` 를 직접 부르고 결과를 Next `unstable_cache`(24h, 태그 'ga4') 에만 둔다. `front/lib/ga4/client.ts:22-48`, `front/lib/ga4/conversion.ts:11-12,513-516,640-643,680-683,801-804,841-844`. DB 쓰기(`getDb/insert`) 없음.
- **사실** `ga4-prebuild` 크론(매일 18:00 UTC, `vercel.json:11`)은 매핑된 시장을 돌며 캐시를 데워 둘 뿐이다(`app/api/cron/ga4-prebuild/route.ts:12-22`).
- **사실** `summary_ga4` 표는 존재하지만(`0059_summary_tables.sql:175-182` "1차 롤아웃에서는 비어 있음") **쓰는 코드가 없다**(front 전체 grep: 마이그레이션 1건만). → **추정** 운영 행 수 0.
- **사실** 따라서 "summary_ga4 재계산" 문제는 없고, GA4 수치는 **GA4 에 다시 질의해야만** 나온다. 질의 가능 조건 = 새 OAuth/서비스 주체가 해당 property 에 뷰어 이상 권한을 가짐(2.1). HUB 는 원본 행을 `ing.ga4_pull/ing.ga4_row`(`DB-v2.32:363-367`)·`rd.ga4_row`(`:681-685`) 로 적재하도록 재설계(G-12 (a), `DECISIONS.md:215-224`).
- 과거 GA4 CSV 내보내기(`scripts/ga4/export-raw.ts`, `export-activeusers.ts`)의 산출물은 `docs/data/2-extract/ga4`(gitignored, `scripts/paths.json`) → 리포에 없음(**미확인** 보관 여부).

### 2.4 "측정 대기(pending) 시장" 데이터
- **사실** 저장 데이터가 아니라 계산값: `resolveProperties` 가 카탈로그 (brand,country) 중 `propertyId === null` 인 항목을 돌려주고 화면이 "측정 대기 N국" 으로 센다(`property-map.ts:25-29,99-102`). DB 측 근거는 `ga4_properties.property_id IS NULL` + `status`('pending_grant'/'unmapped') 행(`0036:17-18`).
- **사실** HUB 는 이를 별도 표 `app.ga4_market_pending` 로 옮긴다(`DB-v2.32:2167-2185`: `mig_src.ga4_properties` 중 property_id NULL 행을 INSERT). PDF 3-2 의 `ga4_properties 1행` 이 맞다면 pending 집합은 최대 1건(추정).
- **이관 항목**: `ga4_properties`·`ga4_tracked_events`·`projects.ga4_property_id` 는 이미 PDF 3-2 에 있음. 추가로 **(비데이터) GA4 접근 주체 교체·속성 뷰어 부여 목록**을 항목에 넣어야 한다. OAuth 토큰·client secret 은 이관 대상 아님.

---

## 3. 발행 리포트 — report_* 3표와 산출물 파일의 소재

### 3.1 세 표의 내용
- **사실** `report_publications` = 발행물 1건 1행: slug, surface('website' 만), brand_scope, volume, version, title, cycle_label(ko/en), round_date(회차 라벨, **측정일 아님**), prev_round_date, asof_cur/asof_prev(추출 시점), published_on, engines[], excluded_fs[], bench_n/bench_n_all, src_cite, **source_filename, source_sha256**, manifest_verified, verify_note, sb_data_version('vol2'), status(active|superseded|rolled_back), superseded_by, ingested_at. `0080_report_publications.sql:55-101`, `schema.ts:1706-1748`. **파일 경로·URL 컬럼은 없다** — 파일 신원은 `source_filename + source_sha256` 뿐(`0080:86-87`).
- **사실** `report_site_facts` = (publication_id, file_seq) 당 정수 쌍: target_hit_prompts/measured_prompts, owned_prompts/owned_prompts_den, owned_answers/monitored_answers, prompts, answers, prev_* 4종, brand/country_code/country_name/region_label/lang_code/lang_label/agency_status, in_headline_pool, **raw jsonb(sb-data 의 사이트 객체 원본)**. `0080:126-178`. 백분율은 저장하지 않는다(`0080:124-125`).
- **사실** `report_site_engine_facts` = (publication_id, file_seq, engine) 당 target_hit_prompts·prev. **분모 없음**, Σeng ≠ c6 이라 엔진 필터에는 못 쓰고 감사용(`0080:185-203`).
- **사실** 원천은 발행 HTML 안 `<script id="sb-data">` 이며, **통합 리포트(vol.2) 생성기는 리포에 없다** — "발행물 자체가 유일한 원천"(`front/lib/reports/sb-data.ts:4-7`). 적재 CLI `front/scripts/reports/ingest-publication.ts`(`npm run report:ingest`, `package.json:50`), 파일명 파서 `lib/reports/publication-meta.ts:22-31`(예: `HMG-GEO-geo_report_vol.2_v3.0_Global_20260915.html`). 검수 매니페스트 `docs/data/.verify-manifest.json`(`ingest-publication.ts:43`).

### 3.2 생성 스크립트와 출력 경로 (arch 에만 있음)
- **사실** 사이트별 인용 리포트 v1.1 생성기 `arch/scripts/reports/gen-citation-reports.py:5-8,27,472` → `docs/data/3-publish/citation-v1.1_{date}/HMG-GEO_{seq}_{KO|EN}_{base}_{lang}_citation_v1.1_{date}.html`, 템플릿 `arch/scripts/reports/templates/citation-v1.1.html`, 로고 `docs/assets/logos`. 경로 정본 `arch/scripts/paths.json`(data=`docs/data`, source=`1-source`, extract=`2-extract`, publish=`3-publish`, archive=`4-archive`, manifest=`docs/data/.verify-manifest.json`).
- **사실** `arch/scripts/reports/verify-artifacts.py:2-11,24-27` 는 "통과해야 **컨플루언스 업로드** 가능", `confluence-sync-attachments.cjs` 가 매니페스트 해시로 업로드를 막는다고 적혀 있다. 그 `.cjs` 는 **front/arch 어디에도 없다**(grep 0건). 검수 항목 D 가 "HTML/PDF 쌍" 을 본다 → PDF 도 생성되지만 변환기는 리포에 없다(**미확인**).
- **사실** `docs/data/**` 는 `.gitignore`("데이터·산출물 루트") 로 추적 제외이고 front/arch 어느 쪽에도 디렉터리가 없다(ls). 리포에 남은 발행 데이터 사본은 테스트 픽스처 `front/lib/reports/__fixtures__/sbdata-vol2-global-20260915.min.json`(축약본) 뿐.
- **사실** `front/scripts/reports/report-spec.json` = 사이트·언어 조합 110건 정의(`verify-artifacts.py:27` CANON_TOTAL=110) — 이것은 리포에 있다.

### 3.3 전달된 산출물의 실제 위치 (판단)
- **추정** 발행 HTML/PDF 원본은 (a) 앤서 작업자 로컬 `docs/data/3-publish/…`, (b) 업로드된 Confluence(문서들이 참조하는 GVN/GGMD 페이지, `front/docs/kpi-menu-mapping.md:3,117`, `ggmd-policy-decision-report.md:5` — 고객측 Confluence 로 보임) 두 곳. **S3·DB·리포에는 없다**.
- **사실** `report_site_facts.raw` 로 sb-data 는 복원되지만 HTML 자체·제목·PDF 는 복원 불가.
- HUB 는 `app.report_publication`(rcache 추적 표, `DECISIONS.md:540`)·`rd.report_unit_value`(R09 발행값 우선) 로 같은 3표를 이어받고 `export.py:31` 이 3표를 추출한다.
- **이관 항목 추가**: PDF 3-2 의 3표 외에 **발행 산출물 파일 묶음(`docs/data/1-source`·`2-extract`·`3-publish`·`4-archive`·`.verify-manifest.json`)과 Confluence 첨부 위치**를 "파일 자산" 항목으로 추가해야 한다. vol.2 생성기 소스가 앤서 워크스페이스 어디에 있는지도 확인 필요(**미확인**).

---

## 4. S3 / 오브젝트 스토리지

### 4.1 레거시(front) — 오브젝트 스토리지 사용 없음
- **사실** 의존성에 S3/Blob SDK 없음(`front/package.json:64-76`: supabase, google-auth-library 뿐). `s3://|aws-sdk|S3Client|@vercel/blob|supabase.storage` grep 0건("bucket" 은 추이 차트 버킷 용어뿐).
- **사실** `crawl_pages`·`crawl_links`·`webgeo_*` 는 `schema.ts` 에 없고 `front/scripts/db/drift-sql.ts:47-48` 가 "별도 파이프라인 소유" 로 제외한다. `lib/geo-catalog` 의 `webgeo_final_list.xlsx` 는 정적 카탈로그(`lib/geo-catalog/README.md:6`)로 무관.
- **사실(HUB 실측 2026-09-27)** 라이브 DB 에 `crawl_pages` 3,947MB/57.3K행, `crawl_links` 2,070MB/4.1M행, `webgeo_page_seo` 516MB/39K행, `webgeo_pages` 416MB/36K행, FK `webgeo_pages.raw_html_path → webgeo_raw_html_objects`, 4표에 RLS 켜짐(`hub/docs/research/03-db-live-catalog.md:12,41-50,148,156-163`). 즉 **원시 HTML 은 S3 가 아니라 DB 표(`webgeo_raw_html_objects`)** 에 있다(그 표 크기는 **미확인**).
- ⚠ **PDF 와 불일치**: PDF 3-4(`handover-data.txt` "0 행 · 폐기: … crawl_links, crawl_pages, webgeo_* 6 종", "라이브에만 있고 … 전부 0 행") 는 2026-10-06 `n_live_tup` 기준인데, 2026-09-27 HUB 실측은 수만~수백만 행·6GB 다. 그 사이 TRUNCATE 됐거나 통계가 0 으로 초기화된 것 중 하나 → **미확인**, `count(*)`·`pg_total_relation_size` 로 재확인 필요. 0행이 맞아도 6GB 의 힙이 남아 있을 수 있다.

### 4.2 HUB — S3 의 실제 용도와 소유
- **사실** 버킷 `hmg-geo-hub-<env>-artifacts-<계정ID>-apne2`, 리전 ap-northeast-2, 퍼블릭 차단·SSE-AES256, EC2 롤에 Get/Put 허용. `hub/infra/20-iam-s3.sh:7-19,30-32`. AWS 프로파일 `scope`(`hub/infra/lib.sh:4-5`) → **앤서(Scope) AWS 계정 소유**(사실: 프로파일명 기준; 계정 ID 는 리포에 없음).
- **사실** 버킷 내용물(코드 기준): `ddl/`(DB-v2.1.sql·rds-prelude·mig_src.sql), `snap/<table>/*.csv.gz`(Supabase 미러·업무 표 스냅샷, `export.py` 산출), `results/s8/`. `hub/back/migration/s9-load.tpl.sh:14,33`, `hub/infra/ops/s8-apply.tpl.sh:6,30`. 스냅샷 대상 표 = `export.py:18-37` BIG 6 + SMALL 46(여기에 report_* 3표·scope_context_* 6표·ga4_* 2표·qa_* 3표 포함, **profiles·crawl_*·webgeo_* 제외**).
- **사실** "crawl·webgeo S3 보관" 은 결정 G-13(`hub/docs/design/db/DECISIONS.md:226-240`: "crawl_* 참조 0건 … 폐기 금지")과 Q14(`DB-v2.32.sql:910-912`, `docs/design/api/DECISIONS-API.md:20`: "두 계열 모두 S3 보관(mig.archive_manifest), 새 DB·API 없음"), 단계 S11 "WG-1 표 S3 보관"(`docs/design/api/전체-통합.md:163`).
- **사실** `mig.archive_manifest`(object_name, kind ∈ table|function|cron|runner|s3_table, rows, bytes, dump_uri, format, sha256, ddl, archived_at, dropped_at, retention_until) `DB-v2.32.sql:786-788`. 그러나 **INSERT 하는 스크립트·행이 리포에 없고** `export.py` 도 crawl/webgeo 를 내보내지 않는다 → 보관은 **계획 단계**(미확인/미구현). 명시된 아카이브 객체는 `archive.bak_anchor_fold`(= 레거시 `_bak_anchor_fold` COPY, `DB-v2.32:789`) 하나.
- **이관 항목 추가**: (1) S2W 가 Supabase 스냅샷(`snap/`)을 받으려면 앤서 계정 버킷 접근 또는 사본 전달이 필요 — 새 항목. (2) `crawl_*`/`webgeo_*`(+`webgeo_raw_html_objects`) 는 소비처 0 이라 PDF 의 "폐기" 가 합리적이나 **행 수 불일치(4.1)** 를 먼저 풀고, 필요 시 S3 아카이브가 아직 없으므로 pg_dump 로 받아야 한다.

---

## 5. Scope 코어에만 등록된 데이터 (Supabase 에 없는 것)

레거시가 Scope `/api/v1` 에 쓰는 경로(`front/lib/scope/http.ts:124-250`): projects CRUD, `projects/{id}/prompts` CRUD, `projects/{id}/schedule` GET/PUT, `projects/{id}/measurements[/{run}/jobs]`, `/query/{job}`. 클라이언트 계약 `front/lib/scope/client.ts:49-123`.

| 항목 | Scope 에만 있는 것 | HMG DB 가 가진 것 | 근거 |
| --- | --- | --- | --- |
| 프로젝트 | 루트(표준 카탈로그) 프로젝트 1 + 웹사이트 사이트별 프로젝트(Genesis SA 3도시 공유) + 고객 프로젝트 미러. Scope 측 필드: name, domain(host), **tracked_brands(brand_name, alternative_names, aliases)**, regions, **acr_iterations**(프로젝트 설정, 기본 10) | `projects.scope_project_id`, `website_sites.scope_project_id`, env `SCOPE_ROOT_PROJECT_ID`·`SCOPE_EXTRA_PROJECT_IDS` (id 만) | `project-sync.ts:67-80,132-136`, `schema.ts:91-100,1328-1340`, `0056:12-16`, `types.ts:95-106`, `docs/scope-api-integration.md:55-56`, 인터페이스 §3.1 |
| 프롬프트 | text, funnel_stage, **keywords(`hmg:brand:`/`hmg:category:`, 웹사이트는 target_url)**, **kind single/acr**, **enabled**(소등), active(soft-delete), regions, lang, created_at, updated_at | `scope_prompts`(prompt_id,text,funnel_stage,is_korean,lang,regions 만), 로컬 카탈로그 `prompts`(kind, scope_prompt_id)·`website_prompts.scope_prompt_id`·`standard_prompts` | `types.ts:115-165`, `schema.ts:1214-1253`, `0025:7-9`, `push-website-scope.ts:10`, `push-standard-split.ts:1-30` |
| 멀티턴 문안 | ACR 2턴째 질문("하나만 골라") 문안과 턴별 prompt_text/answer_text — Scope 코어만 보유. 단일턴 프롬프트 문안도 job 목록에는 없음 | 없음(`scope_answers.answer_text` = job 단위 1값) | `docs/scope-api-integration.md:55`, 인터페이스 §6.1 turns[], `ANALYSIS-ENGINE-DESIGN.md:106,299-300,582`(S-A1) |
| 스케줄 | {enabled, interval_days, targets, regions, prompt_ids, created_at} | `projects.ai_engines` + `project_engine_history`(targets 의 로컬 정본), 웹사이트는 interval 7 상수 | `types.ts:199-226`, `project-sync.ts:162-198`, `push-website-scope.ts:9-21` |
| 실행·반복·턴 | run 의 trigger/targets/regions/completed_jobs/failed_jobs, **prompt_run_id·iteration_index·turn_index·turn_id**, 응답 원본(6.2) | `scope_runs`(status, started/completed_at, total_jobs, project_id, cycle_anchor_at), `scope_answers`(job 1행), `scope_acr_rollups`(prompt_run_id 롤업만) | `schema.ts:682-711,791-808`, `0025:16-47`, 인터페이스 §5·§6 |
| 엔티티 카탈로그 | 온톨로지 전체(엔티티·별칭 정책·관계·grouping·tracked augment·industry id) | `entity_registry`(자사만, `0023`), 언급 행의 entity_id | `ANALYSIS-ENGINE-DESIGN.md:321-328,583`(S-A2 **블로커**) |
| 분석 옵션·모델 | 프로젝트별 라이브 옵션 | 없음 | `ANALYSIS-ENGINE-DESIGN.md:328,584`(S-A3 블로커) |
| 컨텍스트 맵 코퍼스 | 236,781 발화 원본 | `scope_context_*` 2026-07-07 정적 스냅샷(8절 (f)) | `schema.ts:1380-1387` |
| 소유 base | **Scope 에 없음**(domain host 만 보냄) | `project_owned_bases`(`0021`), `website_prompts.owned_base_url`(`0049`) | `project-sync.ts:70-74` |

- **S2W 가 Scope 에서 받아야 할 것(판단)**: ① 프로젝트 전량(id·tracked_brands 별칭·regions·acr_iterations·domain) ② 프롬프트 전량(keywords·kind·enabled·active·regions·lang·시각 — `scope_prompts` 미러는 손실본) ③ 스케줄 전량 ④ 반복·턴 단위 원문(인터페이스 §6 신설분, 과거분 포함 여부 = C1) ⑤ 엔티티 카탈로그(S-A2) ⑥ 분석 옵션(S-A3). ①~③ 은 HMG DB 의 `scope_*_id` 로 대조 가능(`scripts/scope/verify-prompt-regions-mirror.ts`, `check-scope-projects.ts`).
- **이관 항목 추가**: PDF 는 Scope 측 등록 데이터를 "공급 DB" 로만 다루고 **프로젝트 설정·프롬프트 메타(keywords/kind/enabled)·스케줄·acr_iterations** 를 항목화하지 않았다 → 추가 필요. 파트너 키 전환 시 기존 HMG 워크스페이스 프로젝트 id 가 그대로 보이는지(C5)도 확인 항목.

---

## 6. 크론·배치 상태

### 6.1 스케줄 (사실)
| 위치 | 잡 | 주기 | 근거 |
| --- | --- | --- | --- |
| Vercel(icn1) | `/api/cron/sync-mirror`(회차 관제 → 미러 증분 동기화 → 고아/절단 감시 + 앵커 따라잡기) | `*/20 * * * *` | `front/vercel.json:9-13`, `sync-mirror/route.ts` 헤더 |
| Vercel | `/api/cron/ga4-prebuild`(GA4 캐시 워밍 + 회차 사슬 교차확인) | `0 18 * * *` | 같음, `ga4-prebuild/route.ts:12-35` |
| Vercel | `/api/cron/cycle-chain-watch`(노출 지체 Slack·생성 적체 GitHub Issue·URL 히트 커버리지·앵커 공백) | `0 */6 * * *` | `cycle-chain-watch/route.ts` 헤더 |
| EC2 러너(ap-south-1) systemd | `hmg-summary.timer` → `run-generate.sh` → `summary:generate --pending --yes --revalidate`(global 2묶음·website 1묶음/틱) | `*:00,30` +≤180s | `front/ops/summary-runner/hmg-summary.timer:7-9`, `hmg-summary.service:27-35`, `run-generate.sh:111-126` |
| EC2 러너 | `hmg-mirror.service` → `run-mirror.sh` → `scripts/scope/mirror-worker.ts --watch --discover --budget-ms=180000`(벌크 미러 소비자) | 상시(Restart=always) | `hmg-mirror.service:9-25`, `run-mirror.sh:38-39` |
| EC2 러너(수동/일 1회) | `npm run mirror:reconcile`(전체 대조·워터마크 재설정) | 하루 1회 권장 | `scripts/scope/mirror-reconcile.ts:1-14`, `docs/mirror-incremental-sync.md:79-81` |
| EC2 러너 | `hmg-runner-failure@` → Slack 웹훅(Secrets Manager us-west-2) | 실패 시 | `README.md:17-29` |
- **사실** 러너 비밀은 AWS Secrets Manager(**us-west-2**)에서 인스턴스 롤로 직독(`run-generate.sh:25,50-65`, `run-mirror.sh:15-28`); HUB 인프라는 ap-northeast-2 `scope` 프로파일 → 러너 계정/리전이 HUB 와 다르다(소유 계정 **미확인**, 앤서로 추정).
- **사실** `.env.example` 의 `MIRROR_BULK_ENABLED`, `MIRROR_DISCOVERY_STATE_PATH`, `MIRROR_DISCOVERY_BUDGET_MS`, `HMG_INTERNAL_BASE_URL`, `CRON_SECRET`, `SCOPE_*`, `GITHUB_ALERT_*`, `SLACK_ALERT_WEBHOOK` 이 크론·러너 배선 env 다.

### 6.2 상태 파일 (사실)
- `/var/lib/hmg-runner/mirror-discovery-state.json`(벌크 디스커버리 체크포인트, rename 원자 교체) `front/lib/scope/mirror/bulk-discovery.ts:9,130-137`; 락 `hmg-mirror.lock`/`hmg-summary.lock`(`run-mirror.sh:12`, `run-generate.sh:24,47`).
- 개발 PC: `.ga4-token.json`, `.gsc-token.json`(2.1).
- HUB 인프라: `hub/infra/state.<env>.env`(`lib.sh:10`, ARN·id 포인터, 커밋 제외 `hub/.gitignore`), EC2 적재 재개 마커 `/opt/hmg/s9/done/*`(`s9-load.tpl.sh:6,37`).

### 6.3 DB 상태 표와 "재개에 필요한가"
| 표 | 의미 | 없으면 | 근거 |
| --- | --- | --- | --- |
| `scope_sync_cursors`(0043) | 프로젝트별 **마지막 시도 시각**(로테이션 공정성 키) + last_error | 로테이션 순서가 초기화될 뿐, 데이터 손실 없음 | `0043:4-21`, `schema.ts:713-736`, `sync.ts:894-958` |
| `scope_sync_watermarks`(0082) | 프롬프트 `updated_from` 워터마크 + 이어읽기 커서, run 목록 정착 경계(floor run id 5개·스냅샷 시각) | "표가 없으면 종전 **전량 읽기**", 읽기·쓰기 모두 생략 → 정확성은 유지, 루트는 예산 초과로 크론이 run 쓰기 단계에 못 갈 수 있음; `mirror:reconcile` 1회가 다시 세움 | `0082:6-22`, `sync.ts:400-409`, `docs/mirror-incremental-sync.md:11,66-72` |
| `scope_mirror_progress`(0073) | run 단위 재개 체크포인트(phase/cursor/state) | 중단된 run 을 처음부터 다시 당김 | `0073:1-26` |
| `summary_settings`·`summary_generations`·`summary_url_hit_generations` | 읽기 킬스위치·세대 원장 | summary 층 자체가 HUB 에서 폐기(D8) | `0059:51-77`, `0081:65` |
| `scope_cycle_anchor_state`·`scope_cycle_registry_runs`·`scope_cycle_rounds`·`scope_answer_cycle_anchors` | 회차 해소 캐시(함수가 재계산) | `refresh_answer_cycle_anchors` 로 재생성 | `0078:1-30` |
- **판단**: S2W 가 Scope 에서 직접 당기면(HUB 는 `ing.sync_cursor` 를 따로 둠, `DB-v2.32:262`) 위 상태 표는 **이관 불요**. 증분 재개용이지 데이터 정본이 아니다. HUB `export.py:27-28` 가 `scope_sync_cursors`·`scope_mirror_progress` 를 복사하는 것은 대조용. PDF 3-4 "운영 내부" 분류는 타당(사실).

---

## 7. 레거시 PostgreSQL 함수·트리거 목록과 HUB 처리

- **사실** 트리거는 **0개**: `front/lib/db/migrations/*.sql`·`scripts/db/*.sql` 에 `CREATE TRIGGER` 없음(grep; 유일한 매치는 테스트 파일명/주석). 생성 컬럼 1개: `scope_prompts.is_korean GENERATED ALWAYS AS (text ~ '[가-힣]') STORED`(`0046`, `schema.ts:1221-1226`). HUB 의 트리거(rcache.tg_bump 104개, ua_last_admin, app.tg_append_only `DB-v2.32:99`)는 HUB 자체 설계.

| 함수 | 생성 마이그레이션 | 호출처(레거시) | HUB 처리 | 근거 |
| --- | --- | --- | --- | --- |
| `citation_url_norm(text)`, `citation_url_base_norm(text)`, `citation_url_host(text)` (IMMUTABLE SQL) | `0052_scope_citations_url_norm.sql:81-97` | 싱크 삽입 시 `url_norm/url_host/url_base_norm` 채움, 백필 `scripts/db/backfill-citation-norm.ts`; 신규 환경은 `scope-mirror.sql` + 0052 함께 적용 필요 | **재구현**: `rd.report_url_norm(text)` "현행 summary_report_norm = citation_url_norm 과 같은 식", `rd` 의 url_norm/url_base_norm 열 | `scope-mirror.sql:53-57`, `DB-v2.32.sql:418,3720,3773` |
| `scope_anchor_fold(timestamptz, date)` STABLE | `0053_scope_answer_anchors.sql:59-65` | `anchorReapplySql`(재싱크마다 measured_at 날짜부를 앵커로) `front/lib/db/repositories/scope-mirror.ts:117-127`; 수동 접기 절차 | **재구현(의미 변경)**: `rd.rep_order_at(p_ts, p_mirror_at, p_pin_anchor)` 같은 식, `ing.answer_anchor_pin` 레지스트리, 원본 measured_at 은 **덮지 않음**; 재현 안 되는 166행은 `ing.answer_mirror_time` 예외표 | `DB-v2.32.sql:325,4742,4788-4797,4944-4949` |
| `scope_answer_drop_apply(uuid)` plpgsql | `0054:51-72` → `0072_scope_answer_stances.sql:86-105`(stances 삭제 추가) | `dropReapplySql`(`scope-mirror.ts:143-145`), 수동 드롭 절차(`0054:76-90`) | **재구현(삭제→제외)**: `ing.answer_drop` + `rd.job` LEFT JOIN 제외; 허브 대응 주석 명시 | `DB-v2.32.sql:327,6403-6404`, PDF 2.2 |
| `summary_report_norm(text)` = citation_url_norm 위임 | `0060_summary_report_unit_flags.sql:23-26` | summary 생성기(프롬프트 차원 report NORM) | `rd.report_url_norm` 로 흡수 | `DB-v2.32.sql:3720` |
| `summary_ensure_cycle_gen_stats()` | `0062_summary_cycle_gen_stats.sql:34` | summary_* 확장 통계 생성(파티션 생성 시) | **폐기**(HUB D8: 요약 층 없음) | `0062:25-33`, `DECISIONS`/전체-통합 "D8" |
| `summary_ensure_week_partitions(date,date)` | `0064_summary_cycle_ops.sql:59` | 세부층 주 파티션 생성 | **폐기** | `0064:58-70` |
| `hmg_anchor_timezone/_date/_today/_utc_midnight/_week/_month`, `hmg_round_canonical_dow/_prev_canonical/_next_canonical`, `hmg_anchor_default_engines/_is_pinned/_keep_existing/_view_date`, `hmg_round_date_of`, `hmg_assign_cycle_rounds`, `hmg_propagate_cycle_rounds`, `refresh_answer_cycle_anchors(uuid[],uuid)` | `0077_scope_answer_cycle_anchors.sql:83-893`(표 `scope_answer_cycle_anchors`:448, `scope_cycle_rounds`:527) | `scope-mirror.ts:93,155,174`, `scope-answer-anchors-catchup.ts:32`, `summary-cycles.ts`, `lib/summary/cycle-control.ts:224` | **재설계(이식 아님)**: 회차 원장을 `ing.cycle/cycle_round/cycle_run/cycle_unit/cycle_gate`+`rd.cycle` 로 새로 만듦; `hmg_*` 이름은 DB-v2.32 에 0건 | `DB-v2.32.sql:329-353,2916-2924`; `0077:55-110`(KST 상수 한 곳) |
| `hmg_cycle_key(...)`, `hmg_refresh_cycle_registry_runs(uuid[])`, `hmg_prune_cycle_registry_runs(text[])`, `hmg_propagate_cycle_rounds`(교체), `hmg_sync_cycle_anchor_state(...)`, `refresh_answer_cycle_anchors`(교체) | `0078_answer_cycle_anchor_hot_path.sql:145-711`(표 `scope_cycle_anchor_state`:168, `scope_cycle_registry_runs`:231) | 같음 | 같음 | `0078:1-30` |

- **사실** `mig.archive_manifest(kind='function')` 는 함수 보관 슬롯으로 정의돼 있으나(`DB-v2.32:786`) 적재 행·스크립트가 리포에 없다 → 함수 아카이브는 **미확인(미구현)**. 명시 보관은 `archive.bak_anchor_fold`(pg_dump 정의 그대로 + COPY, `:789`) 뿐.
- **판단**: 레거시 DB 를 pg_dump 로 통째 받으면 함수는 따라온다. 새 DB 에 필요한 것은 ① URL 정규화 3함수(KPI 정의) ② 앵커 접기 식 ③ 드롭 의미(삭제 vs 제외) ④ 회차 타임존 상수(`hmg_anchor_timezone` = 'Asia/Seoul', `0077:83-87`) 네 가지 **정의**이며 HUB 에 참조 구현이 있다. 이관 항목: "함수 정의 4종의 의미 보존" 을 명시(데이터 아님).

---

## 8. PDF 사실 확인

### (a) N3 "ACR 답변은 대표 1건으로 접힌다, iteration_index·prompt_run_id·turn_index 없음"
- **사실(대체로 맞음)**. `scope_answers` 컬럼 = job_id, run_id, prompt_id, target, region, status, measured_at, model_slug, answer_text(`scope-mirror.sql:15-25`, `schema.ts:791-808`, 삽입 `sync.ts:1659-1669`) — 세 컬럼 없음. 접기 = `foldKeyForJob`/`dedupeAcrIterationJobs`(`front/lib/scope/mirror/sync.ts:1327-1403`; PDF 의 1330~1375 와 일치). 규칙: ① `analysis.acr_summary.prompt_run_id` 가 있으면 그 키로 접고 완료 우선·최신 measured_at 대표 ② **미완료** job 만 형제 pr 또는 (prompt,target,region) 셀 키로 접음 ③ **완료됐는데 acr_summary 가 없는 job 은 접지 않고 통과**(`:1356-1370`). 적용 지점 `sync.ts:2132-2134`.
- **정정 1**: PDF `answer_text` "추정: 멀티턴이면 마지막 턴" 은 코드 주석과 어긋난다 — 미러는 "대표 **turn1** 답변 1개"(`sync.ts:1332-1333`), 타입도 "single-turn query run"(`types.ts:504-511`). → **turn-1(첫 턴) 답변**으로 보는 것이 맞다(사실: 레거시 주석 기준; Scope 측 실제 payload 는 **미확인**).
- **정정 2**: 경로. PDF 가 적은 `lib/scope/mirror/scope-mirror.ts` 는 없다. 실제는 `front/lib/db/repositories/scope-mirror.ts`(anchorReapplySql `:117`, deletePromptData `:822` — 줄 번호는 일치).
- prompt_run_id 는 `scope_acr_rollups`(`0025:17`)·`QueryRunView`(`types.ts:517`)에, turn_index 는 `scope_mention_occurrences`·`scope_answer_stances`(`0061`, `0072`)에 있다(PDF 1.3 표와 일치).

### (b) N9 "프롬프트 완전 삭제 시 물리 삭제"
- **사실**. `deletePromptData`(`scope-mirror.ts:817-844`)는 한 트랜잭션에서 `scope_mentions`→`scope_citations`→`scope_answer_stances`(표 있을 때)→`scope_acr_rollups`→`scope_answers`→`scope_prompts` 를 DELETE 한다. `scope_runs` 는 남긴다. 호출: `scripts/scope/delete-combined.ts`, 관리자 완전 삭제 캐스케이드(`:55` 주석).
- **보완**: `scope_mention_occurrences`·`scope_answer_anchors`·`scope_answer_drops`·`scope_answer_cycle_anchors` 는 지우지 않는다 → 고아 행 가능(사실: 코드 누락). 0072 도 drop 함수가 occurrences 를 모른다고 명시(`0072:84-85`).
- **N2 해소**: PDF 가 "미확인" 으로 둔 "드롭 답변의 물리 삭제" 는 **사실 — 삭제된다**. `scope_answer_drop_apply` 가 stances/citations/mentions/answers 를 DELETE 하고(`0072:86-105`), 재싱크마다 `dropReapplySql` 로 재적용된다(`scope-mirror.ts:129-145`). 원본 시각은 `scope_answer_drops.source_measured_at` 에만 남는다.

### (c) "scope_prompts: project_id·kind·iterations 컬럼 없음"
- **사실**. `schema.ts:1214-1253` 컬럼 = prompt_id, text, funnel_stage, is_korean(생성), lang, regions. kind 는 로컬 `prompts.kind`(`0025:7-9`, 정본 로컬→Scope push)와 Scope 에, project_id 는 `scope_runs.project_id` 조인 또는 로컬 카탈로그에, iterations 는 Scope `projects.acr_iterations` 에만(`docs/scope-api-integration.md:55-56`). 후속 턴 문안·삭제 시각도 없음(5절).

### (d) 3-2 행 수 타당성
| 표 | PDF | 코드 기대 | 판정 |
| --- | --- | --- | --- |
| ga4_tracked_events | 0 | 0행이면 전환 분자는 GA4 key events 폴백(`0037:4-7`) — 운영상 정상 | **타당** |
| ga4_properties | 1 | 코드 MAP 의 유일한 시장이 Kia/IT(`property-map.ts:37-39`), 레지스트리로 가져오기 UI 존재(`:133-142`) | **타당(추정: Kia/IT 1행)** |
| report_publications | 1 | 발행물 1건 = vol.2 v3.0 Global 2026-09-15(픽스처 `sbdata-vol2-global-20260915.min.json`, slug 예시 `0080:57`) | **타당** |
| report_site_facts | 105 | `bench.nAll` 105(`sb-data.ts:16-17`, `0080:82`) | **정확히 일치** |
| report_site_engine_facts | 202 | 행 = 사이트 × `sites[].eng` 키(`sb-data.ts:416-419`); 105×2=210 이 상한, 202 면 8개 사이트가 한 엔진만 가짐 | **타당(추정)** |
| profiles | 128 | 관리자 목록이 Admin API `per_page=200` 1페이지만 읽음(`admin.ts:87-89`) → 128 < 200 이라 화면 정상; `setup/admin.ts` 는 100개씩 페이징 | **타당** |

### (e) "summary_* 17종" 이름
- **사실** 0059 15개: `summary_cycles`, `summary_cycle_runs`, `summary_settings`, `summary_generations`, `summary_cycle_jobs`, `summary_answers`, `summary_brand_mentions`, `summary_domain_citations`, `summary_target_hits`, `summary_prompt_dim`, `summary_ga4`, `summary_trend_answers`, `summary_trend_brands`, `summary_trend_domains`, `summary_trend_own`(`0059_summary_tables.sql:12-223`) + 0081 2개: `summary_url_hits`, `summary_url_hit_generations`(`0081:42,65`) = **17**. 0062·0063·0065~0071 은 컬럼·인덱스·통계·함수만 추가(새 표 없음).
- 주의: PDF 는 `summary_settings`·`summary_generations`·`summary_url_hit_generations` 를 "운영 내부" 로 따로 적고도 "17종" 이라 했으므로 **중복 집계**(17 은 전체 종 수). 라이브 DB 의 `summary_*_YYYYMMDD` 수백 개는 주 파티션 자식(`03-db-live-catalog.md:11-15,62`)이지 별도 종이 아니다. `summary_ga4` 는 쓰는 코드가 없어 비어 있을 것(2.3).

### (f) "scope_context_* 6종 = 컨텍스트 매핑"
- **사실** 두 성격이 섞여 있다.
  - 5표(`scope_context_entities/drives/combinations/evidence/domains`) = Scope 자동차 산업 코퍼스(ConsumerContext/ConsumerRequirement, industry id …401, 236,781 발화)를 **2026-07-07 에 Scope 라이브 Postgres 에서 직접 1회 떠온 정적 스냅샷**. Scope 의 `GET /api/v1/context-map` 이 타임아웃이라 API 경유가 아니다. 브랜드/역할 스코프 없음, 읽기 전용. `schema.ts:1380-1387`, `0027_scope_context_map.sql:1-6`, `repositories/scope-context-map.ts:27-28`. 재취득 가능 여부는 Scope 코퍼스·API 상태에 달림(**미확인**).
  - 1표(`scope_context_prompt_cache`) = 프로젝트별 **LLM(OpenRouter) 생성 후보 프롬프트 캐시** + 사람의 "더 생성/선택 삭제" 편집 결과(낙관 락 version). `schema.ts:1462-1483`, `0028`, `0030`, `lib/social-scraping/generate-context-prompts.ts:11-20`. 결정적으로 재생성 불가 → **업무 데이터로 이관**해야 한다.
  - HUB 대응: `ext.ctx_*`(snapshot_id 포함, `DB-v2.32:730-740`) + `app.ctx_generated_prompt`(`:P14`). `export.py:28-29` 가 6표 모두 추출.
- PDF 3-1 의 "컨텍스트 매핑 6종" 분류는 이름으로는 맞지만, **5개는 Scope 스냅샷(원천 = Scope), 1개는 HMG 생성물** 이라는 구분이 빠져 있다.

### (g) 덧: N4 "모든 테이블에 FK 0개, CHECK 도 없다"
- **부분 오류**. FK 0 은 미러·업무 표 전반에서 사실이나(이식성 방침), CHECK 는 있다: `prompts_kind_check`(`0025:9`), `ga4_properties_status_check`(`0036:30-31`), `scope_mirror_progress_phase_ck/revision_ck`(`0073:17-20`), `report_publications_status_ck/bench_ck`·`report_site_facts_target_ck/owned_ck`(`0080:98-101,174-177`), `summary_cycles_hidden_*_ck`(0070·0071). 공급 DB 4표(scope_runs/prompts/answers/citations)에 한정하면 맞다.

---

## 요약: 이관 항목에 추가/정정할 것
1. **auth.users**(해시·확인시각·마지막 로그인)와 **uuid 보존** — PDF 의 `profiles` 만으로는 계정 이관이 안 된다(1.5).
2. **GA4 접근 주체 교체·속성별 뷰어 부여** — 토큰은 env/파일이라 이관 불가, GA4 수치는 재질의 전제(2.1·2.3). `summary_ga4` 는 빈 표.
3. **발행 리포트 파일 자산**(`docs/data/*` 4단계 + `.verify-manifest.json` + Confluence 첨부) — DB 에는 sb-data 정수만 있고 HTML/PDF·vol.2 생성기는 리포 밖(3.3).
4. **S3**: 앤서 Scope 계정 버킷의 `snap/` 스냅샷 접근 여부; crawl/webgeo 의 "0행" 주장은 2026-09-27 실측(6GB, 수백만 행)과 충돌 → 재확인 후 폐기/덤프 결정(4.1·4.2). S3 아카이브는 아직 없음.
5. **Scope 측 등록 데이터**(프로젝트 설정·tracked_brands 별칭·acr_iterations·프롬프트 keywords/kind/enabled·스케줄·턴 원문·엔티티 카탈로그) — PDF 항목 밖(5절).
6. 크론 상태 표(cursors/watermarks/progress)는 이관 불요(6.3).
7. DB 함수 4종의 **정의 보존**(URL 정규화·앵커 접기·드롭 의미·KST 회차 상수); HUB 참조 구현 있음, 트리거 없음(7절).
8. PDF 정정: answer_text 는 turn-1(a), 드롭 답변은 물리 삭제됨(N2 해소), deletePromptData 가 occurrences/anchors/drops 를 안 지움(b), `scope-mirror.ts` 경로 오기, `scope_context_prompt_cache` 는 HMG 생성물(f), N4 CHECK 주장 부분 오류(g).
