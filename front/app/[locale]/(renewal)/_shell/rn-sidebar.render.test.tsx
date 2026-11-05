import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import ko from "@/messages/ko.json";
import { visibleRoutes } from "@/lib/auth/route-policy";
import type { Role } from "@/lib/auth/types";

// The renewal menu (2026-10-29) = the production web's (hmg-geo.vercel.app) — AI Visibility is hidden again — every
// section open down to its sub-items, and every item opens /renewal<path> — its renewal page or the
// "not implemented" page; no item leaves the renewal shell for an original screen.

// locale-less paths, as the locale-aware helpers hand them over (the ecat render tests' pattern)
let PATH = "/renewal/dashboard";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  usePathname: () => PATH,
  useRouter: () => ({ replace: () => {}, push: () => {} }),
}));
vi.mock("@/lib/auth/actions", () => ({ logout: async () => {} }));

const { RnSidebar } = await import("./rn-sidebar");
const { ADMIN_SUB_ITEMS, STANDARD_SUB_ITEMS, WEBSITE_SUB_ITEMS } = await import("@/components/dash/sidebar");
const { ACCOUNT_PAGES, RENEWAL_PAGES, RENEWAL_PROJECT_PAGES } = await import("./renewal-pages");

/** Section → its open state and its items in order: links as "label → href" ("· 미구현" marks an item without a
 * renewal page, 2026-10-29; "· 계정 <account>" one waiting on an outside account, 2026-11-02), a menu
 * parent (a label over its sub-items, not a link) as "label (group)". */
function html(role: Role): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={ko} timeZone="Asia/Seoul">
      <RnSidebar routes={visibleRoutes(role)} user={{ email: "a@example.test", role }} locale="ko" />
    </NextIntlClientProvider>,
  );
}

function menu(role: Role): Record<string, { open: boolean; links: string[] }> {
  const out: Record<string, { open: boolean; links: string[] }> = {};
  for (const [, open, id, body] of html(role).matchAll(/<details( open="")?[^>]*data-rn-sec="(\w+)"[^>]*>(.*?)<\/details>/g)) {
    const links = [...body.matchAll(/<a href="([^"]+)"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?<span[^>]*>([^<]*)<\/span>(.*?)<\/a>|<div[^>]*data-rn-nav-group=""[^>]*>(?:<svg[^>]*>.*?<\/svg>)?<span[^>]*>([^<]*)<\/span><\/div>/g)].map(
      ([, href, label, rest, group]) => {
        if (group != null) return `${group} (group)`;
        const account = /data-rn-nav-account="(\w+)"/.exec(rest)?.[1];
        return `${label}${rest.includes("data-rn-nav-unimplemented") ? " · 미구현" : ""}${account ? ` · 계정 ${account}` : ""} → ${href}`;
      },
    );
    out[id] = { open: open != null, links };
  }
  return out;
}

const GLOBAL = [
  "Overview → /renewal/dashboard",
  "Global prompts → /renewal/standard/prompts",
  "Answer analysis (group)",
  "Mention → /renewal/standard/answer-analysis/mention",
  "Citation → /renewal/standard/answer-analysis/citation",
  "AI Agent Funnel (group)",
  "ACR → /renewal/standard/ai-funnel/acr",
  "AI Conversion · 계정 ga4 → /renewal/standard/ai-funnel/conversion",
];
const WEBSITE = [
  "Overview → /renewal/website",
  "Prompts → /renewal/website/prompts",
  "Answer analysis (group)",
  "Mention → /renewal/website/answer-analysis/mention",
  "Citation → /renewal/website/answer-analysis/citation",
  "AI Agent Funnel (group)",
  "AI Conversion · 계정 ga4 → /renewal/website/ai-funnel/conversion",
];

describe("renewal sidebar", () => {
  it("shows an administrator the production menu, every section open, every item in the renewal shell", () => {
    expect(menu("admin")).toEqual({
      standard: { open: true, links: GLOBAL },
      website: { open: true, links: WEBSITE },
      project: { open: true, links: ["Project list → /renewal/projects"] },
      admin: {
        open: true,
        links: [
          "User management → /renewal/admin",
          "Global config (group)",
          "Global prompts → /renewal/admin/standards/prompts",
          "Customer interest config → /renewal/admin/standards/customer-interest",
          "Entity catalog → /renewal/admin/standards/entities",
          "인용 출처 분류 → /renewal/admin/standards/citation-sources",
          "Keyword tools · 계정 dataforseo → /renewal/admin/keyword-tools",
          "GA4 연동 → /renewal/admin/ga4",
          "분석 엔진 · 미구현 → /renewal/admin/analysis",
          "리포트 관리 · 미구현 → /renewal/admin/reports",
          "측정 크레딧 (group)",
          "계정 목록 · 미구현 → /renewal/admin/credits",
        ],
      },
    });
  });

  // 2026-10-29 (user): items without a renewal page carry the "not implemented" icon (named for assistive tech and on
  // hover); no item carries the β badge
  it("marks the items without a renewal page and shows no beta badge", () => {
    const out = html("admin");
    const marks = [...out.matchAll(/<span data-rn-nav-unimplemented="" title="([^"]+)"[^>]*><svg[^>]*>.*?<\/svg><span class="sr-only">([^<]+)<\/span><\/span>/g)];
    expect(marks.length).toBe(3); // Admin 3 (Project list has its page since 2026-11-03)
    for (const [, title, sr] of marks) expect([title, sr]).toEqual([ko.unimplemented.label, ko.unimplemented.label]);
    expect(out).not.toContain("β");
  });

  // 2026-11-02 (user): an item waiting on an outside account carries a key, not the "not implemented" mark — named for
  // the account on hover and for assistive tech
  it("marks the items waiting on an outside account with the account they need", () => {
    const out = html("admin");
    const marks = [...out.matchAll(/<a href="([^"]+)"[^>]*>(?:(?!<\/a>).)*<span data-rn-nav-account="(\w+)" title="([^"]+)"[^>]*><svg[^>]*>.*?<\/svg><span class="sr-only">([^<]+)<\/span><\/span><\/a>/g)];
    expect(marks.map(([, href, account, title, sr]) => [href, account, title, sr])).toEqual([
      ["/renewal/standard/ai-funnel/conversion", "ga4", ko.accountGate.ga4.label, ko.accountGate.ga4.label],
      ["/renewal/website/ai-funnel/conversion", "ga4", ko.accountGate.ga4.label, ko.accountGate.ga4.label],
      ["/renewal/admin/keyword-tools", "dataforseo", ko.accountGate.dataforseo.label, ko.accountGate.dataforseo.label],
    ]);
    // a page waiting on an account has its renewal page, so it never carries the "not implemented" mark as well
    for (const path of Object.keys(ACCOUNT_PAGES)) expect(RENEWAL_PAGES.has(path), path).toBe(true);
  });

  const ROUTE_PAGE = /(^|[\\/])page\.tsx$/;
  it("knows exactly the renewal pages there are", () => {
    const root = fileURLToPath(new URL("../renewal/", import.meta.url));
    const pages = readdirSync(root, { recursive: true, encoding: "utf8" })
      // a project tab's pages (projects/[id]/…) are no menu item: renewal-pages RENEWAL_PROJECT_PAGES lists them.
      // A route is a file named page.tsx, not one ending in it (2026-11-05: admin/_components/admin-list-page.tsx).
      .filter((f) => ROUTE_PAGE.test(f) && !f.includes("[...slug]") && !f.includes("[id]"))
      .map((f) => "/" + f.replace(/\\/g, "/").replace(/\/?page\.tsx$/, ""));
    expect([...RENEWAL_PAGES].sort()).toEqual(pages.sort());
  });

  it("knows exactly the project pages there are", () => {
    const root = fileURLToPath(new URL("../renewal/projects/[id]/", import.meta.url));
    const pages = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((f) => ROUTE_PAGE.test(f) && !f.includes("[...sub]"))
      .map((f) => f.replace(/\\/g, "/").replace(/\/?page\.tsx$/, ""));
    expect([...RENEWAL_PROJECT_PAGES].sort()).toEqual(pages.sort());
  });

  // 2026-10-28 (user): Project · Admin follow Global · Website at the top; only the account sits at the bottom
  it("keeps Project · Admin right under Global · Website: only the account is pushed to the bottom", () => {
    const out = html("admin");
    const bottom = out.slice(out.indexOf('class="mt-auto'));
    expect(bottom).toContain(`aria-label="${ko.nav.logout}"`);
    for (const id of ["standard", "website", "project", "admin"]) expect(bottom, id).not.toContain(`data-rn-sec="${id}"`);
  });

  // 2026-11-03 (menu option D): Project is the administrator's (route-policy /renewal/projects, ⛔J)
  it.each(["country", "local_reader"] as Role[])("shows %s the same Global · Website menus, and no Project or Admin", (role) => {
    const m = menu(role);
    expect(Object.keys(m)).toEqual(["standard", "website"]);
    expect(m.standard.links).toEqual(GLOBAL);
    expect(m.website.links).toEqual(WEBSITE);
  });

  // 2026-10-28 (user): a menu parent only holds its sub-items — it is not a link, and it looks like a group heading
  // 2026-10-28 (user, Nav refinement): first-level items and menu parents carry the menu's icon; a parent's
  // sub-items sit inside a tree line, without icons
  it("shows a menu parent as the heading of its sub-items (a tree), not as a link", () => {
    const out = html("admin");
    const groups = [...out.matchAll(/<div role="group" aria-labelledby="([^"]+)"[^>]*><div id="([^"]+)" data-rn-nav-group="" class="([^"]*)">(<svg[^>]*>.*?<\/svg>)?<span>([^<]*)<\/span><\/div><div data-rn-nav-tree=""[^>]*>(.*?)<\/div><\/div>/g)];
    expect(groups.map((g) => g[5])).toEqual(["Answer analysis", "AI Agent Funnel", "Answer analysis", "AI Agent Funnel", "Global config", "측정 크레딧"]);
    for (const [, labelledBy, id, cls, icon, label, tree] of groups) {
      expect(labelledBy, label).toBe(id);
      expect(icon, label).toBeTruthy();
      expect(cls, label).not.toMatch(/cursor-pointer|hover:/);
      expect(tree, label).toMatch(/^<a href="\/renewal\//);
      // no menu icon on a sub-item (the "not implemented" and account marks are a status, not the menu's icon)
      expect(tree.replace(/<span data-rn-nav-(?:unimplemented|account)="\w*".*?<\/span><\/span>/g, ""), label).not.toContain("<svg");
    }
    expect(out).not.toMatch(/<a [^>]*>(<svg[^>]*>(?:(?!<\/svg>).)*<\/svg>)?(<span[^>]*>)?(Answer analysis|AI Agent Funnel|Global config|측정 크레딧)</);
  });

  it("gives every first-level item its menu icon", () => {
    const first = [...html("admin").replace(/<div data-rn-nav-tree=""[^>]*>.*?<\/div>/g, "").matchAll(/<a href="([^"]+)"[^>]*>(<svg)?/g)];
    expect(first.length).toBe(10); // Global 2 · Website 2 · Project 1 · Admin 5
    expect(first.filter(([, , svg]) => !svg).map(([, href]) => href)).toEqual([]);
  });

  // the sidebar is the only place that says Global or Website (no parent menu name above page titles)
  it.each([
    ["/renewal/standard/answer-analysis/mention", "standard"],
    ["/renewal/website/prompts", "website"],
    ["/renewal/admin/ga4", "admin"],
  ])("marks the section of %s as the current one", (path, id) => {
    PATH = path;
    const here = [...html("admin").matchAll(/data-rn-sec="(\w+)"[^>]*><summary data-rn-sec-here=""/g)].map(([, s]) => s);
    PATH = "/renewal/dashboard";
    expect(here).toEqual([id]);
  });

  // a group's first item (/renewal/website, /renewal/admin) holds every page of the group: the longest match is current
  it.each([
    ["/renewal/website/prompts", "Prompts"],
    ["/renewal/website", "Overview"],
    ["/renewal/admin/ga4", "GA4 연동"],
    ["/renewal/admin", "User management"],
    ["/renewal/standard/answer-analysis/citation/prompts", "Citation"],
  ])("marks one current item on %s", (path, label) => {
    PATH = path;
    const current = [...html("admin").matchAll(/<a href="([^"]+)" aria-current="page"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?<span[^>]*>([^<]*)</g)].map(([, href, l]) => `${l} → ${href}`);
    PATH = "/renewal/dashboard";
    expect(current).toEqual([`${label} → ${path === "/renewal/standard/answer-analysis/citation/prompts" ? "/renewal/standard/answer-analysis/citation" : path}`]);
  });
});

// 2026-11-03 (user, menu option D): a project opens in its own browser tab; that tab's sidebar is the project's menu only
describe("project tab", () => {
  const ID = "843ecb1b-0000-4000-8000-000000000001";
  const at = (path: string) => {
    PATH = path;
    try {
      return html("admin");
    } finally {
      PATH = "/renewal/dashboard";
    }
  };
  const P = `/renewal/projects/${ID}`;

  it("shows the project's card and the original project menu, and nothing else", () => {
    PATH = `${P}/analysis/mention`;
    const m = menu("admin");
    PATH = "/renewal/dashboard";
    expect(m).toEqual({
      project: {
        open: true,
        links: [
          `Dashboard → ${P}`,
          "Intent (group)",
          `Google Keyword · 계정 dataforseo → ${P}/intent/google-keyword`,
          `Social Scraping · 계정 dataforseo → ${P}/intent/social-scraping`,
          `Prompt → ${P}/prompt`,
          "Analysis (group)",
          `Mention → ${P}/analysis/mention`,
          `Citation → ${P}/analysis/citation`,
          "AI Agent Funnel (group)",
          `AI Conversion · 계정 ga4 → ${P}/ai-funnel/conversion`,
          "Setting (group)",
          `General → ${P}/setting`,
          `Member → ${P}/member`,
        ],
      },
    });
    const out = at(`${P}/analysis/mention`);
    // the card waits for the project's layout (its rows come in after hydration): a skeleton on the server
    expect(out).toContain(`data-rn-project-card="${ID}"`);
    expect(out).toContain(`aria-label="${ko.renewal.projects.tab.switch}"`);
  });

  it.each([
    [P, "Dashboard", P],
    [`${P}/analysis/mention`, "Mention", `${P}/analysis/mention`],
    [`${P}/setting`, "General", `${P}/setting`],
    [`${P}/member`, "Member", `${P}/member`],
  ])("marks one current item on %s", (path, label, href) => {
    const current = [...at(path).matchAll(/<a href="([^"]+)" aria-current="page"[^>]*>(?:<svg[^>]*>.*?<\/svg>)?<span[^>]*>([^<]*)</g)].map(([, h, l]) => `${l} → ${h}`);
    expect(current).toEqual([`${label} → ${href}`]);
  });

  it("opens Project list in the main tab", () => {
    const out = at(P);
    const link = /<a href="([^"]+)"([^>]*data-rn-project-list-link=""[^>]*)>/.exec(out);
    expect(link?.[1]).toBe("/renewal/projects");
    expect(link?.[2]).toContain('target="hgh-main"');
    expect(link?.[2]).toContain(`title="${ko.renewal.projects.tab.listHint}"`);
  });
});

describe("original menu", () => {
  it("has no renewal rows", () => {
    const paths = [STANDARD_SUB_ITEMS, WEBSITE_SUB_ITEMS, ADMIN_SUB_ITEMS].flat().flatMap((i) => [i.path, ...(i.children ?? []).map((c) => c.path)]);
    expect(paths.filter((p) => p.startsWith("/renewal"))).toEqual([]);
  });
});
