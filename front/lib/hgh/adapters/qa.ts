import "server-only";

// Raw Data QA console on the backend API (unit U12, design 1.4, appendix F "검수 콘솔").
// Selected per request when HGH_SOURCE_G7=api (D8, sourceGroupFor("qa") = G7, default legacy:
// lib/qa/auth.ts::qaApiSource). The screens and the browser-facing /api/qa/* paths do not
// change; this module returns exactly the shapes they already consume (lib/qa/types.ts) and
// the /api/qa/* bodies the client components already parse.
//
// Transport (design 1.4): the QA console is outside the Supabase session. Every call carries
// only `Cookie: raw_data_qa=<value>` read from the browser request (auth {qaCookie}); no
// Authorization. The front never signs or verifies the cookie (no HGH_QA_SECRET here): login
// and logout relay the backend Set-Cookie with relaySetCookies, which passes the QA session
// cookie in the backend's exact shape and drops anything else.
//
//   screen / route                     backend
//   layout, gate page                  GET   /v1/qa/sessions/current   (BG-45, no side effect)
//   POST   /api/qa/session (login)     POST  /v1/qa/sessions           (clientIp relayed, D2)
//   DELETE /api/qa/session (logout)    PATCH /v1/qa/sessions/{id} {"logout": true}
//   answers page                       GET   /v1/qa/answers · /answers/progress · /filters
//   GET    /api/qa/answers (poll)      GET   /v1/qa/deltas?job_ids=
//   detail page                        GET   /v1/qa/answers/{id} · /review · /notes · /neighbors
//   POST|PATCH|DELETE /api/qa/lock     POST|PATCH|DELETE /v1/qa/answers/{id}/lock
//   PUT    /api/qa/review              PUT   /v1/qa/answers/{id}/review
//   POST|PATCH|DELETE /api/qa/note     POST  /v1/qa/answers/{id}/notes · PATCH|DELETE /v1/qa/notes/{id}
//   notes page                         GET   /v1/qa/notes · /notes/counts
//   GET    /api/qa/notes/export        GET   /v1/qa/notes/export (stream relay)
//
// Shape rules (appendix F): surface global <-> standard (screen and URL vocabulary unchanged),
// brand[] joined with ", " (empty -> null), engine null -> "", timestamps normalized to
// Date.toISOString() (what the legacy JSON of a Date was), snake -> camel. Lists keep the
// legacy order (mentions: count desc, name; citations: ref_index; ACR: acr desc, name).
// Citation override categories arrive as slugs and are shown as taxonomy names (legacy value).
//
// Error mapping (design 2.3 + appendix F write table):
//   401 qa_unauthorized  pages -> the QA gate (throwForPage); routes -> 401 {error:"unauthorized"}
//   409 lock_held        POST /api/qa/lock -> 409 {ok:false, heldBy:{reviewerName, acquiredAt}}
//   409 lock_lost        PUT /api/qa/review -> 409 {error:"lock-lost", heldBy:{reviewerName}}
//   409 cursor_stale, 422 cursor_invalid on a list -> the list page drops the cursor (first page)
//   403 not_author       note edit/delete by someone else -> 403 {error:"forbidden"} (DC-17)
//   404                  detail -> notFound(); note routes -> 404 {error:"not-found"}
//   413, 415, others     route status kept, body {error:{code}} (hghErrorResponse)
//
// Known differences from the legacy source (asserted in lib/hgh/adapters/qa.parity.test.ts):
//   DC-17  no default password; note body/severity edit and delete by the author only; logout
//          releases the session's locks and revokes the session; the review range is fixed by
//          the server (HGH_QA_SURFACES, HGH_QA_SINCE); CSV cells starting with = + - @ get a '
//          prefix. CSV also: surface column "global", timestamps in ISO with offset, trailing CRLF.
//   BG-46  answer.runId and answer.region are null until the backend sends them (core request
//          R1); ACR rows are keyed "acr_cell:<acr_cell_key>" until it sends prompt_run_id (R2),
//          so ACR notes written on the legacy source do not attach to the new keys. Both fields
//          are read here as soon as they appear (additive fields, no code change needed).
//   Notes  citation note keys are 'job_id:ord' (legacy: scope_citations.id); the note JSON has
//          no sessionId; the filter dropdowns come from dimension tables (may list values with
//          0 answers); the list tie-break for equal measured_at is the backend answer key.
//   Dates  from/to match the KST date of the measurement (legacy SQL: the UTC date), so answers
//          measured between 00:00 and 09:00 KST fall on another day (open question to the backend).
import { NextResponse, type NextRequest } from "next/server";
import { CITATION_CATEGORY_SLUGS } from "@/lib/citation-categorizer/taxonomy";
import { qaEnabled, readSessionIdUnverified } from "@/lib/qa/auth";
import {
  fromApiSurface,
  isInvertedRange,
  parseQaNoteFilter,
  qaFilterToApiQuery,
  qaNoteFilterToApiQuery,
  type QaFilter,
  type QaFilterOptionsShape,
  type QaNoteFilter,
  type QaSeverity,
} from "@/lib/qa/filters";
import {
  apiGuard,
  noteKind,
  noteSeverity,
  noteText,
  readJson,
  readSectionFlags,
  str,
  unauthorized,
} from "@/lib/qa/route-helpers";
import type {
  QaAcrGranule,
  QaAnswerListRowData,
  QaCitationGranule,
  QaLockJson,
  QaMentionGranule,
  QaNoteJson,
  QaNoteListRowData,
  QaProgress,
  QaSectionKey,
  QaSerializedDetail,
  QaSerializedNote,
  QaSerializedReview,
} from "@/lib/qa/types";
import type { components } from "../api-types";
import { QA_COOKIE, readQaCookie } from "../auth";
import { hghDelete, hghGet, hghPatch, hghPost, hghPut, hghRaw, requestClientIp } from "../client";
import { ratioValue } from "../convert";
import { describeHghError, hghErrorResponse, isHghApiError } from "../errors";
import { relayDownload, relaySetCookies } from "../relay";

type S = components["schemas"];
export type ApiQaListRow = S["QaListRow"];
export type ApiQaAnswerDetail = S["QaAnswerDetail"];
export type ApiQaNote = S["QaNote"];
export type ApiQaNoteRow = S["QaNoteRow"];
export type ApiQaLock = S["QaLock"];
export type ApiQaReview = S["QaReview"];

// ── shape helpers (pure) ─────────────────────────────────────────────────────

/** ISO timestamp as the legacy JSON of a Date (ms, Z). Unparseable text is kept as is. */
export function isoOrNull(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

function iso(v: string): string {
  return isoOrNull(v) ?? v;
}

/** API brand code list -> the single legacy brand cell. */
export function joinBrands(b: readonly string[] | null | undefined): string | null {
  return b?.length ? b.join(", ") : null;
}

/** A field the backend will add without a schema bump yet (core requests R1, R2). */
function additiveString(obj: object, key: string): string | null {
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : null;
}

const CATEGORY_BY_SLUG: ReadonlyMap<string, string> = new Map(
  Object.entries(CITATION_CATEGORY_SLUGS).map(([name, slug]) => [slug, name]),
);

/** Override category slug -> taxonomy name (the legacy override value). Unknown slug kept. */
export function categoryName(slug: string | null): string | null {
  if (slug === null) return null;
  return CATEGORY_BY_SLUG.get(slug) ?? slug;
}

/** ACR choice level (1 brand, 2 model, 3 company) -> legacy scope_acr_rollups.rollup_level. */
const ROLLUP_LEVEL: Readonly<Record<number, string>> = { 1: "brand", 2: "product", 3: "company" };

/** PostgreSQL text order with NULLS LAST (the legacy ORDER BY). */
function cmpText(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function cmpNumDescNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function cmpNumAscNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

// ── shape conversions (exported for tests) ──────────────────────────────────

export function toAnswerListRow(r: ApiQaListRow): QaAnswerListRowData {
  return {
    jobId: r.job_id,
    promptText: r.prompt_text,
    surface: fromApiSurface(r.surface),
    brand: joinBrands(r.brand),
    country: r.country,
    engine: r.engine ?? "",
    lang: r.lang,
    measuredAt: isoOrNull(r.measured_at),
    mentionCount: r.mention_count,
    citationCount: r.citation_count,
    noteCount: r.note_count,
    reviewStatus: r.review_status,
    reviewerName: r.reviewer_name,
    lock: r.lock ? { reviewerName: r.lock.reviewer_name } : null,
  };
}

function toMention(m: S["QaMention"]): QaMentionGranule {
  const entityId = m.entity_id ?? `ord:${m.ord}`;
  return {
    entityId,
    brand: m.display_name,
    entityType: m.entity_type,
    mentionCount: m.mention_count,
    sentimentPositive: m.sentiment_positive,
    sentimentNeutral: m.sentiment_neutral,
    sentimentNegative: m.sentiment_negative,
    sentimentMixed: m.sentiment_mixed,
    avgPosition: m.avg_position,
    surfaces: m.surfaces,
    brandRollupEntityId: m.brand_rollup_entity_id,
    rollupParentName: m.rollup_parent_name,
    typeMention: m.type_mention,
    typeRecommendation: m.type_recommendation,
    typeComparison: m.type_comparison,
    typeDefinition: m.type_definition,
    typeFinalChoice: m.type_final_choice,
    registryRole: m.registry_role,
    isOwn: m.is_own,
    isExcluded: m.is_excluded,
  };
}

function toCitation(c: S["QaCitation"]): QaCitationGranule {
  const override = categoryName(c.override_category);
  return {
    id: c.ord,
    targetKey: c.target_key,
    refIndex: c.ref_index,
    url: c.url,
    domain: c.domain,
    title: c.title,
    storedCategory: c.stored_category,
    overrideCategory: override,
    effectiveCategory: override ?? c.stored_category,
    urlNorm: c.url_norm ?? null,
    urlHost: c.host,
    urlBaseNorm: c.url_base_norm ?? null,
  };
}

function toAcrRows(cells: readonly S["QaAcrCell"][]): QaAcrGranule[] {
  const out: QaAcrGranule[] = [];
  for (const cell of cells) {
    const runKey =
      additiveString(cell, "prompt_run_id") ??
      (cell.acr_cell_key != null ? `acr_cell:${cell.acr_cell_key}` : `round:${cell.round_date}`);
    cell.choices.forEach((ch, i) => {
      out.push({
        promptRunId: runKey,
        entityId: ch.entity_id ?? `level${ch.level}:${i}`,
        brand: ch.name ?? ch.brand,
        parentBrand: ch.parent_brand,
        rollupLevel: ROLLUP_LEVEL[ch.level] ?? String(ch.level),
        entityType: ch.entity_type,
        plannedIterations: cell.planned,
        validTurn1Iterations: cell.valid_turn1,
        validAcrIterations: cell.valid_acr,
        appearanceCount: ch.appearance,
        choiceCount: ch.choice,
        conditionalChoiceCount: ch.cond_choice,
        offShortlistChoiceCount: ch.off_shortlist,
        unresolvedChoiceCount: ch.unresolved,
        genericChoiceCount: ch.generic,
        appearanceRate: ratioValue(ch.appearance_rate),
        acr: ratioValue(ch.acr),
        overallChoiceShare: ratioValue(ch.overall_choice_share),
        coSingleEntity: cell.co_single,
        coConditionalMultiple: cell.co_conditional,
        coGenericCategory: cell.co_generic,
        coResolvedOffShortlist: cell.co_off_shortlist,
        coUnresolvedChoice: cell.co_unresolved,
        coNone: cell.co_none,
      });
    });
  }
  // legacy: ORDER BY acr DESC NULLS LAST, brand
  return out.sort((a, b) => cmpNumDescNullsLast(a.acr, b.acr) || cmpText(a.brand, b.brand));
}

export function toSerializedDetail(d: ApiQaAnswerDetail): QaSerializedDetail {
  const a = d.answer;
  const p = d.prompt;
  const cat = p.catalog;
  return {
    answer: {
      jobId: a.job_id,
      runId: additiveString(a, "run_id"),
      promptId: p.prompt_id,
      target: a.engine ?? "",
      region: additiveString(a, "region"),
      status: a.status,
      measuredAt: isoOrNull(a.measured_at),
      modelSlug: a.model_slug,
      answerText: a.answer_text,
      surface: fromApiSurface(a.surface),
      brand: joinBrands(a.brand),
      country: a.country,
    },
    prompt: {
      text: p.text,
      // design appendix F: catalog stage first, else the prompt's funnel code
      funnelStage: cat?.funnel_stage ?? p.funnel ?? null,
      lang: p.lang,
      regions: p.regions,
      isKorean: p.is_korean,
      catalog: cat
        ? {
            brand: cat.brand,
            brandPresence: cat.brand_presence,
            listType: cat.list_type,
            depth1: cat.depth1,
            depth2: cat.depth2,
            depth3: cat.depth3,
            depth4: cat.depth4,
            funnelStage: cat.funnel_stage,
            kind: cat.kind,
            promptType: cat.prompt_type,
            category: cat.category,
          }
        : null,
    },
    // legacy: ORDER BY mention_count DESC, brand NULLS LAST
    mentions: d.mentions
      .map(toMention)
      .sort((x, y) => y.mentionCount - x.mentionCount || cmpText(x.brand, y.brand)),
    // legacy: ORDER BY ref_index NULLS LAST, id
    citations: d.citations
      .map(toCitation)
      .sort((x, y) => cmpNumAscNullsLast(x.refIndex, y.refIndex) || x.id - y.id),
    acr: toAcrRows(d.acr),
    derived: {
      anchor: d.derived.anchor
        ? {
            anchor: d.derived.anchor.anchor,
            sourceMeasuredAt: isoOrNull(d.derived.anchor.source_measured_at),
            reason: d.derived.anchor.reason,
          }
        : null,
      drop: d.derived.drop
        ? {
            sourceMeasuredAt: isoOrNull(d.derived.drop.source_measured_at),
            reason: d.derived.drop.reason ?? "",
            droppedAt: isoOrNull(d.derived.drop.dropped_at),
          }
        : null,
    },
  };
}

export function toSerializedReview(r: ApiQaReview | null): QaSerializedReview {
  if (!r) return null;
  const flags: Partial<Record<QaSectionKey, "ok" | "issue">> = {};
  for (const [k, v] of Object.entries(r.section_flags ?? {})) {
    if (v === "ok" || v === "issue") flags[k as QaSectionKey] = v;
  }
  return {
    status: r.status,
    sectionFlags: flags,
    reviewerName: r.reviewer_name,
    reviewedAt: isoOrNull(r.updated_at),
  };
}

export function toSerializedNote(n: ApiQaNote): QaSerializedNote {
  return {
    id: n.note_id,
    targetKind: n.target_kind,
    targetKey: n.target_key,
    targetLabel: n.target_label,
    severity: n.severity,
    body: n.body,
    reviewerName: n.reviewer_name,
    createdAt: isoOrNull(n.created_at),
    resolvedAt: isoOrNull(n.resolved_at),
  };
}

/** /api/qa/note answer body `note` (the legacy JSON of the note row, without sessionId). */
export function toNoteJson(n: ApiQaNote): QaNoteJson {
  return { ...toSerializedNote(n), jobId: n.job_id, resolvedBy: n.resolved_by };
}

export function toNoteListRow(n: ApiQaNoteRow): QaNoteListRowData {
  return {
    id: n.note_id,
    jobId: n.job_id,
    targetKind: n.target_kind,
    targetLabel: n.target_label,
    severity: n.severity,
    body: n.body,
    reviewerName: n.reviewer_name,
    createdAt: isoOrNull(n.created_at),
    resolvedAt: isoOrNull(n.resolved_at),
    resolvedBy: n.resolved_by,
    promptText: n.prompt_text,
    surface: fromApiSurface(n.surface),
  };
}

export function toLockJson(l: ApiQaLock): QaLockJson {
  return {
    jobId: l.job_id,
    sessionId: l.session_id,
    reviewerName: l.reviewer_name,
    acquiredAt: iso(l.acquired_at),
    heartbeatAt: iso(l.heartbeat_at),
  };
}

function pickProgress(p: S["QaProgressCounts"]): QaProgress {
  return { total: p.total, reviewed: p.reviewed, issues: p.issues, notes: p.notes };
}

const ZERO_PROGRESS: QaProgress = { total: 0, reviewed: 0, issues: 0, notes: 0 };

const byLocale = (xs: readonly string[]) => [...xs].sort((a, b) => a.localeCompare(b));

/** Lock holder from a 409 lock_held / lock_lost envelope (display only; branching stays on status + code). */
export function lockHolder(details: unknown): { reviewerName: string; acquiredAt: string | null } | null {
  const held = (details as { held_by?: unknown } | null | undefined)?.held_by;
  if (!held || typeof held !== "object") return null;
  const h = held as { reviewer_name?: unknown; acquired_at?: unknown };
  return {
    reviewerName: typeof h.reviewer_name === "string" ? h.reviewer_name : "",
    acquiredAt: typeof h.acquired_at === "string" ? isoOrNull(h.acquired_at) : null,
  };
}

// ── screen data (server components) ──────────────────────────────────────────

async function qaAuth(): Promise<{ qaCookie: string | null }> {
  return { qaCookie: await readQaCookie() };
}

/**
 * The reviewer of the current QA cookie, or null (no cookie, expired, logged out, revoked:
 * 401). Side-effect free (BG-45: last_seen_at untouched). Other failures are thrown.
 */
export async function getCurrentReviewer(): Promise<{ sessionId: string; name: string } | null> {
  const qaCookie = await readQaCookie();
  if (!qaCookie) return null;
  try {
    const res = await hghGet("/v1/qa/sessions/current", { auth: { qaCookie } });
    return { sessionId: res.data.session_id, name: res.data.reviewer_name };
  } catch (e) {
    if (isHghApiError(e) && e.status === 401) return null;
    throw e;
  }
}

export async function listAnswers(
  filter: QaFilter,
  cursor: string | undefined,
  limit: number,
): Promise<{ rows: QaAnswerListRowData[]; nextCursor: string | null }> {
  if (isInvertedRange(filter)) return { rows: [], nextCursor: null };
  const res = await hghGet("/v1/qa/answers", {
    auth: await qaAuth(),
    query: { ...qaFilterToApiQuery(filter), ...(cursor ? { cursor } : {}), limit },
  });
  return { rows: res.data.items.map(toAnswerListRow), nextCursor: res.meta.page?.next_cursor ?? null };
}

export async function getProgress(filter: QaFilter): Promise<{ scoped: QaProgress; total: QaProgress }> {
  const inverted = isInvertedRange(filter);
  const res = await hghGet("/v1/qa/answers/progress", {
    auth: await qaAuth(),
    query: inverted ? {} : qaFilterToApiQuery(filter),
  });
  return {
    scoped: inverted ? { ...ZERO_PROGRESS } : pickProgress(res.data.scoped),
    total: pickProgress(res.data.total),
  };
}

export async function getFilterOptions(): Promise<QaFilterOptionsShape> {
  const res = await hghGet("/v1/qa/filters", { auth: await qaAuth() });
  const o = res.data;
  return {
    brand: byLocale(o.brand),
    country: byLocale(o.country),
    engine: byLocale(o.engine),
    lang: byLocale(o.lang),
    reviewer: [...o.reviewer],
  };
}

/** Detail, or null when the backend does not know the answer (404) or the id is malformed (422). */
export async function getAnswerDetail(jobId: string): Promise<QaSerializedDetail | null> {
  try {
    const res = await hghGet("/v1/qa/answers/{job_id}", { auth: await qaAuth(), pathParams: { job_id: jobId } });
    return toSerializedDetail(res.data);
  } catch (e) {
    if (isHghApiError(e) && (e.status === 404 || e.status === 422)) return null;
    throw e;
  }
}

export async function getReview(jobId: string): Promise<QaSerializedReview> {
  const res = await hghGet("/v1/qa/answers/{job_id}/review", { auth: await qaAuth(), pathParams: { job_id: jobId } });
  return toSerializedReview(res.data);
}

export async function listNotesForJob(jobId: string): Promise<QaSerializedNote[]> {
  const res = await hghGet("/v1/qa/answers/{job_id}/notes", { auth: await qaAuth(), pathParams: { job_id: jobId } });
  // legacy: ORDER BY created_at (stable for equal times)
  return res.data.items
    .map(toSerializedNote)
    .sort((a, b) => cmpText(a.createdAt, b.createdAt));
}

export async function getNeighbors(filter: QaFilter, jobId: string): Promise<{ prev: string | null; next: string | null }> {
  if (isInvertedRange(filter)) return { prev: null, next: null };
  const res = await hghGet("/v1/qa/answers/{job_id}/neighbors", {
    auth: await qaAuth(),
    pathParams: { job_id: jobId },
    query: qaFilterToApiQuery(filter),
  });
  return { prev: res.data.prev, next: res.data.next };
}

export async function listNotes(
  filter: QaNoteFilter,
  cursor: string | undefined,
  limit: number,
): Promise<{ rows: QaNoteListRowData[]; nextCursor: string | null }> {
  if (isInvertedRange(filter)) return { rows: [], nextCursor: null };
  const res = await hghGet("/v1/qa/notes", {
    auth: await qaAuth(),
    query: { ...qaNoteFilterToApiQuery(filter), ...(cursor ? { cursor } : {}), limit },
  });
  return { rows: res.data.items.map(toNoteListRow), nextCursor: res.meta.page?.next_cursor ?? null };
}

export async function countNotesByKind(filter: QaNoteFilter): Promise<Record<string, number>> {
  if (isInvertedRange(filter)) return {};
  const res = await hghGet("/v1/qa/notes/counts", { auth: await qaAuth(), query: qaNoteFilterToApiQuery(filter) });
  // legacy GROUP BY: kinds without notes are absent
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(res.data)) if (n > 0) out[k] = n;
  return out;
}

/** 409 cursor_stale or 422 cursor_invalid on a list: the page reloads without the cursor. */
export function isCursorProblem(e: unknown): boolean {
  return (
    isHghApiError(e) &&
    ((e.status === 409 && e.code === "cursor_stale") || (e.status === 422 && e.code === "cursor_invalid"))
  );
}

// ── /api/qa/* route handlers (browser-facing paths and bodies unchanged) ─────

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Any other failure: 401 -> the legacy unauthorized body, else status kept with {error:{code}}. */
function routeError(e: unknown): Response {
  if (isHghApiError(e)) {
    if (e.status === 401) return unauthorized();
    if (e.status >= 500) console.warn(describeHghError(e));
  }
  return hghErrorResponse(e);
}

const status = (e: unknown): number | null => (isHghApiError(e) ? e.status : null);

/** Columns of the notes CSV (legacy route and backend export: same names, same order). */
export const QA_NOTE_CSV_COLUMNS = [
  "created_at",
  "reviewer",
  "job_id",
  "target_kind",
  "target_key",
  "target_label",
  "severity",
  "body",
  "prompt",
  "surface",
  "resolved_at",
  "resolved_by",
] as const;

async function drain(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    // body already gone: nothing to free
  }
}

export const qaApiRoutes = {
  /** POST /api/qa/session: gate login. */
  async sessionPost(req: NextRequest): Promise<Response> {
    if (!qaEnabled()) return new NextResponse(null, { status: 404 });
    const body = await readJson(req);
    // Same attempt order as legacy, on the backend: rate limit -> name -> password.
    // A non-string name is sent as "" (-> bad_name); a non-string or over-long password as ""
    // (-> bad_credentials), which the legacy route answered too (the backend caps it at 200).
    const name = typeof body.name === "string" ? body.name : "";
    const password = typeof body.password === "string" && body.password.length <= 200 ? body.password : "";
    let upstream: Response;
    try {
      upstream = await hghRaw("post", "/v1/qa/sessions", {
        auth: "none",
        body: { name, password },
        clientIp: await requestClientIp(),
        accept: "application/json",
        timeoutClass: "write",
      });
    } catch (e) {
      switch (status(e)) {
        case 401:
          return json({ error: "bad-credentials" }, 401);
        case 400:
        case 422:
          return json({ error: "bad-name" }, 400);
        case 429:
          return json({ error: "rate-limited" }, 429);
        case 404:
          return new NextResponse(null, { status: 404 });
        default:
          return routeError(e);
      }
    }
    let reviewerName: string;
    try {
      const out = (await upstream.json()) as S["Envelope_QaSessionOut_"];
      reviewerName = out.data.reviewer_name;
    } catch {
      return json({ error: { code: "upstream_non_json" } }, 502);
    }
    const res = json({ name: reviewerName });
    const { relayed } = relaySetCookies(upstream, res.headers);
    if (relayed === 0) {
      // Logged in on the backend but no usable cookie: the gate would loop. Fail visibly.
      console.error("[hgh] QA login: backend answered without a relayable raw_data_qa cookie");
      return json({ error: { code: "cookie_relay" } }, 502);
    }
    return res;
  },

  /** DELETE /api/qa/session: logout. Always clears the cookie (legacy: always {ok:true}). */
  async sessionDelete(): Promise<Response> {
    if (!qaEnabled()) return new NextResponse(null, { status: 404 });
    const res = json({ ok: true });
    const cookie = await readQaCookie();
    const sessionId = readSessionIdUnverified(cookie);
    let relayed = 0;
    if (cookie && sessionId) {
      try {
        const upstream = await hghRaw("patch", "/v1/qa/sessions/{session_id}", {
          auth: { qaCookie: cookie },
          pathParams: { session_id: sessionId },
          body: { logout: true },
          accept: "application/json",
          timeoutClass: "write",
        });
        relayed = relaySetCookies(upstream, res.headers).relayed;
        await drain(upstream);
      } catch (e) {
        // Session already gone (401) or backend down: the browser cookie still goes.
        if (isHghApiError(e) && e.status !== 401) console.warn(describeHghError(e));
      }
    }
    if (relayed === 0) res.cookies.set({ name: QA_COOKIE, value: "", path: "/", maxAge: 0 });
    return res;
  },

  /** POST /api/qa/lock {jobId}: acquire; with ?release=1 (sendBeacon on unload): release. */
  async lockPost(req: NextRequest): Promise<Response> {
    const g = await apiGuard();
    if (!g.ok) return g.response;
    const jobId = str((await readJson(req)).jobId);
    if (!jobId) return json({ error: "jobId required" }, 400);
    const auth = { qaCookie: g.cookie };
    if (req.nextUrl.searchParams.get("release") === "1") {
      try {
        await hghDelete("/v1/qa/answers/{job_id}/lock", { auth, pathParams: { job_id: jobId } });
        return json({ ok: true });
      } catch (e) {
        return routeError(e);
      }
    }
    try {
      const res = await hghPost("/v1/qa/answers/{job_id}/lock", { auth, pathParams: { job_id: jobId } });
      return json({ ok: true, lock: toLockJson(res.data) });
    } catch (e) {
      if (isHghApiError(e) && e.status === 409 && e.code === "lock_held") {
        const held = lockHolder(e.details);
        return json(
          {
            ok: false,
            heldBy: {
              reviewerName: held?.reviewerName ?? "",
              acquiredAt: held?.acquiredAt ?? new Date().toISOString(),
            },
          },
          409,
        );
      }
      return routeError(e);
    }
  },

  /** PATCH /api/qa/lock {jobId}: heartbeat -> {held}. */
  async lockPatch(req: NextRequest): Promise<Response> {
    const g = await apiGuard();
    if (!g.ok) return g.response;
    const jobId = str((await readJson(req)).jobId);
    if (!jobId) return json({ error: "jobId required" }, 400);
    try {
      const res = await hghPatch("/v1/qa/answers/{job_id}/lock", {
        auth: { qaCookie: g.cookie },
        pathParams: { job_id: jobId },
      });
      return json({ held: res.data.held });
    } catch (e) {
      return routeError(e);
    }
  },

  /** DELETE /api/qa/lock {jobId} (fetch keepalive): release -> {ok:true}. */
  async lockDelete(req: NextRequest): Promise<Response> {
    const g = await apiGuard();
    if (!g.ok) return g.response;
    const jobId = str((await readJson(req)).jobId);
    if (!jobId) return json({ error: "jobId required" }, 400);
    try {
      await hghDelete("/v1/qa/answers/{job_id}/lock", { auth: { qaCookie: g.cookie }, pathParams: { job_id: jobId } });
      return json({ ok: true });
    } catch (e) {
      return routeError(e);
    }
  },

  /** PUT /api/qa/review {jobId, sectionFlags}: save; the backend re-checks the lock. */
  async reviewPut(req: NextRequest): Promise<Response> {
    const g = await apiGuard();
    if (!g.ok) return g.response;
    const body = await readJson(req);
    const jobId = str(body.jobId);
    if (!jobId) return json({ error: "jobId required" }, 400);
    try {
      const res = await hghPut("/v1/qa/answers/{job_id}/review", {
        auth: { qaCookie: g.cookie },
        pathParams: { job_id: jobId },
        body: { section_flags: readSectionFlags(body.sectionFlags) },
      });
      return json({ status: res.data.status, reviewerName: res.data.reviewer_name });
    } catch (e) {
      if (isHghApiError(e) && e.status === 409 && e.code === "lock_lost") {
        return json({ error: "lock-lost", heldBy: { reviewerName: lockHolder(e.details)?.reviewerName ?? "" } }, 409);
      }
      if (status(e) === 422) return json({ error: "invalid" }, 400);
      return routeError(e);
    }
  },

  /** POST /api/qa/note: create a note on one granule. */
  async notePost(req: NextRequest): Promise<Response> {
    const g = await apiGuard();
    if (!g.ok) return g.response;
    const body = await readJson(req);
    const jobId = str(body.jobId);
    const targetKind = noteKind(body.targetKind);
    const text = noteText(body.body);
    if (!jobId || !targetKind || !text) return json({ error: "jobId, targetKind, body required" }, 400);
    const label = str(body.targetLabel);
    try {
      const res = await hghPost("/v1/qa/answers/{job_id}/notes", {
        auth: { qaCookie: g.cookie },
        pathParams: { job_id: jobId },
        body: {
          target_kind: targetKind,
          target_key: str(body.targetKey),
          // The label is a display snapshot; the backend caps it at 500 characters.
          target_label: label ? label.slice(0, 500) : null,
          severity: noteSeverity(body.severity),
          body: text,
        },
      });
      return json({ note: toNoteJson(res.data) });
    } catch (e) {
      if (status(e) === 422) return json({ error: "jobId, targetKind, body required" }, 400);
      if (status(e) === 404) return json({ error: "not-found" }, 404);
      return routeError(e);
    }
  },

  /** PATCH /api/qa/note {id, body?, severity?, resolved?}. */
  async notePatch(req: NextRequest): Promise<Response> {
    const g = await apiGuard();
    if (!g.ok) return g.response;
    const body = await readJson(req);
    const id = str(body.id);
    if (!id) return json({ error: "id required" }, 400);
    const patch: { body?: string; severity?: QaSeverity; resolved?: boolean } = {};
    const text = noteText(body.body);
    if (text) patch.body = text;
    if (body.severity !== undefined) patch.severity = noteSeverity(body.severity);
    if (typeof body.resolved === "boolean") patch.resolved = body.resolved;
    // Nothing to change: legacy updateNote returned null -> 404 not-found (the backend would 422).
    if (Object.keys(patch).length === 0) return json({ error: "not-found" }, 404);
    try {
      const res = await hghPatch("/v1/qa/notes/{note_id}", {
        auth: { qaCookie: g.cookie },
        pathParams: { note_id: id },
        body: patch,
      });
      return json({ note: toNoteJson(res.data) });
    } catch (e) {
      return noteWriteError(e);
    }
  },

  /** DELETE /api/qa/note {id} (no caller in the UI today). */
  async noteDelete(req: NextRequest): Promise<Response> {
    const g = await apiGuard();
    if (!g.ok) return g.response;
    const id = str((await readJson(req)).id);
    if (!id) return json({ error: "id required" }, 400);
    try {
      await hghDelete("/v1/qa/notes/{note_id}", { auth: { qaCookie: g.cookie }, pathParams: { note_id: id } });
      return json({ ok: true });
    } catch (e) {
      return noteWriteError(e);
    }
  },

  /** GET /api/qa/answers?jobIds=a,b: the list's 10 s poll (locks and review states). */
  async answersDeltas(req: NextRequest): Promise<Response> {
    const g = await apiGuard();
    if (!g.ok) return g.response;
    const jobIds = (req.nextUrl.searchParams.get("jobIds") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    if (jobIds.length === 0) return json({ locks: [], reviews: [] });
    try {
      const res = await hghGet("/v1/qa/deltas", { auth: { qaCookie: g.cookie }, query: { job_ids: jobIds } });
      return json({
        locks: res.data.locks.map(toLockJson),
        reviews: res.data.reviews.map((r) => ({ jobId: r.job_id, status: r.status, reviewerName: r.reviewer_name })),
      });
    } catch (e) {
      return routeError(e);
    }
  },

  /** GET /api/qa/notes/export?{note filter}: CSV stream relay (no buffering). */
  async notesExport(req: NextRequest): Promise<Response> {
    const g = await apiGuard();
    if (!g.ok) return g.response;
    // Repeated params kept as arrays (a reviewer name may contain a comma), as legacy.
    const raw: Record<string, string[]> = {};
    req.nextUrl.searchParams.forEach((v, k) => {
      (raw[k] ??= []).push(v);
    });
    const filter = parseQaNoteFilter(raw);
    if (isInvertedRange(filter)) return emptyNotesCsv();
    try {
      return await relayDownload("/v1/qa/notes/export", {
        auth: { qaCookie: g.cookie },
        accept: "text/csv",
        query: qaNoteFilterToApiQuery(filter),
      });
    } catch (e) {
      return routeError(e);
    }
  },
};

function noteWriteError(e: unknown): Response {
  switch (status(e)) {
    case 403:
      return json({ error: "forbidden" }, 403); // not_author (DC-17)
    case 404:
      return json({ error: "not-found" }, 404);
    case 422:
      return json({ error: "invalid" }, 400);
    default:
      return routeError(e);
  }
}

/** Header-only CSV in the backend export format (BOM, CRLF), for an empty (inverted) range. */
function emptyNotesCsv(): Response {
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(`\uFEFF${QA_NOTE_CSV_COLUMNS.join(",")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="qa-notes-${stamp}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
