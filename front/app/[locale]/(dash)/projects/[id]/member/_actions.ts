"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { profileRepository } from "@/lib/db/repositories/profiles";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { memberAuditLogRepository } from "@/lib/db/repositories/member-audit-logs";
import * as api from "@/lib/hgh/adapters/projects";

// Member-management server actions for /projects/[id]/member (v23 slug).
//
// Authorization model (resolved 2026-06-01, Q5(a)/Q6(b)/Q7(b)):
//   - Only the project's active Owner(s) may invite / cancel / remove.
//   - Invited email must resolve to an EXISTING profile (Q7(b)).
//   - Invitations create a pending ProjectMember row; the actual email is
//     only LOGGED for now (Q5(a)) — viewer accepts via in-app notification
//     (Q6(b), see acceptInvite below).
//
// Each action returns a tagged Result instead of throwing for expected
// validation failures (bad email, duplicate, etc.) so the form can render
// inline messages without a try/catch dance. UnauthorizedError still
// throws because those are programmer/access errors, not user input.
//
// Data source (D8): with HGH_SOURCE_G6=api each action calls the backend member API
// (lib/hgh/adapters/projects.ts) and keeps these result shapes and messages; the member id the
// list hands back is the user id on that source (/members/{user_id}), and a pending invite's
// "membershipId" is its project id (/members/me/accept|reject). revalidatePath stays here.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

async function requireOwner(projectId: string): Promise<{
  userId: string;
}> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const userId = session.user.id;

  const project = await projectRepository.getById(projectId);
  if (!project) throw new UnauthorizedError("project not found");

  // admin = developer superuser (resolved 2026-06-02): bypass Owner check
  // so every project's member-mgmt actions are reachable for testing.
  if (session.user.role === "admin") return { userId };

  const membership = await projectMemberRepository.findMembership(
    projectId,
    userId,
  );
  if (
    !membership ||
    membership.role !== "owner" ||
    membership.status !== "active"
  ) {
    throw new UnauthorizedError("member action requires active Owner");
  }
  return { userId };
}

export async function inviteMember(
  projectId: string,
  email: string,
): Promise<ActionResult> {
  if (api.isProjectsApi()) {
    const r = await api.inviteMember(projectId, email);
    if (r.ok) revalidatePath(`/projects/${projectId}/member`);
    return r;
  }
  const { userId: inviterId } = await requireOwner(projectId);

  const normalised = email.trim().toLowerCase();
  if (!EMAIL_RE.test(normalised)) {
    return { ok: false, error: "이메일 형식이 올바르지 않습니다" };
  }

  // Q7(b): the invitee must already have an account. Looking up by email
  // → profile lets us insert a ProjectMember keyed to user_id (no orphan
  // pending rows on un-registered emails).
  const invitee = await profileRepository.getByEmail(normalised);
  if (!invitee) {
    return {
      ok: false,
      error: "해당 이메일로 가입된 사용자를 찾을 수 없습니다",
    };
  }

  if (invitee.id === inviterId) {
    return { ok: false, error: "본인을 초대할 수 없습니다" };
  }

  const existing = await projectMemberRepository.findMembership(
    projectId,
    invitee.id,
  );
  if (existing) {
    return {
      ok: false,
      error:
        existing.status === "active"
          ? "이미 멤버입니다"
          : "이미 초대된 사용자입니다 (대기 상태)",
    };
  }

  await projectMemberRepository.insert({
    projectId,
    userId: invitee.id,
    invitedBy: inviterId,
    role: "viewer",
  });

  await memberAuditLogRepository.insert({
    projectId,
    actorId: inviterId,
    targetUserId: invitee.id,
    action: "invite",
    context: "role=viewer",
  });

  // Q5(a): no email send yet — log so reviewers can confirm the action
  // fired during prod testing.
  console.log(
    `[invite] project=${projectId} → ${normalised} (by ${inviterId})`,
  );

  revalidatePath(`/projects/${projectId}/member`);
  return { ok: true, value: undefined };
}

export async function cancelInvite(
  projectId: string,
  membershipId: string,
): Promise<ActionResult> {
  if (api.isProjectsApi()) {
    const r = await api.cancelInvite(projectId, membershipId);
    if (r.ok) revalidatePath(`/projects/${projectId}/member`);
    return r;
  }
  const { userId: actorId } = await requireOwner(projectId);

  const all = await projectMemberRepository.listForProject(projectId);
  const target = all.find((m) => m.id === membershipId);
  if (!target) return { ok: false, error: "해당 멤버를 찾을 수 없습니다" };
  if (target.status !== "pending") {
    return {
      ok: false,
      error: "대기 중인 초대만 취소할 수 있습니다",
    };
  }

  await projectMemberRepository.delete(membershipId);
  await memberAuditLogRepository.insert({
    projectId,
    actorId,
    targetUserId: target.userId,
    action: "cancel_invite",
  });
  revalidatePath(`/projects/${projectId}/member`);
  return { ok: true, value: undefined };
}

export async function removeMember(
  projectId: string,
  membershipId: string,
): Promise<ActionResult> {
  if (api.isProjectsApi()) {
    const r = await api.removeMember(projectId, membershipId);
    if (r.ok) revalidatePath(`/projects/${projectId}/member`);
    return r;
  }
  const { userId: actorId } = await requireOwner(projectId);

  const all = await projectMemberRepository.listForProject(projectId);
  const target = all.find((m) => m.id === membershipId);
  if (!target) return { ok: false, error: "해당 멤버를 찾을 수 없습니다" };
  if (target.role === "owner") {
    return {
      ok: false,
      error: "Owner는 제거할 수 없습니다 (Owner 위임 후 다시 시도)",
    };
  }
  if (target.userId === actorId) {
    return { ok: false, error: "본인을 제거할 수 없습니다" };
  }

  await projectMemberRepository.delete(membershipId);
  await memberAuditLogRepository.insert({
    projectId,
    actorId,
    targetUserId: target.userId,
    action: "remove",
    context: `role=${target.role}`,
  });
  revalidatePath(`/projects/${projectId}/member`);
  return { ok: true, value: undefined };
}

// Viewer-side accept — opened from the in-app notification badge on the
// /projects list. Verifies the membership belongs to the calling user
// before flipping status. No Owner check here (the invitee is the actor).
export async function acceptInvite(
  membershipId: string,
): Promise<ActionResult> {
  if (api.isProjectsApi()) {
    const r = await api.respondToInvite(membershipId, "accept");
    if (r.ok) revalidatePath(`/projects`);
    return r;
  }
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const userId = session.user.id;

  const all = await projectMemberRepository.pendingForUser(userId);
  const target = all.find((m) => m.id === membershipId);
  if (!target) {
    return { ok: false, error: "대기 중인 초대가 아닙니다" };
  }

  await projectMemberRepository.accept(membershipId);
  // Self-acted: actor === target. Both columns point at the same user so the
  // log row reads cleanly as "<email> accepted invite".
  await memberAuditLogRepository.insert({
    projectId: target.projectId,
    actorId: userId,
    targetUserId: userId,
    action: "accept",
  });
  revalidatePath(`/projects`);
  return { ok: true, value: undefined };
}

// Viewer-side reject — same auth path as accept but deletes the row
// instead of flipping status, matching the v22 flow's "거절 처리 + 알림
// 제거" branch.
export async function rejectInvite(
  membershipId: string,
): Promise<ActionResult> {
  if (api.isProjectsApi()) {
    const r = await api.respondToInvite(membershipId, "reject");
    if (r.ok) revalidatePath(`/projects`);
    return r;
  }
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const userId = session.user.id;

  const all = await projectMemberRepository.pendingForUser(userId);
  const target = all.find((m) => m.id === membershipId);
  if (!target) {
    return { ok: false, error: "대기 중인 초대가 아닙니다" };
  }

  await projectMemberRepository.delete(membershipId);
  await memberAuditLogRepository.insert({
    projectId: target.projectId,
    actorId: userId,
    targetUserId: userId,
    action: "reject",
  });
  revalidatePath(`/projects`);
  return { ok: true, value: undefined };
}
