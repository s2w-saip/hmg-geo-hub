import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readSourceText } from "@/test/source-text";

// BFF boundary: the analysis pages only fetch finished view models (lib/screen.ts → /v1/screens/*,
// back/bff/screens) and render them. Computation lives in the API. This guard follows the runtime
// imports (type-only imports do not count) from every page, layout and route handler of those
// pages, and fails when one of them reaches a module family that computes data.
//
// Allowed on purpose (not data computation): the filter panel's chrome and its master data
// (lib/scope dimensions · brand-presence · website-virtual-geo, lib/rhq), display mappings
// (lib/geo-catalog names, lib/citation-categorizer/taxonomy labels, lib/period-chip-text), chart
// geometry (lib/viz), the project gate and session adapters, and the auth repositories the session
// and the route gates use.

const FRONT = fileURLToPath(new URL("..", import.meta.url));
const EXT = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".json"];
const SKIP = new Set(["node_modules", ".next", ".git", ".out", ".run"]);

/** Page, layout and route files of the BFF screens (admin, QA, project creation are not BFF screens). */
const BFF_ENTRY =
  /^(app\/\[locale\]\/\((dash|renewal)\)\/(renewal\/)?(dashboard|website|standard|customer-interest|projects)\/.*\/?(page|layout)\.tsx|app\/\[locale\]\/\((dash|renewal)\)\/(renewal\/)?(dashboard|website|projects)\/(page|layout)\.tsx|app\/api\/(citations|scope|website|filters)\/.*route\.ts)$/;
const NOT_BFF = /\/projects\/(new|by-scope)\//;

/** Module families that compute data: a BFF page must not reach them at runtime. */
const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/^lib\/hgh\/adapters\/(?!project-gate\.ts$|session\.ts$)/, "front adapters (the API builds the view model)"],
  [/^lib\/kpi\//, "KPI / period comparison computation"],
  [/^lib\/period\//, "period resolution"],
  [/^lib\/scope\/(?!dimensions\.ts$|brand-presence\.ts$|website-virtual-geo\.ts$)/, "legacy aggregation / scope readers"],
  [/^lib\/db\/repositories\/(?!profiles\.ts$|project-members\.ts$|projects\.ts$|request-cache\.ts$)/, "legacy repositories"],
  [/^lib\/(ga4|keyword|summary)\//, "direct GA4 / DataForSEO / summary computation"],
  [/^lib\/citation-categorizer\/(?!taxonomy\.ts$)/, "citation categorisation rules"],
  [/^hooks\/use-sortable-table\.ts$/, "client-side sorting (orders come from the API)"],
];

const rel = (p: string) => relative(FRONT, p).split(sep).join("/");

function listFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, out);
    else if (EXT.includes(extname(e.name))) out.push(p);
  }
  return out;
}

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(FRONT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const c of [base, ...EXT.map((x) => base + x), ...EXT.map((x) => join(base, "index" + x))]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

// Runtime imports only: `import type` / `export type` are erased by the compiler.
const IMPORT_RE = /(?:import|export)\s+(?!type\s)(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function closure(entries: string[]): Map<string, string> {
  const parent = new Map<string, string>();
  const stack = [...entries];
  for (const e of entries) parent.set(e, "");
  while (stack.length) {
    const f = stack.pop()!;
    if (f.endsWith(".json")) continue;
    for (const m of readSourceText(f).matchAll(IMPORT_RE)) {
      const r = resolveSpec(f, m[1] ?? m[2]);
      if (r && !parent.has(r)) {
        parent.set(r, f);
        stack.push(r);
      }
    }
  }
  return parent;
}

function chain(parent: Map<string, string>, f: string): string {
  const out: string[] = [];
  for (let c = f; c; c = parent.get(c) ?? "") out.push(rel(c));
  return out.reverse().join(" -> ");
}

describe("BFF boundary: analysis pages fetch and render, they do not compute", () => {
  const files = listFiles(FRONT);
  const entries = files.filter((f) => BFF_ENTRY.test(rel(f)) && !NOT_BFF.test(rel(f)));
  const reached = closure(entries);

  it("finds the BFF pages and routes", () => {
    expect(entries.length).toBeGreaterThan(40);
    expect(entries.map(rel)).toContain("app/[locale]/(dash)/dashboard/page.tsx");
    expect(entries.map(rel)).toContain("app/api/citations/domains/route.ts");
  });

  it("reaches no data-computation module at runtime", () => {
    const violations: string[] = [];
    for (const f of reached.keys()) {
      const r = rel(f);
      for (const [re, why] of FORBIDDEN) if (re.test(r)) violations.push(`${why}: ${chain(reached, f)}`);
    }
    expect(violations).toEqual([]);
  });

  it("reads data through the screen client", () => {
    expect([...reached.keys()].map(rel)).toContain("lib/screen.ts");
  });
});

// Colour classes a screen sends as data (e.g. stack segment colours) are generated by Tailwind only
// when they also appear in the front source; one that lives only in Python renders without colour.
describe("BFF boundary: classes sent by the screens exist in the front source", () => {
  const SCREENS = join(FRONT, "..", "back", "bff", "screens");
  const CLASS_RE = /["']((?:[a-z]+:)?(?:bg|text|border|fill|stroke|ring|from|to|via|shadow|outline|decoration)-[a-z0-9]+(?:-[a-z0-9]+)*(?:\/\d+)?)["']/g;

  it("every class literal of back/bff/screens is written somewhere in front/", () => {
    const sent = new Set<string>();
    for (const f of readdirSync(SCREENS).filter((n) => n.endsWith(".py"))) {
      for (const m of readSourceText(join(SCREENS, f)).matchAll(CLASS_RE)) sent.add(m[1]);
    }
    expect(sent.size).toBeGreaterThan(0);
    const source = listFiles(FRONT).filter((f) => /\.(tsx?|css)$/.test(f) && !/\.test\.tsx?$/.test(f)).map(readSourceText).join("\n");
    expect([...sent].filter((c) => !source.includes(c))).toEqual([]);
  });
});
