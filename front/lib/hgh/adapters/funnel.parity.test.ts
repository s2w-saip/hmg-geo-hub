import { describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import type { ConversionFilters } from "@/lib/ga4/conversion";

// Legacy <-> API parity of the GA4 conversion screens (unit U8).
//
// Method. One WORLD of GA4 rows (property, date, channel, source, device, visitor type,
// landing page, sessions, key events, page views) is read twice:
//   legacy: the UNCHANGED lib/ga4/conversion.ts functions the pages call (getAiConversionLive,
//           getAiVisitsLive, getAiTrafficConversionRollup), with runReport answered by a small
//           GA4 model over the WORLD (dimension filters: exact, in-list, and-group);
//   api:    a backend model of GET /v1/funnel/conversion over the same WORLD (AI cohort =
//           channel "AI Assistant", engine[] narrows the AI cohort only, device/visitor_type
//           both cohorts, by_engine_all without engine[]), converted by lib/hgh/adapters/funnel.
// The WORLD sets active users = sessions per row so the definition change DC-03 (active users ->
// sessions) does not move the numbers; what remains must be the documented KNOWN_DIFF.

const ga4 = vi.hoisted(() => ({ calls: 0 }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: () => undefined }));
vi.mock("@/lib/db/repositories/ga4-tracked-events", () => ({
  ga4TrackedEventRepository: {
    listForProperty: async () => [],
    listForProperties: async () => new Map<string, string[]>(),
  },
}));

interface Row {
  prop: string;
  date: string; // YYYYMMDD (GA4)
  channel: "AI Assistant" | "Organic Search";
  source: string;
  device: "mobile" | "desktop";
  nvr: "new" | "returning";
  landing: string;
  sessions: number;
  keyEvents: number;
  pageViews: number;
}
const R = (prop: string, date: string, ai: boolean, source: string, device: Row["device"], nvr: Row["nvr"], landing: string, sessions: number, keyEvents: number, pageViews = sessions * 3): Row => ({
  prop,
  date,
  channel: ai ? "AI Assistant" : "Organic Search",
  source,
  device,
  nvr,
  landing,
  sessions,
  keyEvents,
  pageViews,
});
const WORLD: Row[] = [
  R("111", "20260901", true, "chatgpt.com", "mobile", "new", "/it/ev6", 40, 3),
  R("111", "20260901", true, "gemini.google.com", "desktop", "returning", "/it/ev6", 9, 1),
  R("111", "20260902", true, "chatgpt.com", "desktop", "new", "/it/sportage", 23, 2),
  R("111", "20260902", true, "perplexity.ai", "mobile", "new", "/it/picanto", 5, 0),
  R("111", "20260903", true, "gemini.google.com", "mobile", "returning", "/it/sportage", 11, 0),
  R("111", "20260901", false, "google", "mobile", "new", "/it/ev6", 300, 6),
  R("111", "20260902", false, "google", "desktop", "returning", "/it/sportage", 410, 4),
  R("111", "20260903", false, "bing", "mobile", "new", "/it/picanto", 97, 1),
  R("222", "20260901", true, "chatgpt.com", "mobile", "new", "/de/ev3", 31, 2),
  R("222", "20260902", false, "google", "desktop", "new", "/de/ev3", 250, 7),
  R("333", "20260902", false, "google", "desktop", "new", "/es/ceed", 80, 2), // no AI traffic
];

// ── GA4 model (runReport) ────────────────────────────────────────────────────

type Expr = { filter?: { fieldName: string; stringFilter?: { value: string }; inListFilter?: { values: string[] } }; andGroup?: { expressions: Expr[] } };
const FIELD: Record<string, (r: Row) => string> = {
  sessionDefaultChannelGroup: (r) => r.channel,
  sessionSource: (r) => r.source,
  deviceCategory: (r) => r.device,
  newVsReturning: (r) => r.nvr,
  landingPagePlusQueryString: (r) => r.landing,
  date: (r) => r.date,
};
function match(r: Row, e: Expr | undefined): boolean {
  if (!e) return true;
  if (e.andGroup) return e.andGroup.expressions.every((x) => match(r, x));
  const f = e.filter!;
  const v = FIELD[f.fieldName](r).toLowerCase();
  if (f.stringFilter) return v === f.stringFilter.value.toLowerCase();
  return f.inListFilter!.values.map((x) => x.toLowerCase()).includes(v);
}
const METRIC: Record<string, (r: Row) => number> = {
  activeUsers: (r) => r.sessions, // users = sessions in this WORLD (DC-03 neutralised)
  sessions: (r) => r.sessions,
  keyEvents: (r) => r.keyEvents,
  screenPageViews: (r) => r.pageViews,
};
async function runReport(prop: string, body: Record<string, unknown>) {
  ga4.calls += 1;
  const dims = ((body.dimensions as { name: string }[] | undefined) ?? []).map((d) => d.name);
  const metrics = (body.metrics as { name: string }[]).map((m) => m.name);
  const groups = new Map<string, number[]>();
  for (const r of WORLD) {
    if (r.prop !== prop || !match(r, body.dimensionFilter as Expr | undefined)) continue;
    const key = dims.map((d) => FIELD[d](r)).join("|");
    const acc = groups.get(key) ?? metrics.map(() => 0);
    metrics.forEach((m, i) => (acc[i] += METRIC[m](r)));
    groups.set(key, acc);
  }
  return {
    rows: [...groups.entries()].map(([key, vals]) => ({
      dimensionValues: dims.length ? key.split("|").map((value) => ({ value })) : [],
      metricValues: vals.map((v) => ({ value: String(v) })),
    })),
  };
}
vi.mock("@/lib/ga4/client", async (orig) => ({ ...(await orig<typeof import("@/lib/ga4/client")>()), runReport }));

const legacy = await import("@/lib/ga4/conversion");
const F = await import("./funnel");

// ── backend model: GET /v1/funnel/conversion ─────────────────────────────────

type S = components["schemas"];
const ENGINE_OF: Record<string, string> = { "chatgpt.com": "chatgpt", "gemini.google.com": "gemini", "perplexity.ai": "perplexity" };
const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const MARKETS = [
  { brand: "Kia", country: "IT", prop: "111" },
  { brand: "Kia", country: "DE", prop: "222" },
  { brand: "Kia", country: "ES", prop: "333" },
];

function backend(props: string[], f: ConversionFilters): S["ConversionData"] {
  const base = WORLD.filter(
    (r) => props.includes(r.prop) && (!f.device?.length || f.device.includes(r.device)) && (!f.visitorType?.length || f.visitorType.includes(r.nvr)),
  );
  const isAi = (r: Row) => r.channel === "AI Assistant";
  const inEngine = (r: Row) => !f.engine?.length || f.engine.includes(ENGINE_OF[r.source] ?? "other");
  const ai = base.filter((r) => isAi(r) && inEngine(r));
  const human = base.filter((r) => !isAi(r));
  const sum = (rows: Row[], k: "sessions" | "keyEvents" | "pageViews") => rows.reduce((s, r) => s + r[k], 0);
  const dates = [...new Set(base.map((r) => r.date))].sort();
  const pages = [...new Set(base.map((r) => r.landing))]
    .map((url) => ({
      url,
      ai_sessions: sum(ai.filter((r) => r.landing === url), "sessions"),
      ai_conversions: sum(ai.filter((r) => r.landing === url), "keyEvents"),
      human_sessions: sum(human.filter((r) => r.landing === url), "sessions"),
      human_conversions: sum(human.filter((r) => r.landing === url), "keyEvents"),
    }))
    .sort((a, b) => b.ai_sessions - a.ai_sessions)
    .slice(0, 15);
  const engineRows = (rows: Row[]) =>
    [...new Set(rows.map((r) => ENGINE_OF[r.source] ?? "other"))].map((engine) => {
      const e = rows.filter((r) => (ENGINE_OF[r.source] ?? "other") === engine);
      return { engine, sessions: sum(e, "sessions"), conversions: sum(e, "keyEvents"), conv: { num: sum(e, "keyEvents"), den: sum(e, "sessions") } };
    });
  const markets = MARKETS.filter((m) => props.includes(m.prop));
  return {
    period: { from: "2026-06-18", to: "2026-09-15" },
    summary: {
      ai: { sessions: sum(ai, "sessions"), conversions: sum(ai, "keyEvents"), page_views: sum(ai, "pageViews"), conv: { num: sum(ai, "keyEvents"), den: sum(ai, "sessions") } },
      human: { sessions: sum(human, "sessions"), conversions: sum(human, "keyEvents"), conv: { num: sum(human, "keyEvents"), den: sum(human, "sessions") } },
    },
    trend: dates.map((d) => ({
      date: iso(d),
      ai_sessions: sum(ai.filter((r) => r.date === d), "sessions"),
      ai_conversions: sum(ai.filter((r) => r.date === d), "keyEvents"),
      human_sessions: sum(human.filter((r) => r.date === d), "sessions"),
      human_conversions: sum(human.filter((r) => r.date === d), "keyEvents"),
    })),
    by_engine: engineRows(ai),
    by_engine_all: engineRows(base.filter(isAi)),
    pages,
    by_country:
      markets.length >= 2
        ? markets.map((m) => {
            const a = ai.filter((r) => r.prop === m.prop);
            const h = human.filter((r) => r.prop === m.prop);
            return { brand: m.brand, country: m.country, ai: { sessions: sum(a, "sessions"), conversions: sum(a, "keyEvents") }, human: { sessions: sum(h, "sessions"), conversions: sum(h, "keyEvents") } };
          })
        : null,
    coverage: {
      measured_markets: markets.length,
      total_markets: markets.length,
      markets: markets.map((m) => ({ brand: m.brand, country: m.country, status: "active" as const, as_of: "2026-09-15", property_id: m.prop })),
    },
  };
}
const META: S["Meta"] = { mode: "snapshot" };

// ── cases ────────────────────────────────────────────────────────────────────

const FILTER_CASES: { name: string; f: ConversionFilters }[] = [
  { name: "no filter", f: {} },
  { name: "engine gemini (AI cohort only; engine table keeps both engines)", f: { engine: ["gemini"] } },
  { name: "device mobile + new visitors (both cohorts)", f: { device: ["mobile"], visitorType: ["new"] } },
];

/**
 * U8-N16: with an engine filter the legacy "human" cohort was total minus the selected engines,
 * so it also held the other AI engines. Rebuild that legacy human side from the WORLD to prove
 * the difference is exactly those sessions and key events, and nothing else.
 */
function legacyHumanShift(prop: string[], f: ConversionFilters, pick: (r: Row) => boolean = () => true) {
  const rows = WORLD.filter(
    (r) =>
      prop.includes(r.prop) &&
      r.channel === "AI Assistant" &&
      !!f.engine?.length &&
      !f.engine.includes(ENGINE_OF[r.source] ?? "other") &&
      (!f.device?.length || f.device.includes(r.device)) &&
      (!f.visitorType?.length || f.visitorType.includes(r.nvr)) &&
      pick(r),
  );
  return { sessions: rows.reduce((s, r) => s + r.sessions, 0), keyEvents: rows.reduce((s, r) => s + r.keyEvents, 0) };
}

describe("country leaf: live conversion and visits (legacy GA4 functions vs adapter)", () => {
  for (const c of FILTER_CASES) {
    it(c.name, async () => {
      const [live, visits] = await Promise.all([legacy.getAiConversionLive("111", 90, c.f), legacy.getAiVisitsLive("111", 90, c.f)]);
      const screen = F.toConversionScreen(backend(["111"], c.f), META);
      expect(live).not.toBeNull();
      // range: legacy GA4 relative tokens vs the loaded window (U8-N5, not rendered)
      expect(live!.range).toEqual({ start: "90daysAgo", end: "today" });
      expect(screen.liveData!.range).toEqual({ start: "2026-06-18", end: "2026-09-15" });
      const api = screen.liveData!;
      if (c.f.engine?.length) {
        // AI side identical; the human side differs by exactly the other AI engines (U8-N16)
        const shift = legacyHumanShift(["111"], c.f);
        expect(shift.sessions).toBeGreaterThan(0);
        expect([api.summary.aiConvRate, api.summary.aiUsersTotal, api.summary.aiKeyEvents]).toEqual([
          live!.summary.aiConvRate,
          live!.summary.aiUsersTotal,
          live!.summary.aiKeyEvents,
        ]);
        expect(live!.summary.humanUsersTotal - api.summary.humanUsersTotal).toBe(shift.sessions);
        expect(live!.summary.humanKeyEvents - api.summary.humanKeyEvents).toBe(shift.keyEvents);
        expect(api.trend.map((p) => [p.date, p.ai])).toEqual(live!.trend.map((p) => [p.date, p.ai]));
        expect(api.pages.map((p) => [p.url, p.aiUsers, p.aiConvRate])).toEqual(live!.pages.map((p) => [p.url, p.aiUsers, p.aiConvRate]));
        for (const p of api.pages) {
          const lp = live!.pages.find((x) => x.url === p.url)!;
          expect(lp.humanUsers - p.humanUsers).toBe(legacyHumanShift(["111"], c.f, (r) => r.landing === p.url).sessions);
        }
        expect(api.byEngine).toEqual(live!.byEngine);
      } else {
        expect({ ...api, range: null }).toEqual({ ...live!, range: null });
      }

      if (visits === null) {
        expect(screen.visitsData).toBeNull();
      } else {
        const v = screen.visitsData!;
        expect([v.totalSessions, v.pageViews, v.trend]).toEqual([visits.totalSessions, visits.pageViews, visits.trend]);
        expect(v.pages.map((p) => [p.url, p.sessions])).toEqual(visits.pages.map((p) => [p.url, p.sessions]));
        // U8-N4: user counts are not reported (legacy had them)
        expect(visits.totalUsers).toBeGreaterThan(0);
        expect(v.totalUsers).toBeNull();
        expect(v.pages.every((p) => p.users === null)).toBe(true);
      }
    });
  }
});

describe("region rollup (legacy getAiTrafficConversionRollup vs adapter)", () => {
  for (const c of FILTER_CASES) {
    it(c.name, async () => {
      const markets = MARKETS.map((m) => ({ brand: m.brand, country: m.country, propertyId: m.prop }));
      const rollup = (await legacy.getAiTrafficConversionRollup(markets, 90, c.f))!;
      const screen = F.toConversionScreen(backend(["111", "222", "333"], c.f), META);
      expect(screen.isCountryLeaf).toBe(false);
      const api = screen.rollupData!;
      if (c.f.engine?.length) {
        // U8-N16 again: AI side identical, human side short by the other AI engines
        const shift = legacyHumanShift(["111", "222", "333"], c.f);
        expect([api.aiConvRate, api.totalAiUsers, api.totalAiKeyEvents, api.totalMarkets]).toEqual([
          rollup.aiConvRate,
          rollup.totalAiUsers,
          rollup.totalAiKeyEvents,
          rollup.totalMarkets,
        ]);
        expect(rollup.totalHumanUsers - api.totalHumanUsers).toBe(shift.sessions);
        expect(rollup.totalHumanKeyEvents - api.totalHumanKeyEvents).toBe(shift.keyEvents);
        expect(api.byCountry.map((r) => [r.country, r.aiUsers, r.aiConvRate])).toEqual(rollup.byCountry.map((r) => [r.country, r.aiUsers, r.aiConvRate]));
      } else {
        expect(api).toEqual(rollup);
      }
    });
  }
});

describe("the model answers from runReport (sanity)", () => {
  it("legacy calls went through the GA4 model", () => {
    expect(ga4.calls).toBeGreaterThan(0);
  });
});
