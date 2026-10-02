## 1. i18n 사전 확장 (다른 task의 기반)

- [x] 1.1 `messages/ko.json` 에 신규 키 추가: `nav.customerInterest`, `nav.aiAnswers`, `nav.projects` 라벨 "프로젝트" → "개별 프로젝트 생성"으로 갱신
- [x] 1.2 `messages/ko.json` 에 페이지 키 추가: `customerInterest.{title,subtitle}`, `aiAnswers.{title,subtitle}`, `noAccess.{title,description,logoutHint}`
- [x] 1.3 `messages/ko.json` 에 관리자 콘솔 키 확장: `admin.list.{columns.email, columns.role, columns.scope, columns.createdAt, columns.lastSignIn}`, `admin.create.{cta, emailLabel, submit, success, tempPasswordToast, copy}`, `admin.role.{select, hq, region, country, admin}`, `admin.scope.{brands, regions, countries, placeholder}`, `admin.errors.{unauthorized, supabaseFail, rollbackFail}`
- [x] 1.4 `messages/en.json` 에 동일 키 셋을 영문으로 추가 (사전 무결성) — ko/en 각 92 키 동일
- [x] 1.5 `npm run check:strings` 통과 확인

## 2. 라우트 정책 모듈 (단일 진실의 원천)

- [x] 2.1 `lib/auth/route-policy.ts` 신규 — `ROUTES` 상수(5개 라우트 + roles 화이트리스트), `canAccessRoute(role, path)`, `visibleRoutes(role)`, `defaultLandingFor(role)` 함수 export
- [x] 2.2 `lib/auth/route-policy.test.ts` 신규 — 4역할 × 5라우트 매트릭스 전체 검증 (visibleRoutes 길이, canAccessRoute boolean, country가 항상 0개) + `defaultLandingFor` 4역할 모두 + locale prefix 정상화 + guard bypass
- [x] 2.3 `npm test` 로 신규 테스트 통과 확인 (33 tests, 100% pass)

## 3. 신규 페이지 stub 3종

- [x] 3.1 `app/[locale]/(dash)/customer-interest/page.tsx` — `/projects` 동일 패턴 (title + subtitle + `SectionCard`+`EmptyState`), `setRequestLocale` 사용, i18n에서 라벨 조회
- [x] 3.2 `app/[locale]/(dash)/ai-answers/page.tsx` — 동일 패턴
- [x] 3.3 `app/[locale]/(dash)/no-access/page.tsx` — title + 1줄 안내 + 기존 `logout` server action 재사용한 로그아웃 버튼만 노출. route-policy의 `GUARD_BYPASS_PATHS`로 화이트리스트

## 4. DashLayout — 가시성 매트릭스 + 라우트 가드

- [x] 4.1 `app/[locale]/(dash)/layout.tsx` — 현재 `isAdmin` 인라인 분기 제거, `visibleRoutes(session.user.role)` 결과로 네비 항목 매핑 (라벨은 i18n 키 → `nav[route.key]`)
- [x] 4.2 동 layout에서 active path 획득(미들웨어 `x-pathname` 헤더) 후 `canAccessRoute(role, path)` 평가 → 비허용이면 `redirect(\`/\${locale}/no-access\`)`. `/no-access` 자체는 평가 화이트리스트
- [x] 4.3 로그인 직후 도착지를 `defaultLandingFor(role)`로 분기 (`lib/auth/actions.ts` 의 `login` + `app/[locale]/page.tsx` 진입점 모두). country → `/no-access`, region → `/customer-interest`, hq/admin → `/dashboard`
- [x] 4.4 country 시드 계정으로 로그인 → `/no-access` 도착 확인 (사람 시연 완료)

## 5. profiles repository 확장

- [x] 5.1 `lib/db/repositories/profiles.ts` — `list(): Promise<ProfileRow[]>` 추가 (createdAt 내림차순) + `insert(input)` 추가
- [x] 5.2 동 파일 — `update(id, patch)` 추가, 지정 필드만 갱신 + `updatedAt = sql\`now()\`` 서버 강제
- [ ] 5.3 (선택) 단위 테스트 — 부분 업데이트가 다른 컬럼을 건드리지 않음 — **deferred (선택 task)**

## 6. 관리자 콘솔 — Server actions (server-only)

- [x] 6.1 `lib/supabase/admin.ts` 신규 — `SUPABASE_SERVICE_ROLE_KEY`로 Admin API 호출하는 server-only 헬퍼 (`adminCreateUser`, `adminDeleteUser`, `adminListUsers`, `generateTempPassword`). `import "server-only"` 가드
- [x] 6.2 `app/[locale]/(dash)/admin/_actions.ts` 신규 — `"use server"`. 첫 줄에서 `assertAdmin()` 호출 (세션 + `canAccessAdmin`)
- [x] 6.3 `createUser(formData)` — Admin API로 email_confirm:true + 임시 비번 18자 (대/소/숫자/특수) 생성 → profiles insert (role 디폴트 `country`, scopeAll false) → profiles 실패 시 Admin API DELETE 롤백 → `auditDataAccess` → `{ ok, email, tempPassword }` 반환
- [x] 6.4 `updateUserRole(userId, role)` — `assertAdmin()` 후 profiles.update + audit
- [x] 6.5 `updateUserScope(userId, { brands, regions, countries, scopeAll })` — `assertAdmin()` 후 정규화(빈 배열 → null, scopeAll=true시 다른 배열 wipe) + audit
- [x] 6.6 모든 액션에서 에러 메시지는 i18n 키만 반환 (raw Supabase 에러 노출 X — `errorKey` 형태)

## 7. 관리자 콘솔 — UI 컴포넌트

- [x] 7.1 `app/[locale]/(dash)/admin/_components/user-list.tsx` — server component. `profiles.list()` + `adminListUsers()` 메타(email, last_sign_in_at, created_at) join 후 테이블 렌더. 컬럼: email / role / scope / createdAt / lastSignIn
- [x] 7.2 `app/[locale]/(dash)/admin/_components/role-select.tsx` — client component. 4역할 드롭다운. onChange → `updateUserRole` server action + `useTransition` pending 표시
- [x] 7.3 `app/[locale]/(dash)/admin/_components/scope-editor.tsx` — client component. brands/regions/countries 각각 쉼표 구분 입력 + scopeAll 토글. Save 버튼으로 commit
- [x] 7.4 `app/[locale]/(dash)/admin/_components/create-user-form.tsx` — client component. 이메일만 입력하는 폼. 제출 후 `createUser` 반환값의 `tempPassword`를 토스트로 1회 표시
- [x] 7.5 `app/[locale]/(dash)/admin/_components/temp-password-toast.tsx` — modal. 1회 표시 + 복사 버튼 + 명시적 닫기. DOM 외 저장 X

## 8. 관리자 콘솔 — page.tsx 교체

- [x] 8.1 `app/[locale]/(dash)/admin/page.tsx` — 기존 `EmptyState` stub 제거 → `CreateUserForm` + `UserList` 렌더. 진입 시 `canAccessAdmin` 재검증(이중 가드)
- [x] 8.2 페이지 상단에 "사용자 N명" 카운터(서버 렌더) — `t("userCount", { n: profiles.length })`

## 9. 시연 검증

- [x] 9.1 `npm run build` 타입/빌드 통과 — 5개 라우트 + `/no-access` + `/admin` 모두 빌드됨
- [x] 9.2 `npm run lint` 통과 — `✔ No ESLint warnings or errors`
- [x] 9.3 `npm test` 통과 — 37 passed (4 scope-policy + 33 route-policy)
- [x] 9.4 4개 시드 계정으로 각각 로그인 → 네비 가시성 매트릭스 시각 확인 (사람 시연 완료)
- [x] 9.5 권역 계정으로 `/dashboard` URL 직접 입력 → `/no-access` 리다이렉트 확인 (사람 시연 완료)
- [x] 9.6 비관리자 계정 콘솔에서 `_actions.createUser` 직접 호출 시뮬레이션 → 권한 거부 확인 (사람 시연 완료)
- [x] 9.7 admin 계정으로 신규 사용자 생성 → 임시 비번 토스트 → 새 사용자 로그인 + 역할/범위 변경 (사람 시연 완료)
- [x] 9.8 영어 모드 신규 화면 영문 렌더 시각 확인 (사람 시연 완료) — curl로도 자동 검증됨

## 10. 정리

- [x] 10.1 README의 "열린 질문" 섹션에서 *`profiles` 관리 UI* 항목 제거 (해당 change로 해결됨)
- [ ] 10.2 `nav.projects` 라벨 변경이 사수 의도와 어긋나지 않는지 1줄 확인 (어긋나면 사전 값만 되돌림) — **사수 답장 대기**
- [x] 10.3 change archive 완료 — 2026-05-23, `openspec archive` 로 spec sync 동반
