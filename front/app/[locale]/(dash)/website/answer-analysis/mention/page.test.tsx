import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// /website/answer-analysis/mention: the filter bar reads the shared option / calendar screens (with
// the website axes only) and the mention/as-of screen; the body reads ONE screen, mention/view with
// ctx.surface=website (back/bff/screens/mention_surfaces.py reads the website filters, the mention
// body, Sub KPI and previous window and computes every value MentionsView draws).

const st = vi.hoisted(() => ({ calls: [] as { name: string; query: Record<string, unknown> }[], role: "hq" }));
vi.mock("@/i18n/navigation", () => ({ Link: () => null, usePathname: () => "/", useRouter: () => ({}) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({}), useSearchParams: () => new URLSearchParams(), notFound: () => { throw new Error("nf"); }, redirect: () => { throw new Error("rd"); } }));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (k: string) => k,
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({
    user: { id: "u1", email: "x", role: st.role, scope: { all: false, brands: ["Kia"] }, operator: "none", menuGroups: null },
  }),
}));
vi.mock("@/lib/screen", () => ({
  screenGet: async (name: string, query: Record<string, unknown>) => {
    st.calls.push({ name, query });
    switch (name) {
      case "shared/panel-options":
        return { geographyOptions: ["HYUNDAI-N", "US"], languageOptions: ["en"], optionMatrix: [] };
      case "shared/filter-dates":
        return { selectableDates: ["2026-09-07", "2026-09-14"], latestAnchorDay: "2026-09-14", collectionStartDay: null };
      case "mention/as-of":
        return { asOf: "2026-09-14" };
      default:
        return { data: null, degraded: { data: false, types: false, subKpis: false }, subKpis: null, prevSubKpis: null, prevBasisDate: null };
    }
  },
}));

const Page = (await import("./page")).default;

const SERVER_SECTIONS = new Set(["MentionsFilterBar", "MentionsData"]);

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

beforeEach(() => {
  st.calls = [];
  st.role = "hq";
});

describe("website mention page", () => {
  it("filter bar and MentionsView from the screens; website axes only", async () => {
    const sp = { geography: "HYUNDAI-N", brand: "Kia", time: "2026-09-01..2026-09-30" };
    const got = await collect(await Page({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve(sp) }));
    const bar = got.get("AnalysisFilterBar")!;
    expect(await (bar.asOf as Promise<string | null>)).toBe("2026-09-14");
    expect([bar.catalogRows, bar.selectableDates, bar.geographyOptions]).toEqual([undefined, ["2026-09-07", "2026-09-14"], ["HYUNDAI-N", "US"]]);
    const view = got.get("MentionsView")!;
    expect([view.isWebsite, view.lazyPrompts, view.hideFilterPanel]).toEqual([true, true, true]);
    expect(view.compareSource).toEqual({ surface: "website", admin: false });
    const byName = (n: string) => st.calls.find((c) => c.name === n)!.query;
    // the brand axis is not a website axis for a non-admin: the panel options do not narrow by it
    expect(byName("shared/panel-options")).toEqual({ geography: "HYUNDAI-N", time: "2026-09-01..2026-09-30", surface: "website" });
    expect(byName("mention/view")).toEqual({ ...sp, "ctx.surface": "website" });
    expect(byName("mention/as-of")).toEqual({ ...sp, "ctx.surface": "website" });
  });

  it("an admin also gets the brand axis (ctx.admin, panel brand narrowing)", async () => {
    st.role = "admin";
    const got = await collect(await Page({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve({ brand: "Kia" }) }));
    expect(got.get("AnalysisFilterBar")!.extraGroups).toEqual(["brand"]);
    expect(st.calls.find((c) => c.name === "shared/panel-options")!.query).toEqual({ brand: "Kia", surface: "website" });
    expect(st.calls.find((c) => c.name === "mention/view")!.query).toEqual({ brand: "Kia", "ctx.surface": "website", "ctx.admin": "true" });
  });
});
