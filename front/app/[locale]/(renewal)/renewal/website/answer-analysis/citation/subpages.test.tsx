import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// The website Citation sub pages (공식(당사) URL 인용 프롬프트, 긍정/부정 URL) show the Citation page's filters they read
// from the URL as removable tokens (2026-10-30): the page's filter bar (citation/filter-bar, website) behind the shared
// tokens, and a filter change restarts the list (its page and cursor; the URL list's search too, whose tab counts are
// reused on a search move). Without the filter bar the list shows alone. The server sections are resolved here.

const st = vi.hoisted(() => ({ calls: [] as { name: string; query: Record<string, unknown> }[], barFails: false }));
vi.mock("@/i18n/navigation", () => ({ Link: () => null, usePathname: () => "/", useRouter: () => ({}) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({}), useSearchParams: () => new URLSearchParams(), notFound: () => { throw new Error("nf"); }, redirect: () => { throw new Error("rd"); } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (k: string) => k,
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({
    user: { id: "u1", email: "x", role: "admin", scope: { all: true }, operator: "none", menuGroups: null },
  }),
}));
const BAR = {
  options: { catalogRows: undefined, geographyOptions: ["US", "DE"], languageOptions: ["en"], optionMatrix: [] },
  dates: { collectionStartDay: "2026-07-03", latestAnchorDay: "2026-10-09", selectableDates: ["2026-10-02", "2026-10-09"] },
};
vi.mock("@/lib/screen", () => ({
  screenGet: async (name: string, query: Record<string, unknown>) => {
    st.calls.push({ name, query });
    switch (name) {
      case "citation/filter-bar":
        if (st.barFails) throw new Error("bar down");
        return BAR;
      case "citation/prompts":
        return { tab: "owned", page: { rows: [], total: 0, page: 1, pageSize: 50 }, q: "", ownedCount: 260, uncitedCount: 92 };
      case "citation/tone-urls":
        return { tone: "positive", page: { rows: [], total: 0, page: 1, pageSize: 50 }, q: "kia", byDomain: false, counts: { positive: 1, negative: 0 } };
      default:
        throw new Error(`unexpected screen ${name}`);
    }
  },
}));

const PromptsPage = (await import("./prompts/page")).default;
const ToneUrlsPage = (await import("./tone-urls/page")).default;
const { PROMPTS_RESET, TONE_URLS_RESET } = await import("./_shared/website-citation-filters");
const { dropParams } = await import("../../../_components/filter-runtime");

const SERVER_SECTIONS = new Set(["RnWebsiteCitationSubFilters"]);

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
    if (name && typeof el.type !== "string" && !out.has(name)) out.set(name, el.props);
    queue.push(el.props.children);
  }
  return out;
}

type Page = (p: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
const render = async (page: Page, sp: Record<string, string>) => collect(await page({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve(sp) }));

beforeEach(() => {
  st.calls = [];
  st.barFails = false;
});

describe("renewal website citation sub pages: the filters they read, as tokens", () => {
  it("공식(당사) URL 인용 프롬프트: the page's website filter bar behind the tokens; a filter change drops page and cursor", async () => {
    const sp = { geography: "US", tab: "owned", page: "3", cursor: "c" };
    const got = await render(PromptsPage as Page, sp);
    expect(st.calls.find((c) => c.name === "citation/filter-bar")!.query).toEqual({ ...sp, "ctx.surface": "website", "ctx.role": "admin" });
    expect(got.get("RnFilterRuntime")!.reset).toEqual(PROMPTS_RESET);
    const filters = got.get("RnOverviewFilters")!;
    expect(filters.props).toMatchObject({ stage: "citation", surface: "website", geographyOptions: ["US", "DE"], scope: { all: true } });
    // the Citation page's list, never opened with a default saved filter here
    expect(filters.savedFilters).toEqual({ page: "website-citation", userId: "u1", initial: [] });
    expect(got.has("RnOverviewApplied")).toBe(true);
    expect(got.get("RnCitationPromptsView")).toMatchObject({ ownedCount: 260, uncitedCount: 92 });
  });

  it("긍정/부정 URL: a filter change also starts the search over (its tab counts are reused on a search move)", async () => {
    const got = await render(ToneUrlsPage as Page, { geography: "US", q: "kia" });
    expect(got.get("RnFilterRuntime")!.reset).toEqual(TONE_URLS_RESET);
    expect(st.calls.find((c) => c.name === "citation/tone-urls")!.query).toMatchObject({ geography: "US", q: "kia", "ctx.surface": "website", "ctx.client_nav": null });
    expect(got.has("RnCitationToneUrlsView")).toBe(true);
  });

  it("without the filter bar the list shows alone", async () => {
    st.barFails = true;
    const got = await render(PromptsPage as Page, { geography: "US" });
    expect(got.has("RnOverviewFilters")).toBe(false);
    expect(got.has("RnCitationPromptsView")).toBe(true);
  });

  it("dropParams leaves the rest of the query as it is", () => {
    expect(dropParams("geography=US&tab=owned&page=3&cursor=c&q=kia", TONE_URLS_RESET)).toBe("geography=US&tab=owned");
    expect(dropParams("geography=US&page=3", [])).toBe("geography=US&page=3");
  });
});
