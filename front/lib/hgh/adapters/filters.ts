import "server-only";

// Analysis common adapter, part 1 (unit U4): source switch, the one filter serializer entry,
// filter options (F-1 GET /v1/filters/options) and calendar/base dates (F-2 GET
// /v1/filters/dates). Design 2.4, 3.2 (1)(2), appendix A "공용 필터" and "필터 상태 →
// CommonFilters 직렬화", decision D4 (options load when the panel opens).
//
// Source switch (D8). The screens (U5..U8) branch per request:
//   isAnalysisApi(area, surface)  -> HGH_SOURCE_<sourceGroupFor(area, surface)> === "api"
//   global: dashboard G1, analysis (mentions, citations, answers) G2, funnel G4, prompts G5;
//   website surface G3 and project surface G6 for every area. legacy = the current functions,
//   untouched (lib/hgh may not import them at runtime: eslint LEGACY_DATA_BAN).
//
// One serializer (design 2.4). Every analysis call builds its CommonFilters query with
// analysisQuery(), which is toCommonQuery() (lib/hgh/query.ts, U1) plus one rule: a one-sided
// URL period (?time=2026-06-01.. or ..2026-06-30) is sent as that single end. Since core round
// 6 the backend closes it itself (missing to = latest round, missing from = first round), so
// no /v1/filters/dates call is needed before the data call (D6 first-render budget).
//
// Options (F-1). The API takes the period only (other axes come back in ignored_filters) and
// does not narrow by user choices; the legacy pages narrowed some lists by the applied brand
// (narrowScopeBrands). The adapter reproduces that from geo_matrix:
//   legacy                                    api (this module)
//   listCatalogTaxonomy()             STD:394 data.catalog.rows -> CatalogTaxonomyRow (camel,
//                                             funnel dropped, depth4 from BG-03), legacy order
//   listMeasuredRegions(optionScope)  AGG:7488 geo_matrix narrowed by optionBrandsFor(), regions
//   listMeasuredStandardLanguages     AGG:7679 same rows, non-null lang
//   listMeasuredScopeMatrix(scope)    AGG:7636 geo_matrix as is (global: not narrowed)
//   listWebsiteCountries/Languages/ScopeMatrix(optionScope) WS:175/104/142  narrowed geo_matrix
//   fetchProjectMeasuredEngines       SRV:792  data.engines[].code
//   project custom fields + values             data.custom_fields -> DynamicAxis (values sorted)
// Brand narrowing keeps brand-null rows (common / umbrella prompts), as the legacy readers kept
// the umbrella brand. Scope deny markers from the session adapter (brands ["HMG"], countries
// ["ZZ"]) are never treated as real values: a deny brand list narrows to common rows only.
//
// Dates (F-2). /v1/filters/dates takes no value axes (DATES_SUPPORT is empty): the calendar is
// the surface's, not the filter's (DC-22 on website). Mapping:
//   fetchSelectableAnchorDates / fetchProjectSelectableAnchorDates  SRV:5451/5483
//                                   -> dates reversed to ascending; [] -> undefined (legacy
//                                      "unknown" = old free calendar)
//   fetchLatestAnchorDay            SRV:5509 -> latest_round_date (always set; legacy null
//                                      while the period-compare switch was off: DC-16)
//   standardCollectionDates().firstMeasuredAt AGG:9601 -> first_measured_date as the KST
//                                      midnight instant (the panel folds it to a local day;
//                                      fleet value, legacy was scope-narrowed: DC-07)
//
// Known differences. Design DC list (front-adapter-plan 3.6 (나)): DC-06 (website options from
// measured answers, not registered sites), DC-07 (first measured date is the fleet value),
// DC-16 (latest round date always set), DC-22 (website calendar not narrowed by brand/country).
// Outside the DC list (U4 numbering, for the A4 notice; asserted in filters.parity.test.ts):
//   U4-N8  a country whose only answers failed is no longer offered (legacy listMeasuredRegions
//          had no status predicate; F-1 lists completed answers only)
//   U4-N9  a root catalog prompt without brand (NULL, not the umbrella) is a common row and its
//          countries/languages stay under a brand choice (legacy brand IN (<brands>, HMG) dropped it)
//   U4-N10 project geography options = the project's measured countries (legacy: the account's
//          measured countries, unrelated to the project)
//   U4-N11 project engine options = engines measured in the window (legacy, anchor axis on: the
//          default engine only while no engine is chosen, anchorDefaultEngineScope); tied to DC-01
//   U4-N12 preset end point E = latest_round_date of the screen's card family (legacy
//          fetchLatestAnchorDay: the period-compare window end, one value for every family)
// Sync S1 (temporary, asserted in filters.parity.test.ts):
//   S1-N1  standard options without ID: the legacy offers ID again (hmg-geo #302 b60fa40 emptied
//          HIDDEN_STANDARD_REGIONS), the backend hides it until BE-2 removes app.hidden_market
//          ('global','ID'). Release with BE-2 (the parity test's backend model then hides nothing)
import type { AllowedScope, MenuGroup, Role } from "@/lib/auth/types";
import { canAccessRoute } from "@/lib/auth/route-policy";
import type { StandardFilters } from "@/lib/scope/result-adapter";
import { narrowScopeBrands } from "@/lib/scope/hmg-brands";
import type { CatalogTaxonomyRow, DynamicAxis, MeasuredScopeCombo } from "@/components/dash/dimension-filter-panel";
import type { components } from "../api-types";
import { hghGet, hghSource, sourceGroupFor, type HghArea, type HghSource } from "../client";
import { ascendingDates, filterNotices, type ApiMeta, type FilterNotices } from "../convert";
import {
  API_DATE_MAX,
  API_DATE_MIN,
  isOpenEndedRange,
  toCommonQuery,
  type CommonFilterParams,
  type CommonQueryContext,
  type Surface,
} from "../query";
import { SCOPE_DENY_BRAND } from "./session";

type S = components["schemas"];
export type ApiOptionsData = S["OptionsData"];
export type ApiDatesData = S["DatesData"];
export type ApiGeoCombo = S["GeoCombo"];
export type ApiCatalogOptions = S["CatalogOptions"];
export type ApiCustomFieldOption = S["CustomFieldOption"];
export type ApiEngineOption = S["EngineOption"];
export type ApiSourceCategoryOption = S["SourceCategoryOption"];
export type ApiPresetRange = S["PresetRange"];

// ── source switch (D8) ──────────────────────────────────────────────────────

/** Analysis areas served by the U4 adapters (dashboard U5, mentions/citations U6-U7, funnel/prompts U8). */
export type AnalysisArea = Extract<HghArea, "dashboard" | "analysis" | "funnel" | "prompts">;

/** HGH_SOURCE_<group> for an analysis screen (sourceGroupFor: website G3, project G6). */
export function analysisSource(area: AnalysisArea, surface: Surface, env?: Record<string, string | undefined>): HghSource {
  return hghSource(sourceGroupFor(area, surface), env);
}

/** True when the screen's group flag is "api" (default legacy). */
export function isAnalysisApi(area: AnalysisArea, surface: Surface, env?: Record<string, string | undefined>): boolean {
  return analysisSource(area, surface, env) === "api";
}

// ── route gate for analysis BFF routes (/api/*) ─────────────────────────────
//
// A route handler has no (dash) layout above it, so it must apply the same place gate the
// layout applies to pages ((dash)/layout.tsx canAccessRoute(role, pathname, menuGroups)) BEFORE
// reading anything, on both sources (the backend's require_surface only guards the api
// source). The representative page of an (area, surface) is the screen family the data feeds:

/** Representative page per (surface, area): the ROUTES entry whose role/menu rule applies. */
export const ANALYSIS_ROUTE_PATHS: Readonly<Record<Surface, Readonly<Record<AnalysisArea, string>>>> = {
  global: {
    dashboard: "/dashboard",
    analysis: "/standard/answer-analysis",
    funnel: "/standard/ai-funnel",
    prompts: "/standard/prompts",
  },
  website: {
    dashboard: "/website",
    analysis: "/website/answer-analysis",
    funnel: "/website/ai-funnel",
    prompts: "/website/prompts",
  },
  project: {
    dashboard: "/projects",
    analysis: "/projects",
    funnel: "/projects",
    prompts: "/projects",
  },
};

export function analysisRoutePath(area: AnalysisArea, surface: Surface): string {
  return ANALYSIS_ROUTE_PATHS[surface][area];
}

/**
 * The (dash) place gate for an analysis BFF route: role and the account's menu-group
 * whitelist (the third argument is mandatory: without it canAccessRoute ignores menuGroups).
 */
export function canReadAnalysis(
  user: { role: Role; menuGroups?: readonly MenuGroup[] | null },
  area: AnalysisArea,
  surface: Surface,
): boolean {
  return canAccessRoute(user.role, analysisRoutePath(area, surface), user.menuGroups ?? null);
}

// ── the one serializer entry ────────────────────────────────────────────────

/** toCommonQuery context without dateBounds (the backend closes one-sided periods). */
export type AnalysisQueryContext = Omit<CommonQueryContext, "dateBounds">;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function clampDay(d: string): string {
  if (d < API_DATE_MIN) return API_DATE_MIN;
  if (d > API_DATE_MAX) return API_DATE_MAX;
  return d;
}

/**
 * StandardFilters -> CommonFilters query (+ cf) for every analysis endpoint. Same as
 * toCommonQuery (scope-injected values stripped, lists sorted, empty axes omitted) except a
 * one-sided period is passed through as that end alone (backend closes it: missing to =
 * latest round, missing from = first round). An unparseable one-sided day = no period, as in
 * toCommonQuery.
 */
export function analysisQuery(f: StandardFilters, ctx: AnalysisQueryContext): CommonFilterParams {
  if (!isOpenEndedRange(f)) return toCommonQuery(f, ctx);
  const out = toCommonQuery({ ...f, dateFrom: undefined, dateTo: undefined }, ctx);
  if (f.dateFrom && ISO_DAY.test(f.dateFrom)) out.query.from = clampDay(f.dateFrom);
  else if (f.dateTo && ISO_DAY.test(f.dateTo)) out.query.to = clampDay(f.dateTo);
  return out;
}

/** Both ends of a period are set and ordered (legacy fetchPeriodCompare selectedWindow rule). */
export function hasClosedPeriod(f: Pick<StandardFilters, "dateFrom" | "dateTo">): boolean {
  return Boolean(f.dateFrom && f.dateTo && ISO_DAY.test(f.dateFrom) && ISO_DAY.test(f.dateTo) && f.dateFrom <= f.dateTo);
}

// ── F-1 options ─────────────────────────────────────────────────────────────

export interface OptionsRequest {
  surface: Surface;
  /** Required for surface=project. */
  projectId?: string;
  /** The screen's period (options window = data window). One-sided is passed through. */
  dateFrom?: string;
  dateTo?: string;
}

export interface OptionsResponse {
  data: ApiOptionsData;
  meta: ApiMeta;
}

/**
 * GET /v1/filters/options. Only surface, project_id and the period are sent: the endpoint
 * supports the period only and must not be narrowed by user selections (the panel narrows
 * the matrix by its draft). In-request dedupe shares one call per (surface, project, period).
 */
export async function fetchFilterOptions(req: OptionsRequest): Promise<OptionsResponse> {
  const { query } = analysisQuery(
    { dateFrom: req.dateFrom, dateTo: req.dateTo },
    { surface: req.surface, projectId: req.projectId, scope: null },
  );
  const res = await hghGet("/v1/filters/options", { query });
  return { data: res.data, meta: res.meta };
}

const byNullableText = (a: string | null | undefined, b: string | null | undefined): number => {
  // PostgreSQL ASC default: NULLs last. Code-unit order for the rest (ASCII codes).
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return a < b ? -1 : 1;
};

/**
 * data.catalog -> CatalogTaxonomyRow[] (legacy listCatalogTaxonomy). null catalog (website)
 * -> undefined (the panel falls back to its static lists; website screens do not show catalog
 * axes). funnel is not a legacy column: dropped, then rows deduped on the legacy 7 columns.
 * Order = legacy ORDER BY listType, depth1, depth2, depth3 (brand, brandPresence, depth4 as
 * tie-breakers so the order is total).
 */
export function toCatalogRows(catalog: ApiOptionsData["catalog"]): CatalogTaxonomyRow[] | undefined {
  if (!catalog) return undefined;
  const seen = new Map<string, CatalogTaxonomyRow>();
  for (const r of catalog.rows) {
    const row: CatalogTaxonomyRow = {
      brand: r.brand ?? null,
      brandPresence: r.brand_presence ?? null,
      listType: r.list_type ?? null,
      depth1: r.depth1 ?? null,
      depth2: r.depth2 ?? null,
      depth3: r.depth3 ?? null,
      depth4: r.depth4 ?? null,
    };
    const key = JSON.stringify(row);
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()].sort(
    (a, b) =>
      byNullableText(a.listType, b.listType) ||
      byNullableText(a.depth1, b.depth1) ||
      byNullableText(a.depth2, b.depth2) ||
      byNullableText(a.depth3, b.depth3) ||
      byNullableText(a.brand, b.brand) ||
      byNullableText(a.brandPresence, b.brandPresence) ||
      byNullableText(a.depth4, b.depth4),
  );
}

/**
 * Brands the legacy option readers narrowed to: narrowScopeBrands(scope, requested).brands.
 * null = no brand narrowing (admin without a brand choice, or a scope without brands).
 * [] = common rows only (the scope deny marker ["HMG"], or only the umbrella chosen: the API
 * reports the umbrella as brand null, which is kept anyway).
 */
export function optionBrandsFor(scope: AllowedScope | null, requested?: readonly string[]): string[] | null {
  const narrowed = narrowScopeBrands(scope ?? { all: true }, requested?.length ? [...requested] : undefined);
  if (narrowed.all || !narrowed.brands?.length) return null;
  return narrowed.brands.filter((b) => b !== SCOPE_DENY_BRAND);
}

/** Legacy matrix order: ORDER BY region, lang, brand (NULLs last). */
function sortMatrix(rows: MeasuredScopeCombo[]): MeasuredScopeCombo[] {
  return rows.sort(
    (a, b) => byNullableText(a.region, b.region) || byNullableText(a.lang, b.lang) || byNullableText(a.brand, b.brand),
  );
}

/** geo_matrix rows kept by a brand narrowing (brand-null rows always stay), legacy order. */
export function narrowGeoMatrix(matrix: readonly ApiGeoCombo[], brands: readonly string[] | null): MeasuredScopeCombo[] {
  const set = brands ? new Set(brands) : null;
  const out: MeasuredScopeCombo[] = [];
  for (const r of matrix) {
    if (set && r.brand !== null && !set.has(r.brand)) continue;
    out.push({ brand: r.brand ?? null, region: r.region, lang: r.lang ?? null });
  }
  return sortMatrix(out);
}

/** Distinct regions of the narrowed matrix, sorted (legacy listMeasuredRegions / listWebsiteCountries). */
export function regionOptionsOf(matrix: readonly ApiGeoCombo[], brands: readonly string[] | null): string[] {
  return [...new Set(narrowGeoMatrix(matrix, brands).map((r) => r.region))].sort();
}

/** Distinct non-null languages of the narrowed matrix, sorted (legacy listMeasured*Languages). */
export function languageOptionsOf(matrix: readonly ApiGeoCombo[], brands: readonly string[] | null): string[] {
  const out = new Set<string>();
  for (const r of narrowGeoMatrix(matrix, brands)) if (r.lang) out.add(r.lang);
  return [...out].sort();
}

/** data.custom_fields -> DynamicAxis[] (project page: values sorted with localeCompare). */
export function toDynamicAxes(fields: ApiOptionsData["custom_fields"]): DynamicAxis[] {
  return (fields ?? []).map((f) => ({
    id: f.field_id,
    label: f.label,
    options: [...f.values].sort((a, b) => a.localeCompare(b)),
  }));
}

/** data.engines -> engine codes measured in the window (legacy fetchProjectMeasuredEngines). */
export function engineOptionsOf(engines: readonly ApiEngineOption[]): string[] {
  return engines.map((e) => e.code);
}

/** The default engine (applied when engine[] is empty: DC-01), or null. */
export function defaultEngineOf(engines: readonly ApiEngineOption[]): string | null {
  return engines.find((e) => e.is_default)?.code ?? null;
}

/**
 * Source categories with citations in the window, in display order (slug is the API value).
 * null = not requested (the backend computes them only with include=source_categories, WU-12): no options.
 */
export function sourceCategoryOptionsOf(cats: readonly ApiSourceCategoryOption[] | null | undefined): ApiSourceCategoryOption[] {
  return [...(cats ?? [])].sort((a, b) => a.ord - b.ord || byNullableText(a.slug, b.slug));
}

/** Panel option props (DimensionFilterPanel), same names and shapes as the legacy pages passed. */
export interface PanelFilterOptions {
  catalogRows?: CatalogTaxonomyRow[];
  geographyOptions: string[];
  /** Not set on project (the legacy project pages kept the static language list). */
  languageOptions?: string[];
  optionMatrix?: MeasuredScopeCombo[];
  engineOptions?: string[];
  dynamicAxes?: DynamicAxis[];
}

export interface PanelOptionsContext {
  surface: Surface;
  /** Session scope (only used to reproduce the legacy brand narrowing, never sent). */
  scope: AllowedScope | null;
  /** readStandardFilters result: brand (admin URL choice or the brand lock) narrows the lists. */
  filters: Pick<StandardFilters, "brand">;
}

/**
 * F-1 answer -> the option props each surface's page passed (legacy compositions):
 *   global  (dashboard/page.tsx:197-235): catalogRows, geography/language narrowed by the
 *           applied brand, optionMatrix NOT narrowed (the panel narrows by draft)
 *   website (website/page.tsx:165-172): geography/language/matrix narrowed by the applied
 *           brand; catalogRows undefined (catalog null; website panels hide catalog axes)
 *   project (projects/[id]/page.tsx:75-97 geography + dynamic axes; analysis/{mention,citation}
 *           catalogRows + engines + dynamic axes): geography = project measured countries
 *           (legacy: the account's measured countries), no languageOptions (static list kept)
 */
export function toPanelOptions(res: OptionsResponse, ctx: PanelOptionsContext): PanelFilterOptions {
  const matrix = res.data.geo_matrix;
  if (ctx.surface === "project") {
    return {
      catalogRows: toCatalogRows(res.data.catalog),
      geographyOptions: regionOptionsOf(matrix, null),
      engineOptions: engineOptionsOf(res.data.engines),
      dynamicAxes: toDynamicAxes(res.data.custom_fields),
    };
  }
  const brands = optionBrandsFor(ctx.scope, ctx.filters.brand);
  const narrowed: PanelFilterOptions = {
    geographyOptions: regionOptionsOf(matrix, brands),
    languageOptions: languageOptionsOf(matrix, brands),
  };
  if (ctx.surface === "website") {
    return { ...narrowed, optionMatrix: narrowGeoMatrix(matrix, brands) };
  }
  return { ...narrowed, catalogRows: toCatalogRows(res.data.catalog), optionMatrix: narrowGeoMatrix(matrix, null) };
}

/** fetchFilterOptions + toPanelOptions for a screen (one backend call, deduped in the request). */
export async function loadPanelOptions(
  req: OptionsRequest & { scope: AllowedScope | null; filters: Pick<StandardFilters, "brand"> },
): Promise<PanelFilterOptions> {
  const res = await fetchFilterOptions(req);
  return toPanelOptions(res, { surface: req.surface, scope: req.scope, filters: req.filters });
}

// ── F-2 dates ───────────────────────────────────────────────────────────────

/** Hidden-round family of the screen's cards (legacy AnchorHiddenFamily). */
export type DatesFamily = "mentions" | "citations" | "all";

export interface DatesRequest {
  surface: Surface;
  projectId?: string;
  /** Legacy default "mentions"; card surfaces with all 7 KPI pass "all", citation screens "citations". */
  family?: DatesFamily;
}

export interface DatesResponse {
  data: ApiDatesData;
  meta: ApiMeta;
}

/** GET /v1/filters/dates (no value axes: the calendar is the surface's). */
export async function fetchFilterDates(req: DatesRequest): Promise<DatesResponse> {
  const query: { surface: Surface; project_id?: string; family: DatesFamily } = {
    surface: req.surface,
    family: req.family ?? "mentions",
  };
  if (req.projectId && req.surface !== "global") query.project_id = req.projectId;
  const res = await hghGet("/v1/filters/dates", { query });
  return { data: res.data, meta: res.meta };
}

/** Selectable dates in the legacy contract: ascending; empty -> undefined (free calendar). */
export function selectableDatesOf(data: ApiDatesData): string[] | undefined {
  const dates = ascendingDates(data.dates);
  return dates.length ? dates : undefined;
}

/** The preset end point E (legacy fetchLatestAnchorDay), or null. */
export function latestAnchorDayOf(data: ApiDatesData): string | null {
  return data.latest_round_date ?? null;
}

/**
 * first_measured_date (KST date) as the ISO instant of that KST midnight. The panel prop
 * collectionStartDay is an instant the browser folds to its local day (legacy passed
 * firstMeasuredAt.toISOString()); for KST viewers the day is the same.
 */
export function collectionStartDayOf(data: ApiDatesData): string | null {
  const d = data.first_measured_date;
  if (!d || !ISO_DAY.test(d)) return null;
  return new Date(`${d}T00:00:00+09:00`).toISOString();
}

export interface FilterDatesView {
  selectableDates: string[] | undefined;
  latestAnchorDay: string | null;
  collectionStartDay: string | null;
  /** First measured round (KST date) as the API gives it. */
  firstMeasuredDate: string | null;
  /** Preset windows (end = latest_round_date, start clamped to first_measured_date). */
  presets: ApiPresetRange[];
  /** More than 400 rounds: the oldest are not selectable (appendix A gap). */
  truncated: boolean;
  notices: FilterNotices;
}

export function toFilterDatesView(res: DatesResponse): FilterDatesView {
  return {
    selectableDates: selectableDatesOf(res.data),
    latestAnchorDay: latestAnchorDayOf(res.data),
    collectionStartDay: collectionStartDayOf(res.data),
    firstMeasuredDate: res.data.first_measured_date ?? null,
    presets: [...res.data.presets],
    truncated: res.data.dates_truncated,
    notices: filterNotices(res.meta),
  };
}

/** fetchFilterDates + toFilterDatesView (one call; the three legacy readers share it). */
export async function loadFilterDates(req: DatesRequest): Promise<FilterDatesView> {
  return toFilterDatesView(await fetchFilterDates(req));
}
