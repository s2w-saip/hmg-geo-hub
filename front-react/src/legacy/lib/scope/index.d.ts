// Type-only snapshot; no database or server implementation is included.
import type { ScopeClient } from "./client";
export type { ScopeClient } from "./client";
export * from "./types";
export declare function getScopeClient(): ScopeClient;
export declare function isMockMode(): boolean;
