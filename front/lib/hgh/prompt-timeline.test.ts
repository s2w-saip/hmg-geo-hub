import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "./api-types";

// One prompt's change timeline on the backend: the audit-row conversion and the query each call sends.

const { bindHghAuth } = await import("./auth");
const C = await import("./prompt-timeline");

type S = components["schemas"];
type Meta = S["Meta"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const meta = (m: Partial<Meta> = {}): Meta => ({ mode: "crud", ...m }) as Meta;

const seen: URL[] = [];
let answer: () => { status?: number; json?: unknown };

beforeEach(() => {
  seen.length = 0;
  answer = () => ({ json: { data: { items: [] }, meta: meta({ page: { limit: 100 } }) } });
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  bindHghAuth({ getAccessToken: async () => TOKEN });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) => {
      seen.push(new URL(String(u)));
      const a = answer();
      return new Response(JSON.stringify(a.json), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const qs = (i = 0) => seen[i].searchParams;
const fail = (status: number, code: string) => ({ status, json: { error: { code, message: "x" } } });

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

describe("timeline queries", () => {
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
