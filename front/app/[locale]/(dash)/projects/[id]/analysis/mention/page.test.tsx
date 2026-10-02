import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// /projects/[id]/analysis/mention on the api source (unit U6, HGH_SOURCE_G6=api): options first
// (custom fields read the cf_ URL filters), then the mention body, Sub KPI, previous window,
// designated brand (ProjectDetail.target_brand) and calendar, all with surface=project; the
// brand drilldown becomes lazy (3.5 #4). The legacy source keeps the repository readers.

const st = vi.hoisted(() => ({ legacyCalls: [] as string[] }));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (k: string) => k,
}));
vi.mock("../_lib/auth-and-locks", () => ({
  loadProjectAnalysisContext: async () => ({ locks: [{ group: "geography", value: "US" }], lockedGroups: ["geography"] }),
}));
vi.mock("@/lib/scope/server", () => {
  const rec = (n: string) => async () => (st.legacyCalls.push(n), null);
  return {
    fetchProjectMeasuredEngines: rec("engines"),
    fetchProjectMentions: rec("mentions"),
    fetchProjectSubKpis: async () => (st.legacyCalls.push("sub"), { rows: [], promptsWithoutBrand: null, measuredPrompts: null }),
    fetchProjectSubKpisPrev: rec("prev"),
    fetchProjectSelectableAnchorDates: rec("dates"),
  };
});
vi.mock("@/lib/db/repositories/tracked-entities", () => ({
  trackedCompetitorRepository: { getTargetBrand: async () => (st.legacyCalls.push("target"), null) },
}));
vi.mock("@/lib/db/repositories/standards", () => ({ listCatalogTaxonomy: async () => (st.legacyCalls.push("catalog"), []) }));
vi.mock("@/lib/db/repositories/project-custom-fields", () => ({
  projectCustomFieldRepository: {
    listForProject: async () => (st.legacyCalls.push("fields"), []),
    listValuesForProject: async () => [],
  },
}));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const Page = (await import("./page")).default;

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const FIELD = "0b3f1c2d-0000-4000-8000-000000000001";
const log: URL[] = [];

const brands = {
  brands: [
    { name: "Kia", is_own: true, brand_key: 2, mentions: 10, exposure: { num: 5, den: 20 }, share: { num: 10, den: 30 }, avg_rank: null, rank: 1, sentiment: { positive: 1, neutral: 0, negative: 0, mixed: 0 } },
    { name: "Toyota", is_own: false, brand_key: 7, mentions: 20, exposure: { num: 8, den: 20 }, share: { num: 20, den: 30 }, avg_rank: null, rank: 2, sentiment: { positive: 0, neutral: 0, negative: 0, mixed: 0 } },
  ],
  own: { avg_rank: null, brands: ["Kia"], exposure: { num: 5, den: 20 }, mentions: 10, rank: 2, share: { num: 10, den: 30 }, vp_label: "Kia" },
  totals: { answers: 20, brand_count: 2, mentions_total: 30 },
  types_total: null,
};

function handler(u: URL): unknown {
  const meta = { mode: "snapshot", as_of: "2026-09-14", cycles: ["2026-09-14"] };
  switch (u.pathname) {
    case "/v1/filters/options":
      return {
        data: {
          catalog: { rows: [{ brand: null, brand_presence: "branded", list_type: "L", depth1: "d", depth2: null, depth3: null, depth4: null, funnel: null }] },
          custom_fields: [{ field_id: FIELD, label: "Tag", values: ["b", "a"] }],
          engines: [{ code: "chatgpt", is_default: true }],
          geo_matrix: [{ brand: "Kia", region: "US", lang: "en" }],
          languages: [],
          regions: [],
          source_categories: [],
        },
        meta,
      };
    case "/v1/filters/dates":
      return { data: { dates: ["2026-09-14", "2026-09-07"], dates_truncated: false, first_measured_date: "2026-06-01", latest_round_date: "2026-09-14", presets: [] }, meta };
    case "/v1/mentions/brands":
      return { data: brands, meta };
    case "/v1/mentions/types":
      return { data: { answers_total: 20, by_type: [], sentiment_matrix: [], stance: null }, meta };
    case "/v1/trend":
      return { data: { bucket: "cycle", dimension: "brand", own_label: "Kia", buckets: [], series: [] }, meta };
    case "/v1/kpi/summary":
      return {
        data: {
          visibility: { num: 5, den: 20 },
          share_of_voice: { num: 10, den: 30 },
          sentiment: null,
          position: null,
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
          engine_consistency: { citation_share: null, position: null, sentiment: null, share_of_voice: null, visibility: null },
          rows: [{ engine: "chatgpt", answers: 20, tracked: 5, multi: 1, top1: 1, top3: 2, rank_sum: 4, ranked: 2, total_mentions: 30, tracked_mentions: 10, sent_mentions: 1, positive_mentions: 1, negative_mentions: 0, cit_total: 0, cit_owned: 0 }],
          total: {},
        },
        meta,
      };
    case `/v1/projects/${PROJECT}`:
      return { data: { project_id: PROJECT, target_brand: "Toyota" }, meta: { mode: "crud" } };
    default:
      return { data: null, meta };
  }
}

beforeEach(() => {
  st.legacyCalls = [];
  log.length = 0;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
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

/** Resolve an async server component tree until the MentionsView element and return its props. */
async function mentionsViewProps(node: unknown): Promise<Record<string, unknown>> {
  const queue: unknown[] = [node];
  while (queue.length) {
    const n = queue.shift();
    if (Array.isArray(n)) {
      queue.push(...n);
      continue;
    }
    if (!isValidElement(n)) continue;
    const el = n as ReactElement<Record<string, unknown>>;
    const type = el.type as { name?: string } | string;
    if (typeof type !== "string" && type.name === "MentionsView") return el.props;
    if (typeof el.type === "function" && (type as { name?: string }).name === "ProjectMentionApi") {
      queue.push(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
      continue;
    }
    queue.push(el.props.children);
  }
  throw new Error("MentionsView not found");
}

describe("project mention page, api source", () => {
  it("options first, cf filter applied, lazy drilldown, target brand from the project detail", async () => {
    vi.stubEnv("HGH_SOURCE_G6", "api");
    const tree = await Page({
      params: Promise.resolve({ locale: "ko", id: PROJECT }),
      searchParams: Promise.resolve({ [`cf_${FIELD}`]: "a", engine: "chatgpt" }),
    });
    const props = await mentionsViewProps(tree);
    expect(props.lazyPrompts).toBe(true);
    expect(props.designatedTargetBrand).toBe("Toyota");
    expect(props.dynamicAxes).toEqual([{ id: FIELD, label: "Tag", options: ["a", "b"] }]);
    expect(props.engineOptions).toEqual(["chatgpt"]);
    expect(props.selectableDates).toEqual(["2026-09-07", "2026-09-14"]);
    expect((props.data as { summary: unknown }).summary).toEqual({ total: 30, uniqueBrands: 2, totalPrompts: 8, totalAnswers: 20 });
    expect((props.subKpis as { missingPrompts: number }).missingPrompts).toBe(3);
    expect(log[0].pathname).toBe("/v1/filters/options");
    const brandCall = log.find((u) => u.pathname === "/v1/mentions/brands")!.searchParams;
    expect([brandCall.get("surface"), brandCall.get("project_id"), brandCall.getAll(`cf.${FIELD}`), brandCall.getAll("engine")]).toEqual([
      "project",
      PROJECT,
      ["a"],
      ["chatgpt"],
    ]);
    expect(st.legacyCalls).toEqual([]);
  });
  it("legacy source (default): the repository readers, no backend call, eager drilldown", async () => {
    const tree = await Page({ params: Promise.resolve({ locale: "ko", id: PROJECT }), searchParams: Promise.resolve({}) });
    const props = await mentionsViewProps(tree);
    expect(props.lazyPrompts).toBeUndefined();
    expect(st.legacyCalls.sort()).toEqual(["catalog", "dates", "engines", "fields", "mentions", "prev", "sub", "target"]);
    expect(log).toHaveLength(0);
  });
});
