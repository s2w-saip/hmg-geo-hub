import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as Repo from "@/lib/db/repositories/qa-review";
import type * as T from "@/lib/qa/types";
import type { components } from "../api-types";

// Unit tests of the QA console adapter (U12): shape conversions, the raw_data_qa cookie relay in
// both directions, and the error mapping. The legacy <-> api comparison on real data runs in
// qa.parity.test.ts (legacy repository on PGlite).

const st = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Headers(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (st.cookies.has(n) ? { name: n, value: st.cookies.get(n)! } : undefined),
    getAll: () => [...st.cookies].map(([name, value]) => ({ name, value })),
    delete: () => {
      throw new Error("read-only cookies");
    },
  }),
  headers: async () => st.headers,
}));

const qa = await import("./qa");
const { qaApiSource } = await import("@/lib/qa/auth");
const { sourceGroupFor } = await import("../client");

type S = components["schemas"];

// ── compile-time: the legacy repository shapes stay assignable to lib/qa/types ──
type Assert<X extends true> = X;
export type TypeChecks = [
  Assert<Repo.QaAnswerDetail extends T.QaAnswerDetail ? true : false>,
  Assert<Repo.QaCitationGranule extends T.QaCitationGranule ? true : false>,
  Assert<Repo.QaAcrGranule extends T.QaAcrGranule ? true : false>,
  Assert<Repo.QaMentionGranule extends T.QaMentionGranule ? true : false>,
  Assert<Repo.QaProgress extends T.QaProgress ? true : false>,
  Assert<Repo.QaSectionKey extends T.QaSectionKey ? (T.QaSectionKey extends Repo.QaSectionKey ? true : false) : false>,
];

// ── fixtures ────────────────────────────────────────────────────────────────

const JOB = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";
/** Cookie in the backend format (base64url JSON payload + "." + signature). Built, never a real value. */
const COOKIE = `${Buffer.from(JSON.stringify({ sessionId: SID, name: "kim", issuedAt: 1 })).toString("base64url")}.c2lnbmF0dXJl`;

const meta = (page?: S["Page"]): S["Meta"] => ({ mode: "qa", ...(page ? { page } : {}) }) as S["Meta"];
const env = (data: unknown, page?: S["Page"]) => ({ data, meta: meta(page) });

interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}
let seen: Seen[] = [];

function respondWith(fn: (s: Seen) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const s: Seen = {
        url: new URL(String(input)),
        method: String(init.method ?? "GET"),
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      seen.push(s);
      return fn(s);
    }),
  );
}

const ok = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(env(data)), { status, headers: { "content-type": "application/json", ...(headers ?? {}) } });

const apiError = (status: number, code: string, details?: unknown) =>
  new Response(JSON.stringify({ error: { code, message: code, details } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Body text with the BOM kept (Response.text() strips a leading BOM by spec). */
const bytesText = async (res: Response) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());

const req = (url: string, init?: { method?: string; body?: unknown }) =>
  new NextRequest(new URL(url, "https://front.test"), {
    method: init?.method ?? "GET",
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body), headers: { "content-type": "application/json" } } : {}),
  });

beforeEach(() => {
  seen = [];
  st.cookies = new Map();
  st.headers = new Headers();
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  vi.stubEnv("HGH_RELAY_SECRET", "");
  vi.stubEnv("RAW_DATA_QA_ENABLED", "1");
  vi.stubEnv("NODE_ENV", "production");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── flag ────────────────────────────────────────────────────────────────────

describe("source flag (D8)", () => {
  it("qa is group G7 and defaults to legacy", () => {
    expect(sourceGroupFor("qa")).toBe("G7");
    vi.stubEnv("HGH_SOURCE_G7", "");
    expect(qaApiSource()).toBe(false);
    vi.stubEnv("HGH_SOURCE_G7", "legacy");
    expect(qaApiSource()).toBe(false);
    vi.stubEnv("HGH_SOURCE_G7", "api");
    expect(qaApiSource()).toBe(true);
    vi.stubEnv("HGH_SOURCE_G7", "API ");
    expect(qaApiSource()).toBe(true);
  });
});

// ── shape conversions ───────────────────────────────────────────────────────

const listRow: S["QaListRow"] = {
  job_id: JOB,
  prompt_text: "best suv",
  surface: "global",
  brand: ["Hyundai", "Kia"],
  country: "US",
  engine: null,
  lang: "en",
  measured_at: "2026-09-20T01:02:03.456789+00:00",
  job_status: "completed",
  dropped: false,
  mention_count: 2,
  citation_count: 1,
  note_count: 0,
  review_status: "issue",
  reviewer_name: "kim",
  lock: { job_id: JOB, session_id: SID, reviewer_name: "park", acquired_at: "2026-09-20T01:00:00+00:00", heartbeat_at: "2026-09-20T01:00:30+00:00" },
};

const ratio = (num: number, den: number) => ({ num, den });

function detail(over: Partial<S["QaAnswerDetail"]> = {}): S["QaAnswerDetail"] {
  return {
    answer: {
      job_id: JOB,
      surface: "website",
      brand: [],
      country: "GB",
      engine: "gemini",
      lang: "en",
      round_date: "2026-09-17",
      measured_at: "2026-09-20T01:00:00+00:00",
      job_status: "completed",
      dropped: false,
      served: true,
      status: "completed",
      analysis_status: "done",
      model_slug: "m",
      answer_text: "text",
    },
    prompt: {
      prompt_id: "33333333-3333-4333-8333-333333333333",
      text: "q",
      kind: "k",
      lang: "en",
      funnel: "consideration-code",
      regions: ["GB"],
      is_korean: false,
      catalog: null,
    },
    mentions: [
      { ord: 2, entity_id: null, display_name: "B", entity_type: null, mention_count: 1, avg_position: null, surfaces: null, brand_rollup_entity_id: null, rollup_parent_name: null, registry_role: null, is_own: false, is_excluded: false, sentiment_positive: 0, sentiment_neutral: 0, sentiment_negative: 0, sentiment_mixed: 0, type_mention: 1, type_recommendation: 0, type_comparison: 0, type_definition: 0, type_final_choice: 0 },
      { ord: 1, entity_id: "44444444-4444-4444-8444-444444444444", display_name: "A", entity_type: "brand", mention_count: 3, avg_position: 1, surfaces: ["answer"], brand_rollup_entity_id: null, rollup_parent_name: null, registry_role: "own", is_own: true, is_excluded: false, sentiment_positive: 1, sentiment_neutral: 2, sentiment_negative: 0, sentiment_mixed: 0, type_mention: 3, type_recommendation: 1, type_comparison: 0, type_definition: 0, type_final_choice: 0 },
    ],
    citations: [
      { ord: 2, target_key: `${JOB}:2`, ref_index: null, url: "https://r.test/x", title: null, host: "r.test", domain: "r.test", stored_category: "Other", override_category: "communityForums", effective_category: "communityForums", url_norm: "r.test/x", url_base_norm: "r.test" },
      { ord: 1, target_key: `${JOB}:1`, ref_index: 1, url: "https://h.test/", title: "H", host: "h.test", domain: "h.test", stored_category: "Official (HMG)", override_category: null, effective_category: "Official (HMG)", url_norm: "h.test", url_base_norm: "h.test" },
    ],
    acr: [
      {
        acr_cell_key: 501,
        round_date: "2026-09-17",
        planned: 4,
        valid_turn1: 4,
        valid_acr: 0,
        co_single: 1,
        co_conditional: 0,
        co_generic: 0,
        co_off_shortlist: 0,
        co_unresolved: 0,
        co_none: 3,
        is_rep: true,
        choices: [
          { level: 2, entity_id: "55555555-5555-4555-8555-555555555555", name: "Tucson", brand: "Hyundai", parent_brand: "Hyundai", entity_type: "model", appearance: 1, choice: 0, cond_choice: 0, off_shortlist: 0, unresolved: 0, generic: 0, appearance_rate: ratio(1, 4), acr: ratio(0, 0), overall_choice_share: ratio(0, 0) },
          { level: 1, entity_id: null, name: null, brand: "Hyundai", parent_brand: null, entity_type: "brand", appearance: 2, choice: 0, cond_choice: 0, off_shortlist: 0, unresolved: 0, generic: 0, appearance_rate: ratio(2, 4), acr: ratio(0, 0), overall_choice_share: ratio(0, 0) },
        ],
      },
    ],
    derived: { anchor: null, drop: { reason: null, dropped_at: "2026-09-21T00:00:00+00:00", source_measured_at: null } },
    ...over,
  };
}

describe("shape conversions", () => {
  it("list row: surface vocabulary, brand join, engine null, ISO time, lock", () => {
    expect(qa.toAnswerListRow(listRow)).toEqual({
      jobId: JOB,
      promptText: "best suv",
      surface: "standard",
      brand: "Hyundai, Kia",
      country: "US",
      engine: "",
      lang: "en",
      measuredAt: "2026-09-20T01:02:03.456Z",
      mentionCount: 2,
      citationCount: 1,
      noteCount: 0,
      reviewStatus: "issue",
      reviewerName: "kim",
      lock: { reviewerName: "park" },
    });
    expect(qa.toAnswerListRow({ ...listRow, brand: [], surface: "website", lock: null })).toMatchObject({
      brand: null,
      surface: "website",
      lock: null,
    });
  });

  it("detail: legacy order, citation note key and taxonomy names, ACR rows, drop reason", () => {
    const d = qa.toSerializedDetail(detail());
    expect(d.answer).toMatchObject({ jobId: JOB, runId: null, region: null, target: "gemini", surface: "website", brand: null });
    expect(d.prompt.funnelStage).toBe("consideration-code");
    expect(d.mentions.map((m) => [m.entityId, m.brand])).toEqual([
      ["44444444-4444-4444-8444-444444444444", "A"],
      ["ord:2", "B"],
    ]);
    // ref_index NULLS LAST; id = ord; note key 'job_id:ord'; override slug shown as its taxonomy name
    expect(d.citations.map((c) => [c.id, c.refIndex, c.targetKey, c.overrideCategory, c.effectiveCategory])).toEqual([
      [1, 1, `${JOB}:1`, null, "Official (HMG)"],
      [2, null, `${JOB}:2`, "Community & Forums", "Community & Forums"],
    ]);
    // acr DESC NULLS LAST (both null here) then name; level -> legacy rollup_level; den 0 -> null
    expect(d.acr.map((r) => [r.promptRunId, r.entityId, r.brand, r.rollupLevel, r.appearanceRate, r.acr])).toEqual([
      ["acr_cell:501", "level1:1", "Hyundai", "brand", 0.5, null],
      ["acr_cell:501", "55555555-5555-4555-8555-555555555555", "Tucson", "product", 0.25, null],
    ]);
    expect(d.derived).toEqual({
      anchor: null,
      drop: { reason: "", droppedAt: "2026-09-21T00:00:00.000Z", sourceMeasuredAt: null },
    });
  });

  it("detail: picks up run_id, region and prompt_run_id once the backend adds them (core requests R1, R2)", () => {
    const base = detail();
    const d = qa.toSerializedDetail({
      ...base,
      answer: { ...base.answer, run_id: "66666666-6666-4666-8666-666666666666", region: "gb-site" } as S["QaAnswerHead"],
      acr: [{ ...base.acr[0], prompt_run_id: "77777777-7777-4777-8777-777777777777" } as S["QaAcrCell"]],
    });
    expect([d.answer.runId, d.answer.region]).toEqual(["66666666-6666-4666-8666-666666666666", "gb-site"]);
    expect(new Set(d.acr.map((r) => r.promptRunId))).toEqual(new Set(["77777777-7777-4777-8777-777777777777"]));
  });

  it("detail: catalog funnel stage wins over the prompt funnel code (appendix F)", () => {
    const base = detail();
    const catalog: S["QaPromptCatalog"] = {
      brand: "Hyundai", brand_presence: "branded", list_type: "L", depth1: "d1", depth2: null, depth3: null, depth4: null,
      funnel_stage: "Consideration", kind: "K", prompt_type: "P", category: "C",
    };
    const d = qa.toSerializedDetail({ ...base, prompt: { ...base.prompt, catalog } });
    expect(d.prompt.funnelStage).toBe("Consideration");
    expect(d.prompt.catalog).toEqual({
      brand: "Hyundai", brandPresence: "branded", listType: "L", depth1: "d1", depth2: null, depth3: null, depth4: null,
      funnelStage: "Consideration", kind: "K", promptType: "P", category: "C",
    });
  });

  it("review: null section flags dropped, reviewedAt = updated_at; null stays null", () => {
    expect(
      qa.toSerializedReview({
        job_id: JOB,
        status: "issue",
        section_flags: { answer: "ok", citations: "issue", acr: null },
        reviewer_name: "kim",
        session_id: null,
        reviewed_at: "2026-09-20T00:00:00+00:00",
        updated_at: "2026-09-21T00:00:00.5+00:00",
      }),
    ).toEqual({ status: "issue", sectionFlags: { answer: "ok", citations: "issue" }, reviewerName: "kim", reviewedAt: "2026-09-21T00:00:00.500Z" });
    expect(qa.toSerializedReview(null)).toBeNull();
  });

  it("note JSON keeps the legacy keys except sessionId (not exposed by the API)", () => {
    const n: S["QaNote"] = {
      note_id: "88888888-8888-4888-8888-888888888888", job_id: JOB, target_kind: "citation", target_key: `${JOB}:1`,
      target_label: "#1 h.test", severity: "info", body: "b", reviewer_name: "kim",
      created_at: "2026-09-20T01:00:00+00:00", resolved_at: null, resolved_by: null,
    };
    expect(qa.toNoteJson(n)).toEqual({
      id: n.note_id, jobId: JOB, targetKind: "citation", targetKey: `${JOB}:1`, targetLabel: "#1 h.test",
      severity: "info", body: "b", reviewerName: "kim", createdAt: "2026-09-20T01:00:00.000Z", resolvedAt: null, resolvedBy: null,
    });
  });
});

// ── cookie relay (design 1.4) ────────────────────────────────────────────────

const sessionOut = { session_id: SID, reviewer_name: "kim", started_at: "2026-09-20T01:00:00+00:00", last_seen_at: "2026-09-20T01:00:00+00:00" };
const QA_SET = `raw_data_qa=${COOKIE}; HttpOnly; Path=/; SameSite=lax; Secure`;

function withSetCookies(res: Response, lines: string[]): Response {
  const h = new Headers(res.headers);
  for (const l of lines) h.append("set-cookie", l);
  return new Response(res.body, { status: res.status, headers: h });
}

describe("QA cookie relay", () => {
  it("login: no credentials upstream, viewer IP relayed with the secret, only raw_data_qa comes back", async () => {
    vi.stubEnv("HGH_RELAY_SECRET", "relay-secret-for-tests-0123");
    st.headers = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
    st.cookies.set("sb-proj-auth-token", "base64-abc");
    respondWith(() =>
      withSetCookies(ok(sessionOut, 201), [QA_SET, "sb-proj-auth-token=planted; Path=/; HttpOnly; SameSite=lax; Secure", "AWSALB=lb; Path=/"]),
    );
    const res = await qa.qaApiRoutes.sessionPost(req("/api/qa/session", { method: "POST", body: { name: " kim ", password: "pw" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "kim" });
    const set = res.headers.getSetCookie();
    expect(set).toEqual([QA_SET]); // the planted Supabase and load-balancer cookies are dropped
    const [call] = seen;
    expect([call.method, call.url.pathname]).toEqual(["POST", "/v1/qa/sessions"]);
    expect(call.body).toEqual({ name: " kim ", password: "pw" });
    expect(call.headers.get("cookie")).toBeNull();
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.headers.get("x-hgh-client-ip")).toBe("203.0.113.7");
    expect(call.headers.get("x-hgh-relay-secret")).toBe("relay-secret-for-tests-0123");
  });

  it("login: a raw_data_qa cookie in another shape (Domain attribute) is refused and the login fails visibly", async () => {
    respondWith(() => withSetCookies(ok(sessionOut, 201), [`raw_data_qa=${COOKIE}; Domain=evil.test; HttpOnly; Path=/; SameSite=lax; Secure`]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await qa.qaApiRoutes.sessionPost(req("/api/qa/session", { method: "POST", body: { name: "kim", password: "pw" } }));
    expect(res.status).toBe(502);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(warn.mock.calls.flat().join(" ")).toContain("Domain attribute");
    expect(error).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls) + JSON.stringify(error.mock.calls)).not.toContain(COOKIE);
  });

  it("login: non-string name -> '' and over-long password -> '' (legacy bad-name / bad-credentials order kept)", async () => {
    respondWith(() => apiError(422, "bad_name"));
    await qa.qaApiRoutes.sessionPost(req("/api/qa/session", { method: "POST", body: { name: 7, password: "x".repeat(201) } }));
    expect(seen[0].body).toEqual({ name: "", password: "" });
  });

  it("QA calls carry only Cookie: raw_data_qa=<value> (other browser cookies and Authorization never forwarded)", async () => {
    st.cookies.set("raw_data_qa", COOKIE);
    st.cookies.set("sb-proj-auth-token", "base64-abc");
    respondWith(() => ok({ job_id: JOB, session_id: SID, reviewer_name: "kim", acquired_at: "2026-09-20T01:00:00+00:00", heartbeat_at: "2026-09-20T01:00:00+00:00" }));
    const res = await qa.qaApiRoutes.lockPost(req("/api/qa/lock", { method: "POST", body: { jobId: JOB } }));
    expect(res.status).toBe(200);
    expect(seen[0].headers.get("cookie")).toBe(`raw_data_qa=${COOKIE}`);
    expect(seen[0].headers.get("authorization")).toBeNull();
    expect([seen[0].method, seen[0].url.pathname]).toEqual(["POST", `/v1/qa/answers/${JOB}/lock`]);
  });

  it("no cookie, or a cookie outside the signed charset: 401 {error:'unauthorized'} without a backend call", async () => {
    respondWith(() => ok({}));
    for (const value of [undefined, "a b", "x;y=1"]) {
      st.cookies = new Map(value === undefined ? [] : [["raw_data_qa", value]]);
      const res = await qa.qaApiRoutes.lockPatch(req("/api/qa/lock", { method: "PATCH", body: { jobId: JOB } }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
    expect(seen).toHaveLength(0);
  });

  it("kill switch off: 404 before anything else (same as legacy)", async () => {
    vi.stubEnv("RAW_DATA_QA_ENABLED", "");
    respondWith(() => ok({}));
    st.cookies.set("raw_data_qa", COOKIE);
    expect((await qa.qaApiRoutes.lockPost(req("/api/qa/lock", { method: "POST", body: { jobId: JOB } }))).status).toBe(404);
    expect((await qa.qaApiRoutes.sessionPost(req("/api/qa/session", { method: "POST", body: {} }))).status).toBe(404);
    expect((await qa.qaApiRoutes.sessionDelete()).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("logout: PATCH /v1/qa/sessions/{id} {logout:true}, id from the cookie payload, backend deletion relayed", async () => {
    st.cookies.set("raw_data_qa", COOKIE);
    const del = 'raw_data_qa=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Max-Age=0; Path=/; SameSite=lax; Secure';
    respondWith(() => withSetCookies(ok({ session_id: SID, locks_released: 1, session_deleted: true, references_detached: 0, session_kept_reason: null }), [del]));
    const res = await qa.qaApiRoutes.sessionDelete();
    expect(await res.json()).toEqual({ ok: true });
    expect([seen[0].method, seen[0].url.pathname, seen[0].body]).toEqual(["PATCH", `/v1/qa/sessions/${SID}`, { logout: true }]);
    expect(seen[0].headers.get("cookie")).toBe(`raw_data_qa=${COOKIE}`);
    expect(res.headers.getSetCookie()).toEqual([del]);
  });

  it("logout: backend refusal (already logged out) still clears the browser cookie, {ok:true}", async () => {
    st.cookies.set("raw_data_qa", COOKIE);
    respondWith(() => apiError(401, "qa_unauthorized"));
    const res = await qa.qaApiRoutes.sessionDelete();
    expect(await res.json()).toEqual({ ok: true });
    const [line] = res.headers.getSetCookie();
    expect(line).toMatch(/^raw_data_qa=;/);
    expect(line).toMatch(/Max-Age=0/i);
  });

  it("logout without a cookie: no backend call, cookie cleared", async () => {
    respondWith(() => ok({}));
    const res = await qa.qaApiRoutes.sessionDelete();
    expect(seen).toHaveLength(0);
    expect(res.headers.getSetCookie()[0]).toMatch(/^raw_data_qa=;/);
  });
});

// ── error mapping ───────────────────────────────────────────────────────────

describe("error mapping", () => {
  beforeEach(() => st.cookies.set("raw_data_qa", COOKIE));

  it("login errors -> the gate form's legacy error keys", async () => {
    const cases: Array<[Response, number, unknown]> = [
      [apiError(401, "bad_credentials"), 401, { error: "bad-credentials" }],
      [apiError(422, "bad_name", { field: "name" }), 400, { error: "bad-name" }],
      [apiError(422, "unprocessable"), 400, { error: "bad-name" }],
      [apiError(429, "rate_limited"), 429, { error: "rate-limited" }],
    ];
    for (const [upstream, status, body] of cases) {
      respondWith(() => upstream);
      const res = await qa.qaApiRoutes.sessionPost(req("/api/qa/session", { method: "POST", body: { name: "kim", password: "pw" } }));
      expect([res.status, await res.json()]).toEqual([status, body]);
    }
    respondWith(() => apiError(404, "not_found"));
    const off = await qa.qaApiRoutes.sessionPost(req("/api/qa/session", { method: "POST", body: { name: "kim", password: "pw" } }));
    expect([off.status, await off.text()]).toEqual([404, ""]);
  });

  it("401 qa_unauthorized on a route -> 401 {error:'unauthorized'} (client goes back to the gate)", async () => {
    respondWith(() => apiError(401, "qa_unauthorized"));
    const res = await qa.qaApiRoutes.reviewPut(req("/api/qa/review", { method: "PUT", body: { jobId: JOB, sectionFlags: {} } }));
    expect([res.status, await res.json()]).toEqual([401, { error: "unauthorized" }]);
  });

  it("409 lock_held -> {ok:false, heldBy:{reviewerName, acquiredAt}}; holder gone -> empty name", async () => {
    respondWith(() => apiError(409, "lock_held", { held_by: { reviewer_name: "park", acquired_at: "2026-09-20T01:00:00+00:00" } }));
    const res = await qa.qaApiRoutes.lockPost(req("/api/qa/lock", { method: "POST", body: { jobId: JOB } }));
    expect([res.status, await res.json()]).toEqual([409, { ok: false, heldBy: { reviewerName: "park", acquiredAt: "2026-09-20T01:00:00.000Z" } }]);
    respondWith(() => apiError(409, "lock_held", { held_by: null }));
    const gone = await (await qa.qaApiRoutes.lockPost(req("/api/qa/lock", { method: "POST", body: { jobId: JOB } }))).json();
    expect(gone.heldBy.reviewerName).toBe("");
  });

  it("409 lock_lost on save -> {error:'lock-lost', heldBy:{reviewerName}}; flags filtered to the six sections", async () => {
    respondWith(() => apiError(409, "lock_lost", { held_by: { reviewer_name: "park", acquired_at: "2026-09-20T01:00:00+00:00" } }));
    const res = await qa.qaApiRoutes.reviewPut(
      req("/api/qa/review", { method: "PUT", body: { jobId: JOB, sectionFlags: { answer: "ok", acr: "maybe", bogus: "issue" } } }),
    );
    expect([res.status, await res.json()]).toEqual([409, { error: "lock-lost", heldBy: { reviewerName: "park" } }]);
    expect(seen[0].body).toEqual({ section_flags: { answer: "ok" } });
  });

  it("sendBeacon release (POST ?release=1) is sent as DELETE", async () => {
    respondWith(() => ok({ released: true }));
    const res = await qa.qaApiRoutes.lockPost(req("/api/qa/lock?release=1", { method: "POST", body: { jobId: JOB } }));
    expect(await res.json()).toEqual({ ok: true });
    expect([seen[0].method, seen[0].url.pathname]).toEqual(["DELETE", `/v1/qa/answers/${JOB}/lock`]);
  });

  it("note writes: 403 not_author -> forbidden, 404 -> not-found, nothing to change -> 404 without a call", async () => {
    respondWith(() => apiError(403, "not_author"));
    const forbidden = await qa.qaApiRoutes.notePatch(req("/api/qa/note", { method: "PATCH", body: { id: JOB, body: "edit" } }));
    expect([forbidden.status, await forbidden.json()]).toEqual([403, { error: "forbidden" }]);
    respondWith(() => apiError(404, "note_not_found"));
    const missing = await qa.qaApiRoutes.noteDelete(req("/api/qa/note", { method: "DELETE", body: { id: JOB } }));
    expect([missing.status, await missing.json()]).toEqual([404, { error: "not-found" }]);
    seen = [];
    const empty = await qa.qaApiRoutes.notePatch(req("/api/qa/note", { method: "PATCH", body: { id: JOB, body: "   " } }));
    expect([empty.status, await empty.json(), seen.length]).toEqual([404, { error: "not-found" }, 0]);
  });

  it("note create: legacy validation first, body trimmed and cut at 4,000, unknown severity -> issue, label capped", async () => {
    const bad = await qa.qaApiRoutes.notePost(req("/api/qa/note", { method: "POST", body: { jobId: JOB, targetKind: "nope", body: "x" } }));
    expect([bad.status, await bad.json()]).toEqual([400, { error: "jobId, targetKind, body required" }]);
    respondWith(() =>
      ok({ note_id: SID, job_id: JOB, target_kind: "answer", target_key: null, target_label: null, severity: "issue", body: "b", reviewer_name: "kim", created_at: "2026-09-20T01:00:00+00:00", resolved_at: null, resolved_by: null }, 201),
    );
    const res = await qa.qaApiRoutes.notePost(
      req("/api/qa/note", { method: "POST", body: { jobId: JOB, targetKind: "answer", body: `  ${"b".repeat(4100)}  `, severity: "loud", targetLabel: "L".repeat(600), targetKey: "  k  " } }),
    );
    expect(res.status).toBe(200);
    const sent = seen[0].body as Record<string, string>;
    expect([sent.body.length, sent.severity, sent.target_label.length, sent.target_key]).toEqual([4000, "issue", 500, "k"]);
    expect(Object.keys(sent).sort()).toEqual(["body", "severity", "target_key", "target_kind", "target_label"]);
  });

  it("413 and 415 keep their status with {error:{code}}", async () => {
    for (const [status, code] of [[413, "payload_too_large"], [415, "unsupported_media_type"]] as const) {
      respondWith(() => apiError(status, code));
      const res = await qa.qaApiRoutes.notePost(req("/api/qa/note", { method: "POST", body: { jobId: JOB, targetKind: "answer", body: "b" } }));
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
  });

  it("pages: 401 qa_unauthorized -> QA gate (not /login); detail 404/422 -> null; cursor problems detected", async () => {
    const { throwForPage } = await import("../errors");
    respondWith(() => apiError(401, "qa_unauthorized"));
    const err = await qa.listAnswers({}, undefined, 50).catch((e: unknown) => e);
    let digest = "";
    try {
      throwForPage(err, "ko");
    } catch (e) {
      digest = String((e as { digest?: string }).digest);
    }
    expect(digest).toContain("/ko/raw-data-qa;");
    expect(digest).not.toContain("/login");
    respondWith(() => apiError(404, "job_not_found"));
    expect(await qa.getAnswerDetail(JOB)).toBeNull();
    respondWith(() => apiError(422, "unprocessable"));
    expect(await qa.getAnswerDetail("not-a-uuid")).toBeNull();
    const { HghApiError } = await import("../errors");
    expect(qa.isCursorProblem(new HghApiError(409, "cursor_stale"))).toBe(true);
    expect(qa.isCursorProblem(new HghApiError(422, "cursor_invalid"))).toBe(true);
    expect(qa.isCursorProblem(new HghApiError(409, "lock_held"))).toBe(false);
  });

  it("current reviewer: no cookie -> null without a call; 401 -> null; 5xx thrown", async () => {
    st.cookies = new Map();
    respondWith(() => ok(sessionOut));
    expect(await qa.getCurrentReviewer()).toBeNull();
    expect(seen).toHaveLength(0);
    st.cookies.set("raw_data_qa", COOKIE);
    expect(await qa.getCurrentReviewer()).toEqual({ sessionId: SID, name: "kim" });
    expect(seen[0].url.pathname).toBe("/v1/qa/sessions/current");
    respondWith(() => apiError(401, "qa_unauthorized"));
    expect(await qa.getCurrentReviewer()).toBeNull();
    respondWith(() => apiError(503, "unavailable"));
    await expect(qa.getCurrentReviewer()).rejects.toMatchObject({ status: 503 });
  });
});

// ── query and range handling ────────────────────────────────────────────────

describe("filters and ranges", () => {
  beforeEach(() => st.cookies.set("raw_data_qa", COOKIE));

  it("list query: API vocabulary, surface as an array, cursor and limit", async () => {
    respondWith(() => new Response(JSON.stringify(env({ items: [listRow] }, { limit: 50, next_cursor: "c2" })), { headers: { "content-type": "application/json" } }));
    const out = await qa.listAnswers(
      { surface: ["standard", "website"], brand: ["Kia", "Kia"], hasNotes: true, noMentions: true, state: ["unreviewed"], from: "2026-09-01", to: "2026-09-30", q: "suv" },
      "c1",
      50,
    );
    expect(out.nextCursor).toBe("c2");
    const q = seen[0].url.searchParams;
    expect(q.getAll("surface")).toEqual(["global", "website"]);
    expect(q.getAll("brand")).toEqual(["Kia"]);
    expect([q.get("has_notes"), q.get("no_mentions"), q.get("state"), q.get("from"), q.get("to"), q.get("q"), q.get("cursor"), q.get("limit")]).toEqual(
      ["true", "true", "unreviewed", "2026-09-01", "2026-09-30", "suv", "c1", "50"],
    );
    expect(q.has("hasNotes")).toBe(false);
  });

  it("inverted range (from > to): empty list, zero scoped progress with the real total, header-only CSV, no 422", async () => {
    respondWith(() => ok({ scoped: { total: 9, reviewed: 1, issues: 0, notes: 0 }, total: { total: 9, reviewed: 1, issues: 0, notes: 0 } }));
    const f = { from: "2026-09-30", to: "2026-09-01" };
    expect(await qa.listAnswers(f, undefined, 50)).toEqual({ rows: [], nextCursor: null });
    expect(await qa.getNeighbors(f, JOB)).toEqual({ prev: null, next: null });
    expect(await qa.listNotes(f, undefined, 50)).toEqual({ rows: [], nextCursor: null });
    expect(await qa.countNotesByKind(f)).toEqual({});
    expect(seen).toHaveLength(0);
    expect(await qa.getProgress(f)).toEqual({ scoped: { total: 0, reviewed: 0, issues: 0, notes: 0 }, total: { total: 9, reviewed: 1, issues: 0, notes: 0 } });
    expect([...seen[0].url.searchParams.keys()]).toEqual([]);
    seen = [];
    const csv = await qa.qaApiRoutes.notesExport(req("/api/qa/notes/export?from=2026-09-30&to=2026-09-01"));
    expect(seen).toHaveLength(0);
    expect(await bytesText(csv)).toBe(`\uFEFF${qa.QA_NOTE_CSV_COLUMNS.join(",")}\r\n`);
  });

  it("export: note filter in API vocabulary, stream relayed with allow-listed headers", async () => {
    respondWith(
      () =>
        new Response("\uFEFFcreated_at\r\n", {
          headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="qa-notes-2026-09-29.csv"', "x-export-truncated": "true", "set-cookie": "x=1" },
        }),
    );
    const res = await qa.qaApiRoutes.notesExport(req("/api/qa/notes/export?targetKind=citation&includeResolved=1&reviewer=kim,%20lee&reviewer=park"));
    const q = seen[0].url.searchParams;
    expect([q.getAll("target_kind"), q.get("include_resolved"), q.getAll("reviewer")]).toEqual([["citation"], "true", ["kim, lee", "park"]]);
    expect(seen[0].headers.get("accept")).toBe("text/csv");
    expect(res.headers.get("x-export-truncated")).toBe("true");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await bytesText(res)).toBe("\uFEFFcreated_at\r\n");
  });

  it("deltas: comma list trimmed and capped at 200, empty list answered locally", async () => {
    respondWith(() => ok({ locks: [listRow.lock], reviews: [{ job_id: JOB, status: "ok", reviewer_name: "kim", updated_at: "2026-09-20T00:00:00+00:00" }] }));
    const ids = Array.from({ length: 205 }, (_, i) => `id${i}`);
    const res = await qa.qaApiRoutes.answersDeltas(req(`/api/qa/answers?jobIds=${ids.join(",")}, ,`));
    expect(seen[0].url.searchParams.getAll("job_ids")).toHaveLength(200);
    expect(await res.json()).toEqual({
      locks: [{ jobId: JOB, sessionId: SID, reviewerName: "park", acquiredAt: "2026-09-20T01:00:00.000Z", heartbeatAt: "2026-09-20T01:00:30.000Z" }],
      reviews: [{ jobId: JOB, status: "ok", reviewerName: "kim" }],
    });
    seen = [];
    expect(await (await qa.qaApiRoutes.answersDeltas(req("/api/qa/answers?jobIds="))).json()).toEqual({ locks: [], reviews: [] });
    expect(seen).toHaveLength(0);
  });
});
