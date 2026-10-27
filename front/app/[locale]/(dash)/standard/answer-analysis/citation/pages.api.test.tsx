import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// The five citation screens read finished view models from the screen API (back/bff/screens/
// citation.py, GET /v1/screens/citation/*): each page section asks its screen with the page's URL
// params and the route context, and hands the answer to the client components unchanged. Server
// sections are resolved here, client components are not rendered (their props are inspected,
// promises awaited). What the screens compute is pinned by the golden cases
// (test/bff-golden/citation.golden.test.ts) and back/bff/tests/test_screens_citation.py.

const st = vi.hoisted(() => ({ role: "hq" as string }));
vi.mock("@/i18n/navigation", () => ({ Link: () => null, usePathname: () => "/", useRouter: () => ({}) }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({}),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("nf");
  },
  redirect: (to: string) => {
    throw new Error(`rd:${to}`);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next-intl/server", () => ({ setRequestLocale: () => undefined, getTranslations: async () => (k: string) => k }));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({
    user: { id: "u1", email: "x", role: st.role, scope: { all: false, brands: ["Kia"], regions: [], countries: ["US", "KR"] }, operator: "none", menuGroups: null },
  }),
}));
vi.mock("@/app/[locale]/(dash)/projects/[id]/analysis/_lib/auth-and-locks", () => ({
  loadProjectAnalysisContext: async () => ({ locks: [{ group: "geography", value: "US" }], lockedGroups: ["geography"] }),
}));

const StandardPage = (await import("./page")).default;
const PromptsPage = (await import("./prompts/page")).default;
const TonePage = (await import("./tone-urls/page")).default;
const WebsitePage = (await import("../../../website/answer-analysis/citation/page")).default;
const ProjectPage = (await import("../../../projects/[id]/analysis/citation/page")).default;

const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const FIELD = "0b1c2d3e-4f50-4a6b-8c7d-8e9fa0b1c2d3";
const log: URL[] = [];
const LIVE = { summary: { total: 10, uniqueDomains: 1, officialOwnShare: 30 }, asOf: "2026-09-21", domains: [], categories: null, trend: null, categoryTrend: null, engineCategories: null, promptSplit: null };
const FLAGS = { data: false, trend: false, categoryTrend: false, split: false };
const TABLE = { query: "competitor=toyota.com&geography=US", nextCursor: "n1", total: 300 };
const PERIOD = { days: 31, presetKey: "lastMonth", caption: { key: "window", params: {} }, chips: [] };
const OPTIONS = { geographyOptions: ["US"], languageOptions: ["en"], optionMatrix: [], catalogRows: [] };
const DATES = { selectableDates: ["2026-09-14", "2026-09-21"], latestAnchorDay: "2026-09-21", collectionStartDay: null, firstMeasuredDate: null, presets: [], truncated: false, notices: { ignored: [], dropped: {}, hasAny: false } };
const PAGE = { rows: [], total: 7, page: 2, pageSize: 50, nextCursor: "p2", win: { page: 1, pages: 1, from: 0, to: 7 } };

function screen(name: string, q: URLSearchParams): { body: unknown; status?: number } {
  switch (name) {
    case "as-of":
      return { body: { asOf: "2026-09-21", competitorOptions: ["toyota.com"] } };
    case "filter-bar":
      return { body: { options: OPTIONS, dates: DATES } };
    case "standard":
      return {
        body: {
          live: LIVE, dataDegraded: false, sectionDegraded: FLAGS, officialDelta: null, prevCategories: null, typeCategories: [],
          typeChart: { series: [], bars: [], hasAny: false }, toneSummary: { positive: { urls: 3, citations: 4, answers: 2 }, negative: { urls: 1, citations: 1, answers: 1 } },
          tableSource: TABLE, periodView: PERIOD, vm: { status: {}, category: {}, engineChart: null, domains: [] },
        },
      };
    case "website":
      return {
        body: {
          live: LIVE, targetHitRate: { hitPrompts: 7, ownedPrompts: 11, measuredPrompts: 40, rate: 17.5, ownedRate: 27.5, source: "live" },
          tableSource: { ...TABLE, query: "geography=US&surface=website" }, dataDegraded: false, degradedSections: FLAGS, vm: { dealerShare: null, officialPct: null, engineChart: null, domains: [] },
        },
      };
    case "project":
      return {
        body: {
          live: LIVE, options: { catalogRows: [], engineOptions: ["chatgpt"], dynamicAxes: [{ id: FIELD, label: "Tag", options: ["a", "b"] }] },
          selectableDates: DATES.selectableDates, tableSource: { ...TABLE, query: `cf_${FIELD}=a&projectId=${PROJECT}` }, dataDegraded: false, degradedSections: FLAGS,
          vm: { dealerShare: null, officialPct: null, engineChart: null, domains: [] },
        },
      };
    case "prompts":
      return { body: { tab: q.get("tab") === "uncited" ? "uncited" : "owned", q: q.get("q") ?? "", page: PAGE, ownedCount: 2, uncitedCount: 7 } };
    case "tone-urls":
      return { body: { tone: "negative", q: "", byDomain: true, page: PAGE, counts: { positive: 3, negative: 1 } } };
    default:
      return { body: { error: { code: "not_found" } }, status: 404 };
  }
}

let override: ((u: URL) => { body: unknown; status?: number } | null) | null = null;
beforeEach(() => {
  st.role = "hq";
  log.length = 0;
  override = null;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string | URL) => {
      const url = new URL(String(u));
      log.push(url);
      const r = override?.(url) ?? (url.pathname.startsWith("/v1/screens/citation/") ? screen(url.pathname.slice("/v1/screens/citation/".length), url.searchParams) : { body: { error: { code: "not_found" } }, status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const SERVER_SECTIONS = new Set(["CitationsFilterBar", "CitationsBody", "CitationsData"]);

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
    for (const v of Object.values(el.props)) if (isValidElement(v) || Array.isArray(v)) queue.push(v);
    queue.push(el.props.children);
  }
  return out;
}
const args = (sp: Record<string, string>, extra: { id?: string } = {}) => ({
  params: Promise.resolve({ locale: "ko", id: extra.id ?? "" }),
  searchParams: Promise.resolve(sp as Record<string, string | string[] | undefined>),
});
const calls = (name: string) => log.filter((u) => u.pathname === `/v1/screens/citation/${name}`).map((u) => u.searchParams);

describe("standard citation page", () => {
  it("pill and competitor options from citation/as-of, the panel from citation/filter-bar, the body from citation/standard", async () => {
    const got = await collect(await StandardPage(args({ geography: "US", competitor: "toyota.com", time: "2026-08-01..2026-08-31" })));
    expect(await (got.get("LastMeasuredPill")!.asOf as Promise<string | null>)).toBe("2026-09-21");
    const bar = got.get("AnalysisFilterBar")!;
    expect(await (bar.competitorOptions as Promise<string[]>)).toEqual(["toyota.com"]);
    expect([bar.latestAnchorDay, bar.selectableDates, bar.geographyOptions]).toEqual(["2026-09-21", ["2026-09-14", "2026-09-21"], ["US"]]);
    const view = got.get("CitationsStandardView")!;
    expect(view.data).toEqual(LIVE);
    expect(view.tableSource).toEqual(TABLE);
    expect([view.dataDegraded, view.sectionDegraded]).toEqual([false, FLAGS]);
    expect(view.typeChart).toEqual({ series: [], bars: [], hasAny: false });
    expect(got.get("PeriodDeltaLine")!.view).toEqual(PERIOD);
    // every screen got the page's URL params and the surface; the page computes nothing (the tree walk
    // above may resolve a section more than once: every call carries the same query)
    for (const name of ["as-of", "filter-bar", "standard"]) {
      const q = calls(name);
      expect(q.length).toBeGreaterThan(0);
      for (const one of q) expect([one.get("ctx.surface"), one.get("geography"), one.get("competitor"), one.get("time")]).toEqual(["global", "US", "toyota.com", "2026-08-01..2026-08-31"]);
    }
  });

  it("a failed competitor-options read leaves the axis empty, the page renders", async () => {
    override = (u) => (u.pathname.endsWith("/as-of") ? { body: { error: { code: "source_unavailable" } }, status: 503 } : null);
    const got = await collect(await StandardPage(args({})));
    expect(await (got.get("AnalysisFilterBar")!.competitorOptions as Promise<string[]>)).toEqual([]);
    // the pill reads the same failed answer (its Suspense boundary shows the error there)
    await expect(got.get("LastMeasuredPill")!.asOf as Promise<string | null>).rejects.toMatchObject({ status: 503 });
  });

  it("a 401 from a screen redirects to the login page", async () => {
    override = (u) => (u.pathname.endsWith("/filter-bar") ? { body: { error: { code: "token_expired" } }, status: 401 } : null);
    const tree = await StandardPage(args({}));
    await expect(collect(tree)).rejects.toThrow("rd:/ko/login");
  });
});

describe("standard sub pages", () => {
  it("prompts: the URL (tab, q, page, cursor) goes to citation/prompts; the answer reaches the page as is", async () => {
    const got = await collect(await PromptsPage(args({ tab: "uncited", q: "ev", page: "2", cursor: "p1" })));
    const view = got.get("CitationPromptsPage")!;
    expect([view.tab, view.q, view.ownedCount, view.uncitedCount, view.page]).toEqual(["uncited", "ev", 2, 7, PAGE]);
    const q = calls("prompts")[0];
    expect([q.get("tab"), q.get("q"), q.get("page"), q.get("cursor"), q.get("ctx.surface")]).toEqual(["uncited", "ev", "2", "p1", "global"]);
  });

  it("tone: citation/tone-urls, counts and page from the answer", async () => {
    const got = await collect(await TonePage(args({ tone: "negative", by: "domain" })));
    expect(got.get("CitationToneUrlsPage")).toMatchObject({ tone: "negative", byDomain: true, counts: { positive: 3, negative: 1 }, page: PAGE });
    const q = calls("tone-urls")[0];
    expect([q.get("tone"), q.get("by"), q.get("ctx.client_nav")]).toEqual(["negative", "domain", null]);
  });
});

describe("website citation page", () => {
  it("filter bar (website options) + its date, body from citation/website with the role", async () => {
    const got = await collect(await WebsitePage(args({ geography: "US" })));
    const bar = got.get("AnalysisFilterBar")!;
    expect(await (bar.asOf as Promise<string | null>)).toBe("2026-09-21");
    expect(bar.extraGroups).toEqual([]);
    const view = got.get("CitationsView")!;
    expect(view.tableSource).toEqual({ ...TABLE, query: "geography=US&surface=website" });
    expect(view.targetHitRate).toEqual({ hitPrompts: 7, ownedPrompts: 11, measuredPrompts: 40, rate: 17.5, ownedRate: 27.5, source: "live" });
    expect([view.dataDegraded, view.degradedSections]).toEqual([false, FLAGS]);
    for (const name of ["filter-bar", "as-of", "website"]) {
      const q = calls(name)[0];
      expect([q.get("ctx.surface"), q.get("ctx.role"), q.get("geography")]).toEqual(["website", "hq", "US"]);
    }
  });

  it("admin: the brand axis is offered (the screen re-reads the brand param for admin)", async () => {
    st.role = "admin";
    const got = await collect(await WebsitePage(args({})));
    expect(got.get("AnalysisFilterBar")!.extraGroups).toEqual(["brand"]);
    expect(calls("website")[0].get("ctx.role")).toBe("admin");
  });
});

describe("project citation page", () => {
  it("citation/project with the project id and the cf_ params; options, calendar and table source from the answer", async () => {
    const got = await collect(await ProjectPage(args({ [`cf_${FIELD}`]: "a", cf_gone: "x" }, { id: PROJECT })));
    const view = got.get("CitationsView")!;
    expect(view.dynamicAxes).toEqual([{ id: FIELD, label: "Tag", options: ["a", "b"] }]);
    expect(view.engineOptions).toEqual(["chatgpt"]);
    expect(view.selectableDates).toEqual(["2026-09-14", "2026-09-21"]);
    expect(view.lockedGroups).toEqual(["geography"]);
    expect(view.tableSource).toEqual({ ...TABLE, query: `cf_${FIELD}=a&projectId=${PROJECT}` });
    const q = calls("project")[0];
    expect([q.get("ctx.project_id"), q.get(`cf_${FIELD}`), q.get("cf_gone")]).toEqual([PROJECT, "a", "x"]);
  });

  it("a 404 from the screen (not a member) -> notFound()", async () => {
    override = (u) => (u.pathname.endsWith("/project") ? { body: { error: { code: "not_found" } }, status: 404 } : null);
    await expect(ProjectPage(args({}, { id: PROJECT }))).rejects.toThrow("nf");
  });
});
