"use server";

import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { readCatalogPage, readCatalogRows } from "@/lib/db/repositories/catalog-page";
import { isAnalysisApi } from "@/lib/hgh/adapters/filters";
import { isAdminApi } from "@/lib/hgh/adapters/admin";
import { hghPost } from "@/lib/hgh/client";
import { catalogPageQuery, type CatalogPageQuery, type CatalogPage, type CatalogRowsPage } from "@/lib/standards/catalog-page";
import type { PromptType } from "@/lib/db/repositories/prompts";

async function catalogRead(admin: boolean, input: CatalogPageQuery) {
  const session = await getSession();
  const path = admin ? "/admin/standards/prompts" : "/standard/prompts";
  if (!session || !canAccessRoute(session.user.role, path, session.user.menuGroups)) throw new UnauthorizedError();
  const query = catalogPageQuery(input);
  return { scope: session.user.scope, query, api: admin ? isAdminApi() : isAnalysisApi("prompts", "global") };
}

async function postScreen(admin: boolean, query: Required<CatalogPageQuery>, includeMeta: boolean) {
  const defaults = { listType: "all", depth1: "all", depth2: "all", depth3: "all", depth4: "all", funnel: "all", presence: "all", kind: "all", market: "all", lang: "all", status: "all" };
  const body = { ...query, include_meta: includeMeta, filters: { ...defaults, ...query.filters, view: query.filters.view === "deleted" ? "deleted" as const : "active" as const },
    draft: { ...defaults, ...query.draft, view: "active" as const } };
  const response = admin
    ? await hghPost("/v1/admin/catalog/prompts/screen", { body })
    : await hghPost("/v1/prompts/screen", { body });
  const page = response.data;
  return { ...page, rows: page.rows.map(row => ({ ...row, promptType: row.promptType as PromptType | null,
    deletedAt: row.deletedAt ? new Date(row.deletedAt) : null })) };
}

export async function loadCatalogPage(admin: boolean, input: CatalogPageQuery): Promise<CatalogPage> {
  const { scope, query, api } = await catalogRead(admin, input);
  if (!api) return readCatalogPage(scope, query, admin);
  const page = await postScreen(admin, query, true);
  if (page.count == null || !page.facets || !page.columns) throw new Error("Catalog screen response without scope metadata");
  return { ...page, count: page.count, facets: page.facets, columns: page.columns,
    stats: page.stats ? { total: page.stats.total, tracked: page.stats.tracked, untracked: page.stats.untracked, acr: page.stats.acr, deleted: page.stats.deleted, scopeOrphans: page.stats.scope_orphans } : null };
}

/** Rows and the filtered total only (include_meta=false): the list keeps the facets and stats it already has. */
export async function loadCatalogRows(admin: boolean, input: CatalogPageQuery): Promise<CatalogRowsPage> {
  const { scope, query, api } = await catalogRead(admin, input);
  if (!api) return readCatalogRows(scope, query, admin);
  const { rows, total, offset, limit } = await postScreen(admin, query, false);
  return { rows, total, offset, limit };
}
