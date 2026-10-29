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
const { RENEWAL_PAGES } = await import("./renewal-pages");

/** Section → its open state and its items in order: links as "label → href" ("· 미구현" marks an item without a
 * renewal page, 2026-10-29), a menu
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
      ([, href, label, rest, group]) => (group != null ? `${group} (group)` : `${label}${rest.includes("data-rn-nav-unimplemented") ? " · 미구현" : ""} → ${href}`),
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
  "AI Conversion → /renewal/standard/ai-funnel/conversion",
];
const WEBSITE = [
  "Overview · 미구현 → /renewal/website",
  "Prompts · 미구현 → /renewal/website/prompts",
  "Answer analysis (group)",
  "Mention · 미구현 → /renewal/website/answer-analysis/mention",
  "Citation · 미구현 → /renewal/website/answer-analysis/citation",
  "AI Agent Funnel (group)",
  "AI Conversion · 미구현 → /renewal/website/ai-funnel/conversion",
];

describe("renewal sidebar", () => {
  it("shows an administrator the production menu, every section open, every item in the renewal shell", () => {
    expect(menu("admin")).toEqual({
      standard: { open: true, links: GLOBAL },
      website: { open: true, links: WEBSITE },
      project: { open: true, links: ["Project list · 미구현 → /renewal/projects"] },
      admin: {
        open: true,
        links: [
          "User management · 미구현 → /renewal/admin",
          "Global config (group)",
          "Global prompts → /renewal/admin/standards/prompts",
          "Customer interest config · 미구현 → /renewal/admin/standards/customer-interest",
          "Entity catalog · 미구현 → /renewal/admin/standards/entities",
          "인용 출처 분류 · 미구현 → /renewal/admin/standards/citation-sources",
          "Keyword tools · 미구현 → /renewal/admin/keyword-tools",
          "GA4 연동 · 미구현 → /renewal/admin/ga4",
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
    expect(marks.length).toBe(15); // Website 5 · Project 1 · Admin 9
    for (const [, title, sr] of marks) expect([title, sr]).toEqual([ko.unimplemented.label, ko.unimplemented.label]);
    expect(out).not.toContain("β");
  });

  it("knows exactly the renewal pages there are", () => {
    const root = fileURLToPath(new URL("../renewal/", import.meta.url));
    const pages = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith("page.tsx") && !f.includes("[...slug]"))
      .map((f) => "/" + f.replace(/\\/g, "/").replace(/\/?page\.tsx$/, ""));
    expect([...RENEWAL_PAGES].sort()).toEqual(pages.sort());
  });

  // 2026-10-28 (user): Project · Admin follow Global · Website at the top; only the account sits at the bottom
  it("keeps Project · Admin right under Global · Website: only the account is pushed to the bottom", () => {
    const out = html("admin");
    const bottom = out.slice(out.indexOf('class="mt-auto'));
    expect(bottom).toContain(`aria-label="${ko.nav.logout}"`);
    for (const id of ["standard", "website", "project", "admin"]) expect(bottom, id).not.toContain(`data-rn-sec="${id}"`);
  });

  it.each(["country", "local_reader"] as Role[])("shows %s the same Global · Website · Project menus and no Admin", (role) => {
    const m = menu(role);
    expect(Object.keys(m)).toEqual(["standard", "website", "project"]);
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
      // no menu icon on a sub-item (the "not implemented" mark is a status, not the menu's icon)
      expect(tree.replace(/<span data-rn-nav-unimplemented="".*?<\/span><\/span>/g, ""), label).not.toContain("<svg");
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

describe("original menu", () => {
  it("has no renewal rows", () => {
    const paths = [STANDARD_SUB_ITEMS, WEBSITE_SUB_ITEMS, ADMIN_SUB_ITEMS].flat().flatMap((i) => [i.path, ...(i.children ?? []).map((c) => c.path)]);
    expect(paths.filter((p) => p.startsWith("/renewal"))).toEqual([]);
  });
});
