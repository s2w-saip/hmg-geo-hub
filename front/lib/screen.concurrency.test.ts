import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Screen calls (lib/screen.ts) do not take the request's API call slots (2026-10-27): the BFF bounds
// its Gold work itself and runs identical reads that arrive together once, so a page's sections go
// out at once. Held to four at a time, the renewal Mention's 22 sections took 9.7 s and re-ran
// reads the earlier sections had just done. The request scope is React's request cache, so react
// is the react-server build here (see test/request-scope.ts).
vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(join(root, "cjs", "react.react-server.development.js"));
});

const { withRequestScope } = await import("@/test/request-scope");
const { HGH_MAX_CONCURRENT_CALLS, requestCallLimiter } = await import("@/lib/hgh/client");
const { screenGet } = await import("./screen");

let started: string[] = [];
let answers: Array<() => void> = [];

beforeEach(() => {
  started = [];
  answers = [];
  vi.stubEnv("HGH_API_BASE_URL", "http://127.0.0.1:5555");
  // every fetch waits until the test answers it
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      started.push(new URL(String(input)).pathname);
      return new Promise<Response>((resolve) => {
        answers.push(() => resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })));
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("screen calls", () => {
  it("go out at once inside a server request, without taking API call slots", async () => {
    await withRequestScope(async () => {
      const n = HGH_MAX_CONCURRENT_CALLS * 2 + 1;
      const calls = Array.from({ length: n }, (_, i) => screenGet(`mention/rn-${i}`));
      await vi.waitFor(() => expect(started).toHaveLength(n));
      expect(requestCallLimiter()).not.toBeNull();
      expect(requestCallLimiter()?.inFlight).toBe(0);
      for (const answer of answers) answer();
      await Promise.all(calls);
    });
  });
});
