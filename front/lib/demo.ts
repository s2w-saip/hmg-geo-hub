// Capture-only projects and their fixed synthetic identifiers have been removed.
export const DEMO_PROJECT_ID = "";
export const DEMO_SCOPE_PROJECT_ID = "";
export function isDemoProject(_projectId: string | null | undefined): boolean { return false; }
