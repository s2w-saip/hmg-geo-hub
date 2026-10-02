import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fullName, KNOWN_UPSTREAM_FAILURES, knownFailurePattern } from "./hgh-known-upstream-failures";

// Guards the hub known failure list (test/hgh-known-upstream-failures.ts): an entry that no
// longer names exactly one test would silently skip nothing or the wrong test.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "e2e"]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) testFiles(join(dir, e.name), out);
    } else if (/\.test\.tsx?$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

describe("hub known upstream failures", () => {
  const pattern = knownFailurePattern()!;
  const sources = testFiles(ROOT).map((p) => ({ rel: p.slice(ROOT.length), text: readFileSync(p, "utf8") }));

  it.each(KNOWN_UPSTREAM_FAILURES.map((f) => [f.file, f] as const))("%s: names one test, in its file only", (_file, f) => {
    expect(existsSync(join(ROOT, f.file)), f.file).toBe(true);
    const own = readFileSync(join(ROOT, f.file), "utf8");
    expect(own).toContain(JSON.stringify(f.suite));
    expect(own).toContain(JSON.stringify(f.test));
    // no other test file has a test of the same title (the pattern cannot see files)
    const others = sources.filter((s) => s.rel !== f.file && s.text.includes(JSON.stringify(f.test))).map((s) => s.rel);
    expect(others).toEqual([]);
    expect(f.kind).toBe("b");
    expect(f.brokenBy).toMatch(/^[0-9a-f]{7} /);
  });

  it("the pattern skips exactly the listed full names", () => {
    for (const f of KNOWN_UPSTREAM_FAILURES) {
      expect(pattern.test(fullName(f)), fullName(f)).toBe(false);
      // a neighbour (other test of the same describe, or the name with a suffix) still runs
      expect(pattern.test(`${fullName(f)} x`)).toBe(true);
      expect(pattern.test(`${f.suite} other`)).toBe(true);
    }
    expect(pattern.test("mirrorCycleModeOf ① summary-* 셀은 전부 첫 인자로 회차 집합 키를 받는다")).toBe(true);
    expect(knownFailurePattern([])).toBeUndefined();
  });
});
