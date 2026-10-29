import { describe, it, expect } from "vitest";
import { isInScope, projectInScope, resolveDimensionState, showsGeoMap } from "./scope-policy";
import type { AllowedScope, User } from "./types";

// Compensating control for not using RLS (data-access-security): verify that the
// scope rule never lets a restricted role see out-of-scope rows. `isInScope` is
// the pure rule that lib/db/scoped.ts mirrors in SQL.
// Region scope values are RHQ 권역 ids (brand-prefixed, from lib/rhq).
const hq: AllowedScope = { all: true };
const region: AllowedScope = { all: false, regions: ["hyundai-europe"] };
const country: AllowedScope = {
  all: false,
  regions: ["hyundai-asia-pacific"],
  countries: ["KR"],
};

describe("isInScope — role data-scope isolation", () => {
  it("HQ/admin (scope.all) sees everything", () => {
    expect(
      isInScope(hq, { region: "hyundai-north-america", country: "US", brand: "Genesis" }),
    ).toBe(true);
  });

  it("country role sees only its country", () => {
    expect(isInScope(country, { region: "hyundai-asia-pacific", country: "KR" })).toBe(true);
    expect(isInScope(country, { region: "hyundai-north-america", country: "US" })).toBe(false);
    expect(isInScope(country, { region: "hyundai-asia-pacific", country: "JP" })).toBe(false);
  });

  it("region role sees only its region", () => {
    expect(isInScope(region, { region: "hyundai-europe", country: "DE" })).toBe(true);
    expect(isInScope(region, { region: "hyundai-asia-pacific", country: "KR" })).toBe(false);
  });

  it("rows missing scoped fields are excluded for restricted roles", () => {
    expect(isInScope(country, { region: null, country: null })).toBe(false);
  });

  // 2026-06-10 (D5): brand=null = common, visible to brand-scoped users.
  // Genesis HQ sees Genesis-tagged + null-tagged. Region/country still strict.
  it("brand=null rows are common — visible to brand-scoped users", () => {
    const genesisHq: AllowedScope = { all: false, brands: ["Genesis"] };
    expect(isInScope(genesisHq, { brand: "Genesis" })).toBe(true);
    expect(isInScope(genesisHq, { brand: null })).toBe(true);
    expect(isInScope(genesisHq, {})).toBe(true);
    expect(isInScope(genesisHq, { brand: "Hyundai" })).toBe(false);
  });
});

// Mirrors the GGMD planning Use Case (page 4981000): a Country-role user cannot
// modify brand or region filters, even if their profile leaves those dimensions
// unrestricted in the data layer.
const u = (role: User["role"], scope: AllowedScope): User => ({
  id: "u",
  email: "u@hmg.test",
  role,
  scope,
});

describe("resolveDimensionState — dashboard filter authority (v16 matrix)", () => {
  it("admin: All Brands × All RHQ × All Country → every dimension editable", () => {
    const user = u("admin", { all: true });
    for (const dim of ["brand", "region", "country"] as const) {
      expect(resolveDimensionState(user, dim).editable).toBe(true);
    }
  });

  it("HQ: Own Brand × All RHQ × All Country → brand locked, region/country editable", () => {
    const user = u("hq", { all: false, brands: ["Hyundai"] });
    expect(resolveDimensionState(user, "brand").editable).toBe(false);
    expect(resolveDimensionState(user, "brand").value).toBe("Hyundai");
    expect(resolveDimensionState(user, "region").editable).toBe(true);
    expect(resolveDimensionState(user, "country").editable).toBe(true);
  });

  it("region role: Own Brand × Own RHQ × All Country → brand+region locked, country editable", () => {
    const user = u("region", {
      all: false,
      brands: ["Hyundai"],
      regions: ["hyundai-europe"],
    });
    expect(resolveDimensionState(user, "brand").editable).toBe(false);
    expect(resolveDimensionState(user, "region").editable).toBe(false);
    expect(resolveDimensionState(user, "region").value).toBe("hyundai-europe");
    expect(resolveDimensionState(user, "country").editable).toBe(true);
  });

  it("country role: Own Brand × Own RHQ × Own Country → all three locked", () => {
    const user = u("country", {
      all: false,
      brands: ["Hyundai"],
      regions: ["hyundai-asia-pacific"],
      countries: ["KR"],
    });
    for (const dim of ["brand", "region", "country"] as const) {
      expect(resolveDimensionState(user, dim).editable).toBe(false);
    }
    expect(resolveDimensionState(user, "country").value).toBe("KR");
  });

  it("URL-supplied value outside allowed set is dropped (never widens scope)", () => {
    const user = u("hq", { all: false, brands: ["Hyundai"] });
    // HQ has All RHQ — any real 권역 id is valid.
    const state = resolveDimensionState(user, "region", "hyundai-latin-america");
    expect(state.value).toBe("hyundai-latin-america");
    const blocked = resolveDimensionState(user, "region", "BOGUS");
    expect(blocked.value).toBeUndefined();
  });
});

// 시장 지도(GEO map) 노출 정책 — HQ·RHQ·Admin 만 (country/vendor 제외).
describe("showsGeoMap — GEO map visibility (HQ · RHQ · Admin)", () => {
  it("admin (scope.all) sees the map", () => {
    expect(showsGeoMap(u("admin", { all: true }))).toBe(true);
  });
  it("hq sees the map", () => {
    expect(showsGeoMap(u("hq", { all: false, brands: ["Hyundai"] }))).toBe(true);
  });
  it("region (RHQ) sees the map — auto-zoomed to its region", () => {
    expect(
      showsGeoMap(u("region", { all: false, brands: ["Kia"], regions: ["EU"] })),
    ).toBe(true);
  });
  it("country role does NOT see the map (single country is meaningless)", () => {
    expect(
      showsGeoMap(
        u("country", { all: false, regions: ["EU"], countries: ["DE"] }),
      ),
    ).toBe(false);
  });
  it("vendor does NOT see the map", () => {
    expect(showsGeoMap(u("vendor", { all: false }))).toBe(false);
  });
  it("website role does NOT see the map (본인 사이트 시야)", () => {
    expect(
      showsGeoMap(
        u("website", { all: false, brands: ["Hyundai"], countries: ["KR"] }),
      ),
    ).toBe(false);
  });
});

// website 역할(2026-07-22): 필터 잠금은 role 규칙이 아니라 프로필 scope 의
// 싱글턴 핀으로 동작한다 — country 계정과 같은 UX가 나오는지 고정.
describe("resolveDimensionState — website role", () => {
  it("country-scoped website account renders country pinned (disabled)", () => {
    const user = u("website", {
      all: false,
      brands: ["Hyundai"],
      regions: ["hyundai-asia-pacific"],
      countries: ["KR"],
    });
    expect(resolveDimensionState(user, "brand").editable).toBe(false);
    const country = resolveDimensionState(user, "country");
    expect(country.editable).toBe(false);
    expect(country.value).toBe("KR");
  });
});

// 역할→프로젝트 게이팅 (2026-07-02): 프로젝트 brand×country ∈ 계정 scope.
describe("projectInScope — role→project gating predicate", () => {
  it("admin (scope.all) passes any project", () => {
    expect(projectInScope({ all: true }, { brand: "Kia", country: "IT" })).toBe(true);
  });
  it("brand-scoped account passes own-brand project, fails other brand", () => {
    const scope: AllowedScope = { all: false, brands: ["Kia"] };
    expect(projectInScope(scope, { brand: "Kia", country: "IT" })).toBe(true);
    expect(projectInScope(scope, { brand: "Hyundai", country: "IT" })).toBe(false);
  });
  it("country-scoped account fails a project outside its countries", () => {
    const scope: AllowedScope = { all: false, brands: ["Kia"], countries: ["IT"] };
    expect(projectInScope(scope, { brand: "Kia", country: "IT" })).toBe(true);
    expect(projectInScope(scope, { brand: "Kia", country: "DE" })).toBe(false);
  });
  it("brand=null project is COMMON — visible to every brand scope (D5)", () => {
    expect(
      projectInScope({ all: false, brands: ["Genesis"] }, { brand: null, country: "KR" }),
    ).toBe(true);
  });
  it("no assigned scope grants no project access, including common projects", () => {
    expect(projectInScope({ all: false }, { brand: "Kia", country: "IT" })).toBe(false);
    expect(projectInScope({ all: false, brands: [], regions: [], countries: [] }, { brand: null, country: "KR" })).toBe(false);
  });

  // region@hmg.test shape (2026-07-06 QA-STD-016 DB audit): regions set,
  // brands/countries unset — was previously unrestricted worldwide despite the
  // documented matrix ("region → Own Brand × Own RHQ × All Country") because
  // this predicate never resolved scope.regions to countries for a table with
  // no region column.
  it("region-only scope narrows a project to the brand's RHQ countries", () => {
    const scope: AllowedScope = { all: false, regions: ["hyundai-europe"] };
    expect(projectInScope(scope, { brand: "Hyundai", country: "DE" })).toBe(true); // in hyundai-europe
    expect(projectInScope(scope, { brand: "Hyundai", country: "KR" })).toBe(false); // asia-pacific, not europe
  });

  it("region id is brand-prefixed — a region scoped for one brand doesn't gate a different brand's project", () => {
    const scope: AllowedScope = { all: false, regions: ["hyundai-europe"] };
    // no Kia region in scope → regionCountriesForBrand("Kia") is null (unrestricted for Kia)
    expect(projectInScope(scope, { brand: "Kia", country: "KR" })).toBe(true);
  });

  it("region + explicit country both set (country role) — country still wins when it's inside the region", () => {
    const scope: AllowedScope = { all: false, regions: ["hyundai-asia-pacific"], countries: ["KR"] };
    expect(projectInScope(scope, { brand: "Hyundai", country: "KR" })).toBe(true);
    expect(projectInScope(scope, { brand: "Hyundai", country: "JP" })).toBe(false);
  });

  it("brand=null project skips region gating too (D5 — can't resolve a brand-prefixed region without a brand)", () => {
    const scope: AllowedScope = { all: false, regions: ["hyundai-europe"] };
    expect(projectInScope(scope, { brand: null, country: "KR" })).toBe(true);
  });
});
