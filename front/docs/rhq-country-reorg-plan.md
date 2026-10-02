# 브랜드별 RHQ–Country 정본 도입 + 임시 테이블 교체 기획

> **목적:** 손박은 임시 권역 테이블(`lib/scope/dimensions.ts`)을 제거하고, **브랜드별 RHQ 권역
> 분할표(신규 정본)**로 **완전 단일화**한다. 지리(대륙) region 축은 폐기하고 RHQ 하나로 통일.
> 정본 소스: Hyundai = [worldwide](https://www.hyundai.com/worldwide/ko/company/hyundai-world-wide),
> Kia = [global-websites](https://worldwide.kia.com/ko/kia-global-websites),
> Genesis = [change-your-region](https://www.genesis.com/worldwide/en/change-your-region.html).

## 진행 상황 (2026-06-25) — 코드 단계 완료, 검증 green
- ✅ **3-A** RHQ 정본 — `lib/rhq/_data/rhq-map.json`(3브랜드) + `lib/rhq/index.ts` + 테스트(7).
  권역 수: **Hyundai 6 · Kia 7(서/동유럽 분리) · Genesis 5(중남미 없음)**.
- ✅ **3-C** `scope-policy` RHQ brand-aware cutover + 테스트 RHQ 어휘 갱신.
- ✅ **3-D** 완전 단일화 — `live.ts buildGeo`(활성 brand RHQ 그룹핑, C5 게이트) · `geo-snapshot` ·
  `conversion-countries-table`(+activeBrand prop, `regionUnknown` i18n) · `dimension-filter-panel` ·
  `edit-user-dialog`(brand-reactive 권역 옵션, 결정 B). 라벨은 전부 `rhqLabel`.
- ✅ **3-B** `dimensions.ts` 임시값(REGIONS/COUNTRIES/COUNTRIES_BY_REGION/DIMENSION_OPTIONS) 삭제 →
  `FilterDimension` 타입만 잔존. `brand-select`는 `GEO_BRANDS`로.
- ✅ **3-F(코드)** `seed.ts` 권역값 RHQ id로 + C4(국가코드 in region) 정리. `mock.ts`의 `regions`는
  scope 계약상 **국가코드**(RHQ 아님) → 변경 없음. 운영 백필: `scripts/db/migrate-rhq-regions.ts`(dry-run/`--apply`).
- ✅ **3-E** 그림자 복사본 검토 — `push-standard-split.ts`(scope 국가코드)·`google-keyword-view`(키워드 API
  시장 목록) 둘 다 RHQ 축 아님 → 유지.

검증: `tsc` clean · `lint` 신규 에러 0 · `check:strings` OK · `npm test` **296 passed**.

### 남은 운영 작업(코드 외)
- 🗄 DB 반영: dev 재시드(`seed.ts`) + 운영 `migrate-rhq-regions.ts --apply`(DB 크리덴셜 필요, dry-run 먼저).
- 👁 시각 확인: `/ko/dashboard` GEO 스냅샷 + `/ko/standard/ai-funnel` 권역 섹션이 RHQ로 렌더되는지(app 구동).

---

## 0. 핵심 모델 — RHQ는 (brand, country) → 권역

**RHQ(운영 권역)은 지리(대륙)와 다른 축이며 브랜드 의존이다.** 같은 국가가 브랜드마다 다른 권역에
속할 수 있다 — 예: **AU(호주)** 가 Hyundai에선 `아시아 & 태평양` 산하, 다른 브랜드에선 `Australia`
단독 권역이 될 수 있음.

| | 지리 region (구) | **RHQ 권역 (정본)** |
|---|---|---|
| 성격 | 대륙 그룹(지도) | 운영/조직 권역 |
| 브랜드 의존 | 불변 | **의존** |
| AU 귀속 | 항상 Oceania | **브랜드마다 다름** |
| 1국 단독 권역 | 불가 | **가능** |
| 도출 | 카탈로그 | **카탈로그로 불가 → 신규 정본** |

- 정본 단위 = **brand → 권역(label) → [ISO country]** 의 3단 분할. 한 권역은 1개 이상 국가 보유,
  같은 국가가 브랜드별로 다른 권역. 권역 라벨도 브랜드가 정의.
- **완전 단일화**: 지리 대륙 region을 노출 축에서 제거하고, 모든 region 소비처(스코프·필터·스냅샷·
  롤업)를 RHQ로 전환. `geoLocateByCode`(brand-blind) 사용처도 RHQ로 교체.

---

## 1. 정본 데이터 — 신규 RHQ 맵

카탈로그는 RHQ를 못 만들고, worldwide 페이지(~200 시장)는 **카탈로그 보유국의 상위집합**이라
카탈로그 ISO 맵으로도 안 풀린다(NZ·Vietnam·Argentina 등 ~50국 미존재). → **RHQ 맵은 자체 ISO를
직접 보유**한다.

```
lib/rhq/_data/rhq-map.json   (신규 정본)
{
  "Hyundai": {
    "regions": [
      { "id": "hyundai-europe",  "labels": {"ko":"유럽","en":"Europe"},          "countries": ["AL","AT","DE", ...] },
      { "id": "hyundai-aspc",    "labels": {"ko":"아시아 & 태평양","en":"Asia & Pacific"}, "countries": ["AU","JP","KR", ...] },
      { "id": "hyundai-latam",   "labels": {"ko":"중남미","en":"Latin America"},  "countries": ["AR","BR", ...] },
      { "id": "hyundai-africa",  ... }, { "id": "hyundai-me", ... }, { "id": "hyundai-na", ... }
    ]
  },
  "Kia":     { "regions": [ ... ] },   // 후속 — 소스 전달 후
  "Genesis": { "regions": [ ... ] }    // 후속
}
```

- **권역 `id`** = 안정 키(코드·스코프 저장·i18n에 사용). **`labels`** = 표시용 ko/en (JSX 하드코딩
  회피, check:strings 통과). 권역이 브랜드별 임의 라벨("Australia 단독")이어도 수용.
- **country = ISO alpha-2** 직접 보유(카탈로그와 무관, 풀 ISO 기준).
- Hyundai 1차: worldwide 6권역 — 유럽/아시아 & 태평양/중남미/아프리카/중동/북아메리카.

### 신규 접근자 (`lib/rhq/index.ts`)
| 함수 | 반환 |
|---|---|
| `rhqRegionsForBrand(brand)` | 브랜드의 권역 목록 `{id,labels,countries}` |
| `rhqForCountry(brand, iso)` | 그 브랜드에서 국가가 속한 권역 id (또는 null) |
| `countriesForRhq(brand, regionId)` | ISO 목록 |
| `rhqLabel(regionId, locale)` | 표시 라벨 |

---

## 2. ⚠️ 충돌 레지스터

### C1. region 어휘 5중 충돌 → RHQ id로 통일
임시bucket(`EU`)·대륙(`Europe`)·ISO국가코드(`DE`, `scope_answers.region`/`mock`)·테스트약어(`APAC`)·
seed혼합. **전부 `regionId`(brand별)로 정규화.** 단 `scope_answers.region`(=ISO 국가코드)은 country
축이므로 RHQ와 분리 유지.

### C2. region 축은 현재 "데이터 필터"에서 inert → 교체 위험 낮음
`scopeWhere(region)` 호출 0건, `listMeasuredRegions`가 `scope.regions` 무시
([scope-aggregates.ts:731](lib/db/repositories/scope-aggregates.ts#L731)), `isInScope(region)`은 테스트만.
라이브 narrowing은 brand+country로만. → RHQ 전환의 **데이터 누수 없음**. (스냅샷 롤업은 표시 그룹핑이라 별개 — C5)

### C3. profiles.regions[] 레거시값 → 마이그레이션 필수
저장값 `EU`/`Europe`/`KR`이 RHQ `id`와 불일치 → `projectCreationOptions`·필터 잠금 깨짐. 백필 필요.

### C4. country role의 region에 국가코드 → country 축으로 이동
`mock`(`["KR","US"]`), `seed country@hmg.test`(`["KR"]`)는 region이 아님. 정규화.

### C5. 멀티브랜드 스냅샷의 권역 귀속 모호 (완전 단일화의 핵심 난점)
[live.ts buildGeo](app/[locale]/(dash)/dashboard/_data/live.ts#L144)는 한 국가코드에 **여러 브랜드(경쟁사
포함) mention**을 모아 brand-blind로 그룹핑한다. RHQ는 brand 의존이라 "AU가 어느 권역?"이 모호.
- **해결: 활성 브랜드 기준 권역 구조로 해석** — 현재 스코프/선택된 HMG 브랜드의 RHQ 분할로 모든
  국가를 버킷팅("내 브랜드 권역에서 전 브랜드 성과"). `buildGeo(comp, ourBrands, **activeBrand**)`로
  시그니처 확장, `geoLocateByCode`→`rhqForCountry(activeBrand, code)`.
- admin "전체 브랜드(미선택)" 뷰: 기본 분할(Hyundai) 또는 권역 뷰에서 브랜드 선택 강제 — **결정 §5**.

### C6. brand × region 결합 (flat 상수 금지)
`RHQ_REGIONS`(flat)·brand무관 `COUNTRIES_BY_REGION`·`DIMENSION_OPTIONS.region` 사용 시 Genesis에
없는 권역 노출 등 오류. 모든 접근자 **brand 인자화**. 대시보드 region 필터 옵션은 **선택/잠긴 brand 의존**.

### C7. ISO 커버리지 — RHQ는 카탈로그 상위집합
worldwide 시장이 카탈로그 미보유국 포함 → RHQ country는 **풀 ISO** 직접 보유. 카탈로그와의 조인은
ISO로만(국가명 매핑 금지). 카탈로그에 없는 RHQ 국가는 "측정 예정/데이터 없음"으로 표시.

### C8. 보안 불변식 보존
`scope-policy`/`scopeWhere`/`isInScope` 형태(default-deny·단일소스·시그니처) 불변, 값만 RHQ로.
전 단계 `npm test` green 전제.

---

## 3. 변경 목록 (파일별)

### 3-A. 정본 신설
| # | 파일 | 변경 |
|---|---|---|
| 1 | `lib/rhq/_data/rhq-map.json` **(신규)** | brand→권역→ISO 정본. Hyundai = worldwide 6권역(자체 ISO) |
| 2 | `lib/rhq/index.ts` **(신규)** | `rhqRegionsForBrand`/`rhqForCountry`/`countriesForRhq`/`rhqLabel` |
| 3 | `lib/rhq/build-hyundai.ts` 또는 스크립트 | worldwide 페이지 → JSON 생성/검증(재생성 경로 문서화) |

### 3-B. 임시 테이블 제거
| # | 파일 | 변경 |
|---|---|---|
| 4 | `lib/scope/dimensions.ts` | `REGIONS`/`COUNTRIES`/`COUNTRIES_BY_REGION`/`DIMENSION_OPTIONS` 삭제; `Region`/`Country` 삭제; `FilterDimension` 유지; `BRANDS`→`GEO_BRANDS` 재노출 |

### 3-C. 결합점 — scope-policy (brand-aware RHQ)
| # | 파일 | 변경 |
|---|---|---|
| 5 | `lib/auth/scope-policy.ts` | import→`lib/rhq`. `projectCreationOptions` 국가파생 = allowed brand × allowed regionId → `countriesForRhq`. `resolveDimensionState` region 옵션 = `rhqRegionsForBrand(brand)`. `Region` 가드→regionId |
| 6 | `lib/auth/scope-policy.test.ts` | region 기대값 `NA/APAC/EU/LATAM` → RHQ id로 갱신(**보안 테스트, 의식적**) |

### 3-D. 완전 단일화 — 스냅샷/롤업/UI를 RHQ로
| # | 파일 | 변경 |
|---|---|---|
| 7 | `dashboard/_data/live.ts` `buildGeo` | **활성 brand 인자 추가**, `geoLocateByCode`→`rhqForCountry(brand,code)`, `GEO_DISPLAY_REGIONS`→`rhqRegionsForBrand(brand)` (C5) |
| 8 | `dashboard/_components/geo-snapshot.tsx` | region 라벨을 `rhqLabel(id,locale)`로 (REGION_KEY 맵 제거) |
| 9 | `standard/ai-funnel/.../conversion-countries-table.tsx` | 동일 |
| 10 | `components/dash/dashboard-filters.tsx` | region 옵션이 **선택 brand 의존** — brand→region 반응형(또는 §5-A 정적) |
| 11 | `admin/.../edit-user-dialog.tsx` | `GEO_REGIONS`→`rhqRegionsForBrand(선택 brand)`; 저장값=regionId |
| 12 | `lib/geo-catalog/index.ts` | `geoLocateByCode`/`GEO_DISPLAY_REGIONS` 등 region 노출 접근자 RHQ로 이전 또는 deprecate(지리 필요 잔존부만 유지) |

### 3-E. 그림자 복사본
| # | 파일 | 변경 |
|---|---|---|
| 13 | `projects/[id]/intent/.../google-keyword-view.tsx:50` | `COUNTRIES=[...]` → 정본 파생 |
| 14 | `scripts/scope/push-standard-split.ts:26` | `REGIONS=[...]` → 정본/인자화 |

### 3-F. 데이터 마이그레이션 (C3/C4)
| # | 대상 | 변경 |
|---|---|---|
| 15 | `scripts/db/seed.ts` | `regions`를 regionId로(`["EU"]`→`["hyundai-europe"]` 등); 국가코드는 countries로 이동 |
| 16 | `lib/scope/mock.ts` | profiles.regions 국가코드 → countries 이동, region=regionId |
| 17 | 운영 profiles 백필 SQL | `regions[]` 레거시→regionId 일괄 변환 + 검증 카운트 |

---

## 4. 작업 순서 (conflict-safe)

1. **3-A** RHQ 정본 신설(Hyundai) + 단위테스트(`rhqForCountry("Hyundai","AU")==="hyundai-aspc"` 등). *additive.*
2. **3-D(부분)** i18n/라벨 — `rhqLabel` 경유 표시.
3. **3-C** scope-policy를 RHQ brand-aware로 + 테스트 동시 갱신(green).
4. **3-D** live.ts `buildGeo` 활성 brand RHQ 그룹핑 + 스냅샷/필터.
5. **3-B** dimensions.ts 임시값 삭제 + import 정리.
6. **3-F** 데이터 마이그레이션(배포와 동시/직후 — C3 차단 방지).
7. **3-E** 그림자 정리.
8. (후속) Kia/Genesis 소스 수신 → `rhq-map.json` 확장(코드 변경 0).

게이트: 각 단계 `npm test && build && lint && check:strings` green.

---

## 5. 결정 (확정)
1. **admin 전체-브랜드 권역 뷰(C5) → (B) 권역 뷰는 브랜드 선택 필수.** 권역이 brand 의존이라
   브랜드 미선택 시 권역 그룹핑은 의미 없음 → 권역 뷰 진입 전 브랜드 선택 강제.
2. **dashboard 필터 brand→region 연동 → (B) 클라 반응형.** brand 선택 변경 시 브라우저에서
   `rhqRegionsForBrand(선택 brand)`로 region 옵션 재계산(Genesis 선택→Latin America 자동 제거).
   필터 컴포넌트에 brand→권역 매핑 데이터를 함께 내려줌.

---

### 부록 — Hyundai worldwide 6권역 (1차 정본 baseline)
유럽 / 아시아 & 태평양 / 중남미 / 아프리카 / 중동 / 북아메리카.
worldwide 페이지 국가 리스트가 권역별 멤버십 기준선. ISO는 풀 ISO 기준으로 직접 부여
(카탈로그 미보유국 포함 — 측정 데이터는 없을 수 있으나 권역 정의에는 포함).
