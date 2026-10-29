import { describe, expect, it } from "vitest";
import { effectiveCountries } from "./website-sites";

// website_sites has no region column — scope.regions (RHQ buckets) must resolve
// to country codes here or a region-only account (e.g. seed's region@hmg.test:
// brands=["Hyundai"], regions=["hyundai-europe"], countries unset) sees every
// country worldwide instead of just its region.
describe("effectiveCountries", () => {
  it("resolves a region-only scope to that region's countries", () => {
    const countries = effectiveCountries({ all: false, regions: ["hyundai-europe"] });
    expect(countries).toContain("DE");
    expect(countries).not.toBeNull();
    expect(countries).not.toContain("KR"); // asia-pacific, not europe
  });

  it("returns explicit countries unchanged when no region is set", () => {
    expect(effectiveCountries({ all: false, countries: ["KR"] })).toEqual(["KR"]);
  });

  it("intersects region and explicit countries when both are set (country role)", () => {
    // seed's country@hmg.test: regions=["hyundai-asia-pacific"], countries=["KR"]
    const countries = effectiveCountries({
      all: false,
      regions: ["hyundai-asia-pacific"],
      countries: ["KR"],
    });
    expect(countries).toEqual(["KR"]);
  });

  it("drops an explicit country outside the region (defense in depth)", () => {
    const countries = effectiveCountries({
      all: false,
      regions: ["hyundai-europe"],
      countries: ["KR"], // KR is asia-pacific, not europe
    });
    expect(countries).toEqual([]);
  });

  it("returns null (no restriction) when neither region nor country is set", () => {
    expect(effectiveCountries({ all: false, brands: ["Hyundai"] })).toBeNull();
  });

  it("does not special-case scope.all — still resolves stray region/country values", () => {
    // effectiveCountries itself doesn't look at .all — the caller
    // (getProjectIdsForScope) already skips this function entirely when
    // scope.all. Documented here so a future refactor doesn't assume this
    // function short-circuits on .all itself.
    expect(effectiveCountries({ all: true, regions: ["hyundai-europe"], countries: ["KR"] })).toEqual([]);
  });
});

// 제네시스 사우디 도시별 사이트(SA-Dammam·SA-Jeddah·SA-Riyadh, migration 0056)는
// ISO 가 아니라 RHQ 맵에 없다 — SA 를 허용하는 스코프가 셋을 함께 봐야 중동 권역
// 계정이 사우디 사이트를 잃지 않는다. CN-BJ 는 합작사 별도 사이트라 CN 에 딸리지 않는다.
describe("effectiveCountries — pseudo city codes", () => {
  it("region scope that covers SA also covers the Saudi city sites", () => {
    const countries = effectiveCountries({ all: false, regions: ["genesis-middle-east"] });
    expect(countries).toContain("SA");
    expect(countries).toEqual(expect.arrayContaining(["SA-Dammam", "SA-Jeddah", "SA-Riyadh"]));
  });

  it("a Saudi city account keeps its city plus SA, and the region intersection does not drop it", () => {
    const countries = effectiveCountries({
      all: false,
      regions: ["genesis-middle-east"],
      countries: ["SA-Dammam", "SA"],
    });
    expect(countries).toEqual(["SA", "SA-Dammam", "SA-Jeddah", "SA-Riyadh"]);
  });

  it("CN scope does not gain Beijing Hyundai (explicit account scope only)", () => {
    expect(effectiveCountries({ all: false, countries: ["CN"] })).toEqual(["CN"]);
  });
});
