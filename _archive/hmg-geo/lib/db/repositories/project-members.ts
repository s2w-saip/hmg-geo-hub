import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  projectMembers,
  profiles,
  type ProjectMemberRow,
} from "@/lib/db/schema";

// ProjectMember repository — backs the v22 Flow #4 member-management flow.
// Returned rows always include the resolved profile email / role so the UI
// can render a member list without an extra round-trip.

export interface MemberWithProfile extends ProjectMemberRow {
  email: string | null;
  systemRole: string; // profiles.role — for context, not access control
}

export interface MemberInsert {
  projectId: string;
  userId: string;
  invitedBy: string;
  role?: "owner" | "viewer";
}

export interface ProjectMemberRepository {
  /** All members for a project (owners + viewers + pending). Owners first. */
  listForProject(projectId: string): Promise<MemberWithProfile[]>;
  /** A specific user's membership on a project, if any. */
  findMembership(
    projectId: string,
    userId: string,
  ): Promise<ProjectMemberRow | null>;
  /**
   * Batch variant of findMembership for one user across many projects
   * (single IN query) — the /projects list needs the caller's role badge on
   * every card, and per-project findMembership() calls were an N+1. Same
   * semantics as findMembership: no status filter (pending rows count too),
   * and (projectId, userId) is unique so there is at most one row per
   * project. Projects without a membership row are absent from the result.
   */
  getRolesForProjects(
    userId: string,
    projectIds: string[],
  ): Promise<Array<{ projectId: string; role: "owner" | "viewer" }>>;
  /**
   * Active-member head-count per project (single IN + GROUP BY query) — the
   * /projects list only renders the count, so fetching full member rows per
   * project (listForProject × N) was pure over-transfer. Projects with zero
   * active members are absent from the result (callers default to 0).
   */
  countActiveMembersByProject(
    projectIds: string[],
  ): Promise<Array<{ projectId: string; activeMembers: number }>>;
  /** Pending invites awaiting acceptance for a user — drives the project-list notification badge. */
  pendingForUser(userId: string): Promise<ProjectMemberRow[]>;
  insert(input: MemberInsert): Promise<ProjectMemberRow>;
  accept(membershipId: string): Promise<ProjectMemberRow>;
  /** Switch a membership's role (owner ↔ viewer). Caller enforces last-owner check. */
  setRole(
    membershipId: string,
    role: "owner" | "viewer",
  ): Promise<ProjectMemberRow>;
  delete(membershipId: string): Promise<void>;
  /**
   * 사용자 삭제 시 orphan 프로젝트 방지 (2026-07-02 결정: admin 자동 승계).
   * userId의 멤버십을 모두 지우고, 그 결과 수락된 Owner가 0명이 된 프로젝트에
   * successorId(삭제를 수행한 admin)를 Owner로 승계한다 — 기존 멤버십이 있으면
   * owner로 승격, 없으면 accepted owner로 삽입. 승계된 프로젝트 id 목록을
   * 반환한다 (액션 레이어가 멤버 감사 로그를 남길 수 있게).
   */
  removeUserAndSucceedOrphans(
    userId: string,
    successorId: string,
  ): Promise<string[]>;
}

function projectMemberSchemaErrorCode(err: unknown): string | undefined {
  const e = err as { cause?: { code?: string }; code?: string } | null;
  return e?.cause?.code ?? e?.code;
}

function isMissingProjectMemberSchema(err: unknown): boolean {
  const code = projectMemberSchemaErrorCode(err);
  // 42P01 = relation does not exist, 42703 = column does not exist.
  return code === "42P01" || code === "42703";
}

function warnMissingSchema(op: string) {
  console.warn(
    `[project_members] ${op}: schema missing — returning safe fallback (migration 0002 not applied?)`,
  );
}

export const projectMemberRepository: ProjectMemberRepository = {
  async listForProject(projectId) {
    try {
      const rows = await getDb()
        .select({
          id: projectMembers.id,
          projectId: projectMembers.projectId,
          userId: projectMembers.userId,
          role: projectMembers.role,
          status: projectMembers.status,
          invitedBy: projectMembers.invitedBy,
          invitedAt: projectMembers.invitedAt,
          acceptedAt: projectMembers.acceptedAt,
          email: profiles.email,
          systemRole: profiles.role,
        })
        .from(projectMembers)
        .leftJoin(profiles, eq(profiles.id, projectMembers.userId))
        .where(eq(projectMembers.projectId, projectId))
        // Owners first (role asc puts 'owner' before 'viewer'), then by
        // invite time ascending so the project history reads top→bottom.
        .orderBy(asc(projectMembers.role), asc(projectMembers.invitedAt));
      return rows.map((r) => ({
        ...r,
        systemRole: r.systemRole ?? "",
      }));
    } catch (err) {
      if (isMissingProjectMemberSchema(err)) {
        warnMissingSchema("listForProject");
        return [];
      }
      throw err;
    }
  },

  async findMembership(projectId, userId) {
    try {
      const rows = await getDb()
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, userId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    } catch (err) {
      if (isMissingProjectMemberSchema(err)) {
        warnMissingSchema("findMembership");
        return null;
      }
      throw err;
    }
  },

  async getRolesForProjects(userId, projectIds) {
    if (projectIds.length === 0) return [];
    try {
      return await getDb()
        .select({
          projectId: projectMembers.projectId,
          role: projectMembers.role,
        })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.userId, userId),
            inArray(projectMembers.projectId, projectIds),
          ),
        );
    } catch (err) {
      if (isMissingProjectMemberSchema(err)) {
        warnMissingSchema("getRolesForProjects");
        return [];
      }
      throw err;
    }
  },

  async countActiveMembersByProject(projectIds) {
    if (projectIds.length === 0) return [];
    try {
      const rows = await getDb()
        .select({
          projectId: projectMembers.projectId,
          activeMembers: sql<number>`count(*)`,
        })
        .from(projectMembers)
        .where(
          and(
            inArray(projectMembers.projectId, projectIds),
            eq(projectMembers.status, "active"),
          ),
        )
        .groupBy(projectMembers.projectId);
      // count(*) is bigint → postgres-js delivers it as a string; normalise
      // here so callers can sum/compare without surprises.
      return rows.map((r) => ({
        projectId: r.projectId,
        activeMembers: Number(r.activeMembers),
      }));
    } catch (err) {
      if (isMissingProjectMemberSchema(err)) {
        warnMissingSchema("countActiveMembersByProject");
        return [];
      }
      throw err;
    }
  },

  async pendingForUser(userId) {
    try {
      return await getDb()
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.userId, userId),
            eq(projectMembers.status, "pending"),
          ),
        )
        .orderBy(asc(projectMembers.invitedAt));
    } catch (err) {
      if (isMissingProjectMemberSchema(err)) {
        warnMissingSchema("pendingForUser");
        return [];
      }
      throw err;
    }
  },

  async insert(input) {
    const rows = await getDb()
      .insert(projectMembers)
      .values({
        projectId: input.projectId,
        userId: input.userId,
        role: input.role ?? "viewer",
        status: "pending",
        invitedBy: input.invitedBy,
      })
      .returning();
    const created = rows[0];
    if (!created) {
      throw new Error("projectMemberRepository.insert: no row returned");
    }
    return created;
  },

  async accept(membershipId) {
    const rows = await getDb()
      .update(projectMembers)
      .set({
        status: "active",
        acceptedAt: sql`now()`,
      })
      .where(eq(projectMembers.id, membershipId))
      .returning();
    const updated = rows[0];
    if (!updated) {
      throw new Error(
        "projectMemberRepository.accept: no row matched id=" + membershipId,
      );
    }
    return updated;
  },

  async setRole(membershipId, role) {
    const rows = await getDb()
      .update(projectMembers)
      .set({ role })
      .where(eq(projectMembers.id, membershipId))
      .returning();
    const updated = rows[0];
    if (!updated) {
      throw new Error(
        "projectMemberRepository.setRole: no row matched id=" + membershipId,
      );
    }
    return updated;
  },

  async delete(membershipId) {
    // Idempotent — deleting a missing row is a no-op since the desired end
    // state is "row gone". Used for cancel-invite, remove-member, and
    // (future) reject-invite.
    await getDb().delete(projectMembers).where(eq(projectMembers.id, membershipId));
  },

  async removeUserAndSucceedOrphans(userId, successorId) {
    const db = getDb();
    return db.transaction(async (tx) => {
      // 1) 삭제 대상 사용자의 멤버십 제거 — 그 사용자가 관여했던 프로젝트만
      //    orphan 후보가 되므로 지운 프로젝트 id를 기억한다.
      const removed = await tx
        .delete(projectMembers)
        .where(eq(projectMembers.userId, userId))
        .returning({ projectId: projectMembers.projectId });
      const candidateIds = [...new Set(removed.map((r) => r.projectId))];
      if (candidateIds.length === 0) return [];

      const succeeded: string[] = [];
      for (const projectId of candidateIds) {
        const owners = await tx
          .select({ id: projectMembers.id })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.projectId, projectId),
              eq(projectMembers.role, "owner"),
              eq(projectMembers.status, "active"),
            ),
          )
          .limit(1);
        if (owners.length > 0) continue; // 다른 Owner 존재 → orphan 아님

        // 2) admin 승계 — 기존 멤버십(viewer/pending)이 있으면 owner/active로
        //    승격, 없으면 새로 삽입. invited_by = 본인(승계 주체가 곧 admin).
        const existing = await tx
          .select({ id: projectMembers.id })
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.projectId, projectId),
              eq(projectMembers.userId, successorId),
            ),
          )
          .limit(1);
        if (existing.length > 0) {
          await tx
            .update(projectMembers)
            .set({ role: "owner", status: "active", acceptedAt: sql`now()` })
            .where(eq(projectMembers.id, existing[0].id));
        } else {
          await tx.insert(projectMembers).values({
            projectId,
            userId: successorId,
            role: "owner",
            status: "active",
            invitedBy: successorId,
            acceptedAt: sql`now()`,
          });
        }
        succeeded.push(projectId);
      }
      return succeeded;
    });
  },
};
