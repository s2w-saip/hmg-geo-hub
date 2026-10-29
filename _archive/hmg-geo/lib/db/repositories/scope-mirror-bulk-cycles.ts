import "server-only";

import { sql, type SQL } from "drizzle-orm";
import type { ScopeMirrorProgressRow } from "@/lib/db/schema";
import type { BulkVisibility } from "@/lib/scope/mirror/bulk-run";
import { isOversizedRun, mirrorJobCapacity } from "@/lib/scope/mirror/sync";

export type BulkCycleExecutor = {
  execute(query: SQL): PromiseLike<unknown>;
};

type Executor = BulkCycleExecutor;

type Source = {
  measurement_run_id: string;
  project_id: string;
  cycle_anchor_at?: string | null;
  total_jobs: number;
};

type CycleRow = {
  cycle_id: string;
  project_id: string;
  cycle_anchor_at: string;
  hidden_reason: string | null;
  hidden_at: string | null;
  hidden_scope: string | null;
};

type Before = {
  hiddenReason: string | null;
  hiddenAt: string | null;
  hiddenScope: string | null;
};

type Owned = {
  hiddenReason: "operator";
  hiddenAt: string;
  hiddenAtDb: string;
  hiddenScope: "all";
};

export type BulkCycleVisibilityState = {
  version: 1;
  source: { runId: string; projectId: string; cycleAnchorAt: string | null };
  cycles: Array<{ cycleId: string; before: Before; owned: Owned | null }>;
};

type ProgressVisibilityRow = { run_id: string; state: unknown };

function resultRows<T>(value: unknown): T[] {
  return (value ?? []) as T[];
}

async function executeRows<T>(executor: Executor, query: ReturnType<typeof sql>): Promise<T[]> {
  return resultRows<T>(await executor.execute(query));
}

function sourceOf(row: ScopeMirrorProgressRow): Source {
  const source = row.state?.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("Bulk visibility source is missing");
  }
  const s = source as Partial<Source>;
  if (
    typeof s.measurement_run_id !== "string" ||
    typeof s.project_id !== "string" ||
    typeof s.total_jobs !== "number" ||
    !Number.isSafeInteger(s.total_jobs) ||
    s.total_jobs < 0
  ) {
    throw new Error("Bulk visibility source is invalid");
  }
  if (typeof s.cycle_anchor_at === "string") {
    const d = new Date(s.cycle_anchor_at);
    if (Number.isNaN(d.getTime())) throw new Error("Bulk visibility cycle anchor is invalid");
    s.cycle_anchor_at = d.toISOString();
  } else if (s.cycle_anchor_at !== undefined && s.cycle_anchor_at !== null) {
    throw new Error("Bulk visibility cycle anchor is invalid");
  }
  if (isOversizedRun(s.total_jobs) && !s.cycle_anchor_at) {
    throw new Error(
      `Bulk visibility requires cycle_anchor_at for oversized run (jobs=${s.total_jobs}, capacity=${mirrorJobCapacity()})`,
    );
  }
  return { ...s, cycle_anchor_at: s.cycle_anchor_at ?? null } as Source;
}

function normalizeCycle(row: CycleRow): CycleRow {
  if ((row.hidden_reason === null) !== (row.hidden_at === null)) {
    throw new Error(`summary cycle has an invalid hidden pair: ${row.cycle_id}`);
  }
  if (row.hidden_reason === null && row.hidden_scope !== null) {
    throw new Error(`summary cycle has a scope without a hidden reason: ${row.cycle_id}`);
  }
  return row;
}

function visibilityOf(value: unknown): BulkCycleVisibilityState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Partial<BulkCycleVisibilityState>;
  if (v.version !== 1 || !v.source || !Array.isArray(v.cycles)) return null;
  return v as BulkCycleVisibilityState;
}

function projectMatches(v: BulkCycleVisibilityState, source: Source): boolean {
  return v.source.projectId === source.project_id;
}

async function cycleRows(
  tx: Executor,
  row: ScopeMirrorProgressRow,
  source: Source,
): Promise<CycleRow[]> {
  const anchor = source.cycle_anchor_at;
  const ownedCycleIds = visibilityOf(row.state.visibility)?.cycles
    .filter((cycle) => cycle.owned !== null).map((cycle) => cycle.cycleId) ?? [];
  const query = sql`
      SELECT c.cycle_id::text AS cycle_id, c.project_id::text AS project_id,
             c.cycle_anchor_at::text AS cycle_anchor_at,
             c.hidden_reason, c.hidden_at::text AS hidden_at, c.hidden_scope
        FROM summary_cycles c
       WHERE c.project_id = ${source.project_id}::uuid
         AND (
           ${anchor ? sql`c.cycle_anchor_at = ${anchor}::timestamptz` : sql`FALSE`}
           OR c.cycle_id = ANY(${sql.param(ownedCycleIds)}::uuid[])
           OR EXISTS (
             SELECT 1
               FROM summary_cycle_runs cr
              WHERE cr.cycle_id = c.cycle_id
                AND cr.run_id = ${row.runId}::uuid
           )
         )
       FOR UPDATE OF c
    `;
  return (await executeRows<CycleRow>(tx, query)).map(normalizeCycle);
}

async function otherProgress(
  tx: Executor,
  row: ScopeMirrorProgressRow,
  source: Source,
  cycles: Array<Pick<CycleRow, "cycle_id">>,
): Promise<ProgressVisibilityRow[]> {
  const anchor = source.cycle_anchor_at;
  const cycleIds = cycles.map((c) => c.cycle_id);
  const sharedCycle = sql`
    (
      EXISTS (
        SELECT 1
          FROM summary_cycle_runs cr
         WHERE cr.run_id = p.run_id::uuid
           AND cr.cycle_id = ANY(${sql.param(cycleIds)}::uuid[])
      )
      OR EXISTS (
        SELECT 1
          FROM jsonb_array_elements(COALESCE(p.state->'visibility'->'cycles', '[]'::jsonb)) vc
         WHERE vc->>'cycleId' = ANY(${sql.param(cycleIds)}::text[])
           AND vc->'owned' IS NOT NULL
           AND vc->'owned' <> 'null'::jsonb
      )
    )
  `;
  const query = anchor
    ? sql`
        SELECT p.run_id::text AS run_id, p.state
          FROM scope_mirror_progress p
         WHERE p.project_id = ${row.projectId}::uuid
           AND p.run_id <> ${row.runId}::uuid
           AND (
             p.phase = 'complete'
             OR (p.phase = 'finalize' AND p.state->>'step' = 'invalidate-published')
           ) IS NOT TRUE
           AND p.state->'source'->>'project_id' = ${source.project_id}
           AND (
             (p.state->'source'->>'cycle_anchor_at')::timestamptz = ${anchor}::timestamptz
             OR ${sharedCycle}
           )
      `
    : sql`
        SELECT p.run_id::text AS run_id, p.state
          FROM scope_mirror_progress p
         WHERE p.project_id = ${row.projectId}::uuid
           AND p.run_id <> ${row.runId}::uuid
           AND (
             p.phase = 'complete'
             OR (p.phase = 'finalize' AND p.state->>'step' = 'invalidate-published')
           ) IS NOT TRUE
           AND p.state->'source'->>'project_id' = ${source.project_id}
           AND (
             p.state->'source'->>'cycle_anchor_at' IS NULL
             OR ${sharedCycle}
           )
      `;
  return executeRows<ProgressVisibilityRow>(tx, query);
}

function currentIsOwned(cycle: CycleRow, owned: Owned): boolean {
  return cycle.hidden_reason === owned.hiddenReason &&
    (cycle.hidden_scope ?? "all") === owned.hiddenScope &&
    cycle.hidden_at === owned.hiddenAtDb;
}

function freshHiddenAt(previous: string | undefined): string {
  const now = Date.now();
  const prior = previous ? Date.parse(previous) : NaN;
  return new Date(Number.isFinite(prior) && now <= prior ? prior + 1 : now).toISOString();
}

async function hideCycle(tx: Executor, cycle: CycleRow, at: string): Promise<Owned> {
  const updated = await executeRows<{ hidden_at: string }>(tx, sql`
    UPDATE summary_cycles
       SET hidden_reason = 'operator', hidden_at = ${at}::timestamptz, hidden_scope = 'all'
     WHERE cycle_id = ${cycle.cycle_id}::uuid
       AND hidden_reason IS NOT DISTINCT FROM ${cycle.hidden_reason}
       AND hidden_at IS NOT DISTINCT FROM ${cycle.hidden_at ? sql`${cycle.hidden_at}::timestamptz` : sql`NULL`}
       AND hidden_scope IS NOT DISTINCT FROM ${cycle.hidden_scope}
     RETURNING hidden_at::text AS hidden_at
  `);
  if (updated.length !== 1 || !updated[0]?.hidden_at) {
    throw new Error(`bulk visibility hide lost cycle ${cycle.cycle_id}`);
  }
  return { hiddenReason: "operator", hiddenAt: at, hiddenAtDb: updated[0].hidden_at, hiddenScope: "all" };
}

function sourceVisibility(row: ScopeMirrorProgressRow, source: Source): BulkCycleVisibilityState {
  return {
    version: 1,
    source: {
      runId: row.runId,
      projectId: source.project_id,
      cycleAnchorAt: source.cycle_anchor_at ?? null,
    },
    cycles: [],
  };
}

export function createBulkCycleVisibility(invalidate: () => Promise<void>): BulkVisibility {
  return {
    async prepare(tx, row) {
      const source = sourceOf(row);
      if (row.projectId !== source.project_id) throw new Error("Bulk visibility project mismatch");
      const cycles = await cycleRows(tx, row, source);
      const prior = sourceVisibility(row, source);
      if (cycles.length === 0) return prior;

      const others = await otherProgress(tx, row, source, cycles);
      let previousAt: string | undefined;
      for (const cycle of cycles) {
        const candidates = [
          visibilityOf((row.state as { visibility?: unknown })?.visibility),
          ...others.map((p) => visibilityOf((p.state as { visibility?: unknown })?.visibility)),
        ].filter((v): v is BulkCycleVisibilityState => !!v && projectMatches(v, source));
        const otherCycle = candidates
          .flatMap((v) => v.cycles)
          .find((c) => c.cycleId === cycle.cycle_id && c.owned &&
            cycle.hidden_reason === c.owned.hiddenReason &&
            (cycle.hidden_scope ?? "all") === c.owned.hiddenScope &&
            cycle.hidden_at === c.owned.hiddenAtDb);
        const inherited = !!otherCycle?.owned;
        const before = inherited ? otherCycle!.before : {
          hiddenReason: cycle.hidden_reason,
          hiddenAt: cycle.hidden_at,
          hiddenScope: cycle.hidden_scope,
        };
        let owned: Owned | null = null;
        const currentlyAllHidden = cycle.hidden_reason !== null &&
          cycle.hidden_at !== null && (cycle.hidden_scope ?? "all") === "all";
        if (!currentlyAllHidden) {
          const at = freshHiddenAt(previousAt);
          owned = await hideCycle(tx, cycle, at);
          previousAt = owned.hiddenAt;
        } else if (inherited) {
          owned = otherCycle!.owned;
        }
        prior.cycles.push({ cycleId: cycle.cycle_id, before, owned });
      }
      return prior;
    },

    async assertHeld(tx, row) {
      const state = visibilityOf(row.state.visibility);
      if (!state || state.cycles.length === 0) return;
      const current = await executeRows<CycleRow>(tx, sql`
        SELECT c.cycle_id::text AS cycle_id, c.project_id::text AS project_id,
               c.cycle_anchor_at::text AS cycle_anchor_at,
               c.hidden_reason, c.hidden_at::text AS hidden_at, c.hidden_scope
          FROM summary_cycles c
         WHERE c.cycle_id = ANY(${sql.param(state.cycles.map((c) => c.cycleId))}::uuid[])
         FOR SHARE
      `);
      const byId = new Map(current.map((c) => [c.cycle_id, c]));
      for (const expected of state.cycles) {
        const c = byId.get(expected.cycleId);
        if (!c || c.hidden_reason === null || c.hidden_at === null || (c.hidden_scope ?? "all") !== "all") {
          throw new Error(`bulk visibility hold lost cycle ${expected.cycleId}`);
        }
      }
    },

    async publish(tx, row) {
      const state = visibilityOf(row.state.visibility);
      if (!state || state.cycles.length === 0) return;
      const source = sourceOf(row);
      const current = await executeRows<CycleRow>(tx, sql`
        SELECT c.cycle_id::text AS cycle_id, c.project_id::text AS project_id,
               c.cycle_anchor_at::text AS cycle_anchor_at,
               c.hidden_reason, c.hidden_at::text AS hidden_at, c.hidden_scope
          FROM summary_cycles c
         WHERE c.cycle_id = ANY(${sql.param(state.cycles.map((c) => c.cycleId))}::uuid[])
         FOR UPDATE
      `);
      const others = await otherProgress(tx, row, source, state.cycles.map((c) => ({ cycle_id: c.cycleId })));
      const unfinishedCycleIds = new Set<string>();
      for (const p of others) {
        const v = visibilityOf((p.state as { visibility?: unknown })?.visibility);
        if (!v || !projectMatches(v, source)) continue;
        for (const c of v.cycles) unfinishedCycleIds.add(c.cycleId);
      }
      const byId = new Map(current.map((c) => [c.cycle_id, c]));
      for (const expected of state.cycles) {
        if (!expected.owned || unfinishedCycleIds.has(expected.cycleId)) continue;
        const c = byId.get(expected.cycleId);
        if (!c || !currentIsOwned(c, expected.owned)) continue;
        const before = expected.before;
        await tx.execute(sql`
          UPDATE summary_cycles
             SET hidden_reason = ${before.hiddenReason},
                 hidden_at = ${before.hiddenAt ? sql`${before.hiddenAt}::timestamptz` : sql`NULL`},
                 hidden_scope = ${before.hiddenScope}
           WHERE cycle_id = ${expected.cycleId}::uuid
             AND hidden_reason = ${expected.owned.hiddenReason}
             AND hidden_at = ${expected.owned.hiddenAt}::timestamptz
             AND COALESCE(hidden_scope, 'all') = ${expected.owned.hiddenScope}
        `);
      }
    },

    invalidate,
  };
}

/** Detect a cycle generation that raced a bulk checkpoint after its snapshot. */
export async function bulkGenerationDrift(
  executor: Executor,
  cycleId: string,
  generationId: string,
): Promise<boolean> {
  const probe = await executeRows<{ table_name: string | null }>(executor, sql`
    SELECT to_regclass('public.scope_mirror_progress') AS table_name
  `);
  if (!probe[0]?.table_name) return false;
  const locked = await executeRows<{ cycle_id: string }>(executor, sql`
    SELECT cycle_id::text AS cycle_id
      FROM summary_cycles
     WHERE cycle_id = ${cycleId}::uuid
     FOR UPDATE
  `);
  if (!locked[0]) return false;
  const result = await executeRows<{ drift: boolean }>(executor, sql`
    WITH cycle AS (
      SELECT cycle_id, project_id, cycle_anchor_at
        FROM summary_cycles WHERE cycle_id = ${cycleId}::uuid
    ), generation AS (
      SELECT started_at FROM summary_generations WHERE generation_id = ${generationId}::uuid
    )
    SELECT EXISTS (
      SELECT 1
        FROM cycle CROSS JOIN generation
        JOIN scope_mirror_progress p ON TRUE
        LEFT JOIN summary_cycle_runs cr
          ON cr.cycle_id = cycle.cycle_id AND cr.run_id = p.run_id
       WHERE (cr.run_id IS NOT NULL OR (
                p.state->'source'->>'project_id' = cycle.project_id::text
                AND (p.state->'source'->>'cycle_anchor_at')::timestamptz = cycle.cycle_anchor_at
              ))
         AND (p.phase <> 'complete' OR p.updated_at > generation.started_at)
    ) AS drift
  `);
  return result[0]?.drift === true;
}
