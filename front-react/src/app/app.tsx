import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useLocale } from "use-intl";
import { CONNECTED } from "~/api/client";
import { HghApiError } from "@/lib/hgh/errors";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { LocaleProvider } from "./i18n";
import { SessionProvider, useSession } from "./session";
import { Shell } from "./shell";
import { PAGES, type PageDefinition } from "./pages";
import { PageBoundary, PageError, PageLoading } from "./states";
import { AuthPage } from "./auth-pages";

const Analytics = lazy(() => import("~/pages/analytics"));
const Admin = lazy(() => import("~/pages/admin"));
const Catalog = lazy(() => import("~/pages/catalog"));
const Projects = lazy(() => import("~/pages/projects"));
const Funnel = lazy(() => import("~/pages/funnel"));

function LocaleLayout() {
  const { locale } = useParams();
  if (locale !== "ko" && locale !== "en") return <Navigate to="/ko/renewal/dashboard" replace />;
  return <LocaleProvider><SessionProvider><Outlet /></SessionProvider></LocaleProvider>;
}
function PageRoute({ page }: { page: PageDefinition }) {
  const locale = useLocale();
  const { user, loading, error, reload } = useSession();
  const { pathname, search } = useLocation();
  const { id } = useParams();
  useEffect(() => { document.title = `${page.title[locale === "en" ? 1 : 0]} · HMG GEO`; }, [page, locale]);
  let content: ReactNode;
  if (CONNECTED && loading) content = <PageLoading />;
  else if (error) content = <PageError error={error} retry={reload} />;
  else if (CONNECTED && !user) return <Navigate replace to={`/${locale}/login?next=${encodeURIComponent(pathname + search)}`} />;
  else if (CONNECTED && user?.mustChangePassword) return <Navigate replace to={`/${locale}/change-password?next=${encodeURIComponent(pathname + search)}`} />;
  else if (CONNECTED && (!user || !canAccessRoute(user.role, pathname) || (id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))) content = <PageError error={new HghApiError(403, "forbidden")} />;
  else if (["conversion", "visibility", "keyword-tools", "google-keyword", "social-scraping"].includes(page.kind)) content = <Funnel page={page} />;
  else if (page.group === "Admin") content = <Admin page={page} />;
  else if (page.kind === "prompts" || page.kind === "website-prompts") content = <Catalog page={page} />;
  else if (["projects", "project-prompts", "project-setting", "member"].includes(page.kind)) content = <Projects page={page} />;
  else content = <Analytics page={page} />;
  return <Shell><PageBoundary><div data-page-kind={page.kind}><Suspense fallback={<PageLoading />}>{content}</Suspense></div></PageBoundary></Shell>;
}
function UnknownPage() {
  const locale = useLocale();
  return <Shell><section className="rn-standby-frame"><div className="rn-standby-head"><h1 className="text-rn-24 font-semibold">{locale === "en" ? "Page unavailable" : "준비되지 않은 화면입니다"}</h1></div><p className="p-8 text-rn-13 text-rn-muted">{locale === "en" ? "Choose a page from the navigation." : "왼쪽 메뉴에서 확인할 화면을 선택해 주세요."}</p></section></Shell>;
}
export function App() {
  return <Routes><Route path="/" element={<Navigate to="/ko/renewal/dashboard" replace />} /><Route path="/:locale" element={<LocaleLayout />}>
    <Route index element={<Navigate to="renewal/dashboard" replace />} />
    <Route path="login" element={<AuthPage />} /><Route path="change-password" element={<AuthPage password />} />
    {PAGES.map(page => <Route key={page.path} path={`renewal/${page.path}`} element={<PageRoute page={page} />} />)}
    <Route path="*" element={<UnknownPage />} />
  </Route></Routes>;
}
