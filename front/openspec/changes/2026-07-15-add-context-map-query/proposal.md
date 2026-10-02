## Why

소셜 스크래핑(컨텍스트 맵) 화면에서 **데이터를 찾을 수단이 없다**. 조사 결과(2026-07-15):

- **검색창이 단 하나도 없다.** 라이브 프로젝트 라우트는 850행(컨텍스트 150 + 조건 200 +
  컴비네이션 500)을 페이지네이션 없이 한 번에 렌더한다. 컨텍스트 하나를 찾으려면 150행을
  눈으로 훑어야 한다.
- **더 심각한 건 "도달 불가능한 데이터"다.** 헤더는 코퍼스 전체 통계(4,136 엔티티)를 보여주는데
  테이블은 Top-150만 그린다. 사용자는 "4,136개"를 읽고 150개를 센다. 나머지 ~3,986개에 닿을
  방법이 없다 — 검색도, 페이징도, "더 보기"도, **잘렸다는 표시조차** 없다.

Top-N 캡(`scope-context-map.ts:36-41`)은 정당한 조치였다. 전체 로드가 **DB 16초 / RSC 페이로드
10MB**였고 주석이 "citations 페이지와 같은 full-scan 함정"이라 적어뒀다. 문제는 캡이 아니라
**캡이 대증요법**이라는 점이다: 비싼 것은 엔티티 목록이 아니라 거기 딸린 fan-out이다. 같은 주석이
직접 말한다 — *"evidence rows are long text and dominated the wire time (3.9s of the 6.4s)"*.
엔티티 4,136행 자체를 훑는 비용은 무시할 만하다.

그래서 이 change 는 캡을 넓히지 않는다. **필요한 만큼씩만 내려주는 구조로 바꾼다.** 그러면
도달 범위·검색·페이로드가 동시에 좋아진다 — 트레이드오프가 아니다.

| | 현재 | 이 change 이후 |
|---|---|---|
| 도달 가능 범위 | 350행 (전체의 8%) | **4,136행 전부** |
| 1회 페이로드 | Top-350 + fan-out 번들 | 1페이지(50행) — **더 작다** |
| 검색 | 불가 | 서버 `WHERE`로 전체 코퍼스 대상 |
| Top-N 캡 | 필수 | **불필요해짐** |

## What Changes

검색 대상이 두 종류로 갈리고, 각각 다른 답을 쓴다.

### A. 컨텍스트 맵 — 관계형 4,136행 → 서버 페이징 + 서버 검색

- **BREAKING** `scopeContextMapRepository.getMatrix(keyword)`(전체 Top-350 번들 1회 반환)를
  **질의 가능한 페이지 단위 메서드 집합**으로 교체:
  `listContexts` / `listConditions` / `listCombinations`({ search, sort, dir, page, size }),
  `getStats()`, `getEntityDetail(id)`.
- **상세(evidence·domains)를 lazy 로드**로 전환. 현재는 350개 엔티티분을 미리 싣는다 —
  주석이 지목한 6.4초 중 3.9초가 이것이다. 다이얼로그를 열 때만 가져온다.
- `TOP_CONTEXTS` / `TOP_CONDITIONS` / `TOP_COMBINATIONS` **상수 제거**. 페이지 크기가 그
  역할을 대신한다.
- 서버 검색: `canonical_name ILIKE '%q%'`. 4,136행 seq scan 은 수 ms 라 초기엔 인덱스 없이
  간다(design.md D3 참조 — 인덱스는 측정 후 판단).
- `mention_count` 정렬 인덱스 추가(현재 없음 — 매 조회가 4,136행 정렬).
- BFF route handler 신설(`app/api/context-map/*`) — 클라이언트 페이지 전환용.
- UI: 검색창 + 페이지네이션 + 잘림/결과수 표시. 기존 하우스 패턴 준수
  (`useSortableTable` + `SortableHeader`, 검색은 `useDeferredValue`).
  `TableShell` 의 **이미 존재하지만 아무도 안 쓰는 `footer` 슬롯**(`context-map-view.tsx:227`)이
  페이지네이션 자리다.

### B. 프롬프트 카탈로그 — JSON blob ≤84행 → 클라이언트 검색

- `scope_context_prompt_cache` 는 **프로젝트당 jsonb blob 1개**(PK `project_id`)라 서버
  페이징이 원리적으로 불가능하다. 프로덕션 최대치는 **84행 / 10.5KB**(9개 프로젝트 실측,
  6개는 14행). **서버로 갈 이유가 없다.**
- `question` 텍스트 검색 + `layer`/`funnelStage` 필터 추가(둘 다 현재 정렬만 되고 필터는 없다).
- 스키마 변경 없음.

### C. 인접 이슈 (독립 단계 — 넣고 뺄 수 있음)

- **Lost-update 경합 수정.** `generateMoreSocialPrompts` / `removeSocialPrompts` 둘 다 blob 을
  락·버전 없이 read-modify-write 한다(`_actions.ts:157/186`, `225/239`). "더 생성"을 두 번
  빠르게 누르거나 두 명이 동시에 만지면 한쪽이 조용히 사라진다. **검색과 무관한 데이터 유실**이다.
- **노드맵 관점 필터가 실제로 거르게.** 현재 `opacity-25`로 흐리게만 하고 행은 DOM·카운트에
  남는다(`context-node-map-view.tsx:999-1007`). 정렬도 하드코딩(6곳, 렌더 루프 안에서 재정렬)
  → 하우스 패턴으로.
- **빈 상태 추가.** 라이브 테이블 4개 모두 0행이면 헤더만 덩그러니 남는다. (이 피처의 유일한
  빈 상태가 죽은 파일 안에 있다.)
- **죽은 코드 832줄 제거**: `context-graph.tsx`(380) + `prompt-candidates-dialog.tsx`(155)
  import 0건, `social-scraping-view.tsx`(297) 주석에서만 언급.

### 범위 밖 (의도적으로 남김)

- **노드맵 서버 페이징** — 그래프는 일부만 그리면 의미가 없어 페이징이 원리적으로 불가.
  다만 노드맵은 현재 `MOCK_MATRIX` 샘플이라 당장 막히지 않는다. 라이브로 붙일 때 자체 경계
  설계가 필요하다(별도 change).
- **`keyword` no-op 수정** — `getMatrix(keyword)` 의 keyword 는 캐시 키로만 쓰이고 WHERE 에
  안 들어간다. 호출부는 `"자동차"` 하드코딩이라 모든 프로젝트가 동일한 행을 본다. 이건
  "프로젝트별 코퍼스"라는 제품 결정이 선행돼야 해서 이 change 에서 다루지 않는다.
- **조건 카테고리** — 정규식 휴리스틱이며 코드가 스스로 "display-only heuristic, not a real
  signal"이라 밝힌다. 카테고리 필터를 붙이면 데이터가 아니라 정규식을 거르게 되므로 넣지 않는다.

## Capabilities

### New Capabilities
- `context-map-exploration`: 컨텍스트 맵 코퍼스를 **찾을 수 있는** 상태로 만드는 capability.
  서버 질의(검색·정렬·페이징)를 유일한 조회 경로로 정의하고, 표시 범위가 코퍼스의 부분집합일
  때 그 사실을 UI 가 반드시 드러내도록 강제한다.

### Modified Capabilities
- `persistence-foundation`: `scope_context_*` 미러 조회를 "전체 번들 1회 + Top-N 캡"에서
  **페이지 단위 질의 + lazy 상세**로 교체. `mention_count` 인덱스 추가.

## Impact

- **스키마/마이그레이션**: `scope_context_entities.mention_count` 인덱스 추가(신규 마이그레이션).
  0027/0028 은 out-of-band 적용이었으므로(주석 참조) 적용 절차 확인 필요.
- **코드**: `lib/db/repositories/scope-context-map.ts`(재작성),
  `lib/db/repositories/scope-context-prompts.ts`(낙관적 잠금),
  `components/social-scraping/context-map-view.tsx`,
  `components/social-scraping/node-map/context-node-map-view.tsx`,
  `app/[locale]/(dash)/projects/[id]/intent/{social-scraping/page.tsx,_actions.ts}`,
  신규 `app/api/context-map/*`, `messages/{ko,en}.json`.
- **삭제**: `components/social-scraping/{context-graph,prompt-candidates-dialog}.tsx`,
  `app/[locale]/(dash)/projects/[id]/intent/_components/social-scraping-view.tsx`.
- **호출부 파급**: `getMatrix` 는 `_actions.ts:154`(프롬프트 생성 시드)와
  `social-scraping/page.tsx:56` 두 곳에서 쓴다. 시드 생성은 Top-N 셋이 필요하므로
  **페이징된 목록이 아니라 별도 시드 질의**로 분리해야 한다(design.md D2).
- **성능 목표**: 1페이지 응답 payload 를 현재 Top-350 번들보다 작게. 상세는 열 때만.
- **마이그레이션 리스크**: 낮음. 미러는 읽기 전용이고 blob 은 ≤84행이다.
