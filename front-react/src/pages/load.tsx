import { useMemo, type ReactNode } from "react";
import { useLocale } from "use-intl";
import { useLocation, useParams } from "react-router-dom";
import { useBundle, type Read, type ReadControls } from "~/api/bundle";
import { ReadProvider } from "~/components/read-section";
import type { Query } from "~/api/client";
import { useSession } from "~/app/session";
import { PageError, PageLoading } from "~/app/states";
import { surfaceOf, type PageDefinition } from "~/app/pages";
import { RnEmpty } from "@/components/renewal-ui";
import { PageHeading } from "./page-heading";
import { RnFilterRuntime } from "@/app/[locale]/(renewal)/renewal/_components/filter-runtime";
import { RnOverviewFilters, RnFilterSplit, RnOverviewFilterPanel, RnOverviewFilterRail, RnOverviewApplied, type OverviewFilterProps } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import { RnPageFrame } from "@/app/[locale]/(renewal)/renewal/_components/filter-split";
import type { SavedFilterPage } from "@/app/[locale]/(renewal)/renewal/_components/saved-filters";
import { RnServiceWeekProvider } from "@/components/service-week/provider";
import type { ServiceWeekView } from "@/lib/service-week";

export function usePageContext(page: PageDefinition) {
  const locale = useLocale();
  const { id } = useParams();
  const { search } = useLocation();
  const { user } = useSession();
  if (!user) throw new Error("A connected page requires an authenticated HUB session");
  const sp = useMemo(() => {
    const params = new URLSearchParams(search);
    return Object.fromEntries([...new Set(params.keys())].map(key => [key, params.getAll(key).length > 1 ? params.getAll(key) : params.get(key)!]));
  }, [search]);
  const surface = surfaceOf(page);
  const query: Query = { ...sp, "ctx.surface": surface, ...(id ? { "ctx.project_id": id } : {}), ...(surface === "website" ? { "ctx.admin": user.scope.all, "ctx.role": user.role } : {}) };
  return { locale, id: id ?? "", search: search.replace(/^\?/, ""), sp, query, surface, user };
}
export type PageContext = ReturnType<typeof usePageContext>;
export interface Values extends ReadControls { value<T>(key: string): T; promise<T>(key: string): Promise<T>; stamp: string }
export function useReads(reads: Record<string, Read>) {
  const result = useBundle(reads);
  const cache = useMemo(() => new Map<string, { value: unknown; promise: Promise<unknown> }>(), [result.key]);
  // A late section must not replace promises already consumed by other sections.
  const promises = useMemo(() => Object.fromEntries(Object.entries(result.data).map(([key, value]) => {
    let entry = cache.get(key);
    if (!entry || entry.value !== value) { entry = { value, promise: Promise.resolve(value) }; cache.set(key, entry); }
    return [key, entry.promise];
  })), [result.data, cache]);
  const values = useMemo<Values>(() => ({ value: <T,>(key: string) => result.data[key] as T, promise: <T,>(key: string) => promises[key] as Promise<T>, stamp: result.key, states: result.states, retry: result.retry }), [result.data, result.key, promises, result.states, result.retry]);
  return { ...result, values };
}
export function Load({ result, children }: { result: ReturnType<typeof useReads>; children: (values: Values) => ReactNode }) {
  if (result.error) return <PageError error={result.error} retry={result.retry} />;
  if (result.pending) return <PageLoading />;
  return <>{children(result.values)}</>;
}
export const screenRead = (name: string, query: Query = {}, optional = false): Read => ({ name, query, optional });
export const sectionRead = (name: string, query: Query = {}): Read => ({ name, query, deferred: true });
export const hubRead = (name: string, query: Query = {}): Read => ({ name, query, kind: "hub" });
export function commonReads(ctx: PageContext): Record<string, Read> {
  return {
    ...(ctx.surface !== "project" ? { week: screenRead("shared/service-week", {}, true) } : {}),
  };
}
export function savedSource(ctx: PageContext, page: SavedFilterPage) {
  // The existing saved-filter hook loads and retries its own list without blocking screen data.
  return { page, userId: ctx.user.id, initial: null };
}
export function PageWeek({ ctx, values, children }: { ctx: PageContext; values: Values; children: ReactNode }) {
  const value = ctx.surface === "project" ? null : values.value<ServiceWeekView | null | undefined>("week");
  const week = useMemo(() => Promise.resolve(value ?? null), [value]);
  return <RnServiceWeekProvider week={week} notes>{children}</RnServiceWeekProvider>;
}
export function Frame({ page, ctx, values, filters, savedPage, children, reset }: {
  page: PageDefinition; ctx: PageContext; values: Values; filters?: OverviewFilterProps;
  savedPage?: SavedFilterPage; children: ReactNode; reset?: readonly string[];
}) {
  return <ReadProvider value={values}><PageWeek ctx={ctx} values={values}><RnFilterRuntime reset={reset}>
    {filters && savedPage ? <RnOverviewFilters props={filters} savedFilters={savedSource(ctx, savedPage)}>
      <RnFilterSplit header={<PageHeading page={page} values={values} ctx={ctx} />} panel={<RnOverviewFilterPanel />} rail={<RnOverviewFilterRail />} delayInHeader={page.kind === "mention" && ctx.surface === "global"}>
        <RnOverviewApplied /><div className="flex flex-col gap-4">{children}</div>
      </RnFilterSplit>
    </RnOverviewFilters> : <RnPageFrame header={<PageHeading page={page} values={values} ctx={ctx} />}>{children}</RnPageFrame>}
  </RnFilterRuntime></PageWeek></ReadProvider>;
}
export function NoMeasurement() {
  const en = useLocale() === "en";
  return <RnEmpty>{en ? "No measurements for these conditions." : "조회 조건에 해당하는 측정 데이터가 없습니다."}</RnEmpty>;
}
