// Guards for the derived mirror-cache generation (scripts/mirror-cache-generation.mjs).
//
// The generation used to be a hand-bumped string, and on 2026-08-29 the bump
// was forgotten twice in one day (#113 tracked/rank/NER, #114 citation group
// key). It is now derived from the import closure of lib/scope/server.ts, so
// the thing to guard is no longer "did a human bump it" but "does the deriving
// machinery still cover the aggregation surface and is it actually wired in".
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeMirrorSourceHash,
  resolveMirrorSourceClosure,
} from "../../scripts/mirror-cache-generation.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("mirror cache source closure", () => {
  const closure = resolveMirrorSourceClosure(ROOT);

  it("covers the exact files the 2026-08-29 incidents changed", () => {
    // Regression pins: PR #113 (tracked 판정·순위 산식·NER 제외) and PR #114
    // (인용 그룹 키) each changed cached-aggregate semantics without a bump.
    // Every semantic file those PRs touched must stay inside the hashed
    // closure — if one of these ever goes MISS, the derived generation has a
    // blind spot and we are back to relying on human memory.
    const incidentSurfaces = [
      "lib/db/repositories/scope-aggregates.ts", // #113 ① tracked / ② rank formula
      "lib/scope/hmg-brands.ts", // #113 tracked rollup canon
      "lib/scope/non-competitor-brands.ts", // #113 ④ NER noise exclusion
      "lib/scope/result-adapter.ts", // #113/#114 shared shaping
      "lib/db/repositories/citation-group-key.ts", // #114 group key SQL
      "lib/citation-categorizer/official-social.ts", // #114 official-social rules
    ];
    for (const file of incidentSurfaces) {
      expect(closure, `${file} must be in the hashed closure`).toContain(file);
    }
  });

  it("covers the data dictionaries aggregation semantics depend on", () => {
    // Classification seeds are code in JSON clothing: editing them changes
    // cached outputs exactly like editing a rule file does (the v3 bump was
    // precisely a dictionary expansion).
    expect(closure).toContain("lib/citation-categorizer/seed.json");
    expect(closure).toContain("lib/geo-catalog/_data/web-geo-final.json");
  });

  it("does not drag test files into the closure", () => {
    // Test files never run in production; hashing them would invalidate the
    // fleet-wide cache for changes that cannot affect served values.
    expect(closure.filter((f) => /\.test\.tsx?$/.test(f))).toEqual([]);
  });
});

describe("mirror cache source hash", () => {
  it("is 12 lowercase hex chars and deterministic", () => {
    const first = computeMirrorSourceHash(ROOT);
    expect(first).toMatch(/^[0-9a-f]{12}$/);
    expect(computeMirrorSourceHash(ROOT)).toBe(first);
  });

  it("changes when a transitively imported file changes content", () => {
    // Synthetic two-file graph: entry → dep. Editing dep (never touched by
    // the entry's own text) must change the hash — that is the exact case
    // (#113/#114: server.ts untouched, downstream module changed) the manual
    // generation kept missing.
    const dir = mkdtempSync(path.join(tmpdir(), "mirror-gen-"));
    try {
      writeFileSync(path.join(dir, "entry.ts"), `import "./dep";\n`);
      writeFileSync(path.join(dir, "dep.ts"), `export const RULE = 1;\n`);
      const before = computeMirrorSourceHash(dir, "entry.ts");
      writeFileSync(path.join(dir, "dep.ts"), `export const RULE = 2;\n`);
      const after = computeMirrorSourceHash(dir, "entry.ts");
      expect(after).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wiring", () => {
  // The derivation only enforces anything if it is actually injected at build
  // and consumed in the cache key. Source-level tripwires: cheap, and they
  // surface a silent unwiring (someone reverting to a bare literal) as a
  // failing test instead of a silently-stale production cache.
  it("next.config.ts injects MIRROR_CACHE_SOURCE_HASH from the deriver", () => {
    const config = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
    expect(config).toMatch(/MIRROR_CACHE_SOURCE_HASH:\s*computeMirrorSourceHash\(/);
    expect(config).toMatch(
      /from "\.\/scripts\/mirror-cache-generation\.mjs"/,
    );
  });

  it("server.ts composes the injected hash into the unstable_cache keyPart", () => {
    const server = readFileSync(
      path.join(ROOT, "lib/scope/server.ts"),
      "utf8",
    );
    expect(server).toMatch(/process\.env\.MIRROR_CACHE_SOURCE_HASH/);
    expect(server).toMatch(/unstable_cache\(fn, \[MIRROR_CACHE_GENERATION, key\]/);
  });
});
