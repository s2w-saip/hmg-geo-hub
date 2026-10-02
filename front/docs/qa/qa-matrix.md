# QA 매트릭스

hmg-geo 수동/자동 QA 케이스의 단일 관리 문서. 일반 기능 테스트와 별개로 이 레포의
4대 보안 경계(scope BFF 서버 전용 · 서버 파생 scope 필터 · scopeWhere DB 격리 ·
i18n 무하드코딩)가 회귀하지 않는지를 P0으로 관리한다.

- 원본 정책: [lib/auth/route-policy.ts](../../lib/auth/route-policy.ts) (시트 1),
  [lib/auth/scope-policy.ts](../../lib/auth/scope-policy.ts) (시트 2)
- 시트 1은 `ROUTES` 정의에서 생성한 표다. **route-policy.ts를 바꾸면 이 표도 같은
  PR에서 갱신**한다. (생성 기준: 2026-07-02, `ROUTES` 26개 항목)
- 라운드 이력: R1(2026-07-02, 코드 레벨 검수+자동 테스트) → R2(2026-07-02, dev
  서버 HTTP 배터리+DB 직접 조회+프로덕션 빌드 실측) → QA-PRJ-038 수정 완료 →
  R3(2026-07-03, 실제 프로덕션 `<production-host>` 대상 읽기 전용
  HTTP 배터리). 아래 규약은 R1·R2 실행 중 드러난 문제를 반영해 갱신한 버전이다.

## 규약

| 항목 | 규약 |
| --- | --- |
| 케이스 ID | `QA-<영역>-<번호>` — ACC(접근제어) / SEC(보안 경계) / STD(표준 대시보드) / PRJ(프로젝트) / WEB(웹사이트) / COM(공통·횡단) |
| 역할 | `hq` `region` `country` `admin` `vendor` + `anon`(비로그인) |
| 우선순위 | P0 = 보안·차단(실패 시 릴리스 불가) / P1 = 핵심 KPI·업무 흐름 / P2 = UI·i18n·상태 처리 |
| 자동화 | `vitest` / `lint` / `check:strings` / `수동` — 자동 커버 항목은 수동 라운드에서 제외 |
| 판정 코드 | `F`=결함 확인 / `주의`=동작하나 정책·문서와 불일치해 보완 검토 필요 / `P-코드`=구현 코드 확인으로 기대결과 보장 / `P-자동`=vitest·lint 등 자동 테스트로 확인 / `P-실측`=실행 환경(HTTP·DB·번들)에서 직접 관측 / `B-실측`=실측 필요하나 이번 라운드 미실행(사유 명시) / `NA`=현재 시스템에서 구조적으로 도달 불가하거나 알려진 보류 갭 |
| 결과 기록 | 라운드별로 이 문서를 복사하지 않고, 각 케이스 행의 결과 컬럼에 `R1: 판정코드`, `R2: 판정코드 → 조치` 식으로 누적 표기 |

전제조건 공통: `scripts/db/seed.ts` 시드 계정(역할별 1개). **`npm run dev`가 곧
mock 모드라고 가정하지 말 것** — `SCOPE_MODE`은 `.env.local`에 별도 설정되며
이 저장소의 실제 dev 환경은 `SCOPE_MODE=live`인 경우가 흔하다. 라운드 시작 전
`.env.local`의 `SCOPE_MODE`를 확인하고, live면 RUN 푸시·GA4 등 live 전용
케이스도 dev에서 바로 실측 가능하다.

### 검증 방법론 — R1→R2에서 얻은 주의사항

- **상태 코드만으로 판정 금지.** Next.js는 트리 하위 세그먼트에서
  `notFound()`가 호출돼도 상위 셸이 이미 200 헤더를 스트리밍한 뒤라면 최종
  HTTP 상태 코드가 200으로 남는다. 접근 차단 여부는 상태 코드가 아니라 응답
  본문의 `<meta name="next-error" content="not-found"/>` 또는 RSC 페이로드의
  `"children":404` 마커로 확인한다. **단, 이 마커 형식은 빌드마다 달라진다** —
  R2(로컬 `next build`+`next start`)에서는 `next-error` 메타 태그로, R3(실제
  Vercel 프로덕션)에서는 `"digest":"NEXT_HTTP_ERROR_FALLBACK;404"`로 나타났다.
  둘 중 하나만 grep하지 말고 "children":404 / NEXT_HTTP_ERROR_FALLBACK;404 /
  next-error 세 마커를 모두 확인하거나, 더 간단히는 기대되는 실제 콘텐츠(예:
  프로젝트명)가 응답에 없음을 직접 확인한다.
- **`npm run build`와 `npm run dev`를 같은 `.next`에 동시 실행하지 말 것.**
  webpack 청크가 깨져 일시적 500·오탐이 발생한다(앱 결함 아님, R2에서 직접
  겪음). 번들 검사(SEC-001류)는 dev를 내리고 build → 검사 → dev 클린 재시작
  순으로 진행한다.
- **공용 레이아웃 우선 노출 원칙.** 스코프·멤버십으로 보호돼야 할 리소스는
  leaf 페이지뿐 아니라 그 상위의 모든 `layout.tsx`/공용 컴포넌트가 동일
  리소스를 독자적으로 fetch하고 있는지 확인한다 — QA-PRJ-038(레이아웃이
  멤버십 검사 없이 프로젝트 메타를 노출)이 이 패턴이었다. 새 라우트 그룹에
  `layout.tsx`가 추가되면 이 체크를 회귀 리스트에 포함한다.
- **환경 갭과 코드 결함을 구분.** 마이그레이션 미적용·시드 계정 부재 등으로
  실측이 막히면 `F`가 아니라 `B-실측(환경)`으로 기록하고 원인을 명시한다.
- **화이트리스트 배열만 보고 "빠졌다" 단정 금지.** `lib/scope/server.ts`의
  `normalizeFilters`를 감사하다가 `FILTER_AXES` 배열(루프 처리 축)에
  `contextBrand`/`ownEntities`가 없는 것만 보고 "캐시 정규화 때 조용히
  유실된다"고 잘못 판정한 적이 있다(2026-07-06, 오탐). 실제로는 `dateFrom`/
  `dateTo`와 동일하게 배열 루프 **바깥**에 개별 예외 라인으로 보존되고
  있었다 — 함수 본문을 끝까지 안 읽고 배열만 대조해서 생긴 실수. 이런 종류의
  "필드가 두 가지 다른 메커니즘(배열 루프 vs 개별 exemption 라인)으로 나뉘어
  처리되는" 코드를 감사할 때는 **함수 전체를 끝까지 읽고**, 의심 가는 필드
  이름으로 grep해 모든 처리 경로를 확인한 뒤 결론 낸다.

---

## 시트 1 — 접근제어 매트릭스 (P0)

### 1-A. 라우트 × 역할 매트릭스

셀 표기 — **O**: SNB 메뉴 노출 + 접근 허용 / **U**: 메뉴 비노출(hidden)이지만 직접
URL 접근 허용 / **X**: 접근 거부(기본 랜딩으로 리다이렉트).

검증 방법: 역할별 시드 계정으로 로그인 → ① SNB에 메뉴가 표기와 일치하게
노출되는지, ② 직접 URL 입력 시 허용/거부가 표기와 일치하는지 확인.

| # | 경로 | 그룹 | hq | region | country | admin | vendor | 비고 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `/dashboard` | 표준 | O | O | O | O | X | |
| 2 | `/standard/prompts` | 표준 | O | O | O | O | X | 열람 전용, 계정 브랜드 스코프 |
| 3 | `/standard/answer-analysis` | 표준 | O | O | O | O | X | → `/mention` 리다이렉트 |
| 4 | `/standard/answer-analysis/mention` | 표준 | O | O | O | O | X | |
| 5 | `/standard/answer-analysis/citation` | 표준 | O | O | O | O | X | |
| 6 | `/standard/ai-funnel` | 표준 | O | O | O | O | X | → `/acr` 리다이렉트 |
| 7 | `/standard/ai-funnel/visibility` | 표준 | U | U | U | U | X | mock-only로 메뉴 숨김 (2026-06-23) |
| 8 | `/standard/ai-funnel/acr` | 표준 | O | O | O | O | X | |
| 9 | `/standard/ai-funnel/conversion` | 표준 | O | O | O | O | X | |
| 10 | `/customer-interest` | 표준 | U | U | U | U | X | 메뉴 숨김, → `/google-keywords` |
| 11 | `/customer-interest/google-keywords` | 표준 | U | U | U | U | X | |
| 12 | `/customer-interest/social-scraping` | 표준 | U | U | U | U | X | |
| 13 | `/website` | 웹사이트 | O | O | O | O | X | brand 필터 축은 admin에게만 노출 |
| 14 | `/website/answer-analysis` | 웹사이트 | O | O | O | O | X | → `/mention` 리다이렉트 |
| 15 | `/website/answer-analysis/mention` | 웹사이트 | O | O | O | O | X | |
| 16 | `/website/answer-analysis/citation` | 웹사이트 | O | O | O | O | X | |
| 17 | `/website/ai-funnel` | 웹사이트 | O | O | O | O | X | → `/conversion` 리다이렉트 |
| 18 | `/website/ai-funnel/acr` | 웹사이트 | U | U | U | U | X | ACR 메뉴는 표준에서만 노출 (2026-07-01) |
| 19 | `/website/ai-funnel/conversion` | 웹사이트 | O | O | O | O | X | |
| 20 | `/projects` | Project | O | O | O | O | O | vendor 목록은 데이터 계층에서 own+assigned로 제한 → QA-PRJ |
| 21 | `/projects/new` | Project | U | U | U | U | X | 실제 생성 가능 여부는 operator=global 게이트가 별도 결정 (QA-ACC-013) |
| 22 | `/admin` | Admin | X | X | X | O | X | |
| 23 | `/admin/standards` | Admin | X | X | X | O | X | → `/prompts` 리다이렉트 |
| 24 | `/admin/standards/prompts` | Admin | X | X | X | O | X | |
| 25 | `/admin/standards/customer-interest` | Admin | X | X | X | O | X | |
| 26 | `/admin/keyword-tools` | Admin | X | X | X | O | X | 유료 외부 API — 비용 게이트 |

`/projects/[id]/*` 하위 경로(대시보드·prompt·analysis·ai-funnel·intent·setting·
member)는 `canAccessRoute`의 prefix 매칭으로 `/projects` 항목(전 역할 허용)을
따른다. 라우트 계층에서는 전 역할 접근 가능이 **의도된 동작**이고, 프로젝트별
격리는 데이터 계층 담당 — 시트 4에서 검증한다.

### 1-B. 시나리오 케이스

| ID | 역할 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-ACC-001 | anon | 비로그인으로 `(dash)` 하위 임의 URL 접근 | `/{locale}/login` 리다이렉트 (middleware) | P0 | 수동 | R1: P-코드 — middleware.ts:54-55 — PUBLIC_PATHS 외 미인증 트래픽 login 리다이렉트 |
| QA-ACC-002 | vendor | 로그인 직후 랜딩 | `/projects` (defaultLandingFor: 첫 가시 메뉴) | P0 | 수동 | R1: P-자동 — route-policy.test 'vendor sees only Projects' + defaultLandingFor 첫 가시 라우트 반환 |
| QA-ACC-003 | hq/admin | 로그인 직후 랜딩 | `/dashboard` | P1 | 수동 | R1: P-코드 — defaultLandingFor: ROUTES 첫 항목 /dashboard (NON_VENDOR 허용) |
| QA-ACC-004 | (메뉴 0개 계정) | 로그인 직후 랜딩 + 임의 URL 접근 | `/no-access` 랜딩, `/no-access`는 인증만 되면 항상 접근 가능(guard bypass) | P2 | vitest | R2: NA — 현재 `Role` enum(hq/region/country/admin/vendor) 5종 전부 `visibleRoutes`≥1이라 이 상태 자체가 시스템상 도달 불가. 실계정 생성 대신 `visibleRoutes`가 항상 비지 않음을 고정하는 코드 회귀 가드로 대체(수동 케이스 폐지) |
| QA-ACC-005 | 전 역할 | `ROUTES` 미등록 경로 접근 (예: `/ko/standard/nonexistent`) | default-deny — 허용 랜딩으로 리다이렉트, 화면 렌더 없음 | P0 | vitest | R1: P-자동 — canAccessRoute 후보 0건 → false (route-policy.ts:293-297) + 테스트 커버 |
| QA-ACC-006 | vendor | `/dashboard` `/standard/*` `/website/*` 직접 URL 입력 | 전부 거부 | P0 | vitest+수동 | R1: P-자동 — route-policy.test 'vendor cannot access ...' 표준 그룹 전수 케이스 통과 |
| QA-ACC-007 | vendor | `/projects/new` 직접 URL 입력 | 거부 (PROJECT_CREATORS 제외) | P0 | 수동 | R1: P-자동 — route-policy.test 'vendor cannot access /projects/new' 통과 |
| QA-ACC-008 | country | `/admin` 및 하위 3경로 직접 URL 입력 | 전부 거부 | P0 | vitest+수동 | R1: P-자동 — route-policy.test admin-only 거부 케이스(비 admin 역할 전수) 통과 |
| QA-ACC-009 | hq | hidden 라우트 직접 접근 (`/standard/ai-funnel/visibility`, `/customer-interest/*`, `/website/ai-funnel/acr`) | 접근은 허용되고 SNB에는 비노출 (U 셀 검증) | P1 | 수동 | R1: P-코드 — visibleRoutes만 hidden 필터(route-policy.ts:309-311), canAccessRoute는 hidden 무관 — U 셀 의미 구현 확인 |
| QA-ACC-010 | hq | 부모 경로 5종 접근 | 표 1-A 비고의 리다이렉트 대상으로 이동 (`answer-analysis→mention`, `ai-funnel→acr`, `customer-interest→google-keywords`, `website/answer-analysis→mention`, `website/ai-funnel→conversion`, `admin/standards→prompts`는 admin으로) | P2 | 수동 | R1: P-코드 — 6개 부모 page.tsx의 redirect() 대상 grep 실측: mention/acr/google-keywords/mention/conversion/prompts |
| QA-ACC-011 | vendor vs admin | GNB 1depth 탭 구성 | vendor: Project만 / admin: 표준·웹사이트·Project·Admin 4개 / hq·region·country: Admin 제외 3개 | P1 | 수동 | R1: P-자동 — route-policy.test visibleGroups 3개 케이스 통과 |
| QA-ACC-012 | 전 역할 | locale 프리픽스 무관성 (`/en/dashboard` vs `/ko/dashboard`) | 접근 판정 동일 (normalizePath locale 스트립) | P2 | vitest | R1: P-코드 — normalizePath locale 스트립(route-policy.ts:276) |
| QA-ACC-013 | hq(operator≠global) | `/projects`에서 "새 프로젝트" CTA + `/projects/new` 직접 접근 후 생성 시도 | 라우트 접근은 허용되나 CTA 비노출 + 생성 액션은 operator-policy(canCreateProject)에서 거부 | P0 | vitest+수동 | 라우트 게이트와 별개의 비용 게이트 |
| QA-ACC-014 | hq | SNB == 접근 불변식: 화면에 보이는 모든 메뉴를 순회 클릭 | 전 항목 정상 진입 (거부·404 없음) | P1 | 수동 | R1: P-코드 — SNB와 가드가 동일 ROUTES 소스 소비 — 구조적 보장. 육안 순회는 실측 라운드 권장 |

---

## 시트 2 — 보안 경계 (P0)

케이스 도출 축: 4대 경계 각각에 대해 "우회 시도 → 차단 확인" + "정상 경로 →
부수 통제(감사 로그) 동작 확인".

| ID | 시나리오 | 기대결과 | 자동화 | 결과 |
| --- | --- | --- | --- | --- |
| QA-SEC-001 | 프로덕션 빌드 클라이언트 번들에서 `SCOPE_API_KEY`/`SCOPE_API_BASE`/`SUPABASE_SERVICE_ROLE_KEY` 문자열 검색 | 미포함 (`NEXT_PUBLIC_` 금지 준수) | 수동(grep) | R1: P-코드 — NEXT_PUBLIC_ 접두 키 grep 0건. SCOPE_API_KEY 참조는 서버 전용 모듈뿐 |
| QA-SEC-002 | 대시보드 사용 중 브라우저 네트워크 탭 관찰 | scope 원 호스트로 나가는 요청 없음 — `/api/scope/*`만 존재 | 수동 | R1: B-실측 — 구조상 보장(lib/scope 'server-only' import) — 브라우저 실측은 다음 라운드 |
| QA-SEC-003 | 클라이언트에서 임의 brand/region/country 파라미터를 조작해 `/api/scope/*` 호출 | 서버 파생 필터(deriveScopeFilter)가 우선 — 조작 값 무시 | vitest+수동 | R1: P-코드 — enforce()가 deriveScopeFilter(session.user)만 사용(server.ts:88-92). ScopeClient 계약에 필터 파라미터 자체가 없음 — 조작 벡터 부재 |
| QA-SEC-004 | 비로그인 상태로 `/api/scope/*` 직접 호출 | 401/거부 (세션 필수) | 수동(curl) | R1: P-코드 — enforce(): 세션 없으면 UnauthorizedError throw(server.ts:86-87), 모든 export 함수가 enforce 경유 |
| QA-SEC-005 | scope 호출 후 감사 기록 확인 | lib/audit.ts에 호출자(user) 단위 기록 존재 | 수동(DB) | 실저장 완료(2026-07-23, change add-bff-audit-sink) — auditScopeCall/auditDataAccess가 append-only `bff_audit_logs`에 영속(콘솔 PLACEHOLDER 제거). fire-and-forget(after()+console.error 폴백). 검증: 마이그 0033 적용 후 호출 발생시켜 `SELECT count(*) FROM bff_audit_logs` 증가 확인 + lockdown 재실행으로 anon 접근 차단 실측(has_table_privilege). |
| QA-SEC-006 | 저권한 역할로 scopeWhere 스코프 밖 데이터가 표/집계에 노출되는지 | 미노출 — isInScope와 SQL 술어 일치 | vitest | R1: 주의 — isInScope 15개 단위테스트 통과(P). 그러나 scopeWhere SQL 술어 직접 테스트 0건 — 테스트 추가 권장 |
| QA-SEC-007 | `assertProjectInScope` — 타 스코프 프로젝트 접근 | **알려진 갭(현재 pass-through)** — enforcing 전환 시까지 NA 처리, 전환 즉시 P0 활성화 | NA | R1: NA — assertProjectInScope pass-through 재확인(server.ts:97-99 intentionally empty). enforcing 전환 시 P0 활성화 |
| QA-SEC-008 | 비 admin으로 `/api/keyword/*` 호출 | `volume`/`to-prompt`/`prompt-to-volume`는 거부(admin 전용), `related`/`insight`는 인증만 요구(의도된 설계) | 수동(curl) | R2: `volume`/`to-prompt`/`prompt-to-volume` 403 확인(P-실측). `related`/`insight`는 `requireUser`(인증만) — 처음엔 route-policy.ts 주석("동일 게이트")과 불일치해 보였으나, 호출부(`google-keyword-view.tsx`, 프로젝트 Intent 화면)를 확인한 결과 **의도된 설계로 확정**: 이 둘은 role/route가 아니라 `canOperateProject`(액션 레이어)로 게이팅됨. **2026-07-03 조치**: route-policy.ts 주석을 정확한 서술로 수정 완료(F 아님, 문서 오기였음) |
| QA-SEC-009 | anon DB 접근 (lockdown.sql 적용 환경) | PostgREST/anon 데이터 접근 불가 | 수동(psql) | R1: B-실측 — scripts/db/lockdown.sql 존재 확인. 적용 환경 psql 실측은 다음 라운드 |

TODO: 케이스 상세(전제 계정·curl 예시) 채우기.

## 시트 3 — 표준 대시보드 기능 (P1)

대상: `/dashboard`, `/standard/prompts`, `/standard/answer-analysis/{mention,citation}`,
`/standard/ai-funnel/{acr,conversion}`, `/customer-interest/*`.
케이스 도출 축: ① 역할별 Scope 계층 실측(GGMD 3-2 문서 직결, 최우선) ② KPI
카드/추이 수치 정합 ③ DimensionFilterPanel 필터 — 권역→국가 캐스케이딩 포함
④ 정렬(sortable-header) ⑤ 모달(answer-modal mention/citation 뷰) ⑥ URL 필터
인코딩 왕복(filter-encoding: 새로고침·공유 링크 복원).

### 3-A. 역할별 Scope 계층 (P0 — [GGMD 3-2 유저 시나리오](https://customer-wiki.example.invalid/wiki/spaces/GGMD/pages/42336497) "권한 Scope 요약" 직결)

`deriveScopeFilter`([scope-policy.ts:29](../../lib/auth/scope-policy.ts#L29))가
구현한 계층 — HQ=Own Brand×전권역×전국가 / region=Own Brand×Own RHQ×관할국가(국가
제한 없음) / country=Own Brand×Own RHQ×자국 / admin=all — 을 화면에서 실측한다.
`isInScope` 단위테스트 15건은 이미 있으나, 화면 단 검증은 이번에 처음 추가.

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-STD-001 | hq | `/dashboard` 진입, AccountScopeChips 확인 | 브랜드만 고정 칩(Own Brand), 권역·국가는 잠금 없이 전체 옵션 노출 | P0 | 수동 | R3: P-실측 — dev(`SCOPE_MODE=live`) HTML 직접 확인: `scope={brands:["Hyundai"],regions:null,countries:null}` → 칩 렌더 Brand="Hyundai"/Region="전체"/Country="전체", 코드(`account-scope-chips.tsx`)와 정확히 일치 |
| QA-STD-002 | region | 동일 확인 | 브랜드+권역(Own RHQ) 고정 칩, 국가 축은 그 RHQ 소속 국가 전체가 옵션(= "관할 국가", 별도 제한 없음) | P0 | 수동 | R3: 주의 — **seed 계정 드리프트 발견**: `region@hmg.test`의 실제 DB 값은 `brands=null`(제한 없음, seed.ts 소스는 `brands:["Hyundai"]`를 선언 — 소스와 DB 불일치)이라 "Own Brand" 축이 이 계정으로는 검증 불가. 대신 `kia-eu@kia.test`(DB 직접 조회: `brands:["Kia"],regions:["kia-western-europe","kia-eastern-europe"],countries:[39개 유럽 ISO]`)로 "브랜드 고정+권역 범위 내 국가 무제한" 계층 자체는 정상 확인. **케이스는 대체 계정으로 PASS, 단 hmg.test 시드 드리프트는 별도 조치 필요(아래 QA-STD-016)**. **R4(2026-07-08, `genesis-ap@genesis.test` 신규: region/Genesis/genesis-asia-pacific/countries=null)**: 단일 브랜드 region 계정으로 데이터 경로 실측 — **region 경로는 정상 확인**: 적용 데이터 필터 region=`["KR","AU","CN","KZ","ID"]`(genesis-asia-pacific 5개국 정확히), 권역 밖(DE/US/CA=genesis-europe·북미) region 문자열 렌더 페이로드에 **0건**(권역 경계 정상 강제). Genesis 글로벌 멘션 중 DE(3,683)·US 등은 필터에서 제외됨 = 수치 정합. P-실측 PASS |
| QA-STD-003 | country | 동일 확인 | 브랜드+권역+국가 3개 모두 고정 칩(자국 단일) — 필터 조작 자체가 불가 | P0 | 수동 | R3: 주의 — 동일 드리프트: `country@hmg.test`도 `brands=null`. 대신 `kia-it@kia.test`(DB: `brands:["Kia"],regions:["kia-western-europe"],countries:["IT"]`)로 3축 모두 고정되는 계층은 정상 확인. hmg.test 드리프트는 QA-STD-016 참조. **R4(2026-07-08, `genesis-kr@genesis.test` 신규 생성)**: 단일 브랜드 country 계정으로 재검증 — 스코프 **칩** 자체는 정합(brand=Genesis, region=genesis-asia-pacific, country=KR 3축 고정, RSC 페이로드 `scope={brands:["Genesis"],regions:["genesis-asia-pacific"],countries:["KR"]}` 확인). 칩은 P-실측 PASS이나 **실제 데이터는 KR을 벗어남 → QA-STD-020 참조** |
| QA-STD-004 | admin | 동일 확인 | 스코프 칩 없음(scope.all) — 브랜드 필터가 실제 선택 가능한 축으로 열림 | P1 | 수동 | R3: 주의 — **기대결과 정정**: `account-scope-chips.tsx` 코드 확인 결과 `scope.all`이어도 칩 3개가 전부 렌더되고 값이 모두 "전체"로 표시됨(칩이 사라지는 게 아님). DB 실측도 `scope_all:true` 확인. 동작 자체는 정상이나 원래 기대결과 서술이 부정확했음 — 위 내용으로 정정 |
| QA-STD-005 | region | 자기 RHQ 밖 국가의 데이터가 KPI 카드·리스트·랭킹 어디에도 섞이지 않는지 | 미노출 — QA-SEC-006(isInScope/scopeWhere 일치)의 화면 단 대응 케이스 | P0 | 수동 | R3: P-코드 — `isInScope`/`scopeWhere`가 region/country 필터를 독립 AND 조건으로 적용하는 구조 확인(코드 레벨). 실제 KPI 수치 대조(RHQ 밖 국가 값이 진짜 0건인지)까지는 세부 데이터 비교가 필요해 B-실측으로 남김. **R4 갱신**: `genesis-kr` 실측으로 이 B-실측이 해소됨 — 자기 스코프 밖 데이터가 실제로 섞임을 확인(country 계정 기준, QA-STD-020). region 계정 기준 검증은 별도로 남음 |
| QA-STD-020 (신규) | **country 계정(`genesis-kr@genesis.test`: brand=Genesis, region=genesis-asia-pacific, country=KR)** | `/dashboard`·답변분석 집계가 자국(KR) 데이터만 반영하는지 | GGMD 3-2 "country = Own Brand × Own RHQ × **자국**"에 따라 KR 측정만 집계 | **P0** | 수동(HTTP+DB 실측) | R4(2026-07-08): **F — country 스코프가 자국(KR)이 아니라 RHQ 권역 전체(genesis-asia-pacific 5개국)로 넓어짐**. 원인: [`standard-filters.ts::allowedScopeCountries`](../../components/dash/standard-filters.ts#L13)가 `scope.countries`(KR)와 `scope.regions` 확장(genesis-asia-pacific → KR·AU·CN·KZ·ID)의 **합집합**을 취함. country 계정은 두 필드를 모두 가지므로 KR 제한이 권역 5개국으로 상향. **실측 증거**: (1) dev RSC 페이로드의 적용 필터가 `region:["KR","AU","CN","KZ","ID"]`(드롭다운 옵션 아니라 `getLiveDashboard(filters)`로 전달되는 실제 데이터 필터) (2) DB 정량화 — 계정이 조회하는 답변 모집단 36,269건 vs 자국 KR만이면 28,311건(**+28.1% 오염**), Genesis 멘션 한정으로도 5개국 4,407 vs KR 4,043(**비-KR 364건**=AU 326+CN 38이 당사 지표에 유입). 즉 KPI(노출률·SOV·우호도·커버리지)가 5개국 합산으로 계산됨. **맥락**: `allowedScopeCountries`의 union은 2026-07-08 "region 계정(countries=null) default-allow 누출 차단" 보안 수정으로 도입된 것 — region 계정엔 옳지만 country 계정(둘 다 채워짐)엔 과확장. **권장 조치**: `scope.countries`가 비어있지 않으면 그것만 사용(가장 구체적인 축 우선), region 확장은 countries=null일 때만. 단 이 함수는 알려진 fragile 영역(region↔country 스코핑)이라 region 계정 회귀 없는지 확인 후 수정 필요 — **제품 확인**: country 역할의 의도가 자국인지 권역인지(GGMD 3-2 문구는 자국). 이번 라운드는 verify 태스크라 수정 보류, 발견만 기록. **R5(2026-07-08): 수정 완료** — `allowedScopeCountries`를 "가장 구체적인 축 우선"으로 변경: `scope.countries`가 비어있지 않으면 그것만 사용, `scope.regions` 확장은 `countries`가 빈 경우(region 계정)에만 적용. 검증(dev HTTP, 답변분석 mention 지역 분포): country@hmg.test(countries=['KR']+regions=[asia-pacific×3]) → **KR만**(이전 5개국), region@hmg.test(countries=null) → **DE만**(regions 확장 유지, 회귀 없음), hq(무제한) → 전 6권역. `tsc`·vitest 434 통과. GGMD 3-2 "country=자국" 정합. **R5-검증(2026-07-08, `genesis-kr` vs `genesis-ap` 동일 브랜드·권역 대조 실측)**: 수정 후 재측정 — genesis-kr(country) 적용 필터 `["KR"]`(수정 전 `["KR","AU","CN","KZ","ID"]`에서 좁혀짐 확인), genesis-ap(region) 유지 `["KR","AU","CN","KZ","ID"]`(회귀 없음). geography 필터 기능성 확증(`?geography=AU`는 KR과 다른 결과 반환). **주의(정밀 기록)**: genesis-kr 헤더 KPI(visibility 63.4 등)는 수정 전후 동일 — Genesis AP 멘션의 91.7%(4,043/4,407)가 KR이라 헤더 지표가 KR에 지배되어 소수점1 정밀도로는 안 움직임. 수정의 실제 효과는 상세 breakdown(응답 411KB→230KB, AU/CN 멘션 행 제거)에 나타나며, **자국이 권역 대비 소수 시장인 country 계정일수록 오염 제거 효과가 큼**. "헤더 KPI 불변=수정 무의미" 아님 |
| QA-STD-021 (신규) | **region 계정(`genesis-ap@genesis.test`: brand=Genesis, region=genesis-asia-pacific, countries=null)** | 표준 대시보드 geography **필터 드롭다운 옵션**이 관할 권역(AP 5개국)으로만 좁혀지는지 | 옵션 목록도 스코프로 제한 — 권한 밖 권역/국가는 선택지로도 노출 금지 | **P0** | 수동(DB 실측)+단위 | R6(2026-07-16): **F→수정 완료**. region 계정의 표준 geography 드롭다운에 **측정된 48개국 전체**가 선택 가능하게 노출됨(권한 밖 DE·US 등 포함). 원인: [`scope-aggregates.ts::listMeasuredRegions`](../../lib/db/repositories/scope-aggregates.ts#L1401)가 `scope.countries`만 필터하고 `scope.regions`를 무시 — region 계정은 `countries=null`이라 국가 제한이 아예 안 걸림. 데이터 읽기(`allowedScopeCountries`)는 regions를 국가로 펼치는데 **옵션 목록만 안 펼치는 드리프트**. 웹사이트 `listWebsiteCountries`/`listMeasuredLanguages`에도 동일 버그(같은 패턴). **수정**: `lib/rhq::effectiveScopeCountries`를 단일 소스로 신설 — 읽기 필터와 옵션 목록이 **같은 함수 공유**(countries 우선, 없으면 regions 확장). listMeasuredRegions·listWebsiteCountries·listMeasuredLanguages 모두 이걸로 파생. **실측 검증**(DB): genesis-ap 표준 옵션 48→**5개국(AU/CN/ID/KR/KZ)**, genesis-kr→**KR만**, genesis-ca→**CA만**. 단위테스트 5건 추가(`effective-scope-countries.test.ts`), 전체 516 통과. **QA 프로세스 교훈(핵심)**: QA-STD-020이 같은 계정을 썼는데 통과했던 이유 — 그 케이스는 **데이터 필터**(`getLiveDashboard`에 전달되는 region 값)만 검증하고 괄호로 "*드롭다운 옵션 아니라 실제 데이터 필터*"라며 옵션 표면을 **명시적으로 제외**했다. 버그는 정확히 그 제외된 표면에 있었다. → **불변식 분리**: 스코프 격리는 "값(데이터가 안 새는가)"과 "선택지(옵션에 권한 밖이 뜨는가)"의 **별개 두 검증**이 필요. 이후 스코프 케이스는 반드시 둘 다 확인 |
| QA-STD-016 | (신규) | `scripts/db/seed.ts` 소스와 실제 DB profiles 값 대조 | 일치해야 함 | P1 | 수동(DB 직접 조회) | R3: **F** — 최소 2개 계정 드리프트 확인: (1) `hq@hmg.test` — seed.ts는 `scopeAll:true`(전체 무제한)를 선언하지만 DB는 `scope_all:false,brands:["Hyundai"]`(오히려 DB 쪽이 `scope-policy.ts`가 문서화한 "HQ=Own Brand×전권역×전국가" 계층과 정확히 일치 — DB가 맞고 seed.ts가 구식으로 보임) (2) `region@hmg.test`/`country@hmg.test` — seed.ts는 `brands:["Hyundai"]`를 선언하지만 DB는 `brands:null`(무제한 — 역방향 드리프트). **`npm run db:seed` 재실행 시 hq 계정이 실수로 전체 권한으로 리그레션될 위험**이 있어 P1로 기록. seed.ts를 현재 DB 실태(또는 의도된 정책)에 맞춰 갱신 필요 — 어느 쪽이 정답인지는 제품 확인 사항. **2026-07-06 수정 완료**: `scripts/db/seed.ts`의 hq/region/country 3계정을 현재 DB 실측값과 일치시킴 — hq는 `scopeAll:false,brands:["Hyundai"]`(scope-policy.ts 문서화 계층과 일치), region/country는 `brands` 필드 제거하고 DB의 다국적(Hyundai/Kia/Genesis) `regions` 배열 그대로 반영. `tsc --noEmit` 통과. **주의**: 이 수정은 재시드 시 회귀만 막을 뿐 — region/country가 실제로 단일 브랜드여야 하는지(다국적 상태가 의도인지)는 여전히 제품 확인 필요, 코드 주석에 명시해둠. 기존 DB row는 이미 올바른 값이라 재적용 불필요(수정은 seed.ts 소스에만) |

### 3-B. KPI·추이 정합

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-STD-006 | hq | `/dashboard` 7 Core KPI 카드 수치 | 하위 드릴다운(Mention/Citation/AI Funnel) 수치와 정합 | P1 | 수동 | R3: B-실측 — 실제 수치 대조는 육안 크로스체크가 필요, 이번 라운드는 페이지가 에러 없이 렌더되는 것만 구조적으로 확인(다른 케이스에서 200 응답·본문 정상 확인됨) |
| QA-STD-007 | hq | 추이 차트 기간(time range) 변경 | 카드·차트가 동일 기간으로 동기화 | P1 | 수동 | R3: B-실측 — 상호작용(클릭·리렌더) 확인은 브라우저 필요, curl 기반 라운드에서 미실측 |
| QA-STD-008 | hq | `/standard/prompts` 열람 | 편집·삭제 등 CRUD 컨트롤 없음(열람 전용), 브랜드 스코프만 필터로 노출 | P1 | 수동 | R3: P-코드 — `prompt-list-readonly.tsx` 확인: 노출 컨트롤은 스코프 필터 드롭다운(Eye 아이콘, `scopeLabel`)뿐, 편집/삭제 등 CRUD 버튼 없음 |

### 3-C. 필터 — 캐스케이딩 + URL 인코딩 왕복

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-STD-009 | admin | DimensionFilterPanel에서 브랜드 변경 | 하위 권역·국가 옵션이 캐스케이딩되어 좁혀짐 | P1 | 수동 | R3: P-코드 — `dimension-filter-panel.tsx:558` "권역 nav — UI-only cascade: 권역 선택 시 국가 목록을 해당 권역 하위로 좁힘" 코드 존재 확인. **`geo-filter-cascade-backlog` 메모의 "당시 미푸시" 상태는 해소됨 — 현재 main에 반영돼 있음**. 실제 클릭 인터랙션 확인은 브라우저 필요(B-실측 잔존) |
| QA-STD-010 | 전 역할 | 필터 적용 후 새로고침 | URL 파라미터로 필터 상태 복원(`filter-encoding` 왕복) — `filter-encoding.test.ts` 단위테스트는 이미 통과 중, 여기선 실제 화면 반영만 확인 | P2 | vitest+수동 | R3: P-자동 — 단위테스트(인코딩/디코딩 로직) 통과 확인(vitest 378/378 포함). 화면 반영 육안 확인은 B-실측 잔존 |
| QA-STD-011 | 동일 역할 두 세션 | 필터 적용 URL 공유 | 동일 조건으로 동일 결과 재현 | P2 | 수동 | R3: B-실측 — QA-STD-010과 동일 메커니즘(URL이 유일한 상태 소스)이라 구조적으론 자명하나 실측은 미실행 |

### 3-D. 정렬

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-STD-012 | hq | 랭킹/리스트 테이블 컬럼 헤더 클릭 | `sortable-header` 정렬 방향 토글. R1에서 발견된 `aria-sort`/role 불일치 lint 경고(주의)를 스크린리더로 함께 확인 | P2 | 수동 | R3: B-실측 — 정렬 토글 자체는 `useSortableTable` 훅 + 여러 화면(acr-view 등)에서 사용 확인(코드), 스크린리더 접근성 실측은 미실행 |

### 3-E. 모달 · Citation 트리

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-STD-013 | hq | `/standard/answer-analysis/mention` 리스트 항목 클릭 | `answer-modal`에 원문 답변 렌더 | P1 | 수동 | R3: B-실측 — 모달 오픈 인터랙션은 브라우저 필요 |
| QA-STD-014 | hq | `/standard/answer-analysis/citation` 리스트 항목 클릭 | ~~Category→Subcategory→Domain→URL 4단 트리~~ 드릴다운 | P1 | 수동 | R3: **주의 — 기대결과 자체가 틀렸음, 정정**: `lib/citation-categorizer/taxonomy.ts:1` "Citation-source taxonomy — single-level (subcategory **폐기**, see migration 0016)"로 subcategory 레벨이 이미 제거됨 — 현재는 Category→Domain→URL **3단** 구조. [GGMD 3-2](https://customer-wiki.example.invalid/wiki/spaces/GGMD/pages/42336497) Part2-③ "출처분석·가이드형" 과업 설명이 "Category→Subcategory→Domain→URL 4단"이라고 서술한 것은 **이 taxonomy 단순화(migration 0016) 이후 갱신 안 된 문서**로 보임 — Confluence 문서 갱신 필요 여부 제품 확인 권장 |

### 3-F. 고객 관심 (customer-interest, 메뉴 숨김이지만 라우트 유지)

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-STD-015 | hq | `/customer-interest/google-keywords` 진입 | `GoogleKeywordView`를 `canEdit=false`로 재사용 — 프로젝트 intent의 동일 화면과 달리 키워드 추가·삭제·프롬프트 후보화 버튼이 없음(열람 전용) | P1 | 수동 | R3: P-코드 — customer-interest/google-keywords/page.tsx 주석: "canEdit={false} disables the 프롬프트 후보 추가 + keyword add/delete affordances" — 코드로 확인 |

### 3-G. AI Funnel(ACR) — KPI 정의 툴팁 + Battle Grid 데이터 캡

`잔여 TODO: AI Funnel 상세 케이스` 항목을 2026-07-08 diff 감사로 대체 — ACR
화면에 실제 작업이 있었으므로 추측성 TODO 대신 실제 변경을 검증.

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-STD-017 (신규) | hq | ACR `DimensionFilterPanel`에 노출되는 필터 축 | `acrWhere`가 실제로 좁히는 축(geography/engine/time/brandPresence/listType/depth1-3)만 노출 — competitor/source/language/device/visitorType/depth4/funnel 등 "적용해도 무변화"인 죽은 축은 비노출 | P2 | 수동 | R3: P-코드 — `acr-live-view.tsx`의 `STANDARD_ACR_ONLY_GROUPS` 배열이 `aggregateAcrFromMirror::acrWhere` 실제 처리 축과 일치. funnel(promptContext) 제외 사유가 코드 주석에 명시("표준 ACR 지정 프롬프트 69개가 전부 단일 단계라 죽은 축 — 인지/구매 단계 프롬프트 생기면 재도입") — **재도입 조건이 코드에만 있고 회귀 감지 장치는 없음**, 새 ACR 프롬프트가 다른 funnel 값으로 추가돼도 자동으로 안 알려줌(수동 인지 의존) |
| QA-STD-018 (신규) | hq | Battle Grid(프롬프트×모델 격자)에 측정 프롬프트가 30개를 초과할 때 | 30개까지 펼쳐 보이고 "N개 더 보기"로 나머지 확장 — 데이터 자체는 잘리지 않음 | P1 | 수동 | R3: **F(과거) → 수정 완료** — `scope-aggregates.ts:2047-2050`의 `aggregateAcrFromMirror`가 이전엔 `.slice(0, 30)`으로 **집계 단계에서 조용히 30개 초과분을 버리고 있었음**(UI 처리 안내 없이). 2026-07-08 수정: 캡을 200으로 올리고("표준 루트 실측 67개라 200이면 전량 통과" 주석) 30개 노출/확장은 `acr-live-view.tsx`의 `BATTLE_VISIBLE=30` + `battleExpanded` state로 **UI 레이어**로 이전 — Workflow 문서의 "no silent caps" 원칙과 정확히 같은 수정 방향. **잔존 리스크**: 200도 여전히 하드 캡이라 측정 프롬프트가 200개를 넘으면 다시 조용히 잘림 — 주석에 "67개"라는 현재값 근거만 있고 200 도달 시 경고하는 장치는 없음 |
| QA-STD-019 (신규) | hq | ACR Top1/Coverage 카드, Citation Sources 테이블의 Citations/Share/Prompts/Coverage 컬럼에서 ⓘ 아이콘 클릭 | 정의(definition)·산식(formula) 툴팁 렌더 | P2 | 수동 | R3: P-코드 — `acr-live-view.tsx::MetricInfo`, `citations-view.tsx::Th(info=...)` 둘 다 동일 패턴(`dashboard.kpi` 공유 i18n 네임스페이스: `infoAriaLabel`/`definitionLabel`/`formulaLabel`), `messages/{ko,en}.json`에 대응 키 추가 확인 — check:strings(QA-COM-002) 통과 범위 안 |

잔여 TODO: ACR conversion 상세는 프로젝트 쪽 동등 화면(QA-PRJ-020~022)과 로직
공유가 커서 우선순위 낮게 유지.

## 시트 4 — 프로젝트 흐름 (P1)

핵심 여정: 목록 → 생성 → 상세 대시보드 → prompt → analysis → ai-funnel → intent
→ setting → member. 권한 축이 3겹임에 주의해 기대결과를 적었다:
① 라우트 게이트(시트 1 — `/projects` 전 역할 허용) ② **멤버십**(owner/viewer/
pending, `requireOwner`/`requireMember`) ③ **operator**(global/assigned/none —
생성·RUN 등 비용 액션). admin은 멤버십 검사를 바이패스하는 개발자 superuser로
**의도된 동작**이다(2026-06-02 결정). vendor 계정으로 D~G 전 구간 반복 수행이
필수.

전제 계정 표기: `Owner`(해당 프로젝트 active owner), `Viewer`(active viewer),
`비멤버`(멤버십 없음), `global`/`assigned`(operator 값).

### 4-A. 목록·데이터 격리

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-PRJ-001 | vendor | `/projects` 목록 조회 | active 멤버십 보유 프로젝트만 노출 (`listForUser`) — 타 프로젝트 카드 없음 | P0 | vitest+수동 | R1: P-코드 — projects/page.tsx:38-41 — 비 admin은 listForUser(uid), 레포는 active 멤버십 조인 |
| QA-PRJ-002 | admin | `/projects` 목록 조회 | 전체 프로젝트 노출 (superuser `listAll`) | P1 | 수동 | R1: P-코드 — projects/page.tsx:40 — admin이면 listAll() |
| QA-PRJ-003 | 비멤버 (vendor·hq 각각) | 타 프로젝트 `/projects/[id]` 및 하위 URL 직접 접근 | 데이터 계층(멤버십 검사)에서 거부 — 라우트는 통과하더라도 내용 미노출. ※ scope 값 격리 갭(QA-SEC-007)과 별개의 멤버십 격리 | P0 | 수동 | R1: P-코드 — 전 leaf 페이지 확인: dashboard·prompt·member·setting·intent×2는 페이지 내 findMembership, analysis×2·ai-funnel×3은 공용 로더에서 '비 admin & 비 active 멤버 → notFound()' |
| QA-PRJ-004 | 초대 pending 사용자 | `/projects` 목록 | 해당 프로젝트가 수락/거절 대기 상태로 구분 표시, 상세 진입은 수락 전 불가 | P1 | 수동 | R1: P-코드 — projects/page.tsx PendingInvitesPanel + 상세는 status!=='active' → notFound |

### 4-B. 생성 (`/projects/new`)

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-PRJ-005 | hq + global | "새 프로젝트" CTA → 폼 작성 → 생성 | 성공, 생성자가 자동으로 해당 프로젝트 Owner 등록 | P0 | 수동 | R1: P-코드 — new/_actions.ts canCreateProject 통과 시 생성, repositories/projects.ts:147 role:'owner' 자동 등록 |
| QA-PRJ-006 | hq + assigned/none | CTA 노출 여부 + `/projects/new` 직접 접근 후 생성 시도 | CTA 비노출, 생성 액션 거부 (`canCreateProject`: global만) — QA-ACC-013과 동일 게이트의 액션 측 검증 | P0 | vitest+수동 | R1: P-자동 — operator-policy.test 통과 + new/_actions.ts:34 canCreateProject 거부 + page.tsx:89 CTA 게이트 |
| QA-PRJ-007 | global | 브랜드 선택 변경 | 국가 드롭다운이 브랜드에 캐스케이딩되어 축소, ISO 코드가 아닌 국가 풀네임 표기 | P1 | 수동 | R1: P-코드 — new/_form.tsx:56-67 rhqRegionsForBrand 캐스케이드 + countryName(ISO→풀네임) |
| QA-PRJ-008 | global | 필수값 누락 제출 | 필드별 검증 에러 — 메시지 i18n 키 사용(ko/en 전환 확인) | P2 | 수동 | R1: B-실측 — 육안 확인 필요 (check:strings 전역 통과가 간접 근거) |

### 4-C. 프로젝트 대시보드 (`/projects/[id]`)

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-PRJ-009 | Owner | 측정 데이터 있는 프로젝트 대시보드 조회 | KPI/서브KPI/추이/구성/랭킹 카드가 **프로젝트 스코프** 데이터로 렌더 — 표준 대시보드와 구조 패리티, 수치는 프로젝트 한정 | P1 | 수동 | R1: B-실측 — 구현 존재([id]/_data/live.ts + live.test.ts 통과). 수치 정합은 데이터 있는 프로젝트로 실측 필요 |
| QA-PRJ-010 | Owner | 측정 이력 없는 신규 프로젝트 조회 | 빈 상태 안내 렌더 (에러·NaN·무한로딩 없음) | P1 | 수동 | R1: B-실측 — 육안 확인 필요 |

### 4-D. 프롬프트 (`/projects/[id]/prompt`)

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-PRJ-011 | Owner | 후보 리스트에서 항목 선택 | draft 프롬프트로 작업 목록에 추가 (`selectFromCandidates`) | P1 | 수동 | R1: P-코드 — prompt/_actions.ts selectFromCandidates |
| QA-PRJ-012 | Owner | 수동 프롬프트 직접 입력 추가 | draft로 추가 (`addManualPrompt`) | P1 | 수동 | R1: P-코드 — prompt/_actions.ts addManualPrompt |
| QA-PRJ-013 | Owner | draft 메타 수정·삭제 | 수정 반영, 삭제 시 작업 목록에서만 제거(후보는 유지) | P2 | 수동 | R1: P-코드 — updatePromptMeta / deletePrompt 주석·구현 — 작업 목록만 제거 |
| QA-PRJ-014 | Owner | "저장 + 실행"(RUN) → 확인 다이얼로그 승인 | draft 전량 queued 전환. draft 0건이면 안내 후 no-op | P1 | 수동 | R1: P-코드 — executePrompts: draft 필터 → enqueueAll, 0건 시 no-op(_actions.ts:197-234) |
| QA-PRJ-015 | Owner, live | RUN 시 scope 푸시 | 미러 프로젝트 최초 생성 시 `scopeProjectId` 저장, 프롬프트별 `createPrompt` 푸시 후 `scopePromptId` 저장. 동일 상태로 재RUN 시 **중복 생성 없음**(idempotent) | P0 | 수동(live) | R1: P-자동 — lib/scope/project-sync.test.ts 통과 — scopeProjectId/scopePromptId 저장 훅 코드 확인. 라이브 왕복 실측은 보류(부작용 있는 액션) |
| QA-PRJ-016 | Owner, mock | RUN 실행 | 푸시는 no-op, 상태 전환만 정상 수행 | P1 | 수동 | R1: P-코드 — pushDraftPromptsToScope live-only 주석 + 호출부 — mock에서 no-op |
| QA-PRJ-017 | Owner, live+scope 장애 | scope 응답 불가 상태에서 RUN | 에러로 중단되지 않음(best-effort), 이후 재RUN으로 안전 복구 | P1 | 수동(live) | R1: P-코드 — _actions.ts:203-206 'scope outage never throws' + idempotent 훅. 장애 주입 실측은 보류 |
| QA-PRJ-018 | Owner | xlsx export → 수정 → import | 왕복 정합. text 변경은 draft 행만 반영(측정된 행은 라벨만), 미존재 id 행은 경고와 함께 스킵 | P1 | 수동 | R1: P-자동 — lib/prompts/excel.test.ts 통과 + import 로직: draft만 text 반영, 미존재 id 경고 스킵(_actions.ts:322-327) |
| QA-PRJ-040 (신규) | Owner | 프로젝트 커스텀 필드(다이나믹 스키마) 추가·타입 지정(text/select/bool)·옵션 추가·보관/복원·하드삭제·프롬프트별 값 설정 | 정상 동작. 예약어(브랜드/listType/depth1-4/퍼널단계 등) 이름 차단, 사용 중인 필드는 하드삭제 거부(보관만 허용) | P1 | 수동 | 신규(2026-07-06 도입) — 코드 확인: 9개 액션 전부 `requireOwner(projectId)` 게이트, `RESERVED_FIELD_LABELS` 영문+한글 소문자 비교, `deleteCustomFieldHard`는 `countFieldUsage>0`이면 거부. 타입별 값 검증(`bool`→"true"/"false", `select`→`field.options` 포함 여부) 확인 |
| QA-PRJ-041 (신규) | Owner(프로젝트 X만) | 프로젝트 X의 커스텀 필드 액션 호출 시 파라미터의 fieldId/promptId에 **프로젝트 Y 소속** id를 실어 보냄 | 거부돼야 함 (fieldId/promptId가 요청한 projectId 소속인지 검증) | **P0** | 수동 | **F — 신규 발견(2026-07-06 diff 감사)**: `_actions.ts`의 9개 커스텀필드 액션 전부 `requireOwner(projectId)`로 "호출자가 **어떤** 프로젝트의 Owner인지"만 확인하고, 그 뒤 `projectCustomFieldRepository.archive/restore/delete/addOption/removeOption/setValue/clearValue`([project-custom-fields.ts](../../lib/db/repositories/project-custom-fields.ts))는 `fieldId`/`promptId` **단독으로만** 조회·수정 — 그 필드/값이 실제로 `projectId`에 속하는지 재검증하는 코드가 없음. migration 0024 스키마에도 `project_custom_fields`↔`prompt_custom_field_values` 사이에 project 일치를 강제하는 FK/제약 없음. **영향**: 프로젝트 X의 Owner가 프로젝트 Y의 fieldId(UUID)를 알아내면(예: 같은 사용자가 여러 프로젝트 Owner인 경우 클라이언트 상태 뒤섞임, 또는 다른 유출 경로), Y의 커스텀 필드를 보관/복원/하드삭제하거나 Y의 프롬프트 커스텀 값을 임의로 설정/삭제할 수 있음 — 크로스 프로젝트 IDOR. **수정 완료(2026-07-06)**: `_actions.ts`에 `assertFieldInProject`/`assertPromptInProject` 헬퍼 추가, `getById(fieldId)`/`getById(promptId)` 조회 후 `.projectId !== projectId`면 `UnauthorizedError`. `addCustomFieldOption`/`removeCustomFieldOption`/`archiveCustomField`/`restoreCustomField`/`deleteCustomFieldHard`/`setPromptCustomFieldValue`/`clearPromptCustomFieldValue` 7개 액션 전부 `requireOwner` 직후 적용 확인. vitest 419/419 통과 — P-자동 |
| QA-PRJ-042 (신규) | Owner | 커스텀 필드 추가/값 설정이 `flagPromptsForReanalysis`(재분석 큐)를 건드리는지 | 건드리지 않아야 함(메타데이터 전용, 분석 파이프라인과 무관) | P2 | 수동 | 코드 확인: `_actions.ts` 헤더 주석이 "재분석 플래그는 절대 건드리지 않는다"를 명시, 실제 9개 액션 어디에도 `flagPromptsForReanalysis` 호출 없음 — P-코드 |
| QA-PRJ-019 | (Owner/Viewer) × (operator=global/assigned-active/assigned-inactive/none) 매트릭스 | 비용 게이트: RUN 실행 권한 | `canOperateProject`([operator-policy.ts:29](../../lib/auth/operator-policy.ts#L29))가 판정 — global은 스코프 내 전 프로젝트, assigned는 active 멤버십 프로젝트만(role 무관, Viewer도 가능), none은 Owner라도 거부. QA-PRJ-039(인텐트수집)와 동일 함수·동일 매트릭스 — 정정: 이전 버전이 `canRunMeasurement`라는 존재하지 않는 함수명을 잘못 기재했었음 | P0 | vitest+수동 | R1: P-자동 — `operator-policy.test.ts::canOperateProject` 7건이 이 매트릭스를 전수 커버(admin 바이패스/none 항상 거부/global 무조건 허용/assigned+active 허용/assigned+null 거부/assigned+pending 거부/vendor 거부). RUN·인텐트수집(PRJ-039) 양쪽 액션 파일이 이 함수 하나만을 게이트로 호출함을 코드로 확인 — 별도 라이브 검증 불필요 |

### 4-E. 분석·퍼널·인텐트

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-PRJ-020 | Viewer | `/analysis` 진입 | `/analysis/mention` 리다이렉트, mention/citation 뷰 + 답변 모달 렌더 (프로젝트 스코프 데이터) | P1 | 수동 | R1: P-코드 — analysis/page.tsx redirect + loadProjectAnalysisContext 멤버십 게이트 + MentionsView 렌더 |
| QA-PRJ-021 | Viewer | `/ai-funnel` 진입 | `/ai-funnel/conversion` 리다이렉트 | P2 | 수동 | R1: P-코드 — ai-funnel/page.tsx:12 redirect 확인 |
| QA-PRJ-022 | Owner | conversion 화면 — GA4 매핑 유무 비교 | (brand,country)가 GA4 property-map에 매핑된 단일 스코프 프로젝트(예: Kia IT)만 라이브 지표, 미매핑 프로젝트는 빈/비활성 상태 안내 | P1 | 수동(live) | R1: P-실측 — R2: 완전 재시작 후 GA4_PROPERTY_ID legacy env fallback(property-map.ts:42)이 Kia/IT에 정상 적용됨을 실측 확인. 최초 관찰된 '미연동'은 build+dev 동시 실행에 의한 검수자측 프로세스 오염이 원인이었음(앱 결함 아님) |
| QA-PRJ-023 | Owner(operator=global 또는 active+assigned) | `/intent` 진입 → 키워드 후보 추가·추적 등록·해제 | `/intent/google-keyword` 리다이렉트, `addCandidate`/`addTrackedKeyword`/`removeTrackedKeyword` 정상 반영 | P1 | 수동 | R1: P-코드 — intent/page.tsx redirect + intent/_actions.ts 3개 액션, 페이지 멤버십 게이트 확인. 운영자 게이트 매트릭스는 QA-PRJ-039로 분리 |
| QA-PRJ-039 | (Owner/Viewer) × (operator=global/assigned-active/assigned-inactive/none) 매트릭스 | intent 수집 액션 3종 시도 | [GGMD 3-2 유저 시나리오](https://customer-wiki.example.invalid/wiki/spaces/GGMD/pages/42336497) — "운영자 게이트 3종"(생성·**인텐트수집**·실행) 중 인텐트수집 축. `canOperateProject`([operator-policy.ts:29](../../lib/auth/operator-policy.ts#L29))는 멤버십 role(owner/viewer)이 아니라 operator authority로 판정: operator=global이면 **Viewer도 허용**, operator=none이면 **Owner도 거부**, operator=assigned는 active 멤버십이면 role 무관 허용. QA-PRJ-019(RUN)와 동일 축 — 인텐트수집에서 이 매트릭스가 누락돼 있던 갭을 메움 | P0 | vitest+수동 | R1: P-자동 — QA-PRJ-019와 동일 근거(`canOperateProject` 단위테스트 7건). `intent/_actions.ts::requireOperate`가 이 함수만을 호출(addCandidate/addTrackedKeyword/removeTrackedKeyword 3개 액션 전부 동일 경로) — 코드로 확인 완료 |

### 4-F. 설정 (`/projects/[id]/setting`)

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-PRJ-024 | Owner / Viewer 대조 | general-form 수정 제출 | Owner 성공, Viewer는 `requireOwner`에서 거부 | P0 | vitest+수동 | R1: P-자동 — setting/_actions.test.ts 13건 통과 + requireOwner(updateProject, _actions.ts:158) |
| QA-PRJ-025 | Owner | 경쟁사(tracked competitor)·자사 모델(vehicle) 추가/삭제 | 반영 후 관련 지표 화면에 추적 대상 변경 반영 | P1 | 수동 | R1: P-자동 — setting/_actions.tracked.test.ts 10건 통과 |
| QA-PRJ-026 | Owner | owned-bases 추가/삭제 | 반영 (자사 도메인 판정 기준 변경) | P1 | 수동 | R2: 이 dev DB에 `migration 0021`(project_owned_bases) 미적용 확인 — graceful degrade로 항상 빈 목록만 반환됨(B-실측/환경, F 아님). **실행 전 마이그레이션 상태 확인 필수**, 미적용 환경에서는 케이스 스킵 |
| QA-PRJ-027 | Owner / Viewer 대조 | tracked URL 추가·삭제 + xlsx export/import | 변경(추가·삭제·import)은 Owner만, **export는 active 멤버 누구나**(Viewer 포함) 허용 | P1 | vitest+수동 | R1: P-코드 — _actions.ts: 변경 계열 requireOwner / exportTrackedUrlsXlsx는 requireMember(71-88) — 비대칭 구현 확인 |
| QA-PRJ-028 | Owner | 재처리(triggerReprocess) 실행 | 재집계 트리거 후 화면 데이터 갱신, 중복 실행에도 안전 | P2 | 수동 | R1: P-자동 — tracked.test 'triggerReprocess flags prompts' 통과 |
| QA-PRJ-029 | Owner | danger-zone에서 프로젝트 삭제 | 확인 절차 후 하드 삭제 — prompts·candidates·members cascade, 목록·직접 URL 모두 소멸 | P0 | 수동 | R1: P-코드 — repositories/projects.ts:63 hard delete cascade(prompts→candidates→members). UI 확인 절차는 육안 확인 권장 |
| QA-PRJ-030 | Viewer | setting 화면 진입 | mutating UI 비활성/비노출, 액션 강제 호출 시 서버에서 거부 (UI 숨김만으로 충분하지 않음) | P0 | 수동 | R1: P-코드 — 기대보다 강한 구현: Viewer/비멤버는 setting 페이지 자체 notFound(setting/page.tsx:22) + 액션도 requireOwner |

### 4-G. 멤버 (`/projects/[id]/member`)

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-PRJ-031 | Owner | 멤버 초대 | pending viewer 생성. 이메일 발송은 현 스펙상 없음(로그만) — 인앱 알림으로 수락 | P1 | 수동 | R1: P-자동 — member/_actions.test + audit.test 통과 (이메일 미발송·로그만 = 현 스펙 일치) |
| QA-PRJ-032 | 피초대자 | 초대 수락 / 거절 | 수락 시 active viewer 전환, 거절 시 행 삭제. **본인 membership만** 수락/거절 가능 — 타인 membershipId로 시도 시 거부 | P0 | vitest+수동 | R1: P-자동 — acceptInvite 소유 검증(_actions.ts:183-198) + member/_actions.test 통과 |
| QA-PRJ-033 | Owner | pending 초대 취소 | 초대 행 삭제, 피초대자 목록에서 소멸 | P2 | 수동 | R1: P-자동 — cancelInvite + 테스트 통과 |
| QA-PRJ-034 | Owner | Viewer 제거 + Owner 제거 시도 | Viewer 제거 성공. **Owner는 직접 제거 불가**(demote 후 제거) | P1 | 수동 | R1: P-코드 — removeMember: target.role==='owner' → 거부(_actions.ts:160) |
| QA-PRJ-035 | Owner | promote(viewer→owner) / demote(owner→viewer) | 전환 성공. 단 **마지막 active Owner demote는 거부**(last-owner 보호) | P0 | vitest+수동 | R1: P-자동 — setting/_actions.ts:295-296 activeOwners 검사 + _actions.test 통과 |
| QA-PRJ-036 | admin(비멤버) | 멤버십 없는 프로젝트에서 Owner 전용 액션 수행 | 성공 — admin superuser 바이패스는 **의도된 동작** (fail이 아님) | P1 | 수동 | R1: P-코드 — requireOwner: admin 바이패스(setting/_actions.ts:55, member/_actions.ts:43) — 2026-06-02 결정 주석 일치 |
| QA-PRJ-037 | Viewer | invite/remove/promote 강제 호출 | 전부 `requireOwner` 거부 | P0 | vitest+수동 | R1: P-자동 — requireOwner 경유 전수 + member/_actions.test 통과 |
| QA-PRJ-038 | 전 역할(비멤버) | `/projects/[id]` 이하 임의 URL 접근 시 SNB 헤더의 프로젝트 메타(이름/설명/생성일) 노출 여부 | 리프 페이지 본문은 정확히 404 차단되지만, 공용 레이아웃([layout.tsx:91-99](../../app/[locale]/(dash)/layout.tsx#L91-L99))이 멤버십 검사 없이 `projectRepository.getById`를 호출해 이름·설명·생성일이 노출됨 | P1 | 수동 | R2: F → **수정 완료(2026-07-02)**: layout.tsx에 리프 페이지와 동일한 `findMembership`+admin 바이패스 게이트 추가. 프로덕션 빌드(`next build`+`next start`)로 재검증 — 비멤버(vendor·country) 노출 0건, 실제 멤버(hq)·admin 바이패스는 회귀 없음. vitest 364/364 통과. **R3(2026-07-03, 실 프로덕션 `<production-host>`) 재확인**: vendor→비멤버 프로젝트, country→비멤버 프로젝트 양쪽 모두 프로젝트명 노출 0건, `NEXT_HTTP_ERROR_FALLBACK;404` digest로 정확히 차단 — P-실측 |

## 시트 5 — 웹사이트 그룹 (P1)

대상: `/website`, `/website/answer-analysis/{mention,citation}`,
`/website/ai-funnel/{acr,conversion}`. 라우트 접근 자체는 시트 1(#13~19)에서
이미 검증 — 이 시트는 웹사이트 그룹 고유 로직(데이터 소스·brand 필터 게이팅·
빈 상태)만 다룬다.

**R3 메모리 정정**: 기존 백로그 메모("website-official-site-backlog" —
"/website는 표준 데이터 임시 공유")는 **더 이상 정확하지 않다.**
[`_data/live.ts`](../../app/[locale]/(dash)/website/_data/live.ts#L29-L33) 코드
확인 결과 website는 `website_sites`의 (brand×country) scope 프로젝트 전용
집계를 쓰는 자체 데이터 경로가 이미 구현돼 있다(Standard는 루트 scope
프로젝트, Website는 사이트별 scope 프로젝트 DISTINCT ON 합산 — 별도 소스).
"임시 공유" 문서는 갱신 필요.

| ID | 역할/전제 | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| QA-WEB-001 | admin | `/website` DimensionFilterPanel 확인 | brand 축이 필터 옵션으로 노출(scope.all이라 `?brand` URL 값 반영) | P1 | 수동 | R3: P-코드 — `website-filters.tsx:38` `isAdmin ? ["brand"] : []` |
| QA-WEB-002 | hq/region/country | 동일 확인 | brand 축 비노출(하드락) — geography/language/engine/time만 | P1 | 수동 | R3: P-코드 — 동일 코드, 비admin은 빈 배열 |
| QA-WEB-003 | hq | `website_sites.scope_project_id` 미채워진(측정 런 없는) 시장 조회 | "측정 대기" EmptyState 렌더, 에러·NaN 없음 | P1 | 수동 | R3: P-코드 — `getLiveWebsiteDashboard`: `agg.totalAnswers===0 → return null` → page가 EmptyState 분기(주석 확인). 실제 화면 렌더는 B-실측 |
| QA-WEB-004 | hq | `/website` KPI #16(SOV) | 웹사이트도 타겟 지정 개념 없어 자동(SOV 1위) 분모 — 프로젝트/표준과 동일 규칙 | P2 | 수동 | R3: P-코드 — `applyCompetitorSov` 동일 함수 재사용 확인 |
| QA-WEB-005 | hq | `/website` GEO 경쟁 지도 섹션 | 지도 비노출(`showsGeoMap: false`), 인용 현황이 메인 — scope-gateway 후속 연결 전까지 의도된 빈 섹션 | P2 | 수동 | R3: P-코드 — `geo: {markets:[],pending:[],...}` 하드코딩 확인, "scope-gateway 후속" 주석 |
| QA-WEB-006 | hq | `/website/answer-analysis/mention`, `/citation` 진입 | 표준과 동일 뷰 컴포넌트(MentionsView/CitationsView) 재사용, 데이터만 website 소스 | P1 | 수동 | R3: B-실측 — 컴포넌트 재사용 여부는 import 경로로 유추 가능하나 이번엔 미확인, 다음 라운드 권장 |
| QA-WEB-007 | hq | `/website/ai-funnel/acr` 직접 URL 접근 (SNB 비노출, hidden) | 접근 허용 — "ACR 메뉴는 표준에서만 노출" 정책과 일관 | P2 | vitest | R3: P-자동 — route-policy.test 커버(시트1 #18과 동일 근거) |
| QA-WEB-008 | hq | `/website/ai-funnel/conversion` | GA4 매핑 로직 재사용 여부 확인 | P1 | 수동 | R3: B-실측 — property-map.ts가 website 프로젝트까지 커버하는지는 미확인, 다음 라운드 권장 |

## 시트 6 — 공통·횡단 (P2)

케이스 도출 축: ① i18n — ko/en 전환 시 미번역 키·한글 하드코딩 없음
(`check:strings` 자동 + 육안) ② 데이터 모드 — mock↔live env 전환만으로 동작,
live 빈 데이터 상태 처리 ③ 시각 정체성 — 컴포넌트 hex 리터럴 없음(grep 자동),
HMG 토큰 적용 ④ 주요 화면별 빈/에러/로딩 상태 ⑤ Hyundai Sans 미존재
환경(gitignored 폰트) 폴백.

| ID | 시나리오 | 기대결과 | 우선순위 | 자동화 | 결과 |
| --- | --- | --- | --- | --- | --- |
| QA-COM-001 | 컴포넌트 hex 리터럴 검사 (`grep -rnE "#[0-9A-Fa-f]{6}" app components`) | `app/globals.css` 외 매치 0건 | P2 | 수동(grep) | R1: F(97건) → **2026-07-03 부분 조치**: SVG/DOM 렌더 컨텍스트에서 기존 `@theme` 토큰과 정확히 일치하는 8곳을 `var(--color-*)`/Tailwind 유틸(`bg-brand-700` 등)로 치환(`google-keyword-view.tsx`, `visibility-view.tsx`, `conversion-view.tsx`, `acr-view.tsx`, `gnb-rail.tsx`). **남은 항목은 기계적 치환이 부적절함이 확인됨**: (a) `context-node-map-view.tsx`/`node-map/build-graph.ts`/`social-scraping/context-graph.tsx`의 Canvas 2D(`ctx.fillStyle`/`strokeStyle`) 및 `backgroundColor` prop은 CSS 변수를 직접 소비 못 함 — `getComputedStyle` 런타임 해석 등 별도 리팩터 필요 (b) `trend-chart.tsx`/`live-trend-chart.tsx`/`composition-panel.tsx`/`mentions-view.tsx`/`citations-view.tsx`의 10계열 카테고리 팔레트·출처 카테고리 색상은 `@theme`에 대응 토큰이 아예 없음 — 신규 토큰 추가는 디자인 결정이라 임의 생성하지 않음 (c) `_data/sample.ts`의 `BATTLE_BRAND_COLORS`는 "경쟁사 식별색" 목적의 의도된 로컬 컨벤션(코드 주석으로 이미 명시)이라 애초에 위반 아님 — grep 규칙 자체가 이 예외를 인식 못 하는 게 문제 | P2 | 수동 | R1: F → 부분 수정, 나머지는 제품/디자인 판단 대기 |
| QA-COM-002 | ko/en 전환 시 한글 하드코딩·미번역 키 검사 (`npm run check:strings`) | 위반 0건 | P1 | check:strings | R1/R3: P-자동 — 전 라운드에 걸쳐 반복 실행, 매번 "OK: no hardcoded Hangul UI strings detected" |
| QA-COM-003 | `SCOPE_MODE=mock`↔`live` 전환만으로 데이터 소스 교체 | 코드 변경 없이 동작 | P1 | 수동 | R3: P-코드 — `lib/scope/index.ts:16` `process.env.SCOPE_MODE ?? "mock"`로 `MockScopeClient`/`HttpScopeClient` 분기, 미설정 시 mock 기본값. R2·R3 전 라운드가 실제로 이 스위치(로컬 dev는 live, 별도 mock 검증 없음)로 진행됐음 — **역으로 mock 모드 자체의 화면 회귀는 이번 QA에서 실측 안 됨**, 다음 라운드 후보 |
| QA-COM-004 | 측정 런 없는 신규 스코프 조회 시 빈 상태 처리 일관성 | 에러·무한로딩 없이 EmptyState | P1 | 수동 | R3: 부분 확인 — website(QA-WEB-003)·프로젝트 신규(QA-PRJ-010, B-실측)에서 개별 확인 중, 화면 간 EmptyState 컴포넌트 재사용 일관성까지는 미확인 |
| QA-COM-005 | Hyundai Sans 미탑재 환경에서 폰트 렌더링 | 폰트 404 없이 대체 폰트로 정상 렌더 | P2 | 수동 | R3: **케이스 전제 자체가 낡음, 정정**: `app/globals.css:88-90` 주석 "keep Hyundai Sans out of the runtime stack until the licensed files exist so every page avoids repeated font 404s" — Hyundai Sans는 애초에 `--font-head`/`--font-text` 스택에 아예 없고 Pretendard만 활성. "폴백"이 아니라 "미도입" 상태. 실측 대상은 Pretendard 정상 로드 여부로 축소 |
| QA-COM-006 | `lib/scope/server.ts::FILTER_AXES`(캐시 정규화 화이트리스트)가 `StandardFilters`의 모든 배열형 축을 실제로 포함하는지 | 신규 필터 축 추가 시 이 목록에서 누락되지 않아야 함 — 누락되면 `normalizeFilters`가 조용히 삭제해 해당 필터가 죽음 | P0 | 수동(코드 대조) | **F(과거 3회 재발) → 2026-07-06 구조적 조치 확인**: `brandPresence`(최초) → `lang`/`websiteCountry`(2026-07-03) → `sourceCategory`(2026-07-06, Citation Sources 카드/파이/뱃지 축) 순으로 동일 버그가 3번 재발 — 원인은 `server.ts`가 `StandardFilters` 인터페이스와 **별개로 손으로 유지하는 중복 목록**이었기 때문(둘이 서로 모르게 드리프트). 해결: `FILTER_AXES`를 `result-adapter.ts`의 단일 매니페스트 `STANDARD_FILTER_ARRAY_AXES`(인터페이스 바로 옆에 위치)에서 가져오도록 변경 — 이제 목록이 하나뿐이라 "두 사본이 따로 논다"는 재발 경로 자체가 막힘. **잔존 리스크**: `satisfies readonly (keyof StandardFilters)[]`는 원소 유효성만 검증하고 완전성(모든 키 포함)은 컴파일 타임에 강제하지 않음 — 신규 배열형 축을 추가하면서 매니페스트에 넣는 걸 잊으면 여전히 조용히 샌다(개수는 3→1 지점으로 줄었을 뿐, 0은 아님). `dateFrom`/`dateTo`/`contextBrand`/`ownEntities`(스칼라·객체형 축)는애초에 이 배열 방식이 아니라 `normalizeFilters` 본문의 개별 exemption 라인으로 보존되므로 이 패턴과 무관(2026-07-06 오탐 조사로 확인, 위 방법론 참조). **추가 확인**: `components/dash/standard-filters.ts::standardFilterKey`(클라이언트 Suspense 캐시 키 — 서버 `normalizeFilters`와는 별개 메커니즘)도 동일 axis를 손으로 나열한 두 번째 사본이었음이 드러나 같은 `STANDARD_FILTER_ARRAY_AXES`로 통합됨 — 이 파일은 이번 사고(sourceCategory 누락)엔 안 걸렸지만 잠재적 3번째 드리프트 지점이었음. vitest 393/393, `hmg-brands.test.ts`(`trackedRosterFor`/`intersectOrFallback` 경유) 7건 포함 통과 |
| QA-COM-007 (신규) | 멘션 측정 정확도 — Apple/Google/Samsung이 자동차 브랜드가 아니라 커넥티비티 기능명(Apple CarPlay, Google Maps 등)으로 언급된 경우 경쟁 브랜드 mention에서 제외되는지 | 기능 병기 occurrence는 제외, 순수 브랜드 언급만 카운트 | P1 | 수동 | 신규(2026-07-06, `correctProductReferenceBrandMention`) — [case-sensitive-brands.ts](../../lib/scope/mirror/case-sensitive-brands.ts) 확인: 실측 근거 명시(Apple 4205건 중 88.9%가 제품명 병기), `sync.ts` 실시간 동기화 파이프라인에 체이닝 확인(`correctCaseSensitiveBrandMention` 다음 단계, 로직은 P-코드). 기존 SEAT 오분류 보정과 동일 패턴. **백필 스크립트**(`scripts/db/backfill-product-reference-mention-correction.ts`)는 `--dry-run` 지원 + idempotent 명시하나, 기존 `scope_mentions` 데이터에는 **실행 전까지 반영 안 됨**(B-실측/운영) — 배포 체크리스트에 실행 필요 항목으로 남겨야 함 |
| QA-COM-008 (신규) | `DimensionFilterPanel`의 brand 드롭다운에서 "HMG"(umbrella) 옵션 제거 | 회귀 없음 — `brandPresence="unbranded"`가 동일 데이터를 이미 커버 | P2 | 수동 | 코드 확인: root 카탈로그에 brand='HMG' 프롬프트 0개라 드롭다운에서 제외(2026-07-06), 주석에 "브랜드 무관 프롬프트가 추가되면 재검토" 명시 — P-코드, 저위험 |
