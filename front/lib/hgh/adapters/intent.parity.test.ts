import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { GeneratedPrompt } from "@/components/social-scraping/types";

// Legacy <-> API parity for customer interest (unit U10).
//
// Method. One neutral fixture WORLD (a project and its members, tracked keywords, the candidate
// pool, registered prompts, the context map corpus, generated social prompts, and the keyword
// facts DataForSEO would answer) is written twice, each in its own native form:
//   legacy: rows on PGlite (real PostgreSQL) read and written by the UNCHANGED legacy
//           repositories, and the keyword facts answered by a DataForSEO HTTP stub, so the legacy
//           route code (lib/keyword/*) runs for real. Only the LLM (OpenRouter) is replaced by a
//           deterministic function, and the keyword caches are unavailable (their documented
//           best-effort mode).
//   api:    a backend model answering /v1/* in the OpenAPI shapes from the same WORLD with the
//           documented backend semantics (collection queue, keyset cursors, operator gate, dedup),
//           read through lib/hgh/adapters/intent.ts.
// Both sides run the real pages (JSX props handed to the screen components), the real route
// handlers (status + JSON body) and the real server actions. Outputs are diffed field by field
// and the set of differing paths must equal the case's declared KNOWN_DIFF: an unexpected
// difference fails, and so does a declared one that disappears.

const st = vi.hoisted(() => ({
  db: null as unknown,
  user: null as null | {
    id: string;
    email: string;
    role: "hq" | "region" | "country" | "admin" | "vendor" | "website";
    scope: { all: boolean };
    operator: "none" | "assigned" | "global";
    menuGroups: ("standard" | "website" | "project" | "admin")[] | null;
  },
}));

vi.mock("@/lib/db", () => ({ getDb: () => st.db }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => (st.user ? { user: st.user } : null) }));
vi.mock("next/cache", () => ({
  unstable_cache: <F>(fn: F) => fn,
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
// Keyword caches: unavailable (the documented best-effort mode: callers recompute live).
vi.mock("@/lib/db/repositories/keyword-cache", () => ({
  keywordCacheRepository: {
    get: async () => {
      throw new Error("keyword_cache absent");
    },
    set: async () => {
      throw new Error("keyword_cache absent");
    },
  },
}));
vi.mock("@/lib/db/repositories/keyword-volume-cache", () => ({
  keywordVolumeCacheRepository: {
    getValid: async () => {
      throw new Error("keyword_volume_cache absent");
    },
  },
}));
// The LLM is the one external service replaced: the same deterministic function answers the
// legacy keyword -> prompt call and the backend model's serp-drafts.
const llmQuestion = (input: string) => `Q:${input}`;
vi.mock("@/lib/keyword/keyword-to-prompt", () => ({
  generateNaturalQuestions: async (inputs: string[]) =>
    inputs.map((i) => ({ originalInput: i, question: `Q:${i}`, searchIntent: "informational" })),
}));
vi.mock("next-intl/server", async () => {
  const base = (await import("@/messages/ko.json")).default as Record<string, unknown>;
  const unit = (await import("@/messages/units/u10.ko.json")).default as Record<string, unknown>;
  const at = (o: unknown, path: string[]) => path.reduce<unknown>((x, k) => (x as Record<string, unknown> | undefined)?.[k], o);
  return {
    setRequestLocale: () => undefined,
    getTranslations: async (ns: string) => (k: string) => {
      const path = [...ns.split("."), ...k.split(".")];
      const v = at(unit, path) ?? at(base, path);
      return typeof v === "string" ? v : k;
    },
  };
});

const { bindHghAuth } = await import("../auth");
const { annotateSimilar } = await import("@/lib/social-scraping/similarity");
const { isAlreadyAdded } = await import("@/lib/social-scraping/catalog-added");
const { UnauthorizedError } = await import("@/lib/auth/errors");
const insightRoute = await import("@/app/api/keyword/insight/route");
const relatedRoute = await import("@/app/api/keyword/related/route");
const searchRoute = await import("@/app/api/keyword/search/route");
const contextMapRoute = await import("@/app/api/context-map/route");
const exportRoute = await import("@/app/api/context-map/export/route");
const { scopeContextMapRepository } = await import("@/lib/db/repositories/scope-context-map");
const { DEMO_PROJECT_ID } = await import("@/lib/demo");
const { MAX_SEARCH_TERMS, apiAddTrackedKeywords, intentActionMessages } = await import("./intent");
const actions = await import("@/app/[locale]/(dash)/projects/[id]/intent/_actions");
const GoogleKeywordPage = (await import("@/app/[locale]/(dash)/projects/[id]/intent/google-keyword/page")).default;
const SocialPage = (await import("@/app/[locale]/(dash)/projects/[id]/intent/social-scraping/page")).default;
const StandardKeywordsPage = (await import("@/app/[locale]/(dash)/customer-interest/google-keywords/page")).default;
const { GoogleKeywordView } = await import("@/app/[locale]/(dash)/projects/[id]/intent/_components/google-keyword-view");
const { SocialScrapingFlow } = await import("@/components/social-scraping/social-scraping-flow");
const { DEFAULT_KEYWORD_TERMS } = await import("@/app/[locale]/(dash)/projects/[id]/intent/_data/sample");

// ── WORLD ───────────────────────────────────────────────────────────────────

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln";
const PID = u(0x10);
const ADMIN = u(0xa1);
const OWNER = u(0xa2); // hq, assigned operator, active owner
const VIEWER = u(0xa3); // country, no operator authority, active viewer
const WEBSITE = u(0xa4); // website role: no project or standard menu

type Usr = NonNullable<typeof st.user>;
const USERS: Record<string, Usr> = {
  admin: { id: ADMIN, email: "a@x.test", role: "admin", scope: { all: true }, operator: "none", menuGroups: null },
  owner: { id: OWNER, email: "o@x.test", role: "hq", scope: { all: true }, operator: "assigned", menuGroups: null },
  viewer: { id: VIEWER, email: "v@x.test", role: "country", scope: { all: true }, operator: "none", menuGroups: null },
  website: { id: WEBSITE, email: "w@x.test", role: "website", scope: { all: true }, operator: "none", menuGroups: null },
};
const MEMBERS = [
  { userId: OWNER, role: "owner", status: "active" },
  { userId: VIEWER, role: "viewer", status: "active" },
];

const TRACKED = [
  { id: u(0x201), term: "suv", country: null as string | null, createdAt: "2026-09-01T00:00:00.000Z" },
  { id: u(0x202), term: "ev3", country: "KR", createdAt: "2026-09-02T00:00:00.000Z" },
];
const CANDIDATES = [
  { id: u(0x301), text: "가족용 SUV 추천해줘", source: "social_scraping", createdAt: "2026-09-03T00:00:00.000Z" },
  { id: u(0x302), text: "전기차 충전 요금은?", source: "google_keyword", createdAt: "2026-09-04T00:00:00.000Z" },
];
const REGISTERED = ["가족용 SUV 추천해 주세요"];

interface Entity {
  id: string;
  type: "ConsumerContext" | "ConsumerRequirement";
  name: string;
  dimension: string | null;
  mention: number;
  utter: number;
  sent: [number, number, number];
}
const C1 = u(0x401);
const C2 = u(0x402);
const C3 = u(0x403);
const R1 = u(0x411);
const R2 = u(0x412);
const R3 = u(0x413);
const R4 = u(0x414);
const ENTITIES: Entity[] = [
  { id: C1, type: "ConsumerContext", name: "아이 둘 가족", dimension: "lifestage", mention: 30, utter: 40, sent: [3, 1, 3] },
  { id: C2, type: "ConsumerContext", name: "주말 캠핑", dimension: "usecase", mention: 20, utter: 20, sent: [0, 0, 0] },
  { id: C3, type: "ConsumerContext", name: "첫 차 구매", dimension: null, mention: 10, utter: 12, sent: [1, 1, 0] },
  { id: R1, type: "ConsumerRequirement", name: "연비 좋은 차", dimension: null, mention: 40, utter: 44, sent: [5, 2, 1] },
  { id: R2, type: "ConsumerRequirement", name: "넓은 트렁크 공간", dimension: null, mention: 25, utter: 25, sent: [2, 0, 2] },
  { id: R3, type: "ConsumerRequirement", name: "가격 할인 혜택", dimension: null, mention: 15, utter: 15, sent: [0, 3, 0] },
  { id: R4, type: "ConsumerRequirement", name: "조용한 실내", dimension: null, mention: 5, utter: 5, sent: [0, 0, 1] },
];
// What the backend sends for these rows (the ported theme map and name rule).
const THEME: Record<string, string> = { lifestage: "생애주기", usecase: "사용 목적" };
const CATEGORY: Record<string, string> = { [R1]: "연비·동력", [R2]: "공간·적재", [R3]: "가격·비용", [R4]: "기타" };
const DRIVES = [
  { ctx: C1, req: R1, co: 9 },
  { ctx: C1, req: R2, co: 3 },
  { ctx: C2, req: R1, co: 5 },
];
const COMBOS = [
  { a: R1, b: R2, co: 10 },
  { a: R1, b: R3, co: 6 },
  { a: R2, b: R4, co: 2 },
];
const EVIDENCE = [
  { id: u(0x501), entity: C1, quote: "애들 태우기 좋아요", host: "cafe.test", url: "https://cafe.test/1", sentiment: "positive" },
  { id: u(0x502), entity: C1, quote: "좁아요", host: null, url: null, sentiment: "negative" },
  { id: u(0x503), entity: R1, quote: "연비가 중요", host: "blog.test", url: "https://blog.test/2", sentiment: null },
];
const DOMAINS = [
  { entity: C1, host: "cafe.test", n: 5 },
  { entity: C1, host: "blog.test", n: 2 },
  { entity: R1, host: "blog.test", n: 1 },
];

interface Gen {
  apiId: string;
  seedId: string;
  question: string;
  layer: "L1-context" | "L2-condition" | "L3-intersection";
  funnel: "awareness" | "consideration" | "purchase";
  label: string;
  priority: number;
  origin?: "composed";
  removed?: boolean;
}
const GENERATED: Gen[] = [
  { apiId: u(0x601), seedId: `l1-${C1}`, question: "가족용 SUV 추천해줘", layer: "L1-context", funnel: "consideration", label: "아이 둘 가족", priority: 90 },
  { apiId: u(0x602), seedId: `l2-${R1}`, question: "연비 좋은 SUV는?", layer: "L2-condition", funnel: "awareness", label: "연비 좋은 차", priority: 80 },
  { apiId: u(0x603), seedId: `l3-${R1}:${R2}`, question: "연비와 트렁크 둘 다?", layer: "L3-intersection", funnel: "purchase", label: "연비 좋은 차 × 넓은 트렁크 공간", priority: 70, origin: "composed" },
  { apiId: u(0x604), seedId: `l1-${C2}`, question: "캠핑용 차", layer: "L1-context", funnel: "awareness", label: "주말 캠핑", priority: 60, removed: true },
];

// Keyword facts (what DataForSEO answers for KR: location 2410, language ko).
interface Kw {
  months: { year: number; month: number; v: number }[];
  serp: { type: string; rank: number; title: string | null; description: string | null; url: string }[];
  seed: { v: number; intent: string } | null;
  suggestions: { kw: string; v: number | null; intent: string | null }[];
  total: number;
}
const KEYWORDS: Record<string, Kw> = {
  suv: {
    months: Array.from({ length: 12 }, (_, i) => ({ year: i < 2 ? 2024 : 2025, month: ((10 + i) % 12) + 1, v: (i + 1) * 100 })),
    serp: [
      { type: "people_also_ask", rank: 0, title: "PAA", description: null, url: "https://paa.test" },
      ...Array.from({ length: 10 }, (_, i) => ({
        type: "organic",
        rank: i + 1,
        title: i === 2 ? null : `T${i + 1}`,
        description: i === 2 ? null : `S${i + 1}`,
        url: `https://www.site${i + 1}.test/p`,
      })),
    ],
    seed: { v: 5000, intent: "commercial" },
    suggestions: [
      { kw: "suv price", v: 900, intent: "commercial" },
      { kw: "best suv", v: 2400, intent: "informational" },
      { kw: "suv lease", v: null, intent: null },
      { kw: "small suv", v: 1300, intent: "transactional" },
      { kw: "suv vs crossover", v: 900, intent: "bogus" },
    ],
    total: 321,
  },
  sedan: { months: [], serp: [], seed: null, suggestions: [], total: 0 },
};
const qInput = (term: string, title: string | null, snippet: string | null) => `[${term}]-${title ?? ""} - ${snippet ?? ""}`.slice(0, 400);

// ── legacy side: PGlite + DataForSEO stub ───────────────────────────────────

const DDL = `
CREATE TABLE projects (id uuid PRIMARY KEY, name text NOT NULL, description text, domain text, brand text, country text NOT NULL,
  language text, scope_project_id uuid, ga4_property_id text, ai_engines text[], created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE project_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, user_id uuid NOT NULL,
  role text NOT NULL, status text NOT NULL, invited_by uuid NOT NULL, invited_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz,
  UNIQUE (project_id, user_id));
CREATE TABLE tracked_keywords (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, term text NOT NULL, country text,
  created_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT tracked_keywords_project_term_unique UNIQUE (project_id, term));
CREATE TABLE prompt_candidates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, source text NOT NULL,
  source_keyword text, text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE prompts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, candidate_id uuid, text text NOT NULL,
  prompt_type text, category text, brand text, brand_presence text, list_type text, depth1 text, depth2 text, depth3 text, depth4 text,
  funnel_stage text, kind text NOT NULL DEFAULT 'single', lang text, regions text[], scope_prompt_id uuid, status text NOT NULL DEFAULT 'draft',
  needs_reanalysis boolean NOT NULL DEFAULT false, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, deleted_at timestamptz);
CREATE TABLE scope_context_entities (id uuid PRIMARY KEY, type text NOT NULL, canonical_name text NOT NULL, dimension text,
  mention_count int NOT NULL DEFAULT 0, utterance_count int NOT NULL DEFAULT 0, sentiment_positive int NOT NULL DEFAULT 0,
  sentiment_negative int NOT NULL DEFAULT 0, sentiment_neutral int NOT NULL DEFAULT 0);
CREATE TABLE scope_context_drives (context_id uuid NOT NULL, requirement_id uuid NOT NULL, co_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (context_id, requirement_id));
CREATE TABLE scope_context_combinations (cond_a uuid NOT NULL, cond_b uuid NOT NULL, co_count int NOT NULL DEFAULT 0, PRIMARY KEY (cond_a, cond_b));
CREATE TABLE scope_context_evidence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_id uuid NOT NULL, utterance_id uuid NOT NULL,
  quote text NOT NULL, source_host text, source_url text, sentiment text);
CREATE TABLE scope_context_domains (entity_id uuid NOT NULL, host text NOT NULL, n int NOT NULL DEFAULT 0, PRIMARY KEY (entity_id, host));
CREATE TABLE scope_context_prompt_cache (project_id uuid PRIMARY KEY, prompts jsonb NOT NULL DEFAULT '[]'::jsonb, model text,
  generated_at timestamptz NOT NULL DEFAULT now(), version int NOT NULL DEFAULT 0);
`;
const TABLES = [
  "projects", "project_members", "tracked_keywords", "prompt_candidates", "prompts", "scope_context_entities", "scope_context_drives",
  "scope_context_combinations", "scope_context_evidence", "scope_context_domains", "scope_context_prompt_cache",
];

interface Pg {
  exec(sql: string): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  close(): Promise<void>;
}
let pg: Pg;

async function seedLegacy(): Promise<void> {
  await pg.exec(`TRUNCATE ${TABLES.join(", ")}`);
  await pg.query(`INSERT INTO projects (id, name, brand, country, created_by) VALUES ($1, 'Kia KR', 'Kia', 'KR', $2)`, [PID, ADMIN]);
  for (const m of MEMBERS) {
    await pg.query(`INSERT INTO project_members (project_id, user_id, role, status, invited_by) VALUES ($1, $2, $3, $4, $5)`, [
      PID, m.userId, m.role, m.status, ADMIN,
    ]);
  }
  for (const k of TRACKED) {
    await pg.query(`INSERT INTO tracked_keywords (id, project_id, term, country, created_at) VALUES ($1, $2, $3, $4, $5)`, [
      k.id, PID, k.term, k.country, k.createdAt,
    ]);
  }
  for (const c of CANDIDATES) {
    await pg.query(`INSERT INTO prompt_candidates (id, project_id, source, text, created_at) VALUES ($1, $2, $3, $4, $5)`, [
      c.id, PID, c.source, c.text, c.createdAt,
    ]);
  }
  for (const text of REGISTERED) {
    await pg.query(`INSERT INTO prompts (project_id, text, created_by) VALUES ($1, $2, $3)`, [PID, text, ADMIN]);
  }
  for (const e of ENTITIES) {
    await pg.query(
      `INSERT INTO scope_context_entities (id, type, canonical_name, dimension, mention_count, utterance_count, sentiment_positive,
        sentiment_negative, sentiment_neutral) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [e.id, e.type, e.name, e.dimension, e.mention, e.utter, ...e.sent],
    );
  }
  for (const d of DRIVES) await pg.query(`INSERT INTO scope_context_drives VALUES ($1, $2, $3)`, [d.ctx, d.req, d.co]);
  for (const c of COMBOS) await pg.query(`INSERT INTO scope_context_combinations VALUES ($1, $2, $3)`, [c.a, c.b, c.co]);
  for (const e of EVIDENCE) {
    await pg.query(`INSERT INTO scope_context_evidence VALUES ($1, $2, $1, $3, $4, $5, $6)`, [e.id, e.entity, e.quote, e.host, e.url, e.sentiment]);
  }
  for (const d of DOMAINS) await pg.query(`INSERT INTO scope_context_domains VALUES ($1, $2, $3)`, [d.entity, d.host, d.n]);
  const blob = GENERATED.map((g) => ({
    id: g.seedId,
    question: g.question,
    layer: g.layer,
    funnelStage: g.funnel,
    sourceLabel: g.label,
    priority: g.priority,
    ...(g.origin ? { origin: g.origin } : {}),
    ...(g.removed ? { removed: true } : {}),
  }));
  await pg.query(`INSERT INTO scope_context_prompt_cache (project_id, prompts, model, version) VALUES ($1, $2, 'm', 1)`, [
    PID, JSON.stringify(blob),
  ]);
}

let dataforseoCalls = 0;
async function dataforseo(url: string, init?: RequestInit): Promise<Response> {
  dataforseoCalls += 1;
  const body = JSON.parse(String(init?.body ?? "[]"))[0] as Record<string, unknown>;
  const task = (result: unknown) =>
    Response.json({ status_code: 20000, status_message: "Ok.", tasks: [{ status_code: 20000, status_message: "Ok.", result }] });
  if (url.includes("search_volume")) {
    const kws = body.keywords as string[];
    return task(
      kws.flatMap((k) => {
        const w = KEYWORDS[k];
        if (!w || w.months.length === 0) return [];
        // newest first, as DataForSEO answers
        const monthly = [...w.months].reverse().map((m) => ({ year: m.year, month: m.month, search_volume: m.v }));
        return [{ keyword: k, search_volume: w.seed?.v ?? 0, competition: "LOW", competition_index: 1, cpc: 0, monthly_searches: monthly }];
      }),
    );
  }
  const w = KEYWORDS[String(body.keyword)];
  if (url.includes("serp/google/organic")) {
    return task([{ items: (w?.serp ?? []).map((s) => ({ type: s.type, rank_group: s.rank, title: s.title, description: s.description, url: s.url })) }]);
  }
  if (url.includes("keyword_suggestions")) {
    const rows = (w?.suggestions ?? []).map((s) => ({
      keyword: s.kw,
      keyword_info: { search_volume: s.v },
      search_intent_info: { main_intent: s.intent },
    }));
    const withSeed = body.include_seed_keyword && w?.seed
      ? [{ keyword: String(body.keyword), keyword_info: { search_volume: w.seed.v }, search_intent_info: { main_intent: w.seed.intent } }, ...rows]
      : rows;
    return task([{ total_count: w ? w.total : 0, items: withSeed }]);
  }
  throw new Error(`unrouted DataForSEO ${url}`);
}

// ── api side: backend model ─────────────────────────────────────────────────

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const unb64 = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString()) as { o: number; k: string };
const ok = (data: unknown, meta: Record<string, unknown> = {}, status = 200) =>
  Response.json({ data, meta: { mode: "crud", ignored_filters: [], dropped_filters: {}, suppressed: {}, cycles: [], ...meta } }, { status });
const fail = (status: number, code: string) => Response.json({ error: { code, message: code, details: null } }, { status });
const ratio = (n: number, d: number) => ({ num: n, den: d });
const sentimentOf = (e: Entity) => {
  const d = e.sent[0] + e.sent[1] + e.sent[2];
  return { positive: ratio(e.sent[0], d), negative: ratio(e.sent[1], d), neutral: ratio(e.sent[2], d) };
};
const bucket = (v: number, mx: number) => (mx <= 0 ? "low" : v / mx >= 0.66 ? "high" : v / mx >= 0.33 ? "medium" : "low");

class BackendModel {
  tracked = TRACKED.map((k) => ({ ...k }));
  candidates = CANDIDATES.map((c) => ({ ...c }));
  generated = GENERATED.map((g) => ({ ...g }));
  collected = new Set<string>();
  drafts = new Map<string, Map<number, string>>();
  changes = new Map<number, { terms: string[]; polled: number }>();
  nextChange = 100;
  nextId = 0x900;
  calls: string[] = [];

  private canOperate(): boolean {
    const p = st.user!;
    if (p.role === "admin" || p.operator === "global") return true;
    return p.operator === "assigned" && MEMBERS.some((m) => m.userId === p.id && m.status === "active");
  }

  private insightOf(term: string, limit: number) {
    const w = KEYWORDS[term];
    const base = { term, country: "kr", location_code: 2410, language_code: "ko", trend: [] as unknown[], serp_call_id: null as number | null, serp: [] as unknown[] };
    if (!this.collected.has(term) || !w) return { data: base, fresh: false };
    const drafts = this.drafts.get(term) ?? new Map<number, string>();
    base.trend = w.months.map((m) => ({ month: `${m.year}-${String(m.month).padStart(2, "0")}-01`, search_volume: m.v, competition_index: 1, cpc: 0 }));
    const organic = w.serp.filter((s) => s.type === "organic").sort((a, b) => a.rank - b.rank);
    base.serp = organic.slice(0, limit).map((s) => ({
      rank: s.rank, url: s.url, domain: null, title: s.title, snippet: s.description, suggested_prompt: drafts.get(s.rank) ?? null,
      draft_model: null, draft_gen: drafts.has(s.rank) ? 1 : null,
    }));
    base.serp_call_id = organic.length ? 11 : null;
    return { data: base, fresh: organic.length > 0 || base.trend.length > 0 };
  }

  private relatedItems(w: Kw) {
    return w.suggestions.map((s) => ({ term: s.kw, search_volume: s.v, intent: s.intent }));
  }

  private entityPage(type: Entity["type"], q: URLSearchParams) {
    const search = q.get("search")?.toLowerCase();
    const sort = q.get("sort") === "name" ? "name" : "mentions";
    const dir = q.get("dir") === "asc" ? 1 : -1;
    const limit = Number(q.get("limit") ?? 50);
    const key = `${type}|${search ?? ""}|${sort}|${dir}`;
    const rows = ENTITIES.filter((e) => e.type === type && (!search || e.name.toLowerCase().includes(search))).sort(
      (a, b) =>
        dir * (sort === "name" ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.mention - b.mention) ||
        dir * (a.id < b.id ? -1 : 1),
    );
    const c = q.get("cursor");
    let o = 0;
    if (c) {
      const cur = unb64(c);
      if (cur.k !== key) return { error: fail(422, "cursor_invalid") };
      o = cur.o;
    }
    const page = rows.slice(o, o + limit);
    const next = o + limit < rows.length ? b64({ o: o + limit, k: key }) : null;
    return { page, meta: { mode: "catalog", page: { limit, next_cursor: next, total: rows.length } } };
  }

  private linked(e: Entity) {
    const rows = DRIVES.filter((d) => (e.type === "ConsumerContext" ? d.ctx === e.id : d.req === e.id))
      .map((d) => ({ id: e.type === "ConsumerContext" ? d.req : d.ctx, co: d.co }))
      .sort((a, b) => b.co - a.co);
    const mx = Math.max(1, ...rows.map((r) => r.co));
    return rows.map((r) => ({ id: r.id, name: ENTITIES.find((x) => x.id === r.id)!.name, co_count: r.co, strength: bucket(r.co, mx) }));
  }

  private promptModel(g: Gen) {
    const existing = [
      ...REGISTERED.map((text) => ({ text, kind: "prompt" as const })),
      ...this.candidates.map((c) => ({ text: c.text, kind: "candidate" as const })),
    ];
    const sim = annotateSimilar([{ id: g.apiId, question: g.question, layer: g.layer, funnelStage: g.funnel, sourceLabel: g.label, priority: g.priority }], existing)[0]
      .similarTo;
    return {
      prompt_id: g.apiId, seed_key: g.seedId, question: g.question, layer: g.layer, funnel_stage: g.funnel, source_label: g.label,
      priority: g.priority, origin: g.origin ?? null, batch_no: 1, model: "m", generated_at: "2026-09-05T00:00:00Z",
      similar_to: sim ? { text: sim.text, score: sim.score, kind: sim.kind } : null,
      in_candidate_pool: this.candidates.some((c) => c.text === g.question),
    };
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const q = url.searchParams;
    const path = url.pathname;
    const method = req.method;
    this.calls.push(`${method} ${path}`);
    const body = method === "GET" || method === "DELETE" ? null : ((await req.json()) as Record<string, unknown>);
    const operate = () => (this.canOperate() ? null : fail(403, "operator_forbidden"));

    if (method === "GET" && path === "/v1/intent/keywords") {
      return ok({ items: this.tracked.map((k) => ({ keyword_id: k.id, term: k.term, country_code: k.country, country: "kr", created_at: k.createdAt, latest_month: null, latest_volume: null })) });
    }
    if (method === "POST" && path === "/v1/intent/keywords") {
      const denied = operate();
      if (denied) return denied;
      // One row rule for the single body and each row of an items[] body (checked after the rows before it).
      const addOne = (raw: unknown) => {
        const term = String(raw).trim();
        const e = (status: number, code: string) => ({ status, data: null, error: { code, message: code, details: null } });
        if (!term) return e(422, "unprocessable");
        if (this.tracked.some((k) => k.term.toLowerCase() === term.toLowerCase())) return e(409, "duplicate_keyword");
        const id = u((this.nextId += 1));
        this.tracked.push({ id, term, country: null, createdAt: "2026-09-29T00:00:00.000Z" });
        const data = { keyword_id: id, term, country_code: null, country: "kr", created_at: "2026-09-29T00:00:00Z", latest_month: null, latest_volume: null };
        return { status: 201, data, error: null };
      };
      if (Array.isArray(body!.items)) return ok({ items: (body!.items as { term: string }[]).map((it) => addOne(it.term)) });
      const r = addOne(body!.term);
      return r.data ? ok(r.data, {}, 201) : fail(r.status, r.error!.code);
    }
    if (method === "DELETE" && path === "/v1/intent/keywords") {
      const denied = operate();
      if (denied) return denied;
      const ids = new Set(q.getAll("ids"));
      const before = this.tracked.length;
      this.tracked = this.tracked.filter((k) => !ids.has(k.id));
      return ok({ removed_count: before - this.tracked.length });
    }
    if (method === "POST" && path === "/v1/intent/candidates") {
      const denied = operate();
      if (denied) return denied;
      const items = (body!.items as { text: string; source_keyword: string | null }[]).map((i) => i.text.trim()).filter(Boolean);
      if (items.length === 0) return fail(422, "unprocessable");
      const ids: string[] = [];
      for (const text of items) {
        if (this.candidates.some((c) => c.text === text)) continue;
        const id = u((this.nextId += 1));
        this.candidates.push({ id, text, source: String(body!.source), createdAt: "2026-09-29T00:00:00.000Z" });
        ids.push(id);
      }
      return ok({ added_count: ids.length, skipped_count: (body!.items as unknown[]).length - ids.length, candidate_ids: ids }, {}, 201);
    }
    if (method === "GET" && path === `/v1/projects/${PID}/prompt-candidates`) {
      const items = [...this.candidates].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return ok({ items: items.map((c) => ({ candidate_id: c.id, text: c.text, source: c.source, source_keyword: null, created_at: c.createdAt })) }, {
        page: { limit: 500, next_cursor: null, total: items.length },
      });
    }
    if (method === "GET" && path === "/v1/intent/social/prompts") {
      return ok({ items: this.generated.filter((g) => !g.removed).sort((a, b) => b.priority - a.priority).map((g) => this.promptModel(g)) });
    }
    if (method === "DELETE" && path === "/v1/intent/social/prompts") {
      const denied = operate();
      if (denied) return denied;
      const ids = new Set(q.getAll("ids"));
      let n = 0;
      for (const g of this.generated) {
        if (ids.has(g.apiId) && !g.removed) {
          g.removed = true;
          n += 1;
        }
      }
      return ok({ removed_count: n });
    }
    // context map
    if (method === "GET" && path === "/v1/intent/social/context-map/stats") {
      return ok(
        {
          contexts: ENTITIES.filter((e) => e.type === "ConsumerContext").length,
          conditions: ENTITIES.filter((e) => e.type === "ConsumerRequirement").length,
          drives: DRIVES.length,
          combinations: COMBOS.length,
          relationships: DRIVES.length + COMBOS.length,
          sources: new Set(DOMAINS.map((d) => d.host)).size,
        },
        { mode: "catalog" },
      );
    }
    if (method === "GET" && (path.endsWith("/context-map/contexts") || path.endsWith("/context-map/conditions"))) {
      const type = path.endsWith("contexts") ? "ConsumerContext" : "ConsumerRequirement";
      const r = this.entityPage(type, q);
      if ("error" in r) return r.error!;
      const items = r.page.map((e) => {
        const linked = DRIVES.filter((d) => (type === "ConsumerContext" ? d.ctx === e.id : d.req === e.id)).length;
        const common = { id: e.id, name: e.name, mention_count: e.mention, utterance_count: e.utter, sentiment: sentimentOf(e), linked_count: linked };
        return type === "ConsumerContext"
          ? { ...common, theme_id: e.dimension ?? "기타", theme_name: THEME[e.dimension ?? ""] ?? "기타" }
          : { ...common, category: CATEGORY[e.id] };
      });
      return ok({ items }, r.meta);
    }
    if (method === "GET" && path.endsWith("/context-map/combinations")) {
      const search = q.get("search")?.toLowerCase();
      const dir = q.get("dir") === "asc" ? 1 : -1;
      const limit = Number(q.get("limit") ?? 50);
      const name = (id: string) => ENTITIES.find((e) => e.id === id)!.name;
      const key = `combo|${search ?? ""}|${dir}`;
      const rows = COMBOS.filter((c) => !search || name(c.a).toLowerCase().includes(search) || name(c.b).toLowerCase().includes(search)).sort(
        (a, b) => dir * (a.co - b.co),
      );
      const c = q.get("cursor");
      const o = c ? unb64(c).o : 0;
      const mx = Math.max(0, ...COMBOS.map((x) => x.co));
      const page = rows.slice(o, o + limit);
      return ok(
        {
          items: page.map((x) => ({ id: `${x.a}:${x.b}`, cond_a_id: x.a, cond_a_name: name(x.a), cond_b_id: x.b, cond_b_name: name(x.b), co_count: x.co, frequency: bucket(x.co, mx) })),
          max_co_count: mx,
        },
        { mode: "catalog", page: { limit, next_cursor: o + limit < rows.length ? b64({ o: o + limit, k: key }) : null, total: rows.length } },
      );
    }
    const detail = /^\/v1\/intent\/social\/context-map\/entities\/(.+)$/.exec(path);
    if (method === "GET" && detail) {
      const e = ENTITIES.find((x) => x.id === detail[1]);
      if (!e) return fail(404, "not_found");
      return ok(
        {
          id: e.id, name: e.name, type: e.type, mention_count: e.mention, utterance_count: e.utter, sentiment: sentimentOf(e),
          evidence: EVIDENCE.filter((x) => x.entity === e.id).map((x) => ({ quote: x.quote, source_host: x.host, source_url: x.url, sentiment: x.sentiment })),
          source_domains: DOMAINS.filter((d) => d.entity === e.id).sort((a, b) => b.n - a.n).map((d) => ({ host: d.host, count: d.n })),
          linked: this.linked(e),
        },
        { mode: "catalog" },
      );
    }
    if (method === "GET" && path === "/v1/intent/social/context-map/export") {
      return new Response("xlsx-bytes", {
        status: 200,
        headers: {
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": `attachment; filename="context-map-20260929.xlsx"; filename*=UTF-8''${q.get("lang") === "en" ? "context-map" : "%EA%B5%AC%EB%A7%A4"}-20260929.xlsx`,
          "set-cookie": "planted=1",
        },
      });
    }
    // keywords
    if (method === "GET" && path === "/v1/intent/insight") {
      const { data, fresh } = this.insightOf(String(q.get("term")), Number(q.get("limit") ?? 8));
      return ok(data, { mode: "external", source: { freshness: fresh ? "fresh" : "missing" } });
    }
    if (method === "GET" && path === "/v1/intent/related") {
      const term = String(q.get("term"));
      const w = KEYWORDS[term];
      if (!this.collected.has(term) || !w || w.suggestions.length === 0) {
        return ok({ term, country: "kr", found_count: 0, total_count: null, items: [] }, { mode: "external", source: { freshness: "missing" } });
      }
      const items = this.relatedItems(w);
      return ok({ term, country: "kr", found_count: items.length, total_count: w.total, items }, { mode: "external", source: { freshness: "fresh" } });
    }
    if (method === "GET" && path === "/v1/intent/lookup") {
      const items = q.getAll("terms").map((t) => {
        const w = KEYWORDS[t];
        if (!this.collected.has(t) || !w || !w.seed) return { term: t, status: "missing", search_volume: null, intent: null, related: [], total_count: null };
        return { term: t, status: "found", search_volume: w.seed.v, intent: w.seed.intent, related: this.relatedItems(w), total_count: w.total };
      });
      const found = items.filter((i) => i.status === "found").length;
      return ok({ country: "kr", items }, { mode: "external", source: { freshness: found ? "fresh" : "missing" } });
    }
    if (method === "POST" && path === "/v1/intent/fetches") {
      const denied = operate();
      if (denied) return denied;
      const terms = (body!.terms as string[]).filter((t) => body!.force || !this.collected.has(t));
      if (terms.length === 0) return ok({ status: "fresh", change_id: null, terms: [], fresh_terms: body!.terms });
      const id = (this.nextChange += 1);
      this.changes.set(id, { terms, polled: 0 });
      return ok({ status: "queued", change_id: id, terms, fresh_terms: [] }, {}, 202);
    }
    if (method === "GET" && path === "/v1/intent/fetches") {
      const ids = [...new Set(q.getAll("ids").map(Number))];
      if (ids.some((id) => !this.changes.has(id))) return fail(404, "not_found");
      const items = ids.map((id) => {
        const ch = this.changes.get(id)!;
        ch.polled += 1;
        const status = ch.polled >= 2 ? "applied" : "running";
        if (status === "applied") for (const t of ch.terms) this.collected.add(t);
        return { change_id: id, status, kind: null, country: "kr", terms: ch.terms, project_id: null, requested_at: "2026-09-29T00:00:00Z", claimed_at: null, applied_at: null, error: null };
      });
      return ok({ items });
    }
    const change = /^\/v1\/intent\/fetches\/(\d+)$/.exec(path);
    if (method === "GET" && change) {
      const ch = this.changes.get(Number(change[1]));
      if (!ch) return fail(404, "not_found");
      ch.polled += 1;
      const status = ch.polled >= 2 ? "applied" : "running";
      if (status === "applied") for (const t of ch.terms) this.collected.add(t);
      return ok({ change_id: Number(change[1]), status, kind: null, country: "kr", terms: ch.terms, project_id: null, requested_at: "2026-09-29T00:00:00Z", claimed_at: null, applied_at: null, error: null });
    }
    if (method === "POST" && path === "/v1/intent/serp-drafts") {
      const denied = operate();
      if (denied) return denied;
      const term = "suv";
      const w = KEYWORDS[term];
      const drafts = this.drafts.get(term) ?? new Map<number, string>();
      this.drafts.set(term, drafts);
      const organic = w.serp.filter((s) => s.type === "organic").sort((a, b) => a.rank - b.rank);
      const ranks = (body!.ranks as number[] | null) ?? organic.slice(0, 8).filter((s) => !drafts.has(s.rank)).map((s) => s.rank);
      const out = ranks.map((r) => {
        const s = organic.find((x) => x.rank === r)!;
        const prompt = llmQuestion(qInput(term, s.title, s.description));
        drafts.set(r, prompt);
        return { rank: r, prompt, gen: 1, model: "m", generated_at: "2026-09-29T00:00:00Z" };
      });
      return ok({ serp_call_id: body!.serp_call_id, drafts: out, skipped_count: 0 });
    }
    return fail(404, `model: no route ${method} ${path}`);
  }
}
let model: BackendModel;

// ── harness ─────────────────────────────────────────────────────────────────

type Source = "legacy" | "api";
function asSource(source: Source, who: keyof typeof USERS = "owner"): void {
  vi.stubEnv("HGH_SOURCE_G6", source);
  st.user = USERS[who];
}

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  pg = new PGlite() as unknown as Pg;
  await pg.exec(DDL);
  const real = drizzle(pg as never);
  // Production (drizzle postgres-js) returns rows from db.execute() as an array; pglite returns {rows}.
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

beforeEach(async () => {
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  vi.stubEnv("HGH_RELAY_SECRET", "");
  vi.stubEnv("HGH_SOURCE_SESSION", "legacy");
  vi.stubEnv("DATAFORSEO_LOGIN", "login");
  vi.stubEnv("DATAFORSEO_PASSWORD", "pw");
  await seedLegacy();
  model = new BackendModel();
  dataforseoCalls = 0;
  bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: async () => null });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.dataforseo.com/")) {
      if (process.env.HGH_SOURCE_G6 === "api") throw new Error("api source must not call DataForSEO");
      return dataforseo(url, init);
    }
    if (process.env.HGH_SOURCE_G6 !== "api") throw new Error(`legacy source must not call the backend: ${url}`);
    return model.handle(new Request(url, init));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  bindHghAuth(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── diffing ─────────────────────────────────────────────────────────────────

function diffPaths(a: unknown, b: unknown, path = ""): string[] {
  if (Object.is(a, b)) return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [path || "$"];
    return a.flatMap((x, i) => diffPaths(x, b[i], `${path}[${i}]`));
  }
  const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (plain(a) && plain(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diffPaths(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return [path || "$"];
}

/** Both sides, then the diff must be exactly the declared known differences. */
async function parity<T>(
  run: (source: Source) => Promise<T>,
  known: Record<string, string> = {},
): Promise<{ legacy: T; api: T }> {
  const legacy = await run("legacy");
  await seedLegacy();
  const api = await run("api");
  const diffs = diffPaths(legacy, api).sort();
  expect(diffs, JSON.stringify({ legacy, api }).slice(0, 4000)).toEqual(Object.keys(known).sort());
  return { legacy, api };
}

function findProps(node: ReactNode, type: unknown): Record<string, unknown> | null {
  if (!isValidElement(node)) {
    if (Array.isArray(node)) for (const n of node) { const r = findProps(n, type); if (r) return r; }
    return null;
  }
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.type === type) return el.props;
  return findProps(el.props.children as ReactNode, type);
}

const post = (path: string, body: unknown) =>
  new NextRequest(`http://front.test${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const get = (path: string) => new NextRequest(`http://front.test${path}`);
async function call(res: Response | Promise<Response>) {
  const r = await res;
  return { status: r.status, body: (await r.json()) as unknown };
}
const params = { params: Promise.resolve({ locale: "ko", id: PID }) };

// ── pages ───────────────────────────────────────────────────────────────────

describe("pages", () => {
  it("google-keyword: tracked keyword tabs, canEdit, project country", async () => {
    await parity(async (s) => {
      asSource(s, "owner");
      return findProps(await GoogleKeywordPage(params), GoogleKeywordView);
    });
    await parity(async (s) => {
      asSource(s, "viewer");
      return findProps(await GoogleKeywordPage(params), GoogleKeywordView);
    });
  });

  it("social-scraping: stats, first pages, generated prompts and their 이미 추가됨 marks (D6)", async () => {
    const { legacy, api } = await parity(
      async (s) => {
        asSource(s, "owner");
        const { addedTexts, generatedPrompts, ...props } = findProps(await SocialPage(params), SocialScrapingFlow)!;
        // The screen property is the catalog's mark per row (the same isAlreadyAdded the table calls): legacy hands over
        // the whole candidate pool (addedTexts), the API marks each row (inCandidatePool) instead of paging the pool.
        const added = new Set((addedTexts as string[] | undefined) ?? []);
        const rows = (generatedPrompts as GeneratedPrompt[] | undefined) ?? [];
        return {
          ...props,
          generatedPrompts: rows.map(({ inCandidatePool: _mark, ...p }) => p),
          addedMarks: rows.map((p) => isAlreadyAdded(added, p)),
        };
      },
      {
        // D5 / C3: the API pages carry their cursor (null: everything fits one page).
        "initialPages.contexts.nextCursor": "D5 cursor (api only)",
        "initialPages.conditions.nextCursor": "D5 cursor (api only)",
        "initialPages.combinations.nextCursor": "D5 cursor (api only)",
        // U10-N6: id = backend prompt_id instead of the seed id.
        "generatedPrompts[0].id": "U10-N6",
        "generatedPrompts[1].id": "U10-N6",
        "generatedPrompts[2].id": "U10-N6",
      },
    );
    expect((api.generatedPrompts as { id: string }[]).map((p) => p.id)).toEqual([u(0x601), u(0x602), u(0x603)]);
    expect((legacy.generatedPrompts as { similarTo: unknown }[])[0].similarTo).not.toBeNull();
    // Both a marked row (exactly a candidate text) and unmarked rows are covered.
    expect(api.addedMarks).toEqual([true, false, false]);
    expect(model.calls.slice(0, 4).sort()).toEqual([
      "GET /v1/intent/social/context-map/combinations",
      "GET /v1/intent/social/context-map/conditions",
      "GET /v1/intent/social/context-map/contexts",
      "GET /v1/intent/social/context-map/stats",
    ]);
    // The candidate pool is no longer paged through for the marks.
    expect(model.calls.slice(4)).toEqual([`GET /v1/intent/social/prompts`]);
  });

  it("customer-interest google keywords: managed standard keywords replace the sample (U10-N10)", async () => {
    asSource("legacy", "admin");
    const legacy = findProps(await StandardKeywordsPage({ params: Promise.resolve({ locale: "ko" }) }), GoogleKeywordView)!;
    expect((legacy.initialKeywords as { label: string }[]).map((k) => k.label)).toEqual([...DEFAULT_KEYWORD_TERMS]);
    asSource("api", "admin");
    model.handle = async (req) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/intent/standard-keywords");
      expect(url.searchParams.get("source_type")).toBe("google_keyword");
      return ok(
        { source_type: "google_keyword", items: [{ keyword_id: u(0x701), keyword_ids: [u(0x701)], term: "아이오닉 5", source_type: "google_keyword", brand_codes: [null], created_at: "x", updated_at: "x" }] },
        { mode: "catalog", page: { limit: 500, next_cursor: null, total: 1 } },
      );
    };
    const api = findProps(await StandardKeywordsPage({ params: Promise.resolve({ locale: "ko" }) }), GoogleKeywordView)!;
    expect(api.initialKeywords).toEqual([{ id: u(0x701), label: "아이오닉 5" }]);
    expect(diffPaths({ ...legacy, initialKeywords: null }, { ...api, initialKeywords: null })).toEqual([]);
  });
});

// ── context map route ───────────────────────────────────────────────────────

describe("/api/context-map", () => {
  it("contexts page 0 and page 1 (offset vs cursor), conditions by name, combinations search, details", async () => {
    let cursor: string | null = null;
    await parity(
      async (s) => {
        asSource(s);
        const p0 = await call(contextMapRoute.GET(get("/api/context-map?tab=contexts&sort=mentions&dir=desc&page=0&size=2")));
        if (s === "api") cursor = (p0.body as { paged: { nextCursor: string } }).paged.nextCursor;
        const p1 = await call(
          contextMapRoute.GET(get(`/api/context-map?tab=contexts&sort=mentions&dir=desc&page=1&size=2${s === "api" ? `&cursor=${cursor}` : ""}`)),
        );
        const cond = await call(contextMapRoute.GET(get(`/api/context-map?tab=conditions&sort=name&dir=asc&page=0&size=50&search=${encodeURIComponent("차")}`)));
        const combo = await call(contextMapRoute.GET(get(`/api/context-map?tab=combinations&dir=desc&page=0&size=50&search=${encodeURIComponent("트렁크")}`)));
        const d1 = await call(contextMapRoute.GET(get(`/api/context-map?tab=detail&id=${C1}`)));
        const d2 = await call(contextMapRoute.GET(get(`/api/context-map?tab=detail&id=${R1}`)));
        const d404 = await call(contextMapRoute.GET(get(`/api/context-map?tab=detail&id=${u(0x499)}`)));
        const bad = await call(contextMapRoute.GET(get(`/api/context-map?tab=nope`)));
        return { p0, p1, cond, combo, d1, d2, d404, bad };
      },
      {
        "p0.body.paged.nextCursor": "D5 cursor (api only)",
        "p1.body.paged.nextCursor": "D5 cursor (api only)",
        "cond.body.paged.nextCursor": "D5 cursor (api only)",
        "combo.body.paged.nextCursor": "D5 cursor (api only)",
      },
    );
    expect(cursor).toBeTruthy();
  });

  it("place gate on both sources (U10-N12, verification D3): website role 403, no mirror or backend read", async () => {
    const { legacy } = await parity(async (s) => {
      asSource(s, "website");
      return call(contextMapRoute.GET(get("/api/context-map?tab=contexts")));
    });
    expect(legacy).toEqual({ status: 403, body: { error: "forbidden" } });
    expect(model.calls).toEqual([]);
  });

  it("export: api streams the backend file (lang from body), drops upstream cookies; no session 401 on both", async () => {
    asSource("api");
    const res = await exportRoute.POST(post("/api/context-map/export", { labels: {}, filename: "x.xlsx", lang: "en" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("xlsx-bytes");
    expect(res.headers.get("content-type")).toContain("spreadsheetml");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("set-cookie")).toBeNull();
    await parity(async (s) => {
      asSource(s);
      st.user = null;
      return call(exportRoute.POST(post("/api/context-map/export", {})));
    });
  });
});

// ── api error mapping (pages and routes) ────────────────────────────────────

describe("api error mapping", () => {
  const answer = (status: number, code: string) => {
    model.handle = async () => fail(status, code);
  };

  it("pages: 404 -> notFound, 403 role/menu -> /no-access, 401 -> /login, 5xx -> error boundary", async () => {
    asSource("api", "owner");
    answer(404, "not_found");
    await expect(GoogleKeywordPage(params)).rejects.toThrow("NOT_FOUND");
    answer(403, "menu_forbidden");
    await expect(SocialPage(params)).rejects.toThrow("REDIRECT:/ko/no-access");
    answer(403, "operator_forbidden");
    await expect(SocialPage(params)).rejects.toThrow("NOT_FOUND");
    answer(401, "token_expired");
    await expect(StandardKeywordsPage({ params: Promise.resolve({ locale: "ko" }) })).rejects.toThrow("REDIRECT:/ko/login");
    answer(503, "unavailable");
    await expect(GoogleKeywordPage(params)).rejects.toMatchObject({ status: 503 });
  });

  it("routes: status kept with {error:{code}}; export 409 no_active_snapshot passed through (U10-N8)", async () => {
    asSource("api", "owner");
    answer(409, "no_active_snapshot");
    expect(await call(exportRoute.POST(post("/api/context-map/export", { lang: "ko" })))).toMatchObject({
      status: 409, body: { error: { code: "no_active_snapshot" } },
    });
    answer(502, "upstream");
    expect(await call(contextMapRoute.GET(get("/api/context-map?tab=conditions")))).toMatchObject({ status: 502, body: { error: { code: "upstream" } } });
    answer(422, "unprocessable");
    expect((await call(relatedRoute.POST(post("/api/keyword/related", { keyword: "suv", projectId: PID })))).status).toBe(422);
  });

  it("actions: 5xx -> tryAgain text, generation failure -> generateFailed text (ko = legacy wording)", async () => {
    asSource("api", "owner");
    answer(503, "unavailable");
    expect(await actions.removeTrackedKeywords(PID, [TRACKED[0].id])).toEqual({ ok: false, error: "잠시 후 다시 시도해주세요" });
    answer(502, "llm_failed");
    expect(await actions.generateMoreSocialPrompts(PID)).toEqual({ ok: false, error: "프롬프트 생성에 실패했습니다" });
    answer(409, "no_active_snapshot");
    expect(await actions.generateSelectedSocialPrompts(PID, { contextIds: [C1], conditionIds: [], combinations: [], cross: false })).toEqual({
      ok: false, error: "컨텍스트 맵이 준비 중입니다",
    });
  });
});

// ── keyword routes ──────────────────────────────────────────────────────────

describe("/api/keyword/*", () => {
  it("insight: stored after an operator's collection equals the live legacy answer (drafts included)", async () => {
    let legacyDfs = 0;
    const { api } = await parity(async (s) => {
      asSource(s, "owner");
      const out = await call(insightRoute.POST(post("/api/keyword/insight", { keyword: " suv ", country: "KR", projectId: PID })));
      if (s === "legacy") legacyDfs = dataforseoCalls;
      return out;
    });
    // Legacy really ran against DataForSEO (volume + SERP); the api side never does (fetch guard).
    expect(legacyDfs).toBe(2);
    expect((api.body as { insight: { serp: unknown[]; trend: unknown[] } }).insight.serp).toHaveLength(8);
    expect((api.body as { insight: { trend: unknown[] } }).insight.trend).toHaveLength(12);
    expect(model.calls).toEqual([
      "GET /v1/intent/insight",
      "POST /v1/intent/fetches",
      "GET /v1/intent/fetches",
      "GET /v1/intent/fetches",
      "GET /v1/intent/insight",
      "POST /v1/intent/serp-drafts",
    ]);
  });

  it("insight on the standard screen (no projectId) for admin; unknown country falls back to kr", async () => {
    await parity(async (s) => {
      asSource(s, "admin");
      return call(insightRoute.POST(post("/api/keyword/insight", { keyword: "suv", country: "zz" })));
    });
  });

  it("insight for a viewer who may not collect: stored data only (DC-15)", async () => {
    await parity(
      async (s) => {
        asSource(s, "viewer");
        return call(insightRoute.POST(post("/api/keyword/insight", { keyword: "suv", country: "KR", projectId: PID })));
      },
      { "body.insight.serp": "DC-15 never collected", "body.insight.trend": "DC-15 never collected" },
    );
  });

  it("related: foundCount = DataForSEO total_count (BG-39), legacy volume order", async () => {
    const { api } = await parity(async (s) => {
      asSource(s, "owner");
      return call(relatedRoute.POST(post("/api/keyword/related", { keyword: "suv", country: "KR", projectId: PID })));
    });
    expect((api.body as { foundCount: number }).foundCount).toBe(321);
  });

  it("search: several terms, duplicates and a term with no data", async () => {
    await parity(async (s) => {
      asSource(s, "owner");
      return call(searchRoute.POST(post("/api/keyword/search", { keywords: ["suv", " suv ", "sedan"], country: "KR", projectId: PID })));
    });
  });

  it("validation and gates: empty keyword 400 on both; api gates (U10-N12)", async () => {
    await parity(async (s) => {
      asSource(s, "owner");
      return call(insightRoute.POST(post("/api/keyword/insight", { keyword: "  " })));
    });
    asSource("api", "owner");
    expect(await call(insightRoute.POST(post("/api/keyword/insight", { keyword: "suv", projectId: "nope" })))).toEqual({
      status: 400, body: { error: "invalid projectId" },
    });
    asSource("api", "website");
    expect((await call(relatedRoute.POST(post("/api/keyword/related", { keyword: "suv" })))).status).toBe(403);
    asSource("api", "owner");
    expect((await call(searchRoute.POST(post("/api/keyword/search", { keywords: ["suv"], projectId: u(0x999) })))).status).toBe(404);
    expect(model.calls).toEqual([]);
    st.user = null;
    await parity(async (s) => {
      asSource(s);
      st.user = null;
      return call(relatedRoute.POST(post("/api/keyword/related", { keyword: "suv" })));
    });
  });
});

// ── place gates on both sources (verification D1 / D3) ─────────────────────

describe("place gates: 5 routes x both sources (U10-N12, verification D1 / D3)", () => {
  // Every case runs on HGH_SOURCE_G6=legacy AND api: the gate sits before the source switch, so
  // both answer the same status and body and neither reaches DataForSEO, the LLM, the context map
  // mirror or any backend path other than the project gate itself (GET /v1/projects/{id} on
  // HGH_SOURCE_SESSION=api). Dropping the gate from any one route fails its rows.
  const who = (id: number, role: Usr["role"], menuGroups: Usr["menuGroups"] = null): Usr => ({
    id: u(id), email: `${id}@x.test`, role, scope: { all: true }, operator: "global", menuGroups,
  });
  const P = {
    owner: USERS.owner,
    website: USERS.website,
    vendor: who(0xb1, "vendor"),
    noStandardMenu: who(0xb2, "hq", ["project"]),
    noProjectMenu: who(0xb3, "hq", ["standard"]),
    nonMember: who(0xb4, "country"),
    pending: who(0xb5, "hq"),
    removed: who(0xb6, "hq"),
  };
  type Route = "insight" | "related" | "search" | "contextMap" | "export";
  const KEYWORD: Route[] = ["insight", "related", "search"];
  const ALL: Route[] = [...KEYWORD, "contextMap", "export"];
  const hit = (r: Route, projectId?: unknown): Promise<Response> => {
    const pid = projectId === undefined ? {} : { projectId };
    if (r === "insight") return insightRoute.POST(post("/api/keyword/insight", { keyword: "suv", country: "KR", ...pid }));
    if (r === "related") return relatedRoute.POST(post("/api/keyword/related", { keyword: "suv", country: "KR", ...pid }));
    if (r === "search") return searchRoute.POST(post("/api/keyword/search", { keywords: ["suv"], country: "KR", ...pid }));
    if (r === "contextMap") return contextMapRoute.GET(get("/api/context-map?tab=contexts"));
    return exportRoute.POST(post("/api/context-map/export", { labels: {}, lang: "ko" }));
  };
  interface Case {
    name: string;
    routes: Route[];
    user: Usr | null;
    projectId?: unknown;
    session?: { answer: () => Response };
    status: number;
    body?: unknown;
  }
  const CASES: Case[] = [
    { name: "no session", routes: ALL, user: null, projectId: PID, status: 401 },
    { name: "website role, standard screen", routes: KEYWORD, user: P.website, status: 403, body: { error: "forbidden" } },
    { name: "website role, project", routes: KEYWORD, user: P.website, projectId: PID, status: 403, body: { error: "forbidden" } },
    { name: "website role, context map", routes: ["contextMap", "export"], user: P.website, status: 403, body: { error: "forbidden" } },
    { name: "menu without standard, standard screen", routes: KEYWORD, user: P.noStandardMenu, status: 403, body: { error: "forbidden" } },
    { name: "menu without project, project", routes: KEYWORD, user: P.noProjectMenu, projectId: PID, status: 403, body: { error: "forbidden" } },
    { name: "menu without project, context map", routes: ["contextMap", "export"], user: P.noProjectMenu, status: 403, body: { error: "forbidden" } },
    { name: "vendor on the standard route", routes: KEYWORD, user: P.vendor, status: 403, body: { error: "forbidden" } },
    { name: "non-member", routes: KEYWORD, user: P.nonMember, projectId: PID, status: 404, body: { error: "not found" } },
    { name: "pending member", routes: KEYWORD, user: P.pending, projectId: PID, status: 404, body: { error: "not found" } },
    { name: "removed member", routes: KEYWORD, user: P.removed, projectId: PID, status: 404, body: { error: "not found" } },
    { name: "demo project, not admin", routes: KEYWORD, user: P.owner, projectId: DEMO_PROJECT_ID, status: 404, body: { error: "not found" } },
    { name: "unknown project", routes: KEYWORD, user: P.owner, projectId: u(0x999), status: 404, body: { error: "not found" } },
    { name: "bad projectId", routes: KEYWORD, user: P.owner, projectId: "nope", status: 400, body: { error: "invalid projectId" } },
    {
      name: "SESSION=api, backend 404", routes: KEYWORD, user: P.owner, projectId: PID,
      session: { answer: () => fail(404, "not_found") }, status: 404, body: { error: "not found" },
    },
    {
      name: "SESSION=api, backend 403", routes: KEYWORD, user: P.owner, projectId: PID,
      session: { answer: () => fail(403, "scope_forbidden") }, status: 403, body: { error: { code: "scope_forbidden" } },
    },
  ];

  let backend: string[] = [];
  let dfs = 0;
  let mirrorReads = 0;
  beforeEach(async () => {
    await pg.query(`INSERT INTO project_members (project_id, user_id, role, status, invited_by) VALUES ($1, $2, 'viewer', 'pending', $3)`, [PID, P.pending.id, ADMIN]);
    await pg.query(`INSERT INTO project_members (project_id, user_id, role, status, invited_by) VALUES ($1, $2, 'viewer', 'active', $3)`, [PID, P.removed.id, ADMIN]);
    await pg.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [PID, P.removed.id]);
    backend = [];
    dfs = 0;
    mirrorReads = 0;
    for (const m of ["getStats", "listContexts", "listConditions", "listCombinations", "getEntityDetail", "listAllForExport"] as const) {
      vi.spyOn(scopeContextMapRepository, m).mockImplementation((async () => {
        mirrorReads += 1;
        throw new Error("the context map mirror must not be read");
      }) as never);
    }
  });

  for (const c of CASES) {
    for (const r of c.routes) {
      it(`${r}: ${c.name} -> ${c.status} on both sources, nothing called`, async () => {
        const out: Record<Source, { status: number; body: unknown }> = {} as never;
        for (const source of ["legacy", "api"] as const) {
          asSource(source);
          st.user = c.user;
          vi.stubEnv("HGH_SOURCE_SESSION", c.session ? "api" : "legacy");
          vi.stubGlobal("fetch", async (input: string | URL | Request) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.startsWith("https://api.dataforseo.com/")) {
              dfs += 1;
              throw new Error("DataForSEO must not be called");
            }
            const path = new URL(url).pathname;
            backend.push(path);
            if (c.session && path === `/v1/projects/${PID}`) return c.session.answer();
            throw new Error(`backend must not be called: ${path}`);
          });
          const res = await hit(r, c.projectId);
          const body = (await res.json()) as { error?: unknown };
          // the client-generated request id differs per call; the rest must match
          if (typeof body.error === "object" && body.error !== null) delete (body.error as { requestId?: unknown }).requestId;
          out[source] = { status: res.status, body };
        }
        expect(out.legacy.status).toBe(c.status);
        if (c.body !== undefined) expect(out.legacy.body).toMatchObject(c.body as object);
        expect(out.api).toEqual(out.legacy);
        expect(dfs).toBe(0);
        expect(mirrorReads).toBe(0);
        expect(backend).toEqual(c.session ? [`/v1/projects/${PID}`, `/v1/projects/${PID}`] : []);
      });
    }
  }

  // The positive row (U10 N1): admin is not a member of PID and passes the legacy leaf gate
  // (app/api/keyword/_lib/legacy-project-gate.ts) by role alone on HGH_SOURCE_SESSION=legacy; both
  // sources then answer 200 with the same body. Dropping the admin clause from that gate fails it.
  for (const r of KEYWORD) {
    it(`${r}: admin, not a member, project -> 200 on both sources (SESSION=legacy)`, async () => {
      expect(MEMBERS.some((m) => m.userId === USERS.admin.id)).toBe(false);
      const { legacy } = await parity(async (s) => {
        asSource(s, "admin");
        vi.stubEnv("HGH_SOURCE_SESSION", "legacy");
        return call(hit(r, PID));
      });
      expect(legacy.status).toBe(200);
      expect(mirrorReads).toBe(0);
    });
  }

  it(`search: more than MAX_SEARCH_TERMS (${MAX_SEARCH_TERMS}) unique terms -> 400 on both sources, nothing called (D2)`, async () => {
    const terms = Array.from({ length: MAX_SEARCH_TERMS + 1 }, (_, i) => `k${i}`);
    const { legacy } = await parity(async (s) => {
      asSource(s, "owner");
      return call(searchRoute.POST(post("/api/keyword/search", { keywords: terms, country: "KR", projectId: PID })));
    });
    expect(legacy).toEqual({ status: 400, body: { error: `at most ${MAX_SEARCH_TERMS} keywords` } });
    expect(dataforseoCalls).toBe(0);
    expect(model.calls).toEqual([]);
    // duplicates and blanks do not count toward the cap
    asSource("legacy", "owner");
    const dup = await call(searchRoute.POST(post("/api/keyword/search", { keywords: [...terms.slice(0, MAX_SEARCH_TERMS), " k0 ", ""], projectId: PID })));
    expect(dup.status).not.toBe(400);
  });
});

// ── server actions ──────────────────────────────────────────────────────────

describe("intent actions", () => {
  const tabsNow = async () => (findProps(await GoogleKeywordPage(params), GoogleKeywordView)!.initialKeywords as { label: string }[]).map((k) => k.label);

  const settle = async <T,>(f: () => Promise<T>): Promise<T | { threw: string }> => {
    try {
      return await f();
    } catch (e) {
      // A driver error wrapped by drizzle reads "Failed query: ..." (no "unique" in the message).
      if (e instanceof Error && e.message.startsWith("Failed query")) return { threw: "wrapped driver error" };
      return { threw: e instanceof Error ? e.name : String(e) };
    }
  };

  it("tracked keywords: add, duplicate, empty, remove unknown, remove many (same answers and resulting tabs)", async () => {
    const { legacy, api } = await parity(
      async (s) => {
        asSource(s, "owner");
        const added = await actions.addTrackedKeyword(PID, { term: "  아이오닉 5 ", country: "KR" });
        const dup = await settle(() => actions.addTrackedKeyword(PID, { term: "suv", country: null }));
        const empty = await actions.addTrackedKeyword(PID, { term: "   " });
        const none = await actions.removeTrackedKeyword(PID, u(0x2ff));
        const many = await actions.removeTrackedKeywords(PID, [TRACKED[0].id, TRACKED[1].id]);
        const nothing = await actions.removeTrackedKeywords(PID, []);
        return { added: added.ok, dup, empty, none, many, nothing, tabs: await tabsNow() };
      },
      // U10-N13: legacy throws on the duplicate (drizzle wraps the unique violation), api answers.
      { "dup.error": "U10-N13", "dup.ok": "U10-N13", "dup.threw": "U10-N13" },
    );
    expect(legacy.dup).toEqual({ threw: "wrapped driver error" });
    expect(api.dup).toEqual({ ok: false, error: "이미 추가된 키워드입니다" });
  });

  it("tracked keywords, several at once: one api request answers what the legacy single adds answered (same resulting tabs)", async () => {
    const inputs = [{ term: "  아이오닉 5 " }, { term: "   " }, { term: "EV9", country: "KR" }, { term: "캐스퍼" }];
    await parity(async (s) => {
      asSource(s, "owner");
      const results = [];
      if (s === "legacy") {
        for (const x of inputs) results.push(await actions.addTrackedKeyword(PID, x));
      } else {
        results.push(...(await apiAddTrackedKeywords(PID, inputs, await intentActionMessages())));
      }
      return { results: results.map((r) => (r.ok ? "ok" : r.error)), tabs: await tabsNow() };
    });
    expect(model.calls.filter((c) => c === "POST /v1/intent/keywords")).toHaveLength(1);
  });

  it("candidates: single add, empty, bulk with a duplicate and a blank", async () => {
    await parity(async (s) => {
      asSource(s, "owner");
      const one = await actions.addCandidate(PID, "google_keyword", "새 프롬프트", "suv");
      const empty = await actions.addCandidate(PID, "google_keyword", "  ", null);
      const bad = await actions.addCandidate(PID, "manual", "x", null);
      const bulk = await actions.addCandidates(PID, "social_scraping", [
        { text: CANDIDATES[0].text },
        { text: "완전히 새 질문", sourceKeyword: "ctx" },
        { text: "  " },
      ]);
      return { one: one.ok, empty, bad, bulk };
    });
  });

  it("remove generated prompts: count, then not found; no ids", async () => {
    await parity(async (s) => {
      asSource(s, "owner");
      const id = s === "api" ? GENERATED[1].apiId : GENERATED[1].seedId;
      const first = await actions.removeSocialPrompts(PID, [id]);
      const again = await actions.removeSocialPrompts(PID, [id]);
      const none = await actions.removeSocialPrompts(PID, []);
      return { first, again, none };
    });
  });

  it("no operator authority: every write throws UnauthorizedError on both sources", async () => {
    await parity(async (s) => {
      asSource(s, "viewer");
      const out: string[] = [];
      const writes = [
        () => actions.addTrackedKeyword(PID, { term: "x" }),
        () => actions.removeTrackedKeywords(PID, [TRACKED[0].id]),
        () => actions.addCandidate(PID, "google_keyword", "x", null),
        () => actions.addCandidates(PID, "social_scraping", [{ text: "x" }]),
        () => actions.removeSocialPrompts(PID, [s === "api" ? GENERATED[0].apiId : GENERATED[0].seedId]),
      ];
      for (const w of writes) {
        try {
          await w();
          out.push("no throw");
        } catch (e) {
          out.push(e instanceof UnauthorizedError ? "UnauthorizedError" : String(e));
        }
      }
      return out;
    });
  });
});
