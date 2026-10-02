## Context

직전 change `add-supabase-persistence-auth`로 **인증·역할·범위의 서버사이드 백본은 완성**됐다
(Supabase Auth, `profiles` 테이블, `roleEnum`, `scope-policy.ts`, `lockdown.sql`, 시드).
다만 UI는 `DashLayout`이 `isAdmin`만 분기하고 관리자 콘솔이 stub이라, 사수가 요구한 *"권한별
실제 접근 제어가 작동한다"* 는 데모를 만들 수 없다.

이번 change는 **새 백엔드를 짓지 않는다**. 이미 깔린 `profiles` + `scope-policy` 위에 라우팅
정책, 관리자 액션, 페이지 stub만 얹는다. 데드라인은 월요일.

## Goals / Non-Goals

**Goals**
- 4역할 × 5라우트 가시성/접근 매트릭스가 단일 정책 모듈로 표현되고, **클라우회 불가**.
- 관리자가 콘솔 UI에서 사용자 생성·역할 변경·범위 부여를 끝낼 수 있음.
- PDF IA의 5개 메뉴가 라우트로 존재 (텍스트 한 줄 stub 허용).
- `country` 역할이 도착할 곳이 명시적으로 존재(`/no-access`).
- 단위 테스트로 매트릭스 검증 — 회귀 안전망.

**Non-Goals**
- BI 적용(폰트/색상/헤더 톤) — `apply-hyundai-bi` 별도.
- 비밀번호 재설정/초대 메일 흐름.
- 감사 로그 풀 UI (lib/audit.ts 결과 뷰).
- `/dashboard`의 실제 데이터 흐름 확장 (scope mock 그대로).
- profiles 컬럼 스키마 변경.

## Decisions

### D1. 라우트 정책의 단일 진실의 원천 — `lib/auth/route-policy.ts`

`scope-policy.ts`(데이터 범위)와 같은 패턴으로 **별도 모듈**.

```ts
// lib/auth/route-policy.ts
import type { Role } from "./types";

// Auth 뒤 라우트 정의 + 역할별 접근. canSeeMenu == canAccess.
// 추가 정책(예: 메뉴엔 안 보이지만 직접 URL은 가능)이 생기면 이 표를 쪼개면 됨.
export const ROUTES = [
  { path: "/dashboard",         key: "dashboard",        roles: ["hq","admin"] },
  { path: "/customer-interest", key: "customerInterest", roles: ["hq","region","admin"] },
  { path: "/ai-answers",        key: "aiAnswers",        roles: ["hq","region","admin"] },
  { path: "/projects",          key: "projects",         roles: ["hq","region","admin"] },
  { path: "/admin",             key: "admin",            roles: ["admin"] },
] as const;

export type RouteKey = (typeof ROUTES)[number]["key"];

export function canAccessRoute(role: Role, path: string): boolean { /* ... */ }
export function visibleRoutes(role: Role): typeof ROUTES[number][] { /* ... */ }
export function defaultLandingFor(role: Role): string {
  return visibleRoutes(role)[0]?.path ?? "/no-access";
}
```

**왜 별 모듈인가** — `scope-policy.ts`(데이터 필터)는 *값*을, `route-policy.ts`(라우트 가시성)는
*위치*를 결정한다. 섞으면 한 함수가 두 콘셉트를 다루게 되고 테스트도 흐려진다.

**대안 비교**
- ❌ 매 page에서 인라인으로 `if (role !== "admin") redirect(...)` — 매트릭스가 코드 전체에 흩어짐.
- ❌ middleware에서만 — i18n 라우팅, 정적 자산, edge 컨텍스트 등과 엉킴. dev 디버깅 어려움.
- ✅ 단일 정책 + 두 진입점에서 사용: (1) `(dash)/layout.tsx`가 네비/가드, (2) `_actions.ts`가 admin 액션 권한 체크 (별도 `canAccessAdmin`).

### D2. 가드는 **layout** 한 곳에서

각 page 컴포넌트 첫 줄에 게이트 박는 대신 `app/[locale]/(dash)/layout.tsx`에서:

```ts
const session = await getSession();
if (!session) redirect(`/${locale}/login`);
const path = "/" + (segment); // App Router의 active segment에서
if (!canAccessRoute(session.user.role, path)) {
  redirect(`/${locale}/no-access`);
}
```

App Router는 layout이 모든 자식 page에 대해 평가되므로 **한 곳에서 막힌다**. 매 page에 코드
복붙하지 않음.

단, `/no-access` 자체는 게이트를 통과해야 하므로 **`(dash)` 그룹 밖** 또는 그룹 안에서
`canAccessRoute`의 화이트리스트 예외로 처리. 후자(그룹 안 + 예외)가 더 단순.

### D3. 로그인 후 redirect — 모두 `/dashboard`로 보낸 뒤 가드가 분기

```
로그인 성공 → /dashboard (locale 접두 포함)
              └─ layout 가드:
                   role=hq/admin → 그대로
                   role=region   → /customer-interest (defaultLandingFor)
                   role=country  → /no-access
```

**왜** — 분기 1군데. 로그인 액션이 역할에 따라 6가지 destination을 분기하면 가드 로직과 중복.
가드가 어차피 매번 평가되므로 디폴트 도착지를 가드에서 결정.

### D4. 관리자 콘솔 UI 구조

```
app/[locale]/(dash)/admin/
├── page.tsx                    # 권한 체크 → 목록 + 생성 폼 렌더
├── _actions.ts                 # 'use server' — Admin API server actions
└── _components/
    ├── user-list.tsx           # profiles + auth.users 메타 표시
    ├── create-user-form.tsx    # 이메일만 입력 → 임시 비번 발급
    ├── temp-password-toast.tsx # 1회 표시 + 복사 버튼
    ├── role-select.tsx         # 4역할 드롭다운, change 시 server action
    └── scope-editor.tsx        # brands/regions/countries 다중 입력
```

**Server action 위생** (모두 첫 줄에 권한 체크):

```ts
"use server";
async function assertAdmin() {
  const s = await getSession();
  if (!s || !canAccessAdmin(s.user)) throw new Error("unauthorized");
  return s;
}
export async function createUser(formData) {
  await assertAdmin();
  // 1) Supabase Admin API: POST /auth/v1/admin/users { email, password, email_confirm:true }
  // 2) profiles insert (id = auth user id, role=default(country), scope_all=false)
  // 3) 실패 시 auth.users 롤백(DELETE) — best-effort
  // 4) audit.log(actor, "create_user", target)
  // 5) return { tempPassword }  // UI에 1회 표시
}
```

`SUPABASE_SERVICE_ROLE_KEY`는 **server action 내부에서만** 사용. `lib/supabase/admin.ts`
같은 server-only 헬퍼로 캡슐화하고 import는 server file에서만 (lint 규칙으로 강제).

### D5. 임시 비밀번호 정책

- 16자, 대/소/숫자/특수 보강 (지난 admin 추가 때 쓴 방식과 동일).
- 생성 직후 UI에 **1회 표시 + 복사 버튼**.
- DB/세션 어디에도 저장 X (Supabase가 해시로만 보관).
- 사용자가 첫 로그인 후 직접 변경 (비밀번호 변경 페이지는 본 change 범위 밖 — Supabase의
  기본 흐름이나 후속 change).

### D6. profiles repository 확장

```ts
// lib/db/repositories/profiles.ts
list(): Promise<ProfileRow[]>            // 신규
update(id, patch: Partial<ProfileRow>)   // 신규
// 기존: getById(), insert() 등
```

업데이트는 **부분 업데이트** — 역할만 바뀌면 role만, 범위만 바뀌면 scope 컬럼만.
`updatedAt`은 server-side 강제 갱신.

### D7. 신규 stub 페이지의 무게

PDF 사수 지시 "텍스트 한 줄"의 정신을 따르되, **기존 `/projects`·`/admin` stub과 동일 패턴**
유지 (제목 + subtitle 1줄 + `SectionCard` + `EmptyState`). 일관성 우선.

### D8. country가 받을 메시지

`/no-access` 페이지:
- 헤더: "접근 가능한 메뉴가 없습니다"
- 본문: "관리자에게 권한 부여를 요청해 주세요."
- 로그아웃 버튼만 (현재 DashLayout의 logout form 재사용)
- DashLayout 메뉴/배지/locale switcher는 그대로 렌더 (UI 일관성)

## Risks / Trade-offs

- **[가드를 layout에 두면 dynamic segment에 약하다]** — `(dash)/admin/users/[id]` 같은 동적
  자식 라우트가 생기면 layout이 그것까지 평가해야 한다.
  → **Mitigation**: 현재 라우트는 전부 평탄(평면). 동적 자식 생기면 그때 layout의 path 계산을
    `nextUrl.pathname` 기반으로 보강 (server component에서 `headers()` 또는 `next/headers`로 path 획득).

- **[Admin API 호출 후 profiles insert 실패 시 inconsistent state]** — auth.users는 생겼는데
  profiles 없으면 그 사용자는 로그인은 되지만 역할이 없는 상태.
  → **Mitigation**: profiles insert 실패 시 즉시 `DELETE /auth/v1/admin/users/{id}` 호출하여
    롤백. 롤백마저 실패하면 audit에 critical로 남기고 관리자에게 표시.

- **[임시 비밀번호가 채팅/transcript에 남는 위생 이슈]** — 시연 단계에선 OK이지만 실제 운영에선
  토스트 1회 표시만으로 충분하지 않을 수 있음.
  → **Mitigation**: 본 change에서는 1회 토스트로 통일. 운영 진입 시점에 비밀번호 재설정 메일
    흐름을 별 change로 추가 (Supabase의 기본 `generateLink` 사용 가능).

- **[/no-access에 도달한 country 사용자가 자력으로 빠져나갈 수단이 없음]** — 의도된 빈 상태.
  → **Mitigation**: 빈 상태 본문에 *관리자에게 요청* 문구 + 로그아웃 버튼. 이 자체가 시연 가치.

- **[i18n 키 누락 시 한글이 영어 모드에서도 한글로 노출]** — 현재 `check:strings`가 JSX 한글
  하드코딩만 잡지, 사전 누락은 못 잡음.
  → **Mitigation**: ko.json/en.json 두 파일을 같은 키 셋으로 PR에서 짝지어 변경. 추후 사전
    무결성 lint를 다른 change로 추가 가능.

- **[layout이 매 요청마다 session+route policy 평가 → 비용]** — `dynamic = "force-dynamic"`로
  이미 SSR. 추가 비용 미미.

## Migration Plan

- **DB**: 변경 없음. 새 마이그레이션 X. 기존 사용자 그대로 사용.
- **환경변수**: 변경 없음. `SUPABASE_SERVICE_ROLE_KEY`는 이미 `.env.local`에 있음.
- **배포 순서**: 단순 코드 배포. feature flag 불필요.
- **롤백**: 코드 revert만. 데이터 변경 없음 (관리자 콘솔에서 생성된 사용자는 그대로 남음).

## Open Questions

- **`nav.projects` 라벨**: 현재 "프로젝트" → PDF의 "개별 프로젝트 생성"으로 변경할지.
  *디폴트 결정: 변경한다.* (사수 추가 의견 있으면 반영.)
- **사용자 비활성/삭제 UI**: 본 change에서 포함할지. *디폴트: 포함하지 않음, 후속 change.*
- **Site URL / Allowed redirect URLs**: 시연 호스트가 결정되면 Supabase 콘솔에서 추가
  (코드 변경 아님).
