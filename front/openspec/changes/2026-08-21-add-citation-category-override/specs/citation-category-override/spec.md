# citation-category-override

## ADDED Requirements

### Requirement: 운영자는 도메인별 인용 출처 카테고리를 교정할 수 있다

`/admin/standards/citation-sources` 는 admin 만 접근할 수 있어야 한다(SHALL). 운영자가 도메인의
카테고리를 저장하면 `citation_domain_overrides` 에 정규화된 registrable domain(lowercase ·
선행 `www.` 제거 · trim)을 키로 1행이 upsert 되고, 원복은 그 행을 지운다. 저장값은 택소노미
11종(`lib/citation-categorizer/taxonomy.ts`)에 속해야 하며, 그 밖의 값과 빈 도메인은 거부된다.

#### Scenario: 비-admin 차단
- **WHEN** admin 이 아닌 역할(또는 미로그인)이 저장·원복 액션을 호출하면
- **THEN** `UnauthorizedError` 가 던져지고 DB 쓰기와 캐시 무효화가 **모두** 일어나지 않는다

#### Scenario: 택소노미 밖 값 거부
- **WHEN** 액션이 택소노미에 없는 카테고리 문자열을 받으면
- **THEN** 행이 생기지 않는다

#### Scenario: 원복
- **WHEN** 오버라이드가 있는 도메인에서 원복하면
- **THEN** 행이 삭제되고 그 도메인은 기본 분류(owned/seed/rule/fallback)로 돌아간다

### Requirement: 분류 우선순위는 override 가 최상위다

`categorizeDomain(domain, overrides?)` 의 판정 순서는
**override → owned catalog → seed.json → rules.ts → "Other"** 여야 한다(SHALL).
2번째 인자를 생략·`undefined`·`null`·빈 Map 으로 준 경우 결과는 오버라이드 도입 이전과
**완전히 동일**해야 한다(SHALL) — 이것이 회귀 기준이다.

#### Scenario: owned 를 덮어쓰기
- **WHEN** 당사 보유 도메인에 오버라이드가 걸려 있으면
- **THEN** 오버라이드 카테고리가 이기고, 화면은 "당사 보유 도메인을 덮어쓰는 중" 경고를 띄운다

#### Scenario: 오버라이드 0행 회귀
- **WHEN** 오버라이드가 한 행도 없으면
- **THEN** seed 전량과 표본 도메인의 분류가 이전 구현과 1:1 일치한다

### Requirement: 저장은 백필 없이 즉시 전 이력에 반영된다

분류는 read-time 파생이므로 저장 시 백필하지 않는다. 액션은 `CITATION_OVERRIDES_TAG` 와
`MIRROR_AGGREGATE_TAG` 를 **둘 다** `revalidateTag` 해야 한다(SHALL) — Next 는 중첩
`unstable_cache` 의 태그를 바깥 엔트리에 상속시키지 않으므로 하나만 지우면 화면이 안 바뀐다.
오버라이드 로드는 캐시 콜백 **안쪽**에서 수행해야 한다(SHALL) — 캐시 래퍼의 인자로 넘기면
Map 이 캐시 키에 섞여 필터 콤보 간 캐시 오염이 된다.

#### Scenario: 저장 후 즉시 반영
- **WHEN** 운영자가 카테고리를 저장하면
- **THEN** 두 태그가 무효화되고 다음 조회에서 전 기간 산출물이 새 분류로 집계된다

#### Scenario: 테이블 미적용·DB 장애
- **WHEN** `citation_domain_overrides` 가 없거나 조회가 실패하면
- **THEN** 로더는 빈 맵을 돌려주고 화면은 기본 분류로 정상 동작한다(코드 선배포 안전)

### Requirement: live 와 mirror 는 같은 분류를 낸다

인용 산출물을 만드는 모든 집계 지점은 동일한 오버라이드 맵을 통과해야 한다(SHALL).
어느 한 지점이 누락되면 같은 도메인이 화면의 위치에 따라 다른 카테고리로 보인다.

#### Scenario: 양 경로 패리티
- **WHEN** live 경로와 mirror 경로에 같은 오버라이드를 주입하면
- **THEN** 두 경로의 카테고리 집계 결과가 일치한다
