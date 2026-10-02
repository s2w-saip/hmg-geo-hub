import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/types";

// fetchPromptAuditTimeline (unit U8): the place gate on BOTH sources before the branch (role +
// menu group, 3-argument route check: U8-N14, U8 verify D1), the source switch (HGH_SOURCE_G5,
// or G7 for an admin who reaches the admin catalog: U8-N21, verify D2), the backend path (GET
// /v1/prompts/history?prompt_id, from 2000-01-01 .. today KST: the legacy timeline had no
// window; the admin place reads GET /v1/admin/catalog/prompts/{id}/history, U8-7), the legacy scope check (a prompt outside listStandardCatalogScoped(scope) = empty,
// U8-N12) and the error map (401/403 -> UnauthorizedError as the legacy gate, the rest ->
// {ok:false, error: kind}). The legacy path (repository) stays the default.

const st = vi.hoisted(() => ({ session: null as Session | null, listForPrompt: vi.fn(), catalog: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));
vi.mock("@/lib/db/repositories/prompt-audit-logs", () => ({ promptAuditLogRepository: { listForPrompt: st.listForPrompt } }));
vi.mock("@/lib/db/repositories/standards", () => ({ listStandardCatalogScoped: st.catalog }));
vi.mock("@/lib/scope/server", () => ({}));

const { bindHghAuth } = await import("@/lib/hgh/auth");
const { UnauthorizedError } = await import("@/lib/auth/errors");
const { fetchPromptAuditTimeline } = await import("./_actions");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PROMPT = "00000000-0000-4000-8000-000000000001";

const session = (over: Partial<Session["user"]> = {}): Session => ({
  user: { id: "u1", email: "u@hmg.test", role: "hq", scope: { all: false, brands: ["Kia"] }, operator: "none", menuGroups: null, ...over },
});

const calls: URL[] = [];
const answer = { status: 200, json: null as unknown };
const HISTORY = {
  data: {
    items: [
      {
        audit_id: 7,
        prompt_id: PROMPT,
        prompt_text: "kia suv",
        prompt_brand: "Kia",
        event_type: "text_updated",
        changes: { text: { old: "suv", new: "kia suv" } },
        actor_id: null,
        actor_type: "system",
        actor_email: null,
        batch_id: null,
        created_at: "2026-09-20T00:00:00Z",
      },
    ],
  },
  meta: { mode: "crud", page: { limit: 100 } },
};

beforeEach(() => {
  calls.length = 0;
  answer.status = 200;
  answer.json = HISTORY;
  st.session = session();
  st.listForPrompt.mockReset().mockResolvedValue([{ id: "legacy" }]);
  st.catalog.mockReset().mockResolvedValue({ rows: [{ id: PROMPT }] });
  vi.stubEnv("HGH_SOURCE_G5", "api");
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      calls.push(new URL(String(u)));
      return new Response(JSON.stringify(answer.json), { status: answer.status, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const fail = (status: number, code: string) => {
  answer.status = status;
  answer.json = { error: { code, message: "x" } };
};
const kstToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

describe("fetchPromptAuditTimeline on the API source", () => {
  it("reads the whole timeline of the prompt (from 2000-01-01 to today KST, latest 100) and maps the rows", async () => {
    const res = await fetchPromptAuditTimeline(PROMPT);
    expect(calls).toHaveLength(1);
    const q = calls[0].searchParams;
    expect(calls[0].pathname).toBe("/v1/prompts/history");
    expect([q.get("surface"), q.get("prompt_id"), q.get("from"), q.get("to"), q.get("limit")]).toEqual(["global", PROMPT, "2000-01-01", kstToday(), "100"]);
    expect(res).toEqual({
      ok: true,
      value: [
        {
          id: "7",
          promptId: PROMPT,
          actorId: null,
          actorType: "system",
          eventType: "text_updated",
          changes: { text: { old: "suv", new: "kia suv" } },
          batchId: null,
          createdAt: new Date("2026-09-20T00:00:00Z"),
          actorEmail: null,
          promptText: "kia suv",
          promptBrand: "Kia",
        },
      ],
    });
    expect(st.listForPrompt).not.toHaveBeenCalled();
  });

  it("a prompt outside the account scope: the backend answers an empty list, shown as no history (U8-N12)", async () => {
    answer.json = { data: { items: [] }, meta: { mode: "crud", page: { limit: 100 }, dropped_filters: { prompt_id: "out_of_scope" } } };
    expect(await fetchPromptAuditTimeline(PROMPT)).toEqual({ ok: true, value: [] });
  });

  it("no session or a role without the route (vendor): UnauthorizedError before any call", async () => {
    st.session = null;
    await expect(fetchPromptAuditTimeline(PROMPT)).rejects.toBeInstanceOf(UnauthorizedError);
    st.session = session({ role: "vendor" });
    await expect(fetchPromptAuditTimeline(PROMPT)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(calls).toHaveLength(0);
  });

  it("U8-N14: menu groups without standard are refused on BOTH sources before any read (verify D1)", async () => {
    for (const menuGroups of [["website"], ["project"]] as const) {
      st.session = session({ menuGroups: [...menuGroups] });
      for (const flag of ["api", "legacy", ""]) {
        vi.stubEnv("HGH_SOURCE_G5", flag);
        await expect(fetchPromptAuditTimeline(PROMPT)).rejects.toBeInstanceOf(UnauthorizedError);
      }
    }
    expect(calls).toHaveLength(0);
    expect(st.listForPrompt).not.toHaveBeenCalled();
    expect(st.catalog).not.toHaveBeenCalled();
    // with the standard group the API path runs
    vi.stubEnv("HGH_SOURCE_G5", "api");
    st.session = session({ menuGroups: ["standard"] });
    expect((await fetchPromptAuditTimeline(PROMPT)).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  for (const [status, code] of [
    [401, "unauthorized"],
    [403, "role_forbidden"],
    [403, "menu_forbidden"],
  ] as const) {
    it(`${status} ${code} -> UnauthorizedError (the legacy gate failure)`, async () => {
      fail(status, code);
      await expect(fetchPromptAuditTimeline(PROMPT)).rejects.toBeInstanceOf(UnauthorizedError);
    });
  }

  for (const [status, code, kind] of [
    [404, "not_found", "notFound"],
    [422, "invalid_filter", "invalid"],
    [503, "unavailable", "unavailable"],
  ] as const) {
    it(`${status} ${code} -> {ok: false, error: "${kind}"}`, async () => {
      fail(status, code);
      expect(await fetchPromptAuditTimeline(PROMPT)).toEqual({ ok: false, error: kind });
    });
  }
});

describe("fetchPromptAuditTimeline: legacy is the default", () => {
  it("without the flag the repository answers and the backend is not called", async () => {
    vi.stubEnv("HGH_SOURCE_G5", "");
    expect(await fetchPromptAuditTimeline(PROMPT)).toEqual({ ok: true, value: [{ id: "legacy" }] });
    expect(st.catalog).toHaveBeenCalledWith({ all: false, brands: ["Kia"] });
    expect(st.listForPrompt).toHaveBeenCalledWith(PROMPT);
    expect(calls).toHaveLength(0);
  });

  it("U8-N12 on legacy (verify D1 PROBE-1): a prompt outside the account's catalog gives an empty list, unread", async () => {
    vi.stubEnv("HGH_SOURCE_G5", "");
    st.catalog.mockResolvedValue({ rows: [{ id: "00000000-0000-4000-8000-000000000002" }] });
    expect(await fetchPromptAuditTimeline(PROMPT)).toEqual({ ok: true, value: [] });
    expect(st.listForPrompt).not.toHaveBeenCalled();
  });

  it("scope all (admin) is not narrowed: no catalog read", async () => {
    vi.stubEnv("HGH_SOURCE_G5", "");
    st.session = session({ role: "admin", scope: { all: true } });
    expect(await fetchPromptAuditTimeline(PROMPT)).toEqual({ ok: true, value: [{ id: "legacy" }] });
    expect(st.catalog).not.toHaveBeenCalled();
  });
});

describe("fetchPromptAuditTimeline: the admin catalog place follows G7 (verify D2, U8-N21)", () => {
  const admin = (menuGroups: Session["user"]["menuGroups"]) => session({ role: "admin", scope: { all: true }, menuGroups });

  it("a narrowed admin (menu admin only) on G5=api: legacy source (G7 default), not refused (PROBE-3)", async () => {
    st.session = admin(["admin"]);
    expect(await fetchPromptAuditTimeline(PROMPT)).toEqual({ ok: true, value: [{ id: "legacy" }] });
    expect(calls).toHaveLength(0);
  });

  it("G7=api: the admin reads the admin timeline route (G5 still legacy, U8-7)", async () => {
    vi.stubEnv("HGH_SOURCE_G5", "legacy");
    vi.stubEnv("HGH_SOURCE_G7", "api");
    st.session = admin(null);
    expect((await fetchPromptAuditTimeline(PROMPT)).ok).toBe(true);
    expect(calls.map((u) => u.pathname)).toEqual([`/v1/admin/catalog/prompts/${PROMPT}/history`]);
    expect(calls[0].searchParams.get("limit")).toBe("100");
    expect(st.listForPrompt).not.toHaveBeenCalled();
  });

  it("G7=api: an admin with the admin menu only (no standard group) reads it too, not refused (U8-N21)", async () => {
    vi.stubEnv("HGH_SOURCE_G7", "api");
    st.session = admin(["admin"]);
    expect((await fetchPromptAuditTimeline(PROMPT)).ok).toBe(true);
    expect(calls.map((u) => u.pathname)).toEqual([`/v1/admin/catalog/prompts/${PROMPT}/history`]);
  });

  it("G7=api: the admin route refusing (403) maps to UnauthorizedError like the legacy gate", async () => {
    vi.stubEnv("HGH_SOURCE_G7", "api");
    st.session = admin(["admin"]);
    fail(403, "menu_forbidden");
    await expect(fetchPromptAuditTimeline(PROMPT)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("an admin without the admin menu group is on the standard place (G5)", async () => {
    st.session = admin(["standard"]);
    expect((await fetchPromptAuditTimeline(PROMPT)).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("an admin whose menu reaches neither place is refused", async () => {
    st.session = admin(["project"]);
    await expect(fetchPromptAuditTimeline(PROMPT)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(calls).toHaveLength(0);
  });
});
