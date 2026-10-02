import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindHghAuth } from "./auth";
import {
  assertUploadSize,
  attachmentDisposition,
  BACKEND_UPLOAD_MAX_BYTES,
  checkQaSetCookie,
  relayDownload,
  relaySetCookies,
  relayUpload,
  streamResponse,
  uploadLimitBytes,
} from "./relay";

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
let seen: Array<{ url: string; init: RequestInit; headers: Headers }> = [];

function mockFetch(respond: () => Response) {
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    seen.push({ url: String(url), init, headers: new Headers(init.headers) });
    return respond();
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  seen = [];
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_UPLOAD_MAX_BYTES", "");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  bindHghAuth({ getAccessToken: async () => TOKEN });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  bindHghAuth(null);
});

describe("download relay", () => {
  it("streams the upstream body with allow-listed headers only, always no-store and nosniff", async () => {
    const upstream = new Response("a,b\r\n1,2\r\n", {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": "attachment; filename=\"notes.csv\"; filename*=UTF-8''%EB%85%B8%ED%8A%B8.csv",
        "x-export-truncated": "true",
        "set-cookie": "leak=1",
        "x-internal": "no",
      },
    });
    const res = streamResponse(upstream);
    expect(res.status).toBe(200);
    expect(res.body).toBe(upstream.body); // same stream object: no buffering
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(res.headers.get("x-export-truncated")).toBe("true");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-internal")).toBeNull();
    expect(await res.text()).toBe("a,b\r\n1,2\r\n");
  });

  it("Content-Disposition is always an attachment (missing -> attachment, inline -> attachment, params kept)", () => {
    expect(streamResponse(new Response("x", { status: 200 })).headers.get("content-disposition")).toBe("attachment");
    expect(attachmentDisposition('inline; filename="a.csv"')).toBe('attachment; filename="a.csv"');
    expect(attachmentDisposition("Inline")).toBe("attachment");
    expect(attachmentDisposition("attachment; filename*=UTF-8''a.csv")).toBe("attachment; filename*=UTF-8''a.csv");
    const res = streamResponse(new Response("<b>x</b>", { status: 200, headers: { "content-type": "text/html", "content-disposition": "inline" } }));
    expect([res.headers.get("content-disposition"), res.headers.get("x-content-type-options")]).toEqual(["attachment", "nosniff"]);
  });

  it("relayDownload calls the typed export path and relays; errors throw HghApiError", async () => {
    mockFetch(() => new Response("x", { status: 200, headers: { "content-type": XLSX } }));
    const res = await relayDownload("/v1/projects/{project_id}/prompts/export", { pathParams: { project_id: "p1" }, accept: XLSX });
    expect(seen[0].url).toBe("https://api.hgh.test/v1/projects/p1/prompts/export");
    expect(seen[0].headers.get("accept")).toBe(XLSX);
    expect(res.headers.get("content-type")).toBe(XLSX);

    mockFetch(() => new Response(JSON.stringify({ error: { code: "not_found", message: "m" } }), { status: 404, headers: { "content-type": "application/json" } }));
    await expect(relayDownload("/v1/qa/notes/export", { auth: { qaCookie: "a.b" } })).rejects.toMatchObject({ status: 404, code: "not_found" });
  });
});

describe("upload relay", () => {
  it("limit: HGH_UPLOAD_MAX_BYTES, never above the backend 10 MiB", () => {
    expect(uploadLimitBytes({})).toBe(BACKEND_UPLOAD_MAX_BYTES);
    expect(uploadLimitBytes({ HGH_UPLOAD_MAX_BYTES: "4500000" })).toBe(4_500_000);
    expect(uploadLimitBytes({ HGH_UPLOAD_MAX_BYTES: String(50 * 1024 * 1024) })).toBe(BACKEND_UPLOAD_MAX_BYTES);
    expect(() => uploadLimitBytes({ HGH_UPLOAD_MAX_BYTES: "-1" })).toThrow();
  });

  it("over the limit -> 413 payload_too_large with the limit, and nothing is sent", async () => {
    const f = mockFetch(() => new Response("{}", { status: 200 }));
    const big = new Blob([new Uint8Array(11)]);
    expect(() => assertUploadSize(big, 10)).toThrow(expect.objectContaining({ status: 413, code: "payload_too_large", details: { limitBytes: 10, sizeBytes: 11 } }));
    await expect(
      relayUpload("/v1/projects/{project_id}/prompts/import", big, { pathParams: { project_id: "p" }, limitBytes: 10 }),
    ).rejects.toMatchObject({ status: 413 });
    expect(f).not.toHaveBeenCalled();
  });

  it("multipart: field 'file' with the file name; JSON answer returned", async () => {
    mockFetch(() => new Response(JSON.stringify({ data: { created: 3 } }), { status: 200, headers: { "content-type": "application/json" } }));
    const file = new File([new Uint8Array([1, 2, 3])], "prompts.xlsx", { type: XLSX });
    const out = await relayUpload("/v1/projects/{project_id}/prompts/import", file, { pathParams: { project_id: "p" } });
    expect(out).toEqual({ data: { created: 3 } });
    const body = seen[0].init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    const sent = body.get("file") as File;
    expect([sent.name, sent.size]).toEqual(["prompts.xlsx", 3]);
    expect(seen[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].init.method).toBe("POST");
  });

  it("raw mode sends the file itself with its media type", async () => {
    mockFetch(() => new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    const file = new Blob([new Uint8Array([9])], { type: XLSX });
    await relayUpload("/v1/admin/catalog/prompts/import/preview", file, { mode: "raw" });
    expect(seen[0].init.body).toBe(file);
    expect(seen[0].headers.get("content-type")).toBe(XLSX);
  });

  it("backend 415 / 413 surface as HghApiError", async () => {
    mockFetch(() => new Response(JSON.stringify({ error: { code: "unsupported_media_type", message: "m" } }), { status: 415, headers: { "content-type": "application/json" } }));
    await expect(relayUpload("/v1/admin/catalog/prompts/import/preview", new Blob(["x"]))).rejects.toMatchObject({ status: 415, code: "unsupported_media_type" });
  });
});

describe("Set-Cookie relay: only the QA session cookie, only in the backend's shape", () => {
  // Exactly what Starlette writes for set_cookie / delete_cookie in back/app/features/qa/review/sessions/router.py.
  const ISSUE = "raw_data_qa=eyJzIjoxfQ.c2ln; HttpOnly; Path=/; SameSite=lax; Secure";
  const CLEAR = 'raw_data_qa=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Max-Age=0; Path=/; SameSite=lax; Secure';
  const upstreamWith = (...lines: string[]) => {
    const h = new Headers();
    for (const l of lines) h.append("set-cookie", l);
    return new Response(null, { status: 200, headers: h });
  };

  it("issue and clear cookies pass unchanged", () => {
    const target = new Headers();
    expect(relaySetCookies(upstreamWith(ISSUE, CLEAR), target, { requireSecure: true })).toEqual({ relayed: 2, rejected: 0 });
    expect(target.getSetCookie()).toEqual([ISSUE, CLEAR]);
  });

  it("verifier case: of raw_data_qa, raw_data_qa+Domain, sb-127-auth-token, AWSALB only the first passes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const target = new Headers();
    const out = relaySetCookies(
      upstreamWith(
        ISSUE,
        "raw_data_qa=eyJzIjoxfQ.c2ln; Domain=.example.com; HttpOnly; Path=/; SameSite=lax; Secure",
        "sb-127-auth-token=attacker; Path=/; HttpOnly; SameSite=lax; Secure",
        "AWSALB=abc123; Expires=Tue, 06 Oct 2026 00:00:00 GMT; Path=/",
      ),
      target,
      { requireSecure: true },
    );
    expect(out).toEqual({ relayed: 1, rejected: 3 });
    expect(target.getSetCookie()).toEqual([ISSUE]);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain("attacker");
    expect(logged).not.toContain("abc123");
    expect(logged).toContain("Domain");
    warn.mockRestore();
  });

  it.each([
    ["no HttpOnly", "raw_data_qa=a.b; Path=/; SameSite=lax; Secure", /HttpOnly/],
    ["path not /", "raw_data_qa=a.b; HttpOnly; Path=/raw-data-qa; SameSite=lax; Secure", /Path/],
    ["no path", "raw_data_qa=a.b; HttpOnly; SameSite=lax; Secure", /Path/],
    ["SameSite=None", "raw_data_qa=a.b; HttpOnly; Path=/; SameSite=None; Secure", /SameSite/],
    ["no SameSite", "raw_data_qa=a.b; HttpOnly; Path=/; Secure", /SameSite/],
    ["no Secure in production", "raw_data_qa=a.b; HttpOnly; Path=/; SameSite=lax", /Secure/],
    ["unknown attribute", "raw_data_qa=a.b; HttpOnly; Path=/; SameSite=lax; Secure; Partitioned", /attribute/],
    ["value outside the signed charset", "raw_data_qa=a b; HttpOnly; Path=/; SameSite=lax; Secure", /value/],
    ["lowercase domain attribute", "raw_data_qa=a.b; domain=hgh.example; HttpOnly; Path=/; SameSite=lax; Secure", /Domain/],
  ])("rejects %s", (_label, line, reason) => {
    const r = checkQaSetCookie(line, { requireSecure: true });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toMatch(reason);
  });

  it("Secure is required in production by default, not in development (local E2E over http)", () => {
    const devCookie = "raw_data_qa=a.b; HttpOnly; Path=/; SameSite=Lax";
    expect(checkQaSetCookie(devCookie, { requireSecure: false }).ok).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect(checkQaSetCookie(devCookie).ok).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    expect(checkQaSetCookie(devCookie).ok).toBe(true);
  });
});
