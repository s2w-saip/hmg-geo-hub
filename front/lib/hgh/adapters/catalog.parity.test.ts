import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { components } from "../api-types";
import type { AllowedScope } from "@/lib/auth/types";

// Legacy <-> API parity of the prompt catalogs (unit U8): /standard/prompts (root catalog list,
// change history tab) and /website/prompts (the measured site catalog list).
//
// Method. One WORLD (root and non-root catalog prompts with brand and target markets, audit
// rows with actors) is written twice:
//   legacy: rows on PGlite (real PostgreSQL), read by the UNCHANGED repository functions the page
//           calls: listStandardCatalogScoped(scope) and promptAuditLogRepository.listGlobalScoped
//           ({scope, from: now - 90 days});
//   api:    a backend model of GET /v1/prompts?surface=global (root catalog, not deleted, scope =
//           account brands + umbrella/NULL, target markets B1, order depth1..3, text, prompt_id)
//           and GET /v1/prompts/history (same scope, 90 KST days, created_at desc), converted by
//           lib/hgh/adapters/catalog.ts.
//   website: listWebsitePromptsScoped(scope, filters, {sort, dir}) on PGlite (anchor axis off,
//           the current default) vs a backend model of GET /v1/prompts?surface=website fed with
//           the query the page really sends (readWebsitePromptQuery -> websitePromptQuery), so
//           the filter serialization and the scope-injection strip are part of the comparison.
// Differences must be the documented ones (catalog.ts header / KNOWN below).

const st = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => st.db }));
// Anchor axis off (the legacy default path): no anchor tables needed, lastMeasuredAt is the
// COALESCE(cycle_anchor_at, measured_at) timestamp (U8-N19 is about exactly this path).
vi.mock("@/lib/period/anchor-axis-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/period/anchor-axis-state")>()),
  ensureAnchorAxis: async () => false,
  anchorAxisKnownEnabled: () => false,
}));

const { STANDARD_ROOT_PROJECT_ID, listStandardCatalogScoped } = await import("@/lib/db/repositories/standards");
const { promptAuditLogRepository } = await import("@/lib/db/repositories/prompt-audit-logs");
const { listWebsitePromptsScoped } = await import("@/lib/db/repositories/website-sites");
const { readWebsitePromptQuery } = await import("@/lib/website/prompt-query");
const { WEBSITE_BRAND_GEO_CODES } = await import("@/lib/scope/website-virtual-geo");
const C = await import("./catalog");

type S = components["schemas"];
type Pg = { exec(q: string): Promise<unknown>; close(): Promise<void> };

const ROOT = STANDARD_ROOT_PROJECT_ID;
const OTHER = "00000000-0000-4000-8000-0000000000ff";
const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const lit = (v: string | null) => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);
const arr = (v: string[] | null) => (v === null ? "NULL" : `ARRAY[${v.map(lit).join(",")}]::text[]`);

// ── WORLD ───────────────────────────────────────────────────────────────────

interface Prompt {
  id: string;
  project: string;
  text: string;
  brand: string | null;
  regions: string[] | null;
  d1: string | null;
  d2: string | null;
  kind: string;
  lang: string | null;
  scope: string | null;
  deleted?: boolean;
}
const P: Prompt[] = [
  { id: u(1), project: ROOT, text: "best ev", brand: "Hyundai", regions: ["US"], d1: "1.", d2: "a", kind: "single", lang: "EN", scope: u(0x101) },
  { id: u(2), project: ROOT, text: "kia suv", brand: "Kia", regions: ["us", "x:worldwide"], d1: "1.", d2: null, kind: "acr", lang: "EN", scope: null },
  { id: u(3), project: ROOT, text: "umbrella", brand: "HMG", regions: null, d1: null, d2: null, kind: "single", lang: "KO", scope: u(0x103) },
  { id: u(4), project: ROOT, text: "common", brand: null, regions: ["x:global"], d1: "2.", d2: null, kind: "single", lang: null, scope: u(0x104) },
  { id: u(5), project: ROOT, text: "kia kr only", brand: "Kia", regions: ["KR"], d1: "2.", d2: "b", kind: "single", lang: "KO", scope: u(0x105) },
  { id: u(6), project: ROOT, text: "deleted", brand: "Kia", regions: null, d1: "1.", d2: null, kind: "single", lang: null, scope: null, deleted: true },
  { id: u(7), project: OTHER, text: "project prompt", brand: "Kia", regions: null, d1: "0.", d2: null, kind: "single", lang: null, scope: null },
  { id: u(8), project: ROOT, text: "a genesis", brand: "Genesis", regions: [], d1: "1.", d2: "a", kind: "single", lang: "DE", scope: null },
];

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
interface Audit {
  id: string;
  seq: number;
  prompt: Prompt;
  actor: string | null;
  type: string;
  changes: Record<string, { old: string | null; new: string | null }>;
  at: string;
}
const ACTOR = u(0x900);
const A: Audit[] = [
  { id: u(0x301), seq: 1, prompt: P[0], actor: ACTOR, type: "text_updated", changes: { text: { old: "ev", new: "best ev" } }, at: daysAgo(3) },
  { id: u(0x302), seq: 2, prompt: P[1], actor: null, type: "created", changes: {}, at: daysAgo(10) },
  { id: u(0x303), seq: 3, prompt: P[4], actor: ACTOR, type: "meta_updated", changes: { depth1: { old: null, new: "2." } }, at: daysAgo(20) },
  { id: u(0x304), seq: 4, prompt: P[2], actor: ACTOR, type: "kind_changed", changes: { kind: { old: "acr", new: "single" } }, at: daysAgo(40) },
  { id: u(0x305), seq: 5, prompt: P[0], actor: ACTOR, type: "created", changes: {}, at: daysAgo(200) }, // outside 90 days
  { id: u(0x306), seq: 6, prompt: P[6], actor: ACTOR, type: "created", changes: {}, at: daysAgo(5) }, // not the root catalog
];

const DDL = `
CREATE TABLE prompts (id uuid PRIMARY KEY, project_id uuid NOT NULL, text text NOT NULL, prompt_type text, category text,
  brand text, brand_presence text, list_type text, depth1 text, depth2 text, depth3 text, depth4 text, funnel_stage text,
  kind text NOT NULL, lang text, regions text[], scope_prompt_id uuid, deleted_at timestamptz);
CREATE TABLE scope_prompts (prompt_id uuid PRIMARY KEY, text text);
CREATE TABLE profiles (id uuid PRIMARY KEY, email text);
CREATE TABLE prompt_audit_logs (id uuid PRIMARY KEY, prompt_id uuid NOT NULL, project_id uuid NOT NULL, actor_id uuid,
  actor_type text NOT NULL, event_type text NOT NULL, changes jsonb NOT NULL, batch_id uuid, created_at timestamptz NOT NULL);
CREATE TABLE website_sites (id uuid PRIMARY KEY, brand text NOT NULL, country_code text NOT NULL, scope_project_id text);
CREATE TABLE website_prompts (id uuid PRIMARY KEY, site_id uuid NOT NULL, prompt_text text NOT NULL, target_url text NOT NULL,
  domain text NOT NULL, lang_code text NOT NULL, scope_prompt_id text);
CREATE TABLE scope_runs (run_id uuid PRIMARY KEY, cycle_anchor_at timestamptz);
CREATE TABLE scope_answers (id serial PRIMARY KEY, prompt_id uuid NOT NULL, run_id uuid, job_id uuid, target text NOT NULL,
  status text NOT NULL, measured_at timestamptz NOT NULL);
`;

// Website catalog. Four sites (one of them the virtual "Hyundai N" brand), five prompts (one not
// measured), answers over three engines with and without a round anchor, one failed answer.
interface Site { id: string; brand: string; country: string }
interface WPrompt { id: string; site: Site; text: string; url: string; domain: string; lang: string; scope: string | null }
interface Answer { prompt: string; target: string; status: string; measuredAt: string; anchor: string | null }
const S1: Site = { id: u(0x501), brand: "Hyundai", country: "US" };
const S2: Site = { id: u(0x502), brand: "Kia", country: "US" };
const S3: Site = { id: u(0x503), brand: "Kia", country: "DE" };
const S4: Site = { id: u(0x504), brand: "Hyundai N", country: "KR" };
const W: WPrompt[] = [
  { id: u(0x601), site: S1, text: "best suv", url: "https://hyundai.com/us/suv", domain: "hyundai.com", lang: "en", scope: u(0x701) },
  { id: u(0x602), site: S1, text: "ev range", url: "https://hyundai.com/us/range", domain: "hyundai.com", lang: "en", scope: u(0x702) },
  { id: u(0x603), site: S2, text: "kia ev9", url: "https://kia.com/us/ev9", domain: "kia.com", lang: "en", scope: u(0x703) },
  { id: u(0x604), site: S3, text: "kia de", url: "https://kia.com/de", domain: "kia.com", lang: "de", scope: null },
  { id: u(0x605), site: S4, text: "n performance", url: "https://hyundai-n.com/kr", domain: "hyundai-n.com", lang: "ko", scope: u(0x705) },
];
const ANS: Answer[] = [
  { prompt: u(0x701), target: "chatgpt", status: "completed", measuredAt: "2026-09-10T03:00:00Z", anchor: "2026-09-09T15:00:00Z" },
  { prompt: u(0x701), target: "gemini", status: "completed", measuredAt: "2026-09-03T02:00:00Z", anchor: null },
  { prompt: u(0x701), target: "perplexity", status: "completed", measuredAt: "2026-09-12T01:00:00Z", anchor: null },
  { prompt: u(0x702), target: "chatgpt", status: "failed", measuredAt: "2026-09-11T00:00:00Z", anchor: null },
  { prompt: u(0x703), target: "gemini", status: "completed", measuredAt: "2026-08-20T05:00:00Z", anchor: "2026-08-19T15:00:00Z" },
  // 20:00 UTC = 05:00 KST the next day: the round day is 2026-09-06
  { prompt: u(0x705), target: "chatgpt", status: "completed", measuredAt: "2026-09-05T20:00:00Z", anchor: null },
];
function websiteInserts(): string {
  const rows: string[] = [];
  for (const s of [S1, S2, S3, S4]) rows.push(`INSERT INTO website_sites VALUES (${lit(s.id)}, ${lit(s.brand)}, ${lit(s.country)}, NULL);`);
  for (const w of W) {
    rows.push(`INSERT INTO website_prompts VALUES (${lit(w.id)}, ${lit(w.site.id)}, ${lit(w.text)}, ${lit(w.url)}, ${lit(w.domain)}, ${lit(w.lang)}, ${lit(w.scope)});`);
  }
  ANS.forEach((a, i) => {
    const run = u(0x800 + i);
    rows.push(`INSERT INTO scope_runs VALUES (${lit(run)}, ${a.anchor ? `${lit(a.anchor)}::timestamptz` : "NULL"});`);
    rows.push(`INSERT INTO scope_answers (prompt_id, run_id, job_id, target, status, measured_at) VALUES (${lit(a.prompt)}, ${lit(run)}, NULL, ${lit(a.target)}, ${lit(a.status)}, ${lit(a.measuredAt)}::timestamptz);`);
  });
  return rows.join("\n");
}
function inserts(): string {
  const rows: string[] = [`INSERT INTO profiles VALUES (${lit(ACTOR)}, 'editor@hmg.test');`];
  for (const p of P) {
    rows.push(
      `INSERT INTO prompts VALUES (${lit(p.id)}, ${lit(p.project)}, ${lit(p.text)}, 'Brand', 'cat', ${lit(p.brand)}, 'branded', 'Brand Message', ${lit(p.d1)}, ${lit(p.d2)}, NULL, NULL, '인지/탐색', ${lit(p.kind)}, ${lit(p.lang)}, ${arr(p.regions)}, ${lit(p.scope)}, ${p.deleted ? "now()" : "NULL"});`,
    );
    if (p.scope) rows.push(`INSERT INTO scope_prompts VALUES (${lit(p.scope)}, ${lit(p.text)});`);
  }
  for (const a of A) {
    rows.push(
      `INSERT INTO prompt_audit_logs VALUES (${lit(a.id)}, ${lit(a.prompt.id)}, ${lit(a.prompt.project)}, ${lit(a.actor)}, ${lit(a.actor ? "user" : "system")}, ${lit(a.type)}, ${lit(JSON.stringify(a.changes))}::jsonb, NULL, ${lit(a.at)});`,
    );
  }
  return rows.join("\n");
}

// ── backend model ───────────────────────────────────────────────────────────

const UMBRELLA = "HMG";
function inScope(p: Prompt, scope: AllowedScope): boolean {
  if (scope.all) return true;
  if (scope.brands?.length && !(p.brand === null || p.brand === UMBRELLA || scope.brands.includes(p.brand))) return false;
  const allowed = scope.countries;
  if (allowed?.length) {
    const real = (p.regions ?? []).map((r) => r.trim()).filter((r) => r !== "" && !r.toLowerCase().startsWith("x:"));
    if (real.length && !real.some((r) => allowed.includes(r.toUpperCase()))) return false;
  }
  return true;
}
const nullsLast = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);
function backendCatalog(scope: AllowedScope): S["GlobalPromptRow"][] {
  return P.filter((p) => p.project === ROOT && !p.deleted && inScope(p, scope))
    .sort((a, b) => nullsLast(a.d1, b.d1) || nullsLast(a.d2, b.d2) || nullsLast(a.text, b.text) || nullsLast(a.id, b.id))
    .map((p) => ({
      prompt_id: p.id,
      text: p.text,
      kind: p.kind,
      scope_prompt_id: p.scope,
      measured: p.scope !== null,
      brand_code: p.brand,
      brand_presence: "branded",
      brand_presence_effective: "branded",
      prompt_type: "Brand",
      category: "cat",
      list_type: "Brand Message",
      depth1: p.d1,
      depth2: p.d2,
      depth3: null,
      depth4: null,
      funnel_stage: "인지/탐색",
      lang: p.lang,
      regions: p.regions,
    }));
}
function backendHistory(scope: AllowedScope): S["HistoryRow"][] {
  const from = new Date(NOW - 90 * 86_400_000);
  return A.filter((a) => a.prompt.project === ROOT && new Date(a.at) >= from && inScope(a.prompt, scope))
    .sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq)
    .map((a) => ({
      audit_id: a.seq,
      prompt_id: a.prompt.id,
      prompt_text: a.prompt.text,
      prompt_brand: a.prompt.brand,
      event_type: a.type,
      changes: a.changes,
      actor_id: a.actor,
      actor_type: a.actor ? "user" : "system",
      actor_email: a.actor ? "editor@hmg.test" : null,
      batch_id: null,
      created_at: a.at,
    }));
}

// ── PGlite ──────────────────────────────────────────────────────────────────

let pg: Pg;
beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  pg = new PGlite() as unknown as Pg;
  await pg.exec(DDL);
  await pg.exec(inserts());
  await pg.exec(websiteInserts());
  const real = drizzle(pg as never);
  st.db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "execute") return async (q: unknown) => (await target.execute(q as never)).rows;
      return Reflect.get(target, prop, receiver);
    },
  });
}, 60_000);
afterAll(async () => {
  await pg?.close();
});

// ── cases ───────────────────────────────────────────────────────────────────

// Hand-computed expectations (so the parity cannot pass on two empty lists):
//   catalog order = depth1, depth2, text, id with NULLs last; u6 deleted, u7 not the root.
//     admin: u8 (1./a/"a genesis"), u1 (1./a/"best ev"), u2 (1./null), u5 (2./b), u4 (2./null), u3 (null)
//     Kia US: u2 (Kia, "us" upper-cased), u4 (no brand, only x: regions), u3 (umbrella HMG, no regions);
//             u1 Hyundai, u5 KR only, u8 Genesis out
//     Hyundai KR: u4, u3; u1 is Hyundai but US only
//   history (90 days, root, newest first): 0x301 (3 d), 0x302 (10 d), 0x303 (20 d), 0x304 (40 d);
//     0x305 is 200 days old, 0x306 is not the root catalog
//     Kia US: 0x302 (u2), 0x304 (u3 umbrella); Hyundai KR: 0x304
const SCOPES: { name: string; scope: AllowedScope; catalog: number[]; history: number[] }[] = [
  { name: "admin (scope all)", scope: { all: true }, catalog: [8, 1, 2, 5, 4, 3], history: [0x301, 0x302, 0x303, 0x304] },
  { name: "Kia account, US market", scope: { all: false, brands: ["Kia"], countries: ["US"] }, catalog: [2, 4, 3], history: [0x302, 0x304] },
  { name: "Hyundai account, KR market", scope: { all: false, brands: ["Hyundai"], countries: ["KR"] }, catalog: [4, 3], history: [0x304] },
];

// Fields the read-only list renders (StandardPromptViewRow) + the ones the adapter fills.
// scopeText is not rendered by the viewer list: the API does not carry it (KNOWN: null).
const KNOWN_CATALOG = { scopeText: "not in GlobalPromptRow; the read-only list never renders it" };
const KNOWN_AUDIT = { id: "U8-N18: audit id is the backend integer (String(audit_id)); legacy uuid. Only a React key" };

describe("/standard/prompts catalog: listStandardCatalogScoped vs GET /v1/prompts?surface=global", () => {
  for (const c of SCOPES) {
    it(c.name, async () => {
      const legacy = (await listStandardCatalogScoped(c.scope)).rows;
      const api = backendCatalog(c.scope).map(C.toStandardCatalogRow);
      expect(legacy.map((r) => r.id)).toEqual(c.catalog.map(u));
      const strip = (r: Record<string, unknown>) => {
        const out = { ...r };
        for (const k of Object.keys(KNOWN_CATALOG)) delete out[k];
        return out;
      };
      expect(api.map(strip)).toEqual(legacy.map((r) => strip(r as unknown as Record<string, unknown>)));
      expect(api.every((r) => r.scopeText === null)).toBe(true);
    });
  }
});

describe("/standard/prompts history: listGlobalScoped(90 days) vs GET /v1/prompts/history", () => {
  for (const c of SCOPES) {
    it(c.name, async () => {
      const legacy = await promptAuditLogRepository.listGlobalScoped({ scope: c.scope, from: new Date(NOW - 90 * 86_400_000) });
      const api = backendHistory(c.scope).map(C.toAuditView);
      const view = (r: Record<string, unknown>) => {
        const out: Record<string, unknown> = { ...r, createdAt: (r.createdAt as Date).getTime() };
        for (const k of Object.keys(KNOWN_AUDIT)) delete out[k];
        return out;
      };
      expect(api.map((r) => view(r as unknown as Record<string, unknown>))).toEqual(legacy.map((r) => view(r as unknown as Record<string, unknown>)));
      expect(legacy.map((r) => r.promptId + "/" + r.eventType)).toEqual(
        c.history.map((id) => {
          const a = A.find((x) => x.id === u(id))!;
          return a.prompt.id + "/" + a.type;
        }),
      );
      expect(legacy.map((r) => r.id)).toEqual(c.history.map(u));
      // U8-N18: the only field apart
      expect(api.map((r) => r.id)).toEqual(backendHistory(c.scope).map((h) => String(h.audit_id)));
    });
  }
});

// ── /website/prompts ────────────────────────────────────────────────────────

/** Backend default engines when engine[] is empty (DC-01). */
const DEFAULT_ENGINES = ["chatgpt", "gemini"];
const kstDay = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
type WebsiteQuery = ReturnType<typeof C.websitePromptQuery>;
const list = (v: unknown): string[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/**
 * GET /v1/prompts?surface=website as the backend defines it (openapi listPrompts): scope sites
 * (account brands x countries, server-side), then the query's own narrowing (brand, country with
 * virtual site codes, lang, search on prompt_text/target_url), the lens (engine[] or the default
 * engines, completed answers) and the order (sort key, NULLs last, id).
 */
function backendWebsite(q: WebsiteQuery, scope: AllowedScope): { rows: S["WebsitePromptRow"][]; total: number } {
  const qq = q as Record<string, unknown>;
  const brands = list(qq.brand);
  const countries = list(qq.country);
  const langs = list(qq.lang);
  const engines = list(qq.engine).length ? list(qq.engine) : DEFAULT_ENGINES;
  const search = qq.search ? String(qq.search).toLowerCase() : null;
  const inScopeSite = (s: Site) =>
    scope.all || ((!scope.brands?.length || scope.brands.includes(s.brand)) && (!scope.countries?.length || scope.countries.includes(s.country)));
  const geo = (s: Site) => !countries.length || countries.some((c) => c === s.country || WEBSITE_BRAND_GEO_CODES[c] === s.brand);
  const rows = W.filter(
    (w) =>
      inScopeSite(w.site) &&
      (!brands.length || brands.includes(w.site.brand)) &&
      geo(w.site) &&
      (!langs.length || langs.includes(w.lang)) &&
      (!search || w.text.toLowerCase().includes(search) || w.url.toLowerCase().includes(search)),
  ).map((w): S["WebsitePromptRow"] => {
    const lens = ANS.filter((a) => a.prompt === w.scope && a.status === "completed" && engines.includes(a.target));
    const last = lens.map((a) => a.anchor ?? a.measuredAt).sort().at(-1);
    return {
      website_prompt_id: w.id,
      prompt_text: w.text,
      brand_code: w.site.brand,
      country_code: w.site.country,
      lang_code: w.lang,
      target_url: w.url,
      domain: w.domain,
      answers: lens.length,
      last_measured: last ? kstDay(last) : null,
      engines: [...new Set(lens.map((a) => a.target))].sort(),
      measured: w.scope !== null,
      owned_base_url: null,
      scope_prompt_id: w.scope,
    };
  });
  const key: Record<string, (r: S["WebsitePromptRow"]) => string | number | null> = {
    prompt: (r) => r.prompt_text,
    brand: (r) => r.brand_code,
    country: (r) => r.country_code,
    lang: (r) => r.lang_code,
    target_url: (r) => r.target_url,
    answers: (r) => r.answers,
    last_measured: (r) => r.last_measured ?? null,
  };
  const k = key[String(qq.sort ?? "last_measured")];
  const sign = qq.dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const x = k(a);
    const y = k(b);
    if (x !== y) {
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sign;
    }
    return a.website_prompt_id < b.website_prompt_id ? -1 : 1;
  });
  return { rows, total: rows.length };
}

interface WebsiteCase {
  name: string;
  scope: AllowedScope;
  admin: boolean;
  sp: Record<string, string | string[]>;
  /** hand-computed row order (low hex of the website prompt id) */
  expect: number[];
}
// Hand-computed:
//   A lastMeasured desc, every engine: W1 max(anchor 09-09T15Z, 09-03, 09-12T01Z) = 09-12, W5 09-05T20Z
//     (KST 09-06), W3 anchor 08-19T15Z (KST 08-20), then W2 (only a failed answer) and W4 (not
//     measured) with no date, by id
//   B Kia US account: the Kia US site only -> W3
//   C "ev" in prompt or URL, lang en, gemini lens, answers desc: W3 (1 gemini answer), W2 (0)
//   D HYUNDAI-N virtual site code on the geography axis -> the Hyundai N site -> W5
//   E prompt asc, every engine: "best suv" W1, "ev range" W2, "kia de" W4, "kia ev9" W3, "n performance" W5
const ALL = ["chatgpt", "gemini", "perplexity"];
const WEBSITE_CASES: WebsiteCase[] = [
  { name: "A admin, every engine, last measured desc", scope: { all: true }, admin: true, sp: { engine: ALL }, expect: [0x601, 0x605, 0x603, 0x602, 0x604] },
  { name: "B Kia account US, every engine, prompt asc", scope: { all: false, brands: ["Kia"], countries: ["US"] }, admin: false, sp: { engine: ALL, sort: "prompt", dir: "asc" }, expect: [0x603] },
  { name: "C search + language + one engine, answers desc", scope: { all: true }, admin: true, sp: { q: "ev", language: "en", engine: "gemini", sort: "answers" }, expect: [0x603, 0x602] },
  { name: "D virtual site code HYUNDAI-N", scope: { all: true }, admin: true, sp: { geography: "HYUNDAI-N", engine: ALL }, expect: [0x605] },
  { name: "E prompt asc", scope: { all: true }, admin: true, sp: { engine: ALL, sort: "prompt", dir: "asc" }, expect: [0x601, 0x602, 0x604, 0x603, 0x605] },
];

/** U8-N19: the legacy timestamp shown as its KST day (the API value). */
const onDay = (r: { lastMeasuredAt: string | null }) => ({ ...r, lastMeasuredAt: r.lastMeasuredAt ? kstDay(r.lastMeasuredAt) : null });

describe("/website/prompts: listWebsitePromptsScoped vs GET /v1/prompts?surface=website", () => {
  for (const c of WEBSITE_CASES) {
    it(c.name, async () => {
      const { filters, sort, dir } = readWebsitePromptQuery(c.sp, c.scope, c.admin);
      const legacy = await listWebsitePromptsScoped(c.scope, filters, { sort, dir, pageSize: 200 });
      const q = C.websitePromptQuery({ filters, sort, dir }, c.scope);
      const backend = backendWebsite(q, c.scope);
      const api = backend.rows.map(C.toWebsitePromptRow);

      expect(legacy.rows.map((r) => r.id)).toEqual(c.expect.map(u));
      expect(backend.total).toBe(legacy.total);
      expect(api).toEqual(legacy.rows.map(onDay));
    });
  }

  it("U8-N19: the legacy value is a timestamp; the API value is its KST day (W5 crosses midnight)", async () => {
    const { filters, sort, dir } = readWebsitePromptQuery({ engine: ALL }, { all: true }, true);
    const legacy = await listWebsitePromptsScoped({ all: true }, filters, { sort, dir });
    const w5 = legacy.rows.find((r) => r.id === u(0x605))!;
    expect(w5.lastMeasuredAt).toBe("2026-09-05T20:00:00.000Z");
    const api = backendWebsite(C.websitePromptQuery({ filters, sort, dir }, { all: true }), { all: true }).rows.map(C.toWebsitePromptRow);
    expect(api.find((r) => r.id === u(0x605))!.lastMeasuredAt).toBe("2026-09-06");
  });

  it("DC-01: with no engine chosen only the prompt measured by a non-default engine differs, in the lens columns only", async () => {
    const { filters, sort, dir } = readWebsitePromptQuery({}, { all: true }, true);
    expect(filters.engines ?? []).toEqual([]);
    const legacy = (await listWebsitePromptsScoped({ all: true }, filters, { sort, dir })).rows.map(onDay);
    const api = backendWebsite(C.websitePromptQuery({ filters, sort, dir }, { all: true }), { all: true }).rows.map(C.toWebsitePromptRow);
    expect(api.map((r) => r.id)).toEqual(legacy.map((r) => r.id));
    const differs = api.filter((r, i) => !isDeepStrictEqual(r, legacy[i]));
    expect(differs.map((r) => r.id)).toEqual([u(0x601)]);
    const legacyW1 = legacy.find((r) => r.id === u(0x601))!;
    const apiW1 = differs[0];
    // legacy: 3 answers over every engine, latest 09-12 (perplexity); api: chatgpt + gemini only,
    // latest = the chatgpt round anchor 09-09T15Z = 09-10 KST
    expect([legacyW1.answers, legacyW1.engines, legacyW1.lastMeasuredAt]).toEqual([3, ["chatgpt", "gemini", "perplexity"], "2026-09-12"]);
    expect([apiW1.answers, apiW1.engines, apiW1.lastMeasuredAt]).toEqual([2, ["chatgpt", "gemini"], "2026-09-10"]);
    expect({ ...apiW1, answers: 0, engines: [], lastMeasuredAt: null }).toEqual({ ...legacyW1, answers: 0, engines: [], lastMeasuredAt: null });
  });
});
