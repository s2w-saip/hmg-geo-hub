import type { Page, Request } from "@playwright/test";

// Empty contract responses for browser tests only. No runtime sample accounts or measurements.
export const week = { state: "ok", week: { start: "2026-11-02", end: "2026-11-08", month: 11, nth: 1 }, delay: null, checkedAt: null, recordedAt: null, notes: [], rounds: { global: true, website: true } };
const catalog = { rows: [], total: 0, count: 0, offset: 0, limit: 25, page: 1, pages: 0, rangeFrom: 0, rangeTo: 0, facets: { listType: [], depth1: [], depth2: [], depth3: [], depth4: [], funnel: [], lang: [], market: [], marketSort: [], presence: [], kind: [], status: [] }, columns: [], collation: "ko" };
export type Reply = { body: unknown; status?: number };
export async function mockHub(page: Page, override?: (url: URL, request: Request) => Reply | undefined | Promise<Reply | undefined>) {
  const requests: string[] = [], errors: string[] = [], unhandled: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (/uncached promise|async Client Component|cannot update a component while rendering|In HTML,/i.test(message.text())) errors.push(message.text()); });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (!path.startsWith("/api/")) return route.continue();
    requests.push(path);
    let reply = await override?.(url, route.request());
    if (!reply) {
      let body: unknown;
      if (path === "/api/hub/session") body = { user: { id: "test-admin", login: "test-admin", email: null, displayName: null, role: "admin", scope: { all: true }, mustChangePassword: false } };
      else if (path === "/api/hub/saved-filters") body = { data: { items: [] } };
      else if (path === "/api/hub/accounts") body = { data: { items: [], roles: ["hq", "region", "country"] } };
      else if (path.endsWith("/service-week")) body = week;
      else if (path === "/api/screens/overview/filters") body = { catalogRows: [], geographyOptions: [], languageOptions: [], engineOptions: [], optionMatrix: [], selectableDates: [], collectionStartDay: null, latestAnchorDay: null };
      else if (path === "/api/screens/overview/cards") body = { state: "empty" };
      else if (["overview/card-trend", "overview/brand-matrix", "overview/geo"].some(name => path === `/api/screens/${name}`)) body = null;
      else if (path === "/api/screens/overview/as-of") body = { asOf: null };
      else if (path.endsWith("/prompts-page") || path === "/api/standard/prompts/page") body = { ...catalog, collation: url.searchParams.get("collation") ?? "ko" };
      else if (path.endsWith("/prompts-header")) body = { period: null };
      else if (path.endsWith("/prompts-history")) body = { available: false, shown: 0, groups: [] };
      else if (path.endsWith("/panel-options")) body = { geographyOptions: [], languageOptions: [], catalogRows: [], engineOptions: [] };
      else if (path.endsWith("/filter-dates")) body = { selectableDates: [], collectionStartDay: null, latestAnchorDay: null };
      else if (path.endsWith("/rn-page")) body = { ownLabel: "HMG", period: null };
      else if (path.endsWith("/rn-asof")) body = { asOf: "2026-11-05" };
      else if (path.endsWith("/rn-shell")) body = { measured: false, degraded: false, ownBrands: [], ownSum: [], drawer: [] };
      else if (/\/api\/screens\/mention\/rn-(compare|rate-value|rate-hero|rate-engines|rate-types|favor-hero|favor-dist|favor-matrix|rank|bump|ranking|engine-extra|presence-split)$/.test(path)) body = null;
      else { unhandled.push(path); return route.fulfill({ status: 404, contentType: "application/json", body: '{"error":{"code":"unexpected_test_request"}}' }); }
      reply = { body };
    }
    return route.fulfill({ status: reply.status ?? 200, contentType: "application/json", body: JSON.stringify(reply.body) });
  });
  return { requests, errors, unhandled };
}
