## 1. 라이선스/자산 위생 셋업

- [x] 1.1 `.gitignore` 에 `public/fonts/HyundaiSans*` 추가
- [x] 1.2 `public/fonts/.gitkeep` 생성 (디렉터리 보존)
- [x] 1.3 `public/brand/.gitkeep` 생성 (디렉터리 보존)
- [x] 1.4 사수에게 자산 요청 — 응답 완료, 모든 자산 확보 (폰트/정확 hex/로고)

## 2. 폰트 의존성 + self-host

- [x] 2.1 `npm i pretendard` — OFL 라이선스, fallback용으로 의존성 추가
- [x] 2.2 `PretendardVariable.woff2` 를 `public/fonts/` 로 self-host (커밋 OK, OFL)
- [x] 2.3 Hyundai Sans 자산 배치 — `HyundaiSans{Head,Text}Office-*.woff2` 10개 파일 `public/fonts/` 에 배치 (gitignore로 자동 제외 확인)

## 3. 디자인 토큰 정의 — globals.css `@theme`

- [x] 3.1 `app/globals.css` 상단 `@import "tailwindcss";` 확인 (이미 존재)
- [x] 3.2 `@theme` 에 컬러 토큰 정의 — `brand-{50,300,500,700,900}` (정확 `#002c5f` Hyundai Blue) + `ink-{100,300,500,700,900}` (Sand 톤 그레이) + `bg/bg-soft/bg-warm` (Hyundai Light Sand / Sand) + `accent-{gold,info,soft}` + `danger`
- [x] 3.3 `--font-head`, `--font-text` 스택 정의 — HyundaiSans → Pretendard → Apple SD Gothic Neo → Noto Sans KR → system
- [x] 3.4 `--radius-{sm,md,lg}` 정의
- [x] 3.5 `@font-face` 블록 추가 — HyundaiSansHead (Light/Regular/Medium/Bold) + HyundaiSansText (Regular/Italic/Medium/MediumItalic/Bold/BoldItalic) + PretendardVariable. 모두 `font-display: swap`
- [x] 3.6 `body { font-family: var(--font-text); }` 기본 적용
- [x] 3.7 헤드라인 유틸 — `h1, h2, h3 { font-family: var(--font-head); }`

## 4. 워드마크/로고 자산 + 컴포넌트

- [x] 4.1 ~~워드마크 stub SVG~~ → 실제 HMG 로고 `public/brand/hmg-logo.svg` 배치 (사수 자산 사용)
- [x] 4.2 보조 자산 `public/brand/hyundai-logo.svg` 도 배치 (variant="hyundai"로 선택 가능)
- [x] 4.3 `components/wordmark.tsx` — `Wordmark` 컴포넌트 (variant: "hmg"|"hyundai", className 으로 크기 조정). `next/image` + `unoptimized` 로 SVG 벡터 보존

## 5. DashLayout 헤더 톤 적용

- [x] 5.1 헤더 배경 `bg-bg` (white), 하단 라인 `border-b border-ink-100`
- [x] 5.2 좌측 `<Wordmark className="h-6 w-auto" />` + `sr-only` 텍스트 (접근성)
- [x] 5.3 네비 텍스트 `text-sm font-medium`, 항목 간격 `gap-5`, 액티브 라우트 `border-b-2 border-brand-700` + `text-ink-900`, 비활성 `text-ink-500 hover:text-ink-900`
- [x] 5.4 우측 역할 배지: `bg-bg-soft text-ink-700 rounded-full`
- [x] 5.5 로그아웃 버튼: `text-ink-500 hover:text-ink-900`
- [x] 5.6 메인 컨테이너 `max-w-6xl px-6 py-8` 유지

## 6. 로그인 페이지 톤 업

- [x] 6.1 `app/[locale]/login/page.tsx` 레이아웃: `lg:grid lg:grid-cols-2` (좌측 헤드라인 + 우측 폼 카드)
- [x] 6.2 헤드라인: `font-head text-3xl font-bold text-ink-900` + 부제 `text-sm text-ink-500`
- [x] 6.3 폼 카드: `border border-ink-100 rounded-lg p-8 bg-bg`
- [x] 6.4 `login-form.tsx` input/button 토큰 기반 교체: input `border-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20`, button `bg-brand-700 hover:bg-brand-900 text-white rounded-md`
- [x] 6.5 에러 텍스트 `text-danger` 토큰 적용

## 7. 공통 컴포넌트 토큰 적용

- [x] 7.1 `section-card.tsx` — `border-neutral-200` → `border-ink-100`, `text-neutral-{500,900}` → `text-ink-{500,900}`
- [x] 7.2 `empty-state.tsx` — `border-neutral-300` → `border-ink-300`, mock 배지(amber)는 dev signal로 유지
- [x] 7.3 `locale-switcher.tsx` — `border-neutral-300` → `border-ink-300`
- [x] 7.4 `results-table.tsx` — 표 라인/헤더 색 토큰화 (`border-neutral-*` → `border-ink-*`)
- [x] 7.5 admin 콘솔 UI 컴포넌트 5종 토큰 적용: page.tsx + user-list + role-select + scope-editor + create-user-form + temp-password-toast. neutral-900 버튼 → brand-700, neutral 그레이 → ink, red-600 → danger

## 8. 시연 검증

- [x] 8.1 `npm run build` 통과 — Tailwind 4 `@theme` 토큰 인식, 21 static pages 생성
- [x] 8.2 `npm run lint` 통과 — `✔ No ESLint warnings or errors`
- [x] 8.3 `npm test` 통과 — 37 passed (변경 없음, 기존 회귀)
- [ ] 8.4 Hyundai Sans 자산 부재 환경에서 페이지 렌더 확인 → Pretendard fallback 활성 — **사람 시연** (Network 탭에서 woff2 차단 후 확인)
- [x] 8.5 Hyundai Sans 자산 배치 후 페이지 렌더 확인 → 1순위 폰트 활성 — woff2 10개 정상 배치, build 검증 완료
- [x] 8.6 헤더/로그인/대시보드/관리자 콘솔 4개 페이지 비주얼 인상 시각 확인 (사람 시연 완료)
- [x] 8.7 hex 하드코딩 잔여 검색: `grep -rnE "#[0-9A-Fa-f]{6}" app components --include="*.tsx" --include="*.ts"` → **결과 0건** (CSS 토큰 정의 파일 18곳에만 집중)

## 9. 사수 자산 도착 시 정렬

- [x] 9.1 정확한 brand hex 5단계 적용 — `globals.css` `@theme` 에 정확값 박힘 (`#002c5f` 등)
- [x] 9.2 Hyundai Sans `.woff2` 자산 배치 — 10개 파일 `public/fonts/`
- [x] 9.3 실제 로고 SVG 배치 — `public/brand/{hmg-logo,hyundai-logo}.svg`
- [x] 9.4 시각 회귀 시연 — 자산 도착 후 헤더/로그인/대시보드/관리자 4페이지 비주얼 확인 완료

## 10. 정리

- [x] 10.1 README에 BI 정책 단락 추가 — 토큰 위치, 폰트/로고 자산 정책, 자산 교체 절차
- [x] 10.2 change archive 완료 — 2026-05-23, `openspec archive` 로 spec sync 동반
