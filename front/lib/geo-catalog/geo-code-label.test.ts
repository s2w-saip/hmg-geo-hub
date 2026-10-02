import { describe, expect, it } from "vitest";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";
import { ALL_RHQ_COUNTRIES } from "@/lib/rhq";
import { PSEUDO_COUNTRIES, pseudoCountryLabel } from "./pseudo-country";
import { VIRTUAL_GEO_CODES, geoCodeLabel } from "./geo-code-label";

const MESSAGES = { ko, en } as const;
const virtualLabel = (locale: "ko" | "en") => (code: string) =>
  (MESSAGES[locale].dashboard.filters.value as Record<string, string>)[code] ?? code;

// 2026-09-29 이전 필터 패널 valueLabel(geography) 의 본문을 그대로 옮긴 기준 구현 —
// 공용 헬퍼로 바꿔도 패널 라벨이 한 글자도 바뀌지 않는지 대조한다.
function legacyPanelLabel(v: string, locale: "ko" | "en"): string {
  if (VIRTUAL_GEO_CODES.has(v)) return virtualLabel(locale)(v);
  const pseudo = pseudoCountryLabel(v, locale);
  if (pseudo) return pseudo;
  const regionFmt = new Intl.DisplayNames([locale], { type: "region" });
  try {
    return regionFmt.of(v) ?? v;
  } catch {
    return v;
  }
}

// 운영 website_sites.country_code 의 비 ISO 값(2026-09-29 조회) + 계정 전용 코드 + 표본 이상치.
const SITE_AND_ACCOUNT_CODES = [
  "worldwide",
  "EU",
  "MIDDLEEAST",
  "CPO",
  "CN-BJ",
  "HYUNDAI-N",
  ...Object.keys(PSEUDO_COUNTRIES),
];
const ODD_INPUTS = ["", "us", "XX", "ZZZ", "123", "KR-11"];

describe("geoCodeLabel — account-scope codes never throw", () => {
  it.each([
    ["CPO", "ko", "현대 CPO"], // 2026-09-29 라벨 추가(종전 원문 CPO)
    ["CN-BJ", "ko", "중국-베이징"],
    ["worldwide", "ko", "월드와이드(글로벌)"],
    ["MIDDLEEAST", "en", "Middle East Hub (MENA)"],
    ["EU", "ko", "유럽 허브(EU)"],
    ["HYUNDAI-N", "en", "Hyundai N"],
    ["SA-Riyadh", "ko", "사우디 아라비아 - 리야드"],
    ["US", "ko", "미국"],
  ] as const)("%s (%s) → %s", (code, locale, expected) => {
    expect(geoCodeLabel(code, locale, virtualLabel(locale))).toBe(expected);
  });
});

describe("geoCodeLabel — identical to the filter panel's previous rule", () => {
  for (const locale of ["ko", "en"] as const) {
    it(`${locale}: every RHQ ISO + site/account code + odd input labels the same`, () => {
      const codes = [...ALL_RHQ_COUNTRIES, ...SITE_AND_ACCOUNT_CODES, ...ODD_INPUTS];
      const diffs = codes
        .map((c) => [c, legacyPanelLabel(c, locale), geoCodeLabel(c, locale, virtualLabel(locale))])
        .filter(([, a, b]) => a !== b);
      expect(diffs).toEqual([]);
    });
  }
});
