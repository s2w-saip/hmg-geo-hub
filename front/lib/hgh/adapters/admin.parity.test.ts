import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// Legacy <-> API parity for the admin console (unit U11).
//
// Method (U9 / U12 precedent). One neutral WORLD (accounts, root catalog, interest sources,
// mentions, citations, GA4 registry) is written twice, each in its native form:
//   legacy: rows in the legacy tables on PGlite (real PostgreSQL), read and written by the
//           UNCHANGED repositories through the unchanged legacy branch of the pages and actions;
//   api:    a backend model answering /v1/admin/* in the OpenAPI shapes from the same WORLD, with
//           the documented backend semantics (ordering, guards, error codes), read and written
//           through lib/hgh/adapters/admin.ts by the same pages and actions.
// Pages are compared on the props they hand to the screen components (the JSX tree, not
// rendered); actions on their results. Every difference must be a declared known_diff (design
// DC numbers or U11-N#): an undeclared difference fails, and so does a declared one that vanishes.
// Not covered here: the backend's own rules (its tests own them) and whether the migration
// writes the same rows. The model returns what the backend code documents.

const st = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  auth: new Map<string, { id: string; email: string | null; createdAt: string | null; lastSignInAt: string | null }>(),
  markets: [] as string[],
}));

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const { dirname, join: j } = await import("node:path");
  const req = createRequire(import.meta.url);
  const root = dirname(req.resolve("react/package.json"));
  return req(j(root, "cjs", "react.react-server.development.js"));
});
vi.mock("@/lib/db", () => ({ getDb: () => st.db }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => st.session }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
// The entities page (E7) imports the version screens, which link through next-intl navigation;
// its client module resolves next/navigation outside the mock above, so it is stubbed here.
vi.mock("@/i18n/navigation", () => ({
  Link: function Link() {
    return null;
  },
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/",
}));
vi.mock("next/cache", () => ({
  unstable_cache: <F>(fn: F) => fn,
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getTranslations: async () => (k: string, v?: Record<string, unknown>) => (v ? `${k}|${JSON.stringify(v)}` : k),
}));
vi.mock("@/lib/audit", () => ({ auditDataAccess: () => undefined, auditScopeCall: () => undefined }));
// Live Scope calls of the legacy path (outside the compared data).
vi.mock("@/lib/scope/server", () => ({
  MIRROR_AGGREGATE_TAG: "mirror",
  updateRootPrompt: async () => ({}),
  createRootPrompt: async () => null,
  getProject: async () => ({ regions: st.markets }),
}));
// Supabase Auth admin API of the legacy path: in-memory users from the WORLD.
vi.mock("@/lib/supabase/admin", () => ({
  generateTempPassword: () => "tmp-pw",
  adminListUsers: async () => [...st.auth.values()],
  adminCreateUser: async ({ email }: { email: string }) => {
    const id = randomUUID();
    st.auth.set(id, { id, email, createdAt: new Date().toISOString(), lastSignInAt: null });
    return { id };
  },
  adminDeleteUser: async (id: string) => {
    st.auth.delete(id);
  },
}));
vi.mock("@/lib/ga4/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ga4/client")>()),
  runReport: async () => ({ rows: [] }),
  dateNDaysAgo: () => ({ start: "2026-09-27", end: "2026-09-28" }),
}));
vi.mock("@/lib/ga4/property-map", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ga4/property-map")>()),
  legacyEnvMarkets: () => [
    { brand: "Hyundai", country: "KR", propertyId: "111" },
    { brand: "Kia", country: "DE", propertyId: "444" },
  ],
  envPropertyFor: (b: string, c: string) => (b === "Kia" && c === "DE" ? "444" : null),
}));

const { withRequestScope } = await import("@/test/request-scope");
const { bindHghAuth } = await import("@/lib/hgh/auth");
const { buildCurationRow } = await import("@/lib/citation-categorizer/curation");
const { normalizeCitationDomain } = await import("@/lib/citation-categorizer");
const { STANDARD_ROOT_PROJECT_ID: ROOT } = await import("@/lib/db/repositories/standards");
const AdminPage = (await import("@/app/[locale]/(dash)/admin/page")).default;
const { UserList } = await import("@/app/[locale]/(dash)/admin/_components/user-list");
const { UserListClient } = await import("@/app/[locale]/(dash)/admin/_components/user-list-client");
const { CreateUserForm } = await import("@/app/[locale]/(dash)/admin/_components/create-user-form");
const userActions = await import("@/app/[locale]/(dash)/admin/_actions");
const PromptsPage = (await import("@/app/[locale]/(dash)/admin/standards/prompts/page")).default;
const { StandardPromptList } = await import("@/app/[locale]/(dash)/admin/standards/prompts/_components/prompt-list");
const standardActions = await import("@/app/[locale]/(dash)/admin/standards/_actions");
const InterestPage = (await import("@/app/[locale]/(dash)/admin/standards/customer-interest/page")).default;
const { StandardKeywordList } = await import("@/app/[locale]/(dash)/admin/standards/customer-interest/_components/keyword-list");
const { StandardSourceList } = await import("@/app/[locale]/(dash)/admin/standards/customer-interest/_components/source-list");
const EntitiesPage = (await import("@/app/[locale]/(dash)/admin/standards/entities/page")).default;
const { EntityCatalog } = await import("@/app/[locale]/(dash)/admin/standards/entities/_components/entity-catalog");
const entityActions = await import("@/app/[locale]/(dash)/admin/standards/entities/_actions");
const CitationPage = (await import("@/app/[locale]/(dash)/admin/standards/citation-sources/page")).default;
const { DomainList } = await import("@/app/[locale]/(dash)/admin/standards/citation-sources/_components/domain-list");
const citationActions = await import("@/app/[locale]/(dash)/admin/standards/citation-sources/_actions");
const Ga4Page = (await import("@/app/[locale]/(dash)/admin/ga4/page")).default;
const { Ga4RegistryClient } = await import("@/app/[locale]/(dash)/admin/ga4/_components/ga4-registry-client");
const ga4Actions = await import("@/app/[locale]/(dash)/admin/ga4/_actions");
const { PageHeader } = await import("@/components/page-header");

// ── WORLD ───────────────────────────────────────────────────────────────────

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const T = (day: number, h = 0) => new Date(Date.UTC(2026, 5, day, h, 0, 0, 123)).toISOString();
/** Backend timestamp form (microseconds, +00:00). */
const apiTs = (iso: string) => iso.replace("Z", "456+00:00");
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhIn0.c2ln";

type Role = "admin" | "hq" | "region" | "country" | "vendor" | "website";
interface Account {
  id: string;
  email: string;
  role: Role;
  scopeAll: boolean;
  brands: string[];
  regions: string[];
  countries: string[];
  operator: "none" | "assigned" | "global";
  createdAt: string;
  lastSignInAt: string | null;
  /** The account has activity records (backend refuses delete: user_referenced). */
  referenced?: boolean;
}
const ADMIN_A: Account = { id: u(1), email: "a@hmg.test", role: "admin", scopeAll: true, brands: [], regions: [], countries: [], operator: "global", createdAt: T(1), lastSignInAt: "2026-09-01T03:00:00.000Z" };
const HQ_B: Account = { id: u(2), email: "b@hmg.test", role: "hq", scopeAll: true, brands: [], regions: [], countries: [], operator: "none", createdAt: T(2), lastSignInAt: null };
const COUNTRY_C: Account = { id: u(3), email: "c@hmg.test", role: "country", scopeAll: false, brands: ["Hyundai"], regions: ["HMA"], countries: ["KR"], operator: "assigned", createdAt: T(3), lastSignInAt: "2026-09-20T23:30:00.000Z" };
const ADMIN_D: Account = { id: u(4), email: "d@hmg.test", role: "admin", scopeAll: true, brands: [], regions: [], countries: [], operator: "global", createdAt: T(4), lastSignInAt: null };
const VENDOR_E: Account = { id: u(5), email: "e@hmg.test", role: "vendor", scopeAll: false, brands: ["Kia"], regions: [], countries: [], operator: "none", createdAt: T(5), lastSignInAt: null, referenced: true };
const ACCOUNTS = [ADMIN_A, HQ_B, COUNTRY_C, ADMIN_D, VENDOR_E];

interface CatalogRowW {
  id: string;
  text: string;
  brand: string | null;
  depth1: string | null;
  depth2: string | null;
  depth3: string | null;
  kind: string;
  regions: string[] | null;
  lang: string | null;
  scopePromptId: string | null;
  scopeText: string | null;
  deletedAt: string | null;
}
const cat = (id: number, over: Partial<CatalogRowW>): CatalogRowW => ({
  id: u(0x100 + id), text: "", brand: null, depth1: null, depth2: null, depth3: null, kind: "single", regions: null, lang: null,
  scopePromptId: null, scopeText: null, deletedAt: null, ...over,
});
const CATALOG: CatalogRowW[] = [
  cat(1, { text: "alpha", brand: "Hyundai", depth1: "A", depth2: "a", regions: ["KR"], lang: "KO", scopePromptId: u(0x201), scopeText: "alpha s" }),
  cat(2, { text: "beta", depth1: "A", depth2: "b", kind: "acr" }),
  cat(3, { text: "gamma", depth1: "B", deletedAt: T(10), scopePromptId: u(0x203), scopeText: "gamma s" }),
  cat(4, { text: "delta" }),
];
const SCOPE_ORPHAN = u(0x209);
const MARKETS = ["KR", "US"];

interface KeywordW { id: string; term: string; sourceType: "google_keyword" | "community_voc"; brand: string | null; notes: string | null; enabled: boolean; createdAt: string }
interface SourceW { id: string; url: string; channel: "news" | "pr" | "social" | "community"; brand: string | null; notes: string | null; enabled: boolean; createdAt: string }
const KEYWORDS: KeywordW[] = [
  { id: u(0x301), term: "ioniq", sourceType: "google_keyword", brand: "Hyundai", notes: null, enabled: true, createdAt: T(1) },
  { id: u(0x302), term: "ev6", sourceType: "community_voc", brand: "Kia", notes: "voc", enabled: true, createdAt: T(3) },
  { id: u(0x303), term: "gv80", sourceType: "google_keyword", brand: "Genesis", notes: null, enabled: false, createdAt: T(5) },
];
const SOURCES: SourceW[] = [
  { id: u(0x311), url: "https://news.test", channel: "news", brand: null, notes: null, enabled: true, createdAt: T(1) },
  { id: u(0x312), url: "https://pr.test", channel: "pr", brand: "Kia", notes: "pr", enabled: true, createdAt: T(2) },
];

// Mentions: E1 and E3 share the display brand Hyundai (DC-13 shows there).
const E1 = u(0x401), E2 = u(0x402), E3 = u(0x403), E4 = u(0x404);
const MENTIONS = [
  { job: u(0x501), entity: E1, name: "Hyundai", count: 3 },
  { job: u(0x502), entity: E1, name: "Hyundai", count: 1 },
  { job: u(0x501), entity: E2, name: "Kia", count: 2 },
  { job: u(0x503), entity: E3, name: "Hyundai N", count: 1 },
];
const ENTITY_BRAND: Record<string, { code: string; name: string } | null> = {
  [E1]: { code: "Hyundai", name: "Hyundai" },
  [E2]: { code: "Kia", name: "Kia" },
  [E3]: { code: "Hyundai", name: "Hyundai" },
  [E4]: null,
};
const REGISTRY = [
  { entityId: E1, name: "Hyundai", role: "own" as const },
  { entityId: E4, name: "Noise", role: "excluded" as const },
];

// Citations: www. and case folded on both sides; one override; youtube is the backend "social" layer.
const CITED = ["www.hyundai.com", "WWW.Hyundai.com", "hyundai.com", "reddit.com", "reddit.com", "example-blog.test", "youtube.com"];
const OVERRIDES = [{ domain: "reddit.com", category: "News & Media", note: "fix", updatedBy: u(1), updatedAt: T(8) }];
const SOCIAL_DOMAINS = new Set(["youtube.com"]);

interface Ga4W { id: string; brand: string; country: string; propertyId: string | null; status: string; verifiedAt: string | null }
const GA4: Ga4W[] = [
  { id: u(0x601), brand: "Hyundai", country: "KR", propertyId: "111", status: "active", verifiedAt: "2026-09-01T00:00:00.000Z" },
  { id: u(0x602), brand: "Kia", country: "US", propertyId: null, status: "unmapped", verifiedAt: null },
  { id: u(0x603), brand: "Genesis", country: "US", propertyId: "333", status: "pending_grant", verifiedAt: null },
];
const GA4_PROJECTS = [
  { id: u(0x701), name: "Proj one", brand: "Hyundai", country: "KR", ga4: "999", createdAt: T(2) },
  { id: u(0x702), name: "Proj two", brand: null, country: "US", ga4: "111", createdAt: T(5) },
  { id: u(0x703), name: "Proj three", brand: "Kia", country: "US", ga4: null, createdAt: T(6) },
];

// ── legacy side: PGlite ─────────────────────────────────────────────────────

type Pg = {
  exec: (s: string) => Promise<unknown>;
  query: (s: string, p?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  close: () => Promise<void>;
};
let pg: Pg;

const DDL = `
SET TIME ZONE 'UTC';
-- PGlite has no ICU. ASCII fixture only; native PostgreSQL tests cover actual ICU ordering.
CREATE COLLATION "en-x-icu" FROM "C";
CREATE COLLATION "ko-x-icu" FROM "C";
CREATE TYPE standard_keyword_source AS ENUM ('google_keyword', 'community_voc');
CREATE TYPE standard_source_channel AS ENUM ('news', 'pr', 'social', 'community');
CREATE TABLE profiles (id uuid PRIMARY KEY, email text, role text NOT NULL, scope_all boolean NOT NULL DEFAULT false,
  brands text[], regions text[], countries text[], operator text NOT NULL DEFAULT 'none', menu_groups text[],
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE project_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'viewer', status text NOT NULL DEFAULT 'pending', invited_by uuid NOT NULL,
  invited_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz);
CREATE TABLE member_audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, actor_id uuid NOT NULL,
  target_user_id uuid NOT NULL, action text NOT NULL, context text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE prompts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, candidate_id uuid, text text NOT NULL,
  prompt_type text, category text, brand text, brand_presence text, list_type text, depth1 text, depth2 text, depth3 text,
  depth4 text, funnel_stage text, kind text NOT NULL DEFAULT 'single', lang text, regions text[], scope_prompt_id uuid,
  status text NOT NULL DEFAULT 'draft', needs_reanalysis boolean NOT NULL DEFAULT false, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  deleted_at timestamptz);
CREATE TABLE scope_prompts (prompt_id uuid PRIMARY KEY, text text, funnel_stage text, is_korean boolean, lang text, regions text[]);
CREATE TABLE prompt_audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), prompt_id uuid NOT NULL, project_id uuid NOT NULL,
  actor_id uuid, actor_type text NOT NULL DEFAULT 'user', event_type text NOT NULL, changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  batch_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE standard_keywords (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), term text NOT NULL, source_type standard_keyword_source NOT NULL,
  brand text, enabled boolean NOT NULL DEFAULT true, notes text, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE standard_sources (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), url text NOT NULL, channel standard_source_channel NOT NULL,
  brand text, enabled boolean NOT NULL DEFAULT true, notes text, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE entity_registry (entity_id uuid PRIMARY KEY, name text NOT NULL, role text NOT NULL DEFAULT 'own', updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE scope_mentions (job_id uuid, entity_id uuid, brand text, entity_type text, mention_count int);
CREATE TABLE scope_citations (id bigserial PRIMARY KEY, job_id uuid, domain text);
CREATE TABLE citation_domain_overrides (domain text PRIMARY KEY, category text NOT NULL, note text, updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ga4_properties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand text NOT NULL, country_code text NOT NULL,
  property_id text, status text NOT NULL DEFAULT 'pending_grant', granted_at timestamptz, verified_at timestamptz,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand, country_code));
CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, description text, domain text, brand text,
  country text NOT NULL, language text, scope_project_id uuid, ga4_property_id text, ai_engines text[], created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
`;
const TABLES = [
  "profiles", "project_members", "member_audit_logs", "prompts", "scope_prompts", "prompt_audit_logs", "standard_keywords",
  "standard_sources", "entity_registry", "scope_mentions", "scope_citations", "citation_domain_overrides", "ga4_properties", "projects",
];
const arr = (xs: string[] | null) => (xs === null ? null : `{${xs.map((x) => `"${x}"`).join(",")}}`);
const nz = (xs: string[]) => (xs.length ? xs : null);

async function seedLegacy(): Promise<void> {
  await pg.exec(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY;`);
  const q = (s: string, p: unknown[]) => pg.query(s, p);
  st.auth.clear();
  for (const a of ACCOUNTS) {
    await q(
      `INSERT INTO profiles (id, email, role, scope_all, brands, regions, countries, operator, created_at)
       VALUES ($1,$2,$3,$4,$5::text[],$6::text[],$7::text[],$8,$9)`,
      [a.id, a.email, a.role, a.scopeAll, arr(nz(a.brands)), arr(nz(a.regions)), arr(nz(a.countries)), a.operator, a.createdAt],
    );
    st.auth.set(a.id, { id: a.id, email: a.email, createdAt: a.createdAt, lastSignInAt: a.lastSignInAt });
  }
  for (const c of CATALOG) {
    await q(
      `INSERT INTO prompts (id, project_id, text, brand, depth1, depth2, depth3, kind, regions, lang, scope_prompt_id, created_by, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12,$13)`,
      [c.id, ROOT, c.text, c.brand, c.depth1, c.depth2, c.depth3, c.kind, arr(c.regions), c.lang, c.scopePromptId, u(1), c.deletedAt],
    );
    if (c.scopePromptId) await q("INSERT INTO scope_prompts (prompt_id, text) VALUES ($1,$2)", [c.scopePromptId, c.scopeText]);
  }
  await q("INSERT INTO scope_prompts (prompt_id, text) VALUES ($1,$2)", [SCOPE_ORPHAN, "orphan"]);
  for (const k of KEYWORDS) {
    await q(
      "INSERT INTO standard_keywords (id, term, source_type, brand, enabled, notes, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [k.id, k.term, k.sourceType, k.brand, k.enabled, k.notes, u(1), k.createdAt],
    );
  }
  for (const s of SOURCES) {
    await q(
      "INSERT INTO standard_sources (id, url, channel, brand, enabled, notes, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [s.id, s.url, s.channel, s.brand, s.enabled, s.notes, u(1), s.createdAt],
    );
  }
  for (const m of MENTIONS) {
    await q("INSERT INTO scope_mentions (job_id, entity_id, brand, entity_type, mention_count) VALUES ($1,$2,$3,'Brand',$4)", [m.job, m.entity, m.name, m.count]);
  }
  for (const r of REGISTRY) await q("INSERT INTO entity_registry (entity_id, name, role) VALUES ($1,$2,$3)", [r.entityId, r.name, r.role]);
  for (const d of CITED) await q("INSERT INTO scope_citations (job_id, domain) VALUES ($1,$2)", [u(0x501), d]);
  for (const o of OVERRIDES) {
    await q("INSERT INTO citation_domain_overrides (domain, category, note, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5)", [o.domain, o.category, o.note, o.updatedBy, o.updatedAt]);
  }
  for (const g of GA4) {
    await q(
      "INSERT INTO ga4_properties (id, brand, country_code, property_id, status, verified_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [g.id, g.brand, g.country, g.propertyId, g.status, g.verifiedAt, u(1)],
    );
  }
  for (const p of GA4_PROJECTS) {
    await q("INSERT INTO projects (id, name, brand, country, ga4_property_id, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [p.id, p.name, p.brand, p.country, p.ga4, u(1), p.createdAt]);
  }
  // E's activity record (the backend refuses to delete a referenced account).
  await q("INSERT INTO project_members (project_id, user_id, role, status, invited_by) VALUES ($1,$2,'owner','active',$3)", [GA4_PROJECTS[2].id, VENDOR_E.id, u(1)]);
}

// ── api side: backend model ─────────────────────────────────────────────────

type Json = Record<string, unknown>;
const env = (data: unknown, extra: Json = {}) => ({ data, meta: { mode: "admin", ...extra } });
const err = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: code, details: null } }), { status, headers: { "content-type": "application/json" } });
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** The model pages at most MODEL_PAGE items (backends may return fewer than limit): exercises the cursor walk. */
const MODEL_PAGE = 2;
function page<T>(items: T[], url: URL): { slice: T[]; next: string | null } {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), MODEL_PAGE);
  const from = Number((url.searchParams.get("cursor") ?? "c0").slice(1));
  const slice = items.slice(from, from + limit);
  return { slice, next: from + limit < items.length ? `c${from + limit}` : null };
}
/** PostgreSQL ASC order: NULLs last, "C" collation. */
const pgAsc = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);

class BackendModel {
  accounts: Array<Account & { rowVersion: number; status: "active" | "suspended" }>;
  catalog: CatalogRowW[];
  keywords: KeywordW[];
  sources: SourceW[];
  registry: Map<string, { name: string; role: "own" | "excluded"; brand: string | null }>;
  overrides: Map<string, { category: string; note: string | null; updatedBy: string | null; updatedAt: string }>;
  props: Array<{ propertyId: string; brand: string | null; country: string | null; status: string; verifiedAt: string | null }>;
  markets: Array<{ brand: string; country: string }>;
  calls: string[] = [];

  constructor() {
    this.accounts = ACCOUNTS.map((a) => ({ ...a, rowVersion: 1, status: "active" as const }));
    this.catalog = CATALOG.map((c) => ({ ...c }));
    this.keywords = KEYWORDS.map((k) => ({ ...k }));
    this.sources = SOURCES.map((s) => ({ ...s }));
    this.registry = new Map(REGISTRY.map((r) => [r.entityId, { name: r.name, role: r.role, brand: r.role === "own" ? "Hyundai" : null }]));
    this.overrides = new Map(OVERRIDES.map((o) => [o.domain, { category: o.category, note: o.note, updatedBy: o.updatedBy, updatedAt: o.updatedAt }]));
    this.props = GA4.filter((g) => g.propertyId).map((g) => ({ propertyId: g.propertyId!, brand: g.brand, country: g.country, status: g.status, verifiedAt: g.verifiedAt }));
    this.markets = GA4.filter((g) => !g.propertyId).map((g) => ({ brand: g.brand, country: g.country }));
  }

  userItem(a: BackendModel["accounts"][number]) {
    return {
      user_id: a.id, email: a.email, role: a.role, operator: a.operator, scope_all: a.scopeAll, scope_brands: a.brands,
      scope_regions: a.regions, scope_countries: a.countries, menu_groups: null, is_qa_reviewer: false, display_name: null,
      status: a.status, row_version: a.rowVersion, created_at: apiTs(a.createdAt), updated_at: apiTs(a.createdAt),
      last_sign_in_at: a.lastSignInAt ? apiTs(a.lastSignInAt) : null,
    };
  }
  catalogItem(c: CatalogRowW) {
    return {
      prompt_id: c.id, text: c.text, prompt_type: null, category: null, brand_code: c.brand, brand_presence: null, list_type: null,
      depth1: c.depth1, depth2: c.depth2, depth3: c.depth3, depth4: null, funnel_stage: null, kind: c.kind, lang: c.lang, regions: c.regions,
      scope_prompt_id: c.scopePromptId, scope_text: c.scopeText, deleted_at: c.deletedAt ? apiTs(c.deletedAt) : null,
      status: "draft", tracked: c.scopePromptId !== null, created_at: apiTs(T(1)), updated_at: apiTs(T(1)), outbox_pending: false, outbox_error: null,
    };
  }
  write(data: Json, minimal = false) {
    // return=minimal (B075): no prompt re-read, no change ids; propagation from the outbox row.
    if (minimal) return ok(env({ applied: true, change_id: null, change_ids: [], outbox_id: 1, propagation: "pending", warnings: [], prompt: null }));
    return ok(env({ applied: true, change_id: 1, change_ids: [1], outbox_id: 1, propagation: "pending", warnings: [], ...data }));
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    this.calls.push(`${m} ${p}${url.search}`);
    const body = m === "GET" || m === "DELETE" ? {} : ((await req.json().catch(() => ({}))) as Json);
    const actor = (st.session as { user: { id: string } }).user.id;
    let hit: RegExpExecArray | null;

    // accounts
    if (p === "/v1/admin/users" && m === "GET") {
      const sorted = [...this.accounts].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
      const { slice, next } = page(sorted, url);
      return ok(env({ items: slice.map((a) => this.userItem(a)) }, { page: { next_cursor: next, limit: MODEL_PAGE } }));
    }
    if (p === "/v1/admin/users" && m === "POST") {
      const role = body.role as Role;
      const scopeAll = role === "admin" ? true : Boolean(body.scope_all);
      const brands = (body.scope_brands as string[]) ?? [];
      const countries = (body.scope_countries as string[]) ?? [];
      if (this.accounts.some((a) => a.email === body.email)) return err(409, "email_taken");
      if (!(scopeAll || role === "vendor" || brands.length > 0)) return err(422, "constraint_violation");
      if (role === "country" && !scopeAll && countries.length === 0) return err(422, "constraint_violation");
      const a = {
        id: randomUUID(), email: String(body.email), role, scopeAll, brands: scopeAll ? [] : brands, regions: scopeAll ? [] : ((body.scope_regions as string[]) ?? []),
        countries: scopeAll ? [] : countries, operator: body.operator as Account["operator"], createdAt: new Date().toISOString(), lastSignInAt: null,
        rowVersion: 1, status: "active" as const,
      };
      this.accounts.push(a);
      return ok(env({ ...this.userItem(a), temp_password: "tmp-pw" }), 201);
    }
    if ((hit = /^\/v1\/admin\/users\/([^/]+)$/.exec(p))) {
      const a = this.accounts.find((x) => x.id === hit![1]);
      if (!a) return err(404, "not_found");
      if (m === "PATCH") {
        const ifMatch = req.headers.get("if-match");
        if (!ifMatch) return err(428, "precondition_required");
        if (body.role === "vendor" && body.operator !== "none") return err(422, "vendor_operator");
        if (a.role === "admin" && body.role !== "admin") {
          if (a.id === actor) return err(409, "self_demote");
          if (!this.accounts.some((x) => x.role === "admin" && x.id !== a.id)) return err(409, "last_admin");
        }
        if (Number(ifMatch) !== a.rowVersion) return err(409, "row_version_conflict");
        Object.assign(a, {
          role: body.role, operator: body.operator, scopeAll: body.scope_all, brands: body.scope_brands, regions: body.scope_regions,
          countries: body.scope_countries, ...(body.status ? { status: body.status } : {}),
        });
        a.rowVersion += 1;
        return ok(env(this.userItem(a)));
      }
      if (m === "DELETE") {
        if (a.id === actor) return err(409, "self_delete");
        if (a.role === "admin" && !this.accounts.some((x) => x.role === "admin" && x.id !== a.id)) return err(409, "last_admin");
        if (a.referenced) return err(409, "user_referenced");
        this.accounts = this.accounts.filter((x) => x !== a);
        return ok(env({ user_id: a.id, deleted: true, succeeded_projects: [] }));
      }
    }

    // catalog
    if ((p === "/v1/admin/catalog/prompts" && m === "GET") || (p === "/v1/admin/catalog/prompts/screen" && m === "POST")) {
      const rows = [...this.catalog]
        .filter((c) => url.searchParams.get("include_deleted") === "true" || !c.deletedAt)
        .sort((a, b) => pgAsc(a.depth1, b.depth1) || pgAsc(a.depth2, b.depth2) || pgAsc(a.depth3, b.depth3) || pgAsc(a.text, b.text) || pgAsc(a.id, b.id));
      const active = this.catalog.filter((c) => !c.deletedAt);
      const tracked = active.filter((c) => c.scopePromptId).length;
      const stats = { total: active.length, tracked, untracked: active.length - tracked, scope_orphans: 1, acr: active.filter((c) => c.kind === "acr").length, deleted: this.catalog.length - active.length };
      if (p.endsWith("/screen")) {
        const sorted = [...active].sort((a, b) => pgAsc(a.depth1 ?? "~", b.depth1 ?? "~") || pgAsc(a.depth2, b.depth2) || pgAsc(a.depth3, b.depth3) || pgAsc(a.text, b.text));
        const offset = Number(body.offset ?? 0), limit = Number(body.limit ?? 200);
        return ok(env({ rows: sorted.slice(offset, offset + limit).map(c => ({ ...c, promptType: null, category: null, brandPresence: null, listType: null, depth4: null, funnelStage: null })),
          total: active.length, count: this.catalog.length, offset, limit, facets: {}, columns: [], stats }));
      }
      const { slice, next } = page(rows, url);
      return ok(env({ items: slice.map((c) => this.catalogItem(c)), stats }, { page: { next_cursor: next, limit: MODEL_PAGE } }));
    }
    if (p === "/v1/admin/catalog/markets" && m === "GET") {
      return ok(env({ bounded: MARKETS.length > 0, items: MARKETS.map((code) => ({ code, pseudo: false })) }));
    }
    if ((hit = /^\/v1\/admin\/catalog\/prompts\/([^/]+)(?:\/(kind|text|labels|regions|restore))?$/.exec(p))) {
      const c = this.catalog.find((x) => x.id === hit![1]);
      if (!c) return err(404, "not_found");
      const op = hit[2];
      if (m === "DELETE") {
        if (c.deletedAt) return err(409, "state_mismatch");
        c.deletedAt = T(20);
        return this.write({ prompt: this.catalogItem(c) }, url.searchParams.get("return") === "minimal");
      }
      if (op === "restore") {
        if (!c.deletedAt) return err(409, "state_mismatch");
        c.deletedAt = null;
        return this.write({ prompt: this.catalogItem(c) }, url.searchParams.get("return") === "minimal");
      }
      if (c.deletedAt) return err(409, "state_mismatch");
      if (op === "kind") c.kind = String(body.kind);
      if (op === "text") c.text = String(body.text);
      if (op === "labels") {
        for (const k of ["depth1", "depth2", "depth3"] as const) if (k in body) c[k] = body[k] as string | null;
        if ("brand_code" in body) c.brand = body.brand_code as string | null;
      }
      if (op === "regions") {
        if ("regions" in body) {
          const regs = body.regions as string[] | null;
          if (regs && regs.some((r) => !MARKETS.includes(r))) return err(422, "region_out_of_vocabulary");
          c.regions = regs;
        }
        if ("lang" in body) c.lang = body.lang as string | null;
      }
      return this.write({ prompt: this.catalogItem(c) }, url.searchParams.get("return") === "minimal");
    }

    // interest
    const kwItem = (k: KeywordW) => ({ keyword_id: k.id, term: k.term, source_type: k.sourceType, brand_code: k.brand, notes: k.notes, enabled: k.enabled, created_by: u(1), created_at: apiTs(k.createdAt), updated_at: apiTs(k.createdAt) });
    const srcItem = (s: SourceW) => ({ source_id: s.id, url: s.url, channel: s.channel, brand_code: s.brand, notes: s.notes, enabled: s.enabled, created_by: u(1), created_at: apiTs(s.createdAt), updated_at: apiTs(s.createdAt) });
    // Kind sorted as text (alphabetical): the adapter must restore the legacy enum order.
    const byKindThenNewest = <X extends { createdAt: string }>(kind: (x: X) => string) => (a: X, b: X) =>
      pgAsc(kind(a), kind(b)) || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
    if (p === "/v1/admin/interest/keywords" && m === "GET") {
      return ok(env({ items: [...this.keywords].sort(byKindThenNewest<KeywordW>((k) => k.sourceType)).map(kwItem) }));
    }
    if (p === "/v1/admin/interest/sources" && m === "GET") {
      return ok(env({ items: [...this.sources].sort(byKindThenNewest<SourceW>((s) => s.channel)).map(srcItem) }));
    }
    if (p === "/v1/admin/interest/keywords" && m === "POST") {
      const k: KeywordW = { id: randomUUID(), term: String(body.term), sourceType: body.source_type as KeywordW["sourceType"], brand: (body.brand_code as string) ?? null, notes: (body.notes as string) ?? null, enabled: true, createdAt: new Date().toISOString() };
      this.keywords.push(k);
      return ok(env(kwItem(k)), 201);
    }
    if (p === "/v1/admin/interest/sources" && m === "POST") {
      const s: SourceW = { id: randomUUID(), url: String(body.url), channel: body.channel as SourceW["channel"], brand: (body.brand_code as string) ?? null, notes: (body.notes as string) ?? null, enabled: true, createdAt: new Date().toISOString() };
      this.sources.push(s);
      return ok(env(srcItem(s)), 201);
    }
    if ((hit = /^\/v1\/admin\/interest\/(keywords|sources)\/([^/]+)$/.exec(p))) {
      const list = hit[1] === "keywords" ? this.keywords : this.sources;
      const row = list.find((x) => x.id === hit![2]);
      if (!row) return err(404, "not_found");
      if (m === "PATCH") {
        row.enabled = Boolean(body.enabled);
        return ok(env(hit[1] === "keywords" ? kwItem(row as KeywordW) : srcItem(row as SourceW)));
      }
      if (m === "DELETE") {
        if (hit[1] === "keywords") this.keywords = this.keywords.filter((x) => x !== row);
        else this.sources = this.sources.filter((x) => x !== row);
        return ok(env({ deleted: true }));
      }
    }

    // entity versions (E7): the world is before the v1 cutover (no active version), so the
    // entities page keeps the role editor compared here
    if (p === "/v1/admin/entities/versions" && m === "GET") {
      return ok(env({ active_ver: null, draft_ver: null, items: [] }));
    }
    // entities: per entity, all time (legacy listDiscoveredBrands, 5차 항목 1)
    if (p === "/v1/admin/entities" && m === "GET") {
      const ids = [...new Set([...MENTIONS.map((x) => x.entity), ...this.registry.keys()])];
      const entJobs = new Map<string, Set<string>>();
      const entMentions = new Map<string, number>();
      for (const x of MENTIONS) {
        (entJobs.get(x.entity) ?? entJobs.set(x.entity, new Set()).get(x.entity)!).add(x.job);
        entMentions.set(x.entity, (entMentions.get(x.entity) ?? 0) + x.count);
      }
      const items = ids.map((id) => {
        const reg = this.registry.get(id);
        const b = ENTITY_BRAND[id];
        const name = reg?.name ?? MENTIONS.find((x) => x.entity === id)!.name;
        return {
          entity_id: id, name, role: reg?.role ?? "competitor", registered: Boolean(reg), entity_type: "Brand", updated_at: null,
          brand_code: b?.code ?? null, brand_name: b?.name ?? null,
          answers: entJobs.get(id)?.size ?? 0, mentions: entMentions.get(id) ?? 0,
        };
      }).sort((a, b) => b.answers - a.answers || pgAsc(a.name, b.name));
      const { slice, next } = page(items, url);
      return ok(env({ items: slice }, { page: { next_cursor: next, limit: MODEL_PAGE } }));
    }
    if ((hit = /^\/v1\/admin\/entities\/([^/]+)$/.exec(p)) && m === "PUT") {
      const role = body.role as "own" | "excluded" | "competitor";
      if (role === "own" && !body.brand_code) return err(422, "brand_required");
      if (role === "competitor") this.registry.delete(hit[1]);
      else this.registry.set(hit[1], { name: String(body.name), role, brand: (body.brand_code as string) ?? null });
      return ok(env({ entity_id: hit[1], role, name: body.name, brand_code: body.brand_code ?? null, applied: true, change_id: 2, propagation: "pending", warnings: ["full_rebuild"] }));
    }

    // citation overrides (classification = the shared categorizer rules; "social" = backend layer)
    if (p === "/v1/admin/citation-overrides/candidates" && m === "GET") {
      const counts = new Map<string, number>();
      for (const d of CITED) counts.set(normalizeCitationDomain(d), (counts.get(normalizeCitationDomain(d)) ?? 0) + 1);
      for (const d of this.overrides.keys()) if (!counts.has(d)) counts.set(d, 0);
      const omap = new Map([...this.overrides.entries()].map(([d, o]) => [d, o.category] as const));
      const items = [...counts.entries()].map(([domain, citations]) => {
        const row = buildCurationRow(domain, citations, omap as never, this.overrides.get(domain) as never);
        const o = this.overrides.get(domain);
        const slug = (name: string) => name;
        return {
          domain, citations, in_dim_source: true,
          category: { key: 1, name: row.category, slug: slug(row.category) },
          source: SOCIAL_DOMAINS.has(domain) && row.source !== "override" ? "social" : row.source,
          shadows_owned: row.shadowsOwned,
          override: o ? { category: { key: 1, name: o.category, slug: o.category }, note: o.note, propagated: true, updated_at: apiTs(o.updatedAt), updated_by: o.updatedBy } : null,
        };
      }).sort((a, b) => b.citations - a.citations || pgAsc(a.domain, b.domain));
      return ok(env({ items }));
    }
    if ((hit = /^\/v1\/admin\/citation-overrides\/([^/]+)$/.exec(p))) {
      const d = normalizeCitationDomain(decodeURIComponent(hit[1]));
      if (m === "PUT") {
        this.overrides.set(d, { category: String(body.category), note: (body.note as string) ?? null, updatedBy: actor, updatedAt: T(21) });
        return ok(env({ domain: d, category: { key: 1, name: body.category, slug: body.category }, note: body.note ?? null, change_id: 3, propagation: "pending", updated_at: apiTs(T(21)), updated_by: actor }));
      }
      if (m === "DELETE") {
        if (!this.overrides.has(d)) return err(404, "not_found");
        this.overrides.delete(d);
        return ok(env({ domain: d, change_id: 4, propagation: "pending", reverted: true }));
      }
    }

    // GA4
    const propItem = (x: BackendModel["props"][number]) => ({
      property_id: x.propertyId, brand_code: x.brand, country_code: x.country, status: x.status, verified_at: x.verifiedAt ? apiTs(x.verifiedAt) : null,
      tracked_events: 0, loaded: false, conv_basis: null, pending: [], project_overrides: [], updated_at: apiTs(T(1)), updated_by: null, updated_by_email: null,
    });
    if (p === "/v1/admin/ga4/properties" && m === "GET") {
      // fields=registry (B072): the registry columns only, the rest null
      const registry = url.searchParams.get("fields") === "registry";
      const item = (x: BackendModel["props"][number]) =>
        registry ? { ...propItem(x), tracked_events: null, loaded: null, conv_basis: null, pending: null, project_overrides: null } : propItem(x);
      return ok(env({ items: [...this.props].sort((a, b) => pgAsc(a.brand, b.brand) || pgAsc(a.country, b.country)).map(item) }));
    }
    if (p === "/v1/admin/ga4/markets" && m === "GET") {
      return ok(env({ items: [...this.markets].sort((a, b) => pgAsc(a.brand, b.brand) || pgAsc(a.country, b.country)).map((x) => ({ brand_code: x.brand, country_code: x.country, note: null, updated_at: apiTs(T(1)), updated_by: null, updated_by_email: null })) }));
    }
    if (p === "/v1/admin/ga4/project-overrides" && m === "GET") {
      const items = GA4_PROJECTS.filter((x) => x.ga4)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((x) => ({ project_id: x.id, name: x.name, brand_code: x.brand, country_code: x.country, property_id: x.ga4, kind: "customer", created_at: apiTs(x.createdAt), registered: this.props.some((q) => q.propertyId === x.ga4), property_status: null }));
      const { slice, next } = page(items, url);
      return ok(env({ items: slice }, { page: { next_cursor: next, limit: MODEL_PAGE } }));
    }
    if ((hit = /^\/v1\/admin\/ga4\/markets\/([^/]+)\/([^/]+)$/.exec(p))) {
      const [brand, country] = [decodeURIComponent(hit[1]), hit[2]];
      if (m === "PUT") {
        if (this.props.some((x) => x.brand === brand && x.country === country)) return err(409, "market_taken");
        if (!this.markets.some((x) => x.brand === brand && x.country === country)) this.markets.push({ brand, country });
        return ok(env({ created: true, market: { brand_code: brand, country_code: country, note: null, updated_at: apiTs(T(1)) } }));
      }
      if (m === "DELETE") {
        const before = this.markets.length;
        this.markets = this.markets.filter((x) => !(x.brand === brand && x.country === country));
        return before === this.markets.length ? err(404, "not_found") : ok(env({ brand_code: brand, country_code: country, deleted: true }));
      }
    }
    if ((hit = /^\/v1\/admin\/ga4\/properties\/(\d+)$/.exec(p))) {
      const pid = hit[1];
      const cur = this.props.find((x) => x.propertyId === pid);
      if (m === "PUT") {
        const brand = (body.brand_code as string) ?? null;
        const country = (body.country_code as string) ?? null;
        if (this.props.some((x) => x.propertyId !== pid && x.brand === brand && x.country === country)) return err(409, "market_taken");
        const next = cur ?? { propertyId: pid, brand, country, status: "pending_grant", verifiedAt: null };
        Object.assign(next, { brand, country });
        if (body.verify) Object.assign(next, { status: "active", verifiedAt: new Date().toISOString() });
        if (!cur) this.props.push(next);
        this.markets = this.markets.filter((x) => !(x.brand === brand && x.country === country));
        const minimal = url.searchParams.get("return") === "minimal"; // B072: no property re-read
        return ok(env({ property: minimal ? null : propItem(next), verified: body.verify ? true : null, change_id: 5, propagation: "pending", pending_market_cleared: false }));
      }
      if (m === "DELETE") {
        if (!cur) return err(404, "not_found");
        this.props = this.props.filter((x) => x !== cur);
        return ok(env({ property_id: pid, deleted: true, change_id: 6, removed_tracked_events: 0, project_overrides: 0, propagation: "pending" }));
      }
    }
    return err(599, `unmodelled ${m} ${p}`);
  }
}

let model: BackendModel;

// ── harness ─────────────────────────────────────────────────────────────────

type Source = "legacy" | "api";
function asSource(source: Source): void {
  vi.stubEnv("HGH_SOURCE_G7", source);
}
const SESSION = {
  user: { id: ADMIN_A.id, email: ADMIN_A.email, role: "admin", scope: { all: true }, operator: "global", menuGroups: null },
};

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  pg = new PGlite() as unknown as Pg;
  await pg.exec(DDL);
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

beforeEach(async () => {
  vi.stubEnv("HGH_API_BASE_URL", "https://api.hgh.test");
  vi.stubEnv("HGH_API_TRACE_FILE", "");
  vi.stubEnv("HGH_RELAY_SECRET", "");
  vi.stubEnv("SCOPE_MODE", "live");
  vi.stubEnv("SCOPE_ROOT_PROJECT_ID", u(0x999));
  st.session = SESSION;
  st.markets = MARKETS;
  await seedLegacy();
  model = new BackendModel();
  bindHghAuth({ getAccessToken: async () => TOKEN, refreshAccessToken: async () => null });
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (process.env.HGH_SOURCE_G7 !== "api") throw new Error("legacy source must not call the backend");
    return model.handle(new Request(String(input), init));
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  bindHghAuth(null);
});

/** Leaf paths where a and b differ. Arrays of different length are one difference at the array path. */
function diffPaths(a: unknown, b: unknown, path = ""): string[] {
  if (Object.is(a, b)) return [];
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime() ? [] : [path];
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [path || "$"];
    return a.flatMap((x, i) => diffPaths(x, b[i], `${path}[${i}]`));
  }
  const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
  if (plain(a) && plain(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diffPaths(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return [path || "$"];
}

function findEl(node: unknown, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findEl(n, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.type === type) return el;
  return findEl(el.props.children, type);
}
function propsOf(tree: unknown, type: unknown): Record<string, unknown> {
  const el = findEl(tree, type);
  if (!el) throw new Error(`element ${String((type as { name?: string }).name)} not found`);
  const { children: _c, ...rest } = el.props;
  return rest;
}

async function run<T>(source: Source, fn: () => Promise<T>): Promise<T> {
  asSource(source);
  return withRequestScope(fn);
}
const params = { params: Promise.resolve({ locale: "ko" }) };
const omit = <T extends object>(o: T, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

// ── reads ───────────────────────────────────────────────────────────────────

async function usersScreen(source: Source) {
  return run(source, async () => {
    const page = await AdminPage(params);
    const list = await UserList({ locale: "ko" });
    return {
      header: propsOf(page, PageHeader).meta,
      form: propsOf(page, CreateUserForm),
      list: propsOf(list, UserListClient) as { users: Array<Record<string, unknown>>; selfId: string },
    };
  });
}
/** Accounts keyed by email (new accounts get random ids on each side), api-only fields split off. */
function accountsByEmail(list: { users: Array<Record<string, unknown>> }) {
  return Object.fromEntries(list.users.map((x) => [x.email as string, omit(x, ["id", "rowVersion", "status"])]));
}

describe("accounts (/admin)", () => {
  it("list, count and self id match; api rows carry rowVersion + status; the form asks role and scope only on api (D10)", async () => {
    const legacy = await usersScreen("legacy");
    const api = await usersScreen("api");
    expect(api.header).toBe(legacy.header);
    expect(api.list.selfId).toBe(legacy.list.selfId);
    expect(diffPaths(legacy.list.users.map((x) => omit(x, ["rowVersion", "status"])), api.list.users.map((x) => omit(x, ["rowVersion", "status"])))).toEqual([]);
    expect(api.list.users.every((x) => x.rowVersion === 1 && x.status === "active")).toBe(true);
    expect(legacy.list.users.every((x) => !("rowVersion" in x))).toBe(true);
    // legacy calls the backend never (fetch throws on the legacy source); the api header count and
    // the list share the same deduped pages: 3 GETs (2 per page, 5 accounts) per request.
    expect(legacy.form).toEqual({ withRoleScope: false });
    expect(api.form).toEqual({ withRoleScope: true });
    expect(legacy.list.users.find((x) => x.email === COUNTRY_C.email)).toMatchObject({
      createdAt: "2026-06-03", lastSignInAt: "2026-09-20", brands: ["Hyundai"], regions: ["HMA"], countries: ["KR"],
    });
    expect(legacy.list.users.find((x) => x.email === HQ_B.email)).toMatchObject({ brands: null, lastSignInAt: null });
  });

  it("writes: same results and resulting list; declared: DC-19 referenced delete, U11-N1 create scope", async () => {
    const results: Record<Source, unknown[]> = { legacy: [], api: [] };
    const screens: Record<Source, Record<string, unknown>> = { legacy: {}, api: {} };
    for (const source of ["legacy", "api"] as const) {
      if (source === "api") model = new BackendModel();
      const r = results[source];
      const fd = new FormData();
      fd.set("email", "new@hmg.test");
      if (source === "api") {
        fd.set("role", "country");
        fd.set("operator", "none");
        fd.append("brands", "Hyundai");
        fd.append("countries", "KR");
      }
      await run(source, async () => {
        r.push(await userActions.createUser(fd));
        const bad = new FormData();
        bad.set("email", "not-an-email");
        r.push(await userActions.createUser(bad));
        const c = { role: "region" as const, operator: "assigned" as const, scope: { scopeAll: false, brands: ["Hyundai"], regions: ["HMA"], countries: null } };
        r.push(await userActions.updateUserProfile(COUNTRY_C.id, c, 1));
        r.push(await userActions.updateUserProfile(ADMIN_A.id, { role: "hq", operator: "none", scope: { scopeAll: true, brands: null, regions: null, countries: null } }, 1));
        r.push(await userActions.updateUserProfile(VENDOR_E.id, { role: "vendor", operator: "global", scope: { scopeAll: false, brands: ["Kia"], regions: null, countries: null } }, 1));
        r.push(await userActions.deleteUser(ADMIN_A.id));
        r.push(await userActions.deleteUser(HQ_B.id));
        r.push(await userActions.deleteUser(VENDOR_E.id));
      });
      screens[source] = accountsByEmail((await usersScreen(source)).list);
    }
    const resDiff = diffPaths(results.legacy, results.api);
    expect(resDiff).toEqual(["[7].errorKey", "[7].ok"]); // DC-19: referenced account
    expect(results.legacy[7]).toEqual({ ok: true });
    expect(results.api[7]).toEqual({ ok: false, errorKey: "admin.errors.userReferenced" });
    expect(results.api.slice(0, 7)).toEqual([
      { ok: true, email: "new@hmg.test", tempPassword: "tmp-pw" },
      { ok: false, errorKey: "admin.errors.invalidEmail" },
      { ok: true },
      { ok: false, errorKey: "admin.errors.cannotDemoteSelf" },
      { ok: false, errorKey: "admin.errors.vendorOperatorForbidden" },
      { ok: false, errorKey: "admin.errors.cannotDeleteSelf" },
      { ok: true },
    ]);
    const ignoreTime = (s: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(s).map(([k, v]) => [k, omit(v as object, ["createdAt"])]));
    expect(diffPaths(ignoreTime(screens.legacy), ignoreTime(screens.api)).sort()).toEqual(
      ["e@hmg.test", "new@hmg.test.brands", "new@hmg.test.countries"].sort(),
    );
  });

  it("stale dialog: api answers rowVersionConflict and changes nothing", async () => {
    const r = await run("api", () =>
      userActions.updateUserProfile(COUNTRY_C.id, { role: "country", operator: "none", scope: { scopeAll: false, brands: ["Kia"], regions: null, countries: null } }, 9),
    );
    expect(r).toEqual({ ok: false, errorKey: "admin.errors.rowVersionConflict" });
    expect(model.accounts.find((a) => a.id === COUNTRY_C.id)?.brands).toEqual(["Hyundai"]);
  });
});

async function catalogScreen(source: Source) {
  return run(source, async () => omit(propsOf(await PromptsPage(params), StandardPromptList), ["remote"]));
}

describe("standard catalog (/admin/standards/prompts)", () => {
  it("initial active rows, whole-catalog stats and markets match", async () => {
    const legacy = await catalogScreen("legacy");
    const api = await catalogScreen("api");
    expect(diffPaths(legacy, api)).toEqual([]);
    expect((legacy.rows as Array<{ text: string }>).map((r) => r.text)).toEqual(["alpha", "beta", "delta"]);
    expect(legacy.stats).toEqual({ total: 3, tracked: 1, untracked: 2, scopeOrphans: 1, acr: 1, deleted: 1 });
    expect(legacy.markets).toEqual(["KR", "US"]);
  });

  it("writes: same results and resulting catalog; declared: DC-18 messages for a deleted row", async () => {
    const results: Record<Source, unknown[]> = { legacy: [], api: [] };
    const screens: Record<Source, unknown> = { legacy: null, api: null };
    const [p1, p2, p3, p4] = CATALOG.map((c) => c.id);
    for (const source of ["legacy", "api"] as const) {
      const r = results[source];
      await run(source, async () => {
        r.push(await standardActions.setStandardPromptKind(p1, "acr"));
        r.push(await standardActions.updateStandardPromptText(p2, "  beta2 "));
        r.push(await standardActions.updateStandardPromptText(p2, "   "));
        r.push(await standardActions.updateStandardPromptLabels(p1, { depth3: "x" }));
        r.push(await standardActions.updateStandardPromptLabels(p1, {}));
        r.push(await standardActions.updateStandardPromptRegions(p2, { regions: ["us"], lang: "en" }));
        r.push(await standardActions.updateStandardPromptRegions(p2, { regions: ["ZZZ"] }));
        r.push(await standardActions.updateStandardPromptRegions(p2, { regions: ["JP"] }));
        r.push(await standardActions.softDeleteStandardPrompt(p4));
        r.push(await standardActions.softDeleteStandardPrompt(p4));
        r.push(await standardActions.restoreStandardPrompt(p3));
        r.push(await standardActions.restoreStandardPrompt(p3));
        r.push(await standardActions.setStandardPromptKind(u(0xfff), "single"));
        r.push(await standardActions.updateStandardPromptText(p4, "on a deleted row"));
      });
      // deletedAt: the deletion instant differs per side (write time); compare deleted or not.
      const screen = await catalogScreen(source);
      screens[source] = {
        ...screen,
        rows: (screen.rows as Array<{ deletedAt: Date | null }>).map((r) => ({ ...r, deletedAt: r.deletedAt !== null })),
      };
    }
    expect(diffPaths(results.legacy, results.api)).toEqual(["[13].error"]);
    expect(results.api[13]).toEqual({ ok: false, error: "삭제된 행은 편집할 수 없습니다" });
    expect(results.api.slice(6, 8)).toEqual([
      { ok: false, error: "시장 코드 형식이 아닙니다: ZZZ" },
      { ok: false, error: "이 프로젝트의 측정 시장이 아닙니다: JP" },
    ]);
    expect(results.api[12]).toEqual({ ok: false, error: "표준 카탈로그 행을 찾을 수 없습니다" });
    expect(diffPaths(screens.legacy, screens.api)).toEqual([]);
  });
});

async function interestScreen(source: Source) {
  return run(source, async () => {
    const tree = await InterestPage(params);
    return { keywords: propsOf(tree, StandardKeywordList).rows, sources: propsOf(tree, StandardSourceList).rows };
  });
}

describe("customer-interest sources (/admin/standards/customer-interest)", () => {
  it("keyword and source rows match (kind, then newest first)", async () => {
    const legacy = await interestScreen("legacy");
    const api = await interestScreen("api");
    expect(diffPaths(legacy, api)).toEqual([]);
    expect((legacy.keywords as Array<{ term: string }>).map((k) => k.term)).toEqual(["gv80", "ioniq", "ev6"]);
  });

  it("writes: same results and resulting lists (new ids aside)", async () => {
    const screens: Record<Source, unknown> = { legacy: null, api: null };
    const results: Record<Source, unknown[]> = { legacy: [], api: [] };
    for (const source of ["legacy", "api"] as const) {
      const r = results[source];
      await run(source, async () => {
        r.push(await standardActions.createStandardKeyword({ term: " sonata ", sourceType: "google_keyword", brand: " Hyundai ", notes: "" }));
        r.push(await standardActions.createStandardKeyword({ term: "  ", sourceType: "google_keyword" }));
        r.push(await standardActions.toggleStandardKeywordEnabled(KEYWORDS[0].id, false));
        r.push(await standardActions.deleteStandardKeyword(KEYWORDS[1].id));
        r.push(await standardActions.createStandardSource({ url: "https://c.test", channel: "community" }));
        r.push(await standardActions.createStandardSource({ url: "https://d.test", channel: "blog" as never }));
        r.push(await standardActions.deleteStandardSource(SOURCES[0].id));
      });
      const s = await interestScreen(source);
      const scrub = (rows: unknown) => (rows as Array<{ id: string }>).map((x) => ({ ...x, id: x.id.startsWith("00000000-") ? x.id : "NEW" }));
      screens[source] = { keywords: scrub(s.keywords), sources: scrub(s.sources) };
    }
    const scrubResult = (xs: unknown[]) => xs.map((x) => ((x as { value?: { id?: string } }).value?.id ? { ...(x as object), value: { id: "NEW" } } : x));
    expect(diffPaths(scrubResult(results.legacy), scrubResult(results.api))).toEqual([]);
    expect(diffPaths(screens.legacy, screens.api)).toEqual([]);
  });
});

async function entitiesScreen(source: Source) {
  return run(source, async () => propsOf(await EntitiesPage(params), EntityCatalog));
}
const byEntity = (rows: unknown) =>
  Object.fromEntries((rows as Array<Record<string, unknown>>).map((r) => [r.entityId as string, omit(r, ["entityId", "brandCode", "brandName"])]));

describe("entity registry (/admin/standards/entities)", () => {
  it("same entities, names, roles and numbers (per entity, all time = legacy listDiscoveredBrands; DC-13 retired, 5차 항목 1)", async () => {
    const legacy = await entitiesScreen("legacy");
    const api = await entitiesScreen("api");
    expect(legacy.source).toBe("legacy");
    expect(api.source).toBe("api");
    expect(diffPaths(byEntity(legacy.rows), byEntity(api.rows))).toEqual([]);
    expect(byEntity(legacy.rows)[E1]).toMatchObject({ mentions: 4, answers: 2, role: "own" });
    expect(byEntity(api.rows)[E1]).toMatchObject({ mentions: 4, answers: 2, role: "own" });
    expect(byEntity(api.rows)[E4]).toEqual({ name: "Noise", mentions: 0, answers: 0, role: "excluded" });
    expect((api.rows as Array<{ entityId: string; brandCode: string | null }>).find((r) => r.entityId === E2)?.brandCode).toBe("Kia");
  });

  it("role writes: same results and roles; own needs a brand code on api (U11-N2)", async () => {
    const results: Record<Source, unknown[]> = { legacy: [], api: [] };
    const roles: Record<Source, unknown> = { legacy: null, api: null };
    for (const source of ["legacy", "api"] as const) {
      const r = results[source];
      await run(source, async () => {
        r.push(await entityActions.setEntityRole(E2, "Kia", "own", "Kia"));
        r.push(await entityActions.setEntityRole(E1, "Hyundai", "competitor"));
        r.push(await entityActions.setEntityRole(E3, "  ", "excluded"));
      });
      const rows = byEntity((await entitiesScreen(source)).rows);
      roles[source] = Object.fromEntries(Object.entries(rows).map(([id, x]) => [id, x.role]));
    }
    expect(diffPaths(results.legacy, results.api)).toEqual([]);
    expect(diffPaths(roles.legacy, roles.api)).toEqual([]);
    const noBrand = await run("api", () => entityActions.setEntityRole(E3, "Hyundai N", "own"));
    expect(noBrand).toEqual({ ok: false, error: "자사 지정에는 브랜드가 필요합니다" });
  });
});

async function citationScreen(source: Source) {
  return run(source, async () => propsOf(await CitationPage(params), DomainList));
}
const byDomain = (rows: unknown) => Object.fromEntries((rows as Array<Record<string, unknown>>).map((r) => [r.domain as string, omit(r, ["domain"])]));

describe("citation sources (/admin/standards/citation-sources)", () => {
  it("same domains, weights, categories and override info; declared: the backend 'social' layer", async () => {
    const legacy = await citationScreen("legacy");
    const api = await citationScreen("api");
    expect(diffPaths(omit(legacy, ["rows", "source"]), omit(api, ["rows", "source"]))).toEqual([]);
    expect(diffPaths(byDomain(legacy.rows), byDomain(api.rows))).toEqual(["youtube.com.source"]);
    expect(byDomain(api.rows)["youtube.com"].source).toBe("social");
    expect((legacy.rows as Array<{ domain: string }>).map((r) => r.domain)).toEqual((api.rows as Array<{ domain: string }>).map((r) => r.domain));
    expect(byDomain(legacy.rows)["hyundai.com"]).toMatchObject({ citations: 3, source: "owned" });
    expect(byDomain(legacy.rows)["reddit.com"]).toMatchObject({ source: "override", category: "News & Media", overrideNote: "fix" });
  });

  it("set / clear: same results and resulting rows (updatedAt aside)", async () => {
    const results: Record<Source, unknown[]> = { legacy: [], api: [] };
    const rows: Record<Source, unknown> = { legacy: null, api: null };
    for (const source of ["legacy", "api"] as const) {
      const r = results[source];
      await run(source, async () => {
        r.push(await citationActions.setCitationDomainCategory("example-blog.test", "Blogs & Reviews", "  "));
        r.push(await citationActions.setCitationDomainCategory("example-blog.test", "Not a category"));
        r.push(await citationActions.setCitationDomainCategory("  ", "Other"));
        r.push(await citationActions.clearCitationDomainOverride("reddit.com"));
        r.push(await citationActions.clearCitationDomainOverride("nothing.test"));
      });
      const d = byDomain((await citationScreen(source)).rows);
      rows[source] = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, omit(v as object, ["overrideUpdatedAt", "overrideUpdatedBy"])]));
    }
    expect(diffPaths(results.legacy, results.api)).toEqual([]);
    expect(diffPaths(rows.legacy, rows.api)).toEqual(["youtube.com.source"]);
  });
});

async function ga4Screen(source: Source) {
  return run(source, async () => propsOf(await Ga4Page(params), Ga4RegistryClient));
}
const ga4Rows = (p: Record<string, unknown>) =>
  (p.rows as Array<Record<string, unknown>>).map((r) => ({ ...omit(r, ["id"]), verifiedAt: (r.verifiedAt as string | null)?.slice(0, 10) ?? null }));

describe("GA4 registry (/admin/ga4)", () => {
  it("rows (properties + property-less markets), env markets and project overrides match; api ids name the row kind", async () => {
    const legacy = await ga4Screen("legacy");
    const api = await ga4Screen("api");
    expect(diffPaths(ga4Rows(legacy), ga4Rows(api))).toEqual([]);
    expect(diffPaths(legacy.legacy, api.legacy)).toEqual([]);
    expect(diffPaths(legacy.overrides, api.overrides)).toEqual([]);
    expect((api.rows as Array<{ id: string }>).map((r) => r.id)).toEqual(["p:333", "p:111", "m:Kia:US"]);
    expect(legacy.legacy).toEqual([{ brand: "Kia", countryCode: "DE", propertyId: "444" }]);
  });

  it("writes: same results and registry; declared U11-N3: a market mapped to another property is refused", async () => {
    const results: Record<Source, unknown[]> = { legacy: [], api: [] };
    const screens: Record<Source, unknown> = { legacy: null, api: null };
    for (const source of ["legacy", "api"] as const) {
      const r = results[source];
      const before = (await ga4Screen(source)).rows as Array<{ id: string; brand: string; countryCode: string; propertyId: string | null }>;
      const genesis = before.find((x) => x.brand === "Genesis")!;
      const kia = before.find((x) => x.brand === "Kia")!;
      await run(source, async () => {
        r.push(await ga4Actions.upsertGa4Mapping({ brand: "Kia", countryCode: "fr", propertyId: "" }));
        r.push(await ga4Actions.upsertGa4Mapping({ brand: "Kia", countryCode: "fr", propertyId: "12a" }));
        r.push(await ga4Actions.verifyGa4Mapping(genesis.id, "333", { brand: genesis.brand, countryCode: genesis.countryCode }));
        r.push(await ga4Actions.importLegacyMapping("Kia", "de"));
        r.push(await ga4Actions.removeGa4Mapping(kia.id));
        r.push(await ga4Actions.upsertGa4Mapping({ brand: "Genesis", countryCode: "US", propertyId: "555" }));
      });
      screens[source] = { rows: ga4Rows(await ga4Screen(source)) };
    }
    expect(diffPaths(results.legacy, results.api)).toEqual(["[5].error", "[5].ok"]);
    expect(results.legacy[5]).toEqual({ ok: true, value: undefined });
    expect(results.api[5]).toEqual({ ok: false, error: "같은 브랜드·국가에 다른 속성이 이미 매핑돼 있습니다" });
    // U11-N3 is the only row difference: legacy swapped Genesis US to 555 (pending_grant).
    expect(diffPaths(screens.legacy, screens.api).sort()).toEqual(["rows[0].propertyId", "rows[0].status"]);
    const rows = (screens.api as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows.map((x) => `${x.brand} ${x.countryCode} ${x.propertyId ?? "-"} ${x.status}`)).toEqual([
      "Genesis US 333 active",
      "Hyundai KR 111 active",
      "Kia DE 444 pending_grant",
      "Kia FR - unmapped",
    ]);
  });
});

describe("first render call budget (D6) and in-request dedupe", () => {
  it("each page issues only its own GETs, never the same request twice; the users header and list share pages", async () => {
    const screens: Array<[string, () => Promise<unknown>, string[]]> = [
      ["users", () => usersScreen("api"), ["/v1/admin/users"]],
      ["catalog", () => catalogScreen("api"), ["/v1/admin/catalog/prompts/screen", "/v1/admin/catalog/markets"]],
      ["interest", () => interestScreen("api"), ["/v1/admin/interest/keywords", "/v1/admin/interest/sources"]],
      ["entities", () => entitiesScreen("api"), ["/v1/admin/entities", "/v1/admin/entities/versions"]],
      ["citations", () => citationScreen("api"), ["/v1/admin/citation-overrides/candidates"]],
      ["ga4", () => ga4Screen("api"), ["/v1/admin/ga4/markets", "/v1/admin/ga4/project-overrides", "/v1/admin/ga4/properties"]],
    ];
    for (const [name, load, endpoints] of screens) {
      model.calls = [];
      await load();
      const paths = [...new Set(model.calls.map((c) => c.split(" ")[1].split("?")[0]))].sort();
      expect({ name, paths }).toEqual({ name, paths: [...endpoints].sort() });
      expect(model.calls.every((c) => c.startsWith("GET ") || c === "POST /v1/admin/catalog/prompts/screen")).toBe(true);
      expect(new Set(model.calls).size).toBe(model.calls.length);
    }
    // 5 accounts, 2 per model page: 3 cursor pages, once for the header and the list together.
    model.calls = [];
    await usersScreen("api");
    expect(model.calls).toEqual([
      "GET /v1/admin/users?limit=200",
      "GET /v1/admin/users?cursor=c2&limit=200",
      "GET /v1/admin/users?cursor=c4&limit=200",
    ]);
    // Query shapes the backend documents: global surface, include_deleted, answers desc.
    model.calls = [];
    await entitiesScreen("api");
    await citationScreen("api");
    await catalogScreen("api");
    expect(model.calls).toContain("GET /v1/admin/entities?limit=500&sort=answers_desc&surface=global");
    expect(model.calls).toContain("GET /v1/admin/citation-overrides/candidates?limit=500&surface=global");
    expect(model.calls).toContain("POST /v1/admin/catalog/prompts/screen");
  });
});

describe("permissions (both sources)", () => {
  it("a non-admin session is refused before any backend call; pages redirect", async () => {
    for (const source of ["legacy", "api"] as const) {
      st.session = { user: { ...SESSION.user, id: COUNTRY_C.id, role: "country", scope: { all: false, countries: ["KR"] } } };
      const calls = model.calls.length;
      await expect(run(source, () => userActions.deleteUser(HQ_B.id))).rejects.toThrow(/admin/);
      await expect(run(source, () => standardActions.softDeleteStandardPrompt(CATALOG[0].id))).rejects.toThrow(/admin/);
      await expect(run(source, () => entityActions.setEntityRole(E1, "Hyundai", "competitor"))).rejects.toThrow(/role=admin/);
      await expect(run(source, () => citationActions.clearCitationDomainOverride("reddit.com"))).rejects.toThrow(/role=admin/);
      await expect(run(source, () => ga4Actions.removeGa4Mapping("p:111"))).rejects.toThrow(/role=admin/);
      await expect(run(source, () => AdminPage(params))).rejects.toThrow("REDIRECT:/ko/no-access");
      await expect(run(source, () => Ga4Page(params))).rejects.toThrow("REDIRECT:/ko/dashboard");
      expect(model.calls.length).toBe(calls);
      st.session = SESSION;
    }
  });

  it("api: a backend 403 on a write throws (legacy requireAdmin threw), a 401 on a page goes to login", async () => {
    const orig = model.handle.bind(model);
    model.handle = async (req) => (req.method === "GET" ? err(401, "token_expired") : err(403, "admin_only"));
    await expect(run("api", () => standardActions.softDeleteStandardPrompt(CATALOG[0].id))).rejects.toThrow(/admin_only/);
    await expect(run("api", () => AdminPage(params))).rejects.toThrow("REDIRECT:/ko/login");
    await expect(run("api", () => EntitiesPage(params))).rejects.toThrow("REDIRECT:/ko/login");
    model.handle = orig;
  });

  it("api: entity, citation and GA4 registry 5xx propagate instead of becoming empty success", async () => {
    model.handle = async () => err(503, "unavailable");
    await expect(entitiesScreen("api")).rejects.toMatchObject({ status: 503 });
    await expect(citationScreen("api")).rejects.toMatchObject({ status: 503 });
    await expect(ga4Screen("api")).rejects.toMatchObject({ status: 503 });
  });
});

describe("partial backend failures degrade per part, as legacy (M1, M5)", () => {
  /** The model with one path answering 503. */
  function failPath(prefix: string) {
    const orig = model.handle.bind(model);
    model.handle = async (req) => (new URL(req.url).pathname.startsWith(prefix) ? err(503, "unavailable") : orig(req));
  }

  it("catalog: a failed market vocabulary reads as [] alone; the list still renders (legacy rootMarketVocabulary)", async () => {
    const legacy = await catalogScreen("legacy");
    failPath("/v1/admin/catalog/markets");
    const api = await catalogScreen("api");
    // Legacy with the Scope project read failing answers [] too (null -> []).
    expect(diffPaths(omit(legacy, ["markets"]), omit(api, ["markets"]))).toEqual([]);
    expect(api.markets).toEqual([]);
    expect(await run("api", () => standardActions.getStandardMarketVocabulary())).toEqual([]);
    // Only the list errors the page.
    model = new BackendModel();
    failPath("/v1/admin/catalog/prompts");
    await expect(catalogScreen("api")).rejects.toMatchObject({ status: 503 });
  });

  it("GA4: failed overrides alone keep the registry and the import list; a failed registry part errors the page (U11-N7)", async () => {
    const legacy = await ga4Screen("legacy");
    failPath("/v1/admin/ga4/project-overrides");
    const noOverrides = await ga4Screen("api");
    expect(diffPaths(ga4Rows(legacy), ga4Rows(noOverrides))).toEqual([]);
    expect(noOverrides.legacy).toEqual(legacy.legacy);
    expect(noOverrides.overrides).toEqual([]);
    for (const part of ["/v1/admin/ga4/properties", "/v1/admin/ga4/markets"]) {
      model = new BackendModel();
      failPath(part);
      // "Not registered" is unknown: the page's error boundary instead of an empty registry that
      // would offer every env market for import (it could only fail with market_taken or duplicate a row).
      await expect(ga4Screen("api")).rejects.toMatchObject({ status: 503 });
    }
  });
});
