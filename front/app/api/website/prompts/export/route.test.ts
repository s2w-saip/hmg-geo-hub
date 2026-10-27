/**
 * `GET /api/website/prompts/export` — the gate and the relay contract.
 *
 * The filter/sort/search derivation lives in the API (screen website/prompts-export,
 * back/bff/screens/website_prompts.py; its rules are tested in
 * back/bff/tests/test_screens_website_prompts.py). This route only gates the user, passes the
 * page's URL params through with the locale and the admin flag, streams the answer and replaces
 * Content-Disposition with the legacy file name (<stem>-YYYY-MM-DD.xlsx, KST).
 *
 * Half of the reason for this test is **menuGroups**: `canAccessRoute` without its 3rd argument
 * makes `groupAllowed` return true (lib/auth/route-policy.ts), silently disabling the per-account
 * menu whitelist. Route handlers have no DashLayout above them, so this is the only gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/types";

const getSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({ getSession }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));

const BYTES = new Uint8Array([0x7b, 0x7d]);

const session = (over: Partial<Session["user"]> = {}): Session => ({
  user: {
    id: "u1",
    email: "u@hmg.test",
    role: "admin",
    scope: { all: true },
    operator: "none",
    menuGroups: null,
    ...over,
  },
});

const seen: URL[] = [];
let upstream: () => Response;

const call = async (qs = "") => {
  const { GET } = await import("./route");
  return GET(new Request(`http://t/api/website/prompts/export${qs}`) as never);
};

const kstToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

beforeEach(() => {
  seen.length = 0;
  getSession.mockReset();
  vi.stubEnv("HGH_API_BASE_URL", "http://127.0.0.1:18091");
  upstream = () =>
    new Response(BYTES, {
      status: 200,
      headers: { "content-type": "application/json", "x-export-truncated": "true" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string | URL) => {
      seen.push(new URL(String(u)));
      return upstream();
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/website/prompts/export — gate (no API call when refused)", () => {
  it("no session: 401", async () => {
    getSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("a role without the route (vendor): 403", async () => {
    getSession.mockResolvedValue(session({ role: "vendor", scope: { all: false, brands: ["Kia"] } }));
    expect((await call()).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("menu groups without website: 403 (fails if the 3rd canAccessRoute argument is dropped)", async () => {
    getSession.mockResolvedValue(session({ role: "hq", menuGroups: ["standard"] }));
    expect((await call()).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("menu groups with website: relayed", async () => {
    getSession.mockResolvedValue(session({ role: "hq", menuGroups: ["standard", "website"] }));
    expect((await call()).status).toBe(200);
    expect(seen).toHaveLength(1);
  });
});

describe("GET /api/website/prompts/export — relay", () => {
  it("passes the URL params through (repeated keys kept) with the locale and the admin flag", async () => {
    getSession.mockResolvedValue(session());
    await call("?geography=US&geography=DE&engine=gemini&q=%20ev%20&sort=prompt&dir=asc&page=3&cursor=abc&locale=en");
    const url = seen[0];
    expect(url.pathname).toBe("/v1/screens/website/prompts-export");
    expect(url.searchParams.getAll("geography")).toEqual(["US", "DE"]);
    expect([url.searchParams.get("q"), url.searchParams.get("sort"), url.searchParams.get("dir")]).toEqual([" ev ", "prompt", "asc"]);
    expect([url.searchParams.get("ctx.locale"), url.searchParams.get("ctx.admin")]).toEqual(["en", "true"]);
  });

  it("an unknown locale falls back to the default (ko); a non-admin sends admin=false", async () => {
    getSession.mockResolvedValue(session({ role: "country", scope: { all: false, brands: ["Kia"], countries: ["IT"] } }));
    await call("?locale=fr");
    expect([seen[0].searchParams.get("ctx.locale"), seen[0].searchParams.get("ctx.admin")]).toEqual(["ko", "false"]);
  });

  it("streams the body as is with the legacy file name and no-store", async () => {
    getSession.mockResolvedValue(session());
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-export-truncated")).toBe("true");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain(`exportFilename-${kstToday()}.xlsx`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
  });

  for (const [status, code] of [
    [422, "invalid_value"],
    [503, "source_unavailable"],
  ] as const) {
    it(`upstream ${status} ${code}: same status, JSON error code, no attachment header`, async () => {
      getSession.mockResolvedValue(session());
      upstream = () => new Response(JSON.stringify({ error: { code, message: "x" } }), { status, headers: { "content-type": "application/json" } });
      const res = await call();
      expect(res.status).toBe(status);
      expect(res.headers.get("content-disposition")).toBeNull();
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    });
  }
});
