#!/usr/bin/env node
// scripts/audit-control-contrast.mjs
//
// Greps app/ + components/ for usages of interactive primitives where the
// resting affordance may collapse into the page background:
//   - <Button variant="ghost"> with no override class
//   - <Badge variant="ghost">
//   - <Input> usage chained right after a Label only (likely "form row" — OK)
//     vs Inputs in toolbar-like flex rows (heuristic)
//
// Heuristic — not a perfect detector. Reports candidate file:line locations
// for visual review. Run after a contrast pass to confirm coverage.
//
// Usage:  node scripts/audit-control-contrast.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["app", "components"].map((d) => join(ROOT, d));

// Patterns: each entry = { name, regex, severity }
// severity: "warn" = check visually, "info" = expected pattern, fine
const PATTERNS = [
  {
    name: "Button variant=\"ghost\" (no extra bg/border class)",
    regex: /<Button[^>]*variant=["']ghost["'][^>]*>/g,
    severity: "warn",
    note:
      "Ghost has no resting affordance. OK for icon buttons in tables / dialogs; bad in toolbars where it reads as plain text.",
  },
  {
    name: "Badge variant=\"ghost\"",
    regex: /<Badge[^>]*variant=["']ghost["']/g,
    severity: "warn",
    note: "Ghost badge = text-only. Confirm it's inside a contained surface.",
  },
  {
    name: "SelectTrigger with className=bg-transparent (legacy override)",
    regex: /<SelectTrigger[^>]*className=["'][^"']*bg-transparent/g,
    severity: "error",
    note:
      "Should not override to bg-transparent — the new default bg-muted/40 fixes the page-bg-blend issue.",
  },
  {
    name: "Input with className=bg-transparent",
    regex: /<Input[^>]*className=["'][^"']*bg-transparent/g,
    severity: "error",
    note: "Same — bg-card is the new default.",
  },
  {
    name: "Toolbar-style flex containers with Select/Input directly (no card wrap)",
    regex: /flex[^"']*items-center[^"']*gap[^"']*["'][^]{0,300}<(?:Select|Input)/g,
    severity: "info",
    note: "Heuristic — flag rows that may need explicit card wrapping.",
  },
];

function walk(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
      out = out.concat(walk(p));
    } else if (/\.(tsx?|jsx?)$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

const files = SCAN_DIRS.flatMap(walk);
const lineOf = (src, idx) => src.slice(0, idx).split("\n").length;

let totals = { error: 0, warn: 0, info: 0 };
const findings = [];

for (const file of files) {
  const src = readFileSync(file, "utf8");
  for (const pat of PATTERNS) {
    let m;
    pat.regex.lastIndex = 0;
    while ((m = pat.regex.exec(src))) {
      const line = lineOf(src, m.index);
      findings.push({
        file: relative(ROOT, file),
        line,
        pattern: pat.name,
        severity: pat.severity,
        note: pat.note,
        snippet: m[0].slice(0, 120).replace(/\s+/g, " "),
      });
      totals[pat.severity]++;
    }
  }
}

// Print grouped by pattern, errors first
const order = { error: 0, warn: 1, info: 2 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file));

let lastPattern = "";
for (const f of findings) {
  if (f.pattern !== lastPattern) {
    console.log("");
    const tag =
      f.severity === "error" ? "✗" : f.severity === "warn" ? "!" : "·";
    console.log(`${tag} ${f.pattern}  [${f.severity}]`);
    console.log(`  ${f.note}`);
    lastPattern = f.pattern;
  }
  console.log(`  ${f.file}:${f.line}  →  ${f.snippet}`);
}

console.log("");
console.log(
  `Summary: ${totals.error} error  ${totals.warn} warn  ${totals.info} info`,
);
if (totals.error > 0) process.exit(1);
