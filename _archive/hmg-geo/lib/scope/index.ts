import type { ScopeClient } from "./client";
import { MockScopeClient } from "./mock";
import { HttpScopeClient } from "./http";

export type { ScopeClient } from "./client";
export * from "./types";

let cached: ScopeClient | null = null;

// Selects the implementation by SCOPE_MODE (mock | live). Defaults to mock so
// the app runs fully without a scope API key. Switching to live is env-only —
// no code change (scope-gateway spec).
export function getScopeClient(): ScopeClient {
  if (cached) return cached;

  const mode = process.env.SCOPE_MODE ?? "mock";
  if (mode === "live") {
    const baseUrl = process.env.SCOPE_API_BASE;
    const apiKey = process.env.SCOPE_API_KEY;
    if (!baseUrl || !apiKey) {
      throw new Error(
        "SCOPE_MODE=live requires SCOPE_API_BASE and SCOPE_API_KEY",
      );
    }
    cached = new HttpScopeClient(baseUrl, apiKey);
  } else {
    cached = new MockScopeClient();
  }
  return cached;
}

export function isMockMode(): boolean {
  return (process.env.SCOPE_MODE ?? "mock") !== "live";
}
