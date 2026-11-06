// Type-only snapshot; no database or server implementation is included.
/**
 * Number of rules actually MATCHED (ICANN section only) — lets tests assert the
 * snapshot loaded intact AND that the private section really is excluded.
 */
export declare const loadedRuleCount: number;
/** A bracketed IPv6 literal or a bare IPv4 dotted quad is not a domain name. */
export declare function isIpHost(host: string): boolean;
/**
 * The public suffix (eTLD) of an already-normalized lowercase hostname, or null
 * for an IP literal / malformed / empty input.
 */
export declare function publicSuffix(host: string | null | undefined): string | null;
/**
 * The registrable domain (eTLD+1) of an already-normalized lowercase hostname.
 *
 * Returns null when the host IS a public suffix (`com`, `co.uk`), is a single
 * unlisted label, or is an IP literal — i.e. when no registrable domain exists.
 * Callers that must still produce a grouping key decide their own fallback.
 */
export declare function registrableDomain(host: string | null | undefined): string | null;
/**
 * Grouping key for a raw hostname — the single `registrableDomain` authority
 * for this repo. Replaces the three `TWO_LEVEL_TLDS` copies that used to live
 * in lib/geo-catalog, lib/scope/mirror/sync.ts and lib/scope/result-adapter.ts.
 *
 * Differs from `registrableDomain()` above in one way, on purpose: callers here
 * (mirror write path, citation aggregation, owned-domain derivation) must
 * always end up with SOME key, so when no registrable domain exists — the host
 * IS a public suffix (`co.uk`), is a bare unlisted label, or is an IP literal —
 * the normalized host itself is returned instead of null. Only empty/absent
 * input yields null. `www.` is stripped on that fallback path only; the PSL
 * pass already folds `www.example.com` to `example.com` on its own.
 */
export declare function registrableDomainOfHost(rawHost: string | null | undefined): string | null;
