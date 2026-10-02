import { describe, expect, it } from "vitest";
import { effectiveScopeCountries } from "./index";

// The shared "scope → allowed ISO countries" source of truth. Both the read
// filter (standard-filters::allowedScopeCountries) and the filter dropdown
// option list (scope-aggregates::listMeasuredRegions) go through this, so a
// region (RHQ) account can neither read nor *select* countries outside its
// region. Regression guard for: genesis-ap (region, regions=asia-pacific,
// countries=null) previously saw every region in the geography filter because
// the option list only honored scope.countries.
describe("effectiveScopeCountries", () => {
  it("scope.all → undefined (no restriction)", () => {
    expect(effectiveScopeCountries({ all: true })).toBeUndefined();
    expect(effectiveScopeCountries(undefined)).toBeUndefined();
  });

  it("region account (countries=null) expands regions to their countries", () => {
    // genesis-ap@genesis.test
    const c = effectiveScopeCountries({ regions: ["genesis-asia-pacific"] });
    expect(c).toContain("KR");
    expect(c).not.toContain("DE"); // genesis-europe, out of scope
    expect(c).not.toContain("US"); // north-america, out of scope
  });

  it("country account (countries set) uses countries only — most specific axis wins", () => {
    // genesis-kr@genesis.test: countries=['KR'] + regions=['genesis-asia-pacific']
    // must NOT expand to the 5-country region (GGMD 3-2 country = 자국). QA-STD-020.
    expect(
      effectiveScopeCountries({ countries: ["KR"], regions: ["genesis-asia-pacific"] }),
    ).toEqual(["KR"]);
  });

  it("neither countries nor regions → undefined", () => {
    expect(effectiveScopeCountries({ brands: ["Genesis"] })).toBeUndefined();
  });

  it("multiple regions union their countries", () => {
    const c = effectiveScopeCountries({
      regions: ["genesis-asia-pacific", "genesis-north-america"],
    });
    expect(c).toContain("KR"); // asia-pacific
    expect(c).toContain("US"); // north-america
  });
});

// 2026-09-29 제품 책임자 사양표: 전용 사이트 계정의 글로벌 = 그 사이트의 글로벌 시장만.
// 권역·브랜드 전체로 넓히지 않는다(시장이 없으면 fail-closed + 글로벌 탭 숨김).
describe("effectiveScopeCountries — 전용 사이트 계정", () => {
  it("WW [worldwide] → 글로벌 시장 없음 → 전용 코드 그대로(ISO 와 안 맞아 0건)", () => {
    expect(effectiveScopeCountries({ countries: ["worldwide"] })).toEqual(["worldwide"]);
  });

  it("N [HYUNDAI-N] → 미국·한국(미국-영어·한국-한국어)", () => {
    expect(new Set(effectiveScopeCountries({ countries: ["HYUNDAI-N"] }))).toEqual(
      new Set(["US", "KR"]),
    );
  });

  it("CPO [CPO] + 북미 권역 → 권역으로 넓히지 않는다", () => {
    expect(
      effectiveScopeCountries({ countries: ["CPO"], regions: ["hyundai-north-america"] }),
    ).toEqual(["CPO"]);
  });
});
