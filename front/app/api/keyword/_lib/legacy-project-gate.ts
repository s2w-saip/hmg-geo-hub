import "server-only";
import { cachedMembership, cachedProjectById } from "@/lib/db/repositories/request-cache";
import type { LegacyProjectAllowed } from "@/lib/hgh/adapters/intent";

/**
 * The legacy leaf page gate of the project intent pages, injected into keywordRouteGate by
 * /api/keyword/{insight,related,search}: the project exists and the viewer is admin or an ACTIVE
 * member (pending / removed members and non-members -> false). Read through the unchanged
 * request-scoped repositories. It lives here, not in lib/hgh/adapters/intent.ts, because lib/hgh
 * never loads lib/db at runtime (front-ci "금지 import 가드"), the same split as the drilldown
 * and citation routes' legacyProjectAllowed.
 */
export const legacyKeywordProjectAllowed: LegacyProjectAllowed = async (projectId, user) => {
  const [project, membership] = await Promise.all([cachedProjectById(projectId), cachedMembership(projectId, user.id)]);
  if (!project) return false;
  return user.role === "admin" || membership?.status === "active";
};
