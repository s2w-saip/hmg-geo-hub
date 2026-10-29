"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/auth/errors";
import { canOperateProject } from "@/lib/auth/operator-policy";
import { projectRepository } from "@/lib/db/repositories/projects";
import { projectMemberRepository } from "@/lib/db/repositories/project-members";
import { memberAuditLogRepository } from "@/lib/db/repositories/member-audit-logs";
import {
  trackedBrandRepository,
  trackedCompetitorRepository,
  syncTrackedBrandCatalog,
  trackedVehicleRepository,
  flagPromptsForReanalysis,
} from "@/lib/db/repositories/tracked-entities";
import {
  addProjectTrackedUrl,
  updateProjectTrackedUrl,
  removeProjectTrackedUrl,
  listProjectTrackedUrls,
} from "@/lib/db/repositories/project-tracked-urls";
import {
  addProjectOwnedBase,
  listProjectOwnedBases,
  removeProjectOwnedBase,
} from "@/lib/db/repositories/project-owned-bases";
import {
  buildWorkbook,
  parseWorkbook,
} from "@/lib/tracked-urls/excel";
import { normalizeUrlForMatch } from "@/lib/scope/url-match";
import {
  pushScopeUpdate,
  deleteScopeMirror,
  syncScopeSchedule,
  attachScopeMirror,
} from "@/lib/scope/project-sync";
import { normalizeAiEngines, sameAiEngines } from "@/lib/scope/engines";

// Project setting actions for /projects/[id]/setting.
// - updateProject: rename / domain / description / brand. country is
//   immutable post-create (scope policy ties country to creator role).
// - deleteProject: hard delete with cascade (handled in the repository).
//   Confirmed via name re-entry on the client; final auth happens here.
// - promoteToOwner / demoteToViewer: Owner role transfer used by both the
//   member list (Task D) and reachable from settings if needed later.

export type ActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

async function requireOwner(projectId: string): Promise<{ userId: string }> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const userId = session.user.id;

  const project = await projectRepository.getById(projectId);
  if (!project) throw new UnauthorizedError("project not found");

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
    throw new UnauthorizedError("setting action requires active Owner");
  }
  return { userId };
}

// Read access for export — any active member (Owner/Viewer) or admin. Mirrors
// the page-level gate in page.tsx; export carries no mutation/cost.
async function requireMember(projectId: string): Promise<{ userId: string }> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const userId = session.user.id;

  const project = await projectRepository.getById(projectId);
  if (!project) throw new UnauthorizedError("project not found");

  if (session.user.role === "admin") return { userId };

  const membership = await projectMemberRepository.findMembership(
    projectId,
    userId,
  );
  if (!membership || membership.status !== "active") {
    throw new UnauthorizedError("tracked-url export requires active membership");
  }
  return { userId };
}

// Validate + normalize a tracked URL: http(s) only, canonicalized via URL().
// Returns the normalized string or an error message (shared by the add action
// and the Excel import path).
function normalizeTrackedUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "URL을 입력해주세요" };
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, error: "http(s):// URL만 등록할 수 있어요" };
    }
    return { ok: true, url: u.toString() };
  } catch {
    return { ok: false, error: "올바른 URL 형식이 아닙니다" };
  }
}

function normalizeOwnedBaseInput(
  raw: string,
): { ok: true; baseUrl: string } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Owned base URL을 입력해주세요" };
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { ok: false, error: "http(s):// URL만 등록할 수 있어요" };
    }
    const normalized = normalizeUrlForMatch(u.toString());
    if (!normalized) {
      return { ok: false, error: "올바른 owned base 형식이 아닙니다" };
    }
    return { ok: true, baseUrl: normalized };
  } catch {
    return { ok: false, error: "올바른 URL 형식이 아닙니다" };
  }
}

function normalizeAliasList(raw?: string[] | null): string[] | null {
  const aliases = [...new Set((raw ?? []).map((v) => v.trim()).filter(Boolean))];
  return aliases.length > 0 ? aliases : null;
}

async function syncLegacyProjectDomain(projectId: string): Promise<void> {
  const ownedBases = await listProjectOwnedBases(projectId);
  const primaryBase = ownedBases[0]?.baseUrl ?? null;
  const updated = await projectRepository.update(projectId, { domain: primaryBase });
  const { newScopeProjectId } = await pushScopeUpdate(updated);
  if (newScopeProjectId) {
    await attachScopeMirror(projectId, newScopeProjectId, updated.aiEngines);
  }
}

export async function updateProject(
  projectId: string,
  patch: {
    name?: string;
    description?: string | null;
    domain?: string | null;
    brand?: string | null;
    brandAliases?: string[] | null;
    brandAliasesBrand?: string | null;
    ga4PropertyId?: string | null;
  },
): Promise<ActionResult<{ reprocessable: number }>> {
  await requireOwner(projectId);
  const before = await projectRepository.getById(projectId);
  if (!before) return { ok: false, error: "프로젝트를 찾을 수 없습니다" };

  const cleaned: typeof patch = {};
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) return { ok: false, error: "프로젝트 명을 입력해주세요" };
    cleaned.name = trimmed;
  }
  if (patch.description !== undefined) {
    cleaned.description = patch.description?.trim() || null;
  }
  if (patch.domain !== undefined) {
    // canonical 저장: scheme/www/fragment/끝슬래시 제거, 소문자 (예:
    // 'https://www.KIA.com/it/' → 'kia.com/it'). KPI ⑥ 분모 프리픽스와 scope-
    // sync 호스트가 이 단일 값에서 파생된다 — 정책: docs/kpi6-domain-url-
    // normalization-policy.md.
    cleaned.domain = normalizeUrlForMatch(patch.domain) || null;
  }
  if (patch.brand !== undefined) {
    cleaned.brand = patch.brand?.trim() || null;
  }
  if (patch.ga4PropertyId !== undefined) {
    // GA4 Data API property ids are numeric (e.g. "469542848"). Empty → null
    // (fall back to the catalog). Reject anything non-numeric so a bad value
    // can't reach the GA4 request path.
    const raw = patch.ga4PropertyId?.trim() ?? "";
    if (raw && !/^\d+$/.test(raw)) {
      return { ok: false, error: "GA4 속성 ID는 숫자만 입력하세요 (예: 469542848)" };
    }
    cleaned.ga4PropertyId = raw || null;
  }

  const updated = await projectRepository.update(projectId, cleaned);
  const normalizedBrandAliases = normalizeAliasList(patch.brandAliases) ?? [];
  const brandChanged = (before.brand ?? null) !== (updated.brand ?? null);
  const brandAliasesTouched = patch.brandAliases !== undefined;
  const submittedAliasBrand = patch.brandAliasesBrand?.trim() || null;
  const aliasesMatchCurrentBrand =
    submittedAliasBrand !== null && submittedAliasBrand === (updated.brand ?? null);

  if (brandChanged && before.brand) {
    await trackedBrandRepository.deleteByCanonical(projectId, before.brand);
  }

  if (
    updated.brand &&
    brandAliasesTouched &&
    normalizedBrandAliases.length > 0 &&
    aliasesMatchCurrentBrand
  ) {
    await trackedBrandRepository.upsert({
      projectId,
      canonicalName: updated.brand,
      aliases: normalizedBrandAliases,
    });
  } else if (updated.brand && brandAliasesTouched) {
    await trackedBrandRepository.deleteByCanonical(projectId, updated.brand);
  }
  if (brandChanged || brandAliasesTouched) {
    await syncTrackedBrandCatalog(projectId);
  }

  // Propagate the edit to the scope mirror (or create it if a brand was just
  // added to a previously-unmirrored project). Best-effort — see project-sync.
  const { newScopeProjectId } = await pushScopeUpdate(updated);
  if (newScopeProjectId) {
    // 지연 미러 — 링크 + 저장된 엔진 선택 전파(attachScopeMirror).
    await attachScopeMirror(projectId, newScopeProjectId, updated.aiEngines);
  }

  const reprocessable =
    brandChanged || brandAliasesTouched
      ? await flagPromptsForReanalysis(projectId)
      : 0;

  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/setting`);
  revalidatePath(`/projects`);
  return { ok: true, value: { reprocessable } };
}

// AI 엔진 선택 변경 (Setting > General > AI 엔진). Owner/admin 전용.
//   - 저장 = projects.ai_engines 교체 + project_engine_history 1행 append
//     (변경 없으면 no-op — 이력이 같은 값으로 늘지 않게).
//   - scope schedule targets 로 전파(best-effort). 0개 선택 = 수집 중단
//     (enabled=false). 전파 실패는 에러가 아니라 pushed=false 로 알린다 —
//     로컬 값이 정본이고 다음 저장 때 재전파.
export async function updateProjectEngines(
  projectId: string,
  engines: string[],
): Promise<ActionResult<{ engines: string[]; changed: boolean; pushed: boolean }>> {
  const { userId } = await requireOwner(projectId);
  // 엔진 선택 = scope schedule targets = 반복 측정 비용 레버 → RUN 과 같은
  // operator 게이트(canOperateProject)를 추가로 건다(운영 결정 2026-08-18).
  // Owner 여도 operator=none(외부 수행사 등)이면 바꿀 수 없다. admin 은 통과.
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  const membership = await projectMemberRepository.findMembership(projectId, userId);
  if (!canOperateProject(session.user, membership)) {
    return { ok: false, error: "AI 엔진 변경 권한(운영자)이 없습니다" };
  }
  const before = await projectRepository.getById(projectId);
  if (!before) return { ok: false, error: "프로젝트를 찾을 수 없습니다" };

  const next = normalizeAiEngines(engines);
  // 레거시(NULL)는 "기본 2종 측정 중"이지만 명시 저장이 아니므로, 같은 값이라도
  // 첫 저장은 이력에 남긴다(그 시점부터 명시값). 명시값이 있고 같으면 no-op.
  const changed = before.aiEngines == null || !sameAiEngines(before.aiEngines, next);

  let scopeProjectId = before.scopeProjectId;
  if (changed) {
    await projectRepository.setAiEngines(projectId, next, userId);
  }
  // 미러가 없으면 (브랜드 없는 프로젝트 등) 만들어 본다 — 스케줄은 미러가 있어야
  // 걸린다. 미러 생성 조건은 pushScopeUpdate 규약 그대로(best-effort). 스케줄은
  // 아래에서 한 번만 민다(attachScopeMirror 를 쓰지 않는 이유 — reenable 전이
  // 정보를 함께 넘겨야 함).
  if (!scopeProjectId) {
    const { newScopeProjectId } = await pushScopeUpdate(before);
    if (newScopeProjectId) {
      await projectRepository.setScopeProjectId(projectId, newScopeProjectId);
      scopeProjectId = newScopeProjectId;
    }
  }
  // 직전 저장이 명시 [](우리가 enabled=false 로 내린 것)였고 지금 ≥1 이면 되켠다.
  const reenable =
    before.aiEngines != null && before.aiEngines.length === 0 && next.length > 0;
  const { pushed } = await syncScopeSchedule(
    { id: projectId, scopeProjectId, aiEngines: next },
    { reenable },
  );

  revalidatePath(`/projects/${projectId}/setting`);
  return { ok: true, value: { engines: next, changed, pushed } };
}

export async function deleteProject(
  projectId: string,
  confirmName: string,
  locale: string,
): Promise<ActionResult> {
  await requireOwner(projectId);

  const project = await projectRepository.getById(projectId);
  if (!project) return { ok: false, error: "프로젝트를 찾을 수 없습니다" };
  if (confirmName.trim() !== project.name) {
    return {
      ok: false,
      error: "입력한 이름이 프로젝트 명과 일치하지 않습니다",
    };
  }

  await projectRepository.delete(projectId);

  // Remove the scope mirror too (best-effort; a failed scope delete must not
  // block the local delete that already succeeded).
  await deleteScopeMirror(project.scopeProjectId);

  revalidatePath(`/projects`);
  redirect(`/${locale}/projects`);
}

// --- Task D: Owner role transfer ---

export async function promoteToOwner(
  projectId: string,
  membershipId: string,
): Promise<ActionResult> {
  const { userId: actorId } = await requireOwner(projectId);

  const all = await projectMemberRepository.listForProject(projectId);
  const target = all.find((m) => m.id === membershipId);
  if (!target) return { ok: false, error: "해당 멤버를 찾을 수 없습니다" };
  if (target.role === "owner") {
    return { ok: false, error: "이미 Owner입니다" };
  }
  if (target.status !== "active") {
    return { ok: false, error: "활성 상태의 멤버만 위임 가능합니다" };
  }

  await projectMemberRepository.setRole(membershipId, "owner");
  await memberAuditLogRepository.insert({
    projectId,
    actorId,
    targetUserId: target.userId,
    action: "promote",
    context: "viewer->owner",
  });
  revalidatePath(`/projects/${projectId}/member`);
  return { ok: true, value: undefined };
}

export async function demoteToViewer(
  projectId: string,
  membershipId: string,
): Promise<ActionResult> {
  const { userId: actorId } = await requireOwner(projectId);

  const all = await projectMemberRepository.listForProject(projectId);
  const target = all.find((m) => m.id === membershipId);
  if (!target) return { ok: false, error: "해당 멤버를 찾을 수 없습니다" };
  if (target.role !== "owner") {
    return { ok: false, error: "Viewer는 이미 Viewer입니다" };
  }

  const activeOwners = all.filter(
    (m) => m.role === "owner" && m.status === "active",
  );
  if (activeOwners.length <= 1) {
    return { ok: false, error: "마지막 Owner는 강등할 수 없습니다" };
  }

  await projectMemberRepository.setRole(membershipId, "viewer");
  await memberAuditLogRepository.insert({
    projectId,
    actorId,
    targetUserId: target.userId,
    action: "demote",
    context: "owner->viewer",
  });
  revalidatePath(`/projects/${projectId}/member`);
  return { ok: true, value: undefined };
}

// ─── Task P3: designated brands + vehicles + reprocess plumbing ──────────
//
// Add/remove on either list returns ok along with the count of prompts
// flagged for reanalysis. The Settings page surfaces that count in a
// follow-up dialog: if > 0, ask the operator to confirm reanalysis;
// otherwise just toast success. The flagging itself is fire-and-forget —
// the actual analyzer worker (separate process) consumes the flag.

const PATH = (id: string) => `/projects/${id}/setting`;

export async function addTrackedCompetitor(
  projectId: string,
  input: { brandName: string; aliases?: string[] | null; notes?: string | null },
): Promise<ActionResult<{ id: string; reprocessable: number }>> {
  await requireOwner(projectId);
  const brandName = input.brandName.trim();
  if (!brandName) return { ok: false, error: "브랜드 이름을 입력해주세요" };

  try {
    const created = await trackedCompetitorRepository.insert({
      projectId,
      brandName,
      aliases: normalizeAliasList(input.aliases),
      notes: input.notes?.trim() || null,
    });
    await syncTrackedBrandCatalog(projectId);
    const reprocessable = await flagPromptsForReanalysis(projectId);
    revalidatePath(PATH(projectId));
    return { ok: true, value: { id: created.id, reprocessable } };
  } catch (e) {
    // unique (project_id, brand_name) collision surfaces here. Treat as
    // user error — surface a friendly message rather than a 500.
    if (e instanceof Error && e.message.includes("unique")) {
      return { ok: false, error: "이미 추가된 브랜드입니다" };
    }
    throw e;
  }
}

export async function removeTrackedCompetitor(
  projectId: string,
  id: string,
): Promise<ActionResult<{ reprocessable: number }>> {
  await requireOwner(projectId);
  await trackedCompetitorRepository.delete(id);
  await syncTrackedBrandCatalog(projectId);
  const reprocessable = await flagPromptsForReanalysis(projectId);
  revalidatePath(PATH(projectId));
  return { ok: true, value: { reprocessable } };
}

// KPI #16 비교 기준 브랜드 지정/해제 — 분석 라벨과 무관한 집계 시점 설정이라
// 재분석 플래그를 만들지 않는다. id=null → 해제(SOV 1위 외부 브랜드 자동 선택
// 폴백).
export async function setTargetCompetitor(
  projectId: string,
  id: string | null,
): Promise<ActionResult> {
  await requireOwner(projectId);
  await trackedCompetitorRepository.setTarget(projectId, id);
  revalidatePath(PATH(projectId));
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, value: undefined };
}

export async function addTrackedVehicle(
  projectId: string,
  input: {
    brand: string;
    model: string;
    segment?: string | null;
    aliases?: string[] | null;
  },
): Promise<ActionResult<{ id: string; reprocessable: number }>> {
  await requireOwner(projectId);
  const brand = input.brand.trim();
  const model = input.model.trim();
  if (!brand) return { ok: false, error: "브랜드를 입력해주세요" };
  if (!model) return { ok: false, error: "모델명을 입력해주세요" };

  try {
    const created = await trackedVehicleRepository.insert({
      projectId,
      brand,
      model,
      segment: input.segment?.trim() || null,
      aliases: normalizeAliasList(input.aliases),
    });
    // 모델 등록 시 그 브랜드를 "추적 브랜드" 목록에도 자동 등록한다 —
    // syncTrackedBrandCatalog는 이미 vehicle.brand를 분석용 카탈로그에
    // 병합하므로 답변 분석은 브랜드를 인식하지만, trackedCompetitors 기반의
    // "추적 브랜드" UI 목록/KPI#16 비교 기준 지정 화면에는 반영되지 않아
    // 사용자가 "모델은 추가됐는데 브랜드는 안 보인다"고 오인하는 불일치가
    // 있었다. 프로젝트 자체 브랜드(project.brand)는 별도 경로로 항상
    // 포함되므로 중복 등록하지 않는다.
    const project = await projectRepository.getById(projectId);
    if (brand !== (project?.brand ?? null)) {
      const existingBrands = await trackedCompetitorRepository.listForProject(projectId);
      if (!existingBrands.some((row) => row.brandName === brand)) {
        try {
          await trackedCompetitorRepository.insert({ projectId, brandName: brand });
        } catch (e) {
          if (!(e instanceof Error && e.message.includes("unique"))) throw e;
        }
      }
    }
    await syncTrackedBrandCatalog(projectId);
    const reprocessable = await flagPromptsForReanalysis(projectId);
    revalidatePath(PATH(projectId));
    return { ok: true, value: { id: created.id, reprocessable } };
  } catch (e) {
    if (e instanceof Error && e.message.includes("unique")) {
      return { ok: false, error: "이미 추가된 모델입니다" };
    }
    throw e;
  }
}

export async function removeTrackedVehicle(
  projectId: string,
  id: string,
): Promise<ActionResult<{ reprocessable: number }>> {
  await requireOwner(projectId);
  await trackedVehicleRepository.delete(id);
  await syncTrackedBrandCatalog(projectId);
  const reprocessable = await flagPromptsForReanalysis(projectId);
  revalidatePath(PATH(projectId));
  return { ok: true, value: { reprocessable } };
}

export async function addProjectOwnedBaseAction(
  projectId: string,
  input: { baseUrl: string; label?: string | null },
): Promise<ActionResult<{ id: string }>> {
  const { userId } = await requireOwner(projectId);
  const norm = normalizeOwnedBaseInput(input.baseUrl);
  if (!norm.ok) return { ok: false, error: norm.error };
  const label = input.label?.trim() || null;
  try {
    const created = await addProjectOwnedBase({
      projectId,
      baseUrl: norm.baseUrl,
      label,
      createdBy: userId,
    });
    await syncLegacyProjectDomain(projectId);
    revalidatePath(PATH(projectId));
    return { ok: true, value: { id: created.id } };
  } catch (e) {
    if (e instanceof Error && e.message.includes("unique")) {
      return { ok: false, error: "이미 등록된 owned base예요" };
    }
    throw e;
  }
}

export async function removeProjectOwnedBaseAction(
  projectId: string,
  id: string,
): Promise<ActionResult> {
  await requireOwner(projectId);
  await removeProjectOwnedBase(id, projectId);
  await syncLegacyProjectDomain(projectId);
  revalidatePath(PATH(projectId));
  return { ok: true, value: undefined };
}

// 추적 URL CRUD — KPI ⑥ AI 타겟 URL 인용률의 분자. URL은 정확한 경로
// (https://kia.com/it/it/ioniq). 형식 검증은 new URL() 으로 한 번에 — 잘못된
// 입력이면 throw → 에러 메시지로 표시. 측정 wiring(KPI 활성)은 별도 작업.
export async function addProjectTrackedUrlAction(
  projectId: string,
  input: { url: string; label?: string | null },
): Promise<ActionResult<{ id: string }>> {
  const { userId } = await requireOwner(projectId);
  const norm = normalizeTrackedUrl(input.url);
  if (!norm.ok) return { ok: false, error: norm.error };
  const label = input.label?.trim() || null;
  try {
    const created = await addProjectTrackedUrl({
      projectId,
      url: norm.url,
      label,
      createdBy: userId,
    });
    revalidatePath(PATH(projectId));
    return { ok: true, value: { id: created.id } };
  } catch (e) {
    if (e instanceof Error && e.message.includes("unique")) {
      return { ok: false, error: "이미 등록된 URL이에요" };
    }
    throw e;
  }
}

export async function removeProjectTrackedUrlAction(
  projectId: string,
  id: string,
): Promise<ActionResult> {
  await requireOwner(projectId);
  await removeProjectTrackedUrl(id, projectId);
  revalidatePath(PATH(projectId));
  return { ok: true, value: undefined };
}

// "엑셀 내보내기" — serializes the project's tracked URLs to .xlsx, returned
// base64 so the client can trigger a download. Read-only → any active member.
export async function exportTrackedUrlsXlsx(
  projectId: string,
): Promise<ActionResult<{ base64: string; filename: string }>> {
  await requireMember(projectId);
  const rows = await listProjectTrackedUrls(projectId);
  const buf = await buildWorkbook(
    rows.map((r) => ({ id: r.id, url: r.url, label: r.label })),
  );
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return {
    ok: true,
    value: {
      base64: buf.toString("base64"),
      filename: `tracked-urls-${projectId.slice(0, 8)}-${stamp}.xlsx`,
    },
  };
}

export interface TrackedUrlImportSummary {
  created: number;
  updated: number;
  skipped: number;
  warnings: string[];
}

// "엑셀 가져오기" — parses an uploaded .xlsx and upserts tracked URLs by id.
// Owner-only (requireOwner), matching the add/remove authority. A row with an
// id updates the matching URL in this project (url is re-validated/normalized;
// label only changes when the `label` column is present). A row without an id
// inserts a new URL. (project_id, url) uniqueness is DB-enforced — collisions
// are reported as skips, not failures.
export async function importTrackedUrlsXlsx(
  projectId: string,
  formData: FormData,
): Promise<ActionResult<TrackedUrlImportSummary>> {
  const { userId } = await requireOwner(projectId);

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, error: "업로드된 파일이 없습니다" };
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const { rows, warnings } = await parseWorkbook(buffer);

  const existing = await listProjectTrackedUrls(projectId);
  const byId = new Map(existing.map((u) => [u.id, u]));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    // Validate URL up front when one is present (required for inserts; an
    // update may carry only a label).
    let normalizedUrl: string | undefined;
    if (row.url != null) {
      const norm = normalizeTrackedUrl(row.url);
      if (!norm.ok) {
        skipped += 1;
        warnings.push(`행 ${row.rowNumber}: ${norm.error} — 건너뜀`);
        continue;
      }
      normalizedUrl = norm.url;
    }

    const label = row.label === undefined ? undefined : (row.label ?? null);

    try {
      if (row.id) {
        const current = byId.get(row.id);
        if (!current) {
          skipped += 1;
          warnings.push(
            `행 ${row.rowNumber}: id를 이 프로젝트에서 찾을 수 없어 건너뜀 — 신규 등록은 id 칸을 비워두세요`,
          );
          continue;
        }
        const patch: { url?: string; label?: string | null } = {};
        if (normalizedUrl && normalizedUrl !== current.url) {
          patch.url = normalizedUrl;
        }
        if (label !== undefined && label !== current.label) {
          patch.label = label;
        }
        if (Object.keys(patch).length === 0) {
          skipped += 1;
          continue;
        }
        await updateProjectTrackedUrl(row.id, projectId, patch);
        updated += 1;
      } else {
        if (!normalizedUrl) {
          skipped += 1;
          warnings.push(`행 ${row.rowNumber}: id·URL이 없어 건너뜀`);
          continue;
        }
        await addProjectTrackedUrl({
          projectId,
          url: normalizedUrl,
          label: label ?? null,
          createdBy: userId,
        });
        created += 1;
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("unique")) {
        skipped += 1;
        warnings.push(`행 ${row.rowNumber}: 이미 등록된 URL이라 건너뜀`);
        continue;
      }
      throw e;
    }
  }

  revalidatePath(PATH(projectId));
  return { ok: true, value: { created, updated, skipped, warnings } };
}

/**
 * "Reprocess" confirmation handler — surfaced as a follow-up dialog after
 * tracked-entity mutations when reprocessable > 0. For now this is a
 * stub: the rows are already flagged by the mutation above, so this
 * action just logs intent and returns. When a real analyzer worker
 * lands, it'll enqueue a job here. Keep the return ok: true so the
 * dialog closes cleanly.
 */
export async function triggerReprocess(
  projectId: string,
): Promise<ActionResult<{ flagged: number }>> {
  await requireOwner(projectId);
  const flagged = await flagPromptsForReanalysis(projectId);
  console.log(
    `[reprocess] project=${projectId} flagged=${flagged} prompts — analyzer worker (TBD) will consume`,
  );
  revalidatePath(PATH(projectId));
  return { ok: true, value: { flagged } };
}
