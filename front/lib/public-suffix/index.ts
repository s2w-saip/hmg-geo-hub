// Public Suffix List lookup — the eTLD / eTLD+1 authority for this codebase.
//
// Replaces hand-maintained multi-part suffix sets. Those could never be right:
// a curated list cannot express PSL wildcard rules at all (`*.mm` makes EVERY
// label under `.mm` a public suffix), and it silently mis-folds whatever it
// omits. The concrete failure that motivated this module: `com.ua` / `com.kz` /
// `co.il` and ~155 other registry suffixes were missing, so `hyundai.com.ua`
// folded to `com.ua` — collapsing every distinct site under `.com.ua` into one
// leaderboard row.
//
// Scope of that defect, measured on live data (2026-07-26): 184 suffixes /
// 11,203 citations / 1,042 hosts, changing leaderboard row grouping for 100 of
// 114 projects. Owned-domain judgement and `citationShare` are NOT affected —
// no project's owned host set moves (see
// openspec/changes/citation-psl-suffixes/proposal.md for the per-project
// breakdown and why).
//
// Data is a committed snapshot of both PSL sections (lib/public-suffix/data.ts,
// regenerate with `npm run generate:public-suffixes`), but only the ICANN
// section is MATCHED — see the `RULES` comment below. No runtime network
// access — the same input always yields the same output, which citation
// classification depends on.
//
// PORTED FROM the scope repo (Kongventures/scope `lib/public-suffix/`,
// 2026-07-26) verbatim except for `registrableDomainOfHost()` at the bottom of
// this file. hmg-geo carried the SAME defect and never got the fix: three
// hand-maintained `TWO_LEVEL_TLDS` copies (geo-catalog 24 entries, mirror sync
// 8, result-adapter 8) truncated `scope_citations.domain` AT WRITE TIME.
// Measured 2026-08-24 on the hmg-geo mirror: 71,825 of 2,363,526 rows (3.04%)
// stored a bare public suffix, collapsing 3,122 real hosts into 207 suffix
// labels; 39,447 of those rows (54.9%) are HMG country sites, so the customer's
// official-citation KPI was under-counted. See
// internal-kb/citation-category-classification-defect-2026-08-24.md
// (workspace KB).
//
// ⚠️ DIVERGENCE FROM SCOPE (2026-08-24). This module used to match BOTH PSL
// sections, exactly as scope still does, and that identity is what kept mirror
// grouping byte-identical to scope's. It no longer holds: hmg-geo matches the
// ICANN section ONLY. Anyone comparing the two repos' grouping keys must expect
// hosts under PRIVATE-section suffixes to differ. See the `RULES` comment below
// for the decision and its trade-off.

import { ICANN_SUFFIX_RULES } from "./data";

// Rules are looked up by exact string; wildcard/exception forms keep their
// `*.` / `!` prefix in the set and are probed explicitly below.
//
// ── ICANN section only (decision 2026-08-24) ─────────────────────────
//
// The PSL has two sections. ICANN lists suffixes operated by domain
// REGISTRIES (`co.kr`, `com.ua`, `*.mm`) — the boundary at which someone buys
// a name. PRIVATE lists boundaries that a single registrable domain's OWNER
// declares below their own name (`cloudfront.net`, `s3.<region>.amazonaws.com`,
// `webflow.io`, `github.io`, `blogspot.com`).
//
// Matching PRIVATE too is more literally correct — those really are different
// publishing parties — but it is wrong for THIS product. `scope_citations.domain`
// is the customer-facing GROUPING key on the citation leaderboard, and the
// PRIVATE section shatters exactly the rows a customer reads as "one place":
//
//   hyundai-website-v2-prod.s3.ap-southeast-1.amazonaws.com  (both sections)
//                                    amazonaws.com           (ICANN only)
//   d111111abcdef8.cloudfront.net    → cloudfront.net
//   hyundaimotor-asean.webflow.io    → webflow.io
//
// Each CDN bucket / distribution hash becomes its own leaderboard row, and
// those hashes are opaque and unstable. The trade-off is accepted knowingly:
// we lose the ability to distinguish two unrelated `github.io` publishers, and
// in exchange the leaderboard stays legible. Grouping legibility wins for a
// customer dashboard.
//
// PRIVATE_SUFFIX_RULES stays exported from ./data (and is still pinned by the
// integrity test) so this is a one-line reversal, not a data loss. The upstream
// PSL test vectors assume the full list, so 4 of the 78 vectors (`uk.com`) now
// diverge on purpose — index.test.ts enumerates them rather than deleting them.
const RULES: ReadonlySet<string> = new Set(
  ICANN_SUFFIX_RULES.split("\n")
    .map((r) => r.trim())
    .filter(Boolean),
);

/**
 * Number of rules actually MATCHED (ICANN section only) — lets tests assert the
 * snapshot loaded intact AND that the private section really is excluded.
 */
export const loadedRuleCount = RULES.size;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A bracketed IPv6 literal or a bare IPv4 dotted quad is not a domain name. */
export function isIpHost(host: string): boolean {
  if (!host) return false;
  if (host.startsWith("[") && host.endsWith("]")) return true;
  if (host.includes(":")) return true;
  return IPV4.test(host);
}

/**
 * Number of trailing labels that form the public suffix of `host`, per the PSL
 * algorithm: exception rules win; otherwise the rule with the most labels wins;
 * with no matching rule the implicit `*` rule applies (one label).
 */
function publicSuffixLabelCount(labels: string[]): number {
  // Exception rules (`!foo.bar`) take priority over every other match. The
  // public suffix is then the exception rule MINUS its leftmost label.
  for (let m = 1; m <= labels.length; m += 1) {
    const candidate = labels.slice(labels.length - m).join(".");
    if (RULES.has(`!${candidate}`)) return m - 1;
  }

  let best = 0;
  for (let m = 1; m <= labels.length; m += 1) {
    // Exact rule covering the trailing `m` labels.
    if (RULES.has(labels.slice(labels.length - m).join("."))) {
      if (m > best) best = m;
    }
    // Wildcard rule `*.X`: X is the trailing `m-1` labels, and the wildcard
    // consumes one more label to the left — so it only matches a host that
    // actually has that extra label.
    if (m >= 2) {
      const wild = `*.${labels.slice(labels.length - (m - 1)).join(".")}`;
      if (RULES.has(wild) && m > best) best = m;
    }
  }

  // "If no rules match, the prevailing rule is '*'."
  return best === 0 ? 1 : best;
}

/**
 * Split a host into labels, rejecting malformed input. An empty label means a
 * leading / doubled dot (`.example.com`, `a..com`) — not a valid hostname, and
 * the upstream PSL test vectors expect no registrable domain for those. A
 * trailing dot is already removed by the caller's normalization.
 */
function toLabels(host: string): string[] | null {
  const labels = host.split(".");
  if (labels.some((l) => l.length === 0)) return null;
  return labels;
}

/**
 * The public suffix (eTLD) of an already-normalized lowercase hostname, or null
 * for an IP literal / malformed / empty input.
 */
export function publicSuffix(host: string | null | undefined): string | null {
  if (!host) return null;
  if (isIpHost(host)) return null;
  const labels = toLabels(host);
  if (!labels || labels.length === 0) return null;
  const count = publicSuffixLabelCount(labels);
  if (count > labels.length) return null;
  return labels.slice(labels.length - count).join(".");
}

/**
 * The registrable domain (eTLD+1) of an already-normalized lowercase hostname.
 *
 * Returns null when the host IS a public suffix (`com`, `co.uk`), is a single
 * unlisted label, or is an IP literal — i.e. when no registrable domain exists.
 * Callers that must still produce a grouping key decide their own fallback.
 */
export function registrableDomain(host: string | null | undefined): string | null {
  if (!host) return null;
  if (isIpHost(host)) return null;
  const labels = toLabels(host);
  if (!labels || labels.length === 0) return null;
  const suffixLen = publicSuffixLabelCount(labels);
  if (labels.length <= suffixLen) return null;
  return labels.slice(labels.length - suffixLen - 1).join(".");
}

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
export function registrableDomainOfHost(
  rawHost: string | null | undefined,
): string | null {
  const host = (rawHost ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (!host) return null;
  const registrable = registrableDomain(host);
  if (registrable) return registrable;
  return host.replace(/^www\./, "") || null;
}
