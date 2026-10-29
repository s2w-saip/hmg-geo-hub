import "server-only";
import { alias } from "drizzle-orm/pg-core";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  memberAuditLogs,
  profiles,
  type MemberAuditLogRow,
} from "@/lib/db/schema";

// Append-only ledger for the Member tab. Reads always join `profiles`
// twice (actor + target) so the UI can render emails without follow-up
// queries. Inserts are fire-and-forget from the action layer — the action
// itself owns the authorisation check, this repo just persists.

export type MemberAuditAction =
  | "invite"
  | "cancel_invite"
  | "remove"
  | "promote"
  | "demote"
  | "accept"
  | "reject";

export interface MemberAuditLogInsert {
  projectId: string;
  actorId: string;
  targetUserId: string;
  action: MemberAuditAction;
  context?: string | null;
}

export interface MemberAuditLogView extends MemberAuditLogRow {
  actorEmail: string | null;
  targetEmail: string | null;
}

export interface MemberAuditLogRepository {
  /**
   * Project ledger newest-first. Default cap matches the UI window — the
   * Member tab shows the most recent slice and links nowhere deeper for
   * now, so over-fetching past the cap is wasted bandwidth.
   */
  listForProject(projectId: string, limit?: number): Promise<MemberAuditLogView[]>;
  insert(input: MemberAuditLogInsert): Promise<MemberAuditLogRow>;
}

const DEFAULT_LIMIT = 50;

export const memberAuditLogRepository: MemberAuditLogRepository = {
  async listForProject(projectId, limit = DEFAULT_LIMIT) {
    const actorProfile = alias(profiles, "actor_profile");
    const targetProfile = alias(profiles, "target_profile");
    const rows = await getDb()
      .select({
        id: memberAuditLogs.id,
        projectId: memberAuditLogs.projectId,
        actorId: memberAuditLogs.actorId,
        targetUserId: memberAuditLogs.targetUserId,
        action: memberAuditLogs.action,
        context: memberAuditLogs.context,
        createdAt: memberAuditLogs.createdAt,
        actorEmail: actorProfile.email,
        targetEmail: targetProfile.email,
      })
      .from(memberAuditLogs)
      .leftJoin(actorProfile, eq(actorProfile.id, memberAuditLogs.actorId))
      .leftJoin(targetProfile, eq(targetProfile.id, memberAuditLogs.targetUserId))
      .where(eq(memberAuditLogs.projectId, projectId))
      .orderBy(desc(memberAuditLogs.createdAt))
      .limit(limit);
    return rows;
  },

  async insert(input) {
    const inserted = await getDb()
      .insert(memberAuditLogs)
      .values({
        projectId: input.projectId,
        actorId: input.actorId,
        targetUserId: input.targetUserId,
        action: input.action,
        context: input.context ?? null,
      })
      .returning();
    const row = inserted[0];
    if (!row) {
      throw new Error("memberAuditLogRepository.insert: no row returned");
    }
    return row;
  },
};
