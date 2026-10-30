import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// Renewal Website Overview (/renewal/website, W1): the body's website screens leave with the filter panel's read,
// every screen carries ctx.admin (the brand axis is an administrator's only), the panel shows the website axes and
// its own saved filters, and a transient failure of a section's screen becomes that section's notice. The server
// sections are resolved here; client components are not rendered (their props are inspected).

const st = vi.hoisted(() => ({
  calls: [] as { name: string; query: Record<string, unknown> }[],
  holdFilters: false,
  fail: new Set<string>(),
  summary: { state: "ok", tiles: { groups: [], suppressionCaption: null } } as unknown,
  savedPages: [] as string[],
  role: "admin",
}));
vi.mock("@/i18n/navigation", () => ({ Link: () => null, usePathname: () => "/", useRouter: () => ({}) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({}), useSearchParams: () => new URLSearchParams(), notFound: () => { throw new Error("nf"); }, redirect: () => { throw new Error("rd"); } }));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (k: string) => k,
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({
    user: { id: "u1", email: "x", role: st.role, scope: st.role === "admin" ? { all: true } : { all: false, brands: ["Kia"] }, operator: "none", menuGroups: null },
  }),
}));
vi.mock("../_components/saved-filters-server", () => ({
  loadSavedFilters: async (page: string) => {
    st.savedPages.push(page);
    return [];
  },
}));
const timeout = () => Object.assign(new Error("timeout"), { name: "TimeoutError" });
vi.mock("@/lib/screen", () => ({
  screenGet: (name: string, query: Record<string, unknown>) => {
    st.calls.push({ name, query });
    if (st.fail.has(name)) return Promise.reject(timeout());
    switch (name) {
      case "overview/filters":
        return st.holdFilters
          ? new Promise(() => {})
          : Promise.resolve({ geographyOptions: ["US"], languageOptions: ["en"], optionMatrix: [], collectionStartDay: null, latestAnchorDay: "2026-10-09", selectableDates: [] });
      case "overview/as-of":
        return Promise.resolve({ asOf: "2026-10-09" });
      case "website/summary":
        return Promise.resolve(st.summary);
      case "website/summary-deferred":
        return Promise.resolve({ state: "ok", tiles: { groups: [{ category: "content", tiles: [] }], suppressionCaption: null } });
      default:
        return Promise.resolve({ screen: name });
    }
  },
}));

const Page = (await import("./page")).default;

const SERVER_SECTIONS = new Set(["RenewalWebsiteOverview", "OverviewSection"]);
const BODY_SCREENS = ["website/summary", "website/summary-deferred", "website/brands", "website/engines", "website/trend", "website/composition", "website/geo"];

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
const body = async (sp: Record<string, string> = {}) => (await collect(await render(sp))).get("RnWebsiteOverviewBody")!;

beforeEach(() => {
  st.calls = [];
  st.holdFilters = false;
  st.fail = new Set();
  st.summary = { state: "ok", tiles: { groups: [], suppressionCaption: null } };
  st.savedPages = [];
  st.role = "admin";
});

describe("renewal website overview page", () => {
  it("issues the body's screens without waiting for the filter options", async () => {
    st.holdFilters = true;
    await render({ geography: "US" });
    await Promise.resolve();
    expect(st.calls.map((c) => c.name)).toEqual(expect.arrayContaining(BODY_SCREENS));
  });

  it("reads each screen once, with ctx.admin; the panel and the pill on the website surface", async () => {
    const got = await collect(await render({ geography: "US", brand: "Kia" }));
    const counts: Record<string, number> = {};
    for (const c of st.calls) counts[c.name] = (counts[c.name] ?? 0) + 1;
    expect(counts).toEqual({ "overview/as-of": 1, "overview/filters": 1, ...Object.fromEntries(BODY_SCREENS.map((n) => [n, 1])) });
    const query = (name: string) => st.calls.find((c) => c.name === name)!.query;
    expect(query("website/summary")).toEqual({ geography: "US", brand: "Kia", "ctx.admin": "true" });
    expect(query("website/geo")).toEqual({ geography: "US", brand: "Kia", "ctx.admin": "true", "ctx.locale": "ko" });
    expect(query("overview/filters")).toEqual({ geography: "US", brand: "Kia", "ctx.admin": "true", "ctx.surface": "website" });
    expect(query("overview/as-of")).toEqual({ geography: "US", brand: "Kia", "ctx.admin": "true", "ctx.surface": "website" });
    const filters = got.get("RnOverviewFilters")!;
    expect(filters.props).toMatchObject({ stage: "overview", surface: "website", geographyOptions: ["US"], latestAnchorDay: "2026-10-09" });
    expect(filters.savedFilters).toEqual({ page: "website-overview", userId: "u1", initial: [] });
    expect(st.savedPages).toEqual(["website-overview"]);
    const b = got.get("RnWebsiteOverviewBody")!;
    expect(b.qs).toBe("geography=US&brand=Kia");
    expect(b.isAdmin).toBe(true);
    const reads = b.reads as Record<string, Promise<unknown>>;
    expect(await reads.deferred).toEqual({ groups: [{ category: "content", tiles: [] }], suppressionCaption: null });
    expect(await reads.trend).toEqual({ screen: "website/trend" });
    expect(await reads.brands).toEqual({ screen: "website/brands" });
    expect(await reads.engines).toEqual({ screen: "website/engines" });
    // 핵심 요약 waits for the same reads (a server section in the KPI card)
    expect(got.get("Findings")).toMatchObject({ locale: "ko" });
  });

  it("tells a non-administrator's screens ctx.admin=false", async () => {
    st.role = "website";
    const b = await body();
    expect(st.calls.find((c) => c.name === "website/summary")!.query).toEqual({ "ctx.admin": "false" });
    expect(b.isAdmin).toBe(false);
  });

  it("turns a transient failure of a section's screen into that section's notice", async () => {
    st.fail = new Set(["website/summary-deferred", "website/brands", "website/engines", "website/trend", "website/composition", "website/geo"]);
    const reads = (await body()).reads as Record<string, Promise<unknown>>;
    // Δ and the badge: the card-speed tiles stay
    expect(await reads.deferred).toEqual({ groups: [], suppressionCaption: null });
    expect(await reads.trend).toBe("failed");
    expect(await reads.composition).toEqual({ topics: [], sources: [], degraded: true });
    expect(await reads.geo).toBe("failed");
    expect(await reads.brands).toBe("failed");
    expect(await reads.engines).toEqual({ engines: [], consistency: {}, extremes: {}, widest: null, degraded: true });
  });

  it("shows the degraded notice for a failed summary and the empty notice for no data", async () => {
    st.fail = new Set(["website/summary"]);
    const degraded = await collect(await render({}));
    expect(degraded.get("RnWebsiteOverviewBody")).toBeUndefined();
    expect(degraded.get("RnEmpty")!.children).toBe("degraded");
    st.fail = new Set();
    st.summary = { state: "empty" };
    expect((await collect(await render({}))).get("RnEmpty")!.children).toBe("empty");
  });
});
