import "server-only";
import { and, asc, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  scopeContextEntities,
  scopeContextDrives,
  scopeContextDomains,
} from "@/lib/db/schema";
import type {
  CombinationListRow,
  CombinationListSort,
  ConditionListRow,
  ConditionListSort,
  ContextEntityDetail,
  ContextListRow,
  ContextListSort,
  ContextMapExportData,
  ContextMapQuery,
  ContextMapStats,
  ContextSeedPool,
  EvidenceQuote,
  Paged,
  PerspectiveBreakdown,
  Strength,
} from "@/components/social-scraping/types";

// Reads the one-time scope_context_* mirror (see lib/db/schema.ts for the
// "why a mirror, not a live call" rationale).
//
// 2026-07-15 (openspec/changes/2026-07-15-add-context-map-query): this used to
// expose a single `getMatrix(keyword)` that returned the whole Top-350 bundle —
// contexts + conditions + combinations + every attached evidence/domain row —
// in one shot, memoized per keyword.
//
// That shape forced Top-N caps (150/200/500), because the full corpus measured
// 16s of DB time and a ~10MB RSC payload. But the caps treated the symptom: the
// cost was never the 4,136-row entity scan, it was the FAN-OUT. The old comment
// said so outright — "evidence rows are long text and dominated the wire time
// (3.9s of the 6.4s)".
//
// So the split here is: lists are page-sized and carry thin columns only;
// evidence/domains/links load per entity when a dialog opens. That removes the
// need for caps entirely — every one of the 4,136 rows is now reachable, and a
// page weighs LESS than the old capped bundle did.
//
// There is no write path — the mirror is immutable (migration 0027).

/** Hard ceiling on page size. The client sends this, so it must be clamped:
 *  size=100000 would reinstate the 10MB payload this change exists to remove. */
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;

/** Detail dialog shows a handful of quotes; evidence rows are long text. Now
 *  that detail is per-entity and lazy, this bounds ONE entity, not 350. */
const EVIDENCE_PER_ENTITY = 8;

const DIMENSION_THEME: Record<string, string> = {
  demographic: "인구통계",
  trait: "특성",
  lifestage: "생애주기",
  role: "역할",
  occasion: "상황·시즌",
  usecase: "사용 목적",
  emotional: "심리·감정",
};

// ConsumerRequirement has no built-in category in scope's ontology — this is
// a display-only heuristic bucketing over canonical_name keywords, not a real
// signal from the corpus. Falls back to "기타".
//
// Deliberately NOT exposed as a filter: filtering by this would filter by a
// regex, not by data (openspec proposal.md "범위 밖").
const CATEGORY_RULES: [string, RegExp][] = [
  ["가격·비용", /원|가격|비용|할인|가성비|예산|리스|할부/],
  ["연비·동력", /연비|하이브리드|전기|엔진|출력|마력|토크|배기량/],
  ["공간·적재", /공간|시트|트렁크|적재|좌석|열 |인승/],
  ["안전·내구성", /안전|사고|내구|고장|주행거리|상태/],
  ["옵션·편의", /옵션|편의|기능|어시스트|센서|카메라|내비/],
  ["디자인·외관", /디자인|외관|색상|컬러|스타일/],
];

function categorize(name: string): string {
  for (const [category, re] of CATEGORY_RULES) if (re.test(name)) return category;
  return "기타";
}

function sentimentPerspective(
  positive: number,
  negative: number,
  neutral: number,
): PerspectiveBreakdown {
  // Field names kept as buyer/seller/neutral (shared type with the fake demo
  // fixture); the mirror's signal is sentiment.
  const total = positive + negative + neutral;
  if (total === 0) return { buyer: 0, seller: 0, neutral: 100 };
  return {
    buyer: Math.round((positive / total) * 100),
    seller: Math.round((negative / total) * 100),
    neutral: Math.round((neutral / total) * 100),
  };
}

function bucketStrength(value: number, max: number): Strength {
  if (max <= 0) return "low";
  const ratio = value / max;
  if (ratio >= 0.66) return "high";
  if (ratio >= 0.33) return "medium";
  return "low";
}

/** Clamp client-supplied paging. page/size arrive over the wire.
 *  Exported for unit test — this is the guard that stops a client from asking
 *  for the whole corpus in one page and reinstating the 10MB payload. */
export function clampPaging(
  page: number,
  size: number,
): { page: number; size: number; offset: number } {
  const s = Math.min(Math.max(Math.trunc(size) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const p = Math.max(Math.trunc(page) || 0, 0);
  return { page: p, size: s, offset: p * s };
}

/** `%` and `_` are ILIKE wildcards — a user typing "50%" must not turn into a
 *  match-anything pattern. Escape before wrapping in %…%.
 *  Exported for unit test. */
export function likePattern(search: string): string {
  const escaped = search.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

export interface ScopeContextMapRepository {
  getStats(): Promise<ContextMapStats>;
  listContexts(q: ContextMapQuery<ContextListSort>): Promise<Paged<ContextListRow>>;
  listConditions(q: ContextMapQuery<ConditionListSort>): Promise<Paged<ConditionListRow>>;
  listCombinations(q: ContextMapQuery<CombinationListSort>): Promise<Paged<CombinationListRow>>;
  /** Evidence + domains + linked entities for ONE entity. Dialog-open only. */
  getEntityDetail(id: string): Promise<ContextEntityDetail | null>;
  /**
   * Whole-corpus rows for the "Excel 내보내기" button — the three list tabs, no
   * paging, thin columns only (no evidence / domains / links). This is the ONE
   * unpaged read in this module: an export is by definition "give me all of it",
   * and it stays cheap because it carries exactly the columns the tables show
   * (~9.9k rows, 3 round trips — no per-row fan-out).
   */
  listAllForExport(): Promise<ContextMapExportData>;
  /** Top-N signal pool for prompt generation — NOT the list surface. */
  getSeedPool(limits?: {
    contexts?: number;
    conditions?: number;
    combinations?: number;
  }): Promise<ContextSeedPool>;
  /**
   * Resolve user-selected entity ids to canonical rows (구성 flow). Ids arrive
   * from the client, so names/types are re-read here — the canonical name is
   * what feeds the LLM prompt and sourceLabel, and must not be client-supplied.
   * Unknown ids are simply absent from the result.
   */
  getEntitySeeds(
    ids: string[],
  ): Promise<Array<{ id: string; name: string; type: string; mentionCount: number }>>;
}

export const scopeContextMapRepository: ScopeContextMapRepository = {
  async getStats() {
    const rows = (await getDb().execute(sql`
      select
        (select count(*)::int from scope_context_entities where type = 'ConsumerContext') as contexts,
        (select count(*)::int from scope_context_entities where type = 'ConsumerRequirement') as conditions,
        (select count(*)::int from scope_context_drives) as drives,
        (select count(*)::int from scope_context_combinations) as combinations,
        (select count(distinct host)::int from scope_context_domains) as sources
    `)) as Array<{
      contexts: number;
      conditions: number;
      drives: number;
      combinations: number;
      sources: number;
    }>;
    const t = rows[0];
    return {
      contexts: t?.contexts ?? 0,
      conditions: t?.conditions ?? 0,
      relationships: (t?.drives ?? 0) + (t?.combinations ?? 0),
      drives: t?.drives ?? 0,
      combinations: t?.combinations ?? 0,
      sources: t?.sources ?? 0,
    };
  },

  async listContexts(q) {
    return listEntities(q, "ConsumerContext", (e) => ({
      id: e.id,
      name: e.canonicalName,
      themeId: e.dimension ?? "기타",
      themeName: DIMENSION_THEME[e.dimension ?? ""] ?? "기타",
      mentionCount: e.mentionCount,
      perspective: sentimentPerspective(
        e.sentimentPositive,
        e.sentimentNegative,
        e.sentimentNeutral,
      ),
      linkedCount: e.linkedCount,
    }));
  },

  async listConditions(q) {
    return listEntities(q, "ConsumerRequirement", (e) => ({
      id: e.id,
      name: e.canonicalName,
      categoryId: categorize(e.canonicalName),
      mentionCount: e.mentionCount,
      perspective: sentimentPerspective(
        e.sentimentPositive,
        e.sentimentNegative,
        e.sentimentNeutral,
      ),
      linkedCount: e.linkedCount,
    }));
  },

  async listCombinations(q) {
    const db = getDb();
    const { page, size, offset } = clampPaging(q.page, q.size);
    const search = q.search?.trim();

    // Condition names come from a JOIN. The old code resolved them from a Map
    // of all 200 loaded conditions — which silently depended on nothing being
    // paged. Once a page holds 50 conditions, that Map would miss most names.
    const a = sql`a`;
    const b = sql`b`;
    const searchClause = search
      ? sql`and (a.canonical_name ilike ${likePattern(search)} escape '\\'
              or b.canonical_name ilike ${likePattern(search)} escape '\\')`
      : sql``;
    const dir = q.dir === "asc" ? sql`asc` : sql`desc`;

    const [rows, countRows, maxRows] = await Promise.all([
      db.execute(sql`
        select c.cond_a, c.cond_b, c.co_count,
               ${a}.canonical_name as a_name, ${b}.canonical_name as b_name
        from scope_context_combinations c
        join scope_context_entities a on a.id = c.cond_a
        join scope_context_entities b on b.id = c.cond_b
        where true ${searchClause}
        order by c.co_count ${dir}
        limit ${size} offset ${offset}
      `) as Promise<
        Array<{
          cond_a: string;
          cond_b: string;
          co_count: number;
          a_name: string;
          b_name: string;
        }>
      >,
      db.execute(sql`
        select count(*)::int as n
        from scope_context_combinations c
        join scope_context_entities a on a.id = c.cond_a
        join scope_context_entities b on b.id = c.cond_b
        where true ${searchClause}
      `) as Promise<Array<{ n: number }>>,
      // Strength buckets are relative to the corpus max, not the page max —
      // otherwise "high" would mean something different on every page.
      db.execute(sql`
        select coalesce(max(co_count), 0)::int as m from scope_context_combinations
      `) as Promise<Array<{ m: number }>>,
    ]);

    const max = maxRows[0]?.m ?? 0;
    return {
      rows: rows.map((r) => ({
        id: `${r.cond_a}:${r.cond_b}`,
        condAId: r.cond_a,
        condAName: r.a_name,
        condBId: r.cond_b,
        condBName: r.b_name,
        coOccurrenceCount: r.co_count,
        frequency: bucketStrength(r.co_count, max),
      })),
      total: countRows[0]?.n ?? 0,
      page,
      size,
    };
  },

  async listAllForExport() {
    const [contexts, conditions, combinations] = await Promise.all([
      listAllEntities("ConsumerContext", (e) => ({
        id: e.id,
        name: e.canonicalName,
        themeId: e.dimension ?? "기타",
        themeName: DIMENSION_THEME[e.dimension ?? ""] ?? "기타",
        mentionCount: e.mentionCount,
        perspective: sentimentPerspective(
          e.sentimentPositive,
          e.sentimentNegative,
          e.sentimentNeutral,
        ),
        linkedCount: e.linkedCount,
      })),
      listAllEntities("ConsumerRequirement", (e) => ({
        id: e.id,
        name: e.canonicalName,
        categoryId: categorize(e.canonicalName),
        mentionCount: e.mentionCount,
        perspective: sentimentPerspective(
          e.sentimentPositive,
          e.sentimentNegative,
          e.sentimentNeutral,
        ),
        linkedCount: e.linkedCount,
      })),
      listAllCombinations(),
    ]);
    return { contexts, conditions, combinations };
  },

  async getEntityDetail(id) {
    const db = getDb();

    const entityRows = await db
      .select()
      .from(scopeContextEntities)
      .where(eq(scopeContextEntities.id, id))
      .limit(1);
    const entity = entityRows[0];
    if (!entity) return null;

    const isContext = entity.type === "ConsumerContext";

    const [evidenceRows, domainRows, linkRows] = await Promise.all([
      db.execute(sql`
        select quote, source_host, source_url, sentiment
        from scope_context_evidence
        where entity_id = ${id}
        order by id
        limit ${EVIDENCE_PER_ENTITY}
      `) as Promise<
        Array<{
          quote: string;
          source_host: string | null;
          source_url: string | null;
          sentiment: string | null;
        }>
      >,
      db
        .select()
        .from(scopeContextDomains)
        .where(eq(scopeContextDomains.entityId, id))
        .orderBy(desc(scopeContextDomains.n)),
      // A context drives conditions; a condition is driven by contexts. Same
      // table, opposite column — both directions are indexed (0027).
      isContext
        ? (db.execute(sql`
            select d.requirement_id as id, e.canonical_name as name, d.co_count
            from scope_context_drives d
            join scope_context_entities e on e.id = d.requirement_id
            where d.context_id = ${id}
            order by d.co_count desc
          `) as Promise<Array<{ id: string; name: string; co_count: number }>>)
        : (db.execute(sql`
            select d.context_id as id, e.canonical_name as name, d.co_count
            from scope_context_drives d
            join scope_context_entities e on e.id = d.context_id
            where d.requirement_id = ${id}
            order by d.co_count desc
          `) as Promise<Array<{ id: string; name: string; co_count: number }>>),
    ]);

    const evidenceQuotes: EvidenceQuote[] = evidenceRows.map((r) => ({
      quote: r.quote,
      sourceTitle: r.source_host ?? "",
      sourceUrl: r.source_url ?? "",
      perspective:
        r.sentiment === "positive" ? "buyer" : r.sentiment === "negative" ? "seller" : "neutral",
    }));

    const sourceDomains: Record<string, number> = {};
    for (const row of domainRows) sourceDomains[row.host] = row.n;

    const maxLink = Math.max(1, ...linkRows.map((l) => l.co_count));
    return {
      id: entity.id,
      name: entity.canonicalName,
      mentionCount: entity.mentionCount,
      perspective: sentimentPerspective(
        entity.sentimentPositive,
        entity.sentimentNegative,
        entity.sentimentNeutral,
      ),
      evidenceQuotes,
      sourceDomains,
      linked: linkRows.map((l) => ({
        id: l.id,
        name: l.name,
        strength: bucketStrength(l.co_count, maxLink),
      })),
    };
  },

  async getSeedPool(limits) {
    const db = getDb();
    // Defaults preserve the pool the old getMatrix() handed to prompt
    // generation, so this refactor does not change what gets generated.
    // Whether the pool SHOULD reach further into the tail is an open product
    // question (openspec design.md D2 / tasks 0.1) — widening it moves the
    // "더 생성" exhaustion point and the OpenRouter cost, so it is not done here.
    const nContexts = limits?.contexts ?? 150;
    const nConditions = limits?.conditions ?? 200;
    const nCombinations = limits?.combinations ?? 500;

    const [contextRows, conditionRows] = await Promise.all([
      db
        .select({
          id: scopeContextEntities.id,
          name: scopeContextEntities.canonicalName,
          mentionCount: scopeContextEntities.mentionCount,
        })
        .from(scopeContextEntities)
        .where(eq(scopeContextEntities.type, "ConsumerContext"))
        .orderBy(desc(scopeContextEntities.mentionCount))
        .limit(nContexts),
      db
        .select({
          id: scopeContextEntities.id,
          name: scopeContextEntities.canonicalName,
          mentionCount: scopeContextEntities.mentionCount,
        })
        .from(scopeContextEntities)
        .where(eq(scopeContextEntities.type, "ConsumerRequirement"))
        .orderBy(desc(scopeContextEntities.mentionCount))
        .limit(nConditions),
    ]);

    const contextIds = contextRows.map((c) => c.id);
    const conditionIds = conditionRows.map((c) => c.id);

    const [combinationRows, driveRows] = await Promise.all([
      conditionIds.length
        ? (db.execute(sql`
            select c.cond_a, c.cond_b, c.co_count,
                   a.canonical_name as a_name, b.canonical_name as b_name
            from scope_context_combinations c
            join scope_context_entities a on a.id = c.cond_a
            join scope_context_entities b on b.id = c.cond_b
            where c.cond_a = any(${sql.param(conditionIds)})
              and c.cond_b = any(${sql.param(conditionIds)})
            order by c.co_count desc
            limit ${nCombinations}
          `) as Promise<
            Array<{
              cond_a: string;
              cond_b: string;
              co_count: number;
              a_name: string;
              b_name: string;
            }>
          >)
        : Promise.resolve([]),
      contextIds.length && conditionIds.length
        ? db
            .select()
            .from(scopeContextDrives)
            .where(
              and(
                inArray(scopeContextDrives.contextId, contextIds),
                inArray(scopeContextDrives.requirementId, conditionIds),
              ),
            )
        : Promise.resolve([]),
    ]);

    const nameById = new Map(
      [...contextRows, ...conditionRows].map((e) => [e.id, e.name] as const),
    );
    const maxDrive = Math.max(1, ...driveRows.map((d) => d.coCount));

    return {
      contexts: contextRows,
      conditions: conditionRows,
      combinations: combinationRows.map((c) => ({
        condAId: c.cond_a,
        condAName: c.a_name,
        condBId: c.cond_b,
        condBName: c.b_name,
        coCount: c.co_count,
      })),
      drives: driveRows.map((d) => ({
        contextId: d.contextId,
        contextName: nameById.get(d.contextId) ?? d.contextId,
        conditionId: d.requirementId,
        conditionName: nameById.get(d.requirementId) ?? d.requirementId,
        strength: bucketStrength(d.coCount, maxDrive),
      })),
    };
  },

  async getEntitySeeds(ids) {
    if (ids.length === 0) return [];
    return getDb()
      .select({
        id: scopeContextEntities.id,
        name: scopeContextEntities.canonicalName,
        type: scopeContextEntities.type,
        mentionCount: scopeContextEntities.mentionCount,
      })
      .from(scopeContextEntities)
      .where(inArray(scopeContextEntities.id, ids));
  },
};

type EntityRow = typeof scopeContextEntities.$inferSelect & { linkedCount: number };

// Shared list query for both entity types — same shape, different `type`, drives
// direction and row mapper.
//
// `linkedCount` is a correlated COUNT over scope_context_drives. The old code
// got this by counting a fully-loaded drives array; with a page in hand that
// array doesn't exist, so the count has to come from SQL. A context counts the
// conditions it drives (context_id side); a condition counts the contexts
// driving it (requirement_id side). Both are indexed (0027: PK on
// (context_id, requirement_id) + an index on requirement_id).
async function listEntities<R>(
  q: ContextMapQuery<"name" | "mentions">,
  type: "ConsumerContext" | "ConsumerRequirement",
  map: (e: EntityRow) => R,
): Promise<Paged<R>> {
  const db = getDb();
  const { page, size, offset } = clampPaging(q.page, q.size);
  const search = q.search?.trim();

  const where = search
    ? and(
        eq(scopeContextEntities.type, type),
        ilike(scopeContextEntities.canonicalName, likePattern(search)),
      )
    : eq(scopeContextEntities.type, type);

  const col =
    q.sort === "name" ? scopeContextEntities.canonicalName : scopeContextEntities.mentionCount;
  const orderBy = q.dir === "asc" ? asc(col) : desc(col);

  const linkedCount =
    type === "ConsumerContext"
      ? sql<number>`(select count(*)::int from scope_context_drives d where d.context_id = ${scopeContextEntities.id})`
      : sql<number>`(select count(*)::int from scope_context_drives d where d.requirement_id = ${scopeContextEntities.id})`;

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: scopeContextEntities.id,
        type: scopeContextEntities.type,
        canonicalName: scopeContextEntities.canonicalName,
        dimension: scopeContextEntities.dimension,
        mentionCount: scopeContextEntities.mentionCount,
        utteranceCount: scopeContextEntities.utteranceCount,
        sentimentPositive: scopeContextEntities.sentimentPositive,
        sentimentNegative: scopeContextEntities.sentimentNegative,
        sentimentNeutral: scopeContextEntities.sentimentNeutral,
        linkedCount,
      })
      .from(scopeContextEntities)
      .where(where)
      .orderBy(orderBy)
      .limit(size)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(scopeContextEntities)
      .where(where),
  ]);

  return { rows: rows.map((r) => map(r as EntityRow)), total: countRows[0]?.n ?? 0, page, size };
}


/** Unpaged sibling of listEntities — export only. Same columns, same
 *  correlated linkedCount, ordered the way the table opens (mentions desc). */
async function listAllEntities<R>(
  type: "ConsumerContext" | "ConsumerRequirement",
  map: (e: EntityRow) => R,
): Promise<R[]> {
  const linkedCount =
    type === "ConsumerContext"
      ? sql<number>`(select count(*)::int from scope_context_drives d where d.context_id = ${scopeContextEntities.id})`
      : sql<number>`(select count(*)::int from scope_context_drives d where d.requirement_id = ${scopeContextEntities.id})`;

  const rows = await getDb()
    .select({
      id: scopeContextEntities.id,
      type: scopeContextEntities.type,
      canonicalName: scopeContextEntities.canonicalName,
      dimension: scopeContextEntities.dimension,
      mentionCount: scopeContextEntities.mentionCount,
      utteranceCount: scopeContextEntities.utteranceCount,
      sentimentPositive: scopeContextEntities.sentimentPositive,
      sentimentNegative: scopeContextEntities.sentimentNegative,
      sentimentNeutral: scopeContextEntities.sentimentNeutral,
      linkedCount,
    })
    .from(scopeContextEntities)
    .where(eq(scopeContextEntities.type, type))
    .orderBy(desc(scopeContextEntities.mentionCount));

  return rows.map((r) => map(r as EntityRow));
}

/** Unpaged sibling of listCombinations — export only. Strength buckets stay
 *  relative to the corpus max, exactly as the table shows them. */
async function listAllCombinations(): Promise<CombinationListRow[]> {
  const db = getDb();
  const [rows, maxRows] = await Promise.all([
    db.execute(sql`
      select c.cond_a, c.cond_b, c.co_count,
             a.canonical_name as a_name, b.canonical_name as b_name
      from scope_context_combinations c
      join scope_context_entities a on a.id = c.cond_a
      join scope_context_entities b on b.id = c.cond_b
      order by c.co_count desc
    `) as Promise<
      Array<{
        cond_a: string;
        cond_b: string;
        co_count: number;
        a_name: string;
        b_name: string;
      }>
    >,
    db.execute(sql`
      select coalesce(max(co_count), 0)::int as m from scope_context_combinations
    `) as Promise<Array<{ m: number }>>,
  ]);

  const max = maxRows[0]?.m ?? 0;
  return rows.map((r) => ({
    id: `${r.cond_a}:${r.cond_b}`,
    condAId: r.cond_a,
    condAName: r.a_name,
    condBId: r.cond_b,
    condBName: r.b_name,
    coOccurrenceCount: r.co_count,
    frequency: bucketStrength(r.co_count, max),
  }));
}
