import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileRow } from "@/lib/db/schema";

// Login landing, legacy <-> api. The api source asks GET /v1/auth/me with the token the
// sign-in just issued and lands with defaultLandingFor(role, menuGroups), the same rule as the
// locale root page (app/[locale]/page.tsx). Legacy passed the role only.

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, delete: () => undefined }),
  headers: async () => new Headers(),
}));

const LOGIN_TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJsIn0.bG9n";
const s = vi.hoisted(() => ({
  profile: null as ProfileRow | null,
  signInError: null as null | Error,
  token: "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJsIn0.bG9n" as string | null,
  meStatus: 200,
  signOut: 0,
  profileReads: 0,
  auths: [] as (string | null)[],
}));
vi.mock("@/utils/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      signInWithPassword: async () =>
        s.signInError
          ? { data: { user: null, session: null }, error: s.signInError }
          : {
              data: { user: s.profile ? { id: s.profile.id } : null, session: s.token ? { access_token: s.token } : null },
              error: null,
            },
      signOut: async () => {
        s.signOut += 1;
        return { error: null };
      },
      // The cookie session is NOT used by the login landing (the new session is not in the
      // request cookies yet); these make that observable.
      getClaims: async () => {
        throw new Error("login must not read the cookie session");
      },
      getSession: async () => {
        throw new Error("login must not read the cookie session");
      },
    },
  }),
}));
vi.mock("@/lib/db/repositories/profiles", () => ({
  profileRepository: {
    getByUserId: async () => {
      s.profileReads += 1;
      return s.profile;
    },
  },
}));

const { login, logout } = await import("./actions");
const { defaultLandingFor } = await import("./route-policy");

function profile(p: Partial<ProfileRow> & Pick<ProfileRow, "role">): ProfileRow {
  return {
    id: "11111111-0000-4000-8000-000000000002",
    email: "u@example.test",
    scopeAll: false,
    brands: ["Kia"],
    regions: null,
    countries: null,
    operator: "none",
    menuGroups: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...p,
  };
}

function form(locale = "ko"): FormData {
  const f = new FormData();
  f.set("email", " u@example.test ");
  f.set("password", "pw");
  f.set("locale", locale);
  return f;
}

async function landing(source: "legacy" | "api", locale = "ko"): Promise<string> {
  vi.stubEnv("HGH_SOURCE_SESSION", source);
  try {
    const r = await login({}, form(locale));
    return `STATE:${JSON.stringify(r)}`;
  } catch (e) {
    return (e as Error).message;
  }
}

beforeEach(() => {
  s.signInError = null;
  s.token = LOGIN_TOKEN;
  s.meStatus = 200;
  s.signOut = 0;
  s.profileReads = 0;
  s.auths = [];
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string, init: RequestInit = {}) => {
      expect(new URL(String(u)).pathname).toBe("/v1/auth/me");
      s.auths.push(new Headers(init.headers).get("Authorization"));
      const p = s.profile;
      if (s.meStatus !== 200 || !p) {
        const code = s.meStatus === 200 ? "no_account" : s.meStatus === 401 ? "no_account" : "internal";
        return new Response(JSON.stringify({ error: { code, message: "m", details: null } }), {
          status: s.meStatus === 200 ? 401 : s.meStatus,
          headers: { "content-type": "application/json" },
        });
      }
      const data = {
        user_id: p.id,
        email: p.email,
        display_name: null,
        role: p.role,
        operator: p.operator,
        scope: { all: p.role === "admin", brands: null, regions: null, countries: null },
        menu_groups: p.menuGroups,
        is_qa_reviewer: false,
      };
      return new Response(JSON.stringify({ data, meta: { mode: "session" } }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("login landing", () => {
  it.each(["admin", "hq", "region", "country", "vendor", "website"] as const)("role %s without menu narrowing: legacy == api", async (role) => {
    s.profile = profile({ role, scopeAll: role === "admin" });
    const legacy = await landing("legacy");
    const api = await landing("api");
    expect(api).toBe(legacy);
    expect(api).toBe(`REDIRECT:/ko${defaultLandingFor(role)}`);
  });

  it("api: one /v1/auth/me with the token the sign-in returned, no profiles read, no cookie session read", async () => {
    s.profile = profile({ role: "hq" });
    await landing("api", "en");
    expect(s.auths).toEqual([`Bearer ${LOGIN_TOKEN}`]);
    expect(s.profileReads).toBe(0);
  });

  it("menu groups count on both sources (same rule as the locale root page)", async () => {
    // hmg-geo #329 (sync S1): legacy landing now derives the menu groups too (effectiveMenuGroups),
    // so both land on the first allowed menu instead of one the (dash) guard bounces to /no-access.
    s.profile = profile({ role: "hq", menuGroups: ["project"] });
    const legacy = await landing("legacy");
    const api = await landing("api");
    expect(api).toBe(`REDIRECT:/ko${defaultLandingFor("hq", ["project"])}`);
    expect(api).toBe("REDIRECT:/ko/projects");
    expect(legacy).toBe(api);
  });

  it("wrong password: {error:true} on both sources, nothing else called", async () => {
    s.profile = profile({ role: "hq" });
    s.signInError = new Error("Invalid login credentials");
    expect(await landing("legacy")).toBe('STATE:{"error":true}');
    expect(await landing("api")).toBe('STATE:{"error":true}');
    expect(s.auths).toEqual([]);
  });

  it("signed in but no account: legacy no profile == api 401 no_account -> /dashboard (the (dash) layout then finds no session)", async () => {
    s.profile = null;
    expect(await landing("legacy")).toBe("REDIRECT:/ko/dashboard");
    expect(await landing("api")).toBe("REDIRECT:/ko/dashboard");
  });

  it("api: sign-in without a session token -> /dashboard without calling the backend", async () => {
    s.profile = profile({ role: "hq" });
    s.token = null;
    expect(await landing("api")).toBe("REDIRECT:/ko/dashboard");
    expect(s.auths).toEqual([]);
  });

  it("api: backend failure is thrown (legacy: a failed profiles read was thrown too)", async () => {
    s.profile = profile({ role: "hq" });
    s.meStatus = 500;
    vi.stubEnv("HGH_SOURCE_SESSION", "api");
    await expect(login({}, form())).rejects.toMatchObject({ name: "HghApiError", status: 500, code: "internal" });
  });
});

describe("logout (unchanged: the backend is stateless)", () => {
  it("signs out and goes to /login", async () => {
    const f = new FormData();
    f.set("locale", "en");
    await expect(logout(f)).rejects.toThrow("REDIRECT:/en/login");
    expect(s.signOut).toBe(1);
  });
});
