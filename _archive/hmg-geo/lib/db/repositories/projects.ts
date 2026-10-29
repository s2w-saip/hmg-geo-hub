import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  projects,
  projectMembers,
  projectEngineHistory,
  projectOwnedBases,
  projectTrackedUrls,
  trackedBrands,
  promptCandidates,
  prompts,
  trackedCompetitors,
  trackedKeywords,
  trackedVehicles,
  type ProjectRow,
} from "@/lib/db/schema";

// Project repository — minimal CRUD to support the member-management flow.
// Project creation UI (wizard) is paused; insert() is exposed for the seed
// script and future re-enabling of /projects/new.
//
// Access boundary: this repository does NOT check who is allowed to read a
// project. The page layer must pass a user id to listForUser() (returns
// only projects the user is an active member of) or call getById() after
// verifying membership via projectMemberRepository.findMembership().

export interface ProjectInsert {
  name: string;
  description?: string | null;
  domain?: string | null;
  brand?: string | null;
  country: string;
  language?: string | null;
  ga4PropertyId?: string | null;
  // 답변 수집 AI 엔진(lib/scope/engines.ts 어휘). 생략/undefined = NULL(레거시
  // 의미론). 생성 폼은 항상 명시값을 넘긴다.
  aiEngines?: string[] | null;
  createdBy: string;
}

/** A project row that has no scope mirror yet — see listUnmirrored(). */
export interface UnmirroredProject {
  id: string;
  name: string;
  country: string;
  brand: string | null;
  createdAt: Date;
  promptCount: number;
}

export interface ProjectRepository {
  getById(id: string): Promise<ProjectRow | null>;
  /**
   * Reverse lookup by the linked scope (측정 엔진) project id — the role→project
   * gate (lib/scope/server.ts::assertProjectInScope) receives scope ids from the
   * BFF surface and must resolve them back to the local row for brand/country/
   * membership checks.
   */
  getByScopeProjectId(scopeProjectId: string): Promise<ProjectRow | null>;
  /**
   * Projects with NO scope mirror (`scope_project_id IS NULL`) — the "고아"
   * health predicate (lib/scope/orphan-health.ts). Oldest first: the longer a
   * row has been unmirrored, the more certain it is a real defect rather than
   * a creation in flight. `promptCount` rides along because it is what makes
   * the alert actionable — an orphan with prompts is a project the customer
   * believes is measuring and never will.
   *
   * NOTE: `projects` has no soft-delete column (delete() is a hard cascade),
   * so "IS NULL" alone is the active-orphan set. Demo/mock exclusions are the
   * caller's job — they are integration semantics, not a DB fact.
   */
  listUnmirrored(): Promise<UnmirroredProject[]>;
  /**
   * Batch id→name resolution (single IN query). Exists for list surfaces that
   * only need display names for a set of ids — e.g. the pending-invite panel
   * on /projects — so they don't fan out one getById() per id (N+1). Ids not
   * found are simply absent from the result; callers decide the fallback.
   */
  getNamesByIds(ids: string[]): Promise<Array<{ id: string; name: string }>>;
  /**
   * Projects the given user has an `active` ProjectMember row for. Pending
   * invites are intentionally excluded — the user hasn't accepted yet, so
   * the project isn't theirs to list. Pending invites are surfaced via the
   * project list page's notification badge (see projectMembers.pendingForUser).
   */
  listForUser(userId: string): Promise<ProjectRow[]>;
  /**
   * Every project regardless of membership — admin-only (developer superuser
   * per 2026-06-02 resolution). Caller must gate.
   */
  listAll(): Promise<ProjectRow[]>;
  insert(input: ProjectInsert): Promise<ProjectRow>;
  /** Partial update of editable fields (name/description/domain/brand/ga4PropertyId). country is immutable post-create. */
  update(id: string, patch: ProjectUpdate): Promise<ProjectRow>;
  /**
   * Store the 1:1 link to the scope (GEO 측정 엔진) project that mirrors this
   * one. Set after the scope mirror is created (lib/scope/project-sync.ts);
   * separate from update() because it's an integration side-effect, not a
   * user-facing edit.
   */
  setScopeProjectId(id: string, scopeProjectId: string): Promise<void>;
  /**
   * AI 엔진 선택 저장 + 이력 append (한 호출 = 한 이력 행). engines 는 정규화된
   * 카탈로그 토큰 배열이어야 한다(호출자가 normalizeAiEngines). 빈 배열 허용
   * (= 전부 해제). 반환 = 갱신된 프로젝트 행.
   */
  setAiEngines(
    id: string,
    engines: string[],
    changedBy: string | null,
  ): Promise<ProjectRow>;
  /** 엔진 변경 이력 — 최신순. */
  listEngineHistory(id: string): Promise<
    Array<{ id: string; engines: string[]; changedBy: string | null; changedAt: Date }>
  >;
  /**
   * Hard delete with cascade: prompts → prompt_candidates → project_members
   * → projects. No FK ON DELETE CASCADE is set at the DB level (schema.ts
   * doesn't declare references), so we delete child rows ourselves in
   * dependency order.
   */
  delete(id: string): Promise<void>;
}

export interface ProjectUpdate {
  name?: string;
  description?: string | null;
  domain?: string | null;
  brand?: string | null;
  // null clears the per-project binding → resolution falls back to the catalog.
  ga4PropertyId?: string | null;
}

export const projectRepository: ProjectRepository = {
  async getById(id) {
    const rows = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  async getByScopeProjectId(scopeProjectId) {
    const rows = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.scopeProjectId, scopeProjectId))
      .limit(1);
    return rows[0] ?? null;
  },

  async listUnmirrored() {
    const db = getDb();
    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        country: projects.country,
        brand: projects.brand,
        createdAt: projects.createdAt,
        // ⚠️ 손으로 쓴 상관 서브쿼리를 쓰지 마라. `sql\`… where ${prompts.projectId}
        // = ${projects.id}\`` 는 컬럼을 **한정 없이** 렌더한다(`where "project_id"
        // = "id"`) — 서브쿼리 안에서 `"id"` 는 prompts.id 로 묶여 조건이 항상
        // 거짓이 되고, 개수가 조용히 전부 0 이 된다(2026-08-20 실측: 프롬프트
        // 20개인 프로젝트가 0 으로 나왔다). `$count` 는 양쪽을 한정해 렌더한다:
        //   (select count(*) from "prompts"
        //    where "prompts"."project_id" = "projects"."id")
        promptCount: db.$count(prompts, eq(prompts.projectId, projects.id)),
      })
      .from(projects)
      .where(isNull(projects.scopeProjectId))
      .orderBy(asc(projects.createdAt));
    // count(*) 는 int8 이라 드라이버가 문자열로 돌려줄 수 있다 — 경계에서 한 번
    // 좁혀 두면 호출자가 타입을 의심할 일이 없다.
    return rows.map((r) => ({ ...r, promptCount: Number(r.promptCount) }));
  },

  async getNamesByIds(ids) {
    // Guard: inArray([]) is not a valid SQL predicate — and "no ids" already
    // has an unambiguous answer, so skip the round-trip entirely.
    if (ids.length === 0) return [];
    return getDb()
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(inArray(projects.id, ids));
  },

  async listForUser(userId) {
    return getDb()
      .select({
        id: projects.id,
        name: projects.name,
        description: projects.description,
        domain: projects.domain,
        brand: projects.brand,
        country: projects.country,
        language: projects.language,
        scopeProjectId: projects.scopeProjectId,
        ga4PropertyId: projects.ga4PropertyId,
        aiEngines: projects.aiEngines,
        createdBy: projects.createdBy,
        createdAt: projects.createdAt,
        updatedAt: projects.updatedAt,
      })
      .from(projects)
      .innerJoin(
        projectMembers,
        and(
          eq(projectMembers.projectId, projects.id),
          eq(projectMembers.userId, userId),
          eq(projectMembers.status, "active"),
        ),
      )
      .orderBy(desc(projects.createdAt));
  },

  async listAll() {
    return getDb().select().from(projects).orderBy(desc(projects.createdAt));
  },

  async insert(input) {
    const rows = await getDb()
      .insert(projects)
      .values({
        name: input.name,
        description: input.description ?? null,
        domain: input.domain ?? null,
        brand: input.brand ?? null,
        country: input.country,
        language: input.language ?? null,
        ga4PropertyId: input.ga4PropertyId ?? null,
        aiEngines: input.aiEngines ?? null,
        createdBy: input.createdBy,
      })
      .returning();
    const created = rows[0];
    if (!created) throw new Error("projectRepository.insert: no row returned");
    // Auto-create the Owner ProjectMember row in the same transaction-like
    // flow. We don't open a real tx (drizzle-orm/postgres-js's tx helper
    // would suffice when needed); for the seed path failure is recoverable
    // (delete the orphan project and re-run).
    await getDb()
      .insert(projectMembers)
      .values({
        projectId: created.id,
        userId: input.createdBy,
        role: "owner",
        status: "active",
        invitedBy: input.createdBy,
        acceptedAt: sql`now()`,
      })
      .onConflictDoNothing();
    // 엔진을 명시해 만든 프로젝트는 이력의 첫 행(생성 시점 선택)을 남긴다 —
    // 설정 화면의 "엔진 변경 이력"이 생성일부터 시작하도록. Owner 멤버십 뒤에
    // 넣어 이력 insert 실패가 Owner 없는 고아 프로젝트를 만들지 않게 한다.
    if (input.aiEngines) {
      await getDb().insert(projectEngineHistory).values({
        projectId: created.id,
        engines: input.aiEngines,
        changedBy: input.createdBy,
      });
    }
    return created;
  },

  async update(id, patch) {
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.domain !== undefined) set.domain = patch.domain;
    if (patch.brand !== undefined) set.brand = patch.brand;
    if (patch.ga4PropertyId !== undefined) set.ga4PropertyId = patch.ga4PropertyId;
    const rows = await getDb()
      .update(projects)
      .set(set)
      .where(eq(projects.id, id))
      .returning();
    const updated = rows[0];
    if (!updated) throw new Error("projectRepository.update: no row matched id=" + id);
    return updated;
  },

  async setScopeProjectId(id, scopeProjectId) {
    await getDb()
      .update(projects)
      .set({ scopeProjectId, updatedAt: sql`now()` })
      .where(eq(projects.id, id));
  },

  async setAiEngines(id, engines, changedBy) {
    const db = getDb();
    const rows = await db
      .update(projects)
      .set({ aiEngines: engines, updatedAt: sql`now()` })
      .where(eq(projects.id, id))
      .returning();
    const updated = rows[0];
    if (!updated) throw new Error("projectRepository.setAiEngines: no row matched id=" + id);
    await db.insert(projectEngineHistory).values({
      projectId: id,
      engines,
      changedBy,
    });
    return updated;
  },

  async listEngineHistory(id) {
    return getDb()
      .select({
        id: projectEngineHistory.id,
        engines: projectEngineHistory.engines,
        changedBy: projectEngineHistory.changedBy,
        changedAt: projectEngineHistory.changedAt,
      })
      .from(projectEngineHistory)
      .where(eq(projectEngineHistory.projectId, id))
      .orderBy(desc(projectEngineHistory.changedAt), desc(projectEngineHistory.id));
  },

  async delete(id) {
    const db = getDb();
    await db.delete(projectEngineHistory).where(eq(projectEngineHistory.projectId, id));
    await db.delete(projectTrackedUrls).where(eq(projectTrackedUrls.projectId, id));
    await db.delete(projectOwnedBases).where(eq(projectOwnedBases.projectId, id));
    await db.delete(trackedBrands).where(eq(trackedBrands.projectId, id));
    await db.delete(trackedVehicles).where(eq(trackedVehicles.projectId, id));
    await db.delete(trackedCompetitors).where(eq(trackedCompetitors.projectId, id));
    await db.delete(trackedKeywords).where(eq(trackedKeywords.projectId, id));
    await db.delete(prompts).where(eq(prompts.projectId, id));
    await db.delete(promptCandidates).where(eq(promptCandidates.projectId, id));
    await db.delete(projectMembers).where(eq(projectMembers.projectId, id));
    await db.delete(projects).where(eq(projects.id, id));
  },
};

// Re-export Drizzle's order helpers so other repository files can stay
// flat (single-file imports). Internal use only — repositories aren't part
// of the package public API.
export const _orderHelpers = { asc, desc };
