import { beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// /renewal/website/answer-analysis/mention: the renewal Global Mention's screens (mention/rn-<section>) with
// ctx.surface=website (+ ctx.admin for an unrestricted account), the shared panel on the website surface with the
// website axes only (the original page's option reads), and its own saved filter list.

const st = vi.hoisted(() => ({ calls: [] as { name: string; query: Record<string, unknown> }[], all: false }));
vi.mock("@/i18n/navigation", () => ({ Link: () => null, usePathname: () => "/", useRouter: () => ({}) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({}), useSearchParams: () => new URLSearchParams(), notFound: () => { throw new Error("nf"); }, redirect: () => { throw new Error("rd"); } }));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (k: string) => k,
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({
    user: { id: "u1", email: "x", role: st.all ? "admin" : "hq", scope: st.all ? { all: true } : { all: false, brands: ["Kia"] }, operator: "none", menuGroups: null },
  }),
}));
vi.mock("../../../_components/saved-filters-server", () => ({ loadSavedFilters: async () => [] }));
vi.mock("@/lib/screen", () => ({
  screenGet: async (name: string, query: Record<string, unknown>) => {
    st.calls.push({ name, query });
    switch (name) {
      case "shared/panel-options":
        return { geographyOptions: ["HYUNDAI-N", "US"], languageOptions: ["en"], optionMatrix: [] };
      case "shared/filter-dates":
        return { selectableDates: ["2026-10-02", "2026-10-09"], latestAnchorDay: "2026-10-09", collectionStartDay: "2026-07-03" };
      case "mention/rn-page":
        return { ownLabel: "HMG", period: null };
      case "mention/rn-asof":
        return { asOf: "2026-10-09" };
      default:
        return {};
    }
  },
}));

const Page = (await import("./page")).default;

const SERVER_SECTIONS = new Set(["RenewalWebsiteMention"]);

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

const render = async (sp: Record<string, string>) => collect(await Page({ params: Promise.resolve({ locale: "ko" }), searchParams: Promise.resolve(sp) }));
const queries = (prefix: string) => st.calls.filter((c) => c.name.startsWith(prefix));
const byName = (n: string) => st.calls.find((c) => c.name === n)!.query;

beforeEach(() => {
  st.calls = [];
  st.all = false;
});

describe("renewal website mention page", () => {
  it("reads every rn screen on the website surface, the panel with the website axes, its own saved filters", async () => {
    const sp = { geography: "HYUNDAI-N", brand: "Kia", promptContext: "x", time: "2026-09-01..2026-09-30" };
    const got = await render(sp);
    const reads = queries("mention/");
    expect(reads.map((c) => c.name)).toEqual(expect.arrayContaining(["mention/rn-page", "mention/rn-shell", "mention/rn-summary", "mention/rn-ranking", "mention/rn-bump", "mention/view-cards", "mention/view-weekly"]));
    expect(reads.length).toBe(22); // rn-page, rn-asof, 4 tab values, 14 sections, the KPI breakdown and the weekly brand mentions
    for (const c of reads) expect(c.query).toEqual({ ...sp, "ctx.surface": "website", ...(c.query["ctx.kpi"] ? { "ctx.kpi": c.query["ctx.kpi"] } : {}) });
    // the brand axis is not a website axis for a restricted account: the panel options do not narrow by it
    expect(byName("shared/panel-options")).toEqual({ geography: "HYUNDAI-N", time: "2026-09-01..2026-09-30", surface: "website" });
    expect(byName("shared/filter-dates")).toEqual({ surface: "website", family: "mentions" });
    const filters = got.get("RnOverviewFilters")!;
    expect(filters.props).toMatchObject({ stage: "mention", surface: "website", geographyOptions: ["HYUNDAI-N", "US"], selectableDates: ["2026-10-02", "2026-10-09"] });
    expect((filters.props as Record<string, unknown>).catalogRows).toBeUndefined();
    expect((filters.savedFilters as { page: string }).page).toBe("website-mention");
    const input = got.get("RnMentionPageProvider")!.input as { filtered: boolean; afterSummary: { props: { period: boolean } }; brandsExtra: { props: { weekly: Promise<unknown> } } };
    expect(input.filtered).toBe(true);
    // the legacy website values stay (a legacy KPI is reshaped, never dropped): the KPI breakdown under 이번 회차 요약,
    // the weekly brand mentions at the end of 브랜드 상세
    expect(input.afterSummary.props.period).toBe(false);
    expect(input.brandsExtra.props.weekly).toBeInstanceOf(Promise);
  });

  it("an unrestricted account also gets the brand axis (ctx.admin, panel brand narrowing)", async () => {
    st.all = true;
    await render({ brand: "Kia" });
    expect(byName("mention/rn-shell")).toEqual({ brand: "Kia", "ctx.surface": "website", "ctx.admin": "true" });
    expect(byName("shared/panel-options")).toEqual({ brand: "Kia", surface: "website" });
  });

  it("a Global-only axis in the URL is not a website filter (측정 대기, not 결과 없음)", async () => {
    const restricted = await render({ promptContext: "x", brand: "Kia" });
    expect((restricted.get("RnMentionPageProvider")!.input as { filtered: boolean }).filtered).toBe(false);
    st.all = true;
    const admin = await render({ brand: "Kia" });
    expect((admin.get("RnMentionPageProvider")!.input as { filtered: boolean }).filtered).toBe(true);
  });
});
