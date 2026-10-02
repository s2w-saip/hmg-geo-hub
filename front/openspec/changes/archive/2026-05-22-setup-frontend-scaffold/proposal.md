## Why

hmg-geo는 현재 빈 레포(README + openspec 스캐폴드뿐)다. 앞으로 HMG 전용 GEO 모니터링
프론트엔드 — 모회사 측정 엔진 "scope" 위의 thin client + BFF — 가 된다.

**이 change의 범위**: 단순 의존성 설치(기술스택 셋업)에 그치지 않고, 그 위에 **BFF/인증
아키텍처 골격(skeleton)** 까지 토대로 함께 깐다. 여기서 "scaffold"는 의존성 설치가 아니라
"동작하는 최소 골격"을 뜻한다. 이유는 두 가지다. (a) next-intl 라우팅·App Router server
action·route handler·Tailwind가 *서로 맞물려 동작하는지*는 이를 실제로 쓰는 흐름이 하나라도
있어야 검증된다 — 빈 스캐폴드는 "스택이 깔렸다"를 증명하지 못한다. (b) 아래 보안 제약은 기능이
아니라 토대라서, 나중에 끼워넣기 어렵고 처음부터 박아두어야 한다.

기능 개발에 앞서 세 가지 제약을 토대에 박아넣어야 한다: (1) scope workspace key는 HMG
**전체** 데이터를 열기 때문에, 서버단 역할 범위 강제는 기능이 아니라 보안 요구사항이다.
(2) 아직 scope key가 없으므로 안정적인 계약 뒤에서 mock-first로 만들어야 한다. (3) UI 용어와
일부 데이터 출처가 미정이므로, 문자열과 데이터 접근은 컴포넌트를 건드리지 않고 교체 가능해야 한다.

## What Changes

- Next.js 15(App Router) + React 19 + TypeScript + Tailwind 4 스캐폴드와 합의된 viz 의존성
  (cytoscape, cytoscape-fcose, d3, d3-sankey, lucide-react)을 구성한다.
- next-intl로 ko(기본) + en 로케일과 로케일 라우팅(`/ko`, `/en`)을 추가하고, JSX에 UI 문자열을
  하드코딩하지 않는다는 규칙을 확립한다.
- BFF scope 게이트웨이를 만든다: `ScopeClient` 계약과 mock/http 구현, `SCOPE_MODE` env로 선택.
  모든 scope 접근은 `app/api/**` route handler를 경유한다.
- 세션 기반 인증과 역할(HQ / 권역 / 국가 / 관리자)을 추가하고, 모든 scope 호출에 대해 역할에서
  도출한 권역/국가 필터를 **서버단에서 강제 주입**하며 클라가 보낸 location 파라미터는 무시한다.
- v1 IA 라우트(통합 대시보드 / 개별 프로젝트 생성 / 관리자 콘솔)를 배치하고, 미정 영역은
  빈 상태(empty-state) 껍데기로 둔다(고객 관심 데이터, v1에서 경쟁사 cross-insight 제외).
- README에 thin-client 정체성, BFF 보안 규칙, `@answer/ontology-viz` 추출 계획을 문서화한다.

## Capabilities

### New Capabilities
- `app-foundation`: Next.js 15 + TS + Tailwind 4 스캐폴드, viz 의존성, 그리고 빈 상태 껍데기를
  포함한 v1 IA 라우트 구조.
- `localization`: next-intl ko/en 셋업, 로케일 라우팅, 용어 결정까지 담는 "하드코딩 금지" 사전 규율.
- `scope-gateway`: mock-first BFF — `ScopeClient` 계약, mock/http 구현, env 기반 선택, 그리고
  scope는 서버단에서만 접근 가능하다는 규칙.
- `access-control`: 세션 인증, 역할 모델, 그리고 전체 접근 권한을 가진 workspace key에 대한 보안
  경계로서의 서버단 범위 강제.

### Modified Capabilities
<!-- 없음 — greenfield 레포, 기존 spec 없음. -->

## Impact

- `app/`, `lib/`, `messages/`, `components/` 전반에 신규 파일; 신규 `package.json`과 도구 설정
  (TS, Tailwind, ESLint). 기존 코드 영향 없음.
- 신규 의존성: next, react, next-intl, tailwindcss, cytoscape(+fcose), d3(+d3-sankey),
  lucide-react.
- 신규 env 계약: `SCOPE_MODE`(mock|live), 그리고 (추후) `SCOPE_API_KEY`, `SCOPE_API_BASE`.
- PR 차단 컨벤션 확립: 클라→scope 직접 fetch 금지; UI 문자열 하드코딩 금지.

## 현재 상태 / 범위 (정직한 표기)

이 change가 실제로 무엇을 만들었고 무엇은 placeholder/미완인지 명확히 구분한다.

**실재하고 검증됨 (production 토대):**
- 기술스택: Next 15 + React 19 + TS + Tailwind 4 + next-intl(ko/en) + viz 의존성 + 도구 체인.
  `npm run build`(타입 체크 포함) / `lint` / `check:strings` 통과로 증명.
- 보안 경계: 미인증 차단, 서버단 역할 범위 강제(클라가 보낸 location 무시), 사용자별 감사 로그.
  런타임 검증 완료 — 이 부분의 *동작*은 실재한다.

**골격/placeholder (의도적으로 임시, 교체 예정):**
- 인증 백엔드: `lib/auth/users.ts`의 데모 사용자 4명 + 쿠키에 user id만 담는 세션. 실 ID
  저장소/서명 세션으로 교체 필요.
- scope 데이터: 전부 mock(`SCOPE_MODE=mock`). key 발급 시 env만 교체.
- 화면: 로그인/대시보드/프로젝트/관리자는 스택과 보안 경계를 *증명*하는 최소 골격. 실제 KPI·
  차트·측정 제출 UI는 미구현. 미정 데이터 영역은 빈 상태 껍데기.

**이 change에 포함하지 않음 (후속 작업):**
- ontology viz 자산 복사 (task 5.3, scope 레포 접근 필요 — BLOCKED).
- `/v1/query` 제출 UI, 집계 화면(인용 채널/프로젝트 현황) 실제 구현.
- 화면↔scope API 매핑 확정, 용어 확정, 외부 데이터(구글 키워드/VoC) 커넥터.

> 요약: "기술스택 셋업"이 목적이었고 그건 완료·증명되었다. 다만 스택을 *검증 가능하게* 만들고
> 핵심 보안 제약을 토대에 박기 위해, 동작하는 BFF/인증 골격까지 함께 깐 것이 이 change의 실제
> 범위다. 골격 위의 기능 구현은 후속 change로 분리한다.
