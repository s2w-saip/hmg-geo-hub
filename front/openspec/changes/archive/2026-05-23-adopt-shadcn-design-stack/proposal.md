## Why

현재 HMG GEO는 시각 토큰(브랜드 컬러, Hyundai Sans, 라운드, Sand 패밀리)은 잘 정의돼 있지만, 페이지 컴포넌트가 그 자원을 거의 활용하지 못해 "구려 보이는" 상태다. h1은 `text-lg`로 평탄하고, 카드는 border-only로 무게감이 없고, EmptyState 점선 박스가 화면의 80%를 차지한다. Gold/Info/Sky 액센트 토큰은 0회 사용된다. 자매 제품 aeorank(GEO 측정 도메인 동일)는 shadcn/ui + Radix + 사이드바 기반의 검증된 UI 패턴을 이미 보유하고 있어, 이를 차용하면 디자인 빚을 가장 적게 지면서 코퍼레이트 모니터링 도구의 무게감을 확보할 수 있다. 데이터가 채워지기 전에 시각 골격을 잡아두는 게 이후 모든 작업의 토대가 된다.

## What Changes

- **컴포넌트 라이브러리 도입**: shadcn/ui(new-york style, Tailwind v4 모드)와 Radix UI primitives를 인프라로 채택. `class-variance-authority`, `clsx`, `tailwind-merge`, `tailwindcss-animate` 의존성 추가.
- **시각 유틸 시스템**: aeorank에서 검증된 `shadow-soft`, `card-modern`, `gradient-blue`, `glass-*` 유틸 클래스를 HMG 톤으로 톤다운한 형태로 도입(과한 glassmorphism/보라 그라데이션은 제외).
- **레이아웃 전환**: 인증 뒤 레이아웃을 가로 nav에서 **좌측 사이드바 + 상단 헤더**로 변경. 사이드바는 그룹 라벨(`General`/`Settings`)로 묶이고, RBAC 가시 라우트와 1:1로 매핑된다. **BREAKING**: 현행 헤더 구조(좌측 워드마크 + 가로 nav + 우측 보조)는 제거.
- **다크모드 인프라**: `:root`와 `.dark` CSS 변수 두 벌을 정의하되, 활성화 트리거(`next-themes` / 토글 UI)는 도입하지 않음. 향후 토글 도입은 라이브러리 한 줄 추가로 가능하도록 변수 시스템만 준비.
- **HMG 정체성 보존**: 폰트(HyundaiSans + Pretendard fallback), 절제된 라운드(4/8/12), Hyundai Blue 키컬러, Sand 배경 패밀리는 그대로 유지. shadcn 디폴트 토큰(generic blue, 0.75rem 라운드, Inter)은 모두 HMG 값으로 오버라이드.
- **시각화 의존성 보강**: `recharts`(KPI 차트), `framer-motion`(마이크로 인터랙션)을 신규 추가. 기존 cytoscape/d3는 유지.
- **EmptyState 비주얼 업그레이드**: 점선 박스 한 종류에서, 데이터 부재 맥락(mock / pending / no-access)별로 다른 비주얼 처리를 갖는 컴포넌트 패밀리로 확장.
- **도구 사용 정책 명문화**: 구현 단계에서 비주얼 자유도가 높은 task(대시보드 첫 화면 톤, KPI 카드, EmptyState 일러스트, 호버/트랜지션)에 한해 `frontend-design` 스킬을 사용하고, 그 외는 일반 executor가 합의된 토큰/컴포넌트로 구현한다.

## Capabilities

### New Capabilities
- `design-system`: shadcn/ui + Radix primitives 기반 재사용 컴포넌트 라이브러리 + 사이드바 레이아웃 패턴 + 시각 유틸(shadow/gradient/animation) 시스템. 모든 페이지 UI는 이 라이브러리를 통해서만 구성된다.

### Modified Capabilities
- `visual-identity`: 토큰 단일 진실의 원천은 유지하되 (a) 다크모드 변수 페어 정의 자리 요구사항 추가, (b) 그림자/모션 토큰을 색·타이포·반경에 더해 정의 범위에 포함, (c) shadcn 시멘틱 변수(`--primary`, `--background`, `--muted` 등)가 HMG 토큰에서 도출되도록 매핑 룰 추가.
- `app-foundation`: 인증 뒤 레이아웃 구조 요구사항 변경 — "헤더 좌측 워드마크 + 가로 네비 + 우측 보조" 구조에서 "**상단 헤더(워드마크 + 우측 보조) + 좌측 사이드바(그룹 nav)**" 구조로 전환. 로그인 화면 두 칼럼 레이아웃 요구사항은 유지.

## Impact

- **신규 의존성**: `@radix-ui/*` primitives 다수(dialog/dropdown/popover/select/tabs/tooltip/slot/label/checkbox), `class-variance-authority`, `clsx`, `tailwind-merge`, `tailwindcss-animate`, `recharts`, `framer-motion`.
- **설정 파일**: `components.json`(shadcn 설정) 신규. `app/globals.css`에 `.dark` 변수 블록과 시각 유틸 `@layer utilities` 블록 추가. Tailwind v4 `@theme` 안의 토큰명을 shadcn 시멘틱 명(`--color-primary` 등)에 매핑하는 alias 라인 추가.
- **레이아웃 코드**: `app/[locale]/(dash)/layout.tsx` 전면 재구성. 모바일 슬라이드인 사이드바 클라이언트 컴포넌트 신규(`components/dash/sidebar.tsx` 가칭). 워드마크는 상단 헤더에 그대로 유지.
- **기존 컴포넌트 리라이트**: `components/section-card.tsx`, `components/empty-state.tsx`, `components/results-table.tsx`, `components/locale-switcher.tsx`, `app/[locale]/login/login-form.tsx`는 shadcn 기반으로 교체 또는 클래스 리라이트. 직접 토큰 클래스(`text-ink-900` 등) 대신 시멘틱 클래스(`text-foreground` 등) 사용.
- **새 컴포넌트**: `components/ui/*`에 button, card, badge, dialog, dropdown-menu, input, label, select, table, tabs, tooltip 등 shadcn 컴포넌트 신규 배치.
- **테스트/검증**: 헤드라인/본문 폰트 분리, hex 하드코딩 부재, 토큰 교체 반영, 사이드바 가시성-RBAC 매트릭스를 검증하는 시나리오는 그대로 유지(다만 검증 대상 위치가 헤더 → 사이드바로 변경).
- **i18n**: 새 nav 그룹 라벨(`General`, `Settings` 등)에 해당하는 한국어 키 추가. 기존 nav 키는 재사용.
- **호환성**: API 계약·라우트 경로·세션·RBAC 정책은 손대지 않음. 변경 범위는 UI 레이어에 한정.
