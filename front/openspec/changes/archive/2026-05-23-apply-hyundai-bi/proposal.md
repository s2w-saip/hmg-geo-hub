## Why

사수 지시: *"BI는 hyundai.com을 참고해서 세팅되어야 합니다."* 현재 UI는 중성 neutral 톤
(흰 배경 + neutral-200 라인 + 시스템 폰트)으로, HMG 사용자가 봤을 때 "우리 회사 도구"라는
시각적 신호가 0이다. RBAC/IA 변경(`add-rbac-routing-and-admin-console`)이 끝나도 비주얼은
여전히 무색이라, **HMG 내부 도구로서의 정체성**을 시각으로 부여해야 한다.

## What Changes

- **디자인 토큰 도입**: Tailwind 4의 `@theme` 또는 CSS 변수로 색·간격·반경 토큰을 1군데에
  정의(`app/globals.css`). 모든 컴포넌트가 토큰을 참조하므로 정확한 hex가 사수에게서 들어오면
  토큰 값만 갈아끼우면 됨.
- **컬러 팔레트**: Hyundai 코퍼릿 컬러(다크블루 계열, 추정 `#002C5F` Active Blue) +
  흰/거의 검정 + 회색 단계. accent/위험/성공 토큰도 함께. 정확한 값은 사수 자산 도착 후 교체.
- **폰트 스택 1순위 Hyundai Sans + Pretendard fallback**:
  ```
  --font-head:  "HyundaiSansHead", Pretendard, "Noto Sans KR", system-ui, sans-serif;
  --font-text:  "HyundaiSansText", Pretendard, "Noto Sans KR", system-ui, sans-serif;
  ```
  폰트 파일은 git 미커밋(`public/fonts/` + `.gitignore` 추가) — 라이선스 위생.
  자산이 없는 dev 환경에선 Pretendard로 자동 fallback (한국어도 정상 렌더).
- **헤더(DashLayout) 비주얼 톤 적용**: 흰 배경 + 얇은 하단 라인, 좌측 로고(또는 워드마크 stub),
  네비 텍스트 굵기/간격 정렬. 사수가 로고 자산 줄 때까지는 텍스트 워드마크("HMG GEO")로 stub.
- **로그인 페이지 비주얼 톤 업**: 좌측 큰 헤드라인 + 우측 폼 형태(또는 카드형), 컬러 토큰 적용.
- **공통 컴포넌트 갱신**: `SectionCard`, `EmptyState`, `LocaleSwitcher`, 폼/버튼의 색·반경·
  포커스 링을 토큰 기반으로 재배치.
- **로고 자산 자리표시**: `public/brand/wordmark-ko.svg`, `public/brand/wordmark-en.svg` 같은
  잠정 SVG 워드마크(없으면 인라인 SVG). 실제 로고 받으면 파일만 교체.
- **`Pretendard`만 npm 의존성으로 추가**: `pretendard` 패키지 또는 CDN. Hyundai Sans는 자산만,
  의존성 없음.

## Capabilities

### New Capabilities

- `visual-identity`: HMG GEO의 시각 정체성(색·타이포·간격·로고 정책)을 정의하고, 모든 UI가
  토큰을 참조하도록 강제하는 캡빌리티. 폰트 자산의 라이선스 위생도 여기 포함.

### Modified Capabilities

- `app-foundation`: `DashLayout`과 로그인 페이지가 시각 토큰을 따른다는 요구사항이 추가된다
  (라우트 구조 자체는 그대로).

## Impact

- **코드(주요)**:
  - `app/globals.css` — Tailwind 4 `@theme` 블록에 토큰 (색/폰트/반경/그림자)
  - `app/[locale]/(dash)/layout.tsx` — 헤더 비주얼 정렬 (구조 변경은 RBAC change에서 끝남)
  - `app/[locale]/login/page.tsx` + `login-form.tsx` — 톤 업
  - `components/section-card.tsx`, `components/empty-state.tsx`, `components/locale-switcher.tsx`
    — 토큰 적용
  - `public/fonts/` (신규, gitignored) + `public/brand/` (자리표시 워드마크 SVG)
  - `.gitignore` — `public/fonts/*` 추가
  - `tailwind.config.*` 또는 `globals.css` 의 `@theme` (Tailwind 4 무설정 모드)
  - `next/font` 설정 — Pretendard local 또는 self-host 정의 (옵션)

- **새 의존성**: `pretendard` (또는 CDN 사용으로 의존성 0). 다른 패키지 없음.

- **자산**: Hyundai Sans `.woff2` / `.woff` 파일은 사수가 제공 시 `public/fonts/`에 배치(커밋 X).
  부재 시 Pretendard만으로도 동작.

- **라이선스/위생**:
  - Hyundai Sans 사용 가능 확인 1줄을 사수에게 받는 작업이 본 change의 사람 액션으로 포함.
  - 폰트 파일은 git/공개 레포에 들어가지 않음 — `public/fonts/*` ignore.
  - 색상 토큰은 사수가 정확한 hex를 주기 전에는 *근사값*(예: `#002C5F`)으로 둠. 토큰 값
    교체만으로 정렬됨.

- **테스트/검증**: 비주얼 회귀는 인간 시연으로 (스냅샷 도입은 다음 change). i18n/타입/lint는
  변경 없이 유지.

- **마이그레이션 영향**: 없음. 기존 데이터/사용자/스키마 무관.

- **범위 밖**:
  - 본격적 디자인 시스템 컴포넌트 라이브러리 추출(`@hmg-geo/ui` 같은) — 추후
  - 다크 모드 — 추후
  - 비주얼 스냅샷 테스트 도입 — 추후
  - RBAC/IA/관리자 콘솔 변경 — `add-rbac-routing-and-admin-console`에서 진행
