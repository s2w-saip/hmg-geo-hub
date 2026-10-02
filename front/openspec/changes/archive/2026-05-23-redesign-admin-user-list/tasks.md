## 1. Sonner 토스트 인프라

- [x] 1.1 `sonner` 의존성 추가 (`npm i sonner`)
- [x] 1.2 `app/[locale]/(dash)/layout.tsx`에 `<Toaster />` 마운트 (richColors / 우측 하단 / 한국어 친화 옵션 검토)
- [x] 1.3 로그인 화면(`/login`)에는 마운트되지 않음을 확인 (레이아웃 분리 확인)

## 2. 서버 액션 통합 및 추가

- [x] 2.1 `app/[locale]/(dash)/admin/_actions.ts`에 `updateUserProfile(userId, { role, scope })` 신규 — `assertAdmin` 통과 → role/scope 입력 검증 → `profileRepository.update` 단일 호출 → 감사 로그 → `revalidatePath`
- [x] 2.2 `updateUserProfile`에 기존 `updateUserScope`의 정규화 규칙 이전 (scopeAll=true 시 brands/regions/countries=null, 빈 배열→null)
- [x] 2.3 `deleteUser(userId)` 신규 — `assertAdmin` → 자기 자신 삭제 거부 → `profileRepository.delete` → `adminDeleteUser` → 감사 로그 → `revalidatePath` (보안상 순서를 auth 먼저, profile 나중으로 변경; design D4 노트 참조)
- [x] 2.4 `lib/db/repositories/profiles.ts`에 `delete(id)` 메서드 추가
- [x] 2.5 `auth.users` 삭제와 `profiles` 삭제 간 cascade/순서 schema 확인 — FK 없음(`schema.ts` 코멘트), 액션에서 auth→profile 순서로 직접 처리
- [x] 2.6 `updateUserProfile`, `deleteUser` 단위 테스트 (성공/비관리자 거부/자기 자신 삭제 거부/정규화 동작) — 11 tests 통과
- [x] 2.7 기존 `updateUserRole`, `updateUserScope` 액션 제거 + 기존 테스트 정리

## 3. EditUserDialog 신규

- [x] 3.1 `app/[locale]/(dash)/admin/_components/edit-user-dialog.tsx` 신규 (client component)
- [x] 3.2 Props: `{ user: EditableUser; selfId: string; open; onOpenChange }` (ProfileRow 대신 dialog 전용 slice 타입)
- [x] 3.3 Form state: role + scope. user prop 변경 시 useEffect로 초기화 (revalidate 후에도 새 값 반영)
- [x] 3.4 "저장" 버튼은 변경분이 있을 때만 enabled (역할/scopeAll/배열 shallow compare)
- [x] 3.5 저장 핸들러: `updateUserProfile` 호출 → 성공 시 close + `toast.success` / 실패 시 inline error (다이얼로그 유지)
- [x] 3.6 "위험 영역" 섹션: 1단계 삭제 버튼 → 2단계 inline 확정(취소/삭제 토글) → `deleteUser` → 성공 시 close + `toast.success`
- [x] 3.7 외부 클릭 닫기 방지(`onPointerDownOutside.preventDefault`)
- [x] 3.8 키보드: Radix Dialog가 ESC를 처리; form `onSubmit`이 Enter 키 저장 트리거 (변경분 있을 때만)
- [x] 3.9 자기 자신 편집 시 삭제 영역에 selfBlocked 안내 표시 (서버 액션도 동일하게 거부)

## 4. UserList 디스플레이 단순화 + 검색

- [x] 4.1 `user-list.tsx`를 server component(data fetch+직렬화)로, 검색/다이얼로그 상태는 `user-list-client.tsx`로 분리
- [x] 4.2 client wrapper에 검색 input + `useMemo` 기반 필터링 (이메일 substring + 번역된 역할 라벨 substring, case-insensitive)
- [x] 4.3 행은 디스플레이 전용 — email · role(Badge) · scope 요약 · 생성일 · 마지막 로그인
- [x] 4.4 행은 `<button type="button">`로 렌더 (Enter/Space 기본 지원 + focus ring), `aria-label`로 어떤 사용자인지 명시
- [x] 4.5 검색 결과 0건 시 명시적 빈 상태 — 검색어 유무에 따라 "검색 결과 없음" vs "사용자 없음" 메시지 분기
- [x] 4.6 행 hover/focus-visible bg-muted/40, focus ring으로 키보드 사용자 가시성

## 5. 디자인 톤 정리

- [x] 5.1 컨테이너 외곽 `border border-border` rounded box 제거 (`overflow-x-auto`만 남김)
- [x] 5.2 헤더 hairline `border-b border-border`, 행 사이는 `divide-y divide-border`로 통일
- [x] 5.3 role Badge variant 매핑 — admin=destructive, hq=default(brand), region=secondary, country=outline
- [x] 5.4 검색 input 좌측 Search 아이콘 + 입력 있을 때 우측 × 클리어 버튼

## 6. i18n 키 추가

- [x] 6.1 `messages/ko.json`에 admin.list.search/rowAria, admin.edit.*, admin.toast.*, admin.errors.{cannotDeleteSelf,deleteFailed} 추가 (실패 토스트는 다이얼로그 inline error로 대체되므로 saveError/deleteError 토스트 키는 제외)
- [x] 6.2 `messages/en.json`에 동일 키 영문 추가
- [x] 6.3 기존 `admin.role.*`, `admin.scope.*` 키 제거 (RoleSelect/ScopeEditor와 함께 삭제)

## 7. 기존 코드 제거

- [x] 7.1 `app/[locale]/(dash)/admin/_components/role-select.tsx` 삭제
- [x] 7.2 `app/[locale]/(dash)/admin/_components/scope-editor.tsx` 삭제
- [x] 7.3 두 컴포넌트의 import 흔적이 없는지 grep 확인 — 클린
- [x] 7.4 `updateUserRole`, `updateUserScope` 잔존 없음 — `_actions.ts` 마이그레이션 comment 1줄만 남음 (의도)

## 8. 검증

- [x] 8.1 `npx tsc --noEmit` 통과 (출력 없음)
- [x] 8.2 `npm run lint` 통과 (`No ESLint warnings or errors`)
- [x] 8.3 `npm test` 통과 — 48 tests (route-policy 33 + scope-policy 4 + actions 11)
- [x] 8.4 dev server admin 페이지 렌더 검증 — 200 OK, search input + role="table" + Badge + 행 button(aria-label) 모두 HTML에 존재, 옛 인라인 select/checkbox는 행에 없음, sonner Toaster mount 확인 (브라우저 실제 클릭 시연은 사용자가 진행)
- [x] 8.5 코드 검증 — `deleteUser` 유닛 테스트가 admin/비관리자/자기 삭제/auth 실패/profile 정리 실패 5 경로 커버 (브라우저 시연은 사용자가 진행)
- [x] 8.6 RBAC 보장 — `_actions.test.ts`에서 비관리자(region) 호출은 `UnauthorizedError`, 무인증 호출도 거부 확인. 더불어 미들웨어→DashLayout→admin 페이지→서버 액션 `assertAdmin` 4겹 방어
- [ ] 8.7 다른 SectionCard와 시각 톤 비교 (캡처) — 브라우저 새로고침 후 사용자 확인 필요

## 9. 관리자 거버넌스 — 자기 보호 + 마지막 관리자 보호 (D4b)

- [x] 9.1 `profileRepository.countAdminsExcept(id)` 추가 (drizzle `and(eq(role,'admin'), ne(id, target))`)
- [x] 9.2 `updateUserProfile`에 가드 추가 — admin 강등 시: 자기 강등 차단 + 마지막 관리자 차단
- [x] 9.3 `deleteUser`에 마지막 관리자 차단 가드 추가 (defense in depth; 실질적 도달은 자기 삭제 차단으로 막혀 있음)
- [x] 9.4 i18n 키 추가 — `admin.errors.cannotDemoteSelf`, `admin.errors.lastAdminProtected` (ko/en)
- [x] 9.5 EditUserDialog — 자기 편집 + 현재 admin일 때 Select에서 비-admin 옵션 disabled + 하단 안내 텍스트
- [x] 9.6 단위 테스트 7개 추가 — self-demote 차단, self-update keep-admin OK, last-admin demote 차단, demote others 허용, 비-admin update는 count 쿼리 안 침, last-admin delete 차단, 비-admin delete는 count 쿼리 안 침
- [x] 9.7 access-control spec MODIFIED — 시나리오 3개 추가 (자기 강등 차단, 최소 1명 admin invariant, 마지막 관리자 삭제 차단)
- [x] 9.8 design.md D4b 섹션으로 결정 + 대안 캡처

## 10. OpenSpec 마무리

- [x] 10.1 `/opsx:archive`로 change를 archive하고 spec deltas를 본 spec에 sync 완료
