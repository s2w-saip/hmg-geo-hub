import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// /website/answer-analysis/mention on the api source (unit U6, HGH_SOURCE_G3=api): every section
// is fed by the backend adapters in the legacy prop shapes, no legacy reader runs, and the first
// render starts with the D6 essentials. The server sections are resolved here; client components
// are not rendered (their props are inspected, promises awaited). The in-request dedupe needs the
// react-server build, which the page's client imports cannot load: dedupe and the exact D6 order
// are asserted in lib/hgh/adapters/mentions.test.ts and kpi-tab.test.ts instead.

const st = vi.hoisted(() => ({ legacy: [] as string[] }));
vi.mock("@/i18n/navigation", () => ({ Link: () => null, usePathname: () => "/", useRouter: () => ({}) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({}), useSearchParams: () => new URLSearchParams(), notFound: () => { throw new Error("nf"); }, redirect: () => { throw new Error("rd"); } }));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (k: string) => k,
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({
    user: { id: "u1", email: "x", role: "hq", scope: { all: false, brands: ["Kia"] }, operator: "none", menuGroups: null },
  }),
}));
vi.mock("@/lib/scope/server", () =>
  new Proxy(
    {},
    {
      get: (_t, name) =>
        name === "then"
          ? undefined
          : async () => {
              st.legacy.push(String(name));
              return null;
            },
    },
  ),
);
vi.mock("@/lib/db/repositories/standards", () => ({ listCatalogTaxonomy: async () => (st.legacy.push("catalog"), []) }));
vi.mock("@/lib/db/repositories/website-sites", () => ({
  listWebsiteCountries: async () => (st.legacy.push("countries"), []),
  listMeasuredLanguages: async () => (st.legacy.push("langs"), []),
  listWebsiteScopeMatrix: async () => (st.legacy.push("matrix"), []),
}));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const Page = (await import("./page")).default;

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const log: URL[] = [];
const meta = { mode: "snapshot", as_of: "2026-09-14", cycles: ["2026-09-14"] };
const brandsData = {
  brands: [
    { name: "Kia", is_own: true, brand_key: 2, mentions: 10, exposure: { num: 5, den: 20 }, share: { num: 10, den: 30 }, avg_rank: { sum: 4, count: 2 }, rank: 2, sentiment: { positive: 2, neutral: 1, negative: 0, mixed: 0 }, prompts: 4, multi: { mentions: 3, answers: 1, prompts: 1 }, types: { mention: 2, recommendation: 0, comparison: 0, definition: 0, final_choice: 0 } },
    { name: "Toyota", is_own: false, brand_key: 7, mentions: 20, exposure: { num: 8, den: 20 }, share: { num: 20, den: 30 }, avg_rank: null, rank: 1, sentiment: { positive: 0, neutral: 0, negative: 0, mixed: 0 }, prompts: 6, types: { mention: 3, recommendation: 0, comparison: 0, definition: 0, final_choice: 0 } },
  ],
  own: { avg_rank: { sum: 4, count: 2 }, brands: ["Kia"], exposure: { num: 5, den: 20 }, mentions: 10, rank: 2, share: { num: 10, den: 30 }, vp_label: "Kia" },
  totals: { answers: 20, brand_count: 2, mentions_total: 30 },
  types_total: { mention: 5, recommendation: 0, comparison: 0, definition: 0, final_choice: 0 },
};

function handler(u: URL): unknown {
  switch (u.pathname) {
    case "/v1/filters/options":
      return { data: { catalog: { rows: [] }, custom_fields: null, engines: [], geo_matrix: [{ brand: "Kia", region: "US", lang: "en" }], languages: [], regions: [], source_categories: [] }, meta };
    case "/v1/filters/dates":
      return { data: { dates: ["2026-09-14", "2026-09-07"], dates_truncated: false, first_measured_date: "2026-06-01", latest_round_date: "2026-09-14", presets: [] }, meta };
    case "/v1/mentions/brands":
      return { data: u.searchParams.get("group_by") ? { ...brandsData, by_engine: [] } : brandsData, meta };
    case "/v1/mentions/types":
      return { data: { answers_total: 20, by_type: [], sentiment_matrix: [], stance: null }, meta };
    case "/v1/trend":
      return { data: { bucket: "cycle", dimension: u.searchParams.get("dimension"), own_label: "Kia", buckets: [], series: [] }, meta };
    case "/v1/kpi/summary":
      return {
        data: {
          visibility: { num: 5, den: 20 },
          share_of_voice: { num: 10, den: 30 },
          sentiment: { num: 2, den: 3 },
          position: { sum: 4, count: 2 },
          citation_share: null,
          target_url_rate: null,
          owned_url_rate: null,
          citation_accuracy: null,
          params: { answers: 20, applied_prompts: 9, measured_prompts: 8, prompts_without_brand: 3, measured_by_funnel: null },
          analysis_gap: { gap_answers: 0, base_answers: 20 },
        },
        meta,
      };
    case "/v1/kpi/engines":
      return {
        data: {
          engine_consistency: {},
          rows: [{ engine: "chatgpt", answers: 20, tracked: 5, multi: 1, top1: 1, top3: 2, rank_sum: 4, ranked: 2, total_mentions: 30, tracked_mentions: 10, sent_mentions: 3, positive_mentions: 2, negative_mentions: 0, cit_total: 0, cit_owned: 0 }],
          total: {},
        },
        meta: u.searchParams.get("cycle_offset") ? { ...meta, as_of: "2026-09-07" } : meta,
      };
    default:
      return { data: null, meta };
  }
}

beforeEach(() => {
  st.legacy = [];
  log.length = 0;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_SOURCE_G3", "api");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      const url = new URL(String(u));
      log.push(url);
      return new Response(JSON.stringify(handler(url)), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const SERVER_SECTIONS = new Set(["MentionsFilterBar", "MentionsData"]);

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

describe("website mention page, api source", () => {
  it("filter bar and MentionsView from the adapters; site-country axis; no legacy reader", async () => {
    const tree = await Page({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve({ geography: "HYUNDAI-N" }) });
    const got = await collect(tree);
    const bar = got.get("AnalysisFilterBar")!;
    expect(await (bar.asOf as Promise<string | null>)).toBe("2026-09-14");
    expect([bar.catalogRows, bar.selectableDates]).toEqual([undefined, ["2026-09-07", "2026-09-14"]]);
    const view = got.get("MentionsView")!;
    expect([view.isWebsite, view.lazyPrompts, view.prevBasisDate]).toEqual([true, true, "2026-09-07"]);
    expect((view.subKpis as { missingPrompts: number; top3Rate: number }).missingPrompts).toBe(3);
    expect((view.data as { summary: unknown }).summary).toEqual({ total: 30, uniqueBrands: 2, totalPrompts: 8, totalAnswers: 20 });
    expect(st.legacy).toEqual([]);
    // the site-country value (virtual code) goes to country on the website surface
    const b = log.find((u) => u.pathname === "/v1/mentions/brands")!.searchParams;
    expect([b.get("surface"), b.getAll("country")]).toEqual(["website", ["HYUNDAI-N"]]);
  });
});
