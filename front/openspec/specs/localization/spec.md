# localization Specification

## Purpose
TBD - created by archiving change setup-frontend-scaffold. Update Purpose after archive.
## Requirements
### Requirement: ko/en 로케일 라우팅
애플리케이션은 next-intl로 ko(기본)와 en 두 로케일을 로케일 접두 라우팅(`/ko`, `/en`)으로 지원해야 한다(SHALL).
새 로케일 추가가 사전(dictionary) 하나와 로케일 목록 항목 추가만으로 끝나도록 구성되어야 한다.

#### Scenario: 기본 로케일이 결정됨
- **WHEN** 사용자가 로케일 접두 없이 루트에 접속하면
- **THEN** ko 로케일이 제공된다

#### Scenario: 로케일 전환이 UI 언어를 바꿈
- **WHEN** 사용자가 en으로 전환하면
- **THEN** 모든 노출 UI 문자열이 en 사전에서 렌더된다

### Requirement: UI 문자열 하드코딩 금지
모든 사용자 노출 텍스트는 i18n 조회로 사전(messages/ko.json, en.json)에서 가져와야 한다(MUST).
JSX 내 리터럴 표시 문자열은 금지된다. 이로써 용어 결정(aeorank vs scope 어휘)이 사전 편집만으로
처리된다.

#### Scenario: 렌더된 모든 라벨이 사전에서 옴
- **WHEN** 컴포넌트가 사용자 노출 라벨을 렌더하면
- **THEN** 라벨 값은 JSX 리터럴이 아니라 i18n 메시지 조회를 통해 가져온 것이다

#### Scenario: 컴포넌트 수정 없는 용어 변경
- **WHEN** 사전에서 용어(예: 표준프롬프트 vs 맥락)를 변경하면
- **THEN** 컴포넌트 코드 변경 없이 UI가 새 용어를 반영한다

### Requirement: 신규 화면·관리자 콘솔·빈 상태 라벨이 사전에 존재
이번 change의 신규 사용자 노출 텍스트는 두 로케일 사전(ko/en)에 동일 키 셋으로 존재해야 한다(SHALL).
대상은 추가 메뉴 항목, 신규 stub 페이지의 제목·부제, `/no-access` 빈 상태 문구, 관리자 콘솔의
컬럼·액션·역할 셀렉트 라벨이다. JSX 한글 하드코딩 금지 원칙은 변경 없이 유지된다.

#### Scenario: 영어 모드에서 신규 화면이 영어 사전 값으로 렌더됨
- **WHEN** 사용자가 en 로케일에서 고객 관심 / AI 답변 / 관리자 콘솔 / 빈 상태 화면을 열면
- **THEN** 모든 사용자 노출 문자열이 `messages/en.json`의 값으로 렌더된다(한글 fallback 없음)

#### Scenario: 두 사전의 키 셋이 일치함
- **WHEN** 이번 change의 신규 키들을 두 사전에 적용하면
- **THEN** ko 사전과 en 사전이 동일한 키 셋을 가진다(어느 한쪽에만 존재하는 키 없음)

