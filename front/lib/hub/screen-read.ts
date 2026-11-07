import { canAccessRoute } from "@/lib/auth/route-policy";
import { HghApiError } from "@/lib/hgh/errors";
import { searchParamsToRecord } from "@/lib/search-params";
import type { HubUser } from "./client";
import type { ScreenQuery } from "@/lib/screen";

// Browser reads needed by the standalone renewal client. Every value is still computed by the data server.
const names = new Set([
  ...["filters", "as-of", "cards", "card-trend", "brand-matrix", "geo"].map(n => `overview/${n}`),
  ...["summary", "summary-deferred", "engines", "trend", "composition", "brands", "geo", "prompts-page", "prompts-insights", "prompts-options"].map(n => `website/${n}`),
  ...["rn-page", "rn-asof", "rn-shell", "rn-compare", "rn-rate-value", "rn-rate-hero", "rn-rate-engines", "rn-rate-types", "rn-favor-hero", "rn-favor-dist", "rn-favor-matrix", "rn-rank", "rn-bump", "rn-ranking", "rn-engine-extra", "rn-presence-split", "rn-tab-value", "rn-summary", "rn-tab-deltas", "view-cards", "rn-markets", "view-weekly", "view-compare"].map(n => `mention/${n}`),
  ...["standard", "website", "project", "filter-bar", "as-of", "renewal-header", "prompts", "tone-urls"].map(n => `citation/${n}`),
  ...["list", "filters", "as-of", "settings", "prompts", "dash-summary", "dash-summary-deferred", "dash-engines", "dash-trend", "dash-composition", "dash-status"].map(n => `projects/${n}`),
  "shared/service-week", "shared/panel-options", "shared/filter-dates", "catalog/prompts-page", "catalog/prompts-header", "catalog/prompts-history", "acr/renewal", "acr/renewal-header",
  "conversion/renewal", "conversion/renewal-header", "visibility/renewal", "visibility/renewal-header",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTEXT = new Set(["ctx.project_id", "ctx.locale", "ctx.view", "ctx.variant", "ctx.kpi", "ctx.family", "ctx.client_nav"]);

/** UI context is never an authority: validate the page and derive role/admin from the signed-in account. */
export function browserScreenQuery(name: string, params: URLSearchParams, user: HubUser): ScreenQuery {
  if (!names.has(name)) throw new HghApiError(404, "not_found");
  if (user.mustChangePassword) throw new HghApiError(403, "password_change_required");
  const requested = params.get("ctx.surface") ?? params.get("surface") ?? "global";
  if (!["global", "website", "project"].includes(requested)) throw new HghApiError(422, "invalid_surface");
  const surface = name.startsWith("website/") || name === "citation/website" ? "website"
    : name.startsWith("projects/") || name === "citation/project" ? "project"
    : name.startsWith("catalog/") || name.startsWith("acr/") || name === "citation/standard" ? "global" : requested;
  const id = params.get("ctx.project_id") ?? "";
  if (surface === "project" && name !== "projects/list" && !UUID.test(id)) throw new HghApiError(422, "invalid_project_id");
  const base = surface === "project" ? `/renewal/projects/${id}` : surface === "website" ? "/renewal/website" : "/renewal";
  const route = name === "projects/list" ? "/renewal/projects"
    : name.startsWith("mention/") ? `${base}/${surface === "project" ? "analysis" : surface === "website" ? "answer-analysis" : "standard/answer-analysis"}/mention`
    : name.startsWith("citation/") ? `${base}/${surface === "project" ? "analysis" : surface === "website" ? "answer-analysis" : "standard/answer-analysis"}/citation`
    : name.startsWith("acr/") ? "/renewal/standard/ai-funnel/acr"
    : name.startsWith("catalog/") ? "/renewal/standard/prompts"
    : name.startsWith("website/prompts-") ? "/renewal/website/prompts"
    : name === "projects/prompts" ? `${base}/prompt` : name === "projects/settings" ? `${base}/setting`
    : surface === "global" ? "/renewal/dashboard" : base;
  if (name !== "shared/service-week" && !canAccessRoute(user.role, route)) throw new HghApiError(403, "forbidden");
  const query: Record<string, string | readonly string[] | undefined> = {};
  for (const [key, value] of Object.entries(searchParamsToRecord(params))) {
    if (!key.startsWith("ctx.") || CONTEXT.has(key)) query[key] = value;
  }
  // Context values are scalars, even when a caller repeats a key. Filters remain repeatable.
  for (const key of CONTEXT) {
    const value = params.get(key);
    if (value !== null) query[key] = value;
  }
  query["ctx.surface"] = surface;
  query["ctx.role"] = user.role;
  query["ctx.admin"] = String(user.role === "admin");
  if (query["ctx.locale"] && !["ko", "en"].includes(String(query["ctx.locale"]))) throw new HghApiError(422, "invalid_locale");
  if (name.startsWith("citation/")) query["ctx.variant"] = "renewal";
  return query;
}
