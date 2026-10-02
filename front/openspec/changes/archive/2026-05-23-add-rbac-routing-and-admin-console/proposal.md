## Why

사수의 월요일 데드라인 요청: **로그인 + 어드민의 권한 관리 + 권한별 실제 접근 제어**가 작동해야
하고, IA·네비게이션·목업 페이지(텍스트 한 줄짜리 stub OK)가 같이 잡혀 있어야 함.
auth 백본과 `profiles`(role + scope) 스키마는 직전 change(`add-supabase-persistence-auth`)에서
끝났지만, **UI 게이트와 관리자 콘솔이 비어 있어** 권한이 "실제로 작동"한다고 시연할 방법이 없다.

## What Changes

- **신규 라우트 2개 (목업 stub)**: `/customer-interest`(고객 관심 대시보드),
  `/ai-answers`(AI 답변 대시보드). 모두 기존 `/projects` 동일 패턴 — title + 한 줄 subtitle +
  `SectionCard`+`EmptyState`. PDF Use Case 표의 메뉴 분리를 라우트로 옮김.
- **신규 빈 상태 페이지**: `/no-access` — `country` 역할(PDF 메뉴 빈칸)이 도착할 곳.
  로그아웃 버튼 외 액션 없음.
- **네비게이션 가시성 매트릭스** (4역할 × 5라우트). 현재 `DashLayout`은 `isAdmin`만 분기 →
  4×5 매트릭스로 교체. 진실의 원천은 단일 정책 모듈.
- **라우트 가드 매트릭스** — 서버사이드. 매트릭스 `❌`인 URL을 직접 입력해도 차단(`/no-access`로
  redirect). 정책은 `lib/auth/route-policy.ts`(신설, `scope-policy.ts` 패턴 따라).
- **관리자 콘솔 UI** (이번 change의 가장 무거운 부분, `/admin` stub 교체):
  - 사용자 목록 (profiles + auth.users 메타 join: email, role, scope, created_at, last_sign_in)
  - 사용자 생성: server action → Supabase Admin API `POST /auth/v1/admin/users`
    (`email_confirm: true`) → profiles row 삽입 (트랜잭션적 best-effort)
  - 역할 변경 드롭다운 (HQ / 권역 / 국가 / 관리자) — server action
  - 범위(brands / regions / countries) 부여 — server action
- **`profiles` repository 확장**: `list()`, `update()` 메서드 추가 (현재 `getById`만 있음).
- **i18n 키 신규**: `nav.{customerInterest, aiAnswers}`, `customerInterest.*`, `aiAnswers.*`,
  `noAccess.*`, `admin.*` 확장. `nav.projects` 라벨을 "프로젝트" → "개별 프로젝트 생성"
  으로 PDF 표현에 정렬.
- **Auth 정책 명시화**: `mailer_autoconfirm: false` 유지 — 관리자 콘솔의 사용자 생성 액션이
  `email_confirm: true`로 만들어 즉시 사용 가능하게. README/spec에 명시.
- **로그인 직후 redirect 정책**: 모두 `/dashboard`로 보내고 라우트 가드가 country를
  `/no-access`로 보내게(분기 1군데, 단순).

범위 밖(별도 change): Hyundai BI 적용(`apply-hyundai-bi`), 감사 로그 풀 UI, 비밀번호 재설정/
초대 메일 흐름, `/dashboard`의 데이터 흐름 확장.

## Capabilities

### New Capabilities

(없음 — 이번 change는 기존 spec들에 요구사항을 추가/수정한다.)

### Modified Capabilities

- `access-control`: 역할→스코프 매핑(기존)에 더해, **역할→라우트 접근 정책**과 **관리자가
  사용자/역할/범위를 변경하는 권한 있는 액션**을 명시한다. 라우트 가시성 매트릭스 + 가드
  매트릭스가 요구사항으로 들어온다.
- `app-foundation`: 라우트 표가 5개로 확장(통합/고객관심/AI답변/프로젝트/관리자) + `/no-access`
  보조 라우트. `DashLayout` 네비는 역할별 가시성 매트릭스에 따라 렌더한다.
- `localization`: 새 화면·관리자 콘솔·빈 상태에 대한 메시지 키가 추가되고, JSX 한글 하드코딩
  금지 원칙은 그대로 유지된다.
- `persistence-foundation`: `profiles` repository에 `list()`와 `update()`를 추가한다. RLS
  없는 모델은 그대로 — 모든 호출은 server-only, repository 경계 강제도 그대로.

## Impact

- **코드(주요)**:
  - `app/[locale]/(dash)/layout.tsx` — 네비 가시성 매트릭스
  - `app/[locale]/(dash)/customer-interest/page.tsx` (신규)
  - `app/[locale]/(dash)/ai-answers/page.tsx` (신규)
  - `app/[locale]/(dash)/no-access/page.tsx` (신규)
  - `app/[locale]/(dash)/admin/page.tsx` — stub 교체
  - `app/[locale]/(dash)/admin/_actions.ts` (신규) — Supabase Admin API server actions
  - `app/[locale]/(dash)/admin/_components/*` (신규) — 목록/생성 폼/역할·범위 셀렉터
  - `lib/auth/route-policy.ts` (신규) + `route-policy.test.ts`
  - `lib/auth/redirect.ts` 또는 layout 내 헬퍼 — 로그인 후 디폴트 도착지 결정
  - `lib/db/repositories/profiles.ts` — `list()`, `update()` 추가
  - `messages/ko.json`, `messages/en.json`

- **외부 API**: Supabase Auth Admin API
  (`POST /auth/v1/admin/users`, `PATCH /auth/v1/admin/users/:id`,
  `DELETE /auth/v1/admin/users/:id`). `SUPABASE_SERVICE_ROLE_KEY`를 server action 안에서만
  사용 — 브라우저 노출 금지(이미 환경변수 규약에 박혀 있음).

- **새 의존성**: 없음 (`@supabase/ssr`, `drizzle-orm` 등 기존 스택만 사용).

- **DB 스키마**: 변경 없음 (`profiles` 컬럼 그대로 사용). 마이그레이션 신규 X.

- **보안**:
  - 라우트 가드는 서버사이드 단일 정책. 클라이언트 라우팅만으로 차단하지 않음(우회 가능).
  - Admin 액션은 권한 체크 `canAccessAdmin(user)`를 server action 진입 첫 줄에서 강제 — 클라가
    URL을 알아도 호출 불가.
  - 임시 비밀번호 발급 시 UI에 1회 표시 후 다시 불러올 수 없게(저장 X).

- **테스트**: `route-policy.test.ts`로 4역할 × 5라우트 매트릭스 전체 검증. 기존
  `scope-policy.test.ts`는 영향 없음.

- **마이그레이션 영향**: 없음. 기존 사용자(시드 4명 + 실제 admin 1명)는 그대로 동작.
