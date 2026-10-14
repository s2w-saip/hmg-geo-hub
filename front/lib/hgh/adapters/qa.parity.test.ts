import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";

// Legacy <-> API parity for the Raw Data QA console (unit U12).
//
// Method. One neutral fixture WORLD (sessions, answers with their granules, reviews, notes, a
// lock) is written twice, each in its own native form:
//   legacy: rows in the mirror tables on PGlite (real PostgreSQL), read by the UNCHANGED legacy
//           repository (lib/db/repositories/qa-review.ts, real SQL: surface CTE, filters, keyset
//           cursor, locks) through the unchanged legacy page and route bodies;
//   api:    a backend model answering /v1/qa/* in the OpenAPI shapes from the same WORLD, with its
//           own implementation of the documented backend semantics (filters, keyset, lock upsert,
//           author rule), read through lib/hgh/adapters/qa.ts via the same pages and routes.
// Both sides go through the real page (JSX props handed to the screen components) or the real
// route handler (status + JSON body). The outputs are diffed field by field and the set of
// differing paths must equal the declared KNOWN_DIFF of that case, each with its reason: an
// unexpected difference fails, and so does a declared one that disappears.
//
// Not covered here (by design): whether the migrated database holds the same rows. The seed
// migration does not carry qa_answer_reviews / qa_review_notes; they move separately with
// back/migration/migrate-qa.sql and are checked by verify-qa.sql (tests/core/test_migrate_qa.py).

const st = vi.hoisted(() => ({
  db: null as unknown,
  cookies: new Map<string, string>(),
  headers: new Headers(),
}));

vi.mock("@/lib/db", () => ({ getDb: () => st.db }));
vi.mock("@/lib/db/repositories/standards", () => ({
  STANDARD_ROOT_PROJECT_ID: "00000000-0000-4000-8000-00000000a000",
}));
// Run visibility (hidden bulk-mirror runs) is outside the QA semantics compared here.
vi.mock("@/lib/db/repositories/scope-mirror-progress-read", async () => {
  const { sql } = await import("drizzle-orm");
  return { bulkMirrorRunVisibleSql: async () => sql`true` };
});
vi.mock("next/cache", () => ({
  unstable_cache: <F>(fn: F) => fn,
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (st.cookies.has(n) ? { name: n, value: st.cookies.get(n)! } : undefined),
    getAll: () => [...st.cookies].map(([name, value]) => ({ name, value })),
    delete: () => {
      throw new Error("read-only cookies");
    },
  }),
  headers: async () => st.headers,
}));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (k: string) => k,
}));

const ROOT = "00000000-0000-4000-8000-00000000a000";
const { signReviewerCookie } = await import("@/lib/qa/auth");
const { __resetRateLimit } = await import("@/lib/qa/rate-limit");
const sessionRoute = await import("@/app/api/qa/session/route");
const lockRoute = await import("@/app/api/qa/lock/route");
const reviewRoute = await import("@/app/api/qa/review/route");
const noteRoute = await import("@/app/api/qa/note/route");
const answersRoute = await import("@/app/api/qa/answers/route");
const exportRoute = await import("@/app/api/qa/notes/export/route");
const QaLayout = (await import("@/app/[locale]/raw-data-qa/layout")).default;
const GatePage = (await import("@/app/[locale]/raw-data-qa/page")).default;
const AnswersPage = (await import("@/app/[locale]/raw-data-qa/answers/page")).default;
const DetailPage = (await import("@/app/[locale]/raw-data-qa/answers/[jobId]/page")).default;
const NotesPage = (await import("@/app/[locale]/raw-data-qa/notes/page")).default;

// ── WORLD ───────────────────────────────────────────────────────────────────

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
type Surface = "standard" | "website" | "project";
type ApiSurface = "global" | "website" | "project";
const apiSurface = (s: Surface): ApiSurface => (s === "standard" ? "global" : s);

const S_A = { id: u(0xa1), name: "김검수" };
const S_B = { id: u(0xb1), name: "박검수" };
const PASSWORD = "pw-for-tests";

interface Catalog {
  brand: string | null; brand_presence: string | null; list_type: string | null; depth1: string | null; depth2: string | null;
  depth3: string | null; depth4: string | null; funnel_stage: string | null; kind: string | null; prompt_type: string | null; category: string | null;
}
interface Prompt { id: string; text: string; lang: string | null; funnel: string | null; regions: string[] | null; isKorean: boolean | null; catalog: Catalog | null }
interface Mention {
  entity: string; brand: string; type: string | null; count: number; sent: [number, number, number, number]; avg: number | null;
  surfaces: string[] | null; rollup: string | null; rollupName: string | null; types: [number, number, number, number, number];
  role: string | null;
}
interface Citation {
  legacyId: number; ord: number; ref: number | null; url: string; domain: string; title: string | null; category: string;
  norm: string; host: string; base: string;
}
interface AcrChoice { level: 1 | 2 | 3; entity: string; name: string; parent: string | null; type: string; app: number; choice: number }
interface Acr { promptRunId: string; cellKey: number; round: string; planned: number; vt1: number; vacr: number; co: [number, number, number, number, number, number]; choices: AcrChoice[] }
interface Answer {
  jobId: string; key: number; surface: Surface; runId: string; projectRef: string | null; brand: string; country: string;
  region: string; engine: string; lang: string | null; measuredAt: string | null; prompt: Prompt; status: string; modelSlug: string;
  answerText: string; mentions: Mention[]; citations: Citation[]; acr: Acr | null;
  anchor: { anchor: string; source: string | null; reason: string | null } | null;
  drop: { reason: string; droppedAt: string | null; source: string | null } | null;
}

const P1: Prompt = {
  id: u(0x301), text: "best family suv", lang: "en", funnel: "Consideration", regions: ["US"], isKorean: false,
  catalog: { brand: "Hyundai", brand_presence: "branded", list_type: "SUV", depth1: "Vehicles", depth2: "SUV", depth3: null, depth4: null, funnel_stage: "Consideration", kind: "standard", prompt_type: "recommendation", category: "SUV" },
};
const P2: Prompt = { id: u(0x302), text: "kia ev range", lang: "en", funnel: "Awareness", regions: ["GB"], isKorean: false, catalog: null };
const P3: Prompt = { id: u(0x303), text: "제네시스 GV80 리뷰", lang: "ko", funnel: "Decision", regions: ["KR"], isKorean: true, catalog: null };
const R1 = u(0x201);
const SITE = u(0x401);
const PROJ = u(0x402);

const J1: Answer = {
  jobId: u(0x101), key: 3, surface: "standard", runId: R1, projectRef: null, brand: "Hyundai", country: "US", region: "US",
  engine: "chatgpt", lang: "en", measuredAt: "2026-09-20T01:00:00.000Z", prompt: P1, status: "completed", modelSlug: "gpt-x",
  answerText: "Hyundai Tucson is a good pick.",
  mentions: [
    { entity: u(0x502), brand: "Toyota", type: "brand", count: 1, sent: [0, 0, 1, 0], avg: 3.5, surfaces: null, rollup: u(0x505), rollupName: "Toyota Group", types: [1, 0, 1, 0, 0], role: "excluded" },
    { entity: u(0x501), brand: "Hyundai", type: "brand", count: 3, sent: [2, 1, 0, 0], avg: 1, surfaces: ["body", "list"], rollup: null, rollupName: null, types: [3, 1, 0, 0, 1], role: "own" },
  ],
  citations: [
    { legacyId: 102, ord: 2, ref: 2, url: "https://www.reddit.com/r/cars/abc", domain: "reddit.com", title: "r/cars", category: "Other", norm: "reddit.com/r/cars/abc", host: "www.reddit.com", base: "reddit.com/r/cars" },
    { legacyId: 101, ord: 1, ref: 1, url: "https://www.hyundai.com/us/en/suv", domain: "hyundai.com", title: "Hyundai SUVs", category: "Official (HMG)", norm: "hyundai.com/us/en/suv", host: "www.hyundai.com", base: "hyundai.com/us/en" },
  ],
  acr: {
    promptRunId: u(0x601), cellKey: 501, round: "2026-09-17", planned: 4, vt1: 4, vacr: 4, co: [1, 0, 0, 1, 0, 2],
    choices: [
      { level: 2, entity: u(0x504), name: "Tucson", parent: "Hyundai", type: "model", app: 1, choice: 1 },
      { level: 1, entity: u(0x501), name: "Hyundai", parent: null, type: "brand", app: 2, choice: 2 },
    ],
  },
  anchor: { anchor: "2026-09-17", source: "2026-09-20T01:00:00.000Z", reason: "late" },
  drop: null,
};
const J2: Answer = {
  jobId: u(0x102), key: 2, surface: "website", runId: u(0x202), projectRef: SITE, brand: "Kia", country: "GB", region: "gb-site",
  engine: "gemini", lang: "en", measuredAt: "2026-09-19T01:00:00.000Z", prompt: P2, status: "completed", modelSlug: "gemini-y",
  answerText: "Kia EV6 range is ...", mentions: [],
  citations: [{ legacyId: 103, ord: 1, ref: null, url: "https://www.kia.com/uk/ev", domain: "kia.com", title: null, category: "Official (HMG)", norm: "kia.com/uk/ev", host: "www.kia.com", base: "kia.com/uk" }],
  acr: null, anchor: null,
  drop: { reason: "duplicate", droppedAt: "2026-09-21T00:00:00.000Z", source: "2026-09-19T01:00:00.000Z" },
};
const J3: Answer = {
  jobId: u(0x103), key: 1, surface: "project", runId: u(0x203), projectRef: PROJ, brand: "Genesis", country: "KR", region: "KR",
  engine: "chatgpt", lang: "ko", measuredAt: "2026-09-18T01:00:00.000Z", prompt: P3, status: "completed", modelSlug: "gpt-x",
  answerText: "GV80 리뷰 요약", mentions: [
    { entity: u(0x506), brand: "Genesis", type: "brand", count: 2, sent: [1, 1, 0, 0], avg: 1, surfaces: ["body"], rollup: null, rollupName: null, types: [2, 0, 0, 0, 0], role: "own" },
  ],
  citations: [], acr: null, anchor: null, drop: null,
};
// Fillers: 52 older standard answers (page 2 of the list, date-boundary case).
const FILLERS: Answer[] = Array.from({ length: 52 }, (_, i) => ({
  ...J1, jobId: u(0x1000 + i + 1), key: 1000 + i, measuredAt: new Date(Date.UTC(2026, 7, 1, 1) - (i + 1) * 3_600_000).toISOString(),
  mentions: [], citations: [], acr: null, anchor: null, answerText: `filler ${i + 1}`,
}));
const ANSWERS: Answer[] = [J1, J2, J3, ...FILLERS];
const OVERRIDES = [{ domain: "reddit.com", name: "Community & Forums", slug: "communityForums" }];
const REGISTRY_NAMES = [{ entity: u(0x505), name: "Toyota Group" }];

interface Review { jobId: string; status: "ok" | "issue"; flags: Record<string, "ok" | "issue">; reviewer: string; sessionId: string | null; reviewedAt: string; updatedAt: string }
interface Note {
  id: string; jobId: string; kind: string; key: string | null; label: string | null; severity: string; body: string;
  reviewer: string; sessionId: string | null; createdAt: string; resolvedAt: string | null; resolvedBy: string | null;
}
interface Lock { jobId: string; sessionId: string; reviewer: string; acquiredAt: string; heartbeatAt: string }

function worldState(lockAt: string) {
  const reviews: Review[] = [
    { jobId: J1.jobId, status: "issue", flags: { answer: "ok", citations: "issue" }, reviewer: S_A.name, sessionId: S_A.id, reviewedAt: "2026-09-21T02:00:00.000Z", updatedAt: "2026-09-21T03:00:00.000Z" },
    { jobId: J3.jobId, status: "ok", flags: { answer: "ok" }, reviewer: S_B.name, sessionId: S_B.id, reviewedAt: "2026-09-21T04:00:00.000Z", updatedAt: "2026-09-21T04:00:00.000Z" },
  ];
  const notes: Note[] = [
    { id: u(0x701), jobId: J1.jobId, kind: "citation", key: "101", label: "#1 hyundai.com", severity: "issue", body: "category wrong, see \"Other\"", reviewer: S_A.name, sessionId: S_A.id, createdAt: "2026-09-21T02:10:00.000Z", resolvedAt: null, resolvedBy: null },
    { id: u(0x702), jobId: J1.jobId, kind: "answer", key: null, label: null, severity: "info", body: "=SUM(1+1)", reviewer: S_B.name, sessionId: S_B.id, createdAt: "2026-09-21T02:20:00.000Z", resolvedAt: "2026-09-22T00:00:00.000Z", resolvedBy: S_A.name },
    { id: u(0x703), jobId: J3.jobId, kind: "mention", key: u(0x506), label: "Genesis", severity: "question", body: "own?", reviewer: S_A.name, sessionId: S_A.id, createdAt: "2026-09-21T04:10:00.000Z", resolvedAt: null, resolvedBy: null },
  ];
  const locks: Lock[] = [{ jobId: J2.jobId, sessionId: S_B.id, reviewer: S_B.name, acquiredAt: lockAt, heartbeatAt: lockAt }];
  return { reviews, notes, locks };
}

// ── legacy side: PGlite ─────────────────────────────────────────────────────

type Pg = {
  exec: (s: string) => Promise<unknown>;
  query: (s: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  close: () => Promise<void>;
};
let pg: Pg;

const DDL = `
SET TIME ZONE 'UTC';
CREATE TABLE scope_runs (run_id uuid PRIMARY KEY, project_id uuid);
CREATE TABLE website_sites (id serial PRIMARY KEY, scope_project_id text, brand text, country_code text);
CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), scope_project_id uuid, brand text, country text);
CREATE TABLE scope_prompts (prompt_id uuid PRIMARY KEY, text text, lang text, funnel_stage text, regions text[], is_korean boolean);
CREATE TABLE prompts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid, scope_prompt_id uuid, brand text,
  brand_presence text, list_type text, depth1 text, depth2 text, depth3 text, depth4 text, funnel_stage text, kind text,
  prompt_type text, category text);
CREATE TABLE scope_answers (job_id uuid PRIMARY KEY, run_id uuid, prompt_id uuid, target text, region text, status text,
  measured_at timestamptz, model_slug text, answer_text text);
CREATE TABLE scope_mentions (job_id uuid, entity_id uuid, brand text, entity_type text, mention_count int,
  sentiment_positive int, sentiment_neutral int, sentiment_negative int, sentiment_mixed int, avg_position numeric,
  surfaces text[], brand_rollup_entity_id uuid, type_mention int, type_recommendation int, type_comparison int,
  type_definition int, type_final_choice int);
CREATE TABLE entity_registry (entity_id uuid PRIMARY KEY, role text, name text);
CREATE TABLE scope_citations (id bigserial PRIMARY KEY, job_id uuid, ref_index int, url text, domain text, title text,
  category text, url_norm text, url_host text, url_base_norm text);
CREATE TABLE citation_domain_overrides (domain text PRIMARY KEY, category text);
CREATE TABLE scope_acr_rollups (run_id uuid, prompt_id uuid, target text, region text, prompt_run_id uuid, entity_id uuid,
  brand text, parent_brand text, rollup_level text, entity_type text, planned_iterations int, valid_turn1_iterations int,
  valid_acr_iterations int, appearance_count int, choice_count int, conditional_choice_count int,
  off_shortlist_choice_count int, unresolved_choice_count int, generic_choice_count int, appearance_rate numeric,
  acr numeric, overall_choice_share numeric, co_single_entity int, co_conditional_multiple int, co_generic_category int,
  co_resolved_off_shortlist int, co_unresolved_choice int, co_none int);
CREATE TABLE scope_answer_anchors (job_id uuid PRIMARY KEY, anchor date NOT NULL, source_measured_at timestamptz, reason text);
CREATE TABLE scope_answer_drops (job_id uuid PRIMARY KEY, source_measured_at timestamptz, reason text NOT NULL, dropped_at timestamptz);
CREATE TABLE qa_review_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), reviewer_name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(), user_agent text, ip_hash text);
CREATE TABLE qa_answer_reviews (job_id uuid PRIMARY KEY, status text NOT NULL, section_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewer_name text NOT NULL, session_id uuid, reviewed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE qa_review_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL, target_kind text NOT NULL,
  target_key text, target_label text, severity text NOT NULL DEFAULT 'issue', body text NOT NULL, reviewer_name text NOT NULL,
  session_id uuid, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolved_by text);
CREATE TABLE qa_answer_locks (job_id uuid PRIMARY KEY, session_id uuid NOT NULL, reviewer_name text NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(), heartbeat_at timestamptz NOT NULL DEFAULT now());
`;

const TABLES = [
  "scope_runs", "website_sites", "projects", "scope_prompts", "prompts", "scope_answers", "scope_mentions", "entity_registry",
  "scope_citations", "citation_domain_overrides", "scope_acr_rollups", "scope_answer_anchors", "scope_answer_drops",
  "qa_review_sessions", "qa_answer_reviews", "qa_review_notes", "qa_answer_locks",
];

const pgArr = (xs: string[] | null) => (xs ? `{${xs.map((x) => `"${x.replace(/"/g, '\\"')}"`).join(",")}}` : null);

async function seedLegacy(state: ReturnType<typeof worldState>): Promise<void> {
  await pg.exec(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY;`);
  const q = (s: string, p: unknown[]) => pg.query(s, p);
  for (const s of [S_A, S_B]) await q("INSERT INTO qa_review_sessions (id, reviewer_name) VALUES ($1, $2)", [s.id, s.name]);
  await q("INSERT INTO website_sites (scope_project_id, brand, country_code) VALUES ($1, $2, $3)", [SITE, J2.brand, J2.country]);
  await q("INSERT INTO projects (scope_project_id, brand, country) VALUES ($1, $2, $3)", [PROJ, J3.brand, J3.country]);
  for (const p of [P1, P2, P3]) {
    await q("INSERT INTO scope_prompts VALUES ($1, $2, $3, $4, $5::text[], $6)", [p.id, p.text, p.lang, p.funnel, pgArr(p.regions), p.isKorean]);
    if (p.catalog) {
      const c = p.catalog;
      await q(
        `INSERT INTO prompts (project_id, scope_prompt_id, brand, brand_presence, list_type, depth1, depth2, depth3, depth4,
           funnel_stage, kind, prompt_type, category) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [ROOT, p.id, c.brand, c.brand_presence, c.list_type, c.depth1, c.depth2, c.depth3, c.depth4, c.funnel_stage, c.kind, c.prompt_type, c.category],
      );
    }
  }
  const runs = new Map<string, string | null>();
  for (const a of ANSWERS) runs.set(a.runId, a.projectRef);
  for (const [runId, ref] of runs) await q("INSERT INTO scope_runs VALUES ($1, $2)", [runId, ref]);
  for (const a of ANSWERS) {
    await q("INSERT INTO scope_answers VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
      a.jobId, a.runId, a.prompt.id, a.engine, a.region, a.status, a.measuredAt, a.modelSlug, a.answerText,
    ]);
    for (const m of a.mentions) {
      await q("INSERT INTO scope_mentions VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12,$13,$14,$15,$16,$17)", [
        a.jobId, m.entity, m.brand, m.type, m.count, ...m.sent, m.avg, pgArr(m.surfaces), m.rollup, ...m.types,
      ]);
      if (m.role) await q("INSERT INTO entity_registry VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [m.entity, m.role, m.brand]);
    }
    for (const c of a.citations) {
      await q("INSERT INTO scope_citations VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [
        c.legacyId, a.jobId, c.ref, c.url, c.domain, c.title, c.category, c.norm, c.host, c.base,
      ]);
    }
    if (a.acr) {
      const x = a.acr;
      for (const ch of x.choices) {
        const rate = x.vt1 > 0 ? ch.app / x.vt1 : null;
        const acr = x.vacr > 0 ? ch.choice / x.vacr : null;
        await q(
          `INSERT INTO scope_acr_rollups VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
          [a.runId, a.prompt.id, a.engine, a.region, x.promptRunId, ch.entity, ch.name, ch.parent,
            ({ 1: "brand", 2: "product", 3: "company" } as const)[ch.level], ch.type, x.planned, x.vt1, x.vacr, ch.app, ch.choice,
            0, 0, 0, 0, rate, acr, acr, ...x.co],
        );
      }
    }
    if (a.anchor) await q("INSERT INTO scope_answer_anchors VALUES ($1,$2,$3,$4)", [a.jobId, a.anchor.anchor, a.anchor.source, a.anchor.reason]);
    if (a.drop) await q("INSERT INTO scope_answer_drops VALUES ($1,$2,$3,$4)", [a.jobId, a.drop.source, a.drop.reason, a.drop.droppedAt]);
  }
  for (const r of REGISTRY_NAMES) await q("INSERT INTO entity_registry VALUES ($1, NULL, $2) ON CONFLICT DO NOTHING", [r.entity, r.name]);
  for (const o of OVERRIDES) await q("INSERT INTO citation_domain_overrides VALUES ($1, $2)", [o.domain, o.name]);
  for (const r of state.reviews) {
    await q("INSERT INTO qa_answer_reviews VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7)", [r.jobId, r.status, JSON.stringify(r.flags), r.reviewer, r.sessionId, r.reviewedAt, r.updatedAt]);
  }
  for (const n of state.notes) {
    await q("INSERT INTO qa_review_notes VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)", [
      n.id, n.jobId, n.kind, n.key, n.label, n.severity, n.body, n.reviewer, n.sessionId, n.createdAt, n.resolvedAt, n.resolvedBy,
    ]);
  }
  for (const l of state.locks) {
    await q("INSERT INTO qa_answer_locks VALUES ($1,$2,$3,$4,$5)", [l.jobId, l.sessionId, l.reviewer, l.acquiredAt, l.heartbeatAt]);
  }
}

// ── api side: backend model (documented /v1/qa semantics, OpenAPI shapes) ───

/** Python datetime.isoformat() of a UTC instant (microseconds, +00:00), as FastAPI renders it. */
function pyIso(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const base = d.toISOString().slice(0, 19);
  const ms = d.getUTCMilliseconds();
  return ms ? `${base}.${String(ms * 1000).padStart(6, "0")}+00:00` : `${base}+00:00`;
}
const kstDate = (iso: string) => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);
const LOCK_TTL_MS = 180_000;

class BackendModel {
  sessions = new Map<string, { id: string; name: string; startedAt: string }>(); // by cookie value
  reviews = new Map<string, Review>();
  notes: Note[] = [];
  locks = new Map<string, Lock>();
  password: string | null = PASSWORD;
  qaSurfaces: ApiSurface[] = ["global", "website", "project"];
  calls: Array<{ method: string; path: string; cookie: string | null; authorization: string | null }> = [];
  private seq = 0;

  constructor(state: ReturnType<typeof worldState>, cookies: Array<[string, { id: string; name: string }]>) {
    for (const r of state.reviews) this.reviews.set(r.jobId, { ...r });
    this.notes = state.notes.map((n) => ({ ...n }));
    for (const l of state.locks) this.locks.set(l.jobId, { ...l });
    for (const [c, s] of cookies) this.sessions.set(c, { ...s, startedAt: "2026-09-29T00:00:00.000Z" });
  }

  private env(data: unknown, page?: { limit: number; next_cursor: string | null }) {
    return { data, meta: { mode: "qa", ...(page ? { page } : {}) } };
  }
  private json(data: unknown, status = 200, extra: Record<string, string> = {}, setCookies: string[] = []) {
    const h = new Headers({ "content-type": "application/json", ...extra });
    for (const c of setCookies) h.append("set-cookie", c);
    return new Response(JSON.stringify(data), { status, headers: h });
  }
  private err(status: number, code: string, details?: unknown) {
    return this.json({ error: { code, message: code, details: details ?? null } }, status);
  }

  private inRange = (a: Answer) => this.qaSurfaces.includes(apiSurface(a.surface));
  private liveLock(jobId: string): Lock | null {
    const l = this.locks.get(jobId);
    return l && Date.now() - Date.parse(l.heartbeatAt) < LOCK_TTL_MS ? l : null;
  }
  private lockOut = (l: Lock) => ({ job_id: l.jobId, session_id: l.sessionId, reviewer_name: l.reviewer, acquired_at: pyIso(l.acquiredAt), heartbeat_at: pyIso(l.heartbeatAt) });
  private reviewOut = (r: Review) => ({
    job_id: r.jobId, status: r.status, reviewer_name: r.reviewer, session_id: r.sessionId, reviewed_at: pyIso(r.reviewedAt), updated_at: pyIso(r.updatedAt),
    section_flags: Object.fromEntries(["answer", "prompt", "mentions", "citations", "acr", "meta"].map((k) => [k, r.flags[k] ?? null])),
  });
  private noteOut = (n: Note) => ({
    note_id: n.id, job_id: n.jobId, target_kind: n.kind, target_key: n.key, target_label: n.label, severity: n.severity, body: n.body,
    reviewer_name: n.reviewer, created_at: pyIso(n.createdAt), resolved_at: pyIso(n.resolvedAt), resolved_by: n.resolvedBy,
  });

  private matches(a: Answer, q: URLSearchParams): boolean {
    if (!this.inRange(a)) return false;
    const surfaces = q.getAll("surface");
    if (surfaces.length) {
      const kept = surfaces.filter((s) => this.qaSurfaces.includes(s as ApiSurface)); // outside the range: dropped
      if (!kept.includes(apiSurface(a.surface))) return false;
    }
    const eq = (k: string, v: string | null) => q.getAll(k).length === 0 || (v !== null && q.getAll(k).includes(v));
    if (!eq("brand", a.brand) || !eq("country", a.country) || !eq("engine", a.engine) || !eq("lang", a.lang)) return false;
    const from = q.get("from");
    const to = q.get("to");
    if ((from || to) && !a.measuredAt) return false;
    if (from && kstDate(a.measuredAt!) < from) return false; // backend: KST date of the measurement
    if (to && kstDate(a.measuredAt!) > to) return false;
    const text = q.get("q");
    if (text && !a.prompt.text.toLowerCase().includes(text.toLowerCase())) return false;
    const review = this.reviews.get(a.jobId);
    const states = q.getAll("state");
    if (states.length && !states.includes(review?.status ?? "unreviewed")) return false;
    if (!eq("reviewer", review?.reviewer ?? null)) return false;
    if (q.get("has_notes") === "true" && !this.notes.some((n) => n.jobId === a.jobId)) return false;
    if (q.get("no_mentions") === "true" && a.mentions.length > 0) return false;
    return true;
  }
  private sorted(list: Answer[]): Answer[] {
    return [...list].sort((x, y) => {
      if (x.measuredAt === y.measuredAt) return y.key - x.key;
      if (!x.measuredAt) return 1;
      if (!y.measuredAt) return -1;
      return Date.parse(y.measuredAt) - Date.parse(x.measuredAt);
    });
  }
  private page<T>(items: T[], q: URLSearchParams): Response {
    const cursor = q.get("cursor");
    if (cursor === "c-stale") return this.err(409, "cursor_stale");
    if (cursor !== null && !/^c\d+$/.test(cursor)) return this.err(422, "cursor_invalid");
    const off = cursor ? Number(cursor.slice(1)) : 0;
    const limit = Number(q.get("limit") ?? 50);
    return this.json(this.env({ items: items.slice(off, off + limit) }, { limit, next_cursor: off + limit < items.length ? `c${off + limit}` : null }));
  }
  private progress(list: Answer[]) {
    return {
      total: list.length,
      reviewed: list.filter((a) => this.reviews.has(a.jobId)).length,
      issues: list.filter((a) => this.reviews.get(a.jobId)?.status === "issue").length,
      notes: list.filter((a) => this.notes.some((n) => n.jobId === a.jobId)).length,
    };
  }
  private listRow(a: Answer) {
    const r = this.reviews.get(a.jobId);
    const lock = this.liveLock(a.jobId);
    return {
      job_id: a.jobId, prompt_text: a.prompt.text, surface: apiSurface(a.surface), brand: [a.brand], country: a.country, engine: a.engine,
      lang: a.lang, measured_at: pyIso(a.measuredAt), job_status: "completed", dropped: Boolean(a.drop), mention_count: a.mentions.length,
      citation_count: a.citations.length, note_count: this.notes.filter((n) => n.jobId === a.jobId).length,
      review_status: r?.status ?? "unreviewed", reviewer_name: r?.reviewer ?? null, lock: lock ? this.lockOut(lock) : null,
    };
  }
  private detail(a: Answer) {
    const p = a.prompt;
    const ratio = (num: number, den: number) => ({ num, den });
    return {
      answer: {
        job_id: a.jobId, surface: apiSurface(a.surface), brand: [a.brand], country: a.country, engine: a.engine, lang: a.lang,
        round_date: "2026-09-17", measured_at: pyIso(a.measuredAt), job_status: "completed", dropped: Boolean(a.drop), served: true,
        status: a.status, analysis_status: "done", model_slug: a.modelSlug, answer_text: a.answerText,
      },
      prompt: { prompt_id: p.id, text: p.text, kind: p.catalog?.kind ?? null, lang: p.lang, funnel: p.funnel, regions: p.regions, is_korean: p.isKorean, catalog: p.catalog },
      mentions: a.mentions.map((m, i) => ({
        ord: i + 1, entity_id: m.entity, display_name: m.brand, entity_type: m.type, mention_count: m.count, avg_position: m.avg,
        surfaces: m.surfaces, brand_rollup_entity_id: m.rollup, rollup_parent_name: m.rollupName, registry_role: m.role,
        is_own: m.role === "own", is_excluded: m.role === "excluded", sentiment_positive: m.sent[0], sentiment_neutral: m.sent[1],
        sentiment_negative: m.sent[2], sentiment_mixed: m.sent[3], type_mention: m.types[0], type_recommendation: m.types[1],
        type_comparison: m.types[2], type_definition: m.types[3], type_final_choice: m.types[4],
      })),
      citations: a.citations.map((c) => {
        const ov = OVERRIDES.find((o) => o.domain === c.domain)?.slug ?? null;
        return {
          ord: c.ord, target_key: `${a.jobId}:${c.ord}`, ref_index: c.ref, url: c.url, title: c.title, host: c.host, domain: c.domain,
          stored_category: c.category, override_category: ov, effective_category: ov ?? c.category, url_norm: c.norm, url_base_norm: c.base,
        };
      }),
      acr: a.acr
        ? [{
            acr_cell_key: a.acr.cellKey, round_date: a.acr.round, planned: a.acr.planned, valid_turn1: a.acr.vt1, valid_acr: a.acr.vacr,
            co_single: a.acr.co[0], co_conditional: a.acr.co[1], co_generic: a.acr.co[2], co_off_shortlist: a.acr.co[3],
            co_unresolved: a.acr.co[4], co_none: a.acr.co[5], is_rep: true,
            choices: a.acr.choices.map((ch) => ({
              level: ch.level, entity_id: ch.entity, name: ch.name, brand: "Hyundai", parent_brand: ch.parent, entity_type: ch.type,
              appearance: ch.app, choice: ch.choice, cond_choice: 0, off_shortlist: 0, unresolved: 0, generic: 0,
              appearance_rate: ratio(ch.app, a.acr!.vt1), acr: ratio(ch.choice, a.acr!.vacr), overall_choice_share: ratio(ch.choice, a.acr!.vacr),
            })),
          }]
        : [],
      derived: {
        anchor: a.anchor ? { anchor: a.anchor.anchor, reason: a.anchor.reason, source_measured_at: pyIso(a.anchor.source) } : null,
        drop: a.drop ? { reason: a.drop.reason, dropped_at: pyIso(a.drop.droppedAt), source_measured_at: pyIso(a.drop.source) } : null,
      },
    };
  }
  private noteRows(q: URLSearchParams): Note[] {
    const kinds = q.getAll("target_kind");
    const sev = q.getAll("severity");
    return this.notes
      .filter((n) => {
        const a = ANSWERS.find((x) => x.jobId === n.jobId)!;
        if (!this.matches(a, q)) return false;
        if (kinds.length && !kinds.includes(n.kind)) return false;
        if (sev.length && !sev.includes(n.severity)) return false;
        return q.get("include_resolved") === "true" || n.resolvedAt === null;
      })
      .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt) || (x.id < y.id ? 1 : -1));
  }
  private noteRowOut(n: Note) {
    const a = ANSWERS.find((x) => x.jobId === n.jobId)!;
    return { ...this.noteOut(n), prompt_text: a.prompt.text, surface: apiSurface(a.surface), brand: [a.brand], country: a.country, engine: a.engine, lang: a.lang };
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const q = url.searchParams;
    const m = req.method;
    const cookie = req.headers.get("cookie");
    this.calls.push({ method: m, path, cookie, authorization: req.headers.get("authorization") });
    const body = m === "GET" || m === "DELETE" ? undefined : ((await req.json().catch(() => null)) as Record<string, unknown> | null);

    if (m === "POST" && path === "/v1/qa/sessions") {
      const raw = String(body?.name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
      if (!raw || raw.length > 40) return this.err(422, "bad_name", { field: "name" });
      if (this.password === null || body?.password !== this.password) return this.err(401, "bad_credentials");
      const s = { id: u(0xc000 + ++this.seq), name: raw, startedAt: new Date().toISOString() };
      const value = signReviewerCookie({ sessionId: s.id, name: s.name, issuedAt: Date.now() });
      this.sessions.set(value, s);
      return this.json(this.env({ session_id: s.id, reviewer_name: s.name, started_at: pyIso(s.startedAt), last_seen_at: pyIso(s.startedAt) }), 201,
        { "cache-control": "no-store" }, [`raw_data_qa=${value}; HttpOnly; Path=/; SameSite=lax; Secure`]);
    }

    const value = cookie?.match(/^raw_data_qa=([^;]+)$/)?.[1];
    const sess = value ? this.sessions.get(value) : undefined;
    if (!sess) return this.err(401, "qa_unauthorized");

    const sessOut = { session_id: sess.id, reviewer_name: sess.name, started_at: pyIso(sess.startedAt), last_seen_at: pyIso(sess.startedAt) };
    if (m === "GET" && path === "/v1/qa/sessions/current") return this.json(this.env(sessOut));
    let hit = path.match(/^\/v1\/qa\/sessions\/([^/]+)$/);
    if (hit && m === "PATCH") {
      if (hit[1] !== sess.id) return this.err(403, "session_forbidden");
      if (body?.logout) {
        let released = 0;
        for (const [job, l] of this.locks) {
          if (l.sessionId !== sess.id) continue;
          this.locks.delete(job);
          released += 1;
        }
        this.sessions.delete(value!);
        return this.json(this.env({ session_id: sess.id, locks_released: released, session_deleted: true, references_detached: 0, session_kept_reason: null }), 200,
          { "cache-control": "no-store" }, ['raw_data_qa=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Max-Age=0; Path=/; SameSite=lax; Secure']);
      }
      return this.json(this.env(sessOut));
    }

    const inScope = ANSWERS.filter((a) => this.inRange(a));
    if (m === "GET" && path === "/v1/qa/answers") return this.page(this.sorted(inScope.filter((a) => this.matches(a, q))).map((a) => this.listRow(a)), q);
    if (m === "GET" && path === "/v1/qa/answers/progress") {
      return this.json(this.env({ scoped: this.progress(inScope.filter((a) => this.matches(a, q))), total: this.progress(inScope) }));
    }
    if (m === "GET" && path === "/v1/qa/filters") {
      const d = (f: (a: Answer) => string | null) => [...new Set(inScope.map(f).filter((x): x is string => x !== null))];
      return this.json(this.env({
        brand: d((a) => a.brand), country: [...d((a) => a.country), "ZA"], engine: d((a) => a.engine), lang: d((a) => a.lang),
        reviewer: [...new Set([...this.reviews.values()].map((r) => r.reviewer))].sort(), surface: this.qaSurfaces,
      }));
    }
    if (m === "GET" && path === "/v1/qa/deltas") {
      const ids = q.getAll("job_ids");
      return this.json(this.env({
        locks: ids.map((id) => this.liveLock(id)).filter((l): l is Lock => l !== null).map(this.lockOut),
        reviews: ids.map((id) => this.reviews.get(id)).filter((r): r is Review => r !== undefined)
          .map((r) => ({ job_id: r.jobId, status: r.status, reviewer_name: r.reviewer, updated_at: pyIso(r.updatedAt) })),
      }));
    }
    if (m === "GET" && path === "/v1/qa/notes") return this.page(this.noteRows(q).map((n) => this.noteRowOut(n)), q);
    if (m === "GET" && path === "/v1/qa/notes/counts") {
      const out: Record<string, number> = {};
      for (const n of this.noteRows(q)) out[n.kind] = (out[n.kind] ?? 0) + 1;
      return this.json(this.env(out));
    }
    if (m === "GET" && path === "/v1/qa/notes/export") return this.csv(this.noteRows(q));

    hit = path.match(/^\/v1\/qa\/notes\/([^/]+)$/);
    if (hit) {
      const n = this.notes.find((x) => x.id === hit![1]);
      if (!n) return this.err(404, "note_not_found");
      if (m === "DELETE") {
        if (n.reviewer !== sess.name) return this.err(403, "not_author");
        this.notes = this.notes.filter((x) => x !== n);
        return this.json(this.env({ note_id: n.id, deleted: true }));
      }
      const edits = ["body", "severity"].filter((k) => body?.[k] !== undefined && body?.[k] !== null);
      if (!edits.length && typeof body?.resolved !== "boolean") return this.err(422, "unprocessable");
      if (edits.length && n.reviewer !== sess.name) return this.err(403, "not_author");
      if (typeof body?.body === "string") n.body = body.body;
      if (typeof body?.severity === "string") n.severity = body.severity;
      if (typeof body?.resolved === "boolean") {
        n.resolvedAt = body.resolved ? new Date().toISOString() : null;
        n.resolvedBy = body.resolved ? sess.name : null;
      }
      return this.json(this.env(this.noteOut(n)));
    }

    hit = path.match(/^\/v1\/qa\/answers\/([^/]+)(?:\/(lock|review|notes|neighbors))?$/);
    const a = hit ? inScope.find((x) => x.jobId === hit![1]) : undefined;
    if (!hit || !a) return this.err(404, "job_not_found");
    const now = new Date().toISOString();
    const tryLock = (): Lock | null => {
      const held = this.liveLock(a.jobId);
      if (held && held.sessionId !== sess.id) return null;
      const l = { jobId: a.jobId, sessionId: sess.id, reviewer: sess.name, acquiredAt: now, heartbeatAt: now };
      this.locks.set(a.jobId, l);
      return l;
    };
    const holder = () => {
      const l = this.liveLock(a.jobId);
      return { held_by: l ? { reviewer_name: l.reviewer, acquired_at: pyIso(l.acquiredAt) } : null };
    };
    switch (`${m} ${hit[2] ?? ""}`) {
      case "GET ":
        return this.json(this.env(this.detail(a)));
      case "GET review": {
        const r = this.reviews.get(a.jobId);
        return this.json(this.env(r ? this.reviewOut(r) : null));
      }
      case "GET notes":
        return this.json(this.env({ items: this.notes.filter((n) => n.jobId === a.jobId).map(this.noteOut) }));
      case "GET neighbors": {
        const all = this.sorted(inScope);
        const pos = all.findIndex((x) => x.jobId === a.jobId);
        const next = all.slice(pos + 1).find((x) => this.matches(x, q));
        const prev = all.slice(0, pos).reverse().find((x) => this.matches(x, q));
        return this.json(this.env({ prev: prev?.jobId ?? null, next: next?.jobId ?? null }));
      }
      case "POST lock": {
        const l = tryLock();
        return l ? this.json(this.env(this.lockOut(l))) : this.err(409, "lock_held", holder());
      }
      case "PATCH lock": {
        const l = this.liveLock(a.jobId);
        if (!l || l.sessionId !== sess.id) return this.json(this.env({ held: false, lock: null }));
        l.heartbeatAt = now;
        return this.json(this.env({ held: true, lock: this.lockOut(l) }));
      }
      case "DELETE lock": {
        const mine = this.locks.get(a.jobId)?.sessionId === sess.id;
        if (mine) this.locks.delete(a.jobId);
        return this.json(this.env({ released: mine }));
      }
      case "PUT review": {
        if (!tryLock()) return this.err(409, "lock_lost", holder());
        const flags = Object.fromEntries(
          Object.entries((body?.section_flags ?? {}) as Record<string, string | null>).filter(([, v]) => v === "ok" || v === "issue"),
        ) as Record<string, "ok" | "issue">;
        const prev = this.reviews.get(a.jobId);
        const r: Review = {
          jobId: a.jobId, status: Object.values(flags).includes("issue") ? "issue" : "ok", flags, reviewer: sess.name,
          sessionId: sess.id, reviewedAt: prev?.reviewedAt ?? now, updatedAt: now,
        };
        this.reviews.set(a.jobId, r);
        return this.json(this.env(this.reviewOut(r)));
      }
      case "POST notes": {
        const n: Note = {
          id: u(0x9000 + ++this.seq), jobId: a.jobId, kind: String(body?.target_kind), key: (body?.target_key as string | null) ?? null,
          label: (body?.target_label as string | null) ?? null, severity: String(body?.severity ?? "issue"), body: String(body?.body),
          reviewer: sess.name, sessionId: sess.id, createdAt: now, resolvedAt: null, resolvedBy: null,
        };
        this.notes.push(n);
        return this.json(this.env(this.noteOut(n)), 201);
      }
      default:
        return this.err(405, "method_not_allowed");
    }
  }

  /** core.export CSV: BOM, CRLF after every row, formula lead (= + - @ tab CR) neutralized with a quote. */
  private csv(rows: Note[]): Response {
    const safe = (v: string | null) => {
      const s = v ?? "";
      const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines = [QA_CSV_HEADER.join(",")];
    for (const n of rows) {
      const a = ANSWERS.find((x) => x.jobId === n.jobId)!;
      lines.push([pyIso(n.createdAt), n.reviewer, n.jobId, n.kind, n.key, n.label, n.severity, n.body, a.prompt.text, apiSurface(a.surface), pyIso(n.resolvedAt), n.resolvedBy].map(safe).join(","));
    }
    return new Response(`\uFEFF${lines.map((l) => `${l}\r\n`).join("")}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="qa-notes-${new Date().toISOString().slice(0, 10)}.csv"`,
        "cache-control": "no-store",
        "x-row-count": String(rows.length),
      },
    });
  }
}
const QA_CSV_HEADER = ["created_at", "reviewer", "job_id", "target_kind", "target_key", "target_label", "severity", "body", "prompt", "surface", "resolved_at", "resolved_by"];

// ── harness ─────────────────────────────────────────────────────────────────

let model: BackendModel;
let COOKIE_A = "";
let COOKIE_B = "";
let fetchCalls = 0;

const SECRET = "secret-for-parity-tests";

/** The seeded lock's timestamp: fixed per test so both sources see the same live lock. */
let lockAt = "";

async function reset(): Promise<void> {
  const state = worldState(lockAt);
  await seedLegacy(state);
  model = new BackendModel(state, [[COOKIE_A, S_A], [COOKIE_B, S_B]]);
  __resetRateLimit();
}

type Source = "legacy" | "api";
function asSource(source: Source, cookie: string | null = COOKIE_A): void {
  vi.stubEnv("HGH_SOURCE_G7", source);
  st.cookies = new Map(cookie ? [["raw_data_qa", cookie]] : []);
}

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  pg = new PGlite() as unknown as Pg;
  await pg.exec(DDL);
  // One cookie per reviewer for the whole file, in the shared format (legacy verifies the HMAC,
  // the backend model knows it as that session's cookie).
  vi.stubEnv("RAW_DATA_QA_SECRET", SECRET);
  COOKIE_A = signReviewerCookie({ sessionId: S_A.id, name: S_A.name, issuedAt: Date.now() });
  COOKIE_B = signReviewerCookie({ sessionId: S_B.id, name: S_B.name, issuedAt: Date.now() });
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
  vi.stubEnv("RAW_DATA_QA_ENABLED", "1");
  vi.stubEnv("RAW_DATA_QA_SECRET", SECRET);
  vi.stubEnv("RAW_DATA_QA_PASSWORD", PASSWORD);
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  vi.stubEnv("HGH_RELAY_SECRET", "");
  vi.stubEnv("NODE_ENV", "production");
  st.headers = new Headers({ "x-forwarded-for": "203.0.113.9", "x-pathname": "/ko/raw-data-qa/answers" });
  lockAt = new Date(Date.now() - 10_000).toISOString();
  await reset();
  fetchCalls = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    if (process.env.HGH_SOURCE_G7 !== "api") throw new Error("legacy source must not call the backend");
    return model.handle(new Request(String(input), init));
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── diffing ─────────────────────────────────────────────────────────────────

/** Leaf paths where a and b differ. Arrays of different length are one difference at the array path. */
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

/** Replace values at paths (regex on the path) with a marker: generated ids and "now" timestamps. */
function mask<T>(v: T, re: RegExp, path = ""): T {
  if (Array.isArray(v)) return v.map((x, i) => mask(x, re, `${path}[${i}]`)) as T;
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => {
        const p = path ? `${path}.${k}` : k;
        return [k, re.test(p) && x !== null && x !== undefined ? "<generated>" : mask(x, re, p)];
      }),
    ) as T;
  }
  return v;
}

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function findEl(node: ReactNode, name: string): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findEl(n, name);
      if (f) return f;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Record<string, unknown>>;
  if (typeof el.type === "function" && el.type.name === name) return el;
  return findEl(el.props.children as ReactNode, name);
}

function props(node: ReactNode, name: string): Record<string, unknown> {
  const el = findEl(node, name);
  if (!el) throw new Error(`no <${name}> in the page output`);
  const { children: _c, ...rest } = el.props;
  return plain(rest);
}

async function both<T>(run: () => Promise<T>, cookie: string | null = COOKIE_A): Promise<{ legacy: T; api: T }> {
  await reset();
  asSource("legacy", cookie);
  fetchCalls = 0;
  const legacy = await run();
  expect(fetchCalls).toBe(0);
  await reset();
  asSource("api", cookie);
  const api = await run();
  return { legacy, api };
}

const sp = (q: Record<string, string | string[]>) => Promise.resolve(q);
const locale = Promise.resolve({ locale: "ko" });

async function pageOut(render: () => Promise<ReactNode>): Promise<ReactNode | { redirect: string } | { notFound: true }> {
  try {
    return await render();
  } catch (e) {
    const digest = String((e as { digest?: string }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return { redirect: digest.split(";")[2] };
    if (digest.includes("404")) return { notFound: true };
    throw e;
  }
}

async function routeOut(res: Response) {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // CSV and empty bodies stay text
  }
  return { status: res.status, body };
}

const nreq = (url: string, method = "GET", body?: unknown) =>
  new NextRequest(new URL(url, "https://front.test"), {
    method,
    headers: { "x-forwarded-for": "203.0.113.9", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

// ── screens ─────────────────────────────────────────────────────────────────

describe("screens: legacy and api hand the same props to the unchanged components", () => {
  it("layout: reviewer name from the cookie session; an unknown cookie goes to the gate", async () => {
    const ok = await both(async () => pageOut(() => QaLayout({ children: "child", params: locale })));
    expect(props(ok.api as ReactNode, "QaHeader")).toEqual(props(ok.legacy as ReactNode, "QaHeader"));
    expect(props(ok.api as ReactNode, "QaHeader")).toEqual({ locale: "ko", reviewerName: S_A.name });
    const forged = `${COOKIE_A.split(".")[0]}.forged`;
    const bad = await both(async () => pageOut(() => QaLayout({ children: "child", params: locale })), forged);
    expect(bad).toEqual({ legacy: { redirect: "/ko/raw-data-qa" }, api: { redirect: "/ko/raw-data-qa" } });
  });

  it("gate: a valid session skips the form; no session shows it", async () => {
    const valid = await both(async () => pageOut(() => GatePage({ params: locale })));
    expect(valid).toEqual({ legacy: { redirect: "/ko/raw-data-qa/answers" }, api: { redirect: "/ko/raw-data-qa/answers" } });
    const none = await both(async () => pageOut(() => GatePage({ params: locale })), null);
    expect(props(none.api as ReactNode, "GateForm")).toEqual(props(none.legacy as ReactNode, "GateForm"));
  });

  // Filter options come from the backend dimension tables, which also list values with no
  // answer (DC, appendix F "0건 옵션이 섞인다"): the model's extra country ZA.
  const OPTIONS_DIFF = ["options.country"];
  const answersCases: Array<[string, Record<string, string | string[]>]> = [
    ["no filter (first page of 55)", {}],
    ["surface standard (URL vocabulary)", { surface: "standard" }],
    ["website + project, has notes", { surface: ["website", "project"], hasNotes: "1" }],
    ["unreviewed chatgpt", { state: "unreviewed", engine: "chatgpt" }],
    ["issue or ok by reviewer", { state: ["issue", "ok"], reviewer: S_A.name }],
    ["no mentions, text search", { noMentions: "1", q: "KIA" }],
    ["brand + country + lang", { brand: "Genesis", country: "KR", lang: "ko" }],
    ["date range inside one UTC and KST day", { from: "2026-09-19", to: "2026-09-20" }],
    ["inverted date range", { from: "2026-09-20", to: "2026-09-19" }],
  ];
  it.each(answersCases)("answers page: %s", async (_label, query) => {
    const out = await both(async () => pageOut(() => AnswersPage({ params: locale, searchParams: sp(query) })));
    const pick = (n: unknown) => ({
      ...props(n as ReactNode, "AnswerList"),
      progress: props(n as ReactNode, "ProgressHeader").progress,
      options: props(n as ReactNode, "QaFilterBar").options,
    });
    const legacy = pick(out.legacy);
    const api = pick(out.api);
    // Cursors are opaque and source specific: compare "has a next page" only.
    expect(Boolean(api.nextCursor)).toBe(Boolean(legacy.nextCursor));
    expect(diffPaths({ ...legacy, nextCursor: 0 }, { ...api, nextCursor: 0 })).toEqual(OPTIONS_DIFF);
  });

  it("answers page 2 through each source's own cursor: same rows", async () => {
    const run = async () => {
      const first = await pageOut(() => AnswersPage({ params: locale, searchParams: sp({}) }));
      const cursor = props(first as ReactNode, "AnswerList").nextCursor as string;
      const second = await pageOut(() => AnswersPage({ params: locale, searchParams: sp({ cursor }) }));
      return props(second as ReactNode, "AnswerList");
    };
    const out = await both(run);
    expect((out.legacy.rows as unknown[]).length).toBe(5);
    expect(out.api.nextCursor).toBeNull();
    expect(diffPaths(out.legacy, out.api)).toEqual([]);
  });

  it("answers page: a stale api cursor and a legacy cursor both reopen the first page (api only)", async () => {
    asSource("api");
    const stale = await pageOut(() => AnswersPage({ params: locale, searchParams: sp({ cursor: "c-stale", engine: "gemini" }) }));
    expect(stale).toEqual({ redirect: "/ko/raw-data-qa/answers?engine=gemini" });
    const legacyCursor = Buffer.from(`2026-09-19T01:00:00.000Z|${J2.jobId}`).toString("base64url");
    const foreign = await pageOut(() => AnswersPage({ params: locale, searchParams: sp({ cursor: legacyCursor }) }));
    expect(foreign).toEqual({ redirect: "/ko/raw-data-qa/answers" });
  });

  // Known differences of the detail screen (all BG-46 / note-key related, see adapter header):
  //   answer.runId, answer.region    core request R1 (not yet in the API): null
  //   citations[i].id                 legacy scope_citations.id vs the answer ordinal
  //   citations[i].targetKey          API only: note key 'job_id:ord'
  //   acr[i].promptRunId              core request R2: "acr_cell:<key>" until prompt_run_id is sent
  const detailCases: Array<[string, Answer, Record<string, string>, string[]]> = [
    ["J1 standard, full granules", J1, {}, [
      "detail.acr[0].promptRunId", "detail.acr[1].promptRunId", "detail.answer.region", "detail.answer.runId",
      "detail.citations[0].id", "detail.citations[0].targetKey", "detail.citations[1].id", "detail.citations[1].targetKey",
    ]],
    ["J2 website, dropped, null ref_index, lock held by another", J2, { surface: "website" }, [
      "detail.answer.region", "detail.answer.runId", "detail.citations[0].id", "detail.citations[0].targetKey",
    ]],
    ["J3 project, mention note, neighbors under a filter", J3, { engine: "chatgpt" }, ["detail.answer.region", "detail.answer.runId"]],
  ];
  it.each(detailCases)("detail page: %s", async (_label, a, query, known) => {
    const out = await both(async () =>
      pageOut(() => DetailPage({ params: Promise.resolve({ locale: "ko", jobId: a.jobId }), searchParams: sp(query) })),
    );
    const legacy = props(out.legacy as ReactNode, "DetailShell");
    const api = props(out.api as ReactNode, "DetailShell");
    expect(diffPaths(legacy, api)).toEqual(known);
    // The known ones, precisely:
    const d = api.detail as { answer: { runId: unknown; region: unknown }; citations: Array<{ id: number; targetKey: string }>; acr: Array<{ promptRunId: string }> };
    expect([d.answer.runId, d.answer.region]).toEqual([null, null]);
    expect(d.citations.map((c) => c.targetKey)).toEqual(a.citations.map((c) => `${a.jobId}:${c.ord}`).sort((x, y) => (x < y ? -1 : 1)));
    for (const r of d.acr) expect(r.promptRunId).toBe("acr_cell:501");
  });

  it("detail page: unknown answer -> notFound on both", async () => {
    const out = await both(async () =>
      pageOut(() => DetailPage({ params: Promise.resolve({ locale: "ko", jobId: u(0xdead) }), searchParams: sp({}) })),
    );
    expect(out).toEqual({ legacy: { notFound: true }, api: { notFound: true } });
  });

  const notesCases: Array<[string, Record<string, string | string[]>]> = [
    ["default (unresolved only)", {}],
    ["resolved included, two kinds", { includeResolved: "1", targetKind: ["citation", "answer"] }],
    ["severity + answer filter", { severity: "question", surface: "project" }],
  ];
  it.each(notesCases)("notes page: %s", async (_label, query) => {
    const out = await both(async () => pageOut(() => NotesPage({ params: locale, searchParams: sp(query) })));
    const pick = (n: unknown) => ({ ...props(n as ReactNode, "NoteList"), counts: props(n as ReactNode, "NoteSummary").counts });
    const legacy = pick(out.legacy);
    const api = pick(out.api);
    expect(Boolean(api.nextCursor)).toBe(Boolean(legacy.nextCursor));
    expect(diffPaths({ ...legacy, nextCursor: 0 }, { ...api, nextCursor: 0 })).toEqual([]);
  });
});

// ── routes ──────────────────────────────────────────────────────────────────

describe("routes: same status and body on both sources", () => {
  it("poll GET /api/qa/answers: live locks and review states", async () => {
    const ids = [J1.jobId, J2.jobId, J3.jobId].join(",");
    const out = await both(async () => routeOut(await answersRoute.GET(nreq(`/api/qa/answers?jobIds=${ids}`))));
    expect(out.api).toEqual(out.legacy);
    expect((out.api.body as { locks: unknown[] }).locks).toHaveLength(1);
  });

  it("lock: acquire a free answer, heartbeat, release (fetch and sendBeacon forms)", async () => {
    const run = async () => [
      await routeOut(await lockRoute.POST(nreq("/api/qa/lock", "POST", { jobId: J1.jobId }))),
      await routeOut(await lockRoute.PATCH(nreq("/api/qa/lock", "PATCH", { jobId: J1.jobId }))),
      await routeOut(await lockRoute.DELETE(nreq("/api/qa/lock", "DELETE", { jobId: J1.jobId }))),
      await routeOut(await lockRoute.PATCH(nreq("/api/qa/lock", "PATCH", { jobId: J1.jobId }))),
      await routeOut(await lockRoute.POST(nreq("/api/qa/lock", "POST", { jobId: J1.jobId }))),
      await routeOut(await lockRoute.POST(nreq("/api/qa/lock?release=1", "POST", { jobId: J1.jobId }))),
      await routeOut(await lockRoute.POST(nreq("/api/qa/lock", "POST", {}))),
    ];
    const out = await both(run);
    expect(mask(out.api, /\[\d+\]\.body\.lock\.(acquiredAt|heartbeatAt)$/)).toEqual(mask(out.legacy, /\[\d+\]\.body\.lock\.(acquiredAt|heartbeatAt)$/));
    expect(out.api.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200, 400]);
    expect((out.api[3].body as { held: boolean }).held).toBe(false);
  });

  it("lock: an answer held by another reviewer -> 409 {ok:false, heldBy}", async () => {
    const out = await both(async () => routeOut(await lockRoute.POST(nreq("/api/qa/lock", "POST", { jobId: J2.jobId }))));
    expect(out.api).toEqual(out.legacy);
    expect(out.api).toMatchObject({ status: 409, body: { ok: false, heldBy: { reviewerName: S_B.name } } });
  });

  it("review: save (status derived) and lock lost (another reviewer holds the answer)", async () => {
    const run = async () => [
      await routeOut(await reviewRoute.PUT(nreq("/api/qa/review", "PUT", { jobId: J1.jobId, sectionFlags: { answer: "ok", mentions: "issue", x: "ok" } }))),
      await routeOut(await reviewRoute.PUT(nreq("/api/qa/review", "PUT", { jobId: J2.jobId, sectionFlags: { answer: "ok" } }))),
    ];
    const out = await both(run);
    expect(out.api).toEqual(out.legacy);
    expect(out.api).toEqual([
      { status: 200, body: { status: "issue", reviewerName: S_A.name } },
      { status: 409, body: { error: "lock-lost", heldBy: { reviewerName: S_B.name } } },
    ]);
  });

  it("review saved on one source is read back the same by the detail page", async () => {
    const run = async () => {
      await reviewRoute.PUT(nreq("/api/qa/review", "PUT", { jobId: J3.jobId, sectionFlags: { acr: "issue" } }));
      const page = await pageOut(() => DetailPage({ params: Promise.resolve({ locale: "ko", jobId: J3.jobId }), searchParams: sp({}) }));
      return props(page as ReactNode, "DetailShell").review;
    };
    const out = await both(run);
    expect(mask(out.api, /reviewedAt$/)).toEqual(mask(out.legacy, /reviewedAt$/));
    expect(out.api).toMatchObject({ status: "issue", sectionFlags: { acr: "issue" }, reviewerName: S_A.name });
  });

  it("note: create (validation, trim), resolve toggle by another reviewer, not-found, id required", async () => {
    const run = async () => {
      const created = await routeOut(await noteRoute.POST(nreq("/api/qa/note", "POST", {
        jobId: J3.jobId, targetKind: "meta", targetKey: "  k1 ", targetLabel: "model", severity: "odd", body: "  check model  ",
      })));
      const invalid = await routeOut(await noteRoute.POST(nreq("/api/qa/note", "POST", { jobId: J3.jobId, targetKind: "nope", body: "x" })));
      asSource(process.env.HGH_SOURCE_G7 as Source, COOKIE_B);
      const resolved = await routeOut(await noteRoute.PATCH(nreq("/api/qa/note", "PATCH", { id: u(0x701), resolved: true })));
      const missing = await routeOut(await noteRoute.PATCH(nreq("/api/qa/note", "PATCH", { id: u(0xbeef), resolved: true })));
      const noId = await routeOut(await noteRoute.PATCH(nreq("/api/qa/note", "PATCH", {})));
      const nothing = await routeOut(await noteRoute.PATCH(nreq("/api/qa/note", "PATCH", { id: u(0x701) })));
      return { created, invalid, resolved, missing, noId, nothing };
    };
    const out = await both(run);
    const gen = /(created|resolved)\.body\.note\.(id|createdAt|resolvedAt)$/;
    // Known: the legacy note JSON also carried the writer's sessionId; the API does not expose it.
    expect(diffPaths(mask(out.legacy, gen), mask(out.api, gen))).toEqual(["created.body.note.sessionId", "resolved.body.note.sessionId"]);
    expect(out.api.created).toMatchObject({ status: 200, body: { note: { targetKey: "k1", severity: "issue", body: "check model", reviewerName: S_A.name } } });
    expect(out.api.resolved).toMatchObject({ status: 200, body: { note: { resolvedBy: S_B.name } } });
    expect([out.api.missing.status, out.api.noId.status, out.api.nothing.status]).toEqual([404, 400, 404]);
  });

  it("session: login success (cookie shape), bad name, bad credentials; logout clears the cookie", async () => {
    const cookieAttrs = (res: Response) =>
      res.headers.getSetCookie().map((line) => {
        const [pair, ...attrs] = line.split(";").map((s) => s.trim());
        const attr = new Map(attrs.map((a) => [a.split("=")[0].toLowerCase(), (a.split("=")[1] ?? "").toLowerCase()]));
        return {
          name: pair.split("=")[0],
          cleared: pair.endsWith("=") || pair.endsWith('=""') || attr.get("max-age") === "0",
          path: attr.get("path"),
          httponly: attr.has("httponly"),
          samesite: attr.get("samesite"),
          persistent: !attr.has("max-age") && !attr.has("expires") ? false : attr.get("max-age") !== "0",
        };
      });
    const run = async () => {
      const login = await sessionRoute.POST(nreq("/api/qa/session", "POST", { name: "  이검수 ", password: PASSWORD }));
      const badName = await sessionRoute.POST(nreq("/api/qa/session", "POST", { name: "   ", password: PASSWORD }));
      const badPw = await sessionRoute.POST(nreq("/api/qa/session", "POST", { name: "이검수", password: "nope" }));
      const logout = await sessionRoute.DELETE();
      return {
        login: { ...(await routeOut(login)), cookie: cookieAttrs(login) },
        badName: await routeOut(badName),
        badPw: await routeOut(badPw),
        logout: { ...(await routeOut(logout)), cookie: cookieAttrs(logout).map((c) => ({ name: c.name, cleared: c.cleared, path: c.path })) },
      };
    };
    const out = await both(run);
    expect(out.api).toEqual(out.legacy);
    expect(out.api.login).toMatchObject({ status: 200, body: { name: "이검수" }, cookie: [{ name: "raw_data_qa", httponly: true, samesite: "lax", path: "/", persistent: false }] });
    expect(out.api.badName).toEqual({ status: 400, body: { error: "bad-name" } });
    expect(out.api.badPw).toEqual({ status: 401, body: { error: "bad-credentials" } });
    expect(out.api.logout.cookie).toEqual([{ name: "raw_data_qa", cleared: true, path: "/" }]);
    // api: the login went to the backend without any credential; logout carried the QA cookie only
    expect(model.calls.find((c) => c.path === "/v1/qa/sessions")).toMatchObject({ cookie: null, authorization: null });
    expect(model.calls.every((c) => c.authorization === null)).toBe(true);
  });

  it("export: same header row and rows; value format follows the backend (known differences listed)", async () => {
    const parse = (text: string) => {
      const rows: string[][] = [];
      let row: string[] = [];
      let cell = "";
      let quoted = false;
      const endCell = () => {
        row.push(cell);
        cell = "";
      };
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quoted) {
          if (ch === '"' && text[i + 1] === '"') {
            cell += '"';
            i += 1;
          } else if (ch === '"') quoted = false;
          else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ",") endCell();
        else if (ch === "\r" && text[i + 1] === "\n") {
          endCell();
          rows.push(row);
          row = [];
          i += 1;
        } else cell += ch;
      }
      if (cell || row.length) {
        endCell();
        rows.push(row);
      }
      return rows;
    };
    const out = await both(async () => routeOut(await exportRoute.GET(nreq("/api/qa/notes/export?includeResolved=1"))));
    const legacyText = out.legacy.body as string;
    const apiText = out.api.body as string;
    expect([legacyText.startsWith("\uFEFF"), apiText.startsWith("\uFEFF")]).toEqual([true, true]);
    // Known (value format of core.export): every row ends with CRLF (legacy: no trailing CRLF).
    expect([legacyText.endsWith("\r\n"), apiText.endsWith("\r\n")]).toEqual([false, true]);
    const [lh, ...lrows] = parse(legacyText.slice(1));
    const [ah, ...arows] = parse(apiText.slice(1));
    expect(ah).toEqual(lh);
    expect(arows).toHaveLength(lrows.length);
    const col = (name: string) => lh.indexOf(name);
    const diffs = new Set<string>();
    lrows.forEach((l, i) => {
      l.forEach((cell, j) => {
        const a = arows[i][j];
        if (cell === a) return;
        const name = lh[j];
        if ((name === "created_at" || name === "resolved_at") && Date.parse(cell) === Date.parse(a)) diffs.add(`${name}: ISO with offset`);
        else if (name === "surface" && cell === "standard" && a === "global") diffs.add("surface: global");
        else if (name === "body" && a === `'${cell}`) diffs.add("body: formula neutralized (DC-17)");
        else diffs.add(`UNEXPECTED ${name}: ${cell} -> ${a}`);
      });
    });
    expect([...diffs].sort()).toEqual([
      "body: formula neutralized (DC-17)",
      "created_at: ISO with offset",
      "resolved_at: ISO with offset",
      "surface: global",
    ]);
    expect(arows.map((r) => r[col("body")])).toContain("'=SUM(1+1)");
  });
});

// ── DC-17: definition changes, asserted as known differences ────────────────

describe("DC-17 known differences (intended, from the backend)", () => {
  it("no default password: legacy accepts qa-default-redacted when unset, the backend refuses everything", async () => {
    vi.stubEnv("RAW_DATA_QA_PASSWORD", "");
    const run = async () => {
      if (process.env.HGH_SOURCE_G7 === "api") model.password = null; // HGH_QA_PASSWORD unset
      return routeOut(await sessionRoute.POST(nreq("/api/qa/session", "POST", { name: "kim", password: "qa-default-redacted" })));
    };
    const out = await both(run);
    expect(out.legacy).toEqual({ status: 200, body: { name: "kim" } });
    expect(out.api).toEqual({ status: 401, body: { error: "bad-credentials" } });
  });

  it("note body/severity edit and delete: author only on the API (resolve toggle stays open)", async () => {
    const run = async () => {
      asSource(process.env.HGH_SOURCE_G7 as Source, COOKIE_B); // B edits A's note
      return {
        edit: await routeOut(await noteRoute.PATCH(nreq("/api/qa/note", "PATCH", { id: u(0x701), body: "rewritten" }))),
        remove: await routeOut(await noteRoute.DELETE(nreq("/api/qa/note", "DELETE", { id: u(0x701) }))),
      };
    };
    const out = await both(run);
    expect(out.legacy.edit.status).toBe(200);
    expect(out.legacy.remove).toEqual({ status: 200, body: { ok: true } });
    expect(out.api).toEqual({ edit: { status: 403, body: { error: "forbidden" } }, remove: { status: 403, body: { error: "forbidden" } } });
  });

  it("logout releases the session's locks: another reviewer can take the answer at once", async () => {
    const run = async () => {
      asSource(process.env.HGH_SOURCE_G7 as Source, COOKIE_B);
      await sessionRoute.DELETE();
      asSource(process.env.HGH_SOURCE_G7 as Source, COOKIE_A);
      return (await routeOut(await lockRoute.POST(nreq("/api/qa/lock", "POST", { jobId: J2.jobId })))).status;
    };
    const out = await both(run);
    expect(out).toEqual({ legacy: 409, api: 200 }); // legacy: B's lock lives until the 3-minute TTL
  });

  it("review range fixed by the server (HGH_QA_SURFACES): answers outside it are not listed, even when filtered for", async () => {
    const run = async () => {
      if (process.env.HGH_SOURCE_G7 === "api") model.qaSurfaces = ["global"];
      const all = await pageOut(() => AnswersPage({ params: locale, searchParams: sp({}) }));
      const site = await pageOut(() => AnswersPage({ params: locale, searchParams: sp({ surface: "website" }) }));
      const surfaces = (n: unknown) => [...new Set((props(n as ReactNode, "AnswerList").rows as Array<{ surface: string }>).map((r) => r.surface))].sort();
      return { all: surfaces(all), site: surfaces(site), total: (props(all as ReactNode, "ProgressHeader").progress as { total: { total: number } }).total.total };
    };
    const out = await both(run);
    expect(out.legacy).toEqual({ all: ["project", "standard", "website"], site: ["website"], total: 55 });
    expect(out.api).toEqual({ all: ["standard"], site: [], total: 53 });
  });

  it("date filter boundary: the backend counts the KST date of the measurement, legacy the UTC date", async () => {
    const run = async () => {
      const page = await pageOut(() => AnswersPage({ params: locale, searchParams: sp({ from: "2026-08-01", to: "2026-08-01" }) }));
      return (props(page as ReactNode, "AnswerList").rows as unknown[]).length;
    };
    // Fillers sit hourly before 2026-08-01T01:00Z: UTC day 08-01 holds 1 of them, KST day 08-01 holds 10.
    expect(await both(run)).toEqual({ legacy: 1, api: 10 });
  });
});
