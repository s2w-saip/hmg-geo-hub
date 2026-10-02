import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";

// Unit tests of the /v1/auth/me adapter: pure mapping (toAllowedScope, toSession,
// normalizeMenuGroups) and the fetch contract (API mocked at fetch, token injected through
// the lib/hgh/auth test seam). The legacy/api parity over real consumers lives in
// lib/auth/session.test.ts.

const { bindHghAuth } = await import("../auth");
const { fetchSessionData, getSessionFromApi, normalizeMenuGroups, SCOPE_DENY_BRAND, SCOPE_DENY_COUNTRY, toAllowedScope, toSession } =
  await import("./session");
const { countriesForRhq } = await import("@/lib/rhq");
const { projectCreationOptions } = await import("@/lib/auth/scope-policy");
const { canCreateProject } = await import("@/lib/auth/operator-policy");

type SessionData = components["schemas"]["SessionData"];
type SessionScope = components["schemas"]["SessionScope"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const LOGIN_TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJsIn0.bG9n";
const UID = "11111111-0000-4000-8000-000000000002";

const scope = (s: Partial<SessionScope>): SessionScope => ({ all: false, brands: null, regions: null, countries: null, ...s });
const data = (d: Partial<SessionData> = {}): SessionData => ({
  user_id: UID,
  email: "t-hq-h@example.test",
  display_name: null,
  role: "hq",
  operator: "assigned",
  scope: scope({ brands: ["Hyundai"] }),
  menu_groups: ["standard", "project"],
  is_qa_reviewer: false,
  ...d,
});

describe("toAllowedScope: backend semantics -> front semantics", () => {
  it("all -> {all:true} and every axis unrestricted", () => {
    expect(toAllowedScope({ all: true, brands: null, regions: null, countries: null })).toEqual({
      all: true,
      brands: undefined,
      regions: undefined,
      countries: undefined,
    });
  });

  it("null (no restriction) -> undefined, lists kept", () => {
    expect(toAllowedScope(scope({ brands: ["Kia"], countries: ["US"] }))).toEqual({
      all: false,
      brands: ["Kia"],
      regions: undefined,
      countries: ["US"],
    });
  });

  it("[] (backend deny) never becomes [] (front: no restriction): brands -> [HMG], countries -> [ZZ]", () => {
    const s = toAllowedScope(scope({ brands: [], countries: [] }));
    expect(s.brands).toEqual([SCOPE_DENY_BRAND]);
    expect(SCOPE_DENY_BRAND).toBe("HMG");
    expect(s.countries).toEqual([SCOPE_DENY_COUNTRY]);
    expect(SCOPE_DENY_COUNTRY).toBe("ZZ");
    // The deny country code must stay formattable (scope chips use Intl.DisplayNames).
    expect(() => new Intl.DisplayNames(["en"], { type: "region" }).of(SCOPE_DENY_COUNTRY)).not.toThrow();
  });

  it("FA-1: the raw account countries are the front countries, in their stored spelling and order", () => {
    // Dedicated site codes and virtual geo codes: the effective list is uppercased and sorted,
    // the front predicates (website-virtual-geo) match the stored spelling.
    const cases: [string[], string[]][] = [
      [["worldwide"], ["WORLDWIDE"]],
      [["CPO", "US"], ["CPO", "US"]],
      [["HYUNDAI-N", "KR"], ["HYUNDAI-N", "KR"]],
      [["SA-Dammam", "SA"], ["SA", "SA-DAMMAM"]],
      [["US", "CA"], ["CA", "US"]],
    ];
    for (const [raw, effective] of cases) {
      expect(toAllowedScope(scope({ brands: ["Hyundai"], countries: effective, account_countries: raw })).countries).toEqual(raw);
    }
    // The raw list wins even where the effective list is a deny (an account whose surface scope
    // the backend closes): the front consumers show what legacy showed, the backend denies the data.
    expect(toAllowedScope(scope({ brands: ["Kia"], countries: [], account_countries: ["worldwide"] })).countries).toEqual(["worldwide"]);
  });

  it("FA-1: no raw countries (regions only) -> undefined, as legacy; the region expansion is not carried", () => {
    const expansion = [...countriesForRhq("kia-western-europe")].sort();
    expect(expansion.length).toBeGreaterThan(1);
    for (const raw of [null, []]) {
      expect(toAllowedScope(scope({ brands: ["Kia"], regions: ["kia-western-europe"], countries: expansion, account_countries: raw }))).toEqual({
        all: false,
        brands: ["Kia"],
        regions: ["kia-western-europe"],
        countries: undefined,
      });
    }
    // no raw countries and a deny (unresolvable region) stays a deny
    expect(toAllowedScope(scope({ regions: ["kia-atlantis"], countries: [], account_countries: null })).countries).toEqual([SCOPE_DENY_COUNTRY]);
  });

  it("a backend without account_countries (before core 8): the effective list is kept, never guessed back", () => {
    // A regions-only account and one listing every country of its region look the same here;
    // folding either back to undefined would widen the second (adapter header (2)).
    const expansion = [...countriesForRhq("kia-western-europe")].sort();
    expect(toAllowedScope(scope({ brands: ["Kia"], regions: ["kia-western-europe"], countries: expansion }))).toEqual({
      all: false,
      brands: ["Kia"],
      regions: ["kia-western-europe"],
      countries: expansion,
    });
  });

  it("a mapped scope never contains an empty array (front would read it as unrestricted)", () => {
    for (const brands of [null, [], ["Kia"]]) for (const regions of [null, [], ["kia-western-europe"]]) for (const countries of [null, [], ["US"]])
      for (const account of [undefined, null, [], ["US"], ["worldwide"]]) {
        const s = toAllowedScope(scope({ brands, regions, countries, ...(account === undefined ? {} : { account_countries: account }) }));
        for (const axis of [s.brands, s.regions, s.countries]) expect(axis === undefined || axis.length > 0).toBe(true);
      }
  });
});

describe("F1: a deny marker is never a creation choice", () => {
  const reachableCountries = (d: SessionData) => {
    const u = toSession(d).user;
    return canCreateProject(u) ? projectCreationOptions(u).countries : [];
  };

  it("unresolvable region (countries []) + operator global -> operator none, scope untouched", () => {
    const u = toSession(data({ role: "region", operator: "global", scope: scope({ brands: ["Kia"], regions: ["kia-atlantis"], countries: [] }) })).user;
    expect(u.scope).toEqual({ all: false, brands: ["Kia"], regions: ["kia-atlantis"], countries: [SCOPE_DENY_COUNTRY] });
    // Without the operator gate this is exactly the F1 hole: the marker is the only creation country.
    expect(projectCreationOptions(u).countries).toEqual([SCOPE_DENY_COUNTRY]);
    expect(u.operator).toBe("none");
    expect(canCreateProject(u)).toBe(false);
  });

  it("brands AND countries deny -> operator none as well", () => {
    const u = toSession(data({ operator: "global", scope: scope({ brands: [], regions: ["kia-atlantis"], countries: [] }) })).user;
    expect(u.scope.brands).toEqual([SCOPE_DENY_BRAND]);
    expect(u.operator).toBe("none");
  });

  it("countries deny where the front resolves the region (RHQ table drift): the marker is filtered out, operator kept", () => {
    const u = toSession(data({ operator: "global", scope: scope({ brands: ["Kia"], regions: ["kia-western-europe"], countries: [] }) })).user;
    expect(u.operator).toBe("global");
    expect(projectCreationOptions(u).countries).toEqual([]);
  });

  it("no scope/operator combination offers the marker to a user who can reach creation", () => {
    for (const role of ["hq", "region", "country", "vendor", "website"] as const)
      for (const operator of ["none", "assigned", "global"] as const)
        for (const brands of [null, [], ["Kia"], ["HMG"], ["Kia", "Hyundai"]])
          for (const regions of [null, ["kia-western-europe"], ["kia-atlantis"], ["hyundai-europe"]])
            for (const countries of [null, [], ["US"], ["DE", "FR"]])
              for (const account of [undefined, null, ["US"], ["worldwide"]]) {
                const s = scope({ brands, regions, countries, ...(account === undefined ? {} : { account_countries: account }) });
                const d = data({ role, operator, scope: s });
                expect(reachableCountries(d), JSON.stringify(d.scope)).not.toContain(SCOPE_DENY_COUNTRY);
              }
  });

  it("an account without a deny keeps its operator", () => {
    expect(toSession(data({ operator: "global", scope: scope({ brands: ["Kia"], countries: ["US"] }) })).user.operator).toBe("global");
    expect(toSession(data({ operator: "assigned" })).user.operator).toBe("assigned");
  });
});

describe("toSession: the legacy Session shape", () => {
  it("maps every User field", () => {
    expect(toSession(data())).toEqual({
      user: {
        id: UID,
        email: "t-hq-h@example.test",
        role: "hq",
        scope: { all: false, brands: ["Hyundai"], regions: undefined, countries: undefined },
        operator: "assigned",
        menuGroups: ["standard", "project"],
      },
    });
  });

  it("menu groups: null or [] -> null (role default), unknown values dropped", () => {
    expect(normalizeMenuGroups(null)).toBeNull();
    expect(normalizeMenuGroups([])).toBeNull();
    expect(normalizeMenuGroups(["project", "bogus"])).toEqual(["project"]);
    expect(normalizeMenuGroups(["bogus"])).toBeNull();
    expect(toSession(data({ menu_groups: [] })).user.menuGroups).toBeNull();
  });

  it("vendor is operator none even if the backend said otherwise (defense in depth)", () => {
    expect(toSession(data({ role: "vendor", operator: "global" })).user.operator).toBe("none");
  });

  it("display_name and is_qa_reviewer are not part of User", () => {
    const u = toSession(data({ display_name: "x", is_qa_reviewer: true })).user as unknown as Record<string, unknown>;
    expect(Object.keys(u).sort()).toEqual(["email", "id", "menuGroups", "operator", "role", "scope"]);
  });
});

describe("fetchSessionData / getSessionFromApi: GET /v1/auth/me", () => {
  const seen: { url: string; auth: string | null }[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const respond = (r: () => Response) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init: RequestInit = {}) => {
        seen.push({ url: String(u), auth: new Headers(init.headers).get("Authorization") });
        return r();
      }),
    );
  const err = (status: number, code: string) => () => json(status, { error: { code, message: "m", details: null } });

  beforeEach(() => {
    seen.length = 0;
    vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
    bindHghAuth({ getAccessToken: async () => TOKEN });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    bindHghAuth(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("200 -> Session, with the session token as Bearer", async () => {
    respond(() => json(200, { data: data(), meta: { mode: "session" } }));
    await expect(getSessionFromApi()).resolves.toEqual(toSession(data()));
    expect(seen).toEqual([{ url: "https://api.hgh.test/v1/auth/me", auth: `Bearer ${TOKEN}` }]);
  });

  it("explicit bearer (login action) uses the given token, not the cookie session", async () => {
    respond(() => json(200, { data: data(), meta: { mode: "session" } }));
    await expect(fetchSessionData({ bearer: LOGIN_TOKEN })).resolves.toEqual(data());
    expect(seen[0].auth).toBe(`Bearer ${LOGIN_TOKEN}`);
  });

  it("no token -> null without calling the backend (legacy: no claims -> null)", async () => {
    bindHghAuth({ getAccessToken: async () => null });
    respond(() => json(200, { data: data(), meta: {} }));
    await expect(getSessionFromApi()).resolves.toBeNull();
    expect(seen).toHaveLength(0);
  });

  it.each(["no_account", "unauthenticated", "token_expired"])("401 %s -> null (legacy: no profile = no access)", async (code) => {
    respond(err(401, code));
    await expect(getSessionFromApi()).resolves.toBeNull();
  });

  it("5xx / timeout are thrown (legacy: a failed profiles read was thrown too)", async () => {
    respond(err(500, "internal"));
    await expect(getSessionFromApi()).rejects.toMatchObject({ status: 500, code: "internal" });
    respond(err(503, "auth_unavailable"));
    await expect(getSessionFromApi()).rejects.toMatchObject({ status: 503, code: "auth_unavailable" });
  });
});
