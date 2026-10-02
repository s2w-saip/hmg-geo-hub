import "server-only";

// Admin console adapter (unit U11): accounts, standard catalog, customer-interest sources,
// entity registry, citation source overrides, GA4 registry and the keyword tools
// (design 3.3 "운영·검수", 3.4, 3.5 #12 #13 #14 #16 #19, appendix F, 4.2 U11 row, decision D10).
// The screens keep their props and the server actions / route handlers keep their result
// shapes; this module builds them from /v1 answers. The legacy repositories stay in the page,
// action and route files as the rollback path (D8); lib/hgh never imports them at runtime.
//
// Source switch (D8): HGH_SOURCE_G7 = api | legacy (sourceGroupFor("admin") = G7), default
// legacy. One flag for the whole unit, so the pages and actions of one request never mix sources.
//
// Reads (first render, D6: at most three backend calls per page, all issued together)
//   /admin                         GET /v1/admin/users?limit=200 to the end (cursor, D5, maxPages 25).
//                                  The page header count and the list share the same in-request
//                                  deduped GETs. last_sign_in_at comes from the backend (Supabase
//                                  Auth join moved there); meta.suppressed -> null, as legacy's
//                                  catch -> [] did.
//   /admin/standards/prompts       GET /v1/admin/catalog/prompts?include_deleted=true&limit=500 to the
//                                  end (maxPages 20; stats from the first page) + GET
//                                  /v1/admin/catalog/markets (bounded=false -> []). A 5xx on the
//                                  markets read degrades to [] on its own (legacy
//                                  rootMarketVocabulary: never lock the admin out); only a list
//                                  failure errors the page.
//   /admin/standards/customer-interest  GET /v1/admin/interest/keywords + /sources, re-sorted to the
//                                  legacy order (kind in enum declaration order, newest first).
//   /admin/standards/entities      GET /v1/admin/entities?surface=global&sort=answers_desc&limit=500
//                                  to the end (maxPages 10). Counts = per entity, all time (legacy listDiscoveredBrands).
//   /admin/standards/citation-sources  GET /v1/admin/citation-overrides/candidates?surface=global&limit=500.
//   /admin/ga4                     GET /v1/admin/ga4/properties + /markets + /project-overrides (cursor).
//                                  The three parts degrade separately (5xx -> empty part), as legacy's
//                                  two independent .catch(() => []) did; see U11-N7 for the import list.
//
// Field maps (API -> screen prop; legacy source in brackets)
//   UserItem -> UserRow            user_id->id, scope_* [] -> null (legacy stores empty as null),
//                                  created_at / last_sign_in_at -> UTC YYYY-MM-DD, + rowVersion
//                                  (row_version, sent back as If-Match) and status [profiles + auth.users]
//   CatalogPrompt -> StandardCatalogRow  prompt_id->id, prompt_type->promptType, brand_code->brand,
//                                  brand_presence, list_type, funnel_stage, scope_prompt_id, scope_text,
//                                  deleted_at -> Date [prompts LEFT JOIN scope_prompts]
//   Keyword / Source -> list rows  keyword_id / source_id -> id, source_type->sourceType, brand_code->brand
//   EntityRow -> DiscoveredBrandRow  mentions, answers (per entity, all time), + brandCode
//                                  (brand_code: default for an own assignment) [scope_mentions + registry]
//   CandidateItem -> curation row  category.name (taxonomy name; slug fallback), shadows_owned (BG-42),
//                                  override.{note,updated_by,updated_at} [scope_citations + overrides]
//   Ga4Property / PendingMarket -> Ga4Row  a property row has id "p:<property_id>", a property-less
//                                  market (BG-43) "m:<brand>:<country>" with status "unmapped" (legacy
//                                  meaning: property id not yet known); verified_at (BG-43)
//   ProjectOverrideItem -> OverrideRow  project_id->id, brand_code->brand, country_code->country
//   VolumeItem -> keyword volume row  null volume/index/cpc -> 0, monthly 'YYYY-MM-DD' -> {year, month},
//                                  competition (BG-40) as is; summary recomputed with the legacy formula.
//
// Writes keep the legacy result shapes and messages. Error rule (appendix F write tables):
//   a code in the action's table          -> {ok:false, error | errorKey: <legacy message or key>}
//   401, 403                              -> throw UnauthorizedError (legacy requireAdmin threw)
//   anything else                         -> the action's legacy generic failure message (logged)
//   local client_config / auth_unbound    -> thrown (deployment fault, not a user error); the
//                                            keyword routes answer 500 {error, details:<code>}
//                                            instead (message logged server-side only)
// Removals are idempotent as in legacy: 404 on DELETE answers ok; the catalog's 409
// state_mismatch on delete / restore (already deleted / already active) answers ok.
// Writes are sent once (retryOn401 only: server actions and route handlers may refresh cookies).
//
// Known differences (design DC numbers, and U11-N# for this unit). Asserted in admin.test.ts /
// admin.parity.test.ts where observable.
//   DC-18  catalog writes reach Scope through the outbox (async); a failed Scope push no longer
//          rolls the local row back, and a soft-deleted row cannot be edited (409 -> "삭제된 행은
//          편집할 수 없습니다").
//   DC-19  account PATCH needs If-Match (row_version); a stale dialog gets rowVersionConflict. An
//          account with references cannot be deleted (userReferenced); it can be suspended instead.
//   DC-13  entity numbers are the attributed display brand's answers / mentions in the latest
//          exposed cycle on the global surface (legacy: the entity's all-time mentions over every
//          mirrored answer). Role changes reach the KPIs after the loader rebuild (not at once).
//   DC-14  citation override weights are the latest exposed cycle on the global surface (legacy:
//          all-time mirror citations); saving reaches the citation screens after the loader applies it.
//   DC-20  GA4 status "unmapped" on a property row means "no brand x country mapping"; a
//          property-less market row keeps the legacy meaning (property id not yet known).
//   U11-N1 D10: account creation asks for role and scope (plus operator); legacy created
//          role=country with no scope from an e-mail alone.
//   U11-N2 entity "own" assignment sends a brand code (chosen in the row, default = the row's
//          attributed brand); the backend refuses own without one (brand_required).
//   U11-N3 GA4: registering a market already mapped to another property is refused (market_taken);
//          legacy's brand x country upsert swapped the property silently.
//   U11-N4 keyword volume: keywords the backend has not collected yet come back after a bounded
//          wait (route polls the change queue up to KEYWORD_POLL_BUDGET_MS); still pending ones are
//          left out and listed in `pending` (legacy called DataForSEO inline). competition null
//          when DataForSEO gave none (legacy cache defaulted to "LOW").
//   U11-N5 toggleStandardPromptEnabled (deprecated, not wired to any screen) has no backend
//          operation; the api source refuses it (soft delete / restore replace it).
//   U11-N6 the account list shows suspended accounts with a badge (legacy had no status).
//   U11-N7 GA4: when the properties or markets read fails (5xx), the legacy env import section is
//          hidden (legacy listed every env market as "not registered" with an import button; the
//          import could then only fail with market_taken or duplicate a row). Overrides failing
//          alone keeps the registry and the import section.
//   U11-N8 keyword routes: a 500 body carries the error code in `details` (backend code, or the
//          local fault code client_config / auth_unbound, or "internal"); legacy put err.message
//          there. The message is logged server-side only.
//   U11-N9 keyword to-prompt / prompt-to-volume: the BFF waits up to KEYWORD_LLM_TIMEOUT_MS (185 s:
//          ONE backend LLM attempt, LLM_TIMEOUT_S 180 s + margin, as legacy's single 180 s abort).
//          The backend LLM client (back/app/core/llm.py:69-84) retries once 1.5 s after a timeout,
//          429 or 5xx, so its worst case is about 361.5 s (180 + 1.5 + 180; the httpx timeout is
//          per operation, so a slow body can stretch an attempt further). The BFF stops after the
//          first attempt's window and answers the route error (500, details "timeout"). maxDuration
//          is not raised (decision: option 2); the calls send X-HGH-Timeout-Ms = 185 s (D-7) and
//          the backend bounds the whole call, retries included, by that deadline (llm.py
//          request_deadline), so the retry no longer runs past the BFF's wait.
//          prompt-to-volume makes one LLM call per request as legacy (a queued collection is
//          re-read with POST .../volume).
import { UnauthorizedError } from "@/lib/auth/errors";
import { canAccessRoute } from "@/lib/auth/route-policy";
import type { MenuGroup, OperatorScope, Role } from "@/lib/auth/types";
import {
  CITATION_CATEGORIES,
  CITATION_CATEGORY_SLUGS,
  FALLBACK_CATEGORY,
  type CitationCategory,
} from "@/lib/citation-categorizer/taxonomy";
import type { ClassificationSource } from "@/lib/citation-categorizer/source";
import type { CitationDomainCurationRow } from "@/lib/citation-categorizer/curation";
import type {
  StandardCatalogRow,
  StandardCatalogStats,
  StandardKeywordSource,
  StandardSourceChannel,
} from "@/lib/db/repositories/standards";
import type { DiscoveredBrandRow } from "@/lib/db/repositories/entity-registry";
import type { PromptType } from "@/lib/db/repositories/prompts";
import { normalizePromptLang, normalizePromptRegions } from "@/lib/standards/prompt-regions";
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
} from "../client";
import { describeHghError, isHghApiError, LOCAL_CODES, type HghApiError } from "../errors";
import { fetchAllPages, pageInfo, type CursorPage } from "../paginate";
import { relayUpload } from "../relay";

type S = components["schemas"];

// ── source switch ───────────────────────────────────────────────────────────

/** HGH_SOURCE_G7 = api (D8). Read per call: pages and actions of one request agree. */
export function isAdminApi(): boolean {
  return hghSource(sourceGroupFor("admin")) === "api";
}

// ── error mapping ───────────────────────────────────────────────────────────

/** Local faults are never mapped to a user message or an empty list: deployment faults, and a
 *  list longer than its read-to-the-end cap (page_limit_exceeded must not read as "no rows"). */
const LOCAL_FAULTS = new Set<string>([LOCAL_CODES.config, LOCAL_CODES.authUnbound, LOCAL_CODES.pageLimit]);

/** Status + code lookup key: "409:state_mismatch" wins over "state_mismatch". */
export type CodeTable = Record<string, string>;

function lookup(e: HghApiError, table: CodeTable): string | undefined {
  return table[`${e.status}:${e.code}`] ?? table[e.code] ?? table[String(e.status)];
}

/**
 * Write failure -> the action's message. 401 / 403 throw UnauthorizedError (legacy
 * requireAdmin threw), local deployment faults and non-API errors are rethrown, a code in
 * `table` gives its message, anything else `fallback` (logged without payload).
 */
export function writeFailure(e: unknown, table: CodeTable, fallback: string): string {
  if (!isHghApiError(e)) throw e;
  if (LOCAL_FAULTS.has(e.code)) throw e;
  if (e.status === 401 || e.status === 403) {
    throw new UnauthorizedError(`admin backend refused (${e.status} ${e.code})`);
  }
  const hit = lookup(e, table);
  if (hit !== undefined) return hit;
  console.warn(describeHghError(e));
  return fallback;
}

/** True when the error is this status (and code, when given). */
function isApi(e: unknown, status: number, code?: string): boolean {
  return isHghApiError(e) && e.status === status && (code === undefined || e.code === code);
}

/**
 * Read failure on a page whose legacy query degraded to an empty list (entities, citation
 * sources, GA4 parts): 401 / 403 / 404 and local faults are rethrown (the page maps them with
 * throwForPage), anything else is logged and read as empty, as legacy's `.catch(() => [])`.
 */
export function degradeRead<T>(e: unknown, empty: T): T {
  if (!isHghApiError(e)) throw e;
  if (LOCAL_FAULTS.has(e.code) || e.status === 401 || e.status === 403 || e.status === 404) throw e;
  console.warn(describeHghError(e));
  return empty;
}

// ── small helpers ───────────────────────────────────────────────────────────

/** Legacy stores an empty scope axis as null. */
const nullIfEmpty = (xs: readonly string[] | null | undefined): string[] | null => (xs && xs.length ? [...xs] : null);

/** ISO timestamp -> UTC calendar day (legacy: new Date(v).toISOString().slice(0, 10)). */
export function utcDay(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** ISO timestamp -> Date#toISOString (the string form of a legacy Date). */
export function isoOrNull(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function allPages<T>(fetchPage: (cursor: string | null) => Promise<CursorPage<T>>, maxPages: number): Promise<T[]> {
  return (await fetchAllPages(fetchPage, { maxPages })).items;
}

// ── accounts (/admin) ───────────────────────────────────────────────────────

/** The account list row (user-list-client UserRow) plus the api-only fields. */
export interface AdminUserRow {
  id: string;
  email: string | null;
  role: Role;
  scopeAll: boolean;
  brands: string[] | null;
  regions: string[] | null;
  countries: string[] | null;
  operator: OperatorScope;
  createdAt: string | null;
  lastSignInAt: string | null;
  /** app.user_account.row_version: sent back as If-Match on save (DC-19). */
  rowVersion?: number;
  status?: "active" | "suspended";
}

export const USERS_PAGE_LIMIT = 200;
export const USERS_MAX_PAGES = 25;

export function toUserRow(u: S["UserItem"], lastSignInSuppressed = false): AdminUserRow {
  return {
    id: u.user_id,
    email: u.email ?? null,
    role: u.role,
    scopeAll: u.scope_all,
    brands: nullIfEmpty(u.scope_brands),
    regions: nullIfEmpty(u.scope_regions),
    countries: nullIfEmpty(u.scope_countries),
    operator: u.operator,
    createdAt: utcDay(u.created_at),
    lastSignInAt: lastSignInSuppressed ? null : utcDay(u.last_sign_in_at),
    rowVersion: u.row_version,
    status: u.status,
  };
}

/** Every account, newest first (created_at, user_id DESC keyset). */
export async function listAdminUsers(): Promise<AdminUserRow[]> {
  return allPages(async (cursor) => {
    const res = await hghGet("/v1/admin/users", {
      query: { limit: USERS_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      timeoutClass: "adminLong",
    });
    const suppressed = Boolean(res.meta.suppressed && "last_sign_in_at" in res.meta.suppressed);
    return {
      items: res.data.items.map((u) => toUserRow(u, suppressed)),
      nextCursor: pageInfo(res.meta).nextCursor,
    };
  }, USERS_MAX_PAGES);
}

export interface AccountCreateInput {
  email: string;
  role: Role;
  operator: OperatorScope;
  scopeAll: boolean;
  brands: string[];
  regions: string[];
  countries: string[];
}

export type AccountResult<T = object> = ({ ok: true } & T) | { ok: false; errorKey: string };

const ERR = (k: string) => `admin.errors.${k}`;

const CREATE_ERRORS: CodeTable = {
  email_taken: ERR("emailTaken"),
  vendor_operator: ERR("vendorOperatorForbidden"),
  constraint_violation: ERR("scopeRequired"),
  unknown_scope_ref: ERR("scopeRequired"),
  admin_scope_all: ERR("scopeRequired"),
  menu_group_not_allowed: ERR("createFailed"),
  compensation_failed: ERR("rollbackFailed"),
};

/**
 * True when a 422 validation error names the e-mail field (appendix F: details.loc email).
 * FastAPI answers details as [{loc: ["body", "email"], ...}]; a feature error as {field: "email"}.
 */
export function pointsToEmail(details: unknown): boolean {
  const isEmailLoc = (d: unknown) =>
    typeof d === "object" && d !== null &&
    ((Array.isArray((d as { loc?: unknown }).loc) && ((d as { loc: unknown[] }).loc).includes("email")) ||
      (d as { field?: unknown }).field === "email");
  return Array.isArray(details) ? details.some(isEmailLoc) : isEmailLoc(details);
}

/** POST /v1/admin/users (D10: role and scope come from the form). */
export async function createAccount(input: AccountCreateInput): Promise<AccountResult<{ email: string; tempPassword: string }>> {
  const admin = input.role === "admin";
  try {
    const res = await hghPost("/v1/admin/users", {
      body: {
        email: input.email,
        role: input.role,
        is_qa_reviewer: false,
        operator: input.role === "vendor" ? "none" : input.operator,
        scope_all: admin || input.scopeAll,
        scope_brands: admin || input.scopeAll ? [] : input.brands,
        scope_regions: admin || input.scopeAll ? [] : input.regions,
        scope_countries: admin || input.scopeAll ? [] : input.countries,
      },
      timeoutClass: "external",
      retryOn401: true,
    });
    return { ok: true, email: res.data.email, tempPassword: res.data.temp_password };
  } catch (e) {
    // 422 unprocessable is "invalid email" only when it names the e-mail field; any other
    // validation failure (a scope item, the operator) is a generic create failure.
    if (isApi(e, 422, "unprocessable")) {
      if (pointsToEmail((e as HghApiError).details)) return { ok: false, errorKey: ERR("invalidEmail") };
      console.warn(describeHghError(e as HghApiError));
      return { ok: false, errorKey: ERR("createFailed") };
    }
    return { ok: false, errorKey: writeFailure(e, CREATE_ERRORS, ERR("createFailed")) };
  }
}

export interface AccountPatchInput {
  role: Role;
  operator: OperatorScope;
  scopeAll: boolean;
  brands: string[] | null;
  regions: string[] | null;
  countries: string[] | null;
  status?: "active" | "suspended";
}

const UPDATE_ERRORS: CodeTable = {
  vendor_operator: ERR("vendorOperatorForbidden"),
  self_demote: ERR("cannotDemoteSelf"),
  last_admin: ERR("lastAdminProtected"),
  row_version_conflict: ERR("rowVersionConflict"),
  constraint_violation: ERR("scopeRequired"),
  unknown_scope_ref: ERR("scopeRequired"),
  admin_scope_all: ERR("scopeRequired"),
};

/**
 * PATCH /v1/admin/users/{id} with If-Match: <rowVersion>. Scope axes are always sent as
 * arrays (the backend refuses null); scopeAll empties them, as legacy normalized.
 */
export async function patchAccount(userId: string, patch: AccountPatchInput, rowVersion: number | undefined): Promise<AccountResult> {
  if (rowVersion === undefined || !Number.isInteger(rowVersion)) {
    // The dialog always carries the version on the api source; without it the backend
    // answers 428. Report a stale screen instead of sending a request that must fail.
    return { ok: false, errorKey: ERR("rowVersionConflict") };
  }
  const all = patch.scopeAll;
  try {
    await hghPatch("/v1/admin/users/{user_id}", {
      pathParams: { user_id: userId },
      header: { "If-Match": String(rowVersion) },
      body: {
        role: patch.role,
        operator: patch.role === "vendor" ? "none" : patch.operator,
        scope_all: all,
        scope_brands: all ? [] : (patch.brands ?? []),
        scope_regions: all ? [] : (patch.regions ?? []),
        scope_countries: all ? [] : (patch.countries ?? []),
        ...(patch.status ? { status: patch.status } : {}),
      },
      retryOn401: true,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, errorKey: writeFailure(e, UPDATE_ERRORS, ERR("updateFailed")) };
  }
}

const DELETE_USER_ERRORS: CodeTable = {
  self_delete: ERR("cannotDeleteSelf"),
  last_admin: ERR("lastAdminProtected"),
  user_referenced: ERR("userReferenced"),
};

/** DELETE /v1/admin/users/{id}. Owner succession and the audit row happen on the backend. */
export async function deleteAccount(userId: string): Promise<AccountResult> {
  try {
    await hghDelete("/v1/admin/users/{user_id}", {
      pathParams: { user_id: userId },
      timeoutClass: "external",
      retryOn401: true,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, errorKey: writeFailure(e, DELETE_USER_ERRORS, ERR("deleteFailed")) };
  }
}

// ── standard catalog (/admin/standards/prompts) ────────────────────────────

export type ActionResult<T = void> = { ok: true; value: T } | { ok: false; error: string };
const OK: ActionResult = { ok: true, value: undefined };

export const CATALOG_PAGE_LIMIT = 500;
export const CATALOG_MAX_PAGES = 20;

export function toCatalogRow(p: S["CatalogPrompt"]): StandardCatalogRow {
  return {
    id: p.prompt_id,
    text: p.text,
    promptType: (p.prompt_type ?? null) as PromptType | null,
    category: p.category ?? null,
    brand: p.brand_code ?? null,
    brandPresence: p.brand_presence ?? null,
    listType: p.list_type ?? null,
    depth1: p.depth1 ?? null,
    depth2: p.depth2 ?? null,
    depth3: p.depth3 ?? null,
    depth4: p.depth4 ?? null,
    funnelStage: p.funnel_stage ?? null,
    kind: p.kind,
    lang: p.lang ?? null,
    regions: p.regions ?? null,
    scopePromptId: p.scope_prompt_id ?? null,
    scopeText: p.scope_text ?? null,
    deletedAt: p.deleted_at ? new Date(p.deleted_at) : null,
  };
}

export function toCatalogStats(s: S["CatalogStats"]): StandardCatalogStats {
  return {
    total: s.total,
    tracked: s.tracked,
    untracked: s.untracked,
    scopeOrphans: s.scope_orphans,
    acr: s.acr,
    deleted: s.deleted,
  };
}

/** Whole root catalog including soft-deleted rows (the admin "삭제됨" view). */
export async function listAdminCatalog(): Promise<{ rows: StandardCatalogRow[]; stats: StandardCatalogStats }> {
  let stats: StandardCatalogStats | null = null;
  const rows = await allPages(async (cursor) => {
    const res = await hghGet("/v1/admin/catalog/prompts", {
      query: { include_deleted: true, limit: CATALOG_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      timeoutClass: "adminLong",
    });
    if (!cursor || !stats) stats = toCatalogStats(res.data.stats);
    return { items: res.data.items.map(toCatalogRow), nextCursor: pageInfo(res.meta).nextCursor };
  }, CATALOG_MAX_PAGES);
  return { rows, stats: stats ?? { total: 0, tracked: 0, untracked: 0, scopeOrphans: 0, acr: 0, deleted: 0 } };
}

/** Market vocabulary for the edit dialog: [] when unbounded (legacy: null -> []). */
export async function catalogMarketVocabulary(): Promise<string[]> {
  const res = await hghGet("/v1/admin/catalog/markets");
  return res.data.bounded ? res.data.items.map((m) => m.code) : [];
}

/**
 * The vocabulary for the screen (page and getStandardMarketVocabulary): a backend failure reads
 * as [] on its own, so the catalog list still renders (legacy rootMarketVocabulary: failing to
 * read the vocabulary must not lock the admin out). 401 / 403 / 404 and local faults still throw.
 */
export async function catalogMarketVocabularyForScreen(): Promise<string[]> {
  return catalogMarketVocabulary().catch((e) => degradeRead<string[]>(e, []));
}

const MSG = {
  notFound: "글로벌 카탈로그 행을 찾을 수 없습니다",
  kindNotFound: "표준 카탈로그 행을 찾을 수 없습니다",
  deletedRow: "삭제된 행은 편집할 수 없습니다",
  emptyText: "프롬프트 내용을 입력해주세요",
  saveFailed: "저장에 실패했습니다",
  labelInvalid: "라벨 값이 올바르지 않습니다",
  deleteFailed: "삭제에 실패했습니다",
  restoreFailed: "복원에 실패했습니다",
  createFailed: "생성에 실패했습니다",
  kindFailed: "측정 종류 변경에 실패했습니다",
  applyFailed: "적용에 실패했습니다",
  unsupported: "더 이상 지원하지 않는 작업입니다",
} as const;

const CATALOG_ERRORS: CodeTable = {
  "404": MSG.notFound,
  "409:state_mismatch": MSG.deletedRow,
  unknown_brand: MSG.labelInvalid,
  invalid_brand_presence: MSG.labelInvalid,
  invalid_prompt_type: MSG.labelInvalid,
  invalid_lang: "언어 코드 형식이 아닙니다",
};

export async function setCatalogKind(id: string, kind: "single" | "acr"): Promise<ActionResult> {
  try {
    await hghPatch("/v1/admin/catalog/prompts/{prompt_id}/kind", { pathParams: { prompt_id: id }, body: { kind, dry_run: false }, retryOn401: true });
    return OK;
  } catch (e) {
    return { ok: false, error: writeFailure(e, { ...CATALOG_ERRORS, "404": MSG.kindNotFound }, MSG.kindFailed) };
  }
}

export async function updateCatalogText(id: string, text: string): Promise<ActionResult> {
  try {
    await hghPatch("/v1/admin/catalog/prompts/{prompt_id}/text", { pathParams: { prompt_id: id }, body: { text }, retryOn401: true });
    return OK;
  } catch (e) {
    return { ok: false, error: writeFailure(e, { ...CATALOG_ERRORS, "422:unprocessable": MSG.emptyText }, MSG.saveFailed) };
  }
}

/** camelCase catalog label key -> backend snake key (LabelsBody / BulkLabels). */
export const LABEL_KEY_TO_API = {
  promptType: "prompt_type",
  category: "category",
  brand: "brand_code",
  brandPresence: "brand_presence",
  listType: "list_type",
  depth1: "depth1",
  depth2: "depth2",
  depth3: "depth3",
  depth4: "depth4",
  funnelStage: "funnel_stage",
} as const;
export type CatalogLabelKey = keyof typeof LABEL_KEY_TO_API;
export type CatalogLabels = Partial<Record<CatalogLabelKey, string | null>>;

const API_KEY_TO_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(LABEL_KEY_TO_API).map(([camel, snake]) => [snake, camel]),
);

/** Only the keys the caller gave (undefined = untouched), renamed to the backend keys. */
export function toApiLabels(labels: CatalogLabels): S["LabelsBody"] {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(labels)) {
    if (v === undefined) continue;
    const key = LABEL_KEY_TO_API[k as CatalogLabelKey];
    if (key) out[key] = v;
  }
  return out as S["LabelsBody"];
}

export async function updateCatalogLabels(id: string, labels: CatalogLabels): Promise<ActionResult> {
  const body = toApiLabels(labels);
  if (Object.keys(body).length === 0) return OK; // legacy: no change -> ok, and an empty body is 422
  try {
    await hghPatch("/v1/admin/catalog/prompts/{prompt_id}/labels", { pathParams: { prompt_id: id }, body, retryOn401: true });
    return OK;
  } catch (e) {
    return { ok: false, error: writeFailure(e, CATALOG_ERRORS, MSG.saveFailed) };
  }
}

export interface CatalogRegionsPatch {
  regions?: string[] | null;
  lang?: string | null;
}

/**
 * PATCH …/regions with only the given keys. The format check and its message (with the
 * offending values) stay local, as legacy; the vocabulary check is the backend's, and its
 * refusal is explained with the values outside the market vocabulary (one extra GET, error path only).
 */
export async function updateCatalogRegions(id: string, patch: CatalogRegionsPatch): Promise<ActionResult> {
  const body: { regions?: string[] | null; lang?: string | null } = {};
  if (patch.regions !== undefined) {
    const norm = normalizePromptRegions(patch.regions, null);
    if (norm.invalid.length > 0) return { ok: false, error: `시장 코드 형식이 아닙니다: ${norm.invalid.join(", ")}` };
    body.regions = norm.value;
  }
  if (patch.lang !== undefined) {
    const lang = normalizePromptLang(patch.lang);
    if (lang.invalid) return { ok: false, error: `언어 코드 형식이 아닙니다: ${lang.invalid}` };
    body.lang = lang.value;
  }
  if (Object.keys(body).length === 0) return OK;
  try {
    await hghPatch("/v1/admin/catalog/prompts/{prompt_id}/regions", { pathParams: { prompt_id: id }, body, retryOn401: true });
    return OK;
  } catch (e) {
    if (isApi(e, 422, "region_out_of_vocabulary") && body.regions) {
      const vocabulary = await catalogMarketVocabulary().catch(() => []);
      const out = vocabulary.length ? normalizePromptRegions(body.regions, vocabulary).outOfVocabulary : [];
      return { ok: false, error: `이 프로젝트의 측정 시장이 아닙니다${out.length ? `: ${out.join(", ")}` : ""}` };
    }
    if (isApi(e, 422, "invalid_region")) return { ok: false, error: "시장 코드 형식이 아닙니다" };
    return { ok: false, error: writeFailure(e, CATALOG_ERRORS, MSG.saveFailed) };
  }
}

/** Failure code of one bulk row -> the legacy per-row message. */
function rowFailureMessage(code: string): string {
  switch (code) {
    case "not_found":
      return MSG.notFound;
    case "state_mismatch":
      return MSG.deletedRow;
    case "region_out_of_vocabulary":
      return "이 프로젝트의 측정 시장이 아닙니다";
    case "invalid_region":
      return "시장 코드 형식이 아닙니다";
    case "invalid_lang":
      return "언어 코드 형식이 아닙니다";
    case "unknown_brand":
    case "invalid_brand_presence":
    case "invalid_prompt_type":
      return MSG.labelInvalid;
    default:
      return MSG.applyFailed;
  }
}

/** POST …/bulk/regions. "updated" counts unchanged rows too (legacy: a no-op row was ok). */
export async function bulkCatalogRegions(
  ids: string[],
  regions: string[] | null,
): Promise<ActionResult<{ updated: number; failed: Array<{ id: string; error: string }> }>> {
  try {
    const res = await hghPost("/v1/admin/catalog/prompts/bulk/regions", {
      body: { prompt_ids: ids, regions },
      timeoutClass: "adminLong",
      retryOn401: true,
    });
    return {
      ok: true,
      value: {
        updated: res.data.updated + res.data.unchanged,
        failed: res.data.failed.map((f) => ({ id: f.prompt_id, error: rowFailureMessage(f.code) })),
      },
    };
  } catch (e) {
    return { ok: false, error: writeFailure(e, CATALOG_ERRORS, MSG.saveFailed) };
  }
}

export async function softDeleteCatalogPrompt(id: string): Promise<ActionResult> {
  try {
    await hghDelete("/v1/admin/catalog/prompts/{prompt_id}", { pathParams: { prompt_id: id }, retryOn401: true });
    return OK;
  } catch (e) {
    if (isApi(e, 409, "state_mismatch")) return OK; // already deleted: legacy no-op
    return { ok: false, error: writeFailure(e, CATALOG_ERRORS, MSG.deleteFailed) };
  }
}

export async function restoreCatalogPrompt(id: string): Promise<ActionResult> {
  try {
    await hghPost("/v1/admin/catalog/prompts/{prompt_id}/restore", { pathParams: { prompt_id: id }, retryOn401: true });
    return OK;
  } catch (e) {
    if (isApi(e, 409, "state_mismatch")) return OK; // already active: legacy no-op
    return { ok: false, error: writeFailure(e, CATALOG_ERRORS, MSG.restoreFailed) };
  }
}

export async function createCatalogPrompt(input: {
  text: string;
  promptType: PromptType | null;
  category: string | null;
  brand: string | null;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const res = await hghPost("/v1/admin/catalog/prompts", {
      body: {
        text: input.text,
        kind: "single",
        prompt_type: input.promptType as S["CreatePromptBody"]["prompt_type"],
        category: input.category,
        brand_code: input.brand,
      },
      retryOn401: true,
    });
    const id = res.data.prompt?.prompt_id;
    if (!id) return { ok: false, error: MSG.createFailed };
    return { ok: true, value: { id } };
  } catch (e) {
    return { ok: false, error: writeFailure(e, CATALOG_ERRORS, MSG.createFailed) };
  }
}

/** U11-N5: no backend operation; the deprecated action is refused on the api source. */
export function unsupportedCatalogToggle(): ActionResult {
  return { ok: false, error: MSG.unsupported };
}

/** filename / filename* from Content-Disposition (RFC 5987 first). */
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
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(value);
  return plain ? plain[1].trim() : null;
}

/** Legacy file name when the backend gives none: global-catalog-YYYYMMDD.xlsx (UTC day). */
export function catalogExportFallbackName(now: Date = new Date()): string {
  return `global-catalog-${now.toISOString().slice(0, 10).replace(/-/g, "")}.xlsx`;
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** GET …/export (active rows) -> base64 + file name, the server action's legacy result. */
export async function exportCatalogXlsx(): Promise<ActionResult<{ base64: string; filename: string }>> {
  try {
    const res = await hghRaw("get", "/v1/admin/catalog/prompts/export", { accept: XLSX_MIME, retryOn401: true });
    const buf = Buffer.from(await res.arrayBuffer());
    const filename = dispositionFilename(res.headers.get("content-disposition")) ?? catalogExportFallbackName();
    return { ok: true, value: { base64: buf.toString("base64"), filename } };
  } catch (e) {
    return { ok: false, error: writeFailure(e, {}, "내보내기에 실패했습니다") };
  }
}

/** Preview change field key: backend label keys -> the legacy camelCase audit keys. */
export function toLegacyChangeKey(k: string): string {
  return API_KEY_TO_LABEL[k] ?? k;
}

export interface ApiPreviewItem {
  id: string;
  currentText: string;
  changes: Record<string, { old: string | null; new: string | null }>;
  /** The backend BulkItem, sent back verbatim to bulk/apply (catalog-io keeps it opaque). */
  item: { id: string; labels: Record<string, never>; api: Record<string, unknown> };
}

export interface ApiPreview {
  items: ApiPreviewItem[];
  unmatchedIds: string[];
  unchanged: number;
  warnings: string[];
  batchId: string;
}

export function toPreview(d: S["PreviewData"]): ApiPreview {
  return {
    items: d.items.map((it) => {
      const changes: ApiPreviewItem["changes"] = {};
      for (const [k, v] of Object.entries(it.changes)) {
        const pair = v as Record<string, string | null | undefined>;
        changes[toLegacyChangeKey(k)] = { old: pair.old ?? null, new: pair.new ?? null };
      }
      return {
        id: it.prompt_id,
        currentText: it.current_text,
        changes,
        item: { id: it.prompt_id, labels: {}, api: it.item as Record<string, unknown> },
      };
    }),
    unmatchedIds: d.unmatched_ids,
    unchanged: d.unchanged,
    warnings: d.warnings,
    batchId: d.batch_id,
  };
}

/** POST …/import/preview with the uploaded file (multipart relay, size checked first). */
export async function previewCatalogImport(file: File): Promise<ActionResult<ApiPreview>> {
  try {
    const json = (await relayUpload("/v1/admin/catalog/prompts/import/preview", file, { retryOn401: true })) as
      | S["Envelope_PreviewData_"]
      | undefined;
    if (!json?.data) return { ok: false, error: "미리보기에 실패했습니다" };
    return { ok: true, value: toPreview(json.data) };
  } catch (e) {
    return {
      ok: false,
      error: writeFailure(
        e,
        { "413": "파일이 너무 큽니다", "415": "xlsx 파일만 올릴 수 있습니다", "422": "파일을 읽을 수 없습니다" },
        "미리보기에 실패했습니다",
      ),
    };
  }
}

/** A legacy-shaped bulk item (catalog-io built before a source switch) -> backend BulkItem. */
export interface LegacyBulkItem {
  id: string;
  text?: string;
  labels: CatalogLabels;
  regions?: string[] | null;
  lang?: string | null;
  api?: Record<string, unknown>;
}

export function toApiBulkItem(it: LegacyBulkItem): S["BulkItem"] {
  if (it.api && typeof it.api === "object") return { ...(it.api as S["BulkItem"]), prompt_id: it.id };
  return {
    prompt_id: it.id,
    ...(it.text !== undefined ? { text: it.text } : {}),
    labels: toApiLabels(it.labels ?? {}) as S["BulkLabels"],
    ...(it.regions !== undefined ? { regions: it.regions } : {}),
    ...(it.lang !== undefined ? { lang: it.lang } : {}),
  };
}

/** POST …/bulk/apply. applied = applied + unchanged (legacy counted already-applied rows). */
export async function applyCatalogChunk(
  items: LegacyBulkItem[],
  batchId: string,
): Promise<ActionResult<{ applied: number; failed: { id: string; error: string }[] }>> {
  try {
    const res = await hghPost("/v1/admin/catalog/prompts/bulk/apply", {
      body: { batch_id: batchId, items: items.map(toApiBulkItem) },
      timeoutClass: "adminLong",
      retryOn401: true,
    });
    return {
      ok: true,
      value: {
        applied: res.data.applied + res.data.unchanged,
        failed: res.data.failed.map((f) => ({ id: f.prompt_id, error: rowFailureMessage(f.code) })),
      },
    };
  } catch (e) {
    return { ok: false, error: writeFailure(e, CATALOG_ERRORS, MSG.applyFailed) };
  }
}

// ── customer-interest sources (/admin/standards/customer-interest) ─────────

export interface InterestKeywordRow {
  id: string;
  term: string;
  sourceType: StandardKeywordSource;
  brand: string | null;
  notes: string | null;
  enabled: boolean;
}
export interface InterestSourceRow {
  id: string;
  url: string;
  channel: StandardSourceChannel;
  brand: string | null;
  notes: string | null;
  enabled: boolean;
}

export function toKeywordRow(k: S["Keyword"]): InterestKeywordRow {
  return { id: k.keyword_id, term: k.term, sourceType: k.source_type as StandardKeywordSource, brand: k.brand_code ?? null, notes: k.notes ?? null, enabled: k.enabled };
}
export function toSourceRow(s: S["Source"]): InterestSourceRow {
  return { id: s.source_id, url: s.url, channel: s.channel as StandardSourceChannel, brand: s.brand_code ?? null, notes: s.notes ?? null, enabled: s.enabled };
}

/** Legacy enum declaration order (lib/db/schema.ts standard_keyword_source / standard_source_channel). */
export const KEYWORD_SOURCE_ORDER = ["google_keyword", "community_voc"] as const;
export const SOURCE_CHANNEL_ORDER = ["news", "pr", "social", "community"] as const;

/**
 * Legacy list order: kind in enum declaration order (ORDER BY on a PostgreSQL enum), then newest
 * first. Applied here so the screen order does not depend on how the backend sorts the kind
 * column (a text column sorts alphabetically). Unknown kinds go last; ties keep the API order.
 */
export function legacyKindOrder<T>(items: T[], kindOf: (x: T) => string, order: readonly string[], createdOf: (x: T) => string): T[] {
  const rank = (x: T) => {
    const i = order.indexOf(kindOf(x));
    return i < 0 ? order.length : i;
  };
  const ts = (x: T) => Date.parse(createdOf(x)) || 0;
  return items
    .map((x, i) => ({ x, i }))
    .sort((a, b) => rank(a.x) - rank(b.x) || ts(b.x) - ts(a.x) || a.i - b.i)
    .map((e) => e.x);
}

/** Both lists (two GETs issued together), in the legacy order. */
export async function listInterest(): Promise<{ keywords: InterestKeywordRow[]; sources: InterestSourceRow[] }> {
  const [k, s] = await Promise.all([hghGet("/v1/admin/interest/keywords"), hghGet("/v1/admin/interest/sources")]);
  const keywords = legacyKindOrder(k.data.items, (x) => x.source_type, KEYWORD_SOURCE_ORDER, (x) => x.created_at);
  const sources = legacyKindOrder(s.data.items, (x) => x.channel, SOURCE_CHANNEL_ORDER, (x) => x.created_at);
  return { keywords: keywords.map(toKeywordRow), sources: sources.map(toSourceRow) };
}

const INTEREST_ERRORS: CodeTable = {
  unknown_brand: "알 수 없는 브랜드입니다",
  "404": "항목을 찾을 수 없습니다. 목록을 새로 고쳐 주세요",
};

export async function createInterestKeyword(input: {
  term: string;
  sourceType: "google_keyword" | "community_voc";
  brand: string | null;
  notes: string | null;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const res = await hghPost("/v1/admin/interest/keywords", {
      body: { term: input.term, source_type: input.sourceType, brand_code: input.brand, notes: input.notes, enabled: true },
      retryOn401: true,
    });
    return { ok: true, value: { id: res.data.keyword_id } };
  } catch (e) {
    return {
      ok: false,
      error: writeFailure(e, { ...INTEREST_ERRORS, "422:unprocessable": "키워드를 입력해주세요" }, "저장에 실패했습니다"),
    };
  }
}

export async function setInterestKeywordEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  try {
    await hghPatch("/v1/admin/interest/keywords/{keyword_id}", { pathParams: { keyword_id: id }, body: { enabled }, retryOn401: true });
    return OK;
  } catch (e) {
    return { ok: false, error: writeFailure(e, INTEREST_ERRORS, "저장에 실패했습니다") };
  }
}

export async function deleteInterestKeyword(id: string): Promise<ActionResult> {
  try {
    await hghDelete("/v1/admin/interest/keywords/{keyword_id}", { pathParams: { keyword_id: id }, retryOn401: true });
    return OK;
  } catch (e) {
    if (isApi(e, 404)) return OK; // legacy delete of a missing row was a no-op
    return { ok: false, error: writeFailure(e, INTEREST_ERRORS, "삭제에 실패했습니다") };
  }
}

export async function createInterestSource(input: {
  url: string;
  channel: "news" | "pr" | "social" | "community";
  brand: string | null;
  notes: string | null;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const res = await hghPost("/v1/admin/interest/sources", {
      body: { url: input.url, channel: input.channel, brand_code: input.brand, notes: input.notes, enabled: true },
      retryOn401: true,
    });
    return { ok: true, value: { id: res.data.source_id } };
  } catch (e) {
    return {
      ok: false,
      error: writeFailure(e, { ...INTEREST_ERRORS, "422:unprocessable": "URL을 입력해주세요" }, "저장에 실패했습니다"),
    };
  }
}

export async function setInterestSourceEnabled(id: string, enabled: boolean): Promise<ActionResult> {
  try {
    await hghPatch("/v1/admin/interest/sources/{source_id}", { pathParams: { source_id: id }, body: { enabled }, retryOn401: true });
    return OK;
  } catch (e) {
    return { ok: false, error: writeFailure(e, INTEREST_ERRORS, "저장에 실패했습니다") };
  }
}

export async function deleteInterestSource(id: string): Promise<ActionResult> {
  try {
    await hghDelete("/v1/admin/interest/sources/{source_id}", { pathParams: { source_id: id }, retryOn401: true });
    return OK;
  } catch (e) {
    if (isApi(e, 404)) return OK;
    return { ok: false, error: writeFailure(e, INTEREST_ERRORS, "삭제에 실패했습니다") };
  }
}

// ── entity registry (/admin/standards/entities) ────────────────────────────

/** DiscoveredBrandRow + the attributed display brand (default for an own assignment, U11-N2). */
export interface AdminEntityRow extends DiscoveredBrandRow {
  brandCode: string | null;
  brandName: string | null;
}

export const ENTITIES_PAGE_LIMIT = 500;
export const ENTITIES_MAX_PAGES = 10;

export function toEntityRow(r: S["EntityRow"]): AdminEntityRow {
  return {
    entityId: r.entity_id,
    name: r.name,
    mentions: r.mentions,
    answers: r.answers,
    role: r.role,
    brandCode: r.brand_code ?? null,
    brandName: r.brand_name ?? null,
  };
}

/** Answers desc; counts are per entity over all time, as legacy listDiscoveredBrands (DC-13, 5차 항목 1). */
export async function listAdminEntities(): Promise<AdminEntityRow[]> {
  return allPages(async (cursor) => {
    const res = await hghGet("/v1/admin/entities", {
      query: { surface: "global", sort: "answers_desc", limit: ENTITIES_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      timeoutClass: "adminLong",
    });
    return { items: res.data.items.map(toEntityRow), nextCursor: pageInfo(res.meta).nextCursor };
  }, ENTITIES_MAX_PAGES);
}

const ENTITY_ERRORS: CodeTable = {
  brand_required: "자사 지정에는 브랜드가 필요합니다",
  invalid_brand: "알 수 없는 브랜드이거나 엄브렐러입니다",
  name_required: "엔티티 정보가 올바르지 않습니다",
  "422:unprocessable": "엔티티 정보가 올바르지 않습니다",
  "404": "엔티티가 없습니다",
  duplicate_pending: "같은 엔티티의 변경 요청이 이미 대기 중입니다",
};

export async function setAdminEntityRole(
  entityId: string,
  name: string,
  role: "own" | "excluded" | "competitor",
  brandCode: string | null | undefined,
): Promise<ActionResult> {
  try {
    await hghPut("/v1/admin/entities/{entity_id}", {
      pathParams: { entity_id: entityId },
      body: { role, name, ...(role === "own" ? { brand_code: brandCode ?? null } : {}) },
      retryOn401: true,
    });
    return OK;
  } catch (e) {
    return { ok: false, error: writeFailure(e, ENTITY_ERRORS, MSG.saveFailed) };
  }
}

// ── citation source overrides (/admin/standards/citation-sources) ──────────

/** Curation row with the backend's extra classification layer ("social"). */
export type AdminCurationRow = Omit<CitationDomainCurationRow, "source"> & { source: ClassificationSource | "social" };

const CATEGORY_BY_SLUG = new Map<string, CitationCategory>(
  Object.entries(CITATION_CATEGORY_SLUGS).map(([name, slug]) => [slug, name as CitationCategory]),
);
const CATEGORY_NAMES: ReadonlySet<string> = new Set(CITATION_CATEGORIES);

/** Backend category -> taxonomy name: name when it is one, else by slug, else "Other" (logged, CK-05). */
export function toTaxonomyCategory(c: { name: string; slug: string } | null | undefined): CitationCategory {
  if (!c) return FALLBACK_CATEGORY;
  if (CATEGORY_NAMES.has(c.name)) return c.name as CitationCategory;
  const bySlug = CATEGORY_BY_SLUG.get(c.slug);
  if (bySlug) return bySlug;
  console.warn(`[hgh] citation category outside the front taxonomy: ${c.slug.slice(0, 40)}`);
  return FALLBACK_CATEGORY;
}

type CandidateItem = S["app__features__admin__citation_sources__overrides__schemas__CandidateItem"];

export function toCurationRow(it: CandidateItem): AdminCurationRow {
  return {
    domain: it.domain,
    citations: it.citations,
    category: toTaxonomyCategory(it.category),
    source: it.source,
    shadowsOwned: it.shadows_owned ?? false,
    overrideNote: it.override?.note ?? null,
    overrideUpdatedBy: it.override?.updated_by ?? null,
    overrideUpdatedAt: isoOrNull(it.override?.updated_at),
  };
}

/** Global surface, default period (DC-14). Legacy order: citations desc, domain asc. */
export async function listCitationCuration(limit: number): Promise<AdminCurationRow[]> {
  const res = await hghGet("/v1/admin/citation-overrides/candidates", {
    query: { surface: "global", limit },
    timeoutClass: "adminLong",
  });
  return res.data.items
    .map(toCurationRow)
    .sort((a, b) => b.citations - a.citations || a.domain.localeCompare(b.domain));
}

const OVERRIDE_ERRORS: CodeTable = {
  unknown_category: "지원하지 않는 카테고리입니다",
  invalid_domain: "도메인이 비어 있습니다",
  duplicate_pending: "같은 도메인의 변경 요청이 대기 중입니다",
};

export async function putCitationOverride(domain: string, category: CitationCategory, note: string | null): Promise<ActionResult> {
  try {
    await hghPut("/v1/admin/citation-overrides/{domain}", {
      pathParams: { domain },
      body: { category, note: note?.trim() ? note.trim() : null },
      retryOn401: true,
    });
    return OK;
  } catch (e) {
    return { ok: false, error: writeFailure(e, OVERRIDE_ERRORS, "저장에 실패했습니다") };
  }
}

export async function deleteCitationOverride(domain: string): Promise<ActionResult> {
  try {
    await hghDelete("/v1/admin/citation-overrides/{domain}", { pathParams: { domain }, retryOn401: true });
    return OK;
  } catch (e) {
    if (isApi(e, 404)) return OK; // no override: legacy remove() -> false was still ok
    return { ok: false, error: writeFailure(e, OVERRIDE_ERRORS, "원복에 실패했습니다") };
  }
}

// ── GA4 registry (/admin/ga4) ───────────────────────────────────────────────

export interface AdminGa4Row {
  id: string;
  brand: string;
  countryCode: string;
  propertyId: string | null;
  status: string;
  verifiedAt: string | null;
}
export interface AdminGa4OverrideRow {
  id: string;
  name: string;
  brand: string | null;
  country: string;
  propertyId: string;
}

const PROPERTY_ID_RE = /^\d{1,20}$/;

/** Row id: "p:<property_id>" for a property, "m:<brand>:<country>" for a property-less market. */
export function ga4PropertyRowId(propertyId: string): string {
  return `p:${propertyId}`;
}
export function ga4MarketRowId(brand: string, country: string): string {
  return `m:${encodeURIComponent(brand)}:${country}`;
}
export type Ga4RowRef = { kind: "property"; propertyId: string } | { kind: "market"; brand: string; country: string };

export function parseGa4RowId(id: string): Ga4RowRef | null {
  if (id.startsWith("p:")) {
    const pid = id.slice(2);
    return PROPERTY_ID_RE.test(pid) ? { kind: "property", propertyId: pid } : null;
  }
  const m = /^m:([^:]+):([A-Za-z]{2})$/.exec(id);
  if (!m) return null;
  try {
    return { kind: "market", brand: decodeURIComponent(m[1]), country: m[2] };
  } catch {
    return null;
  }
}

export function toGa4PropertyRow(p: S["Ga4Property"]): AdminGa4Row {
  return {
    id: ga4PropertyRowId(p.property_id),
    brand: p.brand_code ?? "",
    countryCode: p.country_code ?? "",
    propertyId: p.property_id,
    status: p.status,
    verifiedAt: isoOrNull(p.verified_at),
  };
}

export function toGa4MarketRow(m: S["PendingMarket"]): AdminGa4Row {
  return {
    id: ga4MarketRowId(m.brand_code, m.country_code),
    brand: m.brand_code,
    countryCode: m.country_code,
    propertyId: null,
    status: "unmapped",
    verifiedAt: null,
  };
}

export function toGa4OverrideRow(o: S["ProjectOverrideItem"]): AdminGa4OverrideRow {
  return { id: o.project_id, name: o.name, brand: o.brand_code ?? null, country: o.country_code, propertyId: o.property_id };
}

/** Code-point order (PostgreSQL "C" order of the legacy ORDER BY brand, country_code). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const GA4_OVERRIDES_LIMIT = 500;
export const GA4_OVERRIDES_MAX_PAGES = 10;

/**
 * Registry rows (properties + property-less markets, brand then country) and project overrides.
 * The three reads degrade independently, as legacy did (registry list and project list each
 * `.catch(() => [])`): a failed part reads as empty (degradeRead: 401 / 403 / 404 and local
 * faults still throw). `registryComplete` is false when properties or markets failed; the page
 * then hides the legacy env import section, since "not registered" is unknown and an import
 * could only fail (market_taken) or duplicate a row.
 */
export async function listGa4Registry(): Promise<{ rows: AdminGa4Row[]; overrides: AdminGa4OverrideRow[]; registryComplete: boolean }> {
  const [props, markets, overrides] = await Promise.allSettled([
    hghGet("/v1/admin/ga4/properties"),
    hghGet("/v1/admin/ga4/markets"),
    allPages(async (cursor) => {
      const res = await hghGet("/v1/admin/ga4/project-overrides", {
        query: { limit: GA4_OVERRIDES_LIMIT, ...(cursor ? { cursor } : {}) },
      });
      return { items: res.data.items.map(toGa4OverrideRow), nextCursor: pageInfo(res.meta).nextCursor };
    }, GA4_OVERRIDES_MAX_PAGES),
  ]);
  // Fatal reasons first (any part), so a session / permission fault is never read as "empty".
  for (const r of [props, markets, overrides]) if (r.status === "rejected") degradeRead(r.reason, null);
  const propRows = props.status === "fulfilled" ? props.value.data.items.map(toGa4PropertyRow) : [];
  const marketRows = markets.status === "fulfilled" ? markets.value.data.items.map(toGa4MarketRow) : [];
  const rows = [...propRows, ...marketRows].sort(
    (a, b) => cmp(a.brand, b.brand) || cmp(a.countryCode, b.countryCode) || cmp(a.id, b.id),
  );
  return {
    rows,
    overrides: overrides.status === "fulfilled" ? overrides.value : [],
    registryComplete: props.status === "fulfilled" && markets.status === "fulfilled",
  };
}

const GA4_ERRORS: CodeTable = {
  market_taken: "같은 브랜드·국가에 다른 속성이 이미 매핑돼 있습니다",
  unknown_brand: "알 수 없는 브랜드입니다",
  duplicate_pending: "같은 속성의 변경 요청이 대기 중입니다",
  "422:unprocessable": "속성ID는 숫자만 허용됩니다",
  "404": "매핑을 찾을 수 없습니다. 목록을 새로 고쳐 주세요",
};

/** Register a market: with a property id PUT the property, without one PUT the pending market. */
export async function putGa4Mapping(brand: string, countryCode: string, propertyId: string): Promise<ActionResult> {
  try {
    if (propertyId) {
      await hghPut("/v1/admin/ga4/properties/{property_id}", {
        pathParams: { property_id: propertyId },
        body: { brand_code: brand, country_code: countryCode, verify: false },
        retryOn401: true,
      });
    } else {
      await hghPut("/v1/admin/ga4/markets/{brand_code}/{country_code}", {
        pathParams: { brand_code: brand, country_code: countryCode },
        body: {},
        retryOn401: true,
      });
    }
    return OK;
  } catch (e) {
    return { ok: false, error: writeFailure(e, GA4_ERRORS, "등록에 실패했습니다") };
  }
}

/**
 * verify=true PUT. The body replaces the mapping, so brand and country go with it: from the
 * caller's row, else looked up in the property list (a property unknown there -> not found).
 */
export async function verifyGa4Property(
  propertyId: string,
  market: { brand: string; countryCode: string } | null | undefined,
): Promise<ActionResult> {
  try {
    let m = market ?? null;
    if (!m) {
      const list = await hghGet("/v1/admin/ga4/properties");
      const hit = list.data.items.find((p) => p.property_id === propertyId);
      if (!hit) return { ok: false, error: GA4_ERRORS["404"] };
      m = { brand: hit.brand_code ?? "", countryCode: hit.country_code ?? "" };
    }
    const res = await hghPut("/v1/admin/ga4/properties/{property_id}", {
      pathParams: { property_id: propertyId },
      body: { brand_code: m.brand || null, country_code: m.countryCode || null, verify: true },
      timeoutClass: "external",
      retryOn401: true,
    });
    if (res.data.verified === false) return { ok: false, error: "검증 실패: GA4 읽기 권한을 확인하세요" };
    return OK;
  } catch (e) {
    return {
      ok: false,
      error: writeFailure(e, { ...GA4_ERRORS, ga4_verify_failed: "검증 실패: GA4 읽기 권한을 확인하세요" }, "검증 실패"),
    };
  }
}

/** DELETE by row id (property or pending market). A missing row is ok (legacy no-op). */
export async function removeGa4Row(id: string): Promise<ActionResult> {
  const ref = parseGa4RowId(id);
  if (!ref) return { ok: false, error: GA4_ERRORS["404"] };
  try {
    if (ref.kind === "property") {
      await hghDelete("/v1/admin/ga4/properties/{property_id}", { pathParams: { property_id: ref.propertyId }, retryOn401: true });
    } else {
      await hghDelete("/v1/admin/ga4/markets/{brand_code}/{country_code}", {
        pathParams: { brand_code: ref.brand, country_code: ref.country },
        retryOn401: true,
      });
    }
    return OK;
  } catch (e) {
    if (isApi(e, 404)) return OK;
    return { ok: false, error: writeFailure(e, GA4_ERRORS, "삭제에 실패했습니다") };
  }
}

// ── keyword tools (/api/keyword/{volume,to-prompt,prompt-to-volume}) ───────

export interface KeywordVolumeRow {
  keyword: string;
  search_volume: number;
  competition: string | null;
  competition_index: number;
  cpc: number;
  monthly_searches: Array<{ year: number; month: number; search_volume: number }>;
}

export interface KeywordVolumeSummary {
  totalKeywords: number;
  averageSearchVolume: number;
  totalSearchVolume: number;
  highVolumeCount: number;
  mediumVolumeCount: number;
  lowVolumeCount: number;
  averageCompetitionIndex: number;
  averageCPC: number;
}

/** 'YYYY-MM-DD' (or 'YYYY-MM') -> {year, month}; anything else dropped. */
function monthParts(m: string): { year: number; month: number } | null {
  const hit = /^(\d{4})-(\d{2})/.exec(m);
  return hit ? { year: Number(hit[1]), month: Number(hit[2]) } : null;
}

export function toVolumeRow(v: S["VolumeItem"]): KeywordVolumeRow {
  return {
    keyword: v.keyword,
    search_volume: v.search_volume ?? 0,
    competition: v.competition ?? null,
    competition_index: v.competition_index ?? 0,
    cpc: v.cpc ?? 0,
    monthly_searches: (v.monthly_searches ?? []).flatMap((ms) => {
      const p = monthParts(ms.month);
      return p ? [{ ...p, search_volume: ms.search_volume ?? 0 }] : [];
    }),
  };
}

/** The legacy summarizeKeywordSearchVolume formula (lib/keyword/dataforseo.ts), on converted rows. */
export function summarizeVolumes(rows: KeywordVolumeRow[]): KeywordVolumeSummary {
  if (rows.length === 0) {
    return {
      totalKeywords: 0,
      averageSearchVolume: 0,
      totalSearchVolume: 0,
      highVolumeCount: 0,
      mediumVolumeCount: 0,
      lowVolumeCount: 0,
      averageCompetitionIndex: 0,
      averageCPC: 0,
    };
  }
  const sv = (r: KeywordVolumeRow) => r.search_volume ?? 0;
  const total = rows.reduce((s, r) => s + sv(r), 0);
  return {
    totalKeywords: rows.length,
    averageSearchVolume: Math.round(total / rows.length),
    totalSearchVolume: total,
    highVolumeCount: rows.filter((r) => sv(r) >= 100000).length,
    mediumVolumeCount: rows.filter((r) => sv(r) >= 10000 && sv(r) < 100000).length,
    lowVolumeCount: rows.filter((r) => sv(r) < 10000).length,
    averageCompetitionIndex: Math.round(rows.reduce((s, r) => s + (r.competition_index ?? 0), 0) / rows.length),
    averageCPC: Math.round((rows.reduce((s, r) => s + (r.cpc ?? 0), 0) / rows.length) * 100) / 100,
  };
}

/**
 * Screen gate of the keyword tools, applied by /api/keyword/{volume,to-prompt,prompt-to-volume}
 * on both sources before anything else (the page's route-policy check: role admin AND the
 * account's menu groups; U4 F1 lesson: a relay route gates like its screen).
 */
export function canUseKeywordTools(user: { role: Role; menuGroups?: readonly MenuGroup[] | null }): boolean {
  return user.role === "admin" && canAccessRoute(user.role, "/admin/keyword-tools", user.menuGroups ?? null);
}

/**
 * BFF timeout of the two LLM calls (to-prompt, prompt-to-volume): the backend's LLM cap for ONE
 * attempt (LLM_TIMEOUT_S = 180, the legacy OpenRouter abort) plus a margin. It covers the first
 * attempt only: the backend client retries once after a timeout, 429 or 5xx (1.5 s later, worst
 * case about 361.5 s in all). The calls also send it as X-HGH-Timeout-Ms (D-7), so the backend
 * bounds the whole LLM call, retry included, to this value minus its 2 s margin and no retry
 * runs on after the BFF gave up (U11-N9). The routes' maxDuration sits above this value.
 */
export const KEYWORD_LLM_TIMEOUT_MS = 185_000;

/** Longest wait inside one route call for queued DataForSEO collection (U11-N4). */
export const KEYWORD_POLL_BUDGET_MS = 20_000;
export const KEYWORD_POLL_INTERVAL_MS = 1_500;
const DONE = new Set(["applied", "failed", "escalated_rebuild"]);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the change queue until every id is done or the budget runs out. True when all are done. */
export async function waitForChanges(ids: number[], budgetMs = KEYWORD_POLL_BUDGET_MS, intervalMs = KEYWORD_POLL_INTERVAL_MS): Promise<boolean> {
  const pending = new Set(ids);
  const deadline = Date.now() + budgetMs;
  while (pending.size > 0) {
    for (const id of [...pending]) {
      try {
        const res = await hghGet("/v1/admin/changes/{change_id}", { pathParams: { change_id: id }, dedupe: false });
        if (DONE.has(res.data.status)) pending.delete(id);
      } catch (e) {
        if (isApi(e, 404)) pending.delete(id);
        else throw e;
      }
    }
    if (pending.size === 0) return true;
    if (Date.now() + intervalMs > deadline) return false;
    await wait(intervalMs);
  }
  return true;
}

function changeIds(f: S["FetchState"]): number[] {
  return [...new Set([...(f.change_id !== null && f.change_id !== undefined ? [f.change_id] : []), ...(f.pending_change_ids ?? [])])];
}

export interface VolumeLookup {
  keywords: KeywordVolumeRow[];
  summary: KeywordVolumeSummary;
  /** Terms still being collected after the wait (U11-N4). */
  pending: string[];
}

/** POST …/volume; when collection was queued, wait (bounded) and ask once more. */
export async function lookupKeywordVolumes(keywords: string[], locationCode?: number, languageCode?: string): Promise<VolumeLookup> {
  const body = {
    keywords,
    force: false,
    ...(locationCode !== undefined ? { location_code: locationCode } : {}),
    ...(languageCode !== undefined ? { language_code: languageCode } : {}),
  };
  const call = () => hghPost("/v1/admin/keyword-tools/volume", { body, timeoutClass: "external", retryOn401: true });
  let res = await call();
  if (res.data.fetch.status !== "fresh") {
    const ids = changeIds(res.data.fetch);
    if (ids.length > 0 && (await waitForChanges(ids))) res = await call();
  }
  const rows = res.data.keywords
    .filter((k) => !(k.freshness === "missing" && (k.search_volume === null || k.search_volume === undefined)))
    .map(toVolumeRow)
    .sort((a, b) => b.search_volume - a.search_volume);
  const pending = res.data.fetch.status === "fresh" ? [] : [...(res.data.fetch.pending_terms ?? [])];
  return { keywords: rows, summary: summarizeVolumes(rows), pending };
}

export interface GeneratedQuestion {
  originalInput: string;
  question: string;
  searchIntent: "informational" | "navigational" | "transactional" | "commercial";
  volume: number | null;
}

export async function keywordsToPrompts(
  keywords: string[],
  keywordVolumeMap: Record<string, number> | undefined,
  maxQuestions: number,
): Promise<{ questions: GeneratedQuestion[]; totalQuestions: number; sourceKeywords: number }> {
  const res = await hghPost("/v1/admin/keyword-tools/to-prompt", {
    body: {
      keywords,
      keyword_volume_map: keywordVolumeMap ?? null,
      max_questions: Math.max(1, Math.min(500, Math.trunc(maxQuestions))),
    },
    timeoutMs: KEYWORD_LLM_TIMEOUT_MS,
    header: { "X-HGH-Timeout-Ms": KEYWORD_LLM_TIMEOUT_MS },
    retryOn401: true,
  });
  const questions = res.data.questions.map((q) => ({
    originalInput: q.original_input,
    question: q.question,
    searchIntent: q.search_intent,
    volume: q.volume ?? null,
  }));
  return { questions, totalQuestions: res.data.total_questions, sourceKeywords: res.data.source_keywords };
}

export interface PromptVolume {
  volume: number | null;
  keywords: string[];
  debug?: { extractedKeywords: string[]; volumes: Array<{ keyword: string; volume: number }> };
  pending?: string[];
}

/**
 * POST …/prompt-to-volume once (LLM extraction + volume lookup on the backend). When collection
 * was queued, wait (bounded) and re-read the volumes of the SAME extracted keywords with POST
 * …/volume (no LLM): posting prompt-to-volume again would bill the LLM twice and could extract
 * different keywords, throwing away the volumes just collected.
 */
export async function promptToVolume(promptText: string, locationCode?: number, languageCode?: string): Promise<PromptVolume> {
  const res = await hghPost("/v1/admin/keyword-tools/prompt-to-volume", {
    body: {
      prompt_text: promptText,
      force: false,
      ...(locationCode !== undefined ? { location_code: locationCode } : {}),
      ...(languageCode !== undefined ? { language_code: languageCode } : {}),
    },
    timeoutMs: KEYWORD_LLM_TIMEOUT_MS,
    header: { "X-HGH-Timeout-Ms": KEYWORD_LLM_TIMEOUT_MS },
    retryOn401: true,
  });
  const d = res.data;
  if (d.keywords.length === 0) return { volume: null, keywords: [] };
  let items = d.volumes;
  let fetch = d.fetch;
  if (fetch.status !== "fresh") {
    const ids = changeIds(fetch);
    if (ids.length > 0 && (await waitForChanges(ids))) {
      const again = await hghPost("/v1/admin/keyword-tools/volume", {
        body: { keywords: d.keywords, force: false, location_code: d.location_code, language_code: d.language_code },
        timeoutClass: "external",
        retryOn401: true,
      });
      items = again.data.keywords;
      fetch = again.data.fetch;
    }
  }
  const volumes = items.map(toVolumeRow);
  const pending = fetch.status === "fresh" ? [] : [...(fetch.pending_terms ?? [])];
  if (volumes.length === 0) return { volume: null, keywords: d.keywords, ...(pending.length ? { pending } : {}) };
  // The backend's rule (max search volume, 0 -> null), recomputed on whichever volume set is used.
  const top = Math.max(...volumes.map((v) => v.search_volume));
  return {
    volume: top > 0 ? top : null,
    keywords: d.keywords,
    debug: {
      extractedKeywords: d.keywords,
      volumes: volumes.map((v) => ({ keyword: v.keyword, volume: v.search_volume })),
    },
    ...(pending.length ? { pending } : {}),
  };
}

/**
 * Keyword route failure -> the legacy route answer: 400 for bad input, the status for 401/403,
 * 500 {error, details:<code>} otherwise, local deployment faults included (their message is
 * logged server-side only); a non-backend error -> 500 {error, details:"internal"}.
 */
export function keywordRouteError(e: unknown, genericError: string): { status: number; body: { error: string; details?: string } } {
  if (!isHghApiError(e)) {
    // Not a backend answer: log it here, answer only a fixed code (no message to the client).
    console.error("[keyword tools] unexpected error:", e);
    return { status: 500, body: { error: genericError, details: "internal" } };
  }
  if (LOCAL_FAULTS.has(e.code)) {
    // Deployment fault (base URL / token provider): the message stays in the server log; the
    // client gets the code only, never configuration text.
    console.error(`${describeHghError(e)} ${e.message}`);
    return { status: 500, body: { error: genericError, details: e.code } };
  }
  if (e.status === 401) return { status: 401, body: { error: "unauthorized" } };
  if (e.status === 403) return { status: 403, body: { error: "forbidden" } };
  if (e.status === 422 && (e.code === "no_keywords" || e.code === "unprocessable")) {
    return { status: 400, body: { error: "keywords array is required and must not be empty" } };
  }
  if (e.status === 422 && (e.code === "unknown_location" || e.code === "unknown_language")) {
    return { status: 400, body: { error: e.code } };
  }
  console.warn(describeHghError(e));
  return { status: 500, body: { error: genericError, details: e.code } };
}

