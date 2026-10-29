// Fixed identifiers for the always-mock DEMO project used for manual/screenshot
// captures.
//
// The demo project is a real DB row (seeded by scripts/db/seed-demo.ts). Its
// dashboard / answer-analysis / ai-funnel screens are fed entirely by synthetic
// rows in the local scope_* MIRROR tables, and those aggregates are pure DB SQL
// (lib/db/repositories/scope-aggregates.ts) — so the demo renders identically
// regardless of SCOPE_MODE (live or mock). No project page calls the live scope
// client, so no real Hyundai Motor Group workspace data is ever involved.
//
// Access is admin-only, enforced once in the project layout (the demo shows
// fabricated numbers, so it must never look like a real customer project to a
// scoped account).
export const DEMO_PROJECT_ID = "de300000-0000-4000-8000-000000000001";

// The scope_runs.project_id every synthetic mirror row is tagged with. Also
// stored on the project row as scope_project_id so resolveScopeProjectId()
// wires the per-project mirror aggregates to these rows.
export const DEMO_SCOPE_PROJECT_ID = "de300000-0000-4000-8000-000000000002";

export function isDemoProject(projectId: string | null | undefined): boolean {
  return (
    projectId === DEMO_PROJECT_ID || projectId === DEMO_SCOPE_PROJECT_ID
  );
}
