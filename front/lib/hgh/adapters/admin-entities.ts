import "server-only";

// Entity versioning adapter (E7, design hmg-entity-management-versioning 7절, API E6 be/ecat-e6).
// The admin entity screens (/admin/standards/entities and its sub pages) read and write the hub
// catalog overlay through /v1/admin/entities/{versions,applies,review,audit}. Only the api
// source (HGH_SOURCE_G7 = api) has versions; the legacy source keeps the old catalog screen.
//
// Reads
//   list page     GET /v1/admin/entities (default period, all pages) + GET .../versions, then the
//                 active and draft version details in parallel. The list endpoint projects the
//                 ACTIVE version onto the old role vocabulary (removed shows as competitor), so the
//                 real role comes from the version detail rows (mergeEntityRows).
//   draft page    GET .../versions (numbers) + GET .../versions/{draft} + GET .../versions/{draft}/diff
//   versions page GET .../versions + GET .../applies
//   apply page    GET .../versions?view=gate (numbers only) + GET .../applies/{id} (polled by the client while a
//                 preview or an apply runs) + GET .../versions/{ver}?view=lint (summary and lint only)
//   review page   GET .../versions?view=gate + GET .../review?status=&kind=&q= + GET /v1/admin/entities?fields=names
//                 (merge target names: no own-brand attribution)
//   audit page    GET .../audit?before_id=
// Draft create / title edit ask return=minimal: the screens only read the version number and refresh.
//
// Errors: writes answer {ok:false, errorKey} where errorKey is a key under adminEcat.errors
// (i18n, never a backend message). 401 and 403 throw UnauthorizedError except
// 403 ECAT_EXPOSED_REQUIRES_APPROVAL (an admin who is not an approver: a user error, shown).
// Local deployment faults are rethrown.

import { UnauthorizedError } from "@/lib/auth/errors";
import type { components } from "../api-types";
import { hghDelete, hghGet, hghPatch, hghPost, hghPut } from "../client";
import { describeHghError, isHghApiError, LOCAL_CODES } from "../errors";
import { fetchAllPages, pageInfo } from "../paginate";

type S = components["schemas"];

import { ECAT_ROLES, OWN_BRANDS, isApplyBusy, type EcatRole, type OwnBrand } from "../ecat-model";

export { ECAT_ROLES, OWN_BRANDS, isApplyBusy };
export type { EcatRole, OwnBrand };
export type ScopeKind = "unexposed" | "from_round" | "all";
export type ApplyStatus = S["ApplyItem"]["status"];
export type VersionStatus = S["VersionSummary"]["status"];

export type EcatResult<T> = { ok: true; value: T } | { ok: false; errorKey: string };

// ── error mapping ───────────────────────────────────────────────────────────

/** Backend codes with their own message (adminEcat.errors.<code>). */
export const ECAT_ERROR_CODES = [
  "ECAT_DRAFT_EXISTS",
  "ECAT_NO_ACTIVE",
  "ECAT_NO_DRAFT",
  "ECAT_VERSION_NOT_FOUND",
  "ECAT_VERSION_STATE",
  "ECAT_MERGE_CHAIN",
  "ECAT_MERGE_SELF",
  "ECAT_PARENT_SELF",
  "ECAT_UNKNOWN_ENTITY",
  "ECAT_ENTITY_IN_USE",
  "ECAT_SURFACE_ADD_GLOBAL",
  "ECAT_SURFACE_EMPTY",
  "ECAT_LINT_STALE",
  "ECAT_LINT_UNKNOWN_KEY",
  "ECAT_LINT_BLOCKED",
  "ECAT_LINT_UNACKED",
  "ECAT_SCOPE_INVALID",
  "ECAT_APPLY_NOT_FOUND",
  "ECAT_APPLY_OPEN",
  "ECAT_APPLY_STATE",
  "ECAT_APPLY_RUNNING",
  "ECAT_BASE_CHANGED",
  "ECAT_EXPOSED_REQUIRES_APPROVAL",
  "ECAT_PREVIEW_STALE",
  "ECAT_REVIEW_DECIDED",
  "ECAT_LEGACY_WRITE",
  "ECAT_IMMUTABLE",
  "ECAT_APPLY_TRANSITION",
  "ECAT_PREVIEW_PENDING",
  "ECAT_SCAN_PENDING",
  "ECAT_APPLY_ABANDONED",
  "ECAT_APPLY_ABANDONING",
  "ECAT_KIND_UNSUPPORTED",
  "ECAT_ROLLBACK_IMMUTABLE",
  "ECAT_ENTITY_NOT_IN_DRAFT",
  "ECAT_SURFACE_NOT_IN_DRAFT",
  "ECAT_REVIEW_NOT_FOUND",
  "duplicate_pending",
  "name_required",
  "brand_required",
  "invalid_brand",
] as const;
const KNOWN = new Set<string>(ECAT_ERROR_CODES);
const LOCAL_FAULTS = new Set<string>([LOCAL_CODES.config, LOCAL_CODES.authUnbound, LOCAL_CODES.pageLimit]);

/** Error -> adminEcat.errors key. Throws for auth refusals and local faults (see header). */
export function ecatErrorKey(e: unknown): string {
  if (!isHghApiError(e)) throw e;
  if (LOCAL_FAULTS.has(e.code)) throw e;
  if (e.code === "ECAT_EXPOSED_REQUIRES_APPROVAL") return e.code;
  if (e.status === 401 || e.status === 403) {
    throw new UnauthorizedError(`admin backend refused (${e.status} ${e.code})`);
  }
  if (KNOWN.has(e.code)) return e.code;
  console.warn(describeHghError(e));
  if (e.status === 404) return "notFound";
  if (e.status === 409) return "conflict";
  if (e.status === 422) return "invalid";
  return "generic";
}

async function attempt<T>(fn: () => Promise<T>): Promise<EcatResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, errorKey: ecatErrorKey(e) };
  }
}

// ── versions ────────────────────────────────────────────────────────────────

export interface ApplyBriefView {
  applyId: number;
  status: ApplyStatus;
  scopeKind: ScopeKind;
  fromRoundDate: string | null;
  requestedAt: string;
  finishedAt: string | null;
}

export interface VersionSummaryView {
  ver: number;
  status: VersionStatus;
  title: string;
  reason: string | null;
  origin: S["VersionSummary"]["origin"];
  basedOn: number | null;
  createdAt: string;
  createdBy: string;
  activatedAt: string | null;
  retiredAt: string | null;
  submittedAt: string | null;
  entityRows: number;
  surfaceRows: number;
  lastApply: ApplyBriefView | null;
}

export interface VersionsView {
  activeVer: number | null;
  draftVer: number | null;
  items: VersionSummaryView[];
}

export function toApplyBrief(a: S["ApplyBrief"] | null | undefined): ApplyBriefView | null {
  if (!a) return null;
  return {
    applyId: a.apply_id,
    status: a.status,
    scopeKind: a.scope_kind,
    fromRoundDate: a.from_round_date ?? null,
    requestedAt: a.requested_at,
    finishedAt: a.finished_at ?? null,
  };
}

export function toVersionSummary(v: S["VersionSummary"]): VersionSummaryView {
  return {
    ver: v.ver,
    status: v.status,
    title: v.title,
    reason: v.reason ?? null,
    origin: v.origin,
    basedOn: v.based_on ?? null,
    createdAt: v.created_at,
    createdBy: v.created_by,
    activatedAt: v.activated_at ?? null,
    retiredAt: v.retired_at ?? null,
    submittedAt: v.submitted_at ?? null,
    entityRows: v.entity_rows,
    surfaceRows: v.surface_rows,
    lastApply: toApplyBrief(v.last_apply),
  };
}

export async function listVersions(limit = 100): Promise<VersionsView> {
  const res = await hghGet("/v1/admin/entities/versions", { query: { limit } });
  return {
    activeVer: res.data.active_ver ?? null,
    draftVer: res.data.draft_ver ?? null,
    items: res.data.items.map(toVersionSummary),
  };
}

/** Active and draft numbers only (view=gate: the backend reads no version rows, counts or last applies). items stays empty. */
export async function listVersionNumbers(): Promise<VersionsView> {
  const res = await hghGet("/v1/admin/entities/versions", { query: { view: "gate" } });
  return { activeVer: res.data.active_ver ?? null, draftVer: res.data.draft_ver ?? null, items: [] };
}

export interface EntityOverrideView {
  entityId: string;
  origin: "scope" | "hub";
  role: EcatRole;
  name: string | null;
  repName: string | null;
  entityType: string | null;
  brandCode: string | null;
  brandName: string | null;
  mergeInto: string | null;
  parentBrandId: string | null;
  note: string | null;
  observed: boolean;
  updatedAt: string | null;
  /** Own brand the entity counts toward under this version (null = none). */
  effectiveOwnBrand: string | null;
}

export interface SurfaceView {
  surfaceId: number;
  action: "add" | "block";
  entityId: string | null;
  surface: string;
  surfaceNorm: string;
  lang: string | null;
  createdAt: string;
}

export interface LintFindingView {
  key: string;
  /** INFO = a structural finding the base version already had (does not block, needs no confirmation). */
  level: "L1" | "L2" | "L3" | "INFO";
  code: string;
  target: string;
  detail: string;
  entityId: string | null;
  surfaceId: number | null;
  escalate: boolean;
}

export interface LintView {
  blocked: boolean;
  stale: boolean;
  counts: Record<string, number>;
  escalated: number;
  findings: LintFindingView[];
  acked: string[];
  unacked: string[];
  lintedAt: string | null;
  observedSource: string | null;
}

export interface VersionDetailView {
  version: VersionSummaryView;
  contentMd5: string | null;
  entities: EntityOverrideView[];
  surfaces: SurfaceView[];
  lint: LintView | null;
}

export function toEntityOverride(e: S["EntityOverride"]): EntityOverrideView {
  return {
    entityId: e.entity_id,
    origin: e.origin,
    role: e.role,
    name: e.name ?? null,
    repName: e.rep_name ?? null,
    entityType: e.entity_type ?? null,
    brandCode: e.brand_code ?? null,
    brandName: e.brand_name ?? null,
    mergeInto: e.merge_into ?? null,
    parentBrandId: e.parent_brand_id ?? null,
    note: e.note ?? null,
    observed: e.observed,
    updatedAt: e.updated_at ?? null,
    effectiveOwnBrand: e.effective_own_brand ?? null,
  };
}

export function toSurface(s: S["SurfaceItem"]): SurfaceView {
  return {
    surfaceId: s.surface_id,
    action: s.action,
    entityId: s.entity_id ?? null,
    surface: s.surface,
    surfaceNorm: s.surface_norm,
    lang: s.lang ?? null,
    createdAt: s.created_at,
  };
}

export function toLint(l: S["LintState"] | null | undefined): LintView | null {
  if (!l) return null;
  return {
    blocked: l.blocked,
    stale: l.stale ?? false,
    counts: { ...l.counts },
    escalated: l.escalated,
    findings: l.findings.map((f) => ({
      key: f.key,
      level: f.level,
      code: f.code,
      target: f.target,
      detail: f.detail ?? "",
      entityId: f.entity_id ?? null,
      surfaceId: f.surface_id ?? null,
      escalate: f.escalate,
    })),
    acked: [...(l.acked ?? [])],
    unacked: [...(l.unacked ?? [])],
    lintedAt: l.linted_at ?? null,
    observedSource: l.observed_source ?? null,
  };
}

export function toVersionDetail(d: S["VersionDetail"]): VersionDetailView {
  return {
    version: toVersionSummary(d.version),
    contentMd5: d.content_md5 ?? null,
    entities: d.entities.map(toEntityOverride),
    surfaces: d.surfaces.map(toSurface),
    lint: toLint(d.lint),
  };
}

export async function getVersion(ver: number): Promise<VersionDetailView> {
  const res = await hghGet("/v1/admin/entities/versions/{ver}", { pathParams: { ver } });
  return toVersionDetail(res.data);
}

export type VersionLintView = Pick<VersionDetailView, "version" | "contentMd5" | "lint">;

/** Summary, content fingerprint and last lint of a version (view=lint: no override rows, no attribution). */
export async function getVersionLint(ver: number): Promise<VersionLintView> {
  const res = await hghGet("/v1/admin/entities/versions/{ver}", { pathParams: { ver }, query: { view: "lint" } });
  return { version: toVersionSummary(res.data.version), contentMd5: res.data.content_md5 ?? null, lint: toLint(res.data.lint) };
}

export interface VersionDiffView {
  ver: number;
  against: number | null;
  counts: Record<string, number>;
  entities: { entityId: string; change: "added" | "removed" | "changed"; fields: string[]; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[];
  surfaces: { surfaceId: number; surface: string; entityId: string | null; change: "added" | "removed" | "changed"; beforeAction: string | null; afterAction: string | null }[];
}

export function toDiff(d: S["VersionDiff"]): VersionDiffView {
  return {
    ver: d.ver,
    against: d.against ?? null,
    counts: { ...d.counts },
    entities: d.entities.map((x) => ({
      entityId: x.entity_id,
      change: x.change,
      fields: [...(x.fields ?? [])],
      before: (x.before as Record<string, unknown> | null | undefined) ?? null,
      after: (x.after as Record<string, unknown> | null | undefined) ?? null,
    })),
    surfaces: d.surfaces.map((x) => ({
      surfaceId: x.surface_id,
      surface: x.surface,
      entityId: x.entity_id ?? null,
      change: x.change,
      beforeAction: x.before_action ?? null,
      afterAction: x.after_action ?? null,
    })),
  };
}

export async function getVersionDiff(ver: number, against?: number | null): Promise<VersionDiffView> {
  const res = await hghGet("/v1/admin/entities/versions/{ver}/diff", {
    pathParams: { ver },
    query: against ? { against } : {},
  });
  return toDiff(res.data);
}

// ── version writes ──────────────────────────────────────────────────────────

/** Draft create / edit result: the version summary only (return=minimal; the screens refresh for the rest). */
export interface VersionWriteView {
  version: VersionSummaryView;
}

export function createDraft(title: string, reason: string | null): Promise<EcatResult<VersionWriteView>> {
  return attempt(async () => {
    const res = await hghPost("/v1/admin/entities/versions", { query: { return: "minimal" }, body: { title, reason }, retryOn401: true });
    return { version: toVersionSummary(res.data.version) };
  });
}

export function patchDraft(ver: number, title: string | null, reason: string | null): Promise<EcatResult<VersionWriteView>> {
  return attempt(async () => {
    const res = await hghPatch("/v1/admin/entities/versions/{ver}", {
      pathParams: { ver },
      query: { return: "minimal" },
      body: { title, reason },
      retryOn401: true,
    });
    return { version: toVersionSummary(res.data.version) };
  });
}

export function discardDraft(ver: number, reason: string | null): Promise<EcatResult<{ rejectedApplies: number[] }>> {
  return attempt(async () => {
    const res = await hghPost("/v1/admin/entities/versions/{ver}/discard", { pathParams: { ver }, body: { reason }, retryOn401: true });
    return { rejectedApplies: [...(res.data.rejected_applies ?? [])] };
  });
}

export interface EntityEdit {
  role: EcatRole;
  name?: string | null;
  brandCode?: string | null;
  mergeInto?: string | null;
  parentBrandId?: string | null;
  note?: string | null;
  entityType?: string | null;
}

export interface EntityWriteView {
  changed: boolean;
  entity: EntityOverrideView | null;
  staleApplies: number[];
}

function toEntityWrite(w: S["EntityWrite"]): EntityWriteView {
  return { changed: w.changed, entity: w.entity ? toEntityOverride(w.entity) : null, staleApplies: [...(w.stale_applies ?? [])] };
}

/** Empty strings are sent as null (a cleared field), trimmed otherwise. */
export function nz(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t : null;
}

export function entityBody(e: EntityEdit): S["EntityBody"] {
  return {
    role: e.role,
    name: nz(e.name),
    brand_code: e.role === "own" ? nz(e.brandCode) : null,
    merge_into: nz(e.mergeInto),
    parent_brand_id: nz(e.parentBrandId),
    note: nz(e.note),
    ...(e.entityType !== undefined ? { entity_type: nz(e.entityType) } : {}),
  };
}

export function putDraftEntity(ver: number, entityId: string, e: EntityEdit): Promise<EcatResult<EntityWriteView>> {
  return attempt(async () => {
    const res = await hghPut("/v1/admin/entities/versions/{ver}/entities/{entity_id}", {
      pathParams: { ver, entity_id: entityId },
      body: entityBody(e),
      retryOn401: true,
    });
    return toEntityWrite(res.data);
  });
}

export interface HubEntityInput {
  name: string;
  entityType: string;
  role: EcatRole;
  brandCode?: string | null;
  parentBrandId?: string | null;
  note?: string | null;
}

export function addHubEntity(ver: number, h: HubEntityInput): Promise<EcatResult<EntityWriteView>> {
  return attempt(async () => {
    const res = await hghPost("/v1/admin/entities/versions/{ver}/entities", {
      pathParams: { ver },
      body: {
        name: h.name.trim(),
        entity_type: h.entityType.trim() || "Brand",
        role: h.role,
        brand_code: h.role === "own" ? nz(h.brandCode) : null,
        parent_brand_id: nz(h.parentBrandId),
        note: nz(h.note),
      },
      retryOn401: true,
    });
    return toEntityWrite(res.data);
  });
}

export function deleteDraftEntity(ver: number, entityId: string): Promise<EcatResult<EntityWriteView>> {
  return attempt(async () => {
    const res = await hghDelete("/v1/admin/entities/versions/{ver}/entities/{entity_id}", {
      pathParams: { ver, entity_id: entityId },
      retryOn401: true,
    });
    return toEntityWrite(res.data);
  });
}

export interface SurfaceInput {
  action: "add" | "block";
  surface: string;
  entityId: string | null;
  lang?: string | null;
}

export interface SurfaceWriteView {
  changed: boolean;
  surface: SurfaceView | null;
  staleApplies: number[];
}

export function addDraftSurface(ver: number, s: SurfaceInput): Promise<EcatResult<SurfaceWriteView>> {
  return attempt(async () => {
    const res = await hghPost("/v1/admin/entities/versions/{ver}/surfaces", {
      pathParams: { ver },
      body: { action: s.action, surface: s.surface.trim(), entity_id: nz(s.entityId), lang: nz(s.lang) },
      retryOn401: true,
    });
    const w = res.data;
    return { changed: w.changed, surface: w.surface ? toSurface(w.surface) : null, staleApplies: [...(w.stale_applies ?? [])] };
  });
}

export function deleteDraftSurface(ver: number, surfaceId: number): Promise<EcatResult<SurfaceWriteView>> {
  return attempt(async () => {
    const res = await hghDelete("/v1/admin/entities/versions/{ver}/surfaces/{surface_id}", {
      pathParams: { ver, surface_id: surfaceId },
      retryOn401: true,
    });
    const w = res.data;
    return { changed: w.changed, surface: w.surface ? toSurface(w.surface) : null, staleApplies: [...(w.stale_applies ?? [])] };
  });
}

export function runLint(ver: number): Promise<EcatResult<LintView>> {
  return attempt(async () => {
    const res = await hghPost("/v1/admin/entities/versions/{ver}/lint", { pathParams: { ver }, retryOn401: true, timeoutClass: "adminLong" });
    return toLint(res.data) as LintView;
  });
}

export function saveLintAcks(ver: number, keys: string[]): Promise<EcatResult<LintView>> {
  return attempt(async () => {
    const res = await hghPut("/v1/admin/entities/versions/{ver}/lint/acks", { pathParams: { ver }, body: { keys }, retryOn401: true });
    return toLint(res.data) as LintView;
  });
}

// ── applies ─────────────────────────────────────────────────────────────────

export interface ApplyItemView {
  applyId: number;
  ver: number;
  fromVer: number | null;
  status: ApplyStatus;
  scopeKind: ScopeKind;
  fromRoundDate: string | null;
  reason: string;
  requestedAt: string;
  requestedBy: string;
  approvedAt: string | null;
  approvedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  affectedAnswers: number | null;
  hasPreview: boolean;
  requiresApproval: boolean;
  errorCode: string | null;
}

export function toApplyItem(a: S["ApplyItem"] | S["ApplyDetail"]): ApplyItemView {
  return {
    applyId: a.apply_id,
    ver: a.ver,
    fromVer: a.from_ver ?? null,
    status: a.status,
    scopeKind: a.scope_kind,
    fromRoundDate: a.from_round_date ?? null,
    reason: a.reason,
    requestedAt: a.requested_at,
    requestedBy: a.requested_by,
    approvedAt: a.approved_at ?? null,
    approvedBy: a.approved_by ?? null,
    startedAt: a.started_at ?? null,
    finishedAt: a.finished_at ?? null,
    affectedAnswers: a.affected_answers ?? null,
    hasPreview: a.has_preview,
    requiresApproval: a.requires_approval,
    errorCode: a.error_code ?? null,
  };
}

export async function listApplies(opts: { ver?: number; beforeId?: number; limit?: number } = {}): Promise<ApplyItemView[]> {
  const res = await hghGet("/v1/admin/entities/applies", {
    query: {
      limit: opts.limit ?? 50,
      ...(opts.ver ? { ver: opts.ver } : {}),
      ...(opts.beforeId ? { before_id: opts.beforeId } : {}),
    },
  });
  return res.data.items.map(toApplyItem);
}

// Preview (E4 compute_preview, v = 1). The body is untyped in the contract (dict), so it is read
// defensively: a shape this module does not know yields preview = null and the raw flag set.


export interface KpiCounts {
  answers: number;
  total_mentions: number;
  tracked: number;
  own_mentions: number;
  rank_sum: number;
  ranked: number;
}

export interface BrandKpi {
  visBefore: number | null;
  visAfter: number | null;
  sovBefore: number | null;
  sovAfter: number | null;
  posBefore: number | null;
  posAfter: number | null;
}

export interface KpiRowView {
  key: string;
  roundDate: string | null;
  surface: "global" | "website" | "project" | null;
  geo: string | null;
  engine: string | null;
  exposed: boolean;
  answersBefore: number;
  answersAfter: number;
  brands: Record<OwnBrand, BrandKpi>;
  /** Largest absolute change over the three brands' visibility and SoV (percentage points). */
  maxDelta: number;
  /**
   * Card value before -> after for a frozen round that the apply re-freezes (preview kpi[].card): before = what the
   * card shows now (frozen snapshot), after = the card once re-frozen at the new version. null for rounds without it.
   */
  card: { answersBefore: number; answersAfter: number; brands: Record<OwnBrand, BrandKpi> } | null;
}

/** Frozen rounds the apply re-freezes when it finishes (preview.refreeze). An unexposed-only range never re-freezes. */
export interface RefreezePlanView {
  applies: boolean;
  count: number;
  exposed: number;
  note: string | null;
  /** preview.refreeze.approx present: the card "after" values are an estimate (cell rd values + work-answer delta). With the
   *  brand_card_fold profile on, the fold share of coexisting answers is missing until the re-freeze re-folds them. The backend
   *  text itself is not shown (UI strings come from messages). */
  approx: boolean;
  cycles: { cycKey: number; roundDate: string; surface: KpiRowView["surface"]; exposed: boolean }[];
}

export interface PreviewSampleView {
  change: string;
  answerKey: number;
  name: string | null;
  surface: string | null;
  context: string | null;
  highlight: [number, number] | null;
  approx: boolean;
}

export interface PreviewView {
  computedAt: string | null;
  requiresApproval: boolean;
  impact: {
    entities: number;
    impactedAnswers: number;
    workAnswers: number;
    changedAnswers: number;
    promptRuns: number;
    orphanPromptRuns: number;
    blockSurfaces: number;
    addSurfaces: number;
  };
  cycles: { inScope: number; exposed: { cycKey: number; roundDate: string; surface: string | null }[] };
  approx: { noOccurrenceAnswers: number; acrAnswers: number };
  /** Per round (round_date x surface): the changed groups summed. */
  kpiByRound: KpiRowView[];
  /** Changed round x country x engine groups, largest change first, at most KPI_TOP rows. */
  kpiTop: KpiRowView[];
  kpiGroupsChanged: number;
  kpiTruncated: boolean;
  brands: {
    bare: string;
    beforeMentions: number | null;
    afterMentions: number | null;
    deltaMentions: number;
    beforeAnswers: number | null;
    afterAnswers: number | null;
    deltaAnswers: number;
  }[];
  samples: { removed: PreviewSampleView[]; added: PreviewSampleView[]; moved: PreviewSampleView[] };
  /** Hidden role changes the loader counted (preview.hidden.count: hidden applies to every period at once), null when absent. */
  hiddenChanges: number | null;
  /** Re-freeze plan for frozen rounds in range, null when the preview predates it. */
  refreeze: RefreezePlanView | null;
}

/** Hidden role changes (to or from hidden) in a version diff: the fallback when the preview carries no hidden block. */
export function hiddenChangesInDiff(diff: VersionDiffView): number {
  const role = (r: Record<string, unknown> | null) => (r && typeof r.role === "string" ? r.role : null);
  return diff.entities.filter((x) => role(x.before) !== role(x.after) && (role(x.before) === "hidden" || role(x.after) === "hidden")).length;
}

export const KPI_TOP = 200;
const SURFACES: Record<number, KpiRowView["surface"]> = { 1: "global", 2: "website", 3: "project" };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function counts(v: unknown): KpiCounts {
  const o = isObj(v) ? v : {};
  return {
    answers: num(o.answers),
    total_mentions: num(o.total_mentions),
    tracked: num(o.tracked),
    own_mentions: num(o.own_mentions),
    rank_sum: num(o.rank_sum),
    ranked: num(o.ranked),
  };
}

/** Ratio in percent (1 decimal kept by the caller's formatting), null when the base is 0. */
export const pct = (n: number, d: number): number | null => (d > 0 ? (n / d) * 100 : null);
export const avg = (n: number, d: number): number | null => (d > 0 ? n / d : null);

function addCounts(a: KpiCounts, b: KpiCounts): KpiCounts {
  return {
    answers: a.answers + b.answers,
    total_mentions: a.total_mentions + b.total_mentions,
    tracked: a.tracked + b.tracked,
    own_mentions: a.own_mentions + b.own_mentions,
    rank_sum: a.rank_sum + b.rank_sum,
    ranked: a.ranked + b.ranked,
  };
}

type RawRow = {
  key: string;
  roundDate: string | null;
  surface: KpiRowView["surface"];
  geo: string | null;
  engine: string | null;
  exposed: boolean;
  before: Record<OwnBrand, KpiCounts>;
  after: Record<OwnBrand, KpiCounts>;
  card: { before: Record<OwnBrand, KpiCounts>; after: Record<OwnBrand, KpiCounts> } | null;
};

function brandCounts(v: unknown): Record<OwnBrand, KpiCounts> {
  const o = isObj(v) ? v : {};
  const out = {} as Record<OwnBrand, KpiCounts>;
  for (const code of OWN_BRANDS) out[code] = counts(o[code]);
  return out;
}

function addBrandCounts(a: Record<OwnBrand, KpiCounts>, b: Record<OwnBrand, KpiCounts>): Record<OwnBrand, KpiCounts> {
  const out = {} as Record<OwnBrand, KpiCounts>;
  for (const code of OWN_BRANDS) out[code] = addCounts(a[code], b[code]);
  return out;
}

function brandKpi(b: KpiCounts, a: KpiCounts): BrandKpi {
  return {
    visBefore: pct(b.tracked, b.answers),
    visAfter: pct(a.tracked, a.answers),
    sovBefore: pct(b.own_mentions, b.total_mentions),
    sovAfter: pct(a.own_mentions, a.total_mentions),
    posBefore: avg(b.rank_sum, b.ranked),
    posAfter: avg(a.rank_sum, a.ranked),
  };
}

function toKpiRow(r: RawRow): KpiRowView {
  const brands = {} as Record<OwnBrand, BrandKpi>;
  let maxDelta = 0;
  for (const code of OWN_BRANDS) {
    const k = brandKpi(r.before[code], r.after[code]);
    brands[code] = k;
    for (const [x, y] of [
      [k.visBefore, k.visAfter],
      [k.sovBefore, k.sovAfter],
    ] as const) {
      const d = Math.abs((y ?? 0) - (x ?? 0));
      if (d > maxDelta) maxDelta = d;
    }
  }
  return {
    key: r.key,
    roundDate: r.roundDate,
    surface: r.surface,
    geo: r.geo,
    engine: r.engine,
    exposed: r.exposed,
    answersBefore: r.before[OWN_BRANDS[0]].answers,
    answersAfter: r.after[OWN_BRANDS[0]].answers,
    brands,
    maxDelta,
    card: r.card
      ? {
          answersBefore: r.card.before[OWN_BRANDS[0]].answers,
          answersAfter: r.card.after[OWN_BRANDS[0]].answers,
          brands: Object.fromEntries(OWN_BRANDS.map((c) => [c, brandKpi(r.card!.before[c], r.card!.after[c])])) as Record<OwnBrand, BrandKpi>,
        }
      : null,
  };
}

function sample(v: unknown): PreviewSampleView | null {
  if (!isObj(v)) return null;
  const hl = Array.isArray(v.highlight) && v.highlight.length === 2 ? ([num(v.highlight[0]), num(v.highlight[1])] as [number, number]) : null;
  return {
    change: str(v.change) ?? "",
    answerKey: num(v.answer_key),
    name: str(v.name),
    surface: str(v.surface),
    context: str(v.context),
    highlight: hl,
    approx: v.approx === true,
  };
}

const samples = (v: unknown): PreviewSampleView[] => arr(v).map(sample).filter((x): x is PreviewSampleView => x !== null);

export function toPreview(raw: unknown): PreviewView | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  const impact = isObj(raw.impact) ? raw.impact : {};
  const cycles = isObj(raw.cycles) ? raw.cycles : {};
  const approx = isObj(raw.approx) ? raw.approx : {};
  const rows: RawRow[] = arr(raw.kpi).filter(isObj).map((r) => {
    const before = brandCounts(r.before);
    const after = brandCounts(r.after);
    const card = isObj(r.card) ? { before: brandCounts(r.card.before), after: brandCounts(r.card.after) } : null;
    return {
      key: `${num(r.cyc_key)}:${num(r.geo_key)}:${num(r.engine_key)}`,
      roundDate: str(r.round_date),
      surface: SURFACES[num(r.surface)] ?? null,
      geo: str(r.geo),
      engine: str(r.engine),
      exposed: r.exposed === true,
      before,
      after,
      card,
    };
  });

  const byRound = new Map<string, RawRow>();
  for (const r of rows) {
    const k = `${r.roundDate ?? ""}:${r.surface ?? ""}`;
    const cur = byRound.get(k);
    if (!cur) {
      byRound.set(k, {
        ...r,
        key: k,
        geo: null,
        engine: null,
        before: { ...r.before },
        after: { ...r.after },
        card: r.card ? { before: { ...r.card.before }, after: { ...r.card.after } } : null,
      });
      continue;
    }
    cur.exposed = cur.exposed || r.exposed;
    if (r.card) {
      cur.card = cur.card
        ? { before: addBrandCounts(cur.card.before, r.card.before), after: addBrandCounts(cur.card.after, r.card.after) }
        : { before: { ...r.card.before }, after: { ...r.card.after } };
    }
    for (const code of OWN_BRANDS) {
      cur.before[code] = addCounts(cur.before[code], r.before[code]);
      cur.after[code] = addCounts(cur.after[code], r.after[code]);
    }
  }
  const kpiByRound = [...byRound.values()]
    .map(toKpiRow)
    .sort((x, y) => (y.roundDate ?? "").localeCompare(x.roundDate ?? "") || (x.surface ?? "").localeCompare(y.surface ?? ""));
  const kpiTop = rows
    .map(toKpiRow)
    .sort((x, y) => y.maxDelta - x.maxDelta || (y.roundDate ?? "").localeCompare(x.roundDate ?? "") || x.key.localeCompare(y.key))
    .slice(0, KPI_TOP);

  const s = isObj(raw.samples) ? raw.samples : {};
  const rf = isObj(raw.refreeze) ? raw.refreeze : null;
  return {
    computedAt: str(raw.computed_at),
    requiresApproval: raw.requires_approval === true,
    impact: {
      entities: num(impact.entities),
      impactedAnswers: num(impact.impacted_answers),
      workAnswers: num(impact.work_answers),
      changedAnswers: num(impact.changed_answers),
      promptRuns: num(impact.prompt_runs),
      orphanPromptRuns: num(impact.orphan_prompt_runs),
      blockSurfaces: arr(impact.block_surfaces).length,
      addSurfaces: arr(impact.add_surfaces).length,
    },
    cycles: {
      inScope: num(cycles.in_scope),
      exposed: arr(cycles.exposed_labels)
        .filter(isObj)
        .map((c) => ({ cycKey: num(c.cyc_key), roundDate: str(c.round_date) ?? "", surface: SURFACES[num(c.surface)] ?? null })),
    },
    approx: { noOccurrenceAnswers: num(approx.no_occurrence_answers), acrAnswers: num(approx.acr_answers) },
    kpiByRound,
    kpiTop,
    kpiGroupsChanged: num(raw.kpi_groups_changed) || rows.length,
    kpiTruncated: raw.kpi_truncated === true,
    hiddenChanges: isObj(raw.hidden) ? (typeof raw.hidden.count === "number" ? raw.hidden.count : arr(raw.hidden.changes).length) : null,
    brands: arr(raw.brands)
      .filter(isObj)
      .map((b) => ({
        bare: str(b.bare) ?? "",
        beforeMentions: numOrNull(b.before_mentions),
        afterMentions: numOrNull(b.after_mentions),
        deltaMentions: num(b.delta_mentions),
        beforeAnswers: numOrNull(b.before_answers),
        afterAnswers: numOrNull(b.after_answers),
        deltaAnswers: num(b.delta_answers),
      })),
    samples: { removed: samples(s.removed), added: samples(s.added), moved: samples(s.moved) },
    refreeze: rf
      ? {
          applies: rf.applies === true,
          count: num(rf.count),
          exposed: num(rf.exposed),
          note: str(rf.note),
          approx: typeof rf.approx === "string" && rf.approx.length > 0,
          cycles: arr(rf.cycles)
            .filter(isObj)
            .map((c) => ({ cycKey: num(c.cyc_key), roundDate: str(c.round_date) ?? "", surface: SURFACES[num(c.surface)] ?? null, exposed: c.exposed === true })),
        }
      : null,
  };
}

/** Cycles an abandon pins to the version before the apply (review N2): planned before the abandon, measured on rd.cycle after. */
export interface AbandonPinsView {
  state: "planned" | "abandoning" | "abandoned";
  newVer: number;
  activeVer: number | null;
  cycles: { cycKey: number; roundDate: string; surface: "global" | "website" | "project" | null; exposed: boolean; pinVer: number }[];
  /** Not yet exposed among them: later "unexposed" applies leave them out. */
  unexposed: number;
  /** An apply whose range includes a pinned cycle needs an approver. */
  requiresApprovalLater: boolean;
}

export function toAbandonPins(p: S["AbandonPins"] | null | undefined): AbandonPinsView | null {
  if (!p) return null;
  return {
    state: p.state,
    newVer: p.new_ver,
    activeVer: p.active_ver ?? null,
    cycles: (p.cycles ?? []).map((c) => ({ cycKey: c.cyc_key, roundDate: c.round_date, surface: c.surface ?? null, exposed: c.exposed, pinVer: c.pin_ver })),
    unexposed: p.unexposed ?? 0,
    requiresApprovalLater: p.requires_approval_later,
  };
}

export interface ApplyDetailView extends ApplyItemView {
  actions: string[];
  abandonPins: AbandonPinsView | null;
  canApprove: boolean;
  approverRequired: boolean;
  cycleKeys: number[];
  preview: PreviewView | null;
  /** A preview body exists but its shape is unknown to this screen (v != 1). */
  previewUnreadable: boolean;
  queue: { changeId: number; op: string | null; status: string; requestedAt: string; appliedAt: string | null; hasError: boolean }[];
}

export function toApplyDetail(d: S["ApplyDetail"]): ApplyDetailView {
  const preview = toPreview(d.preview);
  return {
    ...toApplyItem(d),
    actions: [...(d.actions ?? [])],
    abandonPins: toAbandonPins(d.abandon_pins),
    canApprove: d.can_approve,
    approverRequired: d.approver_required,
    cycleKeys: [...(d.cycle_keys ?? [])],
    preview,
    previewUnreadable: d.preview != null && preview === null,
    queue: (d.queue ?? []).map((q) => ({
      changeId: q.change_id,
      op: q.op ?? null,
      status: q.status,
      requestedAt: q.requested_at,
      appliedAt: q.applied_at ?? null,
      hasError: !!q.error,
    })),
  };
}

export async function getApply(applyId: number): Promise<ApplyDetailView> {
  const res = await hghGet("/v1/admin/entities/applies/{apply_id}", { pathParams: { apply_id: applyId } });
  return toApplyDetail(res.data);
}

export interface ApplyRequest {
  scopeKind: ScopeKind;
  fromRoundDate?: string | null;
  reason: string;
  ver?: number | null;
}

export function requestApply(r: ApplyRequest): Promise<EcatResult<ApplyDetailView>> {
  return attempt(async () => {
    const res = await hghPost("/v1/admin/entities/applies", {
      body: {
        scope_kind: r.scopeKind,
        reason: r.reason.trim(),
        from_round_date: r.scopeKind === "from_round" ? nz(r.fromRoundDate) : null,
        ...(r.ver ? { ver: r.ver } : {}),
      },
      retryOn401: true,
    });
    return toApplyDetail(res.data);
  });
}

export function applyAction(
  applyId: number,
  action: "preview" | "approve" | "reject" | "resume" | "abandon" | "rollback",
  reason?: string | null,
): Promise<EcatResult<ApplyDetailView>> {
  return attempt(async () => {
    const pathParams = { apply_id: applyId };
    let res;
    switch (action) {
      case "preview":
        res = await hghPost("/v1/admin/entities/applies/{apply_id}/preview", { pathParams, retryOn401: true });
        break;
      case "approve":
        res = await hghPost("/v1/admin/entities/applies/{apply_id}/approve", { pathParams, body: { reason: nz(reason) }, retryOn401: true });
        break;
      case "reject":
        res = await hghPost("/v1/admin/entities/applies/{apply_id}/reject", { pathParams, body: { reason: (reason ?? "").trim() }, retryOn401: true });
        break;
      case "resume":
        res = await hghPost("/v1/admin/entities/applies/{apply_id}/resume", { pathParams, retryOn401: true });
        break;
      case "abandon":
        res = await hghPost("/v1/admin/entities/applies/{apply_id}/abandon", { pathParams, body: { reason: (reason ?? "").trim() }, retryOn401: true });
        break;
      case "rollback":
        res = await hghPost("/v1/admin/entities/applies/{apply_id}/rollback", { pathParams, body: { reason: (reason ?? "").trim() }, retryOn401: true });
        break;
    }
    return toApplyDetail(res.data);
  });
}

// ── review inbox ────────────────────────────────────────────────────────────

export type ReviewStatus = "pending" | "resolved" | "dismissed";

export interface ReviewItemView {
  reviewId: number;
  kind: "new_entity" | "new_surface";
  status: ReviewStatus;
  entityId: string;
  displayName: string | null;
  entityType: string | null;
  surface: string | null;
  nAnswers: number;
  nMentions: number;
  firstSeenAt: string;
  lastSeenAt: string;
  alertGrade: number | null;
  decidedAt: string | null;
  resolvedVer: number | null;
  note: string | null;
}

export function toReview(r: S["ReviewItem"]): ReviewItemView {
  return {
    reviewId: r.review_id,
    kind: r.kind,
    status: r.status,
    entityId: r.entity_id,
    displayName: r.display_name ?? null,
    entityType: r.entity_type ?? null,
    surface: r.surface ?? null,
    nAnswers: r.n_answers,
    nMentions: r.n_mentions,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    alertGrade: r.alert_grade ?? null,
    decidedAt: r.decided_at ?? null,
    resolvedVer: r.resolved_ver ?? null,
    note: r.note ?? null,
  };
}

export async function listReview(opts: { status?: ReviewStatus | "all"; kind?: "new_entity" | "new_surface" | null; q?: string | null; limit?: number } = {}): Promise<ReviewItemView[]> {
  const res = await hghGet("/v1/admin/entities/review", {
    query: {
      status: opts.status ?? "pending",
      limit: opts.limit ?? 200,
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(nz(opts.q) ? { q: nz(opts.q) as string } : {}),
    },
  });
  return res.data.items.map(toReview);
}

export interface ReviewDecisionInput {
  action: "register" | "dismiss";
  role?: EcatRole | null;
  brandCode?: string | null;
  mergeInto?: string | null;
  surfaceAction?: "add" | "block" | null;
  note?: string | null;
}

export function decideReview(reviewId: number, d: ReviewDecisionInput): Promise<EcatResult<{ ver: number | null; review: ReviewItemView }>> {
  return attempt(async () => {
    const res = await hghPost("/v1/admin/entities/review/{review_id}/decision", {
      pathParams: { review_id: reviewId },
      body: {
        action: d.action,
        note: nz(d.note),
        ...(d.action === "register"
          ? {
              role: d.role ?? null,
              brand_code: d.role === "own" ? nz(d.brandCode) : null,
              merge_into: nz(d.mergeInto),
              surface_action: d.surfaceAction ?? null,
            }
          : {}),
      },
      retryOn401: true,
    });
    return { ver: res.data.ver ?? null, review: toReview(res.data.review) };
  });
}

// ── audit ───────────────────────────────────────────────────────────────────

export interface AuditItemView {
  auditId: number;
  ts: string;
  action: string;
  actorId: string;
  ver: number | null;
  applyId: number | null;
  entityId: string | null;
  surfaceId: number | null;
  reviewId: number | null;
  detail: string | null;
}

export function toAudit(a: S["EcatAuditItem"]): AuditItemView {
  return {
    auditId: a.audit_id,
    ts: a.ts,
    action: a.action,
    actorId: a.actor_id,
    ver: a.ver ?? null,
    applyId: a.apply_id ?? null,
    entityId: a.entity_id ?? null,
    surfaceId: a.surface_id ?? null,
    reviewId: a.review_id ?? null,
    detail: a.detail ? JSON.stringify(a.detail) : null,
  };
}

export async function listAudit(opts: { beforeId?: number | null; limit?: number; ver?: number | null; applyId?: number | null } = {}): Promise<AuditItemView[]> {
  const res = await hghGet("/v1/admin/entities/audit", {
    query: {
      limit: opts.limit ?? 100,
      ...(opts.beforeId ? { before_id: opts.beforeId } : {}),
      ...(opts.ver ? { ver: opts.ver } : {}),
      ...(opts.applyId ? { apply_id: opts.applyId } : {}),
    },
  });
  return res.data.items.map(toAudit);
}

// ── entity list + samples ───────────────────────────────────────────────────

export const ENTITY_LIST_LIMIT = 500;
export const ENTITY_LIST_MAX_PAGES = 10;

/** All entity list pages. fields "names" = rows for name pickers (merge targets): the backend skips the own-brand attribution (own_brand null). */
export async function listEntityRows(opts: { fields?: "names" } = {}): Promise<S["EntityRow"][]> {
  const r = await fetchAllPages(
    async (cursor) => {
      const res = await hghGet("/v1/admin/entities", {
        query: {
          surface: "global",
          sort: "answers_desc",
          limit: ENTITY_LIST_LIMIT,
          ...(opts.fields ? { fields: opts.fields } : {}),
          ...(cursor ? { cursor } : {}),
        },
        timeoutClass: "adminLong",
      });
      return { items: res.data.items, nextCursor: pageInfo(res.meta).nextCursor };
    },
    { maxPages: ENTITY_LIST_MAX_PAGES },
  );
  return r.items;
}

export interface ManagedEntityRow {
  entityId: string;
  name: string;
  entityType: string | null;
  brandName: string | null;
  brandCode: string | null;
  mentions: number;
  answers: number;
  origin: "scope" | "hub";
  observed: boolean;
  /** Role in the active version (no override row = competitor, the Scope default). */
  activeRole: EcatRole;
  /** Own brand this entity's mentions count toward in the active version (prefix correction, roll-up), independent of the role; null = none. */
  activeOwnBrand: string | null;
  /** The same under the draft (RollupRule on the draft rows; no draft row = as active). null when there is no draft. */
  draftOwnBrand: string | null;
  /** Role in the draft (null = no draft). */
  draftRole: EcatRole | null;
  /** The draft changes this entity's override row (any field). */
  draftChanged: boolean;
  active: EntityOverrideView | null;
  draft: EntityOverrideView | null;
  surfaceCount: number;
}

const OVERRIDE_FIELDS = ["role", "name", "brandCode", "mergeInto", "parentBrandId", "note", "entityType"] as const;

export function sameOverride(a: EntityOverrideView | null, b: EntityOverrideView | null): boolean {
  if (!a || !b) return a === b;
  return OVERRIDE_FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));
}

const legacyRole = (r: S["EntityRow"]["role"]): EcatRole => (r === "own" ? "own" : r === "excluded" ? "hidden" : "competitor");

/**
 * Entity list rows: the observed Brand entities of the list endpoint plus every entity that has an
 * override row in the active or draft version (hub entities, entities not observed in the period,
 * non-Brand entities). The role comes from the version rows; the list endpoint's role is used only
 * when no active version detail is given.
 */
export function mergeEntityRows(
  list: readonly S["EntityRow"][],
  active: VersionDetailView | null,
  draft: VersionDetailView | null,
): ManagedEntityRow[] {
  const act = new Map((active?.entities ?? []).map((e) => [e.entityId, e]));
  const drf = new Map((draft?.entities ?? []).map((e) => [e.entityId, e]));
  const surfaces = new Map<string, number>();
  for (const s of (draft ?? active)?.surfaces ?? []) {
    if (s.entityId) surfaces.set(s.entityId, (surfaces.get(s.entityId) ?? 0) + 1);
  }
  const out: ManagedEntityRow[] = [];
  const seen = new Set<string>();
  const row = (id: string, base: Partial<ManagedEntityRow> & { name: string; fallbackRole: EcatRole }): ManagedEntityRow => {
    const a = act.get(id) ?? null;
    const d = draft ? (drf.get(id) ?? null) : null;
    const activeRole = a ? a.role : active ? "competitor" : base.fallbackRole;
    const draftRole = draft ? (d ? d.role : "competitor") : null;
    const ov = d ?? a;
    const activeOwnBrand = base.activeOwnBrand !== undefined ? base.activeOwnBrand : (a?.effectiveOwnBrand ?? null);
    return {
      entityId: id,
      name: base.name,
      entityType: base.entityType ?? ov?.entityType ?? null,
      brandName: base.brandName ?? ov?.brandName ?? null,
      brandCode: base.brandCode ?? ov?.brandCode ?? null,
      mentions: base.mentions ?? 0,
      answers: base.answers ?? 0,
      origin: ov?.origin ?? "scope",
      observed: base.observed ?? ov?.observed ?? false,
      activeRole,
      activeOwnBrand,
      draftOwnBrand: draft ? (d ? d.effectiveOwnBrand : activeOwnBrand) : null,
      draftRole,
      draftChanged: !!draft && !sameOverride(a, d),
      active: a,
      draft: d,
      surfaceCount: surfaces.get(id) ?? 0,
    };
  };
  for (const r of list) {
    if (seen.has(r.entity_id)) continue;
    seen.add(r.entity_id);
    out.push(
      row(r.entity_id, {
        name: r.name,
        entityType: r.entity_type ?? null,
        brandName: r.brand_name ?? null,
        brandCode: r.brand_code ?? null,
        mentions: r.mentions,
        answers: r.answers,
        observed: true,
        activeOwnBrand: r.own_brand ?? null,
        fallbackRole: legacyRole(r.role),
      }),
    );
  }
  for (const e of [...act.values(), ...drf.values()]) {
    if (seen.has(e.entityId)) continue;
    seen.add(e.entityId);
    out.push(row(e.entityId, { name: e.name ?? e.repName ?? e.entityId, fallbackRole: "competitor" }));
  }
  return out;
}

export interface MentionSamplesView {
  entityId: string;
  name: string | null;
  brandName: string | null;
  entityType: string | null;
  surfaces: { surface: string; n: number }[];
  items: {
    answerKey: number;
    roundDate: string;
    context: string | null;
    highlight: [number, number] | null;
    surfaceText: string | null;
    source: "occurrence" | "body";
    sentiment: string | null;
    turnIndex: number | null;
  }[];
}

export async function getEntityMentions(entityId: string, surfaceText?: string | null, limit = 20): Promise<MentionSamplesView> {
  const res = await hghGet("/v1/admin/entities/{entity_id}/mentions", {
    pathParams: { entity_id: entityId },
    query: { surface: "global", limit, ...(nz(surfaceText) ? { surface_text: nz(surfaceText) as string } : {}) },
    timeoutClass: "adminLong",
  });
  const d = res.data;
  return {
    entityId: d.entity_id,
    name: d.name ?? null,
    brandName: d.brand_name ?? null,
    entityType: d.entity_type ?? null,
    surfaces: (d.surfaces ?? []).map((s) => ({ surface: s.surface, n: s.n })),
    items: d.items.map((m) => ({
      answerKey: m.answer_key,
      roundDate: m.round_date,
      context: m.context ?? null,
      highlight: m.highlight && m.highlight.length === 2 ? [m.highlight[0], m.highlight[1]] : null,
      surfaceText: m.surface_text ?? null,
      source: m.source,
      sentiment: m.sentiment ?? null,
      turnIndex: m.turn_index ?? null,
    })),
  };
}

export function mentionSamples(entityId: string, surfaceText?: string | null): Promise<EcatResult<MentionSamplesView>> {
  return attempt(() => getEntityMentions(entityId, surfaceText));
}

export function versionDiffResult(ver: number, against?: number | null): Promise<EcatResult<VersionDiffView>> {
  return attempt(() => getVersionDiff(ver, against));
}

export function applyDetailResult(applyId: number): Promise<EcatResult<ApplyDetailView>> {
  return attempt(() => getApply(applyId));
}
