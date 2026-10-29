// 웹사이트 지역 축의 **브랜드 가상 코드** — 국가가 아니라 브랜드 하나를 지역
// 드롭다운의 "글로벌·허브" 그룹에 한 항목으로 노출한다.
//
// 배경(2026-09-06 운영 결정): `website_sites.brand='Hyundai N'` 사이트 2행
// (country_code = KR · worldwide)은 브랜드 드롭다운(3사 고정)에 없고, 지역 축에서는
// 현대 worldwide/KR 사이트와 같은 코드라 섞여서만 보인다. 브랜드 축에 추가하는
// 대안은 기각 — 지역 필터의 글로벌·허브 자리에 "현대 N" 을 넣는다.
//
// 구현은 **코드 전용·가산적**이다. `website_sites.country_code` 를 바꾸지 않는다
// (계정 17 = Hyundai N brand 의 countries=worldwide·KR 가시성, 미러 region, 요약
// 사실표의 country verbatim 이 그 값에 묶여 있다). 대신 `filters.websiteCountry` 에
// 이 가상 코드가 오면 술어를 `ws.country_code IN (…)` 에 `ws.brand IN (…)` 을
// OR 로 덧붙여 해석한다. 같은 데이터가 worldwide/KR 선택에도 계속 잡히는 것은
// 종전 동작 그대로다(격리 뷰가 추가된 것이지 기존 뷰가 바뀐 것이 아니다).
//
// 술어를 두는 곳은 전부 `splitWebsiteGeo` 를 거친다 — scope-aggregates 의
// promptAxisPreds · readWebsiteCountryPromptIds · websiteOwnedBases · 타겟 셋,
// summary-website-aggregates 의 answerWhere · websiteTargetKeys. 새 술어를
// 추가할 때 `ws.country_code IN` 을 직접 쓰면 이 코드가 그 경로에서만 조용히
// 0건이 된다(2026-08-25 언어축 누락 사고와 같은 형태).

/** 가상 코드 → website_sites.brand. 코드는 ISO/기존 가상 코드와 겹치지 않게 대문자. */
export const WEBSITE_BRAND_GEO_CODES: Readonly<Record<string, string>> = {
  "HYUNDAI-N": "Hyundai N",
};

export function isWebsiteBrandGeoCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(WEBSITE_BRAND_GEO_CODES, code);
}

/** 지역 축 값을 실 코드(country_code)와 브랜드(website_sites.brand)로 가른다. */
export function splitWebsiteGeo(codes: readonly string[]): {
  countries: string[];
  brands: string[];
} {
  const countries: string[] = [];
  const brands: string[] = [];
  for (const c of codes) {
    const brand = WEBSITE_BRAND_GEO_CODES[c];
    if (brand) {
      if (!brands.includes(brand)) brands.push(brand);
    } else {
      countries.push(c);
    }
  }
  return { countries, brands };
}

/**
 * 옵션 매트릭스(brand × region × lang) 에 가상 브랜드 코드 행을 덧붙인다 — 패널은
 * 매트릭스가 오면 `listWebsiteCountries` 가 아니라 이것으로 국가 목록을 만든다
 * (dimension-filter-panel::deriveMatrixOptions). 2026-09-06 프로덕션 실측: 서버
 * geographyOptions 엔 HYUNDAI-N 이 있는데(74) 드롭다운엔 73개만 떠 원인이 이것이었다.
 * 그 브랜드의 각 (region, lang) 행마다 region 을 가상 코드로 바꾼 행을 추가한다
 * (원행은 유지 — worldwide/KR 선택은 종전대로).
 */
export function withWebsiteBrandGeoCombos<
  R extends { brand: string | null; region: string; lang: string | null },
>(rows: readonly R[]): R[] {
  const extra: R[] = [];
  const seen = new Set<string>();
  for (const [code, brand] of Object.entries(WEBSITE_BRAND_GEO_CODES)) {
    for (const r of rows) {
      if (r.brand !== brand) continue;
      const key = `${code}|${r.lang ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      extra.push({ ...r, region: code });
    }
  }
  return [...rows, ...extra];
}

/** 스코프에 든 사이트 브랜드 목록 → 드롭다운에 덧붙일 가상 코드. */
export function websiteBrandGeoCodesFor(brands: Iterable<string>): string[] {
  const set = new Set(brands);
  return Object.entries(WEBSITE_BRAND_GEO_CODES)
    .filter(([, brand]) => set.has(brand))
    .map(([code]) => code);
}
