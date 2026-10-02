## Context

hmg-geo는 모회사 GEO 측정 엔진 "scope" 위의 thin client + BFF가 될 greenfield 레포다. 핵심
제약은 보안이다: scope는 HMG 데이터를 단일 workspace API key로 노출하는데, 이 key는 HMG 전체
데이터(권역·국가·브랜드)를 연다. hmg-geo 자체 역할(HQ / 권역 / 국가 / 관리자)이 각 사용자가 볼
범위를 제한해야 하며, 이 제한은 서버에서 강제될 때만 신뢰할 수 있다 — 국가 담당자가 요청 파라미터를
바꿔 범위를 넓힐 수 있어선 안 된다. 두 가지 추가 제약이 토대를 좌우한다: 아직 scope API key가
없고(mock-first로 구축), UI 용어와 여러 데이터 출처가 미정이다(문자열·데이터 접근을 교체 가능하게).
스택은 scope를 따른다(Next.js 15 / React 19 / TS / Tailwind 4 + cytoscape/fcose + d3/d3-sankey)
— ontology viz 자산을 공유하기 위함이다.

## Goals / Non-Goals

**Goals:**
- scope key 없이도 실행되는 Next.js 15 App Router 앱(mock-first).
- 단단한 서버단 보안 경계: scope는 `app/api/**`로만 접근, 역할 기반 필터 서버단 주입, key는
  브라우저에 절대 노출 안 됨.
- 교체 가능한 용어(i18n 사전)와 교체 가능한 데이터 출처(`SCOPE_MODE`).
- v1 IA 라우트 스캐폴드, 미정 영역은 빈 상태 껍데기.

**Non-Goals:**
- scope 측정 로직 구축(scope 소유).
- 구글 키워드 / 커뮤니티 VoC 실 커넥터(출처 미정).
- 경쟁사 cross-insight / share-of-voice(v1 제외).
- `@answer/ontology-viz` 패키지 추출(지금은 복사, 추후 추출).
- 신규 집계 엔드포인트에 대한 화면↔API 매핑 확정(별도 협의).

## Decisions

- **BFF 호스트로 Next.js 채택(vs SPA + 별도 백엔드).** 보안 경계에는 UI와 같은 위치의 서버 계층이
  필요한데, App Router route handler가 두 번째 서비스 없이 이를 제공한다. 대안(Vite SPA)은 어차피
  별도 BFF를 강제하므로 기각.
- **mock/http 구현을 가진 `ScopeClient` 인터페이스, `SCOPE_MODE`로 선택.** 화면은 인터페이스에만
  의존; mock 기본이라 key 없이 실행. live 전환은 env 변경. 계약은 아직 없는 집계 엔드포인트를 mock
  메서드로 인코딩해 scope 팀과의 계약 초안이 된다. 대안(화면마다 scope 임의 호출)은 출처를 노출하고
  key 없는 개발을 막아 기각.
- **next-intl, ko 기본 + en, 로케일 접두 라우팅.** 사전은 용어의 단일 진실원천이라, 미정인
  aeorank-vs-scope 어휘가 JSON 편집으로 처리된다. 로케일 추가 = 사전 + 목록 항목. JSX 하드코딩 금지
  (가능한 경우 lint 강제).
- **세션 역할 기반 서버단 범위 강제.** route handler가 세션에서 허용 권역/국가를 도출해 필터를
  주입하고 클라가 보낸 location 값을 버린다. 단일 key는 scope에서 호출자를 구분 못하므로 사용자별
  attribution은 서버단에 기록.
- **scope ontology viz를 지금은 `lib/viz`에 복사, 추후 추출.** 조기 패키지화보다 속도 우선;
  README에 `@answer/ontology-viz` 추출 의도 기록.

## Risks / Trade-offs

- **mock이 실제 scope 응답과 어긋남(drift)** → `ScopeClient` 타입을 단일 진실원천으로 유지하고,
  계약이 확정되는 즉시 scope 실제 스키마와 정렬한다.
- **화면이 BFF를 우회해 클라단에서 scope 호출** → 컨벤션은 PR 차단; 리뷰뿐 아니라 CI에서 실패하도록
  lint 규칙/경계 검사 고려.
- **하드코딩 문자열이 스며들어 i18n 침식** → lint와 리뷰로 강제; 리터럴 하나라도 배포되면 가치 상실.
- **역할→범위 매핑에 기획 공백(국가 담당 = 권역으로 가정)** → 매핑을 한 곳에 인코딩해 확정 시 저렴하게
  수정; 열린 질문으로 취급.
- **viz 복사본이 scope 상류와 분기** → 단기적으로 허용; 추출 계획으로 완화.

## Open Questions

- 화면↔scope API 정확한 매핑: v1 데이터 중 무엇이 /v1/results로 되고 무엇이 신규 집계 엔드포인트
  (인용 채널 영향력, 프로젝트 현황)가 필요한가?
- 국가 담당 역할의 정확한 허용 범위(기획 문서 공백).
- UI 용어: aeorank 어휘 vs scope narrative 어휘(사전으로 보류).
- 구글 키워드 / 커뮤니티 VoC 데이터 출처, 그리고 scope 경유인지 직접 연동인지.
- 인증 백엔드: hmg-geo 자체 로그인의 ID 저장소/자격 증명 출처는 무엇인가?
