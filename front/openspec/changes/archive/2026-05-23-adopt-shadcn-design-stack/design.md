## Context

HMG GEO의 현재 시각 상태는 "좋은 토큰 + 죽은 사용"으로 요약된다. `app/globals.css`의 `@theme` 블록에는 Hyundai Blue, Sand 패밀리, Gold, HyundaiSans Head/Text, 절제된 라운드 토큰이 모두 정의돼 있으나, 페이지 컴포넌트(`app/[locale]/(dash)/**`)는 이 자원을 거의 활용하지 않는다. h1이 `text-lg`로 평탄하고, 카드는 border-only, EmptyState 점선 박스가 화면의 대부분을 차지하며, Gold/Info/Sky 액센트는 0회 사용된다. 디자인 시스템은 잘 짜여 있지만 사용 패턴이 "B2B 어드민 디폴트 룩"에 머물러 있다.

자매 제품 aeorank(`~/Answer/aeorank`)는 동일 도메인(GEO 측정)을 다루며, shadcn/ui(new-york) + Radix UI primitives + Tailwind v3 + 사이드바 레이아웃 + `shadow-soft`/`card-modern`/`glass-*` 시각 유틸로 검증된 UI 시스템을 보유한다. 이 시스템의 **구조와 패턴**을 차용하고, **시각 정체성(폰트·키컬러·라운드)**은 HMG의 것을 유지하는 것이 가장 낮은 비용으로 가장 큰 시각적 임팩트를 낸다.

본 변경은 UI 레이어에 한정된다. 라우팅, i18n, 세션, RBAC 정책, scope API 계약은 그대로 두며 컴포넌트와 레이아웃만 재구성한다.

## Goals / Non-Goals

**Goals:**
- 코퍼레이트 모니터링 도구로서의 시각적 무게감 확보(임원·실무자 양 청중 모두 진지하게 받아들이는 톤).
- aeorank의 검증된 UI 패턴(shadcn + Radix + 사이드바 + 시각 유틸)을 인프라로 도입해 향후 컴포넌트 추가 비용을 낮춤.
- 시각 토큰 단일 진실 원천 원칙 유지: shadcn 시멘틱 토큰(`--primary`, `--background`, `--muted` 등)이 HMG 브랜드 토큰에서 도출되도록 매핑.
- 데이터 부재(EmptyState 천지) 상태에서도 시각적으로 죽지 않는 화면 골격 확립.
- 향후 다크모드 활성화 시 라이브러리 한 줄 추가로 가능하도록 `:root`/`.dark` 변수 페어를 미리 정의.

**Non-Goals:**
- 데이터 시각화의 구체적 디자인(KPI 산식, 차트 종류 선택)은 본 변경의 범위가 아니다. shadcn 카드 + recharts 래퍼까지만 깔고 실제 차트는 후속 변경에서.
- 다크모드 활성화(토글 UI 노출, `next-themes` 도입)는 하지 않는다. 변수만 준비한다.
- aeorank의 모든 컴포넌트/페이지를 그대로 복붙하지 않는다. 도입할 컴포넌트와 패턴은 명시적으로 선별한다.
- shadcn 디폴트 미감(generic blue, 0.75rem 강한 라운드, Inter)을 그대로 두지 않는다 — HMG 토큰으로 오버라이드한다.
- 경쟁사 cross-insight, 구글 키워드/VoC 실데이터 연결은 본 변경의 범위가 아니다(v1 product scope 외).

## Decisions

### Decision 1: Tailwind v4 유지(다운그레이드 X)

**선택**: 현행 Tailwind v4 + `@theme` 인라인 토큰 구조를 유지한다.

**대안**: aeorank처럼 Tailwind v3로 다운그레이드 + `tailwind.config.ts` + `:root` HSL 변수.

**근거**:
- 현재 토큰 시스템이 v4 네이티브로 잘 짜여 있음. 다운그레이드는 반나절치 후퇴 작업.
- shadcn/ui는 2024년 후반부터 Tailwind v4를 공식 지원(`npx shadcn@latest init`이 v4 감지).
- v4의 Oxide 엔진은 빌드 5~10배 빠름. 미래의 표준.
- aeorank의 시각 유틸(`shadow-soft`, `card-modern`, `gradient-blue` 등)은 단순 CSS 유틸이라 v3/v4 무관 — 복붙 가능.

**감수할 비용**: 일부 deprecated 클래스(`bg-opacity-*` 등) 손보기, shadcn 컴포넌트 1~2개 v3 가정 마크업 수정. 한 시간치 미세 조정.

### Decision 2: 토큰 정의는 hex `@theme` 유지, shadcn 시멘틱은 alias로 매핑

**선택**: HMG 브랜드 토큰은 현행대로 `@theme` 블록 안에 hex로 정의하고, shadcn이 요구하는 시멘틱 변수(`--color-primary`, `--color-background` 등)는 **같은 블록 안에서 HMG 토큰을 가리키는 alias로 추가**한다.

**대안 A**: 모든 토큰을 HSL CSS 변수로 마이그레이션(aeorank 방식).
**대안 B**: shadcn 시멘틱 변수를 별도 `:root` 블록에 둠.

**근거**:
- HMG 토큰명(`--color-brand-700`, `--color-ink-900`, `--color-bg-soft`)이 visual-identity spec과 시각 디자인 가이드에 등장하는 정체성 어휘다. 이 어휘를 잃지 않는다.
- shadcn 시멘틱 변수는 컴포넌트 라이브러리의 인터페이스 계약이다. 둘 다 필요하다.
- Tailwind v4의 `@theme` 안에서 변수 참조는 가능(`--color-primary: var(--color-brand-700)`). 한 블록에 두면 단일 진실 원천 원칙도 유지.

**매핑 예시**:
```
@theme {
  /* HMG 정체성 토큰 (원천) */
  --color-brand-700: #002c5f;
  --color-ink-900: #0a0908;
  --color-bg-soft: #f6f3f2;
  ...

  /* shadcn 시멘틱 (HMG 토큰을 가리키는 alias) */
  --color-primary: var(--color-brand-700);
  --color-primary-foreground: var(--color-bg);
  --color-background: var(--color-bg);
  --color-foreground: var(--color-ink-900);
  --color-muted: var(--color-bg-soft);
  --color-muted-foreground: var(--color-ink-500);
  --color-border: var(--color-ink-100);
  --color-ring: var(--color-brand-500);
  ...
}
```

### Decision 3: 사이드바 레이아웃 채택 (가로 nav 제거)

**선택**: 인증 뒤 레이아웃을 좌측 사이드바 + 상단 헤더 + 메인 영역의 3구획 구조로 전환한다. 사이드바는 그룹 라벨(`General`/`Settings`)로 묶고, RBAC 가시 라우트와 1:1 매핑한다.

**대안**: 현행 가로 nav를 유지하고 비주얼만 손보기.

**근거**:
- RBAC 기반 메뉴 가시성이 핵심 요구. 가로 nav는 6+ 항목 시 답답해지며 그룹화도 어렵다.
- 사이드바는 향후 "프로젝트별 하위 메뉴" 확장(aeorank의 `Projects` 트리 패턴)에 자연스럽다.
- 상단 헤더는 워드마크 + 우상단 보조(역할 배지, 로케일, 로그아웃)만 남겨 코퍼레이트 톤 확보.
- 모바일은 슬라이드인 사이드바 패턴(aeorank 코드 참고).

**감수할 비용**: BREAKING — `app/[locale]/(dash)/layout.tsx` 전면 재작성, app-foundation spec의 헤더 구조 요구사항 수정.

### Decision 4: 다크모드는 변수만 준비, 토글 트리거 없음

**선택**: `:root`와 `.dark` 두 벌의 CSS 변수를 정의해두되, `next-themes` 같은 토글 라이브러리는 도입하지 않고 토글 UI도 노출하지 않는다.

**대안 A**: 다크 변수 자체를 정의하지 않음(완전 단일 모드).
**대안 B**: `next-themes` 도입하고 토글 UI 노출.

**근거**:
- 코퍼레이트 모니터링 도구라 다크모드 수요가 즉시 있지는 않음 — 토글 도입은 운영 비용(잘못된 색 페어 PR 리뷰 등).
- 그러나 shadcn 컴포넌트는 다크 변수를 전제로 마크업이 짜여 있어, 변수 페어를 처음부터 정의해두면 컴포넌트 추가 시 일관성이 보장된다.
- 향후 임원 데모용 다크 한 화면을 켜야 할 때 `next-themes` 한 줄만 추가하면 됨 — 옵션을 열어두는 비용이 0에 가깝다.

### Decision 5: shadcn CLI로 새로 설치 + aeorank 시각 유틸 CSS만 복붙

**선택**: shadcn 컴포넌트(`components/ui/*`)는 `npx shadcn@latest add <name>`으로 정상 설치하고, aeorank의 `app/globals.css`에서 시각 유틸(`shadow-soft`, `card-modern`, `gradient-*`, `glass-*`, `animate-*`)만 발췌해 HMG 토큰 기반으로 톤다운한 형태로 `app/globals.css`에 이식한다.

**대안**: aeorank의 `components/ui/*` 파일을 그대로 복붙.

**근거**:
- shadcn CLI는 Radix 의존성 자동 설치, components.json 동기화 등 부수 비용을 처리한다.
- aeorank 컴포넌트는 v3 마크업이라 v4에서 미세 클래스 차이가 생긴다 — 새로 설치하는 게 깨끗하다.
- 시각 유틸 CSS는 단순 색·그림자·키프레임이라 그대로 가져오기 적합. 다만 `gradient-blue`(generic 파랑)는 HMG 톤(brand-700 기반)으로 재작성.

**제외할 aeorank 유틸**: `glass-blue` 등 강한 glassmorphism, `btn-solid-blue` 같은 보라/푸른 그라데이션 버튼(generic AI 룩), `animate-scale-in`처럼 활용 빈도 낮은 것.

### Decision 6: frontend-design 스킬은 Phase 4 비주얼 디테일에 한정

**선택**: 도구 사용 정책을 design.md와 tasks.md에 명문화한다. shadcn 인프라/토큰 매핑/레이아웃 재구성/RBAC 통합은 일반 executor가 처리하고, **자유도가 높은 시각 디테일 task**(대시보드 첫 화면 톤, KPI 카드, EmptyState 비주얼, 호버/트랜지션)에 한해 `frontend-design` 스킬을 호출한다.

**대안**: 모든 비주얼 작업을 frontend-design으로 일임.

**근거**:
- frontend-design 스킬의 미션("avoids generic AI aesthetics")은 창의적 디자인 생성에 최적화돼 있다. apply 단계의 본질(결정된 명세 따라 일관성 있게 구현)과 부분적으로 어긋남.
- 풀어두면 합의된 톤에서 미세하게 벗어나는 결과 → 인간 리뷰 비용 증가.
- 분할 사용: 토큰 마이그레이션/CLI 작업/클래스 리라이트 같은 기계적 task는 executor가, 시각적 판단이 필요한 task만 frontend-design.

**가드레일**: frontend-design 호출 시 매번 함께 던질 구속 세트를 design.md "가드레일" 섹션에 명시(아래 별도 섹션).

### Decision 7: 시각화 의존성 — recharts + framer-motion 추가

**선택**: KPI 카드/차트 래퍼용으로 `recharts`, 마이크로 인터랙션용으로 `framer-motion`을 추가한다. 기존 cytoscape/d3는 유지(그래프 뷰/Sankey 등 더 복잡한 시각화 전용).

**근거**:
- shadcn 표준 차트 컴포넌트(`chart`)가 recharts 위에 만들어져 있어 호환성 최선.
- framer-motion은 aeorank에서도 사용 — page transition, 카드 entry 애니메이션 등 작은 디테일 비용 대비 큰 효과.
- d3는 raw로 쓰면 코드량이 많음 — 단순 차트는 recharts가 빠르다.

### 가드레일 세트 (frontend-design 호출 시 매번 함께 던질 구속)

```
STACK
  Next.js 15 (App Router) · React 19 · TypeScript · Tailwind v4 · shadcn v4 · Radix UI

TYPOGRAPHY
  font-head = HyundaiSansHead (Pretendard fallback)
  font-text = HyundaiSansText (Pretendard fallback)
  h1/h2/h3 → font-head, body → font-text
  Inter / system-ui 직접 지정 금지

COLOR
  primary  = Hyundai Blue #002c5f
  bg/sand  = #ffffff / #f6f3f2 / #e4dcd3
  ink      = #0a0908 / #2b2825 / #6b6660 / #c7c2bb / #ece8e3
  gold     = #a36b4f (액센트, 강조 1점만)
  info     = #00aad2 (정보 배지에만)
  danger   = #e63312 (에러에만)
  generic blue gradient / 보라·핑크 그라데이션 금지

RADIUS
  sm 4px / md 8px / lg 12px
  0.75rem 이상의 강한 라운드 금지

SHADOW
  shadow-soft 시리즈 (aeorank에서 톤다운)
  강한 colored shadow / 형광 글로우 금지

MOTION
  150~250ms ease-out 기본
  hover 시 카드 lift 2~4px 정도
  page transition은 framer-motion fade/slide

TONE
  코퍼레이트 모니터링 도구, 임원·실무자 양 청중
  자동차 그룹의 무게감 + 측정의 진지함
  AI sparkle 아이콘, 이모지, glass overload, 형광 색 모두 금지
```

## Risks / Trade-offs

- [Risk] shadcn v4 호환성 미세 이슈 → 컴포넌트별 add 시 마크업 점검, 필요 시 v3 가정 클래스를 v4 동등 표현으로 수정.
- [Risk] HMG 토큰 ↔ shadcn 시멘틱 이중 명명으로 인한 혼란 → 컴포넌트는 시멘틱 변수만 참조하도록 규칙화, HMG 토큰 직접 참조는 globals.css의 매핑 라인에만 허용.
- [Risk] frontend-design 스킬이 합의된 톤에서 벗어남 → 호출마다 가드레일 세트를 프롬프트에 주입, 결과물은 리뷰 후 토큰 클래스로 정규화.
- [Risk] BREAKING한 레이아웃 변경(가로 nav → 사이드바)으로 app-foundation 시나리오 회귀 → 시나리오 자체를 사이드바 기준으로 갱신, RBAC 가시성 매트릭스는 동일 의미로 보존.
- [Risk] 토큰 클래스(`text-ink-900`)에서 시멘틱 클래스(`text-foreground`)로의 리라이트 시 색상 회귀 → 매핑 alias가 항상 동일 결과를 내도록 globals.css에서 단일 정의, 시각 비교 후 PR.
- [Trade-off] aeorank 컴포넌트 복붙이 아닌 shadcn CLI 사용 → 초기 셋업 비용 약간 증가하지만 향후 컴포넌트 추가 비용 감소.
- [Trade-off] 다크모드 변수 페어 정의는 컴포넌트 토큰을 두 벌 관리해야 함 → 자동화된 확인 시나리오 없음, 직접 시각 검토에 의존.

## Migration Plan

**Phase 1 — 인프라 (executor)**
- 의존성 추가: Radix primitives, CVA, clsx, tailwind-merge, tailwindcss-animate, recharts, framer-motion.
- `npx shadcn@latest init` (v4 모드, new-york, baseColor 무시: 우리는 HMG 토큰 사용).
- `components.json` 커밋.
- `globals.css`에 shadcn 시멘틱 alias 라인 추가(Decision 2 매핑), `.dark` 변수 블록 정의.
- aeorank 시각 유틸 CSS 발췌 이식(HMG 톤다운).

**Phase 2 — 컴포넌트 (executor)**
- `npx shadcn add` 로 도입: button, card, badge, input, label, dialog, dropdown-menu, select, table, tabs, tooltip.
- 기존 `components/section-card.tsx`, `empty-state.tsx`, `results-table.tsx`, `locale-switcher.tsx`, `wordmark.tsx`를 shadcn 컴포넌트 기반으로 재작성 또는 클래스 리라이트.
- 직접 토큰 클래스(`text-ink-900` 등) → 시멘틱 클래스(`text-foreground` 등) 일관 적용. 단 브랜드 정체성을 명시적으로 표현해야 하는 곳(워드마크 색, gold 액센트)은 토큰 직접 사용 허용.

**Phase 3 — 레이아웃 (executor)**
- `app/[locale]/(dash)/layout.tsx` 전면 재구성: 상단 헤더(워드마크 + 우상단 보조) + 좌측 사이드바(그룹 nav) + 메인.
- 모바일 슬라이드인 사이드바 클라이언트 컴포넌트(`components/dash/sidebar.tsx`).
- 사이드바 nav 그룹화: `General`(통합·고객관심·AI답변·프로젝트), `Admin`(관리자 전용 라우트). RBAC 가시 룰은 그대로 적용.
- i18n: 새 그룹 라벨 키 `nav.general`, `nav.admin` 추가.

**Phase 4 — 비주얼 디테일 (frontend-design)**
- 대시보드 첫 화면(통합 대시보드) 비주얼 톤 잡기 — KPI 칩, 메타 라인, 카드 위계.
- KPI 카드 컴포넌트 디자인 — 숫자 + 변화량 화살표 + 미니 스파크라인 슬롯.
- EmptyState 비주얼 업그레이드 — mock/pending/no-access 세 변종.
- 호버/트랜지션 디테일 — 카드 lift, 사이드바 active 표시, 페이지 fade-in.
- 각 호출마다 가드레일 세트 주입.

**Rollback strategy**:
- Phase 1, 2는 git revert로 안전 복귀.
- Phase 3는 layout.tsx 단일 파일이 변경 중심이라 revert로 즉시 복귀.
- Phase 4는 컴포넌트별 분리 커밋 → 부분 revert 가능.
- 단계 사이에 시각 회귀 점검(로그인/대시보드/관리자/no-access 화면 직접 확인).

## Open Questions

- 사이드바를 collapsible(접기/펴기)로 만들 것인가? aeorank는 항상 펼쳐져 있음. v1은 펼침 고정으로 시작하고, 필요 시 후속 변경에서 토글 추가하는 것을 권장.
- 다크모드 변수 페어의 색상 결정은 본 변경에서 합리적 디폴트만 정한다(`.dark` 블록의 시멘틱 변수가 HMG의 다크 톤 매핑을 갖되, 정확한 hex는 임시값). 본격 다크 활성화 시 재검토.
- 시스템 관리자 콘솔(`app/[locale]/(dash)/admin/page.tsx`)의 정보 밀도가 다른 화면보다 높을 가능성 — 사이드바 아래에 별도 그룹으로 분리할지 결정 필요. 본 변경은 일단 `Admin` 그룹으로 분리.
- aeorank의 `Projects` 트리(사이드바 확장형 메뉴)를 도입할지 — HMG는 v1에 "개별 프로젝트 생성" 메뉴만 있고 프로젝트 인스턴스 목록은 미정의. 인스턴스 목록이 생기는 시점에 트리 패턴 추가하는 것을 권장.
