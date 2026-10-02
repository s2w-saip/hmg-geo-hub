// 지역 축 코드(국가 ISO · 가상 허브 코드 · 의사 국가 코드) → 표시 라벨의 정본.
//
// 필터 패널(dimension-filter-panel::valueLabel)과 계정 스코프 칩(account-scope-chips)이
// 같은 규칙을 쓰도록 여기 한 곳에 둔다. 2026-09-29 운영 사고: 칩만 계정 원본 코드를
// 가드 없이 `Intl.DisplayNames.of` 에 넘겨, hyundai-cpo([CPO, US])·hyundai-cn-bj
// ([CN-BJ, CN]) 계정에서 `RangeError: invalid_argument` 로 페이지 전체가 에러 경계에
// 떨어졌다(패널은 같은 코드를 안전하게 라벨링하고 있었다 — 규칙이 두 벌이었던 것이 원인).
//
// 규칙(순서가 곧 우선순위):
//   1. 가상 코드(worldwide·EU·MIDDLEEAST·HYUNDAI-N 등) → i18n `dashboard.filters.value.*`
//      (EU 는 Intl 도 "유럽연합"으로 풀지만 여기서는 허브 라벨이 이긴다)
//   2. 의사 국가 코드(SA-Dammam·CN-BJ …) → pseudo-country 정본 라벨
//   3. 그 외 → Intl.DisplayNames, 모르는/비표준 코드(CPO 등)는 원문 — **절대 throw 안 함**
//
// 3 을 country-name::countryName 에 위임하지 않는 이유: countryName 은 입력을
// trim·대문자로 정규화한다(`us` → 미국). 필터 패널은 정규화 없이 원문을 넘겨 왔고
// (`?geography=us` → "us" — 대소문자 구분 IN 이라 데이터도 0건이므로 원문이 정직하다),
// 이 헬퍼로 옮기면서 패널 라벨이 한 글자도 바뀌지 않아야 한다(geo-code-label.test.ts 가
// RHQ ISO 185개 + 사이트·계정 코드 + 이상 입력으로 대조). 둘 다 throw 하지 않는다.

import { WEBSITE_BRAND_GEO_CODES } from "@/lib/scope/website-virtual-geo";
import { pseudoCountryLabel } from "./pseudo-country";

const regionFormatters = new Map<string, Intl.DisplayNames>();
function regionFormatter(locale: string): Intl.DisplayNames {
  let f = regionFormatters.get(locale);
  if (!f) {
    f = new Intl.DisplayNames([locale], { type: "region" });
    regionFormatters.set(locale, f);
  }
  return f;
}

// website_sites.country_code의 가상 권역 코드 — 국가(ISO)가 아닌 논리 그룹.
// geography 드롭다운에서 어느 권역에도 속하지 않아 헤더 없는 그룹으로 목록
// 맨끝에 밀리던 것을, 전용 라벨(value.*)+그룹 헤더(group.globalHub)+최상단
// 고정으로 노출한다. 새 가상 코드 추가 시 messages의 value.* 라벨도 함께.
// 브랜드 가상 코드(HYUNDAI-N — 현대 N 사이트 2행을 한 항목으로, 2026-09-06 제품 책임자
// 결정)도 같은 그룹에 둔다. 해석 규칙은 lib/scope/website-virtual-geo.
export const VIRTUAL_GEO_CODES: ReadonlySet<string> = new Set([
  "worldwide",
  "EU",
  "MIDDLEEAST",
  // 현대 인증중고차 사이트 — ISO 가 아니라 Intl 이 못 푼다(2026-09-29 라벨 "현대 CPO").
  "CPO",
  ...Object.keys(WEBSITE_BRAND_GEO_CODES),
]);

/**
 * 지역 축 코드의 표시 라벨. `virtualLabel` 은 호출자의 i18n 조회
 * (`t(\`value.${code}\`)` — dashboard.filters 네임스페이스)다.
 */
export function geoCodeLabel(
  code: string,
  locale: string,
  virtualLabel: (code: string) => string,
): string {
  if (VIRTUAL_GEO_CODES.has(code)) return virtualLabel(code);
  const pseudo = pseudoCountryLabel(code, locale);
  if (pseudo) return pseudo;
  try {
    return regionFormatter(locale).of(code) ?? code;
  } catch {
    // CPO·3글자 코드 등 비표준 region subtag — 렌더에서 절대 throw 하지 않고 원문.
    return code;
  }
}
