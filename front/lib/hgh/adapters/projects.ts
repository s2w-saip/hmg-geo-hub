import "server-only";

// Project management adapter (unit U9): /projects list, /projects/new, /projects/by-scope,
// /projects/[id]/{member,setting,prompt} reads and their server actions (design 3.3 "프로젝트",
// 3.4, appendix E, 4.2 U9 row). The screens keep their props and the actions keep their result
// shapes; this module builds them from /v1 answers. The legacy repositories stay in the page and
// action files as the rollback path (D8); lib/hgh never imports them at runtime.
//
// Source switch (D8): HGH_SOURCE_G6 = api | legacy (sourceGroupFor("projects") = G6), default
// legacy. One flag for the whole unit: pages and actions of one request never mix sources.
//
// Reads (first-render calls, D6 "필수 4개 먼저")
//   /projects              GET /v1/projects?limit=100 to the end (cursor, D5; maxPages 20) +
//                          GET /v1/me/project-invites. 5 legacy queries -> 1 list (card counts and
//                          my_role are on the list items).
//   /projects/new          GET /v1/projects/creation-options (BG-37). Sets from the backend; order
//                          re-ranked by the legacy projectCreationOptions order (bg-projects
//                          DECISIONS-API B-3: the DB has no GEO_BRANDS / RHQ-map order column).
//   /projects/by-scope     GET /v1/projects/by-scope/{scope_project_id} (BG-36).
//   member                 gate GET /v1/projects/{id} + GET …/members + GET …/member-audit?limit=20.
//   setting                gate + GET …/settings + …/settings/tracked-urls (cursor, limit 500) +
//                          …/settings/engines/history (cursor, limit 200); admin only, after
//                          those four: …/settings/scope-link.
//   prompt                 gate + …/prompt-candidates (limit 500) + …/prompts (limit 500) + …/prompt-fields.
// The gate is lib/hgh/adapters/project-gate (U2): admin or active member, else notFound(). The
// raw ProjectDetail the setting page needs is the same in-request deduped GET.
//
// Field maps (API -> screen prop; legacy source in brackets)
//   ProjectListItem -> ProjectRow   project_id->id, brand_code->brand, country_code->country,
//                                   scope_project_id->scopeProjectId, ga4_property_id->ga4PropertyId,
//                                   ai_engines->aiEngines, created_by->createdBy, created_at/updated_at
//                                   -> Date, language -> null [projects.*]
//   ProjectListItem -> ProjectCardData  role = my_role ?? "viewer" [getRolesForProjects, page.tsx
//                                   fallback], promptCount = prompt_count [countByProject.total],
//                                   activeMembers = active_member_count, createdAt ISO
//   totals                          sum(active_member_count), sum(prompt_in_flight_count)
//                                   [countActiveMembersByProject, countByProject.queuedOrRunning]
//   PendingInvite -> PendingRow     membershipId = project_id (the API has no membership id; one
//                                   pending row per user and project), projectName = project_name,
//                                   invitedAt ISO; ascending invited_at [pendingForUser asc]
//   Member -> MemberRow             id = user_id (the member actions address /members/{user_id})
//   MemberAuditEntry -> AuditLogEntry  id = audit_id, actorEmail = actor_email, targetEmail = target_email
//   SettingsBundle                  canEdit = can_edit, canEditEngines = engines.can_edit,
//                                   engines initial = normalizeAiEngines(effective) (legacy
//                                   effectiveAiEngines), explicit = stored !== null,
//                                   ownBrandAliases = brand_aliases.aliases (canonical removed by the
//                                   server), competitors id = brand_name, vehicles id =
//                                   brand + "\u0000" + model, owned base id = base_norm
//   TrackedUrl -> row               id = url_norm
//   EngineHistoryEntry -> entry     id = history_id, changedAt ISO (newest first, as legacy)
//   CandidateItem -> CandidateRow   id = candidate_id, sourceKeyword = source_keyword
//   PromptItem -> PromptRow         id = prompt_id, promptType = prompt_type, brand = brand_code,
//                                   scopePromptId = scope_prompt_id, customValues = tags; API order
//                                   created_at DESC reversed to the legacy ASC
//   FieldItem -> CustomFieldRow     id = field_id (value_count dropped: the list counts values itself)
//   ScopeLink -> ScopeLinkView      admin diagnostic block (component change C2, design 3.5 #11)
// All timestamps are re-serialized with Date#toISOString, the legacy string form.
//
// Writes keep the legacy ActionResult shapes and messages. Error rule (appendix E common part):
//   a code in the action's table            -> {ok:false, error:<legacy Korean message>}
//   401, 403 (owner_only, role/menu, other) -> throw UnauthorizedError (legacy requireOwner / requireMember
//                                              / requireOperate threw); the tables map the few 403s the
//                                              legacy action returned as ok:false (operator_forbidden on
//                                              create / engines)
//   404 without a mapped code               -> throw UnauthorizedError (project hidden: legacy "project not found")
//   other 400 / 409 / 413 / 415 / 422       -> {ok:false, error: GENERIC_INVALID} (logged)
//   429, 5xx, timeout, network              -> {ok:false, error: RETRY_LATER} (logged)
//   local client_config / auth_unbound      -> thrown (deployment fault, not a user error)
// Removals are idempotent as in legacy (a missing row was a silent no-op there): their *_not_found
// codes answer ok. Writes are sent once (retryOn401 only: server actions may refresh cookies).
//
// Known differences (U9 numbering; design DC list does not cover this unit). Asserted in
// projects.test.ts / projects.parity.test.ts where the difference is observable.
//   U9-N1  admin project list: only customer projects (backend kind = 'customer'); legacy listAll
//          also listed the standard root row.
//   U9-N2  by-scope: a site the account may not see on the website surface is 404 (legacy redirected
//          to /website and let that screen narrow it: bg-projects DECISIONS-API B-1); a malformed
//          (non-uuid) scope id is notFound instead of a database error.
//   U9-N3  new project: validation moves to the server (country/brand/engine vocabulary, domain
//          canonicalization); an invalid domain is now refused ("도메인 형식이 올바르지 않습니다") and
//          the "scope 연결 실패" branch is gone (the Scope link is an outbox job; right after
//          creation scope_project_id is null).
//   U9-N4  owned bases / tracked URLs: an http(s)-less or malformed URL answers one message
//          ("올바른 URL 형식이 아닙니다"); legacy distinguished "http(s):// URL만 등록할 수 있어요".
//          The legacy-domain migration hint of the owned-base panel no longer shows: the project
//          domain is derived from the owned bases (read only), so no domain exists without a base.
//   U9-N5  tracked-entity writes always report reprocessable 0 (re-judgment is automatic through
//          judgment_change); the "N건 재분석" dialog no longer opens; triggerReprocess flags nothing
//          and answers flagged 0 (it still requires an active Owner or admin: two reads, the
//          project gate then /v1/auth/me for non-owners; unauthorized callers throw as in legacy).
//   U9-N6  brand aliases saved against a stale project brand answer "프로젝트 브랜드가 바뀌었습니다.
//          새로고침 후 다시 저장해주세요" (409 brand_mismatch); legacy silently deleted the aliases.
//   U9-N7  engine save reports pushed=true with queued=true (the Scope schedule is an outbox job):
//          the panel toasts "저장됨(측정 반영 대기)" instead of the saved / savedNotPushed pair.
//          Component change outside design 3.5 (whose U9 list has only #11 setting/page.tsx): the
//          U9-owned setting/_components/ai-engines-panel.tsx gained one queued branch (two lines,
//          r.value.queued -> t("savedQueued")); on the legacy source queued is undefined, so the
//          saved / savedNotPushed toasts are unchanged there (verification D3).
//   U9-N8  competitor aliases come from project_tracked_competitor only (gap G7 / CK-20): legacy
//          preferred the merged tracked_brands row. Same for new writes; migrated data may differ.
//   U9-N9  prompt lifecycle impact counts use the backend units (answers = served answers, mentions =
//          brand mention rows: 모듈-프로젝트 §9); a draft or published prompt that is not deletable
//          (measured) answers 409 prompt_not_deletable with a new message (legacy deleted any status).
//   U9-N10 pause / resume / hard delete / execute: no synchronous Scope call, so the "scope 반영 실패"
//          and "측정 엔진(scope) 연결에 실패" branches are gone; resume leaves unpublished rows queued.
//   U9-N11 cancelInvite / removeMember on a pending row both remove the invitation; removeMember of a
//          pending row is audited as cancel_invite (legacy: remove). demote of a pending member
//          answers "활성 상태의 멤버만 위임 가능합니다" (legacy: "Viewer는 이미 Viewer입니다").
//   U9-N12 empty-input checks (empty URL, label, value, id list) and the cancelInvite "pending only"
//          check run before the backend's permission check, so a viewer's forged request can get that
//          message instead of a thrown error (the screens never offer these controls to viewers).
//   U9-N13 setTargetCompetitor with an unknown brand keeps the previous target and answers
//          "해당 브랜드를 찾을 수 없습니다" (legacy cleared the target).
//   U9-N14 xlsx import: the rules run on the server (same rules, back/app/features/projects/prompts/io
//          service.py); file limit 5MB and 5,000 rows with explicit messages; tracked-URL rows keyed
//          by the old uuid id column are matched by URL instead (gap G15 / CK-14).
//   U9-N15 member / setting / prompt pages hide projects from pending or removed members exactly as
//          before, but a project id that is not a uuid is notFound without a query (U2 gate).
//   U9-N16 duplicate adds (competitor, tracked URL, owned base, vehicle, tag label) answer the legacy
//          message ("이미 추가된 브랜드입니다" ...). Legacy threw instead: drizzle 0.45 wraps the unique
//          violation in DrizzleQueryError ("Failed query: ..."), so its e.message.includes("unique")
//          branch never matched (reproduced on PGlite in projects.parity.test.ts).
import type { ProjectRow } from "@/lib/db/schema";
import type { User } from "@/lib/auth/types";
import { UnauthorizedError } from "@/lib/auth/errors";
import { projectCreationOptions } from "@/lib/auth/scope-policy";
import { normalizeAiEngines, type AiEngineId } from "@/lib/scope/engines";
import type { PendingRow } from "@/app/[locale]/(dash)/projects/_components/pending-invites";
import type { ProjectCardData } from "@/app/[locale]/(dash)/projects/_components/project-list";
import type { MemberRow } from "@/app/[locale]/(dash)/projects/[id]/member/_components/member-list";
import type { AuditLogEntry } from "@/app/[locale]/(dash)/projects/[id]/member/_components/audit-log";
import type { CandidateRow } from "@/app/[locale]/(dash)/projects/[id]/prompt/_components/candidate-list";
import type { PromptRow, PromptStatus, PromptType } from "@/app/[locale]/(dash)/projects/[id]/prompt/_components/prompt-list";
import type { CustomFieldRow } from "@/app/[locale]/(dash)/projects/[id]/prompt/_components/custom-fields-panel";
import type { EngineHistoryEntry } from "@/app/[locale]/(dash)/projects/[id]/setting/_components/ai-engines-panel";
import type { components } from "../api-types";
import {
  hghDelete,
  hghGet,
  hghPatch,
  hghPost,
  hghPut,
  hghRaw,
  hghSource,
  sourceGroupFor,
  type HghSource,
} from "../client";
import { pct1OrNull } from "../convert";
import { describeHghError, isHghApiError, LOCAL_CODES, throwForPage, type HghApiError } from "../errors";
import { fetchAllPages, pageInfo, type CursorPage } from "../paginate";
import { relayUpload, uploadLimitBytes } from "../relay";
import { isProjectId, requireProjectPage, type GateProject } from "./project-gate";

type S = components["schemas"];
export type ApiProjectListItem = S["ProjectListItem"];
export type ApiProjectDetail = S["ProjectDetail"];
export type ApiPendingInvite = S["PendingInvite"];
export type ApiCreationOptions = S["CreationOptions"];
export type ApiScopeResolution = S["ScopeResolution"];
export type ApiMember = S["Member"];
export type ApiMemberAuditEntry = S["MemberAuditEntry"];
export type ApiSettingsBundle = S["SettingsBundle"];
export type ApiTrackedUrl = S["TrackedUrl"];
export type ApiEngineHistoryEntry = S["EngineHistoryEntry"];
export type ApiScopeLink = S["ScopeLink"];
export type ApiCandidateItem = S["app__features__projects__prompts__candidates__schemas__CandidateItem"];
export type ApiPromptItem = S["app__features__projects__prompts__crud__schemas__PromptItem"];
export type ApiFieldItem = S["FieldItem"];
export type ApiImportSummary = S["ImportSummary"];
export type ApiTrackedUrlImport = S["TrackedUrlImport"];

// ── source switch (D8) ──────────────────────────────────────────────────────

/** HGH_SOURCE_G6 for the project management screens and actions. */
export function projectsSource(env?: Record<string, string | undefined>): HghSource {
  return hghSource(sourceGroupFor("projects"), env);
}

/** True when the unit's group flag is "api" (default legacy). */
export function isProjectsApi(env?: Record<string, string | undefined>): boolean {
  return projectsSource(env) === "api";
}

// ── limits ──────────────────────────────────────────────────────────────────

/** Page sizes (the backend maxima) and page caps for the "read everything" lists (design 2.6). */
export const PAGE = {
  projects: { limit: 100, maxPages: 20 },
  candidates: { limit: 500, maxPages: 40 },
  prompts: { limit: 500, maxPages: 40 },
  trackedUrls: { limit: 500, maxPages: 20 },
  engineHistory: { limit: 200, maxPages: 10 },
  audit: { limit: 20 },
} as const;

/** Backend body limits (CandidateIds 500, BulkSet 1000): bigger selections go in chunks. */
export const CHUNK = { candidateIds: 500, bulkPromptIds: 1000 } as const;

/** Prompt and tracked-URL xlsx import limit (back prompts/io/schemas.py MAX_UPLOAD_BYTES). */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

// ── small shared helpers ────────────────────────────────────────────────────

/** Date#toISOString form of an API timestamp (microseconds cut to ms, "Z"), as legacy produced. */
export function isoLegacy(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

function toDate(value: string): Date {
  return new Date(value);
}

/** Composite id of a tracked vehicle (the delete action splits it back into ?brand=&model=). */
export const VEHICLE_ID_SEP = "\u0000";
export function vehicleId(brand: string, model: string): string {
  return `${brand}${VEHICLE_ID_SEP}${model}`;
}
export function splitVehicleId(id: string): { brand: string; model: string } | null {
  const i = id.indexOf(VEHICLE_ID_SEP);
  if (i <= 0 || i === id.length - 1) return null;
  return { brand: id.slice(0, i), model: id.slice(i + 1) };
}

/**
 * Order `values` by their position in `legacyOrder`; values the legacy order does not know keep
 * their API order after the known ones. The SET always comes from the API.
 */
export function rankByLegacyOrder(values: readonly string[], legacyOrder: readonly string[]): string[] {
  const rank = new Map(legacyOrder.map((v, i) => [v, i] as const));
  return values
    .map((v, i) => ({ v, i, r: rank.get(v) }))
    .sort((a, b) => {
      if (a.r !== undefined && b.r !== undefined) return a.r - b.r;
      if (a.r !== undefined) return -1;
      if (b.r !== undefined) return 1;
      return a.i - b.i;
    })
    .map((x) => x.v);
}

function nextCursorOf(data: { next_cursor?: string | null }, meta: { page?: S["Page"] | null } | null | undefined): string | null {
  return data.next_cursor || pageInfo(meta).nextCursor;
}

// ── /projects (list) ────────────────────────────────────────────────────────

export function toProjectRow(p: ApiProjectListItem): ProjectRow {
  return {
    id: p.project_id,
    name: p.name,
    description: p.description ?? null,
    domain: p.domain ?? null,
    brand: p.brand_code ?? null,
    country: p.country_code,
    language: null,
    scopeProjectId: p.scope_project_id ?? null,
    ga4PropertyId: p.ga4_property_id ?? null,
    aiEngines: p.ai_engines ?? null,
    createdBy: p.created_by,
    createdAt: toDate(p.created_at),
    updatedAt: toDate(p.updated_at),
  };
}

export function toProjectCard(p: ApiProjectListItem): ProjectCardData {
  return {
    id: p.project_id,
    name: p.name,
    domain: p.domain ?? null,
    role: p.my_role ?? "viewer",
    promptCount: p.prompt_count ?? 0,
    activeMembers: p.active_member_count ?? 0,
    createdAt: isoLegacy(p.created_at),
  };
}

export function toPendingRows(items: readonly ApiPendingInvite[]): PendingRow[] {
  return items
    .map((p, i) => ({ p, i }))
    .sort((a, b) => Date.parse(a.p.invited_at) - Date.parse(b.p.invited_at) || a.i - b.i)
    .map(({ p }) => ({
      membershipId: p.project_id,
      projectId: p.project_id,
      projectName: p.project_name,
      invitedAt: isoLegacy(p.invited_at),
    }));
}

export interface ProjectsListView {
  /** ProjectsOverview input (brand / country / createdAt distributions). */
  projects: ProjectRow[];
  cards: ProjectCardData[];
  pending: PendingRow[];
  totalActiveMembers: number;
  totalQueuedPrompts: number;
}

export function toProjectsListView(items: readonly ApiProjectListItem[], invites: readonly ApiPendingInvite[]): ProjectsListView {
  return {
    projects: items.map(toProjectRow),
    cards: items.map(toProjectCard),
    pending: toPendingRows(invites),
    totalActiveMembers: items.reduce((s, p) => s + (p.active_member_count ?? 0), 0),
    totalQueuedPrompts: items.reduce((s, p) => s + (p.prompt_in_flight_count ?? 0), 0),
  };
}

/** Every project the session may list (admin: all customer projects; others: active memberships). */
export async function fetchAllProjects(): Promise<ApiProjectListItem[]> {
  const res = await fetchAllPages<ApiProjectListItem>(
    async (cursor) => {
      const r = await hghGet("/v1/projects", { query: { limit: PAGE.projects.limit, cursor } });
      return { items: r.data.items, nextCursor: nextCursorOf(r.data, r.meta) };
    },
    { maxPages: PAGE.projects.maxPages },
  );
  return res.items;
}

export async function fetchPendingInvites(): Promise<ApiPendingInvite[]> {
  const r = await hghGet("/v1/me/project-invites");
  return r.data.items;
}

/** /projects page data. Page errors (401 login, 5xx boundary) via throwForPage. */
export async function loadProjectsList(locale: string): Promise<ProjectsListView> {
  try {
    const [items, invites] = await Promise.all([fetchAllProjects(), fetchPendingInvites()]);
    return toProjectsListView(items, invites);
  } catch (e) {
    throwForPage(e, locale);
  }
}

// ── /projects/new ───────────────────────────────────────────────────────────

export interface CreationOptionsView {
  brands: string[];
  countries: string[];
  brandLocked: boolean;
  /** Selectable engine codes and the form default (BG-37); the form still uses its constants (U9 request R2). */
  engines: string[];
  defaultEngines: string[];
}

/** API options re-ranked by the legacy order for this user (sets unchanged). */
export function toCreationOptionsView(data: ApiCreationOptions, user: User): CreationOptionsView {
  const legacy = projectCreationOptions(user);
  return {
    brands: rankByLegacyOrder(data.brands, legacy.brands),
    countries: rankByLegacyOrder(data.countries, legacy.countries),
    brandLocked: data.brand_locked,
    engines: [...data.engines],
    defaultEngines: [...data.default_engines],
  };
}

/**
 * GET /v1/projects/creation-options. 403 operator_forbidden (not a project creator) -> null, the page
 * sends the user back to /projects like legacy. Other failures go through throwForPage.
 */
export async function loadCreationOptions(locale: string, user: User): Promise<CreationOptionsView | null> {
  try {
    const r = await hghGet("/v1/projects/creation-options");
    return toCreationOptionsView(r.data, user);
  } catch (e) {
    if (isHghApiError(e) && e.status === 403 && e.code === "operator_forbidden") return null;
    throwForPage(e, locale);
  }
}

// ── /projects/by-scope/[scopeId] ────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ScopeTarget =
  | { kind: "project"; projectId: string }
  | { kind: "website"; brand: string; country: string };

export function toScopeTarget(d: ApiScopeResolution): ScopeTarget | null {
  if (d.kind === "project" && d.project_id) return { kind: "project", projectId: d.project_id };
  if (d.kind === "website" && d.brand_code && d.country_code) {
    return { kind: "website", brand: d.brand_code, country: d.country_code };
  }
  return null;
}

/** BG-36 resolver. null = notFound (unknown id, hidden project, invisible site, non-uuid id: U9-N2). */
export async function resolveByScope(locale: string, scopeId: string): Promise<ScopeTarget | null> {
  if (!UUID_RE.test(scopeId)) return null;
  try {
    const r = await hghGet("/v1/projects/by-scope/{scope_project_id}", { pathParams: { scope_project_id: scopeId } });
    return toScopeTarget(r.data);
  } catch (e) {
    if (isHghApiError(e) && e.status === 404) return null;
    throwForPage(e, locale);
  }
}

// ── project pages: gate + detail ────────────────────────────────────────────

export interface ProjectPageAccess {
  gate: GateProject;
  isAdmin: boolean;
  /** Legacy canEdit: admin or the active Owner. */
  canEdit: boolean;
}

/** The U2 page gate plus the legacy canEdit rule (admin or active Owner). */
export async function requireProjectAccess(locale: string, id: string, isAdmin: boolean): Promise<ProjectPageAccess> {
  const gate = await requireProjectPage(locale, id);
  return { gate, isAdmin, canEdit: isAdmin || gate.myRole === "owner" };
}

async function projectDetail(locale: string, id: string): Promise<ApiProjectDetail> {
  try {
    // Same path, params and options as the gate: deduped in the request (one HTTP call).
    const r = await hghGet("/v1/projects/{project_id}", { pathParams: { project_id: id } });
    return r.data;
  } catch (e) {
    throwForPage(e, locale, { permission: "not-found" });
  }
}

// ── member page ─────────────────────────────────────────────────────────────

export function toMemberRow(m: ApiMember): MemberRow {
  return { id: m.user_id, email: m.email, role: m.role, status: m.status, invitedAt: isoLegacy(m.invited_at) };
}

export function toAuditEntry(e: ApiMemberAuditEntry): AuditLogEntry {
  return {
    id: e.audit_id,
    actorEmail: e.actor_email ?? null,
    targetEmail: e.target_email ?? null,
    action: e.action,
    context: e.context ?? null,
    createdAt: isoLegacy(e.created_at),
  };
}

export interface MemberPageData {
  canEdit: boolean;
  members: MemberRow[];
  audit: AuditLogEntry[];
}

export async function loadMemberPage(locale: string, id: string, isAdmin: boolean): Promise<MemberPageData> {
  const access = await requireProjectAccess(locale, id, isAdmin);
  try {
    const [members, audit] = await Promise.all([
      hghGet("/v1/projects/{project_id}/members", { pathParams: { project_id: id } }),
      hghGet("/v1/projects/{project_id}/member-audit", { pathParams: { project_id: id }, query: { limit: PAGE.audit.limit } }),
    ]);
    return {
      canEdit: access.canEdit,
      members: members.data.items.map(toMemberRow),
      audit: audit.data.items.map(toAuditEntry),
    };
  } catch (e) {
    throwForPage(e, locale, { permission: "not-found" });
  }
}

// ── setting page ────────────────────────────────────────────────────────────

export type ScopeLinkState = ApiScopeLink["state"];

export interface ScopeLinkView {
  state: ScopeLinkState;
  latestRound: { roundDate: string; status: string; servable: boolean } | null;
  jobs: {
    total: number;
    served: number;
    /** served / total as a one-decimal percent; null when there are no jobs (block hides it). */
    servedPct: number | null;
    inProgress: number;
    failed: number;
    lastMeasuredAt: string | null;
  } | null;
  outbox: { pending: number; erroring: number; promptPending: number };
}

export function toScopeLinkView(d: ApiScopeLink): ScopeLinkView {
  return {
    state: d.state,
    latestRound: d.latest_round
      ? { roundDate: d.latest_round.round_date, status: d.latest_round.status, servable: d.latest_round.servable }
      : null,
    jobs: d.jobs
      ? {
          total: d.jobs.total,
          served: d.jobs.served,
          servedPct: pct1OrNull(d.jobs.served_ratio),
          inProgress: d.jobs.in_progress,
          failed: d.jobs.failed,
          lastMeasuredAt: d.jobs.last_measured_at ? isoLegacy(d.jobs.last_measured_at) : null,
        }
      : null,
    outbox: { pending: d.outbox.pending, erroring: d.outbox.erroring, promptPending: d.outbox.prompt_pending },
  };
}

export interface SettingsPageData {
  project: {
    name: string;
    description: string | null;
    brand: string | null;
    country: string;
    ga4PropertyId: string | null;
    domain: string | null;
  };
  canEdit: boolean;
  canEditEngines: boolean;
  engines: { initial: AiEngineId[]; explicit: boolean };
  engineHistory: EngineHistoryEntry[];
  ownedBases: { id: string; baseUrl: string; label: string | null }[];
  trackedUrls: { id: string; url: string; label: string | null }[];
  ownBrandAliases: string[];
  designatedBrands: { id: string; brandName: string; aliases: string[]; notes: string | null; isTarget: boolean }[];
  vehicles: { id: string; brand: string; model: string; segment: string | null; aliases: string[] }[];
  scopeLink: { status: "missing" | "root" | "linked"; scopeProjectId: string | null };
}

export function toSettingsPageData(
  detail: ApiProjectDetail,
  bundle: ApiSettingsBundle,
  trackedUrls: readonly ApiTrackedUrl[],
  history: readonly ApiEngineHistoryEntry[],
): SettingsPageData {
  return {
    project: {
      name: detail.name,
      description: detail.description ?? null,
      brand: detail.brand_code ?? null,
      country: detail.country_code,
      ga4PropertyId: detail.ga4_property_id ?? null,
      domain: bundle.domain ?? detail.domain ?? null,
    },
    canEdit: bundle.can_edit,
    canEditEngines: bundle.engines.can_edit ?? false,
    engines: { initial: normalizeAiEngines(bundle.engines.effective), explicit: bundle.engines.stored != null },
    engineHistory: history.map((h) => ({ id: h.history_id, engines: [...h.engines], changedAt: isoLegacy(h.changed_at) })),
    ownedBases: bundle.owned_bases.map((b) => ({ id: b.base_norm, baseUrl: b.base_url, label: b.label ?? null })),
    trackedUrls: trackedUrls.map((u) => ({ id: u.url_norm, url: u.url, label: u.label ?? null })),
    ownBrandAliases: detail.brand_code ? [...(bundle.brand_aliases.aliases ?? [])] : [],
    designatedBrands: bundle.competitors.map((c) => ({
      id: c.brand_name,
      brandName: c.brand_name,
      aliases: [...(c.aliases ?? [])],
      notes: c.notes ?? null,
      isTarget: c.is_target ?? false,
    })),
    vehicles: bundle.vehicles.map((v) => ({
      id: vehicleId(v.brand, v.model),
      brand: v.brand,
      model: v.model,
      segment: v.segment ?? null,
      aliases: [...(v.aliases ?? [])],
    })),
    // "root" is unreachable: the standard root project is 404 on customer routes.
    scopeLink: detail.scope_project_id
      ? { status: "linked", scopeProjectId: detail.scope_project_id }
      : { status: "missing", scopeProjectId: null },
  };
}

async function allTrackedUrls(id: string): Promise<ApiTrackedUrl[]> {
  const res = await fetchAllPages<ApiTrackedUrl>(
    async (cursor): Promise<CursorPage<ApiTrackedUrl>> => {
      const r = await hghGet("/v1/projects/{project_id}/settings/tracked-urls", {
        pathParams: { project_id: id },
        query: { limit: PAGE.trackedUrls.limit, cursor },
      });
      return { items: r.data.items, nextCursor: nextCursorOf(r.data, r.meta), total: r.data.total };
    },
    { maxPages: PAGE.trackedUrls.maxPages },
  );
  return res.items;
}

async function allEngineHistory(id: string): Promise<ApiEngineHistoryEntry[]> {
  const res = await fetchAllPages<ApiEngineHistoryEntry>(
    async (cursor) => {
      const r = await hghGet("/v1/projects/{project_id}/settings/engines/history", {
        pathParams: { project_id: id },
        query: { limit: PAGE.engineHistory.limit, cursor },
      });
      return { items: r.data.items, nextCursor: nextCursorOf(r.data, r.meta) };
    },
    { maxPages: PAGE.engineHistory.maxPages },
  );
  return res.items;
}

/**
 * Admin Scope-link diagnostic. A transient failure degrades to "no diagnostic" (one log line), as
 * the legacy probe reported its own errors inside the block instead of failing the page.
 */
export async function loadScopeLink(id: string): Promise<ScopeLinkView | null> {
  try {
    const r = await hghGet("/v1/projects/{project_id}/settings/scope-link", { pathParams: { project_id: id } });
    return toScopeLinkView(r.data);
  } catch (e) {
    if (!isHghApiError(e) || e.code === LOCAL_CODES.config) throw e;
    console.warn(describeHghError(e));
    return null;
  }
}

export interface SettingsPageLoad {
  data: SettingsPageData;
  isAdmin: boolean;
  diagnostic: ScopeLinkView | null;
}

export async function loadSettingsPage(locale: string, id: string, isAdmin: boolean): Promise<SettingsPageLoad> {
  await requireProjectPage(locale, id);
  let data: SettingsPageData;
  try {
    // D6: the four first calls (detail is the gate's deduped GET), then the admin-only probe.
    const [detail, bundle, urls, history] = await Promise.all([
      projectDetail(locale, id),
      hghGet("/v1/projects/{project_id}/settings", { pathParams: { project_id: id } }),
      allTrackedUrls(id),
      allEngineHistory(id),
    ]);
    data = toSettingsPageData(detail, bundle.data, urls, history);
  } catch (e) {
    throwForPage(e, locale, { permission: "not-found" });
  }
  const diagnostic = isAdmin ? await loadScopeLink(id) : null;
  return { data, isAdmin, diagnostic };
}

// ── prompt page ─────────────────────────────────────────────────────────────

export function toCandidateRow(c: ApiCandidateItem): CandidateRow {
  return {
    id: c.candidate_id,
    source: c.source,
    sourceKeyword: c.source_keyword ?? null,
    text: c.text,
    createdAt: isoLegacy(c.created_at),
  };
}

export function toPromptRows(items: readonly ApiPromptItem[], reverse = true): PromptRow[] {
  // API order: created_at DESC, prompt_id DESC. Legacy order: created_at ASC.
  return (reverse ? [...items].reverse() : items).map((p) => ({
    id: p.prompt_id,
    text: p.text,
    promptType: (p.prompt_type ?? null) as PromptType | null,
    category: p.category ?? null,
    brand: p.brand_code ?? null,
    status: p.status as PromptStatus,
    scopePromptId: p.scope_prompt_id ?? null,
    customValues: { ...(p.tags ?? {}) },
  }));
}

export function toCustomFieldRow(f: ApiFieldItem): CustomFieldRow {
  return { id: f.field_id, label: f.label, archived: f.archived };
}

export interface PromptPageData {
  canEdit: boolean;
  candidates: CandidateRow[];
  prompts: PromptRow[];
  customFields: CustomFieldRow[];
}

async function allCandidates(id: string): Promise<ApiCandidateItem[]> {
  const res = await fetchAllPages<ApiCandidateItem>(
    async (cursor) => {
      const r = await hghGet("/v1/projects/{project_id}/prompt-candidates", {
        pathParams: { project_id: id },
        query: { limit: PAGE.candidates.limit, cursor },
      });
      return { items: r.data.items, nextCursor: nextCursorOf(r.data, r.meta) };
    },
    { maxPages: PAGE.candidates.maxPages },
  );
  return res.items;
}

async function allPrompts(id: string): Promise<ApiPromptItem[]> {
  const res = await fetchAllPages<ApiPromptItem>(
    async (cursor) => {
      const r = await hghGet("/v1/projects/{project_id}/prompts", {
        pathParams: { project_id: id },
        query: { limit: PAGE.prompts.limit, cursor },
      });
      return { items: r.data.items, nextCursor: nextCursorOf(r.data, r.meta) };
    },
    { maxPages: PAGE.prompts.maxPages },
  );
  return res.items;
}

export async function loadPromptPage(locale: string, id: string, isAdmin: boolean): Promise<PromptPageData> {
  const access = await requireProjectAccess(locale, id, isAdmin);
  try {
    const [candidates, prompts, fields] = await Promise.all([
      allCandidates(id),
      allPrompts(id),
      hghGet("/v1/projects/{project_id}/prompt-fields", { pathParams: { project_id: id } }),
    ]);
    return {
      canEdit: access.canEdit,
      candidates: candidates.map(toCandidateRow),
      prompts: toPromptRows(prompts),
      customFields: fields.data.items.map(toCustomFieldRow),
    };
  } catch (e) {
    throwForPage(e, locale, { permission: "not-found" });
  }
}

// ── writes: error mapping ───────────────────────────────────────────────────

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: string };
export type ActionFailure = { ok: false; error: string };

/** Unmapped 400/409/413/415/422: the request was refused for a reason this screen has no copy for. */
export const GENERIC_INVALID = "요청을 처리하지 못했습니다. 새로고침 후 다시 시도해주세요";
/** 429, 5xx, timeout, network (appendix E: "잠시 후 다시 시도해주세요"). */
export const RETRY_LATER = "잠시 후 다시 시도해주세요";

/** Code -> legacy message. A function sees the error (only used where appendix E reads details). */
export type ErrorTable = Readonly<Record<string, string | ((e: HghApiError) => string)>>;

const FATAL_LOCAL = new Set<string>([LOCAL_CODES.config, LOCAL_CODES.authUnbound]);

/**
 * Map a failed write. Returns the ActionFailure, or "ok" when the code is in okCodes (idempotent
 * removals). Throws for access failures (legacy threw UnauthorizedError) and non-API errors.
 */
export function writeFailure(e: unknown, table: ErrorTable, okCodes: readonly string[] = []): ActionFailure | "ok" {
  if (!isHghApiError(e)) throw e;
  if (FATAL_LOCAL.has(e.code)) throw e;
  const mapped = table[e.code];
  if (mapped !== undefined) return { ok: false, error: typeof mapped === "function" ? mapped(e) : mapped };
  if (okCodes.includes(e.code)) return "ok";
  if (e.status === 401) throw new UnauthorizedError("session");
  if (e.status === 403) throw new UnauthorizedError(e.code);
  if (e.status === 404) throw new UnauthorizedError("project not found");
  console.warn(describeHghError(e));
  if ([400, 409, 413, 415, 422].includes(e.status)) return { ok: false, error: GENERIC_INVALID };
  return { ok: false, error: RETRY_LATER };
}

async function run<T>(call: () => Promise<T>, table: ErrorTable, okCodes: readonly string[] = []): Promise<{ ok: true; value: T | null } | ActionFailure> {
  try {
    return { ok: true, value: await call() };
  } catch (e) {
    const f = writeFailure(e, table, okCodes);
    return f === "ok" ? { ok: true, value: null } : f;
  }
}

const W = { retryOn401: true } as const;
const pid = (projectId: string) => ({ project_id: projectId });

function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

function normalizeAliasList(raw?: readonly string[] | null): string[] {
  return [...new Set((raw ?? []).map((v) => v.trim()).filter(Boolean))];
}

// ── writes: /projects/new ───────────────────────────────────────────────────

export const CREATE_ERRORS: ErrorTable = {
  operator_forbidden: "프로젝트 생성 권한(운영자)이 없습니다",
  country_forbidden: "선택한 국가에 대한 권한이 없습니다",
  brand_forbidden: "선택한 브랜드에 대한 권한이 없습니다",
  unknown_brand: "선택한 브랜드에 대한 권한이 없습니다",
  engines_required: "AI 엔진을 1개 이상 선택해주세요",
  unknown_engine: "AI 엔진을 1개 이상 선택해주세요",
  invalid_url: "도메인 형식이 올바르지 않습니다",
};

/**
 * createProject body. Legacy input checks kept in front of the call with the same messages (name,
 * country, at least one engine); every scope / vocabulary rule is the server's. Returns the new
 * project id (the action redirects) or the failure.
 */
export async function createProject(formData: FormData): Promise<{ ok: true; projectId: string } | ActionFailure> {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const domain = String(formData.get("domain") ?? "").trim();
  const brand = String(formData.get("brand") ?? "").trim();
  const country = String(formData.get("country") ?? "").trim();
  const engines = [...new Set(formData.getAll("aiEngines").map((v) => String(v).trim()).filter(Boolean))];
  if (!name) return { ok: false, error: "제목을 입력해주세요" };
  if (!country) return { ok: false, error: "국가를 선택해주세요" };
  if (engines.length === 0) return { ok: false, error: "AI 엔진을 1개 이상 선택해주세요" };
  const r = await run(
    () =>
      hghPost("/v1/projects", {
        ...W,
        body: {
          name,
          description: description || null,
          domain: domain || null,
          brand_code: brand || null,
          country_code: country,
          ai_engines: engines,
        },
      }),
    CREATE_ERRORS,
  );
  if (!r.ok) return r;
  return { ok: true, projectId: r.value!.data.project_id };
}

// ── writes: members ─────────────────────────────────────────────────────────

/**
 * Duplicate invite 409 (U9-1): the backend names the two legacy cases by code (roster/service.py
 * already_member_error), active -> already_member, pending -> already_invited, the concurrent
 * insert path included. details.status is kept by the backend for compatibility only; the screen
 * branches on the code (legacy member/_actions.ts: existing.status === "active").
 */
export const INVITE_ERRORS: ErrorTable = {
  unprocessable: "이메일 형식이 올바르지 않습니다",
  invalid_value: "이메일 형식이 올바르지 않습니다",
  invitee_not_found: "해당 이메일로 가입된 사용자를 찾을 수 없습니다",
  self_invite: "본인을 초대할 수 없습니다",
  already_member: "이미 멤버입니다",
  already_invited: "이미 초대된 사용자입니다 (대기 상태)",
};

export async function inviteMember(projectId: string, email: string): Promise<ActionResult> {
  const r = await run(
    () => hghPost("/v1/projects/{project_id}/members", { ...W, pathParams: pid(projectId), body: { email } }),
    INVITE_ERRORS,
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

const MEMBER_NOT_FOUND = "해당 멤버를 찾을 수 없습니다";

export const REMOVE_ERRORS: ErrorTable = {
  member_not_found: MEMBER_NOT_FOUND,
  cannot_remove_owner: "Owner는 제거할 수 없습니다 (Owner 위임 후 다시 시도)",
  cannot_remove_self: "본인을 제거할 수 없습니다",
  unprocessable: MEMBER_NOT_FOUND,
};

/**
 * cancelInvite: the API deletes pending and active rows alike, so the legacy "pending only" check
 * reads the roster first (owner-readable) and keeps the legacy messages.
 */
export async function cancelInvite(projectId: string, userId: string): Promise<ActionResult> {
  const roster = await run(
    // Same refresh-and-retry as every other server-action call (verification D1): an expired
    // access token must not end the action here while the DELETE below would have refreshed.
    () => hghGet("/v1/projects/{project_id}/members", { ...W, pathParams: pid(projectId), dedupe: false }),
    {},
  );
  if (!roster.ok) return roster;
  const target = roster.value!.data.items.find((m) => m.user_id === userId);
  if (!target) return { ok: false, error: MEMBER_NOT_FOUND };
  if (target.status !== "pending") return { ok: false, error: "대기 중인 초대만 취소할 수 있습니다" };
  const r = await run(
    () => hghDelete("/v1/projects/{project_id}/members/{user_id}", { ...W, pathParams: { project_id: projectId, user_id: userId } }),
    REMOVE_ERRORS,
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

export async function removeMember(projectId: string, userId: string): Promise<ActionResult> {
  const r = await run(
    () => hghDelete("/v1/projects/{project_id}/members/{user_id}", { ...W, pathParams: { project_id: projectId, user_id: userId } }),
    REMOVE_ERRORS,
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

export const INVITE_RESPONSE_ERRORS: ErrorTable = {
  no_pending_invite: "대기 중인 초대가 아닙니다",
  not_found: "대기 중인 초대가 아닙니다",
  unprocessable: "대기 중인 초대가 아닙니다",
};

/** accept / reject: `membershipId` carries the project id on this source (toPendingRows). */
export async function respondToInvite(membershipId: string, answer: "accept" | "reject"): Promise<ActionResult> {
  const r = await run(
    () =>
      answer === "accept"
        ? hghPost("/v1/projects/{project_id}/members/me/accept", { ...W, pathParams: pid(membershipId) })
        : hghPost("/v1/projects/{project_id}/members/me/reject", { ...W, pathParams: pid(membershipId) }),
    INVITE_RESPONSE_ERRORS,
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

export const PROMOTE_ERRORS: ErrorTable = {
  already_that_role: "이미 Owner입니다",
  not_active: "활성 상태의 멤버만 위임 가능합니다",
  member_not_found: MEMBER_NOT_FOUND,
  unprocessable: MEMBER_NOT_FOUND,
};
export const DEMOTE_ERRORS: ErrorTable = {
  already_that_role: "Viewer는 이미 Viewer입니다",
  last_owner_cannot_demote: "마지막 Owner는 강등할 수 없습니다",
  not_active: "활성 상태의 멤버만 위임 가능합니다",
  member_not_found: MEMBER_NOT_FOUND,
  unprocessable: MEMBER_NOT_FOUND,
};

export async function changeMemberRole(projectId: string, userId: string, role: "owner" | "viewer"): Promise<ActionResult> {
  const r = await run(
    () =>
      hghPatch("/v1/projects/{project_id}/members/{user_id}", {
        ...W,
        pathParams: { project_id: projectId, user_id: userId },
        body: { role },
      }),
    role === "owner" ? PROMOTE_ERRORS : DEMOTE_ERRORS,
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

// ── writes: settings ────────────────────────────────────────────────────────

/**
 * triggerReprocess on the api source: nothing to trigger (U9-N5), but the caller still has to be
 * what legacy requireOwner accepted (verification D2): active Owner of the project, or admin.
 * Anyone else (no session, viewer, pending, hidden project) gets the legacy throw. Reads only.
 */
export async function authorizeReprocess(projectId: string): Promise<ActionResult<{ flagged: number }>> {
  if (!isProjectId(projectId)) throw new UnauthorizedError("project not found");
  const gate = await run(
    () => hghGet("/v1/projects/{project_id}", { ...W, pathParams: pid(projectId) }),
    {},
  );
  if (!gate.ok) return gate;
  if (gate.value!.data.my_role !== "owner") {
    const me = await run(() => hghGet("/v1/auth/me", W), {});
    if (!me.ok) return me;
    if (me.value!.data.role !== "admin") throw new UnauthorizedError("setting action requires active Owner");
  }
  return { ok: true, value: { flagged: 0 } };
}

export interface ProjectPatchInput {
  name?: string;
  description?: string | null;
  domain?: string | null;
  brand?: string | null;
  brandAliases?: string[] | null;
  brandAliasesBrand?: string | null;
  ga4PropertyId?: string | null;
}

const BRAND_SCOPE = "브랜드는 본인 권한 내에서만 선택 가능합니다";
const BRAND_CHANGED = "프로젝트 브랜드가 바뀌었습니다. 새로고침 후 다시 저장해주세요";

export const PATCH_ERRORS: ErrorTable = {
  name_required: "프로젝트 명을 입력해주세요",
  invalid_ga4_property_id: "GA4 속성 ID는 숫자만 입력하세요 (예: 469542848)",
  unknown_brand: BRAND_SCOPE,
  brand_forbidden: BRAND_SCOPE,
};
export const ALIAS_ERRORS: ErrorTable = {
  brand_mismatch: BRAND_CHANGED,
  no_project_brand: BRAND_CHANGED,
};

/**
 * updateProject: general fields -> PATCH /v1/projects/{id} (domain is read-only on the API: derived
 * from the owned bases, so it is not sent), aliases -> PUT …/settings/brand-aliases. reprocessable is
 * always 0 (U9-N5).
 */
export async function updateProject(projectId: string, patch: ProjectPatchInput): Promise<ActionResult<{ reprocessable: number }>> {
  const body: S["ProjectPatch"] = {};
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) return { ok: false, error: "프로젝트 명을 입력해주세요" };
    body.name = trimmed;
  }
  if (patch.description !== undefined) body.description = patch.description?.trim() || null;
  if (patch.brand !== undefined) body.brand_code = patch.brand?.trim() || null;
  if (patch.ga4PropertyId !== undefined) body.ga4_property_id = patch.ga4PropertyId?.trim() || null;
  if (Object.keys(body).length > 0) {
    const r = await run(
      () => hghPatch("/v1/projects/{project_id}", { ...W, pathParams: pid(projectId), body }),
      PATCH_ERRORS,
      ["empty_patch"],
    );
    if (!r.ok) return r;
  }
  if (patch.brandAliases !== undefined) {
    const brand = patch.brandAliasesBrand?.trim() || null;
    if (!brand) return { ok: false, error: BRAND_CHANGED };
    const r = await run(
      () =>
        hghPut("/v1/projects/{project_id}/settings/brand-aliases", {
          ...W,
          pathParams: pid(projectId),
          body: { brand_code: brand, aliases: normalizeAliasList(patch.brandAliases) },
        }),
      ALIAS_ERRORS,
    );
    if (!r.ok) return r;
  }
  return { ok: true, value: { reprocessable: 0 } };
}

export const ENGINES_ERRORS: ErrorTable = {
  operator_forbidden: "AI 엔진 변경 권한(운영자)이 없습니다",
  unknown_engine: "알 수 없는 엔진입니다",
};

export async function updateProjectEngines(
  projectId: string,
  engines: string[],
): Promise<ActionResult<{ engines: string[]; changed: boolean; pushed: boolean; queued: boolean }>> {
  const r = await run(
    () =>
      hghPut("/v1/projects/{project_id}/settings/engines", {
        ...W,
        pathParams: pid(projectId),
        body: { engines: normalizeAiEngines(engines) },
      }),
    ENGINES_ERRORS,
  );
  if (!r.ok) return r;
  const d = r.value!.data;
  // pushed: the Scope schedule is an outbox job now (G6); queued tells the panel to say so (U9-N7).
  return { ok: true, value: { engines: normalizeAiEngines(d.engines), changed: d.changed, pushed: true, queued: true } };
}

export const DELETE_PROJECT_ERRORS: ErrorTable = {
  name_mismatch: "입력한 이름이 프로젝트 명과 일치하지 않습니다",
};

export async function deleteProject(projectId: string, confirmName: string): Promise<ActionResult> {
  const name = confirmName.trim();
  if (!name) return { ok: false, error: "입력한 이름이 프로젝트 명과 일치하지 않습니다" };
  const r = await run(
    () => hghDelete("/v1/projects/{project_id}", { ...W, pathParams: pid(projectId), body: { confirm_name: name } }),
    DELETE_PROJECT_ERRORS,
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

export const COMPETITOR_ERRORS: ErrorTable = {
  duplicate_competitor: "이미 추가된 브랜드입니다",
  required: "브랜드 이름을 입력해주세요",
};

export async function addTrackedCompetitor(
  projectId: string,
  input: { brandName: string; aliases?: string[] | null; notes?: string | null },
): Promise<ActionResult<{ id: string; reprocessable: number }>> {
  const brandName = input.brandName.trim();
  if (!brandName) return { ok: false, error: "브랜드 이름을 입력해주세요" };
  const r = await run(
    () =>
      hghPost("/v1/projects/{project_id}/settings/competitors", {
        ...W,
        pathParams: pid(projectId),
        body: { brand_name: brandName, aliases: normalizeAliasList(input.aliases), notes: input.notes?.trim() || null },
      }),
    COMPETITOR_ERRORS,
  );
  if (!r.ok) return r;
  return { ok: true, value: { id: r.value!.data.competitor?.brand_name ?? brandName, reprocessable: 0 } };
}

export async function removeTrackedCompetitor(projectId: string, id: string): Promise<ActionResult<{ reprocessable: number }>> {
  const r = await run(
    () => hghDelete("/v1/projects/{project_id}/settings/competitors", { ...W, pathParams: pid(projectId), query: { brand_name: id } }),
    {},
    ["competitor_not_found"],
  );
  return r.ok ? { ok: true, value: { reprocessable: 0 } } : r;
}

export const TARGET_ERRORS: ErrorTable = {
  competitor_not_found: "해당 브랜드를 찾을 수 없습니다",
};

export async function setTargetCompetitor(projectId: string, id: string | null): Promise<ActionResult> {
  const r = await run(
    () =>
      hghPut("/v1/projects/{project_id}/settings/competitors/target", {
        ...W,
        pathParams: pid(projectId),
        body: { brand_name: id },
      }),
    TARGET_ERRORS,
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

export const VEHICLE_ERRORS: ErrorTable = {
  duplicate_vehicle: "이미 추가된 모델입니다",
};

export async function addTrackedVehicle(
  projectId: string,
  input: { brand: string; model: string; segment?: string | null; aliases?: string[] | null },
): Promise<ActionResult<{ id: string; reprocessable: number }>> {
  const brand = input.brand.trim();
  const model = input.model.trim();
  if (!brand) return { ok: false, error: "브랜드를 입력해주세요" };
  if (!model) return { ok: false, error: "모델명을 입력해주세요" };
  const r = await run(
    () =>
      hghPost("/v1/projects/{project_id}/settings/vehicles", {
        ...W,
        pathParams: pid(projectId),
        body: { brand, model, segment: input.segment?.trim() || null, aliases: normalizeAliasList(input.aliases) },
      }),
    VEHICLE_ERRORS,
  );
  if (!r.ok) return r;
  const v = r.value!.data.vehicle;
  return { ok: true, value: { id: vehicleId(v?.brand ?? brand, v?.model ?? model), reprocessable: 0 } };
}

export async function removeTrackedVehicle(projectId: string, id: string): Promise<ActionResult<{ reprocessable: number }>> {
  const key = splitVehicleId(id);
  // A malformed id matches nothing: legacy deleted nothing and answered ok.
  if (!key) return { ok: true, value: { reprocessable: 0 } };
  const r = await run(
    () =>
      hghDelete("/v1/projects/{project_id}/settings/vehicles", {
        ...W,
        pathParams: pid(projectId),
        query: { brand: key.brand, model: key.model },
      }),
    {},
    ["vehicle_not_found"],
  );
  return r.ok ? { ok: true, value: { reprocessable: 0 } } : r;
}

const INVALID_URL = "올바른 URL 형식이 아닙니다";

export const OWNED_BASE_ERRORS: ErrorTable = {
  duplicate_owned_base: "이미 등록된 owned base예요",
  invalid_url: INVALID_URL,
};

export async function addOwnedBase(projectId: string, input: { baseUrl: string; label?: string | null }): Promise<ActionResult<{ id: string }>> {
  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) return { ok: false, error: "Owned base URL을 입력해주세요" };
  const r = await run(
    () =>
      hghPost("/v1/projects/{project_id}/settings/owned-bases", {
        ...W,
        pathParams: pid(projectId),
        body: { base_url: baseUrl, label: input.label?.trim() || null },
      }),
    OWNED_BASE_ERRORS,
  );
  return r.ok ? { ok: true, value: { id: r.value!.data.base_norm } } : r;
}

export async function removeOwnedBase(projectId: string, id: string): Promise<ActionResult> {
  const r = await run(
    () => hghDelete("/v1/projects/{project_id}/settings/owned-bases", { ...W, pathParams: pid(projectId), query: { base_norm: id } }),
    {},
    ["owned_base_not_found"],
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

export const TRACKED_URL_ERRORS: ErrorTable = {
  duplicate_tracked_url: "이미 등록된 URL이에요",
  invalid_url: INVALID_URL,
};

export async function addTrackedUrl(projectId: string, input: { url: string; label?: string | null }): Promise<ActionResult<{ id: string }>> {
  const url = input.url.trim();
  if (!url) return { ok: false, error: "URL을 입력해주세요" };
  const r = await run(
    () =>
      hghPost("/v1/projects/{project_id}/settings/tracked-urls", {
        ...W,
        pathParams: pid(projectId),
        body: { url, label: input.label?.trim() || null },
      }),
    TRACKED_URL_ERRORS,
  );
  return r.ok ? { ok: true, value: { id: r.value!.data.url_norm } } : r;
}

export async function removeTrackedUrl(projectId: string, id: string): Promise<ActionResult> {
  const r = await run(
    () => hghDelete("/v1/projects/{project_id}/settings/tracked-urls", { ...W, pathParams: pid(projectId), query: { url_norm: id } }),
    {},
    ["tracked_url_not_found"],
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

// ── writes: xlsx relays (export stream -> base64, upload multipart) ─────────

/** filename from Content-Disposition (RFC 5987 filename* first), else null. */
export function dispositionFilename(value: string | null): string | null {
  if (!value) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through to the plain parameter
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/.exec(value);
  const name = (plain?.[1] ?? plain?.[2] ?? "").trim();
  return name || null;
}

function legacyStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

export const EXPORT_ERRORS: ErrorTable = {};

async function exportXlsx(
  path: "/v1/projects/{project_id}/prompts/export" | "/v1/projects/{project_id}/settings/tracked-urls/export",
  projectId: string,
  fallbackPrefix: "prompts" | "tracked-urls",
): Promise<ActionResult<{ base64: string; filename: string }>> {
  const r = await run(async () => {
    const res = await hghRaw("get", path, {
      ...W,
      pathParams: pid(projectId),
      accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const filename =
      dispositionFilename(res.headers.get("content-disposition")) ?? `${fallbackPrefix}-${projectId.slice(0, 8)}-${legacyStamp()}.xlsx`;
    return { base64: buf.toString("base64"), filename };
  }, EXPORT_ERRORS);
  return r.ok ? { ok: true, value: r.value! } : r;
}

export function exportPromptsXlsx(projectId: string) {
  return exportXlsx("/v1/projects/{project_id}/prompts/export", projectId, "prompts");
}
export function exportTrackedUrlsXlsx(projectId: string) {
  return exportXlsx("/v1/projects/{project_id}/settings/tracked-urls/export", projectId, "tracked-urls");
}

const TOO_BIG = "파일이 너무 큽니다(최대 5MB)";
const UNREADABLE = "엑셀(.xlsx) 파일을 읽을 수 없습니다";
export const IMPORT_ERRORS: ErrorTable = {
  payload_too_large: TOO_BIG,
  file_too_large: TOO_BIG,
  too_many_cells: TOO_BIG,
  too_many_columns: TOO_BIG,
  text_too_large: TOO_BIG,
  cell_too_long: TOO_BIG,
  invalid_xlsx: UNREADABLE,
  invalid_upload: UNREADABLE,
  unsupported_media_type: UNREADABLE,
  too_many_rows: "데이터 행은 5,000개까지 가져올 수 있습니다",
  empty_sheet: "시트가 비어 있습니다",
  missing_header: "헤더에 'id' 또는 'text' 열이 없습니다",
};

async function importXlsx<T>(
  path: "/v1/projects/{project_id}/prompts/import" | "/v1/projects/{project_id}/settings/tracked-urls/import",
  projectId: string,
  formData: FormData,
): Promise<{ ok: true; value: T } | ActionFailure> {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "업로드된 파일이 없습니다" };
  const r = await run(
    async () =>
      (await relayUpload(path, file, {
        ...W,
        pathParams: pid(projectId),
        limitBytes: Math.min(IMPORT_MAX_BYTES, uploadLimitBytes()),
      })) as { data: T },
    IMPORT_ERRORS,
  );
  return r.ok ? { ok: true, value: r.value!.data } : r;
}

export async function importTrackedUrlsXlsx(
  projectId: string,
  formData: FormData,
): Promise<ActionResult<{ created: number; updated: number; skipped: number; warnings: string[] }>> {
  const r = await importXlsx<ApiTrackedUrlImport>("/v1/projects/{project_id}/settings/tracked-urls/import", projectId, formData);
  if (!r.ok) return r;
  const d = r.value;
  return { ok: true, value: { created: d.created, updated: d.updated, skipped: d.skipped, warnings: [...d.warnings] } };
}

export async function importPromptsXlsx(
  projectId: string,
  formData: FormData,
): Promise<ActionResult<{ created: number; updated: number; skipped: number; createdTags: number; warnings: string[] }>> {
  const r = await importXlsx<ApiImportSummary>("/v1/projects/{project_id}/prompts/import", projectId, formData);
  if (!r.ok) return r;
  const d = r.value;
  return {
    ok: true,
    value: { created: d.created, updated: d.updated, skipped: d.skipped, createdTags: d.created_tags, warnings: [...(d.warnings ?? [])] },
  };
}

// ── writes: prompts ─────────────────────────────────────────────────────────

const CANDIDATE_GONE = "선택한 후보를 찾을 수 없습니다";
const CANDIDATE_DELETE_GONE = "삭제할 후보를 찾을 수 없습니다";

/** Chunked candidate call: 404 candidate_not_found of a chunk counts 0 (it had none of this project). */
async function candidateChunks(
  ids: readonly string[],
  call: (chunkIds: string[]) => Promise<number>,
): Promise<{ ok: true; value: number } | ActionFailure> {
  let total = 0;
  for (const part of chunk([...new Set(ids)], CHUNK.candidateIds)) {
    const r = await run(() => call(part), { unprocessable: GENERIC_INVALID }, ["candidate_not_found"]);
    if (!r.ok) return r;
    total += r.value ?? 0;
  }
  return { ok: true, value: total };
}

export async function selectFromCandidates(projectId: string, candidateIds: string[]): Promise<ActionResult<{ created: number }>> {
  if (candidateIds.length === 0) return { ok: false, error: "선택된 후보가 없습니다" };
  const r = await candidateChunks(candidateIds, async (ids) => {
    const res = await hghPost("/v1/projects/{project_id}/prompt-candidates/select", {
      ...W,
      pathParams: pid(projectId),
      body: { candidate_ids: ids },
    });
    return res.data.created;
  });
  if (!r.ok) return r;
  if (r.value === 0) return { ok: false, error: CANDIDATE_GONE };
  return { ok: true, value: { created: r.value } };
}

export async function deleteCandidates(projectId: string, candidateIds: string[]): Promise<ActionResult<{ count: number }>> {
  if (candidateIds.length === 0) return { ok: false, error: "선택된 후보가 없습니다" };
  const r = await candidateChunks(candidateIds, async (ids) => {
    const res = await hghPost("/v1/projects/{project_id}/prompt-candidates/bulk-delete", {
      ...W,
      pathParams: pid(projectId),
      body: { candidate_ids: ids },
    });
    return res.data.deleted;
  });
  if (!r.ok) return r;
  if (r.value === 0) return { ok: false, error: CANDIDATE_DELETE_GONE };
  return { ok: true, value: { count: r.value } };
}

export async function deleteCandidate(projectId: string, candidateId: string): Promise<ActionResult> {
  const r = await run(
    () =>
      hghDelete("/v1/projects/{project_id}/prompt-candidates/{candidate_id}", {
        ...W,
        pathParams: { project_id: projectId, candidate_id: candidateId },
      }),
    { candidate_not_found: CANDIDATE_DELETE_GONE, unprocessable: CANDIDATE_DELETE_GONE },
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

export const MANUAL_ERRORS: ErrorTable = {
  empty_text: "프롬프트 내용을 입력해주세요",
  too_many_lines: "한 번에 1,000줄까지 추가할 수 있습니다",
  text_too_long: "한 줄은 4,000자까지입니다",
  invalid_text: "제어 문자가 포함돼 있습니다",
  unprocessable: "제어 문자가 포함돼 있거나 내용이 너무 깁니다",
};

export async function addManualPrompt(projectId: string, text: string): Promise<ActionResult<{ count: number }>> {
  if (text.split("\n").every((l) => l.trim().length === 0)) return { ok: false, error: "프롬프트 내용을 입력해주세요" };
  const r = await run(
    () => hghPost("/v1/projects/{project_id}/prompts", { ...W, pathParams: pid(projectId), body: { text } }),
    MANUAL_ERRORS,
  );
  return r.ok ? { ok: true, value: { count: r.value!.data.created } } : r;
}

const PROMPT_GONE = "프롬프트를 찾을 수 없습니다";

export const DELETE_PROMPT_ERRORS: ErrorTable = {
  prompt_not_deletable: "측정에 들어간 프롬프트는 완전 삭제로만 지울 수 있습니다",
};

export async function deletePrompt(projectId: string, promptId: string): Promise<ActionResult> {
  const r = await run(
    () => hghDelete("/v1/projects/{project_id}/prompts/{prompt_id}", { ...W, pathParams: { project_id: projectId, prompt_id: promptId } }),
    DELETE_PROMPT_ERRORS,
    ["prompt_not_found"],
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

export interface PromptLifecycleImpact {
  answers: number;
  mentions: number;
  citations: number;
  sharedRows: number;
}

export async function getPromptLifecycleImpact(projectId: string, promptId: string): Promise<ActionResult<PromptLifecycleImpact>> {
  const r = await run(
    () =>
      hghGet("/v1/projects/{project_id}/prompts/{prompt_id}/lifecycle-impact", {
        pathParams: { project_id: projectId, prompt_id: promptId },
        retryOn401: true,
        dedupe: false,
      }),
    { prompt_not_found: PROMPT_GONE, unprocessable: PROMPT_GONE },
  );
  if (!r.ok) return r;
  const d = r.value!.data;
  return { ok: true, value: { answers: d.answers, mentions: d.mentions, citations: d.citations, sharedRows: d.shared_rows } };
}

export const PAUSE_ERRORS: ErrorTable = {
  invalid_status: "측정 중인 프롬프트만 중지할 수 있습니다",
  shared_prompt: "다른 행과 측정을 공유하는 프롬프트는 개별로 중지할 수 없습니다",
  prompt_not_found: PROMPT_GONE,
  unprocessable: PROMPT_GONE,
};
export const RESUME_ERRORS: ErrorTable = {
  invalid_status: "측정 중지된 프롬프트만 재개할 수 있습니다",
  prompt_not_found: PROMPT_GONE,
  unprocessable: PROMPT_GONE,
};
export const HARD_DELETE_ERRORS: ErrorTable = {
  prompt_not_found: PROMPT_GONE,
  unprocessable: PROMPT_GONE,
};

export async function promptLifecycle(projectId: string, promptId: string, op: "pause" | "resume" | "hard-delete"): Promise<ActionResult> {
  const pathParams = { project_id: projectId, prompt_id: promptId };
  const r = await run(
    () =>
      op === "pause"
        ? hghPost("/v1/projects/{project_id}/prompts/{prompt_id}/pause", { ...W, pathParams })
        : op === "resume"
          ? hghPost("/v1/projects/{project_id}/prompts/{prompt_id}/resume", { ...W, pathParams })
          : hghPost("/v1/projects/{project_id}/prompts/{prompt_id}/hard-delete", { ...W, pathParams }),
    op === "pause" ? PAUSE_ERRORS : op === "resume" ? RESUME_ERRORS : HARD_DELETE_ERRORS,
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

export const EXECUTE_ERRORS: ErrorTable = {
  nothing_to_execute: "실행할 프롬프트가 없습니다",
};

/** POST …/prompts/execute (202). The action redirects on ok (legacy: to the analysis tab). */
export async function executePrompts(projectId: string): Promise<ActionResult> {
  const r = await run(
    () => hghPost("/v1/projects/{project_id}/prompts/execute", { ...W, pathParams: pid(projectId) }),
    EXECUTE_ERRORS,
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

export const FIELD_CREATE_ERRORS: ErrorTable = {
  reserved_label: "기존 고정 분류축과 같은 이름은 사용할 수 없습니다",
  duplicate: "이미 있는 태그입니다",
  conflict: "이미 있는 태그입니다",
};

export async function addCustomField(projectId: string, label: string): Promise<ActionResult<{ id: string }>> {
  const trimmed = label.trim();
  if (!trimmed) return { ok: false, error: "태그 이름을 입력해주세요" };
  const r = await run(
    () => hghPost("/v1/projects/{project_id}/prompt-fields", { ...W, pathParams: pid(projectId), body: { label: trimmed } }),
    FIELD_CREATE_ERRORS,
  );
  return r.ok ? { ok: true, value: { id: r.value!.data.field_id } } : r;
}

/** archive / restore / hard delete: 404 field_not_found throws, as legacy assertFieldInProject did. */
export async function customFieldOp(projectId: string, fieldId: string, op: "archive" | "restore" | "delete"): Promise<ActionResult> {
  const pathParams = { project_id: projectId, field_id: fieldId };
  const r = await run(
    () =>
      op === "archive"
        ? hghPost("/v1/projects/{project_id}/prompt-fields/{field_id}/archive", { ...W, pathParams })
        : op === "restore"
          ? hghPost("/v1/projects/{project_id}/prompt-fields/{field_id}/restore", { ...W, pathParams })
          : hghDelete("/v1/projects/{project_id}/prompt-fields/{field_id}", { ...W, pathParams }),
    {},
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

export async function setPromptCustomFieldValue(projectId: string, promptId: string, fieldId: string, value: string): Promise<ActionResult> {
  const stored = value.trim();
  if (!stored) return { ok: false, error: "값을 입력해주세요" };
  const r = await run(
    () =>
      hghPut("/v1/projects/{project_id}/prompts/{prompt_id}/fields/{field_id}", {
        ...W,
        pathParams: { project_id: projectId, prompt_id: promptId, field_id: fieldId },
        body: { value: stored },
      }),
    {},
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

export async function setPromptCustomFieldValueBulk(
  projectId: string,
  promptIds: string[],
  fieldId: string,
  value: string,
): Promise<import("@/lib/projects/bulk-field-result").BulkFieldResult> {
  const stored = value.trim();
  if (!stored) return { ok: false, error: "값을 입력해주세요" };
  const ids = [...new Set(promptIds)];
  if (ids.length === 0) return { ok: false, error: "프롬프트를 선택해주세요" };
  let count = 0;
  try {
    for (const part of chunk(ids, CHUNK.bulkPromptIds)) {
      const r = await run(
        () =>
          hghPost("/v1/projects/{project_id}/prompt-fields/{field_id}/bulk-set", {
            ...W,
            pathParams: { project_id: projectId, field_id: fieldId },
            body: { value: stored, prompt_ids: part },
          }),
        {},
      );
      if (!r.ok) return { ...r, progress: { appliedIds: ids.slice(0, count), remainingIds: ids.slice(count) } };
      if (r.value?.data.count !== part.length) {
        return {
          ok: false,
          error: "저장 결과를 확인하지 못했습니다",
          progress: { appliedIds: ids.slice(0, count), remainingIds: ids.slice(count) },
        };
      }
      count += part.length;
    }
  } catch (error) {
    if (count === 0) throw error;
    return {
      ok: false,
      error: "일괄 저장이 중단되었습니다",
      progress: { appliedIds: ids.slice(0, count), remainingIds: ids.slice(count) },
    };
  }
  return { ok: true, value: { count } };
}

export async function clearPromptCustomFieldValue(projectId: string, promptId: string, fieldId: string): Promise<ActionResult> {
  const r = await run(
    () =>
      hghDelete("/v1/projects/{project_id}/prompts/{prompt_id}/fields/{field_id}", {
        ...W,
        pathParams: { project_id: projectId, prompt_id: promptId, field_id: fieldId },
      }),
    {},
  );
  return r.ok ? { ok: true, value: undefined } : r;
}

