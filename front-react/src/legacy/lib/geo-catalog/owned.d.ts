// Type-only snapshot; no database or server implementation is included.
import { registrableDomainOfHost } from "@/lib/public-suffix";
export { registrableDomainOfHost };
/** Distinct registrable domains of every brand site (owned-citation allowlist). */
export declare const GEO_OWNED_DOMAINS: string[];
/** Whether a cited domain is a brand-owned site (catalog match). */
export declare function isOwnedDomain(domain: string): boolean;
/** Which brand owns a cited domain (exact or subdomain match), or null. */
export declare function ownedBrandOf(domain: string): string | null;
export declare function normalizeOwnedBaseUrl(raw: string | null | undefined): string;
export declare function ownedBasePrefixFromUrl(raw: string | null | undefined): string;
export declare const SHARED_GLOBAL_HOSTS: ReadonlySet<string>;
export declare function isSiteRootHome(normUrl: string, host: string): boolean;
export interface OwnedBaseEntry {
    brand: string;
    region: string;
    country: string;
    /** 본문 실측 언어(GeoEntry.language) — 같은 도메인을 언어로 가른 사이트를
     *  자사 판정에서 구분하기 위해 싣는다(2026-09-01). null = 카탈로그 미기재. */
    language: string | null;
    url: string;
    prefix: string;
}
/** Canonical HMG localized site bases used by KPI ⑤ (host + country path). */
export declare const GEO_OWNED_BASES: OwnedBaseEntry[];
/** Normalized base-url prefixes that count as "ours" for KPI ⑤. */
export declare const GEO_OWNED_BASE_PREFIXES: string[];
/**
 * Which canonical owned base a cited URL belongs to, or null. This is the
 * source of truth for KPI ⑤ attribution and keeps answer market attribution
 * separate from cited-site market attribution.
 */
export declare function ownedBaseEntryForUrl(url: string): OwnedBaseEntry | null;
/** Whether a cited URL belongs to one of the canonical owned site bases. */
export declare function isOwnedBaseUrl(url: string): boolean;
