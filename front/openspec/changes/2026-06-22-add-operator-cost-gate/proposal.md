## Why

GGMD 유저 시나리오(3-2, 페이지 42336497)의 **권한 모델 · 비용 통제(운영자 게이트)**가 코드에
미반영이다. 시나리오 원칙: *비용은 실행(RUN)에서 발생 → **프로젝트 생성 · 인텐트 수집 · 프롬프트
실행** 3종만 별도 "운영자" 권한(ON/OFF)으로 게이팅하고, 조회·대시보드는 자유*. 운영자 권한은
시스템 관리자가 부여하며, 실행 비용은 해당 scope(브랜드·권역)에 귀속된다.

현재 코드는 비용 액션을 **역할(role)** 로만 막고 있고, 운영자(operator) 차원 자체가 없다.
그 결과 시나리오와 **정면 충돌**한다:

- `route-policy.ts::PROJECT_CREATORS = [hq, region, country, vendor, admin]` — **외부 수행사(vendor)가
  프로젝트를 생성**하고 Owner가 된다. 시나리오는 외부 수행사 = **운영자 영구 OFF (배정 프로젝트
  READ만)** 이다.
- 그룹사(HQ/권역/국가) 사용자도 역할만으로 생성·수집·실행에 도달한다. 시나리오는 **기본 OFF,
  지정 시 배정 한정 ON** 이다.

이 충돌은 "시나리오가 최신 의사결정"으로 확정(2026-06-22)되었으므로, 운영자 게이트를 도입해
비용 액션 3종을 운영자 차원으로 재게이팅한다.

## What Changes

- **신규 capability `operator-gating`**: 비용 유발 액션 3종(프로젝트 생성 · 인텐트 수집 · 프롬프트
  실행)을 운영자 권한으로 게이팅하는 규약. 조회·대시보드는 비게이팅 유지.
- **`operator` 차원 도입** — `profiles.operator ∈ {none, assigned, global}` (default `none`):
  - `global` = 이노션 본사 (전역 ON) — 데이터 scope 내 모든 프로젝트 생성·수집·실행.
  - `assigned` = 이노션 법인(해외) / 지정 그룹사 — **배정(active member) 프로젝트 한정** 수집·실행.
    프로젝트 신규 생성 불가.
  - `none` = 외부 수행사(영구) · 미지정 그룹사(기본) — 비용 액션 전면 불가, 조회만.
- **vendor 영구 OFF 강제**: role=`vendor` 는 operator 가 항상 `none` 으로 정규화되며, admin 이
  vendor 에게 운영자 권한을 부여하려는 시도는 거부된다.
- **비용 액션 3종 재게이팅**:
  - 프로젝트 생성(`createProject`) → `canCreateProject` (global | admin).
  - 인텐트 수집(`addCandidate`) → `canOperateProject` (운영자 ON + (global | active member)).
  - 프롬프트 실행(`executePrompts`) → `canOperateProject`.
- **Admin 운영자 부여 UI**: 사용자 편집 다이얼로그에서 역할·scope 와 함께 operator 를 **단일
  액션으로 원자적** 갱신(부분 저장 금지).

## Capabilities

### New Capabilities
- `operator-gating`: 비용 유발 액션 3종을 운영자(operator) 권한으로 게이팅하는 규약.

### Modified Capabilities
- `access-control`: 역할 모델에 **운영자(operator) 차원**을 추가(역할과 직교). vendor 운영자
  영구 OFF, admin 사용자 갱신 액션이 operator 를 원자적으로 함께 갱신.

## Impact

- **DB/스키마**:
  - `lib/db/schema.ts` — `operatorEnum` + `profiles.operator`(additive ALTER, default `none` —
    기존 행 안전, 0007 교훈 준수).
  - 마이그레이션 `db:generate` → `db:migrate`.
- **Auth**:
  - `lib/auth/types.ts` — `OperatorScope` 타입 + `User.operator`.
  - `lib/auth/session.ts` — profiles → `User.operator`(vendor → `none` 정규화).
  - `lib/auth/operator-policy.ts` (신규) — `canCreateProject` / `canOperateProject` 단일 진실의 원천.
  - `lib/auth/route-policy.ts` — `PROJECT_CREATORS` 에서 vendor 제거; `/projects/new` 는 operator
    게이트로 위임(주석 갱신).
- **서버 액션(비용 게이트 강제)**:
  - `app/[locale]/(dash)/projects/new/_actions.ts` — `canCreateProject` 재확인.
  - `app/[locale]/(dash)/projects/[id]/prompt/_actions.ts` — `executePrompts` 에 운영자 게이트.
  - `app/[locale]/(dash)/projects/[id]/intent/_actions.ts` — `addCandidate` 에 운영자 게이트.
  - `app/[locale]/(dash)/admin/_actions.ts` — 사용자 갱신에 operator 포함(원자적), vendor OFF 강제.
- **UI**:
  - 프로젝트 목록의 "새 프로젝트" 버튼 + `/projects/new` — operator 없는 사용자에게 비활성/차단.
  - admin 사용자 편집 다이얼로그 — operator 선택.
  - `messages/{ko,en}.json` — operator 라벨/안내 문구.
- **seed**: `scripts/db/seed.ts` — 데모 계정에 operator 부여(이노션 본사 global, 법인 assigned,
  vendor none).
- **보안 경계**: scope BFF(server-only) 불변. 운영자 게이트는 비용 **트리거**에만 적용 — 조회
  경로(server-derived 필터)는 변경 없음.
- **테스트**: `lib/auth/operator-policy.test.ts` — 3종 액션 × operator 3값 × vendor 강제 OFF 단위 테스트.
