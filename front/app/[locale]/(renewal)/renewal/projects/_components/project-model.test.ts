import { describe, expect, it, vi } from "vitest";
import ko from "@/messages/ko.json";
import { resolvePageTitleRef } from "@/lib/nav/page-title";
import {
  PROJECT_PAGES,
  answersMatch,
  projectAt,
  projectHref,
  projectMatches,
  projectPageOf,
  sortProjects,
  type ProjectRow,
} from "./project-model";

// the original sidebar module (its project menu) needs the navigation helpers only to load
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => "/" }));
vi.mock("@/i18n/navigation", () => ({ Link: () => null, usePathname: () => "/", useRouter: () => ({}) }));
vi.mock("@/lib/auth/actions", () => ({ logout: async () => {} }));
const { PROJECT_SUB_ITEMS } = await import("@/components/dash/sidebar");

const row = (over: Partial<ProjectRow>): ProjectRow => ({
  id: "843ecb1b-0000-4000-8000-000000000001",
  prompts: 3,
  answers: 6,
  last_measured_day: "2026-10-11",
  countries: ["KR"],
  engines: ["chatgpt", "gemini"],
  languages: ["ko"],
  rounds: 1,
  custom_fields: 0,
  first_prompt: "GV60 마그마 출시를 통해 제네시스가",
  ...over,
});

describe("project tab pages", () => {
  it("are the original project menu's leaves, in its order", () => {
    const leaves = PROJECT_SUB_ITEMS.flatMap((i) => (i.children?.length ? i.children.map((c) => c.path) : [i.path]));
    expect([...PROJECT_PAGES]).toEqual(leaves);
    // each names its page (the browser tab's title) as the original menu does
    const titles = PROJECT_PAGES.map((p) => resolvePageTitleRef(`/projects/x${p ? `/${p}` : ""}`));
    for (const ref of titles) expect(ref?.namespace).toBe("nav.projectDetail");
    expect(titles.map((r) => ko.nav.projectDetail[r!.key as keyof typeof ko.nav.projectDetail])).toEqual([
      "Dashboard", "Google Keyword", "Social Scraping", "Prompt", "Mention", "Citation", "AI Conversion", "General", "Member",
    ]);
  });

  it("open a page, send a menu parent to its first child, and know no other path", () => {
    expect(projectPageOf(undefined)).toEqual({ page: "" });
    expect(projectPageOf(["analysis", "mention"])).toEqual({ page: "analysis/mention" });
    expect(projectPageOf(["setting"])).toEqual({ page: "setting" });
    expect(projectPageOf(["intent"])).toEqual({ redirect: "intent/google-keyword" });
    expect(projectPageOf(["analysis"])).toEqual({ redirect: "analysis/mention" });
    expect(projectPageOf(["ai-funnel"])).toEqual({ redirect: "ai-funnel/conversion" });
    // hidden in the original menu too (AI Visibility, ACR), and anything else
    for (const sub of [["ai-funnel", "acr"], ["ai-funnel", "visibility"], ["new"], ["analysis", "mention", "x"]]) expect(projectPageOf(sub)).toBeNull();
  });

  it("read the project and its page from a renewal path", () => {
    expect(projectHref("p1")).toBe("/renewal/projects/p1");
    expect(projectHref("p1", "analysis/citation")).toBe("/renewal/projects/p1/analysis/citation");
    expect(projectAt("/renewal/projects/p1")).toEqual({ id: "p1", page: "" });
    expect(projectAt("/renewal/projects/p1/analysis/citation")).toEqual({ id: "p1", page: "analysis/citation" });
    expect(projectAt("/renewal/projects")).toBeNull();
    expect(projectAt("/renewal/dashboard")).toBeNull();
  });
});

describe("project list", () => {
  const label = (c: string) => ({ KR: "한국", US: "미국" })[c] ?? c;

  it("finds a project by its ID, first prompt or country (code or name)", () => {
    const r = row({});
    for (const q of ["843ECB", "마그마", "kr", "한국", "  "]) expect(projectMatches(r, q, label), q).toBe(true);
    expect(projectMatches(r, "미국", label)).toBe(false);
    expect(projectMatches(row({ first_prompt: null, countries: [] }), "마그마", label)).toBe(false);
  });

  it("splits projects by whether Gold has answers", () => {
    expect([answersMatch(row({}), "measured"), answersMatch(row({}), "unmeasured"), answersMatch(row({ answers: 0 }), "unmeasured")]).toEqual([true, false, true]);
  });

  it("sorts on the key, never-measured last, ties in the screen's order", () => {
    const a = row({ id: "a", answers: 6, last_measured_day: "2026-10-11" });
    const b = row({ id: "b", answers: 810, last_measured_day: "2026-10-06" });
    const c = row({ id: "c", answers: 0, last_measured_day: null });
    const d = row({ id: "d", answers: 6, last_measured_day: "2026-10-11" });
    const ids = (rows: ProjectRow[]) => rows.map((r) => r.id).join("");
    expect(ids(sortProjects([a, b, c, d], { key: "last", asc: false }))).toBe("adbc");
    expect(ids(sortProjects([a, b, c, d], { key: "last", asc: true }))).toBe("badc");
    expect(ids(sortProjects([a, b, c, d], { key: "answers", asc: false }))).toBe("badc");
  });
});
