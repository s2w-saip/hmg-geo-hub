// In-memory pager for the fake sample matrix.
//
// The live context map is paged by Postgres (scope-context-map.ts). The demo
// routes (/customer-interest/social-scraping, /admin/standards/customer-interest)
// run on the static fixture in sample-data.ts and have no DB behind them.
//
// Rather than give ContextMapView two code paths — "paged props for live, whole
// matrix for sample" — both sources speak the same paged interface and this
// module is the sample-side implementation. Same split as lib/scope's
// MockScopeClient vs HttpScopeClient: the view does not know which it has.
//
// Client-safe on purpose (no "server-only"): the sample matrix is handed to the
// client and paged there, because there is no endpoint to page it against.

import type {
  CombinationListRow,
  ConditionListRow,
  ContextListRow,
  ContextMapQuery,
  ContextMapStats,
  ContextMatrix,
  ContextEntityDetail,
  Paged,
} from "@/components/social-scraping/types";

const DIMENSION_THEME_FALLBACK = "기타";

function match(name: string, search?: string): boolean {
  const q = search?.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q);
}

function paginate<T>(rows: T[], page: number, size: number): Paged<T> {
  const s = Math.max(size, 1);
  const p = Math.max(page, 0);
  return { rows: rows.slice(p * s, p * s + s), total: rows.length, page: p, size: s };
}

function cmp(a: string | number, b: string | number, dir: "asc" | "desc"): number {
  const sign = dir === "asc" ? 1 : -1;
  if (typeof a === "string" && typeof b === "string") return sign * a.localeCompare(b);
  return sign * ((a as number) - (b as number));
}

export function sampleStats(matrix: ContextMatrix): ContextMapStats {
  // The fixture carries only the summed `relationships`; split it the same way
  // the live corpus is split so the header tooltip has parts to name.
  const combinations = matrix.combinations.length;
  const drives = Math.max(matrix.stats.relationships - combinations, 0);
  return {
    contexts: matrix.stats.contexts,
    conditions: matrix.stats.conditions,
    relationships: matrix.stats.relationships,
    drives,
    combinations,
    sources: matrix.stats.sources,
  };
}

export function pageSampleContexts(
  matrix: ContextMatrix,
  q: ContextMapQuery<"name" | "mentions">,
): Paged<ContextListRow> {
  const themeName = new Map(matrix.themes.map((t) => [t.id, t.name] as const));
  // Mirrors the live query's correlated COUNT over drives.
  const linked = new Map<string, number>();
  for (const d of matrix.drives) linked.set(d.contextId, (linked.get(d.contextId) ?? 0) + 1);
  const rows: ContextListRow[] = matrix.contexts
    .filter((c) => match(c.name, q.search))
    .map((c) => ({
      id: c.id,
      name: c.name,
      themeId: c.themeId,
      themeName: themeName.get(c.themeId) ?? DIMENSION_THEME_FALLBACK,
      mentionCount: c.mentionCount,
      perspective: c.perspective,
      linkedCount: linked.get(c.id) ?? 0,
    }))
    .sort((a, b) =>
      q.sort === "name" ? cmp(a.name, b.name, q.dir) : cmp(a.mentionCount, b.mentionCount, q.dir),
    );
  return paginate(rows, q.page, q.size);
}

export function pageSampleConditions(
  matrix: ContextMatrix,
  q: ContextMapQuery<"name" | "mentions">,
): Paged<ConditionListRow> {
  const linked = new Map<string, number>();
  for (const d of matrix.drives) linked.set(d.conditionId, (linked.get(d.conditionId) ?? 0) + 1);
  const rows: ConditionListRow[] = matrix.conditions
    .filter((c) => match(c.name, q.search))
    .map((c) => ({
      id: c.id,
      name: c.name,
      categoryId: c.categoryId,
      mentionCount: c.mentionCount,
      perspective: c.perspective,
      linkedCount: linked.get(c.id) ?? 0,
    }))
    .sort((a, b) =>
      q.sort === "name" ? cmp(a.name, b.name, q.dir) : cmp(a.mentionCount, b.mentionCount, q.dir),
    );
  return paginate(rows, q.page, q.size);
}

export function pageSampleCombinations(
  matrix: ContextMatrix,
  q: ContextMapQuery<"cooccurrence">,
): Paged<CombinationListRow> {
  const nameById = new Map(
    [...matrix.contexts, ...matrix.conditions].map((e) => [e.id, e.name] as const),
  );
  const rows: CombinationListRow[] = matrix.combinations
    .map((c) => {
      const [aId, bId] = c.conditionIds;
      return {
        id: c.id,
        condAId: aId,
        condAName: nameById.get(aId) ?? aId,
        condBId: bId,
        condBName: nameById.get(bId) ?? bId,
        coOccurrenceCount: c.coOccurrenceCount,
        frequency: c.frequency,
      };
    })
    // Search matches either side's name — mirrors the live query's OR over the
    // two joined entity names.
    .filter((r) => match(r.condAName, q.search) || match(r.condBName, q.search))
    .sort((a, b) => cmp(a.coOccurrenceCount, b.coOccurrenceCount, q.dir));
  return paginate(rows, q.page, q.size);
}

export function sampleEntityDetail(
  matrix: ContextMatrix,
  id: string,
): ContextEntityDetail | null {
  const context = matrix.contexts.find((c) => c.id === id);
  const condition = matrix.conditions.find((c) => c.id === id);
  const entity = context ?? condition;
  if (!entity) return null;

  const nameById = new Map(
    [...matrix.contexts, ...matrix.conditions].map((e) => [e.id, e.name] as const),
  );
  // A context links to the conditions it drives; a condition links back to the
  // contexts driving it — same relation, opposite direction, as the live query.
  const linked = context
    ? matrix.drives
        .filter((d) => d.contextId === id)
        .map((d) => ({
          id: d.conditionId,
          name: nameById.get(d.conditionId) ?? d.conditionId,
          strength: d.strength,
        }))
    : matrix.drives
        .filter((d) => d.conditionId === id)
        .map((d) => ({
          id: d.contextId,
          name: nameById.get(d.contextId) ?? d.contextId,
          strength: d.strength,
        }));

  return {
    id: entity.id,
    name: entity.name,
    mentionCount: entity.mentionCount,
    perspective: entity.perspective,
    evidenceQuotes: entity.evidenceQuotes,
    sourceDomains: entity.sourceDomains,
    linked,
  };
}
