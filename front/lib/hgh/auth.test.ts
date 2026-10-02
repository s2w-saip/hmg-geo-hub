import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DynamicServerError } from "next/dist/client/components/hooks-server-context";

// react-server build so cache() (per-request token memo) really memoizes; see test/request-scope.ts.
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join: j } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(j(root, "cjs", "react.react-server.development.js"));
});

// Request cookies. `readOnly` = a server component (Next seals the store: set/delete throw).
const jar = vi.hoisted(() => ({ values: new Map<string, string>(), readOnly: false, deletes: [] as string[] }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name) } : undefined),
    delete: (name: string) => {
      if (jar.readOnly) throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
      jar.deletes.push(name);
    },
  }),
  headers: async () => new Headers(),
}));

// The Supabase server client (utils/supabase/server.ts), faked at its auth surface.
const sb = vi.hoisted(() => ({
  createThrows: false,
  createThrowsWith: null as unknown,
  claims: null as null | { sub: string },
  claimsError: null as null | Error,
  claimsThrowsOnce: false,
  accessToken: null as string | null,
  refreshToken: null as string | null,
  refreshError: null as null | Error,
  calls: { create: 0, getClaims: 0, getSession: 0, refresh: 0 },
}));
vi.mock("@/utils/supabase/server", () => ({
  createSupabaseServerClient: async () => {
    sb.calls.create += 1;
    if (sb.createThrowsWith !== null) throw sb.createThrowsWith;
    if (sb.createThrows) throw new Error("`cookies` was called outside a request scope");
    return {
      auth: {
        getClaims: async () => {
          sb.calls.getClaims += 1;
          if (sb.claimsThrowsOnce) {
            sb.claimsThrowsOnce = false;
            throw new TypeError("fetch failed");
          }
          if (sb.claimsError) return { data: null, error: sb.claimsError };
          return { data: sb.claims ? { claims: sb.claims } : null, error: null };
        },
        getSession: async () => {
          sb.calls.getSession += 1;
          return { data: { session: sb.accessToken ? { access_token: sb.accessToken } : null }, error: null };
        },
        refreshSession: async () => {
          sb.calls.refresh += 1;
          if (sb.refreshError) return { data: { session: null, user: null }, error: sb.refreshError };
          return { data: { session: sb.refreshToken ? { access_token: sb.refreshToken } : null, user: null }, error: null };
        },
      },
    };
  },
}));

const { withRequestScope } = await import("@/test/request-scope");
const auth = await import("./auth");
const { bindHghAuth, canWriteCookies, COOKIE_WRITE_PROBE, getAccessToken, isHghAuthBound, isTestRunner, qaCookieHeader, QA_COOKIE, readQaCookie, refreshAccessToken } =
  auth;
const { hghGet } = await import("./client");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const FRESH = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ2In0.bmV3";

let logSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  jar.values.clear();
  jar.readOnly = false;
  jar.deletes = [];
  sb.createThrows = false;
  sb.createThrowsWith = null;
  sb.claims = { sub: "11111111-0000-4000-8000-000000000002" };
  sb.claimsError = null;
  sb.claimsThrowsOnce = false;
  sb.accessToken = TOKEN;
  sb.refreshToken = FRESH;
  sb.refreshError = null;
  sb.calls = { create: 0, getClaims: 0, getSession: 0, refresh: 0 };
  logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  // Token values must never reach a log line, whatever the test did.
  for (const spy of logSpies) {
    for (const call of spy.mock.calls) {
      const text = call.map((a: unknown) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" ");
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(FRESH);
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  bindHghAuth(null);
});

describe("getAccessToken: Supabase cookie session (runtime default, no binding)", () => {
  it("verified session -> its access token; no load-order dependency (nothing bound)", async () => {
    expect(isHghAuthBound()).toBe(false);
    await expect(getAccessToken()).resolves.toBe(TOKEN);
    expect(sb.calls.getClaims).toBe(1);
    expect(sb.calls.getSession).toBe(1);
  });

  it("no session (no claims) -> null, getSession not needed", async () => {
    sb.claims = null;
    await expect(getAccessToken()).resolves.toBeNull();
    expect(sb.calls.getSession).toBe(0);
  });

  it("claims error (bad signature, JWKS failure) -> null, like the legacy getSession", async () => {
    sb.claimsError = Object.assign(new Error("Invalid JWT signature"), { __isAuthError: true });
    await expect(getAccessToken()).resolves.toBeNull();
  });

  it("verified once per request (React cache); a new request verifies again", async () => {
    await withRequestScope(async () => {
      await expect(getAccessToken()).resolves.toBe(TOKEN);
      await expect(getAccessToken()).resolves.toBe(TOKEN);
      await expect(Promise.all([getAccessToken(), getAccessToken()])).resolves.toEqual([TOKEN, TOKEN]);
    });
    expect(sb.calls.getClaims).toBe(1);
    await withRequestScope(() => getAccessToken());
    expect(sb.calls.getClaims).toBe(2);
  });

  it("a failed read is not memoized for the rest of the request", async () => {
    sb.claimsThrowsOnce = true;
    await withRequestScope(async () => {
      await expect(getAccessToken()).rejects.toThrow("fetch failed");
      await expect(getAccessToken()).resolves.toBe(TOKEN);
    });
    expect(sb.calls.getClaims).toBe(2);
  });

  it("outside a request / Supabase env unset -> 500 auth_unbound (never anonymous)", async () => {
    sb.createThrows = true;
    await expect(getAccessToken()).rejects.toMatchObject({ status: 500, code: "auth_unbound" });
  });

  it("Next's dynamic-usage signal from cookies() passes through untouched (static prerender marks the page dynamic)", async () => {
    // 2026-09-30 stg build: swallowing it turned /ko's prerender into auth_unbound and failed the build.
    const signal = new DynamicServerError("Route /ko couldn't be rendered statically because it used `cookies`.");
    sb.createThrowsWith = signal;
    await expect(getAccessToken()).rejects.toBe(signal);
  });

  it("a malformed token is rejected before it can reach a header", async () => {
    sb.accessToken = "Bearer x\r\nInjected: 1";
    await expect(getAccessToken()).rejects.toMatchObject({ status: 500, code: "client_config" });
  });
});

describe("refreshAccessToken: route handlers and server actions only", () => {
  it("writable cookies (route handler / action) -> one Supabase refresh, new token used for the rest of the request", async () => {
    await withRequestScope(async () => {
      await expect(getAccessToken()).resolves.toBe(TOKEN);
      await expect(refreshAccessToken()).resolves.toBe(FRESH);
      await expect(getAccessToken()).resolves.toBe(FRESH);
    });
    expect(sb.calls.refresh).toBe(1);
    expect(jar.deletes).toEqual([COOKIE_WRITE_PROBE]);
  });

  it("server component (read-only cookies) -> no explicit refresh: null, Supabase not called (no lost refresh-token rotation)", async () => {
    jar.readOnly = true;
    await expect(canWriteCookies()).resolves.toBe(false);
    await expect(refreshAccessToken()).resolves.toBeNull();
    expect(sb.calls.refresh).toBe(0);
    expect(sb.calls.create).toBe(0);
  });

  it("refresh refused by Supabase (expired refresh token) -> null", async () => {
    sb.refreshError = new Error("Invalid Refresh Token");
    await expect(refreshAccessToken()).resolves.toBeNull();
    expect(sb.calls.refresh).toBe(1);
  });
});

describe("client integration (lib/hgh/client uses these without any binding)", () => {
  const BASE = "https://api.hgh.test";
  const seen: Headers[] = [];
  const respond = (...rs: Array<() => Response>) => {
    let i = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit = {}) => {
        seen.push(new Headers(init.headers));
        return rs[Math.min(i++, rs.length - 1)]();
      }),
    );
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const me = () => json(200, { data: { user_id: "u" }, meta: { mode: "session" } });
  const expired = () => json(401, { error: { code: "token_expired", message: "m", details: null } });

  beforeEach(() => {
    seen.length = 0;
    vi.stubEnv("HGH_API_BASE_URL", BASE);
  });

  it("Bearer comes from the Supabase session", async () => {
    respond(me);
    await hghGet("/v1/auth/me", { dedupe: false });
    expect(seen[0].get("Authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("no session token -> local 401 unauthenticated, nothing sent (pages map it to /login)", async () => {
    sb.claims = null;
    respond(me);
    await expect(hghGet("/v1/auth/me", { dedupe: false })).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(seen).toHaveLength(0);
  });

  it("401 token_expired + retryOn401 in a writable context -> refresh once, retried with the new token", async () => {
    respond(expired, me);
    await hghGet("/v1/auth/me", { dedupe: false, retryOn401: true });
    expect(seen.map((h) => h.get("Authorization"))).toEqual([`Bearer ${TOKEN}`, `Bearer ${FRESH}`]);
  });

  it("401 token_expired + retryOn401 in a server component -> no refresh, the 401 surfaces (login)", async () => {
    jar.readOnly = true;
    respond(expired, me);
    await expect(hghGet("/v1/auth/me", { dedupe: false, retryOn401: true })).rejects.toMatchObject({ status: 401, code: "token_expired" });
    expect(seen).toHaveLength(1);
    expect(sb.calls.refresh).toBe(0);
  });
});

describe("test seam (bindHghAuth)", () => {
  it("a bound provider wins over the Supabase session; unbinding restores it", async () => {
    bindHghAuth({ getAccessToken: async () => FRESH });
    expect(isHghAuthBound()).toBe(true);
    await expect(getAccessToken()).resolves.toBe(FRESH);
    await expect(refreshAccessToken()).resolves.toBeNull();
    expect(sb.calls.create).toBe(0);
    bindHghAuth({ getAccessToken: async () => null, refreshAccessToken: async () => TOKEN });
    await expect(getAccessToken()).resolves.toBeNull();
    await expect(refreshAccessToken()).resolves.toBe(TOKEN);
    bindHghAuth(null);
    await expect(getAccessToken()).resolves.toBe(TOKEN);
  });

  it("refused outside a test runner (production can never run on an injected token)", () => {
    expect(isTestRunner({ VITEST: "true" })).toBe(true);
    expect(isTestRunner({ NODE_ENV: "test" })).toBe(true);
    expect(isTestRunner({ NODE_ENV: "production" })).toBe(false);
    expect(isTestRunner({ NODE_ENV: "development" })).toBe(false);
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => bindHghAuth({ getAccessToken: async () => TOKEN })).toThrow(expect.objectContaining({ status: 500, code: "client_config" }));
    expect(() => bindHghAuth(null)).not.toThrow();
  });

  it("a malformed bound token is rejected too", async () => {
    bindHghAuth({ getAccessToken: async () => "a b" });
    await expect(getAccessToken()).rejects.toMatchObject({ code: "client_config" });
  });
});

describe("QA cookie", () => {
  it("same cookie name as today; header only for signed-cookie charset values", () => {
    expect(QA_COOKIE).toBe("raw_data_qa");
    expect(qaCookieHeader("eyJzZXNzaW9uSWQiOiJ4In0.abc_DEF-123")).toBe("raw_data_qa=eyJzZXNzaW9uSWQiOiJ4In0.abc_DEF-123");
    expect(qaCookieHeader("a; other=1")).toBeNull();
    expect(qaCookieHeader("a\r\nb")).toBeNull();
    expect(qaCookieHeader("")).toBeNull();
    expect(qaCookieHeader(null)).toBeNull();
  });

  it("readQaCookie reads the request cookie and drops malformed values", async () => {
    await expect(readQaCookie()).resolves.toBeNull();
    jar.values.set("raw_data_qa", "abc.def");
    await expect(readQaCookie()).resolves.toBe("abc.def");
    jar.values.set("raw_data_qa", "abc def");
    await expect(readQaCookie()).resolves.toBeNull();
  });
});
