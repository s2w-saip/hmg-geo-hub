import "server-only";

// AI funnel adapter (unit U8): ACR (A-1 GET /v1/funnel/acr), GA4 conversion (C GET
// /v1/funnel/conversion) and the conversion-event dialog (BG-29 GET/PUT
// /v1/funnel/conversion/events). Design 3.3 "AI 퍼널·프롬프트 카탈로그", appendix D rules
// A1..A7 and C1..C7, decisions D6 (first render: acr + options + dates = 3 calls; conversion =
// 1 call), D8 (HGH_SOURCE_<group>: funnel global G4, website G3, project G6; legacy = the
// current functions, untouched).
//
// The screens keep their props: this module builds the legacy shapes
//   StandardAcr (lib/db/repositories/scope-aggregates.ts)          from AcrData
//   ConversionLive / AiTrafficConversionRollup (lib/ga4/conversion) from ConversionData
//   VisitsViewData (visits-view.tsx, AiVisits without user counts)  from ConversionData
//   Ga4EventRow (lib/ga4/tracked-events-service)                    from ConversionEventItem
//
// Backend additions used as delivered (no "before the backend round" fallbacks):
//   BG-28 project surface reads the project's property, BG-29 non-admin event path and
//   coverage.markets[].property_id, BG-30 days=7|28|90, BG-31 by_engine_all, BG-33
//   data.options.langs (ACR population languages).
//
// Known differences. Design DC list (front-adapter-plan 3.6 (나)):
//   DC-01  ACR with no engine chosen = the default engine only (legacy: every engine)
//   DC-03  GA4 conversion denominator = sessions (legacy: active users). Values only; the
//          labels are shared messages read by components outside U8 (see U8-N3)
//   DC-09  ACR trend = gated rounds (latest 12, round_date buckets), legacy = measured days,
//          whole history; territory rows are per ACR cell
// Outside the DC list (U8 numbering, for the A4 notice; asserted in funnel.test.ts KNOWN_DIFF):
//   U8-N1  ACR trend rounds with no ACR cells (gap, den 0) are left out, as the legacy day
//          buckets only existed where data existed
//   U8-N2  ACR acrPromptCount = catalog_acr_prompts of the account scope (legacy: root catalog
//          count without scope, design G4)
//   U8-N3  conversion labels still read "active users" (aiFunnelView.conversion.*, shared by
//          legacy and api, read by views outside U8) while the api values are sessions. The
//          relabel is a REQUIRED STEP of the G3/G4/G6 flip (cutover checklist), not per request
//   U8-N4  visits: the unique-visitor and visit-frequency cards and the users column are hidden
//          (the API has no user counts, BG-32 not provided); legacy showed them
//   U8-N5  7/28-day windows end at the latest loaded GA4 date (days=N), legacy ended today
//   U8-N6  conversion page table: the first 12 of one 15-row list ordered by AI sessions
//          (legacy: 12 rows by AI active users); the visits table uses the same list
//   U8-N7  market state comes from coverage.markets[].status: pending_grant = "측정 대기"
//          (legacy: a GA4 call failure), a registry-unmapped market has no property
//   U8-N8  conversion-event counts come from the loaded events report (legacy: live GA4);
//          a save is queued (propagation pending, design G14): the conversion numbers move
//          after the next load. The action returns that wording as value.notice
//          (adminGa4.events.savedPending); the dialog (components/dash/ga4-events-dialog.tsx,
//          outside U8) still toasts the plain "saved" text until it shows value.notice (one
//          line, to coordinate before the G3/G6/G7 flip). A property outside the admin registry
//          cannot be saved (404 -> error text, design G13). data.can_edit and data.registered
//          are not shown: the dialog takes canEdit from the page, so an unregistered property
//          still offers Save and answers with the notRegistered text
//   U8-N9  the conversion-event dialog source follows the calling place (tracked-events-
//          actions.ts eventsPlace): with a project G6; without one, an admin whose menu reaches
//          /admin/ga4 is the registry place (G7, GET/PUT /v1/admin/ga4/properties/{id}/events),
//          everyone else the website place (G3, BG-29). The action cannot see the page, so an
//          admin who opens the dialog from /website/ai-funnel/conversion also reads G7: flip G3
//          and G7 together for admins, or accept the mixed source on that one dialog
//   U8-N15 website ACR (static sample, options only): the filter options are the website
//          surface's (no catalog taxonomy: catalog null -> catalogRows [] hides the catalog
//          axis; countries measured on the website surface). Legacy listed the standard
//          catalog taxonomy and the countries measured on the global surface
//   U8-N16 with an engine filter the comparison cohort ("human") is non-AI traffic only; legacy
//          computed it as total minus the selected engines, so the other AI engines counted
//          as "human" (summary, trend, pages, rollup). Without an engine filter both agree
//   U8-N17 website conversion geography options = website-surface countries (virtual site
//          codes included); legacy listed the countries measured on the global surface
//   U8-N20 the ACR trend hint still reads "일별 최종 추천 선택률" (aiFunnelView.acr.trend.hint,
//          read by acr-live-view.tsx outside U8) while the api buckets are rounds (DC-09). The
//          relabel ("회차별") is a REQUIRED STEP of the G4 flip (cutover checklist)
//   U8-N22 ACR trend: a series brand with no ACR row in a round shows 0 % (the backend sends
//          num 0 for every series brand); legacy left that day's key out and the chart line
//          skipped the point (connectNulls). Found by funnel.acr.parity.test.ts
import type { StandardAcr } from "@/lib/db/repositories/scope-aggregates";
import type {
  AiTrafficConversionCountry,
  AiTrafficConversionRollup,
  ConversionFilters,
  ConversionLive,
  EngineBreakdownRow,
} from "@/lib/ga4/conversion";
import type { Ga4EventRow } from "@/lib/ga4/tracked-events-service";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import type { VisitsViewData } from "@/app/[locale]/(dash)/standard/ai-funnel/_components/visits-view";
import type { components } from "../api-types";
import { hghGet, hghPut } from "../client";
import { filterNotices, pct1OrNull, wholeSuppression, type ApiMeta, type FilterNotices } from "../convert";
import { withParams, type Surface } from "../query";
import { analysisQuery, type AnalysisQueryContext } from "./filters";

type S = components["schemas"];
export type ApiAcrData = S["AcrData"];
export type ApiConversionData = S["ConversionData"];
export type ApiConversionMarket = S["app__features__analytics__funnel__conversion__schemas__Market"];
export type ApiConversionEvents = S["ConversionEventsData"];
export type ApiAdminEvents = S["EventsData"];

// ── ACR (A1..A7) ─────────────────────────────────────────────────────────────

const EMPTY_ACR: StandardAcr = {
  measured: false,
  brands: [],
  trend: [],
  battle: [],
  modelConversion: [],
  territory: [],
  totals: { promptRuns: 0, prompts: 0, iterations: 0, engines: [] },
};

/** AcrData -> StandardAcr (rules A1..A7). Percentages: round1(100 n / d), d 0 -> null (legacy pct). */
export function toStandardAcr(d: ApiAcrData, meta: Pick<ApiMeta, "suppressed">): StandardAcr {
  // A1: measured = there is at least one cell and the response is not suppressed as a whole.
  if (!(d.totals.prompt_runs > 0) || wholeSuppression(meta)) return { ...EMPTY_ACR, totals: { ...EMPTY_ACR.totals } };
  return {
    measured: true,
    // A2
    brands: d.brands.map((b) => ({
      brand: b.brand,
      isOurs: b.is_ours,
      choiceCount: b.choice,
      appearanceCount: b.appearance,
      choiceShare: pct1OrNull(b.choice_share),
      coverage: pct1OrNull(b.coverage),
    })),
    // KPI 카드: 관점 당사 합계(상위 12 밖 당사·여러 당사 브랜드 합)
    ...(d.own
      ? {
          own: {
            choiceCount: d.own.choice,
            appearanceCount: d.own.appearance,
            choiceShare: pct1OrNull(d.own.choice_share),
            coverage: pct1OrNull(d.own.coverage),
          },
        }
      : {}),
    // A3 (DC-09, U8-N1): one bucket per round with cells; value = choice / that round's iterations.
    trend: d.trend.buckets
      .filter((b) => !b.gap && b.den > 0)
      .map((b) => {
        const series: Record<string, number | null> = {};
        for (const p of b.series) series[p.brand] = pct1OrNull({ num: p.num, den: b.den });
        return { date: b.round_date, series };
      })
      .sort((a, b) => a.date.localeCompare(b.date)),
    // A4
    battle: d.battle.map((r) => ({
      promptId: r.prompt_id,
      promptText: r.prompt_text ?? null,
      cells: r.cells.map((c) => ({
        engine: c.engine,
        winner: c.winner_brand ?? null,
        winnerIsOurs: c.winner_is_ours,
        choiceCount: c.choice,
      })),
    })),
    // A5
    modelConversion: d.model_conversion.map((m) => ({
      brand: m.brand ?? null,
      model: m.model,
      isOurs: m.is_ours,
      conversionRate: pct1OrNull(m.conversion),
      shortlistCount: m.cells,
      top1Count: m.top1,
    })),
    // A6: the country code is shown as is (legacy too)
    territory: d.territory.map((s) => ({
      region: s.country ?? null,
      engine: s.engine,
      rows: s.rows.map((r) => ({
        promptId: r.prompt_id,
        promptText: r.prompt_text ?? null,
        validAcr: r.valid_acr,
        entries: r.entries.map((e) => ({ brand: e.brand, choice: e.choice, isOurs: e.is_ours })),
      })),
    })),
    // A7
    totals: {
      promptRuns: d.totals.prompt_runs,
      prompts: d.totals.prompts,
      iterations: d.totals.iterations,
      engines: [...d.totals.engines],
    },
  };
}

export interface AcrScreen {
  data: StandardAcr;
  /**
   * Catalog ACR prompts (the waiting-state count, legacy countStandardAcrPrompts). Counted only for
   * an unmeasured answer (include_catalog_count=false, B097): with cells it is 0 here, and the
   * screen reads it only in the waiting state (data.measured false).
   */
  acrPromptCount: number;
  /** ACR population languages (BG-33), legacy listMeasuredAcrLanguages. */
  languageOptions: string[];
  notices: FilterNotices;
}

/**
 * GET /v1/funnel/acr with the screen's filters (analysisQuery). The extension parameters keep
 * their defaults, which equal the legacy constants (top 12 brands, 5 series, 200 battle rows,
 * 12 sheets, 12 models); trend_cycles keeps the backend default 12 (DC-09). B097: the screen
 * takes its countries from /v1/filters/options and reads the catalog count only while unmeasured,
 * so include_option_countries=false and include_catalog_count=false skip those statements.
 */
export async function loadAcrScreen(filters: StandardFilters, ctx: AnalysisQueryContext): Promise<AcrScreen> {
  const { query, cf } = analysisQuery(filters, ctx);
  const res = await hghGet("/v1/funnel/acr", {
    query: withParams(query, { include_option_countries: false, include_catalog_count: false }),
    cf,
  });
  return {
    data: toStandardAcr(res.data, res.meta),
    acrPromptCount: res.data.totals.catalog_acr_prompts ?? 0,
    languageOptions: [...(res.data.options?.langs ?? [])],
    notices: filterNotices(res.meta),
  };
}

// ── conversion (C1..C7) ──────────────────────────────────────────────────────

/** Engines the conversion panel offers (legacy PANEL_ENGINES, conversion.ts). */
export const CONVERSION_PANEL_ENGINES = ["chatgpt", "gemini"] as const;
/** Page rows the API returns: the visits table (15) and the conversion page table (first 12). */
export const CONVERSION_PAGE_LIMIT = 15;
export const CONVERSION_PAGE_TABLE_ROWS = 12;

/**
 * Legacy GA4 percent: Math.round(n / d * 1000) / 10. A cohort with no session (d 0) has no rate: null ("—"), not 0.0 %
 * (legacy pct gave 0, so an engine with no Gemini session read AI 0.0 % and a gap of minus the human rate).
 */
export const conversionPct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);
const pct = conversionPct;
/** Gap in pp; undefined (null) when either rate is. */
const lift = (ai: number | null, human: number | null): number | null =>
  ai == null || human == null ? null : Math.round((ai - human) * 10) / 10;

export interface ConversionMarketView {
  brand: string;
  country: string;
  /** GA4 property of the market (null when unmapped). */
  propertyId: string | null;
  status: ApiConversionMarket["status"];
}

export interface ConversionScreen {
  markets: ConversionMarketView[];
  /** One market in scope (the legacy country-leaf branch). */
  isCountryLeaf: boolean;
  /** Property of the single market (country leaf), else null. */
  singlePropertyId: string | null;
  liveData: ConversionLive | null;
  rollupData: AiTrafficConversionRollup | null;
  visitsData: VisitsViewData | null;
  notices: FilterNotices;
}

export interface ConversionRequest {
  surface: Surface;
  /** Required on surface=project. */
  projectId?: string;
  /** URL geography values (global/website). Not sent on project (the backend fixes the market). */
  geography?: readonly string[];
  filters: ConversionFilters;
  /** 7 | 28 | 90 (parseConversionPeriod). */
  days: number;
}

/**
 * Query for GET /v1/funnel/conversion: CommonFilters via analysisQuery + device, visitor_type, days, page_limit,
 * rollup_lite (B096: with two or more markets the screen draws the rollup, which reads summary, by_country
 * and coverage only, so the backend skips the page and engine-compare statements and sends trend /
 * by_engine / by_engine_all / pages empty; one market (country leaf) is unaffected).
 */
export function conversionQuery(req: ConversionRequest) {
  const ctx: AnalysisQueryContext = { surface: req.surface, projectId: req.projectId, scope: null };
  const common = analysisQuery(
    {
      region: req.surface === "project" ? undefined : [...(req.geography ?? [])],
      websiteCountry: req.surface === "website" ? [...(req.geography ?? [])] : undefined,
      engine: req.filters.engine,
    },
    ctx,
  );
  const device = [...new Set(req.filters.device ?? [])].sort() as ("mobile" | "desktop" | "tablet")[];
  const visitor = [...new Set(req.filters.visitorType ?? [])].sort() as ("new" | "returning")[];
  return {
    query: withParams(common.query, {
      ...(device.length ? { device } : {}),
      ...(visitor.length ? { visitor_type: visitor } : {}),
      days: req.days,
      page_limit: CONVERSION_PAGE_LIMIT,
      rollup_lite: true,
    }),
    cf: common.cf,
  };
}

function marketsOf(d: ApiConversionData): ConversionMarketView[] {
  return d.coverage.markets.map((m) => ({
    brand: m.brand,
    country: m.country,
    propertyId: m.status === "unmapped" ? null : (m.property_id ?? null),
    status: m.status,
  }));
}

/** C4: always the two panel engines (0 rows kept), engine[] not applied (by_engine_all, BG-31). */
export function toEngineBreakdown(d: ApiConversionData): EngineBreakdownRow[] {
  const rows = d.by_engine_all ?? d.by_engine;
  return CONVERSION_PANEL_ENGINES.map((engine) => {
    const r = rows.find((x) => x.engine === engine);
    const sessions = r?.sessions ?? 0;
    const conversions = r?.conversions ?? 0;
    return { engine, users: sessions, keyEvents: conversions, convRate: pct(conversions, sessions) };
  });
}

/** C1..C4: the country-leaf live view, or null when both cohorts have no session (legacy "no data"). */
export function toConversionLive(d: ApiConversionData, propertyId: string | null): ConversionLive | null {
  const ai = d.summary.ai;
  const human = d.summary.human;
  if (ai.sessions + human.sessions === 0) return null;
  const aiConvRate = pct(ai.conversions, ai.sessions);
  const humanConvRate = pct(human.conversions, human.sessions);
  return {
    propertyId: propertyId ?? "",
    range: { start: d.period.from ?? "", end: d.period.to ?? "" },
    summary: {
      aiConvRate,
      humanConvRate,
      lift: lift(aiConvRate, humanConvRate),
      aiUsersTotal: ai.sessions,
      humanUsersTotal: human.sessions,
      aiKeyEvents: ai.conversions,
      humanKeyEvents: human.conversions,
    },
    // C2
    trend: [...d.trend]
      .map((p) => ({
        date: p.date,
        ai: pct(p.ai_conversions, p.ai_sessions),
        human: pct(p.human_conversions, p.human_sessions),
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    // C3 (U8-N6)
    pages: d.pages
      .filter((p) => p.ai_sessions > 0)
      .slice(0, CONVERSION_PAGE_TABLE_ROWS)
      .map((p) => {
        const a = pct(p.ai_conversions, p.ai_sessions);
        const h = pct(p.human_conversions, p.human_sessions);
        return { url: p.url, aiUsers: p.ai_sessions, humanUsers: p.human_sessions, aiConvRate: a, humanConvRate: h, lift: lift(a, h) };
      }),
    byEngine: toEngineBreakdown(d),
  };
}

function countryRow(brand: string, country: string, ai: { sessions: number; conversions: number }, human: { sessions: number; conversions: number }): AiTrafficConversionCountry {
  const a = pct(ai.conversions, ai.sessions);
  const h = pct(human.conversions, human.sessions);
  return {
    brand, country, aiConvRate: a, humanConvRate: h, lift: lift(a, h), aiUsers: ai.sessions, humanUsers: human.sessions,
    aiKeyEvents: ai.conversions, humanKeyEvents: human.conversions,
  };
}

/**
 * C5: the region / HQ rollup. byCountry = data.by_country (two or more active markets); with one
 * active market the row is built from the summary; markets whose two cohorts have no session are
 * left out and measuredMarkets counts the rows kept (legacy definition). totalMarkets = markets
 * in scope (coverage), unmapped included.
 */
export function toConversionRollup(d: ApiConversionData): AiTrafficConversionRollup {
  const ai = d.summary.ai;
  const human = d.summary.human;
  let rows: AiTrafficConversionCountry[];
  if (d.by_country) {
    rows = d.by_country.map((r) => countryRow(r.brand, r.country, r.ai, r.human));
  } else {
    const active = d.coverage.markets.filter((m) => m.status === "active");
    rows = active.length === 1 ? [countryRow(active[0].brand, active[0].country, ai, human)] : [];
  }
  const byCountry = rows.filter((r) => r.aiUsers > 0 || r.humanUsers > 0);
  const aiConvRate = pct(ai.conversions, ai.sessions);
  const humanConvRate = pct(human.conversions, human.sessions);
  return {
    aiConvRate,
    humanConvRate,
    lift: lift(aiConvRate, humanConvRate),
    measuredMarkets: byCountry.length,
    totalMarkets: d.coverage.markets.length,
    totalAiUsers: ai.sessions,
    totalHumanUsers: human.sessions,
    totalAiKeyEvents: ai.conversions,
    totalHumanKeyEvents: human.conversions,
    byCountry,
  };
}

/** C6: the visits sub-KPI (AI cohort sessions), or null when there is no AI session (legacy). */
export function toVisits(d: ApiConversionData, propertyId: string | null): VisitsViewData | null {
  const ai = d.summary.ai;
  if (ai.sessions === 0) return null;
  return {
    propertyId: propertyId ?? "",
    range: { start: d.period.from ?? "", end: d.period.to ?? "" },
    totalSessions: ai.sessions,
    totalUsers: null, // U8-N4: no user counts in the API
    pageViews: ai.page_views,
    pages: d.pages
      .filter((p) => p.ai_sessions > 0)
      .slice(0, CONVERSION_PAGE_LIMIT)
      .map((p) => ({ url: p.url, sessions: p.ai_sessions, users: null })),
    // days with AI sessions only: the legacy GA4 report had no row for a day without AI traffic
    trend: d.trend
      .filter((p) => p.ai_sessions > 0)
      .map((p) => ({ date: p.date, sessions: p.ai_sessions }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/**
 * The page branches of the legacy conversion pages from one response:
 *   one market, active        -> live + visits (country leaf)
 *   one market, pending_grant -> no live data ("측정 대기" notice), property kept for the dialog
 *   one market, unmapped      -> no property ("GA4 미연동" notice)
 *   two or more markets       -> rollup
 *   no market                 -> nothing (the view shows its sample, as legacy)
 */
export function toConversionScreen(d: ApiConversionData, meta: ApiMeta): ConversionScreen {
  const markets = marketsOf(d);
  const isCountryLeaf = markets.length === 1;
  const single = isCountryLeaf ? markets[0] : null;
  const live = single !== null && single.status === "active" ? single : null;
  return {
    markets,
    isCountryLeaf,
    singlePropertyId: single?.propertyId ?? null,
    liveData: live ? toConversionLive(d, live.propertyId) : null,
    rollupData: !isCountryLeaf && markets.length > 0 ? toConversionRollup(d) : null,
    visitsData: live ? toVisits(d, live.propertyId) : null,
    notices: filterNotices(meta),
  };
}

/** GET /v1/funnel/conversion once (C7: days = the page's 7/28/90 window, BG-30). */
export async function loadConversionScreen(req: ConversionRequest): Promise<ConversionScreen> {
  const { query, cf } = conversionQuery(req);
  const res = await hghGet("/v1/funnel/conversion", { query, cf });
  return toConversionScreen(res.data, res.meta);
}

// ── conversion events (BG-29, admin AD GA4) ──────────────────────────────────

/** ConversionEventItem / EventItem -> Ga4EventRow. The backend order (tracked first, count desc, name) is kept. */
export function toEventRows(d: Pick<ApiConversionEvents | ApiAdminEvents, "items">): Ga4EventRow[] {
  return d.items.map((e) => ({ eventName: e.event_name, count: e.count, tracked: e.tracked }));
}

/** GET /v1/funnel/conversion/events (surface omitted: project with project_id, else website). */
export async function fetchConversionEvents(propertyId: string, projectId?: string): Promise<ApiConversionEvents> {
  const res = await hghGet("/v1/funnel/conversion/events", {
    query: { property_id: propertyId, ...(projectId ? { project_id: projectId } : {}) },
    retryOn401: true,
  });
  return res.data;
}

/** PUT /v1/funnel/conversion/events: replace the tracked set (the backend trims, dedupes, sorts). */
export async function putConversionEvents(propertyId: string, eventNames: readonly string[], projectId?: string) {
  const res = await hghPut("/v1/funnel/conversion/events", {
    query: { property_id: propertyId, ...(projectId ? { project_id: projectId } : {}) },
    body: { event_names: [...eventNames] },
    retryOn401: true,
  });
  return res.data;
}

/**
 * GET /v1/admin/ga4/properties/{id}/events: the admin GA4 registry's own read (source G7, the
 * registry screen). Admin role + admin menu group; a property outside the registry is 404.
 */
export async function fetchAdminConversionEvents(propertyId: string): Promise<ApiAdminEvents> {
  const res = await hghGet("/v1/admin/ga4/properties/{property_id}/events", {
    pathParams: { property_id: propertyId },
    retryOn401: true,
  });
  return res.data;
}

/** PUT /v1/admin/ga4/properties/{id}/events: replace the tracked set (queued: propagation pending). */
export async function putAdminConversionEvents(propertyId: string, eventNames: readonly string[]) {
  const res = await hghPut("/v1/admin/ga4/properties/{property_id}/events", {
    pathParams: { property_id: propertyId },
    body: { event_names: [...eventNames] },
    retryOn401: true,
  });
  return res.data;
}
