import type { ReactNode } from "react";
import type { AllowedScope } from "@/lib/auth/types";
import { RnBusyScope, RnFilterRuntime } from "../../_components/filter-runtime";
import { RnOverviewApplied, RnOverviewFilters } from "../../_components/overview-filters";
import { projectFilterProps } from "./project-filters-server";

/**
 * The project Citation sub pages (2026-11-03, P3): they read the Citation page's filters from the URL and show them as
 * the page's removable tokens (the website sub pages' rule, website-citation-filters.tsx). Removing one reloads the list
 * from its start (`reset`). Without the options the list shows alone.
 */
export async function RnProjectCitationSubFilters({
  id,
  sp,
  scope,
  userId,
  locale,
  reset,
  children,
}: {
  id: string;
  sp: Record<string, string | string[] | undefined>;
  scope: AllowedScope;
  userId: string;
  locale: string;
  reset: readonly string[];
  children: ReactNode;
}) {
  const props = await projectFilterProps(id, sp, scope, locale, "citation", "citations").catch(() => null);
  if (!props) return <>{children}</>;
  return (
    <RnFilterRuntime reset={reset}>
      <RnOverviewFilters props={props} savedFilters={{ page: "project-citation", userId, initial: [] }}>
        <div className="flex flex-col gap-3">
          <RnOverviewApplied />
          <RnBusyScope className="flex flex-col gap-4">{children}</RnBusyScope>
        </div>
      </RnOverviewFilters>
    </RnFilterRuntime>
  );
}
