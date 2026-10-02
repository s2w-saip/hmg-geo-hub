import "server-only";

// Prompt catalog adapter (unit U8): /standard/prompts (global root catalog, change history,
// per-prompt timeline) and /website/prompts (site catalog with the measurement lens, its
// options, calendar and the xlsx download). Design 3.3 "AI 퍼널·프롬프트 카탈로그", appendix D
// "/standard/prompts" and "/website/prompts", decisions D5 (cursor lists), D6, D7 (stream relay),
// D8 (HGH_SOURCE_<group>: prompts global G5, website G3; legacy = the current repository reads,
// untouched).
//
// Mapping (legacy -> api):
//   listStandardCatalogScoped(scope)   STD:287  GET /v1/prompts?surface=global&all=true (BG-34),
//                                               cursor chain only past 25,000 rows (maxPages 4)
//   standardCollectionDates(scope)     AGG:9601 GET /v1/filters/dates?surface=global
//   promptAuditLogRepository.listGlobalScoped({scope, from: now-90d})
//                                               GET /v1/prompts/history (default window 90 days,
//                                               first page = 500 rows, the legacy cap)
//   promptAuditLogRepository.listForPrompt(id) GET /v1/prompts/history?prompt_id&from=2000-01-01
//                                               &to=today KST (no window, as legacy; limit 100);
//                                               admin catalog place (G7): GET /v1/admin/catalog/
//                                               prompts/{id}/history (no window, limit 100)
//   listWebsitePromptsScoped(scope, filters, {sort, dir, page})
//                                      WS:507   GET /v1/prompts?surface=website&limit=50&cursor
//   listWebsiteCountries/Languages/Brands(scope) GET /v1/filters/options?surface=website
//   fetchSelectableAnchorDates("website", {}, "all") GET /v1/filters/dates?surface=website&family=all
//   export route (exceljs in the front)         GET /v1/prompts?surface=website&format=xlsx
//                                               &columns=screen&locale (BG-35), streamed
//
// Known differences. Design DC list (front-adapter-plan 3.6 (나)):
//   DC-01  /website/prompts with no engine chosen: answers, engines and last measured count the
//          default engines only (legacy lens: every engine). Rows and total are unaffected
//   DC-06  website filter options come from measured answers (registered-but-unmeasured sites
//          drop out of the country/language/brand lists)
//   DC-07  the collection-period start is the fleet first measured round (legacy: the account's
//          first completed answer)
// Outside the DC list (U8 numbering, for the A4 notice; asserted in catalog.test.ts KNOWN_DIFF):
//   U8-N10 collection period = gated round dates (first_measured_date .. latest_round_date);
//          legacy = min/max measured_at of completed answers as UTC days (design G20)
//   U8-N11 the history window is 90 KST calendar days (backend); legacy = now - 90 x 24 h
//   U8-N12 the timeline of a prompt outside the account scope is empty. Since U8 this holds on
//          both sources (the legacy action now checks listStandardCatalogScoped unless scope.all);
//          before U8 the legacy action read listForPrompt unscoped
//   U8-N13 /website/prompts pages by cursor: next = cursor, previous = history, no page jump;
//          a cursor that no longer fits (409 cursor_stale, 422 cursor_invalid) restarts on page 1
//          (legacy: an out-of-range page showed the last page)
//   U8-N14 the timeline action requires the account's menu group (3-argument route check, the
//          backend check_route) on both sources: /standard/prompts (standard group) or the admin
//          catalog (admin + admin group). Before U8 the action checked the role only
//   U8-N18 history row id = String(audit_id) (backend integer); legacy = the audit uuid. Only
//          a React key: no screen shows it
//   U8-N19 /website/prompts last measured = the latest round_date of the lens (YYYY-MM-DD,
//          design G23); legacy anchor-axis-off path = max(COALESCE(cycle_anchor_at,
//          measured_at)) as an ISO timestamp. Same day in KST, the time part is gone (rows of
//          one day sort by id under last-measured order, legacy by time); the anchor-axis-on
//          path was already YYYY-MM-DD
//   U8-N21 an admin whose menu reaches the admin catalog reads the timeline from the admin
//          group G7 (the admin catalog's source), also when opened from /standard/prompts: flip
//          G5 and G7 together for admins, or accept that one mixed dialog. With G7=api that admin
//          reads GET /v1/admin/catalog/prompts/{id}/history (admin + admin menu group, no
//          standard menu gate: backend request U8-7), so an admin without the standard menu
//          group is no longer refused (legacy allowed it)
//   CK-10  history `changes` keys are passed as stored (field -> {old, new})
import type { AllowedScope } from "@/lib/auth/types";
import type { StandardCatalogRow } from "@/lib/db/repositories/standards";
import type { PromptAuditLogView } from "@/lib/db/repositories/prompt-audit-logs";
import type { WebsitePromptSortKey, WebsitePromptViewRow } from "@/lib/db/repositories/website-sites";
import type { PromptAuditChanges } from "@/lib/standards/audit";
import type { components, operations } from "../api-types";
import { hghGet } from "../client";
import { isHghApiError, isCursorStale } from "../errors";
import { fetchAllPages, pageInfo } from "../paginate";
import { relayDownload } from "../relay";
import { todayKst, withParams } from "../query";
import { analysisQuery, fetchFilterOptions, loadFilterDates } from "./filters";

type S = components["schemas"];
export type ApiGlobalPromptRow = S["GlobalPromptRow"];
export type ApiWebsitePromptRow = S["WebsitePromptRow"];
export type ApiHistoryRow = S["HistoryRow"];
type PromptsQuery = operations["listPrompts"]["parameters"]["query"];

// ── /standard/prompts: catalog ───────────────────────────────────────────────

/** Rows per /v1/prompts page in all mode (backend GLOBAL_ALL_MAX) and the page cap of the read. */
export const GLOBAL_ALL_PAGE_ROWS = 25_000;
export const GLOBAL_CATALOG_MAX_PAGES = 4;

const isGlobalRow = (r: ApiGlobalPromptRow | ApiWebsitePromptRow): r is ApiGlobalPromptRow => "prompt_id" in r;
const isWebsiteRow = (r: ApiGlobalPromptRow | ApiWebsitePromptRow): r is ApiWebsitePromptRow => "website_prompt_id" in r;

/** GlobalPromptRow -> StandardCatalogRow (the fields the read-only list reads; soft-deleted rows never come). */
export function toStandardCatalogRow(r: ApiGlobalPromptRow): StandardCatalogRow {
  return {
    id: r.prompt_id,
    text: r.text,
    promptType: (r.prompt_type ?? null) as StandardCatalogRow["promptType"],
    category: r.category ?? null,
    brand: r.brand_code ?? null,
    // the stored value: the list derives the effective presence itself (brandPresenceOf)
    brandPresence: r.brand_presence ?? null,
    listType: r.list_type ?? null,
    depth1: r.depth1 ?? null,
    depth2: r.depth2 ?? null,
    depth3: r.depth3 ?? null,
    depth4: r.depth4 ?? null,
    funnelStage: r.funnel_stage ?? null,
    kind: r.kind,
    lang: r.lang ?? null,
    regions: r.regions ? [...r.regions] : null,
    scopePromptId: r.scope_prompt_id ?? null,
    scopeText: null,
    deletedAt: null,
  };
}

/**
 * The account's root catalog, all of it (legacy listStandardCatalogScoped). Scope is the
 * server's (brand + umbrella/NULL, target markets B1). Order = depth1, depth2, depth3, text,
 * prompt_id (legacy order plus the id tie-break).
 */
export async function listStandardCatalogApi(): Promise<{ rows: StandardCatalogRow[] }> {
  const res = await fetchAllPages(
    async (cursor) => {
      const r = await hghGet("/v1/prompts", {
        query: { surface: "global", all: true, ...(cursor ? { cursor } : {}) },
      });
      const info = pageInfo(r.meta);
      return { items: r.data.items.filter(isGlobalRow), nextCursor: info.nextCursor, total: info.total };
    },
    { maxPages: GLOBAL_CATALOG_MAX_PAGES },
  );
  return { rows: res.items.map(toStandardCatalogRow) };
}

/** Collection period header {from, to} (YYYY-MM-DD) or nulls (legacy standardCollectionDates, as UTC days). */
export async function standardCollectionPeriodApi(): Promise<{ from: string | null; to: string | null }> {
  const v = await loadFilterDates({ surface: "global" });
  return { from: v.firstMeasuredDate, to: v.latestAnchorDay };
}

// ── /standard/prompts: history ───────────────────────────────────────────────

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** jsonb {field: {old, new}} -> PromptAuditChanges (values as strings, as the legacy writer stored them). */
export function toAuditChanges(changes: ApiHistoryRow["changes"]): PromptAuditChanges {
  const out: PromptAuditChanges = {};
  for (const [field, v] of Object.entries(changes ?? {})) {
    const pair = (v ?? {}) as { old?: unknown; new?: unknown };
    out[field] = { old: str(pair.old), new: str(pair.new) };
  }
  return out;
}

/** HistoryRow -> PromptAuditLogView. */
export function toAuditView(r: ApiHistoryRow): PromptAuditLogView {
  return {
    id: String(r.audit_id),
    promptId: r.prompt_id,
    actorId: r.actor_id ?? null,
    actorType: r.actor_type,
    eventType: r.event_type,
    changes: toAuditChanges(r.changes),
    batchId: r.batch_id ?? null,
    createdAt: new Date(r.created_at),
    actorEmail: r.actor_email ?? null,
    promptText: r.prompt_text ?? null,
    promptBrand: r.prompt_brand ?? null,
  };
}

/** The history tab: default 90-day window, first page (500 rows, the legacy cap). */
export async function listGlobalAuditApi(): Promise<PromptAuditLogView[]> {
  const res = await hghGet("/v1/prompts/history", { query: { surface: "global", limit: 500 } });
  return res.data.items.map(toAuditView);
}

/** Legacy timeline has no period: from/to are always sent, else the backend applies 90 days. */
export const TIMELINE_FROM = "2000-01-01";

/** One prompt's timeline (latest 100), for the read-only action. */
export async function fetchPromptTimelineApi(promptId: string, today: string = todayKst()): Promise<PromptAuditLogView[]> {
  const res = await hghGet("/v1/prompts/history", {
    query: { surface: "global", prompt_id: promptId, from: TIMELINE_FROM, to: today, limit: 100 },
    retryOn401: true,
  });
  return res.data.items.map(toAuditView);
}

/**
 * One prompt's timeline for the admin catalog place (latest 100, no window, deleted prompts
 * included): the admin-only route, gated by admin + the admin menu group (backend request U8-7).
 */
export async function fetchAdminPromptTimelineApi(promptId: string): Promise<PromptAuditLogView[]> {
  const res = await hghGet("/v1/admin/catalog/prompts/{prompt_id}/history", {
    pathParams: { prompt_id: promptId },
    query: { limit: 100 },
    retryOn401: true,
  });
  return res.data.items.map(toAuditView);
}

// ── /website/prompts: list ───────────────────────────────────────────────────

/** Legacy sort key -> API sort name. */
export const WEBSITE_SORT_API: Readonly<Record<WebsitePromptSortKey, NonNullable<PromptsQuery["sort"]>>> = {
  prompt: "prompt",
  brand: "brand",
  country: "country",
  lang: "lang",
  targetUrl: "target_url",
  answers: "answers",
  lastMeasuredAt: "last_measured",
};

/** readWebsitePromptQuery output (filters are the scope-injected legacy values; injection is stripped). */
export interface WebsitePromptRequest {
  filters: {
    brands?: string[];
    countries?: string[];
    langs?: string[];
    search?: string;
    engines?: string[];
    dateFrom?: string;
    dateTo?: string;
  };
  sort: WebsitePromptSortKey;
  dir: "asc" | "desc";
}

/** Query for GET /v1/prompts?surface=website (list or export): analysisQuery + search, sort, dir. */
export function websitePromptQuery(req: WebsitePromptRequest, scope: AllowedScope | null) {
  const f = req.filters;
  const { query } = analysisQuery(
    {
      brand: f.brands,
      websiteCountry: f.countries,
      region: f.countries,
      lang: f.langs,
      engine: f.engines,
      dateFrom: f.dateFrom,
      dateTo: f.dateTo,
    },
    { surface: "website", scope },
  );
  const search = f.search?.trim();
  return withParams({ ...query, surface: "website" as const }, {
    ...(search ? { search } : {}),
    sort: WEBSITE_SORT_API[req.sort],
    dir: req.dir,
  });
}

/** WebsitePromptRow -> WebsitePromptViewRow. */
export function toWebsitePromptRow(r: ApiWebsitePromptRow): WebsitePromptViewRow {
  return {
    id: r.website_prompt_id,
    promptText: r.prompt_text,
    brand: r.brand_code,
    countryCode: r.country_code,
    langCode: r.lang_code,
    targetUrl: r.target_url,
    domain: r.domain,
    answers: r.answers,
    lastMeasuredAt: r.last_measured ?? null,
    engines: [...r.engines],
  };
}

export const WEBSITE_PROMPTS_API_PAGE_SIZE = 50;

export interface WebsitePromptPageApi {
  rows: WebsitePromptViewRow[];
  total: number;
  nextCursor: string | null;
  /** The given cursor no longer fitted (cursor_stale / cursor_invalid): this is page 1. */
  restarted: boolean;
}

/**
 * One page. A cursor that no longer fits the data generation (409 cursor_stale) or the
 * filters (422 cursor_invalid: the filter panel keeps ?cursor when it rewrites the URL) is
 * dropped once and the first page is read instead (U8-N13).
 */
export async function listWebsitePromptsApi(
  req: WebsitePromptRequest,
  scope: AllowedScope | null,
  cursor: string | null,
): Promise<WebsitePromptPageApi> {
  const base = websitePromptQuery(req, scope);
  const read = async (c: string | null) => {
    const res = await hghGet("/v1/prompts", {
      query: { ...base, limit: WEBSITE_PROMPTS_API_PAGE_SIZE, ...(c ? { cursor: c } : {}) },
    });
    const info = pageInfo(res.meta);
    const rows = res.data.items.filter(isWebsiteRow).map(toWebsitePromptRow);
    return { rows, total: info.total ?? rows.length, nextCursor: info.nextCursor };
  };
  try {
    return { ...(await read(cursor)), restarted: false };
  } catch (e) {
    const unusable = isCursorStale(e) || (isHghApiError(e) && e.status === 422 && e.code === "cursor_invalid");
    if (cursor !== null && unusable) return { ...(await read(null)), restarted: true };
    throw e;
  }
}

/** Filter options of the page (legacy site-catalog lists, now measured answers: DC-06). */
export interface WebsitePromptOptions {
  geographyOptions: string[];
  languageOptions: string[];
  brandOptions: string[];
}

/**
 * GET /v1/filters/options?surface=website without a period (the legacy lists had none):
 * countries = regions without virtual brand codes (HYUNDAI-N is chosen on the brand axis,
 * legacy isWebsiteBrandGeoCode filter), languages as given, brands = distinct geo_matrix
 * brands (brand_code equals the site brand label, e.g. "Hyundai N").
 */
export async function loadWebsitePromptOptions(): Promise<WebsitePromptOptions> {
  const { data } = await fetchFilterOptions({ surface: "website" });
  const geographyOptions = [...new Set(data.regions.filter((r) => r.kind !== "virtual_brand").map((r) => r.code))].sort();
  const languageOptions = [...new Set(data.languages)].sort();
  const brandOptions = [...new Set(data.geo_matrix.map((r) => r.brand).filter((b): b is string => !!b))].sort();
  return { geographyOptions, languageOptions, brandOptions };
}

/** Calendar of the website surface (every family, legacy "all"): ascending, [] -> undefined. */
export async function loadWebsitePromptDates(): Promise<string[] | undefined> {
  return (await loadFilterDates({ surface: "website", family: "all" })).selectableDates;
}

// ── /website/prompts: download ───────────────────────────────────────────────

export const XLSX_ACCEPT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Stream the xlsx of the same query (cursor and limit are not sent: the export is the whole
 * filtered list, backend cap 50,000 with X-Export-Truncated). columns=screen + locale = the
 * current 8-column file with labels and display names (BG-35).
 */
export async function relayWebsitePromptsExport(
  req: WebsitePromptRequest,
  scope: AllowedScope | null,
  locale: "ko" | "en",
): Promise<Response> {
  const query = { ...websitePromptQuery(req, scope), format: "xlsx" as const, columns: "screen" as const, locale };
  return relayDownload("/v1/prompts", { query, accept: XLSX_ACCEPT, retryOn401: true });
}
