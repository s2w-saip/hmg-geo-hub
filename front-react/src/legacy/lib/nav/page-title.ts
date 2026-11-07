import { ROUTES } from "@/lib/auth/route-policy";

// Resolve a request pathname to the i18n label that the SNB (sidebar) shows
// for that page — the "breadcrumb" of the current location — so the browser
// tab <title> can be unified with the active menu label.
//
// Single source of intent: the sidebar's nav trees (components/dash/sidebar.tsx)
// and route-policy's ROUTES both key off the SAME `nav.*` / `nav.projectDetail.*`
// dictionaries. This resolver mirrors that mapping for server-side metadata:
//   - group routes (표준 / 웹사이트 / 프로젝트 목록 / Admin) → nav.<key>
//   - project detail (/projects/{id}/*)                       → nav.projectDetail.<key>
// Keep the project-detail table in sync with PROJECT_SUB_ITEMS in sidebar.tsx.

export type PageTitleRef = {
  // next-intl namespace to translate `key` under.
  namespace: "nav" | "nav.projectDetail";
  key: string;
};

const LOCALE_PREFIX = /^\/(ko|en)(?=\/|$)/;

function stripLocale(path: string): string {
  return path.replace(LOCALE_PREFIX, "") || "/";
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

// Website routes that carry their OWN label — no standard twin to borrow, so the
// prefix must NOT be stripped. 웹사이트 프롬프트는 표준프롬프트와 다른 카탈로그라
// (website_prompts: brand×country×language, HMG 분류 없음) 라벨을 공유하지 않는다.
// Stripping would resolve to a nonexistent `nav.prompts` and the tab title would
// silently fall back to the raw key.
const WEBSITE_OWN_LABEL_KEYS: ReadonlySet<string> = new Set(["websitePrompts"]);

// Website routes otherwise intentionally reuse the standard nav labels (see
// WEBSITE_SUB_ITEMS in sidebar.tsx). Their route keys carry a "website" prefix
// (websiteAnswerAnalysisCitation) but the shown label lives under the un-prefixed
// standard key (answerAnalysisCitation). Strip the prefix to land on it.
function navKeyForRouteKey(routeKey: string): string {
  if (WEBSITE_OWN_LABEL_KEYS.has(routeKey)) return routeKey;
  if (routeKey.startsWith("website")) {
    const rest = routeKey.slice("website".length);
    return rest.charAt(0).toLowerCase() + rest.slice(1);
  }
  return routeKey;
}

// Path suffix (relative to /projects/{id}) → nav.projectDetail key.
// Ordered most-specific first so the longest matching suffix wins.
const PROJECT_DETAIL_TITLES: ReadonlyArray<readonly [string, string]> = [
  ["intent/google-keyword", "intentGoogleKeyword"],
  ["intent/social-scraping", "intentSocialScraping"],
  ["analysis/mention", "analysisMention"],
  ["analysis/citation", "analysisCitation"],
  ["ai-funnel/visibility", "aiFunnelVisibility"],
  ["ai-funnel/acr", "aiFunnelAcr"],
  ["ai-funnel/conversion", "aiFunnelConversion"],
  ["intent", "intent"],
  ["analysis", "analysis"],
  ["ai-funnel", "aiFunnel"],
  ["prompt", "prompt"],
  ["member", "member"],
  // The bare /setting page IS the General settings leaf in the SNB tree.
  ["setting", "general"],
  ["", "dashboard"], // bare /projects/{id} = project Dashboard
];

export function resolvePageTitleRef(pathname: string): PageTitleRef | null {
  const path = trimTrailingSlash(stripLocale(pathname));

  // Project detail: /projects/{id}/... (id !== "new"). The SNB shows the
  // project sub-nav here, not the flat "Project list" label.
  const projectMatch = path.match(/^\/projects\/([^/]+)(?:\/(.*))?$/);
  if (projectMatch && projectMatch[1] !== "new") {
    const rest = projectMatch[2] ?? "";
    for (const [suffix, key] of PROJECT_DETAIL_TITLES) {
      if (rest === suffix || (suffix && rest.startsWith(suffix + "/"))) {
        return { namespace: "nav.projectDetail", key };
      }
    }
    return { namespace: "nav.projectDetail", key: "dashboard" };
  }

  // Group routes — most-specific ROUTES match wins (mirror canAccessRoute).
  const candidates = ROUTES.filter(
    (r) => path === r.path || path.startsWith(r.path + "/"),
  );
  // a renewal path without a row of its own carries its original's label (as route-policy permits it)
  if (candidates.length === 0) return path.startsWith("/renewal/") ? resolvePageTitleRef(path.slice("/renewal".length)) : null;
  const best = candidates.reduce((a, b) =>
    b.path.length > a.path.length ? b : a,
  );
  return { namespace: "nav", key: navKeyForRouteKey(best.key) };
}
