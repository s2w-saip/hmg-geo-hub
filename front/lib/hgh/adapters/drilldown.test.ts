import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import type { MentionsPromptLive } from "@/lib/scope/result-adapter";

// Drilldown adapter (unit U6): the route gate (place gate on role and menu groups, the project page
// gate on both session sources), hand-checked row conversions (M-3 brand and signal, C-1 list and
// detail, BG-04), the loaders' queries, cursor reads to the end (cap, cursor_stale restart), and
// the error map (404/403 -> empty list, 422 kept for the route's 400).

vi.mock("@/lib/scope/server", () => ({}));
const { bindHghAuth } = await import("../auth");
const D = await import("./drilldown");

type S = components["schemas"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

// ── gate ────────────────────────────────────────────────────────────────────

describe("drilldownTarget", () => {
  const t = (qs: string) => D.drilldownTarget(new URLSearchParams(qs));
  it("projectId wins, then surface=website, else global; a malformed projectId is refused", () => {
    expect(t(`projectId=${PROJECT}&surface=website`)).toEqual({ surface: "project", projectId: PROJECT });
    expect(t("surface=website")).toEqual({ surface: "website" });
    expect(t("surface=project")).toEqual({ surface: "global" });
    expect(t("")).toEqual({ surface: "global" });
    expect(t("projectId=../members")).toBeNull();
  });
});

describe("drilldownGate: both sources, before any read", () => {
  const legacyYes = vi.fn(async () => true);
  const legacyNo = vi.fn(async () => false);
  const log: URL[] = [];
  beforeEach(() => {
    log.length = 0;
    legacyYes.mockClear();
    legacyNo.mockClear();
    vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
    bindHghAuth({ getAccessToken: async () => TOKEN });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        const url = new URL(String(u));
        log.push(url);
        const ok = url.pathname === `/v1/projects/${PROJECT}`;
        return new Response(
          JSON.stringify(ok ? { data: { project_id: PROJECT, name: "p", created_at: "2026-01-01T00:00:00Z", country_code: "US" }, meta: { mode: "crud" } } : { error: { code: "not_found", message: "x" } }),
          { status: ok ? 200 : 404, headers: { "content-type": "application/json" } },
        );
      }),
    );
  });
  afterEach(() => {
    bindHghAuth(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("place gate: a vendor cannot read the standard or website drilldowns (403), a project one it may", async () => {
    const vendor = { id: "u", role: "vendor" as const, menuGroups: null };
    expect(await D.drilldownGate(vendor, { surface: "global" }, legacyYes)).toEqual({ ok: false, status: 403 });
    expect(await D.drilldownGate(vendor, { surface: "website" }, legacyYes)).toEqual({ ok: false, status: 403 });
    expect(await D.drilldownGate(vendor, { surface: "project", projectId: PROJECT }, legacyYes)).toEqual({ ok: true });
  });
  it("menu groups narrow the role: an hq account limited to projects is refused the standard drilldown", async () => {
    const narrowed = { id: "u", role: "hq" as const, menuGroups: ["project" as const] };
    expect(await D.drilldownGate(narrowed, { surface: "global" }, legacyYes)).toEqual({ ok: false, status: 403 });
    expect(await D.drilldownGate({ ...narrowed, menuGroups: null }, { surface: "global" }, legacyYes)).toEqual({ ok: true });
  });
  it("project, legacy session source: the injected membership check decides (404 when it says no)", async () => {
    const hq = { id: "u", role: "hq" as const, menuGroups: null };
    expect(await D.drilldownGate(hq, { surface: "project", projectId: PROJECT }, legacyNo)).toEqual({ ok: false, status: 404 });
    expect(legacyNo).toHaveBeenCalledWith(PROJECT, hq);
    expect(log).toHaveLength(0);
  });
  it("project, HGH_SOURCE_SESSION=api: GET /v1/projects/{id} decides (404 hides)", async () => {
    vi.stubEnv("HGH_SOURCE_SESSION", "api");
    const hq = { id: "u", role: "hq" as const, menuGroups: null };
    expect(await D.drilldownGate(hq, { surface: "project", projectId: PROJECT }, legacyNo)).toEqual({ ok: true });
    expect(await D.drilldownGate(hq, { surface: "project", projectId: "11111111-1111-4111-8111-111111111111" }, legacyYes)).toEqual({ ok: false, status: 404 });
    expect(legacyYes).not.toHaveBeenCalled();
  });
  it("demo project: admin only (before any membership lookup)", async () => {
    const { DEMO_PROJECT_ID } = await import("@/lib/demo");
    const t = { surface: "project" as const, projectId: DEMO_PROJECT_ID };
    expect(await D.drilldownGate({ id: "u", role: "hq", menuGroups: null }, t, legacyYes)).toEqual({ ok: false, status: 404 });
    expect(legacyYes).not.toHaveBeenCalled();
    expect(await D.drilldownGate({ id: "u", role: "admin", menuGroups: null }, t, legacyYes)).toEqual({ ok: true });
  });
});

describe("U6 verification D3: api project gate answers (HGH_SOURCE_SESSION=api)", () => {
  const replies: { status: number; code?: string }[] = [];
  let calls = 0;
  let refreshed = 0;
  beforeEach(() => {
    replies.length = 0;
    calls = 0;
    refreshed = 0;
    vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
    vi.stubEnv("HGH_SOURCE_SESSION", "api");
    bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: async () => (refreshed++, TOKEN) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        const r = replies.shift() ?? { status: 200 };
        const body = r.status === 200
          ? { data: { project_id: PROJECT, name: "p", created_at: "2026-01-01T00:00:00Z", country_code: "US" }, meta: { mode: "crud" } }
          : { error: { code: r.code, message: "x" } };
        return new Response(JSON.stringify(body), { status: r.status, headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    bindHghAuth(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const hq = { id: "u", role: "hq" as const, menuGroups: null };
  const t = { surface: "project" as const, projectId: PROJECT };
  const legacy = vi.fn(async () => true);

  it("403 owner_only / other -> 404 (hidden); 403 role_forbidden / menu_forbidden -> 403", async () => {
    replies.push({ status: 403, code: "owner_only" }, { status: 403, code: "operator_forbidden" }, { status: 403, code: "role_forbidden" }, { status: 403, code: "menu_forbidden" });
    expect(await D.drilldownGate(hq, t, legacy)).toEqual({ ok: false, status: 404 });
    expect(await D.drilldownGate(hq, t, legacy)).toEqual({ ok: false, status: 404 });
    expect(await D.drilldownGate(hq, t, legacy)).toEqual({ ok: false, status: 403 });
    expect(await D.drilldownGate(hq, t, legacy)).toEqual({ ok: false, status: 403 });
    expect(legacy).not.toHaveBeenCalled();
  });
  it("401 token_expired refreshes once and retries (retryOn401)", async () => {
    replies.push({ status: 401, code: "token_expired" });
    expect(await D.drilldownGate(hq, t, legacy)).toEqual({ ok: true });
    expect([calls, refreshed]).toEqual([2, 1]);
  });
  it("5xx is thrown as HghApiError; gateErrorResponse maps it (and 401) without the backend message", async () => {
    replies.push({ status: 500, code: "internal" });
    const e = await D.drilldownGate(hq, t, legacy).catch((x: unknown) => x);
    const res = D.gateErrorResponse(e);
    expect([res.status, await res.json()]).toMatchObject([500, { error: { code: "internal" } }]);
    const { HghApiError } = await import("../errors");
    const r401 = D.gateErrorResponse(new HghApiError(401, "token_expired"));
    expect([r401.status, await r401.json()]).toEqual([401, { error: "unauthorized" }]);
    expect(() => D.gateErrorResponse(new Error("boom"))).toThrow("boom");
  });
});

// ── conversions ─────────────────────────────────────────────────────────────

const ref = (o: Partial<S["app__features__analytics__mentions__prompts__schemas__AnswerRef"]> = {}) => ({
  engine: "chatgpt",
  job_id: "j1",
  measured_at: "2026-09-14T03:00:00Z",
  position: 2,
  region: "US",
  runs: 3,
  value: 4,
  terms: { brand: ["Hyundai", "현대"], model: ["Ioniq 5"] },
  ...o,
});
const item = (o: Partial<D.ApiPromptItem> = {}): D.ApiPromptItem => ({
  prompt_id: "p1",
  prompt_text: "best EV",
  count: 7,
  share: { num: 7, den: 40 },
  funnel_code: "awareness",
  providers: ["claude-web", "chatgpt", "claude-sonnet"],
  answers: [ref()],
  ...o,
});

describe("prompt rows", () => {
  it("brand mode: share 7/40 = 17.5, engine labels deduped (Claude once), terms as highlights (BG-18)", () => {
    const expected: MentionsPromptLive = {
      id: "p1",
      promptText: "best EV",
      mentions: 7,
      share: 17.5,
      funnelStage: "awareness",
      providers: ["Claude", "ChatGPT"],
      answers: [
        { jobId: "j1", provider: "ChatGPT", region: "US", mentionCount: 4, position: 2, highlights: { brand: ["Hyundai", "현대"], model: ["Ioniq 5"] }, measuredAt: "2026-09-14T03:00:00Z", runs: 3 },
      ],
    };
    expect(D.toMentionsPrompt(item(), "brand")).toEqual(expected);
  });
  it("signal mode keeps the legacy bare reference (position null, runs 1, no date, no highlights)", () => {
    expect(D.toMentionsPrompt(item({ answers: [ref({ terms: null })] }), "signal").answers).toEqual([
      { jobId: "j1", provider: "ChatGPT", region: "US", mentionCount: 4, position: null, highlights: { brand: [], model: [] }, measuredAt: null, runs: 1 },
    ]);
  });
  it("prompt text null -> '' (legacy map miss); no terms -> empty highlights", () => {
    const r = D.toMentionsPrompt(item({ prompt_text: null, answers: [ref({ terms: null })] }), "brand");
    expect([r.promptText, r.answers[0].highlights]).toEqual(["", { brand: [], model: [] }]);
  });
});

describe("citation rows", () => {
  const row: S["DomainRow"] = {
    category: { category_key: 1, name: "Official HMG", slug: "officialHmg" },
    citations: 30,
    citing_answers: 12,
    citing_prompts: 9,
    competitor_brand: null,
    coverage: { num: 12, den: 80 },
    domain: "hyundai.com",
    is_own: true,
    is_social: false,
    is_target: false,
    match_rank: 1,
    own_citations: 30,
    rank: 1,
    share: { num: 30, den: 120 },
    skey: "hyundai.com",
  };
  it("list row: legacy category label from the slug, prompts = citing_prompts (BG-24), drilldown empty until opened", () => {
    expect(D.toCitationDomain(row)).toEqual({
      domain: "hyundai.com",
      citations: 30,
      share: 25,
      prompts: 9,
      coverageRate: 15,
      urls: [],
      promptList: [],
      isOurs: true,
      category: "Official (HMG)",
      subcategory: null,
      skey: "hyundai.com",
    });
    expect(D.categoryLabel({ category_key: 99, name: "New kind", slug: "newKind" })).toBe("New kind");
    expect(D.categoryLabel(null)).toBeNull();
  });
  it("detail: URLs by citations (title fallback = display url, BG-23 prompt text), prompts with bare refs", () => {
    const d = D.toDomainDrilldown({
      citations: 30,
      own_citations: 30,
      prompt_total: 2,
      url_total: 2,
      source: { category: null, competitor_brand: null, domain: "hyundai.com", is_social: false, skey: "hyundai.com" },
      urls: [
        { url: "https://hyundai.com/us/a", title: null, citations: 5, engines: ["gemini"], prompt_text: null, country: "US" },
        { url: "https://hyundai.com/us/b", title: "B", citations: 9, engines: ["claude-web", "claude-opus", "chatgpt"], prompt_text: "best EV", country: null },
      ],
      prompts: [
        { prompt_id: "p1", text: "best EV", funnel: null, citations: 9, own_citations: 9, engines: ["chatgpt"], answers: [{ job_id: "j9", engine: "chatgpt", country: "US", citations: 2 }] },
      ],
    });
    expect(d.urls.map((x) => [x.url, x.title, x.count, x.aiProvider, x.promptText, x.country])).toEqual([
      ["https://hyundai.com/us/b", "B", 9, "Claude, ChatGPT", "best EV", null],
      ["https://hyundai.com/us/a", "hyundai.com/us/a", 5, "Gemini", "", "US"],
    ]);
    expect(d.promptList).toEqual([
      {
        id: "p1",
        promptText: "best EV",
        funnelStage: null,
        citations: 9,
        ownedCitations: 9,
        providers: ["ChatGPT"],
        answers: [{ jobId: "j9", provider: "ChatGPT", region: "US", mentionCount: 2, position: null, highlights: { brand: [], model: [] }, measuredAt: null, runs: 1 }],
      },
    ]);
  });
  it("unmeasured row -> legacy UnmeasuredPrompt", () => {
    expect(D.toUnmeasuredPrompt({ prompt_id: "c1", scope_prompt_id: "s1", text: null, list_type: "L", depth1: "d1", depth2: null, funnel_stage: "f" })).toEqual({
      id: "c1",
      text: "",
      listType: "L",
      depth1: "d1",
      depth2: null,
      funnelStage: "f",
    });
  });
});

// ── loaders ─────────────────────────────────────────────────────────────────

describe("loaders", () => {
  const log: URL[] = [];
  let handler: (u: URL) => { status?: number; body: unknown } = () => ({ body: {} });
  beforeEach(() => {
    log.length = 0;
    vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
    bindHghAuth({ getAccessToken: async () => TOKEN });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        const url = new URL(String(u));
        log.push(url);
        const r = handler(url);
        return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    bindHghAuth(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const page = (items: unknown[], next: string | null) => ({
    body: { data: { items, mode: "brand", target: {}, total: 40 }, meta: { mode: "cumulative", page: { limit: 200, next_cursor: next } } },
  });
  const ctx = { surface: "global" as const, scope: null };

  it("brand prompts: mention_brand, terms, 200 per page, 50 references, read to the end by cursor", async () => {
    handler = (u) => (u.searchParams.get("cursor") ? page([item({ prompt_id: "p2" })], null) : page([item()], "Y3Vyc29yMQ"));
    const rows = await D.loadBrandMentionPrompts({ region: ["US"] }, ctx, { mentionBrand: "Toyota" });
    expect(rows.map((r) => r.id)).toEqual(["p1", "p2"]);
    const q = log[0].searchParams;
    expect([q.get("mode"), q.get("mention_brand"), q.get("terms"), q.get("limit"), q.get("answers_limit"), q.getAll("country")]).toEqual([
      "brand",
      "Toyota",
      "true",
      "200",
      "50",
      ["US"],
    ]);
    expect(log[1].searchParams.get("cursor")).toBe("Y3Vyc29yMQ");
  });
  it("own targets (BG-17): own=true, plus own_brand_code for a split row; never mention_brand", async () => {
    handler = () => page([], null);
    await D.loadBrandMentionPrompts({}, ctx, { own: true });
    await D.loadBrandMentionPrompts({}, ctx, { own: true, ownBrandCode: "Kia" });
    expect(log.map((u) => [u.searchParams.get("own"), u.searchParams.get("own_brand_code"), u.searchParams.get("mention_brand")])).toEqual([
      ["true", null, null],
      ["true", "Kia", null],
    ]);
  });
  it("brand_not_found (404) or hidden (403) -> []; 422 is thrown (route answers 400)", async () => {
    handler = () => ({ status: 404, body: { error: { code: "brand_not_found", message: "x" } } });
    expect(await D.loadBrandMentionPrompts({}, ctx, { mentionBrand: "Nope" })).toEqual([]);
    handler = () => ({ status: 403, body: { error: { code: "role_forbidden", message: "x" } } });
    expect(await D.loadSignalPrompts({}, ctx, "positive")).toEqual([]);
    handler = () => ({ status: 422, body: { error: { code: "invalid_value", message: "x" } } });
    const err = await D.loadBrandMentionPrompts({}, ctx, { mentionBrand: "X" }).catch((e) => e);
    expect(D.isBadFilterError(err)).toBe(true);
  });
  it("cursor_stale (409) restarts from the first page once", async () => {
    let calls = 0;
    handler = (u) => {
      calls += 1;
      if (u.searchParams.get("cursor") && calls === 2) return { status: 409, body: { error: { code: "cursor_stale", message: "x" } } };
      return u.searchParams.get("cursor") ? page([item({ prompt_id: "p2" })], null) : page([item()], "Y3Vyc29yMQ");
    };
    expect((await D.loadBrandMentionPrompts({}, ctx, { mentionBrand: "Toyota" })).map((r) => r.id)).toEqual(["p1", "p2"]);
    expect(log.map((u) => u.searchParams.get("cursor"))).toEqual([null, "Y3Vyc29yMQ", null, "Y3Vyc29yMQ"]);
  });
  it("the cap: at most MAX_PAGES requests, then the list read so far", async () => {
    let n = 0;
    handler = () => page([item({ prompt_id: `p${++n}` })], `Y3Vy${n}`);
    const rows = await D.loadBrandMentionPrompts({}, ctx, { mentionBrand: "Toyota" });
    expect([rows.length, log.length]).toEqual([D.MAX_PAGES, D.MAX_PAGES]);
  });
  it("signal: one page of 50 with 6 references, no terms; project surface carries project_id and cf", async () => {
    handler = () => page([item()], null);
    const field = "0b3f1c2d-0000-4000-8000-000000000001";
    await D.loadSignalPrompts({ customFieldFilters: { [field]: ["x"] } }, { surface: "project", projectId: PROJECT, scope: null, customFields: { [field]: ["x"] } }, "negative");
    const q = log[0].searchParams;
    expect([q.get("mode"), q.get("signal"), q.get("limit"), q.get("answers_limit"), q.get("terms"), q.get("project_id"), q.getAll(`cf.${field}`)]).toEqual([
      "signal",
      "negative",
      "50",
      "6",
      null,
      PROJECT,
      ["x"],
    ]);
  });
  it("citation list (mention_brand, 200 per page) and detail (urls 10, prompts 100, answers 20)", async () => {
    handler = (u) =>
      u.pathname === "/v1/citations/domains"
        ? { body: { data: { items: [], competitor_totals: [], summary: { answers_den: 0, own_share: { num: 0, den: 0 }, total_citations: 0, unique_sources: 0 } }, meta: { mode: "cumulative", page: { limit: 200, next_cursor: null } } } }
        : { body: { data: { citations: 0, own_citations: 0, prompts: [], urls: [], source: { category: null, domain: "a", is_social: false, skey: "a/b" } }, meta: { mode: "cumulative" } } };
    await D.loadBrandCitationDomains({}, { surface: "website", scope: null }, "Kia");
    await D.loadBrandCitationDetail({}, { surface: "website", scope: null }, "Kia", "linkedin.com/hyundai-motor-group");
    expect([log[0].searchParams.get("mention_brand"), log[0].searchParams.get("limit"), log[0].searchParams.get("surface")]).toEqual(["Kia", "200", "website"]);
    expect(log[1].pathname).toBe("/v1/citations/domains/linkedin.com%2Fhyundai-motor-group");
    expect([log[1].searchParams.get("urls_limit"), log[1].searchParams.get("prompts_limit"), log[1].searchParams.get("answers_limit")]).toEqual(["10", "100", "20"]);
  });
  it("unmeasured (BG-04): total = meta.page.total (before the 200 cap)", async () => {
    handler = () => ({
      body: {
        data: { items: [{ prompt_id: "c1", scope_prompt_id: "s1", text: "t", list_type: null, depth1: null, depth2: null, funnel_stage: null }] },
        meta: { mode: "snapshot", page: { limit: 200, next_cursor: null, total: 350 } },
      },
    });
    const r = await D.loadUnmeasuredPrompts({ region: ["US"] }, { surface: "global", scope: null });
    expect([r.total, r.rows.length, log[0].searchParams.get("limit"), log[0].searchParams.getAll("country")]).toEqual([350, 1, "200", ["US"]]);
  });
});

export const KNOWN_DIFF = [
  { id: "U6-N9", reason: "signal list = top 50 with 6 references; share over every prompt" },
  { id: "U6-N10", reason: "domain detail capped at 10 URLs, 100 prompts, 20 references" },
  { id: "U6-N11", reason: "project citation tab reads the project (legacy: standard root)" },
  { id: "U6-N12", reason: "competitive rows only on both sides (C-G11 confirmed by drilldown.parity.test.ts)" },
  { id: "U6-N13", reason: "unmeasured rows carry the surface's prompt id" },
  { id: "U6-N14", reason: "brand reference value = the brand's answer total (legacy: first row)" },
  { id: "U6-N15", reason: "brand reference position = rank among competitive brands (legacy: avg_position)" },
  { id: "U6-N16", reason: "signal list funnel = catalog funnel (legacy: scope_prompts.funnel_stage)" },
];

describe("known differences are documented in the adapter header", () => {
  const src = readFileSync(fileURLToPath(new URL("./drilldown.ts", import.meta.url)), "utf8");
  it.each(KNOWN_DIFF.map((k) => [k.id] as const))("%s", (id) => expect(src).toContain(id));
});
