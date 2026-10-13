import "server-only";

// Customer interest (고객 관심) on the backend API (unit U10, design appendix E "intent",
// "API 라우트 절", decisions D5 cursor, D6 staged first render, D8 flag, D12 operator queue).
// Selected per call when HGH_SOURCE_G6=api (sourceGroupFor("intent") = G6, default legacy).
// The screens, the browser-facing /api/keyword/{insight,related,search} and /api/context-map*
// paths and the server action signatures do not change: this module returns exactly the
// shapes they already consume (lib/keyword/insight.ts, components/social-scraping/types.ts,
// intent/_actions.ts ActionResult).
//
//   screen / route / action                    backend
//   google-keyword page: tracked tabs          GET    /v1/intent/keywords?project_id
//   customer-interest/google-keywords: tabs    GET    /v1/intent/standard-keywords (BG-41, cursor)
//   POST /api/keyword/insight                  GET    /v1/intent/insight (+ collect, serp-drafts)
//   POST /api/keyword/related                  GET    /v1/intent/related (+ collect)
//   POST /api/keyword/search                   GET    /v1/intent/lookup (+ collect), 20 terms per call
//   social-scraping page (D6: 4 first)         GET    context-map/stats, contexts, conditions, combinations
//                        (then)                GET    /v1/projects/{id}/prompt-candidates (texts),
//                                                     /v1/intent/social/prompts
//   GET  /api/context-map?tab=...              GET    context-map/{contexts,conditions,combinations}
//                                                     (cursor, D5), context-map/entities/{id}
//   POST /api/context-map/export               GET    context-map/export?lang (stream relay)
//   addTrackedKeyword / remove(s)              POST / DELETE /v1/intent/keywords
//   addCandidate / addCandidates               POST   /v1/intent/candidates
//   generateMore / generateSelected            POST   /v1/intent/social/prompts {mode}
//   removeSocialPrompts                        DELETE /v1/intent/social/prompts
//
// Collection (D12, Q13): the backend GETs never call DataForSEO. When a read is not fresh the
// route asks for a collection (POST /v1/intent/fetches, operators only), polls the change until
// applied or failed (bounded), reads again, then drafts missing SERP prompts (POST
// /v1/intent/serp-drafts, operators only). A viewer who may not collect gets what is stored.
//
// Known differences from the legacy source (asserted in intent.test.ts and intent.parity.test.ts):
//   DC-15    keyword data: legacy = anyone, live DataForSEO + LLM inside the request. api = stored
//            data; only admin / operators (global, or assigned on their project and its
//            countries) trigger a collection. Others see empty trend / SERP / related (never
//            collected) or the stored copy.
//   U10-N1   collection that does not finish within COLLECT_BUDGET_MS (or fails) answers the stored
//            copy when there is one, else 502 upstream (component error state with retry, gap G9).
//   U10-N2   SERP prompt drafts: legacy stored the keyword itself when the LLM failed; api keeps
//            no draft and shows the keyword as the prompt (same visible text), a later load retries.
//            The same fallback when the route has too little time left for the drafts call
//            (serpDraftTimeoutMs: the call is sized to the rest of the route's maxDuration).
//   U10-N3   related / search foundCount = DataForSEO total_count (BG-39); when the stored call has
//            no total_count, the stored item count (legacy's own fallback).
//   U10-N4   tracked keyword country: legacy stored any string; api accepts the 30 DataForSEO
//            presets only (422 unknown_country -> "지원하지 않는 국가입니다").
//   U10-N5   candidates: same-text dedup against the project pool now also applies to the single
//            add (legacy inserted duplicates); a skipped single add still answers ok (id "").
//   U10-N6   social prompts: GeneratedPrompt.id = backend prompt_id (legacy: seed id); order =
//            batch, priority desc (legacy: cache append order); layer null -> "L1-context",
//            funnel null -> "consideration", sourceLabel null -> "", priority null -> 0;
//            similarTo computed by the backend (same bigram rule, threshold 0.5).
//            The optimistic-lock "다른 작업과 겹쳤습니다" answer no longer occurs (seed_key unique).
//            Selected generation takes at most 50 ids per kind (backend limit).
//   U10-N13  duplicate tracked keyword: api answers "이미 추가된 키워드입니다" (409 duplicate_keyword)
//            for the same normalized term (NFC, case) and effective country. Legacy compared the
//            exact term and, with the current drizzle (it wraps the driver error, so the
//            message check for "unique" misses), THROWS on the duplicate instead of answering.
//            The view already blocks an exact duplicate label before calling, so this shows only
//            for case variants or a stale tab.
//   U10-N7   context map lists: keyset cursor instead of page offsets (D5, C3); rows with equal
//            sort keys are ordered by id (legacy: undefined order); search is cut to 100
//            characters and control characters are dropped (backend limit).
//   U10-N8   context map with no active snapshot: stats all 0 and empty lists (gap G13), detail 404,
//            export 409 (legacy: the mirror always had rows).
//   U10-N9   context map export: sheet names and headers come from the backend (EXPORT_LABELS,
//            equal to messages/{ko,en} socialScraping.contextMap today, gap G14), the language from
//            the request body `lang` (C4) or NEXT_LOCALE; the file name header is the backend's
//            (the component names the download itself).
//   U10-N10  standard keywords screen (BG-41): the managed standard keyword list (brand scoped,
//            newest first) instead of the fixed sample terms.
//   U10-N11  action errors come from messages projectDetail.intent.actionErrors (ko = the legacy
//            strings); en shows English where legacy showed Korean.
//   U10-N12  place gates on the three keyword routes and the context-map routes, on BOTH sources
//            and before the source switch (verification D1 / D3; keywordRouteGate,
//            contextMapRouteDenied): project routes need the project page gate, the standard screen
//            needs its ROUTES rule, the context map the project ROUTES rule (backend enforces the
//            same, the BFF checks first). Not a legacy <-> api difference any more; it changes the
//            pre-U10 legacy routes, which let any session reach live DataForSEO + LLM or the mirror.
//   U10-N14  /api/keyword/search takes at most MAX_SEARCH_TERMS (40) unique trimmed terms on both
//            sources (400 above, verification D2; pre-U10 legacy had no cap). On api the collections
//            of all chunks are requested first and share ONE COLLECT_BUDGET_MS deadline.
import { getTranslations } from "next-intl/server";
import { canAccessRoute } from "@/lib/auth/route-policy";
import type { Role, MenuGroup } from "@/lib/auth/types";
import { UnauthorizedError } from "@/lib/auth/errors";
import { isDemoProject } from "@/lib/demo";
import type { KeywordInsight, KeywordSearchGroup, RelatedItem, SerpRow, TrendPoint } from "@/lib/keyword/insight";
import type { SearchIntent } from "@/lib/keyword/dataforseo-discovery";
import { getPresetById, type LocationLanguagePreset } from "@/lib/keyword/location-presets";
import type { PromptSource } from "@/lib/db/repositories/prompts";
import type {
  CombinationListRow,
  ConditionListRow,
  ContextEntityDetail,
  ContextListRow,
  ContextMapStats,
  ContextSortDir,
  FunnelStage,
  GeneratedPrompt,
  Paged,
  PerspectiveBreakdown,
  PromptLayer,
} from "@/components/social-scraping/types";
import type { components } from "../api-types";
import { HGH_TIMEOUTS, hghDelete, hghGet, hghPost, hghSource, sourceGroupFor, type HghSource } from "../client";
import { errorKindOf, HghApiError, hghErrorResponse, isHghApiError } from "../errors";
import { fetchAllPages, fetchPageOrRestart, MAX_PAGES_CEILING, pageInfo, type CursorPage } from "../paginate";
import { relayDownload } from "../relay";
import { fetchProjectGate } from "./project-gate";

type S = components["schemas"];
export type ApiInsight = S["Insight"];
export type ApiRelated = S["Related"];
export type ApiLookupRow = S["LookupRow"];
export type ApiRelatedItem = S["RelatedItem"];
export type ApiContextRow = S["ContextRow"];
export type ApiConditionRow = S["ConditionRow"];
export type ApiCombinationRow = S["CombinationRow"];
export type ApiEntityDetail = S["EntityDetail"];
export type ApiStats = S["Stats"];
export type ApiGeneratedPrompt = S["GeneratedPrompt"];
export type ApiSentiment = S["app__features__intent__social__context_map__schemas__Sentiment"];
type ApiMeta = S["Meta"];

// ── source switch (D8) ──────────────────────────────────────────────────────

/** HGH_SOURCE_<G6> for the customer-interest screens, routes and actions (default legacy). */
export function intentSource(env?: Record<string, string | undefined>): HghSource {
  return hghSource(sourceGroupFor("intent"), env);
}

export function isIntentApi(env?: Record<string, string | undefined>): boolean {
  return intentSource(env) === "api";
}

// ── place gates for the api branch of the BFF routes (U10-N12) ──────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** ROUTES entries whose rule the intent routes apply (route-policy.ts). */
export const INTENT_ROUTE_PATHS = {
  project: "/projects",
  standardKeywords: "/customer-interest/google-keywords",
} as const;

export interface GateUser {
  id: string;
  role: Role;
  menuGroups?: readonly MenuGroup[] | null;
}

export type GateResult = { ok: true } | { ok: false; status: 403 | 404 };

/**
 * The project pages' gate for a route handler: the project ROUTES rule (role + menu), demo
 * project admin-only, then the project itself: HGH_SOURCE_SESSION=api -> GET /v1/projects/{id}
 * (admin or active member, everyone else 404), legacy -> `legacyAllowed` (the leaf page gate:
 * project exists and admin or active member). Errors other than 404 are thrown (HghApiError).
 */
export async function projectRouteGate(
  user: GateUser,
  projectId: string,
  legacyAllowed: () => Promise<boolean>,
): Promise<GateResult> {
  if (!canAccessRoute(user.role, INTENT_ROUTE_PATHS.project, user.menuGroups ?? null)) return { ok: false, status: 403 };
  if (!isUuid(projectId)) return { ok: false, status: 404 };
  if (isDemoProject(projectId) && user.role !== "admin") return { ok: false, status: 404 };
  const allowed = hghSource("SESSION") === "api" ? (await fetchProjectGate(projectId)) !== null : await legacyAllowed();
  return allowed ? { ok: true } : { ok: false, status: 404 };
}

/** The standard keyword screen's ROUTES rule (STANDARD_VIEWERS + menu standard). */
export function standardKeywordRouteAllowed(user: GateUser): boolean {
  return canAccessRoute(user.role, INTENT_ROUTE_PATHS.standardKeywords, user.menuGroups ?? null);
}

/** The context map's live screen is the project social-scraping page: the project ROUTES rule. */
export function contextMapRouteAllowed(user: GateUser): boolean {
  return canAccessRoute(user.role, INTENT_ROUTE_PATHS.project, user.menuGroups ?? null);
}

/**
 * The legacy leaf page gate of the project intent pages (project exists, admin or ACTIVE member),
 * injected by the keyword routes (app/api/keyword/_lib/legacy-project-gate.ts): lib/hgh never
 * loads lib/db at runtime (front-ci "금지 import 가드"), as drilldownGate / citationRouteGate.
 */
export type LegacyProjectAllowed = (projectId: string, user: GateUser) => Promise<boolean>;

export type KeywordRouteGate = { ok: true; projectId: string | undefined } | { ok: false; response: Response };

const denied = (status: 400 | 403 | 404, error: string): KeywordRouteGate => ({
  ok: false,
  response: Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } }),
});

/**
 * The one place gate of POST /api/keyword/{insight,related,search} (U10-N12, verification D1 /
 * D3). Every route calls it right after the session check and BEFORE its source switch, so it
 * holds on both HGH_SOURCE_G6 sources and before any backend, DataForSEO or LLM call:
 *   body projectId present and not a uuid              -> 400 invalid projectId
 *   no projectId (the standard keyword screen)          -> its ROUTES rule, else 403
 *   projectId (a project intent page)                   -> projectRouteGate: role / menu 403,
 *     demo non-admin 404, then HGH_SOURCE_SESSION=api GET /v1/projects/{id} (backend 404 -> 404,
 *     other errors mapped by hghErrorResponse, e.g. 403) or the injected legacy leaf gate (404).
 */
export async function keywordRouteGate(
  user: GateUser,
  rawProjectId: unknown,
  legacyProjectAllowed: LegacyProjectAllowed,
): Promise<KeywordRouteGate> {
  if (rawProjectId !== undefined && rawProjectId !== null && rawProjectId !== "" && !isUuid(rawProjectId)) {
    return denied(400, "invalid projectId");
  }
  const projectId = isUuid(rawProjectId) ? rawProjectId : undefined;
  if (projectId === undefined) {
    return standardKeywordRouteAllowed(user) ? { ok: true, projectId } : denied(403, "forbidden");
  }
  try {
    const gate = await projectRouteGate(user, projectId, () => legacyProjectAllowed(projectId, user));
    if (gate.ok) return { ok: true, projectId };
    return denied(gate.status, gate.status === 403 ? "forbidden" : "not found");
  } catch (e) {
    return { ok: false, response: hghErrorResponse(e) };
  }
}

/** The context-map routes' place gate on both sources (U10-N12, D3): null = allowed. */
export function contextMapRouteDenied(user: GateUser): Response | null {
  return contextMapRouteAllowed(user)
    ? null
    : Response.json({ error: "forbidden" }, { status: 403, headers: { "Cache-Control": "no-store" } });
}

// ── keyword conversions (legacy lib/keyword/insight.ts shapes) ──────────────

const INTENTS: ReadonlySet<string> = new Set(["informational", "navigational", "transactional", "commercial"]);

/** Legacy normalizeIntent: unknown or missing -> "informational". */
export function toIntent(raw: string | null | undefined): SearchIntent {
  return raw && INTENTS.has(raw) ? (raw as SearchIntent) : "informational";
}

/** "2025-10-01" -> "25.10" (legacy buildMonthlyTrend: 2-digit year, month without leading zero). */
export function trendWeekLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month);
  if (!m) return month;
  return `${m[1].slice(2)}.${Number(m[2])}`;
}

/** Legacy SERP url: scheme stripped for display. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/**
 * Insight -> KeywordInsight. `drafts` (rank -> prompt) fills rows whose stored draft is missing
 * (just generated); a row with neither shows the keyword (U10-N2, legacy LLM-failure fallback).
 */
export function toKeywordInsight(d: ApiInsight, drafts: ReadonlyMap<number, string> = new Map()): KeywordInsight {
  const trend: TrendPoint[] = d.trend.map((p) => ({ week: trendWeekLabel(p.month), primary: p.search_volume ?? 0 }));
  const serp: SerpRow[] = d.serp.map((r, i) => ({
    id: `serp-${i}-${r.rank}`,
    rank: r.rank,
    url: displayUrl(r.url),
    title: r.title ?? "",
    snippet: r.snippet ?? "",
    suggestedPrompt: drafts.get(r.rank) ?? r.suggested_prompt ?? d.term,
  }));
  return { label: d.term, trend, serp };
}

/** Related items, legacy order (search volume desc, stable), ids rel-<i> after ordering. */
export function toRelatedItems(items: readonly ApiRelatedItem[]): RelatedItem[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (b.it.search_volume ?? 0) - (a.it.search_volume ?? 0) || a.i - b.i)
    .map(({ it }, i) => ({ id: `rel-${i}`, term: it.term, volume: it.search_volume ?? 0, intent: toIntent(it.intent) }));
}

export function toRelatedBundle(d: ApiRelated): { foundCount: number; items: RelatedItem[] } {
  const items = toRelatedItems(d.items);
  return { foundCount: d.total_count ?? items.length, items };
}

export function toSearchGroup(r: ApiLookupRow): KeywordSearchGroup {
  const related = toRelatedItems(r.related);
  return {
    term: r.term,
    volume: r.search_volume ?? 0,
    intent: toIntent(r.intent),
    foundCount: r.total_count ?? related.length,
    related,
  };
}

// ── collection (D12) ─────────────────────────────────────────────────────────

export const COLLECT_POLL_MS = 1_500;
/** Longest wait for one collection (the routes set maxDuration 120 s: this + drafts + reads). */
export const COLLECT_BUDGET_MS = 40_000;
/** Backend limit of terms per lookup / fetch request (FetchIn.MAX_TERMS, lookup max_length). */
export const MAX_TERMS_PER_CALL = 20;
/**
 * Most unique terms one /api/keyword/search request may ask for (verification D2, both sources):
 * two lookup / fetch chunks, so reads + one shared collection budget + the re-read fit in the
 * route's maxDuration. Above it the route answers 400.
 */
export const MAX_SEARCH_TERMS = 40;

export interface CollectOptions {
  pollMs?: number;
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type CollectOutcome = "fresh" | "applied" | "forbidden" | "failed" | "timeout";

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Requested = Exclude<CollectOutcome, "applied" | "failed" | "timeout"> | { changeId: number };

/** POST /v1/intent/fetches. 403 (not an operator of this project / country) -> "forbidden". */
async function requestCollect(
  kind: "insight" | "related" | "search",
  terms: string[],
  country: string,
  projectId: string | undefined,
  force: boolean,
): Promise<Requested> {
  let accepted;
  try {
    accepted = await hghPost("/v1/intent/fetches", {
      body: { kind, terms, country, project_id: projectId ?? null, force },
      retryOn401: true,
    });
  } catch (e) {
    if (isHghApiError(e) && e.status === 403) return "forbidden";
    throw e;
  }
  const a = accepted.data;
  if (a.status === "fresh" || a.change_id === null) return "fresh";
  return { changeId: a.change_id };
}

/**
 * Poll every requested change together until each is applied / failed or the ONE shared
 * `deadline` passes (verification D2: the chunks of one search never wait a budget each).
 */
async function pollCollects(requested: readonly Requested[], deadline: number, opts: CollectOptions): Promise<CollectOutcome[]> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? COLLECT_POLL_MS;
  const out: (CollectOutcome | null)[] = requested.map((r) => (typeof r === "string" ? r : null));
  while (out.some((o) => o === null)) {
    await sleep(pollMs);
    for (let i = 0; i < requested.length; i += 1) {
      const r = requested[i];
      if (out[i] !== null || typeof r === "string") continue;
      const st = await hghGet("/v1/intent/fetches/{change_id}", { pathParams: { change_id: r.changeId }, dedupe: false });
      if (st.data.status === "applied") out[i] = "applied";
      else if (st.data.status === "failed" || st.data.status === "escalated_rebuild") out[i] = "failed";
    }
    if (now() >= deadline) return out.map((o) => o ?? "timeout");
  }
  return out as CollectOutcome[];
}

/**
 * POST /v1/intent/fetches, then poll the change until applied / failed or the budget is spent.
 * 403 (not an operator of this project / country) -> "forbidden": the caller shows stored data.
 */
export async function collect(
  kind: "insight" | "related" | "search",
  terms: string[],
  country: string,
  projectId: string | undefined,
  force: boolean,
  opts: CollectOptions = {},
): Promise<CollectOutcome> {
  const now = opts.now ?? Date.now;
  const requested = await requestCollect(kind, terms, country, projectId, force);
  if (typeof requested === "string") return requested;
  const [outcome] = await pollCollects([requested], now() + (opts.budgetMs ?? COLLECT_BUDGET_MS), opts);
  return outcome;
}

function freshnessOf(meta: ApiMeta): string | null {
  const f = (meta.source as { freshness?: unknown } | null | undefined)?.freshness;
  return typeof f === "string" ? f : null;
}

/** 502 for a collection that did not produce data (U10-N1). */
function collectError(outcome: CollectOutcome): HghApiError {
  return new HghApiError(502, "upstream", `keyword collection ${outcome}`);
}

/** Legacy country rule: unknown or missing -> "kr". */
export function keywordPreset(country: unknown): LocationLanguagePreset {
  return getPresetById(String(country ?? "kr").toLowerCase()) ?? getPresetById("kr")!;
}

/** The keyword routes' maxDuration (app/api/keyword/{insight,related,search}/route.ts: 120 s). */
export const KEYWORD_ROUTE_MAX_DURATION_MS = 120_000;
/**
 * Left free under the route's maxDuration when the SERP drafts call is sized: the JSON response
 * after the call, the platform's own time before the handler's first line (cold start, not in
 * `startedAt`), and the abort itself (the client stops the body read on the same signal). 10 s
 * is well above what these take (the response is one small JSON body). Worst case before the
 * call (session and gate reads, insight read 10 s, fetch request 15 s, polling to the 40 s budget
 * plus one 1.5 s sleep and one 10 s read past it, re-read 10 s: about 97 s with a 10 s gate) the
 * drafts still get about 13 s; below SERP_DRAFT_MIN_MS they are skipped.
 */
export const SERP_DRAFT_MARGIN_MS = 10_000;
/** Below this the drafts call is not sent: the backend would start (and bill) an LLM call the BFF drops. */
export const SERP_DRAFT_MIN_MS = 5_000;

/**
 * Timeout of POST /v1/intent/serp-drafts after `elapsedMs` of the route (U10 N2): min(external
 * 70 s, maxDuration - elapsed - margin). null = no budget left: the drafts are skipped and the
 * rows show the stored copy or the keyword (U10-N2 fallback).
 */
export function serpDraftTimeoutMs(elapsedMs: number): number | null {
  const rest = KEYWORD_ROUTE_MAX_DURATION_MS - elapsedMs - SERP_DRAFT_MARGIN_MS;
  if (rest < SERP_DRAFT_MIN_MS) return null;
  return Math.min(HGH_TIMEOUTS.external, rest);
}

export interface InsightOptions extends CollectOptions {
  /** When the route started (Date.now() at its first line); default: the start of this call. */
  startedAt?: number;
}

export interface KeywordRequest {
  term: string;
  country: LocationLanguagePreset;
  /** Project screen: the project id (C1); the standard screen sends none. */
  projectId?: string;
}

export async function loadKeywordInsight(
  req: KeywordRequest & { fresh?: boolean },
  opts: InsightOptions = {},
): Promise<KeywordInsight> {
  const now = opts.now ?? Date.now;
  const startedAt = opts.startedAt ?? now();
  const query = { term: req.term, country: req.country.id, project_id: req.projectId ?? null, limit: 8 };
  let res = await hghGet("/v1/intent/insight", { query, dedupe: false });
  const before = res.data.serp_call_id;
  const stale = freshnessOf(res.meta) !== "fresh";
  if (stale || req.fresh) {
    const outcome = await collect("insight", [req.term], req.country.id, req.projectId, Boolean(req.fresh), opts);
    if (outcome === "applied" || outcome === "fresh") {
      res = await hghGet("/v1/intent/insight", { query, dedupe: false });
    } else if (outcome !== "forbidden" && freshnessOf(res.meta) === "missing") {
      throw collectError(outcome);
    }
  }
  const d = res.data;
  const drafts = new Map<number, string>();
  if (d.serp_call_id !== null && d.serp.length > 0) {
    // After "재생성" on an unchanged SERP call the rows are regenerated; otherwise only the
    // rows without a draft are drafted (backend default: missing ones among the top 8).
    const regenerate = Boolean(req.fresh) && d.serp_call_id === before;
    const missing = d.serp.some((r) => r.suggested_prompt === null);
    // The call gets what is left of the route's maxDuration (U10 N2); none left -> no call, the
    // stored copy (or the keyword) is shown as below.
    const timeoutMs = missing || regenerate ? serpDraftTimeoutMs(now() - startedAt) : null;
    if (timeoutMs !== null) {
      try {
        const r = await hghPost("/v1/intent/serp-drafts", {
          body: {
            project_id: req.projectId ?? null,
            serp_call_id: d.serp_call_id,
            ranks: regenerate ? d.serp.map((x) => x.rank) : null,
          },
          timeoutMs,
          // D-7: the backend bounds the LLM call (retry included) to what the BFF waits here.
          header: { "X-HGH-Timeout-Ms": timeoutMs },
          retryOn401: true,
        });
        for (const x of r.data.drafts) drafts.set(x.rank, x.prompt);
      } catch (e) {
        // Not an operator (403), the SERP call gone (404), a concurrent draft (409) or the LLM
        // failed (5xx, timeout): the stored copy (or the keyword) is shown (U10-N2). Session and
        // request errors (401, 400, 422) are not hidden.
        if (!isHghApiError(e) || e.status === 401 || e.status === 400 || e.status === 422) throw e;
      }
    }
  }
  return toKeywordInsight(d, drafts);
}

export async function loadRelatedKeywords(
  req: KeywordRequest,
  opts: CollectOptions = {},
): Promise<{ foundCount: number; items: RelatedItem[] }> {
  const query = { term: req.term, country: req.country.id, project_id: req.projectId ?? null };
  let res = await hghGet("/v1/intent/related", { query, dedupe: false });
  if (freshnessOf(res.meta) !== "fresh") {
    const outcome = await collect("related", [req.term], req.country.id, req.projectId, false, opts);
    if (outcome === "applied" || outcome === "fresh") {
      res = await hghGet("/v1/intent/related", { query, dedupe: false });
    } else if (outcome !== "forbidden" && freshnessOf(res.meta) === "missing") {
      throw collectError(outcome);
    }
  }
  return toRelatedBundle(res.data);
}

function chunk<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function lookupOnce(terms: string[], req: Omit<KeywordRequest, "term">): Promise<{ rows: ApiLookupRow[]; needs: boolean }> {
  const rows: ApiLookupRow[] = [];
  let needs = false;
  for (const part of chunk(terms, MAX_TERMS_PER_CALL)) {
    const res = await hghGet("/v1/intent/lookup", {
      query: { terms: part, country: req.country.id, project_id: req.projectId ?? null },
      dedupe: false,
    });
    rows.push(...res.data.items);
    if (freshnessOf(res.meta) !== "fresh" || res.data.items.some((r) => r.status === "missing")) needs = true;
  }
  return { rows, needs };
}

/** Unique trimmed search terms, in input order (legacy getKeywordSearchGroups rule). */
export function uniqueSearchTerms(terms: readonly string[]): string[] {
  return [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
}

/**
 * Legacy getKeywordSearchGroups: unique trimmed terms, one group each, in input order. At most
 * MAX_SEARCH_TERMS unique terms (400 too_many_terms, verification D2). The collections of all
 * chunks are requested first and then polled together under ONE COLLECT_BUDGET_MS deadline, so
 * the call stays inside the route's maxDuration whatever the chunk count.
 */
export async function loadKeywordSearchGroups(
  terms: string[],
  req: Omit<KeywordRequest, "term">,
  opts: CollectOptions = {},
): Promise<KeywordSearchGroup[]> {
  const unique = uniqueSearchTerms(terms);
  if (unique.length > MAX_SEARCH_TERMS) {
    throw new HghApiError(400, "too_many_terms", `at most ${MAX_SEARCH_TERMS} keywords per search`);
  }
  const first = await lookupOnce(unique, req);
  let rows = first.rows;
  if (first.needs) {
    const now = opts.now ?? Date.now;
    const deadline = now() + (opts.budgetMs ?? COLLECT_BUDGET_MS);
    const requested: Requested[] = [];
    for (const part of chunk(unique, MAX_TERMS_PER_CALL)) {
      requested.push(await requestCollect("search", part, req.country.id, req.projectId, false));
    }
    const outcomes = await pollCollects(requested, deadline, opts);
    const collected = outcomes.some((o) => o === "applied" || o === "fresh");
    if (collected) rows = (await lookupOnce(unique, req)).rows;
    else if (outcomes.some((o) => o !== "forbidden") && rows.every((r) => r.status === "missing")) {
      throw collectError(outcomes.find((o) => o !== "forbidden")!);
    }
  }
  // A term still missing after collection keeps the legacy "no result" shape (volume 0, no related).
  return rows.map(toSearchGroup);
}

// ── tracked keyword tabs ────────────────────────────────────────────────────

export interface KeywordTab {
  id: string;
  label: string;
}

/** Project tracked keywords -> GoogleKeywordView initialKeywords (created order, as legacy). */
export async function listTrackedKeywordTabs(projectId: string): Promise<KeywordTab[]> {
  const res = await hghGet("/v1/intent/keywords", { query: { project_id: projectId } });
  return res.data.items.map((k) => ({ id: k.keyword_id, label: k.term }));
}

/**
 * Most standard keyword pages read (500 per page, backend maximum). The tabs are the whole
 * managed list, so a longer list fails the page (fetchAllPages throws) instead of dropping
 * tabs: the old 4-page cap returned the first 2,000 as if they were all of them.
 */
export const STANDARD_KEYWORD_MAX_PAGES = MAX_PAGES_CEILING;

/** Standard screen tabs (BG-41, U10-N10): managed keywords, newest first, tab id = keyword_id. */
export async function listStandardKeywordTabs(): Promise<KeywordTab[]> {
  const all = await fetchAllPages<KeywordTab>(
    async (cursor) => {
      const res = await hghGet("/v1/intent/standard-keywords", {
        query: { source_type: "google_keyword", cursor, limit: 500 },
      });
      return {
        items: res.data.items.map((k) => ({ id: k.keyword_id, label: k.term })),
        nextCursor: pageInfo(res.meta).nextCursor,
        total: pageInfo(res.meta).total,
      };
    },
    { maxPages: STANDARD_KEYWORD_MAX_PAGES },
  );
  return all.items;
}

// ── context map conversions ─────────────────────────────────────────────────

/** Legacy sentimentPerspective: Math.round(part / total * 100), empty -> neutral 100. */
export function toPerspective(s: ApiSentiment): PerspectiveBreakdown {
  const den = s.positive.den;
  if (!den) return { buyer: 0, seller: 0, neutral: 100 };
  const pct = (num: number) => Math.round((num / den) * 100);
  return { buyer: pct(s.positive.num), seller: pct(s.negative.num), neutral: pct(s.neutral.num) };
}

export function toContextRow(r: ApiContextRow): ContextListRow {
  return {
    id: r.id,
    name: r.name,
    themeId: r.theme_id,
    themeName: r.theme_name,
    mentionCount: r.mention_count,
    perspective: toPerspective(r.sentiment),
    linkedCount: r.linked_count,
  };
}

export function toConditionRow(r: ApiConditionRow): ConditionListRow {
  return {
    id: r.id,
    name: r.name,
    categoryId: r.category,
    mentionCount: r.mention_count,
    perspective: toPerspective(r.sentiment),
    linkedCount: r.linked_count,
  };
}

export function toCombinationRow(r: ApiCombinationRow): CombinationListRow {
  return {
    id: r.id,
    condAId: r.cond_a_id,
    condAName: r.cond_a_name,
    condBId: r.cond_b_id,
    condBName: r.cond_b_name,
    coOccurrenceCount: r.co_count,
    frequency: r.frequency,
  };
}

export function toEntityDetail(d: ApiEntityDetail): ContextEntityDetail {
  return {
    id: d.id,
    name: d.name,
    mentionCount: d.mention_count,
    perspective: toPerspective(d.sentiment),
    evidenceQuotes: d.evidence.map((e) => ({
      quote: e.quote,
      sourceTitle: e.source_host ?? "",
      sourceUrl: e.source_url ?? "",
      perspective: e.sentiment === "positive" ? "buyer" : e.sentiment === "negative" ? "seller" : "neutral",
    })),
    sourceDomains: Object.fromEntries(d.source_domains.map((x) => [x.host, x.count])),
    linked: d.linked.map((l) => ({ id: l.id, name: l.name, strength: l.strength })),
  };
}

/** No active snapshot (data null) -> zeros (U10-N8, gap G13). */
export function toStats(d: ApiStats | null | undefined): ContextMapStats {
  return {
    contexts: d?.contexts ?? 0,
    conditions: d?.conditions ?? 0,
    relationships: d?.relationships ?? 0,
    drives: d?.drives ?? 0,
    combinations: d?.combinations ?? 0,
    sources: d?.sources ?? 0,
  };
}

export type ContextMapTab = "contexts" | "conditions" | "combinations";

export interface ContextMapPageQuery {
  search?: string;
  sort: "name" | "mentions" | "cooccurrence";
  dir: ContextSortDir;
  /** 0-based page number the client shows. */
  page: number;
  size: number;
  /** Keyset cursor of that page (meta.page.next_cursor of the previous one). */
  cursor?: string | null;
}

/** Legacy clampPaging size rule (1..200, default 50) and the backend search limits (U10-N7). */
export function normalizeContextMapQuery(q: ContextMapPageQuery): ContextMapPageQuery {
  const size = Math.min(Math.max(Math.trunc(q.size) || 50, 1), 200);
  const page = Math.max(Math.trunc(q.page) || 0, 0);
  const search = (q.search ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100) || undefined;
  return { ...q, size, page, search };
}

type RowOf<T extends ContextMapTab> = T extends "contexts"
  ? ContextListRow
  : T extends "conditions"
    ? ConditionListRow
    : CombinationListRow;

async function contextMapCursorPage<T extends ContextMapTab>(
  tab: T,
  q: ContextMapPageQuery,
  cursor: string | null,
): Promise<CursorPage<RowOf<T>> & { limit: number | null }> {
  const common = { search: q.search ?? null, dir: q.dir, cursor, limit: q.size };
  const sort = q.sort === "name" ? "name" : "mentions";
  if (tab === "combinations") {
    const res = await hghGet("/v1/intent/social/context-map/combinations", { query: common });
    const p = pageInfo(res.meta);
    return { items: res.data.items.map(toCombinationRow) as RowOf<T>[], nextCursor: p.nextCursor, total: p.total, limit: p.limit };
  }
  if (tab === "contexts") {
    const res = await hghGet("/v1/intent/social/context-map/contexts", { query: { ...common, sort } });
    const p = pageInfo(res.meta);
    return { items: res.data.items.map(toContextRow) as RowOf<T>[], nextCursor: p.nextCursor, total: p.total, limit: p.limit };
  }
  const res = await hghGet("/v1/intent/social/context-map/conditions", { query: { ...common, sort } });
  const p = pageInfo(res.meta);
  return { items: res.data.items.map(toConditionRow) as RowOf<T>[], nextCursor: p.nextCursor, total: p.total, limit: p.limit };
}

/**
 * One context-map page in the legacy Paged shape plus nextCursor (C3). A page > 0 without a
 * cursor, or a 409 cursor_stale, answers the first page with page 0 (the hook follows).
 */
export async function fetchContextMapPage<T extends ContextMapTab>(tab: T, raw: ContextMapPageQuery): Promise<Paged<RowOf<T>>> {
  const q = normalizeContextMapQuery(raw);
  const cursor = q.page > 0 && q.cursor ? q.cursor : null;
  let limit: number | null = null;
  const got = await fetchPageOrRestart<RowOf<T>>(async (c) => {
    const r = await contextMapCursorPage(tab, q, c);
    limit = r.limit;
    return r;
  }, cursor);
  const page = cursor === null || got.restarted ? 0 : q.page;
  return {
    rows: got.items,
    total: got.total ?? got.items.length,
    page,
    size: limit ?? q.size,
    nextCursor: got.nextCursor,
  };
}

export async function fetchContextMapStats(): Promise<ContextMapStats> {
  const res = await hghGet("/v1/intent/social/context-map/stats");
  return toStats(res.data);
}

/** Entity detail; null when the backend answers 404 (unknown id or no active snapshot). */
export async function fetchContextEntityDetail(id: string): Promise<ContextEntityDetail | null> {
  if (!isUuid(id)) return null;
  try {
    const res = await hghGet("/v1/intent/social/context-map/entities/{entity_id}", { pathParams: { entity_id: id } });
    return toEntityDetail(res.data);
  } catch (e) {
    if (isHghApiError(e) && e.status === 404) return null;
    throw e;
  }
}

export type ExportLang = "ko" | "en";

export function exportLang(bodyLang: unknown, cookieLocale: string | undefined): ExportLang {
  if (bodyLang === "ko" || bodyLang === "en") return bodyLang;
  return cookieLocale === "en" ? "en" : "ko";
}

/** Stream the backend xlsx (U10-N9). Non-2xx throws HghApiError. */
export function relayContextMapExport(lang: ExportLang): Promise<Response> {
  return relayDownload("/v1/intent/social/context-map/export", {
    query: { lang },
    accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

// ── social prompts ──────────────────────────────────────────────────────────

const LAYERS: ReadonlySet<string> = new Set(["L1-context", "L2-condition", "L3-intersection"]);
const FUNNELS: ReadonlySet<string> = new Set(["awareness", "consideration", "purchase"]);

export function toGeneratedPrompt(p: ApiGeneratedPrompt): GeneratedPrompt {
  const out: GeneratedPrompt = {
    id: p.prompt_id,
    question: p.question,
    layer: (p.layer && LAYERS.has(p.layer) ? p.layer : "L1-context") as PromptLayer,
    funnelStage: (p.funnel_stage && FUNNELS.has(p.funnel_stage) ? p.funnel_stage : "consideration") as FunnelStage,
    sourceLabel: p.source_label ?? "",
    priority: p.priority ?? 0,
  };
  // Legacy annotateSimilar leaves the field out when nothing clears the threshold.
  if (p.similar_to) out.similarTo = { text: p.similar_to.text, score: p.similar_to.score, kind: p.similar_to.kind };
  if (p.origin === "composed") out.origin = "composed";
  if (p.in_candidate_pool) out.inCandidatePool = true;
  return out;
}

export interface SocialScrapingPageData {
  stats: ContextMapStats;
  initialPages: {
    contexts: Paged<ContextListRow>;
    conditions: Paged<ConditionListRow>;
    combinations: Paged<CombinationListRow>;
  };
  /** "이미 추가됨" travels on each prompt (inCandidatePool), not as a copy of the whole candidate pool. */
  generatedPrompts: GeneratedPrompt[] | undefined;
}

/**
 * The social-scraping page's first render (D6 (b)): the four context-map reads the screen
 * cannot draw without, then the project's generated prompts. The backend marks the rows
 * already in the candidate pool, so the page no longer pages through the pool (it read at
 * most 20 x 500 texts and silently missed the rest).
 */
export async function loadSocialScrapingPage(projectId: string, pageSize = 50): Promise<SocialScrapingPageData> {
  const first = { dir: "desc" as const, page: 0, size: pageSize };
  const [stats, contexts, conditions, combinations] = await Promise.all([
    fetchContextMapStats(),
    fetchContextMapPage("contexts", { ...first, sort: "mentions" }),
    fetchContextMapPage("conditions", { ...first, sort: "mentions" }),
    fetchContextMapPage("combinations", { ...first, sort: "cooccurrence" }),
  ]);
  const prompts = await hghGet("/v1/intent/social/prompts", { query: { project_id: projectId } });
  const generated = prompts.data.items.map(toGeneratedPrompt);
  return {
    stats,
    initialPages: { contexts, conditions, combinations },
    generatedPrompts: generated.length > 0 ? generated : undefined,
  };
}

// ── server action bodies (intent/_actions.ts api branch) ────────────────────

export type IntentActionResult<T = void> = { ok: true; value: T } | { ok: false; error: string };

export const INTENT_ACTION_ERROR_KEYS = [
  "emptyPrompt",
  "invalidSource",
  "nothingToSend",
  "generateFailed",
  "noSelection",
  "tooManySelected",
  "nothingToRemove",
  "promptNotFound",
  "emptyKeyword",
  "duplicateKeyword",
  "keywordNotFound",
  "noKeywordsToRemove",
  "unknownCountry",
  "contextMapNotReady",
  "conflict",
  "tryAgain",
] as const;
export type IntentActionErrorKey = (typeof INTENT_ACTION_ERROR_KEYS)[number];
export type IntentMessages = (key: IntentActionErrorKey) => string;

/** Action error texts (messages/units/u10: projectDetail.intent.actionErrors, U10-N11). */
export async function intentActionMessages(): Promise<IntentMessages> {
  const t = await getTranslations("projectDetail.intent.actionErrors");
  return (key) => t(key);
}

/**
 * Backend failure -> the legacy action outcome. Permission (401, 403) and hidden project (404)
 * throw UnauthorizedError like legacy requireOperate; the rest become ok:false with a text.
 */
function actionFailure(
  e: unknown,
  msg: IntentMessages,
  map: Partial<Record<number | string, IntentActionErrorKey>> = {},
  transient: IntentActionErrorKey = "tryAgain",
): { ok: false; error: string } {
  if (!isHghApiError(e)) throw e;
  if (e.status === 401 || e.status === 403 || e.status === 404) {
    throw new UnauthorizedError(e.status === 404 ? "project not found" : "intent collection requires operator authority");
  }
  const byCode = map[e.code];
  if (byCode) return { ok: false, error: msg(byCode) };
  const byStatus = map[e.status];
  if (byStatus) return { ok: false, error: msg(byStatus) };
  const kind = errorKindOf(e.status, e.code);
  if (kind === "conflict" || kind === "cursorStale") return { ok: false, error: msg("conflict") };
  if (kind === "timeout" || kind === "unavailable" || kind === "rateLimited" || kind === "internal") {
    return { ok: false, error: msg(transient) };
  }
  return { ok: false, error: msg("tryAgain") };
}

const INTENT_SOURCES: ReadonlySet<string> = new Set(["google_keyword", "social_scraping"]);
export const MAX_CANDIDATES_PER_CALL = 200;
export const MAX_IDS_PER_DELETE = 100;
export const MAX_SELECTION_PER_KIND = 50;

export async function apiAddCandidate(
  projectId: string,
  source: PromptSource,
  text: string,
  sourceKeyword: string | null,
  msg: IntentMessages,
): Promise<IntentActionResult<{ id: string }>> {
  if (!INTENT_SOURCES.has(source)) return { ok: false, error: msg("invalidSource") };
  try {
    const res = await hghPost("/v1/intent/candidates", {
      query: { project_id: projectId },
      body: { source: source as "google_keyword" | "social_scraping", items: [{ text, source_keyword: sourceKeyword }] },
      retryOn401: true,
    });
    return { ok: true, value: { id: res.data.candidate_ids[0] ?? "" } };
  } catch (e) {
    return actionFailure(e, msg, { 422: "emptyPrompt" });
  }
}

export async function apiAddCandidates(
  projectId: string,
  source: PromptSource,
  items: Array<{ text: string; sourceKeyword?: string | null }>,
  msg: IntentMessages,
): Promise<IntentActionResult<{ count: number; skipped: number }>> {
  if (!INTENT_SOURCES.has(source)) return { ok: false, error: msg("invalidSource") };
  const all = items.map((it) => ({ text: it.text, source_keyword: it.sourceKeyword ?? null }));
  const nonBlank = all.filter((it) => it.text.trim().length > 0);
  // Nothing to send: still ask the backend (at most one chunk) so a caller without operator
  // authority gets the legacy throw before the "nothing to send" answer.
  const send = nonBlank.length > 0 ? nonBlank : all.slice(0, MAX_CANDIDATES_PER_CALL);
  if (send.length === 0) return { ok: false, error: msg("nothingToSend") };
  let added = 0;
  try {
    for (const part of chunk(send, MAX_CANDIDATES_PER_CALL)) {
      const res = await hghPost("/v1/intent/candidates", {
        query: { project_id: projectId },
        body: { source: source as "google_keyword" | "social_scraping", items: part },
        retryOn401: true,
      });
      added += res.data.added_count;
    }
  } catch (e) {
    return actionFailure(e, msg, { 422: "nothingToSend" });
  }
  // Legacy skipped = non-blank rows not inserted (blank rows are not counted).
  return { ok: true, value: { count: added, skipped: nonBlank.length - added } };
}

/**
 * Social prompt generation waits on the LLM (legacy page maxDuration 120). Sent as X-HGH-Timeout-Ms
 * too (D-7): the backend bounds the LLM call, retry included, to this wait.
 */
export const SOCIAL_GENERATE_TIMEOUT_MS = 110_000;

export async function apiGenerateMoreSocialPrompts(
  projectId: string,
  msg: IntentMessages,
): Promise<IntentActionResult<{ prompts: GeneratedPrompt[]; exhausted: boolean }>> {
  try {
    const res = await hghPost("/v1/intent/social/prompts", {
      query: { project_id: projectId },
      body: { mode: "more" },
      timeoutMs: SOCIAL_GENERATE_TIMEOUT_MS,
      header: { "X-HGH-Timeout-Ms": SOCIAL_GENERATE_TIMEOUT_MS },
      retryOn401: true,
    });
    return { ok: true, value: { prompts: res.data.prompts.map(toGeneratedPrompt), exhausted: res.data.exhausted } };
  } catch (e) {
    return actionFailure(e, msg, { no_active_snapshot: "contextMapNotReady" }, "generateFailed");
  }
}

export async function apiGenerateSelectedSocialPrompts(
  projectId: string,
  selection: {
    contextIds: string[];
    conditionIds: string[];
    combinations: Array<{ condAId: string; condBId: string }>;
    cross: boolean;
  },
  msg: IntentMessages,
): Promise<IntentActionResult<{ prompts: GeneratedPrompt[]; skippedExisting: number }>> {
  const contextIds = [...new Set(selection.contextIds)];
  const conditionIds = [...new Set(selection.conditionIds)];
  if (
    contextIds.length > MAX_SELECTION_PER_KIND ||
    conditionIds.length > MAX_SELECTION_PER_KIND ||
    selection.combinations.length > MAX_SELECTION_PER_KIND
  ) {
    return { ok: false, error: msg("tooManySelected") };
  }
  try {
    const res = await hghPost("/v1/intent/social/prompts", {
      query: { project_id: projectId },
      body: {
        mode: "selected",
        selection: {
          context_ids: contextIds,
          condition_ids: conditionIds,
          combinations: selection.combinations.map((c) => ({ cond_a_id: c.condAId, cond_b_id: c.condBId })),
          cross: selection.cross,
        },
      },
      timeoutMs: SOCIAL_GENERATE_TIMEOUT_MS,
      header: { "X-HGH-Timeout-Ms": SOCIAL_GENERATE_TIMEOUT_MS },
      retryOn401: true,
    });
    return {
      ok: true,
      value: { prompts: res.data.prompts.map(toGeneratedPrompt), skippedExisting: res.data.skipped_existing },
    };
  } catch (e) {
    return actionFailure(e, msg, { no_active_snapshot: "contextMapNotReady", 422: "noSelection" }, "generateFailed");
  }
}

export async function apiRemoveSocialPrompts(
  projectId: string,
  promptIds: string[],
  msg: IntentMessages,
): Promise<IntentActionResult<{ count: number }>> {
  const ids = [...new Set(promptIds)];
  if (ids.length === 0) return { ok: false, error: msg("nothingToRemove") };
  let count = 0;
  try {
    for (const part of chunk(ids, MAX_IDS_PER_DELETE)) {
      const res = await hghDelete("/v1/intent/social/prompts", {
        query: { project_id: projectId, ids: part },
        retryOn401: true,
      });
      count += res.data.removed_count;
    }
  } catch (e) {
    return actionFailure(e, msg, { 422: "nothingToRemove" });
  }
  if (count === 0) return { ok: false, error: msg("promptNotFound") };
  return { ok: true, value: { count } };
}

export async function apiAddTrackedKeyword(
  projectId: string,
  input: { term: string; country?: string | null },
  msg: IntentMessages,
): Promise<IntentActionResult<{ id: string }>> {
  const term = input.term.trim();
  if (!term) return { ok: false, error: msg("emptyKeyword") };
  try {
    const res = await hghPost("/v1/intent/keywords", {
      query: { project_id: projectId },
      body: { term, country: input.country?.trim() || null },
      retryOn401: true,
    });
    return { ok: true, value: { id: res.data.keyword_id } };
  } catch (e) {
    return actionFailure(e, msg, { duplicate_keyword: "duplicateKeyword", unknown_country: "unknownCountry", 422: "emptyKeyword" });
  }
}

async function deleteKeywords(projectId: string, ids: string[]): Promise<number> {
  let count = 0;
  for (const part of chunk(ids, MAX_IDS_PER_DELETE)) {
    const res = await hghDelete("/v1/intent/keywords", { query: { project_id: projectId, ids: part }, retryOn401: true });
    count += res.data.removed_count;
  }
  return count;
}

export async function apiRemoveTrackedKeyword(
  projectId: string,
  id: string,
  msg: IntentMessages,
): Promise<IntentActionResult<void>> {
  let count: number;
  try {
    count = await deleteKeywords(projectId, [id]);
  } catch (e) {
    return actionFailure(e, msg, { 422: "keywordNotFound" });
  }
  if (count === 0) return { ok: false, error: msg("keywordNotFound") };
  return { ok: true, value: undefined };
}

export async function apiRemoveTrackedKeywords(
  projectId: string,
  ids: string[],
  msg: IntentMessages,
): Promise<IntentActionResult<{ count: number }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { ok: false, error: msg("noKeywordsToRemove") };
  let count: number;
  try {
    count = await deleteKeywords(projectId, unique);
  } catch (e) {
    return actionFailure(e, msg, { 422: "keywordNotFound" });
  }
  if (count === 0) return { ok: false, error: msg("keywordNotFound") };
  return { ok: true, value: { count } };
}
