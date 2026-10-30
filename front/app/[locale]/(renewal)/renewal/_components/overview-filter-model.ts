// Renewal Overview filter model — pure. Every rule here is the app's DimensionFilterPanel
// rule for the Overview (overview-filters.tsx → DimensionFilterPanel stage "overview"),
// built from the panel's own exported functions so the two cannot drift:
//   axes        = overviewOnlyGroups (stage "acr": acrOnlyGroups, "mention" / "citation": composeGroups) + admin brand slot − locked axes − empty catalog axes
//                 (surface "website": WEBSITE_ONLY_GROUPS, + 출처 카테고리 on Citation)
//   sections    = FILTER_SECTIONS rows (디멘션 / 프롬프트 필터), empty rows dropped
//   권역 axis   = single active brand, >1 measured region, not a region-pinned account
//   국가/언어   = option matrix narrowed by the picked brand(s) and countries
//   cascade     = catalog listType/depth narrowed by brand → listType → depth1 …
//   normalize   = pruneCascade → clearDescendantsIfEmpty → clearAxesDisabledBy
// The renewal page differs only in presentation and in applying picks at once.
// Parity is pinned by overview-filter-model.parity.test.tsx (renders the real panel) and, for the
// Website pages, website-filter-model.parity.test.tsx.

import {
  CASCADE_FIELDS,
  CATALOG_AXES,
  DIMENSIONS,
  FILTER_SECTIONS,
  catalogAxisHasValues,
  catalogOptionsFor,
  clearAxesDisabledBy,
  clearDescendantsIfEmpty,
  deriveMatrixOptions,
  orderGeographyOptions,
  pruneCascade,
  pruneToOptions,
  STAGE_PRIMARY,
  type CatalogTaxonomyRow,
  type DimensionGroup,
  type Draft,
  type MeasuredScopeCombo,
} from "@/components/dash/dimension-filter-panel";
import { overviewOnlyGroups } from "@/app/[locale]/(dash)/dashboard/_components/overview-filters";
import { acrOnlyGroups } from "@/app/[locale]/(dash)/standard/ai-funnel/_components/acr-live-view";
import { STANDARD_CITATION_V2_ONLY_GROUPS, composeGroups } from "@/app/[locale]/(dash)/standard/answer-analysis/_components/filter-groups";
import { VIRTUAL_GEO_CODES } from "@/lib/geo-catalog/geo-code-label";
import { pseudoCountryParent } from "@/lib/geo-catalog/pseudo-country";
import { rhqForCountry } from "@/lib/rhq";
import { scopeForGeoSurface } from "@/lib/scope/website-virtual-geo";
import type { AllowedScope } from "@/lib/auth/types";

export interface OverviewPanelInput {
  /**
   * The app panel this one mirrors: the Overview (default), the ACR page (acr-live-view.tsx
   * acrOnlyGroups), the Mention page (analysis-filter-bar.tsx composeGroups "mentions") or the
   * Citation page (composeGroups "citations" with STANDARD_CITATION_V2_ONLY_GROUPS = + 출처 카테고리 · 경쟁사).
   * "visibility" has no app panel to mirror (the original page takes a date form only): VISIBILITY_ONLY_GROUPS.
   * "conversion" mirrors the app's conversion stage (STAGE_PRIMARY.conversion): CONVERSION_ONLY_GROUPS.
   */
  stage?: "overview" | "acr" | "mention" | "citation" | "visibility" | "conversion";
  /**
   * "website" (2026-10-30): the app's Website filters for the Overview / Mention / Citation stages —
   * WEBSITE_ONLY_GROUPS (+ 출처 카테고리 on Citation), and the account scope as the Website surface sees it
   * (scopeForGeoSurface). Other stages keep their own axes. Default "standard" (Global).
   */
  surface?: "standard" | "website";
  scope?: AllowedScope;
  catalogRows?: CatalogTaxonomyRow[];
  geographyOptions?: string[];
  languageOptions?: string[];
  /**
   * 브랜드 axis options from the page's own read (the app panel's brandOptions: the Website Prompts page passes the
   * brands of website/prompts-options, renewal audit 13-4). Absent = the static DIMENSIONS.brand, as in the app.
   */
  brandOptions?: string[];
  optionMatrix?: MeasuredScopeCombo[];
}

/** Axis shown as its own panel section. `rhqRegion` is the 권역 pre-filter of 국가. */
export type PanelAxis = DimensionGroup | "rhqRegion";

export interface OverviewPanelModel {
  isAdmin: boolean;
  /** Axes the URL may carry for this account (commit set). */
  visibleGroups: DimensionGroup[];
  /** Section rows in render order, with 권역 inserted before 국가 when it applies. */
  sections: { id: string; axes: PanelAxis[] }[];
  /** Single brand that drives RHQ grouping (account brand or the one admin pick). */
  activeBrand: string | null;
  /** 국가 options after brand narrowing (sorted, before 권역 nav and display order). */
  geographyOptions: string[];
  /** 언어 options (narrowed by the picked countries). */
  languageOptions: readonly string[];
  /** Measured 권역 ids in first-occurrence order over the 국가 options. */
  regions: string[];
  countryToRhq: Map<string, string>;
}

/**
 * AI Visibility (2026-10-27): the axes the analytics reader applies — 국가 picks sites, AI 엔진 narrows
 * AI 크롤 only, 디바이스 narrows 검색 노출 only (hub_stores/analytics_reader.py visibility). The period
 * is days, not rounds: the page's own 측정 기간 row, not the time axis.
 */
export const VISIBILITY_ONLY_GROUPS: readonly DimensionGroup[] = ["geography", "engine", "device"];

/**
 * AI Conversion (2026-10-29): the app's GA4 axes — 국가 picks GA4 properties, AI 엔진 narrows the AI cohort only,
 * 디바이스 · 방문자 유형 narrow both cohorts (hub_stores/analytics_reader.py conversion). The period is the page's
 * own 측정 기간 row, as on AI Visibility.
 */
export const CONVERSION_ONLY_GROUPS: readonly DimensionGroup[] = STAGE_PRIMARY.conversion;

/**
 * Website (2026-10-30): the app's Website axes — 국가 (사이트 국가) · 언어 · AI 엔진 · 기간 (website-filters.tsx
 * WebsiteFilters, the website answer-analysis pages' WEBSITE_ONLY_GROUPS); Citation adds 출처 카테고리. Website
 * prompts carry no catalog tagging, so there is no catalog axis, and no 경쟁사 axis. The app's website
 * Mention / Citation panels saw the account scope as Global; the renewal pages see it as Website on every
 * page, as the app's Website Overview does (they differ only for a dedicated-site account).
 */
export const WEBSITE_ONLY_GROUPS: readonly DimensionGroup[] = ["geography", "language", "engine", "time"];

const websiteOnlyGroups = (stage: OverviewPanelInput["stage"], languageOptions?: string[]): DimensionGroup[] | null =>
  stage === "mention"
    ? composeGroups("mentions", { onlyGroups: [...WEBSITE_ONLY_GROUPS], languageOptions }).only
    : stage === "citation"
      ? composeGroups("citations", { onlyGroups: [...WEBSITE_ONLY_GROUPS, "source"], languageOptions }).only
      : stage === undefined || stage === "overview"
        ? [...WEBSITE_ONLY_GROUPS]
        : null;

const insertBrand = (base: DimensionGroup[]): DimensionGroup[] => {
  if (base.includes("brand")) return base;
  const i = base.indexOf("promptContext");
  return i === -1 ? [...base, "brand"] : [...base.slice(0, i + 1), "brand", ...base.slice(i + 1)];
};

export function overviewPanelModel(input: OverviewPanelInput, draft: Draft): OverviewPanelModel {
  const { stage, scope, catalogRows, geographyOptions, languageOptions, optionMatrix } = input;
  const isAdmin = scope?.all === true;
  const website = input.surface === "website" ? websiteOnlyGroups(stage, languageOptions) : null;
  const viewScope = scope ? scopeForGeoSurface(scope, website ? "website" : "standard") : scope;
  const lock = new Set<DimensionGroup>();
  if (!isAdmin) lock.add("brand");
  if (!isAdmin && viewScope?.countries?.length === 1) lock.add("geography");
  const only =
    website ??
    (stage === "acr"
      ? acrOnlyGroups(languageOptions)
      : stage === "mention"
        ? composeGroups("mentions", { languageOptions }).only
        : stage === "citation"
          ? composeGroups("citations", { onlyGroups: STANDARD_CITATION_V2_ONLY_GROUPS, languageOptions }).only
          : stage === "visibility"
            ? [...VISIBILITY_ONLY_GROUPS]
            : stage === "conversion"
              ? [...CONVERSION_ONLY_GROUPS]
              : overviewOnlyGroups(languageOptions));
  const base = isAdmin ? insertBrand(only) : only;
  const visibleGroups = base.filter((g) => {
    if (lock.has(g)) return false;
    if (catalogRows && CATALOG_AXES.has(g)) return catalogAxisHasValues(g, catalogRows);
    return true;
  });

  const activeBrand =
    (scope && !scope.all && scope.brands?.length === 1 ? scope.brands[0] : null) ??
    (scope?.all === true && (draft.brand?.length ?? 0) === 1 ? draft.brand![0] : null);
  const picked = draft.brand?.length ? draft.brand : activeBrand ? [activeBrand] : [];
  const matrix = optionMatrix?.length ? deriveMatrixOptions(optionMatrix, picked.length ? picked : null, draft.geography) : null;
  const geo = matrix?.regions ?? geographyOptions ?? [];
  const languages = matrix?.languages ?? languageOptions ?? DIMENSIONS.language;

  const countryToRhq = new Map<string, string>();
  const regions: string[] = [];
  if (activeBrand) {
    for (const iso of geo) {
      const id = rhqForCountry(activeBrand, pseudoCountryParent(iso));
      if (!id) continue;
      countryToRhq.set(iso, id);
      if (!regions.includes(id)) regions.push(id);
    }
  }
  const rhqPinned = !isAdmin && (scope?.regions?.length ?? 0) === 1;
  const rhqAxis = visibleGroups.includes("geography") && !rhqPinned && regions.length > 1;

  const sections = FILTER_SECTIONS.map((s) => ({
    id: s.id,
    axes: s.groups
      .filter((g) => visibleGroups.includes(g))
      .flatMap((g): PanelAxis[] => (g === "geography" && rhqAxis ? ["rhqRegion", "geography"] : [g])),
  })).filter((s) => s.axes.length > 0);

  return { isAdmin, visibleGroups, sections, activeBrand, geographyOptions: geo, languageOptions: languages, regions, countryToRhq };
}

/** Options of one value axis, in the app's order. `nav` = 권역 picks narrowing 국가. */
export function axisOptions(
  model: OverviewPanelModel,
  input: OverviewPanelInput,
  draft: Draft,
  group: DimensionGroup,
  nav: readonly string[],
): readonly string[] {
  if (input.catalogRows && CASCADE_FIELDS.has(group)) {
    const catalogDraft = model.activeBrand ? { ...draft, brand: [model.activeBrand] } : draft;
    return catalogOptionsFor(group, input.catalogRows, catalogDraft);
  }
  if (group === "geography") {
    const narrowed =
      nav.length > 0 && model.activeBrand
        ? model.geographyOptions.filter((iso) => {
            const id = rhqForCountry(model.activeBrand!, pseudoCountryParent(iso));
            return id ? nav.includes(id) : false;
          })
        : model.geographyOptions;
    return orderGeographyOptions(narrowed);
  }
  if (group === "language") return model.languageOptions;
  if (group === "brand" && input.brandOptions) return input.brandOptions;
  return DIMENSIONS[group];
}

/**
 * Group header of a 국가 option (null = no header). Only while no 권역 is being
 * navigated — the app groups the flat list by RHQ, virtual hub codes on top.
 */
export function geographyGroupOf(code: string, model: OverviewPanelModel): "globalHub" | { rhq: string } | null {
  if (VIRTUAL_GEO_CODES.has(code)) return "globalHub";
  if (!model.activeBrand) return null;
  const id = rhqForCountry(model.activeBrand, pseudoCountryParent(code));
  return id ? { rhq: id } : null;
}

/** The app's normalizeDraft (filter-draft-actions) after one axis changed. */
export function normalizeDraft(next: Draft, group: DimensionGroup, catalogRows?: CatalogTaxonomyRow[]): Draft {
  const pruned = catalogRows && (CASCADE_FIELDS.has(group) || group === "brand") ? pruneCascade(next, catalogRows) : next;
  return clearAxesDisabledBy(clearDescendantsIfEmpty(pruned, group));
}

/**
 * The panel's effects after any draft change, applied at once:
 *  · active brand changed → 국가·언어 cleared and 권역 nav reset
 *  · 국가 / 언어 picks outside the current options are dropped
 */
export function settleDraft(
  input: OverviewPanelInput,
  draft: Draft,
  nav: string[],
  prevActiveBrand: string | null,
): { draft: Draft; nav: string[] } {
  let d = draft;
  let n = nav;
  let model = overviewPanelModel(input, d);
  if (model.activeBrand !== prevActiveBrand) {
    n = [];
    if (d.geography?.length || d.language?.length) {
      d = { ...d };
      delete d.geography;
      delete d.language;
      model = overviewPanelModel(input, d);
    }
  }
  if (input.optionMatrix?.length) {
    const g = pruneToOptions(d, "geography", model.geographyOptions);
    if (g !== d) {
      d = g;
      model = overviewPanelModel(input, d);
    }
    d = pruneToOptions(d, "language", model.languageOptions);
  }
  return { draft: d, nav: n };
}

export function toggleValue(draft: Draft, group: DimensionGroup, value: string): Draft {
  const cur = draft[group] ?? [];
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  const out = { ...draft };
  if (next.length) out[group] = next;
  else delete out[group];
  return out;
}

export function clearGroup(draft: Draft, group: DimensionGroup): Draft {
  if (!draft[group]?.length) return draft;
  const out = { ...draft };
  delete out[group];
  return out;
}
