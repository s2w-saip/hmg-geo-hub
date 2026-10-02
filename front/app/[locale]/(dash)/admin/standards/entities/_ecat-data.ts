import "server-only";

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import { isAdminApi } from "@/lib/hgh/adapters/admin";
import * as ecat from "@/lib/hgh/adapters/admin-entities";
import { isHghApiError, throwForPage } from "@/lib/hgh/errors";

// Server-side gate and helpers shared by the entity management pages (E7).
//   legacy      HGH_SOURCE_G7 = legacy: no versions; the old catalog screen stays.
//   precutover  api source but no active version yet (v1 not migrated, T0 before) or the
//               versions endpoint is not deployed (404): the old catalog screen stays.
//   ready       versions exist: the version screens are shown.
//   unavailable the versions read failed otherwise (5xx, timeout): the pages show a notice
//               instead of the old role editor, whose PUT is refused after the cutover.

export type EcatGate =
  | { kind: "legacy" }
  | { kind: "precutover" }
  | { kind: "unavailable" }
  | { kind: "ready"; versions: ecat.VersionsView };

export async function requireAdminPage(locale: string): Promise<void> {
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  if (!canAccessAdmin(session.user)) redirect(`/${locale}/dashboard`);
}

export async function ecatGate(locale: string): Promise<EcatGate> {
  if (!isAdminApi()) return { kind: "legacy" };
  try {
    const versions = await ecat.listVersions();
    return versions.activeVer == null ? { kind: "precutover" } : { kind: "ready", versions };
  } catch (e) {
    if (isHghApiError(e) && e.status === 404) return { kind: "precutover" };
    if (isHghApiError(e) && e.status >= 500) {
      console.warn(`[ecat] versions read failed (${e.status} ${e.code})`);
      return { kind: "unavailable" };
    }
    throwForPage(e, locale);
  }
}

/** entity id -> display name from version details and diff rows (merge targets, change list). */
export function namesOf(details: (ecat.VersionDetailView | null)[], diffs: (ecat.VersionDiffView | null)[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of details) {
    for (const e of d?.entities ?? []) {
      const n = e.name ?? e.repName;
      if (n) out[e.entityId] = n;
    }
  }
  for (const d of diffs) {
    for (const e of d?.entities ?? []) {
      const n = (e.after?.name ?? e.before?.name) as string | null | undefined;
      if (n && !out[e.entityId]) out[e.entityId] = n;
    }
  }
  return out;
}

/** Number of draft changes against the active version: changed override rows + switched surfaces. */
export function draftChangeCount(rows: ecat.ManagedEntityRow[], active: ecat.VersionDetailView | null, draft: ecat.VersionDetailView | null): number {
  if (!draft) return 0;
  const surf = (d: ecat.VersionDetailView | null) => new Map((d?.surfaces ?? []).map((s) => [s.surfaceId, s.action]));
  const a = surf(active);
  const b = surf(draft);
  let n = rows.filter((r) => r.draftChanged).length;
  for (const id of new Set([...a.keys(), ...b.keys()])) if (a.get(id) !== b.get(id)) n += 1;
  return n;
}
