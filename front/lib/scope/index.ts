import type { ScopeClient } from "./client";
import { HttpScopeClient } from "./http";
import { localReadOnly } from "@/lib/local-readonly";

export type { ScopeClient } from "./client";
export * from "./types";

let cached: ScopeClient | null = null;

// Legacy API transport only. There is no synthetic implementation or default.
export function getScopeClient(): ScopeClient {
  if (localReadOnly()) throw new Error("Scope API access is disabled; read the Gold database");
  if (cached) return cached;

  const mode = process.env.SCOPE_MODE;
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
    throw new Error("Scope API is not configured; sample data has been removed");
  }
  return cached;
}

export function isMockMode(): boolean {
  return false;
}
