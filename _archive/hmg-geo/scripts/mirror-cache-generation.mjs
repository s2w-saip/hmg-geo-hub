// Mirror cache generation — derived from source, not from human memory.
//
// WHY (2026-08-29): lib/scope/server.ts wraps every mirror aggregate in
// unstable_cache keyed by a hand-bumped generation string ("mirror-v2" →
// "mirror-v3" → "mirror-v4"). The comment there says "bump on every semantic
// change" — and on 2026-08-29 alone that rule was broken twice (PR #113
// changed tracked judgment / rank formula / NER exclusion, PR #114 changed
// the citation group key; neither bumped). #113 was only rescued because a
// *mistaken* cache hypothesis produced the #116 bump after it. A comment is
// not an enforcement mechanism.
//
// HOW: the stale-cell hazard is exactly "code the cached arrows transitively
// call changed its output for identical inputs". Next already keys each cell
// by the wrapper arrow's own text (unstable-cache.js: fixedKey includes
// cb.toString()) and by the JSON of its args — what it cannot see is the
// *called* modules (scope-aggregates.ts, citation-categorizer, hmg-brands, …).
// So we extend the same principle: hash the transitive in-repo import closure
// of lib/scope/server.ts at build time and put that hash in the cache key
// (wired via next.config.ts `env` → process.env.MIRROR_CACHE_SOURCE_HASH).
// Any deploy that touches the aggregation surface invalidates the mirror
// cache automatically; nobody has to remember anything.
//
// Over-invalidation (a comment-only edit also busts) is accepted by design:
// a cold cell costs one mirror GROUP BY per filter combo, which is already
// paid on every 30-min TTL expiry and every sync revalidateTag. Missing an
// invalidation costs wrong numbers on a customer dashboard.
//
// Only node stdlib — this runs inside next.config.ts at build/dev startup
// and inside vitest. Keep it dependency-free and synchronous.

import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";

export const MIRROR_CACHE_ENTRY = "lib/scope/server.ts";

// Matches every static specifier form used in this repo:
//   import x from "…" / import "…" / export … from "…" / import("…")
const SPECIFIER_RE =
  /(?:from\s*|import\s*\(\s*|import\s+)["']([^"']+)["']/g;

const RESOLVE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  ".json",
  "/index.ts",
  "/index.tsx",
];

function resolveSpecifier(rootDir, fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) {
    base = path.join(rootDir, spec.slice(2)); // tsconfig: "@/*" → "./*"
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else {
    return null; // npm package / next builtin / "server-only" — out of scope
  }
  for (const suffix of RESOLVE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null; // e.g. a type-only path that only exists as .d.ts — ignore
}

/**
 * BFS over the in-repo import graph from `entry`. Returns the sorted list of
 * repo-relative file paths in the closure (entry included).
 */
export function resolveMirrorSourceClosure(rootDir, entry = MIRROR_CACHE_ENTRY) {
  const entryAbs = path.join(rootDir, entry);
  const visited = new Set();
  const queue = [entryAbs];
  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (file.endsWith(".json")) continue; // data leaf — no imports
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SPECIFIER_RE)) {
      const resolved = resolveSpecifier(rootDir, file, match[1]);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }
  return [...visited]
    .map((f) => path.relative(rootDir, f).split(path.sep).join("/"))
    .sort();
}

/**
 * Content hash of the closure — 12 hex chars, deterministic for identical
 * file contents. Paths are hashed alongside contents so a rename alone also
 * changes the generation (a rename can change resolution/behavior).
 */
export function computeMirrorSourceHash(rootDir, entry = MIRROR_CACHE_ENTRY) {
  const hash = createHash("sha256");
  for (const rel of resolveMirrorSourceClosure(rootDir, entry)) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(path.join(rootDir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}
