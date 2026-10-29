import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  promptCandidates,
  prompts,
  type PromptCandidateRow,
  type PromptRow,
} from "@/lib/db/schema";

// Prompt-pool repositories. Two tables:
//   - prompt_candidates: rolling pool fed from customer-interest results
//     (Google Keyword SERP suggestions + Social Scraping intents). Never
//     mutated by Prompt-tab actions — "원본은 후보 풀에 유지" per v22 flow
//     §3-2 A-④.
//   - prompts: actually-selected/manually-added prompts ready for batch AI
//     execution. Has lifecycle status (draft → queued → done|failed).

export type PromptType =
  | "comparison"
  | "recommendation"
  | "information"
  | "other";
// `paused` = 측정 중지 (2026-07-29, migration 0038): scope 쪽 active=false로
// 측정만 중단하고 이력은 보존한 행. updateStatusByScopePromptIds의 갱신 대상
// (queued/running/failed)이 아니므로 sync가 되살리지 않는다.
export type PromptStatus =
  | "draft"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "paused";
export type PromptSource = "google_keyword" | "social_scraping" | "manual";

export interface PromptCandidateInsert {
  projectId: string;
  source: PromptSource;
  sourceKeyword?: string | null;
  text: string;
}

export interface PromptCandidateRepository {
  listForProject(projectId: string): Promise<PromptCandidateRow[]>;
  /** Distinct candidate texts for the project — for send-time dedup + the
   *  "이미 추가됨" state in the Social Scraping catalog. */
  listTextsForProject(projectId: string): Promise<string[]>;
  insert(input: PromptCandidateInsert): Promise<PromptCandidateRow>;
  delete(id: string): Promise<void>;
  /** Delete only when the row belongs to the project — the id comes from the
   *  client, so the projectId predicate is the cross-project guard. */
  deleteForProject(projectId: string, id: string): Promise<boolean>;
  /** Bulk variant of deleteForProject (선택 삭제). Returns deleted count. */
  deleteManyForProject(projectId: string, ids: string[]): Promise<number>;
}

export const promptCandidateRepository: PromptCandidateRepository = {
  async listForProject(projectId) {
    return getDb()
      .select()
      .from(promptCandidates)
      .where(eq(promptCandidates.projectId, projectId))
      .orderBy(desc(promptCandidates.createdAt));
  },

  async listTextsForProject(projectId) {
    const rows = await getDb()
      .select({ text: promptCandidates.text })
      .from(promptCandidates)
      .where(eq(promptCandidates.projectId, projectId));
    return rows.map((r) => r.text);
  },

  async insert(input) {
    const rows = await getDb()
      .insert(promptCandidates)
      .values({
        projectId: input.projectId,
        source: input.source,
        sourceKeyword: input.sourceKeyword ?? null,
        text: input.text,
      })
      .returning();
    const created = rows[0];
    if (!created) {
      throw new Error("promptCandidateRepository.insert: no row returned");
    }
    return created;
  },

  async delete(id) {
    await getDb().delete(promptCandidates).where(eq(promptCandidates.id, id));
  },

  async deleteForProject(projectId, id) {
    const rows = await getDb()
      .delete(promptCandidates)
      .where(
        and(
          eq(promptCandidates.projectId, projectId),
          eq(promptCandidates.id, id),
        ),
      )
      .returning({ id: promptCandidates.id });
    return rows.length > 0;
  },

  async deleteManyForProject(projectId, ids) {
    if (ids.length === 0) return 0;
    const rows = await getDb()
      .delete(promptCandidates)
      .where(
        and(
          eq(promptCandidates.projectId, projectId),
          inArray(promptCandidates.id, ids),
        ),
      )
      .returning({ id: promptCandidates.id });
    return rows.length;
  },
};

// ---- Prompts (selected / manual) -----------------------------------------

export interface PromptInsert {
  projectId: string;
  candidateId?: string | null;
  text: string;
  promptType?: PromptType | null;
  category?: string | null;
  // Corporate-framework taxonomy (HMG xlsx) — all plain text, all optional.
  brand?: string | null; // HMG / Hyundai / Kia / Genesis
  listType?: string | null;
  depth1?: string | null;
  depth2?: string | null;
  depth3?: string | null;
  depth4?: string | null; // placeholder for future axis (migration 0010)
  funnelStage?: string | null;
  scopePromptId?: string | null;
  createdBy: string;
}

export interface PromptUpdate {
  text?: string;
  promptType?: PromptType | null;
  category?: string | null;
  brand?: string | null;
  listType?: string | null;
  depth1?: string | null;
  depth2?: string | null;
  depth3?: string | null;
  depth4?: string | null;
  funnelStage?: string | null;
}

export interface PromptRepository {
  listForProject(projectId: string): Promise<PromptRow[]>;
  /**
   * Per-project prompt counts in one IN + GROUP BY query: `total` (all
   * lifecycle statuses) and `queuedOrRunning` (status queued|running — the
   * "실행 대기" overview tile). Exists for the /projects list, which only
   * renders counts — fetching full prompt rows per project (listForProject
   * × N) was both an N+1 and a full-row over-transfer. Projects with zero
   * prompts are absent from the result (callers default to 0).
   */
  countByProject(
    projectIds: string[],
  ): Promise<
    Array<{ projectId: string; total: number; queuedOrRunning: number }>
  >;
  getById(id: string): Promise<PromptRow | null>;
  // scope prompt_id → 로컬 카탈로그 행 역참조 (catalog-prompt-audit: scope id만
  // 아는 호출부가 감사 로그의 로컬 promptId를 찾을 때).
  getByScopePromptId(scopePromptId: string): Promise<PromptRow | null>;
  /**
   * How many OTHER catalog rows map to the same scope prompt (excluding
   * `excludeId`). scope_prompt_id is intentionally NOT unique — 브랜드 간 텍스트
   * 공유·이중분류로 다대일 매핑이 존재한다. 라이프사이클 액션(측정 중지/완전
   * 삭제)은 이 값이 0일 때만 scope·미러를 건드릴 수 있다 — 아니면 남은 행들의
   * 측정·이력까지 같이 죽는다.
   */
  countOthersByScopePromptId(
    scopePromptId: string,
    excludeId: string,
  ): Promise<number>;
  /** 라이프사이클 전환 전용 setter (paused ↔ done). update()와 분리 — status는
   *  카탈로그 편집이 아니라 측정 상태라 편집 UI 경로에 노출하지 않는다. */
  setStatus(id: string, status: PromptStatus): Promise<void>;
  insert(input: PromptInsert): Promise<PromptRow>;
  update(id: string, patch: PromptUpdate): Promise<PromptRow>;
  delete(id: string): Promise<void>;
  /**
   * Persist the scope prompt_id a local draft was mirrored to (live push in
   * executePrompts). Separate from `update` because scopePromptId is set by the
   * scope-sync layer, not editable via the prompt-edit UI — cf.
   * projectRepository.setScopeProjectId.
   */
  setScopePromptId(id: string, scopePromptId: string): Promise<void>;
  /**
   * 측정 종류 전환 ('single' ↔ 'acr', migration 0025). scopePromptId처럼 일반
   * update와 분리 — kind는 카탈로그 편집이 아니라 측정 정책이고, 호출부(admin
   * 액션/push 스크립트)가 scope PATCH와 로컬 반영을 한 트랜잭션처럼 다뤄야 해서
   * 전용 setter로 둔다.
   */
  setKind(id: string, kind: "single" | "acr"): Promise<void>;
  /**
   * Flip a batch of draft prompts to `queued` and stamp a transition time.
   * In a real impl this is also where the AI batch-call would be dispatched;
   * for now it's a stub status change so the UI can demo end-to-end.
   */
  enqueueAll(projectId: string, ids: string[]): Promise<number>;
  /**
   * Feed measurement outcomes (from the scope mirror sync) back into the
   * catalog's lifecycle status, keyed by scope_prompt_id. `done` is sticky —
   * never touched once reached, so an out-of-order sync of a stale run can't
   * regress a settled success back to running/queued/failed. `failed` is
   * NOT sticky: scope re-measures registered prompts on its own recurring
   * cadence (weekly/monthly — independent of anything hmg-geo does, see
   * docs/root-catalog-country-scope-proposal.md), so a later successful job
   * for the same scope_prompt_id must be allowed to flip a `failed` row to
   * `done` — otherwise a real recovery on scope's side would be invisible
   * here forever.
   */
  updateStatusByScopePromptIds(
    updates: Array<{ scopePromptId: string; status: "running" | "done" | "failed" }>,
  ): Promise<number>;
}

export const promptRepository: PromptRepository = {
  async listForProject(projectId) {
    return getDb()
      .select()
      .from(prompts)
      .where(eq(prompts.projectId, projectId))
      .orderBy(asc(prompts.createdAt));
  },

  async countByProject(projectIds) {
    if (projectIds.length === 0) return [];
    const rows = await getDb()
      .select({
        projectId: prompts.projectId,
        total: sql<number>`count(*)`,
        queuedOrRunning: sql<number>`count(*) filter (where ${prompts.status} in ('queued', 'running'))`,
      })
      .from(prompts)
      .where(inArray(prompts.projectId, projectIds))
      .groupBy(prompts.projectId);
    // count(*) is bigint → postgres-js delivers it as a string; normalise to
    // number here so callers can sum/compare without surprises.
    return rows.map((r) => ({
      projectId: r.projectId,
      total: Number(r.total),
      queuedOrRunning: Number(r.queuedOrRunning),
    }));
  },

  async getById(id) {
    const rows = await getDb().select().from(prompts).where(eq(prompts.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async getByScopePromptId(scopePromptId) {
    const rows = await getDb()
      .select()
      .from(prompts)
      .where(eq(prompts.scopePromptId, scopePromptId))
      .limit(1);
    return rows[0] ?? null;
  },

  async countOthersByScopePromptId(scopePromptId, excludeId) {
    const rows = await getDb()
      .select({ n: sql<number>`count(*)` })
      .from(prompts)
      .where(
        and(
          eq(prompts.scopePromptId, scopePromptId),
          sql`${prompts.id} <> ${excludeId}`,
        ),
      );
    return Number(rows[0]?.n ?? 0);
  },

  async setStatus(id, status) {
    await getDb()
      .update(prompts)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(prompts.id, id));
  },

  async insert(input) {
    const rows = await getDb()
      .insert(prompts)
      .values({
        projectId: input.projectId,
        candidateId: input.candidateId ?? null,
        text: input.text,
        promptType: input.promptType ?? null,
        category: input.category ?? null,
        brand: input.brand ?? null,
        listType: input.listType ?? null,
        depth1: input.depth1 ?? null,
        depth2: input.depth2 ?? null,
        depth3: input.depth3 ?? null,
        depth4: input.depth4 ?? null,
        funnelStage: input.funnelStage ?? null,
        scopePromptId: input.scopePromptId ?? null,
        createdBy: input.createdBy,
      })
      .returning();
    const created = rows[0];
    if (!created) {
      throw new Error("promptRepository.insert: no row returned");
    }
    return created;
  },

  async update(id, patch) {
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (patch.text !== undefined) set.text = patch.text;
    if (patch.promptType !== undefined) set.promptType = patch.promptType;
    if (patch.category !== undefined) set.category = patch.category;
    if (patch.brand !== undefined) set.brand = patch.brand;
    if (patch.listType !== undefined) set.listType = patch.listType;
    if (patch.depth1 !== undefined) set.depth1 = patch.depth1;
    if (patch.depth2 !== undefined) set.depth2 = patch.depth2;
    if (patch.depth3 !== undefined) set.depth3 = patch.depth3;
    if (patch.depth4 !== undefined) set.depth4 = patch.depth4;
    if (patch.funnelStage !== undefined) set.funnelStage = patch.funnelStage;
    const rows = await getDb()
      .update(prompts)
      .set(set)
      .where(eq(prompts.id, id))
      .returning();
    const updated = rows[0];
    if (!updated) {
      throw new Error("promptRepository.update: no row matched id=" + id);
    }
    return updated;
  },

  async delete(id) {
    await getDb().delete(prompts).where(eq(prompts.id, id));
  },

  async setScopePromptId(id, scopePromptId) {
    await getDb()
      .update(prompts)
      .set({ scopePromptId, updatedAt: sql`now()` })
      .where(eq(prompts.id, id));
  },

  async setKind(id, kind) {
    await getDb()
      .update(prompts)
      .set({ kind, updatedAt: sql`now()` })
      .where(eq(prompts.id, id));
  },

  async enqueueAll(projectId, ids) {
    if (ids.length === 0) return 0;
    const rows = await getDb()
      .update(prompts)
      .set({ status: "queued", updatedAt: sql`now()` })
      .where(
        and(
          eq(prompts.projectId, projectId),
          inArray(prompts.id, ids),
          eq(prompts.status, "draft"),
        ),
      )
      .returning({ id: prompts.id });
    return rows.length;
  },

  async updateStatusByScopePromptIds(updates) {
    if (updates.length === 0) return 0;
    const idsByStatus = new Map<string, string[]>();
    for (const u of updates) {
      const arr = idsByStatus.get(u.status) ?? [];
      arr.push(u.scopePromptId);
      idsByStatus.set(u.status, arr);
    }
    let total = 0;
    for (const [status, scopePromptIds] of idsByStatus) {
      const rows = await getDb()
        .update(prompts)
        .set({ status: status as PromptStatus, updatedAt: sql`now()` })
        .where(
          and(
            inArray(prompts.scopePromptId, scopePromptIds),
            // `failed` included so a later successful re-measurement (scope's
            // own recurring cadence) can recover a prompt out of `failed` —
            // only `done` stays untouched/sticky.
            inArray(prompts.status, ["queued", "running", "failed"]),
          ),
        )
        .returning({ id: prompts.id });
      total += rows.length;
    }
    return total;
  },
};
