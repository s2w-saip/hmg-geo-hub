# Unify Official Citation Share on the Brand-Scope (축E) Judgment (공식 인용 비중 당사 판정 통일)

## Why

GGMD 고객 지적(2026-08-05): Hyundai 프로젝트의 Analysis-Citation 타일 "공식 (HMG) 인용
비중"이 kia.com·genesis.com까지 합산돼 hyundai.com 비중과 안 맞음. 고객 판단: 브랜드
프로젝트에서 타 브랜드 공식 사이트까지 합산한 비중은 불필요.

**2026-08-05 결정(지원): "전사 관점" 별도 지표는 두지 않는다.** 언급 계열 KPI(노출률·
SOV·우호도)는 이미 축E("당사 = 활성 브랜드 스코프 ∩ 3사")를 따르며, 무필터 hq/admin
에서는 자동으로 3사 전체가 된다 — 전사 관점은 무필터의 자연스러운 특수경우이지 별도
지표가 아니다. 공식 인용 비중만 유일하게 축E 밖에 있다:

- 프로젝트 대시보드 KPI ⑤는 당사 한정(`ownedBasePrefixesForProject`,
  `lib/scope/server.ts:498-514` — 설정 owned bases → project.domain → brand×country
  카탈로그 폴백)이지만, Analysis-Citation 상세 경로(`fetchProjectCitations` →
  `aggregateCitationsFromMirror`)는 prefixes 미스레딩 — owned 배지·타일이 HMG 전체.
- 표준/웹사이트 경로는 브랜드 필터와 무관하게 항상 `GEO_OWNED_BASE_PREFIXES`(HMG 전체)
  (`server.ts:617-619`, `scope-aggregates.ts:429-432` 디폴트) — Hyundai로 필터해도
  그 답변들이 인용한 kia.com이 "오피셜 인용"으로 계상된다. 같은 혼선의 표준 레벨 잠복.

## What Changes

- **판정 통일 (전 표면)**: 공식 인용 비중의 분자 판정 = **현재 브랜드 스코프의 공식
  베이스** (축E — 활성 brand 필터(락 포함) ∩ 3사, 교집합 비면 3사 폴백 —
  `lib/scope/hmg-brands.ts` 규칙 준용).
  - 표준/웹사이트: 스코프 브랜드들의 카탈로그 베이스 전체(국가 불문 — 축E는 브랜드
    축이며 지역 필터는 답변 모집단이 이미 처리). 무필터 = 3사 전체 = **현행값 불변**.
  - 프로젝트: 기존 KPI ⑤ 사슬 그대로(설정 owned bases → project.domain →
    brand×country 카탈로그) — 이 change에서는 인용 상세 경로에 스레딩만 추가.
- **동일 프리픽스를 같은 표면의 전 소비처에**: 대시보드 KPI ⑤(코어·추이·서브) ·
  Analysis-Citation 타일 · 도메인 owned 배지 · 당사 인용 프롬프트 버킷. 한 화면
  체계에 판정 두 개를 남기지 않는다.
- **타일 개명 (전 표면)**: "공식 (HMG) 인용 비중" → **"공식 (당사) 인용 비중"**.
  분자/분모는 SQL 스칼라(카테고리 슬라이스 아님). ⓘ툴팁: 당사 판정(브랜드 스코프
  공식 베이스; 프로젝트는 owned bases 사슬)과 "카테고리 파이의 Official (HMG)와
  다름"을 명시.
- **카테고리 파이 불변**: `Official (HMG)` 택소노미는 출처 구성 분류(도메인→카테고리
  순수 함수, 스코프 무관)로 유지.
- **캐시**: prefixes를 캐시 함수 인자로 전달(`unstable_cache` 키 자동 포함 — KPI ⑤
  프로젝트 경로와 동일 패턴). 표준/웹사이트는 필터에서 파생되므로 콤보별로 갈린다.

### 범위 제외 (명시)

- citation-categorizer 택소노미·seed 변경 없음. scope API/미러 스키마 변경 없음.
- 표준/웹사이트에서 지역(국가) 필터로 공식 베이스를 좁히지 않음 — 축E는 브랜드 축
  (국가 좁히기는 프로젝트의 owned bases 개념).
- 무필터 전사 화면의 수치 변화 없음(정의상 3사 전체 = 현행 동일).

### 고지 필요 (착수 시)

표준/웹사이트에서 **브랜드 필터 활성 시** KPI ⑤·인용 타일 수치가 변한다(비교 답변의
타 브랜드 공식 인용이 빠지는 만큼). 착수 시 dev 실데이터로 변동 폭을 실측해 GGMD에
고지한다.

## 코어/테넌트 판정

**코어.** "공식 인용 판정 = 당사 브랜드 스코프"는 언급 계열 KPI가 이미 채택한 축E의
확장 적용으로 테넌트 무관 일반 규칙이다. HMG 카탈로그·엔티티 로스터는 테넌트 자산이지만
이 change에서 불변.

## Capabilities

### Added Capabilities

- `citation-official-share`: 공식 인용 비중의 판정 소스(축E 브랜드 스코프; 프로젝트는
  owned bases 사슬)와 화면 내 판정 단일성(same-surface single judgment), 무필터
  전사 불변 규약.

## Impact

(라인 앵커는 `wbs/menu-group-restriction` 작업 트리 기준 — 착수 시 재확인.)

- **게이트웨이**: `lib/scope/server.ts` — 신규 헬퍼 `ownedBasePrefixesForScope(filters)`
  (축E 교집합 → `GEO_OWNED_BASES` 브랜드 필터); 표준 호출부(:596-628 —
  standard-citations :607-608, standard-trend :617-619, sub-kpis :621-622, 코어 집계
  콜사이트) · 웹사이트 호출부(:980, :1006 일대) · `fetchProjectCitations`(:462-473,
  :793-806 패턴으로 개편).
- **집계**: `lib/db/repositories/scope-aggregates.ts` —
  `aggregateCitationsFromMirror`(:2104-) 파라미터화, `citationOwnedClause`(:1828-1830)·
  `citationOwnedBaseSql`(:1841-1846)의 prefixes/도메인 폴백 집합 주입(디폴트 제거 —
  판정 소스를 콜사이트가 명시), 타일 분자 스칼라 추가.
- **타입**: `lib/scope/result-adapter.ts::CitationsLive`(:1195-) — summary에
  `officialOwnShare`(optional) 추가; live(HTTP) 어댑터 경로 동일 판정.
- **UI**: `standard/answer-analysis/_components/citations-view.tsx` — 타일(:384-389)
  교체(`officialOwnShare` 부재 시 = 구 캐시 → 현행 타일 폴백), `OFFICIAL_HMG`
  상수(:97) 사용처 정리, ⓘ툴팁.
- **i18n**: `messages/{ko,en}.json` — `summary.officialOwnShare` 계열 신규 키; 현행
  `officialShare`(:609)는 폴백 렌더용으로 유지 후 후속 제거.
- **테스트**: 축E 교집합·3사 폴백·프로젝트 사슬·무필터 불변(회귀)·verify:url-match
  갱신.

## 수용 기준 (요약 — 상세는 specs/tasks)

1. Hyundai 프로젝트 타일 분자에 kia.com/genesis.com 인용이 포함되지 않는다.
2. 표준/웹사이트에서 brand=Hyundai 필터 시 분자가 Hyundai 공식 베이스로 한정된다;
   **무필터 시 현행값과 동일**(회귀 기준).
3. 같은 표면·같은 필터·같은 스냅샷 창에서 KPI ⑤ owned 판정 == 인용 타일 분자 판정
   == owned 배지 == 당사 인용 프롬프트 버킷.
4. 프로젝트는 설정 owned bases → project.domain → brand×country 카탈로그 폴백 사슬
   (KPI ⑤와 동일)이 적용된다.
5. `npm test` · `npm run build` · `npm run lint` · `npm run check:strings` 통과.
