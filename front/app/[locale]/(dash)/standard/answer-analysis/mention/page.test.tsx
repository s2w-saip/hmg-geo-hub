import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// /standard/answer-analysis/mention: every section reads one screen of the API
// (back/bff/screens/mention.py) with the page's URL params, and passes the payload to the same
// components. The server sections are resolved here; client components are not rendered (their props
// are inspected, promises awaited). The screen values themselves are covered by the goldens
// (test/bff-golden/mention.golden.test.ts) and back/bff/tests/test_screens_mention.py.

const st = vi.hoisted(() => ({ calls: [] as { name: string; query: Record<string, unknown> }[] }));
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
vi.mock("@/lib/screen", () => ({
  screenGet: async (name: string, query: Record<string, unknown>) => {
    st.calls.push({ name, query });
    switch (name) {
      case "shared/panel-options":
        return { geographyOptions: ["US"], languageOptions: ["en"], optionMatrix: [], catalogRows: [] };
      case "shared/filter-dates":
        return { selectableDates: ["2026-09-07", "2026-09-14"], latestAnchorDay: "2026-09-14", collectionStartDay: null };
      case "mention/as-of":
        return { asOf: "2026-09-14" };
      case "mention/kpi-period":
        return { periodCompare: null, monthLine: null };
      default:
        return { screen: name, query };
    }
  },
}));

const Page = (await import("./page")).default;

const SERVER_SECTIONS = new Set(["MentionsFilterBar", "MentionsKpiBody", "MentionsData"]);

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

const render = (sp: Record<string, string>) => Page({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve(sp) });

beforeEach(() => {
  st.calls = [];
});

describe("standard mention page", () => {
  it("filter bar, header pill, the exposure tab sections and the bottom section read their screens", async () => {
    const got = await collect(await render({ geography: "US" }));
    expect(await (got.get("LastMeasuredPill")!.asOf as Promise<string | null>)).toBe("2026-09-14");
    const bar = got.get("AnalysisFilterBar")!;
    expect([bar.selectableDates, bar.latestAnchorDay, bar.geographyOptions]).toEqual([["2026-09-07", "2026-09-14"], "2026-09-14", ["US"]]);
    const tab = got.get("MentionKpiTab")!;
    expect(tab.metric).toBe("exposure");
    for (const [prop, screen] of [
      ["hero", "mention/kpi-hero"],
      ["heroDelta", "mention/kpi-hero-delta"],
      ["competitors", "mention/kpi-competitors"],
      ["heroTrend", "mention/kpi-hero-trend"],
      ["engines", "mention/kpi-engines"],
      ["types", "mention/kpi-types"],
    ]) {
      expect(await (tab[prop] as Promise<{ screen: string; query: Record<string, unknown> }>)).toEqual({
        screen,
        query: { geography: "US", "ctx.metric": "exposure" },
      });
    }
    expect(got.get("MentionsPromptsSection")!.data).toBeNull();
    const names = st.calls.map((c) => c.name).sort();
    expect(names).toContain("mention/prompts-section");
    expect(st.calls.find((c) => c.name === "shared/panel-options")!.query).toEqual({ geography: "US", surface: "global" });
    expect(st.calls.find((c) => c.name === "shared/filter-dates")!.query).toEqual({ surface: "global", family: "mentions" });
  });

  it.each([
    ["sov", "MentionKpiTab", "hero", "mention/kpi-hero"],
    ["favorability", "FavorabilityKpiTab", "hero", "mention/favor-hero"],
    ["first-rank", "FirstRankKpiTab", "firstRank", "mention/first-rank"],
  ])("kpi=%s reads its own section screens", async (kpi, component, prop, screen) => {
    const got = await collect(await render({ kpi }));
    const payload = await (got.get(component)![prop] as Promise<{ screen: string }>);
    expect(payload.screen).toBe(screen);
  });
});
