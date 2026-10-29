// One-shot generator: turn the corporate-framework prompts.txt into a SQL load
// for the "HMG Standard (root catalog)" project in the `prompts` table.
//
//   - 6 fields/record: List Type · Depth1 · Depth2 · Depth3 · 퍼널 · 프롬프트
//   - "{Hyundai/Kia/Genesis}" prompts are split into 3 per-brand rows; brand set
//     to Hyundai/Kia/Genesis. Everything else gets brand = "HMG".
//   - scope_prompt_id is linked by matching the (placeholder→"Hyundai, Kia, and
//     Genesis") combined text against scope_prompts.text.
//   - "-" / "" depth values become NULL. 퍼널 kept as the Korean label.
//
// Usage: node scripts/db/gen-standard-prompts.mjs  → writes load-standard-prompts.sql
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "../..");

const PROJECT_ID = "26751906-c175-485c-9e69-29fc68d0fdbb";
const CREATED_BY = "d9d6ffbb-d3cb-4cdd-9780-511b8014899f";
const PLACEHOLDER = "{Hyundai/Kia/Genesis}";
const SCOPE_COMBINED = "Hyundai, Kia, and Genesis";
const BRANDS = ["Hyundai", "Kia", "Genesis"];

const vals = fs
  .readFileSync(path.join(ROOT, "scripts/db/_input/prompts.txt"), "utf8")
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean);

const body = vals.slice(6); // drop the 6 header fields
const recs = [];
for (let i = 0; i + 5 < body.length; i += 6) {
  recs.push({
    listType: body[i],
    depth1: body[i + 1],
    depth2: body[i + 2],
    depth3: body[i + 3],
    funnel: body[i + 4],
    text: body[i + 5],
  });
}

const norm = (v) => (v == null || v === "-" || v === "" ? null : v);
const rows = [];
for (const r of recs) {
  const base = {
    listType: norm(r.listType),
    depth1: norm(r.depth1),
    depth2: norm(r.depth2),
    depth3: norm(r.depth3),
    funnel: norm(r.funnel),
  };
  if (r.text.includes(PLACEHOLDER)) {
    const matchText = r.text.split(PLACEHOLDER).join(SCOPE_COMBINED);
    for (const b of BRANDS) {
      rows.push({ ...base, text: r.text.split(PLACEHOLDER).join(b), brand: b, matchText });
    }
  } else {
    rows.push({ ...base, text: r.text, brand: "HMG", matchText: r.text });
  }
}

const q = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const link = (mt) =>
  `(SELECT prompt_id FROM public.scope_prompts WHERE text = ${q(mt)} LIMIT 1)`;

const lines = rows.map(
  (r) =>
    "  (" +
    [
      q(PROJECT_ID),
      q(r.text),
      q(r.brand),
      q(r.listType),
      q(r.depth1),
      q(r.depth2),
      q(r.depth3),
      q(r.funnel),
      "'draft'",
      q(CREATED_BY),
      link(r.matchText),
    ].join(", ") +
    ")",
);

const sql =
  "BEGIN;\n" +
  "-- Idempotent reload of the HMG Standard (root) prompt catalog.\n" +
  `DELETE FROM public.prompts WHERE project_id = ${q(PROJECT_ID)};\n` +
  "INSERT INTO public.prompts\n" +
  "  (project_id, text, brand, list_type, depth1, depth2, depth3, funnel_stage, status, created_by, scope_prompt_id)\n" +
  "VALUES\n" +
  lines.join(",\n") +
  ";\nCOMMIT;\n";

fs.writeFileSync(path.join(HERE, "load-standard-prompts.sql"), sql);

const byBrand = {};
for (const r of rows) byBrand[r.brand] = (byBrand[r.brand] || 0) + 1;
console.log("records:", recs.length, "-> rows:", rows.length);
console.log("brand:", JSON.stringify(byBrand));
console.log("distinct match_texts:", new Set(rows.map((r) => r.matchText)).size);
console.log("sql bytes:", Buffer.byteLength(sql));
