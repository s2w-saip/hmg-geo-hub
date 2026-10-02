import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Operation header parameters (U11: If-Match on PATCH /v1/admin/users/{user_id}). The client
// owns Authorization, Cookie, Accept, Content-Type, X-Request-Id and the relay headers; an
// operation header may never set them.
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join: j } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(j(root, "cjs", "react.react-server.development.js"));
});

const { bindHghAuth } = await import("./auth");
const { hghPatch, operationHeaders } = await import("./client");

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const USER = "00000000-0000-4000-8000-000000000001";
let seen: Headers[] = [];

beforeEach(() => {
  seen = [];
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  vi.stubEnv("HGH_RELAY_SECRET", "");
  bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: async () => null });
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
    seen.push(new Headers(init.headers));
    return new Response(JSON.stringify({ data: { user_id: USER }, meta: { mode: "crud" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  bindHghAuth(null);
});

describe("operation header parameters", () => {
  it("If-Match travels as given, next to the client's own headers", async () => {
    await hghPatch("/v1/admin/users/{user_id}", {
      pathParams: { user_id: USER },
      header: { "If-Match": "7" },
      body: { role: "hq" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].get("if-match")).toBe("7");
    expect(seen[0].get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].get("content-type")).toBe("application/json");
  });

  it("null / missing header values are not sent", async () => {
    await hghPatch("/v1/admin/users/{user_id}", { pathParams: { user_id: USER }, header: { "If-Match": null }, body: {} });
    await hghPatch("/v1/admin/users/{user_id}", { pathParams: { user_id: USER }, body: {} });
    expect(seen.map((h) => h.get("if-match"))).toEqual([null, null]);
  });

  it("reserved or malformed headers are refused before any request", () => {
    for (const name of ["Authorization", "cookie", "X-Request-Id", "Accept", "Content-Type", "X-HGH-Client-IP", "X-HGH-Relay-Secret"]) {
      expect(() => operationHeaders({ [name]: "x" })).toThrow(expect.objectContaining({ status: 500, code: "client_config" }));
    }
    expect(() => operationHeaders({ "If-Match": "1\r\nX-Evil: 1" })).toThrow(/malformed/);
    expect(() => operationHeaders({ "If Match": "1" })).toThrow(/not allowed/);
    expect(operationHeaders({ "If-Match": "3", Other: undefined })).toEqual([["If-Match", "3"]]);
  });

  it("integer values (X-HGH-Timeout-Ms) travel as decimal strings; a non-integer is refused", () => {
    expect(operationHeaders({ "X-HGH-Timeout-Ms": 185_000 })).toEqual([["X-HGH-Timeout-Ms", "185000"]]);
    expect(() => operationHeaders({ "X-HGH-Timeout-Ms": 1.5 })).toThrow(/malformed/);
    expect(() => operationHeaders({ "X-HGH-Timeout-Ms": Number.NaN })).toThrow(/malformed/);
  });
});
