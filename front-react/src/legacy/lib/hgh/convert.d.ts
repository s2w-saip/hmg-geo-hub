// Type-only snapshot; no database or server implementation is included.
import type { components } from "./api-types";
export type Ratio = components["schemas"]["Ratio"];
export type ApiPage = components["schemas"]["Page"];
/** Ratio -> one-decimal percent; missing ratio or den 0 -> null ("no measurement"). */
export declare function pct1OrNull(r: Ratio | null | undefined): number | null;
/** Plain fraction num/den (no rounding) or null when den is 0. */
export declare function ratioValue(r: Ratio | null | undefined): number | null;
export interface FilterNotices {
    /** Axes the feature does not use on this surface (sent but not applied). */
    ignored: string[];
    /** Axis -> values dropped as out of scope or unknown. */
    dropped: Record<string, string[]>;
    hasAny: boolean;
}
