// ⚠️ 초기 시드 전용 (2026-08-12 catalog-prompt-audit 이후). 운영 카탈로그의
// 편집·교체는 /admin/standards/prompts UI(단건·벌크 xlsx)가 정본 경로다 — 이
// 생성기의 산출 SQL은 감사 원장을 남기지 않고 통째 교체하므로 운영 사용 금지.
//
// Generator for prompts_v0.4.txt (FINAL set) → SQL load for the "HMG Standard
// (root catalog)" project. Differs from gen-standard-prompts.mjs:
//   - v0.4 is TAB-separated, ONE record per line, with a header line.
//   - Taxonomy fields carry an ordering prefix ("1. ", "2. ") that we strip.
//   - The combined prompts are already gone from scope, so a brand-split row
//     links to its OWN per-brand scope prompt by exact text (match_text = the
//     final per-brand text), not the old combined form.
//
// Usage: node scripts/db/gen-standard-prompts-v04.mjs → writes load-standard-prompts-v04.sql
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "../..");

const PROJECT_ID = "26751906-c175-485c-9e69-29fc68d0fdbb";
const CREATED_BY = "d9d6ffbb-d3cb-4cdd-9780-511b8014899f";
const PLACEHOLDER = "{Hyundai/Kia/Genesis}";
const BRANDS = ["Hyundai", "Kia", "Genesis"];

const lines = fs
  .readFileSync(path.join(ROOT, "scripts/db/_input/prompts_v0.4.txt"), "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim().length > 0);

// drop the header row, split each record on tabs
const recs = lines.slice(1).map((l) => {
  const f = l.split("\t");
  const strip = (s) => (s ?? "").replace(/^\s*\d+\.\s*/, "").trim(); // kill "2. " prefix
  return {
    listType: strip(f[0]),
    depth1: strip(f[1]),
    depth2: strip(f[2]),
    depth3: strip(f[3]),
    funnel: strip(f[4]),
    text: (f[5] ?? "").trim(), // prompt text is NOT prefixed — leave verbatim
  };
});

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
    for (const b of BRANDS) {
      const text = r.text.split(PLACEHOLDER).join(b);
      rows.push({ ...base, text, brand: b, matchText: text });
    }
  } else {
    rows.push({ ...base, text: r.text, brand: "HMG", matchText: r.text });
  }
}

const q = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const link = (mt) =>
  `(SELECT prompt_id FROM public.scope_prompts WHERE text = ${q(mt)} LIMIT 1)`;
const lineSql = rows.map(
  (r) =>
    "  (" +
    [
      q(PROJECT_ID), q(r.text), q(r.brand), q(r.listType), q(r.depth1),
      q(r.depth2), q(r.depth3), q(r.funnel), "'draft'", q(CREATED_BY), link(r.matchText),
    ].join(", ") +
    ")",
);

const sql =
  "BEGIN;\n" +
  "-- Replace the HMG Standard (root) catalog with the v0.4 FINAL set.\n" +
  `DELETE FROM public.prompts WHERE project_id = ${q(PROJECT_ID)};\n` +
  "INSERT INTO public.prompts\n" +
  "  (project_id, text, brand, list_type, depth1, depth2, depth3, funnel_stage, status, created_by, scope_prompt_id)\n" +
  "VALUES\n" +
  lineSql.join(",\n") +
  ";\nCOMMIT;\n";

fs.writeFileSync(path.join(HERE, "load-standard-prompts-v04.sql"), sql);

const byBrand = {};
for (const r of rows) byBrand[r.brand] = (byBrand[r.brand] || 0) + 1;
console.log("records:", recs.length, "-> rows:", rows.length);
console.log("brand:", JSON.stringify(byBrand));
console.log("distinct funnel:", [...new Set(rows.map((r) => r.funnel))]);
console.log("distinct depth1:", [...new Set(rows.map((r) => r.depth1))].length, "values");
console.log("sql bytes:", Buffer.byteLength(sql));
