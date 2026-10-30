import type { ReactNode } from "react";
import type { AllowedScope } from "@/lib/auth/types";
import { screenGet, type ScreenQuery } from "@/lib/screen";
import type { CitationFilterBarScreen } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/citation-view";
import { RnBusyScope, RnFilterRuntime } from "../../../../_components/filter-runtime";
import { RnOverviewApplied, RnOverviewFilters, type OverviewFilterProps } from "../../../../_components/overview-filters";

// Filter options of the website Citation pages: the original website page's filter bar (citation/filter-bar,
// ctx.surface=website), drawn as the shared panel's Website Citation axes (surface "website": 사이트 국가 · 언어 · 엔진 ·
// 기간 · 출처, admin 브랜드).
export async function websiteCitationFilterProps(query: ScreenQuery, scope: AllowedScope): Promise<OverviewFilterProps> {
  const bar = await screenGet<CitationFilterBarScreen>("citation/filter-bar", query);
  return {
    stage: "citation",
    surface: "website",
    scope,
    catalogRows: bar.options.catalogRows,
    geographyOptions: bar.options.geographyOptions,
    languageOptions: bar.options.languageOptions,
    optionMatrix: bar.options.optionMatrix,
    collectionStartDay: bar.dates.collectionStartDay,
    latestAnchorDay: bar.dates.latestAnchorDay,
    selectableDates: bar.dates.selectableDates,
  };
}

// The sub pages' own URL state, which a filter change makes stale: a cursor of other filters is refused, and the URL
// list reuses its tab counts on a search move (back/bff/screens/citation.py tone_urls), so a filter change there starts
// the search over too.
export const PROMPTS_RESET = ["page", "cursor"] as const;
export const TONE_URLS_RESET = ["page", "cursor", "q"] as const;

/**
 * The sub pages (2026-10-30): they read the Citation page's filters from the URL, and now show them as the page's
 * removable tokens. Removing one reloads the list on the new filters from its start (`reset`). Without the filter
 * bar the list shows alone, as before.
 */
export async function RnWebsiteCitationSubFilters({
  query,
  scope,
  userId,
  reset,
  children,
}: {
  query: ScreenQuery;
  scope: AllowedScope;
  userId: string;
  reset: readonly string[];
  children: ReactNode;
}) {
  const props = await websiteCitationFilterProps(query, scope).catch(() => null);
  if (!props) return <>{children}</>;
  return (
    <RnFilterRuntime reset={reset}>
      <RnOverviewFilters props={props} savedFilters={{ page: "website-citation", userId, initial: [] }}>
        <div className="flex flex-col gap-3">
          <RnOverviewApplied />
          <RnBusyScope className="flex flex-col gap-4">{children}</RnBusyScope>
        </div>
      </RnOverviewFilters>
    </RnFilterRuntime>
  );
}
