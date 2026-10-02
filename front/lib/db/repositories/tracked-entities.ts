import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  trackedBrands,
  trackedCompetitors,
  trackedVehicles,
  trackedKeywords,
  projects,
  prompts,
  type TrackedBrandRow,
  type TrackedCompetitorRow,
  type TrackedVehicleRow,
  type TrackedKeywordRow,
} from "@/lib/db/schema";

// Per-project tracked entity repositories — designated brands + vehicles
// (Task P3). DB/table names still say "competitor" for backward compatibility,
// but the project-setting meaning is now "brands designated for this project's
// analysis dimensions". Action layer calls
// `flagPromptsForReanalysis(projectId)` after any mutation so existing prompts
// get picked up by the next batch run.

// ─── tracked_competitors ─────────────────────────────────────────────────

export interface TrackedCompetitorInsert {
  projectId: string;
  brandName: string;
  aliases?: string[] | null;
  notes?: string | null;
}

export interface TrackedCompetitorRepository {
  listForProject(projectId: string): Promise<TrackedCompetitorRow[]>;
  insert(input: TrackedCompetitorInsert): Promise<TrackedCompetitorRow>;
  delete(id: string): Promise<void>;
  /**
   * KPI #16 비교 기준 브랜드 지정 — 프로젝트당 최대 1개 (partial unique
   * index). id=null 이면 지정 해제(→ 집계가 외부 브랜드 SOV 1위 자동 선택으로
   * 폴백).
   */
  setTarget(projectId: string, id: string | null): Promise<void>;
  /** 지정된 비교 기준 브랜드명 (없으면 null → 자동 선택 모드). */
  getTargetBrand(projectId: string): Promise<string | null>;
}

export const trackedCompetitorRepository: TrackedCompetitorRepository = {
  async listForProject(projectId) {
    return getDb()
      .select()
      .from(trackedCompetitors)
      .where(eq(trackedCompetitors.projectId, projectId))
      .orderBy(asc(trackedCompetitors.brandName));
  },

  async insert(input) {
    const rows = await getDb()
      .insert(trackedCompetitors)
      .values({
        projectId: input.projectId,
        brandName: input.brandName,
        aliases: input.aliases ?? null,
        notes: input.notes ?? null,
      })
      .returning();
    const created = rows[0];
    if (!created) throw new Error("trackedCompetitorRepository.insert: no row returned");
    return created;
  },

  async delete(id) {
    await getDb().delete(trackedCompetitors).where(eq(trackedCompetitors.id, id));
  },

  async setTarget(projectId, id) {
    // 해제 → 지정 순서를 한 트랜잭션으로 — partial unique index 위반 없이 교체.
    await getDb().transaction(async (tx) => {
      await tx
        .update(trackedCompetitors)
        .set({ isTarget: false })
        .where(
          and(
            eq(trackedCompetitors.projectId, projectId),
            eq(trackedCompetitors.isTarget, true),
          ),
        );
      if (id) {
        await tx
          .update(trackedCompetitors)
          .set({ isTarget: true })
          .where(
            and(
              eq(trackedCompetitors.id, id),
              eq(trackedCompetitors.projectId, projectId),
            ),
          );
      }
    });
  },

  async getTargetBrand(projectId) {
    const rows = await getDb()
      .select({ brandName: trackedCompetitors.brandName })
      .from(trackedCompetitors)
      .where(
        and(
          eq(trackedCompetitors.projectId, projectId),
          eq(trackedCompetitors.isTarget, true),
        ),
      )
      .limit(1);
    return rows[0]?.brandName ?? null;
  },
};

// ─── tracked_vehicles ────────────────────────────────────────────────────

export interface TrackedVehicleInsert {
  projectId: string;
  brand: string;
  model: string;
  segment?: string | null;
  aliases?: string[] | null;
}

export interface TrackedVehicleDistinctRow {
  brand: string;
  segment: string | null;
  model: string;
}

export interface TrackedVehicleRepository {
  listForProject(projectId: string): Promise<TrackedVehicleRow[]>;
  insert(input: TrackedVehicleInsert): Promise<TrackedVehicleRow>;
  delete(id: string): Promise<void>;
  /** Workspace-wide DISTINCT (brand, segment, model) — drives dashboard Product filter. */
  listDistinctWorkspace(): Promise<TrackedVehicleDistinctRow[]>;
}

export const trackedVehicleRepository: TrackedVehicleRepository = {
  async listForProject(projectId) {
    return getDb()
      .select()
      .from(trackedVehicles)
      .where(eq(trackedVehicles.projectId, projectId))
      .orderBy(asc(trackedVehicles.brand), asc(trackedVehicles.model));
  },

  // 2026-06-10 (D3): workspace-wide DISTINCT (brand, segment, model). Drives
  // the dashboard Product filter — swap the table when HMG ships its dedicated
  // product catalog. Shape kept narrow (no projectId) so callers can't leak it
  // back into a per-project query by accident.
  async listDistinctWorkspace() {
    return getDb()
      .selectDistinct({
        brand: trackedVehicles.brand,
        segment: trackedVehicles.segment,
        model: trackedVehicles.model,
      })
      .from(trackedVehicles)
      .orderBy(asc(trackedVehicles.brand), asc(trackedVehicles.model));
  },

  async insert(input) {
    const rows = await getDb()
      .insert(trackedVehicles)
      .values({
        projectId: input.projectId,
        brand: input.brand,
        model: input.model,
        segment: input.segment ?? null,
        aliases: input.aliases ?? null,
      })
      .returning();
    const created = rows[0];
    if (!created) throw new Error("trackedVehicleRepository.insert: no row returned");
    return created;
  },

  async delete(id) {
    await getDb().delete(trackedVehicles).where(eq(trackedVehicles.id, id));
  },
};

// ─── tracked_brands ──────────────────────────────────────────────────────

export interface TrackedBrandInsert {
  projectId: string;
  canonicalName: string;
  aliases: string[];
}

export interface TrackedBrandRepository {
  listForProject(projectId: string): Promise<TrackedBrandRow[]>;
  upsert(input: TrackedBrandInsert): Promise<void>;
  deleteByCanonical(projectId: string, canonicalName: string): Promise<void>;
}

export const trackedBrandRepository: TrackedBrandRepository = {
  async listForProject(projectId) {
    return getDb()
      .select()
      .from(trackedBrands)
      .where(eq(trackedBrands.projectId, projectId))
      .orderBy(asc(trackedBrands.canonicalName));
  },

  async upsert(input) {
    await getDb()
      .insert(trackedBrands)
      .values({
        projectId: input.projectId,
        canonicalName: input.canonicalName,
        aliases: input.aliases,
      })
      .onConflictDoUpdate({
        target: [trackedBrands.projectId, trackedBrands.canonicalName],
        set: { aliases: input.aliases },
      });
  },

  async deleteByCanonical(projectId, canonicalName) {
    await getDb()
      .delete(trackedBrands)
      .where(
        and(
          eq(trackedBrands.projectId, projectId),
          eq(trackedBrands.canonicalName, canonicalName),
        ),
      );
  },
};

// ─── tracked_keywords ────────────────────────────────────────────────────

export interface TrackedKeywordInsert {
  projectId: string;
  term: string;
  country?: string | null;
}

export interface TrackedKeywordRepository {
  listForProject(projectId: string): Promise<TrackedKeywordRow[]>;
  insert(input: TrackedKeywordInsert): Promise<TrackedKeywordRow>;
  /** Delete only when the row belongs to the project — the id comes from the
   *  client, so the projectId predicate is the cross-project guard. */
  deleteForProject(projectId: string, id: string): Promise<boolean>;
  /** Bulk variant of deleteForProject (선택 삭제). Returns deleted count. */
  deleteManyForProject(projectId: string, ids: string[]): Promise<number>;
}

export const trackedKeywordRepository: TrackedKeywordRepository = {
  async listForProject(projectId) {
    return getDb()
      .select()
      .from(trackedKeywords)
      .where(eq(trackedKeywords.projectId, projectId))
      .orderBy(asc(trackedKeywords.createdAt));
  },

  async insert(input) {
    const rows = await getDb()
      .insert(trackedKeywords)
      .values({
        projectId: input.projectId,
        term: input.term,
        country: input.country ?? null,
      })
      .returning();
    const created = rows[0];
    if (!created) throw new Error("trackedKeywordRepository.insert: no row returned");
    return created;
  },

  async deleteForProject(projectId, id) {
    const rows = await getDb()
      .delete(trackedKeywords)
      .where(
        and(
          eq(trackedKeywords.projectId, projectId),
          eq(trackedKeywords.id, id),
        ),
      )
      .returning({ id: trackedKeywords.id });
    return rows.length > 0;
  },

  async deleteManyForProject(projectId, ids) {
    if (ids.length === 0) return 0;
    const rows = await getDb()
      .delete(trackedKeywords)
      .where(
        and(
          eq(trackedKeywords.projectId, projectId),
          inArray(trackedKeywords.id, ids),
        ),
      )
      .returning({ id: trackedKeywords.id });
    return rows.length;
  },
};

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

// Rebuild the per-project canonical brand catalog from the current source
// entities so every downstream reader sees one brand-alias truth set.
export async function syncTrackedBrandCatalog(projectId: string): Promise<void> {
  const [projectRows, competitors, vehicles, existing] = await Promise.all([
    getDb()
      .select({ brand: projects.brand })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1),
    trackedCompetitorRepository.listForProject(projectId),
    trackedVehicleRepository.listForProject(projectId),
    trackedBrandRepository.listForProject(projectId),
  ]);

  const projectBrand = projectRows[0]?.brand?.trim() || null;
  const merged = new Map<string, Set<string>>();
  const pushBrand = (canonicalName: string, aliases: string[]) => {
    const canonical = canonicalName.trim();
    if (!canonical) return;
    const set = merged.get(canonical) ?? new Set<string>();
    set.add(canonical);
    for (const alias of aliases) {
      const trimmed = alias.trim();
      if (trimmed) set.add(trimmed);
    }
    merged.set(canonical, set);
  };

  if (projectBrand) pushBrand(projectBrand, []);
  for (const row of competitors) pushBrand(row.brandName, row.aliases ?? []);
  for (const row of vehicles) pushBrand(row.brand, []);
  for (const row of existing) {
    if (merged.has(row.canonicalName)) {
      pushBrand(row.canonicalName, row.aliases);
    }
  }

  for (const [canonicalName, aliases] of merged) {
    await trackedBrandRepository.upsert({
      projectId,
      canonicalName,
      aliases: uniq([...aliases]),
    });
  }

  for (const row of existing) {
    if (!merged.has(row.canonicalName)) {
      await trackedBrandRepository.deleteByCanonical(projectId, row.canonicalName);
    }
  }
}

// ─── reprocess plumbing ──────────────────────────────────────────────────

/**
 * Flip needs_reanalysis = true for every prompt in this project that has
 * already produced an answer (status in done / running / failed). Drafts
 * are excluded because their next execution will use the new label set
 * anyway — flipping them would just be redundant work for the analyzer.
 *
 * Returns the number of prompts touched so the action layer can surface
 * a "재처리 대상 {n}건" hint in the confirm toast.
 */
export async function flagPromptsForReanalysis(projectId: string): Promise<number> {
  const updated = await getDb()
    .update(prompts)
    .set({ needsReanalysis: true, updatedAt: sql`now()` })
    .where(
      and(
        eq(prompts.projectId, projectId),
        sql`${prompts.status} in ('queued', 'running', 'done', 'failed')`,
      ),
    )
    .returning({ id: prompts.id });
  return updated.length;
}
