import { beforeEach, describe, expect, it, vi } from "vitest";

// next/navigation's redirect/notFound throw framework-internal errors; replace them
// with recognisable throws so the page handler's decisions are observable.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const {
  HghApiError,
  classifyHghError,
  errorFromResponse,
  errorKindOf,
  hghErrorResponse,
  isCursorStale,
  parseErrorBody,
  throwForPage,
  toActionError,
} = await import("./errors");

const envelope = (code: string, details?: unknown) =>
  JSON.stringify({ error: { code, message: `dev text for ${code}`, details: details ?? null } });

describe("parseErrorBody: the envelope is the only trusted shape", () => {
  it("reads code, message and details from {error:{...}}", () => {
    const d = parseErrorBody(422, envelope("invalid_value", [{ loc: ["query", "from"] }]), "application/json");
    expect(d).toEqual({ code: "invalid_value", message: "dev text for invalid_value", details: [{ loc: ["query", "from"] }] });
  });

  it("CloudFront HTML 502 -> upstream_non_json", () => {
    expect(parseErrorBody(502, "<html>Bad Gateway</html>", "text/html").code).toBe("upstream_non_json");
  });

  it("JSON without error.code (e.g. FastAPI default {detail}) -> upstream_non_json", () => {
    expect(parseErrorBody(404, JSON.stringify({ detail: "Not Found" }), "application/json").code).toBe("upstream_non_json");
    expect(parseErrorBody(500, "{broken", "application/json").code).toBe("upstream_non_json");
  });

  it("errorFromResponse keeps status and request context", async () => {
    const res = new Response(envelope("token_expired"), { status: 401, headers: { "content-type": "application/json" } });
    const e = await errorFromResponse(res, { requestId: "rid-1", method: "GET", path: "/v1/auth/me" });
    expect(e).toBeInstanceOf(HghApiError);
    expect([e.status, e.code, e.requestId, e.path]).toEqual([401, "token_expired", "rid-1", "/v1/auth/me"]);
  });
});

describe("errorKindOf: status + code only", () => {
  const cases: Array<[number, string, string]> = [
    [401, "unauthenticated", "session"],
    [401, "token_expired", "session"],
    [401, "no_account", "session"],
    [401, "qa_unauthorized", "qaSession"],
    [403, "role_forbidden", "forbidden"],
    [403, "menu_forbidden", "forbidden"],
    [403, "owner_only", "permission"],
    [403, "operator_forbidden", "permission"],
    [403, "admin_only", "permission"],
    [403, "forbidden", "permission"],
    [404, "not_found", "notFound"],
    [409, "cursor_stale", "cursorStale"],
    [409, "conflict", "conflict"],
    [409, "duplicate_pending", "conflict"],
    [409, "lock_lost", "conflict"],
    [413, "payload_too_large", "tooLarge"],
    [415, "unsupported_media_type", "unsupportedMedia"],
    [422, "unprocessable", "invalid"],
    [422, "cursor_invalid", "invalid"],
    [422, "constraint_violation", "invalid"],
    [400, "bad_request", "invalid"],
    [429, "rate_limited", "rateLimited"],
    [500, "internal", "internal"],
    [502, "upstream", "unavailable"],
    [502, "llm_failed", "unavailable"],
    [503, "auth_unavailable", "unavailable"],
    [503, "llm_unavailable", "unavailable"],
    [504, "timeout", "timeout"],
    [502, "network_error", "unavailable"],
    [502, "upstream_non_json", "unavailable"],
    [500, "upstream_non_json", "unavailable"],
  ];
  it.each(cases)("%i %s -> %s", (status, code, kind) => {
    expect(errorKindOf(status, code)).toBe(kind);
  });

  it("details never change the decision", () => {
    const a = classifyHghError(new HghApiError(409, "conflict", "m", { constraint: "x_uq" }));
    const b = classifyHghError(new HghApiError(409, "conflict", "other", [{ loc: ["body"] }]));
    expect(a).toEqual(b);
  });

  it("classification carries retryable and the i18n key", () => {
    expect(classifyHghError(new HghApiError(503, "unavailable"))).toMatchObject({ retryable: true, messageKey: "apiError.unavailable" });
    expect(classifyHghError(new HghApiError(422, "unprocessable"))).toMatchObject({ retryable: false, messageKey: "apiError.invalid" });
    expect(classifyHghError(new HghApiError(429, "rate_limited")).retryable).toBe(true);
  });

  it("isCursorStale is 409 + cursor_stale only", () => {
    expect(isCursorStale(new HghApiError(409, "cursor_stale"))).toBe(true);
    expect(isCursorStale(new HghApiError(409, "conflict"))).toBe(false);
    expect(isCursorStale(new HghApiError(422, "cursor_invalid"))).toBe(false);
    expect(isCursorStale(new Error("cursor_stale"))).toBe(false);
  });
});

describe("throwForPage (server components)", () => {
  const run = (e: unknown, opts?: Parameters<typeof throwForPage>[2]) => {
    try {
      throwForPage(e, "ko", opts);
    } catch (thrown) {
      return thrown;
    }
    throw new Error("throwForPage returned");
  };
  const msg = (x: unknown) => (x as Error).message;

  it("401 -> login, 403 surface -> no-access, 404 -> notFound", () => {
    expect(msg(run(new HghApiError(401, "token_expired")))).toBe("REDIRECT:/ko/login");
    expect(msg(run(new HghApiError(403, "menu_forbidden")))).toBe("REDIRECT:/ko/no-access");
    expect(msg(run(new HghApiError(404, "not_found")))).toBe("NOT_FOUND");
  });

  it("401 qa_unauthorized goes to the QA gate, never to the Supabase /login", () => {
    expect(msg(run(new HghApiError(401, "qa_unauthorized")))).toBe("REDIRECT:/ko/raw-data-qa");
    expect(msg(run(new HghApiError(401, "qa_unauthorized"), { qaLoginPath: "/en/raw-data-qa" }))).toBe("REDIRECT:/en/raw-data-qa");
    expect(msg(run(new HghApiError(401, "token_expired"), { loginPath: "/ko/login?next=%2Fko%2Fdashboard" }))).toBe(
      "REDIRECT:/ko/login?next=%2Fko%2Fdashboard",
    );
    expect(classifyHghError(new HghApiError(401, "qa_unauthorized")).messageKey).toBe("apiError.qaSession");
    expect(toActionError(new HghApiError(401, "qa_unauthorized")).error).toBe("qaSession");
  });

  it("403 action-level follows the page's current gate", () => {
    expect(msg(run(new HghApiError(403, "owner_only")))).toBe("REDIRECT:/ko/no-access");
    expect(msg(run(new HghApiError(403, "owner_only"), { permission: "not-found" }))).toBe("NOT_FOUND");
  });

  it("422 and 5xx go to the error boundary unchanged; foreign errors pass through", () => {
    const e422 = new HghApiError(422, "unprocessable");
    const e503 = new HghApiError(503, "unavailable");
    const other = new TypeError("boom");
    expect(run(e422)).toBe(e422);
    expect(run(e503)).toBe(e503);
    expect(run(other)).toBe(other);
  });
});

describe("hghErrorResponse (route handlers)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("same status, {error:{code, requestId}}, no backend message/details, no-store", async () => {
    const res = hghErrorResponse(new HghApiError(409, "duplicate_pending", "internal text", { secret: 1 }, { requestId: "r-9" }));
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-request-id")).toBe("r-9");
    expect(await res.json()).toEqual({ error: { code: "duplicate_pending", requestId: "r-9" } });
  });

  it("non-HghApiError -> 500 internal without the error text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = hghErrorResponse(new Error("db password=hunter2"));
    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).toBe(JSON.stringify({ error: { code: "internal" } }));
    expect(body).not.toContain("hunter2");
  });
});

describe("toActionError (server actions)", () => {
  it("maps to kind + code", () => {
    expect(toActionError(new HghApiError(401, "no_account"))).toEqual({ ok: false, error: "session", code: "no_account" });
    expect(toActionError(new HghApiError(413, "payload_too_large"))).toEqual({ ok: false, error: "tooLarge", code: "payload_too_large" });
  });
  it("rethrows foreign errors", () => {
    expect(() => toActionError(new RangeError("x"))).toThrow(RangeError);
  });
});
