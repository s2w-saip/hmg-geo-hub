import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileRow } from "@/lib/db/schema";
import type { components } from "@/lib/hgh/api-types";
import type { MenuGroup, User } from "./types";

// getSession facade (D8 flag HGH_SOURCE_SESSION) and the legacy <-> api parity check.
//
// Parity method: one account, two sources, same consumers.
//   legacy = the profiles row (profileRepository mocked) through the unchanged legacy path;
//   api    = what the backend answers for the SAME account after migration: the row is carried
//            into app.user_account (null arrays -> '{}'), and /v1/auth/me is computed by a port of
//            back/app/core/auth.py DataScope.of + platform/auth/session/service.py build_session
//            (below; refs.rhq approximated by the front RHQ table lib/rhq, umbrella = HMG), with
//            account_countries = the stored account countries (core 8) and menu_groups = the
//            derived groups of sync S1 BE-7 (principal_from_row effective_menu_groups, the same
//            rule as ./menu-groups effectiveMenuGroups; ships in the deploy window of FA-1).
// Both Users are then fed to every consumer of the session (route guard, SNB menus, landing,
// operator gates, scope-policy, rhq expansion, the dedicated site rules of website-virtual-geo)
// and the results compared. Differences are not
// tolerated silently: each fixture lists the consumer keys allowed to differ (KNOWN_DIFF) with
// the reason, and the test fails if the actual set of differing keys is anything else.

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));

const current = vi.hoisted(() => ({
  profile: null as ProfileRow | null,
  claims: null as null | { sub: string; email?: string },
  token: "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln" as string | null,
  me: null as unknown,
  meStatus: 200,
  meCode: "",
  profileCalls: 0,
  fetchCalls: 0,
}));

vi.mock("@/utils/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getClaims: async () => ({ data: current.claims ? { claims: current.claims } : null, error: null }),
      getSession: async () => ({ data: { session: current.token ? { access_token: current.token } : null }, error: null }),
    },
  }),
}));
vi.mock("@/lib/db/repositories/profiles", () => ({
  profileRepository: {
    getByUserId: vi.fn(async () => {
      current.profileCalls += 1;
      return current.profile;
    }),
  },
}));

const { getSession } = await import("./session");
const routePolicy = await import("./route-policy");
const scopePolicy = await import("./scope-policy");
const operatorPolicy = await import("./operator-policy");
const { countriesForRhq, effectiveScopeCountries, effectiveWebsiteScopeCountries, rhqForCountry } = await import("@/lib/rhq");
const { effectiveMenuGroups } = await import("./menu-groups");
const { hasGlobalSurface, scopeForGeoSurface, websiteScopeBrands } = await import("@/lib/scope/website-virtual-geo");

type SessionData = components["schemas"]["SessionData"];

// ── backend port (test only) ─────────────────────────────────────────────────

const UMBRELLA = new Set(["HMG"]);
const uniqSorted = (xs: string[]) => [...new Set(xs)].sort();

/** profiles row -> app.user_account -> GET /v1/auth/me data (DataScope.of + build_session). */
function backendSessionFor(p: ProfileRow): SessionData {
  const brands = p.brands ?? [];
  const regions = p.regions ?? [];
  const rawCountries = uniqSorted((p.countries ?? []).map((c) => c.toUpperCase()));
  let scope: SessionData["scope"];
  if (p.scopeAll || p.role === "admin") {
    scope = { all: true, brands: null, regions: null, countries: null };
  } else {
    const b = p.role === "vendor" && brands.length === 0 ? null : brands.filter((x) => !UMBRELLA.has(x));
    let countries: string[] | null;
    if (rawCountries.length) countries = rawCountries;
    else if (regions.length) {
      const unresolved = regions.filter((r) => countriesForRhq(r).length === 0);
      countries = unresolved.length ? [] : uniqSorted(regions.flatMap((r) => countriesForRhq(r)));
    } else countries = null;
    scope = {
      all: false,
      brands: b,
      regions: regions.length ? [...regions] : null,
      countries,
      account_countries: p.countries?.length ? [...p.countries] : null,
    };
  }
  return {
    user_id: p.id,
    email: p.email ?? "",
    display_name: null,
    role: p.role,
    operator: p.role === "vendor" ? "none" : p.operator,
    scope,
    menu_groups: effectiveMenuGroups(p.menuGroups, { all: p.scopeAll || p.role === "admin", countries: p.countries ?? undefined }),
    is_qa_reviewer: false,
  };
}

// ── fixtures (back/tests/support.py accounts + the edge shapes the mapping must survive) ──

let seq = 0;
function profile(p: Partial<ProfileRow> & Pick<ProfileRow, "role">): ProfileRow {
  seq += 1;
  return {
    id: `11111111-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    email: `u${seq}@example.test`,
    scopeAll: false,
    brands: null,
    regions: null,
    countries: null,
    operator: "none",
    menuGroups: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...p,
  };
}

const KIA_WEU = countriesForRhq("kia-western-europe");

const FIXTURES: Record<string, ProfileRow> = {
  admin: profile({ role: "admin", scopeAll: true, operator: "global" }),
  hqHyundaiMenus: profile({ role: "hq", brands: ["Hyundai"], operator: "assigned", menuGroups: ["standard", "project"] }),
  countryKiaUS: profile({ role: "country", brands: ["Kia"], countries: ["US"] }),
  vendor: profile({ role: "vendor", menuGroups: ["project"] }),
  vendorStoredGlobal: profile({ role: "vendor", operator: "global" }),
  regionKiaWEU: profile({ role: "region", brands: ["Kia"], regions: ["kia-western-europe"] }),
  websiteKia: profile({ role: "website", brands: ["Kia"], menuGroups: ["website"] }),
  hqEmptyMenus: profile({ role: "hq", brands: ["Genesis"], operator: "global", menuGroups: [] }),
  hqBogusMenu: profile({ role: "hq", brands: ["Hyundai"], menuGroups: ["project", "bogus"] as MenuGroup[] }),
  hqScopeAll: profile({ role: "hq", scopeAll: true, operator: "global" }),
  countryRegionPlusCountry: profile({ role: "country", brands: ["Kia"], regions: ["kia-western-europe"], countries: ["DE"] }),
  hqUmbrellaOnly: profile({ role: "hq", brands: ["HMG"] }),
  hqUmbrellaAndKia: profile({ role: "hq", brands: ["HMG", "Kia"] }),
  regionUnresolved: profile({ role: "region", brands: ["Kia"], regions: ["kia-atlantis"] }),
  regionUnresolvedGlobalOperator: profile({ role: "region", brands: ["Kia"], regions: ["kia-atlantis"], operator: "global" }),
  hqUmbrellaOnlyUnresolvedGlobal: profile({ role: "hq", brands: ["HMG"], regions: ["kia-atlantis"], operator: "global" }),
  regionExplicitFullExpansion: profile({ role: "region", brands: ["Kia"], regions: ["kia-western-europe"], countries: [...KIA_WEU] }),
  countryUnsortedList: profile({ role: "country", brands: ["Hyundai"], countries: ["US", "CA"] }),
  // Dedicated site accounts (hmg-geo #326 #328 #329): the front rules match the stored spelling.
  websiteKiaWorldwide: profile({ role: "website", brands: ["Kia"], countries: ["worldwide"], menuGroups: ["website"] }),
  hqHyundaiCPO: profile({ role: "hq", brands: ["Hyundai"], countries: ["CPO"], operator: "assigned" }),
  hqHyundaiN: profile({ role: "hq", brands: ["Hyundai"], countries: ["HYUNDAI-N"] }),
  hqHyundaiNPlusKR: profile({ role: "hq", brands: ["Hyundai"], countries: ["HYUNDAI-N", "KR"] }),
  countryVirtualGeo: profile({ role: "country", brands: ["Hyundai"], regions: ["hyundai-middle-east"], countries: ["SA-Riyadh", "SA"] }),
};

// Consumer keys allowed to differ, with the reason (documented in lib/hgh/adapters/session.ts).
// Every one of them narrows (checked below): api never shows a project, row or country legacy hid.
// regionKiaWEU left this list with FA-1 (sync S1): the raw account countries (none) now reach the
// front, so the region account's country filter and projectInScope equal legacy.
const KNOWN_DIFF: Record<string, { keys: string[]; why: string }> = {
  hqUmbrellaAndKia: {
    keys: ["dim.brand", "projectCreationOptions", "projectInScope", "isInScope", "websiteScopeBrands"],
    why:
      "backend drops the umbrella brand from brand lists: HMG-tagged projects/rows and the HMG option leave a " +
      "[HMG, Kia] account, and the single remaining brand now pins the brand chip to Kia (the website brand allow list loses HMG too)",
  },
  regionUnresolved: {
    keys: ["dim.country", "projectCreationOptions", "projectInScope", "effectiveScopeCountries", "effectiveWebsiteScopeCountries", "geoSurface"],
    why:
      "legacy let an unresolvable region fall through to 'no country restriction' (leak: every Kia project passed); " +
      "backend denies (verification B1) and the front reads countries [ZZ] as deny (the country filter pins ZZ). " +
      "projectCreationOptions would list ZZ but is unreachable: operator none (creationChoices equal, both empty). The website and per surface country lists read ZZ the same way",
  },
  regionUnresolvedGlobalOperator: {
    keys: ["identity", "operator", "dim.country", "creationChoices", "projectCreationOptions", "projectInScope", "effectiveScopeCountries", "effectiveWebsiteScopeCountries", "geoSurface"],
    why:
      "as regionUnresolved, and ZZ would be a creation country (F1): operator becomes none, so the creation page and " +
      "action close (legacy offered the page with no country; backend offers no creation country either)",
  },
  hqUmbrellaOnlyUnresolvedGlobal: {
    keys: ["identity", "operator", "dim.country", "creationChoices", "projectCreationOptions", "projectInScope", "effectiveScopeCountries", "effectiveWebsiteScopeCountries", "geoSurface"],
    why:
      "brands AND countries both deny: same as above; projectCreationOptions would list ZZ but is unreachable " +
      "(canCreateProject is false), which creationChoices shows",
  },
};

// ── consumers ────────────────────────────────────────────────────────────────

const BRANDS = ["Hyundai", "Kia", "Genesis", "HMG", null];
// Real data values only. The deny marker ZZ is not one (asserted below): no row or project
// carries it, which is what lets countries [ZZ] mean "deny".
const COUNTRIES = ["US", "CA", "DE", "FR", "KR", "MX", null];
const PATHS = [
  ...routePolicy.ROUTES.map((r) => r.path),
  "/projects/11111111-2222-4333-8444-555555555555",
  "/projects/11111111-2222-4333-8444-555555555555/analysis/mention",
  "/projects/by-scope/x",
  "/no-access",
  "/unknown",
];
const sorted = (xs: readonly string[] | undefined) => (xs ? [...xs].sort() : xs);

function consumers(u: User): Record<string, unknown> {
  const dim = (d: "brand" | "region" | "country") => {
    const s = scopePolicy.resolveDimensionState(u, d);
    return { editable: s.editable, options: sorted(s.options), value: s.value };
  };
  const pco = scopePolicy.projectCreationOptions(u);
  const grid: string[] = [];
  for (const brand of BRANDS) for (const country of COUNTRIES) {
    grid.push(`${brand}/${country}:${scopePolicy.projectInScope(u.scope, { brand, country })}`);
  }
  // Rows as the data has them: the region is derived from brand x country (RHQ), so a row
  // never pairs a region with a country outside it. Plus region-less rows.
  const rows: string[] = [];
  for (const brand of BRANDS) for (const country of COUNTRIES) {
    const derived = brand && country ? rhqForCountry(brand, country) : null;
    for (const region of new Set([derived, null])) {
      rows.push(`${brand}/${region}/${country}:${scopePolicy.isInScope(u.scope, { brand, region, country })}`);
    }
  }
  return {
    identity: { id: u.id, email: u.email, role: u.role, operator: u.operator, menuGroups: u.menuGroups },
    visibleRoutes: routePolicy.visibleRoutes(u.role, u.menuGroups).map((r) => r.path),
    visibleGroups: routePolicy.visibleGroups(u.role, u.menuGroups),
    landing: routePolicy.defaultLandingFor(u.role, u.menuGroups),
    canAccessRoute: PATHS.map((p) => `${p}:${routePolicy.canAccessRoute(u.role, p, u.menuGroups)}`),
    operator: {
      create: operatorPolicy.canCreateProject(u),
      isOperator: operatorPolicy.isOperator(u),
      operateNonMember: operatorPolicy.canOperateProject(u, null),
      operateMember: operatorPolicy.canOperateProject(u, { status: "active" } as never),
    },
    canAccessAdmin: scopePolicy.canAccessAdmin(u),
    showsGeoMap: scopePolicy.showsGeoMap(u),
    showsGeoSnapshot: scopePolicy.showsGeoSnapshot(u),
    "dim.brand": dim("brand"),
    "dim.region": dim("region"),
    "dim.country": dim("country"),
    projectCreationOptions: { brands: sorted(pco.brands), countries: sorted(pco.countries) },
    // What the creation page offers and the legacy creation action accepts: both check
    // canCreateProject before computing projectCreationOptions.
    creationChoices: operatorPolicy.canCreateProject(u)
      ? { brands: sorted(pco.brands), countries: sorted(pco.countries) }
      : { brands: [], countries: [] },
    projectInScope: grid,
    isInScope: rows,
    standardPromptInScope: BRANDS.map((b) => scopePolicy.standardPromptInScope(u.scope, b)),
    effectiveScopeCountries: sorted(effectiveScopeCountries(u.scope)),
    // Dedicated site rules (hmg-geo #326 #328 #329): read the raw account countries (FA-1).
    effectiveWebsiteScopeCountries: sorted(effectiveWebsiteScopeCountries(u.scope)),
    hasGlobalSurface: hasGlobalSurface(u.scope),
    geoSurface: {
      website: sorted(scopeForGeoSurface(u.scope, "website").countries),
      standard: sorted(scopeForGeoSurface(u.scope, "standard").countries),
    },
    websiteScopeBrands: sorted(websiteScopeBrands(u.scope.brands, u.scope.countries)),
  };
}

// ── harness ──────────────────────────────────────────────────────────────────

function loadAccount(p: ProfileRow) {
  current.profile = p;
  current.claims = { sub: p.id, email: p.email ?? undefined };
  current.me = backendSessionFor(p);
  current.meStatus = 200;
}

beforeEach(() => {
  current.token = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
  current.profileCalls = 0;
  current.fetchCalls = 0;
  current.meStatus = 200;
  current.meCode = "";
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      current.fetchCalls += 1;
      expect(String(url)).toBe("https://api.hgh.test/v1/auth/me");
      const body = current.meStatus === 200 ? { data: current.me, meta: { mode: "session" } } : { error: { code: current.meCode, message: "m", details: null } };
      return new Response(JSON.stringify(body), { status: current.meStatus, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function sessionFrom(source: "legacy" | "api") {
  vi.stubEnv("HGH_SOURCE_SESSION", source);
  return getSession();
}

describe("getSession facade (D8: HGH_SOURCE_SESSION)", () => {
  it("unset -> legacy (profiles), no backend call", async () => {
    loadAccount(FIXTURES.hqHyundaiMenus);
    vi.stubEnv("HGH_SOURCE_SESSION", "");
    const s = await getSession();
    expect(s?.user.id).toBe(FIXTURES.hqHyundaiMenus.id);
    expect(current.profileCalls).toBe(1);
    expect(current.fetchCalls).toBe(0);
  });

  it("api -> /v1/auth/me, no profiles read", async () => {
    loadAccount(FIXTURES.hqHyundaiMenus);
    const s = await sessionFrom("api");
    expect(s?.user.id).toBe(FIXTURES.hqHyundaiMenus.id);
    expect(current.fetchCalls).toBe(1);
    expect(current.profileCalls).toBe(0);
  });

  it("no Supabase session: both sources -> null (the (dash) layout sends it to /login)", async () => {
    loadAccount(FIXTURES.hqHyundaiMenus);
    current.claims = null;
    current.token = null;
    await expect(sessionFrom("legacy")).resolves.toBeNull();
    await expect(sessionFrom("api")).resolves.toBeNull();
    expect(current.fetchCalls).toBe(0);
  });

  it("signed in without an account: legacy no profile == api 401 no_account -> null", async () => {
    loadAccount(FIXTURES.hqHyundaiMenus);
    current.profile = null;
    current.meStatus = 401;
    current.meCode = "no_account";
    await expect(sessionFrom("legacy")).resolves.toBeNull();
    await expect(sessionFrom("api")).resolves.toBeNull();
  });

  it("backend failure is thrown to the error boundary, not turned into 'logged out'", async () => {
    loadAccount(FIXTURES.hqHyundaiMenus);
    current.meStatus = 500;
    current.meCode = "internal";
    await expect(sessionFrom("api")).rejects.toMatchObject({ status: 500 });
  });
});

describe("legacy <-> api parity over every session consumer", () => {
  it.each(Object.keys(FIXTURES))("%s", async (name) => {
    loadAccount(FIXTURES[name]);
    const legacy = await sessionFrom("legacy");
    const api = await sessionFrom("api");
    expect(legacy).not.toBeNull();
    expect(api).not.toBeNull();
    const a = consumers(legacy!.user);
    const b = consumers(api!.user);
    const differing = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    expect(differing.sort()).toEqual([...(KNOWN_DIFF[name]?.keys ?? [])].sort());
    // Identity, menus, landing and route access are never allowed to differ.
    for (const k of ["visibleRoutes", "visibleGroups", "landing", "canAccessRoute"]) {
      expect(b[k], k).toEqual(a[k]);
    }
  });

  it("FA-1: a region account carries no country list, as legacy (was: the region expansion)", async () => {
    loadAccount(FIXTURES.regionKiaWEU);
    const api = (await sessionFrom("api"))!.user;
    const legacy = (await sessionFrom("legacy"))!.user;
    expect(current.me).toMatchObject({ scope: { countries: [...KIA_WEU].sort(), account_countries: null } });
    expect(api.scope.countries).toBeUndefined();
    expect(consumers(api)["dim.country"]).toEqual(consumers(legacy)["dim.country"]);
  });

  it("FA-1: dedicated site accounts keep their stored codes (the backend's effective list is uppercased)", async () => {
    loadAccount(FIXTURES.websiteKiaWorldwide);
    expect(current.me).toMatchObject({ scope: { countries: ["WORLDWIDE"], account_countries: ["worldwide"] } });
    const ww = (await sessionFrom("api"))!.user;
    expect(ww.scope.countries).toEqual(["worldwide"]);
    expect(hasGlobalSurface(ww.scope)).toBe(false);
    expect(scopeForGeoSurface(ww.scope, "website").countries).toEqual(["worldwide"]);
    loadAccount(FIXTURES.hqHyundaiNPlusKR);
    const n = (await sessionFrom("api"))!.user;
    expect(scopeForGeoSurface(n.scope, "standard").countries?.slice().sort()).toEqual(["KR", "US"]);
    expect(scopeForGeoSurface(n.scope, "website").countries).toEqual(["HYUNDAI-N"]);
    expect(websiteScopeBrands(n.scope.brands, n.scope.countries)).toEqual(["Hyundai", "Hyundai N"]);
  });

  it("api only ever narrows: projects, rows, countries, creation choices, operator rights (every fixture)", async () => {
    const subset = (x: readonly string[], y: readonly string[]) => x.every((v) => y.includes(v));
    for (const name of Object.keys(FIXTURES)) {
      loadAccount(FIXTURES[name]);
      const a = consumers((await sessionFrom("legacy"))!.user);
      const b = consumers((await sessionFrom("api"))!.user);
      for (const k of ["projectInScope", "isInScope"] as const) {
        const legacyTrue = new Set((a[k] as string[]).filter((x) => x.endsWith(":true")));
        const widened = (b[k] as string[]).filter((x) => x.endsWith(":true") && !legacyTrue.has(x));
        expect(widened, `${name} ${k}`).toEqual([]);
      }
      // undefined = unrestricted: anything is narrower than that; otherwise api must be a subset.
      for (const k of ["effectiveScopeCountries", "effectiveWebsiteScopeCountries"] as const) {
        const la = a[k] as string[] | undefined;
        const lb = b[k] as string[] | undefined;
        if (la) expect(lb !== undefined && subset(lb, la), `${name} ${k}`).toBe(true);
      }
      // Website brand allow list: [] = unrestricted, otherwise api must be a subset.
      const wa = a.websiteScopeBrands as string[];
      const wb = b.websiteScopeBrands as string[];
      if (wa.length) expect(wb.length > 0 && subset(wb, wa), `${name} websiteScopeBrands`).toBe(true);
      // Creation (F1): what api offers and accepts is a subset of what legacy offered and accepted,
      // and a deny marker is never a choice.
      const ca = a.creationChoices as { brands: string[]; countries: string[] };
      const cb = b.creationChoices as { brands: string[]; countries: string[] };
      expect(subset(cb.countries, ca.countries), `${name} creation countries`).toBe(true);
      expect(subset(cb.brands, ca.brands) || cb.countries.length === 0, `${name} creation brands`).toBe(true);
      expect(cb.countries, `${name} creation marker`).not.toContain("ZZ");
      // Operator rights never grow.
      const oa = a.operator as Record<string, boolean>;
      const ob = b.operator as Record<string, boolean>;
      for (const k of Object.keys(oa)) if (ob[k]) expect(oa[k], `${name} operator.${k}`).toBe(true);
    }
  });

  it("the deny marker ZZ is never a data value (RHQ table, geo catalog, pseudo countries)", async () => {
    const { ALL_RHQ_COUNTRIES } = await import("@/lib/rhq");
    const { GEO_ENTRIES, geoLocateByCode } = await import("@/lib/geo-catalog");
    expect(ALL_RHQ_COUNTRIES).not.toContain("ZZ");
    expect(GEO_ENTRIES.some((e) => JSON.stringify(e).includes('"ZZ"'))).toBe(false);
    expect(geoLocateByCode("ZZ")).toBeNull();
  });

  it("F1 repro: an unresolvable-region account with operator global cannot create a ZZ project on either source", async () => {
    for (const name of ["regionUnresolvedGlobalOperator", "hqUmbrellaOnlyUnresolvedGlobal"]) {
      loadAccount(FIXTURES[name]);
      const api = (await sessionFrom("api"))!.user;
      const reachable = operatorPolicy.canCreateProject(api) ? scopePolicy.projectCreationOptions(api).countries : [];
      expect(reachable, name).toEqual([]);
      expect(api.scope.countries, name).toEqual(["ZZ"]);
    }
  });
});
