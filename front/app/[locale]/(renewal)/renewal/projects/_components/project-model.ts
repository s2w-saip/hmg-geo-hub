// Renewal Project (2026-11-03, menu option D — docs/design/ui/project-menu-mockup.html): the list lives in the main
// tab's sidebar; a project opens in its own browser tab whose sidebar is that project's menu only. Data: the screen
// projects/list (back/bff/screens/sources.py → gold/projects): Gold surface 3 has no project name, brand or country,
// so a project is told apart by its Gold values (measured countries · languages · engines, first prompt).

/** One row of the screen projects/list. */
export interface ProjectRow {
  id: string;
  prompts: number;
  answers: number;
  last_measured_day: string | null;
  countries: string[];
  engines: string[];
  languages: string[];
  rounds: number;
  custom_fields: number;
  first_prompt: string | null;
}

/** The named browser tabs (menu option D): every project opens in the one project tab, the list in the main one. */
export const PROJECT_TAB = "hgh-project";
export const MAIN_TAB = "hgh-main";

/** A project's pages under /projects/{id} ("" = Dashboard), in the original menu's order (components/dash/sidebar.tsx
 * PROJECT_SUB_ITEMS; AI Visibility and ACR stay out of the menu there too). */
export const PROJECT_PAGES = [
  "",
  "intent/google-keyword",
  "intent/social-scraping",
  "prompt",
  "analysis/mention",
  "analysis/citation",
  "ai-funnel/conversion",
  "setting",
  "member",
] as const;
export type ProjectPage = (typeof PROJECT_PAGES)[number];

/** Menu parents open their first child, as the original parent pages redirect. */
const FIRST_CHILD: Readonly<Record<string, ProjectPage>> = {
  intent: "intent/google-keyword",
  analysis: "analysis/mention",
  "ai-funnel": "ai-funnel/conversion",
};

/** The page a project tab path asks for: a page, a parent's first child, or nothing (404). */
export function projectPageOf(sub: readonly string[] | undefined): { page: ProjectPage } | { redirect: ProjectPage } | null {
  const path = (sub ?? []).join("/");
  if ((PROJECT_PAGES as readonly string[]).includes(path)) return { page: path as ProjectPage };
  return FIRST_CHILD[path] ? { redirect: FIRST_CHILD[path] } : null;
}

/** The locale-less path of a project page. */
export function projectHref(id: string, page: string = ""): string {
  return `/renewal/projects/${id}${page ? `/${page}` : ""}`;
}

/** The project id and its page of a locale-less renewal path, or null outside a project tab. */
export function projectAt(path: string): { id: string; page: string } | null {
  const m = /^\/renewal\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
  return m ? { id: m[1], page: (m[2] ?? "").replace(/\/$/, "") } : null;
}

/** The short id shown where a name would be (Gold has none). */
export const shortId = (id: string) => id.slice(0, 8);

export type AnswersFilter = "all" | "measured" | "unmeasured";
export type ProjectSortKey = "last" | "answers" | "prompts" | "rounds";

export function projectMatches(row: ProjectRow, query: string, countryLabel: (code: string) => string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [row.id, row.first_prompt ?? "", ...row.countries, ...row.countries.map(countryLabel)].join(" ").toLowerCase();
  return hay.includes(q);
}

export function answersMatch(row: ProjectRow, filter: AnswersFilter): boolean {
  return filter === "all" || (filter === "measured") === row.answers > 0;
}

/** Sorted by the key, ties (and projects never measured) in the screen's order. */
export function sortProjects(rows: readonly ProjectRow[], sort: { key: ProjectSortKey; asc: boolean }): ProjectRow[] {
  const value = (r: ProjectRow): number | string | null =>
    sort.key === "last" ? r.last_measured_day : sort.key === "answers" ? r.answers : sort.key === "prompts" ? r.prompts : r.rounds;
  const indexed = rows.map((r, i) => ({ r, i, v: value(r) }));
  indexed.sort((a, b) => {
    if (a.v == null || b.v == null) return a.v == null && b.v == null ? a.i - b.i : a.v == null ? 1 : -1;
    const c = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    return (sort.asc ? c : -c) || a.i - b.i;
  });
  return indexed.map((x) => x.r);
}
