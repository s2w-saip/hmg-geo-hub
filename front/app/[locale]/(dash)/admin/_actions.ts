"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import { UnauthorizedError } from "@/lib/auth/errors";
import { profileRepository } from "@/lib/db/repositories/profiles";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { memberAuditLogRepository } from "@/lib/db/repositories/member-audit-logs";
import {
  adminCreateUser,
  adminDeleteUser,
  generateTempPassword,
} from "@/lib/supabase/admin";
import { auditDataAccess } from "@/lib/audit";
import type { Role, OperatorScope } from "@/lib/auth/types";
import * as api from "@/lib/hgh/adapters/admin";

// All admin actions enter through assertAdmin(). Two layers of defense:
//   (1) DashLayout gate blocks /admin URL for non-admins (route-policy).
//   (2) Every action re-validates the caller — never trust the surface above.
// access-control spec: "비관리자 호출은 즉시 거부".
//
// Source (D8, HGH_SOURCE_G7): every action keeps its gate and local input checks, then the
// api source hands the write to lib/hgh/adapters/admin.ts (POST / PATCH If-Match / DELETE
// /v1/admin/users) and keeps these result shapes and error keys; legacy runs the code below
// unchanged. Owner succession and audit rows move to the backend (DB trigger) on the api source.
async function assertAdmin() {
  const session = await getSession();
  if (!session || !canAccessAdmin(session.user)) {
    throw new UnauthorizedError("admin action requires role=admin");
  }
  return session;
}

const ROLES: Role[] = ["hq", "region", "country", "admin", "vendor", "website"];
const OPERATORS: OperatorScope[] = ["none", "assigned", "global"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CreateUserResult {
  ok: true;
  email: string;
  tempPassword: string;
}

export interface ActionError {
  ok: false;
  errorKey: string;
}

/** FormData list field: every non-empty value, trimmed, de-duplicated. */
function formList(formData: FormData, name: string): string[] {
  return [
    ...new Set(
      formData
        .getAll(name)
        .map((v) => String(v).trim())
        .filter(Boolean),
    ),
  ];
}

// Create a new user end-to-end: Supabase auth.users + profiles row + audit.
// On profiles insert failure we roll back the auth.users record so we don't
// leave half-created identities (design D4 risk mitigation).
// api source (D10, U11-N1): the form also sends role, operator and scope (scopeAll, brands,
// regions, countries); the backend creates the Supabase user, the account row and the audit
// row, and rolls the Supabase user back itself.
export async function createUser(
  formData: FormData,
): Promise<CreateUserResult | ActionError> {
  const actor = await assertAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, errorKey: "admin.errors.invalidEmail" };
  }

  if (api.isAdminApi()) {
    const role = String(formData.get("role") ?? "") as Role;
    const operator = String(formData.get("operator") ?? "none") as OperatorScope;
    if (!ROLES.includes(role) || !OPERATORS.includes(operator)) {
      return { ok: false, errorKey: "admin.errors.createFailed" };
    }
    if (role === "vendor" && operator !== "none") {
      return { ok: false, errorKey: "admin.errors.vendorOperatorForbidden" };
    }
    const res = await api.createAccount({
      email,
      role,
      operator,
      scopeAll: formData.get("scopeAll") === "true",
      brands: formList(formData, "brands"),
      regions: formList(formData, "regions"),
      countries: formList(formData, "countries"),
    });
    if (!res.ok) return res;
    revalidatePath("/[locale]/(dash)/admin", "page");
    return { ok: true, email: res.email, tempPassword: res.tempPassword };
  }

  const tempPassword = generateTempPassword();

  // 1. Create auth.users (with email_confirm:true — immediately usable).
  let authUserId: string | null = null;
  try {
    const u = await adminCreateUser({
      email,
      password: tempPassword,
      emailConfirm: true,
    });
    authUserId = u.id;
  } catch {
    return { ok: false, errorKey: "admin.errors.createFailed" };
  }

  // 2. Create profiles row. Default to country / no scope — admin tunes after.
  try {
    await profileRepository.insert({
      id: authUserId,
      email,
      role: "country",
      scopeAll: false,
      brands: null,
      regions: null,
      countries: null,
    });
  } catch {
    // Roll back the auth.users so we don't leak a half-created identity.
    try {
      await adminDeleteUser(authUserId);
    } catch {
      return { ok: false, errorKey: "admin.errors.rollbackFailed" };
    }
    return { ok: false, errorKey: "admin.errors.createFailed" };
  }

  auditDataAccess(actor.user, "profiles", `create:${email}`);
  revalidatePath("/[locale]/(dash)/admin", "page");
  return { ok: true, email, tempPassword };
}

export interface ScopeInput {
  scopeAll: boolean;
  brands: string[] | null;
  regions: string[] | null;
  countries: string[] | null;
}

export interface ProfilePatchInput {
  role: Role;
  scope: ScopeInput;
  operator: OperatorScope;
  /** api source only (DC-19): suspend instead of delete for an account with references. */
  status?: "active" | "suspended";
}

// Single atomic update: role + scope in one profiles.update call.
// Replaces the previous split updateUserRole / updateUserScope so a partial
// save can't happen and audit + revalidate fire exactly once per edit.
// (access-control spec: "역할과 범위를 단일 액션으로 갱신").
//
// Admin self-protection (mirrors deleteUser):
//   - An admin cannot demote themselves out of the admin role (lockout).
//   - The "at least one admin" invariant is enforced: demoting any admin
//     (self or other) is rejected if no other admin remains afterward.
//
// api source: PATCH with If-Match = rowVersion (the row version the dialog was opened with,
// DC-19); the governance guards (self demote, last admin, vendor operator) are the backend's
// and come back as the same error keys; a stale dialog gets rowVersionConflict.
export async function updateUserProfile(
  userId: string,
  patch: ProfilePatchInput,
  rowVersion?: number,
): Promise<{ ok: true } | ActionError> {
  const actor = await assertAdmin();
  if (!ROLES.includes(patch.role)) {
    return { ok: false, errorKey: "admin.errors.updateFailed" };
  }
  if (!OPERATORS.includes(patch.operator)) {
    return { ok: false, errorKey: "admin.errors.updateFailed" };
  }
  // vendor (외부 수행사) is operator-OFF permanently (operator-gating spec):
  // reject any attempt to grant a vendor cost-action authority.
  if (patch.role === "vendor" && patch.operator !== "none") {
    return { ok: false, errorKey: "admin.errors.vendorOperatorForbidden" };
  }

  if (api.isAdminApi()) {
    if (patch.status !== undefined && patch.status !== "active" && patch.status !== "suspended") {
      return { ok: false, errorKey: "admin.errors.updateFailed" };
    }
    const res = await api.patchAccount(
      userId,
      {
        role: patch.role,
        operator: patch.operator,
        scopeAll: patch.scope.scopeAll,
        brands: patch.scope.brands,
        regions: patch.scope.regions,
        countries: patch.scope.countries,
        ...(patch.status ? { status: patch.status } : {}),
      },
      rowVersion,
    );
    if (!res.ok) return res;
    revalidatePath("/[locale]/(dash)/admin", "page");
    return { ok: true };
  }

  // Admin governance guards — only relevant when an admin role is being
  // removed. Reading the current profile up-front so a row that's already
  // non-admin doesn't trigger the count query unnecessarily.
  if (patch.role !== "admin") {
    const current = await profileRepository.getByUserId(userId);
    const wasAdmin = current?.role === "admin";
    if (wasAdmin) {
      if (actor.user.id === userId) {
        return { ok: false, errorKey: "admin.errors.cannotDemoteSelf" };
      }
      const otherAdmins = await profileRepository.countAdminsExcept(userId);
      if (otherAdmins === 0) {
        return { ok: false, errorKey: "admin.errors.lastAdminProtected" };
      }
    }
  }

  // Normalize scope: scopeAll=true wipes per-dimension arrays so the stored
  // state always matches the rendered intent. Empty arrays collapse to null.
  const scope = patch.scope;
  const normalized = scope.scopeAll
    ? { scopeAll: true as const, brands: null, regions: null, countries: null }
    : {
        scopeAll: false as const,
        brands: scope.brands && scope.brands.length ? scope.brands : null,
        regions: scope.regions && scope.regions.length ? scope.regions : null,
        countries:
          scope.countries && scope.countries.length ? scope.countries : null,
      };

  // vendor is normalized to operator=none regardless of the submitted value
  // (belt-and-suspenders with the guard above and session.ts normalization).
  const operator: OperatorScope =
    patch.role === "vendor" ? "none" : patch.operator;

  try {
    await profileRepository.update(userId, {
      role: patch.role,
      operator,
      ...normalized,
    });
  } catch {
    return { ok: false, errorKey: "admin.errors.updateFailed" };
  }
  auditDataAccess(
    actor.user,
    "profiles",
    `update:${userId}:${JSON.stringify({ role: patch.role, operator, ...normalized })}`,
  );
  revalidatePath("/[locale]/(dash)/admin", "page");
  return { ok: true };
}

// Delete a user end-to-end. Order matters for security: revoke auth FIRST so
// access is immediately blocked, then clean up the local profile. If profile
// cleanup fails after auth deletion succeeds we still return ok — login is
// already revoked and the orphan profile won't surface in the join with
// adminListUsers. Self-deletion is rejected to prevent admin lockout.
// (access-control spec: 자기 삭제 거부 + 단일 액션 삭제).
export async function deleteUser(
  userId: string,
): Promise<{ ok: true } | ActionError> {
  const actor = await assertAdmin();
  if (actor.user.id === userId) {
    return { ok: false, errorKey: "admin.errors.cannotDeleteSelf" };
  }
  if (api.isAdminApi()) {
    // The backend guards last admin and referenced accounts (userReferenced, DC-19) and does
    // the Owner succession + audit in the same transaction.
    const res = await api.deleteAccount(userId);
    if (!res.ok) return res;
    revalidatePath("/[locale]/(dash)/admin", "page");
    return { ok: true };
  }
  // Defense in depth: even with the self-delete block above, an admin could
  // in principle ask to delete another admin who happens to be the only
  // remaining one (impossible if both caller and target are admin since the
  // count would be ≥ 2, but we encode the invariant explicitly so a future
  // refactor can't quietly remove it).
  const target = await profileRepository.getByUserId(userId);
  if (target?.role === "admin") {
    const otherAdmins = await profileRepository.countAdminsExcept(userId);
    if (otherAdmins === 0) {
      return { ok: false, errorKey: "admin.errors.lastAdminProtected" };
    }
  }
  try {
    await adminDeleteUser(userId);
  } catch {
    return { ok: false, errorKey: "admin.errors.deleteFailed" };
  }
  try {
    await profileRepository.delete(userId);
  } catch {
    // Auth already revoked — log and continue. Don't block the UX on a
    // local cleanup hiccup; an orphan profile is hidden by the join anyway.
    console.warn(
      "[deleteUser] auth deleted but profile cleanup failed",
      userId,
    );
  }
  // Orphan 프로젝트 방지 (2026-07-02 결정: admin 자동 승계) — 삭제된 사용자의
  // 멤버십을 걷어내고, Owner가 0명이 된 프로젝트는 삭제를 수행한 admin이 Owner를
  // 승계한다. auth는 이미 revoke됐으므로 여기 실패도 UX를 막지 않는다(경고만).
  try {
    const succeeded = await projectMemberRepository.removeUserAndSucceedOrphans(
      userId,
      actor.user.id,
    );
    for (const projectId of succeeded) {
      await memberAuditLogRepository.insert({
        projectId,
        actorId: actor.user.id,
        targetUserId: actor.user.id,
        action: "promote",
        context: `orphan-succession (deleted user ${userId})`,
      });
    }
  } catch (e) {
    console.warn("[deleteUser] orphan succession failed", userId, e);
  }
  auditDataAccess(actor.user, "profiles", `delete:${userId}`);
  revalidatePath("/[locale]/(dash)/admin", "page");
  return { ok: true };
}
