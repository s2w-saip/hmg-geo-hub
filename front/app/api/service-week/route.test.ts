import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// GET /api/service-week: the shells read the service week again on a page or filter change and when the tab comes
// back (components/service-week/provider.tsx). A session gate, then a thin proxy to the screen shared/service-week
// (back/bff/screens/shared.py), never cached; the screen's failure status is handed on (503 = the BFF could not read
// the week and has none to fall back on). The page's site picks (a Website page's brand, geography, language and
// engine) go with it: the screen reads the site notes with them.

const st = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));

const { GET: get } = await import("./route");
const GET = (query = "") => get(new NextRequest(`http://localhost/api/service-week${query}`));

const WEEK = {
  state: "ok",
  week: { start: "2026-10-05", end: "2026-10-11", month: 10, nth: 2 },
  delay: { days: 22, threshold: 10, next: { start: "2026-10-12", end: "2026-10-18", month: 10, nth: 3 } },
  checkedAt: "2026-11-02T12:10:00+00:00",
  recordedAt: "2026-10-12T01:10:00+00:00",
  notes: [],
};
const seen: string[] = [];
let status = 200;

beforeEach(() => {
  seen.length = 0;
  status = 200;
  st.session = { user: { id: "u1", role: "country", scope: { all: false, countries: ["US"] }, menuGroups: null } };
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      seen.push(new URL(String(u)).pathname + new URL(String(u)).search);
      const body = status === 200 ? WEEK : { error: { code: "service_week_unavailable", message: "m", details: null } };
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("GET /api/service-week", () => {
  it("401 without a session, and the BFF is not asked", async () => {
    st.session = null;
    const r = await GET();
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: { code: "unauthenticated" } });
    expect(seen).toEqual([]);
  });

  it("hands the screen's answer on as it is, never cached", async () => {
    const r = await GET();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual(WEEK);
    expect(seen).toEqual(["/v1/screens/shared/service-week"]);
  });

  it("passes the page's site picks on (brand · geography · language · engine), nothing else of the query", async () => {
    // review r1-7 (2026-11-03): a Genesis page over July was told of Kia Italy's unpublished site; review r5-1: a German
    // page of an Italian and an English one
    const r = await GET("?brand=Genesis&geography=IT~US&time=2026-07-01..2026-07-31&language=en&engine=chatgpt~gemini&source=officialHmg");
    expect(r.status).toBe(200);
    expect(seen).toEqual(["/v1/screens/shared/service-week?brand=Genesis&engine=chatgpt%7Egemini&geography=IT%7EUS&language=en"]);
  });

  it("the screen's 503 stays a 503", async () => {
    status = 503;
    const r = await GET();
    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toMatchObject({ error: { code: "service_week_unavailable" } });
  });
});
