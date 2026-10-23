import type { Role, MenuGroup } from "./types";

// Single source of truth: which roles can see / enter which auth-protected route.
// `canSeeMenu == canAccess` — if a role can't see a menu item, the server gate
// also redirects them away from that URL. The DashLayout reads this to render
// the navigation, and the same layout calls canAccessRoute() as a server guard.
//
// Why a separate module from scope-policy:
//   scope-policy decides *values* (which data rows are allowed)
//   route-policy decides *places* (which URLs are allowed)
// Mixing them would make a single function carry two concepts and blur tests.
//
// Adjust this table when a role's menu access changes — it is the only place.
//
// Navigation hierarchy (per GGMD planning v19 IA):
//   1depth = `group`   — rendered as GNB tabs (표준 / Project / Admin)
//   2depth = leaf route OR `section` label
//   3depth = leaf route belonging to a `section` (e.g. AI Visibility under
//            the aiFunnel section). Sections are non-clickable labels in
//            the SNB; only leaf routes carry URLs.
//
// SNB renders the 2depth and 3depth of the currently active 1depth in one
// vertical column — 2depth leaves first, then each section header followed
// by its 3depth children indented.

// 내부 4역할 — 표준(글로벌) 그룹의 기본 시청자. vendor(외부 수행사)와
// website(웹사이트 전용 열람)는 제외.
const STANDARD_VIEWERS: Role[] = ["hq", "region", "country", "admin"];
// 웹사이트 그룹 = 내부 4역할 + website (2026-07-22: [글로벌X, 웹O, 프로젝트X]
// 계정 — 본인 공식 사이트 대시보드만 확인). GNB/랜딩 특수처리는 불필요:
// visibleGroups()가 website 탭만 그리고 defaultLandingFor()가 /website 로 보낸다.
const WEBSITE_VIEWERS: Role[] = [...STANDARD_VIEWERS, "website"];
// 프로젝트 그룹 — vendor 포함, website 제외(피드백: 프로젝트X).
const PROJECT_VIEWERS: Role[] = ["hq", "region", "country", "admin", "vendor"];
const ADMIN_ONLY: Role[] = ["admin"];
// Project creation is a COST action — route access is necessary but not
// sufficient. The actual create gate is the orthogonal operator authority
// (canCreateProject: global | admin), enforced in the create action and the
// "새 프로젝트" CTA visibility (lib/auth/operator-policy.ts, GGMD scenario 3-2).
// Here we only keep vendor OUT at the route layer (외부 수행사 = 운영자 영구
// OFF, never operates); every other role *may* reach the route but still needs
// operator=global to actually create. Whoever creates becomes the project Owner.
const PROJECT_CREATORS: Role[] = [
  "hq",
  "region",
  "country",
  "admin",
];

export const ROUTES = [
  // ─── 표준 — 전사 통합 모니터링 ───────────────────────────────────────
  {
    path: "/dashboard",
    key: "dashboard",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
  },
  // Renewal pages (2026-10-20): the redesigned Overview / Global prompts run side by
  // side with the originals so both can be compared in the service. Same roles as
  // the originals; each sits right after its original so the SNB order matches.
  {
    path: "/renewal/dashboard",
    key: "renewalDashboard",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
  },
  // 표준 프롬프트 (열람 전용) — role-scoped read-only view of the standard
  // prompt catalog (2026-06-15). Brand-scoped per account; no scope filter UI.
  // Mirrors the admin /admin/standards/prompts catalog source but read-only and
  // vendor-excluded. Brand-only scoping (catalog has no region/country axis).
  {
    path: "/standard/prompts",
    key: "standardPrompts",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
  },
  {
    path: "/renewal/standard/prompts",
    key: "renewalStandardPrompts",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
  },
  // Answer Analysis — Mention + Citation now live at their own URLs
  // (2026-06-04 standard SNB reorg). The parent path redirects to the
  // first child. SNB renders the tree via STANDARD_SUB_ITEMS so we don't
  // need a `section` field anymore — the parent + children show as a
  // single visual group via the sidebar's path-based tree.
  {
    path: "/standard/answer-analysis",
    key: "answerAnalysis",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
  },
  {
    path: "/standard/answer-analysis/mention",
    key: "answerAnalysisMention",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
  },
  // Renewal Mention (2026-10-21) — next to the original, same roles (see the renewal note above).
  {
    path: "/renewal/standard/answer-analysis/mention",
    key: "renewalAnswerAnalysisMention",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
  },
  {
    path: "/standard/answer-analysis/citation",
    key: "answerAnalysisCitation",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
  },
  // Renewal Citation (2026-10-21) — next to the original, same roles; covers its prompts / tone-urls sub pages.
  {
    path: "/renewal/standard/answer-analysis/citation",
    key: "renewalAnswerAnalysisCitation",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
  },
  // AI Agent Funnel — same parent → 3 children pattern. Parent redirects
  // to Visibility.
  {
    path: "/standard/ai-funnel",
    key: "aiFunnel",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
  },
  // Hidden from the 표준 SNB (2026-06-23): AI 가시성은 데이터 소스(크롤·SEO 노출)가
  // scope 측정 surface 밖이라 현재 mock-only — 실데이터 연결 전까지 메뉴에서 숨김.
  // 라우트 접근은 유지(동일 VisibilityView 를 프로젝트 뷰가 재사용). 부모
  // /standard/ai-funnel 리다이렉트는 acr 로 이동.
  {
    path: "/standard/ai-funnel/visibility",
    key: "aiFunnelVisibility",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
    hidden: true,
  },
  {
    path: "/standard/ai-funnel/acr",
    key: "aiFunnelAcr",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
  },
  // Renewal ACR (2026-10-21) — next to the original, same roles (see the renewal note above).
  {
    path: "/renewal/standard/ai-funnel/acr",
    key: "renewalAiFunnelAcr",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
  },
  {
    path: "/standard/ai-funnel/conversion",
    key: "aiFunnelConversion",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
  },
  // Customer Interest — parent + 2 children. Parent redirects to
  // google-keywords. Overview 폐기 (2026-06-11).
  // Hidden from the 표준 SNB (2026-06-23): 고객 관심은 표준(전사 측정) 메뉴와
  // 성격이 달라 메뉴에서 숨김. 라우트 접근은 유지 — 프로젝트 intent가 동일
  // GoogleKeywordView/SocialScrapingFlow 를 재사용하고 admin 측 고객관심 관리는
  // 별도(group:admin)로 남는다.
  {
    path: "/customer-interest",
    key: "customerInterest",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
    hidden: true,
  },
  {
    path: "/customer-interest/google-keywords",
    key: "customerInterestGoogleKeywords",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
    hidden: true,
  },
  {
    path: "/customer-interest/social-scraping",
    key: "customerInterestSocialScraping",
    roles: STANDARD_VIEWERS,
    group: "standard" as const,
    hidden: true,
  },
  // ─── 웹사이트 — 확보 권역별 공식 사이트 모니터링 ──────────────────────
  // 표준(전사 측정)과 프로젝트(개별 실행)의 중간 성격. 표준 SNB 구조를 그대로
  // 재사용하되 프롬프트 메뉴는 표준프롬프트가 아닌 웹사이트 전용 카탈로그를
  // 가리킨다(/website/prompts) — 웹사이트는 권역별 공식 사이트용 프롬프트를
  // 별도로 두기 때문(website_prompts, xlsx 적재 완료).
  // country = 자국 공식 사이트, region/hq = 권역 내 국가 종합. 브랜드 통합(종합)
  // 뷰는 admin 전용(웹사이트 필터에서 brand 축은 admin 에게만 노출).
  // 데이터 소스는 당분간 표준 라이브 집계를 재사용 — 권역 프롬프트 적재 후 교체.
  {
    path: "/website",
    key: "websiteDashboard",
    roles: WEBSITE_VIEWERS,
    group: "website" as const,
  },
  // 웹사이트 프롬프트 (열람 전용) — website_prompts 카탈로그. 표준프롬프트와
  // 달리 HMG 분류(listType/depth)가 없고 brand×country×language 축을 갖는다.
  // 수정/생성 없음: 프롬프트 적재는 xlsx 시드(scripts/db/seed-website-prompts.ts)
  // 소관이고 이 화면은 "무엇으로 측정하는가"를 보는 곳이다.
  {
    path: "/website/prompts",
    key: "websitePrompts",
    roles: WEBSITE_VIEWERS,
    group: "website" as const,
  },
  {
    path: "/website/answer-analysis",
    key: "websiteAnswerAnalysis",
    roles: WEBSITE_VIEWERS,
    group: "website" as const,
  },
  {
    path: "/website/answer-analysis/mention",
    key: "websiteAnswerAnalysisMention",
    roles: WEBSITE_VIEWERS,
    group: "website" as const,
  },
  {
    path: "/website/answer-analysis/citation",
    key: "websiteAnswerAnalysisCitation",
    roles: WEBSITE_VIEWERS,
    group: "website" as const,
  },
  {
    path: "/website/ai-funnel",
    key: "websiteAiFunnel",
    roles: WEBSITE_VIEWERS,
    group: "website" as const,
  },
  // Hidden from the 웹사이트 SNB (2026-07-01): ACR 메뉴는 표준(전사 측정)에서만
  // 노출한다. 라우트 접근은 유지(직접 URL 접근 가능) — 부모 /website/ai-funnel
  // 리다이렉트는 conversion 으로 이동. 표준 acr 는 계속 노출.
  {
    path: "/website/ai-funnel/acr",
    key: "websiteAiFunnelAcr",
    roles: WEBSITE_VIEWERS,
    group: "website" as const,
    hidden: true,
  },
  {
    path: "/website/ai-funnel/conversion",
    key: "websiteAiFunnelConversion",
    roles: WEBSITE_VIEWERS,
    group: "website" as const,
  },
  // ─── Project — 개별 GEO 프로젝트 실행 ────────────────────────────────
  {
    path: "/projects",
    key: "projects",
    // Vendor (GEO 수행사) has full Project menu access — including create
    // (resolved 2026-05-29). The data layer scopes vendor's project list to
    // own (created) + assigned only. website(웹사이트 열람) is excluded.
    roles: PROJECT_VIEWERS,
    group: "project" as const,
  },
  {
    // Project create form. Hidden from SNB — the entry point is the "새
    // 프로젝트" CTA on /projects, which itself is gated by canCreateProject
    // (operator=global). Route access excludes vendor; the operator gate in
    // the create action is the binding check.
    path: "/projects/new",
    key: "projectNew",
    roles: PROJECT_CREATORS,
    group: "project" as const,
    hidden: true,
  },
  // ─── Admin — 시스템 운영 관리 ────────────────────────────────────────
  {
    path: "/admin",
    key: "admin",
    roles: ADMIN_ONLY,
    group: "admin" as const,
  },
  // 표준 관리 — parent + 2 children (path-based tree in ADMIN_SUB_ITEMS).
  // `section` field dropped (last user); SNB owns the visual grouping now.
  {
    path: "/admin/standards",
    key: "adminStandards",
    roles: ADMIN_ONLY,
    group: "admin" as const,
  },
  {
    path: "/admin/standards/prompts",
    key: "adminStandardPrompts",
    roles: ADMIN_ONLY,
    group: "admin" as const,
  },
  {
    path: "/admin/standards/customer-interest",
    key: "adminStandardCustomerInterest",
    roles: ADMIN_ONLY,
    group: "admin" as const,
  },
  // 엔티티 카탈로그 — entity_registry(자사 명부) 역할 관리. 역할이 곧 전 화면
  // KPI 당사 판정이라 admin 전용.
  {
    path: "/admin/standards/entities",
    key: "adminStandardEntities",
    roles: ADMIN_ONLY,
    group: "admin" as const,
  },
  // 인용 출처 분류 — citation_domain_overrides 편집. 분류가 read-time 파생이라
  // 저장 즉시 전 이력·전 화면 인용 집계에 반영되므로 admin 전용.
  {
    path: "/admin/standards/citation-sources",
    key: "adminCitationSources",
    roles: ADMIN_ONLY,
    group: "admin" as const,
  },
  // 키워드 도구 — DataForSEO 검색량 + OpenRouter keyword→prompt (ported from
  // aeorank). Admin-only: both back onto PAID external APIs, so access is
  // gated for cost control. /api/keyword/volume, /to-prompt, /prompt-to-volume
  // enforce the same admin gate (bulk direct-tool usage reached from this
  // route). /api/keyword/related and /api/keyword/insight do NOT — they're
  // called from the project Intent screen (google-keyword-view.tsx) by any
  // authenticated operator, gated instead at the action layer by
  // canOperateProject (operator-policy.ts), not by role/route. This is
  // intentional, not a gap — 2026-07-03 QA 확인 (docs/qa/qa-matrix.md
  // QA-SEC-008).
  {
    path: "/admin/keyword-tools",
    key: "keywordTools",
    roles: ADMIN_ONLY,
    group: "admin" as const,
  },
  {
    // GA4 연동 레지스트리(WBS 1.2.2) — brand×country → GA4 속성 매핑 등록·검증.
    // Admin-only: GA 자격/속성 접근을 다루므로.
    path: "/admin/ga4",
    key: "adminGa4",
    roles: ADMIN_ONLY,
    group: "admin" as const,
  },
] as const;

export type RouteDef = (typeof ROUTES)[number];
export type RouteKey = RouteDef["key"];
export type RouteGroup = RouteDef["group"];
// Section keys (2depth labels in SNB). Derived from the union of the
// `section` field; "section" in r is needed because not every route has one.
export type RouteSection = Extract<RouteDef, { section: string }>["section"];

// Routes inside the (dash) group that bypass the role gate. /no-access is the
// landing for users with zero menus — it must be reachable by anyone authenticated.
const GUARD_BYPASS_PATHS: ReadonlySet<string> = new Set(["/no-access"]);

export function isGuardBypass(path: string): boolean {
  return GUARD_BYPASS_PATHS.has(normalizePath(path));
}

// Normalize: strip trailing slash, ignore query/hash. Caller may pass a path
// with locale prefix; we want to match against the role table which uses
// locale-less paths. Locale stripping is done here so callers stay simple.
function normalizePath(path: string): string {
  if (!path) return "/";
  // Drop locale prefix (e.g. "/ko/dashboard" → "/dashboard"). Locales are
  // limited to a short list — see i18n/routing.ts.
  const stripped = path.replace(/^\/(ko|en)(?=\/|$)/, "");
  // Strip trailing slash (but not for root "/")
  const trimmed = stripped.length > 1 && stripped.endsWith("/")
    ? stripped.slice(0, -1)
    : stripped;
  return trimmed || "/";
}

// 계정별 메뉴 그룹 화이트리스트가 이 그룹을 허용하는지. null/빈 = 제한 없음.
// role 판정과 AND 로 결합되므로 좁히기(축소)만 가능하다 — role 이 천장.
function groupAllowed(group: RouteGroup, menuGroups?: readonly MenuGroup[] | null): boolean {
  if (!menuGroups || menuGroups.length === 0) return true;
  return (menuGroups as readonly string[]).includes(group);
}

export function canAccessRoute(
  role: Role,
  path: string,
  menuGroups?: readonly MenuGroup[] | null,
): boolean {
  const normalized = normalizePath(path);
  if (isGuardBypass(normalized)) return true;
  // Most-specific match wins: a nested path (/admin/standards/prompts) must
  // resolve to its own ROUTES entry, not the broader /admin entry, so its role
  // list applies. Sort by descending path length and pick the first match.
  const candidates = ROUTES.filter(
    (r) => normalized === r.path || normalized.startsWith(r.path + "/"),
  );
  if (candidates.length === 0) {
    // Unknown path under (dash): default-deny. Callers should not silently
    // open new routes — add them to ROUTES first.
    return false;
  }
  const best = candidates.reduce((a, b) =>
    b.path.length > a.path.length ? b : a,
  );
  return best.roles.includes(role) && groupAllowed(best.group, menuGroups);
}

export function visibleRoutes(
  role: Role,
  menuGroups?: readonly MenuGroup[] | null,
): RouteDef[] {
  // `hidden` excludes a route from the sidebar even when the role is
  // permitted — used for non-menu surfaces like wizards reached via in-page
  // CTAs (e.g. /projects/new is opened by the "Add Project" button on
  // /projects, not from the SNB). Access control still applies normally.
  return ROUTES.filter(
    (r) =>
      r.roles.includes(role) &&
      !("hidden" in r && r.hidden === true) &&
      groupAllowed(r.group, menuGroups),
  );
}

// Which 1depth groups the user has any visible route in. Drives the GNB tab
// list — a group with zero permitted routes hides its tab.
export function visibleGroups(
  role: Role,
  menuGroups?: readonly MenuGroup[] | null,
): RouteGroup[] {
  const seen = new Set<RouteGroup>();
  for (const r of visibleRoutes(role, menuGroups)) seen.add(r.group);
  // Preserve canonical order: standard → website → project → admin.
  const order: RouteGroup[] = ["standard", "website", "project", "admin"];
  return order.filter((g) => seen.has(g));
}

// Which 1depth group does this path live in? Used by the layout to highlight
// the GNB tab and filter the SNB. Falls back to the first group the user can
// see (e.g. on /no-access where there's no matched route).
export function groupForPath(path: string, role: Role): RouteGroup {
  const normalized = normalizePath(path);
  const match = ROUTES.find(
    (r) => normalized === r.path || normalized.startsWith(r.path + "/"),
  );
  if (match) return match.group;
  return visibleGroups(role)[0] ?? "standard";
}

// Where to send a freshly-authenticated user. If the role has at least one
// menu, send them to the first one. Otherwise → /no-access landing.
export function defaultLandingFor(
  role: Role,
  menuGroups?: readonly MenuGroup[] | null,
): string {
  const first = visibleRoutes(role, menuGroups)[0];
  return first?.path ?? "/no-access";
}
