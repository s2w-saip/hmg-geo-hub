// Entity versioning (E7): values shared by the server adapter (lib/hgh/adapters/admin-entities.ts,
// server-only) and the client components. Only constants and pure functions live here; the
// adapter owns every backend call.

export type EcatRole = "own" | "competitor" | "hidden" | "removed";
export const ECAT_ROLES: readonly EcatRole[] = ["own", "competitor", "hidden", "removed"];

export const OWN_BRANDS = ["Hyundai", "Kia", "Genesis"] as const;
export type OwnBrand = (typeof OWN_BRANDS)[number];

/** Apply statuses the loader is still working on (the apply page keeps polling). */
export function isApplyBusy(d: {
  status: string;
  hasPreview: boolean;
  errorCode: string | null;
  queue?: readonly { status: string }[];
}): boolean {
  // An open queue request means the loader still has work for this apply, whatever the error says (an abandon in
  // progress keeps failed + ECAT_APPLY_ABANDONING; a draft request edited before its preview carries ECAT_PREVIEW_STALE).
  if (d.queue?.some((q) => q.status === "pending" || q.status === "running")) return true;
  if (d.errorCode) return false;
  if (d.status === "running" || d.status === "approved") return true;
  if (d.status === "draft") return !d.hasPreview;
  return false;
}

/** Poll interval of the apply page (ms) and its ceiling (the page stops and offers a reload). */
export const APPLY_POLL_MS = 3000;
export const APPLY_POLL_MAX = 200;
