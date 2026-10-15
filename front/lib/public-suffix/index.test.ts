// Ported from the scope repo's node:assert suite to vitest (this repo runs
// `npm test` = `vitest run`).
//
// The matcher's correctness is pinned by the Public Suffix List project's OWN
// test vectors (__fixtures__/psl-test-vectors.tsv, extracted verbatim from
// https://raw.githubusercontent.com/publicsuffix/list/master/tests/test_psl.txt).
// Those cover the parts a hand-rolled suffix set always gets wrong: wildcard
// rules, exception rules, unlisted TLDs, and mixed case.
//
// ⚠️ Since 2026-08-24 this repo matches the ICANN PSL section ONLY (see the
// `RULES` comment in ./index.ts). The upstream vectors assume BOTH sections, so
// a handful of them cannot pass by construction. They are NOT deleted — the
// exact set is enumerated in `PRIVATE_SECTION_DIVERGENCE` below with the value
// each configuration produces, and the test asserts that set is EXACTLY the
// vectors that diverge. A regeneration that changes which vectors depend on the
// PRIVATE section therefore fails loudly instead of drifting silently.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import {
  isIpHost,
  loadedRuleCount,
  publicSuffix,
  registrableDomain,
  registrableDomainOfHost,
} from "./index";
import {
  ICANN_SUFFIX_RULES,
  PRIVATE_SUFFIX_RULES,
  PUBLIC_SUFFIX_RULE_COUNT,
  PUBLIC_SUFFIX_RULES_SHA256,
} from "./data";
import { readSourceText } from "@/test/source-text";

const splitRules = (txt: string): string[] =>
  txt
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);

describe("public-suffix snapshot integrity", () => {
  it("loaded intact (count + digest pinned)", () => {
    const rules = splitRules(`${ICANN_SUFFIX_RULES}\n${PRIVATE_SUFFIX_RULES}`);
    expect(rules.length).toBe(PUBLIC_SUFFIX_RULE_COUNT);
    expect(createHash("sha256").update(rules.join("\n")).digest("hex")).toBe(
      PUBLIC_SUFFIX_RULES_SHA256,
    );
    // A truncated regeneration is the realistic failure mode.
    expect(rules.length).toBeGreaterThan(5000);
    // The wildcard/exception forms must survive generation — they are what a
    // hand-curated list structurally cannot represent.
    expect(rules).toContain("*.mm");
    expect(rules).toContain("!city.kobe.jp");
  });

  it("the matcher loads the ICANN section ONLY (2026-08-24 decision)", () => {
    const icann = splitRules(ICANN_SUFFIX_RULES);
    const priv = splitRules(PRIVATE_SUFFIX_RULES);
    // The whole point of the decision: private rules are present in the data
    // snapshot (reversibility) but absent from the matcher.
    expect(loadedRuleCount).toBe(icann.length);
    expect(loadedRuleCount).toBeLessThan(PUBLIC_SUFFIX_RULE_COUNT);
    expect(priv.length).toBeGreaterThan(2000);
    // Sanity: the sections really are disjoint, so `loadedRuleCount` could not
    // coincidentally equal the ICANN count while private rules leaked in.
    expect(icann.length + priv.length).toBe(PUBLIC_SUFFIX_RULE_COUNT);
  });
});

// The upstream vectors that depend on a PRIVATE-section rule, and therefore
// cannot match upstream while we run ICANN-only. Measured 2026-08-24 against
// this exact snapshot (ICANN 7,395 / PRIVATE 3,303): these four are the ONLY
// divergences out of 78 vectors — all of them `uk.com`, a PRIVATE rule.
//
//   key  = the vector's input (lowercased, as the matcher receives it)
//   value.upstream = what the full two-section list yields (the .tsv column)
//   value.icannOnly = what this repo yields, and why it is acceptable:
//                     `uk.com` is a reseller boundary, not a registry one, so
//                     folding `example.uk.com` -> `uk.com` is the same grouping
//                     choice we deliberately make for `cloudfront.net`.
const PRIVATE_SECTION_DIVERGENCE: Record<
  string,
  { upstream: string | null; icannOnly: string | null }
> = {
  "uk.com": { upstream: null, icannOnly: "uk.com" },
  "example.uk.com": { upstream: "example.uk.com", icannOnly: "uk.com" },
  "b.example.uk.com": { upstream: "example.uk.com", icannOnly: "uk.com" },
  "a.b.example.uk.com": { upstream: "example.uk.com", icannOnly: "uk.com" },
};

describe("upstream PSL test vectors", () => {
  it("registrableDomain matches every vector except the enumerated PRIVATE-section ones", () => {
    const file = new URL("./__fixtures__/psl-test-vectors.tsv", import.meta.url);
    const lines = readSourceText(file).trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(70);
    let checked = 0;
    const diverged: string[] = [];
    for (const line of lines) {
      const [rawInput, rawExpect] = line.split("\t");
      if (rawInput === undefined || rawExpect === undefined) continue;
      const input = rawInput === "null" ? null : rawInput;
      const expected = rawExpect === "null" ? null : rawExpect;
      // The vectors include mixed case; PSL matching is case-insensitive and
      // our callers hand us an already-lowercased host, so mirror that here.
      const lowered = input === null ? null : input.toLowerCase();
      const got = registrableDomain(lowered);
      const carveOut = lowered === null ? undefined : PRIVATE_SECTION_DIVERGENCE[lowered];
      if (carveOut) {
        // Pin BOTH halves: the upstream expectation we are knowingly departing
        // from, and the value we produce instead.
        expect(expected, `carve-out drifted from upstream: ${lowered}`).toBe(carveOut.upstream);
        expect(got, `carve-out value changed: ${lowered}`).toBe(carveOut.icannOnly);
        diverged.push(lowered);
      } else {
        expect(got, `input=${JSON.stringify(input)}`).toBe(expected);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(70);
    // Exactly the enumerated set diverges — no more, no fewer.
    expect(diverged.sort()).toEqual(Object.keys(PRIVATE_SECTION_DIVERGENCE).sort());
  });
});

// ── ICANN-only: the grouping this repo deliberately keeps coarse ────────────
//
// PRIVATE-section suffixes would explode each of these into one row per opaque
// CDN bucket / distribution hash on the customer's citation leaderboard. Hosts
// below are real values seen in HMG citations.

describe("PRIVATE-section suffixes stay folded (ICANN-only, 2026-08-24)", () => {
  it.each([
    // The PRIVATE rule here is the three-label `s3.<region>.amazonaws.com`;
    // ICANN-only folds all the way to the registrable domain.
    ["hyundai-website-v2-prod.s3.ap-southeast-1.amazonaws.com", "amazonaws.com"],
    ["d111111abcdef8.cloudfront.net", "cloudfront.net"],
    ["hyundaimotor-asean.webflow.io", "webflow.io"],
    ["someuser.github.io", "github.io"],
    ["someblog.blogspot.com", "blogspot.com"],
  ])("%s folds to %s", (host, want) => {
    expect(registrableDomainOfHost(host)).toBe(want);
    expect(registrableDomain(host)).toBe(want);
  });
});

describe("ICANN-section suffixes are unaffected by the carve-out", () => {
  it.each([
    ["hyundai.com.ua", "hyundai.com.ua"],
    ["sbs.gob.pe", "sbs.gob.pe"],
    ["kia.kiev.ua", "kia.kiev.ua"],
    ["tokyo.lg.jp", "tokyo.lg.jp"],
    ["pref.kanagawa.jp", "pref.kanagawa.jp"],
    // `gov.uk` is itself an ICANN rule, so the registrable domain is
    // `www.gov.uk` — NOT `gov.uk`. Unchanged by the carve-out; pinned here
    // because it is the case people expect to read the other way.
    ["www.gov.uk", "www.gov.uk"],
  ])("%s -> %s", (host, want) => {
    expect(registrableDomainOfHost(host)).toBe(want);
    expect(registrableDomain(host)).toBe(want);
  });
});

// ── the regression this module exists for ──────────────────────────────────
//
// Every host below was measured on 2026-08-24 in hmg-geo's own mirror
// (scope_citations, 71,825 truncated rows) — these are the actual values that
// the 8-entry TWO_LEVEL_TLDS copy in lib/scope/mirror/sync.ts folded away.

describe("eTLD truncation regression (hmg-geo mirror, 2026-08-24)", () => {
  it.each([
    ["hyundaimobil.co.id", "hyundaimobil.co.id"], // 7,723 rows
    ["hyundai.com.mx", "hyundai.com.mx"], //          7,355 rows
    ["kiavietnam.com.vn", "kiavietnam.com.vn"], //    2,301 rows
    ["kia-israel.co.il", "kia-israel.co.il"], //      2,130 rows
    ["hyundai.com.sg", "hyundai.com.sg"], //          1,369 rows
    ["kia.com.kz", "kia.com.kz"], //                  1,272 rows
    ["genesis.com.pr", "genesis.com.pr"], //            743 rows
    ["kia.co.nz", "kia.co.nz"], //                      738 rows
    ["car365.go.kr", "car365.go.kr"], //                710 rows
    ["kia.com.eg", "kia.com.eg"], //                    635 rows
    ["hyundai.com.ua", "hyundai.com.ua"], //            574 rows
    ["hyundai-motor.com.tr", "hyundai-motor.com.tr"], //552 rows
    ["hyundai.com.tw", "hyundai.com.tw"],
    ["hyundai.com.co", "hyundai.com.co"],
    ["koreana.or.kr", "koreana.or.kr"],
    ["visitkorea.or.kr", "visitkorea.or.kr"],
  ])("%s does not fold to its public suffix", (host, want) => {
    expect(registrableDomainOfHost(host)).toBe(want);
    expect(registrableDomain(host)).toBe(want);
  });

  it("com.mm is reachable only through the wildcard rule *.mm", () => {
    // A curated Set cannot express this at all: `*.mm` makes EVERY label under
    // .mm a public suffix. This is the structural reason 8 -> 24 entries could
    // not have fixed the defect.
    expect(publicSuffix("kia.com.mm")).toBe("com.mm");
    expect(registrableDomainOfHost("kia.com.mm")).toBe("kia.com.mm");
    expect(registrableDomain("com.mm")).toBe(null);
    expect(registrableDomainOfHost("anything.mm")).toBe("anything.mm");
  });

  it("exception rules (!city.kobe.jp) are honoured", () => {
    expect(registrableDomain("c.kobe.jp")).toBe(null);
    expect(registrableDomain("b.c.kobe.jp")).toBe("b.c.kobe.jp");
    expect(registrableDomain("city.kobe.jp")).toBe("city.kobe.jp");
    expect(registrableDomain("www.city.kobe.jp")).toBe("city.kobe.jp");
  });

  it("previously-correct folds are unchanged", () => {
    expect(registrableDomainOfHost("blog.naver.com")).toBe("naver.com");
    expect(registrableDomainOfHost("news.bobaedream.co.kr")).toBe("bobaedream.co.kr");
    expect(registrableDomainOfHost("motortrend.com")).toBe("motortrend.com");
    expect(registrableDomainOfHost("bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomainOfHost("a.b.c.example.com.au")).toBe("example.com.au");
    expect(registrableDomainOfHost("plan.danawa.com")).toBe("danawa.com");
    expect(registrableDomainOfHost("www.hyundai.com")).toBe("hyundai.com");
  });
});

describe("registrableDomainOfHost (repo-wide grouping key)", () => {
  it("normalizes case, surrounding space and a trailing dot", () => {
    expect(registrableDomainOfHost("  WWW.Hyundai.COM.UA. ")).toBe("hyundai.com.ua");
  });

  it("falls back to the host when no registrable domain exists", () => {
    // These have no eTLD+1 at all. The mirror still needs a grouping key, so
    // the normalized host is returned rather than null (see the doc comment).
    expect(registrableDomainOfHost("co.kr")).toBe("co.kr");
    expect(registrableDomainOfHost("com")).toBe("com");
    expect(registrableDomainOfHost("192.168.0.1")).toBe("192.168.0.1");
    expect(registrableDomainOfHost("localhost")).toBe("localhost");
  });

  it("returns null only for empty/absent input", () => {
    expect(registrableDomainOfHost("")).toBe(null);
    expect(registrableDomainOfHost("   ")).toBe(null);
    expect(registrableDomainOfHost(null)).toBe(null);
    expect(registrableDomainOfHost(undefined)).toBe(null);
  });

  it("is deterministic — the classification/grouping key depends on it", () => {
    for (const h of ["hyundaimobil.co.id", "hyundai.com.ua", "c.kobe.jp", "example.example"]) {
      expect(registrableDomainOfHost(h)).toBe(registrableDomainOfHost(h));
    }
  });
});

describe("IP literals, malformed hosts, IDN", () => {
  it("IP literals have no registrable domain", () => {
    for (const h of ["192.168.0.1", "127.0.0.1", "8.8.8.8", "[2001:db8::1]", "::1"]) {
      expect(isIpHost(h), h).toBe(true);
      expect(registrableDomain(h), h).toBe(null);
      expect(publicSuffix(h), h).toBe(null);
    }
    expect(isIpHost("hyundai.co.kr")).toBe(false);
  });

  it("leading / doubled dots are not valid hostnames", () => {
    expect(registrableDomain(".example.com")).toBe(null);
    expect(registrableDomain("a..com")).toBe(null);
    expect(registrableDomain("")).toBe(null);
    expect(registrableDomain(null)).toBe(null);
    expect(registrableDomain(undefined)).toBe(null);
  });

  it("punycode / IDN labels are ordinary labels", () => {
    expect(registrableDomain("xn--3e0b707e")).toBe(null); // .한국 TLD alone
    expect(registrableDomain("example.xn--3e0b707e")).toBe("example.xn--3e0b707e");
    expect(registrableDomain("www.example.xn--3e0b707e")).toBe("example.xn--3e0b707e");
  });
});
