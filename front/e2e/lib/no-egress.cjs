// Preloaded into next dev by stack.sh (NODE_OPTIONS=--require). Harness runtime, not app code.
//
// The E2E stack must not reach the internet (design 5.1: everything on 127.0.0.1). next dev
// itself fetches the npm registry at start (version staleness check), and a screen that still
// runs a legacy path could call Scope, OpenRouter or Supabase cloud. Every fetch() to a
// non-loopback host is refused here and logged by host only, so such a call shows up in the
// next log as "[e2e-egress] blocked <host>" instead of silently leaving the machine.
"use strict";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const original = globalThis.fetch;

if (typeof original === "function") {
  globalThis.fetch = function e2eGuardedFetch(input, init) {
    let host = "";
    try {
      const raw = typeof input === "string" || input instanceof URL ? String(input) : input && input.url;
      host = new URL(raw).hostname;
    } catch {
      return original.call(this, input, init);
    }
    if (!LOOPBACK.has(host)) {
      console.warn(`[e2e-egress] blocked ${host}`);
      return Promise.reject(new TypeError(`fetch failed: e2e egress blocked (${host})`));
    }
    return original.call(this, input, init);
  };
}
