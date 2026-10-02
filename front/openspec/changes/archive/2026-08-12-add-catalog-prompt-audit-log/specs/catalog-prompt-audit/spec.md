# catalog-prompt-audit

## ADDED Requirements

### Requirement: 카탈로그 mutation은 감사 이벤트 없이 커밋되지 않는다

표준 카탈로그 프롬프트의 생성·본문/라벨 수정·측정종류 전환·soft-delete·복원은
같은 로컬 트랜잭션에서 `prompt_audit_logs` 행(이벤트 종류 + 바뀐 필드의 old/new +
actor)을 남겨야 한다(SHALL). Scope 반영 실패 시 로컬 변경과 로그가 함께 롤백되어야
한다(SHALL).

#### Scenario: Scope PATCH 실패 시 원자적 롤백

- **WHEN** admin이 본문을 수정하고 scope `updateRootPrompt`가 throw하면
- **THEN** `prompts` 행과 `prompt_audit_logs` 모두 변경 전 상태이고 액션은 `{ok:false}`를 반환한다

#### Scenario: 본문 수정은 id를 유지한다 (in-place)

- **WHEN** admin이 카탈로그 프롬프트 본문을 수정하면
- **THEN** 같은 `prompts.id`/`scope_prompt_id`로 text만 바뀌고, `text_updated` 이벤트에 old/new 전문이 기록된다

### Requirement: 삭제는 soft-delete이며 복원 가능하다

카탈로그 프롬프트 삭제는 `prompts.deleted_at` 세팅 + scope `active=false`로 처리해야
하며(SHALL), 물리 DELETE 경로는 카탈로그에서 제거된다. 복원은 그 역이다.

#### Scenario: 삭제 후 목록·측정 제외, 복원 시 복귀

- **WHEN** admin이 프롬프트를 삭제하면
- **THEN** 활성 카탈로그·뷰어·집계에서 빠지고 `deleted` 이벤트가 남는다
- **WHEN** 복원하면
- **THEN** 되돌아오고 `restored` 이벤트가 남는다

### Requirement: 벌크 교체는 건별 이력 + batch 묶음을 남긴다

xlsx 벌크 적용은 항목별 독립 처리(부분 실패 허용·실패 목록 반환)하고, 성공 건마다
감사 행을 남기며 공통 `batch_id`로 묶어야 한다(SHALL). `kind`는 벌크로 변경할 수
없다(측정량 ~20배 스위치 — 단건 확인 다이얼로그 전용).

#### Scenario: 부분 실패

- **WHEN** 청크 적용 중 한 항목의 scope PATCH가 실패하면
- **THEN** 그 항목만 실패 목록에 담기고 나머지 항목은 적용·기록된다

### Requirement: 이력은 NON_VENDOR 역할이 열람한다

프롬프트별 타임라인과 전역 이력(탭)·CSV는 `/standard/prompts` 접근 역할(NON_VENDOR)
에게 제공되어야 하며(SHALL), 전역 이력은 뷰어와 동일한 브랜드 스코프 술어(null/HMG=
공통)로 필터된다. 편집은 admin 외 전부 거부된다(SHALL).

#### Scenario: 브랜드 스코프 필터

- **WHEN** brands=[Kia] 스코프의 hq 사용자가 이력 탭을 열면
- **THEN** Kia·공통(null/HMG) 프롬프트의 이벤트만 보인다

#### Scenario: 비admin 편집 거부

- **WHEN** hq 사용자가 편집 액션을 호출하면
- **THEN** `UnauthorizedError`가 발생한다

### Requirement: 감사 원장은 append-only다

`prompt_audit_logs`는 3중으로 append-only를 강제한다(SHALL): 비owner 롤
REVOKE(UPDATE/DELETE) + 리포지터리에 update/delete 메서드 부재 + ESLint
`@/lib/db` 경계. (앱 접속 롤이 owner인 구성에서 DB 수준 완전 차단은 불가 —
코드 경계가 1차 방어.)

#### Scenario: 리포지터리 표면

- **WHEN** 코드가 감사 행을 수정·삭제하려 하면
- **THEN** `lib/db/repositories/prompt-audit-logs.ts`에 해당 메서드가 존재하지 않고, `@/lib/db` 직접 import는 ESLint가 차단한다

### Requirement: 추이 차트는 프롬프트 변경 시점을 표시한다

dashboard 추이 차트(LiveTrendChart)는 일 단위 변경 카운트(`text_updated`/`created`/
`deleted`)를 세로 마커로 표시하고, 마커에서 이력 탭으로 이동할 수 있어야 한다(SHALL).

#### Scenario: 변경일 마커

- **WHEN** 특정 일자에 카탈로그 변경이 N건 있고 그 날짜가 차트 X축에 존재하면
- **THEN** 그 위치에 "프롬프트 변경 N건" 마커가 그려진다
