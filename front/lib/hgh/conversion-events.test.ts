import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "./api-types";

// GA4 conversion-event reads/writes (BG-29): the query each call sends and the row conversion.

const { bindHghAuth } = await import("./auth");
const E = await import("./conversion-events");

type Meta = components["schemas"]["Meta"];

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const meta = (m: Partial<Meta> = {}): Meta => ({ mode: "snapshot", as_of: "2026-09-14", cycles: ["2026-09-14"], ...m });

describe("conversion events: GET and PUT", () => {
  const urls: string[] = [];
  const bodies: unknown[] = [];
  const answer: { json: unknown; status: number } = { json: null, status: 200 };
  beforeEach(() => {
    urls.length = 0;
    bodies.length = 0;
    answer.status = 200;
    vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
    bindHghAuth({ getAccessToken: async () => TOKEN });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string, init?: RequestInit) => {
        urls.push(String(u));
        bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return new Response(JSON.stringify(answer.json), { status: answer.status, headers: { "content-type": "application/json" } });
      }),
    );
  });
  afterEach(() => {
    bindHghAuth(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  const q = (i = 0) => new URL(urls[i]).searchParams;

  it("events: GET and PUT with property_id (and project_id in the project context)", async () => {
    answer.json = {
      data: { property_id: "123", window_from: "2026-06-18", window_to: "2026-09-15", loaded: true, registered: true, can_edit: true, items: [{ event_name: "purchase", count: 5, tracked: true }, { event_name: "view", count: 90, tracked: false }] },
      meta: meta({ mode: "admin" }),
    };
    const ev = await E.fetchConversionEvents("123", PROJECT);
    expect(E.toEventRows(ev)).toEqual([
      { eventName: "purchase", count: 5, tracked: true },
      { eventName: "view", count: 90, tracked: false },
    ]);
    expect([new URL(urls[0]).pathname, q(0).get("property_id"), q(0).get("project_id"), q(0).has("surface")]).toEqual([
      "/v1/funnel/conversion/events",
      "123",
      PROJECT,
      false,
    ]);
    answer.json = { data: { property_id: "123", event_names: ["purchase"], propagation: "pending", change_id: 9 }, meta: meta({ mode: "crud" }) };
    await E.putConversionEvents("123", ["purchase"]);
    expect([q(1).get("property_id"), q(1).has("project_id")]).toEqual(["123", false]);
    expect(bodies[1]).toEqual({ event_names: ["purchase"] });
  });
});
