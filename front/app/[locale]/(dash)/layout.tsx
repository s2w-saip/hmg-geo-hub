import type { ReactNode } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { resolvePageTitleRef } from "@/lib/nav/page-title";
import { perfNoCacheActive } from "@/lib/perf/nocache-probe";
import { Toaster } from "sonner";
import { getSession } from "@/lib/auth/session";
import {
  canAccessRoute,
  visibleRoutes,
  visibleGroups,
  defaultLandingFor,
  isGuardBypass,
  ROUTES,
} from "@/lib/auth/route-policy";
import { Link } from "@/i18n/navigation";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { Wordmark } from "@/components/wordmark";
import {
  Sidebar,
  SidebarMobileTrigger,
  type ProjectMetaForSnb,
} from "@/components/dash/sidebar";
import { GnbRail, type RailTab, type RailUser } from "@/components/dash/gnb-rail";
import {
  BetaNoticeBanner,
  BetaNoticeDialog,
} from "@/components/dash/beta-notice";
import {
  cachedProjectById,
  cachedMembership,
} from "@/lib/db/repositories/request-cache";
import { hghSource } from "@/lib/hgh/client";
import { projectMetaForSnb } from "@/lib/hgh/adapters/project-gate";
import type { User } from "@/lib/auth/types";

// Authenticated area: reads the session + project meta per request (Supabase + DB on the
// legacy source, the backend API when HGH_SOURCE_SESSION=api).
export const dynamic = "force-dynamic";

// Browser tab <title>, unified with the active SNB menu label (the current
// "breadcrumb"). Reads x-pathname (set by middleware) to resolve the route to
// its nav i18n key, then renders "<menu label> · <app name>". Falls back to the
// bare app name for unmatched paths (e.g. /no-access). This deepest metadata in
// the tree overrides the root layout's static title for every (dash) page.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const hdrs = await headers();
  const pathname = hdrs.get("x-pathname") ?? "";
  const tApp = await getTranslations({ locale, namespace: "app" });
  const appName = tApp("name");

  // T18 프로브 관측: 이 요청이 캐시 우회로 돌았는지를 사람이 눈으로 확인할 수 있게
  // 남긴다. 서버 컴포넌트 렌더는 응답 헤더를 못 붙이므로(`x-hmg-summary` 와 같은
  // 제약) ① 로그 1줄 ② head 의 meta 태그 두 경로다 — 프로브는 스트리밍 HTML 을
  // 읽고 있으니 meta 로 자기 요청이 게이트를 통과했는지 자체 확인할 수 있다.
  // 게이트가 닫힌 요청(= 사실상 전부)에는 아무것도 안 찍고 안 붙인다.
  const perfNoCache = await perfNoCacheActive();
  if (perfNoCache) console.info("x-hmg-perf: nocache");
  const perfMeta = perfNoCache
    ? { other: { "x-hmg-perf": "nocache" } }
    : {};

  const ref = resolvePageTitleRef(pathname);
  if (!ref) return { title: appName, ...perfMeta };

  const t = await getTranslations({ locale, namespace: ref.namespace });
  return { title: `${t(ref.key)} · ${appName}`, ...perfMeta };
}

// For each visible 1depth group, pick the first permitted route as the
// rail tab's destination.
function buildRailTabs(
  role: Parameters<typeof visibleGroups>[0],
  menuGroups: Parameters<typeof visibleGroups>[1],
): RailTab[] {
  const groups = visibleGroups(role, menuGroups);
  return groups.map((group) => {
    const first = ROUTES.find(
      (r) =>
        r.group === group &&
        r.roles.includes(role) &&
        !("hidden" in r && r.hidden === true),
    );
    return {
      group,
      href: first?.path ?? defaultLandingFor(role, menuGroups),
    };
  });
}

// Legacy SNB project meta (HGH_SOURCE_SESSION=legacy, the rollback path): admin, or an
// active member, reads the project row. Request-scoped memos: the leaf page under this
// layout runs the same two lookups for its own membership gate, so without sharing them a
// project page paid for each query twice.
async function legacyProjectMeta(
  projectId: string,
  user: User,
): Promise<ProjectMetaForSnb | null> {
  const isAdmin = user.role === "admin";
  const membership = isAdmin ? null : await cachedMembership(projectId, user.id);
  if (!isAdmin && !(membership && membership.status === "active")) return null;
  const project = await cachedProjectById(projectId);
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    createdAt: project.createdAt.toISOString(),
  };
}

export default async function DashLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  // params / session / headers are mutually independent — the session round-trip
  // (Supabase claims + a profiles read) used to block the headers() read that
  // the route guard needs, for no reason. Kick all three off together.
  const [{ locale }, session, hdrs] = await Promise.all([
    params,
    getSession(),
    headers(),
  ]);
  if (!session) {
    redirect(`/${locale}/login`);
  }

  // Server-side route guard (single source of truth: route-policy.ts).
  // menuGroups(계정별 좁히기)까지 함께 판정 — role 이 허용해도 계정 화이트리스트
  // 밖 그룹이면 차단.
  const menuGroups = session.user.menuGroups;
  const pathname = hdrs.get("x-pathname") ?? "";
  if (
    pathname &&
    !isGuardBypass(pathname) &&
    !canAccessRoute(session.user.role, pathname, menuGroups)
  ) {
    redirect(`/${locale}/no-access`);
  }

  const tApp = await getTranslations("app");

  const role = session.user.role;
  const routes = visibleRoutes(role, menuGroups);
  const railTabs = buildRailTabs(role, menuGroups);

  const railUser: RailUser = {
    email: session.user.email,
    role,
  };

  // Project context detection: when the URL is inside /projects/[id]/*,
  // fetch the project meta server-side so the SNB can render the project
  // header (name / created date / description) at the top of its column.
  // The new /projects-detail GNB reorg removed the in-content header; the
  // SNB now carries that role permanently.
  //
  // Membership gate (2026-07-02 QA fix): this layout sits above every leaf
  // page's own membership check, so without a gate here a non-member could
  // read another project's name/description/createdAt from the SNB even
  // though the leaf page correctly 404s the main content. Only admin or an
  // active member gets the meta: legacy checks it here, the API source gets a
  // 404 from GET /v1/projects/{id} (lib/hgh/adapters/project-gate.ts) for anyone else.
  let projectMeta: ProjectMetaForSnb | null = null;
  const cleanedPath = pathname.replace(/^\/(ko|en)(?=\/|$)/, "");
  const projectMatch = cleanedPath.match(/^\/projects\/([^/]+)/);
  // uuid 형태만 프로젝트 id 로 취급: /projects/new·/projects/by-scope/* 같은
  // 정적 형제 세그먼트를 id 로 오인하면 getById 가 PG uuid 캐스트(22P02)로
  // 터져 페이지 전체가 500 이 된다(2026-08-14 by-scope 라이브 실증).
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (projectMatch && UUID_RE.test(projectMatch[1])) {
    projectMeta =
      hghSource("SESSION") === "api"
        ? await projectMetaForSnb(projectMatch[1], locale)
        : await legacyProjectMeta(projectMatch[1], session.user);
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      {/* ─── Common top header — always visible, full width.
          Carries wordmark + (mobile drawer trigger) + locale switcher.
          The 1depth group nav lives in the GNB rail below; the header is
          purely brand chrome + global affordances per v19. */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 bg-card px-4 shadow-soft sm:px-6">
        <div className="flex items-center gap-3">
          <SidebarMobileTrigger
            routes={routes}
            projectMeta={projectMeta}
            locale={locale}
          />
          <Link
            href="/"
            className="inline-flex items-center"
            aria-label={tApp("name")}
          >
            <Wordmark variant="hmg" className="h-8 w-auto" />
            <span className="sr-only">{tApp("name")}</span>
          </Link>
        </div>
        <LocaleSwitcher />
      </header>

      {/* ─── Beta-period notice strip — persistent on every (dash) page. */}
      <BetaNoticeBanner />

      {/* ─── Beta-period operational notice popup (first entry per session). */}
      <BetaNoticeDialog />

      {/* ─── Body row: GNB rail (1depth) | SNB column (2depth + 3depth) | main. */}
      <div className="flex flex-1">
        <GnbRail tabs={railTabs} user={railUser} locale={locale} />
        <Sidebar routes={routes} projectMeta={projectMeta} locale={locale} />
        <main className="min-w-0 flex-1 px-4 py-8 sm:px-6 lg:px-10">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>

      <Toaster position="bottom-right" richColors closeButton />
    </div>
  );
}
