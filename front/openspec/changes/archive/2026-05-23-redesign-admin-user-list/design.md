## Context

관리자 콘솔의 사용자 목록(`app/[locale]/(dash)/admin/_components/user-list.tsx`)은 현재 모든 편집을 행 안 인라인 컨트롤(`role-select.tsx`, `scope-editor.tsx`)로 처리한다. 셔터 빈도가 낮은 어드민 화면이지만, (a) 데모 4명에서도 시각 노이즈가 큼, (b) 시연/운영 시 사용자가 수십명만 되어도 검색 없이는 못 찾음, (c) 현재 `updateUserRole`과 `updateUserScope`가 분리되어 클라이언트에서 두 액션을 별개 시점에 호출 → 부분 저장 위험, (d) 컨테이너 + 셀 누적 border가 다른 borderless SectionCard와 톤이 어긋난다.

기존 `TempPasswordToast`는 이름은 toast지만 동작은 fixed-inset modal이라 분류상 dialog에 가깝다. 이번 변경에서 토스트 표준을 정의하면서도 해당 컴포넌트의 의미 재정의는 별도 후속으로 미룬다 (사용자 생성 즉시 비밀번호를 보여주는 1회성 UX는 fade-out 토스트보다 명시적 dismiss를 가진 modal이 더 안전하다는 판단도 있음).

## Goals / Non-Goals

**Goals:**
- 사용자 수가 수십~수백 명으로 늘어도 빠르게 찾고 편집할 수 있는 UI
- role과 scope가 항상 함께, 원자적으로 갱신되어 부분 저장이 구조적으로 불가능하게
- 저장/삭제 결과 피드백을 명확하게 (성공 = 토스트, 실패 = 다이얼로그 내 inline)
- 다른 SectionCard들과 일관된 borderless 톤
- 다이얼로그를 통한 사용자 삭제(이미 존재하는 `adminDeleteUser` 활용)

**Non-Goals:**
- 페이지네이션, 다중 정렬, 다중 필터 (검색 input 1개로 충분한 규모를 가정)
- 임시 비밀번호 재발급, 이메일 변경
- `TempPasswordToast`의 sonner 마이그레이션 (별도 후속)
- 역할/범위 변경에 대한 이메일 알림
- DB 스키마 변경

## Decisions

### D1. 검색 — client-side filter
HMG 직원 규모(수십~수백)에선 server pagination·검색이 과한 도구다. 모든 profiles는 이미 server component에서 일괄 로드되어 클라이언트로 직렬화되므로, 검색은 동일 데이터에 대한 in-memory filter로 즉각 반응한다.

**필터 대상**: 이메일 substring + 역할 표시명(번역된 라벨). 생성일/마지막 로그인은 검색 대상에서 제외 (UX 일관성).

**대안 검토**:
- Server-side 검색: 현재 규모 대비 round-trip 비용이 큼. 천 명 단위로 늘어나면 그때 도입.
- 정규식·다중 토큰: v1엔 과함. substring 매칭으로 충분.

### D2. 토스트 — sonner 도입
`sonner`는 shadcn 생태계의 표준 토스트로, 스택/오토 디스미스/접근성/포지셔닝이 모두 처리된다. dependency 1개(~3KB gz) 비용으로 자체 구현 50줄을 대체하고, 향후 다른 액션(삭제·표준 프롬프트 등록 등)에서 재사용한다.

**Mount 위치**: 인증 뒤 레이아웃 `app/[locale]/(dash)/layout.tsx`에 `<Toaster />` 한 번. 로그인 화면에는 노출하지 않는다.

**사용 규약**:
- 성공: `toast.success(...)` (e.g., "저장되었습니다", "삭제되었습니다")
- 실패: 다이얼로그 내 inline 메시지 (사용자가 같은 화면에서 즉시 재시도 가능). 토스트는 success-only.

**대안 검토**:
- 자체 토스트 컴포넌트: dep 0이지만 스택 큐/타이머/aria-live 등을 직접 구현. 향후 더 자라면 결국 sonner로 갈 가능성.
- shadcn `Toast`(deprecated): shadcn 자체가 sonner로 이전됨.

### D3. 저장 — 단일 액션 `updateUserProfile`
role과 scope는 같은 `profiles` 행에 살고 항상 함께 의미를 가진다. 분리된 두 액션을 클라이언트에서 순차 호출하면 (i) 한쪽 실패 시 부분 저장, (ii) 감사 로그가 두 줄로 쪼개짐, (iii) `revalidatePath`가 두 번 발생해 불필요한 리렌더가 생긴다.

**새 시그니처**: `updateUserProfile(userId: string, patch: { role: Role; scope: ScopeInput }): Promise<{ ok: true } | ActionError>`

서버에선 `profileRepository.update`를 1회 호출해 두 컬럼군을 atomically patch. `updatedAt`은 기존과 동일하게 서버에서 갱신.

**Deprecated**: `updateUserRole`, `updateUserScope` 완전 제거. 호출처는 EditUserDialog 단 하나라 마이그레이션 비용 작음.

### D4b. 관리자 거버넌스 — 자기 보호 + 마지막 관리자 보호 (이 change에 추가)
초기 D4는 자기 자신 삭제만 막았지만, role 변경 경로가 똑같이 lockout을 일으킬 수 있다는 비대칭이 발견되어 본 change 안에서 보강.

**규칙 두 가지:**
1. **자기 강등 차단** — admin이 본인 role을 admin이 아닌 값으로 바꾸는 것을 거부 (`cannotDemoteSelf`). 자기 삭제 차단과 대칭. 다른 admin 존재 여부와 무관하게 항상 차단 — 스텝다운이 필요하면 다른 admin이 처리.
2. **마지막 관리자 보호** — admin 강등/삭제 시 시스템에 admin이 0명이 되면 거부 (`lastAdminProtected`). repository `countAdminsExcept(id)`로 계산. 자기 삭제 차단으로 deleteUser에서는 사실상 도달 불가능한 경로지만 invariant를 명시적으로 인코딩해 향후 리팩토링 시 사라지지 않도록.

**UI 미러링**: EditUserDialog는 자기 편집 + 현재 role=admin일 때 Select에서 admin 외 옵션을 disabled + 하단 안내 텍스트. 마지막 관리자는 클라이언트가 카운트를 모르므로 시각 비활성 없이 서버 응답 시 inline error로 보임.

**대안 검토**:
- "스텝다운 허용 (자기 강등 OK)" — 더 유연하지만 자기 삭제 차단과의 비대칭이 다시 생김. 결정: 일관성 우선.
- "owner 계층 (super-admin)" — 더 강력하지만 DB 마이그레이션 필요. 후속 change로 미룸.

### D4. 삭제 — `deleteUser` 서버 액션 추가
`lib/supabase/admin.ts`에 이미 `adminDeleteUser`가 존재하지만 서버 액션 래퍼가 없어 UI에서 호출 경로가 없다.

**구현**:
1. `assertAdmin()` 통과 검증
2. `profileRepository.delete(userId)` 먼저 호출 (앱 레이어 데이터 정리)
3. `adminDeleteUser(userId)` 호출 (auth.users 제거)
4. 감사 로그 기록 + `revalidatePath`

**자기 자신 삭제 방지**: 현재 세션 사용자와 동일 userId면 거부 (`admin.errors.cannotDeleteSelf`). 잠재적 lockout 방지.

**확인 단계**: 다이얼로그 내 "위험 영역" 섹션에서 destructive 버튼 → 이메일을 한 번 더 보여주는 confirm 서브 다이얼로그 또는 inline 2단계 (취소/삭제 토글). v1은 inline 2단계로 단순화.

### D5. 행 클릭 영역 — 전체 행
모던 어드민 표준(Linear, Gemini, Notion). 행 전체에 `onClick={openDialog(profile)}` + `role="button"` + `tabIndex={0}` + Enter/Space 키 핸들러. 시각적으로는 hover bg-muted/40로 클릭 가능성을 신호.

**대안 검토**:
- 우측 "편집" 버튼만: 더 명시적이지만 행 전체가 죽어 보임. 어드민 화면에서 데이터 밀도가 떨어짐.

### D6. 시각 톤 — borderless 컨테이너 + 헤더 hairline
다른 SectionCard들의 borderless + soft shadow 톤과 통일. 단:
- **유지**: 헤더 행 아래 `border-b` hairline (정보 위계상 필요)
- **유지**: 행 간 hairline (밀도 높은 테이블에서 가독성)
- **제거**: 컨테이너 외곽 `border border-border` rounded box
- **추가**: 행 hover `bg-muted/40`, role은 `Badge` 컴포넌트로 색 구분 (admin = 강조, hq = brand, region/country = neutral tones)

### D7. 다이얼로그 폼 상태 — 로컬 state, 저장 시에만 commit
- 다이얼로그가 열릴 때 현재 profile 값으로 form state 초기화
- 저장 버튼은 **변경분이 있을 때만** enabled (참조 비교)
- 취소/X 클릭 시 state 폐기. 외부 클릭으로 닫히지 않게 `onPointerDownOutside` prevent (실수 방지)
- 저장 성공 시 다이얼로그 닫고 토스트 → server revalidate로 목록 갱신
- 저장 실패 시 다이얼로그 유지, 에러 inline

## Risks / Trade-offs

- **[Risk] sonner 도입이 번들/SSR 호환성 문제** → Mitigation: sonner는 SSR-friendly, Next App Router 공식 지원. Toaster를 dash layout에만 mount해 로그인 화면 영향 없음.
- **[Risk] 행 전체 클릭이 접근성 저하** → Mitigation: `role="button"`, `aria-label="<email> 사용자 편집"`, Enter/Space 키 바인딩, focus ring 유지. 키보드 사용자도 진입 가능.
- **[Risk] client filter는 마운트 시 전체 fetch 필요 → 큰 사용자 수에서 SSR 느려짐** → Mitigation: 수십~수백 명 가정이 깨지면(천 명+) server pagination + 검색 도입을 후속 change로. 현재는 안전 마진 충분.
- **[Risk] 자기 자신 삭제 lockout** → Mitigation: D4에 자기 삭제 거부 + i18n 에러. 단일 admin 환경에선 다른 admin이 없으면 어차피 lockout인데, 의도적 방어막.
- **[Risk] 단일 액션 통합 시 server 측 검증 누락** → Mitigation: 기존 `updateUserScope`의 normalize 로직(빈 배열 → null, scopeAll=true 시 다른 필드 wipe) 그대로 이전. 단위 테스트로 보강.
- **[Trade-off] inline 2단계 삭제 vs 별도 confirm 다이얼로그** → 2단계가 가벼움. 사용자 삭제는 빈도가 낮아 over-engineering 회피.

## Migration Plan

1. `sonner` 의존성 추가 + dash layout에 Toaster mount (단독 PR로도 가능, 후속 토스트 사용처가 사용)
2. 새 액션 `updateUserProfile`, `deleteUser` 추가 + 테스트
3. `EditUserDialog` 신규
4. `UserList` 디스플레이 전용으로 단순화 + 검색 input + 행 클릭 → 다이얼로그 트리거
5. 디자인 톤 정리 (컨테이너 borderless, 헤더 hairline, Badge 도입)
6. 기존 `RoleSelect`, `ScopeEditor`, `updateUserRole`, `updateUserScope` 삭제 + 호출 정리 (admin/_components/user-list.tsx만 호출)
7. i18n 키 추가
8. spec deltas 반영

**Rollback**: 6번까지의 단계는 새 컴포넌트/액션 추가만이므로 안전. 7번 삭제 직전까지는 기존 인라인 편집과 새 다이얼로그가 공존 가능. 문제 발생 시 user-list만 이전 버전으로 복원하면 됨 (액션 6번 미실행 상태로).

## Open Questions

- **Q1**: `adminDeleteUser` 호출 시 cascade로 `profiles` row가 같이 사라지는지(외래키), 아니면 별도로 삭제해야 하는지. 현재 schema에선 `profiles.id`가 `auth.users.id`를 참조하지만 cascade 설정 확인 필요. → 구현 시 schema 확인. cascade 없으면 D4 순서대로 profiles 먼저 정리 후 auth 삭제로 안전 처리 (현재 design 가정).
- **Q2**: 토스트가 일시적이라 스크린리더 사용자에게 충분히 도달하는지. sonner의 `aria-live` 정책 신뢰. 추가 검토 필요시 별도 a11y 패스.
- **Q3**: 검색 필터링이 0건일 때의 빈 상태 메시지(국어/영어)와 디자인. 기존 `EmptyState` 컴포넌트 재사용 가능한지 검토.
