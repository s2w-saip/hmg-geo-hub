import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";

// Answer detail adapter (unit U6, AN-2): hand-checked field map (legacy MirrorAnswerDetail keys and
// orders, sentiment and stance presence rules), the request (surface, only the admin brand choice,
// the legacy IDOR gate as project_id / gate_country / gate_brand, lite), and the error map
// (404/403/422 -> available:false; 401 and 5xx thrown). Legacy parity on PGlite is in
// answers.parity.test.ts.

vi.mock("@/lib/scope/server", () => ({}));
const { bindHghAuth } = await import("../auth");
const A = await import("./answers");

type S = components["schemas"];
type Detail = S["AnswerDetail"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const JOB = "3f2b8c1e-0000-4000-8000-00000000abcd";

function detail(o: Partial<Detail> = {}): Detail {
  return {
    id: JOB,
    body: { available: true, answer_text: "Hyundai Ioniq 5 beats the Toyota bZ4X." },
    header: {
      acr_iter_rank: 0,
      analysis_state: 1,
      anchor_date: "2026-09-14",
      country: "US",
      cycle_id: "c1",
      engine: "chatgpt",
      gap: false,
      is_acr: false,
      is_rep: true,
      lang: "en",
      measured_at: "2026-09-14T03:00:00+00:00",
      model_slug: null,
      prompt: { funnel: null, kind: "catalog", prompt_id: "p1", text: "best EV" },
      round_date: "2026-09-14",
      surface: "global",
    },
    citations: [
      { ord: 2, url: "https://b.example/x", domain: "b.example", title: null, category: "newsMedia", owned: false, target_hit: false },
      { ord: 1, url: "https://hyundai.com/us", domain: "hyundai.com", title: "Hyundai", category: "officialHmg", owned: true, target_hit: false },
    ],
    mentions: {
      brands: [
        { name: "Toyota", mention_count: 2, own: false, rank: 2 },
        { name: "Hyundai", mention_count: 3, own: true, rank: 1 },
        { name: "BMW", mention_count: 2, own: false, rank: 3 },
      ],
      models: [
        { name: "bZ4X", mention_count: 1, parent_brand: "Toyota", avg_position: null },
        { name: "Ioniq 5", mention_count: 2, parent_brand: "Hyundai", avg_position: 1 },
      ],
    },
    sentiment: { spans: [], skipped: 0 },
    stances: [],
    ...o,
  } as Detail;
}

describe("toMirrorAnswerDetail", () => {
  it("legacy keys and orders: citations by ord, mentions by count desc (stable), instants in toISOString form", () => {
    expect(A.toMirrorAnswerDetail(detail())).toEqual({
      available: true,
      answerText: "Hyundai Ioniq 5 beats the Toyota bZ4X.",
      measuredAt: "2026-09-14T03:00:00.000Z",
      citations: [
        { url: "https://hyundai.com/us", domain: "hyundai.com", title: "Hyundai", category: "officialHmg" },
        { url: "https://b.example/x", domain: "b.example", title: null, category: "newsMedia" },
      ],
      brandMentions: [
        { name: "Hyundai", count: 3, tracked: true },
        { name: "Toyota", count: 2, tracked: false },
        { name: "BMW", count: 2, tracked: false },
      ],
      modelMentions: [
        { name: "Ioniq 5", count: 2, brand: "Hyundai" },
        { name: "bZ4X", count: 1, brand: "Toyota" },
      ],
    });
  });
  it("no occurrence spans and nothing skipped: no sentiment key; no stances: no stances key (legend and stance row not drawn)", () => {
    const d = A.toMirrorAnswerDetail(detail());
    expect("sentiment" in d || "stances" in d).toBe(false);
  });
  it("sentiment spans camelCased; skipped alone also keeps the key", () => {
    const d = A.toMirrorAnswerDetail(
      detail({
        sentiment: {
          spans: [
            {
              start: 0,
              end: 16,
              sentiment: "positive",
              evidence: [{ brand_name: "Hyundai", sentiment: "positive", assertion: "beats", context_snippet: "Ioniq 5 beats", criteria: ["range"], descriptors: [] }],
            },
          ],
          skipped: 1,
        },
      }),
    );
    expect(d.sentiment).toEqual({
      spans: [
        {
          start: 0,
          end: 16,
          sentiment: "positive",
          evidence: [{ brandName: "Hyundai", sentiment: "positive", assertion: "beats", descriptors: [], criteria: ["range"], contextSnippet: "Ioniq 5 beats" }],
        },
      ],
      skipped: 1,
    });
    expect(A.toMirrorAnswerDetail(detail({ sentiment: { spans: [], skipped: 2 } })).sentiment).toEqual({ spans: [], skipped: 2 });
  });
  it("stances: turn, own first, brand order (legacy sort) and field names", () => {
    const st = (turn: number, brand: string, own: boolean) => ({
      turn_index: turn,
      entity_id: `e-${brand}`,
      brand,
      own,
      stance: "neutral" as const,
      confidence: null,
      evidence_text: null,
      evidence_match: "unavailable" as const,
      reason: null,
    });
    const d = A.toMirrorAnswerDetail(detail({ stances: [st(1, "Kia", true), st(0, "Toyota", false), st(0, "BMW", false), st(0, "Hyundai", true)] }));
    expect(d.stances?.map((s) => [s.turnIndex, s.brand, s.tracked])).toEqual([
      [0, "Hyundai", true],
      [0, "BMW", false],
      [0, "Toyota", false],
      [1, "Kia", true],
    ]);
    expect(d.stances?.[0]).toEqual({ turnIndex: 0, entityId: "e-Hyundai", brand: "Hyundai", tracked: true, stance: "neutral", confidence: null, evidenceText: null, evidenceMatch: "unavailable", reason: null });
  });
  it("body not available or empty text -> {available: false} only", () => {
    expect(A.toMirrorAnswerDetail(detail({ body: { available: false, answer_text: null } }))).toEqual({ available: false });
    expect(A.toMirrorAnswerDetail(detail({ body: { available: true, answer_text: "" } }))).toEqual({ available: false });
  });
});

describe("loadAnswerDetail: request and error map", () => {
  const log: URL[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: { data: detail(), meta: { mode: "audit" } } };
  beforeEach(() => {
    log.length = 0;
    reply = { status: 200, body: { data: detail(), meta: { mode: "audit" } } };
    vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
    bindHghAuth({ getAccessToken: async () => TOKEN });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        log.push(new URL(String(u)));
        return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    bindHghAuth(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("global admin: surface + the URL brand choice (perspective and gate); path is the job id; lite", async () => {
    await A.loadAnswerDetail({ jobId: JOB, surface: "global", filters: { brand: ["Kia", "Hyundai"] }, scope: { all: true } });
    expect(log[0].pathname).toBe(`/v1/answers/${JOB}`);
    expect([log[0].searchParams.get("surface"), log[0].searchParams.getAll("brand")]).toEqual(["global", ["Hyundai", "Kia"]]);
    expect([log[0].searchParams.getAll("gate_brand"), log[0].searchParams.get("lite")]).toEqual([["Hyundai", "Kia"], "true"]);
    expect(log[0].searchParams.has("gate_country") || log[0].searchParams.has("project_id")).toBe(false);
  });
  it("brand-locked account: the injected lock is not sent (the backend decides the perspective and applies the scope)", async () => {
    await A.loadAnswerDetail({ jobId: JOB, surface: "website", filters: { brand: ["Kia"] }, scope: { all: false, brands: ["Kia"] } });
    expect(log[0].search).toBe("?lite=true&surface=website");
  });
  it("project: project_id = the gated project (legacy run gate), no brand and no URL filter gate", async () => {
    await A.loadAnswerDetail({
      jobId: JOB,
      surface: "project",
      filters: { brand: ["Kia"], region: ["DE"] },
      scope: null,
      projectId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    });
    expect(log[0].search).toBe("?lite=true&project_id=7c9e6679-7425-40de-944b-e07fc1f90ae7&surface=project");
  });
  it("global URL countries gate the answer (legacy region IN f.region); the scope injection is not sent", async () => {
    await A.loadAnswerDetail({ jobId: JOB, surface: "global", filters: { region: ["US", "DE"] }, scope: { all: true } });
    // readStandardFilters: a URL country outside the scope falls back to the whole scope -> the injection, not sent
    const kiaUs = { all: false, brands: ["Kia"], countries: ["US"] };
    await A.loadAnswerDetail({ jobId: JOB, surface: "global", filters: { brand: ["Kia", "HMG"], region: ["US"] }, scope: kiaUs });
    expect(log[0].searchParams.getAll("gate_country")).toEqual(["DE", "US"]);
    expect(log[1].search).toBe("?lite=true&surface=global");
  });
  it("website: the URL brand gates (site brand), the URL countries never do (virtual site countries, legacy remap)", async () => {
    await A.loadAnswerDetail({ jobId: JOB, surface: "website", filters: { brand: ["Kia"], region: ["worldwide"] }, scope: { all: true } });
    expect(log[0].search).toBe("?brand=Kia&gate_brand=Kia&lite=true&surface=website");
  });
  it.each([404, 403, 422])("%i -> {available: false}", async (status) => {
    reply = { status, body: { error: { code: "x", message: "m" } } };
    expect(await A.loadAnswerDetail({ jobId: JOB, surface: "global", filters: {}, scope: null })).toEqual({ available: false });
  });
  it.each([401, 500, 503])("%i is thrown", async (status) => {
    reply = { status, body: { error: { code: status === 401 ? "no_account" : "upstream", message: "m" } } };
    await expect(A.loadAnswerDetail({ jobId: JOB, surface: "global", filters: {}, scope: null })).rejects.toMatchObject({ status });
  });
});

export const KNOWN_DIFF = [
  { id: "U6-N7", reason: "citations[].category is the slug (the modal does not read it)" },
];

describe("known differences are documented in the adapter header", () => {
  const src = readFileSync(fileURLToPath(new URL("./answers.ts", import.meta.url)), "utf8");
  it.each(KNOWN_DIFF.map((k) => [k.id] as const))("%s", (id) => expect(src).toContain(id));
  it("U6-N8 (project answer served for another project's id) is closed: project_id is sent", () => {
    expect(src).toMatch(/U6-N8[^\n]*closed/);
  });
});
