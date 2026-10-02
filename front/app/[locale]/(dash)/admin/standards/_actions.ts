"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth/session";
import { canAccessAdmin } from "@/lib/auth/scope-policy";
import { UnauthorizedError } from "@/lib/auth/errors";
import {
  standardPromptRepository,
  standardKeywordRepository,
  standardSourceRepository,
  type StandardKeywordSource,
  type StandardSourceChannel,
} from "@/lib/db/repositories/standards";
import { promptRepository, type PromptType } from "@/lib/db/repositories/prompts";
import { STANDARD_ROOT_PROJECT_ID } from "@/lib/db/repositories/standards";
import { createRootPrompt, updateRootPrompt, getProject } from "@/lib/scope/server";
import { getRootConfig } from "@/lib/scope/result-adapter";
import {
  normalizePromptRegions,
  normalizePromptLang,
  regionsForAudit,
  sameRegions,
} from "@/lib/standards/prompt-regions";
import { encodeStandardKeywords } from "./_prompt-scope";
import {
  applyAuditedCatalogChange,
  createAuditedCatalogPrompt,
  promptAuditLogRepository,
} from "@/lib/db/repositories/prompt-audit-logs";
import { computeChanges, type PromptAuditChanges } from "@/lib/standards/audit";
import { buildCatalogWorkbook, parseCatalogWorkbook } from "@/lib/standards/excel";
import { listStandardCatalog } from "@/lib/db/repositories/standards";
import type { PromptRow } from "@/lib/db/schema";
import * as api from "@/lib/hgh/adapters/admin";

// Admin-only mutation actions for /admin/standards/{prompts,customer-interest}.
// Same shape as the other admin actions: Result tagged for inline form errors;
// UnauthorizedError thrown for access-control violations so it surfaces as a
// 500 (which Next renders as a friendly error boundary, not a silent fail).
//
// Source (D8, HGH_SOURCE_G7): each action keeps its gate and the local input checks, then the
// api source hands the write to lib/hgh/adapters/admin.ts (/v1/admin/catalog/prompts*,
// /v1/admin/interest/*) and keeps these result shapes and messages; legacy runs the code below
// unchanged. On the api source Scope is reached through the backend outbox (DC-18): the audit
// rows are written by the database trigger, and a Scope failure no longer rolls the row back.

export type ActionResult<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string };

async function requireAdmin(): Promise<{ userId: string }> {
  const session = await getSession();
  if (!session || !canAccessAdmin(session.user)) {
    throw new UnauthorizedError("admin standards action requires role=admin");
  }
  return { userId: session.user.id };
}

// v1 편집 게이트 = admin. hq 개방 시 이 함수 한 곳만 바꾼다 (catalog-prompt-audit).
async function requireCatalogEditor(): Promise<{ userId: string }> {
  return requireAdmin();
}

const PROMPTS_PATH = "/admin/standards/prompts";
const KEYWORDS_PATH = "/admin/standards/customer-interest";

// ─── standard_prompts ────────────────────────────────────────────────────

// catalog-prompt-audit: 로컬 카탈로그 행 + created 이벤트 + scope 생성·링크를
// 한 트랜잭션으로 정규화. (구 구현은 scope 단독 생성이라 로컬 카탈로그에 행이
// 없는 scope orphan을 만들었고, mock 폴백이 쓰던 standard_prompts 레거시 행은
// listStandardCatalog가 읽지 않는 죽은 데이터였다.)
export async function createStandardPrompt(
  input: {
    text: string;
    promptType?: PromptType | null;
    category?: string | null;
    brand?: string | null;
  },
): Promise<ActionResult<{ id: string }>> {
  const { userId } = await requireCatalogEditor();
  const text = input.text.trim();
  if (!text) return { ok: false, error: "프롬프트 내용을 입력해주세요" };

  const promptType = input.promptType ?? null;
  const category = input.category?.trim() || null;
  const brand = input.brand?.trim() || null;

  if (api.isAdminApi()) {
    const r = await api.createCatalogPrompt({ text, promptType, category, brand });
    if (r.ok) revalidatePath(PROMPTS_PATH);
    return r;
  }

  try {
    const created = await createAuditedCatalogPrompt({
      actorId: userId,
      values: { text, promptType, category, brand },
      pushScope: async () => {
        const scoped = await createRootPrompt({
          text,
          keywords: encodeStandardKeywords({ promptType, category, brand }),
        });
        return scoped ? { scopePromptId: scoped.prompt_id } : null;
      },
    });
    revalidatePath(PROMPTS_PATH);
    return { ok: true, value: { id: created.id } };
  } catch {
    return { ok: false, error: "생성에 실패했습니다" };
  }
}

// deprecated: soft-delete(softDeleteStandardPrompt)가 은퇴 의미론을 대체 — 현
// UI에는 미배선. 유지 이유 = 외부 호출 호환. 로컬 카탈로그 행이 있으면
// enabled_changed 감사 이벤트를 남긴다(로컬 컬럼 변경이 없어 composite 불필요).
export async function toggleStandardPromptEnabled(
  id: string,
  enabled: boolean,
): Promise<ActionResult> {
  const { userId } = await requireCatalogEditor();
  if (api.isAdminApi()) return api.unsupportedCatalogToggle(); // U11-N5
  // `id` is the scope prompt_id in live mode (enabled → scope `enabled`),
  // else the local row id. ⚠️ scope 의 `active` 는 soft-delete 여부라 여기서
  // 쓰면 안 된다 — 그 혼동이 #475 사고였다.
  const updated = await updateRootPrompt(id, { enabled });
  if (!updated) await standardPromptRepository.update(id, { enabled });
  const local = await promptRepository.getByScopePromptId(id);
  if (local) {
    await promptAuditLogRepository.insert({
      promptId: local.id,
      projectId: STANDARD_ROOT_PROJECT_ID,
      actorId: userId,
      eventType: "enabled_changed",
      changes: { enabled: { old: String(!enabled), new: String(enabled) } },
    });
  }
  revalidatePath(PROMPTS_PATH);
  return { ok: true, value: undefined };
}

// 측정 종류 전환 ('single' ↔ 'acr') — 표준 카탈로그(prompts 테이블) 행 대상.
// scope 먼저 PATCH하고 성공해야 로컬을 바꾼다 (실패 시 로컬 불변 → drift 방지).
// scope 미연결(미추적) 행은 로컬만 바꾼다 — 이후 reconcile push가 kind째 생성.
// 주의: 'acr' 전환은 다음 측정 주기부터 그 프롬프트를 2턴×acr_iterations(기본
// 10회) 측정으로 바꾼다 — 셀당 측정량 ~20배. UI가 확인 다이얼로그로 안내한다.
export async function setStandardPromptKind(
  id: string,
  kind: "single" | "acr",
): Promise<ActionResult> {
  const { userId } = await requireCatalogEditor();
  if (kind !== "single" && kind !== "acr") {
    return { ok: false, error: "지원하지 않는 측정 종류입니다" };
  }
  if (api.isAdminApi()) {
    const r = await api.setCatalogKind(id, kind);
    if (r.ok) revalidatePath(PROMPTS_PATH);
    return r;
  }
  const row = await promptRepository.getById(id);
  if (!row || row.projectId !== STANDARD_ROOT_PROJECT_ID) {
    return { ok: false, error: "표준 카탈로그 행을 찾을 수 없습니다" };
  }
  if (row.kind === kind) return { ok: true, value: undefined };
  const scopePromptId = row.scopePromptId;
  try {
    await applyAuditedCatalogChange({
      promptId: id,
      actorId: userId,
      eventType: "kind_changed",
      patch: { kind },
      changes: { kind: { old: row.kind, new: kind } },
      applyScope: scopePromptId
        ? async () => {
            await updateRootPrompt(scopePromptId, { kind });
          }
        : undefined,
    });
  } catch {
    return { ok: false, error: "scope 반영에 실패했습니다 — 잠시 후 다시 시도해주세요" };
  }
  revalidatePath(PROMPTS_PATH);
  return { ok: true, value: undefined };
}

// catalog-prompt-audit: 물리 삭제 폐지 — soft-delete로 위임 (복원 가능·이력 보존).
export async function deleteStandardPrompt(id: string): Promise<ActionResult> {
  return softDeleteStandardPrompt(id);
}

// ─── catalog-prompt-audit: 단건 편집 · soft-delete · 복원 ─────────────────
// id = 로컬 카탈로그 행 id (prompts.id) — setStandardPromptKind와 동일 규약.
// 쓰기는 전부 composite(로컬 UPDATE + 로그 INSERT + Scope 콜백 원자) 경유.

const CATALOG_LABEL_FIELDS = [
  "promptType",
  "category",
  "brand",
  "brandPresence",
  "listType",
  "depth1",
  "depth2",
  "depth3",
  "depth4",
  "funnelStage",
] as const;

export type CatalogLabelsPatch = Partial<
  Record<(typeof CATALOG_LABEL_FIELDS)[number], string | null>
>;

type CatalogRowResult = { ok: true; row: PromptRow } | { ok: false; error: string };

async function getCatalogRowOr(id: string): Promise<CatalogRowResult> {
  const row = await promptRepository.getById(id);
  if (!row || row.projectId !== STANDARD_ROOT_PROJECT_ID) {
    return { ok: false, error: "글로벌 카탈로그 행을 찾을 수 없습니다" };
  }
  return { ok: true, row };
}

export async function updateStandardPromptText(
  id: string,
  text: string,
): Promise<ActionResult> {
  const { userId } = await requireCatalogEditor();
  const next = text.trim();
  if (!next) return { ok: false, error: "프롬프트 내용을 입력해주세요" };
  if (api.isAdminApi()) {
    const r = await api.updateCatalogText(id, next);
    if (r.ok) revalidatePath(PROMPTS_PATH);
    return r;
  }
  const got = await getCatalogRowOr(id);
  if (!got.ok) return got;
  const changes = computeChanges({ text: got.row.text }, { text: next }, ["text"]);
  if (Object.keys(changes).length === 0) return { ok: true, value: undefined };
  const scopePromptId = got.row.scopePromptId;
  try {
    await applyAuditedCatalogChange({
      promptId: id,
      actorId: userId,
      eventType: "text_updated",
      patch: { text: next },
      changes,
      applyScope: scopePromptId
        ? async () => {
            await updateRootPrompt(scopePromptId, { text: next });
          }
        : undefined,
    });
  } catch {
    return { ok: false, error: "저장에 실패했습니다 — scope 반영 실패 시 로컬도 롤백됩니다" };
  }
  revalidatePath(PROMPTS_PATH);
  return { ok: true, value: undefined };
}

export async function updateStandardPromptLabels(
  id: string,
  labels: CatalogLabelsPatch,
): Promise<ActionResult> {
  const { userId } = await requireCatalogEditor();
  if (api.isAdminApi()) {
    const r = await api.updateCatalogLabels(id, labels);
    if (r.ok) revalidatePath(PROMPTS_PATH);
    return r;
  }
  const got = await getCatalogRowOr(id);
  if (!got.ok) return got;
  const row = got.row;
  const before = Object.fromEntries(
    CATALOG_LABEL_FIELDS.map((f) => [f, row[f as keyof PromptRow] ?? null]),
  );
  const changes = computeChanges(before, labels, [...CATALOG_LABEL_FIELDS]);
  if (Object.keys(changes).length === 0) return { ok: true, value: undefined };
  // scope에는 keywords(promptType/category/brand 인코딩)만 존재한다 — 로컬
  // funnelStage(한국어 자유 텍스트)는 scope FunnelStage enum과 다른 축이라
  // 전파하지 않는다(생성 경로와 동일 규약).
  const scopeVisibleChanged =
    "promptType" in changes || "category" in changes || "brand" in changes;
  const nextMeta = {
    promptType: (labels.promptType !== undefined
      ? labels.promptType
      : row.promptType) as PromptType | null,
    category: labels.category !== undefined ? labels.category : row.category,
    brand: labels.brand !== undefined ? labels.brand : row.brand,
  };
  const scopePromptId = row.scopePromptId;
  try {
    await applyAuditedCatalogChange({
      promptId: id,
      actorId: userId,
      eventType: "meta_updated",
      patch: labels,
      changes,
      applyScope:
        scopePromptId && scopeVisibleChanged
          ? async () => {
              await updateRootPrompt(scopePromptId, {
                keywords: encodeStandardKeywords(nextMeta),
              });
            }
          : undefined,
    });
  } catch {
    return { ok: false, error: "저장에 실패했습니다 — scope 반영 실패 시 로컬도 롤백됩니다" };
  }
  revalidatePath(PROMPTS_PATH);
  return { ok: true, value: undefined };
}

// ─── H5: 시장·언어 편집 ──────────────────────────────────────────────────
// `CatalogLabelsPatch` 는 `string | null` 계약이라 `text[]` 를 욱여넣지 않는다 —
// `kind` 가 별도 액션인 것과 같은 규약이다.
//
// 어휘(선택 가능한 시장)는 **서버가 루트 프로젝트 실황에서 직접 가져온다.**
// 클라이언트가 보낸 목록을 상한으로 쓰면 그건 상한이 아니다(scope-policy 의
// "서버 파생 필터" 원칙과 같은 이유). UI 도 같은 값을 받아 그리므로 화면과
// 검증이 갈리지 않는다.
async function rootMarketVocabulary(): Promise<string[] | null> {
  const root = getRootConfig();
  if (!root) return null;
  try {
    const project = await getProject(root.projectId);
    const regions = project?.regions;
    return Array.isArray(regions) && regions.length > 0 ? regions : null;
  } catch (err) {
    // 어휘를 못 읽었다고 편집을 막지 않는다 — 상한이 없는 상태로 형식 검사만
    // 남긴다. 반대로 굴면 scope 가 잠깐 흔들릴 때 어드민이 통째로 잠긴다.
    console.warn("[standards] 루트 시장 어휘 조회 실패 — 형식 검사만 적용:", err);
    return null;
  }
}

/** 편집 UI 가 멀티셀렉트를 그릴 때 쓰는 어휘. 서버 컴포넌트에서 호출한다. */
export async function getStandardMarketVocabulary(): Promise<string[]> {
  await requireCatalogEditor();
  if (api.isAdminApi()) return api.catalogMarketVocabularyForScreen();
  return (await rootMarketVocabulary()) ?? [];
}

export interface StandardPromptRegionsPatch {
  /** 미지정(상속)으로 되돌리려면 `null`. 생략하면 건드리지 않는다. */
  regions?: string[] | null;
  lang?: string | null;
}

export async function updateStandardPromptRegions(
  id: string,
  patch: StandardPromptRegionsPatch,
): Promise<ActionResult> {
  const { userId } = await requireCatalogEditor();
  if (api.isAdminApi()) {
    const r = await api.updateCatalogRegions(id, patch);
    if (r.ok) revalidatePath(PROMPTS_PATH);
    return r;
  }
  const got = await getCatalogRowOr(id);
  if (!got.ok) return got;
  const row = got.row;

  const vocabulary = await rootMarketVocabulary();
  const nextRegions =
    patch.regions !== undefined ? normalizePromptRegions(patch.regions, vocabulary) : null;
  if (nextRegions) {
    // 형식 오류와 어휘 밖을 **구분해서** 알린다 — 사용자가 오타를 고쳐야 하는지
    // 프로젝트 시장 설정을 바꿔야 하는지가 다르다.
    if (nextRegions.invalid.length > 0) {
      return { ok: false, error: `시장 코드 형식이 아닙니다: ${nextRegions.invalid.join(", ")}` };
    }
    if (nextRegions.outOfVocabulary.length > 0) {
      return {
        ok: false,
        error: `이 프로젝트의 측정 시장이 아닙니다: ${nextRegions.outOfVocabulary.join(", ")}`,
      };
    }
  }
  const nextLang = patch.lang !== undefined ? normalizePromptLang(patch.lang) : null;
  if (nextLang?.invalid) {
    return { ok: false, error: `언어 코드 형식이 아닙니다: ${nextLang.invalid}` };
  }

  // 변경 없음을 조기 반환 — 빈 감사 로그가 쌓이면 이력이 신호를 잃는다.
  const regionsChanged =
    patch.regions !== undefined && !sameRegions(row.regions, nextRegions?.value ?? null);
  const langChanged = patch.lang !== undefined && (row.lang ?? null) !== (nextLang?.value ?? null);
  if (!regionsChanged && !langChanged) return { ok: true, value: undefined };

  const changes: PromptAuditChanges = {};
  if (regionsChanged) {
    // ⚠️ 배열이 아니라 **정렬 CSV** 로 넣는다 — computeChanges 는 String(v)
    // 직렬화라 순서만 다른 같은 집합이 가짜 변경으로 남는다.
    changes.regions = {
      old: regionsForAudit(row.regions),
      new: regionsForAudit(nextRegions?.value ?? null),
    };
  }
  if (langChanged) {
    changes.lang = { old: row.lang ?? null, new: nextLang?.value ?? null };
  }

  const scopePromptId = row.scopePromptId;
  try {
    await applyAuditedCatalogChange({
      promptId: id,
      actorId: userId,
      eventType: "meta_updated",
      patch: {
        ...(regionsChanged ? { regions: nextRegions?.value ?? null } : {}),
        ...(langChanged ? { lang: nextLang?.value ?? null } : {}),
      },
      changes,
      // scope 에는 **시장만** 전파한다. `lang` 은 표시·필터·언어 프리셋 전용이며
      // 측정 축이 아니다(scope 0137 의 컬럼 주석이 정본) — 잡 생성에 관여하지
      // 않는 값을 굳이 왕복시키지 않는다.
      applyScope:
        scopePromptId && regionsChanged
          ? async () => {
              await updateRootPrompt(scopePromptId, { regions: nextRegions?.value ?? null });
            }
          : undefined,
    });
  } catch {
    return { ok: false, error: "저장에 실패했습니다 — scope 반영 실패 시 로컬도 롤백됩니다" };
  }
  revalidatePath(PROMPTS_PATH);
  return { ok: true, value: undefined };
}

/**
 * 다중선택 일괄 시장 설정 (D8). 감사는 **건별 1행** — 한 줄로 묶으면 나중에
 * "이 프롬프트가 언제 왜 바뀌었나"를 프롬프트 단위로 못 읽는다.
 * 부분 성공을 허용하고 실패 건을 그대로 돌려준다(전부 롤백하면 한 건의 오타가
 * 199건의 정상 변경을 되돌린다).
 */
export async function bulkSetStandardPromptRegions(
  ids: string[],
  regions: string[] | null,
): Promise<ActionResult<{ updated: number; failed: Array<{ id: string; error: string }> }>> {
  await requireCatalogEditor();
  if (ids.length === 0) return { ok: false, error: "선택된 행이 없습니다" };
  if (api.isAdminApi()) {
    const r = await api.bulkCatalogRegions(ids, regions);
    revalidatePath(PROMPTS_PATH);
    return r;
  }
  let updated = 0;
  const failed: Array<{ id: string; error: string }> = [];
  for (const id of ids) {
    const r = await updateStandardPromptRegions(id, { regions });
    if (r.ok) updated++;
    else failed.push({ id, error: r.error });
  }
  revalidatePath(PROMPTS_PATH);
  return { ok: true, value: { updated, failed } };
}

export async function softDeleteStandardPrompt(id: string): Promise<ActionResult> {
  const { userId } = await requireCatalogEditor();
  if (api.isAdminApi()) {
    const r = await api.softDeleteCatalogPrompt(id);
    if (r.ok) revalidatePath(PROMPTS_PATH);
    return r;
  }
  const got = await getCatalogRowOr(id);
  if (!got.ok) return got;
  if (got.row.deletedAt) return { ok: true, value: undefined };
  const scopePromptId = got.row.scopePromptId;
  try {
    await applyAuditedCatalogChange({
      promptId: id,
      actorId: userId,
      eventType: "deleted",
      patch: { deletedAt: new Date() },
      changes: { deleted: { old: "false", new: "true" } },
      applyScope: scopePromptId
        ? async () => {
            await updateRootPrompt(scopePromptId, { enabled: false });
          }
        : undefined,
    });
  } catch {
    return { ok: false, error: "삭제에 실패했습니다" };
  }
  revalidatePath(PROMPTS_PATH);
  return { ok: true, value: undefined };
}

export async function restoreStandardPrompt(id: string): Promise<ActionResult> {
  const { userId } = await requireCatalogEditor();
  if (api.isAdminApi()) {
    const r = await api.restoreCatalogPrompt(id);
    if (r.ok) revalidatePath(PROMPTS_PATH);
    return r;
  }
  const got = await getCatalogRowOr(id);
  if (!got.ok) return got;
  if (!got.row.deletedAt) return { ok: true, value: undefined };
  const scopePromptId = got.row.scopePromptId;
  try {
    await applyAuditedCatalogChange({
      promptId: id,
      actorId: userId,
      eventType: "restored",
      patch: { deletedAt: null },
      changes: { deleted: { old: "true", new: "false" } },
      applyScope: scopePromptId
        ? async () => {
            await updateRootPrompt(scopePromptId, { enabled: true });
          }
        : undefined,
    });
  } catch {
    return { ok: false, error: "복원에 실패했습니다" };
  }
  revalidatePath(PROMPTS_PATH);
  return { ok: true, value: undefined };
}

// ─── catalog-prompt-audit: 벌크 xlsx (export / preview / chunk apply) ─────
// 585행 × Scope PATCH를 한 서버 액션에서 돌리면 서버리스 타임아웃 위험이라,
// preview가 적용 페이로드를 돌려주고 클라이언트가 CHUNK_LIMIT 단위로 순차
// 호출한다. 권한은 매 호출 requireCatalogEditor().

const CHUNK_LIMIT = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BULK_DIFF_FIELDS = ["text", ...CATALOG_LABEL_FIELDS] as const;

export interface CatalogBulkItem {
  id: string;
  text?: string;
  labels: CatalogLabelsPatch;
  /** H5. `undefined` = 불변, `null` = 미지정(전체)로 되돌림. */
  regions?: string[] | null;
  lang?: string | null;
  /** api source: the backend preview item, sent back verbatim to bulk/apply. */
  api?: Record<string, unknown>;
}

export interface CatalogImportPreviewItem {
  id: string;
  currentText: string;
  changes: PromptAuditChanges; // 필드별 old/new — UI 프리뷰 표가 그대로 렌더
  item: CatalogBulkItem; // apply 시 청크로 되돌려 보낼 페이로드
}

export interface CatalogImportPreview {
  items: CatalogImportPreviewItem[];
  unmatchedIds: string[];
  unchanged: number;
  warnings: string[];
  batchId: string; // 서버 생성 uuid — 청크 호출들이 공유
}

export interface CatalogChunkResult {
  applied: number;
  failed: { id: string; error: string }[];
}

function diffAgainstRow(row: PromptRow, item: CatalogBulkItem): PromptAuditChanges {
  const before = Object.fromEntries(
    BULK_DIFF_FIELDS.map((f) => [f, row[f as keyof PromptRow] ?? null]),
  );
  const after: Record<string, unknown> = { ...item.labels };
  if (item.text !== undefined) after.text = item.text;
  const changes = computeChanges(before, after, [...BULK_DIFF_FIELDS]);
  // 시장·언어는 BULK_DIFF_FIELDS 밖에서 따로 센다 — regions 가 배열이라
  // computeChanges 의 String(v) 직렬화에 그대로 태우면 순서 차이가 가짜 변경이
  // 된다. 정렬 CSV 로 비교하고, 로그에도 그 형태로 남긴다.
  if (item.regions !== undefined && !sameRegions(row.regions, item.regions)) {
    changes.regions = { old: regionsForAudit(row.regions), new: regionsForAudit(item.regions) };
  }
  if (item.lang !== undefined && (row.lang ?? null) !== item.lang) {
    changes.lang = { old: row.lang ?? null, new: item.lang };
  }
  return changes;
}

export async function exportStandardCatalogXlsx(): Promise<
  ActionResult<{ base64: string; filename: string }>
> {
  await requireCatalogEditor();
  if (api.isAdminApi()) return api.exportCatalogXlsx();
  const { rows } = await listStandardCatalog(); // 삭제 행 제외(기본값)
  const buf = await buildCatalogWorkbook(rows);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return {
    ok: true,
    value: { base64: buf.toString("base64"), filename: `global-catalog-${stamp}.xlsx` },
  };
}

export async function previewStandardCatalogImport(
  formData: FormData,
): Promise<ActionResult<CatalogImportPreview>> {
  await requireCatalogEditor();
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "업로드된 파일이 없습니다" };
  if (api.isAdminApi()) {
    const r = await api.previewCatalogImport(file);
    if (!r.ok) return r;
    return { ok: true, value: r.value as unknown as CatalogImportPreview };
  }
  const parsed = await parseCatalogWorkbook(Buffer.from(await file.arrayBuffer()));

  const { rows: catalog } = await listStandardCatalog();
  const byId = new Map(catalog.map((r) => [r.id, r]));
  // 어휘 검증은 **프리뷰에서** 한다 — 파서는 형식만 본다(어휘는 scope 조회가
  // 필요해 순수 파서가 알 수 없다). 여기서 막지 않으면 오타 하나가 적용 단계의
  // scope 400 연쇄가 된다.
  const vocabulary = await rootMarketVocabulary();
  const warnings = [...parsed.warnings];

  const items: CatalogImportPreviewItem[] = [];
  const unmatchedIds: string[] = [];
  let unchanged = 0;
  for (const p of parsed.rows) {
    const cur = byId.get(p.id);
    if (!cur) {
      unmatchedIds.push(p.id);
      continue;
    }
    let regions = p.regions;
    if (p.regions !== undefined && p.regions !== null) {
      const norm = normalizePromptRegions(p.regions, vocabulary);
      if (norm.invalid.length > 0 || norm.outOfVocabulary.length > 0) {
        // 행 전체를 버리지 않고 **시장 변경만** 뺀다 — 같은 행의 라벨·본문 수정은
        // 정상이므로 함께 죽이면 오타 하나가 멀쩡한 변경까지 되돌린다.
        warnings.push(
          `${p.id}: 시장 변경을 건너뜁니다 — ` +
            [
              norm.invalid.length ? `형식 아님(${norm.invalid.join(", ")})` : "",
              norm.outOfVocabulary.length
                ? `프로젝트 시장 밖(${norm.outOfVocabulary.join(", ")})`
                : "",
            ]
              .filter(Boolean)
              .join(" · "),
        );
        regions = undefined;
      } else {
        regions = norm.value;
      }
    }
    const item: CatalogBulkItem = {
      id: p.id,
      text: p.text,
      labels: p.labels,
      ...(regions !== undefined ? { regions } : {}),
      ...(p.lang !== undefined ? { lang: p.lang } : {}),
    };
    const changes = diffAgainstRow(cur as unknown as PromptRow, item);
    if (Object.keys(changes).length === 0) {
      unchanged++;
      continue;
    }
    items.push({ id: p.id, currentText: cur.text, changes, item });
  }

  return {
    ok: true,
    value: {
      items,
      unmatchedIds,
      unchanged,
      warnings,
      batchId: crypto.randomUUID(),
    },
  };
}

export async function applyStandardCatalogChunk(
  items: CatalogBulkItem[],
  batchId: string,
): Promise<ActionResult<CatalogChunkResult>> {
  const { userId } = await requireCatalogEditor();
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: "적용할 항목이 없습니다" };
  }
  if (items.length > CHUNK_LIMIT) {
    return { ok: false, error: `청크는 최대 ${CHUNK_LIMIT}건입니다` };
  }
  if (!UUID_RE.test(batchId)) return { ok: false, error: "잘못된 batch id입니다" };
  if (api.isAdminApi()) {
    const r = await api.applyCatalogChunk(items, batchId);
    revalidatePath(PROMPTS_PATH);
    return r;
  }

  let applied = 0;
  const failed: { id: string; error: string }[] = [];
  for (const item of items) {
    try {
      const got = await getCatalogRowOr(item.id);
      if (!got.ok) {
        failed.push({ id: item.id, error: got.error });
        continue;
      }
      // 적용 시점 DB 기준으로 재대조 — preview 이후 바뀐 행도 정확한 old를 남긴다.
      const changes = diffAgainstRow(got.row, item);
      if (Object.keys(changes).length === 0) {
        applied++; // 이미 반영된 상태 = 성공으로 계산 (재시도 멱등)
        continue;
      }
      const patch: Record<string, unknown> = { ...item.labels };
      if (item.text !== undefined && "text" in changes) patch.text = item.text;
      if ("regions" in changes) patch.regions = item.regions ?? null;
      if ("lang" in changes) patch.lang = item.lang ?? null;
      const scopePromptId = got.row.scopePromptId;
      const textChanged = "text" in changes;
      const scopeMetaChanged =
        "promptType" in changes || "category" in changes || "brand" in changes;
      // lang 은 전파하지 않는다 — 표시·필터 전용이고 측정 축이 아니다.
      const regionsChanged = "regions" in changes;
      const nextMeta = {
        promptType: (item.labels.promptType !== undefined
          ? item.labels.promptType
          : got.row.promptType) as PromptType | null,
        category:
          item.labels.category !== undefined ? item.labels.category : got.row.category,
        brand: item.labels.brand !== undefined ? item.labels.brand : got.row.brand,
      };
      await applyAuditedCatalogChange({
        promptId: item.id,
        actorId: userId,
        // text+라벨이 함께 바뀌면 text_updated 하나에 changes를 합산(이벤트 분열 방지).
        eventType: textChanged ? "text_updated" : "meta_updated",
        patch,
        changes,
        batchId,
        applyScope:
          scopePromptId && (textChanged || scopeMetaChanged || regionsChanged)
            ? async () => {
                await updateRootPrompt(scopePromptId, {
                  ...(textChanged ? { text: item.text } : {}),
                  ...(scopeMetaChanged
                    ? { keywords: encodeStandardKeywords(nextMeta) }
                    : {}),
                  ...(regionsChanged ? { regions: item.regions ?? null } : {}),
                });
              }
            : undefined,
      });
      applied++;
    } catch {
      failed.push({ id: item.id, error: "적용에 실패했습니다 (scope 반영 실패 시 로컬도 롤백됨)" });
    }
  }
  revalidatePath(PROMPTS_PATH);
  return { ok: true, value: { applied, failed } };
}

// ─── standard_keywords ───────────────────────────────────────────────────

export async function createStandardKeyword(
  input: {
    term: string;
    sourceType: StandardKeywordSource;
    brand?: string | null;
    notes?: string | null;
  },
): Promise<ActionResult<{ id: string }>> {
  const { userId } = await requireAdmin();
  const term = input.term.trim();
  if (!term) return { ok: false, error: "키워드를 입력해주세요" };
  if (input.sourceType !== "google_keyword" && input.sourceType !== "community_voc") {
    return { ok: false, error: "지원하지 않는 소스 유형입니다" };
  }
  if (api.isAdminApi()) {
    const r = await api.createInterestKeyword({
      term,
      sourceType: input.sourceType,
      brand: input.brand?.trim() || null,
      notes: input.notes?.trim() || null,
    });
    if (r.ok) revalidatePath(KEYWORDS_PATH);
    return r;
  }

  const created = await standardKeywordRepository.insert({
    term,
    sourceType: input.sourceType,
    brand: input.brand?.trim() || null,
    notes: input.notes?.trim() || null,
    createdBy: userId,
  });
  revalidatePath(KEYWORDS_PATH);
  return { ok: true, value: { id: created.id } };
}

export async function toggleStandardKeywordEnabled(
  id: string,
  enabled: boolean,
): Promise<ActionResult> {
  await requireAdmin();
  if (api.isAdminApi()) {
    const r = await api.setInterestKeywordEnabled(id, enabled);
    revalidatePath(KEYWORDS_PATH);
    return r;
  }
  await standardKeywordRepository.update(id, { enabled });
  revalidatePath(KEYWORDS_PATH);
  return { ok: true, value: undefined };
}

export async function deleteStandardKeyword(id: string): Promise<ActionResult> {
  await requireAdmin();
  if (api.isAdminApi()) {
    const r = await api.deleteInterestKeyword(id);
    revalidatePath(KEYWORDS_PATH);
    return r;
  }
  await standardKeywordRepository.delete(id);
  revalidatePath(KEYWORDS_PATH);
  return { ok: true, value: undefined };
}

// ─── standard_sources ────────────────────────────────────────────────────

const VALID_CHANNELS: StandardSourceChannel[] = [
  "news",
  "pr",
  "social",
  "community",
];

export async function createStandardSource(input: {
  url: string;
  channel: StandardSourceChannel;
  brand?: string | null;
  notes?: string | null;
}): Promise<ActionResult<{ id: string }>> {
  const { userId } = await requireAdmin();
  const url = input.url.trim();
  if (!url) return { ok: false, error: "URL을 입력해주세요" };
  if (!VALID_CHANNELS.includes(input.channel)) {
    return { ok: false, error: "지원하지 않는 채널입니다" };
  }
  if (api.isAdminApi()) {
    const r = await api.createInterestSource({
      url,
      channel: input.channel,
      brand: input.brand?.trim() || null,
      notes: input.notes?.trim() || null,
    });
    if (r.ok) revalidatePath(KEYWORDS_PATH);
    return r;
  }

  const created = await standardSourceRepository.insert({
    url,
    channel: input.channel,
    brand: input.brand?.trim() || null,
    notes: input.notes?.trim() || null,
    createdBy: userId,
  });
  revalidatePath(KEYWORDS_PATH);
  return { ok: true, value: { id: created.id } };
}

export async function toggleStandardSourceEnabled(
  id: string,
  enabled: boolean,
): Promise<ActionResult> {
  await requireAdmin();
  if (api.isAdminApi()) {
    const r = await api.setInterestSourceEnabled(id, enabled);
    revalidatePath(KEYWORDS_PATH);
    return r;
  }
  await standardSourceRepository.update(id, { enabled });
  revalidatePath(KEYWORDS_PATH);
  return { ok: true, value: undefined };
}

export async function deleteStandardSource(id: string): Promise<ActionResult> {
  await requireAdmin();
  if (api.isAdminApi()) {
    const r = await api.deleteInterestSource(id);
    revalidatePath(KEYWORDS_PATH);
    return r;
  }
  await standardSourceRepository.delete(id);
  revalidatePath(KEYWORDS_PATH);
  return { ok: true, value: undefined };
}
