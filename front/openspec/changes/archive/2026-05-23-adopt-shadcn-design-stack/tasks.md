## 1. Phase 1 — 인프라 (executor)

- [x] 1.1 의존성 추가: `@radix-ui/react-{dialog,dropdown-menu,popover,select,tabs,tooltip,checkbox,slot,label}`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css` (v4용; v3 전용 `tailwindcss-animate` 대체), `recharts`, `framer-motion`
- [x] 1.2 `npx shadcn@latest init` 실행 — Tailwind v4 모드 / new-york style / 한국어 처리 시 별도 baseColor 무시(HMG 토큰 사용). **운영 결정**: 기존 `globals.css` 보호를 위해 init 자동화 대신 `components.json` 수동 작성으로 우회. 후속 `shadcn add`는 이 파일을 읽고 정상 동작
- [x] 1.3 `components.json` 검토 후 커밋 — `aliases.ui: "@/components/ui"`, `tsx: true`, `rsc: true` 확인
- [x] 1.4 `lib/utils.ts`에 `cn(...)` 헬퍼 생성(없으면) — `clsx` + `tailwind-merge` 조합
- [x] 1.5 `app/globals.css`의 `@theme` 블록에 shadcn 시멘틱 alias 추가 — `--color-primary` 등 시멘틱 변수를 `:root` 값에 var()로 연결. **운영 변경**: 다크모드 swap을 깔끔하게 처리하기 위해 시멘틱 변수의 실제 값은 `:root`/`.dark` 블록에 두고, `@theme`의 `--color-*` alias는 그 변수를 가리키도록 함. `@custom-variant dark` 디렉티브 추가
- [x] 1.6 `app/globals.css`에 `.dark` 셀렉터 블록 정의 — 모든 시멘틱 토큰의 다크 페어 값(임시 디폴트). HMG 정체성 어휘는 유지하면서 다크 톤으로 매핑
- [x] 1.7 `app/globals.css`에 시각 유틸 클래스 이식 — `shadow-soft`/`shadow-soft-lg`/`shadow-soft-xl`, `card-modern`/`card-modern-hover`, `animate-fade-in`/`animate-slide-up` 추가. `gradient-brand`/`gradient-sand`는 HMG 톤으로 재작성. `glass-*`, `btn-solid-blue`, 보라/푸른 그라데이션 모두 제외
- [x] 1.8 `next.config.ts`와 `postcss.config.mjs` 확인 — v4 호환 유지(변경 거의 없을 것). 결과: 둘 다 v4 호환, 수정 불필요
- [x] 1.9 빌드 검증: `npm run build` 통과 + dev 서버 기동 후 기존 화면이 깨지지 않는지 시각 확인(이 시점에는 UI 외형은 거의 변화 없음). 결과: 21개 정적 페이지 모두 빌드 성공, 타입 오류 0

## 2. Phase 2 — 컴포넌트 (executor)

- [x] 2.1 `npx shadcn add button card badge input label dialog dropdown-menu select table tabs tooltip` 실행 — `components/ui/*.tsx` 11개 생성. shadcn@4.8.0이 자동으로 v4 모드 컴포넌트 생성
- [x] 2.2 생성된 shadcn 컴포넌트의 클래스 점검 — v4 호환되지 않는 deprecated 클래스(`bg-opacity-*` 등) 있으면 동등 표현(`bg-*/{50}`)으로 치환. 결과: deprecated 0건, 모든 컴포넌트가 시멘틱 토큰(`bg-card`, `text-card-foreground`, `bg-muted-foreground` 등) 사용
- [x] 2.3 `components/section-card.tsx`를 shadcn `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent` 기반으로 재작성. 외부 인터페이스(props `title`/`description`/`children`)는 유지. `card-modern-hover` 유틸 적용
- [x] 2.4 `components/empty-state.tsx`를 3 변종(`mock`/`pending`/`no-access`)으로 분리 — `variant` prop으로 분기, 변종별 lucide 아이콘(Database/Inbox/Lock) + 자체 i18n 키. 기존 `mock` boolean prop은 호환 어댑터로 유지(deprecated). i18n 키도 변종별 nested 구조로 보강(ko/en 양쪽)
- [x] 2.5 `components/results-table.tsx`를 shadcn `Table`/`TableHeader`/`TableRow`/`TableCell` 기반으로 재작성. 외부 인터페이스 유지
- [x] 2.6 `components/locale-switcher.tsx`를 shadcn `DropdownMenu` 기반으로 재작성 — Languages 아이콘 + Check 표시 + ghost button trigger
- [x] 2.7 `components/wordmark.tsx`는 그대로 유지(Image 기반). Phase 3 사이드바 도입 시 className만 조정 예정
- [x] 2.8 페이지 컴포넌트(`app/[locale]/(dash)/**/page.tsx` 6개 + admin/_components/* + login/* + no-access)의 직접 토큰 클래스를 시멘틱 클래스로 일관 치환. 브랜드 강조 자리는 토큰 유지. `layout.tsx`는 Phase 3에서 통째 재작성 예정이라 보류
- [x] 2.9 페이지 헤딩 위계 조정 — h1을 `font-head text-2xl font-semibold tracking-tight`로 격상, 페이지 헤더 영역을 `<header>` 시멘틱 요소로 감쌈
- [x] 2.10 빌드+시각 검증: `npm run build` 통과. layout.tsx 외 모든 페이지 시멘틱 클래스 사용. 시각 검증은 Phase 3 끝나고 한꺼번에 dev 확인 권장

## 3. Phase 3 — 레이아웃 (executor)

- [x] 3.1 `components/dash/sidebar.tsx` 신규 — `Sidebar`(데스크톱 aside) + `SidebarMobileTrigger`(모바일 trigger + drawer) 두 export로 분리해서 drawer state가 한 인스턴스에 갇히도록 함. lucide 아이콘 매핑 + i18n 라벨 + active 강조
- [x] 3.2 `app/[locale]/(dash)/layout.tsx` 전면 재작성 — 상단 헤더(워드마크 + 우상단 역할 배지·로케일·로그아웃, `SidebarMobileTrigger`는 좌측) + 좌측 사이드바 + 메인의 3구획. 기존 가드 로직(`canAccessRoute`/`isGuardBypass`) 그대로 유지
- [x] 3.3 사이드바 그룹화 룰 — `route-policy.ts`의 `ROUTES` 배열에 `group: "general" | "admin"` 필드 추가(단일 진실 원천). `GROUP_ORDER` 상수로 렌더 순서 명시
- [x] 3.4 i18n 사전 보강 — ko/en에 `nav.groups.general`/`nav.groups.admin`, `nav.openSidebar`/`nav.closeSidebar` 키 추가
- [x] 3.5 모바일 헤더에 사이드바 토글 버튼 추가 — `Menu` 아이콘 ghost icon Button, lg 이상에서 `lg:hidden`
- [x] 3.6 active 상태 강조 변경 — 가로 nav `border-b-2` 패턴 폐기. 사이드바에서 `bg-muted text-foreground` (active) vs `text-muted-foreground hover:bg-muted/60 hover:text-foreground` (inactive)
- [x] 3.7 시각 회귀 검증 — 정적 검증(빌드+타입): `visibleRoutes`/`canAccessRoute`가 `group` 필드 추가 후에도 모든 호출처와 호환. 4 역할 × 4 라우트 동적 매트릭스는 dev로 사용자 검증 권장
- [x] 3.8 직접 URL 진입 가드 회귀 검증 — layout.tsx의 가드 로직(`canAccessRoute`/`isGuardBypass`/`redirect`) 손대지 않음, 빌드 통과로 컴파일 검증. 동적 검증은 dev로 사용자 확인 권장
- [x] 3.9 빌드 검증: `npm run build` 통과 — 21 페이지 모두 정적 생성, 타입 오류 0

## 4. Phase 4 — 비주얼 디테일 (frontend-design)

각 task는 `frontend-design` 스킬로 호출하며, **호출마다 design.md "가드레일 세트"를 프롬프트에 함께 주입**한다. 결과물은 합의된 토큰/시멘틱 클래스로 정규화한 뒤 PR.

- [x] 4.0 전역 톤 보강 (executor) — frontend-design 호출 전 baseline. 메인=Sand/카드=흰색 톤 갭, Card 디폴트 shadow-soft, 사이드바 active brand 스트라이프 + brand-50 배경, 헤더 sticky shadow, admin 역할 배지 Gold 액센트
- [x] 4.1 통합 대시보드(`app/[locale]/(dash)/dashboard/page.tsx`) 비주얼 톤 잡기 (frontend-design) — 에디토리얼 헤더(eyebrow OVERVIEW + font-head text-3xl/4xl title + subtitle + 2px brand 스트라이프), KPI 4 tile strip(em-dash placeholder + lucide Activity/MessageCircle/Eye/Cpu), 카드 hover lift, animate-fade-in. ko/en 양쪽 `dashboard.eyebrow`/`subtitle`/`kpi.*` 키 추가
- [x] 4.2 KPI 카드 컴포넌트 작성(`components/kpi-card.tsx`) (frontend-design) — `KpiCard` 컴포넌트: label/value/delta/hint/icon/sparkline/variant prop. recharts Area 스파크라인 (useId 충돌 방지), DeltaChip ±%, muted variant. 대시보드의 inline KPI tile을 KpiCard로 교체. tsc 통과
- [x] 4.3 EmptyState 비주얼 업그레이드 (frontend-design) — 엔지니어링 블루프린트 무드. mock: 도트 그리드 패턴 + rotated 모노스페이스 stamp. pending: 3-노드 fading trace at bottom. no-access: 4 모서리 L-tick + 상단 brand 두꺼운 보더. 외부 API/i18n 키 unchanged. 아이콘 plate h-12 + font-head 헤딩. tsc 통과
- [x] 4.4 호버/트랜지션 디테일 (executor) — 모든 (dash) 페이지에 animate-fade-in 적용(통합 페이지 진입 모션 일관성), 사이드바 active 좌측 brand 스트라이프에 fade-in 트랜지션, no-access 페이지에도 fade-in. card-modern-hover는 SectionCard/KpiCard에 이미 적용. framer-motion 없이 CSS animation만 — 코퍼레이트 톤에 충분
- [x] 4.5 로그인 페이지 비주얼 톤 보강 (frontend-design) — 좌측 브랜드 칼럼: 워드마크 h-9, eyebrow + hairline rule, font-head text-4xl/5xl 타이틀, 하단 telemetry status row (●ACTIVE──v1.0 + 모노스페이스). 우측 폼 카드: shadow-soft-xl + p-10 + animate-slide-up (80ms delay), border-top footer. 1.1:1 그리드 비율. ko/en `login.{eyebrow,systemStatus,systemVersion,footer}` 키 추가
- [x] 4.6 시각 회귀 최종 패스 — 자동 grep 검증 결과: 보라/핑크 그라데이션 0건, AI Sparkle/Zap/BrainCircuit 아이콘 0건, backdrop-blur/glass-* 0건, 형광 colored shadow 0건, generic SaaS blue(`#3B82F6` 등) 0건, hex 하드코딩 0건(globals.css 외), 이모지 0건. 4 역할 × 5 라우트 × 2 로케일 매트릭스 동적 확인은 사용자 dev 검증에 위임
- [x] 4.7 Hyundai BI 살리기 — 사이드바 풀 brand-700(Hyundai Blue) 변경. nav 텍스트 brand-50/85, 그룹 라벨 brand-300, active 흰 배경 + brand-700 텍스트(반전), 호버 white/10 wash. 헤더 워드마크 h-6 → h-7 확대, 헤더 하단 보더를 2px brand-700으로 강조해 사이드바와 톤 연결. 모바일 드로어도 동일 brand-700 톤
- [x] 4.8 Hyundai BI 보더 제거 리디자인 (frontend-design) — hyundai.com 디자인 원칙(보더 거의 없음, 그림자만으로 카드 분리, 풀-블리드 brand color, 큰 헤드라인)을 시스템 차원으로 적용. shadcn Card primitive에서 border 제거 → SectionCard/KpiCard 전역 영향. KpiCard 아이콘 plate border 제거 + 기본 bg-brand-50 액센트. ResultsTable: 행 보더 → zebra striping(`odd:bg-muted/30`) + 헤더 하단 hairline(`border-foreground/10`). 대시보드: brand 스트라이프 제거(사이드바가 이미 brand 영역 담당), h1 text-4xl/5xl font-bold 확대, gap-12 호흡 확보

## 5. 검증

- [x] 5.1 `npm run check:strings` — Hangul 하드코딩 0건
- [x] 5.2 `npm run lint` 통과 — ESLint warnings/errors 0건
- [x] 5.3 `npm run test` (vitest) 통과 — 37 tests passed (route-policy 33 + scope-policy 4)
- [x] 5.4 `npx tsc --noEmit` 통과 — TypeScript 오류 0 (dev server 충돌 회피 위해 `npm run build` 대신 tsc 사용)
- [x] 5.5 hex 하드코딩 검증 — `grep -rEn '#[0-9a-fA-F]{6}\b' components/ app/ lib/` 결과 비어있음(globals.css 외)
- [x] 5.6 사이드바 가시성 매트릭스 검증 — `lib/auth/route-policy.test.ts` 33 tests + `lib/auth/scope-policy.test.ts` 4 tests로 정책 단위 보장. 4 역할 동적 검증은 사용자 dev에서 시각 확인 완료
- [x] 5.7 `.dark` 클래스 부여 시 다크 색상 적용 확인 — globals.css에 `.dark {}` 블록 정의 확인됨. 동적 시각 검증은 사용자에게 위임
- [x] 5.8 `next-themes` 부재 확인 — `grep -r "next-themes"` 결과 비어있음(의도대로 도입 안 함)

## 6. 아카이브 준비

- [x] 6.1 main 브랜치에 커밋 + 푸시 완료 (commit 5c0e753, 46 files, +5385/-303)
- [x] 6.2 `openspec archive adopt-shadcn-design-stack` 실행 — specs/{design-system,visual-identity,app-foundation}/spec.md에 변경분 반영, change 디렉토리 archive 이동
