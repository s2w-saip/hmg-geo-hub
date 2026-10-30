import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// Renewal Overview (/renewal/dashboard): the body's screens leave with the filter panel's read, not after
// it (the body does not use the panel options; awaiting them first held every section back by that read),
// and the sections render from those same requests. The server sections are resolved here; client
// components are not rendered (their props are inspected).

const st = vi.hoisted(() => ({
  calls: [] as { name: string; query: Record<string, unknown> }[],
  holdFilters: false,
  failMatrix: false,
  savedPages: [] as string[],
}));
vi.mock("@/i18n/navigation", () => ({ Link: () => null, usePathname: () => "/", useRouter: () => ({}) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({}), useSearchParams: () => new URLSearchParams(), notFound: () => { throw new Error("nf"); }, redirect: () => { throw new Error("rd"); } }));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (k: string) => k,
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({
    user: { id: "u1", email: "x", role: "admin", scope: { all: true }, operator: "none", menuGroups: null },
  }),
}));
// The account's saved filters, read with the filter options (HUB operations store; per request cookies).
vi.mock("../_components/saved-filters-server", () => ({
  loadSavedFilters: async (page: string) => {
    st.savedPages.push(page);
    return [{ id: "a", name: "독일", query: "geography=DE", isDefault: true }];
  },
}));
vi.mock("@/lib/screen", () => ({
  screenGet: (name: string, query: Record<string, unknown>) => {
    st.calls.push({ name, query });
    switch (name) {
      case "overview/filters":
        return st.holdFilters
          ? new Promise(() => {})
          : Promise.resolve({ catalogRows: [], geographyOptions: ["US"], languageOptions: [], optionMatrix: [],
              collectionStartDay: null, latestAnchorDay: "2026-10-05", selectableDates: [] });
      case "overview/as-of":
        return Promise.resolve({ asOf: "2026-10-05" });
      case "overview/cards":
        return Promise.resolve({ state: "ok", cards: [{ key: "visibility" }], compareTitle: null });
      case "overview/card-trend":
        return Promise.resolve({ degraded: false, cards: {}, count: 1 });
      case "overview/card-competitors":
        return Promise.resolve({ degraded: [], rows: {}, standing: {} });
      case "overview/geo":
        return Promise.resolve({ geo: null, degraded: false });
      case "overview/brand-matrix":
        // a transient failure (timeout) of the brand table's screen
        return st.failMatrix ? Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })) : Promise.resolve({ screen: name });
      default:
        return Promise.resolve({ screen: name });
    }
  },
}));

const Page = (await import("./page")).default;

const SERVER_SECTIONS = new Set(["RenewalOverview", "OverviewSection"]);
const BODY_SCREENS = ["overview/cards", "overview/card-trend", "overview/card-competitors", "overview/brand-matrix", "overview/geo"];

/** Walk the tree, resolving the page's own server sections; collect client component props by name. */
async function collect(node: unknown): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const queue: unknown[] = [node];
  while (queue.length) {
    const n = queue.shift();
    if (Array.isArray(n)) {
      queue.push(...n);
      continue;
    }
    if (!isValidElement(n)) continue;
    const el = n as ReactElement<Record<string, unknown>>;
    const name = typeof el.type === "string" ? el.type : ((el.type as { name?: string }).name ?? "");
    if (SERVER_SECTIONS.has(name)) {
      queue.push(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
      continue;
    }
    if (name && typeof el.type !== "string") out.set(name, el.props);
    for (const [k, v] of Object.entries(el.props)) if (k !== "children" && (isValidElement(v) || Array.isArray(v))) queue.push(v);
    queue.push(el.props.children);
  }
  return out;
}

const render = (sp: Record<string, string>) => Page({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve(sp) });

beforeEach(() => {
  st.calls = [];
  st.holdFilters = false;
  st.failMatrix = false;
  st.savedPages = [];
});

describe("renewal overview page", () => {
  it("issues the body's screens without waiting for the filter options", async () => {
    st.holdFilters = true;
    await render({ geography: "US" });
    await Promise.resolve();
    expect(st.calls.map((c) => c.name)).toEqual(expect.arrayContaining(BODY_SCREENS));
  });

  it("renders the sections from those requests, one per screen", async () => {
    const got = await collect(await render({ geography: "US" }));
    const counts: Record<string, number> = {};
    for (const c of st.calls) counts[c.name] = (counts[c.name] ?? 0) + 1;
    expect(counts).toEqual({ "overview/as-of": 1, "overview/filters": 1, ...Object.fromEntries(BODY_SCREENS.map((n) => [n, 1])) });
    const query = (name: string) => st.calls.find((c) => c.name === name)!.query;
    expect(query("overview/card-competitors")).toEqual({ geography: "US", "ctx.view": "renewal" });
    expect(query("overview/geo")).toEqual({ geography: "US", "ctx.locale": "ko" });
    const body = got.get("RnOverviewBody")!;
    expect(body.cards).toEqual([{ key: "visibility" }]);
    const deferred = body.deferred as Record<string, Promise<unknown>>;
    expect(await deferred.trend).toEqual({ degraded: false, cards: {}, count: 1 });
    expect(await deferred.matrix).toEqual({ screen: "overview/brand-matrix" });
    expect(await (body.geo as Promise<unknown>)).toEqual({ geo: null, degraded: false });
    expect(st.savedPages).toEqual(["overview"]);
    expect(got.get("RnOverviewFilters")!.savedFilters).toEqual({
      page: "overview",
      userId: "u1",
      initial: [{ id: "a", name: "독일", query: "geography=DE", isDefault: true }],
    });
  });

  // Gold metric review ⚠️ Overview #31: a transient failure of the brand table emptied it to null and the card
  // vanished without a word; it now reaches the body as "failed" (the body shows the failure notice).
  it("hands a failed brand table on as failed, not as no table", async () => {
    st.failMatrix = true;
    const got = await collect(await render({}));
    const deferred = got.get("RnOverviewBody")!.deferred as Record<string, Promise<unknown>>;
    expect(await deferred.matrix).toBe("failed");
  });
});
