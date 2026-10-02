## Why

관리자 콘솔의 사용자 목록은 행 안에서 역할/범위를 인라인 편집하는 구조라 사용자 수가 늘면 (a) 검색이 없어 못 찾고, (b) 시각 노이즈가 누적되며, (c) 역할과 범위가 각자 다른 시점에 저장돼 부분 저장이 발생할 수 있다. 또한 행 컨테이너 + 셀 border가 누적돼 borderless + soft shadow를 채택한 다른 SectionCard들과 톤이 어긋난다. 월요일 시연 + 향후 운영 단계 모두를 위해 스케일과 디자인 일관성을 같이 정리한다.

## What Changes

- 사용자 목록을 디스플레이 전용 행으로 단순화하고, 행 클릭 시 다이얼로그를 열어 역할/범위를 함께 편집하도록 변경
- 다이얼로그 하단 "저장" 버튼 1개로 역할/범위를 **단일 트랜잭션**으로 갱신 (현재의 분리된 두 액션 폐기)
- 사용자 목록 상단에 이메일/역할 검색 input 추가 (client-side filter)
- 다이얼로그 내 "위험 영역" 섹션에 **사용자 삭제** 액션 추가 (서버 액션 신규)
- 저장/삭제 성공·실패 피드백을 **sonner** 기반 토스트로 통일
- 사용자 목록 시각 톤 정리: 컨테이너 borderless, 헤더 hairline, 행 hover bg-muted/40
- **BREAKING**: `updateUserRole`, `updateUserScope` 서버 액션 제거 → `updateUserProfile` 단일 액션으로 대체. `role-select.tsx`, `scope-editor.tsx` 컴포넌트 제거

## Capabilities

### New Capabilities
<!-- 없음. 신규 sonner 토스트 표준은 design-system 확장으로 처리한다. -->

### Modified Capabilities
- `access-control`: 사용자 역할+범위 갱신을 단일 원자 액션으로 정의. 사용자 삭제 시나리오 추가. 사용자 목록 검색 요구사항 추가. 인라인 편집을 다이얼로그 편집으로 변경.
- `design-system`: 성공/실패 피드백을 sonner 토스트로 통일하는 요구사항 추가.

## Impact

- **코드**:
  - `app/[locale]/(dash)/admin/_components/user-list.tsx` — 디스플레이 전용 행 + 검색
  - `app/[locale]/(dash)/admin/_components/edit-user-dialog.tsx` — 신규
  - `app/[locale]/(dash)/admin/_components/role-select.tsx`, `scope-editor.tsx` — 삭제
  - `app/[locale]/(dash)/admin/_actions.ts` — `updateUserProfile`, `deleteUser` 추가 / `updateUserRole`, `updateUserScope` 삭제
  - `app/[locale]/(dash)/layout.tsx` — sonner `<Toaster />` mount
- **의존성**: `sonner` 신규 추가 (~3KB gz). 다른 기능에서도 사용 예정
- **DB**: 스키마 변경 없음. Drizzle update 호출만 통합
- **i18n**: `messages/ko.json`, `messages/en.json`에 검색/다이얼로그/토스트 키 추가
- **테스트**: 신규 액션 `updateUserProfile`, `deleteUser`에 단위 테스트. 기존 두 액션 테스트 제거
- **비스코프**: 페이지네이션·정렬·다중 필터, 임시 비밀번호 재발급, 이메일 변경, `TempPasswordToast`의 sonner 마이그레이션
