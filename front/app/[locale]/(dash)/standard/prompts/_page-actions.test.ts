import { beforeEach, describe, expect, it, vi } from "vitest";

// First-page server action of both prompt catalog lists (_page-actions.ts loadCatalogPage).
//   B077  the admin list's server render also reads in the browser's collation (Accept-Language), like the
//         standard list (P9), so prompt-list.tsx's rereadAfterHydration finds no difference and skips the
//         hydration reread; an explicit collation from the client is kept; outside a request: "en" as before.

const h = vi.hoisted(() => ({
  acceptLanguage: "ko-KR,ko;q=0.9" as string | null,
  noRequest: false,
  api: false,
  legacy: [] as Array<{ admin: boolean; collation: string }>,
  posts: [] as Array<{ path: string; body: Record<string, unknown> }>,
}));
vi.mock("next/headers", () => ({
  headers: async () => {
    if (h.noRequest) throw new Error("headers() outside a request");
    return new Headers(h.acceptLanguage == null ? {} : { "accept-language": h.acceptLanguage });
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => ({ user: { role: "hq", menuGroups: null, scope: { kind: "all" } } }) }));
vi.mock("@/lib/auth/route-policy", () => ({ canAccessRoute: () => true }));
vi.mock("@/lib/hgh/adapters/admin", () => ({ isAdminApi: () => h.api }));
vi.mock("@/lib/hgh/adapters/filters", () => ({ isAnalysisApi: () => h.api }));
vi.mock("@/lib/db/repositories/catalog-page", () => ({
  readCatalogPage: async (_scope: unknown, query: { collation: string }, admin: boolean) => {
    h.legacy.push({ admin, collation: query.collation });
    return { rows: [], total: 0, offset: 0, limit: 200, count: 0, facets: {}, columns: {}, stats: null };
  },
  readCatalogRows: async () => ({ rows: [], total: 0, offset: 0, limit: 50 }),
}));
vi.mock("@/lib/hgh/client", () => ({
  hghPost: async (path: string, init: { body: Record<string, unknown> }) => {
    h.posts.push({ path, body: init.body });
    return { data: { rows: [], total: 0, offset: 0, limit: 200, count: 0, facets: {}, columns: {}, stats: null } };
  },
}));

const { loadCatalogPage } = await import("./_page-actions");

beforeEach(() => {
  h.acceptLanguage = "ko-KR,ko;q=0.9";
  h.noRequest = false;
  h.api = false;
  h.legacy.length = 0;
  h.posts.length = 0;
});

describe("loadCatalogPage collation", () => {
  it.each([true, false])("legacy admin=%s: Korean browser → first page read and returned in ko", async admin => {
    const page = await loadCatalogPage(admin, { limit: 200 });
    expect(h.legacy).toEqual([{ admin, collation: "ko" }]);
    expect(page.collation).toBe("ko");
  });

  it.each([true, false])("api admin=%s: Korean browser → screen body collation ko, row_fields unchanged", async admin => {
    h.api = true;
    const page = await loadCatalogPage(admin, { limit: 200 });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].path).toBe(admin ? "/v1/admin/catalog/prompts/screen" : "/v1/prompts/screen");
    expect(h.posts[0].body).toMatchObject({ collation: "ko", include_meta: true, row_fields: admin ? "full" : "list" });
    expect(page.collation).toBe("ko");
  });

  it("other browsers read in en (the former admin default)", async () => {
    h.acceptLanguage = "en-US,en;q=0.9";
    expect((await loadCatalogPage(true, { limit: 200 })).collation).toBe("en");
    h.acceptLanguage = null;
    expect((await loadCatalogPage(true, { limit: 200 })).collation).toBe("en");
    expect(h.legacy.map(q => q.collation)).toEqual(["en", "en"]);
  });

  it("an explicit collation from the client is kept", async () => {
    await loadCatalogPage(true, { limit: 200, collation: "en" });
    expect(h.legacy).toEqual([{ admin: true, collation: "en" }]);
  });

  it("outside a request falls back to en", async () => {
    h.noRequest = true;
    expect((await loadCatalogPage(true, { limit: 200 })).collation).toBe("en");
  });
});
