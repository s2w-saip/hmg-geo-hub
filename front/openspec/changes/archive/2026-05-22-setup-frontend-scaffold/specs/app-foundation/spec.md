## ADDED Requirements

### Requirement: 프로젝트 스캐폴드와 도구 설정
프로젝트는 App Router 기반 Next.js 15 + React 19 + TypeScript + Tailwind 4 애플리케이션이어야 한다(SHALL).
합의된 시각화 의존성(cytoscape, cytoscape-fcose, d3, d3-sankey, lucide-react)이 설치되어야 한다.

#### Scenario: 개발 서버가 실행됨
- **WHEN** 개발자가 설치 후 dev 명령을 실행하면
- **THEN** 타입/컴파일 오류 없이 앱이 빌드되고 서빙된다
- **AND** Tailwind 유틸리티 클래스가 스타일로 렌더된다

#### Scenario: 프로덕션 빌드가 성공함
- **WHEN** 프로덕션 빌드 명령이 실행되면
- **THEN** TypeScript 오류 없이 빌드가 완료된다

### Requirement: v1 정보구조 라우트
애플리케이션은 인증 뒤에 v1 IA를 라우트로 노출해야 한다(SHALL): 통합 대시보드, 개별 프로젝트
생성, 관리자 콘솔.

#### Scenario: 인증된 사용자가 대시보드에 도달함
- **WHEN** 인증된 사용자가 대시보드 라우트로 이동하면
- **THEN** 로케일 접두 경로 안에서 통합 대시보드 페이지가 렌더된다

#### Scenario: 미인증 접근은 리다이렉트됨
- **WHEN** 미인증 방문자가 대시보드 라우트를 요청하면
- **THEN** 로그인 라우트로 리다이렉트된다

### Requirement: 미정 영역의 빈 상태 껍데기
데이터 출처가 미정인 화면은 조작된 UI 대신 빈 상태(empty-state) 자리표시자를 렌더해야 한다(SHALL).
대상은 고객 관심 데이터(구글 키워드, 커뮤니티 VoC)이며, 경쟁사 cross-insight(share-of-voice)는
v1에 나타나지 않아야 한다.

#### Scenario: 미정 데이터 영역이 빈 상태를 보여줌
- **WHEN** 사용자가 고객 관심 데이터 화면을 열면
- **THEN** "데이터 출처 미정"을 알리는 빈 상태 자리표시자가 표시된다
- **AND** 경쟁사 cross-insight 뷰는 존재하지 않는다
