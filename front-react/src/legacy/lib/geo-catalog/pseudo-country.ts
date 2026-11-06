// 의사(pseudo) 국가코드 정본 — ISO 3166-1 alpha-2 가 아닌데 `website_sites.country_code`
// 와 계정 스코프(`profiles.countries`)에 국가처럼 저장되는 값들.
//
// 왜 필요한가 — website 표면의 측정 단위는 "사이트"인데 사이트가 국가보다 잘게
// 갈리는 곳이 있다. 베이징현대(beijing-hyundai.com.cn)는 현대 중국(hyundai.com.cn)과
// 별개 사이트라 `CN-BJ` 로 분리돼 있었고, 제네시스 사우디는 담맘·제다·리야드 도시별
// 사이트(genesis.com/sa-{dammam,jeddah,riyadh})를 따로 측정하는데 2026-07-27 시드가
// 셋을 `SA` 한 행으로 합쳐 필터에서 도시를 고를 수 없었다(2026-09-05 제품 책임자 제보 —
// 계정은 genesis-sa-{dammam,jeddah,riyadh} 셋인데 전부 같은 데이터를 봤다).
//
// 이 파일이 답하는 질문 세 가지:
//   1. 표시 — `Intl.DisplayNames` 는 이 코드를 모른다(예외 → 원문 코드 노출).
//      ko/en 라벨을 여기서 준다(`countryName`·필터 패널 `valueLabel` 이 먼저 조회).
//   2. 권역 — RHQ 맵은 ISO 만 안다. 필터 드롭다운 그룹 헤더는 `parent` 로 찾는다.
//   3. 스코프 — `scopeParent` 가 있으면 그 나라를 허용하는 스코프가 이 코드도 본다
//      (사우디 권역·국가 계정 → 도시 3곳). CN-BJ 는 의도적으로 **없다**: 베이징현대는
//      합작사 별도 사이트라 현대 중국(CN) 계정이 자동으로 보면 안 되고, 전용 계정이
//      `countries=['CN-BJ','CN']` 로 명시 보유한다(2026-08 계정 발급 결정 유지).
//
// `worldwide`·`EU`·`MIDDLEEAST` 같은 **가상 권역 코드**는 여기 두지 않는다 — 그건
// 국가의 하위가 아니라 상위(허브)라 필터 패널이 별도 규칙(VIRTUAL_GEO_CODES)으로 다룬다.

export interface PseudoCountry {
  /** 표시·권역 판정에 쓰는 ISO 모국. */
  parent: string;
  /** 이 나라를 허용하는 스코프가 이 코드도 허용하는가(도시 = 나라의 부분집합일 때만). */
  scopeParent?: string;
  labels: { ko: string; en: string };
}

export const PSEUDO_COUNTRIES: Readonly<Record<string, PseudoCountry>> = {
  "SA-Dammam": {
    parent: "SA",
    scopeParent: "SA",
    labels: { ko: "사우디 아라비아 - 담맘", en: "Saudi Arabia - Dammam" },
  },
  "SA-Jeddah": {
    parent: "SA",
    scopeParent: "SA",
    labels: { ko: "사우디 아라비아 - 제다", en: "Saudi Arabia - Jeddah" },
  },
  "SA-Riyadh": {
    parent: "SA",
    scopeParent: "SA",
    labels: { ko: "사우디 아라비아 - 리야드", en: "Saudi Arabia - Riyadh" },
  },
  "CN-BJ": {
    parent: "CN",
    labels: { ko: "중국-베이징", en: "China-Beijing" },
  },
};

export function isPseudoCountry(code: string | null | undefined): code is string {
  return !!code && Object.prototype.hasOwnProperty.call(PSEUDO_COUNTRIES, code);
}

/** ko/en 라벨. 모르는 코드면 null — 호출자가 Intl 로 폴백한다. */
export function pseudoCountryLabel(code: string | null | undefined, locale: string): string | null {
  if (!isPseudoCountry(code)) return null;
  const l = PSEUDO_COUNTRIES[code].labels;
  return locale.toLowerCase().startsWith("ko") ? l.ko : l.en;
}

/** 권역 판정용 ISO 모국. 의사 코드가 아니면 입력 그대로. */
export function pseudoCountryParent(code: string): string {
  return isPseudoCountry(code) ? PSEUDO_COUNTRIES[code].parent : code;
}

/**
 * 허용 국가 목록에 딸린 의사 코드를 덧붙인다 — `scopeParent` 가 목록에 있는 것만.
 * 입력 순서를 보존하고 이미 있는 코드는 중복 추가하지 않는다.
 */
export function withPseudoCountries(countries: readonly string[]): string[] {
  const out = [...countries];
  const seen = new Set(countries);
  for (const [code, def] of Object.entries(PSEUDO_COUNTRIES)) {
    if (def.scopeParent && seen.has(def.scopeParent) && !seen.has(code)) {
      out.push(code);
      seen.add(code);
    }
  }
  return out;
}
