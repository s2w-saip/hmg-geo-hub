// Type-only snapshot; no database or server implementation is included.
export declare const HMG_BRANDS: readonly ["Hyundai", "Kia", "Genesis"];
export type HmgBrand = (typeof HMG_BRANDS)[number];
export declare const HMG_BRAND_ENTITY_IDS: Record<HmgBrand, string>;
export declare const HMG_BRAND_ALIAS_ENTITY_IDS: Record<HmgBrand, readonly string[]>;
export declare const HMG_BRAND_NAME_PREFIXES: Record<HmgBrand, readonly string[]>;
export declare function hmgBrandPrefixEntries(): ReadonlyArray<readonly [brand: HmgBrand, entityId: string, prefixes: readonly string[]]>;
export declare function hmgBrandByNamePrefix(name: string | null | undefined): HmgBrand | null;
export declare function hmgRollupIdByNamePrefix(name: string | null | undefined): string | null;
export declare const HMG_BRAND_NAME_ALIASES: Readonly<Record<string, HmgBrand>>;
export declare function resolveHmgBrandName(name: string): HmgBrand | null;
export interface OwnEntity {
    id: string;
    name: string;
}
declare const isHmgBrand: (b: string) => b is HmgBrand;
export declare function intersectOrFallback<T>(items: readonly T[], allowed: string[], key: (item: T) => string): T[];
export declare function narrowScopeBrands<S extends {
    all: boolean;
    brands?: string[];
}>(scope: S, requestedBrands?: string[]): S;
export declare function trackedRosterFor(brandFilter?: string[], roster?: readonly OwnEntity[]): readonly OwnEntity[];
export declare function trackedEntityIdsFor(brandFilter?: string[], roster?: readonly OwnEntity[]): string[];
export declare function trackedBrandNameSetFor(brandFilter?: string[], roster?: readonly OwnEntity[]): Set<string>;
export declare function isTrackedEntityId(id: string | null | undefined, brandFilter?: string[], roster?: readonly OwnEntity[]): boolean;
export declare function ownedBasePrefixesForScope(brandFilter?: string[], roster?: readonly OwnEntity[], countryFilter?: string[], langFilter?: string[]): string[];
export declare function rollupCanonicalPairs(roster?: readonly OwnEntity[]): ReadonlyArray<readonly [aliasId: string, canonicalId: string]>;
export declare const HMG_BRAND_ENTITY_ID_SET: Set<string>;
export declare const HMG_BRAND_NAME_SET: Set<string>;
export { isHmgBrand };
