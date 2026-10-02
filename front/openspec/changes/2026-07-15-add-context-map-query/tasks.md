단계 1~4 가 본체(컨텍스트 맵 서버 질의 + 프롬프트 클라이언트 검색). 단계 5~7 은 조사 중 나온
인접 이슈로, **독립적이라 빼도 본체가 성립한다**.

## 0. 선행 확인 (코드 작성 전)

- [ ] 0.1 design.md 미해결 질문 1 — `generate-context-prompts.ts:56` 시드 풀 롱테일 의도를
      작성자에게 확인. 답에 따라 3.4 의 범위가 바뀐다.
- [ ] 0.2 design.md 미해결 질문 2 — 인덱스 마이그레이션 적용 경로 확인(0027/0028 은 out-of-band).
- [ ] 0.3 **현재 성능 베이스라인 측정** — `/projects/[id]/intent/social-scraping` 의 DB 시간과
      RSC 페이로드 크기를 기록. 이게 없으면 "더 가벼워졌다"를 주장할 수 없다.

## 1. 스키마 — 정렬 인덱스

- [ ] 1.1 마이그레이션 신설: `scope_context_entities (type, mention_count DESC)` 복합 인덱스.
      모든 목록 질의가 `WHERE type = ? ORDER BY mention_count DESC` 라 복합이 맞다.
- [ ] 1.2 검색용 trigram 인덱스는 **넣지 않는다**(design D3). 1.5 측정 후 재판단.
- [ ] 1.3 적용 후 `EXPLAIN ANALYZE` 로 인덱스 사용 확인 — 증거를 tasks 에 붙일 것.
- [ ] 1.4 `scope_context_combinations.co_count` 인덱스 필요 여부 판단(현재 없음, 5,739행).
- [ ] 1.5 검색 `ILIKE '%q%'` 실측 — 4,136행 seq scan 이 수 ms 라는 가정을 확인. 아니면 1.2 복구.

## 2. 리포지토리 — 페이지 단위 질의 (lib/db/repositories/scope-context-map.ts)

- [ ] 2.1 공통 타입 정의: `ContextMapQuery { search?, sort, dir, page, size }`,
      `Paged<T> { rows: T[], total: number, page: number, size: number }`.
      `total` 은 검색 적용 후 개수 — "결과 N / 전체 M" 표시에 둘 다 필요하다.
- [ ] 2.2 `listContexts(q)` — `type='ConsumerContext'`, 얇은 컬럼만(id/name/dimension/
      mention_count/sentiment). **evidence·domains 를 조인하지 않는다**(design D1).
- [ ] 2.3 `listConditions(q)` — 위와 동일, `type='ConsumerRequirement'`.
- [ ] 2.4 `listCombinations(q)` — **조건 이름 조인 필수**. 현재는 조건 200개가 전부 메모리에
      있다는 전제로 `condName(id)` Map 을 쓰는데, 페이징하면 그 전제가 깨진다. `cond_a`/`cond_b`
      를 `scope_context_entities` 에 조인해 이름을 함께 내려준다.
- [ ] 2.5 `getStats()` — 기존 corpus-wide 집계 유지(이미 값싸다).
- [ ] 2.6 `getEntityDetail(id)` — evidence + domains + drives 를 **이 엔티티에 대해서만**.
      다이얼로그 열 때 호출. `EVIDENCE_PER_ENTITY` 상한은 여기서만 의미를 갖는다.
- [ ] 2.7 `getSeedPool()` — 프롬프트 생성용 Top-N(design D2). fan-out 없이 얇게.
      0.1 답에 따라 N 결정.
- [ ] 2.8 `TOP_CONTEXTS`/`TOP_CONDITIONS`/`TOP_COMBINATIONS` 제거. `getMatrix` 제거.
- [ ] 2.9 모듈 레벨 `matrixCache` Map memo 재설계 — 페이지별 질의라 키가 달라진다.
      요청 단위 memo(`request-cache.ts` 패턴)로 갈지, 캐시 없이 갈지 판단.
- [ ] 2.10 단위 테스트: 페이징 경계(page 0/마지막/범위 밖), 검색 0건, `total` 정확성,
      `size` 상한 클램프.

## 3. 호출부 재배선

- [ ] 3.1 `app/api/context-map/route.ts` 신설 — 페이지 전환용 BFF. 세션 필수, 기존 route
      handler 패턴 준수.
- [ ] 3.2 `social-scraping/page.tsx:56` — `getMatrix` → 첫 페이지 + `getStats()`.
- [ ] 3.3 `_actions.ts:154` — `getMatrix("자동차")` → `getSeedPool()`.
- [ ] 3.4 `generate-context-prompts.ts` — 시드 풀 입력 타입 변경 반영. 0.1 답 반영.
- [ ] 3.5 `getMatrix` 잔존 참조 0건 확인(`grep -rn getMatrix app lib components`).

## 4. UI — 검색 / 페이징 / 잘림 표시

- [ ] 4.1 `context-map-view.tsx` 3개 테이블(컨텍스트/조건/컴비네이션)에 검색창.
      `useDeferredValue`(design D7).
- [ ] 4.2 페이지네이션을 `TableShell` 의 **기존 `footer` 슬롯**에 렌더(`:227`) — 새로 만들지 말 것.
- [ ] 4.3 정렬을 서버로 위임 — `SortableHeader` 는 표시·토글만, 훅의 `sorted` 미사용(design D7).
- [ ] 4.4 "검색 결과 N / 전체 M" 표시. 헤더 stats 와 테이블 개수의 불일치 해소.
- [ ] 4.5 상세 다이얼로그 lazy 로드 — 열 때 `getEntityDetail`. 로딩 상태 필요.
- [ ] 4.6 프롬프트 카탈로그: `question` 검색 + `layer`/`funnelStage` 필터(현재 정렬만 됨).
      **클라이언트 처리**(≤84행, design D5).
- [ ] 4.7 i18n 키 추가 — `messages/{ko,en}.json` 양쪽. `npm run check:strings` 통과.
- [ ] 4.8 페이지 전환 중 대기 UX — 기존 `Button pending` + 스켈레톤 재사용.

## 5. [독립] Lost-update 경합 수정

- [ ] 5.1 `scope-context-prompts.ts` — `set()` 에 낙관적 잠금. `generated_at` 을 토큰으로
      `WHERE project_id = ? AND generated_at = ?`, 0행이면 충돌 반환(design D6).
- [ ] 5.2 `_actions.ts` 두 액션에 충돌 처리 — 재조회 후 재시도 또는 사용자 안내.
- [ ] 5.3 회귀 테스트: 같은 blob 에 대한 동시 write 2건에서 한쪽이 유실되지 않음.

## 6. [독립] 노드맵 — 필터가 실제로 거르게

- [ ] 6.1 관점 필터를 dim(`opacity-25`)에서 **실제 필터**로(`:999-1007`, `:1141-1149`).
      카운트도 필터 반영.
- [ ] 6.2 하드코딩 정렬 6곳 → `useSortableTable`. 렌더 루프 안 재정렬 제거(`:934`, `:1078`,
      `:1229`, `:1348`, `:1550`, `:1840`).
- [ ] 6.3 노드맵은 **샘플 데이터(`MOCK_MATRIX`)** 라 라이브 배선은 범위 밖임을 코드 주석에 명시.

## 7. [독립] 정리

- [ ] 7.1 빈 상태 추가 — 라이브 테이블 4개. 죽은 `social-scraping-view.tsx:144-147` 의 것을
      참고(이 피처의 유일한 빈 상태가 거기 있다).
- [ ] 7.2 죽은 코드 삭제: `components/social-scraping/context-graph.tsx`(380줄),
      `components/social-scraping/prompt-candidates-dialog.tsx`(155줄),
      `app/[locale]/(dash)/projects/[id]/intent/_components/social-scraping-view.tsx`(297줄).
- [ ] 7.3 삭제 후 `npm run build` + `grep` 로 잔존 참조 0건 확인.

## 8. 검증 게이트

- [ ] 8.1 `npm test` — 신규 테스트(2.10, 5.3) 포함 전체 통과.
- [ ] 8.2 `npx tsc --noEmit` / `npm run lint` / `npm run check:strings` 클린.
- [ ] 8.3 `npm run build` 성공.
- [ ] 8.4 **0.3 베이스라인 대비 실측 비교** — 1페이지 DB 시간·페이로드가 기존 Top-350 번들보다
      작음을 수치로 제시. 이 change 의 핵심 주장이므로 증거 없이 완료 처리 금지.
- [ ] 8.5 라이브 프로젝트 라우트에서 **실제로 구동 확인** — 검색해서 Top-350 밖의 엔티티가
      나오는지. 이게 이 change 의 존재 이유다. 정적 검사로 대체 불가.
