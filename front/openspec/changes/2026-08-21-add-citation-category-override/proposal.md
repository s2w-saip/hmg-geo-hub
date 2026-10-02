## Why

인용 출처 카테고리는 `lib/citation-categorizer/` 의 **read-time 순수 함수**가 유일한 소스다
(scope 는 citation category 를 보내지 않는 것으로 확정, 2026-07-02). 분류를 고치려면
`seed.json`(333개) 또는 `rules.ts` 를 커밋·배포해야 한다 — 고객이 "이 도메인 분류가 틀렸다"고
지적해도 **다음 배포 전까지 화면이 안 바뀐다.** 미분류(`Other`) 도메인 큐레이션도 같은 이유로
`scripts/citations/seed-curation.ts` 를 돌린 사람만 할 수 있다.

운영자가 화면에서 도메인별 분류를 교정하고 **즉시** 반영되게 한다. 분류가 read-time 파생이라
저장 즉시 전 이력이 재분류되며, 백필은 필요 없다.

## What Changes

- **DB**: `citation_domain_overrides` 신설 — `domain`(PK, 정규화된 registrable domain) ·
  `category`(택소노미 11종) · `note` · `updated_by` · `updated_at`. 행 삭제 = 원복.
- **분류기**: `categorizeDomain(domain, overrides?)` 선택 파라미터 추가. 우선순위 =
  **override → owned catalog → seed.json → rules.ts → "Other"**. 파라미터 생략 시 현행과 동일.
- **주입**: 동기 집계 지점(`aggregateCitationsFromPublic` · `aggregateCitationsFrom` · brand 인용
  롤업 · `foldCitationsLive` 계열)에 `overrides?: ReadonlyMap` 파라미터를 얹고, 로드는
  `aggregateCitationsFromMirror` · `aggregateBrandCitationsFromMirror` **내부**(= 캐시 콜백 안쪽)에서
  한다. ⚠️ 초안은 `lib/scope/server.ts` 의 `fetch*Citations` 에서 로드하려 했으나 **기각**했다 —
  그 경로는 `unstable_cache` 래퍼라 `Map` 을 인자로 넘기면 캐시 키 직렬화에서 전부 같은 값으로
  접혀 필터 콤보 간 캐시가 오염된다. `server.ts` 는 무변경이다.
- **캐시**: `loadCitationOverrides()` 는 `unstable_cache` + 전용 태그. 저장·삭제 시 그 태그와
  `MIRROR_AGGREGATE_TAG` 를 함께 `revalidateTag` (entities admin 선례와 동일).
- **화면**: `/admin/standards/citation-sources` — 실제 인용 데이터의 가중치 상위 도메인 목록,
  행마다 현재 분류 + **출처 배지**(override/owned/seed/rule/fallback), 검색·카테고리 필터·
  "Other 만" 토글, 인라인 카테고리 셀렉트 + 원복. 권한은 기존 `canAccessAdmin`.

## Capabilities

### New Capabilities
- `citation-category-override`: 운영자가 도메인별 인용 출처 카테고리를 교정하고 캐시 무효화로
  즉시 전 이력에 반영한다.

## Decisions

- **override 를 owned catalog 위에 둔다.** 아래에 두면 owned 도메인 오분류를 UI 로 고칠 방법이
  아예 없다. 대신 owned 도메인을 오버라이드하면 화면에 경고 배지를 띄운다.
- **`result-adapter.ts` 는 순수 모듈로 유지한다.** 이 파일은 `server-only` 가 없고 클라이언트
  컴포넌트가 `import type` 으로 참조한다 — 로더를 import 하면 이후 값 import 하나로 빌드가 깨진다.
  오버라이드는 파라미터로만 받는다.
- **모듈 전역 캐시 방식 기각.** `categorizeDomain(d)` 시그니처를 유지한 채 모듈 변수에 오버라이드를
  담으면 호출부를 안 고쳐도 되지만, 숨은 전역 상태라 로드 전 호출이 조용히 옛 분류를 내고
  테스트가 순서 의존이 된다. live/mirror 패리티가 "구조적 보장"에서 "로드 타이밍 운"으로 강등된다.
- **seed.json·rules.ts 는 손대지 않는다.** 코드 리뷰 대상인 기본 분류는 그대로 두고 DB 는 그 위의
  교정층이다. 이중 정본을 만들지 않기 위해 DB→seed 역동기화도 하지 않는다.
- **범위 밖**: 택소노미 11종 목록 편집(값이 i18n slug·필터 패널·파이 차트에 하드코딩), `rules.ts`
  편집(순서 의존 규칙 오편집 시 전 이력 오분류), 고객 admin 노출, 승인 워크플로, 일괄 업로드.

## Impact

- DB: `0043_citation_domain_overrides.sql` — **손작성 멱등 SQL**. `npm run db:generate` 는 못 쓴다
  (`lib/db/migrations/meta/` 스냅샷이 0000~0002 뿐이고 `_journal.json` 이 0020 에서 멈춰 있어
  0002 기준으로 20여 개를 재생성하려다 컬럼 rename 프롬프트에서 죽는다 — 2026-08-21 실행 확인).
  0021+ 관행과 동일. 적용 판정은 저널이 아니라 `SELECT to_regclass('public.citation_domain_overrides')`.
  적용 후 `scripts/db/lockdown.sql` 재실행 + `has_table_privilege('anon', …)` = false 확인.
- 오버라이드가 0행이면 모든 산출물이 현행과 바이트 단위로 동일해야 한다(회귀 기준).
- 감사: 별도 audit-log 테이블 없이 `updated_by`/`updated_at` 으로 충분(내부 운영자 전용).

## 우선순위 — 저장된 category 와의 관계 (2026-08-21 결정)

전 집계 지점은 `resolveCitationCategory(row.category, domain, overrides)` 를 통과한다.
순서는 **운영자 교정 > 저장된/전송된 `row.category` > 로컬 분류기**다. 종전
`row.category ?? categorizeDomain(...)` 은 행에 category 가 있으면 교정을 조용히 무시했다 —
mock 인용 행은 이미 category 를 싣고 있어 mock 데모에서 저장이 반영되지 않았고, scope 가
분류를 보내기 시작하면(미러 sync 는 `c?.category ?? null`, `lib/scope/mirror/sync.ts:567`)
프로덕션에서도 신규 행부터 admin 화면이 무력화된다. 사람이 명시 지정한 교정을 엔진 자동
분류보다 위에 둔다.
