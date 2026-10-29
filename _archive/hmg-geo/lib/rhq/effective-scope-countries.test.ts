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
