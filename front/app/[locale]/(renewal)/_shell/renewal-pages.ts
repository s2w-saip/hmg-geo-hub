// The paths (original menu paths, without /renewal) that have a renewal page. Every other menu item
// opens the "not implemented" page (renewal/[...slug]), and the sidebar marks it (2026-10-29, user).
// rn-sidebar.render.test.tsx keeps this list in step with the page files under renewal/.
export const RENEWAL_PAGES: ReadonlySet<string> = new Set([
  "/dashboard",
  "/standard/prompts",
  "/standard/answer-analysis/mention",
  "/standard/answer-analysis/citation",
  "/standard/answer-analysis/citation/prompts",
  "/standard/answer-analysis/citation/tone-urls",
  "/standard/ai-funnel/acr",
  "/standard/ai-funnel/conversion",
  "/standard/ai-funnel/visibility",
  "/website",
  "/website/prompts",
  "/website/answer-analysis/mention",
  "/website/answer-analysis/citation",
  "/website/answer-analysis/citation/prompts",
  "/website/answer-analysis/citation/tone-urls",
  "/website/ai-funnel/conversion",
  "/projects",
  "/admin",
  "/admin/standards/prompts",
  "/admin/standards/customer-interest",
  "/admin/standards/entities",
  "/admin/standards/citation-sources",
  "/admin/keyword-tools",
  "/admin/ga4",
]);

// A project's pages (paths under /projects/{id}, "" = Dashboard) that have a renewal page; the others open the
// project tab's "not implemented" page (renewal/projects/[id]/[[...sub]], menu option D, 2026-11-03).
export const RENEWAL_PROJECT_PAGES: ReadonlySet<string> = new Set<string>([]);

export type RnAccount = "ga4" | "dataforseo";

// The pages whose data needs an outside account the HUB does not hold yet (2026-11-02, user): the sidebar marks them
// with a key instead of the "not implemented" mark, and the page shows its screen on sample data under a veil naming
// the account (renewal/_components/account-gate.tsx). Delete a row when its account is handed over.
export const ACCOUNT_PAGES: Readonly<Record<string, RnAccount>> = {
  "/standard/ai-funnel/conversion": "ga4",
  "/website/ai-funnel/conversion": "ga4",
  "/admin/keyword-tools": "dataforseo",
};
