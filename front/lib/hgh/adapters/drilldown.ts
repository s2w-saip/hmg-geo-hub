import "server-only";

// Drilldown adapter (unit U6): the mention drilldown BFF routes (/api/scope/brand-mention-prompts,
// /signal-prompts, /brand-citations) and their shared route gate. The routes keep their paths and
// JSON shapes ({prompts}, {domains}); only the inside switches to the backend. Design 3.3 "공용
// 드릴다운" row, appendix B 공통 규칙 3·4 and the "공용: 답변 드릴다운·모달" table, 3.5 #4·#5,
// BG-17, BG-18, BG-23..25.
//
//   legacy (lib/scope/server.ts)                           api (this module)
//   fetchStandard/WebsiteBrandMentionPrompts SRV:3876/5002  loadBrandMentionPrompts  M-3 mode=brand
//   (project drilldown: eager perBrandPrompts)             loadBrandMentionPrompts  surface=project
//   fetchStandard/Website/ProjectSignalPrompts SRV:3923..  loadSignalPrompts        M-3 mode=signal
//   fetchBrandCitations / fetchWebsiteBrandCitations       loadBrandCitationDomains C-1 mention_brand
//     (urls, promptList inside each row)                   loadBrandCitationDetail  C-1 /domains/{skey}
// (The unmeasured prompts route /api/scope/unmeasured-prompts and its loader were removed: no screen
// imported its dialog, before or after the switch. GET /v1/kpi/unmeasured-prompts stays in the back.)
//
// Targets of mode=brand (BG-17): a competitor row -> mention_brand=<name>; the own row ->
// own=true, plus own_brand_code=<code> when the row is one brand of a split perspective (D13).
// The brand lists are read in ONE request of DRILLDOWN_LIST_LIMIT rows (the former cap of 10 cursor
// pages x 200; the backend takes limit <= 2000 for these targets): the drilldown table sorts the
// whole list on the client, as the legacy full answer did. When the backend has more rows than
// the cap (meta.page.total), the result carries `total` and the table shows the existing
// "{total}개 중 {shown}개 표시" line; a list that fits carries no `total` (JSON as before).
//
// Row rules (hand-checked in drilldown.test.ts):
//   prompt  id ← prompt_id, promptText ← prompt_text ?? "", mentions ← count, share ← Ratio % (one
//           decimal, den 0 -> 0), funnelStage ← funnel_code, providers ← engine labels (deduped,
//           providerLabel: claude-web and claude-sonnet are both "Claude")
//   answer  jobId, provider ← label, region, mentionCount ← value, position, measuredAt, runs,
//           highlights ← terms (BG-18); signal mode keeps the legacy reference: position null,
//           runs 1, measuredAt null, no highlights (terms are not requested, and lite=true asks the
//           backend not to compute runs / position / measured_at at all)
//   domain  domain ← skey (the legacy group key: registrable domain, an official social account
//           host+path, as citations.ts; the display host would give an account row the same name
//           and React key as the plain row of its host), citations, share, prompts ←
//           citing_prompts (BG-24), coverageRate ← coverage %, isOurs ← is_own, category ← the
//           legacy label of the category slug, skey; urls and promptList are empty until the row
//           opens (citation-domain-table loads the detail)
//   detail  urls ← {url, title ?? display url, count ← citations, aiProvider ← labels joined,
//           promptText ← prompt_text (BG-23), country}; promptList ← prompts with answer refs
//           (position null, runs 1, no highlights, as the legacy citation references);
//           urlTotal / promptTotal ← url_total / prompt_total only when the caps cut the lists
//
// Route errors (공통 규칙 4): 401 -> 401 {error: "unauthorized"} (legacy); 403 place gate -> 403
// with the empty shape; project gate -> 404 with the empty shape; backend 404 brand_not_found /
// unknown skey -> the empty list ("no data"); backend 403 on a brand list or detail -> 403 with
// the empty shape (thrown, not an empty list: the component shows its existing error state);
// 422 -> 400 with the empty shape; 5xx -> the error response. The signal list keeps 404/403 -> [].
//
// Known differences (U6 numbering; asserted in drilldown.test.ts):
//   U6-N9  signal list = the top 50 prompts by signal count with 6 answer references each (the
//          legacy limits); share is over every prompt, not the top 50 (the dialog does not show it)
//   U6-N10 domain detail is capped: 10 URLs (as legacy), 100 prompts and 20 answer references per
//          prompt (legacy: every prompt and every answer); the prompts column keeps the full count
//   U6-N11 the project drilldown's citation tab reads the project (legacy read the standard root:
//          a legacy defect, 3.5 #4)
//   U6-N12 (C-G11, confirmed: no difference) both sides count only the brand's competitive rows:
//          legacy drops a non-competitor rollup name unless the row's own name extends it
//          (isNonCompetitorMention), the backend keeps rd.answer_brand.competitive rows (the same
//          rule, ported). The prompt count sums every such row, products rolled up included, on
//          both sides (PGlite parity: drilldown.parity.test.ts, Toyota and the bare-only "Golf")
//   U6-N14 brand drilldown answer reference value: the brand's total in that answer (brand row plus
//          its rolled-up products, rd.answer_brand.mention_count); legacy took the first mention row
//          of the brand in the answer (the prompt count is the same on both sides, U6-N12)
//   U6-N15 brand drilldown answer reference position: the brand's rank among the answer's
//          competitive brands by their best avg_position (rd.answer_brand.rk); legacy showed the
//          first row's raw avg_position
//   U6-N16 signal list funnel: the catalog funnel (as the brand list and every other screen);
//          legacy read scope_prompts.funnel_stage (the legacy vocabulary, often null)
// U6-N12, N14, N15 and N16 are asserted against the unchanged legacy readers on PGlite in
// drilldown.parity.test.ts.
import type { MenuGroup, Role } from "@/lib/auth/types";
import type {
  CitationDomainLive,
  CitationPromptLive,
  CitationUrlLive,
  MentionAnswerLive,
  MentionsPromptLive,
  StandardFilters,
} from "@/lib/scope/result-adapter";
import { providerLabel } from "@/lib/scope/result-adapter";
import { displayCitationUrl } from "@/lib/url-display";
import { CITATION_CATEGORY_SLUGS } from "@/lib/citation-categorizer/taxonomy";
import { isDemoProject } from "@/lib/demo";
import type { components } from "../api-types";
import { hghGet, hghSource } from "../client";
import { pct1OrZero } from "../convert";
import { errorKindOf, hghErrorResponse, isHghApiError } from "../errors";
import { withParams, type Surface } from "../query";
import { analysisQuery, canReadAnalysis, type AnalysisQueryContext } from "./filters";
import { isProjectId } from "./project-gate";

type S = components["schemas"];
export type ApiPromptItem = S["app__features__analytics__mentions__prompts__schemas__PromptItem"];
export type ApiAnswerRef = S["app__features__analytics__mentions__prompts__schemas__AnswerRef"];
export type ApiDomainRow = S["DomainRow"];
export type ApiDomainDetail = S["DomainDetailData"];
export type SignalKey = NonNullable<S["Target"]["signal"]>;

export const SIGNAL_KEYS: readonly SignalKey[] = [
  "positive",
  "neutral",
  "mixed",
  "negative",
  "mention",
  "recommendation",
  "comparison",
  "definition",
  "final_choice",
];

/**
 * Cap of the brand lists, read in one request (the former "read to the end" cap: 10 cursor pages x
 * 200, design 2.6; the backend takes limit <= 2000 for mention_brand / own targets only).
 */
export const DRILLDOWN_LIST_LIMIT = 2000;
export const BRAND_ANSWERS_LIMIT = 50;
export const SIGNAL_PROMPTS_LIMIT = 50;
export const SIGNAL_ANSWERS_LIMIT = 6;
export const DETAIL_LIMITS = { urls_limit: 10, prompts_limit: 100, answers_limit: 20 } as const;

// ── route target and gate ───────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DrilldownTarget {
  surface: Surface;
  projectId?: string;
}

/**
 * Surface of a drilldown request, the same routing as the legacy routes: projectId -> project,
 * surface=website -> website, anything else -> global. A projectId that is not a uuid -> null.
 */
export function drilldownTarget(q: URLSearchParams): DrilldownTarget | null {
  const projectId = q.get("projectId");
  if (projectId !== null) return UUID_RE.test(projectId) ? { surface: "project", projectId } : null;
  return { surface: q.get("surface") === "website" ? "website" : "global" };
}

export interface GateUser {
  id: string;
  role: Role;
  menuGroups?: readonly MenuGroup[] | null;
}

/** The legacy project page gate (project exists and admin or active member). Injected by routes. */
export type LegacyProjectAllowed = (projectId: string, user: GateUser) => Promise<boolean>;

export type GateResult = { ok: true } | { ok: false; status: 403 | 404 };

/**
 * The route gate, applied before any read on BOTH sources (U4 F1):
 *   1. the (dash) place gate of the screen family: canReadAnalysis(role, menuGroups, analysis,
 *      surface) -> 403
 *   2. project surface: the project page gate (demo project admin only; HGH_SOURCE_SESSION=api ->
 *      GET /v1/projects/{id}, legacy -> the injected repository check) -> 404
 *
 * Backend answers of the api project gate (U6 verification D3), the project page contract of
 * project-gate.ts mapped to route statuses: 404 -> 404; 403 role_forbidden / menu_forbidden -> 403;
 * any other 403 -> 404 (project routes hide existence). The call refreshes once on 401
 * (retryOn401: a route handler can write the refreshed cookies), like the data calls behind it; a
 * 401 that survives the refresh and every 5xx / timeout are THROWN as HghApiError, and the routes
 * call the gate inside their error mapping (401 -> 401 {error: "unauthorized"}, others ->
 * hghErrorResponse).
 */
export async function drilldownGate(
  user: GateUser,
  target: DrilldownTarget,
  legacyProjectAllowed: LegacyProjectAllowed,
): Promise<GateResult> {
  if (!canReadAnalysis(user, "analysis", target.surface)) return { ok: false, status: 403 };
  if (target.surface === "project") {
    const id = target.projectId!;
    if (isDemoProject(id) && user.role !== "admin") return { ok: false, status: 404 };
    if (hghSource("SESSION") === "api") return apiProjectGate(id);
    if (!(await legacyProjectAllowed(id, user))) return { ok: false, status: 404 };
  }
  return { ok: true };
}

async function apiProjectGate(id: string): Promise<GateResult> {
  if (!isProjectId(id)) return { ok: false, status: 404 };
  try {
    await hghGet("/v1/projects/{project_id}", { pathParams: { project_id: id }, retryOn401: true });
    return { ok: true };
  } catch (e) {
    if (isHghApiError(e) && e.status === 404) return { ok: false, status: 404 };
    if (isHghApiError(e) && e.status === 403) {
      return { ok: false, status: errorKindOf(e.status, e.code) === "forbidden" ? 403 : 404 };
    }
    throw e;
  }
}

/**
 * Route response for a gate that threw (see drilldownGate): 401 -> 401 {error: "unauthorized"}
 * (the legacy body), any other HghApiError -> hghErrorResponse ({error:{code}}, no backend
 * message). Anything else is rethrown.
 */
export function gateErrorResponse(e: unknown): Response {
  if (isHghApiError(e) && e.status === 401) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (isHghApiError(e)) return hghErrorResponse(e);
  throw e;
}

/** Backend answers the signal list turns into an empty list (existence hidden, 공통 규칙 4). */
export function isEmptyListError(e: unknown): boolean {
  return isHghApiError(e) && (e.status === 404 || e.status === 403);
}

/**
 * Backend answers the brand lists and the source detail turn into an empty list: 404 only
 * (brand_not_found, an unknown skey = "no data"). A 403 is a refusal, not "no data": it is thrown
 * and the routes answer 403 with the empty shape (isForbiddenError), so the component shows its
 * existing error state instead of "no prompts / no sources".
 */
export function isNoDataError(e: unknown): boolean {
  return isHghApiError(e) && e.status === 404;
}

/** A backend refusal (403) of a brand list or detail read: the routes answer 403 with the empty shape. */
export function isForbiddenError(e: unknown): boolean {
  return isHghApiError(e) && e.status === 403;
}

/** A filter the backend refused (422): the routes answer 400 with the empty shape. */
export function isBadFilterError(e: unknown): boolean {
  return isHghApiError(e) && e.status === 422;
}

// ── conversions ─────────────────────────────────────────────────────────────

/** Engine codes -> display labels, deduped in first-seen order (claude-web / claude-sonnet -> Claude). */
export function engineLabels(codes: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const c of codes) {
    if (!c) continue;
    const label = providerLabel(c);
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

export type PromptMode = "brand" | "signal";

/** M-3 AnswerRef -> MentionAnswerLive (signal mode keeps the legacy bare reference). */
export function toMentionAnswer(a: ApiAnswerRef, mode: PromptMode): MentionAnswerLive {
  if (mode === "signal") {
    return {
      jobId: a.job_id,
      provider: providerLabel(a.engine),
      region: a.region ?? null,
      mentionCount: a.value,
      position: null,
      highlights: { brand: [], model: [] },
      measuredAt: null,
      runs: 1,
    };
  }
  return {
    jobId: a.job_id,
    provider: providerLabel(a.engine),
    region: a.region ?? null,
    mentionCount: a.value,
    position: a.position ?? null,
    highlights: { brand: [...(a.terms?.brand ?? [])], model: [...(a.terms?.model ?? [])] },
    measuredAt: a.measured_at ?? null,
    // runs is null only in a lite reply, which the backend gives to mode=signal only (422 otherwise)
    runs: a.runs ?? 1,
  };
}

/** M-3 PromptItem -> MentionsPromptLive. */
export function toMentionsPrompt(item: ApiPromptItem, mode: PromptMode): MentionsPromptLive {
  return {
    id: item.prompt_id,
    promptText: item.prompt_text ?? "",
    mentions: item.count,
    share: pct1OrZero(item.share),
    funnelStage: item.funnel_code ?? null,
    providers: engineLabels(item.providers),
    answers: item.answers.map((a) => toMentionAnswer(a, mode)),
  };
}

const CATEGORY_LABEL_BY_SLUG: ReadonlyMap<string, string> = new Map(
  Object.entries(CITATION_CATEGORY_SLUGS).map(([label, slug]) => [slug, label]),
);

/** Category of a source row in the legacy vocabulary ("Official (HMG)", ...); unknown slug -> API name. */
export function categoryLabel(c: ApiDomainRow["category"]): string | null {
  if (!c) return null;
  return CATEGORY_LABEL_BY_SLUG.get(c.slug) ?? c.name;
}

/**
 * C-1 DomainRow -> CitationDomainLive (drilldown loaded when the row opens). The row name is the
 * legacy group key (skey: an official social account is host+path), as citations.ts: the display
 * host (domain) is shared by an account row and the plain row of its host.
 */
export function toCitationDomain(r: ApiDomainRow): CitationDomainLive {
  return {
    domain: r.skey,
    citations: r.citations,
    share: pct1OrZero(r.share),
    prompts: r.citing_prompts ?? 0,
    coverageRate: pct1OrZero(r.coverage),
    urls: [],
    promptList: [],
    isOurs: r.is_own,
    category: categoryLabel(r.category),
    subcategory: null,
    skey: r.skey,
  };
}

export interface DomainDrilldown {
  urls: CitationUrlLive[];
  promptList: CitationPromptLive[];
  /** URLs before the cap (url_total), only when the cap cut the list. */
  urlTotal?: number;
  /** Prompts before the cap (prompt_total), only when the cap cut the list. */
  promptTotal?: number;
}

/** A total worth reporting: the count before the cap, only when it is larger than what was read. */
function cutTotal(total: number | null | undefined, shown: number): number | undefined {
  return typeof total === "number" && total > shown ? total : undefined;
}

/** C-1 detail -> the row's URL list and prompt list (legacy buildCitationDomains shapes). */
export function toDomainDrilldown(d: ApiDomainDetail): DomainDrilldown {
  const out: DomainDrilldown = {
    urls: [...d.urls]
      .sort((a, b) => b.citations - a.citations)
      .map((u) => ({
        url: u.url,
        title: u.title || displayCitationUrl(u.url),
        count: u.citations,
        aiProvider: engineLabels(u.engines).join(", "),
        promptText: u.prompt_text ?? "",
        country: u.country ?? null,
      })),
    promptList: [...d.prompts]
      .sort((a, b) => b.citations - a.citations)
      .map((p) => ({
        id: p.prompt_id,
        promptText: p.text ?? "",
        funnelStage: p.funnel ?? null,
        citations: p.citations,
        ownedCitations: p.own_citations,
        providers: engineLabels(p.engines),
        answers: p.answers.map((a) => ({
          jobId: a.job_id,
          provider: providerLabel(a.engine ?? ""),
          region: a.country ?? null,
          mentionCount: a.citations,
          position: null,
          highlights: { brand: [], model: [] },
          measuredAt: null,
          runs: 1,
        })),
      })),
  };
  const urlTotal = cutTotal(d.url_total, d.urls.length);
  const promptTotal = cutTotal(d.prompt_total, d.prompts.length);
  if (urlTotal !== undefined) out.urlTotal = urlTotal;
  if (promptTotal !== undefined) out.promptTotal = promptTotal;
  return out;
}

// ── loaders ─────────────────────────────────────────────────────────────────

export type DrilldownContext = AnalysisQueryContext;

/** mode=brand target (BG-17). */
export type BrandTarget = { mentionBrand: string } | { own: true; ownBrandCode?: string };

/** The prompts tab list (route JSON {prompts}); total = prompts before the cap, only when it cut the list. */
export interface BrandPromptsList {
  prompts: MentionsPromptLive[];
  total?: number;
}

/** The citation sources tab list (route JSON {domains}); total = sources before the cap, only when it cut the list. */
export interface BrandDomainsList {
  domains: CitationDomainLive[];
  total?: number;
}

/**
 * M-3 mode=brand in one request (DRILLDOWN_LIST_LIMIT prompts, 50 answer references each,
 * terms=true). brand_not_found (404) -> []; a refusal (403) or a refused filter (422) is thrown.
 */
export async function loadBrandMentionPrompts(
  filters: StandardFilters,
  ctx: DrilldownContext,
  target: BrandTarget,
): Promise<BrandPromptsList> {
  const { query, cf } = analysisQuery(filters, ctx);
  const targetParams: { mention_brand?: string; own?: boolean; own_brand_code?: string } =
    "own" in target
      ? { own: true, ...(target.ownBrandCode ? { own_brand_code: target.ownBrandCode } : {}) }
      : { mention_brand: target.mentionBrand };
  try {
    const res = await hghGet("/v1/mentions/prompts", {
      query: withParams(query, {
        mode: "brand" as const,
        ...targetParams,
        terms: true,
        limit: DRILLDOWN_LIST_LIMIT,
        answers_limit: BRAND_ANSWERS_LIMIT,
      }),
      cf,
      retryOn401: true,
    });
    const prompts = res.data.items.map((i) => toMentionsPrompt(i, "brand"));
    const total = cutTotal(res.meta.page?.total, prompts.length);
    return total !== undefined ? { prompts, total } : { prompts };
  } catch (e) {
    if (isNoDataError(e)) return { prompts: [] };
    throw e;
  }
}

/**
 * M-3 mode=signal: the top 50 prompts with 6 answer references (legacy limits), one page. lite=true:
 * the backend skips runs / position / measured_at, which the signal reference drops anyway.
 */
export async function loadSignalPrompts(
  filters: StandardFilters,
  ctx: DrilldownContext,
  signal: SignalKey,
): Promise<MentionsPromptLive[]> {
  const { query, cf } = analysisQuery(filters, ctx);
  try {
    const res = await hghGet("/v1/mentions/prompts", {
      query: withParams(query, {
        mode: "signal" as const,
        signal,
        limit: SIGNAL_PROMPTS_LIMIT,
        answers_limit: SIGNAL_ANSWERS_LIMIT,
        lite: true,
      }),
      cf,
      retryOn401: true,
    });
    return res.data.items.map((i) => toMentionsPrompt(i, "signal"));
  } catch (e) {
    if (isEmptyListError(e)) return [];
    throw e;
  }
}

/**
 * C-1 with mention_brand in one request (DRILLDOWN_LIST_LIMIT sources). The table reads rows only
 * (coverage needs the denominator), so the competitor totals are not computed
 * (include_competitor_totals=false). 404 -> []; 403 / 422 are thrown (an unknown brand name is not
 * a 404 here: the backend answers an empty list).
 */
export async function loadBrandCitationDomains(
  filters: StandardFilters,
  ctx: DrilldownContext,
  mentionBrand: string,
): Promise<BrandDomainsList> {
  const { query, cf } = analysisQuery(filters, ctx);
  try {
    const res = await hghGet("/v1/citations/domains", {
      query: withParams(query, { mention_brand: mentionBrand, limit: DRILLDOWN_LIST_LIMIT, include_competitor_totals: false }),
      cf,
      retryOn401: true,
    });
    const domains = res.data.items.map(toCitationDomain);
    const total = cutTotal(res.meta.page?.total, domains.length);
    return total !== undefined ? { domains, total } : { domains };
  } catch (e) {
    if (isNoDataError(e)) return { domains: [] };
    throw e;
  }
}

/**
 * C-1 detail of one source for the brand (loaded when a row opens). 404 (unknown skey) -> empty
 * lists; 403 / 422 are thrown.
 */
export async function loadBrandCitationDetail(
  filters: StandardFilters,
  ctx: DrilldownContext,
  mentionBrand: string,
  skey: string,
): Promise<DomainDrilldown> {
  const { query, cf } = analysisQuery(filters, ctx);
  try {
    const res = await hghGet("/v1/citations/domains/{skey}", {
      pathParams: { skey },
      query: withParams(query, { mention_brand: mentionBrand, ...DETAIL_LIMITS }),
      cf,
      retryOn401: true,
    });
    return toDomainDrilldown(res.data);
  } catch (e) {
    if (isNoDataError(e)) return { urls: [], promptList: [] };
    throw e;
  }
}

/** Parse a signal key (the dialog's ?signal=). */
export function isSignalKeyApi(v: string | null): v is SignalKey {
  return v !== null && (SIGNAL_KEYS as readonly string[]).includes(v);
}
