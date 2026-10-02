"use client";

import { useMemo, useState, type ComponentType } from "react";
import { useTranslations } from "next-intl";
import {
  LayoutDashboard,
  MessageSquareText,
  ListChecks,
  FlaskConical,
  Eye,
  Trophy,
  TrendingUp,
  Heart,
  Globe,
  MessagesSquare,
  FolderPlus,
  Briefcase,
  Search,
  BarChart3,
  Users,
  Shield,
  FileText,
  Database,
  Building2,
  Settings,
  LayoutPanelLeft,
  MessageCircle,
  Link2,
  FolderOpen,
  Sparkles,
  Plug,
  Menu,
  X,
  ArrowLeft,
} from "lucide-react";
// `Globe` + `MessagesSquare` are used by the project sub-nav children
// (Intent → Google Keyword + Social Scraping leafs).
import { Link, usePathname } from "@/i18n/navigation";
import { useSearchParams } from "next/navigation";
import { carryFilterParams, carryProjectFilterParams } from "@/components/dash/filter-carry";
import {
  ROUTES,
  type RouteDef,
  type RouteKey,
  type RouteGroup,
  type RouteSection,
} from "@/lib/auth/route-policy";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// SNB — Secondary navigation column. Sits to the right of the GNB rail.
// Renders the 2depth (leaves) and 3depth (section + items) routes for the
// currently active 1depth group in a single column.
//
// Project context (2026-06-04 reorg): when inside /projects/[id]/*, the SNB
// also renders:
//   1. A project meta header at the very top (name + created date + description)
//      — fetched server-side by the dash layout and passed in via projectMeta.
//   2. The full project sub-nav with 4depth children inlined as indented
//      children under their parent (no more in-page tabs for Intent /
//      Analysis / AI Agent Funnel).

const ROUTE_ICON: Record<RouteKey, ComponentType<{ className?: string }>> = {
  // 표준 — standard routes are rendered via STANDARD_SUB_ITEMS, not flat
  // leafs. The icon map only matters for the (now empty) fallback path.
  dashboard: LayoutDashboard,
  standardPrompts: ListChecks,
  answerAnalysis: MessageSquareText,
  answerAnalysisMention: MessageCircle,
  answerAnalysisCitation: Link2,
  aiFunnel: FlaskConical,
  aiFunnelVisibility: Eye,
  aiFunnelAcr: Trophy,
  aiFunnelConversion: TrendingUp,
  customerInterest: Heart,
  customerInterestGoogleKeywords: Globe,
  customerInterestSocialScraping: MessagesSquare,
  // 웹사이트 — 표준과 동일 아이콘 셋을 재사용(SNB 트리는 WEBSITE_SUB_ITEMS).
  websiteDashboard: LayoutDashboard,
  websitePrompts: ListChecks,
  websiteAnswerAnalysis: MessageSquareText,
  websiteAnswerAnalysisMention: MessageCircle,
  websiteAnswerAnalysisCitation: Link2,
  websiteAiFunnel: FlaskConical,
  websiteAiFunnelAcr: Trophy,
  websiteAiFunnelConversion: TrendingUp,
  // Project — FolderOpen (no plus) for the list leaf so the SNB label reads
  // as "프로젝트 목록" without an "add" affordance creeping in visually.
  projects: FolderOpen,
  projectNew: FolderPlus, // hidden=true; the actual Add CTA lives on the list page header
  // Admin
  admin: Shield,
  adminStandards: FileText,
  adminStandardPrompts: FileText,
  adminStandardCustomerInterest: Database,
  adminStandardEntities: Building2,
  adminCitationSources: Link2,
  keywordTools: Sparkles,
  adminGa4: Plug,
};

// SECTION_ICON: kept around purely for the project-detail virtual section
// label (the only remaining section-based render path — both standard and
// admin SNB groups now own their structure via *_SUB_ITEMS trees).
// `Partial<Record<RouteSection, ...>>` because the typed union now has no
// values (no route still carries a `section` field) — adminStandards and
// aiFunnel were dropped during the 2026-06-04 SNB reorg.
const SECTION_ICON: { projectDetail: ComponentType<{ className?: string }> } = {
  projectDetail: Briefcase,
};

// Standard group sub-nav tree (same shape as PROJECT_SUB_ITEMS). Each
// path is the absolute URL pathname (not relative) so the tree can mix
// flat /dashboard with deeper /standard/* + /customer-interest/* paths.
type StandardSubLeaf = {
  path: string;
  i18nKey: string; // under `nav.*`
  icon: ComponentType<{ className?: string }>;
  // beta: 라벨 뒤에 파란 (beta) 접미사를 붙인다. 실데이터가 아직 부분/실험
  // 단계인 화면(ACR·AI Conversion·Social Scraping)에 표시 — 2026-09-04 제품 결정.
  beta?: boolean;
};
type StandardSubItem = StandardSubLeaf & { children?: StandardSubLeaf[] };

const STANDARD_SUB_ITEMS: StandardSubItem[] = [
  {
    path: "/dashboard",
    i18nKey: "dashboard",
    icon: LayoutDashboard,
  },
  {
    path: "/standard/prompts",
    i18nKey: "standardPrompts",
    icon: ListChecks,
  },
  {
    path: "/standard/answer-analysis",
    i18nKey: "answerAnalysis",
    icon: MessageSquareText,
    children: [
      {
        path: "/standard/answer-analysis/mention",
        i18nKey: "answerAnalysisMention",
        icon: MessageCircle,
      },
      {
        path: "/standard/answer-analysis/citation",
        i18nKey: "answerAnalysisCitation",
        icon: Link2,
      },
    ],
  },
  {
    path: "/standard/ai-funnel",
    i18nKey: "aiFunnel",
    icon: FlaskConical,
    children: [
      {
        path: "/standard/ai-funnel/visibility",
        i18nKey: "aiFunnelVisibility",
        icon: Eye,
      },
      {
        path: "/standard/ai-funnel/acr",
        i18nKey: "aiFunnelAcr",
        icon: Trophy,
        beta: true,
      },
      {
        path: "/standard/ai-funnel/conversion",
        i18nKey: "aiFunnelConversion",
        icon: TrendingUp,
        beta: true,
      },
    ],
  },
  {
    path: "/customer-interest",
    i18nKey: "customerInterest",
    icon: Heart,
    children: [
      {
        path: "/customer-interest/google-keywords",
        i18nKey: "customerInterestGoogleKeywords",
        icon: Globe,
      },
      {
        path: "/customer-interest/social-scraping",
        i18nKey: "customerInterestSocialScraping",
        icon: MessagesSquare,
        beta: true,
      },
    ],
  },
];

// Admin group sub-nav tree (same shape as STANDARD_SUB_ITEMS).
const ADMIN_SUB_ITEMS: StandardSubItem[] = [
  {
    path: "/admin",
    i18nKey: "admin",
    icon: Shield,
  },
  {
    path: "/admin/standards",
    i18nKey: "adminStandards",
    icon: FileText,
    children: [
      {
        path: "/admin/standards/prompts",
        i18nKey: "adminStandardPrompts",
        icon: FileText,
      },
      {
        path: "/admin/standards/customer-interest",
        i18nKey: "adminStandardCustomerInterest",
        icon: Database,
      },
      {
        path: "/admin/standards/entities",
        i18nKey: "adminStandardEntities",
        icon: Building2,
      },
      {
        path: "/admin/standards/citation-sources",
        i18nKey: "adminCitationSources",
        icon: Link2,
      },
    ],
  },
  {
    path: "/admin/keyword-tools",
    i18nKey: "keywordTools",
    icon: Sparkles,
  },
  {
    path: "/admin/ga4",
    i18nKey: "adminGa4",
    icon: Plug,
  },
];

// Website group sub-nav tree. Mirrors the *visible* 표준 SNB (대시보드 / 답변분석
// / AI 퍼널). 라벨은 표준과 동일하므로 기존 nav.* i18n 키를 그대로 재사용한다 —
// 단 프롬프트만 예외: 표준프롬프트가 아니라 웹사이트 전용 카탈로그라 자체 라벨
// (nav.websitePrompts)을 쓴다(route-policy 의 website 블록 참고).
const WEBSITE_SUB_ITEMS: StandardSubItem[] = [
  {
    path: "/website",
    i18nKey: "dashboard",
    icon: LayoutDashboard,
  },
  {
    path: "/website/prompts",
    i18nKey: "websitePrompts",
    icon: ListChecks,
  },
  {
    path: "/website/answer-analysis",
    i18nKey: "answerAnalysis",
    icon: MessageSquareText,
    children: [
      {
        path: "/website/answer-analysis/mention",
        i18nKey: "answerAnalysisMention",
        icon: MessageCircle,
      },
      {
        path: "/website/answer-analysis/citation",
        i18nKey: "answerAnalysisCitation",
        icon: Link2,
      },
    ],
  },
  {
    path: "/website/ai-funnel",
    i18nKey: "aiFunnel",
    icon: FlaskConical,
    children: [
      {
        path: "/website/ai-funnel/acr",
        i18nKey: "aiFunnelAcr",
        icon: Trophy,
        beta: true,
      },
      {
        path: "/website/ai-funnel/conversion",
        i18nKey: "aiFunnelConversion",
        icon: TrendingUp,
        beta: true,
      },
    ],
  },
];

// Project sub-nav tree.
//
// `path` is the relative path under /projects/{id} — empty string = the
// bare project URL (Dashboard). Using a path (rather than a single-segment
// slug) lets children point anywhere — including outside the parent's URL
// prefix, which Setting needs: its "Member" child links to /member (not
// /setting/member) so we don't have to restructure the existing /member
// route family.
type ProjectSubLeaf = {
  path: string;
  i18nKey: string;
  icon: ComponentType<{ className?: string }>;
  beta?: boolean;
};

type ProjectSubItem = ProjectSubLeaf & {
  children?: ProjectSubLeaf[];
};

const PROJECT_SUB_ITEMS: ProjectSubItem[] = [
  { path: "", i18nKey: "dashboard", icon: LayoutPanelLeft },
  {
    path: "intent",
    i18nKey: "intent",
    icon: Search,
    children: [
      { path: "intent/google-keyword", i18nKey: "intentGoogleKeyword", icon: Globe },
      {
        path: "intent/social-scraping",
        i18nKey: "intentSocialScraping",
        icon: MessagesSquare,
        beta: true,
      },
    ],
  },
  { path: "prompt", i18nKey: "prompt", icon: MessageSquareText },
  {
    path: "analysis",
    i18nKey: "analysis",
    icon: BarChart3,
    children: [
      { path: "analysis/mention", i18nKey: "analysisMention", icon: MessageCircle },
      { path: "analysis/citation", i18nKey: "analysisCitation", icon: Link2 },
    ],
  },
  {
    path: "ai-funnel",
    i18nKey: "aiFunnel",
    icon: FlaskConical,
    children: [
      // AI 가시성(visibility)은 mock-only라 SNB에서 숨김 (2026-06-23). ACR 도
      // 프로젝트 SNB에서 숨김 (2026-07-01) — ACR 은 표준(전사 측정)에서만 노출.
      // 두 라우트 모두 접근은 유지, 부모 ai-funnel 은 conversion 으로 리다이렉트.
      {
        path: "ai-funnel/conversion",
        i18nKey: "aiFunnelConversion",
        icon: TrendingUp,
        beta: true,
      },
    ],
  },
  {
    path: "setting",
    i18nKey: "setting",
    icon: Settings,
    children: [
      // 일반 lives at /setting (the existing Settings page — name/domain/
      // brand/tracked entities/Danger Zone). 멤버 lives at /member (the
      // existing Members page). Both stay at their current URLs; the SNB
      // just visually groups them under Setting.
      { path: "setting", i18nKey: "general", icon: Settings },
      { path: "member", i18nKey: "member", icon: Users },
    ],
  },
];

import {
  useSnbProjectMeta,
  type ProjectMetaForSnb,
} from "@/components/dash/project-meta-broadcast";

export type { ProjectMetaForSnb };

function stripLocale(p: string): string {
  return p.replace(/^\/(ko|en)(?=\/|$)/, "") || "/";
}

// `activeGroup` is computed client-side from the current pathname so soft
// navigation always picks the correct 1depth group without depending on
// server layout re-rendering.
function useActiveGroup(): RouteGroup {
  const pathname = usePathname();
  return useMemo(() => {
    const match = ROUTES.find(
      (r) => pathname === r.path || pathname.startsWith(r.path + "/"),
    );
    return match?.group ?? "standard";
  }, [pathname]);
}

// Detect the active project id from pathname when inside a project detail
// (/projects/{id} or any deeper sub-page). Returns null on the bare list
// (/projects) and on the wizard (/projects/new).
function useProjectContext(): { projectId: string } | null {
  const pathname = stripLocale(usePathname());
  return useMemo(() => {
    const m = pathname.match(/^\/projects\/([^/]+)/);
    if (!m) return null;
    const id = m[1];
    if (id === "new") return null;
    return { projectId: id };
  }, [pathname]);
}

type CommonProps = {
  routes: readonly RouteDef[];
  projectMeta?: ProjectMetaForSnb | null;
};

// Resolve the project meta to render in the SNB header. The live store
// (broadcast by the project [id] layout) wins — it tracks soft navigation,
// which the server-fetched layout prop can't (the dash layout doesn't
// re-render on client-side navigation). The server prop covers the initial
// hard load / SSR paint. Either source must match the URL's project id.
function useEffectiveProjectMeta(
  projectContext: { projectId: string } | null,
  serverMeta?: ProjectMetaForSnb | null,
): ProjectMetaForSnb | null {
  const liveMeta = useSnbProjectMeta();
  if (!projectContext) return null;
  if (liveMeta && liveMeta.id === projectContext.projectId) return liveMeta;
  if (serverMeta && serverMeta.id === projectContext.projectId) return serverMeta;
  return null;
}

function ProjectHeader({ meta, locale }: { meta: ProjectMetaForSnb; locale: string }) {
  const t = useTranslations("nav.projectDetail");
  // Format Jun 1 2026 style without Date.now / new Date sans args (workflow
  // env restrictions). The ISO string from the server is stable.
  // timeZone: UTC 고정 — createdAt은 풀 타임스탬프라 미지정 시 서버(UTC) SSR
  // 텍스트와 브라우저(뷰어 TZ) hydration 렌더의 날짜가 자정 부근에서 갈려
  // hydration 불일치(React #418)가 된다 (live-trend-chart와 동일 계열, 2026-07-22).
  const d = new Date(meta.createdAt);
  const dateLabel = isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
  return (
    <div className="mb-2 flex flex-col gap-1 border-b border-border px-3 pt-1 pb-3">
      <Link
      // prefetch 끄기(2026-08-27): next/link 기본 auto 프리페치가 뷰포트에 들어온
      // 링크마다 라우트를 미리 렌더시킨다. 프로덕션 로그 실측에서 사이드바가
      // 보이는 순간 (dash) leaf 라우트 **7개가 같은 초에** 요청됐고, 그 렌더들이
      // Suspense 안에서 미러 집계 트랜잭션을 열어 둔 채 셸만 응답했다. 그 뒤
      // Vercel 이 인스턴스를 정지시키면 트랜잭션이 문장 사이에서 얼어 scope_*
      // 테이블에 AccessShareLock 을 수 분간 쥔다(0046 ALTER 가 55P03 으로 거부된
      // 원인). 잃는 것은 loading.tsx 셸의 선행 렌더뿐이고 — 실데이터는 어차피
      // 프리페치 대상이 아니다 — 클릭 시 셸은 즉시 나온다.
      prefetch={false}
        href={`/projects/${meta.id}`}
        className="font-head text-lg leading-tight font-semibold tracking-tight text-foreground hover:text-brand-700"
        title={t("openDashboard")}
      >
        {meta.name}
      </Link>
      {dateLabel ? (
        <span className="text-[11px] tabular-nums text-muted-foreground">{dateLabel}</span>
      ) : null}
      {meta.description ? (
        <p className="line-clamp-3 text-xs text-muted-foreground">{meta.description}</p>
      ) : null}
    </div>
  );
}

// SNB nav list. For the "standard" group, renders STANDARD_SUB_ITEMS (the
// hand-curated tree with parent+children groupings, matching the project
// SNB pattern). For other groups, walks the routes list in declaration
// order — contiguous routes sharing a `section` collapse under one label,
// others render as standalone leaves.
function NavList({
  routes,
  group,
  projectContext,
  onItemSelect,
}: {
  routes: readonly RouteDef[];
  group: RouteGroup;
  projectContext?: { projectId: string } | null;
  onItemSelect?: () => void;
}) {
  const tNav = useTranslations("nav");
  const tSection = useTranslations("nav.section");
  const tProjectDetail = useTranslations("nav.projectDetail");
  const pathname = stripLocale(usePathname());
  // 표준 그룹 내 이동 시 필터 쿼리 이월(filter-carry.ts). (dash)는 세션 기반
  // 동적 렌더라 useSearchParams의 정적 프리렌더 제약(서스펜스)과 무관하다.
  const searchParams = useSearchParams();

  // Routes-based fallback render — only the Project group still uses
  // this (its top-level routes are flat: just /projects). Standard and
  // Admin groups own their hierarchy via *_SUB_ITEMS trees, see the JSX
  // switch below. RouteSection is now an empty union (no routes carry a
  // `section` field), so the prior section-grouping code is dead — flat
  // leaves cover every case here.
  //
  // Inside a project detail the /projects list leaf is suppressed from the
  // nav — the "back to list" affordance is pinned at the very bottom of the
  // SNB column instead (BackToProjectsLink), keeping the project meta
  // header + sub-nav at the top.
  const usesTreeRender =
    group === "standard" || group === "website" || group === "admin";
  const leafNodes: RouteDef[] =
    usesTreeRender || projectContext ? [] : [...routes];

  // Permission filter — keep deny-by-default. The *_SUB_ITEMS trees can
  // include nodes a given role isn't allowed to reach (e.g. vendor on the
  // standard tree); filter them out before render.
  const allowedPaths = new Set<string>(routes.map((r) => r.path));
  const filterByPerm = (items: StandardSubItem[]): StandardSubItem[] =>
    items
      .filter((item) => allowedPaths.has(item.path))
      .map((item) => ({
        ...item,
        children: item.children?.filter((c) => allowedPaths.has(c.path)),
      }));
  const visibleStandardItems = filterByPerm(STANDARD_SUB_ITEMS);
  const visibleWebsiteItems = filterByPerm(WEBSITE_SUB_ITEMS);
  const visibleAdminItems = filterByPerm(ADMIN_SUB_ITEMS);

  const isRouteActive = (r: RouteDef): boolean =>
    pathname === r.path || pathname.startsWith(r.path + "/");

  // Active matchers for project sub items (path-based).
  //   - Bare leaf (path=""): active only on the exact project URL (Dashboard).
  //   - Path leaf: active on exact match OR any deeper sub-path.
  //   - Parent: active when any of its children is active, OR the parent's
  //     own path matches as a fallback for parents without children.
  const matchPath = (base: string, path: string): boolean => {
    const href = path ? `${base}/${path}` : base;
    return path
      ? pathname === href || pathname.startsWith(href + "/")
      : pathname === href;
  };
  const matchParent = (
    base: string,
    parent: ProjectSubItem,
  ): boolean => {
    if (parent.children?.length) {
      return parent.children.some((c) => matchPath(base, c.path));
    }
    return matchPath(base, parent.path);
  };

  // Active matchers for absolute-path standard items (mirrors the
  // project sub-nav matcher but on full paths, not project-relative).
  const matchStandardPath = (p: string): boolean =>
    pathname === p || pathname.startsWith(p + "/");
  const matchStandardParent = (item: StandardSubItem): boolean => {
    if (item.children?.length) return item.children.some((c) => matchStandardPath(c.path));
    return matchStandardPath(item.path);
  };

  // Render helper for path-based tree groups (standard + admin).
  const renderTree = (items: StandardSubItem[]) =>
    items.map((item) => {
      const hasChildren = !!item.children?.length;
      const parentActive = matchStandardParent(item);
      return (
        <div key={item.path} className="flex flex-col gap-0.5">
          <ProjectSubLink
            href={carryFilterParams(pathname, item.path, searchParams)}
            active={parentActive}
            onSelect={onItemSelect}
            label={tNav(item.i18nKey)}
            Icon={item.icon}
            beta={item.beta}
          />
          {hasChildren ? (
            <div className="ml-4 flex flex-col gap-0.5">
              {item.children!.map((child) => (
                <ProjectSubLink
                  key={child.path}
                  href={carryFilterParams(pathname, child.path, searchParams)}
                  active={matchStandardPath(child.path)}
                  onSelect={onItemSelect}
                  label={tNav(child.i18nKey)}
                  Icon={child.icon}
                  dense
                  beta={child.beta}
                />
              ))}
            </div>
          ) : null}
        </div>
      );
    });

  return (
    <nav className="flex flex-col gap-1">
      {group === "standard"
        ? renderTree(visibleStandardItems)
        : group === "website"
        ? renderTree(visibleWebsiteItems)
        : group === "admin"
        ? renderTree(visibleAdminItems)
        : leafNodes.map((r) => (
            <LeafLink
              key={`leaf-${r.key}`}
              route={r}
              active={isRouteActive(r)}
              onSelect={onItemSelect}
              t={tNav}
              indent={false}
            />
          )
          )}

      {projectContext ? (
        <div className="mt-2 flex flex-col gap-1">
          {/* No section label — the project meta header at the top of the
              SNB already establishes "this is a project" context, so an
              extra "개별 프로젝트" group label was redundant. */}
          {PROJECT_SUB_ITEMS.map((item) => {
            const base = `/projects/${projectContext.projectId}`;
            // 현재 화면의 /projects/{id} 아래 상대경로 — 필터 이월 매니페스트 키.
            const currentRel =
              pathname === base
                ? ""
                : pathname.startsWith(`${base}/`)
                  ? pathname.slice(base.length + 1)
                  : pathname;
            // 대시보드/언급/인용 간 이동 시 공통 축 + 커스텀 태그(cf_*) 이월.
            const href = carryProjectFilterParams(base, currentRel, item.path, searchParams);
            const hasChildren = !!item.children?.length;
            const parentActive = matchParent(base, item);
            return (
              <div key={item.path || "dashboard"} className="flex flex-col gap-0.5">
                <ProjectSubLink
                  href={href}
                  active={parentActive}
                  onSelect={onItemSelect}
                  label={tProjectDetail(item.i18nKey)}
                  Icon={item.icon}
                  beta={item.beta}
                />
                {hasChildren ? (
                  <div className="ml-4 flex flex-col gap-0.5">
                    {item.children!.map((child) => {
                      const childHref = carryProjectFilterParams(base, currentRel, child.path, searchParams);
                      const childActive = matchPath(base, child.path);
                      return (
                        <ProjectSubLink
                          key={`${item.path}-${child.path}`}
                          href={childHref}
                          active={childActive}
                          onSelect={onItemSelect}
                          label={tProjectDetail(child.i18nKey)}
                          Icon={child.icon}
                          dense
                          beta={child.beta}
                        />
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </nav>
  );
}

function SectionLabel({
  icon: Icon,
  label,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 px-3 pt-2 pb-1">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      <span className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {label}
      </span>
    </div>
  );
}

function LeafLink({
  route,
  active,
  indent,
  onSelect,
  t,
}: {
  route: RouteDef;
  active: boolean;
  indent: boolean;
  onSelect?: () => void;
  t: (key: string) => string;
}) {
  const Icon = ROUTE_ICON[route.key];
  return (
    <Link
    // prefetch 끄기(2026-08-27): next/link 기본 auto 프리페치가 뷰포트에 들어온
    // 링크마다 라우트를 미리 렌더시킨다. 프로덕션 로그 실측에서 사이드바가
    // 보이는 순간 (dash) leaf 라우트 **7개가 같은 초에** 요청됐고, 그 렌더들이
    // Suspense 안에서 미러 집계 트랜잭션을 열어 둔 채 셸만 응답했다. 그 뒤
    // Vercel 이 인스턴스를 정지시키면 트랜잭션이 문장 사이에서 얼어 scope_*
    // 테이블에 AccessShareLock 을 수 분간 쥔다(0046 ALTER 가 55P03 으로 거부된
    // 원인). 잃는 것은 loading.tsx 셸의 선행 렌더뿐이고 — 실데이터는 어차피
    // 프리페치 대상이 아니다 — 클릭 시 셸은 즉시 나온다.
    prefetch={false}
      href={route.path}
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-md py-2 text-sm font-medium transition-colors",
        indent ? "px-3 pl-7" : "px-3",
        active
          ? "bg-brand-700/10 text-brand-700"
          : "text-foreground/80 hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 shrink-0 transition-colors",
          active ? "text-brand-700" : "text-muted-foreground",
        )}
        aria-hidden
      />
      <span className="truncate">{t(route.key)}</span>
    </Link>
  );
}

function ProjectSubLink({
  href,
  active,
  onSelect,
  label,
  Icon,
  dense,
  beta,
}: {
  href: string;
  active: boolean;
  onSelect?: () => void;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  dense?: boolean;
  beta?: boolean;
}) {
  // Explicit hierarchy in font weight + size so the SNB depth reads at a
  // glance: depth-3 parents are 14px / medium; depth-4 children are 12px /
  // normal + a lighter resting color. (Previously both depths shared the
  // same 14px which made the tree look flat.)
  return (
    <Link
    // prefetch 끄기(2026-08-27): next/link 기본 auto 프리페치가 뷰포트에 들어온
    // 링크마다 라우트를 미리 렌더시킨다. 프로덕션 로그 실측에서 사이드바가
    // 보이는 순간 (dash) leaf 라우트 **7개가 같은 초에** 요청됐고, 그 렌더들이
    // Suspense 안에서 미러 집계 트랜잭션을 열어 둔 채 셸만 응답했다. 그 뒤
    // Vercel 이 인스턴스를 정지시키면 트랜잭션이 문장 사이에서 얼어 scope_*
    // 테이블에 AccessShareLock 을 수 분간 쥔다(0046 ALTER 가 55P03 으로 거부된
    // 원인). 잃는 것은 loading.tsx 셸의 선행 렌더뿐이고 — 실데이터는 어차피
    // 프리페치 대상이 아니다 — 클릭 시 셸은 즉시 나온다.
    prefetch={false}
      href={href}
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-md pr-3 transition-colors",
        dense
          ? "py-1.5 pl-3 text-xs font-normal"
          : "py-2 pl-3 text-sm font-medium",
        active
          ? "bg-brand-700/10 text-brand-700"
          : dense
            ? "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            : "text-foreground/80 hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <Icon
        className={cn(
          dense ? "h-3 w-3" : "h-4 w-4",
          "shrink-0 transition-colors",
          active ? "text-brand-700" : "text-muted-foreground",
        )}
        aria-hidden
      />
      <span className="truncate">{label}</span>
      {beta ? (
        // (beta) 접미사 — 파란색 고정. active 상태에서도 브랜드 네이비에 묻히지
        // 않도록 링크 색을 상속하지 않고 --color-beta(목업 추출값)를 직접 쓴다.
        <span
          className={cn(
            "shrink-0 font-normal text-beta dark:text-beta-dark",
            dense ? "text-[10px]" : "text-[11px]",
          )}
        >
          (beta)
        </span>
      ) : null}
    </Link>
  );
}

// Pinned "back to project list" affordance — rendered at the very bottom of
// the SNB column (outside the scroll area) while inside a project detail.
function BackToProjectsLink({ onSelect }: { onSelect?: () => void }) {
  const t = useTranslations("nav.projectDetail");
  return (
    <div className="border-t border-border px-3 py-3">
      <Link
      // prefetch 끄기(2026-08-27): next/link 기본 auto 프리페치가 뷰포트에 들어온
      // 링크마다 라우트를 미리 렌더시킨다. 프로덕션 로그 실측에서 사이드바가
      // 보이는 순간 (dash) leaf 라우트 **7개가 같은 초에** 요청됐고, 그 렌더들이
      // Suspense 안에서 미러 집계 트랜잭션을 열어 둔 채 셸만 응답했다. 그 뒤
      // Vercel 이 인스턴스를 정지시키면 트랜잭션이 문장 사이에서 얼어 scope_*
      // 테이블에 AccessShareLock 을 수 분간 쥔다(0046 ALTER 가 55P03 으로 거부된
      // 원인). 잃는 것은 loading.tsx 셸의 선행 렌더뿐이고 — 실데이터는 어차피
      // 프리페치 대상이 아니다 — 클릭 시 셸은 즉시 나온다.
      prefetch={false}
        href="/projects"
        onClick={onSelect}
        className="group flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <ArrowLeft
          className="h-4 w-4 shrink-0 transition-transform group-hover:-translate-x-0.5"
          aria-hidden
        />
        <span className="truncate">{t("backToList")}</span>
      </Link>
    </div>
  );
}

// Desktop SNB column — sits right of the GNB rail, below the common top
// header (h-14) + beta-notice banner (h-10): sticky top-24, height
// 100vh - 6rem (same offset as the KPI filter panel — see beta-notice.tsx).
// Light surface for clear body text contrast against the dark rail.
export function Sidebar({ routes, projectMeta, locale }: CommonProps & { locale: string }) {
  const activeGroup = useActiveGroup();
  const projectContext = useProjectContext();
  const effectiveMeta = useEffectiveProjectMeta(projectContext, projectMeta);
  const filtered = routes.filter((r) => r.group === activeGroup);
  const inProjectDetail = activeGroup === "project" && !!projectContext;
  return (
    <aside
      className="hidden shrink-0 border-r border-border bg-card lg:sticky lg:top-24 lg:flex lg:h-[calc(100vh-6rem)] lg:w-60 lg:flex-col"
      aria-label="Secondary navigation"
    >
      <div className="flex-1 overflow-y-auto px-3 py-6">
        {effectiveMeta ? (
          <ProjectHeader meta={effectiveMeta} locale={locale} />
        ) : null}
        <NavList
          routes={filtered}
          group={activeGroup}
          projectContext={activeGroup === "project" ? projectContext : null}
        />
      </div>
      {inProjectDetail ? <BackToProjectsLink /> : null}
    </aside>
  );
}

// Mobile drawer — single combined surface for both GNB and SNB. Flattens
// every visible route across groups since the narrow viewport doesn't have
// room for a rail + column layout.
export function SidebarMobileTrigger({
  routes,
  projectMeta,
  locale,
}: {
  routes: readonly RouteDef[];
  projectMeta?: ProjectMetaForSnb | null;
  locale: string;
}) {
  const activeGroup = useActiveGroup();
  const projectContext = useProjectContext();
  const effectiveMeta = useEffectiveProjectMeta(projectContext, projectMeta);
  const tNav = useTranslations("nav");
  const tGroup = useTranslations("nav.groups");
  const [open, setOpen] = useState(false);

  const groupOrder: RouteGroup[] = ["standard", "website", "project", "admin"];
  const byGroup = groupOrder
    .map((g) => ({
      group: g,
      items: routes.filter((r) => r.group === g),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="lg:hidden"
        onClick={() => setOpen(true)}
        aria-label={tNav("openSidebar")}
      >
        <Menu className="h-5 w-5" aria-hidden />
      </Button>

      {open ? (
        <div
          className="fixed inset-0 z-50 flex lg:hidden"
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            aria-label={tNav("closeSidebar")}
            className="fixed inset-0 bg-foreground/40 animate-fade-in"
            onClick={() => setOpen(false)}
          />
          <div className="relative flex h-full w-72 flex-col bg-card shadow-soft-xl animate-slide-up">
            <div className="flex items-center justify-end px-2 py-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setOpen(false)}
                aria-label={tNav("closeSidebar")}
              >
                <X className="h-5 w-5" aria-hidden />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto px-3 pb-6">
              {effectiveMeta ? (
                <ProjectHeader meta={effectiveMeta} locale={locale} />
              ) : null}
              <div className="flex flex-col gap-6">
                {byGroup.map(({ group, items }) => (
                  <div key={group} className="flex flex-col gap-2">
                    <h3
                      className={cn(
                        "px-3 text-[10px] font-semibold tracking-[0.18em] uppercase",
                        group === activeGroup
                          ? "text-brand-700"
                          : "text-muted-foreground",
                      )}
                    >
                      {tGroup(group)}
                    </h3>
                    <NavList
                      routes={items}
                      group={group}
                      projectContext={
                        group === "project" ? projectContext : null
                      }
                      onItemSelect={() => setOpen(false)}
                    />
                  </div>
                ))}
              </div>
            </div>
            {projectContext ? (
              <BackToProjectsLink onSelect={() => setOpen(false)} />
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
