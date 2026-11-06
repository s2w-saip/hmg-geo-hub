// The filter panel's option and calendar props as the shared screens send them
// (back/bff/screens/shared.py: shared/panel-options, shared/filter-dates). Types only.
import type { CatalogTaxonomyRow, DynamicAxis, MeasuredScopeCombo } from "@/components/dash/dimension-filter-panel";
import type { components } from "./api-types";
import type { FilterNotices } from "./convert";

export type ApiPresetRange = components["schemas"]["PresetRange"];

/** Panel option props (DimensionFilterPanel), same names and shapes as the pages pass. */
export interface PanelFilterOptions {
  catalogRows?: CatalogTaxonomyRow[];
  geographyOptions: string[];
  /** Not set on project (the project pages keep the static language list). */
  languageOptions?: string[];
  optionMatrix?: MeasuredScopeCombo[];
  engineOptions?: string[];
  dynamicAxes?: DynamicAxis[];
}

/** The calendar props of a surface (GET /v1/filters/dates). */
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
