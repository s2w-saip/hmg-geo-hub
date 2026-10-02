"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import { canAccessRoute } from "@/lib/auth/route-policy";
import { UnauthorizedError } from "@/lib/auth/errors";
import * as ecat from "@/lib/hgh/adapters/admin-entities";
import type { EcatResult } from "@/lib/hgh/adapters/admin-entities";

// Admin-only entity version actions (E7). Every write goes to the draft (or to an apply request);
// nothing here changes the KPIs directly: a version reaches the facts only after
// apply request -> preview -> approve -> loader apply. Arguments are validated here (the
// backend validates again); a bad argument answers errorKey "invalid" without a backend call.
// Results carry an i18n key (adminEcat.errors.<key>), never a backend message.

const LAYOUT = "/[locale]/admin/standards/entities";
const ENTITIES_PATH = "/admin/standards/entities";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INVALID = { ok: false as const, errorKey: "invalid" };

// Same gate as the backend router (require_admin + require_menu_group('admin')): role admin and an account
// menu-group list that allows the admin group (null or empty = no narrowing, route-policy groupAllowed).
async function requireAdmin() {
  const session = await getSession();
  if (!session || !canAccessAdmin(session.user) || !canAccessRoute(session.user.role, ENTITIES_PATH, session.user.menuGroups)) {
    throw new UnauthorizedError("entity version action requires role=admin and the admin menu group");
  }
}

const isId = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0 && n < 2_147_483_647;
const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);
const optUuid = (s: unknown): boolean => s == null || s === "" || isUuid(s);
const isRole = (r: unknown): r is ecat.EcatRole => typeof r === "string" && (ecat.ECAT_ROLES as readonly string[]).includes(r);
const text = (s: unknown, max = 2000): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= max;
const optText = (s: unknown, max = 2000): boolean => s == null || (typeof s === "string" && s.length <= max);

function written<T>(r: EcatResult<T>): EcatResult<T> {
  if (r.ok) revalidatePath(LAYOUT, "layout");
  return r;
}

// ── draft ───────────────────────────────────────────────────────────────────

export async function createDraftAction(title: string, reason: string | null) {
  await requireAdmin();
  if (!text(title, 200) || !optText(reason)) return INVALID;
  return written(await ecat.createDraft(title.trim(), ecat.nz(reason)));
}

export async function patchDraftAction(ver: number, title: string, reason: string | null) {
  await requireAdmin();
  if (!isId(ver) || !text(title, 200) || !optText(reason)) return INVALID;
  return written(await ecat.patchDraft(ver, title.trim(), ecat.nz(reason)));
}

export async function discardDraftAction(ver: number, reason: string | null) {
  await requireAdmin();
  if (!isId(ver) || !optText(reason)) return INVALID;
  return written(await ecat.discardDraft(ver, ecat.nz(reason)));
}

export async function putDraftEntityAction(ver: number, entityId: string, edit: ecat.EntityEdit) {
  await requireAdmin();
  if (!isId(ver) || !isUuid(entityId) || !edit || !isRole(edit.role)) return INVALID;
  if (!optUuid(edit.mergeInto) || !optUuid(edit.parentBrandId) || !optText(edit.name, 200) || !optText(edit.note)) return INVALID;
  if (edit.mergeInto === entityId || edit.parentBrandId === entityId) return { ok: false as const, errorKey: "ECAT_MERGE_SELF" };
  if (edit.role === "own" && !ecat.nz(edit.brandCode)) return { ok: false as const, errorKey: "brand_required" };
  return written(await ecat.putDraftEntity(ver, entityId, edit));
}

export async function addHubEntityAction(ver: number, input: ecat.HubEntityInput) {
  await requireAdmin();
  if (!isId(ver) || !input || !text(input.name, 200) || !isRole(input.role) || !optText(input.entityType, 60)) return INVALID;
  if (!optUuid(input.parentBrandId) || !optText(input.note)) return INVALID;
  if (input.role === "own" && !ecat.nz(input.brandCode)) return { ok: false as const, errorKey: "brand_required" };
  return written(await ecat.addHubEntity(ver, input));
}

export async function deleteDraftEntityAction(ver: number, entityId: string) {
  await requireAdmin();
  if (!isId(ver) || !isUuid(entityId)) return INVALID;
  return written(await ecat.deleteDraftEntity(ver, entityId));
}

export async function addDraftSurfaceAction(ver: number, input: ecat.SurfaceInput) {
  await requireAdmin();
  if (!isId(ver) || !input || (input.action !== "add" && input.action !== "block") || !text(input.surface, 200)) return INVALID;
  if (!optUuid(input.entityId) || !optText(input.lang, 16)) return INVALID;
  if (input.action === "add" && !input.entityId) return { ok: false as const, errorKey: "ECAT_SURFACE_ADD_GLOBAL" };
  return written(await ecat.addDraftSurface(ver, input));
}

export async function deleteDraftSurfaceAction(ver: number, surfaceId: number) {
  await requireAdmin();
  if (!isId(ver) || !isId(surfaceId)) return INVALID;
  return written(await ecat.deleteDraftSurface(ver, surfaceId));
}

export async function runLintAction(ver: number) {
  await requireAdmin();
  if (!isId(ver)) return INVALID;
  return written(await ecat.runLint(ver));
}

export async function saveLintAcksAction(ver: number, keys: string[]) {
  await requireAdmin();
  if (!isId(ver) || !Array.isArray(keys) || keys.length > 5000 || !keys.every((k) => text(k, 500))) return INVALID;
  return written(await ecat.saveLintAcks(ver, [...new Set(keys)]));
}

export async function versionDiffAction(ver: number, against: number | null) {
  await requireAdmin();
  if (!isId(ver) || (against != null && !isId(against))) return INVALID;
  return ecat.versionDiffResult(ver, against);
}

// ── apply ───────────────────────────────────────────────────────────────────

export async function requestApplyAction(req: ecat.ApplyRequest) {
  await requireAdmin();
  if (!req || !["unexposed", "from_round", "all"].includes(req.scopeKind) || !text(req.reason)) return INVALID;
  if (req.scopeKind === "from_round" && !(typeof req.fromRoundDate === "string" && DAY.test(req.fromRoundDate))) {
    return { ok: false as const, errorKey: "ECAT_SCOPE_INVALID" };
  }
  if (req.ver != null && !isId(req.ver)) return INVALID;
  return written(await ecat.requestApply(req));
}

export async function getApplyAction(applyId: number) {
  await requireAdmin();
  if (!isId(applyId)) return INVALID;
  return ecat.applyDetailResult(applyId);
}

export async function applyStepAction(
  applyId: number,
  step: "preview" | "approve" | "reject" | "resume" | "abandon" | "rollback",
  reason: string | null,
) {
  await requireAdmin();
  if (!isId(applyId) || !["preview", "approve", "reject", "resume", "abandon", "rollback"].includes(step) || !optText(reason)) return INVALID;
  if ((step === "reject" || step === "abandon" || step === "rollback") && !text(reason)) return { ok: false as const, errorKey: "reasonRequired" };
  return written(await ecat.applyAction(applyId, step, reason));
}

// ── samples, review ─────────────────────────────────────────────────────────

export async function entityMentionsAction(entityId: string, surfaceText: string | null) {
  await requireAdmin();
  if (!isUuid(entityId) || !optText(surfaceText, 200)) return INVALID;
  return ecat.mentionSamples(entityId, surfaceText);
}

export async function decideReviewAction(reviewId: number, d: ecat.ReviewDecisionInput) {
  await requireAdmin();
  if (!isId(reviewId) || !d || (d.action !== "register" && d.action !== "dismiss")) return INVALID;
  if (d.role != null && !isRole(d.role)) return INVALID;
  if (!optUuid(d.mergeInto) || !optText(d.note)) return INVALID;
  if (d.surfaceAction != null && d.surfaceAction !== "add" && d.surfaceAction !== "block") return INVALID;
  if (d.action === "register" && d.role === "own" && !ecat.nz(d.brandCode)) return { ok: false as const, errorKey: "brand_required" };
  return written(await ecat.decideReview(reviewId, d));
}
