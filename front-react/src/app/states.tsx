import { Component, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useLocale, useTranslations } from "use-intl";
import { RnCard, RnNote, RnPageHeader, RnSkeleton } from "@/components/renewal-ui";
import { RnPageFrame, RnFilterSplit } from "@/app/[locale]/(renewal)/renewal/_components/filter-split";
import DashError from "@/app/[locale]/(dash)/error";
import { HghApiError } from "@/lib/hgh/errors";
import { PageNavigation } from "./navigation";

const PROJECT_PAGE = /^\/(?:ko|en)\/renewal\/projects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/|$)/i;

/** First entry into a page: the page frame's shape (header, filter panel, content), so the swap to the page does not jump. */
export function PageLoading() {
  return <div role="status" aria-label="불러오는 중" className="contents"><RnFilterSplit
    header={<div className="flex flex-col gap-2"><RnSkeleton className="h-8 w-64" /><RnSkeleton className="h-4 w-[420px] max-w-full" /></div>}
    panel={<RnCard className="h-[480px]" />} rail={<RnCard className="h-24" />}>
    <RnCard className="h-[220px]" /><RnCard className="h-[320px]" />
  </RnFilterSplit></div>;
}
/** A page body still reading, inside its frame. */
export function BodyLoading() {
  return <RnCard className="p-6"><RnSkeleton className="mb-4 h-4 w-32" /><div className="flex flex-col gap-3">{Array.from({ length: 5 }, (_, i) => <RnSkeleton key={i} className="h-12 w-full" />)}</div></RnCard>;
}
/** A page of a project with no measured data yet: a project added in Admin › 측정 설정 opens before its first round is loaded. */
export function ProjectNoData() {
  const locale = useLocale();
  const t = useTranslations("renewal.projects.noData");
  return <RnPageFrame header={<RnPageHeader title={t("title")} />}><RnNote><span data-rn-project-no-data={locale}>{t("body")}</span></RnNote></RnPageFrame>;
}
export function NotFoundPage() {
  const en = useLocale() === "en";
  return <section className="rn-standby-frame"><div className="rn-standby-head"><h1 className="text-rn-24 font-semibold">{en ? "Page unavailable" : "준비되지 않은 화면입니다"}</h1></div><p className="p-8 text-rn-13 text-rn-muted">{en ? "Check the address or choose another page from the menu." : "주소를 확인하거나 메뉴에서 다른 화면을 선택해 주세요."}</p></section>;
}
export function PageError({ error, retry }: { error: unknown; retry?: () => void }) {
  const locale = useLocale();
  const location = useLocation();
  const notFound = () => PROJECT_PAGE.test(location.pathname) ? <ProjectNoData /> : <NotFoundPage />;
  if (error instanceof PageNavigation) return error.status === 404 ? notFound() : <Navigate replace to={error.href} />;
  if (error instanceof HghApiError) {
    if (error.status === 401) return <Navigate replace to={`/${locale}/login?next=${encodeURIComponent(location.pathname + location.search)}`} />;
    if (error.status === 403) return <Navigate replace to={`/${locale}/no-access`} />;
    if (error.status === 404) return notFound();
  }
  const failure = error instanceof Error ? error : new Error(String(error));
  return <div className="px-6 py-6 xl:px-8"><DashError error={failure} reset={() => retry?.()} /></div>;
}
class Boundary extends Component<{ children: ReactNode; reset: string }, { error: unknown; reset: string }> {
  state = { error: null as unknown, reset: this.props.reset };
  static getDerivedStateFromProps(props: { reset: string }, state: { reset: string }) {
    return props.reset !== state.reset ? { error: null, reset: props.reset } : null;
  }
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() { return this.state.error ? <PageError error={this.state.error} retry={() => this.setState({ error: null })} /> : this.props.children; }
}
export function PageBoundary({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation();
  // Filters reset a caught error, but must not remount a healthy page and its scroll/panel state.
  return <Boundary key={pathname} reset={search}>{children}</Boundary>;
}
