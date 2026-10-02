## ADDED Requirements

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
