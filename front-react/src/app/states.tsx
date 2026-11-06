import { Component, type ReactNode } from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";
import { useLocale } from "use-intl";
import { RnButton, RnCard, RnPageHeader, RnSkeleton } from "@/components/renewal-ui";
import { RnPageFrame } from "@/app/[locale]/(renewal)/renewal/_components/filter-split";
import { HghApiError } from "@/lib/hgh/errors";
import { PageNavigation } from "./navigation";

export function PageLoading() { return <div className="m-2.5 flex flex-col gap-4 rounded-[18px] bg-white p-8" role="status" aria-label="불러오는 중"><RnSkeleton className="h-8 w-52" /><RnSkeleton className="h-5 w-80" /><RnSkeleton className="h-40 w-full" /><RnSkeleton className="h-64 w-full" /></div>; }
export function PageError({ error, retry }: { error: unknown; retry?: () => void }) {
  const locale = useLocale();
  const location = useLocation();
  const en = locale === "en";
  if (error instanceof PageNavigation) return <Navigate replace to={error.status === 404 ? `/${locale}/no-access` : error.href} />;
  if (error instanceof HghApiError && error.status === 401) return <Navigate replace to={`/${locale}/login?next=${encodeURIComponent(location.pathname + location.search)}`} />;
  const forbidden = error instanceof HghApiError && error.status === 403;
  const late = error instanceof HghApiError && error.status === 503;
  const title = forbidden ? (en ? "Access unavailable" : "접근할 수 없습니다") : late ? (en ? "Data is not ready" : "데이터를 준비하고 있습니다") : (en ? "Unable to load this page" : "화면을 불러오지 못했습니다");
  return <RnPageFrame header={<RnPageHeader title={title} />}><RnCard className="p-8"><p role="alert" className="text-rn-13 text-rn-muted">{forbidden ? (en ? "Check your account permissions." : "계정의 접근 권한을 확인해 주세요.") : (en ? "Please try again shortly." : "잠시 후 다시 조회해 주세요.")}</p>{retry && !forbidden && <RnButton onClick={retry}>{en ? "Retry" : "다시 조회"}</RnButton>}</RnCard></RnPageFrame>;
}
class Boundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { error }; }
  render() { return this.state.error ? <PageError error={this.state.error} retry={() => this.setState({ error: null })} /> : this.props.children; }
}
export function PageBoundary({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation();
  return <Boundary key={pathname + search}>{children}</Boundary>;
}
