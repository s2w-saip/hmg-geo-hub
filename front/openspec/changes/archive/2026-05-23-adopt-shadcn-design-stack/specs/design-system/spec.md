## ADDED Requirements

### Requirement: 컴포넌트 라이브러리 단일 출처

시스템은 모든 재사용 UI 컴포넌트를 shadcn/ui(new-york style) + Radix UI primitives 기반의 단일 라이브러리(`components/ui/*`)에 두어야 한다(SHALL). 페이지·기능 컴포넌트는 이 라이브러리의 컴포넌트만 조합해 구성하며, 동일 역할의 컴포넌트(버튼, 카드, 다이얼로그, 드롭다운, 셀렉트, 탭, 툴팁, 배지, 인풋, 테이블 등)를 라이브러리 밖에 별도로 정의해서는 안 된다(MUST NOT).

#### Scenario: 라이브러리 외부에 동급 컴포넌트가 존재하지 않음

- **WHEN** 저장소에서 `components/ui/` 외 경로에 `Button`, `Card`, `Dialog`, `Dropdown*`, `Select`, `Tabs`, `Tooltip`, `Badge`, `Input`, `Label`, `Table` 컴포넌트가 정의됐는지 검색하면
- **THEN** `components/ui/`를 통과한 정의 외에는 발견되지 않는다

#### Scenario: 페이지가 라이브러리 컴포넌트를 통해 구성됨

- **WHEN** 임의의 라우트 페이지가 카드/버튼/배지/다이얼로그를 사용하면
- **THEN** 해당 요소는 `@/components/ui/*` 에서 임포트한 컴포넌트로 렌더된다

### Requirement: 컴포넌트 추가는 shadcn CLI를 통과한다

시스템은 신규 shadcn 컴포넌트를 추가할 때 `npx shadcn@latest add <name>` 명령으로 설치해야 한다(SHALL). 임의 수기 복붙은 허용되지 않으며, 라이브러리 설치 결과로 생성되는 의존성과 설정 변경(`components.json`, `package.json`, `components/ui/<name>.tsx`)은 함께 커밋되어야 한다.

#### Scenario: components.json이 저장소에 존재함

- **WHEN** 저장소를 클론한 직후
- **THEN** 루트에 `components.json`이 존재하고 `style: "new-york"`, `aliases.ui: "@/components/ui"` 가 정의돼 있다

#### Scenario: shadcn 컴포넌트의 의존성이 함께 커밋됨

- **WHEN** 신규 shadcn 컴포넌트가 `components/ui/`에 추가된 커밋을 확인하면
- **THEN** 해당 컴포넌트가 요구하는 Radix 패키지가 `package.json` dependencies에 함께 추가된 커밋이거나 같은 커밋이다

### Requirement: 시멘틱 클래스 우선 사용

페이지·기능 컴포넌트는 시각 토큰을 가리키는 시멘틱 Tailwind 클래스(`text-foreground`, `bg-background`, `bg-muted`, `border-border`, `text-muted-foreground`, `ring-ring` 등)를 우선 사용해야 하며(SHALL), HMG 정체성 토큰 클래스(`text-ink-*`, `bg-bg-*`, `text-brand-*`)는 브랜드 정체성을 명시적으로 표현해야 하는 자리(워드마크, 액티브 nav 강조, 브랜드 헤드라인, gold/info/danger 의도적 강조)에 한해 사용한다.

#### Scenario: 일반 본문/카드는 시멘틱 클래스를 사용

- **WHEN** 일반 본문 텍스트 또는 카드 컴포넌트의 클래스를 확인하면
- **THEN** `text-ink-900`/`bg-bg`/`border-ink-100` 같은 직접 토큰 클래스 대신 `text-foreground`/`bg-background`/`border-border` 같은 시멘틱 클래스가 사용된다

#### Scenario: 브랜드 명시 자리는 정체성 토큰을 사용

- **WHEN** 워드마크, 액티브 nav 강조, 로그인 헤드라인, gold 액센트 배지의 클래스를 확인하면
- **THEN** `text-brand-700` 또는 `text-accent-gold` 같은 HMG 정체성 토큰 클래스가 사용된다

### Requirement: 인증 뒤 레이아웃은 사이드바 패턴을 사용

시스템은 인증 뒤 화면을 좌측 사이드바 + 상단 헤더 + 메인 영역의 3구획 레이아웃으로 구성해야 한다(SHALL). 사이드바는 그룹 라벨로 묶인 네비게이션 항목을 표시하며, 상단 헤더는 워드마크와 우상단 보조(역할 배지, 로케일 스위처, 로그아웃)만 포함한다. 모바일(lg 미만) 화면에서는 사이드바가 슬라이드인 드로어로 표시된다.

#### Scenario: 데스크톱에서 사이드바가 좌측에 고정됨

- **WHEN** lg 이상 너비에서 인증된 사용자가 보호 라우트를 렌더하면
- **THEN** 좌측에 사이드바, 상단에 헤더, 우측 메인 영역의 3구획 레이아웃이 나타난다

#### Scenario: 모바일에서 사이드바가 슬라이드인 드로어

- **WHEN** lg 미만 너비에서 사용자가 헤더의 메뉴 토글을 누르면
- **THEN** 좌측에서 슬라이드인 드로어가 열리고 동일한 네비게이션 항목이 표시된다

#### Scenario: 사이드바 항목이 그룹 라벨로 분류됨

- **WHEN** 사이드바를 렌더하면
- **THEN** 항목은 `General`(통합·고객관심·AI답변·프로젝트)과 `Admin`(관리자 콘솔) 등의 그룹 라벨 아래에 분류돼 표시된다

### Requirement: 시각 유틸 클래스 시스템

시스템은 그림자, 카드 hover, 그라데이션, 페이드/슬라이드 애니메이션을 표준화한 유틸 클래스(`shadow-soft`, `shadow-soft-lg`, `card-modern`, `card-modern-hover`, `animate-fade-in`, `animate-slide-up`)를 `app/globals.css`에서 제공해야 한다(SHALL). 페이지·컴포넌트는 직접 `box-shadow` CSS 리터럴을 작성하는 대신 이 유틸을 사용한다.

#### Scenario: 카드 컴포넌트가 표준 유틸을 사용

- **WHEN** `components/ui/card.tsx`의 클래스를 확인하면
- **THEN** `shadow-soft` 또는 `card-modern` 같은 표준 유틸 클래스가 적용되고 직접 `box-shadow` 인라인 스타일이 없다

#### Scenario: 페이지 진입 애니메이션이 표준 유틸을 사용

- **WHEN** 라우트 페이지가 페이드인 애니메이션을 적용하면
- **THEN** `animate-fade-in` 같은 표준 유틸을 통해 적용된다

### Requirement: 빈 상태 컴포넌트의 맥락 변종

시스템은 EmptyState 컴포넌트를 mock(개발 모드 자리표시), pending(데이터 출처 미정 자리표시), no-access(접근 권한 부재) 세 변종으로 분리해 제공해야 한다(SHALL). 변종마다 다른 시각 처리(아이콘, 메시지 톤, 보조 액션 유무)를 갖고, 단일 점선 박스 한 종류로 모든 빈 상태를 처리하지 않는다.

#### Scenario: mock 변종이 mock 배지를 표시

- **WHEN** `SCOPE_MODE=mock` 환경에서 데이터가 없는 카드가 EmptyState(mock) 변종을 렌더하면
- **THEN** "Mock 데이터" 등 mock임을 알리는 배지와 함께 자리표시가 표시된다

#### Scenario: pending 변종이 데이터 출처 미정을 알림

- **WHEN** 고객 관심 화면(데이터 출처 미정)이 EmptyState(pending) 변종을 렌더하면
- **THEN** "데이터 출처 미정"을 알리는 메시지가 표시되고 mock 배지는 표시되지 않는다

#### Scenario: no-access 변종이 권한 안내를 표시

- **WHEN** `/no-access` 라우트에서 EmptyState(no-access) 변종을 렌더하면
- **THEN** 관리자에게 권한 요청이 필요함을 안내하는 메시지와 로그아웃 액션만 표시된다

### Requirement: 마이크로 인터랙션 기준

시스템은 카드 hover lift, 사이드바 active 강조, 페이지 진입 페이드, 버튼 트랜지션 등 마이크로 인터랙션에 일관된 timing(150~250ms ease-out)과 이동량(2~4px lift)을 적용해야 한다(SHALL). 강한 colored shadow나 형광 글로우, 보라/핑크 그라데이션 등 generic AI 룩으로 분류되는 효과는 도입하지 않는다(MUST NOT).

#### Scenario: 카드 hover가 lift 효과를 갖는다

- **WHEN** 카드 컴포넌트 위에 포인터가 올라가면
- **THEN** 그림자가 한 단계 강해지고 카드가 2~4px 정도 들리는 트랜지션이 150~250ms 안에 끝난다

#### Scenario: 금지된 시각 효과가 사용되지 않음

- **WHEN** 저장소에서 보라·핑크 그라데이션 (`from-purple-*`, `from-pink-*`, `to-purple-*`, `to-pink-*`), AI sparkle 아이콘 클래스(`sparkles` 등 표시), 강한 colored shadow를 검색하면
- **THEN** 발견되지 않거나 의도된 1회용 강조 자리(있을 경우 design.md에 명시된 자리)에만 한정된다

### Requirement: frontend-design 스킬의 사용 범위 제한

시스템 개발에서 `frontend-design` 스킬은 비주얼 자유도가 높은 task(대시보드 첫 화면 톤, KPI/차트 카드, EmptyState 비주얼, 호버/트랜지션 디테일)에 한해 사용해야 한다(SHALL). 토큰 마이그레이션, shadcn CLI 설치, 클래스 리라이트, RBAC 통합 같은 기계적·도메인 로직 task에는 일반 executor를 사용한다. 스킬 호출 시에는 design.md에 정의된 가드레일 세트(stack, typography, color, radius, shadow, motion, tone)를 매 호출마다 함께 던진다.

#### Scenario: 가드레일 세트가 design.md에 명시됨

- **WHEN** `openspec/changes/adopt-shadcn-design-stack/design.md`를 확인하면
- **THEN** "가드레일 세트" 또는 동등한 제목 아래 stack/typography/color/radius/shadow/motion/tone 항목이 정의돼 있다

#### Scenario: 스킬 호출 task가 tasks.md에 명시됨

- **WHEN** `tasks.md`에서 frontend-design 호출이 의도된 task를 확인하면
- **THEN** 해당 task에 "(frontend-design)" 또는 동등한 표기가 있고, 그 외 task는 executor 흐름으로 처리됨이 암묵적으로(또는 명시적으로) 표시된다
