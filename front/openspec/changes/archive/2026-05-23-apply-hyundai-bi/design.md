## Context

현재 UI 스타일은 Tailwind 기본 neutral 팔레트 + 시스템 폰트로 *완전히 중성*이다. 사수 지시는
"BI는 hyundai.com 참고". hyundai.com은 공개 자료로는 정확한 hex/font-family를 추출하기 어려우나
(SPA + 비공개 CSS), 다음은 공개·관습적으로 알려진 사실이다:

- Hyundai의 코퍼릿 컬러는 통상 **다크 블루(Active Blue)** 계열로 알려져 있으며 추정값은
  `#002C5F`. 정확한 값은 사수의 브랜드 가이드 자산이 진실의 원천.
- Hyundai의 자체 폰트는 **Hyundai Sans** (Head / Text 두 family, 2018년 도입). 외부 무료 배포
  없음 — 라이선스/자산은 사수가 제공.
- 톤은 미니멀·프리미엄·라이트(흰 배경 중심) — 큰 헤드라인, 평면 카드, 얇은 라인, 그림자 최소.

본 change는 정확한 값을 *기다리지 않고* **토큰만 박아 두어** 자산 도착 시 값 교체로 정렬되게 한다.

## Goals / Non-Goals

**Goals**
- 모든 색·간격·반경·폰트가 1군데에서 정의된 토큰을 참조.
- HMG 사용자가 첫 화면(로그인 + 헤더)에서 "우리 회사 도구"라고 인지할 수 있는 톤.
- Hyundai Sans 미보유 환경에서도 한국어 렌더가 깨지지 않음 (Pretendard fallback).
- 폰트/로고 자산이 git에 들어가지 않음 — 공개 레포 라이선스 위생.

**Non-Goals**
- 정확한 hex 매칭 — 사수 자산 도착 후 토큰 값만 교체로 끝낸다.
- 컴포넌트 라이브러리화(`@hmg-geo/ui`) — 추후.
- 다크 모드, 비주얼 스냅샷 테스트, 모션 디자인 — 추후.
- 로고 자산 제작 — stub SVG 워드마크 사용, 실제 로고는 사수로부터.

## Decisions

### D1. Tailwind 4 `@theme` 블록을 토큰의 단일 진실의 원천

Tailwind 4는 `globals.css` 안에 `@theme` 블록을 통해 토큰 정의 → 자동 utility 생성을 지원.
별도 `tailwind.config.ts` 파일을 안 만들고 `@theme`만 사용 (현재 프로젝트가 Tailwind 4).

```css
/* app/globals.css */
@import "tailwindcss";

@theme {
  /* 색 — 정확한 hex는 사수 자산 도착 후 교체 */
  --color-brand-50:  #E6EAF0;
  --color-brand-500: #1A4D8E;
  --color-brand-700: #002C5F;   /* 추정 Active Blue */
  --color-brand-900: #001533;

  --color-ink-900: #0A0A0A;
  --color-ink-700: #2B2B2B;
  --color-ink-500: #6B6B6B;
  --color-ink-300: #C7C7C7;
  --color-ink-100: #EFEFEF;

  --color-bg:       #FFFFFF;
  --color-bg-soft:  #F7F8FA;

  /* 폰트 */
  --font-head: "HyundaiSansHead", Pretendard, "Noto Sans KR", system-ui, sans-serif;
  --font-text: "HyundaiSansText", Pretendard, "Noto Sans KR", system-ui, sans-serif;

  /* 반경 — 살짝 둥근 미니멀 */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;

  /* 그림자 — 평면 톤 (그림자 최소, 얇은 라인 우선) */
  --shadow-card: 0 0 0 1px var(--color-ink-100);
}
```

**왜** — Tailwind 4의 권장 방식이고, 사수가 hex 한 줄 바꾸면 전 UI 갱신. CSS 변수라
컴포넌트 코드가 변경되지 않음.

### D2. 폰트 로딩 — `@font-face` self-host + `next/font` 없음

```css
/* app/globals.css */
@font-face {
  font-family: "HyundaiSansHead";
  src: url("/fonts/HyundaiSansHead-Bold.woff2") format("woff2");
  font-weight: 700;
  font-display: swap;
  font-style: normal;
}
/* ... HyundaiSansText regular/medium 같은 */

@font-face {
  font-family: "Pretendard";
  src: url("/fonts/PretendardVariable.woff2") format("woff2-variations");
  font-weight: 100 900;
  font-display: swap;
}
```

**왜 `next/font` 안 쓰나** — `next/font/google`은 Hyundai Sans 호스팅 불가, `next/font/local`
은 빌드 타임에 파일 존재 필수 → Hyundai Sans 자산 부재 시 빌드 깨짐. `@font-face`는 파일
없으면 그냥 fallback으로 떨어져 무해함 → dev 환경에 유리.

**Pretendard 의존성**: 패키지 추가하면 `node_modules`에서 가져옴(라이선스 안전). CDN 옵션도
있지만 self-host 권장 (오프라인 dev / 빌드 결정성).

### D3. 폰트 자산 디렉터리 + gitignore 정책

```
public/
  fonts/
    .gitkeep              # 디렉터리만 커밋
    HyundaiSans*.woff2    # ⛔ gitignored — 사수 제공
    PretendardVariable.woff2  # ✅ 오픈 라이선스, 커밋 OK (또는 npm 패키지에서)
  brand/
    wordmark-ko.svg       # ✅ 자체 stub (텍스트 SVG), 실제 로고 도착 시 교체
    wordmark-en.svg
```

`.gitignore` 추가:
```
public/fonts/HyundaiSans*
```

**왜** — 외부 공개 레포(GitHub 등)에 Hyundai Sans `.woff2` 파일이 올라가면 라이선스 위험.
디렉터리는 보존하고 파일만 무시.

### D4. 헤더의 비주얼 톤

```
높이      ~56px (현재 py-3 유지)
배경      bg-white
하단 라인 border-b border-ink-100 (1px)
로고      좌측, 워드마크 SVG (h-6) — 추후 로고 도착 시 교체
nav       text-sm, font-medium, 항목 간 24px, 현재 라우트만 underline(2px, brand-700)
우측      역할 배지(둥근 pill, bg-bg-soft) + locale + 로그아웃
```

`DashLayout` 구조는 RBAC change에서 결정되고, 이 change는 색·타이포·반경만 정렬한다.
**구조와 비주얼을 분리하는 것이 두 change를 따로 가는 이유**.

### D5. 로그인 페이지 톤

```
레이아웃: 좌측 큰 헤드라인(font-head, text-3xl/font-bold, "HMG GEO 모니터링")
          + 부제(font-text, text-sm, ink-500) /
          우측 폼 카드(border-ink-100, radius-lg, padding-8)
브레이크: lg 이상에서 2-column, 미만에서 stack
배경:     bg-bg (#FFF)
버튼:     bg-brand-700, hover:bg-brand-900, text-white, radius-md, py-2.5
input:    border-ink-300, focus:border-brand-500, focus:ring-2 ring-brand-500/20
```

### D6. 공통 컴포넌트 갱신 범위

- `SectionCard`: `border-neutral-200` → `border-ink-100`, 반경 `rounded-xl` → `rounded-lg`,
  내부 타이틀 `text-sm font-semibold` → `font-head text-base font-semibold`.
- `EmptyState`: 점선 → 실선 + ink-300, 안내 텍스트 톤 정렬, mock 배지 색 토큰 적용.
- `LocaleSwitcher`: 토큰 색 정렬.
- 버튼/input: 인라인으로 토큰 적용 (별도 컴포넌트 추출은 추후).

### D7. 워드마크 stub SVG

실제 로고를 받기 전 짧은 SVG 텍스트 워드마크로 stub. ko/en 별 분리(`/brand/wordmark-{ko,en}.svg`)
하지만 v1엔 동일 디자인 — 로케일 의존 분리는 추후 가능성을 열어두기 위한 자리표시.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 24">
  <text x="0" y="18" font-family="HyundaiSansHead, Pretendard, system-ui"
        font-size="18" font-weight="700" fill="#002C5F">HMG GEO</text>
</svg>
```

### D8. 토큰 교체 단일 지점

사수에게 정확한 hex / 폰트 자산 받으면:
1. `app/globals.css` 의 `--color-brand-*` 5개 값 교체
2. `public/fonts/` 에 `.woff2` 추가 (자동으로 폰트 스택의 1순위가 활성)
3. `public/brand/wordmark-*.svg` 를 실제 로고로 교체
끝. 컴포넌트 코드 변경 0.

## Risks / Trade-offs

- **[추정 hex가 사수가 가진 정확한 값과 다를 수 있음]** — Active Blue가 `#002C5F`가 아닐 수 있음.
  → **Mitigation**: 추정값은 *근사*임을 design에 명시. 토큰 값 교체는 1줄. 시연 전에 사수 확인.

- **[Hyundai Sans 라이선스 회수 시나리오]** — 사수가 "외부 빌더는 사용 금지"라고 통지할 가능성.
  → **Mitigation**: Pretendard fallback이 이미 스택의 2순위. `.woff2` 파일 제거만으로 자동
    Pretendard 톤으로 강등. 라이선스 위생이 핵심.

- **[Pretendard와 Hyundai Sans의 자형 차이로 톤 인상이 달라짐]** — fallback이 활성된 환경에선
  살짝 다른 인상.
  → **Mitigation**: 두 폰트 모두 모던 산세리프라 인상 차이는 작음. 자형 metric은 유사.
    실제 시연 환경에 Hyundai Sans 배치 권장.

- **[`@font-face` swap 시 FOIT/FOUT]** — `font-display: swap` 이라 빈 텍스트는 안 나오지만
  로딩 중 fallback 자형이 잠시 보임.
  → **Mitigation**: 두 family의 x-height·width 큰 차이 없음. 허용 가능 수준.

- **[Tailwind 4 `@theme`가 일부 컴포넌트에서 인식되지 않을 수 있음]** — 신규 문법이라
  IDE/플러그인 캐시 이슈 가능.
  → **Mitigation**: `npm run build` 통과를 정합성의 기준으로. 빌드가 깨지면 토큰 명을 줄이고
    재시도.

- **[로고 자산이 도착하기 전 워드마크 stub가 시연에서 약해 보임]** — *실제 로고는 못 받은 채*
  데모 가능성.
  → **Mitigation**: 워드마크는 사수에게 *시각 자산 요청* 알림 자체가 됨. 데모에서 "로고는 받으면
    교체 1줄" 메시지 명시.

## Migration Plan

- **배포**: 코드 변경만, 데이터 영향 0. feature flag 불필요.
- **사수 자산 도착 시 순서**:
  1. 정확한 hex 받음 → `globals.css` 토큰 5줄 수정.
  2. Hyundai Sans `.woff2` 받음 → `public/fonts/`에 배치 (gitignore로 자동 제외).
  3. 실제 로고 받음 → `public/brand/wordmark-*.svg` 교체.
- **롤백**: `globals.css`의 토큰을 RBAC change 시점 값으로 되돌리면 끝.

## Open Questions

- **정확한 Hyundai Blue hex** — 사수 확인 필요. 추정값 `#002C5F`로 시작.
- **Hyundai Sans 사용 OK 여부** — 사수 한 줄 확인. 부재 시 Pretendard만으로 진행 가능.
- **워드마크 vs 로고 사용 가이드** — 사수가 어느 자산을 hmg-geo에 쓰기를 선호하는지.
- **CI/배포 환경에서 폰트 자산 주입 방식** — 사수의 자산 서버 vs 빌드 시 secret 디렉터리 마운트
  vs 정적 호스팅. 시연 단계엔 dev 머신 로컬 배치로 충분.
