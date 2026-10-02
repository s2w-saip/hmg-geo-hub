import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests of lib/hgh/adapters/admin.ts (U11): shape conversions with hand-computed
// expectations, request shapes, error mapping, cursor walks, keyword collection waits, and the
// keyword relay routes (gate on both sources, api body, error bodies). Legacy <-> api parity of
// the screens and actions lives in admin.parity.test.ts.

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join: j } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(j(root, "cjs", "react.react-server.development.js"));
});
const st = vi.hoisted(() => ({ session: null as unknown, legacyVolumeCalls: 0 }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));
vi.mock("@/lib/keyword/service", () => ({
  getKeywordVolumes: async () => {
    st.legacyVolumeCalls += 1;
    return [];
  },
}));
vi.mock("@/lib/keyword/keyword-to-prompt", () => ({
  generateNaturalQuestions: async () => [],
  generateNaturalQuestionsBatch: async () => [],
  attachVolumes: (q: unknown[]) => q,
}));
vi.mock("@/lib/openrouter/client", () => ({ callOpenRouter: async () => ({ data: { keywords: [] } }), defaultModel: () => "m" }));

const { withRequestScope } = await import("@/test/request-scope");
const { bindHghAuth } = await import("@/lib/hgh/auth");
const { UnauthorizedError } = await import("@/lib/auth/errors");
const { HghApiError } = await import("@/lib/hgh/errors");
const { summarizeKeywordSearchVolume } = await import("@/lib/keyword/dataforseo");
const a = await import("./admin");
const volumeRoute = await import("@/app/api/keyword/volume/route");
const toPromptRoute = await import("@/app/api/keyword/to-prompt/route");
const promptToVolumeRoute = await import("@/app/api/keyword/prompt-to-volume/route");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const U = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

interface Call {
  method: string;
  path: string;
  query: string;
  headers: Headers;
  body: unknown;
}
let calls: Call[] = [];
type Handler = (c: Call) => Response | Promise<Response>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const data = (d: unknown, meta: Record<string, unknown> = {}) => json(200, { data: d, meta: { mode: "admin", ...meta } });
const fail = (status: number, code: string) => json(status, { error: { code, message: code, details: { secret: "x" } } });

function mock(handler: Handler) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const raw = init.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    const c = { method: init.method ?? "GET", path: url.pathname, query: url.search, headers: new Headers(init.headers), body };
    calls.push(c);
    return handler(c);
  });
}

beforeEach(() => {
  calls = [];
  st.legacyVolumeCalls = 0;
  st.session = { user: { id: U(1), email: "a@t.test", role: "admin", scope: { all: true }, operator: "global", menuGroups: null } };
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  vi.stubEnv("HGH_RELAY_SECRET", "");
  vi.stubEnv("HGH_SOURCE_G7", "api");
  bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: async () => null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  bindHghAuth(null);
});

// ── conversions ─────────────────────────────────────────────────────────────

const userItem = (over: Record<string, unknown> = {}) => ({
  user_id: U(3), email: "c@t.test", role: "country", operator: "assigned", scope_all: false, scope_brands: ["Kia"], scope_regions: [],
  scope_countries: ["KR", "JP"], menu_groups: null, is_qa_reviewer: false, display_name: null, status: "suspended", row_version: 4,
  created_at: "2026-06-30T23:59:59.999999+00:00", updated_at: "2026-07-01T00:00:00+00:00", last_sign_in_at: "2026-09-01T15:30:00.5+09:00",
  ...over,
});

describe("conversions (hand-computed)", () => {
  it("UserItem -> UserRow: [] -> null, UTC day, row version and status kept", () => {
    expect(a.toUserRow(userItem() as never)).toEqual({
      id: U(3), email: "c@t.test", role: "country", scopeAll: false, brands: ["Kia"], regions: null, countries: ["KR", "JP"],
      operator: "assigned", createdAt: "2026-06-30", lastSignInAt: "2026-09-01", rowVersion: 4, status: "suspended",
    });
    // 00:30 KST on 09-02 is still 09-01 in UTC (legacy: toISOString().slice(0, 10)).
    expect(a.toUserRow(userItem({ last_sign_in_at: "2026-09-02T00:30:00+09:00" }) as never).lastSignInAt).toBe("2026-09-01");
    expect(a.toUserRow(userItem() as never, true).lastSignInAt).toBeNull();
  });

  it("CatalogPrompt -> StandardCatalogRow and stats", () => {
    const row = a.toCatalogRow({
      prompt_id: U(9), text: "t", prompt_type: "comparison", category: "c", brand_code: "Kia", brand_presence: "branded", list_type: "L",
      depth1: "d1", depth2: null, depth3: null, depth4: null, funnel_stage: "인지", kind: "acr", lang: "KO", regions: ["KR"],
      scope_prompt_id: U(10), scope_text: "st", deleted_at: "2026-09-01T00:00:00.123456+00:00", status: "draft", tracked: true,
      created_at: "2026-01-01T00:00:00+00:00", updated_at: "2026-01-01T00:00:00+00:00", outbox_pending: true, outbox_error: null,
    } as never);
    expect(row).toEqual({
      id: U(9), text: "t", promptType: "comparison", category: "c", brand: "Kia", brandPresence: "branded", listType: "L",
      depth1: "d1", depth2: null, depth3: null, depth4: null, funnelStage: "인지", kind: "acr", lang: "KO", regions: ["KR"],
      scopePromptId: U(10), scopeText: "st", deletedAt: new Date("2026-09-01T00:00:00.123Z"),
    });
    expect(a.toCatalogStats({ total: 5, tracked: 3, untracked: 2, scope_orphans: 1, acr: 2, deleted: 4 })).toEqual({
      total: 5, tracked: 3, untracked: 2, scopeOrphans: 1, acr: 2, deleted: 4,
    });
  });

  it("labels: camel -> snake, only given keys; bulk item from a legacy-shaped item or the preview item", () => {
    expect(a.toApiLabels({ brand: "Kia", promptType: null, depth4: undefined, funnelStage: "x" })).toEqual({
      brand_code: "Kia", prompt_type: null, funnel_stage: "x",
    });
    expect(a.toApiBulkItem({ id: U(1), text: "t", labels: { brandPresence: "branded" }, regions: null })).toEqual({
      prompt_id: U(1), text: "t", labels: { brand_presence: "branded" }, regions: null,
    });
    expect(a.toApiBulkItem({ id: U(1), labels: {}, api: { prompt_id: U(2), text: "server" } })).toEqual({ prompt_id: U(1), text: "server" });
  });

  it("preview: backend keys -> legacy audit keys, the backend item kept opaque", () => {
    const p = a.toPreview({
      batch_id: U(7), unchanged: 2, unmatched_ids: ["x"], warnings: ["w"],
      items: [{ prompt_id: U(1), current_text: "cur", changes: { brand_code: { old: "Kia", new: null }, text: { old: "a", new: "b" } }, item: { prompt_id: U(1), text: "b" } }],
    } as never);
    expect(p).toEqual({
      batchId: U(7), unchanged: 2, unmatchedIds: ["x"], warnings: ["w"],
      items: [{ id: U(1), currentText: "cur", changes: { brand: { old: "Kia", new: null }, text: { old: "a", new: "b" } }, item: { id: U(1), labels: {}, api: { prompt_id: U(1), text: "b" } } }],
    });
  });

  it("entity, curation and GA4 rows", () => {
    expect(a.toEntityRow({ entity_id: U(4), name: "N", role: "competitor", registered: false, entity_type: "Brand", updated_at: null, brand_code: "Hyundai", brand_name: "Hyundai", answers: 7, mentions: 11 } as never)).toEqual({
      entityId: U(4), name: "N", mentions: 11, answers: 7, role: "competitor", brandCode: "Hyundai", brandName: "Hyundai",
    });
    const cur = a.toCurationRow({
      domain: "x.test", citations: 3, in_dim_source: true, category: { key: 2, name: "not-a-name", slug: "newsMedia" }, source: "social",
      shadows_owned: true, override: { category: { key: 2, name: "News & Media", slug: "newsMedia" }, note: "n", propagated: false, updated_at: "2026-09-01T00:00:00.5+09:00", updated_by: U(1) },
    } as never);
    expect(cur).toEqual({
      domain: "x.test", citations: 3, category: "News & Media", source: "social", shadowsOwned: true, overrideNote: "n",
      overrideUpdatedBy: U(1), overrideUpdatedAt: "2026-08-31T15:00:00.500Z",
    });
    expect(a.toTaxonomyCategory({ name: "??", slug: "??" })).toBe("Other");
    expect(a.toTaxonomyCategory(null)).toBe("Other");
    expect(a.toGa4PropertyRow({ property_id: "12", brand_code: null, country_code: null, status: "unmapped", verified_at: null } as never)).toEqual({
      id: "p:12", brand: "", countryCode: "", propertyId: "12", status: "unmapped", verifiedAt: null,
    });
    expect(a.toGa4MarketRow({ brand_code: "HYUNDAI N", country_code: "US" } as never)).toEqual({
      id: "m:HYUNDAI%20N:US", brand: "HYUNDAI N", countryCode: "US", propertyId: null, status: "unmapped", verifiedAt: null,
    });
    expect(a.parseGa4RowId("m:HYUNDAI%20N:US")).toEqual({ kind: "market", brand: "HYUNDAI N", country: "US" });
    expect(a.parseGa4RowId("p:12")).toEqual({ kind: "property", propertyId: "12" });
    for (const bad of ["p:1a", "p:", "m:X:USA", "m::US", "uuid-like", "m:%E0%A4%A:US"]) expect(a.parseGa4RowId(bad)).toBeNull();
  });

  it("keyword volume rows and the legacy summary formula (checked against the legacy function too)", () => {
    const rows = [
      { keyword: "a", search_volume: 150000, competition: "HIGH", competition_index: 80, cpc: 1.234, monthly_searches: [{ month: "2026-08-01", search_volume: 10 }, { month: "bad", search_volume: 1 }] },
      { keyword: "b", search_volume: null, competition: null, competition_index: null, cpc: null, monthly_searches: [] },
      { keyword: "c", search_volume: 20000, competition: "LOW", competition_index: 5, cpc: 0.5, monthly_searches: [{ month: "2026-07-01", search_volume: null }] },
    ].map((v) => a.toVolumeRow({ freshness: "fresh", term_norm: v.keyword, ...v } as never));
    expect(rows[0].monthly_searches).toEqual([{ year: 2026, month: 8, search_volume: 10 }]);
    expect(rows[1]).toEqual({ keyword: "b", search_volume: 0, competition: null, competition_index: 0, cpc: 0, monthly_searches: [] });
    expect(rows[2].monthly_searches).toEqual([{ year: 2026, month: 7, search_volume: 0 }]);
    // total 170000, avg round(170000/3)=56667, high 1 (>=100000), mid 1, low 1 (0),
    // competition index round(85/3)=28, cpc round((1.734/3)*100)/100 = 0.58
    const s = a.summarizeVolumes(rows);
    expect(s).toEqual({
      totalKeywords: 3, averageSearchVolume: 56667, totalSearchVolume: 170000, highVolumeCount: 1, mediumVolumeCount: 1,
      lowVolumeCount: 1, averageCompetitionIndex: 28, averageCPC: 0.58,
    });
    expect(s).toEqual(summarizeKeywordSearchVolume(rows as never));
    expect(a.summarizeVolumes([])).toEqual(summarizeKeywordSearchVolume([]));
  });

  it("interest lists come back in the legacy enum order, newest first inside a kind", () => {
    const items = [
      { k: "community_voc", t: "2026-09-02T00:00:00Z" },
      { k: "google_keyword", t: "2026-09-01T00:00:00Z" },
      { k: "zzz", t: "2026-09-09T00:00:00Z" },
      { k: "google_keyword", t: "2026-09-03T00:00:00Z" },
    ];
    expect(a.legacyKindOrder(items, (x) => x.k, a.KEYWORD_SOURCE_ORDER, (x) => x.t).map((x) => `${x.k}@${x.t.slice(8, 10)}`)).toEqual([
      "google_keyword@03", "google_keyword@01", "community_voc@02", "zzz@09",
    ]);
  });

  it("export file name: RFC 5987 first, plain next, legacy fallback", () => {
    expect(a.dispositionFilename(`attachment; filename="x.xlsx"; filename*=UTF-8''%EA%B8%80.xlsx`)).toBe("글.xlsx");
    expect(a.dispositionFilename(`attachment; filename="global-catalog-20260929.xlsx"`)).toBe("global-catalog-20260929.xlsx");
    expect(a.dispositionFilename(null)).toBeNull();
    expect(a.catalogExportFallbackName(new Date("2026-09-29T23:00:00Z"))).toBe("global-catalog-20260929.xlsx");
  });
});

// ── requests and error mapping ─────────────────────────────────────────────

describe("accounts", () => {
  it("list walks the cursor to the end; suppressed last sign-in reads as null", async () => {
    mock((c) =>
      c.query.includes("cursor=")
        ? data({ items: [userItem({ user_id: U(4) })] }, { page: { next_cursor: null, limit: 200 }, suppressed: { last_sign_in_at: "upstream" } })
        : data({ items: [userItem()] }, { page: { next_cursor: "n1", limit: 200 } }),
    );
    const rows = await withRequestScope(() => a.listAdminUsers());
    expect(calls.map((c) => c.query)).toEqual(["?limit=200", "?cursor=n1&limit=200"]);
    expect(rows.map((r) => [r.id, r.lastSignInAt])).toEqual([[U(3), "2026-09-01"], [U(4), null]]);
  });

  it("create: admin forces scope_all and empty axes, vendor forces operator none; errors map to form keys", async () => {
    mock(() => json(201, { data: { ...userItem(), email: "n@t.test", temp_password: "pw" }, meta: { mode: "crud" } }));
    const base = { email: "n@t.test", operator: "global" as const, scopeAll: false, brands: ["Kia"], regions: ["R"], countries: ["KR"] };
    expect(await a.createAccount({ ...base, role: "admin" })).toEqual({ ok: true, email: "n@t.test", tempPassword: "pw" });
    expect(calls[0].body).toMatchObject({ role: "admin", operator: "global", scope_all: true, scope_brands: [], scope_regions: [], scope_countries: [] });
    await a.createAccount({ ...base, role: "vendor" });
    expect(calls[1].body).toMatchObject({ role: "vendor", operator: "none", scope_all: false, scope_brands: ["Kia"], scope_countries: ["KR"] });
    const cases: Array<[number, string, string]> = [
      [422, "unprocessable", "admin.errors.createFailed"], // details do not name the e-mail field (M6)
      [409, "email_taken", "admin.errors.emailTaken"],
      [422, "constraint_violation", "admin.errors.scopeRequired"],
      [422, "unknown_scope_ref", "admin.errors.scopeRequired"],
      [502, "compensation_failed", "admin.errors.rollbackFailed"],
      [503, "auth_admin_unconfigured", "admin.errors.createFailed"],
    ];
    for (const [status, code, key] of cases) {
      mock(() => fail(status, code));
      expect(await a.createAccount({ ...base, role: "country" })).toEqual({ ok: false, errorKey: key });
    }
  });

  it("create: 422 unprocessable is 'invalid email' only when the details name the e-mail field (M6)", async () => {
    const base = { email: "n@t.test", operator: "none" as const, scopeAll: false, brands: ["Kia"], regions: null, countries: ["KR"], role: "country" as const };
    const unprocessable = (details: unknown) =>
      json(422, { error: { code: "unprocessable", message: "요청 검증 실패", details } });
    // FastAPI RequestValidationError shape (back/app/core/errors.py: [{loc, msg, type}]).
    mock(() => unprocessable([{ loc: ["body", "email"], msg: "value is not a valid email address", type: "value_error" }]));
    expect(await a.createAccount(base)).toEqual({ ok: false, errorKey: "admin.errors.invalidEmail" });
    // A feature error naming the field ({field}) reads the same.
    mock(() => unprocessable({ field: "email" }));
    expect(await a.createAccount(base)).toEqual({ ok: false, errorKey: "admin.errors.invalidEmail" });
    // A malformed scope item or operator is not an e-mail problem.
    mock(() => unprocessable([{ loc: ["body", "scope_brands", 0], msg: "string too long", type: "string_too_long" }]));
    expect(await a.createAccount(base)).toEqual({ ok: false, errorKey: "admin.errors.createFailed" });
    mock(() => unprocessable([{ loc: ["body", "operator"], msg: "bad enum", type: "enum" }]));
    expect(await a.createAccount(base)).toEqual({ ok: false, errorKey: "admin.errors.createFailed" });
    mock(() => unprocessable(null));
    expect(await a.createAccount(base)).toEqual({ ok: false, errorKey: "admin.errors.createFailed" });
  });

  it("patch sends If-Match and array axes; each guard code maps to its key", async () => {
    mock(() => data(userItem()));
    const patch = { role: "country" as const, operator: "none" as const, scopeAll: false, brands: null, regions: ["R"], countries: ["KR"] };
    expect(await a.patchAccount(U(3), patch, 4)).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ method: "PATCH", path: `/v1/admin/users/${U(3)}` });
    expect(calls[0].headers.get("if-match")).toBe("4");
    expect(calls[0].body).toEqual({ role: "country", operator: "none", scope_all: false, scope_brands: [], scope_regions: ["R"], scope_countries: ["KR"] });
    await a.patchAccount(U(3), { ...patch, scopeAll: true, status: "suspended" }, 5);
    expect(calls[1].body).toMatchObject({ scope_all: true, scope_brands: [], scope_regions: [], scope_countries: [], status: "suspended" });
    // no version: refused locally, nothing sent
    calls = [];
    expect(await a.patchAccount(U(3), patch, undefined)).toEqual({ ok: false, errorKey: "admin.errors.rowVersionConflict" });
    expect(calls).toEqual([]);
    const cases: Array<[number, string, string]> = [
      [422, "vendor_operator", "admin.errors.vendorOperatorForbidden"],
      [409, "self_demote", "admin.errors.cannotDemoteSelf"],
      [409, "last_admin", "admin.errors.lastAdminProtected"],
      [409, "row_version_conflict", "admin.errors.rowVersionConflict"],
      [428, "precondition_required", "admin.errors.updateFailed"],
      [404, "not_found", "admin.errors.updateFailed"],
    ];
    for (const [status, code, key] of cases) {
      mock(() => fail(status, code));
      expect(await a.patchAccount(U(3), patch, 1)).toEqual({ ok: false, errorKey: key });
    }
  });

  it("delete: guard codes map to keys; 401 / 403 throw UnauthorizedError; local faults rethrow", async () => {
    for (const [code, key] of [["self_delete", "cannotDeleteSelf"], ["last_admin", "lastAdminProtected"], ["user_referenced", "userReferenced"], ["delete_incomplete", "deleteFailed"]]) {
      mock(() => fail(409, code));
      expect(await a.deleteAccount(U(3))).toEqual({ ok: false, errorKey: `admin.errors.${key}` });
    }
    for (const status of [401, 403]) {
      mock(() => fail(status, status === 401 ? "unauthenticated" : "admin_only"));
      await expect(a.deleteAccount(U(3))).rejects.toBeInstanceOf(UnauthorizedError);
    }
    vi.stubEnv("HGH_API_BASE_URL", "");
    await expect(a.deleteAccount(U(3))).rejects.toMatchObject({ code: "client_config" });
  });
});

describe("catalog", () => {
  it("list: cursor to the end, stats from the first page", async () => {
    const item = (id: number) => ({ prompt_id: U(id), text: `t${id}`, kind: "single", status: "draft", tracked: false, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    mock((c) =>
      c.query.includes("cursor=")
        ? data({ items: [item(2)], stats: { total: 99, tracked: 0, untracked: 0, scope_orphans: 0, acr: 0, deleted: 0 } }, { page: { next_cursor: null } })
        : data({ items: [item(1)], stats: { total: 2, tracked: 1, untracked: 1, scope_orphans: 3, acr: 0, deleted: 1 } }, { page: { next_cursor: "p2" } }),
    );
    const out = await withRequestScope(() => a.listAdminCatalog());
    expect(out.rows.map((r) => r.id)).toEqual([U(1), U(2)]);
    expect(out.stats).toEqual({ total: 2, tracked: 1, untracked: 1, scopeOrphans: 3, acr: 0, deleted: 1 });
    expect(calls[0].query).toBe("?include_deleted=true&limit=500");
  });

  it("markets: unbounded -> []", async () => {
    mock(() => data({ bounded: false, items: [{ code: "KR", pseudo: false }] }));
    expect(await a.catalogMarketVocabulary()).toEqual([]);
    mock(() => data({ bounded: true, items: [{ code: "KR", pseudo: false }, { code: "x:EU", pseudo: true }] }));
    expect(await a.catalogMarketVocabulary()).toEqual(["KR", "x:EU"]);
  });

  it("delete / restore absorb state_mismatch; other codes give the legacy messages", async () => {
    mock(() => fail(409, "state_mismatch"));
    expect(await a.softDeleteCatalogPrompt(U(1))).toEqual({ ok: true, value: undefined });
    expect(await a.restoreCatalogPrompt(U(1))).toEqual({ ok: true, value: undefined });
    expect(await a.updateCatalogText(U(1), "x")).toEqual({ ok: false, error: "삭제된 행은 편집할 수 없습니다" });
    mock(() => fail(404, "not_found"));
    expect(await a.softDeleteCatalogPrompt(U(1))).toEqual({ ok: false, error: "글로벌 카탈로그 행을 찾을 수 없습니다" });
    expect(await a.setCatalogKind(U(1), "acr")).toEqual({ ok: false, error: "표준 카탈로그 행을 찾을 수 없습니다" });
    mock(() => fail(422, "unknown_brand"));
    expect(await a.updateCatalogLabels(U(1), { brand: "Nope" })).toEqual({ ok: false, error: "라벨 값이 올바르지 않습니다" });
    mock(() => fail(500, "internal"));
    expect(await a.restoreCatalogPrompt(U(1))).toEqual({ ok: false, error: "복원에 실패했습니다" });
    expect(calls.map((c) => c.body)).toContainEqual({ brand_code: "Nope" });
  });

  it("regions: format checked locally (nothing sent), vocabulary refusal names the values", async () => {
    mock(() => data({}));
    expect(await a.updateCatalogRegions(U(1), { regions: ["kr", "KOR"] })).toEqual({ ok: false, error: "시장 코드 형식이 아닙니다: KOR" });
    expect(await a.updateCatalogRegions(U(1), { lang: "english" })).toEqual({ ok: false, error: "언어 코드 형식이 아닙니다: ENGLISH" });
    expect(calls).toEqual([]);
    mock((c) => (c.method === "PATCH" ? fail(422, "region_out_of_vocabulary") : data({ bounded: true, items: [{ code: "KR", pseudo: false }] })));
    expect(await a.updateCatalogRegions(U(1), { regions: ["jp", "kr", "us"] })).toEqual({ ok: false, error: "이 프로젝트의 측정 시장이 아닙니다: JP, US" });
    expect(calls[0].body).toEqual({ regions: ["JP", "KR", "US"] });
    mock(() => data({}));
    calls = [];
    expect(await a.updateCatalogRegions(U(1), { regions: null, lang: null })).toEqual({ ok: true, value: undefined });
    expect(calls[0].body).toEqual({ regions: null, lang: null });
  });

  it("bulk apply: applied counts unchanged rows, failures keep the row id; bulk regions likewise", async () => {
    mock(() => data({ applied: 2, unchanged: 1, batch_id: U(9), change_ids: [], outbox_ids: [], failed: [{ prompt_id: U(3), code: "state_mismatch", message: "m" }] }));
    expect(await a.applyCatalogChunk([{ id: U(1), labels: { brand: "Kia" } }], U(9))).toEqual({
      ok: true, value: { applied: 3, failed: [{ id: U(3), error: "삭제된 행은 편집할 수 없습니다" }] },
    });
    expect(calls[0].body).toEqual({ batch_id: U(9), items: [{ prompt_id: U(1), labels: { brand_code: "Kia" } }] });
    mock(() => data({ updated: 1, unchanged: 2, batch_id: U(9), outbox_ids: [], failed: [{ prompt_id: U(4), code: "region_out_of_vocabulary", message: "m" }] }));
    expect(await a.bulkCatalogRegions([U(1)], ["KR"])).toEqual({
      ok: true, value: { updated: 3, failed: [{ id: U(4), error: "이 프로젝트의 측정 시장이 아닙니다" }] },
    });
  });

  it("export: bytes to base64, file name from the header or the legacy fallback", async () => {
    mock(() => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-disposition": `attachment; filename="c.xlsx"` } }));
    expect(await a.exportCatalogXlsx()).toEqual({ ok: true, value: { base64: "AQID", filename: "c.xlsx" } });
    expect(calls[0].headers.get("accept")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });

  it("preview: multipart relay; 413 before sending when over the limit", async () => {
    mock(() => data({ batch_id: U(7), unchanged: 0, unmatched_ids: [], warnings: [], items: [] }));
    const file = new File([new Uint8Array([1])], "c.xlsx");
    expect(await a.previewCatalogImport(file)).toEqual({ ok: true, value: { batchId: U(7), unchanged: 0, unmatchedIds: [], warnings: [], items: [] } });
    expect(calls[0].body).toBeInstanceOf(FormData);
    vi.stubEnv("HGH_UPLOAD_MAX_BYTES", "1");
    calls = [];
    expect(await a.previewCatalogImport(new File([new Uint8Array([1, 2])], "c.xlsx"))).toEqual({ ok: false, error: "파일이 너무 큽니다" });
    expect(calls).toEqual([]);
  });
});

describe("interest, entities, citation overrides, GA4", () => {
  it("interest deletes absorb 404; unknown brand is named", async () => {
    mock(() => fail(404, "not_found"));
    expect(await a.deleteInterestKeyword(U(1))).toEqual({ ok: true, value: undefined });
    expect(await a.deleteInterestSource(U(1))).toEqual({ ok: true, value: undefined });
    expect(await a.setInterestKeywordEnabled(U(1), false)).toEqual({ ok: false, error: "항목을 찾을 수 없습니다. 목록을 새로 고쳐 주세요" });
    mock(() => fail(422, "unknown_brand"));
    expect(await a.createInterestKeyword({ term: "x", sourceType: "google_keyword", brand: "Nope", notes: null })).toEqual({ ok: false, error: "알 수 없는 브랜드입니다" });
    expect(calls.at(-1)?.body).toEqual({ term: "x", source_type: "google_keyword", brand_code: "Nope", notes: null, enabled: true });
  });

  it("entity role: brand code only for own; codes map to messages", async () => {
    mock(() => data({ entity_id: U(1), role: "own", name: "n", brand_code: "Kia", applied: true }));
    await a.setAdminEntityRole(U(1), "n", "own", "Kia");
    await a.setAdminEntityRole(U(1), "n", "competitor", "Kia");
    expect(calls.map((c) => c.body)).toEqual([{ role: "own", name: "n", brand_code: "Kia" }, { role: "competitor", name: "n" }]);
    for (const [code, msg] of [["brand_required", "자사 지정에는 브랜드가 필요합니다"], ["invalid_brand", "알 수 없는 브랜드이거나 엄브렐러입니다"], ["duplicate_pending", "같은 엔티티의 변경 요청이 이미 대기 중입니다"]]) {
      mock(() => fail(code === "duplicate_pending" ? 409 : 422, code));
      expect(await a.setAdminEntityRole(U(1), "n", "own", null)).toEqual({ ok: false, error: msg });
    }
  });

  it("citation override: note trimmed to null, delete absorbs 404, pending duplicate named", async () => {
    mock(() => data({ domain: "a.test" }));
    await a.putCitationOverride("a.test", "Other", "  ");
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/v1/admin/citation-overrides/a.test", body: { category: "Other", note: null } });
    mock(() => fail(404, "not_found"));
    expect(await a.deleteCitationOverride("a.test")).toEqual({ ok: true, value: undefined });
    mock(() => fail(409, "duplicate_pending"));
    expect(await a.putCitationOverride("a.test", "Other", null)).toEqual({ ok: false, error: "같은 도메인의 변경 요청이 대기 중입니다" });
  });

  it("GA4: no property id -> pending market PUT; verify re-sends the market or looks it up; remove by row kind", async () => {
    mock((c) => (c.method === "GET" ? data({ items: [{ property_id: "7", brand_code: "Kia", country_code: "US", status: "active" }] }) : data({ verified: true })));
    await a.putGa4Mapping("Kia", "US", "");
    await a.putGa4Mapping("Kia", "US", "7");
    await a.verifyGa4Property("7", { brand: "Kia", countryCode: "US" });
    await a.verifyGa4Property("7", null);
    await a.removeGa4Row("m:Kia:US");
    await a.removeGa4Row("p:7");
    expect(calls.map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body ?? null)}`)).toEqual([
      'PUT /v1/admin/ga4/markets/Kia/US {}',
      'PUT /v1/admin/ga4/properties/7 {"brand_code":"Kia","country_code":"US","verify":false}',
      'PUT /v1/admin/ga4/properties/7 {"brand_code":"Kia","country_code":"US","verify":true}',
      "GET /v1/admin/ga4/properties null",
      'PUT /v1/admin/ga4/properties/7 {"brand_code":"Kia","country_code":"US","verify":true}',
      "DELETE /v1/admin/ga4/markets/Kia/US null",
      "DELETE /v1/admin/ga4/properties/7 null",
    ]);
    calls = [];
    expect(await a.removeGa4Row("some-legacy-uuid")).toEqual({ ok: false, error: "매핑을 찾을 수 없습니다. 목록을 새로 고쳐 주세요" });
    expect(calls).toEqual([]);
    mock(() => fail(409, "market_taken"));
    expect(await a.putGa4Mapping("Kia", "US", "8")).toEqual({ ok: false, error: "같은 브랜드·국가에 다른 속성이 이미 매핑돼 있습니다" });
    mock(() => fail(422, "ga4_verify_failed"));
    expect(await a.verifyGa4Property("7", { brand: "Kia", countryCode: "US" })).toEqual({ ok: false, error: "검증 실패: GA4 읽기 권한을 확인하세요" });
    mock(() => fail(404, "not_found"));
    expect(await a.removeGa4Row("p:7")).toEqual({ ok: true, value: undefined });
  });

  it("degradeRead: 5xx -> empty, 401/403/404 and local faults rethrown", () => {
    expect(a.degradeRead(new HghApiError(503, "unavailable"), [])).toEqual([]);
    for (const e of [new HghApiError(401, "unauthenticated"), new HghApiError(403, "menu_forbidden"), new HghApiError(404, "not_found"), new HghApiError(500, "client_config"), new HghApiError(500, "page_limit_exceeded")]) {
      expect(() => a.degradeRead(e, [])).toThrow(e);
    }
    expect(() => a.degradeRead(new Error("boom"), [])).toThrow("boom");
  });
});

// ── keyword tools ───────────────────────────────────────────────────────────

const vol = (keyword: string, sv: number | null, freshness = "fresh") => ({
  keyword, term_norm: keyword, search_volume: sv, competition: sv ? "LOW" : null, competition_index: 1, cpc: 0.1, freshness,
  monthly_searches: [], observed_at: null, month: null,
});
const fetchState = (status: string, extra: Record<string, unknown> = {}) => ({ status, change_id: null, pending_change_ids: [], pending_terms: [], terms: [], ...extra });

describe("keyword tools", () => {
  it("fresh volume: rows without never-collected terms, volume desc, legacy summary", async () => {
    mock(() => data({ fetch: fetchState("fresh"), keywords: [vol("a", 10), vol("b", null, "missing"), vol("c", 30)], missing: ["b"], summary: {}, location_code: 2410, language_code: "ko" }));
    const out = await a.lookupKeywordVolumes(["a", "b", "c"], 2410, "ko");
    expect(out.keywords.map((k) => k.keyword)).toEqual(["c", "a"]);
    expect(out.pending).toEqual([]);
    expect(out.summary.totalSearchVolume).toBe(40);
    expect(calls[0].body).toEqual({ keywords: ["a", "b", "c"], force: false, location_code: 2410, language_code: "ko" });
  });

  it("queued volume: polls the change until applied, then asks once more", async () => {
    let posts = 0;
    mock((c) => {
      if (c.method === "GET") return data({ change_id: 5, status: "applied", kind: "dfs_fetch", requested_at: "2026-09-29T00:00:00Z" });
      posts += 1;
      return posts === 1
        ? json(202, { data: { fetch: fetchState("queued", { change_id: 5, pending_terms: ["a"] }), keywords: [], missing: ["a"], summary: {}, location_code: 1, language_code: "ko" }, meta: { mode: "external" } })
        : data({ fetch: fetchState("fresh"), keywords: [vol("a", 5)], missing: [], summary: {}, location_code: 1, language_code: "ko" });
    });
    const out = await a.lookupKeywordVolumes(["a"]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/admin/keyword-tools/volume",
      "GET /v1/admin/changes/5",
      "POST /v1/admin/keyword-tools/volume",
    ]);
    expect(out).toMatchObject({ pending: [], keywords: [{ keyword: "a", search_volume: 5 }] });
  });

  it("queued prompt-to-volume: one LLM POST, then the SAME keywords re-read with POST .../volume (M2)", async () => {
    // Probe P2 of the verification: a second prompt-to-volume POST would bill the LLM again and
    // could extract other keywords ([beta]), throwing away the collected alpha volume.
    let extractions = 0;
    mock((c) => {
      if (c.method === "GET") return data({ change_id: 7, status: "applied", kind: "dfs_fetch", requested_at: "2026-09-29T00:00:00Z" });
      if (c.path.endsWith("/prompt-to-volume")) {
        extractions += 1;
        const kw = extractions === 1 ? "alpha" : "beta";
        return json(202, {
          data: { fetch: fetchState("queued", { change_id: 7, pending_terms: [kw] }), keywords: [kw], volume: null, volumes: [], language_code: "ko", location_code: 2410 },
          meta: { mode: "external" },
        });
      }
      return data({ fetch: fetchState("fresh"), keywords: [vol("alpha", 40)], missing: [], summary: {}, location_code: 2410, language_code: "ko" });
    });
    const out = await a.promptToVolume("p", 2410, "ko");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /v1/admin/keyword-tools/prompt-to-volume",
      "GET /v1/admin/changes/7",
      "POST /v1/admin/keyword-tools/volume",
    ]);
    expect(extractions).toBe(1);
    expect(calls[2].body).toEqual({ keywords: ["alpha"], force: false, location_code: 2410, language_code: "ko" });
    expect(out).toEqual({ volume: 40, keywords: ["alpha"], debug: { extractedKeywords: ["alpha"], volumes: [{ keyword: "alpha", volume: 40 }] } });
    // A re-read that is still pending keeps the pending terms; zero volume reads as null (legacy).
    mock((c) =>
      c.method === "GET"
        ? data({ change_id: 7, status: "applied", kind: "dfs_fetch", requested_at: "2026-09-29T00:00:00Z" })
        : c.path.endsWith("/prompt-to-volume")
          ? json(202, { data: { fetch: fetchState("queued", { change_id: 7, pending_terms: ["a", "b"] }), keywords: ["a", "b"], volume: null, volumes: [], language_code: "ko", location_code: 1 }, meta: { mode: "external" } })
          : json(202, { data: { fetch: fetchState("pending", { pending_terms: ["b"] }), keywords: [vol("a", 0)], missing: ["b"], summary: {}, location_code: 1, language_code: "ko" }, meta: { mode: "external" } }),
    );
    expect(await a.promptToVolume("p")).toEqual({
      volume: null, keywords: ["a", "b"], debug: { extractedKeywords: ["a", "b"], volumes: [{ keyword: "a", volume: 0 }] }, pending: ["b"],
    });
  });

  it("LLM calls wait KEYWORD_LLM_TIMEOUT_MS (above ONE backend LLM attempt, 180 s; not its retry, U11-N9); routes' maxDuration covers it (M3)", async () => {
    expect(a.KEYWORD_LLM_TIMEOUT_MS).toBeGreaterThan(180_000);
    // U11-N9 (declared): the backend retries once (180 + 1.5 + 180 s worst case); the BFF waits
    // for the first attempt only. Covering the retry would change the declaration.
    expect(a.KEYWORD_LLM_TIMEOUT_MS).toBeLessThan(180_000 + 1_500 + 180_000);
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      mock((c) =>
        c.path.endsWith("/to-prompt")
          ? data({ questions: [], total_questions: 0, source_keywords: 1, failed_batches: 0 })
          : data({ fetch: fetchState("fresh"), keywords: ["k"], volume: 1, volumes: [vol("k", 1)], language_code: "ko", location_code: 1 }),
      );
      await a.keywordsToPrompts(["k"], undefined, 10);
      await a.promptToVolume("p");
      expect(spy.mock.calls.map((c) => c[0])).toEqual([a.KEYWORD_LLM_TIMEOUT_MS, a.KEYWORD_LLM_TIMEOUT_MS]);
      // D-7: both LLM calls tell the backend the same wait (it bounds the call, retry included)
      expect(calls.map((c) => [c.path, c.headers.get("x-hgh-timeout-ms")])).toEqual([
        ["/v1/admin/keyword-tools/to-prompt", String(a.KEYWORD_LLM_TIMEOUT_MS)],
        ["/v1/admin/keyword-tools/prompt-to-volume", String(a.KEYWORD_LLM_TIMEOUT_MS)],
      ]);
    } finally {
      spy.mockRestore();
    }
    // Route budget: to-prompt = one LLM call; prompt-to-volume = LLM call + collection wait + one
    // volume re-read (external class, 70 s).
    expect(toPromptRoute.maxDuration * 1000).toBeGreaterThan(a.KEYWORD_LLM_TIMEOUT_MS);
    expect(promptToVolumeRoute.maxDuration * 1000).toBeGreaterThan(a.KEYWORD_LLM_TIMEOUT_MS + a.KEYWORD_POLL_BUDGET_MS + 70_000);
  });

  it("waitForChanges: gives up at the budget (false), 404 counts as done, other errors propagate", async () => {
    mock(() => data({ change_id: 1, status: "pending" }));
    expect(await a.waitForChanges([1], 30, 10)).toBe(false);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    mock(() => fail(404, "not_found"));
    expect(await a.waitForChanges([1, 2], 30, 10)).toBe(true);
    mock(() => fail(500, "internal"));
    await expect(a.waitForChanges([1], 30, 10)).rejects.toMatchObject({ status: 500 });
  });

  it("route error bodies: bad input 400, auth as is, everything else 500 with the code only", () => {
    expect(a.keywordRouteError(new HghApiError(422, "no_keywords"), "g")).toEqual({ status: 400, body: { error: "keywords array is required and must not be empty" } });
    expect(a.keywordRouteError(new HghApiError(422, "unknown_location"), "g")).toEqual({ status: 400, body: { error: "unknown_location" } });
    expect(a.keywordRouteError(new HghApiError(403, "menu_forbidden"), "g")).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(a.keywordRouteError(new HghApiError(502, "llm_failed"), "g")).toEqual({ status: 500, body: { error: "g", details: "llm_failed" } });
    expect(a.keywordRouteError(new HghApiError(500, "client_config", "HGH_API_BASE_URL is not set"), "g")).toEqual({ status: 500, body: { error: "g", details: "client_config" } });
  });

  it("gate: admin and the keyword-tools screen menu group", () => {
    expect(a.canUseKeywordTools({ role: "admin", menuGroups: null })).toBe(true);
    expect(a.canUseKeywordTools({ role: "admin", menuGroups: ["admin"] })).toBe(true);
    expect(a.canUseKeywordTools({ role: "admin", menuGroups: ["standard"] })).toBe(false);
    expect(a.canUseKeywordTools({ role: "hq", menuGroups: null })).toBe(false);
  });
});

const post = (path: string, body: unknown) =>
  new Request(`http://front.test${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }) as never;

describe("/api/keyword/{volume,to-prompt,prompt-to-volume} routes", () => {
  it("both sources: no session 401, non-admin or admin without the admin menu 403, before any backend or legacy call", async () => {
    mock(() => data({}));
    for (const source of ["legacy", "api"]) {
      vi.stubEnv("HGH_SOURCE_G7", source);
      for (const [session, status] of [
        [null, 401],
        [{ user: { id: U(2), role: "hq", scope: { all: true }, operator: "none", menuGroups: null } }, 403],
        [{ user: { id: U(1), role: "admin", scope: { all: true }, operator: "global", menuGroups: ["standard"] } }, 403],
      ] as const) {
        st.session = session;
        expect((await volumeRoute.POST(post("/api/keyword/volume", { keywords: ["a"] }))).status).toBe(status);
        expect((await toPromptRoute.POST(post("/api/keyword/to-prompt", { keywords: ["a"] }))).status).toBe(status);
        expect((await promptToVolumeRoute.POST(post("/api/keyword/prompt-to-volume", { promptText: "p" }))).status).toBe(status);
      }
    }
    expect(calls).toEqual([]);
    expect(st.legacyVolumeCalls).toBe(0);
  });

  it("api volume: legacy body shape plus pending terms; empty keywords 400 without a call", async () => {
    mock(() => json(202, { data: { fetch: fetchState("pending", { change_id: null, pending_terms: ["b"] }), keywords: [vol("a", 7), vol("b", null, "missing")], missing: ["b"], summary: {}, location_code: 1, language_code: "ko" }, meta: { mode: "external" } }));
    const res = await volumeRoute.POST(post("/api/keyword/volume", { keywords: ["a", "b"], locationCode: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, count: 1, pending: ["b"], keywords: [{ keyword: "a", search_volume: 7, competition: "LOW", monthly_searches: [] }] });
    expect(body.summary).toMatchObject({ totalKeywords: 1, totalSearchVolume: 7 });
    calls = [];
    expect((await volumeRoute.POST(post("/api/keyword/volume", { keywords: [] }))).status).toBe(400);
    expect(calls).toEqual([]);
    expect(st.legacyVolumeCalls).toBe(0);
  });

  it("api to-prompt and prompt-to-volume: legacy body shapes; backend failure -> 500 with the code, no message leak", async () => {
    mock((c) =>
      c.path.endsWith("/to-prompt")
        ? data({ questions: [{ original_input: "k", question: "q?", search_intent: "commercial", volume: null }], total_questions: 1, source_keywords: 1, failed_batches: 0 })
        : data({ fetch: fetchState("fresh"), keywords: ["k1"], volume: 12, volumes: [vol("k1", 12)], language_code: "ko", location_code: 1 }),
    );
    const tp = await (await toPromptRoute.POST(post("/api/keyword/to-prompt", { keywords: ["k"], keywordVolumeMap: { k: 3 }, maxQuestions: 900 }))).json();
    expect(tp).toEqual({ success: true, data: { questions: [{ originalInput: "k", question: "q?", searchIntent: "commercial", volume: null }], totalQuestions: 1, sourceKeywords: 1 } });
    expect(calls[0].body).toEqual({ keywords: ["k"], keyword_volume_map: { k: 3 }, max_questions: 500 });
    const pv = await (await promptToVolumeRoute.POST(post("/api/keyword/prompt-to-volume", { promptText: "p" }))).json();
    expect(pv).toEqual({ volume: 12, keywords: ["k1"], debug: { extractedKeywords: ["k1"], volumes: [{ keyword: "k1", volume: 12 }] } });
    mock(() => fail(502, "llm_failed"));
    const bad = await toPromptRoute.POST(post("/api/keyword/to-prompt", { keywords: ["k"] }));
    expect(bad.status).toBe(500);
    expect(await bad.json()).toEqual({ error: "Failed to generate prompts", details: "llm_failed" });
  });

  it("api: a local deployment fault answers 500 with the code only, no configuration text (M4)", async () => {
    // Probe P1 of the verification: HGH_API_BASE_URL unset leaked "HGH_API_BASE_URL is not set".
    vi.stubEnv("HGH_API_BASE_URL", "");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const [res, generic] of [
        [await volumeRoute.POST(post("/api/keyword/volume", { keywords: ["a"] })), "Failed to fetch keyword volumes"],
        [await toPromptRoute.POST(post("/api/keyword/to-prompt", { keywords: ["a"] })), "Failed to generate prompts"],
        [await promptToVolumeRoute.POST(post("/api/keyword/prompt-to-volume", { promptText: "p" })), "Failed to fetch search volume"],
      ] as const) {
        expect(res.status).toBe(500);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ error: generic, details: "client_config" });
        expect(text).not.toContain("HGH_API_BASE_URL");
      }
      // The message stays in the server log.
      expect(err.mock.calls.some((c) => String(c.join(" ")).includes("HGH_API_BASE_URL is not set"))).toBe(true);
      // A bad token from the provider (auth_unbound family) likewise answers its code only.
      vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
      bindHghAuth({ getAccessToken: async () => "not-a-token", refreshAccessToken: async () => null });
      const res = await volumeRoute.POST(post("/api/keyword/volume", { keywords: ["a"] }));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Failed to fetch keyword volumes", details: "client_config" });
    } finally {
      err.mockRestore();
    }
  });

  it("legacy source keeps the legacy route (no backend call)", async () => {
    vi.stubEnv("HGH_SOURCE_G7", "legacy");
    mock(() => data({}));
    const res = await volumeRoute.POST(post("/api/keyword/volume", { keywords: ["a"] }));
    expect(await res.json()).toMatchObject({ success: true, count: 0 });
    expect(st.legacyVolumeCalls).toBe(1);
    expect(calls).toEqual([]);
  });
});
