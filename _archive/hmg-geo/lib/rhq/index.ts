// RHQ (운영 권역) 정본 — brand × country → 권역.
//
// 지리(대륙) 카탈로그(lib/geo-catalog)와 다른 축이다: RHQ는 브랜드 의존이라 같은 국가가
// 브랜드마다 다른 권역(또는 단독 권역)에 속할 수 있고, 카탈로그로는 도출되지 않는다.
// 손박은 임시 권역 테이블(lib/scope/dimensions.ts)을 대체하는 단일 진실(정본)이다.
//
// 데이터: _data/rhq-map.json. brand → 권역{id, labels:{ko,en}, countries:[ISO alpha-2]}.
//   - id     = 안정 키(스코프 저장 / i18n / 코드 참조). 브랜드 프리픽스로 전역 유일.
//   - labels = 표시용(ko/en) — JSX 하드코딩 회피(check:strings 통과).
//   - country= 풀 ISO 직접 보유(카탈로그 보유국의 상위집합일 수 있음).
// Hyundai = worldwide 페이지 6권역. Kia/Genesis는 소스 수신 후 JSON 확장(코드 변경 0).

import rawMap from "./_data/rhq-map.json";

export type RhqLocale = "ko" | "en";

export interface RhqRegion {
  /** 안정 권역 키(예: "hyundai-asia-pacific"). 스코프 저장값. */
  id: string;
  labels: Record<RhqLocale, string>;
  /** ISO alpha-2 국가코드. */
  countries: string[];
}

interface BrandRhq {
  source?: string;
  regions: RhqRegion[];
}

const MAP = rawMap as unknown as Record<string, BrandRhq>;

// brand → (ISO → regionId), 그리고 id → 권역 (1회 구축).
const BY_BRAND_CODE = new Map<string, Map<string, string>>();
const REGION_BY_ID = new Map<string, RhqRegion>();
for (const [brand, b] of Object.entries(MAP)) {
  const codeToId = new Map<string, string>();
  for (const r of b.regions) {
    REGION_BY_ID.set(r.id, r);
    for (const c of r.countries) codeToId.set(c, r.id);
  }
  BY_BRAND_CODE.set(brand, codeToId);
}

/** RHQ 정본을 보유한 브랜드 목록(소스 수신 순). */
export const RHQ_BRANDS = Object.keys(MAP);

/** 브랜드의 권역 목록(정의 순). 미보유 브랜드 → []. */
export function rhqRegionsForBrand(brand: string): RhqRegion[] {
  return MAP[brand]?.regions ?? [];
}

/** 그 브랜드에서 ISO 국가가 속한 권역 id, 없으면 null. */
export function rhqForCountry(brand: string, iso: string): string | null {
  return BY_BRAND_CODE.get(brand)?.get(iso.toUpperCase()) ?? null;
}

/** 브랜드의 권역 id 목록(라벨/국가 제외). */
export function rhqRegionIdsForBrand(brand: string): string[] {
  return rhqRegionsForBrand(brand).map((r) => r.id);
}

/** 모든 브랜드의 권역 id(평탄) — 스코프 검증의 유효 권역 universe. */
export const ALL_RHQ_REGION_IDS = [...REGION_BY_ID.keys()];

/** 모든 브랜드에 걸친 distinct ISO 국가 — 스코프 검증의 유효 국가 universe. */
export const ALL_RHQ_COUNTRIES = [
  ...new Set(Object.values(MAP).flatMap((b) => b.regions.flatMap((r) => r.countries))),
];

/** 권역 id의 ISO 국가 목록(없으면 []). */
export function countriesForRhq(regionId: string): string[] {
  return REGION_BY_ID.get(regionId)?.countries ?? [];
}

/**
 * 스코프 → 허용 ISO 국가 집합(가장 구체적인 축 우선):
 *   - scope.all/무제한 → undefined (제한 없음)
 *   - scope.countries가 있으면 그것만 (country 계정 = 자국)
 *   - countries가 비어있으면 scope.regions(RHQ 권역 id)를 countriesForRhq로 펼침
 *     (region 계정 = countries=null, regions만)
 *   - 둘 다 비면 undefined
 *
 * 데이터 읽기 필터(standard-filters::allowedScopeCountries)와 필터 드롭다운
 * 옵션 목록(scope-aggregates::listMeasuredRegions)이 이 함수를 **공유**해,
 * "데이터는 스코프대로 좁혀지는데 옵션에는 권한 밖 권역이 뜨는" 드리프트를 막는다.
 */
export function effectiveScopeCountries(scope?: {
  all?: boolean;
  countries?: string[];
  regions?: string[];
}): string[] | undefined {
  if (!scope || scope.all) return undefined;
  if (scope.countries?.length) return [...scope.countries];
  const set = new Set<string>();
  for (const rid of scope.regions ?? []) {
    for (const c of countriesForRhq(rid)) set.add(c);
  }
  return set.size ? [...set] : undefined;
}

/** 유효한 권역 id 인지(스코프 값 검증용). */
export function isRhqRegionId(id: string): boolean {
  return REGION_BY_ID.has(id);
}

/** 권역 id의 표시 라벨(locale), 없으면 null. */
export function rhqLabel(regionId: string, locale: RhqLocale = "ko"): string | null {
  const r = REGION_BY_ID.get(regionId);
  return r ? (r.labels[locale] ?? r.labels.ko) : null;
}
