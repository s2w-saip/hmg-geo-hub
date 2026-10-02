## 1. 프로젝트 스캐폴드

- [x] 1.1 Next.js 15(App Router) + React 19 + TypeScript 프로젝트 초기화
- [x] 1.2 Tailwind 4 추가 및 설정
- [x] 1.3 viz 의존성 추가: cytoscape, cytoscape-fcose, d3, d3-sankey, lucide-react
- [x] 1.4 tsconfig, ESLint, 기본 스크립트(dev/build/lint) 구성
- [x] 1.5 dev 서버 실행 및 프로덕션 빌드 TS 오류 없음 확인

## 2. 다국어(next-intl)

- [x] 2.1 next-intl 설치 및 로케일 접두 라우팅(/ko, /en) 구성, ko 기본
- [x] 2.2 초기 키를 담은 messages/ko.json, messages/en.json 생성
- [x] 2.3 app/[locale] 하위에 i18n provider + 로케일 레이아웃 연결
- [x] 2.4 로케일 스위처 추가, 전환 시 모든 노출 문자열이 바뀌는지 확인
- [x] 2.5 (가능한 경우) JSX 내 UI 문자열 하드코딩 방지 lint 가드 추가

## 3. scope 게이트웨이(mock-first BFF)

- [x] 3.1 lib/scope/types.ts 정의(계약: query, results + 집계 mock 메서드)
- [x] 3.2 lib/scope/client.ts에 ScopeClient 인터페이스 정의
- [x] 3.3 계약 형태의 mock 데이터를 반환하는 lib/scope/mock.ts 구현
- [x] 3.4 lib/scope/http.ts 구현(Bearer key, env의 base URL) — live 전까지 비활성
- [x] 3.5 SCOPE_MODE로 구현 선택하는 lib/scope/index.ts 구현(기본 mock)
- [x] 3.6 ScopeClient를 서버단에서 소비하는 app/api/scope/* route handler 추가
- [x] 3.7 env 계약(SCOPE_MODE, SCOPE_API_KEY, SCOPE_API_BASE)을 .env.example에 문서화

## 4. 접근 제어(인증 + 서버단 범위 강제)

- [x] 4.1 세션 기반 로그인 및 서버단 세션 처리 구현
- [x] 4.2 역할 모델(HQ / 권역 / 국가 / 관리자)과 역할→허용범위 매핑을 한 곳에 정의
- [x] 4.3 가드/미들웨어 추가: 미인증 사용자 리다이렉트, 미인증 API 호출 차단
- [x] 4.4 scope route handler에서 세션 역할로 필터를 도출해 서버단 주입, 클라가 보낸 location 무시
- [x] 4.5 각 scope 호출에 사용자별 attribution 로깅 추가

## 5. IA 라우트와 껍데기

- [x] 5.1 인증 라우트 스캐폴드: 통합 대시보드, 개별 프로젝트 생성, 관리자 콘솔
- [x] 5.2 고객 관심 데이터(구글 키워드, 커뮤니티 VoC) 빈 상태 껍데기 추가; SoV 뷰 없음

<!-- (이전 5.3 "ontology viz 자산 복사"는 scope 레포 접근이 필요한 외부 블로킹이라
     이 change에서 제외하고 별도 후속 change로 분리함. lib/viz/README.md에 추출 계획 보존.) -->


## 6. 문서화

- [x] 6.1 README 재작성: thin-client 정체성, BFF 보안 규칙, viz 추출 계획
- [x] 6.2 열린 질문 기록(화면↔API 매핑, 국가 역할 범위, 용어, 데이터 출처)
