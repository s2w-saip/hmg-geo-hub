import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// HUB login (2026-10-27): the BFF client, the session that turns the local reader into the top-level
// administrator, the cookie options and the login's return path.

const jar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "hgh_hub_session" && jar.token ? { name, value: jar.token } : undefined) }),
  headers: async () => new Headers(),
}));

const { hubFetch, hubMe } = await import("./client");
const { hubAdminUser } = await import("./session");
const { hubCookieOptions } = await import("./cookie");
const { hubLoginNext } = await import("./next-path");
const { getSession } = await import("@/lib/auth/session");

const USER = { id: "8f6f0c1e-2b7a-4c1e-9d2a-1b2c3d4e5f60", login: "admin", email: null, displayName: "Admin", role: "admin" };
const calls: Array<{ url: string; init: RequestInit }> = [];

function answer(status: number, body: unknown) {
  return vi.fn(async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
}

beforeEach(() => {
  vi.stubEnv("HGH_API_BASE_URL", "http://127.0.0.1:5555");
  vi.stubEnv("HGH_LOCAL_READ_ONLY", "1");
  calls.length = 0;
  jar.token = undefined;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hubFetch", () => {
  it("sends the bearer token and JSON body to the BFF", async () => {
    vi.stubGlobal("fetch", answer(200, { data: { ok: true } }));
    await hubFetch("PUT", "/v1/hub/global-prompts/abc", { token: "tok", body: { text: "x" } });
    expect(calls[0].url).toBe("http://127.0.0.1:5555/v1/hub/global-prompts/abc");
    expect(calls[0].init.method).toBe("PUT");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(calls[0].init.body).toBe('{"text":"x"}');
  });

  it("turns the error envelope into HghApiError with code and details", async () => {
    vi.stubGlobal("fetch", answer(409, { error: { code: "version_conflict", message: "reload", details: { currentVersion: 3 } } }));
    await expect(hubFetch("GET", "/v1/hub/global-prompts")).rejects.toMatchObject({ status: 409, code: "version_conflict", details: { currentVersion: 3 } });
  });

  it("only reaches the HUB paths", async () => {
    for (const path of ["/v1/screens/overview", "/v1/hub/../prompts", "http://evil.test/v1/hub/x", "/v1/hub/global-prompts?x=1"]) {
      await expect(hubFetch("GET", path)).rejects.toThrow(TypeError);
    }
  });
});

describe("HUB session", () => {
  it("hubMe: null when the BFF refuses the token, thrown otherwise", async () => {
    vi.stubGlobal("fetch", answer(401, { error: { code: "unauthorized", message: "x" } }));
    expect(await hubMe("t")).toBeNull();
    vi.stubGlobal("fetch", answer(503, { error: { code: "source_unavailable", message: "x" } }));
    await expect(hubMe("t")).rejects.toMatchObject({ status: 503 });
  });

  it("no cookie: no BFF call, no administrator, no session (the local mode needs the login)", async () => {
    const fetch = answer(200, { data: { user: USER } });
    vi.stubGlobal("fetch", fetch);
    expect(await hubAdminUser()).toBeNull();
    expect(await getSession()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a valid cookie makes the local session the administrator; a refused or unreachable one is no session", async () => {
    jar.token = "tok";
    vi.stubGlobal("fetch", answer(200, { data: { user: USER } }));
    expect((await getSession())?.user).toEqual({ id: USER.id, email: "admin", role: "admin", scope: { all: true }, operator: "none", menuGroups: null });
    vi.stubGlobal("fetch", answer(401, { error: { code: "unauthorized", message: "x" } }));
    expect(await getSession()).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getSession()).toBeNull();
  });
});

describe("cookie and return path", () => {
  it("cookie: httpOnly, this site only, until the token expires (or cleared)", () => {
    expect(hubCookieOptions(false, 1_800_000_000)).toEqual({ httpOnly: true, sameSite: "strict", secure: false, path: "/", expires: new Date(1_800_000_000_000) });
    expect(hubCookieOptions(true)).toEqual({ httpOnly: true, sameSite: "strict", secure: true, path: "/", maxAge: 0 });
  });

  it("returns only to a path of this site under the locale", () => {
    const fallback = "/ko/renewal/dashboard";
    expect(hubLoginNext("/ko/renewal/dashboard?x=1", "ko")).toBe("/ko/renewal/dashboard?x=1");
    for (const bad of [undefined, ["/ko/a"], "https://evil.test/ko/", "//evil.test/ko/", "/ko//evil.test", "/en/renewal", "/ko/\\evil", "ko/x"]) {
      expect(hubLoginNext(bad, "ko"), String(bad)).toBe(fallback);
    }
  });
});
