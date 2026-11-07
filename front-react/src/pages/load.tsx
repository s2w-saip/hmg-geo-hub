import { useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useLocale } from "use-intl";
import { useLocation, useParams } from "react-router-dom";
import { useBundle, type Read, type ReadControls } from "~/api/bundle";
import { ReadProvider } from "~/components/read-section";
import type { Query } from "~/api/client";
import { useSession } from "~/app/session";
import { CONNECTED } from "~/api/client";
import { previewRead, previewViewer } from "~/api/preview";
import { PageError, PageLoading } from "~/app/states";
import { surfaceOf, type PageDefinition } from "~/app/pages";
import { PageHeading } from "./page-heading";
import { RnBusyScope, RnFilterRuntime } from "@/app/[locale]/(renewal)/renewal/_components/filter-runtime";
import { RnOverviewFilters, RnFilterSplit, RnOverviewFilterPanel, RnOverviewFilterRail, RnOverviewApplied, type OverviewFilterProps } from "@/app/[locale]/(renewal)/renewal/_components/overview-filters";
import { RnPageFrame } from "@/app/[locale]/(renewal)/renewal/_components/filter-split";
import type { SavedFilterPage } from "@/app/[locale]/(renewal)/renewal/_components/saved-filters";
import { RnServiceWeekProvider } from "@/components/service-week/provider";
import type { ServiceWeekPagePeriod, ServiceWeekView } from "@/lib/service-week";

export function usePageContext(page: PageDefinition) {
  const locale = useLocale();
  const { id } = useParams();
  const location = useLocation();
  const { search } = location;
  const { user: session } = useSession();
  const user = CONNECTED ? session : previewViewer;
  if (!user) throw new Error("A connected page requires an authenticated HUB session");
  const sp = useMemo(() => {
    const params = new URLSearchParams(search);
    return Object.fromEntries([...new Set(params.keys())].map(key => [key, params.getAll(key).length > 1 ? params.getAll(key) : params.get(key)!]));
  }, [search]);
  const surface = surfaceOf(page);
  const query: Query = { ...sp, "ctx.surface": surface, ...(id ? { "ctx.project_id": id } : {}), ...(surface === "website" ? { "ctx.admin": user.scope.all, "ctx.role": user.role } : {}) };
  // the first address of this mounted page is a full read; any move after it is the in-page move Next tells apart with sec-fetch-dest
  const first = useRef(location.key);
  return { locale, id: id ?? "", search: search.replace(/^\?/, ""), sp, query, surface, user, clientNav: location.key !== first.current };
}
export type PageContext = ReturnType<typeof usePageContext>;
export interface Values extends ReadControls { value<T>(key: string): T; promise<T>(key: string): Promise<T>; stamp: string; updating: boolean }

interface Pending { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void; state: "pending" | "done" | "failed"; value?: unknown }
function pendingEntry(): Pending {
  let resolve!: (value: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {}); // a section may never ask for it
  return { promise, resolve, reject, state: "pending" };
}
const derivedOf = new WeakMap<object, Map<string, Promise<unknown>>>();
/** A promise worked out from a read's promise, the same object on every render: a new one would send the sections consuming it back to their skeletons. */
export function derive<T, R>(source: Promise<T>, tag: string, work: (value: T) => R): Promise<R> {
  let known = derivedOf.get(source);
  if (!known) derivedOf.set(source, known = new Map());
  let out = known.get(tag);
  if (!out) { out = source.then(work); out.catch(() => {}); known.set(tag, out); }
  return out as Promise<R>;
}
export function useReads(reads: Record<string, Read>) {
  const bundle = useBundle(reads);
  const preview = useMemo(() => Object.fromEntries(Object.entries(reads).map(([key, read]) => [key, previewRead(read)])), [bundle.key]);
  const result = CONNECTED ? bundle : { ...bundle, data: preview, pending: false, error: null };
  const cache = useMemo(() => new Map<string, Pending>(), [result.key]);
  // A read's promise stays pending until its answer, so a copied section waits in its own Suspense as on Next.
  // A late section must not replace promises already consumed by other sections.
  const promises = useMemo(() => Object.fromEntries(Object.keys(reads).map(key => {
    let entry = cache.get(key);
    if (!entry) cache.set(key, entry = pendingEntry());
    const value = result.data[key];
    const error = result.states[key]?.error ?? null;
    if (entry.state === "failed" && !error) cache.set(key, entry = pendingEntry());
    if (value !== undefined) {
      if (entry.state === "done" && entry.value !== value) cache.set(key, entry = pendingEntry());
      if (entry.state === "pending") { entry.state = "done"; entry.value = value; entry.resolve(value); }
    } else if (error && entry.state === "pending") { entry.state = "failed"; entry.reject(error); }
    return [key, entry.promise];
  })), [result.data, result.states, cache]);
  const values = useMemo<Values>(() => ({ value: <T,>(key: string) => result.data[key] as T, promise: <T,>(key: string) => promises[key] as Promise<T>, stamp: result.key, updating: false, states: result.states, retry: result.retry }), [result.data, result.key, promises, result.states, result.retry]);
  const [served, setServed] = useState<{ resource: string; values: Values } | null>(null);
  // Keep the last complete bundle during a new filter read, never a mix of periods/conditions.
  // The resource includes account, role and scope: old privileged data cannot cross that boundary.
  if (!result.pending && !result.error && served?.values !== values) setServed({ resource: result.resource, values });
  const retaining = result.pending && !result.error && served?.resource === result.resource;
  const shown = useMemo(() => retaining ? { ...served!.values, updating: true } : values, [retaining, served, values]);
  return { ...result, pending: result.pending && !retaining, values: shown };
}
export function Load({ result, children, failure }: { result: ReturnType<typeof useReads>; children: (values: Values) => ReactNode; failure?: (error: Error) => ReactNode }) {
  if (result.error) return <>{failure?.(result.error) ?? <PageError error={result.error} retry={result.retry} />}</>;
  if (result.pending) return <PageLoading />;
  return <>{children(result.values)}</>;
}
export const screenRead = (name: string, query: Query = {}, optional = false): Read => ({ name, query, optional });
export const sectionRead = (name: string, query: Query = {}, fallback?: unknown): Read => ({ name, query, deferred: true, ...(fallback !== undefined ? { fallback } : {}) });
export const hubRead = (name: string, query: Query = {}): Read => ({ name, query, kind: "hub" });
export function commonReads(ctx: PageContext): Record<string, Read> {
  return {
    ...(ctx.surface !== "project" ? { week: screenRead("shared/service-week", {}, true) } : {}),
  };
}
export function savedSource(ctx: PageContext, page: SavedFilterPage) {
  // The existing saved-filter hook loads and retries its own list without blocking screen data.
  return { page, userId: ctx.user.id, initial: CONNECTED ? null : [] };
}
export function PageWeek({ ctx, values, children }: { ctx: PageContext; values: Values; children: ReactNode }) {
  const value = ctx.surface === "project" ? null : values.value<ServiceWeekView | null | undefined>("week");
  const week = useMemo(() => Promise.resolve(value ?? null), [value]);
  return <RnServiceWeekProvider week={week} notes>{children}</RnServiceWeekProvider>;
}
export function Frame({ page, ctx, values, filters, savedPage, children, reset, panel, notesPeriod, bodyClass = "flex flex-col gap-4" }: {
  page: PageDefinition; ctx: PageContext; values: Values; filters?: OverviewFilterProps;
  savedPage?: SavedFilterPage; children: ReactNode; reset?: readonly string[];
  panel?: ComponentProps<typeof RnOverviewFilterPanel>; notesPeriod?: Promise<ServiceWeekPagePeriod>; bodyClass?: string;
}) {
  return <ReadProvider value={values}><PageWeek ctx={ctx} values={values}><RnFilterRuntime reset={reset} pending={values.updating}>
    {filters && savedPage ? <RnOverviewFilters props={filters} savedFilters={savedSource(ctx, savedPage)}>
      <RnFilterSplit header={<PageHeading page={page} values={values} ctx={ctx} />} panel={<RnOverviewFilterPanel {...panel} />} rail={<RnOverviewFilterRail />} notesPeriod={notesPeriod} delayInHeader={page.kind === "mention" && ctx.surface === "global"}>
        <RnOverviewApplied /><RnBusyScope className={bodyClass}>{children}</RnBusyScope>
      </RnFilterSplit>
    </RnOverviewFilters> : <RnPageFrame header={<PageHeading page={page} values={values} ctx={ctx} />}>{children}</RnPageFrame>}
  </RnFilterRuntime></PageWeek></ReadProvider>;
}
