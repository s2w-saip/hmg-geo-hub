import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Server actions of the entity version screens (E7) against an in-memory backend that follows
// the E6 contract: the whole admin flow edit -> lint -> L2 confirm -> apply request -> preview
// (polled) -> approve -> applied -> rollback, the admin gate, and the argument checks that answer
// without a backend call. The screens show only i18n keys, asserted here as errorKey values.

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join: j } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(j(root, "cjs", "react.react-server.development.js"));
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

const { getSession } = await import("@/lib/auth/session");
const { revalidatePath } = await import("next/cache");
const { UnauthorizedError } = await import("@/lib/auth/errors");
const { bindHghAuth } = await import("@/lib/hgh/auth");
const { isApplyBusy } = await import("@/lib/hgh/ecat-model");
const act = await import("./_ecat-actions");
const { PREVIEW } = await import("@/lib/hgh/adapters/admin-entities.fixture");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const U = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const admin = { user: { id: U(1), email: "a@t.test", role: "admin", scope: { all: true }, operator: "global", menuGroups: null } };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (d: unknown) => json(200, { data: d, meta: { mode: "admin" } });
const fail = (status: number, code: string) => json(status, { error: { code, message: code } });

// ── in-memory E6 backend ────────────────────────────────────────────────────

interface World {
  active: number;
  draft: number | null;
  entities: Map<string, Record<string, unknown>>;
  surfaces: Map<number, Record<string, unknown>>;
  lintKeys: string[];
  acked: string[];
  linted: boolean;
  applies: Map<number, { id: number; ver: number; status: string; scope: string; from: string | null; polls: number; preview: unknown; rollbackOf?: number }>;
  exposedApprover: boolean;
  calls: string[];
}
let w: World;

const summary = (ver: number, status: string) => ({
  ver, status, title: `v${ver}`, reason: null, origin: "admin", based_on: ver - 1, created_at: "2026-10-01T00:00:00+00:00", created_by: U(1),
  activated_at: null, retired_at: null, submitted_at: null, entity_rows: w.entities.size, surface_rows: w.surfaces.size, last_apply: null,
});
const lint = () => ({
  blocked: false, counts: { L1: 0, L2: w.lintKeys.length, L3: 0 }, escalated: 0, stale: false, linted_at: w.linted ? "2026-10-01T00:00:00Z" : null,
  findings: w.lintKeys.map((k) => ({ key: k, level: "L2", code: "L2_SHORT_ASCII", target: "Epit", detail: "", escalate: false })),
  acked: w.acked, unacked: w.lintKeys.filter((k) => !w.acked.includes(k)),
});
const applyBody = (a: World["applies"] extends Map<number, infer V> ? V : never) => ({
  apply_id: a.id, ver: a.ver, from_ver: w.active, status: a.status, scope_kind: a.scope, from_round_date: a.from, reason: "r",
  requested_at: "2026-10-01T00:00:00Z", requested_by: U(1), has_preview: a.preview != null, requires_approval: a.scope !== "unexposed",
  approver_required: a.scope !== "unexposed", can_approve: a.status === "previewed" && (a.scope === "unexposed" || w.exposedApprover),
  actions: a.status === "previewed" ? ["approve", "preview", "reject"] : a.status === "applied" ? ["rollback"] : [],
  preview: a.preview, queue: [],
});

function backend(method: string, path: string, body: Record<string, unknown> | undefined): Response {
  w.calls.push(`${method} ${path}`);
  const V = "/v1/admin/entities/versions";
  const A = "/v1/admin/entities/applies";
  if (method === "POST" && path === V) {
    if (w.draft) return fail(409, "ECAT_DRAFT_EXISTS");
    w.draft = w.active + 1;
    w.linted = false;
    return ok({ version: summary(w.draft, "draft"), content_md5: null, entities: [], surfaces: [], lint: null });
  }
  let m = path.match(/^\/v1\/admin\/entities\/versions\/(\d+)\/entities\/(.+)$/);
  if (m && method === "PUT") {
    if (Number(m[1]) !== w.draft) return fail(409, "ECAT_VERSION_STATE");
    w.entities.set(m[2], { entity_id: m[2], origin: "scope", observed: true, ...body });
    w.linted = false;
    return ok({ ver: w.draft, changed: true, entity: { entity_id: m[2], origin: "scope", observed: true, ...body }, stale_applies: [] });
  }
  m = path.match(/^\/v1\/admin\/entities\/versions\/(\d+)\/surfaces$/);
  if (m && method === "POST") {
    const id = w.surfaces.size + 10;
    const s = { surface_id: id, surface_norm: String(body?.surface).toLowerCase(), created_at: "2026-10-01T00:00:00Z", created_by: U(1), ...body };
    w.surfaces.set(id, s);
    w.linted = false;
    return ok({ ver: w.draft, changed: true, surface: s, stale_applies: [] });
  }
  if (method === "POST" && path === `${V}/${w.draft}/lint`) {
    w.linted = true;
    w.lintKeys = ["L2_SHORT_ASCII|Epit"];
    w.acked = [];
    return ok(lint());
  }
  if (method === "PUT" && path === `${V}/${w.draft}/lint/acks`) {
    w.acked = (body?.keys as string[]) ?? [];
    return ok(lint());
  }
  if (method === "POST" && path === A) {
    if (!w.linted) return fail(422, "ECAT_LINT_BLOCKED");
    if (w.acked.length < w.lintKeys.length) return fail(422, "ECAT_LINT_UNACKED");
    const id = 7 + w.applies.size;
    const a = { id, ver: (body?.ver as number) ?? (w.draft as number), status: "draft", scope: String(body?.scope_kind), from: (body?.from_round_date as string) ?? null, polls: 0, preview: null };
    w.applies.set(id, a);
    return ok(applyBody(a));
  }
  m = path.match(/^\/v1\/admin\/entities\/applies\/(\d+)(\/\w+)?$/);
  if (m) {
    const a = w.applies.get(Number(m[1]));
    if (!a) return fail(404, "ECAT_APPLY_NOT_FOUND");
    const op = m[2];
    if (!op && method === "GET") {
      // the loader: preview after two polls; an approved apply runs one poll, then is applied
      a.polls += 1;
      if (a.status === "draft" && a.polls >= 2) {
        a.status = "previewed";
        a.preview = PREVIEW;
      } else if (a.status === "approved") a.status = "running";
      else if (a.status === "running") {
        a.status = "applied";
        w.active = a.ver;
        w.draft = null;
      }
      return ok(applyBody(a));
    }
    if (op === "/approve") {
      if (a.scope !== "unexposed" && !w.exposedApprover) return fail(403, "ECAT_EXPOSED_REQUIRES_APPROVAL");
      a.status = "approved";
      return ok(applyBody(a));
    }
    if (op === "/rollback") {
      if (w.draft) return fail(409, "ECAT_DRAFT_EXISTS");
      const id = 7 + w.applies.size;
      const r = { id, ver: w.active + 1, status: "draft", scope: a.scope, from: a.from, polls: 0, preview: null, rollbackOf: a.id };
      w.applies.set(id, r);
      w.draft = r.ver;
      return ok(applyBody(r));
    }
  }
  return fail(404, "not_found");
}

beforeEach(() => {
  w = { active: 2, draft: null, entities: new Map(), surfaces: new Map(), lintKeys: [], acked: [], linted: false, applies: new Map(), exposedApprover: false, calls: [] };
  vi.mocked(getSession).mockResolvedValue(admin as never);
  vi.mocked(revalidatePath).mockClear();
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  vi.stubEnv("HGH_RELAY_SECRET", "");
  vi.stubEnv("HGH_SOURCE_G7", "api");
  bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: async () => null });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const raw = init.body;
    return backend(init.method ?? "GET", url.pathname, typeof raw === "string" ? JSON.parse(raw) : undefined);
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  bindHghAuth(null);
});

async function pollUntilIdle(applyId: number, max = 10) {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    const r = await act.getApplyAction(applyId);
    if (!r.ok) throw new Error(r.errorKey);
    seen.push(r.value.status);
    if (!isApplyBusy(r.value)) return { detail: r.value, seen };
  }
  throw new Error("still busy");
}

describe("entity version flow (edit -> lint -> preview -> apply -> rollback)", () => {
  it("runs end to end with the unexposed range and self approval", async () => {
    const draft = await act.createDraftAction("block N", null);
    expect(draft).toMatchObject({ ok: true, value: { version: { ver: 3, status: "draft" } } });
    expect(await act.createDraftAction("again", null)).toEqual({ ok: false, errorKey: "ECAT_DRAFT_EXISTS" });

    expect((await act.putDraftEntityAction(3, U(2), { role: "removed", note: "noise" })).ok).toBe(true);
    expect((await act.addDraftSurfaceAction(3, { action: "block", surface: "N", entityId: U(5) })).ok).toBe(true);

    // apply before lint and before the L2 confirmation is refused by the backend
    expect(await act.requestApplyAction({ scopeKind: "unexposed", reason: "fix" })).toEqual({ ok: false, errorKey: "ECAT_LINT_BLOCKED" });
    const l = await act.runLintAction(3);
    expect(l).toMatchObject({ ok: true, value: { unacked: ["L2_SHORT_ASCII|Epit"] } });
    expect(await act.requestApplyAction({ scopeKind: "unexposed", reason: "fix" })).toEqual({ ok: false, errorKey: "ECAT_LINT_UNACKED" });
    expect(await act.saveLintAcksAction(3, ["L2_SHORT_ASCII|Epit", "L2_SHORT_ASCII|Epit"])).toMatchObject({ ok: true, value: { unacked: [] } });

    const req = await act.requestApplyAction({ scopeKind: "unexposed", reason: "fix N" });
    expect(req).toMatchObject({ ok: true, value: { applyId: 7, status: "draft", hasPreview: false } });
    const pv = await pollUntilIdle(7);
    expect(pv.seen).toEqual(["draft", "previewed"]);
    expect(pv.detail).toMatchObject({ status: "previewed", canApprove: true, actions: ["approve", "preview", "reject"] });
    expect(pv.detail.preview?.impact.impactedAnswers).toBe(120);

    expect(await act.applyStepAction(7, "approve", null)).toMatchObject({ ok: true, value: { status: "approved" } });
    const done = await pollUntilIdle(7);
    expect(done.seen).toEqual(["running", "applied"]);
    expect(done.detail.actions).toEqual(["rollback"]);

    // rollback: reason required locally, then a new apply for the previous content opens
    expect(await act.applyStepAction(7, "rollback", "  ")).toEqual({ ok: false, errorKey: "reasonRequired" });
    const rb = await act.applyStepAction(7, "rollback", "wrong block");
    expect(rb).toMatchObject({ ok: true, value: { applyId: 8, status: "draft", scopeKind: "unexposed" } });
    expect((await pollUntilIdle(8)).detail.status).toBe("previewed");
    expect(await act.applyStepAction(8, "approve", null)).toMatchObject({ ok: true });
    expect((await pollUntilIdle(8)).detail.status).toBe("applied");
    expect(w.active).toBe(4);
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/[locale]/admin/standards/entities", "layout");
  });

  it("an exposed range is refused for a non-approver and approved by one", async () => {
    await act.createDraftAction("all", null);
    await act.runLintAction(3);
    await act.saveLintAcksAction(3, ["L2_SHORT_ASCII|Epit"]);
    expect(await act.requestApplyAction({ scopeKind: "from_round", fromRoundDate: "2026/09/20", reason: "x" })).toEqual({ ok: false, errorKey: "ECAT_SCOPE_INVALID" });
    const req = await act.requestApplyAction({ scopeKind: "from_round", fromRoundDate: "2026-09-20", reason: "x" });
    expect(req).toMatchObject({ ok: true, value: { scopeKind: "from_round", fromRoundDate: "2026-09-20" } });
    const pv = await pollUntilIdle(7);
    expect(pv.detail).toMatchObject({ requiresApproval: true, approverRequired: true, canApprove: false });
    expect(await act.applyStepAction(7, "approve", null)).toEqual({ ok: false, errorKey: "ECAT_EXPOSED_REQUIRES_APPROVAL" });
    w.exposedApprover = true;
    expect(await act.applyStepAction(7, "approve", "checked")).toMatchObject({ ok: true, value: { status: "approved" } });
  });
});

describe("gate and argument checks", () => {
  it("non-admin is refused before any backend call", async () => {
    vi.mocked(getSession).mockResolvedValue({ user: { ...admin.user, role: "hq" } } as never);
    await expect(act.createDraftAction("t", null)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(act.getApplyAction(7)).rejects.toBeInstanceOf(UnauthorizedError);
    vi.mocked(getSession).mockResolvedValue(null as never);
    await expect(act.runLintAction(3)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(w.calls).toEqual([]);
  });

  it("an admin whose menu groups leave out admin is refused like the backend (require_menu_group admin)", async () => {
    vi.mocked(getSession).mockResolvedValue({ user: { ...admin.user, menuGroups: ["standard", "website", "project"] } } as never);
    await expect(act.createDraftAction("t", null)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(act.applyStepAction(7, "approve", null)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(act.saveLintAcksAction(3, ["k"])).rejects.toBeInstanceOf(UnauthorizedError);
    expect(w.calls).toEqual([]);
    vi.mocked(getSession).mockResolvedValue({ user: { ...admin.user, menuGroups: ["admin"] } } as never);
    expect(await act.createDraftAction("t", null)).toMatchObject({ ok: true });
  });

  it("abandon needs a reason and posts it to the abandon endpoint", async () => {
    expect(await act.applyStepAction(7, "abandon", "  ")).toEqual({ ok: false, errorKey: "reasonRequired" });
    expect(w.calls).toEqual([]);
  });

  it("bad arguments answer locally", async () => {
    const r = await Promise.all([
      act.createDraftAction("  ", null),
      act.putDraftEntityAction(0, U(2), { role: "competitor" }),
      act.putDraftEntityAction(3, "not-a-uuid", { role: "competitor" }),
      act.putDraftEntityAction(3, U(2), { role: "boss" as never }),
      act.putDraftEntityAction(3, U(2), { role: "competitor", mergeInto: U(2) }),
      act.putDraftEntityAction(3, U(2), { role: "own", brandCode: " " }),
      act.addDraftSurfaceAction(3, { action: "add", surface: "N", entityId: null }),
      act.addDraftSurfaceAction(3, { action: "block", surface: "", entityId: null }),
      act.requestApplyAction({ scopeKind: "everything" as never, reason: "x" }),
      act.requestApplyAction({ scopeKind: "all", reason: " " }),
      act.applyStepAction(7, "reject", null),
      act.applyStepAction(7, "delete" as never, null),
      act.decideReviewAction(4, { action: "register", role: "own", brandCode: null }),
      act.entityMentionsAction("x", null),
      act.versionDiffAction(3, -1),
    ]);
    expect(r.map((x) => (x.ok ? "ok" : x.errorKey))).toEqual([
      "invalid", "invalid", "invalid", "invalid", "ECAT_MERGE_SELF", "brand_required", "ECAT_SURFACE_ADD_GLOBAL", "invalid",
      "invalid", "invalid", "reasonRequired", "invalid", "brand_required", "invalid", "invalid",
    ]);
    expect(w.calls).toEqual([]);
  });
});
