/**
 * `GET /api/website/prompts/export` on the backend API source (HGH_SOURCE_G3=api, unit U8).
 *
 * The legacy contract (route.test.ts) stays as is. Here: the 3-argument gate runs before the
 * relay (U4 F1 scar: no backend call for a forbidden user), the query the route sends is the
 * page's derivation (readWebsitePromptQuery, scope injection stripped, cursor and page dropped),
 * the xlsx body is streamed as is with only Content-Disposition replaced by the legacy file name,
 * and upstream errors keep their status with a JSON body and no attachment header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/types";

const getSession = vi.hoisted(() => vi.fn());
const listWebsitePromptsForExport = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/session", () => ({ getSession }));
vi.mock("@/lib/db/repositories/website-sites", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/repositories/website-sites")>()),
  listWebsitePromptsForExport,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/lib/scope/server", () => ({}));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { XLSX_ACCEPT } = await import("@/lib/hgh/adapters/catalog");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]);

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

const seen: { url: URL; headers: Headers }[] = [];
let upstream: () => Response;

const call = async (qs = "") => {
  const { GET } = await import("./route");
  return GET(new Request(`http://t/api/website/prompts/export${qs}`) as never);
};

beforeEach(() => {
  seen.length = 0;
  getSession.mockReset();
  listWebsitePromptsForExport.mockReset();
  vi.stubEnv("HGH_SOURCE_G3", "api");
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  upstream = () =>
    new Response(BYTES, {
      status: 200,
      headers: {
        "content-type": XLSX_ACCEPT,
        "content-disposition": 'attachment; filename="prompts-website.xlsx"',
        "cache-control": "no-store",
        "x-export-truncated": "true",
      },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string, init?: RequestInit) => {
      seen.push({ url: new URL(String(u)), headers: new Headers(init?.headers) });
      return upstream();
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const kstToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

describe("export on the API source: the gate comes first", () => {
  it("no session: 401, no backend call", async () => {
    getSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("role without the route (vendor): 403, no backend call", async () => {
    getSession.mockResolvedValue(session({ role: "vendor", scope: { all: false, brands: ["Kia"] } }));
    expect((await call()).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("menu groups without website: 403, no backend call", async () => {
    getSession.mockResolvedValue(session({ role: "hq", menuGroups: ["standard"] }));
    expect((await call()).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("menu groups with website: relayed", async () => {
    getSession.mockResolvedValue(session({ role: "hq", menuGroups: ["standard", "website"], scope: { all: false, brands: ["Kia"] } }));
    expect((await call()).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(listWebsitePromptsForExport).not.toHaveBeenCalled();
  });
});

describe("export on the API source: request and response", () => {
  it("admin: the screen filters, sort and dir; cursor, page and limit dropped; xlsx screen columns in the chosen locale", async () => {
    getSession.mockResolvedValue(session());
    const res = await call("?geography=US&geography=DE&engine=gemini&q=%20ev%20&sort=prompt&dir=asc&page=3&cursor=abc&locale=en");
    const q = seen[0].url.searchParams;
    expect(seen[0].url.pathname).toBe("/v1/prompts");
    expect(q.getAll("country")).toEqual(["DE", "US"]);
    expect(q.getAll("engine")).toEqual(["gemini"]);
    expect([q.get("search"), q.get("sort"), q.get("dir")]).toEqual(["ev", "prompt", "asc"]);
    expect([q.get("surface"), q.get("format"), q.get("columns"), q.get("locale")]).toEqual(["website", "xlsx", "screen", "en"]);
    expect([q.has("cursor"), q.has("page"), q.has("limit")]).toEqual([false, false, false]);
    expect(seen[0].headers.get("accept")).toBe(XLSX_ACCEPT);
    expect(seen[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(XLSX_ACCEPT);
    expect(res.headers.get("x-export-truncated")).toBe("true");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // the legacy name rule (<stem>-YYYY-MM-DD.xlsx, KST), not the backend's prompts-website.xlsx
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain(`exportFilename-${kstToday()}.xlsx`);
    expect(cd).not.toContain("prompts-website");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES);
    expect(listWebsitePromptsForExport).not.toHaveBeenCalled();
  });

  it("an unknown locale falls back to the default (ko); a bad sort to last measured desc", async () => {
    getSession.mockResolvedValue(session());
    await call("?locale=fr&sort=nope");
    const q = seen[0].url.searchParams;
    expect([q.get("locale"), q.get("sort"), q.get("dir")]).toEqual(["ko", "last_measured", "desc"]);
  });

  it("non-admin: the brand lock and the whole scope country set are not sent (the backend applies the account scope)", async () => {
    getSession.mockResolvedValue(session({ role: "country", scope: { all: false, brands: ["Kia"], countries: ["IT"] } }));
    await call("?brand=Hyundai");
    const q = seen[0].url.searchParams;
    expect(q.getAll("brand")).toEqual([]);
    expect(q.getAll("country")).toEqual([]);
  });

  for (const [status, code] of [
    [403, "menu_forbidden"],
    [422, "invalid_filter"],
    [503, "unavailable"],
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

  it("the legacy source is the default: without the flag the repository is used and the backend is not called", async () => {
    vi.stubEnv("HGH_SOURCE_G3", "");
    getSession.mockResolvedValue(session());
    listWebsitePromptsForExport.mockResolvedValue({ rows: [], truncated: false });
    const res = await call();
    expect(res.status).toBe(200);
    expect(listWebsitePromptsForExport).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(0);
  });
});
