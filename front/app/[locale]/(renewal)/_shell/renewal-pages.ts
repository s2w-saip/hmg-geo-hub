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
  "/admin",
  "/admin/standards/prompts",
  "/admin/standards/citation-sources",
  "/admin/ga4",
]);
