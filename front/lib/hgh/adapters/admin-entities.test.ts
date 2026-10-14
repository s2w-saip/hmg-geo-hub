import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit tests of lib/hgh/adapters/admin-entities.ts (E7): conversions with hand-computed
// expectations (preview KPI ratios and ordering, entity list merge), request shapes of every
// write, and the error-key mapping. The fetch transport is stubbed; no backend runs.

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join: j } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(j(root, "cjs", "react.react-server.development.js"));
});
vi.mock("@/lib/auth/session", () => ({ getSession: async () => null }));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { UnauthorizedError } = await import("@/lib/auth/errors");
const { HghApiError, LOCAL_CODES } = await import("@/lib/hgh/errors");
const e = await import("./admin-entities");
const { isApplyBusy } = await import("@/lib/hgh/ecat-model");
const { PREVIEW } = await import("./admin-entities.fixture");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const U = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

interface Call {
  method: string;
  path: string;
  query: string;
  body: unknown;
}
let calls: Call[] = [];
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const data = (d: unknown) => json(200, { data: d, meta: { mode: "admin" } });
const fail = (status: number, code: string) => json(status, { error: { code, message: code } });

function mock(handler: (c: Call) => Response) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const raw = init.body;
    const c = { method: init.method ?? "GET", path: url.pathname, query: url.search, body: typeof raw === "string" ? JSON.parse(raw) : raw };
    calls.push(c);
    return handler(c);
  });
}

beforeEach(() => {
  calls = [];
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  vi.stubEnv("HGH_RELAY_SECRET", "");
  vi.stubEnv("HGH_SOURCE_G7", "api");
  bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: async () => null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  bindHghAuth(null);
});

// ── fixtures ────────────────────────────────────────────────────────────────

const override = (id: string, role: string, over: Record<string, unknown> = {}) => ({
  entity_id: id, origin: "scope", role, name: `n${id.slice(-2)}`, rep_name: null, entity_type: "Brand", brand_code: null, brand_name: null,
  merge_into: null, parent_brand_id: null, note: null, observed: true, updated_at: null, updated_by: null, ...over,
});
const summary = (ver: number, status: string) => ({
  ver, status, title: `t${ver}`, reason: null, origin: "admin", based_on: ver - 1, created_at: "2026-10-01T00:00:00+00:00",
  created_by: U(1), activated_at: null, retired_at: null, submitted_at: null, entity_rows: 0, surface_rows: 0, last_apply: null,
});
const detail = (ver: number, status: string, entities: unknown[], surfaces: unknown[] = []) =>
  e.toVersionDetail({ version: summary(ver, status), content_md5: null, entities, surfaces, lint: null } as never);

// ── conversions ─────────────────────────────────────────────────────────────

describe("preview conversion", () => {
  it("ratios per brand, rounds summed, groups ordered by the largest change", () => {
    const p = e.toPreview(PREVIEW)!;
    expect(p.impact).toEqual({ entities: 2, impactedAnswers: 120, workAnswers: 130, changedAnswers: 90, promptRuns: 4, orphanPromptRuns: 1, blockSurfaces: 1, addSurfaces: 0 });
    expect(p.cycles).toEqual({ inScope: 3, exposed: [{ cycKey: 5, roundDate: "2026-09-20", surface: "global" }] });
    expect(p.approx).toEqual({ noOccurrenceAnswers: 30, acrAnswers: 2 });
    // largest change first: KR/chatgpt (10pp), then the Kia round (SoV 0 -> 25 counts as 25pp), then US (2pp)
    expect(p.kpiTop.map((r) => r.key)).toEqual(["6:1:1", "5:1:1", "5:2:2"]);
    const kr = p.kpiTop[1].brands.Hyundai;
    expect(kr).toEqual({ visBefore: 50, visAfter: 40, sovBefore: 20, sovAfter: 25, posBefore: 2, posAfter: 2 });
    // round 2026-09-20 = KR + US summed: tracked 15/60 -> 15/60, SoV 12/110 -> 12/108
    const r = p.kpiByRound.find((x) => x.roundDate === "2026-09-20")!;
    expect(r.exposed).toBe(true);
    expect(r.brands.Hyundai.visBefore).toBeCloseTo(25);
    expect(r.brands.Hyundai.visAfter).toBeCloseTo(25);
    expect(r.brands.Hyundai.sovBefore).toBeCloseTo((12 / 110) * 100);
    expect(r.brands.Hyundai.sovAfter).toBeCloseTo((12 / 108) * 100);
    expect(r.answersBefore).toBe(60);
    // newest round first
    expect(p.kpiByRound.map((x) => `${x.roundDate}:${x.surface}`)).toEqual(["2026-09-27:website", "2026-09-20:global"]);
    // zero base -> null, not 0
    expect(p.kpiByRound[0].brands.Kia.sovBefore).toBeNull();
    expect(p.kpiByRound[0].brands.Kia.sovAfter).toBe(25);
    expect(p.brands).toEqual([{ bare: "Tesla", beforeMentions: 40, afterMentions: 35, deltaMentions: -5, beforeAnswers: 20, afterAnswers: 18, deltaAnswers: -2 }]);
    expect(p.samples.removed[0]).toEqual({ change: "block", answerKey: 1, name: "N", surface: "N", context: "the N line", highlight: [4, 5], approx: false });
    expect(p.samples.moved[0]).toMatchObject({ context: null, highlight: null, approx: true });
  });

  it("re-freeze plan and card values of frozen rounds (summed per round like the live values)", () => {
    expect(e.toPreview(PREVIEW)!.refreeze).toBeNull();
    expect(e.toPreview(PREVIEW)!.kpiTop.every((r) => r.card === null)).toBe(true);
    const z = { answers: 10, total_mentions: 10, tracked: 0, own_mentions: 0, sent_pos: 0, sent_neg: 0, sent_all: 0, rank_sum: 0, ranked: 0 };
    const own = (h: Partial<typeof z>) => ({ Hyundai: { ...z, ...h }, Kia: z, Genesis: z });
    const kpi = PREVIEW.kpi.map((r, i) =>
      i < 2 ? { ...r, card: { before: own({ tracked: 5, own_mentions: 2 }), after: own({ tracked: 4, own_mentions: 1 }) } } : r,
    );
    const refreeze = { applies: true, count: 2, exposed: 1, note: "노출 회차 1개 재동결", approx: "x",
      cycles: [{ cyc_key: 5, gen_key: 9, round_date: "2026-09-20", surface: 1, exposed: true }, { cyc_key: 6, gen_key: 10, round_date: "2026-09-27", surface: 2, exposed: false }] };
    const p = e.toPreview({ ...PREVIEW, kpi, refreeze })!;
    expect(p.refreeze).toEqual({ applies: true, count: 2, exposed: 1, note: "노출 회차 1개 재동결", approx: true,
      cycles: [{ cycKey: 5, roundDate: "2026-09-20", surface: "global", exposed: true }, { cycKey: 6, roundDate: "2026-09-27", surface: "website", exposed: false }] });
    expect(e.toPreview({ ...PREVIEW, kpi, refreeze: { ...refreeze, approx: undefined } })!.refreeze!.approx).toBe(false);
    const kr = p.kpiTop.find((r) => r.key === "5:1:1")!;
    expect(kr.card!.brands.Hyundai).toMatchObject({ visBefore: 50, visAfter: 40, sovBefore: 20, sovAfter: 10 });
    expect(p.kpiTop.find((r) => r.key === "6:1:1")!.card).toBeNull();
    // round 2026-09-20 = KR + US card counts summed: tracked 10/20 -> 8/20
    const r = p.kpiByRound.find((x) => x.roundDate === "2026-09-20")!;
    expect(r.card!.brands.Hyundai.visBefore).toBeCloseTo(50);
    expect(r.card!.brands.Hyundai.visAfter).toBeCloseTo(40);
    expect(r.card!.answersBefore).toBe(20);
    expect(p.kpiByRound.find((x) => x.roundDate === "2026-09-27")!.card).toBeNull();
  });

  it("hidden role changes: the preview list when present, else counted from the version diff", () => {
    expect(e.toPreview(PREVIEW)!.hiddenChanges).toBeNull();
    const hidden = { all_periods: true, count: 3, changes: [{ entity_id: "x" }], truncated: false, note: "n" };
    expect(e.toPreview({ ...PREVIEW, hidden })!.hiddenChanges).toBe(3);                      // loader preview.hidden (count)
    expect(e.toPreview({ ...PREVIEW, hidden: { changes: [{}, {}] } })!.hiddenChanges).toBe(2);
    const d = e.toDiff({
      ver: 3, against: 2, counts: {},
      entities: [
        { entity_id: "a", change: "added", after: { role: "hidden" } },
        { entity_id: "b", change: "changed", fields: ["role"], before: { role: "hidden" }, after: { role: "competitor" } },
        { entity_id: "c", change: "changed", fields: ["note"], before: { role: "hidden", note: null }, after: { role: "hidden", note: "x" } },
        { entity_id: "d", change: "added", after: { role: "removed" } },
      ],
      surfaces: [],
    } as never);
    expect(e.hiddenChangesInDiff(d)).toBe(2);
  });

  it("abandon pins (review N2): snake to camel, absent = null", () => {
    expect(e.toAbandonPins(null)).toBeNull();
    expect(
      e.toAbandonPins({ state: "abandoned", new_ver: 3, active_ver: null, unexposed: 1, requires_approval_later: true,
        cycles: [{ cyc_key: 12, round_date: "2026-09-21", surface: "website", exposed: false, pin_ver: 2 }] } as never),
    ).toEqual({ state: "abandoned", newVer: 3, activeVer: null, unexposed: 1, requiresApprovalLater: true,
      cycles: [{ cycKey: 12, roundDate: "2026-09-21", surface: "website", exposed: false, pinVer: 2 }] });
  });

  it("unknown preview shape reads as null (and the apply says unreadable)", () => {
    expect(e.toPreview({ v: 2 })).toBeNull();
    expect(e.toPreview(null)).toBeNull();
    const d = e.toApplyDetail({
      apply_id: 1, ver: 2, from_ver: 1, status: "previewed", scope_kind: "unexposed", reason: "r", requested_at: "2026-10-01T00:00:00Z",
      requested_by: U(1), has_preview: true, requires_approval: false, approver_required: false, can_approve: true, actions: ["approve"],
      preview: { v: 99 }, queue: [],
    } as never);
    expect(d.preview).toBeNull();
    expect(d.previewUnreadable).toBe(true);
  });

  it("apply busy states (the page polls on these)", () => {
    const b = (status: string, hasPreview = false, errorCode: string | null = null) => isApplyBusy({ status, hasPreview, errorCode });
    expect([b("draft"), b("draft", true), b("previewed", true), b("approved", true), b("running", true), b("applied", true)]).toEqual([
      true, false, false, true, true, false,
    ]);
    expect(b("draft", false, "ECAT_SCAN_FAILED")).toBe(false);
    expect(b("approved", true, "ECAT_CHUNK")).toBe(false);
    // an open queue request keeps polling even with an error (abandon in progress, draft request edited before its preview)
    const q = (status: string) => [{ status }];
    expect(isApplyBusy({ status: "failed", hasPreview: true, errorCode: "ECAT_APPLY_ABANDONING", queue: q("pending") })).toBe(true);
    expect(isApplyBusy({ status: "draft", hasPreview: false, errorCode: "ECAT_PREVIEW_STALE", queue: q("running") })).toBe(true);
    expect(isApplyBusy({ status: "failed", hasPreview: true, errorCode: "ECAT_SCAN_FAILED", queue: q("failed") })).toBe(false);
  });
});

describe("entity list merge", () => {
  const list = [
    { entity_id: U(1), name: "Hyundai", role: "own", registered: true, entity_type: "Brand", brand_code: "Hyundai", brand_name: "Hyundai", answers: 9, mentions: 20, updated_at: null },
    // active projection shows removed as competitor: the version row must win
    { entity_id: U(2), name: "Epit", role: "competitor", registered: false, entity_type: "Brand", brand_code: null, brand_name: "Epit", answers: 3, mentions: 3, updated_at: null },
    { entity_id: U(3), name: "BMW", role: "competitor", registered: false, entity_type: "Brand", brand_code: null, brand_name: "BMW", answers: 5, mentions: 6, updated_at: null },
  ] as never[];

  it("role from the active version, draft role and change flag, hub rows appended", () => {
    const active = detail(2, "active", [override(U(1), "own", { brand_code: "Hyundai" }), override(U(2), "removed")]);
    const draft = detail(3, "draft", [
      override(U(1), "own", { brand_code: "Hyundai" }),
      override(U(2), "removed"),
      override(U(3), "hidden"),
      override(U(4), "competitor", { origin: "hub", observed: false, name: "Hub Co" }),
    ], [{ surface_id: 5, action: "block", entity_id: U(3), surface: "B", surface_norm: "b", lang: null, created_at: "2026-10-01T00:00:00Z", created_by: U(1) }]);
    const rows = e.mergeEntityRows(list, active, draft);
    const by = Object.fromEntries(rows.map((r) => [r.entityId, r]));
    expect(by[U(1)]).toMatchObject({ activeRole: "own", draftRole: "own", draftChanged: false, answers: 9, mentions: 20, observed: true });
    expect(by[U(2)]).toMatchObject({ activeRole: "removed", draftRole: "removed", draftChanged: false });
    expect(by[U(3)]).toMatchObject({ activeRole: "competitor", draftRole: "hidden", draftChanged: true, surfaceCount: 1 });
    expect(by[U(4)]).toMatchObject({ name: "Hub Co", origin: "hub", observed: false, activeRole: "competitor", draftChanged: true, answers: 0 });
    expect(rows.map((r) => r.entityId)).toEqual([U(1), U(2), U(3), U(4)]);
  });

  it("own attribution: list own_brand for the active, the draft row's effective_own_brand for the draft (else as active)", () => {
    const lst = [
      { ...(list[1] as object), own_brand: "Hyundai" },                 // Epit: 명부 밖, 접두 교정으로 자사 귀속
      { ...(list[2] as object), own_brand: null },                      // BMW: 순수 경쟁사
    ] as never[];
    const draft = detail(3, "draft", [override(U(2), "competitor", { parent_brand_id: U(9), effective_own_brand: null })]);
    const rows = e.mergeEntityRows(lst, null, draft);
    const by = Object.fromEntries(rows.map((r) => [r.entityId, r]));
    expect(by[U(2)]).toMatchObject({ activeRole: "competitor", activeOwnBrand: "Hyundai", draftOwnBrand: null, draftChanged: true });
    expect(by[U(3)]).toMatchObject({ activeOwnBrand: null, draftOwnBrand: null });
    expect(e.mergeEntityRows(lst, null, null)[0]).toMatchObject({ activeOwnBrand: "Hyundai", draftOwnBrand: null });
    expect(e.mergeEntityRows(lst, null, detail(3, "draft", []))[0]).toMatchObject({ draftOwnBrand: "Hyundai" });   // 초안 행 없음 = 활성과 같다
  });

  it("no draft: draft role null; no active detail: the list role (excluded = hidden)", () => {
    const rows = e.mergeEntityRows([{ ...(list[0] as object), role: "excluded" }] as never[], null, null);
    expect(rows[0]).toMatchObject({ activeRole: "hidden", draftRole: null, draftChanged: false });
  });
});

// ── requests ────────────────────────────────────────────────────────────────

describe("request shapes", () => {
  it("draft edits: bodies, trimming, own-only brand code", async () => {
    mock((c) =>
      c.path.endsWith("/versions") && c.method === "POST"
        ? data({ version: summary(3, "draft"), content_md5: null, entities: [], surfaces: [], lint: null })
        : c.path.includes("/surfaces")
          ? data({ ver: 3, changed: true, surface: null, stale_applies: [9] })
          : data({ ver: 3, changed: true, entity: null, stale_applies: [] }),
    );
    expect((await e.createDraft("  v3  ".trim(), null)).ok).toBe(true);
    await e.putDraftEntity(3, U(2), { role: "competitor", brandCode: "Kia", name: "  ", mergeInto: U(5), note: " n " });
    await e.putDraftEntity(3, U(2), { role: "own", brandCode: "Kia" });
    await e.addHubEntity(3, { name: " New ", entityType: "", role: "competitor" });
    const s = await e.addDraftSurface(3, { action: "block", surface: " N ", entityId: null, lang: "" });
    await e.deleteDraftSurface(3, 5);
    await e.deleteDraftEntity(3, U(2));
    expect(s).toEqual({ ok: true, value: { changed: true, surface: null, staleApplies: [9] } });
    expect(calls.map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body ?? null)}`)).toEqual([
      'POST /v1/admin/entities/versions {"title":"v3","reason":null}',
      `PUT /v1/admin/entities/versions/3/entities/${U(2)} {"role":"competitor","name":null,"brand_code":null,"merge_into":"${U(5)}","parent_brand_id":null,"note":"n"}`,
      `PUT /v1/admin/entities/versions/3/entities/${U(2)} {"role":"own","name":null,"brand_code":"Kia","merge_into":null,"parent_brand_id":null,"note":null}`,
      'POST /v1/admin/entities/versions/3/entities {"name":"New","entity_type":"Brand","role":"competitor","brand_code":null,"parent_brand_id":null,"note":null}',
      'POST /v1/admin/entities/versions/3/surfaces {"action":"block","surface":"N","entity_id":null,"lang":null}',
      "DELETE /v1/admin/entities/versions/3/surfaces/5 null",
      `DELETE /v1/admin/entities/versions/3/entities/${U(2)} null`,
    ]);
  });

  it("lint, acks, diff, apply flow and review / audit queries", async () => {
    const lint = { blocked: false, counts: { L2: 1 }, escalated: 0, findings: [{ key: "k1", level: "L2", code: "c", target: "Epit", detail: "", escalate: false }], acked: ["k1"], unacked: [], stale: false };
    const apply = (status: string, over: Record<string, unknown> = {}) => ({
      apply_id: 7, ver: 3, from_ver: 2, status, scope_kind: "from_round", from_round_date: "2026-09-20", reason: "r", requested_at: "2026-10-01T00:00:00Z",
      requested_by: U(1), has_preview: status !== "draft", requires_approval: true, approver_required: true, can_approve: false, actions: ["approve", "reject"],
      preview: status === "draft" ? null : PREVIEW, queue: [{ change_id: 1, op: "preview", status: "applied", requested_at: "2026-10-01T00:00:00Z", error: "x" }], ...over,
    });
    mock((c) => {
      if (c.path.endsWith("/lint") || c.path.endsWith("/lint/acks")) return data(lint);
      if (c.path.includes("/diff")) return data({ ver: 3, against: 1, counts: {}, entities: [], surfaces: [] });
      if (c.path.includes("/rollback")) return data(apply("draft", { apply_id: 8 }));
      if (c.path === "/v1/admin/entities/applies" && c.method === "GET") return data({ items: [apply("applied")] });
      if (c.path.includes("/applies")) return data(apply(c.method === "POST" && c.path.endsWith("/applies") ? "draft" : "previewed"));
      if (c.path.includes("/review/")) return data({ ver: 3, review: { review_id: 4, kind: "new_entity", status: "resolved", entity_id: U(4), first_seen_at: "2026-10-01T00:00:00Z", last_seen_at: "2026-10-01T00:00:00Z", n_answers: 1, n_mentions: 1 }, entity: null, surface: null });
      if (c.path.includes("/review")) return data({ items: [] });
      return data({ items: [] });
    });
    expect((await e.runLint(3)).ok).toBe(true);
    expect(await e.saveLintAcks(3, ["k1"])).toMatchObject({ ok: true, value: { acked: ["k1"], unacked: [] } });
    expect((await e.getVersionDiff(3, 1)).against).toBe(1);
    await e.getVersionDiff(3);
    const req = await e.requestApply({ scopeKind: "from_round", fromRoundDate: "2026-09-20", reason: " fix N ", ver: null });
    expect(req).toMatchObject({ ok: true, value: { applyId: 7, status: "draft", preview: null, previewUnreadable: false } });
    await e.requestApply({ scopeKind: "unexposed", fromRoundDate: "2026-09-20", reason: "x", ver: 2 });
    const got = await e.getApply(7);
    expect(got).toMatchObject({ status: "previewed", canApprove: false, approverRequired: true, actions: ["approve", "reject"] });
    expect(got.preview?.kpiTop).toHaveLength(3);
    expect(got.queue[0]).toEqual({ changeId: 1, op: "preview", status: "applied", requestedAt: "2026-10-01T00:00:00Z", appliedAt: null, hasError: true });
    await e.applyAction(7, "approve", " ");
    await e.applyAction(7, "reject", " no ");
    await e.applyAction(7, "preview");
    await e.applyAction(7, "resume");
    await e.applyAction(7, "abandon", " stuck ");
    expect(await e.applyAction(7, "rollback", "back")).toMatchObject({ ok: true, value: { applyId: 8 } });
    await e.decideReview(4, { action: "register", role: "own", brandCode: "Kia", mergeInto: "", note: "" });
    await e.decideReview(4, { action: "dismiss", role: "own", note: "noise" });
    await e.listReview({ status: "all", kind: "new_surface", q: " N " });
    await e.listAudit({ beforeId: 50, limit: 100 });
    expect((await e.listApplies({ limit: 50 }))[0]).toMatchObject({ applyId: 7, status: "applied", requiresApproval: true, errorCode: null });
    expect(calls.map((c) => `${c.method} ${c.path}${c.query} ${JSON.stringify(c.body ?? null)}`)).toEqual([
      "POST /v1/admin/entities/versions/3/lint null",
      'PUT /v1/admin/entities/versions/3/lint/acks {"keys":["k1"]}',
      "GET /v1/admin/entities/versions/3/diff?against=1 null",
      "GET /v1/admin/entities/versions/3/diff null",
      'POST /v1/admin/entities/applies {"scope_kind":"from_round","reason":"fix N","from_round_date":"2026-09-20"}',
      'POST /v1/admin/entities/applies {"scope_kind":"unexposed","reason":"x","from_round_date":null,"ver":2}',
      "GET /v1/admin/entities/applies/7 null",
      'POST /v1/admin/entities/applies/7/approve {"reason":null}',
      'POST /v1/admin/entities/applies/7/reject {"reason":"no"}',
      "POST /v1/admin/entities/applies/7/preview null",
      "POST /v1/admin/entities/applies/7/resume null",
      'POST /v1/admin/entities/applies/7/abandon {"reason":"stuck"}',
      'POST /v1/admin/entities/applies/7/rollback {"reason":"back"}',
      'POST /v1/admin/entities/review/4/decision {"action":"register","note":null,"role":"own","brand_code":"Kia","merge_into":null,"surface_action":null}',
      'POST /v1/admin/entities/review/4/decision {"action":"dismiss","note":"noise"}',
      "GET /v1/admin/entities/review?kind=new_surface&limit=200&q=N&status=all null",
      "GET /v1/admin/entities/audit?before_id=50&limit=100 null",
      "GET /v1/admin/entities/applies?limit=50 null",
    ]);
  });
  it("gate numbers, lint view, minimal draft writes and merge-candidate names (optional params; defaults unchanged)", async () => {
    const lint = { blocked: true, counts: { L1: 1 }, escalated: 0, findings: [], acked: [], unacked: [], stale: false, content_md5: "ab" };
    const row = (n: number) => ({ entity_id: U(n), name: `e${n}`, entity_type: n % 2 ? "Brand" : "Product", role: "competitor", registered: false,
      brand_code: null, brand_name: null, answers: 10 - n, mentions: 10 - n, updated_at: null, own_brand: null });
    mock((c) => {
      if (c.path === "/v1/admin/entities/versions" && c.method === "GET") {
        return data({ active_ver: 2, draft_ver: 3, items: c.query.includes("view=gate") ? [] : [summary(3, "draft"), summary(2, "active")] });
      }
      if (c.path === "/v1/admin/entities/versions" || c.path === "/v1/admin/entities/versions/3") {
        return data({ version: summary(3, "draft"), content_md5: c.method === "GET" ? "ab" : null, entities: [], surfaces: [], lint: c.method === "GET" ? lint : null });
      }
      if (c.path === "/v1/admin/entities") return data({ items: [row(1), row(2)] });
      return fail(404, "not_found");
    });
    expect(await e.listVersionNumbers()).toEqual({ activeVer: 2, draftVer: 3, items: [] });
    expect((await e.listVersions()).items.map((v) => v.ver)).toEqual([3, 2]);
    const lv = await e.getVersionLint(3);
    expect(lv).toEqual({ version: e.toVersionSummary(summary(3, "draft") as never), contentMd5: "ab", lint: e.toLint(lint as never) });
    expect(lv.lint?.blocked).toBe(true);
    expect(await e.createDraft("t", null)).toEqual({ ok: true, value: { version: e.toVersionSummary(summary(3, "draft") as never) } });
    expect(await e.patchDraft(3, "t2", "r")).toEqual({ ok: true, value: { version: e.toVersionSummary(summary(3, "draft") as never) } });
    // merge candidates: the same rows (names, types) as the default list, only the attribution is skipped by the backend
    const names = await e.listEntityRows({ fields: "names" });
    const all = await e.listEntityRows();
    expect(names.map((r) => [r.entity_id, r.name, r.entity_type])).toEqual(all.map((r) => [r.entity_id, r.name, r.entity_type]));
    expect(calls.map((c) => `${c.method} ${c.path}${c.query} ${JSON.stringify(c.body ?? null)}`)).toEqual([
      "GET /v1/admin/entities/versions?view=gate null",
      "GET /v1/admin/entities/versions?limit=100 null",
      "GET /v1/admin/entities/versions/3?view=lint null",
      'POST /v1/admin/entities/versions?return=minimal {"title":"t","reason":null}',
      'PATCH /v1/admin/entities/versions/3?return=minimal {"title":"t2","reason":"r"}',
      "GET /v1/admin/entities?fields=names&limit=500&sort=answers_desc&surface=global null",
      "GET /v1/admin/entities?limit=500&sort=answers_desc&surface=global null",
    ]);
  });
});

// ── errors ──────────────────────────────────────────────────────────────────

describe("error keys", () => {
  it("backend codes map to their key; statuses to generic keys; auth refusals throw", async () => {
    for (const [status, code, key] of [
      [409, "ECAT_DRAFT_EXISTS", "ECAT_DRAFT_EXISTS"],
      [422, "ECAT_LINT_BLOCKED", "ECAT_LINT_BLOCKED"],
      [409, "ECAT_PREVIEW_STALE", "ECAT_PREVIEW_STALE"],
      [403, "ECAT_EXPOSED_REQUIRES_APPROVAL", "ECAT_EXPOSED_REQUIRES_APPROVAL"],
      [422, "brand_required", "brand_required"],
      [404, "not_found", "notFound"],
      [409, "something_new", "conflict"],
      [422, "unprocessable", "invalid"],
      [503, "unavailable", "generic"],
    ] as const) {
      mock(() => fail(status, code));
      expect(await e.applyAction(7, "approve")).toEqual({ ok: false, errorKey: key });
    }
    mock(() => fail(403, "admin_only"));
    await expect(e.createDraft("t", null)).rejects.toBeInstanceOf(UnauthorizedError);
    mock(() => fail(401, "unauthenticated"));
    await expect(e.runLint(3)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(() => e.ecatErrorKey(new Error("boom"))).toThrow("boom");
    expect(() => e.ecatErrorKey(new HghApiError(0, LOCAL_CODES.config))).toThrow();
  });
});
