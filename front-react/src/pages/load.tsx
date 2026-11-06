import { useMemo, type ReactNode } from "react";
import { useLocale } from "use-intl";
import { useLocation, useParams } from "react-router-dom";
import { useBundle, type Read } from "~/api/bundle";
import type { Query } from "~/api/client";
import { useSession } from "~/app/session";
import { PageError, PageLoading } from "~/app/states";
import { surfaceOf, type PageDefinition } from "~/app/pages";
import { RnPageHeader, RnEmpty } from "@/components/renewal-ui";
import { RnFilterRuntime } from "@/app/[locale]/(renewal)/renewal/_components/filter-runtime";
import { RnOverviewFilters, RnFilterSplit, RnOverviewFilterPanel, RnOverviewFilterRail, RnOverviewApplied, type OverviewFilterProps } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import { RnPageFrame } from "@/app/[locale]/(renewal)/renewal/_components/filter-split";
import type { SavedFilter, SavedFilterPage } from "@/app/[locale]/(renewal)/renewal/_components/saved-filters";
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
export interface Values { value<T>(key: string): T; promise<T>(key: string): Promise<T>; stamp: string }
export function useReads(reads: Record<string, Read>) {
  const result = useBundle(reads);
  const values = useMemo<Values>(() => {
    const promises = Object.fromEntries(Object.entries(result.data).map(([key, value]) => [key, Promise.resolve(value)]));
    return { value: <T,>(key: string) => result.data[key] as T, promise: <T,>(key: string) => promises[key] as Promise<T>, stamp: JSON.stringify(result.data) };
  }, [result.data]);
  return { ...result, values };
}
export function Load({ result, children }: { result: ReturnType<typeof useReads>; children: (values: Values) => ReactNode }) {
  if (result.error) return <PageError error={result.error} retry={result.retry} />;
  if (result.pending) return <PageLoading />;
  return <>{children(result.values)}</>;
}
export const screenRead = (name: string, query: Query = {}): Read => ({ name, query });
export const hubRead = (name: string, query: Query = {}): Read => ({ name, query, kind: "hub" });
export function commonReads(ctx: PageContext, savedPage?: SavedFilterPage): Record<string, Read> {
  return {
    ...(ctx.surface !== "project" ? { week: screenRead("shared/service-week") } : {}),
    ...(savedPage ? { saved: hubRead("saved-filters", { page: savedPage }) } : {}),
  };
}
export function Header({ page }: { page: PageDefinition }) {
  const en = useLocale() === "en";
  return <RnPageHeader title={page.title[en ? 1 : 0]} meta={<span>{page.group}</span>} />;
}
export function savedSource(ctx: PageContext, values: Values, page: SavedFilterPage) {
  return { page, userId: ctx.user.id, initial: values.value<{ items: SavedFilter[] }>("saved").items };
}
export function Frame({ page, ctx, values, filters, savedPage, children, reset }: {
  page: PageDefinition; ctx: PageContext; values: Values; filters?: OverviewFilterProps;
  savedPage?: SavedFilterPage; children: ReactNode; reset?: readonly string[];
}) {
  const week = useMemo(() => ctx.surface === "project" ? Promise.resolve(null) : values.promise<ServiceWeekView>("week"), [values, ctx.surface]);
  return <RnServiceWeekProvider week={week} notes><RnFilterRuntime reset={reset}>
    {filters && savedPage ? <RnOverviewFilters props={filters} savedFilters={savedSource(ctx, values, savedPage)}>
      <RnFilterSplit header={<Header page={page} />} panel={<RnOverviewFilterPanel />} rail={<RnOverviewFilterRail />}>
        <RnOverviewApplied /><div className="flex flex-col gap-4">{children}</div>
      </RnFilterSplit>
    </RnOverviewFilters> : <RnPageFrame header={<Header page={page} />}>{children}</RnPageFrame>}
  </RnFilterRuntime></RnServiceWeekProvider>;
}
export function NoMeasurement() {
  const en = useLocale() === "en";
  return <RnEmpty>{en ? "No measurements for these conditions." : "조회 조건에 해당하는 측정 데이터가 없습니다."}</RnEmpty>;
}
