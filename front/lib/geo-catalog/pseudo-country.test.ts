import { describe, expect, it } from "vitest";
import {
  isPseudoCountry,
  pseudoCountryLabel,
  pseudoCountryParent,
  withPseudoCountries,
} from "./pseudo-country";
import { countryName } from "./country-name";

describe("pseudo-country", () => {
  it("labels Genesis Saudi city sites and Beijing Hyundai in ko/en", () => {
    expect(pseudoCountryLabel("SA-Dammam", "ko")).toBe("사우디 아라비아 - 담맘");
    expect(pseudoCountryLabel("SA-Jeddah", "en")).toBe("Saudi Arabia - Jeddah");
    expect(pseudoCountryLabel("CN-BJ", "ko")).toBe("중국-베이징");
    expect(pseudoCountryLabel("CN-BJ", "en")).toBe("China-Beijing");
    expect(pseudoCountryLabel("SA", "ko")).toBeNull();
    expect(isPseudoCountry("worldwide")).toBe(false);
  });

  it("countryName prefers the registry over Intl (which would echo the raw code)", () => {
    expect(countryName("CN-BJ", "ko")).toBe("중국-베이징");
    expect(countryName("SA-Riyadh", "en")).toBe("Saudi Arabia - Riyadh");
    expect(countryName("KR", "en")).toBe("South Korea");
  });

  it("maps a pseudo code to its ISO parent for RHQ grouping", () => {
    expect(pseudoCountryParent("SA-Dammam")).toBe("SA");
    expect(pseudoCountryParent("CN-BJ")).toBe("CN");
    expect(pseudoCountryParent("DE")).toBe("DE");
  });

  it("withPseudoCountries adds Saudi cities under SA but never CN-BJ under CN", () => {
    expect(withPseudoCountries(["AE", "SA"])).toEqual([
      "AE", "SA", "SA-Dammam", "SA-Jeddah", "SA-Riyadh",
    ]);
    expect(withPseudoCountries(["CN"])).toEqual(["CN"]);
    expect(withPseudoCountries(["SA-Dammam", "SA"])).toEqual([
      "SA-Dammam", "SA", "SA-Jeddah", "SA-Riyadh",
    ]);
    expect(withPseudoCountries([])).toEqual([]);
  });
});

// 권역 토글·권역 nav 는 국가 코드를 rhqForCountry 에 넣기 전에 모국으로 바꿔야 한다 —
// 안 바꾸면 도시 사이트가 어느 권역에도 안 속해 "권역 중동 → 사우디 없음"이 된다.
import { rhqForCountry } from "@/lib/rhq";
describe("pseudo-country × RHQ", () => {
  it("Genesis Saudi city codes resolve to the Middle East region via their parent", () => {
    expect(rhqForCountry("Genesis", "SA-Dammam")).toBeNull();
    expect(rhqForCountry("Genesis", pseudoCountryParent("SA-Dammam"))).toBe("genesis-middle-east");
    expect(rhqForCountry("Genesis", pseudoCountryParent("SA-Riyadh"))).toBe("genesis-middle-east");
  });
});
