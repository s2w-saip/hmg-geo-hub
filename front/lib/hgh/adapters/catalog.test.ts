import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";

// Prompt catalog adapter (unit U8): hand-computed conversions (catalog row, audit view, website
// row), the query each call sends (one serializer: analysisQuery + search/sort/dir; scope
// injection stripped), keyset paging with the stale-cursor restart (D5, U8-N13), the options
// and calendar of /website/prompts, the xlsx relay (BG-35, D7) and the documented known
// differences. Legacy <-> api parity runs the UNCHANGED repository functions on PGlite in
// catalog.parity.test.ts.

vi.mock("@/lib/scope/server", () => ({}));
const { bindHghAuth } = await import("../auth");
const C = await import("./catalog");

type S = components["schemas"];
type Meta = S["Meta"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const meta = (m: Partial<Meta> = {}): Meta => ({ mode: "crud", ...m }) as Meta;

// ── fetch stub ──────────────────────────────────────────────────────────────

interface Seen {
  url: URL;
  headers: Headers;
}
const seen: Seen[] = [];
let answer: (url: URL, i: number) => { status?: number; json?: unknown; body?: BodyInit; headers?: Record<string, string> };

beforeEach(() => {
  seen.length = 0;
  answer = () => ({ json: { data: { items: [] }, meta: meta({ page: { limit: 50 } }) } });
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string, init?: RequestInit) => {
      const url = new URL(String(u));
      seen.push({ url, headers: new Headers(init?.headers) });
      const a = answer(url, seen.length - 1);
      if (a.body !== undefined) return new Response(a.body, { status: a.status ?? 200, headers: a.headers });
      return new Response(JSON.stringify(a.json), {
        status: a.status ?? 200,
        headers: { "content-type": "application/json", ...(a.headers ?? {}) },
      });
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const qs = (i = 0) => seen[i].url.searchParams;
const fail = (status: number, code: string) => ({ status, json: { error: { code, message: "x" } } });

// ── /standard/prompts: catalog ──────────────────────────────────────────────

function globalRow(o: Partial<S["GlobalPromptRow"]> = {}): S["GlobalPromptRow"] {
  return {
    prompt_id: "00000000-0000-4000-8000-000000000001",
    text: "best ev",
    kind: "single",
    scope_prompt_id: "00000000-0000-4000-8000-000000000101",
    measured: true,
    brand_code: "Hyundai",
    brand_presence: null,
    brand_presence_effective: "branded",
    prompt_type: "Brand",
    category: "cat",
    list_type: "Brand Message",
    depth1: "1.",
    depth2: "a",
    depth3: null,
    depth4: null,
    funnel_stage: "인지/탐색",
    lang: "EN",
    regions: ["US", "x:global"],
    ...o,
  };
}

describe("toStandardCatalogRow", () => {
  it("maps every field the read-only list reads; stored brand_presence (not the effective one); regions copied", () => {
    const api = globalRow();
    const r = C.toStandardCatalogRow(api);
    expect(r).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      text: "best ev",
      promptType: "Brand",
      category: "cat",
      brand: "Hyundai",
      brandPresence: null,
      listType: "Brand Message",
      depth1: "1.",
      depth2: "a",
      depth3: null,
      depth4: null,
      funnelStage: "인지/탐색",
      kind: "single",
      lang: "EN",
      regions: ["US", "x:global"],
      scopePromptId: "00000000-0000-4000-8000-000000000101",
      scopeText: null,
      deletedAt: null,
    });
    expect(r.regions).not.toBe(api.regions);
  });

  it("absent optionals are null (not undefined), regions null stays null", () => {
    const r = C.toStandardCatalogRow(
      globalRow({ brand_code: null, regions: null, lang: null, prompt_type: null, scope_prompt_id: null, measured: false }),
    );
    expect([r.brand, r.regions, r.lang, r.promptType, r.scopePromptId]).toEqual([null, null, null, null, null]);
  });
});

describe("listStandardCatalogApi: all mode, cursor chain", () => {
  it("surface=global&all=true, follows next_cursor, keeps order, drops website-shaped rows", async () => {
    const r1 = globalRow({ prompt_id: "00000000-0000-4000-8000-000000000001", text: "a" });
    const r2 = globalRow({ prompt_id: "00000000-0000-4000-8000-000000000002", text: "b" });
    answer = (url) =>
      url.searchParams.get("cursor")
        ? { json: { data: { items: [r2] }, meta: meta({ page: { limit: 25000, next_cursor: null, total: 2 } }) } }
        : { json: { data: { items: [r1] }, meta: meta({ page: { limit: 25000, next_cursor: "c2", total: 2 } }) } };
    const res = await C.listStandardCatalogApi();
    expect(res.rows.map((r) => r.text)).toEqual(["a", "b"]);
    expect(seen.map((s) => [s.url.pathname, s.url.searchParams.get("surface"), s.url.searchParams.get("all"), s.url.searchParams.get("cursor")])).toEqual([
      ["/v1/prompts", "global", "true", null],
      ["/v1/prompts", "global", "true", "c2"],
    ]);
    // no limit: the all mode ignores it (the backend reports it as ignored)
    expect(qs(0).has("limit")).toBe(false);
  });

  it("a chain longer than the page cap throws (never a silent partial catalog)", async () => {
    let n = 0;
    answer = () => ({ json: { data: { items: [globalRow()] }, meta: meta({ page: { limit: 25000, next_cursor: `c${++n}` } }) } });
    await expect(C.listStandardCatalogApi()).rejects.toThrow();
    expect(seen.length).toBe(C.GLOBAL_CATALOG_MAX_PAGES);
  });
});

describe("standardCollectionPeriodApi", () => {
  it("from = first_measured_date, to = latest_round_date (U8-N10, DC-07); nulls pass through", async () => {
    const dates = (d: Partial<S["DatesData"]>) => ({
      json: {
        data: { dates: ["2026-09-14"], dates_truncated: false, first_measured_date: "2026-07-01", latest_round_date: "2026-09-14", presets: [], surface: "global", ...d },
        meta: meta({ mode: "snapshot" }),
      },
    });
    answer = () => dates({});
    expect(await C.standardCollectionPeriodApi()).toEqual({ from: "2026-07-01", to: "2026-09-14" });
    expect([seen[0].url.pathname, qs(0).get("surface")]).toEqual(["/v1/filters/dates", "global"]);
    answer = () => dates({ first_measured_date: null, latest_round_date: null, dates: [] });
    expect(await C.standardCollectionPeriodApi()).toEqual({ from: null, to: null });
  });
});

// ── /standard/prompts: history ──────────────────────────────────────────────

function historyRow(o: Partial<S["HistoryRow"]> = {}): S["HistoryRow"] {
  return {
    audit_id: 42,
    prompt_id: "00000000-0000-4000-8000-000000000001",
    prompt_text: "best ev",
    prompt_brand: "Hyundai",
    event_type: "meta_updated",
    changes: { depth1: { old: null, new: "2." }, regions: { old: ["US"], new: ["US", "KR"] }, weight: { old: 1, new: 2 } },
    actor_id: "00000000-0000-4000-8000-000000000900",
    actor_type: "user",
    actor_email: "editor@hmg.test",
    batch_id: null,
    created_at: "2026-09-20T01:02:03Z",
    ...o,
  };
}

describe("toAuditView / toAuditChanges", () => {
  it("row fields; changes values as strings (the legacy writer stored strings), null kept", () => {
    const v = C.toAuditView(historyRow());
    expect(v).toEqual({
      id: "42",
      promptId: "00000000-0000-4000-8000-000000000001",
      actorId: "00000000-0000-4000-8000-000000000900",
      actorType: "user",
      eventType: "meta_updated",
      changes: {
        depth1: { old: null, new: "2." },
        // String(["US","KR"]) = "US,KR"; String(1) = "1"
        regions: { old: "US", new: "US,KR" },
        weight: { old: "1", new: "2" },
      },
      batchId: null,
      createdAt: new Date("2026-09-20T01:02:03Z"),
      actorEmail: "editor@hmg.test",
      promptText: "best ev",
      promptBrand: "Hyundai",
    });
  });

  it("a malformed pair (null, missing keys) becomes {old: null, new: null}; empty changes -> {}", () => {
    expect(C.toAuditChanges({ a: null, b: {} } as never)).toEqual({ a: { old: null, new: null }, b: { old: null, new: null } });
    expect(C.toAuditChanges({})).toEqual({});
    expect(C.toAuditChanges(null as never)).toEqual({});
  });
});

describe("history queries", () => {
  it("tab: surface=global, limit 500, no period (the backend 90-day default, U8-N11)", async () => {
    answer = () => ({ json: { data: { items: [historyRow(), historyRow({ audit_id: 41 })] }, meta: meta({ page: { limit: 500 } }) } });
    const rows = await C.listGlobalAuditApi();
    expect(rows.map((r) => r.id)).toEqual(["42", "41"]);
    expect(seen[0].url.pathname).toBe("/v1/prompts/history");
    expect([qs().get("surface"), qs().get("limit"), qs().has("from"), qs().has("to"), qs().has("prompt_id")]).toEqual(["global", "500", false, false, false]);
  });

  it("timeline: prompt_id with from=2000-01-01..today always sent (else a 90-day window), limit 100", async () => {
    answer = () => ({ json: { data: { items: [historyRow()] }, meta: meta({ page: { limit: 100 } }) } });
    await C.fetchPromptTimelineApi(PID, "2026-09-29");
    expect([qs().get("surface"), qs().get("prompt_id"), qs().get("from"), qs().get("to"), qs().get("limit")]).toEqual([
      "global",
      PID,
      "2000-01-01",
      "2026-09-29",
      "100",
    ]);
  });

  it("errors keep status and code for the action to map", async () => {
    answer = () => fail(403, "menu_forbidden");
    await expect(C.fetchPromptTimelineApi(PID, "2026-09-29")).rejects.toMatchObject({ status: 403, code: "menu_forbidden" });
  });
});

// ── /website/prompts: query ─────────────────────────────────────────────────

const req = (o: Partial<import("./catalog").WebsitePromptRequest> = {}): import("./catalog").WebsitePromptRequest => ({
  filters: {},
  sort: "lastMeasuredAt",
  dir: "desc",
  ...o,
});

describe("websitePromptQuery: analysisQuery + search/sort/dir", () => {
  it("every legacy sort key has its API name", () => {
    const got = Object.fromEntries(
      (["prompt", "brand", "country", "lang", "targetUrl", "answers", "lastMeasuredAt"] as const).map((k) => [k, C.websitePromptQuery(req({ sort: k }), { all: true }).sort]),
    );
    expect(got).toEqual({
      prompt: "prompt",
      brand: "brand",
      country: "country",
      lang: "lang",
      targetUrl: "target_url",
      answers: "answers",
      lastMeasuredAt: "last_measured",
    });
  });

  it("admin choices are sent sorted (country keeps virtual site codes); search trimmed; blank search omitted", () => {
    const q = C.websitePromptQuery(
      req({
        filters: { brands: ["Kia", "Hyundai N"], countries: ["US", "HYUNDAI-N"], langs: ["en"], engines: ["gemini", "chatgpt"], search: "  ev  ", dateFrom: "2026-09-01", dateTo: "2026-09-10" },
        sort: "answers",
        dir: "asc",
      }),
      { all: true },
    ) as Record<string, unknown>;
    expect(q.surface).toBe("website");
    expect(q.brand).toEqual(["Hyundai N", "Kia"]);
    expect(q.country).toEqual(["HYUNDAI-N", "US"]);
    expect(q.lang).toEqual(["en"]);
    expect(q.engine).toEqual(["chatgpt", "gemini"]);
    expect([q.search, q.sort, q.dir, q.from, q.to]).toEqual(["ev", "answers", "asc", "2026-09-01", "2026-09-10"]);
    const blank = C.websitePromptQuery(req({ filters: { search: "   " } }), { all: true }) as Record<string, unknown>;
    expect("search" in blank).toBe(false);
  });

  it("non-admin: the scope-injected brand lock and the whole allowed country set are not sent (the server applies the scope)", () => {
    const scope = { all: false, brands: ["Kia"], countries: ["DE", "US"] };
    const q = C.websitePromptQuery(req({ filters: { brands: ["Kia"], countries: ["DE", "US"] } }), scope) as Record<string, unknown>;
    expect([q.brand, q.country]).toEqual([undefined, undefined]);
    // a narrower country choice inside the scope is a real choice
    const narrow = C.websitePromptQuery(req({ filters: { brands: ["Kia"], countries: ["US"] } }), scope) as Record<string, unknown>;
    expect([narrow.brand, narrow.country]).toEqual([undefined, ["US"]]);
  });
});

// ── /website/prompts: list ──────────────────────────────────────────────────

function websiteRow(o: Partial<S["WebsitePromptRow"]> = {}): S["WebsitePromptRow"] {
  return {
    website_prompt_id: "00000000-0000-4000-8000-000000000601",
    prompt_text: "best suv",
    brand_code: "Hyundai N",
    country_code: "KR",
    lang_code: "ko",
    target_url: "https://hyundai-n.com/kr",
    domain: "hyundai-n.com",
    answers: 3,
    last_measured: "2026-09-12",
    engines: ["chatgpt", "gemini"],
    measured: true,
    owned_base_url: "https://hyundai-n.com",
    scope_prompt_id: "00000000-0000-4000-8000-000000000701",
    ...o,
  };
}

describe("toWebsitePromptRow", () => {
  it("maps the ten legacy fields and drops measured, owned_base_url, scope_prompt_id", () => {
    const api = websiteRow();
    const r = C.toWebsitePromptRow(api);
    expect(r).toEqual({
      id: "00000000-0000-4000-8000-000000000601",
      promptText: "best suv",
      brand: "Hyundai N",
      countryCode: "KR",
      langCode: "ko",
      targetUrl: "https://hyundai-n.com/kr",
      domain: "hyundai-n.com",
      answers: 3,
      lastMeasuredAt: "2026-09-12",
      engines: ["chatgpt", "gemini"],
    });
    expect(r.engines).not.toBe(api.engines);
    expect(C.toWebsitePromptRow(websiteRow({ last_measured: null, answers: 0, engines: [] }))).toMatchObject({ lastMeasuredAt: null, answers: 0, engines: [] });
  });
});

describe("listWebsitePromptsApi: keyset page (D5) and restart (U8-N13)", () => {
  const page = (items: S["WebsitePromptRow"][], next: string | null, total: number | null) => ({
    json: { data: { items }, meta: meta({ page: { limit: 50, next_cursor: next, total } }) },
  });

  it("first page: limit 50, no cursor; next cursor and total from meta.page", async () => {
    answer = () => page([websiteRow()], "n1", 120);
    const res = await C.listWebsitePromptsApi(req(), { all: true }, null);
    expect([qs().get("limit"), qs().has("cursor"), qs().get("sort"), qs().get("dir")]).toEqual(["50", false, "last_measured", "desc"]);
    expect([res.rows.length, res.total, res.nextCursor, res.restarted]).toEqual([1, 120, "n1", false]);
  });

  it("the given cursor is sent; the last page has no next cursor; a missing total falls back to the row count", async () => {
    answer = () => page([websiteRow(), websiteRow({ website_prompt_id: "00000000-0000-4000-8000-000000000602" })], null, null);
    const res = await C.listWebsitePromptsApi(req(), { all: true }, "n1");
    expect(qs().get("cursor")).toBe("n1");
    expect([res.total, res.nextCursor, res.restarted]).toEqual([2, null, false]);
  });

  for (const [status, code] of [
    [409, "cursor_stale"],
    [422, "cursor_invalid"],
  ] as const) {
    it(`${status} ${code} on a cursor: read page 1 once, restarted = true`, async () => {
      answer = (url) => (url.searchParams.has("cursor") ? fail(status, code) : page([websiteRow()], "n1", 5));
      const res = await C.listWebsitePromptsApi(req(), { all: true }, "old");
      expect(seen.map((s) => s.url.searchParams.get("cursor"))).toEqual(["old", null]);
      expect([res.total, res.nextCursor, res.restarted]).toEqual([5, "n1", true]);
    });
  }

  it("other errors are not swallowed: 422 with another code, 409 without a cursor, 403", async () => {
    answer = () => fail(422, "invalid_filter");
    await expect(C.listWebsitePromptsApi(req(), { all: true }, "old")).rejects.toMatchObject({ status: 422, code: "invalid_filter" });
    answer = () => fail(409, "cursor_stale");
    await expect(C.listWebsitePromptsApi(req(), { all: true }, null)).rejects.toMatchObject({ status: 409 });
    answer = () => fail(403, "menu_forbidden");
    await expect(C.listWebsitePromptsApi(req(), { all: true }, null)).rejects.toMatchObject({ status: 403 });
    expect(seen.length).toBe(3);
  });

  it("the list and the export send the same filter query (one serializer)", async () => {
    const r = req({ filters: { countries: ["US"], engines: ["gemini"], search: "ev" }, sort: "prompt", dir: "asc" });
    answer = () => page([], null, 0);
    await C.listWebsitePromptsApi(r, { all: true }, null);
    answer = () => ({ body: "x", headers: { "content-type": C.XLSX_ACCEPT } });
    await C.relayWebsitePromptsExport(r, { all: true }, "ko");
    const strip = (p: URLSearchParams, drop: string[]) => [...p.entries()].filter(([k]) => !drop.includes(k)).sort();
    expect(strip(qs(0), ["limit"])).toEqual(strip(qs(1), ["format", "columns", "locale"]));
  });
});

// ── /website/prompts: options, calendar ─────────────────────────────────────

describe("loadWebsitePromptOptions / loadWebsitePromptDates", () => {
  it("countries without virtual brand codes, languages as given, geo_matrix brands (null dropped), all distinct and sorted", async () => {
    answer = () => ({
      json: {
        data: {
          catalog: null,
          custom_fields: null,
          engines: [{ code: "chatgpt", is_default: true }],
          geo_matrix: [
            { brand: "Kia", region: "US", lang: "en" },
            { brand: "Hyundai N", region: "HYUNDAI-N", lang: "ko" },
            { brand: "Hyundai", region: "US", lang: "en" },
            { brand: null, region: "GB", lang: "en" },
            { brand: "Kia", region: "DE", lang: "de" },
          ],
          languages: ["ko", "en", "de"],
          regions: [
            { code: "US", area: "NA", kind: "country" },
            { code: "HYUNDAI-N", area: null, kind: "virtual_brand" },
            { code: "DE", area: "EU", kind: "country" },
            { code: "DE", area: "EU", kind: "country" },
          ],
          source_categories: [],
        },
        meta: meta({ mode: "snapshot" }),
      },
    });
    const o = await C.loadWebsitePromptOptions();
    expect(o).toEqual({
      geographyOptions: ["DE", "US"],
      languageOptions: ["de", "en", "ko"],
      brandOptions: ["Hyundai", "Hyundai N", "Kia"],
    });
    // no period: the legacy lists had none (DC-06 is the population change)
    expect([seen[0].url.pathname, qs().get("surface"), qs().has("from"), qs().has("to")]).toEqual(["/v1/filters/options", "website", false, false]);
  });

  it("calendar: surface=website&family=all, ascending; an empty calendar is undefined", async () => {
    const dates = (d: string[]) => ({
      json: {
        data: { dates: d, dates_truncated: false, first_measured_date: "2026-07-01", latest_round_date: d[0] ?? null, presets: [], surface: "website" },
        meta: meta({ mode: "snapshot" }),
      },
    });
    answer = () => dates(["2026-09-14", "2026-09-07"]);
    expect(await C.loadWebsitePromptDates()).toEqual(["2026-09-07", "2026-09-14"]);
    expect([qs().get("surface"), qs().get("family")]).toEqual(["website", "all"]);
    answer = () => dates([]);
    expect(await C.loadWebsitePromptDates()).toBeUndefined();
  });
});

// ── /website/prompts: download ──────────────────────────────────────────────

describe("relayWebsitePromptsExport: xlsx stream relay (BG-35, D7)", () => {
  it("format=xlsx, columns=screen, locale; no cursor or limit; xlsx Accept; body and headers pass through", async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    answer = () => ({ body: bytes, headers: { "content-type": C.XLSX_ACCEPT, "x-export-truncated": "true", "cache-control": "no-store" } });
    const res = await C.relayWebsitePromptsExport(req({ filters: { langs: ["en"] }, sort: "brand", dir: "asc" }), { all: true }, "en");
    expect(seen[0].url.pathname).toBe("/v1/prompts");
    expect([qs().get("surface"), qs().get("format"), qs().get("columns"), qs().get("locale"), qs().get("sort"), qs().get("dir")]).toEqual([
      "website",
      "xlsx",
      "screen",
      "en",
      "brand",
      "asc",
    ]);
    expect(qs().getAll("lang")).toEqual(["en"]);
    expect([qs().has("cursor"), qs().has("limit")]).toEqual([false, false]);
    expect(seen[0].headers.get("accept")).toBe(C.XLSX_ACCEPT);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-export-truncated")).toBe("true");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("an upstream error is thrown with its status and code (the route maps it)", async () => {
    answer = () => fail(422, "invalid_filter");
    await expect(C.relayWebsitePromptsExport(req(), { all: true }, "ko")).rejects.toMatchObject({ status: 422, code: "invalid_filter" });
  });
});

// ── known differences (A4 notice list) ──────────────────────────────────────

export const KNOWN_DIFF = ["DC-01", "DC-06", "DC-07", "U8-N10", "U8-N11", "U8-N12", "U8-N13", "U8-N14", "U8-N18", "U8-N19", "U8-N21"] as const;

describe("known_diff: every documented item is in the module header", () => {
  it("the header lists exactly these codes", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("./catalog.ts", import.meta.url), "utf8");
    const header = src.split("\nimport ")[0];
    const codes = [...header.matchAll(/^\/\/\s+((?:DC|U8-N)[-\dN]+)\s/gm)].map((m) => m[1]);
    expect(codes).toEqual([...KNOWN_DIFF]);
  });
});
