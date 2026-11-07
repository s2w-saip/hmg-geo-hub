import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useLocale, useTranslations } from "use-intl";
import { CONNECTED } from "~/api/client";
import { useBundle } from "~/api/bundle";
import { canAccessRoute, isMenuPath } from "@/lib/auth/route-policy";
import { resolvePageTitleRef } from "@/lib/nav/page-title";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { RnUnimplementedPage } from "@/app/[locale]/(renewal)/renewal/_components/unimplemented";
import { projectHref, projectPageOf, shortId, type ProjectRow } from "@/app/[locale]/(renewal)/renewal/projects/_components/project-model";
import { LocaleProvider } from "./i18n";
import { SessionProvider, useLogout, useSession } from "./session";
import { Shell } from "./shell";
import { PAGES, type PageDefinition, type PageKind } from "./pages";
import { NotFoundPage, PageBoundary, PageError, PageLoading, ProjectNoData } from "./states";
import { AuthPage } from "./auth-pages";

const Analytics = lazy(() => import("~/pages/analytics"));
const Admin = lazy(() => import("~/pages/admin"));
const Catalog = lazy(() => import("~/pages/catalog"));
const Projects = lazy(() => import("~/pages/projects"));
const Funnel = lazy(() => import("~/pages/funnel"));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What a project page's browser tab names; every project page also carries the project's short id. */
const PROJECT_TITLES: Partial<Record<PageKind, string>> = {
  overview: "nav.projectDetail.dashboard", mention: "nav.projectDetail.analysisMention", citation: "nav.projectDetail.analysisCitation", "citation-prompts": "renewal.projects.citation.promptsPage.title", "citation-tone": "answerAnalysis.citations.v2.toneUrlsPage.title",
  "project-prompts": "nav.projectDetail.prompt", "project-setting": "nav.projectDetail.general", member: "nav.projectDetail.member", "google-keyword": "nav.projectDetail.intentGoogleKeyword", "social-scraping": "nav.projectDetail.intentSocialScraping", conversion: "nav.projectDetail.aiFunnelConversion",
};

function LocaleLayout() {
  const { locale } = useParams();
  if (locale !== "ko" && locale !== "en") return <Navigate to="/ko/renewal/dashboard" replace />;
  return <LocaleProvider><SessionProvider><Outlet /></SessionProvider></LocaleProvider>;
}
function useTabTitle(kind: PageKind | null, projectTitle?: string) {
  const t = useTranslations();
  const { pathname } = useLocation();
  const { id } = useParams();
  const project = id ? (projectTitle ?? (kind ? PROJECT_TITLES[kind] : undefined)) : undefined;
  const ref = resolvePageTitleRef(pathname);
  const app = t("app.name");
  const title = id && project ? `${t(project)} · ${shortId(id)} · ${app}` : ref ? `${t(`${ref.namespace}.${ref.key}`)} · ${app}` : app;
  useEffect(() => { document.title = title; }, [title]);
}
/** The checks every page shares, and its shell. What stays out of the shell is the sign-in pages. */
function Guarded({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const { user, loading, error, reload } = useSession();
  const { pathname, search } = useLocation();
  let content = children;
  if (CONNECTED && loading) content = <PageLoading />;
  else if (error) content = <PageError error={error} retry={reload} />;
  else if (CONNECTED && !user) return <Navigate replace to={`/${locale}/login?next=${encodeURIComponent(pathname + search)}`} />;
  else if (CONNECTED && user?.mustChangePassword) return <Navigate replace to={`/${locale}/login/password?next=${encodeURIComponent(pathname + search)}`} />;
  else if (CONNECTED && (!user || !canAccessRoute(user.role, pathname))) return <Navigate replace to={`/${locale}/no-access`} />;
  return <Shell><PageBoundary><Suspense fallback={<PageLoading />}>{content}</Suspense></PageBoundary></Shell>;
}
/** A project page opens only for a project on the list; the list's own answer also feeds the sidebar's project card. */
function ProjectGate({ id, children }: { id: string; children: ReactNode }) {
  const read = useBundle({ projects: { name: "projects/list" } });
  const list = read.data.projects as { items: ProjectRow[] } | undefined;
  if (!CONNECTED) return <>{children}</>;
  if (read.error) return <PageError error={read.error} retry={() => { void read.retry(); }} />;
  if (read.pending || !list) return <PageLoading />;
  return list.items.some(r => r.id === id) ? <>{children}</> : <NotFoundPage />;
}
function PageRoute({ page }: { page: PageDefinition }) {
  const { id } = useParams();
  useTabTitle(page.kind);
  const body = !CONNECTED || !id || UUID.test(id) ? <PageBody page={page} /> : <NotFoundPage />;
  return <Guarded><div data-page-kind={page.kind} className="contents">{id && UUID.test(id) ? <ProjectGate id={id}>{body}</ProjectGate> : body}</div></Guarded>;
}
function PageBody({ page }: { page: PageDefinition }) {
  if (["conversion", "visibility", "keyword-tools", "google-keyword", "social-scraping"].includes(page.kind)) return <Funnel page={page} />;
  if (page.group === "Admin") return <Admin page={page} />;
  if (page.kind === "prompts" || page.kind === "website-prompts") return <Catalog page={page} />;
  if (["projects", "project-prompts", "project-setting", "member"].includes(page.kind)) return <Projects page={page} />;
  return <Analytics page={page} />;
}
/** Menu parents open their first child, and a menu item without its page says it is not implemented. */
const FIRST_CHILD: Record<string, string> = {
  "/standard/answer-analysis": "/standard/answer-analysis/mention",
  "/standard/ai-funnel": "/standard/ai-funnel/acr",
  "/website/answer-analysis": "/website/answer-analysis/mention",
  "/website/ai-funnel": "/website/ai-funnel/conversion",
  "/admin/standards": "/admin/standards/prompts",
};
function RenewalOther() {
  const locale = useLocale();
  const t = useTranslations();
  const { "*": rest = "" } = useParams();
  const path = `/${rest}`.replace(/\/$/, "");
  useTabTitle(null);
  if (FIRST_CHILD[path]) return <Navigate replace to={`/${locale}/renewal${FIRST_CHILD[path]}`} />;
  const ref = resolvePageTitleRef(path);
  return <Guarded>{isMenuPath(path) && ref ? <RnUnimplementedPage title={t(`${ref.namespace}.${ref.key}`)} label={t("unimplemented.label")} body={t("unimplemented.body")} /> : <NotFoundPage />}</Guarded>;
}
function ProjectOther() {
  const locale = useLocale();
  const t = useTranslations();
  const { id = "", "*": rest = "" } = useParams();
  const at = projectPageOf(rest.split("/").filter(Boolean));
  const ref = resolvePageTitleRef(`/projects/${id}${at && "page" in at ? `/${at.page}` : ""}`);
  useTabTitle(null, ref ? `${ref.namespace}.${ref.key}` : undefined);
  if (at && "redirect" in at) return <Navigate replace to={`/${locale}${projectHref(id, at.redirect)}`} />;
  return <Guarded><ProjectGate id={id}>{at && ref ? <RnUnimplementedPage title={t(`${ref.namespace}.${ref.key}`)} label={t("unimplemented.label")} body={t("unimplemented.body")} /> : <ProjectNoData />}</ProjectGate></Guarded>;
}
/** A signed-in account with no way into a page lands here. */
function NoAccess() {
  const t = useTranslations("noAccess");
  const tNav = useTranslations("nav");
  const logout = useLogout();
  const { user, loading } = useSession();
  useTabTitle(null);
  if (loading) return <PageLoading />;
  const body = <div className="mx-auto max-w-xl animate-fade-in py-16"><EmptyState variant="no-access" title={t("title")} description={t("description")}
    action={<div className="flex flex-col items-center gap-3"><p className="text-xs text-muted-foreground">{t("logoutHint")}</p><Button type="button" variant="outline" size="sm" onClick={() => void logout()}>{tNav("logout")}</Button></div>} /></div>;
  return CONNECTED && user && !user.mustChangePassword ? <Shell>{body}</Shell> : <main className="min-h-screen bg-background">{body}</main>;
}
function LegacyPasswordAddress() {
  const locale = useLocale();
  const { search } = useLocation();
  return <Navigate replace to={`/${locale}/login/password${search}`} />;
}
function Unknown() {
  useTabTitle(null);
  return <Guarded><NotFoundPage /></Guarded>;
}
export function App() {
  return <Routes><Route path="/" element={<Navigate to="/ko/renewal/dashboard" replace />} /><Route path="/:locale" element={<LocaleLayout />}>
    <Route index element={<Navigate to="renewal/dashboard" replace />} />
    <Route path="login" element={<AuthPage />} /><Route path="login/password" element={<AuthPage password />} /><Route path="change-password" element={<LegacyPasswordAddress />} />
    <Route path="no-access" element={<NoAccess />} />
    {PAGES.map(page => <Route key={page.path} path={`renewal/${page.path}`} element={<PageRoute page={page} />} />)}
    <Route path="renewal/projects/:id/*" element={<ProjectOther />} />
    <Route path="renewal/*" element={<RenewalOther />} />
    <Route path="*" element={<Unknown />} />
  </Route></Routes>;
}
