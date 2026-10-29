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
// regenerate with `pnpm generate:public-suffixes`). No runtime network access —
// the same input always yields the same output, which citation classification
// caching depends on.

import { ICANN_SUFFIX_RULES, PRIVATE_SUFFIX_RULES } from "./data";

// Rules are looked up by exact string; wildcard/exception forms keep their
// `*.` / `!` prefix in the set and are probed explicitly below.
//
// Both PSL sections are used. The PRIVATE section marks boundaries below a
// registrable domain where a DIFFERENT party controls the content
// (`cloudfront.net`, `it.com`, `com.de`) — exactly the distinction citation
// analytics needs, and required for the upstream test vectors to pass.
const RULES: ReadonlySet<string> = new Set(
  `${ICANN_SUFFIX_RULES}\n${PRIVATE_SUFFIX_RULES}`
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean),
);

/** Number of parsed rules — lets tests assert the snapshot actually loaded. */
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
