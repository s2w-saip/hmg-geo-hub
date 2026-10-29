#!/usr/bin/env node
// Heuristic guard for the "no hardcoded UI strings" rule (localization spec).
// Flags Hangul text appearing as JSX text content or in common string-bearing
// JSX attributes in app/ and components/. UI strings must come from i18n
// dictionaries (messages/*.json) via t(); this catches the most common slip:
// Korean copy pasted straight into JSX.
//
// Heuristic, not a parser — review flags, suppress false positives with the
// inline marker `/* i18n-ignore */` on the line. Exits 1 if any flag is found.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["app", "components"];
const HANGUL = /[가-힣]/;
const IGNORE = "i18n-ignore";

/** Collect .tsx files under the given roots. */
function walk(dir, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
}

const files = [];
for (const root of ROOTS) {
  try {
    walk(root, files);
  } catch {
    // root may not exist yet
  }
}

const flags = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.includes(IGNORE)) return;
    // JSX text content: >...한글...<   or   bare Hangul inside a tag boundary
    const jsxText = />[^<>{}\n]*[가-힣][^<>{}\n]*</.test(line);
    // string-bearing attributes with Hangul
    const attr =
      /(?:title|label|placeholder|alt|aria-label)\s*=\s*["'][^"']*[가-힣]/.test(
        line,
      );
    if ((jsxText || attr) && HANGUL.test(line)) {
      flags.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (flags.length > 0) {
  console.error("Hardcoded UI strings found (use i18n messages instead):\n");
  for (const f of flags) console.error("  " + f);
  console.error(
    `\n${flags.length} issue(s). Move text to messages/*.json or add /* ${IGNORE} */.`,
  );
  process.exit(1);
}

console.log("OK: no hardcoded Hangul UI strings detected.");
