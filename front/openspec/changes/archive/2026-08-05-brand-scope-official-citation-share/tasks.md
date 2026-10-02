# Tasks — 공식 인용 비중 당사(축E) 판정 통일

> 라인 앵커는 `wbs/menu-group-restriction` 작업 트리 기준 — **착수 시 재확인**.
> 순서: 헬퍼 → 게이트웨이 스레딩 → 집계 파라미터화 → 타일/배지 → i18n → 테스트 → 실측 고지.

## 1. 스코프 헬퍼 — `lib/scope/server.ts` (또는 `lib/scope/hmg-brands.ts`)

- [x] 1.1 `ownedBasePrefixesForScope(filters)` 신규: 축E 교집합(활성 brand 필터(락
      포함) ∩ 로스터, `contextBrand ?? brand` — 언급 축E와 동일 입력) → 해당 브랜드의
      `GEO_OWNED_BASES` prefixes. 교집합 비면 3사 전체 폴백(`hmg-brands.ts` 규칙 준용,
      빈 IN 절 방지). 브랜드명 해석은 `resolveHmgBrandName` 재사용.

## 2. 게이트웨이 — `lib/scope/server.ts`

- [x] 2.1 표준 콜사이트 스레딩: standard-citations(:607-608) · standard-trend
      (:617-619, 현행 `GEO_OWNED_BASE_PREFIXES` 명시 전달을 헬퍼 결과로) ·
      sub-kpis(:621-622) · 코어 집계(aggregateStandardFromMirror 콜사이트) 전부
      `ownedBasePrefixesForScope(filters)` 전달. 캐시 함수 인자에 포함(키 자동 반영).
- [x] 2.2 웹사이트 콜사이트(:980, :1006 일대) 동일 스레딩.
- [x] 2.3 `fetchProjectCitations`(:462-473)를 KPI ⑤ 패턴(:793-806)으로 개편:
      `cachedProjectById` → `ownedBasePrefixesForProject` → 인자 전달. 프로젝트는
      스코프 헬퍼가 아니라 **프로젝트 사슬**(설정 owned bases → domain → brand×country)
      — 기존 KPI ⑤와 동일.

## 3. 집계 — `lib/db/repositories/scope-aggregates.ts`

- [x] 3.1 `aggregateCitationsFromMirror`(:2104-)에 `ownedBasePrefixes` 파라미터 추가.
      `aggregateStandardFromMirror`(:432)·서브(:656)·추이(:866)의
      `= GEO_OWNED_BASE_PREFIXES` **디폴트 제거** — 판정 소스를 콜사이트가 항상 명시
      (디폴트 의존이 이번 표준 경로 갭의 원인).
- [x] 3.2 `citationOwnedClause`(:1828-1830)·`citationOwnedBaseSql`(:1841-1846)
      파라미터화: base-prefix 목록 + url 없는 행의 도메인 폴백 정규식(`domain ~*`)을
      전달된 prefixes에서 파생한 도메인 집합으로 한정. `verify:url-match`(SQL↔JS 일치
      가드) 갱신.
- [x] 3.3 타일 분자 스칼라: owned 판정 인용 수/전체 인용 수를 SQL로 계산해
      `CitationsLive.summary.officialOwnShare`(optional)로 반환. 도메인 행 top-N 캡과
      무관하게 전량 기준.
- [x] 3.4 `promptBuckets`(당사 인용/미인용 프롬프트 버킷)·도메인 owned 플래그가 동일
      prefixes를 쓰는지 확인·정렬.
- [x] 3.5 live(HTTP) 어댑터 경로 — **구현 중 판정 변경**: `aggregateCitationsFrom`/
      `aggregateCitationsFromPublic`은 게이트웨이 미배선(테스트 전용 레거시, 프로덕션
      인용 읽기는 전부 미러 경로)임을 전수 확인 → 파라미터화 대신 주석으로 명시,
      `officialOwnShare` 미계산(undefined → 뷰 폴백).

## 4. UI — `citations-view.tsx`

- [x] 4.1 타일 교체: `officialOwnShare` 존재 시 "공식 (당사) 인용 비중"(전 표면 공통),
      부재(구 캐시 30분 창) 시 현행 HMG 타일 폴백.
- [x] 4.2 ⓘ툴팁: 당사 판정 정의(표준/웹사이트 = 브랜드 스코프 공식 베이스, 프로젝트 =
      owned bases → 도메인 → 브랜드×국가 사슬)와 "카테고리 파이의 Official (HMG)
      분류와 다름"을 명시(기존 4컬럼 정의 툴팁 패턴).
- [x] 4.3 도메인 테이블 owned 배지가 같은 판정을 따르는지 렌더 확인(3.2로 자동 정렬
      예상).

## 5. i18n — `messages/{ko,en}.json`

- [x] 5.1 `summary.officialOwnShare` + 툴팁 정의·산식 키(ko/en). 현행
      `officialShare`(:609)는 폴백 렌더용 유지(후속 change에서 제거). "표준" 어휘 금지.

## 6. 테스트

- [x] 6.1 축E: 표준 픽스처에서 brand=Hyundai 필터 시 kia.com 인용이 분자 불포함;
      무필터 시 3사 전체 = 현행값 동일(회귀).
- [x] 6.2 폴백: 교집합 빈 brand 필터 → 3사 폴백(분자 0 아님).
- [x] 6.3 프로젝트 사슬: 설정 owned bases > project.domain > brand×country 순;
      Hyundai 프로젝트 분자에 kia.com/genesis.com 불포함.
- [x] 6.4 판정 단일성: 동일 표면·필터·창에서 KPI ⑤ == 타일 == 배지 == 버킷 판정.
- [x] 6.5 `verify:url-match` 통과(파라미터화 후 SQL↔JS 동일성 — 실행 확인, 정규화
      로직은 불변이라 스크립트 수정 불필요).

## 7. 게이트 + 고지

- [x] 7.1 `npm test` · `npm run build` · `npm run lint` · `npm run check:strings` 통과.
- [x] 7.2 dev 실데이터 실측 + 고지 문안 + 스크린샷 — 완료(2026-08-05):
      실측(int 테스트 `scope-aggregates.official-share.int.test.ts`) 표준 무필터
      total 37,690 · officialOwnShare 2.9%(= 종전 전사 판정, 회귀 기준);
      brand=Hyundai 당사판정 3.9% vs 전사판정 4.0%(-0.1%p — kia/genesis 공식 인용
      이탈분). 고지 문안 = ./notice-ggmd.md. 스크린샷 = 데모 프로젝트 인용 탭
      타일 26.8% 렌더 확인(`docs/reports/screenshot-official-own-share-demo-
      20260805.png`, 미커밋 로컬 보관).
