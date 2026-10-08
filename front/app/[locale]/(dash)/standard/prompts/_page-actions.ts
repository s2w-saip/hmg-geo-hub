"use server";

import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { readCatalogPage } from "@/lib/db/repositories/catalog-page";
import { isAnalysisApi } from "@/lib/hgh/adapters/filters";
import { isAdminApi } from "@/lib/hgh/adapters/admin";
import { hghPost } from "@/lib/hgh/client";
import { catalogPageQuery, type CatalogPageQuery, type CatalogPage } from "@/lib/standards/catalog-page";
import type { PromptType } from "@/lib/db/repositories/prompts";

export async function loadCatalogPage(admin: boolean, input: CatalogPageQuery): Promise<CatalogPage> {
  const session = await getSession();
  const path = admin ? "/admin/standards/prompts" : "/standard/prompts";
  if (!session || !canAccessRoute(session.user.role, path, session.user.menuGroups)) throw new UnauthorizedError();
  const query = catalogPageQuery(input);
  if (!(admin ? isAdminApi() : isAnalysisApi("prompts", "global"))) return readCatalogPage(session.user.scope, query, admin);
  const defaults = { listType: "all", depth1: "all", depth2: "all", depth3: "all", depth4: "all", funnel: "all", presence: "all", kind: "all", market: "all", lang: "all", status: "all" };
  const body = { ...query, filters: { ...defaults, ...query.filters, view: query.filters.view === "deleted" ? "deleted" as const : "active" as const },
    draft: { ...defaults, ...query.draft, view: "active" as const } };
  const response = admin
    ? await hghPost("/v1/admin/catalog/prompts/screen", { body })
    : await hghPost("/v1/prompts/screen", { body });
  const page = response.data;
  return { ...page, rows: page.rows.map(row => ({ ...row, promptType: row.promptType as PromptType | null,
    deletedAt: row.deletedAt ? new Date(row.deletedAt) : null })),
    stats: page.stats ? { total: page.stats.total, tracked: page.stats.tracked, untracked: page.stats.untracked, acr: page.stats.acr, deleted: page.stats.deleted, scopeOrphans: page.stats.scope_orphans } : null };
}
