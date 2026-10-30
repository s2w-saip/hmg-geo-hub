import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// Renewal Website AI Conversion (/renewal/website/ai-funnel/conversion, W5): the Global AI Conversion's screens,
// body and filters with the URL as is (GA4 rows carry no surface; the original is the Global screen itself), and
// its own saved-filter list. The server section is resolved here; client components are not rendered (their props
// are inspected).

const st = vi.hoisted(() => ({
  calls: [] as { name: string; query: Record<string, unknown> }[],
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
vi.mock("../../../_components/saved-filters-server", () => ({
  loadSavedFilters: async (page: string) => {
    st.savedPages.push(page);
    return [{ id: "a", name: "미국 7일", query: "geography=US&days=7", isDefault: false }];
  },
}));
const BODY = { state: "noprop", choice: { preset: 28, days: 28, from: null, to: null }, period: { from: null, to: null, days: null }, properties: [], view: null };
vi.mock("@/lib/screen", () => ({
  screenGet: (name: string, query: Record<string, unknown>) => {
    st.calls.push({ name, query });
    switch (name) {
      case "conversion/renewal-header":
        return Promise.resolve({ preset: 7, days: 7, from: null, to: null });
      case "conversion/renewal":
        return Promise.resolve({ props: { stage: "conversion", geographyOptions: ["US"] }, body: BODY });
      default:
        return Promise.reject(new Error(`unexpected screen ${name}`));
    }
  },
}));

const Page = (await import("./page")).default;

/** Walk the tree, resolving the page's server section; collect client component props by name. */
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
    if (name === "RenewalWebsiteConversion") {
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
  st.savedPages = [];
});

describe("renewal website AI Conversion page", () => {
  it("reads the Global AI Conversion's screens with the URL as is", async () => {
    await collect(await render({ geography: "US", days: "7" }));
    expect(st.calls).toEqual([
      { name: "conversion/renewal-header", query: { geography: "US", days: "7" } },
      { name: "conversion/renewal", query: { geography: "US", days: "7" } },
    ]);
  });

  it("renders the Global body and filter panel and keeps its own saved-filter list", async () => {
    const got = await collect(await render({ geography: "US", days: "7" }));
    expect(got.get("RnConvBody")!.input).toEqual(BODY);
    const filters = got.get("RnOverviewFilters")!;
    expect(filters.props).toEqual({ stage: "conversion", geographyOptions: ["US"], scope: { all: true } });
    expect(filters.savedFilters).toEqual({ page: "website-conversion", userId: "u1", initial: [{ id: "a", name: "미국 7일", query: "geography=US&days=7", isDefault: false }] });
    expect(st.savedPages).toEqual(["website-conversion"]);
    const panel = got.get("RnOverviewFilterPanel")!;
    expect(panel.hint).toBe("filters.hint");
    expect(panel.axisHelp).toEqual({ engine: "filters.engineHelp", device: "filters.deviceHelp", visitorType: "filters.visitorTypeHelp" });
    expect(got.get("RnDaysPeriod")).toEqual({ choice: BODY.choice, period: BODY.period });
  });
});
