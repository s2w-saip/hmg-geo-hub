// Type-only snapshot; no database or server implementation is included.
export declare const NON_COMPETITOR_BRANDS: Set<string>;
export declare function isNonCompetitorBrand(brand: string | null | undefined): boolean;
export declare const BARE_ONLY_NON_COMPETITOR_PATTERNS: ReadonlyArray<readonly [name: string, posixPattern: string]>;
export declare function isNonCompetitorMention(rollupName: string | null | undefined, ownName?: string | null): boolean;
