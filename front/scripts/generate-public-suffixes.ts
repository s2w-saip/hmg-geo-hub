/**
 * Generator — Public Suffix List snapshot for `lib/public-suffix/`.
 *
 * Ported from the scope repo (Kongventures/scope scripts/generate-public-suffixes.ts).
 * Both repos must resolve eTLD+1 identically or the hmg-geo mirror stops
 * grouping citations the way scope does.
 *
 * Why a committed snapshot instead of an npm dependency (tldts / psl):
 *
 *  1. The suffix set is a *semantic input to stored data*, not a runtime
 *     detail: `scope_citations.domain` is written once at mirror-sync time and
 *     never recomputed on read. A silent dependency bump would change what
 *     future rows are keyed by while old rows keep the old grouping. The set
 *     must be reviewable in `git diff`.
 *  2. Determinism — the same host must always yield the same grouping key, in
 *     this repo and in scope.
 *  3. No new supply-chain surface for what is pure lookup data.
 *
 * The cost of owning updates is paid down by (a) this generator, (b) the
 * upstream PSL test vectors committed alongside the matcher, and (c) an
 * integrity test pinning the emitted rule count + digest.
 *
 * BOTH sections are emitted (ICANN + PRIVATE), kept as separate exports so the
 * split is auditable and reversible.
 *
 * ⚠️ Emitted ≠ matched. Since 2026-08-24 `lib/public-suffix/index.ts` builds its
 * rule set from ICANN_SUFFIX_RULES ONLY (제품 책임자 decision). PRIVATE is still
 * emitted, still pinned by the integrity digest, and still unused at runtime —
 * so re-enabling it is a one-line change in index.ts with no regeneration.
 *
 * Why PRIVATE is emitted but not matched:
 *   - matching it IS more literally correct: those rules mark real publisher
 *     boundaries below a registrable domain (`cloudfront.net`, `github.io`,
 *     `s3.<region>.amazonaws.com`, `webflow.io`, `blogspot.com`);
 *   - but `scope_citations.domain` is the customer-facing GROUPING key on the
 *     citation leaderboard, and those boundaries shatter it into one row per
 *     opaque CDN bucket / distribution hash. Grouping legibility was chosen
 *     over party-level precision. Full reasoning: the `RULES` comment in
 *     lib/public-suffix/index.ts;
 *   - the upstream PSL test vectors assume the FULL list, so ICANN-only
 *     diverges on 4 of the 78 committed vectors (all `uk.com`, a PRIVATE rule).
 *     index.test.ts enumerates those four explicitly instead of dropping them,
 *     so the rest of the vectors keep working as independent evidence and a
 *     regeneration that changes the divergence set fails loudly;
 *   - measured live impact of the PRIVATE section (scope, 2026-07-26): 27
 *     two-label suffixes / 1,084 citations (0.11%) — `cloudfront.net` (20
 *     hosts), `blogspot.com` (15), `it.com`, `com.de`, `vercel.app`,
 *     `github.io`, `pages.dev`, `myshopify.com`, `netlify.app`. An independent
 *     count that also walks THREE-label PRIVATE rules (e.g.
 *     `us-east-1.amazonaws.com`, 211 citations) puts it nearer 32 suffixes /
 *     1,415 citations (0.14%). Small either way — which is also why excluding
 *     it is cheap. The highest-volume blog hosts (`tistory.com`, `naver.com`,
 *     `wordpress.com`, `medium.com`) carry no PSL rule at all and are unaffected
 *     in both configurations.
 *
 * ⚠️ scope (Kongventures/scope `lib/public-suffix/`) still matches BOTH
 * sections. The two repos' grouping keys are therefore NO LONGER identical for
 * hosts under PRIVATE suffixes. Whether scope should follow is a separate
 * decision.
 *
 * Usage:  npm run generate:public-suffixes
 * Network: fetches publicsuffix.org at BUILD time only. Runtime never fetches.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { domainToASCII } from "node:url";
import path from "node:path";

const SOURCE_URL = "https://publicsuffix.org/list/public_suffix_list.dat";
const OUT = path.join(process.cwd(), "lib", "public-suffix", "data.ts");

/**
 * The upstream list stores IDN rules in UTF-8 (`公司.cn`), but `new URL().hostname`
 * — how every production caller obtains a host — yields punycode
 * (`xn--55qx5d.cn`). Emit BOTH forms so the matcher works on either without
 * transcoding (which would also change the *output* form).
 */
function withPunycode(rule: string): string[] {
  // Pure-ASCII rules already are their own punycode form.
  if (!/[^\x00-\x7F]/.test(rule)) return [rule];
  const prefix = rule.startsWith("!") ? "!" : "";
  const bare = prefix ? rule.slice(1) : rule;
  const ascii = domainToASCII(bare);
  if (!ascii || ascii === bare) return [rule];
  return [rule, `${prefix}${ascii}`];
}

function sectionRules(lines: string[], name: string): string[] {
  const beginAt = lines.findIndex((l) => l.includes(`===BEGIN ${name} DOMAINS===`));
  const endAt = lines.findIndex((l) => l.includes(`===END ${name} DOMAINS===`));
  if (beginAt < 0 || endAt < 0 || endAt <= beginAt) {
    throw new Error(`${name} section markers not found — upstream format changed`);
  }
  return [
    ...new Set(
      lines
        .slice(beginAt + 1, endAt)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("//"))
        .flatMap(withPunycode),
    ),
    // Sorted so an upstream reordering does not produce a noisy diff.
  ].sort();
}

async function main(): Promise<void> {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`PSL fetch failed: ${res.status}`);
  const raw = await res.text();
  const upstreamDigest = createHash("sha256").update(raw).digest("hex");

  const lines = raw.split("\n");
  const icann = sectionRules(lines, "ICANN");
  const priv = sectionRules(lines, "PRIVATE");

  if (icann.length < 5000) {
    throw new Error(`suspiciously few ICANN rules (${icann.length}) — aborting`);
  }
  if (priv.length < 2000) {
    throw new Error(`suspiciously few PRIVATE rules (${priv.length}) — aborting`);
  }

  // The matcher assumes wildcards are LEADING-ONLY (`*.foo`) and that exception
  // rules never nest. Both hold for the list today; if upstream ever adds
  // `a.*.jp` or two exceptions on the same branch, the matcher would silently
  // mis-resolve instead of failing. Fail generation instead.
  for (const rule of [...icann, ...priv]) {
    const bare = rule.startsWith("!") ? rule.slice(1) : rule;
    const star = bare.indexOf("*");
    if (star > 0) {
      throw new Error(
        `non-leading wildcard rule "${rule}" — lib/public-suffix matcher only probes leading "*."`,
      );
    }
    if (star === 0 && !bare.startsWith("*.")) {
      throw new Error(`unexpected wildcard form "${rule}"`);
    }
  }
  const exceptions = [...icann, ...priv].filter((r) => r.startsWith("!"));
  for (const a of exceptions) {
    for (const b of exceptions) {
      if (a !== b && a.slice(1).endsWith(`.${b.slice(1)}`)) {
        throw new Error(
          `nested exception rules "${a}" / "${b}" — matcher returns the shortest match first`,
        );
      }
    }
  }

  const all = [...icann, ...priv];
  const stat = (rs: string[]): string =>
    `${rs.length} (wildcard ${rs.filter((r) => r.startsWith("*.")).length}, exception ${rs.filter((r) => r.startsWith("!")).length})`;
  const digest = (rs: string[]): string =>
    createHash("sha256").update(rs.join("\n")).digest("hex");

  const body = `// GENERATED FILE — do not edit by hand. Run \`npm run generate:public-suffixes\`.
//
// Public Suffix List snapshot — both sections, kept separate so the split is
// auditable and reversible.
//   source:           ${SOURCE_URL}
//   retrieved:        ${new Date().toISOString().slice(0, 10)}
//   upstream sha256:  ${upstreamDigest}
//   ICANN rules:      ${stat(icann)}
//   PRIVATE rules:    ${stat(priv)}
//   combined sha256:  ${digest(all)}
//
// NOTE: index.ts matches the ICANN section ONLY (decision 2026-08-24). PRIVATE
// is emitted for auditability + one-line reversibility. See
// scripts/generate-public-suffixes.ts and lib/public-suffix/index.ts.

/** Combined rule count at generation time — pinned by index.test.ts. */
export const PUBLIC_SUFFIX_RULE_COUNT = ${all.length};

/** sha256 of the newline-joined combined rules — pinned by index.test.ts. */
export const PUBLIC_SUFFIX_RULES_SHA256 =
  "${digest(all)}";

/** ICANN section — registry-operated suffixes (\`co.kr\`, \`com.ua\`, \`*.mm\`). */
export const ICANN_SUFFIX_RULES = \`${icann.join("\n")}\`;

/** PRIVATE section — party boundaries below a registrable domain (\`cloudfront.net\`). */
export const PRIVATE_SUFFIX_RULES = \`${priv.join("\n")}\`;
`;

  writeFileSync(OUT, body, "utf8");
  console.log(
    `wrote ${OUT}\n  ICANN=${stat(icann)}\n  PRIVATE=${stat(priv)}\n  combined=${all.length}\n  upstream sha256=${upstreamDigest}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
