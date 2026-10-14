import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";

// Unit tests of the customer-interest adapter (unit U10): conversions with hand-computed
// expectations, the collection flow (D12), cursor pages (D5), action error mapping and the
// place gates. API mocked at fetch; token through the lib/hgh/auth test seam. The legacy <->
// api parity of the pages, routes and actions is in intent.parity.test.ts.

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (k: string) => `t:${k}`,
}));

const { bindHghAuth } = await import("../auth");
const I = await import("./intent");
const { UnauthorizedError } = await import("@/lib/auth/errors");

type S = components["schemas"];
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PID = "c0000000-0000-4000-8000-000000000003";
const msg = (k: string) => `m:${k}`;

// ── fetch router ─────────────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  query: Record<string, string[]>;
  body: unknown;
  headers: Headers;
}
const calls: Call[] = [];
type Handler = (c: Call) => Response | Promise<Response>;
let routes: Record<string, Handler | Handler[]> = {};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const env = (data: unknown, meta: Partial<S["Meta"]> = {}) => json(200, { data, meta: { mode: "external", ...meta } });
const err = (status: number, code: string) => json(status, { error: { code, message: "m", details: null } });

function install(r: Record<string, Handler | Handler[]>) {
  routes = r;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const u = new URL(String(input));
      const query: Record<string, string[]> = {};
      for (const [k, v] of u.searchParams) (query[k] ??= []).push(v);
      const c: Call = {
        method: (init?.method ?? "GET").toUpperCase(),
        path: u.pathname,
        query,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: new Headers(init?.headers),
      };
      calls.push(c);
      const key = `${c.method} ${c.path}`;
      const h = routes[key];
      if (!h) throw new Error(`unrouted ${key}`);
      if (Array.isArray(h)) {
        const next = h.shift();
        if (!next) throw new Error(`no more answers for ${key}`);
        return next(c);
      }
      return h(c);
    }),
  );
}
const seq = () => calls.map((c) => `${c.method} ${c.path}`);
const noSleep = { sleep: async () => {}, pollMs: 1, budgetMs: 10_000 };

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: async () => null });
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ── fixtures ────────────────────────────────────────────────────────────────

const serpRow = (rank: number, prompt: string | null, over: Partial<S["SerpRow"]> = {}): S["SerpRow"] => ({
  rank,
  url: `https://site${rank}.test/page`,
  domain: `site${rank}.test`,
  title: `T${rank}`,
  snippet: `S${rank}`,
  suggested_prompt: prompt,
  draft_model: null,
  draft_gen: prompt ? 1 : null,
  ...over,
});
const insight = (serp: S["SerpRow"][], callId: number | null = 11, trend = true): S["Insight"] => ({
  term: "suv",
  country: "kr",
  location_code: 2410,
  language_code: "ko",
  serp_call_id: callId,
  serp,
  trend: trend
    ? [
        { month: "2025-11-01", search_volume: 100, competition_index: null, cpc: null },
        { month: "2025-12-01", search_volume: null, competition_index: null, cpc: null },
        { month: "2026-01-01", search_volume: 300, competition_index: 5, cpc: 1.2 },
      ]
    : [],
});
// GET /v1/intent/fetches?ids answer: every asked change in the asked order (one poll = one request).
const change = (id: number, status: S["FetchStatus"]["status"], over: Partial<S["FetchStatus"]> = {}): S["FetchStatus"] => ({
  change_id: id,
  status,
  kind: "insight",
  country: "kr",
  terms: ["suv"],
  project_id: null,
  requested_at: "2026-09-29T00:00:00Z",
  claimed_at: null,
  applied_at: null,
  error: null,
  ...over,
});
const statuses = (...rows: S["FetchStatus"][]) => env({ items: rows });
const fresh = { source: { freshness: "fresh" } };
const missing = { source: { freshness: "missing" }, suppressed: { "*": "source_pending" } };
const stale = { source: { freshness: "stale" } };
const KR = I.keywordPreset("KR");

// ── conversions ─────────────────────────────────────────────────────────────

describe("keyword conversions", () => {
  it("trend labels: 2-digit year, month without leading zero", () => {
    expect(I.trendWeekLabel("2025-10-01")).toBe("25.10");
    expect(I.trendWeekLabel("2026-01-01")).toBe("26.1");
  });

  it("toKeywordInsight: volume null -> 0, url scheme stripped, draft -> stored -> keyword", () => {
    const d = insight([serpRow(1, "stored one"), serpRow(3, null, { title: null, snippet: null, url: "http://x.test/a" }), serpRow(4, null)]);
    const out = I.toKeywordInsight(d, new Map([[3, "fresh draft"]]));
    expect(out).toEqual({
      label: "suv",
      trend: [
        { week: "25.11", primary: 100 },
        { week: "25.12", primary: 0 },
        { week: "26.1", primary: 300 },
      ],
      serp: [
        { id: "serp-0-1", rank: 1, url: "site1.test/page", title: "T1", snippet: "S1", suggestedPrompt: "stored one" },
        { id: "serp-1-3", rank: 3, url: "x.test/a", title: "", snippet: "", suggestedPrompt: "fresh draft" },
        { id: "serp-2-4", rank: 4, url: "site4.test/page", title: "T4", snippet: "S4", suggestedPrompt: "suv" },
      ],
    });
  });

  it("related items: legacy order volume desc (stable), ids after ordering, intent default informational", () => {
    const items = I.toRelatedItems([
      { term: "a", search_volume: 100, intent: "commercial" },
      { term: "b", search_volume: null, intent: null },
      { term: "c", search_volume: 300, intent: "bogus" },
      { term: "d", search_volume: 100, intent: "navigational" },
    ]);
    expect(items).toEqual([
      { id: "rel-0", term: "c", volume: 300, intent: "informational" },
      { id: "rel-1", term: "a", volume: 100, intent: "commercial" },
      { id: "rel-2", term: "d", volume: 100, intent: "navigational" },
      { id: "rel-3", term: "b", volume: 0, intent: "informational" },
    ]);
  });

  it("foundCount = total_count (BG-39), else the item count (U10-N3)", () => {
    const base = { term: "suv", country: "kr", found_count: 2, items: [{ term: "x", search_volume: 1, intent: null }, { term: "y", search_volume: 2, intent: null }] };
    expect(I.toRelatedBundle({ ...base, total_count: 1234 }).foundCount).toBe(1234);
    expect(I.toRelatedBundle({ ...base, total_count: null }).foundCount).toBe(2);
    expect(
      I.toSearchGroup({ term: "suv", status: "found", search_volume: null, intent: "transactional", related: base.items, total_count: null }),
    ).toEqual({
      term: "suv",
      volume: 0,
      intent: "transactional",
      foundCount: 2,
      related: [
        { id: "rel-0", term: "y", volume: 2, intent: "informational" },
        { id: "rel-1", term: "x", volume: 1, intent: "informational" },
      ],
    });
  });

  it("keywordPreset: legacy country rule (case-insensitive, unknown -> kr)", () => {
    expect(I.keywordPreset("IT").id).toBe("it");
    expect(I.keywordPreset("zz").id).toBe("kr");
    expect(I.keywordPreset(undefined).id).toBe("kr");
  });
});

describe("context map conversions", () => {
  const sent = (p: number, n: number, u: number) => ({
    positive: { num: p, den: p + n + u },
    negative: { num: n, den: p + n + u },
    neutral: { num: u, den: p + n + u },
  });

  it("perspective = Math.round(part / total * 100); empty -> neutral 100", () => {
    expect(I.toPerspective(sent(3, 1, 3))).toEqual({ buyer: 43, seller: 14, neutral: 43 });
    expect(I.toPerspective(sent(1, 1, 0))).toEqual({ buyer: 50, seller: 50, neutral: 0 });
    expect(I.toPerspective(sent(0, 0, 0))).toEqual({ buyer: 0, seller: 0, neutral: 100 });
  });

  it("rows, detail and stats keep the legacy field names", () => {
    const id = "e0000000-0000-4000-8000-000000000001";
    expect(
      I.toContextRow({ id, name: "Family", theme_id: "lifestage", theme_name: "생애주기", mention_count: 9, utterance_count: 12, sentiment: sent(2, 1, 1), linked_count: 4 }),
    ).toEqual({ id, name: "Family", themeId: "lifestage", themeName: "생애주기", mentionCount: 9, perspective: { buyer: 50, seller: 25, neutral: 25 }, linkedCount: 4 });
    expect(
      I.toConditionRow({ id, name: "연비", category: "연비·동력", mention_count: 3, utterance_count: 3, sentiment: sent(0, 0, 0), linked_count: 0 }),
    ).toEqual({ id, name: "연비", categoryId: "연비·동력", mentionCount: 3, perspective: { buyer: 0, seller: 0, neutral: 100 }, linkedCount: 0 });
    expect(
      I.toCombinationRow({ id: `${id}:x`, cond_a_id: id, cond_a_name: "A", cond_b_id: "x", cond_b_name: "B", co_count: 7, frequency: "medium" }),
    ).toEqual({ id: `${id}:x`, condAId: id, condAName: "A", condBId: "x", condBName: "B", coOccurrenceCount: 7, frequency: "medium" });
    expect(
      I.toEntityDetail({
        id,
        name: "Family",
        type: "ConsumerContext",
        mention_count: 9,
        utterance_count: 9,
        sentiment: sent(1, 0, 1),
        evidence: [
          { quote: "q1", source_host: "a.test", source_url: "https://a.test/1", sentiment: "positive" },
          { quote: "q2", source_host: null, source_url: null, sentiment: "negative" },
          { quote: "q3", source_host: "b.test", source_url: null, sentiment: null },
        ],
        source_domains: [{ host: "a.test", count: 5 }, { host: "b.test", count: 2 }],
        linked: [{ id: "l1", name: "L1", co_count: 9, strength: "high" }],
      }),
    ).toEqual({
      id,
      name: "Family",
      mentionCount: 9,
      perspective: { buyer: 50, seller: 0, neutral: 50 },
      evidenceQuotes: [
        { quote: "q1", sourceTitle: "a.test", sourceUrl: "https://a.test/1", perspective: "buyer" },
        { quote: "q2", sourceTitle: "", sourceUrl: "", perspective: "seller" },
        { quote: "q3", sourceTitle: "b.test", sourceUrl: "", perspective: "neutral" },
      ],
      sourceDomains: { "a.test": 5, "b.test": 2 },
      linked: [{ id: "l1", name: "L1", strength: "high" }],
    });
    expect(I.toStats(null)).toEqual({ contexts: 0, conditions: 0, relationships: 0, drives: 0, combinations: 0, sources: 0 });
    expect(I.toStats({ contexts: 1, conditions: 2, drives: 3, combinations: 4, relationships: 7, sources: 5 })).toEqual({
      contexts: 1, conditions: 2, relationships: 7, drives: 3, combinations: 4, sources: 5,
    });
  });

  it("generated prompts: prompt_id is the id, missing fields fall back (U10-N6)", () => {
    const base: S["GeneratedPrompt"] = {
      prompt_id: "p0000000-0000-4000-8000-000000000001".replace("p", "a"),
      seed_key: "l1-x",
      question: "q?",
      layer: null,
      funnel_stage: null,
      source_label: null,
      priority: null,
      origin: null,
      batch_no: 1,
      model: null,
      generated_at: "2026-09-01T00:00:00Z",
      similar_to: null,
      in_candidate_pool: false,
    };
    expect(I.toGeneratedPrompt(base)).toEqual({
      id: base.prompt_id, question: "q?", layer: "L1-context", funnelStage: "consideration", sourceLabel: "", priority: 0,
    });
    // Backend "already in the candidate pool" mark -> the catalog's "이미 추가됨" (left out when false, like legacy rows).
    expect(I.toGeneratedPrompt({ ...base, in_candidate_pool: true }).inCandidatePool).toBe(true);
    expect(
      I.toGeneratedPrompt({ ...base, layer: "L3-intersection", funnel_stage: "purchase", source_label: "A x B", priority: 88, origin: "composed", similar_to: { text: "t", score: 0.7, kind: "prompt" } }),
    ).toEqual({
      id: base.prompt_id, question: "q?", layer: "L3-intersection", funnelStage: "purchase", sourceLabel: "A x B", priority: 88,
      similarTo: { text: "t", score: 0.7, kind: "prompt" }, origin: "composed",
    });
  });

  it("query normalization: legacy size clamp, control characters and length cut (U10-N7)", () => {
    const q = (o: Partial<Parameters<typeof I.normalizeContextMapQuery>[0]>) =>
      I.normalizeContextMapQuery({ sort: "mentions", dir: "desc", page: 0, size: 50, ...o });
    expect(q({ size: 0 }).size).toBe(50);
    expect(q({ size: 500 }).size).toBe(200);
    expect(q({ size: -3 }).size).toBe(1);
    expect(q({ page: -2 }).page).toBe(0);
    expect(q({ search: "  a\u0000b\u007f  " }).search).toBe("ab");
    expect(q({ search: "x".repeat(150) }).search).toHaveLength(100);
    expect(q({ search: "   " }).search).toBeUndefined();
  });

  it("export language: body lang, else the NEXT_LOCALE cookie, else ko", () => {
    expect(I.exportLang("en", "ko")).toBe("en");
    expect(I.exportLang(undefined, "en")).toBe("en");
    expect(I.exportLang("fr", undefined)).toBe("ko");
  });
});

// ── collection flow (D12) ───────────────────────────────────────────────────

describe("loadKeywordInsight", () => {
  it("fresh stored data: one read, no collection, no drafts when every row has one", async () => {
    install({ "GET /v1/intent/insight": () => env(insight([serpRow(1, "p1")]), fresh) });
    const out = await I.loadKeywordInsight({ term: "suv", country: KR, projectId: PID }, noSleep);
    expect(seq()).toEqual(["GET /v1/intent/insight"]);
    expect(calls[0].query).toEqual({ term: ["suv"], country: ["kr"], project_id: [PID], limit: ["8"] });
    expect(out.serp[0].suggestedPrompt).toBe("p1");
  });

  it("missing + operator: collect, poll to applied, read again, draft the missing rows", async () => {
    install({
      "GET /v1/intent/insight": [() => env(insight([], null, false), missing), () => env(insight([serpRow(1, null), serpRow(2, "kept")]), fresh)],
      "POST /v1/intent/fetches": () => json(202, { data: { status: "queued", change_id: 7, terms: ["suv"], fresh_terms: [] }, meta: { mode: "crud" } }),
      "GET /v1/intent/fetches": [
        () => statuses(change(7, "pending", { project_id: PID })),
        () => statuses(change(7, "applied", { project_id: PID })),
      ],
      "POST /v1/intent/serp-drafts": () =>
        env({ serp_call_id: 11, skipped_count: 0, drafts: [{ rank: 1, prompt: "drafted", gen: 1, model: "m", generated_at: "2026-09-29T00:00:01Z" }] }),
    });
    const out = await I.loadKeywordInsight({ term: "suv", country: KR, projectId: PID }, noSleep);
    expect(seq()).toEqual([
      "GET /v1/intent/insight",
      "POST /v1/intent/fetches",
      "GET /v1/intent/fetches",
      "GET /v1/intent/fetches",
      "GET /v1/intent/insight",
      "POST /v1/intent/serp-drafts",
    ]);
    expect(calls[1].body).toEqual({ kind: "insight", terms: ["suv"], country: "kr", project_id: PID, force: false });
    expect([calls[2].query, calls[3].query]).toEqual([{ ids: ["7"] }, { ids: ["7"] }]);
    expect(calls[5].body).toEqual({ project_id: PID, serp_call_id: 11, ranks: null });
    expect(out.serp.map((r) => r.suggestedPrompt)).toEqual(["drafted", "kept"]);
  });

  it("missing + not an operator: 403 on collect -> the empty stored shape, no drafts (DC-15)", async () => {
    install({
      "GET /v1/intent/insight": () => env(insight([], null, false), missing),
      "POST /v1/intent/fetches": () => err(403, "operator_forbidden"),
    });
    const out = await I.loadKeywordInsight({ term: "suv", country: KR }, noSleep);
    expect(seq()).toEqual(["GET /v1/intent/insight", "POST /v1/intent/fetches"]);
    expect(calls[0].query.project_id).toBeUndefined();
    expect(out).toEqual({ label: "suv", trend: [], serp: [] });
  });

  it("stale + collection times out: the stored copy (U10-N1)", async () => {
    let t = 0;
    install({
      "GET /v1/intent/insight": () => env(insight([serpRow(1, "old")]), stale),
      "POST /v1/intent/fetches": () => json(202, { data: { status: "pending", change_id: 8, terms: ["suv"], fresh_terms: [] }, meta: { mode: "crud" } }),
      "GET /v1/intent/fetches": () => statuses(change(8, "running")),
    });
    const out = await I.loadKeywordInsight(
      { term: "suv", country: KR },
      { sleep: async () => {}, pollMs: 1, budgetMs: 3, now: () => (t += 1) },
    );
    expect(out.serp[0].suggestedPrompt).toBe("old");
    expect(seq().filter((s) => s === "GET /v1/intent/fetches").length).toBeGreaterThanOrEqual(2);
  });

  it("missing + collection failed: 502 upstream (component error state, gap G9)", async () => {
    install({
      "GET /v1/intent/insight": () => env(insight([], null, false), missing),
      "POST /v1/intent/fetches": () => json(202, { data: { status: "queued", change_id: 9, terms: ["suv"], fresh_terms: [] }, meta: { mode: "crud" } }),
      "GET /v1/intent/fetches": () => statuses(change(9, "failed", { error: "x" })),
    });
    await expect(I.loadKeywordInsight({ term: "suv", country: KR }, noSleep)).rejects.toMatchObject({ status: 502, code: "upstream" });
  });

  it("재생성 (fresh) on an unchanged SERP call regenerates every row's draft; LLM failure keeps the keyword", async () => {
    install({
      "GET /v1/intent/insight": () => env(insight([serpRow(1, "a"), serpRow(2, "b")]), fresh),
      "POST /v1/intent/fetches": () => err(403, "operator_forbidden"),
      "POST /v1/intent/serp-drafts": () => err(502, "llm_failed"),
    });
    const out = await I.loadKeywordInsight({ term: "suv", country: KR, fresh: true }, noSleep);
    expect(calls[1].body).toMatchObject({ force: true });
    expect(calls[2].body).toEqual({ project_id: null, serp_call_id: 11, ranks: [1, 2] });
    expect(out.serp.map((r) => r.suggestedPrompt)).toEqual(["a", "b"]);
  });

  it("U10 N2: the drafts timeout is what is left of the route's maxDuration, at most the external 70 s", () => {
    // min(70 s, 120 s - elapsed - 10 s margin); under 5 s left -> null (skip)
    expect(I.serpDraftTimeoutMs(0)).toBe(70_000);
    expect(I.serpDraftTimeoutMs(40_000)).toBe(70_000);
    expect(I.serpDraftTimeoutMs(50_000)).toBe(60_000);
    expect(I.serpDraftTimeoutMs(105_000)).toBe(5_000);
    expect(I.serpDraftTimeoutMs(105_001)).toBeNull();
    expect(I.serpDraftTimeoutMs(130_000)).toBeNull();
  });

  it("U10 N2: the drafts call gets the rest of the route budget (route started 50 s ago -> 60 s)", async () => {
    install({
      "GET /v1/intent/insight": () => env(insight([serpRow(1, null)]), fresh),
      "POST /v1/intent/serp-drafts": () =>
        env({ serp_call_id: 11, skipped_count: 0, drafts: [{ rank: 1, prompt: "drafted", gen: 1, model: "m", generated_at: "2026-09-29T00:00:01Z" }] }),
    });
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    const T = 1_000_000;
    const out = await I.loadKeywordInsight({ term: "suv", country: KR }, { ...noSleep, now: () => T, startedAt: T - 50_000 });
    expect(seq()).toEqual(["GET /v1/intent/insight", "POST /v1/intent/serp-drafts"]);
    expect(timeouts.mock.calls.map((c) => c[0])).toEqual([10_000, 60_000]);
    // D-7: the backend bounds the LLM call (retry included) to the same wait
    expect(calls[1].headers.get("x-hgh-timeout-ms")).toBe("60000");
    expect(calls[0].headers.get("x-hgh-timeout-ms")).toBeNull();
    expect(out.serp[0].suggestedPrompt).toBe("drafted");
    timeouts.mockRestore();
  });

  it("U10 N2: no route budget left -> no drafts call, the stored copy or the keyword is shown", async () => {
    install({
      "GET /v1/intent/insight": () => env(insight([serpRow(1, null), serpRow(2, "kept")]), fresh),
      "POST /v1/intent/serp-drafts": () => {
        throw new Error("the drafts call must not be sent without budget");
      },
    });
    const T = 1_000_000;
    const out = await I.loadKeywordInsight({ term: "suv", country: KR }, { ...noSleep, now: () => T, startedAt: T - 106_000 });
    expect(seq()).toEqual(["GET /v1/intent/insight"]);
    expect(out.serp.map((r) => r.suggestedPrompt)).toEqual(["suv", "kept"]);

    // the same when the collection itself spent the budget (clock runs on through the polls)
    let t = 0;
    install({
      "GET /v1/intent/insight": [() => env(insight([], null, false), missing), () => env(insight([serpRow(1, null)]), fresh)],
      "POST /v1/intent/fetches": () => json(202, { data: { status: "queued", change_id: 7, terms: ["suv"], fresh_terms: [] }, meta: { mode: "crud" } }),
      "GET /v1/intent/fetches": () => statuses(change(7, "applied")),
      "POST /v1/intent/serp-drafts": () => {
        throw new Error("the drafts call must not be sent without budget");
      },
    });
    calls.length = 0;
    const late = await I.loadKeywordInsight(
      { term: "suv", country: KR },
      { sleep: async () => {}, pollMs: 1, budgetMs: 200_000, now: () => (t += 40_000) },
    );
    expect(seq()).toEqual(["GET /v1/intent/insight", "POST /v1/intent/fetches", "GET /v1/intent/fetches", "GET /v1/intent/insight"]);
    expect(late.serp.map((r) => r.suggestedPrompt)).toEqual(["suv"]);
  });

  it("a request error from the drafts call is not hidden", async () => {
    install({
      "GET /v1/intent/insight": () => env(insight([serpRow(1, null)]), fresh),
      "POST /v1/intent/serp-drafts": () => err(422, "unknown_rank"),
    });
    await expect(I.loadKeywordInsight({ term: "suv", country: KR }, noSleep)).rejects.toMatchObject({ status: 422 });
  });
});

describe("loadRelatedKeywords / loadKeywordSearchGroups", () => {
  it("related: fresh -> one read", async () => {
    install({
      "GET /v1/intent/related": () =>
        env({ term: "suv", country: "kr", found_count: 1, total_count: 55, items: [{ term: "suv price", search_volume: 10, intent: "commercial" }] }, fresh),
    });
    expect(await I.loadRelatedKeywords({ term: "suv", country: KR }, noSleep)).toEqual({
      foundCount: 55,
      items: [{ id: "rel-0", term: "suv price", volume: 10, intent: "commercial" }],
    });
    expect(seq()).toEqual(["GET /v1/intent/related"]);
  });

  it("search: 25 terms -> lookups of 20 + 5; a missing term triggers collection per chunk, then one more read", async () => {
    const terms = Array.from({ length: 25 }, (_, i) => `t${i}`);
    const row = (t: string, found: boolean): S["LookupRow"] =>
      found
        ? { term: t, status: "found", search_volume: 5, intent: null, related: [], total_count: 9 }
        : { term: t, status: "missing", search_volume: null, intent: null, related: [], total_count: null };
    let round = 0;
    install({
      "GET /v1/intent/lookup": (c) => {
        const ts = c.query.terms;
        if (ts[0] === "t0") round += 1;
        return env({ country: "kr", items: ts.map((t) => row(t, round > 1 || t !== "t21")) }, fresh);
      },
      "POST /v1/intent/fetches": () => json(202, { data: { status: "queued", change_id: 5, terms: [], fresh_terms: [] }, meta: { mode: "crud" } }),
      "GET /v1/intent/fetches": () => statuses(change(5, "applied", { kind: "search", terms: [] })),
    });
    const groups = await I.loadKeywordSearchGroups([...terms, " t0 ", ""], { country: KR }, noSleep);
    expect(groups).toHaveLength(25);
    expect(groups[21]).toEqual({ term: "t21", volume: 5, intent: "informational", foundCount: 9, related: [] });
    const lookups = calls.filter((c) => c.path === "/v1/intent/lookup").map((c) => c.query.terms.length);
    expect(lookups).toEqual([20, 5, 20, 5]);
    const fetches = calls.filter((c) => c.method === "POST" && c.path === "/v1/intent/fetches").map((c) => (c.body as { terms: string[] }).terms.length);
    expect(fetches).toEqual([20, 5]);
    // the two chunks were coalesced into the same change: one id per status request
    expect(calls.filter((c) => c.method === "GET" && c.path === "/v1/intent/fetches").map((c) => c.query.ids)).toEqual([["5"]]);
  });

  // Verification D2: every chunk shares ONE collection deadline, and every chunk's collection is
  // requested before the polling starts, so the whole call stays inside the route's maxDuration.
  const lookupRow = (t: string, found: boolean): S["LookupRow"] =>
    found
      ? { term: t, status: "found", search_volume: 5, intent: null, related: [], total_count: 9 }
      : { term: t, status: "missing", search_volume: null, intent: null, related: [], total_count: null };
  const pendingChange = (id: number) => change(id, "pending", { kind: "search", terms: [] });
  const queued = (id: number) => json(202, { data: { status: "queued", change_id: id, terms: [], fresh_terms: [] }, meta: { mode: "crud" } });
  function pendingForever(storedTerm: string | null) {
    let nextChange = 30;
    install({
      "GET /v1/intent/lookup": (c) => env({ country: "kr", items: c.query.terms.map((t) => lookupRow(t, t === storedTerm)) }, missing),
      "POST /v1/intent/fetches": () => queued((nextChange += 1)),
      "GET /v1/intent/fetches": (c) => statuses(...c.query.ids.map((id) => pendingChange(Number(id)))),
    });
  }
  const statusPolls = () => calls.filter((c) => c.method === "GET" && c.path === "/v1/intent/fetches").map((c) => c.query.ids);
  const clock = () => {
    const c = { t: 0 };
    return { c, opts: { sleep: async (ms: number) => void (c.t += ms), now: () => c.t, pollMs: I.COLLECT_POLL_MS, budgetMs: I.COLLECT_BUDGET_MS } };
  };
  const forty = Array.from({ length: I.MAX_SEARCH_TERMS }, (_, i) => `t${i}`);

  it("search: one stored term, the rest pending -> both chunks requested first, one shared deadline, the stored copy (D2)", async () => {
    pendingForever("t5");
    const { c, opts } = clock();
    const groups = await I.loadKeywordSearchGroups(forty, { country: KR }, opts);
    expect(groups).toHaveLength(40);
    expect(groups[5].volume).toBe(5);
    expect(c.t).toBeLessThanOrEqual(I.COLLECT_BUDGET_MS + I.COLLECT_POLL_MS);
    const s = seq();
    expect(s.filter((x) => x === "POST /v1/intent/fetches")).toHaveLength(2);
    expect(s.lastIndexOf("POST /v1/intent/fetches")).toBeLessThan(s.indexOf("GET /v1/intent/fetches"));
    // every poll asks both waiting changes in one request (was one GET per change)
    expect(statusPolls().length).toBeGreaterThan(1);
    expect(new Set(statusPolls().map((ids) => ids.join(",")))).toEqual(new Set(["31,32"]));
  });

  it("search polling: one status request per poll for the waiting changes; a finished change leaves the next poll", async () => {
    let polls = 0;
    install({
      "GET /v1/intent/lookup": (c) => env({ country: "kr", items: c.query.terms.map((t) => lookupRow(t, polls >= 2)) }, polls >= 2 ? fresh : missing),
      "POST /v1/intent/fetches": [() => queued(41), () => queued(42)],
      "GET /v1/intent/fetches": (c) => {
        polls += 1;
        return statuses(...c.query.ids.map((id) => change(Number(id), id === "41" || polls >= 2 ? "applied" : "running", { kind: "search" })));
      },
    });
    const groups = await I.loadKeywordSearchGroups(forty, { country: KR }, noSleep);
    expect(groups).toHaveLength(40);
    expect(groups.every((g) => g.volume === 5)).toBe(true);
    expect(statusPolls()).toEqual([["41", "42"], ["42"]]);
    expect(seq().filter((x) => x === "GET /v1/intent/lookup")).toHaveLength(4);
  });

  it("search: every term missing and never collected -> both chunks requested, then 502 within one budget (D2)", async () => {
    pendingForever(null);
    const { c, opts } = clock();
    await expect(I.loadKeywordSearchGroups(forty, { country: KR }, opts)).rejects.toMatchObject({ status: 502, code: "upstream" });
    expect(seq().filter((x) => x === "POST /v1/intent/fetches")).toHaveLength(2);
    expect(c.t).toBeLessThanOrEqual(I.COLLECT_BUDGET_MS + I.COLLECT_POLL_MS);
  });

  it("search: more than MAX_SEARCH_TERMS unique terms -> 400 before any backend call (D2)", async () => {
    install({});
    await expect(I.loadKeywordSearchGroups([...forty, "t40"], { country: KR }, noSleep)).rejects.toMatchObject({ status: 400, code: "too_many_terms" });
    // duplicates and blanks do not count
    pendingForever("t0");
    await expect(I.loadKeywordSearchGroups([...forty, " t0 ", ""], { country: KR }, clock().opts)).resolves.toHaveLength(40);
    expect(seq()[0]).toBe("GET /v1/intent/lookup");
  });
});

// ── cursor pages (D5) ───────────────────────────────────────────────────────

describe("fetchContextMapPage", () => {
  const ctxRow = (n: number): S["ContextRow"] => ({
    id: `e0000000-0000-4000-8000-00000000000${n}`,
    name: `C${n}`,
    theme_id: "trait",
    theme_name: "특성",
    mention_count: 10 - n,
    utterance_count: 1,
    sentiment: { positive: { num: 1, den: 1 }, negative: { num: 0, den: 1 }, neutral: { num: 0, den: 1 } },
    linked_count: n,
  });

  it("page 0 without cursor, page 2 with its cursor; nextCursor and total carried", async () => {
    install({
      "GET /v1/intent/social/context-map/contexts": (c) =>
        env({ items: [ctxRow(c.query.cursor ? 3 : 1)] }, { mode: "catalog", page: { limit: 2, next_cursor: c.query.cursor ? null : "k1", total: 5 } }),
    });
    const p0 = await I.fetchContextMapPage("contexts", { sort: "mentions", dir: "desc", page: 0, size: 2 });
    expect(p0).toMatchObject({ page: 0, size: 2, total: 5, nextCursor: "k1" });
    expect(calls[0].query).toEqual({ dir: ["desc"], limit: ["2"], sort: ["mentions"] });
    const p2 = await I.fetchContextMapPage("contexts", { sort: "name", dir: "asc", page: 2, size: 2, cursor: "k2", search: "fam" });
    expect(p2).toMatchObject({ page: 2, nextCursor: null });
    expect(calls[1].query).toEqual({ search: ["fam"], dir: ["asc"], cursor: ["k2"], limit: ["2"], sort: ["name"] });
  });

  it("page > 0 without a cursor answers page 0; 409 cursor_stale restarts at page 0", async () => {
    install({
      "GET /v1/intent/social/context-map/combinations": [
        () => env({ items: [], max_co_count: 0 }, { mode: "catalog", page: { limit: 50, next_cursor: null, total: 0 } }),
        () => err(409, "cursor_stale"),
        () => env({ items: [], max_co_count: 0 }, { mode: "catalog", page: { limit: 50, next_cursor: "z", total: 3 } }),
      ],
    });
    const a = await I.fetchContextMapPage("combinations", { sort: "cooccurrence", dir: "desc", page: 3, size: 50 });
    expect(a.page).toBe(0);
    expect(calls[0].query.cursor).toBeUndefined();
    const b = await I.fetchContextMapPage("combinations", { sort: "cooccurrence", dir: "desc", page: 3, size: 50, cursor: "old" });
    expect(b).toMatchObject({ page: 0, nextCursor: "z", total: 3 });
    expect(calls.map((c) => c.query.cursor?.[0] ?? null)).toEqual([null, "old", null]);
  });

  it("detail: non-uuid never sent, 404 -> null", async () => {
    install({ "GET /v1/intent/social/context-map/entities/e0000000-0000-4000-8000-000000000001": () => err(404, "no_active_snapshot") });
    expect(await I.fetchContextEntityDetail("../x")).toBeNull();
    expect(await I.fetchContextEntityDetail("e0000000-0000-4000-8000-000000000001")).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("listTrackedKeywordTabs", () => {
  it("tabs = id + term in the backend order; the latest monthly volume is not asked for (include_volume=false)", async () => {
    const kw = (id: string, term: string): S["TrackedKeyword"] => ({
      keyword_id: id,
      term,
      country_code: null,
      country: "kr",
      created_at: "2026-09-01T00:00:00Z",
      latest_month: null,
      latest_volume: null,
    });
    install({ "GET /v1/intent/keywords": () => env({ items: [kw("k1", "suv"), kw("k2", "ev3")] }, { mode: "crud" }) });
    expect(await I.listTrackedKeywordTabs(PID)).toEqual([
      { id: "k1", label: "suv" },
      { id: "k2", label: "ev3" },
    ]);
    expect(calls[0].query).toEqual({ project_id: [PID], include_volume: ["false"] });
  });
});

describe("listStandardKeywordTabs", () => {
  const kw = (n: number) => ({
    keyword_id: `k${n}`, keyword_ids: [`k${n}`], term: `t${n}`, source_type: "google_keyword", brand_codes: [null], created_at: "x", updated_at: "x",
  });
  // Keyset pages of 500 (backend maximum); the cursor here is the next offset.
  const pages = (total: number) => (c: Call) => {
    const o = Number(c.query.cursor?.[0] ?? 0);
    const n = Math.min(500, total - o);
    const next = o + n < total ? String(o + n) : null;
    return env(
      { source_type: "google_keyword", items: Array.from({ length: n }, (_, i) => kw(o + i)) },
      { mode: "catalog", page: { limit: 500, next_cursor: next, total } },
    );
  };

  it("every managed keyword becomes a tab, past the old 2,000 cap, newest-first order kept", async () => {
    install({ "GET /v1/intent/standard-keywords": pages(2_600) });
    const tabs = await I.listStandardKeywordTabs();
    expect(tabs).toHaveLength(2_600);
    expect([tabs[0], tabs[2_599]]).toEqual([{ id: "k0", label: "t0" }, { id: "k2599", label: "t2599" }]);
    expect(calls).toHaveLength(6);
    expect(calls.every((c) => c.query.limit?.[0] === "500" && c.query.source_type?.[0] === "google_keyword")).toBe(true);
  });

  it("a list beyond the page ceiling fails loudly instead of returning a cut list", async () => {
    install({ "GET /v1/intent/standard-keywords": pages(500 * I.STANDARD_KEYWORD_MAX_PAGES + 1) });
    await expect(I.listStandardKeywordTabs()).rejects.toMatchObject({ status: 500, code: "page_limit_exceeded" });
    expect(calls).toHaveLength(I.STANDARD_KEYWORD_MAX_PAGES);
  });
});

// ── actions ─────────────────────────────────────────────────────────────────

describe("action bodies (error mapping)", () => {
  it("addTrackedKeyword: 201 -> id; 409 duplicate; 422 unknown_country; other 422 -> empty keyword; 403 throws", async () => {
    install({
      "POST /v1/intent/keywords": [
        () => json(201, { data: { keyword_id: "k1", term: "suv", country_code: null, country: "kr", created_at: "x", latest_month: null, latest_volume: null }, meta: { mode: "crud" } }),
        () => err(409, "duplicate_keyword"),
        () => err(422, "unknown_country"),
        () => err(422, "unprocessable"),
        () => err(403, "operator_forbidden"),
        () => err(404, "not_found"),
        () => err(503, "unavailable"),
      ],
    });
    expect(await I.apiAddTrackedKeyword(PID, { term: " suv ", country: "KR" }, msg)).toEqual({ ok: true, value: { id: "k1" } });
    expect(calls[0].body).toEqual({ term: "suv", country: "KR" });
    expect(calls[0].query).toEqual({ project_id: [PID] });
    expect(await I.apiAddTrackedKeyword(PID, { term: "suv" }, msg)).toEqual({ ok: false, error: "m:duplicateKeyword" });
    expect(await I.apiAddTrackedKeyword(PID, { term: "suv", country: "ZZ" }, msg)).toEqual({ ok: false, error: "m:unknownCountry" });
    expect(await I.apiAddTrackedKeyword(PID, { term: "suv" }, msg)).toEqual({ ok: false, error: "m:emptyKeyword" });
    await expect(I.apiAddTrackedKeyword(PID, { term: "suv" }, msg)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(I.apiAddTrackedKeyword(PID, { term: "suv" }, msg)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await I.apiAddTrackedKeyword(PID, { term: "suv" }, msg)).toEqual({ ok: false, error: "m:tryAgain" });
    expect(await I.apiAddTrackedKeyword(PID, { term: "  " }, msg)).toEqual({ ok: false, error: "m:emptyKeyword" });
    expect(calls).toHaveLength(7);
  });

  it("addTrackedKeywords: one items[] request per 100; each row answers what the single add answers for it", async () => {
    // A backend with the documented row rule: 409 for the same term (case) and country, 422 unknown_country,
    // a row checked after the rows before it. A single body answers 201 / an error, an items[] body 200 rows.
    const backend = () => {
      const seen = new Set<string>();
      let n = 0;
      const one = (term: string, country: string | null | undefined): S["TrackedAddResult"] => {
        const e = (status: number, code: string) => ({ status, data: null, error: { code, message: code, details: null } });
        if (country === "ZZ") return e(422, "unknown_country");
        const key = `${term.toLowerCase()}|${country ?? ""}`;
        if (seen.has(key)) return e(409, "duplicate_keyword");
        seen.add(key);
        n += 1;
        const data = { keyword_id: `k${n}`, term, country_code: country ?? null, country: "kr", created_at: "x", latest_month: null, latest_volume: null };
        return { status: 201, data, error: null };
      };
      return (c: Call) => {
        const b = c.body as { term?: string; country?: string | null; items?: { term: string; country?: string | null }[] };
        if (b.items) return env({ items: b.items.map((it) => one(it.term, it.country)) }, { mode: "crud" });
        const r = one(b.term!, b.country);
        return r.data ? json(201, { data: r.data, meta: { mode: "crud" } }) : json(r.status, { error: r.error });
      };
    };
    const inputs = [{ term: " suv " }, { term: "SUV" }, { term: "  " }, { term: "ev3", country: "ZZ" }, { term: "ev3", country: " KR " }, { term: "ev3", country: "KR" }];
    install({ "POST /v1/intent/keywords": backend() });
    const singles = [];
    for (const x of inputs) singles.push(await I.apiAddTrackedKeyword(PID, x, msg));
    expect(calls).toHaveLength(5);
    calls.length = 0;
    install({ "POST /v1/intent/keywords": backend() });
    const batch = await I.apiAddTrackedKeywords(PID, inputs, msg);
    expect(batch).toEqual(singles);
    expect(batch.map((r) => (r.ok ? r.value.id : r.error))).toEqual(["k1", "m:duplicateKeyword", "m:emptyKeyword", "m:unknownCountry", "k2", "m:duplicateKeyword"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toEqual({ project_id: [PID] });
    expect(calls[0].body).toEqual({
      items: [
        { term: "suv", country: null },
        { term: "SUV", country: null },
        { term: "ev3", country: "ZZ" },
        { term: "ev3", country: "KR" },
        { term: "ev3", country: "KR" },
      ],
    });

    // 250 rows -> 100 + 100 + 50; blank only -> no call
    calls.length = 0;
    install({ "POST /v1/intent/keywords": backend() });
    const many = await I.apiAddTrackedKeywords(PID, Array.from({ length: 250 }, (_, i) => ({ term: `t${i}` })), msg);
    expect(many.every((r) => r.ok)).toBe(true);
    expect(calls.map((c) => (c.body as { items: unknown[] }).items.length)).toEqual([100, 100, 50]);
    calls.length = 0;
    expect(await I.apiAddTrackedKeywords(PID, [{ term: " " }], msg)).toEqual([{ ok: false, error: "m:emptyKeyword" }]);
    expect(calls).toHaveLength(0);

    // a failed request: 403 / 404 throw like the single add, a transient failure answers each sent row
    install({ "POST /v1/intent/keywords": () => err(403, "operator_forbidden") });
    await expect(I.apiAddTrackedKeywords(PID, [{ term: "x" }], msg)).rejects.toBeInstanceOf(UnauthorizedError);
    install({ "POST /v1/intent/keywords": () => err(503, "unavailable") });
    expect(await I.apiAddTrackedKeywords(PID, [{ term: "x" }, { term: " " }, { term: "y" }], msg)).toEqual([
      { ok: false, error: "m:tryAgain" },
      { ok: false, error: "m:emptyKeyword" },
      { ok: false, error: "m:tryAgain" },
    ]);
  });

  it("removeTrackedKeywords: dedup, 100 per call, count summed; 0 -> not found; empty -> no call", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `k${i}`);
    install({
      "DELETE /v1/intent/keywords": [
        (c) => env({ removed_count: c.query.ids.length }, { mode: "crud" }),
        (c) => env({ removed_count: c.query.ids.length - 1 }, { mode: "crud" }),
        () => env({ removed_count: 0 }, { mode: "crud" }),
      ],
    });
    expect(await I.apiRemoveTrackedKeywords(PID, [...ids, "k0"], msg)).toEqual({ ok: true, value: { count: 149 } });
    expect(calls.map((c) => c.query.ids.length)).toEqual([100, 50]);
    expect(await I.apiRemoveTrackedKeyword(PID, "k9", msg)).toEqual({ ok: false, error: "m:keywordNotFound" });
    expect(await I.apiRemoveTrackedKeywords(PID, [], msg)).toEqual({ ok: false, error: "m:noKeywordsToRemove" });
    expect(calls).toHaveLength(3);
  });

  it("addCandidate: first id, skipped single add still ok (U10-N5); invalid source never sent", async () => {
    install({
      "POST /v1/intent/candidates": [
        () => json(201, { data: { added_count: 1, skipped_count: 0, candidate_ids: ["c1"] }, meta: { mode: "crud" } }),
        () => json(201, { data: { added_count: 0, skipped_count: 1, candidate_ids: [] }, meta: { mode: "crud" } }),
        () => err(422, "unprocessable"),
      ],
    });
    expect(await I.apiAddCandidate(PID, "google_keyword", "q?", "suv", msg)).toEqual({ ok: true, value: { id: "c1" } });
    expect(calls[0].body).toEqual({ source: "google_keyword", items: [{ text: "q?", source_keyword: "suv" }] });
    expect(await I.apiAddCandidate(PID, "google_keyword", "q?", null, msg)).toEqual({ ok: true, value: { id: "" } });
    expect(await I.apiAddCandidate(PID, "google_keyword", "  ", null, msg)).toEqual({ ok: false, error: "m:emptyPrompt" });
    expect(await I.apiAddCandidate(PID, "manual", "q", null, msg)).toEqual({ ok: false, error: "m:invalidSource" });
    expect(calls).toHaveLength(3);
  });

  it("addCandidates: blanks not sent and not counted as skipped; all blank asks the backend (403 throws first)", async () => {
    install({
      "POST /v1/intent/candidates": [
        () => json(201, { data: { added_count: 1, skipped_count: 1, candidate_ids: ["c1"] }, meta: { mode: "crud" } }),
        () => err(403, "operator_forbidden"),
        () => err(422, "unprocessable"),
      ],
    });
    expect(await I.apiAddCandidates(PID, "social_scraping", [{ text: "a" }, { text: " " }, { text: "b", sourceKeyword: "ctx" }], msg)).toEqual({
      ok: true,
      value: { count: 1, skipped: 1 },
    });
    expect(calls[0].body).toEqual({ source: "social_scraping", items: [{ text: "a", source_keyword: null }, { text: "b", source_keyword: "ctx" }] });
    await expect(I.apiAddCandidates(PID, "social_scraping", [{ text: " " }], msg)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(await I.apiAddCandidates(PID, "social_scraping", [{ text: " " }], msg)).toEqual({ ok: false, error: "m:nothingToSend" });
    expect(await I.apiAddCandidates(PID, "social_scraping", [], msg)).toEqual({ ok: false, error: "m:nothingToSend" });
    expect(calls).toHaveLength(3);
  });

  it("social prompts: generate more / selected / remove", async () => {
    const gp: S["GeneratedPrompt"] = {
      prompt_id: "a0000000-0000-4000-8000-000000000001", seed_key: "l1-x", question: "q?", layer: "L2-condition", funnel_stage: "awareness",
      source_label: "Family", priority: 80, origin: null, batch_no: 2, model: "m", generated_at: "2026-09-01T00:00:00Z", similar_to: null,
      in_candidate_pool: true,
    };
    install({
      "POST /v1/intent/social/prompts": [
        () => env({ prompts: [gp], exhausted: false, skipped_existing: 0 }, { mode: "crud" }),
        () => err(409, "no_active_snapshot"),
        () => err(502, "llm_failed"),
        () => env({ prompts: [], exhausted: false, skipped_existing: 3 }, { mode: "crud" }),
        () => err(422, "unprocessable"),
      ],
      "DELETE /v1/intent/social/prompts": [() => env({ removed_count: 2 }, { mode: "crud" }), () => env({ removed_count: 0 }, { mode: "crud" })],
    });
    expect(await I.apiGenerateMoreSocialPrompts(PID, msg)).toEqual({
      ok: true,
      // A "더 생성" row already in the candidate pool keeps the mark (rows appended after the first render).
      value: { exhausted: false, prompts: [{ id: gp.prompt_id, question: "q?", layer: "L2-condition", funnelStage: "awareness", sourceLabel: "Family", priority: 80, inCandidatePool: true }] },
    });
    expect(calls[0].body).toEqual({ mode: "more" });
    expect(calls[0].headers.get("x-hgh-timeout-ms")).toBe(String(I.SOCIAL_GENERATE_TIMEOUT_MS));
    expect(await I.apiGenerateMoreSocialPrompts(PID, msg)).toEqual({ ok: false, error: "m:contextMapNotReady" });
    expect(await I.apiGenerateMoreSocialPrompts(PID, msg)).toEqual({ ok: false, error: "m:generateFailed" });
    const sel = { contextIds: ["c1", "c1"], conditionIds: ["d1"], combinations: [{ condAId: "d1", condBId: "d2" }], cross: true };
    expect(await I.apiGenerateSelectedSocialPrompts(PID, sel, msg)).toEqual({ ok: true, value: { prompts: [], skippedExisting: 3 } });
    expect(calls[3].headers.get("x-hgh-timeout-ms")).toBe(String(I.SOCIAL_GENERATE_TIMEOUT_MS));
    expect(calls[3].body).toEqual({
      mode: "selected",
      selection: { context_ids: ["c1"], condition_ids: ["d1"], combinations: [{ cond_a_id: "d1", cond_b_id: "d2" }], cross: true },
    });
    expect(await I.apiGenerateSelectedSocialPrompts(PID, { ...sel, contextIds: [] , conditionIds: [], combinations: [] }, msg)).toEqual({ ok: false, error: "m:noSelection" });
    const many = Array.from({ length: 51 }, (_, i) => `c${i}`);
    expect(await I.apiGenerateSelectedSocialPrompts(PID, { ...sel, contextIds: many }, msg)).toEqual({ ok: false, error: "m:tooManySelected" });
    expect(await I.apiRemoveSocialPrompts(PID, ["x", "y", "x"], msg)).toEqual({ ok: true, value: { count: 2 } });
    expect(calls[5].query.ids).toEqual(["x", "y"]);
    expect(await I.apiRemoveSocialPrompts(PID, ["z"], msg)).toEqual({ ok: false, error: "m:promptNotFound" });
    expect(await I.apiRemoveSocialPrompts(PID, [], msg)).toEqual({ ok: false, error: "m:nothingToRemove" });
    expect(calls).toHaveLength(7);
  });

  it("intentActionMessages reads projectDetail.intent.actionErrors", async () => {
    const t = await I.intentActionMessages();
    expect(t("tryAgain")).toBe("t:tryAgain");
  });
});

// ── gates ───────────────────────────────────────────────────────────────────

describe("place gates (U10-N12)", () => {
  const user = (role: "hq" | "region" | "country" | "admin" | "vendor" | "website", menuGroups: ("standard" | "website" | "project" | "admin")[] | null = null) => ({
    id: "u1",
    role,
    menuGroups,
  });

  it("standard keyword screen: STANDARD_VIEWERS and the standard menu", () => {
    expect(I.standardKeywordRouteAllowed(user("hq"))).toBe(true);
    expect(I.standardKeywordRouteAllowed(user("admin"))).toBe(true);
    expect(I.standardKeywordRouteAllowed(user("vendor"))).toBe(false);
    expect(I.standardKeywordRouteAllowed(user("website"))).toBe(false);
    expect(I.standardKeywordRouteAllowed(user("hq", ["project"]))).toBe(false);
  });

  it("context map: the project ROUTES rule", () => {
    expect(I.contextMapRouteAllowed(user("vendor"))).toBe(true);
    expect(I.contextMapRouteAllowed(user("website"))).toBe(false);
    expect(I.contextMapRouteAllowed(user("country", ["standard"]))).toBe(false);
  });

  it("project gate: role/menu 403 before anything, bad id / demo 404, then the source's gate", async () => {
    const legacyYes = vi.fn(async () => true);
    const legacyNo = vi.fn(async () => false);
    expect(await I.projectRouteGate(user("website"), PID, legacyYes)).toEqual({ ok: false, status: 403 });
    expect(await I.projectRouteGate(user("hq", ["standard"]), PID, legacyYes)).toEqual({ ok: false, status: 403 });
    expect(await I.projectRouteGate(user("hq"), "not-a-uuid", legacyYes)).toEqual({ ok: false, status: 404 });
    expect(await I.projectRouteGate(user("hq"), "de300000-0000-4000-8000-000000000001", legacyYes)).toEqual({ ok: false, status: 404 });
    expect(legacyYes).not.toHaveBeenCalled();
    expect(await I.projectRouteGate(user("hq"), PID, legacyNo)).toEqual({ ok: false, status: 404 });
    expect(await I.projectRouteGate(user("hq"), PID, legacyYes)).toEqual({ ok: true });

    vi.stubEnv("HGH_SOURCE_SESSION", "api");
    install({
      [`GET /v1/projects/${PID}`]: [
        () => err(404, "not_found"),
        () => env({ project_id: PID, name: "p", description: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", created_by: PID, brand_code: null, country_code: "KR", ga4_property_id: null, my_role: "viewer", scope_linked: false, scope_project_id: null, domain: null, ai_engines: null, effective_engines: [] }, { mode: "crud" }),
      ],
    });
    expect(await I.projectRouteGate(user("hq"), PID, legacyYes)).toEqual({ ok: false, status: 404 });
    expect(await I.projectRouteGate(user("hq"), PID, legacyNo)).toEqual({ ok: true });
    expect(legacyNo).toHaveBeenCalledTimes(1);
  });

  it("flag: HGH_SOURCE_G6 decides, default legacy", () => {
    expect(I.isIntentApi({})).toBe(false);
    expect(I.isIntentApi({ HGH_SOURCE_G6: "api" })).toBe(true);
    expect(I.isIntentApi({ HGH_SOURCE_G2: "api" })).toBe(false);
  });
});
