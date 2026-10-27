import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement } from "react";

// Legacy <-> API parity for the project management screens and actions (unit U9). The project list
// and the member / setting / prompt pages render their screens now (components/gold-projects.tsx,
// gold-project-metadata.tsx), so the page parity left here is /projects/new and /projects/by-scope.
//
// Method (U12 / U4 precedent). One neutral WORLD (accounts, projects, memberships, audit rows,
// candidates, prompts, tags, tracked entities, owned bases, tracked URLs, engine history) is
// written twice, each in its native form:
//   legacy: rows in the legacy tables on PGlite (real PostgreSQL), read and written by the
//           UNCHANGED repositories through the unchanged legacy branch of the pages and actions;
//   api:    a backend model answering /v1/projects* in the OpenAPI shapes from the same WORLD, with
//           the documented backend semantics (visibility, ordering, error codes, file:line cited),
//           read through lib/hgh/adapters/projects.ts by the same pages and actions.
// Pages are compared on the props they hand to the screen components (the JSX tree, not rendered);
// actions on their result (or thrown error type). The set of differing paths must equal the case's
// declared KNOWN_DIFF: an unexpected difference fails, and so does a declared one that disappears.
//
// Not covered here (by design): whether the backend's migration writes the same rows, and the
// backend's own rules (its tests own them). The model returns what the backend code answers.

const st = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
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
vi.mock("@/i18n/navigation", () => ({
  Link: function Link() {
    return null;
  },
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  usePathname: () => "/",
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next/cache", () => ({
  unstable_cache: <F>(fn: F) => fn,
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));
vi.mock("next-intl/server", () => ({
  setRequestLocale: () => undefined,
  getLocale: async () => "ko",
  getTranslations: async () => (k: string) => k,
}));
// Live Scope calls of the legacy path (outside the compared data): no-ops.
vi.mock("@/lib/scope/server", () => ({
  diagnoseProjectAnalysisConnection: async () => ({ overall: "healthy", mention: { state: "ok" }, citation: { state: "ok" } }),
  updatePrompt: async () => undefined,
}));
vi.mock("@/lib/scope/project-sync", () => ({
  createScopeMirror: async () => ({ status: "skipped" }),
  attachScopeMirror: async () => undefined,
  pushScopeUpdate: async () => ({}),
  deleteScopeMirror: async () => undefined,
  syncScopeSchedule: async () => ({ pushed: true }),
  pushDraftPromptsToScope: async () => ({ pushedCount: 0, pushedIds: [], failedCount: 0, skipped: true }),
}));
vi.mock("@/lib/audit", () => ({ auditDataAccess: () => undefined, auditScopeCall: () => undefined }));

const { withRequestScope } = await import("@/test/request-scope");
const { bindHghAuth } = await import("@/lib/hgh/auth");
const { UnauthorizedError } = await import("@/lib/auth/errors");
const NewProjectPage = (await import("@/app/[locale]/(dash)/projects/new/page")).default;
const ByScopePage = (await import("@/app/[locale]/(dash)/projects/by-scope/[scopeId]/page")).default;
const memberActions = await import("@/app/[locale]/(dash)/projects/[id]/member/_actions");
const settingActions = await import("@/app/[locale]/(dash)/projects/[id]/setting/_actions");
const promptActions = await import("@/app/[locale]/(dash)/projects/[id]/prompt/_actions");
const newActions = await import("@/app/[locale]/(dash)/projects/new/_actions");
const { NewProjectForm } = await import("@/app/[locale]/(dash)/projects/new/_form");

// ── WORLD ───────────────────────────────────────────────────────────────────

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const T = (day: number, h = 0) => new Date(Date.UTC(2026, 5, day, h, 0, 0, 123)).toISOString();
/** Backend timestamp form (microseconds, +00:00): the adapter must fold it to Date#toISOString. */
const apiTs = (iso: string) => iso.replace("Z", "456+00:00");

type Role = "admin" | "hq" | "country";
interface Account {
  id: string;
  email: string;
  role: Role;
  operator: "global" | "assigned" | "none";
}
const ADMIN: Account = { id: u(1), email: "admin@hmg.test", role: "admin", operator: "global" };
const OWNER: Account = { id: u(2), email: "owner@hmg.test", role: "hq", operator: "global" };
const VIEWER: Account = { id: u(3), email: "viewer@hmg.test", role: "country", operator: "assigned" };
const INVITEE: Account = { id: u(4), email: "invitee@hmg.test", role: "country", operator: "none" };
const OUTSIDER: Account = { id: u(5), email: "outsider@hmg.test", role: "country", operator: "none" };
const ACCOUNTS = [ADMIN, OWNER, VIEWER, INVITEE, OUTSIDER];

const ROOT = "00000000-0000-4000-8000-00000000a000";
const PA = u(0x100);
const PB = u(0x101);
const SCOPE_A = u(0x900);
const SCOPE_SITE = u(0x901);
const SCOPE_SITE_HIDDEN = u(0x902);

interface Project {
  id: string;
  name: string;
  description: string | null;
  domain: string | null;
  brand: string | null;
  country: string;
  scopeProjectId: string | null;
  ga4: string | null;
  engines: string[] | null;
  createdBy: string;
  createdAt: string;
  kind: "customer" | "standard_root";
}
const PROJECTS: Project[] = [
  { id: ROOT, name: "Global root", description: null, domain: null, brand: null, country: "KR", scopeProjectId: null, ga4: null, engines: null, createdBy: ADMIN.id, createdAt: T(1), kind: "standard_root" },
  { id: PA, name: "Kia US", description: "US site", domain: "kia.com/us", brand: "Kia", country: "US", scopeProjectId: SCOPE_A, ga4: "123", engines: ["chatgpt", "gemini"], createdBy: OWNER.id, createdAt: T(2), kind: "customer" },
  { id: PB, name: "Genesis AE", description: null, domain: null, brand: "Genesis", country: "AE", scopeProjectId: null, ga4: null, engines: null, createdBy: VIEWER.id, createdAt: T(3), kind: "customer" },
];

interface Membership {
  id: string;
  projectId: string;
  userId: string;
  role: "owner" | "viewer";
  status: "pending" | "active";
  invitedBy: string;
  invitedAt: string;
}
const MEMBERS: Membership[] = [
  { id: u(0x200), projectId: PA, userId: OWNER.id, role: "owner", status: "active", invitedBy: OWNER.id, invitedAt: T(2, 1) },
  { id: u(0x201), projectId: PA, userId: VIEWER.id, role: "viewer", status: "active", invitedBy: OWNER.id, invitedAt: T(2, 2) },
  { id: u(0x202), projectId: PA, userId: INVITEE.id, role: "viewer", status: "pending", invitedBy: OWNER.id, invitedAt: T(4, 3) },
  { id: u(0x203), projectId: PB, userId: VIEWER.id, role: "owner", status: "active", invitedBy: VIEWER.id, invitedAt: T(3, 1) },
  { id: u(0x204), projectId: PB, userId: OWNER.id, role: "viewer", status: "active", invitedBy: VIEWER.id, invitedAt: T(3, 2) },
  { id: u(0x205), projectId: PB, userId: INVITEE.id, role: "viewer", status: "pending", invitedBy: VIEWER.id, invitedAt: T(5, 1) },
];

const AUDIT = [
  { id: u(0x300), projectId: PA, actorId: OWNER.id, targetUserId: VIEWER.id, action: "invite", context: "role=viewer", createdAt: T(2, 2) },
  { id: u(0x301), projectId: PA, actorId: VIEWER.id, targetUserId: VIEWER.id, action: "accept", context: null, createdAt: T(2, 3) },
  { id: u(0x302), projectId: PA, actorId: OWNER.id, targetUserId: INVITEE.id, action: "invite", context: "role=viewer", createdAt: T(4, 3) },
];

const CANDIDATES = [
  { id: u(0x400), projectId: PA, source: "google_keyword", sourceKeyword: "ev9 price", text: "EV9 price?", createdAt: T(6) },
  { id: u(0x401), projectId: PA, source: "social_scraping", sourceKeyword: null, text: "Best 3-row EV?", createdAt: T(7) },
];

const PROMPTS = [
  { id: u(0x500), projectId: PA, text: "Is the EV9 good?", promptType: "information", category: "차종", brand: "Kia", status: "draft", scopePromptId: null, createdAt: T(8) },
  { id: u(0x501), projectId: PA, text: "EV9 vs Model Y", promptType: "comparison", category: null, brand: "Kia", status: "queued", scopePromptId: u(0x950), createdAt: T(9) },
  { id: u(0x502), projectId: PA, text: "Best EV in US", promptType: null, category: null, brand: null, status: "paused", scopePromptId: u(0x951), createdAt: T(10) },
  { id: u(0x503), projectId: PB, text: "GV80 review", promptType: null, category: null, brand: "Genesis", status: "running", scopePromptId: u(0x952), createdAt: T(11) },
];
const FIELDS = [
  { id: u(0x600), projectId: PA, label: "Segment", archived: false, createdAt: T(6) },
  { id: u(0x601), projectId: PA, label: "Old", archived: true, createdAt: T(7) },
];
const VALUES = [{ promptId: u(0x500), fieldId: u(0x600), value: "SUV" }];

const COMPETITORS = [
  { id: u(0x700), projectId: PA, brandName: "Honda", aliases: null as string[] | null, notes: null, isTarget: false, createdAt: T(6) },
  { id: u(0x701), projectId: PA, brandName: "Toyota", aliases: ["토요타"], notes: "main rival", isTarget: true, createdAt: T(6) },
];
const VEHICLES = [
  { id: u(0x710), projectId: PA, brand: "Kia", model: "EV9", segment: "SUV", aliases: ["이브이나인"], createdAt: T(6) },
  { id: u(0x711), projectId: PA, brand: "Toyota", model: "RAV4", segment: null, aliases: null as string[] | null, createdAt: T(6) },
];
// tracked_brands = the merged catalog: own brand (canonical + aliases) and the competitors' rows.
const TRACKED_BRANDS = [
  { id: u(0x720), projectId: PA, canonicalName: "Kia", aliases: ["Kia", "기아"] },
  { id: u(0x721), projectId: PA, canonicalName: "Toyota", aliases: ["토요타"] },
  { id: u(0x722), projectId: PA, canonicalName: "Honda", aliases: [] as string[] },
];
const OWNED = [{ id: u(0x730), projectId: PA, baseUrl: "kia.com/us", norm: "kia.com/us", label: "US", createdAt: T(6) }];
const URLS = [
  { id: u(0x740), projectId: PA, url: "https://kia.com/us/ev9", norm: "kia.com/us/ev9", label: "EV9", createdAt: T(6) },
  { id: u(0x741), projectId: PA, url: "https://kia.com/us/k5", norm: "kia.com/us/k5", label: null, createdAt: T(7) },
];
const HISTORY = [
  { id: u(0x750), projectId: PA, apiId: "11", engines: ["chatgpt"], changedAt: T(2) },
  { id: u(0x751), projectId: PA, apiId: "12", engines: ["chatgpt", "gemini"], changedAt: T(5) },
];
const SITES = [
  { brand: "Genesis", countryCode: "AE", scopeProjectId: SCOPE_SITE, visible: true },
  { brand: "Kia", countryCode: "DE", scopeProjectId: SCOPE_SITE_HIDDEN, visible: false },
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
CREATE TABLE profiles (id uuid PRIMARY KEY, email text, role text NOT NULL, scope_all boolean NOT NULL DEFAULT false,
  brands text[], regions text[], countries text[], operator text NOT NULL DEFAULT 'none', menu_groups text[],
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE projects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, description text, domain text, brand text,
  country text NOT NULL, language text, scope_project_id uuid, ga4_property_id text, ai_engines text[], created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE project_engine_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, engines text[] NOT NULL,
  changed_by uuid, changed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE project_owned_bases (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, base_url text NOT NULL,
  label text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, base_url));
CREATE TABLE project_tracked_urls (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, url text NOT NULL,
  label text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, url));
CREATE TABLE project_custom_fields (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, label text NOT NULL,
  archived boolean NOT NULL DEFAULT false, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, label));
CREATE TABLE prompt_custom_field_values (prompt_id uuid NOT NULL, field_id uuid NOT NULL, value text NOT NULL, PRIMARY KEY (prompt_id, field_id));
CREATE TABLE project_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'viewer', status text NOT NULL DEFAULT 'pending', invited_by uuid NOT NULL,
  invited_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz, UNIQUE (project_id, user_id));
CREATE TABLE member_audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, actor_id uuid NOT NULL,
  target_user_id uuid NOT NULL, action text NOT NULL, context text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE prompt_candidates (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, source text NOT NULL,
  source_keyword text, text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE prompts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, candidate_id uuid, text text NOT NULL,
  prompt_type text, category text, brand text, brand_presence text, list_type text, depth1 text, depth2 text, depth3 text, depth4 text,
  funnel_stage text, kind text NOT NULL DEFAULT 'single', lang text, regions text[], scope_prompt_id uuid,
  status text NOT NULL DEFAULT 'draft', needs_reanalysis boolean NOT NULL DEFAULT false, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, deleted_at timestamptz);
CREATE TABLE tracked_competitors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, brand_name text NOT NULL,
  aliases text[], notes text, is_target boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, brand_name));
CREATE TABLE tracked_vehicles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, brand text NOT NULL,
  model text NOT NULL, segment text, aliases text[], created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, brand, model));
CREATE TABLE tracked_brands (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid NOT NULL, canonical_name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}'::text[], created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (project_id, canonical_name));
CREATE TABLE website_sites (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), brand text NOT NULL, country_code text NOT NULL,
  scope_project_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
`;
const TABLES = [
  "profiles", "projects", "project_engine_history", "project_owned_bases", "project_tracked_urls", "project_custom_fields",
  "prompt_custom_field_values", "project_members", "member_audit_logs", "prompt_candidates", "prompts", "tracked_competitors",
  "tracked_vehicles", "tracked_brands", "website_sites",
];

async function seedLegacy(): Promise<void> {
  await pg.exec(`TRUNCATE ${TABLES.join(", ")};`);
  const q = (s: string, p: unknown[]) => pg.query(s, p);
  for (const a of ACCOUNTS) await q("INSERT INTO profiles (id, email, role, operator) VALUES ($1,$2,$3,$4)", [a.id, a.email, a.role, a.operator]);
  for (const p of PROJECTS) {
    await q(
      `INSERT INTO projects (id, name, description, domain, brand, country, scope_project_id, ga4_property_id, ai_engines, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
      [p.id, p.name, p.description, p.domain, p.brand, p.country, p.scopeProjectId, p.ga4, p.engines, p.createdBy, p.createdAt],
    );
  }
  for (const m of MEMBERS) {
    await q("INSERT INTO project_members (id, project_id, user_id, role, status, invited_by, invited_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [
      m.id, m.projectId, m.userId, m.role, m.status, m.invitedBy, m.invitedAt,
    ]);
  }
  for (const a of AUDIT) {
    await q("INSERT INTO member_audit_logs VALUES ($1,$2,$3,$4,$5,$6,$7)", [a.id, a.projectId, a.actorId, a.targetUserId, a.action, a.context, a.createdAt]);
  }
  for (const c of CANDIDATES) await q("INSERT INTO prompt_candidates VALUES ($1,$2,$3,$4,$5,$6)", [c.id, c.projectId, c.source, c.sourceKeyword, c.text, c.createdAt]);
  for (const p of PROMPTS) {
    await q(
      `INSERT INTO prompts (id, project_id, text, prompt_type, category, brand, status, scope_prompt_id, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [p.id, p.projectId, p.text, p.promptType, p.category, p.brand, p.status, p.scopePromptId, OWNER.id, p.createdAt],
    );
  }
  for (const f of FIELDS) await q("INSERT INTO project_custom_fields VALUES ($1,$2,$3,$4,$5,$6)", [f.id, f.projectId, f.label, f.archived, OWNER.id, f.createdAt]);
  for (const v of VALUES) await q("INSERT INTO prompt_custom_field_values VALUES ($1,$2,$3)", [v.promptId, v.fieldId, v.value]);
  for (const c of COMPETITORS) await q("INSERT INTO tracked_competitors VALUES ($1,$2,$3,$4,$5,$6,$7)", [c.id, c.projectId, c.brandName, c.aliases, c.notes, c.isTarget, c.createdAt]);
  for (const v of VEHICLES) await q("INSERT INTO tracked_vehicles VALUES ($1,$2,$3,$4,$5,$6,$7)", [v.id, v.projectId, v.brand, v.model, v.segment, v.aliases, v.createdAt]);
  for (const b of TRACKED_BRANDS) await q("INSERT INTO tracked_brands (id, project_id, canonical_name, aliases) VALUES ($1,$2,$3,$4)", [b.id, b.projectId, b.canonicalName, b.aliases]);
  for (const o of OWNED) await q("INSERT INTO project_owned_bases VALUES ($1,$2,$3,$4,$5,$6)", [o.id, o.projectId, o.baseUrl, o.label, OWNER.id, o.createdAt]);
  for (const x of URLS) await q("INSERT INTO project_tracked_urls VALUES ($1,$2,$3,$4,$5,$6)", [x.id, x.projectId, x.url, x.label, OWNER.id, x.createdAt]);
  for (const h of HISTORY) await q("INSERT INTO project_engine_history VALUES ($1,$2,$3,$4,$5)", [h.id, h.projectId, h.engines, OWNER.id, h.changedAt]);
  for (const s of SITES) await q("INSERT INTO website_sites (brand, country_code, scope_project_id) VALUES ($1,$2,$3)", [s.brand, s.countryCode, s.scopeProjectId]);
}

// ── api side: backend model (same WORLD, OpenAPI shapes) ────────────────────

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (data: unknown, extra: Record<string, unknown> = {}) => json(200, { data, meta: { mode: "crud", ...extra } });
const fail = (status: number, code: string, details: unknown = null) => json(status, { error: { code, message: "dev", details } });
const byDesc = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((a, b) => key(b).localeCompare(key(a)));
const emailOf = (id: string) => ACCOUNTS.find((a) => a.id === id)?.email ?? null;

let me: Account = OWNER;
/** Per-case backend answer for writes (what the backend code answers in this state). */
let writeAnswer: (() => Response) | null = null;

function activeRole(projectId: string, userId: string): "owner" | "viewer" | null {
  const m = MEMBERS.find((x) => x.projectId === projectId && x.userId === userId && x.status === "active");
  return m?.role ?? null;
}
/** core.auth.resolve_project(level="active_member"): admin or active member; root / unknown / others 404. */
function visible(projectId: string): Project | null {
  const p = PROJECTS.find((x) => x.id === projectId && x.kind === "customer");
  if (!p) return null;
  return me.role === "admin" || activeRole(projectId, me.id) ? p : null;
}
function listItem(p: Project) {
  const prompts = PROMPTS.filter((x) => x.projectId === p.id);
  return {
    project_id: p.id,
    name: p.name,
    description: p.description,
    domain: p.domain,
    brand_code: p.brand,
    country_code: p.country,
    scope_project_id: p.scopeProjectId,
    ga4_property_id: p.ga4,
    ai_engines: p.engines,
    effective_engines: p.engines ?? ["chatgpt", "gemini"],
    created_by: p.createdBy,
    created_at: apiTs(p.createdAt),
    updated_at: apiTs(p.createdAt),
    my_role: activeRole(p.id, me.id),
    active_member_count: MEMBERS.filter((m) => m.projectId === p.id && m.status === "active").length,
    prompt_count: prompts.length,
    prompt_in_flight_count: prompts.filter((x) => x.status === "queued" || x.status === "running").length,
  };
}

function backend(method: string, path: string, query: URLSearchParams): Response {
  if (method !== "GET" && !path.endsWith("/screen")) return writeAnswer ? writeAnswer() : fail(500, "internal");
  if (path === "/v1/projects") {
    const rows = PROJECTS.filter((p) => p.kind === "customer" && (me.role === "admin" || activeRole(p.id, me.id)));
    return ok({ items: byDesc(rows, (p) => p.createdAt).map(listItem), next_cursor: null }, { page: { limit: Number(query.get("limit")), next_cursor: null } });
  }
  if (path === "/v1/me/project-invites") {
    const rows = MEMBERS.filter((m) => m.userId === me.id && m.status === "pending");
    return ok({
      items: byDesc(rows, (m) => m.invitedAt).map((m) => ({
        project_id: m.projectId,
        project_name: PROJECTS.find((p) => p.id === m.projectId)!.name,
        brand_code: null,
        country_code: "US",
        role: m.role,
        invited_at: apiTs(m.invitedAt),
        invited_by: m.invitedBy,
        invited_by_email: emailOf(m.invitedBy),
      })),
    });
  }
  const bs = /^\/v1\/projects\/by-scope\/(.+)$/.exec(path);
  if (bs) {
    const p = PROJECTS.find((x) => x.scopeProjectId === bs[1]);
    if (p) return visible(p.id) ? ok({ kind: "project", project_id: p.id }) : fail(404, "not_found");
    const s = SITES.find((x) => x.scopeProjectId === bs[1]);
    // website_site_visible (back/app/features/projects/project/core/service.py:139): scope-gated.
    return s?.visible ? ok({ kind: "website", brand_code: s.brand, country_code: s.countryCode }) : fail(404, "not_found");
  }
  const m = /^\/v1\/projects\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return fail(404, "not_found");
  const p = visible(m[1]);
  if (!p) return fail(404, "not_found");
  const sub = m[2] ?? "";
  if (sub === "") {
    return ok({
      ...listItem(p),
      scope_linked: p.scopeProjectId !== null,
    });
  }
  if (sub === "/members") {
    const rows = MEMBERS.filter((x) => x.projectId === p.id).sort((a, b) => a.role.localeCompare(b.role) || a.invitedAt.localeCompare(b.invitedAt));
    return ok({
      items: rows.map((x) => ({ user_id: x.userId, email: emailOf(x.userId), role: x.role, status: x.status, invited_at: apiTs(x.invitedAt), invited_by: x.invitedBy })),
    });
  }
  if (sub === "/member-audit") {
    const rows = byDesc(AUDIT.filter((a) => a.projectId === p.id), (a) => a.createdAt).slice(0, Number(query.get("limit") ?? 20));
    return ok({
      items: rows.map((a, i) => ({
        audit_id: String(1000 - i),
        action: a.action,
        actor_id: a.actorId,
        target_user_id: a.targetUserId,
        actor_email: emailOf(a.actorId),
        target_email: emailOf(a.targetUserId),
        context: a.context,
        created_at: apiTs(a.createdAt),
      })),
      next_cursor: null,
    });
  }
  if (sub === "/settings") {
    const role = activeRole(p.id, me.id);
    const canEdit = me.role === "admin" || role === "owner";
    const own = TRACKED_BRANDS.find((b) => b.projectId === p.id && b.canonicalName === p.brand);
    return ok({
      project_id: p.id,
      domain: p.domain,
      my_role: role,
      can_edit: canEdit,
      engines: {
        stored: p.engines,
        effective: p.engines ?? ["chatgpt", "gemini"],
        // rd.dim_engine: every measured target code, not only the front vocabulary (#16 uses perplexity).
        allowed: ["chatgpt", "gemini", "deepseek", "perplexity"],
        can_edit: canEdit && (me.role === "admin" || me.operator === "global" || (me.operator === "assigned" && role !== null)),
      },
      owned_bases: OWNED.filter((o) => o.projectId === p.id).map((o) => ({ base_norm: o.norm, base_url: o.baseUrl, label: o.label, created_at: apiTs(o.createdAt), created_by: OWNER.id })),
      // aliases_without_canonical (tracked_targets/service.py)
      brand_aliases: { brand_code: p.brand, aliases: (own?.aliases ?? []).filter((a) => a !== p.brand) },
      competitors: COMPETITORS.filter((c) => c.projectId === p.id)
        .sort((a, b) => a.brandName.localeCompare(b.brandName))
        .map((c) => ({ brand_name: c.brandName, aliases: c.aliases ?? [], notes: c.notes, is_target: c.isTarget, created_at: apiTs(c.createdAt) })),
      vehicles: VEHICLES.filter((v) => v.projectId === p.id)
        .sort((a, b) => a.brand.localeCompare(b.brand) || a.model.localeCompare(b.model))
        .map((v) => ({ brand: v.brand, model: v.model, segment: v.segment, aliases: v.aliases ?? [], created_at: apiTs(v.createdAt) })),
      tracked_url_count: URLS.filter((x) => x.projectId === p.id).length,
    });
  }
  if (sub === "/settings/tracked-urls") {
    const rows = byDesc(URLS.filter((x) => x.projectId === p.id), (x) => x.createdAt);
    return ok({ items: rows.map((x) => ({ url_norm: x.norm, url: x.url, label: x.label, created_at: apiTs(x.createdAt), created_by: OWNER.id })), next_cursor: null, total: rows.length });
  }
  if (sub === "/settings/engines/history") {
    const rows = byDesc(HISTORY.filter((h) => h.projectId === p.id), (h) => h.changedAt);
    return ok({ items: rows.map((h) => ({ history_id: h.apiId, engines: h.engines, changed_at: apiTs(h.changedAt), changed_by: OWNER.id })), next_cursor: null });
  }
  if (sub === "/settings/scope-link") {
    return ok({ project_id: p.id, linked: true, scope_project_id: p.scopeProjectId, state: "healthy", jobs: null, latest_round: null, outbox: { pending: 0, erroring: 0, prompt_pending: 0, recent: [] } });
  }
  if (sub === "/prompt-candidates" || sub === "/prompt-candidates/screen") {
    const rows = byDesc(CANDIDATES.filter((c) => c.projectId === p.id), (c) => c.createdAt);
    const items = rows.map((c) => ({ candidate_id: c.id, source: c.source, source_keyword: c.sourceKeyword, text: c.text, created_at: apiTs(c.createdAt) }));
    return ok(sub.endsWith("/screen") ? { rows: items, ids: [], total: rows.length, offset: 0, limit: 200, show_brand: false, show_category: false, draft_count: 0, values: {} } : { items, next_cursor: null });
  }
  if (sub === "/prompts" || sub === "/prompts/screen") {
    const rows = byDesc(PROMPTS.filter((x) => x.projectId === p.id), (x) => x.createdAt);
    const items = rows.map((x) => ({
        prompt_id: x.id,
        text: x.text,
        kind: "single",
        status: x.status,
        prompt_type: x.promptType,
        category: x.category,
        brand_code: x.brand,
        lang: null,
        regions: null,
        scope_prompt_id: x.scopePromptId,
        candidate_id: null,
        tags: Object.fromEntries(VALUES.filter((v) => v.promptId === x.id).map((v) => [v.fieldId, v.value])),
        created_at: apiTs(x.createdAt),
        updated_at: apiTs(x.createdAt),
      }));
    const fields = FIELDS.filter(f => f.projectId === p.id);
    return ok(sub.endsWith("/screen") ? {
      rows: items.reverse(), ids: [], total: rows.length, offset: 0, limit: 200,
      show_brand: rows.some(r => !!r.brand), show_category: rows.some(r => !!r.category),
      draft_count: rows.filter(r => r.status === "draft" || (r.status === "queued" && !r.scopePromptId)).length,
      values: Object.fromEntries(fields.map(f => [f.id, [...new Set(VALUES.filter(v => v.fieldId === f.id && v.value).map(v => v.value))]]).filter(([, values]) => (values as string[]).length)),
    } : { items });
  }
  if (sub === "/prompt-fields") {
    return ok({
      items: FIELDS.filter((f) => f.projectId === p.id).map((f) => ({
        field_id: f.id,
        label: f.label,
        archived: f.archived,
        value_count: VALUES.filter((v) => v.fieldId === f.id).length,
        created_at: apiTs(f.createdAt),
      })),
    });
  }
  return fail(404, "not_found");
}

// ── harness ─────────────────────────────────────────────────────────────────

type Source = "legacy" | "api";
function as(source: Source, account: Account, scope: Record<string, unknown> = { all: true }) {
  vi.stubEnv("HGH_SOURCE_G6", source);
  me = account;
  st.session = {
    user: { id: account.id, email: account.email, role: account.role, operator: account.operator, menuGroups: null, scope },
  };
}

function* walk(node: unknown): Generator<ReactElement> {
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n);
    return;
  }
  if (!isValidElement(node)) return;
  yield node;
  for (const v of Object.values((node.props ?? {}) as Record<string, unknown>)) yield* walk(v);
}
function propsOf(tree: unknown, type: unknown): Record<string, unknown>[] {
  return [...walk(tree)].filter((e) => e.type === type).map((e) => e.props as Record<string, unknown>);
}
const without = (o: Record<string, unknown> | undefined, ...keys: string[]) => {
  if (!o) return o;
  const c = { ...o };
  for (const k of keys) delete c[k];
  return c;
};

/** Leaf paths where a and b differ. */
function diff(a: unknown, b: unknown, path = ""): string[] {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime() ? [] : [path];
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: string[] = [];
    if (a.length !== b.length) out.push(`${path}.length`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) out.push(...diff(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => diff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`));
  }
  return Object.is(a, b) ? [] : [path];
}

/** Every diff path matches a declared pattern, and every declared pattern matches a diff. */
function expectDiff(legacy: unknown, api: unknown, known: Record<string, string>) {
  const paths = diff(legacy, api);
  const patterns = Object.keys(known).map((k) => [k, new RegExp(k)] as const);
  const unexpected = paths.filter((p) => !patterns.some(([, re]) => re.test(p)));
  const vanished = patterns.filter(([, re]) => !paths.some((p) => re.test(p))).map(([k]) => k);
  expect({ unexpected, vanished }).toEqual({ unexpected: [], vanished: [] });
}

async function render(source: Source, account: Account, page: () => Promise<unknown>, scope?: Record<string, unknown>): Promise<unknown> {
  as(source, account, scope);
  try {
    return await withRequestScope(page);
  } catch (e) {
    return { thrown: e instanceof Error ? e.message : String(e) };
  }
}

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve({ locale: "ko", ...p }) });

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
  vi.stubEnv("SCOPE_ROOT_PROJECT_ID", "");
  bindHghAuth({ getAccessToken: async () => "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln" });
  writeAnswer = null;
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    return backend(String(init.method ?? "GET"), url.pathname, url.searchParams);
  });
  await seedLegacy();
});

// ── pages ───────────────────────────────────────────────────────────────────

describe("/projects/new", () => {
  it("scoped account: same brand / country choices in the same order, same lock", async () => {
    const scope = { all: false, brands: ["Kia"], regions: undefined, countries: ["US", "DE", "KR"] };
    // creation_options (project/core/service.py:185): account brands in stored order; countries = account
    // countries in stored order filtered by the brand's regions; brand_locked = not all and 1 brand.
    writeAnswer = null;
    const legacyTree = await render("legacy", OWNER, () => NewProjectPage(params({})), scope);
    vi.stubGlobal("fetch", async (input: string) =>
      new URL(String(input)).pathname === "/v1/projects/creation-options"
        ? ok({ brands: ["Kia"], countries: ["US", "DE", "KR"], brand_locked: true, engines: ["chatgpt", "gemini", "deepseek"], default_engines: ["chatgpt", "gemini"] })
        : fail(404, "not_found"),
    );
    const apiTree = await render("api", OWNER, () => NewProjectPage(params({})), scope);
    const pick = (t: unknown) => without(propsOf(t, NewProjectForm)[0], "locale");
    expectDiff(pick(legacyTree), pick(apiTree), {});
  });

  it("all-brand account: the API's sort_order brands come back in the legacy GEO_BRANDS order", async () => {
    const legacyTree = await render("legacy", OWNER, () => NewProjectPage(params({})), { all: true });
    const legacyForm = propsOf(legacyTree, NewProjectForm)[0];
    vi.stubGlobal("fetch", async () =>
      ok({
        brands: ["Hyundai", "Kia", "Genesis"],
        countries: [...(legacyForm.allowedCountries as string[])].sort(),
        brand_locked: false,
        engines: ["chatgpt"],
        default_engines: ["chatgpt"],
      }),
    );
    const apiTree = await render("api", OWNER, () => NewProjectPage(params({})), { all: true });
    expectDiff(without(legacyForm, "locale"), without(propsOf(apiTree, NewProjectForm)[0], "locale"), {});
  });

  it("non-creator: both send the user back to the list (front gate; backend 403 operator_forbidden)", async () => {
    vi.stubGlobal("fetch", async () => fail(403, "operator_forbidden"));
    expect(await render("legacy", VIEWER, () => NewProjectPage(params({})))).toEqual({ thrown: "REDIRECT:/ko/projects" });
    expect(await render("api", VIEWER, () => NewProjectPage(params({})))).toEqual({ thrown: "REDIRECT:/ko/projects" });
  });
});

describe("/projects/by-scope/[scopeId]", () => {
  const go = (source: Source, account: Account, scopeId: string) => render(source, account, () => ByScopePage(params({ scopeId })));
  it("project link, visible website site, unknown id: same redirect / notFound", async () => {
    for (const [account, id] of [
      [OWNER, SCOPE_A],
      [OWNER, SCOPE_SITE],
      [OWNER, u(0x999)],
    ] as const) {
      expect(await go("api", account, id)).toEqual(await go("legacy", account, id));
    }
    expect(await go("api", OWNER, SCOPE_A)).toEqual({ thrown: `REDIRECT:/ko/projects/${PA}` });
    expect(await go("api", OWNER, SCOPE_SITE)).toEqual({ thrown: "REDIRECT:/ko/website?geography=AE&brand=Genesis" });
  });
  it("U9-N2: a site outside the account's website scope is notFound (legacy redirected to /website)", async () => {
    expect(await go("legacy", OWNER, SCOPE_SITE_HIDDEN)).toEqual({ thrown: "REDIRECT:/ko/website?geography=DE&brand=Kia" });
    expect(await go("api", OWNER, SCOPE_SITE_HIDDEN)).toEqual({ thrown: "NOT_FOUND" });
  });
  it("a project the viewer may not open: legacy redirects and the detail 404s; api 404s at once (same end)", async () => {
    expect(await go("legacy", OUTSIDER, SCOPE_A)).toEqual({ thrown: `REDIRECT:/ko/projects/${PA}` });
    expect(await go("api", OUTSIDER, SCOPE_A)).toEqual({ thrown: "NOT_FOUND" });
  });
});

// ── actions ─────────────────────────────────────────────────────────────────

type Outcome = { ok: boolean; error?: string } | { threw: string };
async function outcome(source: Source, account: Account, call: () => Promise<unknown>): Promise<Outcome> {
  as(source, account);
  try {
    const r = (await call()) as { ok: boolean; error?: string };
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (e) {
    if (e instanceof UnauthorizedError) return { threw: "UnauthorizedError" };
    const msg = e instanceof Error ? e.message : String(e);
    // A database error of the legacy path (drizzle wraps it: "Failed query: ...") is one outcome.
    return { threw: msg.startsWith("Failed query:") ? "database error" : msg };
  }
}

interface ActionCase {
  name: string;
  account: Account;
  call: () => Promise<unknown>;
  /** What the backend answers in this WORLD state (status, code, details) with its source line. */
  backend: [number, string, unknown?] | "ok";
  /** Declared difference: [legacy outcome, api outcome, reason]. */
  known?: [Outcome, Outcome, string];
}

const ok204 = () => new Response(null, { status: 204 });
const ACTIONS: ActionCase[] = [
  // members/roster/service.py self_invite, invitee_not_found, already_member_error (active already_member, pending already_invited)
  { name: "invite self", account: OWNER, call: () => memberActions.inviteMember(PA, "Owner@hmg.test "), backend: [400, "self_invite"] },
  { name: "invite unknown email", account: OWNER, call: () => memberActions.inviteMember(PA, "nobody@hmg.test"), backend: [404, "invitee_not_found"] },
  { name: "invite active member", account: OWNER, call: () => memberActions.inviteMember(PA, "viewer@hmg.test"), backend: [409, "already_member", { status: "active" }] },
  { name: "invite pending member", account: OWNER, call: () => memberActions.inviteMember(PA, "invitee@hmg.test"), backend: [409, "already_invited", { status: "pending" }] },
  { name: "invite bad email", account: OWNER, call: () => memberActions.inviteMember(PA, "not-an-email"), backend: [422, "unprocessable"] },
  { name: "invite as viewer", account: VIEWER, call: () => memberActions.inviteMember(PA, "outsider@hmg.test"), backend: [403, "owner_only"] },
  { name: "invite success", account: OWNER, call: () => memberActions.inviteMember(PA, "outsider@hmg.test"), backend: "ok" },
  // roster/service.py:84 cannot_remove_owner, :86 cannot_remove_self (after the owner check)
  {
    name: "remove owner",
    account: VIEWER,
    call: () => memberActions.removeMember(PB, currentId(PB, VIEWER.id)),
    backend: [409, "cannot_remove_owner"],
  },
  // invites/service.py:21 no_pending_invite
  { name: "accept a non-pending invite", account: VIEWER, call: () => memberActions.acceptInvite(currentPending(PA, VIEWER.id)), backend: [404, "no_pending_invite"] },
  { name: "accept own invite", account: INVITEE, call: () => memberActions.acceptInvite(currentPending(PA, INVITEE.id)), backend: "ok" },
  // roster/service.py:65 already_that_role, :67 last_owner_cannot_demote
  { name: "promote an owner", account: OWNER, call: () => settingActions.promoteToOwner(PA, currentId(PA, OWNER.id)), backend: [409, "already_that_role"] },
  { name: "demote the last owner", account: OWNER, call: () => settingActions.demoteToViewer(PA, currentId(PA, OWNER.id)), backend: [409, "last_owner_cannot_demote"] },
  { name: "promote as viewer", account: VIEWER, call: () => settingActions.promoteToOwner(PA, currentId(PA, VIEWER.id)), backend: [403, "owner_only"] },
  // project/core/service.py:271 name_required, :291 invalid_ga4_property_id, :319 name_mismatch
  { name: "rename to blank", account: OWNER, call: () => settingActions.updateProject(PA, { name: "  " }), backend: [422, "name_required"] },
  { name: "ga4 not numeric", account: OWNER, call: () => settingActions.updateProject(PA, { ga4PropertyId: "G-12" }), backend: [422, "invalid_ga4_property_id"] },
  { name: "delete with a wrong name", account: OWNER, call: () => settingActions.deleteProject(PA, "Kia", "ko"), backend: [409, "name_mismatch"] },
  // engines/service.py:30 owner_and_operate: viewer 403 owner_only, owner without operator 403 operator_forbidden
  { name: "engines as viewer", account: VIEWER, call: () => settingActions.updateProjectEngines(PA, ["chatgpt"]), backend: [403, "owner_only"] },
  // tracked_targets/service.py:78 duplicate_competitor; owned_bases/service.py:52; tracked_urls/service.py:135
  {
    name: "add a competitor twice",
    account: OWNER,
    call: () => settingActions.addTrackedCompetitor(PA, { brandName: "Toyota" }),
    backend: [409, "duplicate_competitor"],
    known: [{ threw: "database error" }, { ok: false, error: "이미 추가된 브랜드입니다" }, "U9-N16"],
  },
  {
    name: "add a tracked URL twice",
    account: OWNER,
    call: () => settingActions.addProjectTrackedUrlAction(PA, { url: "https://kia.com/us/ev9" }),
    backend: [409, "duplicate_tracked_url"],
    known: [{ threw: "database error" }, { ok: false, error: "이미 등록된 URL이에요" }, "U9-N16"],
  },
  { name: "tracked URL not http(s)", account: OWNER, call: () => settingActions.addProjectTrackedUrlAction(PA, { url: "not a url" }), backend: [422, "invalid_url"] },
  // prompts/candidates/service.py:36,45; fields/service.py:42 reserved_label, :44 duplicate
  { name: "select no candidates", account: OWNER, call: () => promptActions.selectFromCandidates(PA, []), backend: [422, "unprocessable"] },
  { name: "select other project's candidate", account: OWNER, call: () => promptActions.selectFromCandidates(PA, [u(0x4ff)]), backend: [404, "candidate_not_found"] },
  { name: "delete a missing candidate", account: OWNER, call: () => promptActions.deleteCandidate(PA, u(0x4ff)), backend: [404, "candidate_not_found"] },
  { name: "reserved tag label", account: OWNER, call: () => promptActions.addCustomField(PA, { label: "Brand" }), backend: [422, "reserved_label"] },
  {
    name: "duplicate tag label",
    account: OWNER,
    call: () => promptActions.addCustomField(PA, { label: "Segment" }),
    backend: [409, "duplicate"],
    known: [{ threw: "database error" }, { ok: false, error: "이미 있는 태그입니다" }, "U9-N16"],
  },
  { name: "blank manual prompt", account: OWNER, call: () => promptActions.addManualPrompt(PA, "  \n "), backend: [422, "empty_text"] },
  // lifecycle/service.py:64 invalid_status (draft), :77 invalid_status (not paused)
  { name: "pause a draft", account: OWNER, call: () => promptActions.pausePrompt(PA, u(0x500)), backend: [409, "invalid_status"] },
  { name: "resume a queued prompt", account: OWNER, call: () => promptActions.resumePrompt(PA, u(0x501)), backend: [409, "invalid_status"] },
  { name: "pause as viewer", account: VIEWER, call: () => promptActions.pausePrompt(PA, u(0x501)), backend: [403, "owner_only"] },
  // fields/service.py:36 field_not_found for another project's field (IDOR guard)
  { name: "tag value on a foreign field", account: OWNER, call: () => promptActions.setPromptCustomFieldValue(PA, u(0x500), u(0x6ff), "x"), backend: [404, "field_not_found"] },
  { name: "tag value blank", account: OWNER, call: () => promptActions.setPromptCustomFieldValue(PA, u(0x500), u(0x600), " "), backend: [422, "unprocessable"] },
  // hidden project: resolve_project 404 for an outsider
  { name: "outsider writes", account: OUTSIDER, call: () => settingActions.addTrackedVehicle(PA, { brand: "Kia", model: "K9" }), backend: [404, "not_found"] },
];

// Member ids differ per source: legacy passes membership ids, api user ids (what each page renders).
let source: Source = "legacy";
function currentId(projectId: string, userId: string): string {
  return source === "legacy" ? MEMBERS.find((m) => m.projectId === projectId && m.userId === userId)!.id : userId;
}
function currentPending(projectId: string, userId: string): string {
  return source === "legacy" ? MEMBERS.find((m) => m.projectId === projectId && m.userId === userId)!.id : projectId;
}

describe("actions: legacy (real repositories on PGlite) vs api (backend answer for the same state)", () => {
  it.each(ACTIONS.map((c) => [c.name, c] as const))("%s", async (_n, c) => {
    source = "legacy";
    const legacy = await outcome("legacy", c.account, c.call);
    await seedLegacy();
    source = "api";
    writeAnswer = () => (c.backend === "ok" ? ok204() : fail(c.backend[0], c.backend[1], c.backend[2] ?? null));
    const api = await outcome("api", c.account, c.call);
    if (c.known) {
      expect(legacy).toEqual(c.known[0]);
      expect(api).toEqual(c.known[1]);
    } else {
      expect(api).toEqual(legacy);
    }
  });

  it("createProject: blank name, then success redirects to the new project's intent tab on both", async () => {
    const fd = (name: string) => {
      const f = new FormData();
      f.set("name", name);
      f.set("country", "US");
      f.set("brand", "Kia");
      f.append("aiEngines", "chatgpt");
      f.set("locale", "ko");
      return f;
    };
    source = "legacy";
    expect(await outcome("legacy", ADMIN, () => newActions.createProject(fd(" ")))).toEqual({ ok: false, error: "제목을 입력해주세요" });
    const legacy = await outcome("legacy", ADMIN, () => newActions.createProject(fd("New")));
    expect((legacy as { threw: string }).threw).toMatch(/^REDIRECT:\/ko\/projects\/[0-9a-f-]{36}\/intent$/);
    source = "api";
    writeAnswer = () => json(201, { data: { ...listItem(PROJECTS[1]), project_id: u(0xabc), scope_linked: false }, meta: { mode: "crud" } });
    expect(await outcome("api", ADMIN, () => newActions.createProject(fd(" ")))).toEqual({ ok: false, error: "제목을 입력해주세요" });
    expect(await outcome("api", ADMIN, () => newActions.createProject(fd("New")))).toEqual({ threw: `REDIRECT:/ko/projects/${u(0xabc)}/intent` });
  });

  it("executePrompts: nothing to run answers the same message; a run redirects to the analysis tab on both", async () => {
    source = "legacy";
    const legacyRun = await outcome("legacy", OWNER, () => promptActions.executePrompts(PA, "ko"));
    expect(legacyRun).toEqual({ threw: `REDIRECT:/ko/projects/${PA}/analysis` });
    // PB: its only prompt is running and published (nothing to run); its Owner is an assigned operator.
    expect(await outcome("legacy", VIEWER, () => promptActions.executePrompts(PB, "ko"))).toEqual({ ok: false, error: "실행할 프롬프트가 없습니다" });
    source = "api";
    writeAnswer = () => json(202, { data: { queued: 1, recovered: 0, skipped_pending: 0, propagation: "pending" }, meta: { mode: "crud" } });
    expect(await outcome("api", OWNER, () => promptActions.executePrompts(PA, "ko"))).toEqual(legacyRun);
    // execute/service.py:28 nothing_to_execute
    writeAnswer = () => fail(409, "nothing_to_execute");
    expect(await outcome("api", VIEWER, () => promptActions.executePrompts(PB, "ko"))).toEqual({ ok: false, error: "실행할 프롬프트가 없습니다" });
  });
});
