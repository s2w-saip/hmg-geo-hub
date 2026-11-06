// 웹사이트 지역 축의 **브랜드 가상 코드** — 국가가 아니라 브랜드 하나를 지역
// 드롭다운의 "글로벌·허브" 그룹에 한 항목으로 노출한다.
//
// 배경(2026-09-06 제품 결정): `website_sites.brand='Hyundai N'` 사이트 2행
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

// ─── 전용 사이트 계정 (2026-09-29 제품 책임자: "CPO·Hyundai N·WW 는 각각에 맞는 필터만") ───
//
// 계정 `countries` 한 배열이 두 표면을 동시에 좁힌다 — 웹사이트는
// `website_sites.country_code`, 글로벌은 `scope_answers.region`(ISO). 그래서 08-20
// 발급 때 특수 사이트 계정은 가상코드와 ISO 를 함께 넣었고(N = worldwide·KR,
// CPO = CPO·US), 그 ISO 가 웹사이트 쪽에서 **본사 사이트까지** 열었다(N 계정 국가
// 필터 = 월드와이드·대한민국 = 현대 본사 사이트, N 사이트는 브랜드가 달라 0건).
// WW 계정은 국가 무제한이라 웹사이트 국가 필터에 브랜드 전 국가가 떴다.
//
// 아래 코드는 **독립 사이트 하나**를 가리킨다(권역 허브 EU·MIDDLEEAST 나 합작
// CN-BJ 처럼 ISO 국가 사이트와 함께 보는 코드가 아니다). 계정 `countries` 에 하나라도
// 있으면(= 전용 사이트 계정):
//   - 웹사이트 표면: 그 코드들**만** 본다(같은 배열의 ISO 는 글로벌 전용).
//   - 글로벌 표면: 같은 배열의 ISO + 그 사이트의 글로벌 시장(WEBSITE_SITE_GLOBAL_MARKETS)
//     만 본다. 권역·브랜드 전체로 **넓히지 않는다**. 둘 다 비면 글로벌 탭 자체를 숨긴다
//     (hasGlobalSurface → lib/auth/session 의 menuGroups).
// 제품 책임자 사양표(2026-09-29): WW 3사·CPO = 글로벌 숨김 · 웹사이트 자기 사이트만,
// 현대 N = 글로벌 미국-영어·한국-한국어 · 웹사이트 현대 N 만. 계정 설정은 어드민에서
// 브랜드 + 국가(월드와이드 / 현대CPO / 현대N) 하나로 끝난다.
// 권역 허브 계정(MIDDLEEAST + 중동 ISO 등)은 이 목록 밖이라 종전 동작 그대로다.
export const WEBSITE_DEDICATED_SITE_CODES: readonly string[] = [
  "worldwide",
  "CPO",
  ...Object.keys(WEBSITE_BRAND_GEO_CODES),
];

const DEDICATED = new Set(WEBSITE_DEDICATED_SITE_CODES);

export function isWebsiteDedicatedSiteCode(code: string): boolean {
  return DEDICATED.has(code);
}

/** 계정 countries 중 전용 사이트 코드만. 없으면 빈 배열. */
export function websiteDedicatedCodes(countries: readonly string[] | null | undefined): string[] {
  return (countries ?? []).filter(isWebsiteDedicatedSiteCode);
}

/** 계정 countries 에서 전용 사이트 코드를 뺀 나머지. */
export function withoutWebsiteDedicatedCodes(
  countries: readonly string[] | null | undefined,
): string[] {
  return (countries ?? []).filter((c) => !isWebsiteDedicatedSiteCode(c));
}

/**
 * 전용 사이트 → 글로벌 탭에서 보는 시장(ISO). 없는 코드(worldwide·CPO)는 글로벌 없음.
 * 현대 N: 미국-영어·한국-한국어(제품 책임자 사양표). 현대 글로벌 카탈로그는 US=EN·KR=KO 만
 * 측정하므로(2026-09-29 실측, 최근 21일 각 292 프롬프트) 국가만 좁히면 언어 쌍이 맞다.
 */
export const WEBSITE_SITE_GLOBAL_MARKETS: Readonly<Record<string, readonly string[]>> = {
  "HYUNDAI-N": ["US", "KR"],
};

/**
 * 전용 사이트 계정의 글로벌 국가(ISO). 전용 사이트 계정이 아니면 null(종전 규칙).
 * 빈 배열 = 글로벌에서 볼 시장이 없다(→ 글로벌 탭 숨김, 데이터는 fail-closed).
 */
export function siteAccountGlobalCountries(
  countries: readonly string[] | null | undefined,
): string[] | null {
  const dedicated = websiteDedicatedCodes(countries);
  if (!dedicated.length) return null;
  const out = withoutWebsiteDedicatedCodes(countries);
  for (const code of dedicated) {
    for (const c of WEBSITE_SITE_GLOBAL_MARKETS[code] ?? []) if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** 글로벌 탭을 볼 시장이 있는가. 전용 사이트 계정 중 WW·CPO 처럼 시장이 없으면 false. */
export function hasGlobalSurface(scope: { all: boolean; countries?: string[] }): boolean {
  if (scope.all) return true;
  const global = siteAccountGlobalCountries(scope.countries);
  return global === null || global.length > 0;
}

/**
 * 어드민 계정관리에서 브랜드별로 고를 수 있는 전용 사이트 코드. 권역 없이 고른다
 * (WW·N 은 권역 계정이 아니다). 라벨은 dashboard.filters.value.<code>.
 */
export const WEBSITE_DEDICATED_CODES_BY_BRAND: Readonly<Record<string, readonly string[]>> = {
  Hyundai: ["worldwide", "CPO", "HYUNDAI-N"],
  Kia: ["worldwide"],
  Genesis: ["worldwide"],
};

/**
 * 브랜드 가상 코드의 사이트 브랜드 → 모 브랜드. 계정 brands 는 3사 어휘(Hyundai)라
 * `website_sites.brand='Hyundai N'` 을 그대로 거르면 N 계정이 N 사이트를 못 본다 —
 * 계정 countries 에 HYUNDAI-N 이 있고 brands 에 모 브랜드가 있을 때만 사이트 브랜드를
 * 허용 목록에 더한다(websiteScopeBrands).
 */
export const WEBSITE_SITE_BRAND_PARENT: Readonly<Record<string, string>> = {
  "Hyundai N": "Hyundai",
};

/**
 * 웹사이트 표면의 계정 브랜드 허용 목록 — 계정 brands + 전용 브랜드 코드가 여는 사이트
 * 브랜드. brands 가 비면(브랜드 제한 없음) 빈 배열 그대로 돌려준다 — 여기서 값을 채우면
 * 제한이 없던 계정에 브랜드 제한이 **생긴다**.
 */
export function websiteScopeBrands(
  brands: readonly string[] | null | undefined,
  countries: readonly string[] | null | undefined,
): string[] {
  const out = [...(brands ?? [])];
  if (!out.length) return out;
  for (const code of countries ?? []) {
    const siteBrand = WEBSITE_BRAND_GEO_CODES[code];
    if (!siteBrand || out.includes(siteBrand)) continue;
    const parent = WEBSITE_SITE_BRAND_PARENT[siteBrand];
    if (parent && out.includes(parent)) out.push(siteBrand);
  }
  return out;
}

/**
 * 필터 패널이 표면별로 보는 계정 스코프(스코프 칩·국가 축 잠금). 권한 판정이 아니라
 * **표시용**이다 — 데이터 게이트는 서버 경로(website-sites·rhq)가 같은 규칙으로 따로 건다.
 *   - website:  전용 사이트 코드가 있으면 countries = 그 코드들만
 *   - standard: 전용 사이트 계정이면 countries = 글로벌 시장(N = US·KR). 시장이 없는
 *               계정(WW·CPO)은 글로벌 탭이 숨겨져 여기 오지 않는다.
 */
export function scopeForGeoSurface<
  S extends { all: boolean; countries?: string[] },
>(scope: S, surface: "website" | "standard"): S {
  if (scope.all || !scope.countries?.length) return scope;
  if (surface === "website") {
    const dedicated = websiteDedicatedCodes(scope.countries);
    return dedicated.length ? { ...scope, countries: dedicated } : scope;
  }
  const global = siteAccountGlobalCountries(scope.countries);
  return global?.length ? { ...scope, countries: global } : scope;
}
