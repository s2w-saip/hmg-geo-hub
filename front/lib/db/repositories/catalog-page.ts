import "server-only";
import { and, asc, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { prompts, scopePrompts } from "@/lib/db/schema";
import type { AllowedScope } from "@/lib/auth/types";
import { UnauthorizedError } from "@/lib/auth/errors";
import { effectiveScopeCountries } from "@/lib/rhq";
import { UMBRELLA_BRAND } from "@/lib/scope/brand-presence";
import { EXCLUDED_STANDARD_PROMPT_IDS, EXCLUDED_STANDARD_PROMPT_TEXTS } from "@/lib/scope/standard-prompt-exclusions";
import { catalogPageQuery, type CatalogPage, type CatalogPageQuery } from "@/lib/standards/catalog-page";
import { normalizeMarket } from "@/lib/standards/prompt-markets";
import { catalogMarketScopeCondition, STANDARD_ROOT_PROJECT_ID, type StandardCatalogRow } from "./standards";

const axes = { listType: prompts.listType, depth1: prompts.depth1, depth2: prompts.depth2, depth3: prompts.depth3, depth4: prompts.depth4,
  funnel: prompts.funnelStage, kind: prompts.kind, lang: prompts.lang };
const selection = { id: prompts.id, text: prompts.text, promptType: prompts.promptType, category: prompts.category, brand: prompts.brand,
  brandPresence: prompts.brandPresence, listType: prompts.listType, depth1: prompts.depth1, depth2: prompts.depth2, depth3: prompts.depth3,
  depth4: prompts.depth4, funnelStage: prompts.funnelStage, kind: prompts.kind, lang: prompts.lang, regions: prompts.regions,
  scopePromptId: prompts.scopePromptId, scopeText: scopePrompts.text, deletedAt: prompts.deletedAt };
const normalizedMarket = sql`CASE WHEN lower(btrim(m)) LIKE 'x:%' THEN 'x:' || upper(substr(btrim(m), 3)) ELSE upper(btrim(m)) END`;
const markets = sql`ARRAY(SELECT DISTINCT ${normalizedMarket} FROM unnest(${prompts.regions}) m WHERE btrim(m) <> '' ORDER BY 1)`;
const presence = sql`coalesce(${prompts.brandPresence}, CASE WHEN ${prompts.brand} = ${UMBRELLA_BRAND} THEN 'unbranded' WHEN ${prompts.brand} IS NOT NULL THEN 'branded' END)`;
const present = (value: string | undefined) => value && value !== "all";

export async function readCatalogPage(scope: AllowedScope | null | undefined, input: CatalogPageQuery, admin = false): Promise<CatalogPage> {
  if (!scope) throw new UnauthorizedError();
  const q = catalogPageQuery(input);
  const db = getDb();
  const base: SQL[] = [eq(prompts.projectId, STANDARD_ROOT_PROJECT_ID)];
  if (!admin) {
    base.push(isNull(prompts.deletedAt));
    if (!scope.all && scope.brands?.length) base.push(or(inArray(prompts.brand, scope.brands), isNull(prompts.brand), eq(prompts.brand, UMBRELLA_BRAND))!);
    const allowed = effectiveScopeCountries(scope);
    if (allowed?.length) {
      const marketScope = catalogMarketScopeCondition(allowed);
      if (marketScope) base.push(marketScope);
    }
    if (EXCLUDED_STANDARD_PROMPT_IDS.length) base.push(notInArray(prompts.id, [...EXCLUDED_STANDARD_PROMPT_IDS]));
    if (EXCLUDED_STANDARD_PROMPT_TEXTS.length) base.push(sql`btrim(${prompts.text}) NOT IN (${sql.join(EXCLUDED_STANDARD_PROMPT_TEXTS.map(t => sql`${t.trim()}`), sql`, `)})`);
  }
  const where = [...base];
  if (admin) where.push(q.filters.view === "deleted" ? sql`${prompts.deletedAt} IS NOT NULL` : isNull(prompts.deletedAt));
  for (const [key, column] of Object.entries(axes)) {
    const value = q.filters[key as keyof typeof axes];
    if (present(value)) where.push(eq(column, value!));
  }
  if (present(q.filters.presence)) where.push(sql`${presence} = ${q.filters.presence}`);
  if (["measured", "tracked"].includes(q.filters.status ?? "")) where.push(sql`${prompts.scopePromptId} IS NOT NULL`);
  if (["unmeasured", "untracked"].includes(q.filters.status ?? "")) where.push(isNull(prompts.scopePromptId));
  if (present(q.filters.market)) where.push(sql`${normalizeMarket(q.filters.market!)} = ANY(${markets})`);
  if (q.search.trim()) where.push(sql`strpos(lower(${prompts.text}), ${q.search.trim().toLowerCase()}) > 0`);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(prompts).where(and(...where));
  const offset = Math.min(q.offset, Math.max(0, Math.floor((total - 1) / q.limit) * q.limit));
  const facetSelect: Record<string, SQL> = { count: sql`count(*)::int` };
  const parents: SQL[] = [];
  for (const key of ["listType", "depth1", "depth2", "depth3", "depth4", "funnel", "lang"] as const) {
    const column = axes[key];
    const constraint = key.startsWith("depth") && parents.length ? sql`AND ${and(...parents)}` : sql``;
    facetSelect[key] = sql`array_agg(DISTINCT ${column}) FILTER (WHERE ${column} IS NOT NULL AND ${column} <> '' ${constraint})`;
    if (["listType", "depth1", "depth2", "depth3"].includes(key) && present(q.draft[key])) parents.push(eq(column, q.draft[key]!));
    if (key === "listType" || key.startsWith("depth")) facetSelect[`has_${key}`] = sql`bool_or(${column} IS NOT NULL AND ${column} <> '')`;
  }
  const [meta] = await db.select(facetSelect).from(prompts).where(and(...base));
  const marketRows = await db.select({ values: sql<string[]>`ARRAY(SELECT DISTINCT ${normalizedMarket} FROM ${prompts} CROSS JOIN LATERAL unnest(${prompts.regions}) m WHERE ${and(...base)} AND btrim(m) <> '')` }).from(prompts).limit(1);
  const allMarkets = new Set(marketRows.flatMap(r => r.values ?? []));
  const facets: Record<string, string[]> = {};
  for (const key of ["listType", "depth1", "depth2", "depth3", "depth4", "funnel", "lang"]) facets[key] = ((meta[key] ?? []) as string[]).sort();
  facets.market = [...allMarkets].filter(c => !c.startsWith("x:")).sort().concat([...allMarkets].filter(c => ["x:WW", "x:EU", "x:ME"].includes(c)).sort());
  facets.marketSort = [...allMarkets].sort();
  const columns = Object.keys(meta).filter(k => k.startsWith("has_") && meta[k]).map(k => k.slice(4));
  const sorters: Record<string, SQL> = Object.fromEntries(Object.entries(axes).map(([key, column]) => [key, sql`coalesce(${column}, '~')`]));
  Object.assign(sorters, { text: sql`${prompts.text}`, brand: sql`coalesce(${prompts.brand}, '')`, presence: sql`coalesce(${presence}, '~')`,
    kind: sql`CASE WHEN ${prompts.kind} = 'acr' THEN 1 ELSE 0 END`, status: sql`(${prompts.scopePromptId} IS NOT NULL)`, tracked: sql`(${prompts.scopePromptId} IS NOT NULL)` });
  if (q.sort === "market") {
    const first = sql`(SELECT code FROM unnest(${markets}) code ORDER BY (code LIKE 'x:%'), code LIMIT 1)`;
    sorters.market = sql`coalesce(${JSON.stringify(q.market_labels)}::jsonb ->> ${first}, ${first}, '~')`;
  }
  const collation = q.collation === "ko" ? sql`COLLATE "ko-x-icu"` : sql`COLLATE "en-x-icu"`;
  const numeric = ["kind", "status", "tracked"].includes(q.sort);
  const order = sql`${sorters[q.sort]} ${numeric ? sql`` : collation} ${q.asc ? sql`ASC` : sql`DESC`}`;
  const rows = await db.select(selection).from(prompts).leftJoin(scopePrompts, eq(prompts.scopePromptId, scopePrompts.promptId))
    .where(and(...where)).orderBy(order, asc(prompts.depth1), asc(prompts.depth2), asc(prompts.depth3), asc(prompts.text), asc(prompts.id)).limit(q.limit).offset(offset);
  let stats: CatalogPage["stats"] = null;
  if (admin) {
    const [s] = await db.select({ total: sql<number>`count(*) FILTER (WHERE ${prompts.deletedAt} IS NULL)::int`,
      tracked: sql<number>`count(*) FILTER (WHERE ${prompts.deletedAt} IS NULL AND ${prompts.scopePromptId} IS NOT NULL)::int`,
      acr: sql<number>`count(*) FILTER (WHERE ${prompts.deletedAt} IS NULL AND ${prompts.kind} = 'acr')::int`,
      deleted: sql<number>`count(*) FILTER (WHERE ${prompts.deletedAt} IS NOT NULL)::int` }).from(prompts).where(and(...base));
    const [o] = await db.select({ count: sql<number>`count(*)::int` }).from(scopePrompts).leftJoin(prompts, eq(prompts.scopePromptId, scopePrompts.promptId)).where(isNull(prompts.id));
    stats = { ...s, untracked: s.total - s.tracked, scopeOrphans: o.count };
  }
  return { rows: rows as StandardCatalogRow[], total, count: Number(meta.count), offset, limit: q.limit, facets, columns, stats };
}
