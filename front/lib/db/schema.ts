import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  bigserial,
  real,
  timestamp,
  date,
  jsonb,
  index,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// `vendor` = GEO 수행사 (external execution partner). Per the v16 Use Case
// matrix (page 4981000), vendor accesses Project menu only — no standard/intent
// dashboards, no admin console.
// `website` = 웹사이트 전용 열람 계정 (2026-07-22): Website group menus only.
// Enum value added by migration 0034 (manual SQL — this repo manages DDL by
// hand from 0020).
export const roleEnum = pgEnum("role", [
  "hq",
  "region",
  "country",
  "admin",
  "vendor",
  "website",
]);

// operator: 비용 통제 게이트(운영자 권한). role 과 직교(orthogonal) — role 은 데이터 가시성,
// operator 는 비용 유발 액션(프로젝트 생성·인텐트 수집·프롬프트 실행)의 실행 가능 여부를
// 결정한다(GGMD 유저 시나리오 3-2 "권한 모델·비용 통제"). 의미론:
//   - global   : 데이터 scope 내 모든 프로젝트 생성·수집·실행 (이노션 본사)
//   - assigned : 배정(active member) 프로젝트 한정 수집·실행, 생성 불가 (이노션 법인·지정 그룹사)
//   - none     : 비용 액션 전면 불가, 조회만 (외부 수행사 영구 / 미지정 그룹사 기본)
// 게이팅은 lib/auth/operator-policy.ts 가 단일 진실의 원천.
export const operatorEnum = pgEnum("operator_scope", [
  "none",
  "assigned",
  "global",
]);

// profiles: maps an authenticated user (id = Supabase auth.users.id) to a role
// and allowed data scope. Role/scope live HERE (server-controlled), never in
// user_metadata — so a client cannot change its own role (access-control spec).
//
// Deliberately NO hard FK to auth.users: that table is Supabase-managed and
// wouldn't exist on a non-Supabase Postgres. Keeping `id` as a plain uuid makes
// the schema portable to the future on-prem install (persistence-foundation spec).
export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(), // = auth.users.id
  email: text("email"),
  role: roleEnum("role").notNull(),
  // scopeAll = true → no restriction (HQ / admin). Otherwise the arrays below
  // constrain the allowed brands / regions / countries.
  scopeAll: boolean("scope_all").notNull().default(false),
  brands: text("brands").array(),
  regions: text("regions").array(),
  countries: text("countries").array(),
  // 운영자(비용 게이트) 권한 — role 과 직교. default none = 조회만(가장 안전한 기본값).
  // role=vendor 는 도출 단계(session.ts)에서 항상 none 으로 정규화된다.
  operator: operatorEnum("operator").notNull().default("none"),
  // 계정별 메뉴 그룹 화이트리스트(좁히기 전용, migration 0039). NULL = 제한 없음
  // (role 기본 메뉴). 값이 있으면 route-policy 가 role 허용 그룹과 교집합해 축소만
  // 한다(role 이 천장 — 상승 불가). 값: 'standard'|'website'|'project'|'admin'.
  menuGroups: text("menu_groups").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProfileRow = typeof profiles.$inferSelect;

// projects: a "tracked brand/domain" unit per GGMD v22 user flow. Project
// creation UI is paused; this schema exists so members can be invited to a
// seed project. brand/region/country scoping is intentionally omitted —
// project visibility is governed purely by ProjectMember rows (resolved
// 2026-06-01: planning page's brand/region/country matrix applies to the
// 표준 menu only, not to per-project access).
export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  // ─── v23 simple-form fields (5 inputs: 제목 / 설명 / 도메인 / 브랜드 / 국가) ─
  name: text("name").notNull(), // 제목 (required)
  description: text("description"), // 설명 (optional, was `goal`)
  domain: text("domain"), // 도메인 (optional)
  brand: text("brand"), // 브랜드 (optional, scope-filtered at submit)
  country: text("country").notNull(), // 국가 (required, scope-filtered at submit)
  language: text("language"), // deprecated — kept for backward compatibility
  // 1:1 link to the scope (GEO 측정 엔진) project that mirrors this HMG project
  // inside the Hyundai Motor Group workspace. Set in live mode after the scope
  // project is created (lib/scope/project-sync.ts); stays NULL in mock mode or
  // after a transient scope failure (retried on the next edit). The local row
  // stays the source of truth for HMG-specific data (members, country/brand
  // scoping); scope owns measurement. Integration is HTTP /api/v1 only — the
  // two DBs are not shared.
  scopeProjectId: uuid("scope_project_id"),
  // GA4 Data API property id for this project's tracked domain (numeric, e.g.
  // "469542848"). Per-project binding so projects whose domain is NOT in the
  // central market catalog (lib/ga4/property-map) can still connect GA4 —
  // resolution is `project.ga4PropertyId ?? resolveProperty(brand, country)`,
  // i.e. the project value wins, catalog is the fallback for cataloged markets.
  // Not a secret (access is gated by the OAuth account's viewer grant); the
  // OAuth credential stays in server-only env. NULL = fall back to catalog.
  ga4PropertyId: text("ga4_property_id"),
  // 답변을 수집할 AI 엔진(scope schedule targets 토큰: chatgpt/gemini/deepseek —
  // 어휘는 lib/scope/engines.ts). NULL = 한 번도 지정하지 않은 레거시 행 →
  // scope 기본(chatgpt·gemini)으로 측정 중인 것으로 취급(effectiveAiEngines).
  // 빈 배열 = 명시적으로 전부 해제(스케줄 비활성). 변경 이력은
  // project_engine_history 에 append(0042).
  aiEngines: text("ai_engines").array(),
  createdBy: uuid("created_by").notNull(), // = profiles.id of the creator
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProjectRow = typeof projects.$inferSelect;

// project_engine_history: 프로젝트 AI 엔진 선택 변경 이력 (0042). append-only —
// 리포지터리에 update/delete 없음. 한 행 = 한 번의 저장 시점의 **전체 선택
// 집합**(diff 가 아님 — 화면의 "엔진 변경 이력"이 날짜별로 그 시점 엔진 목록을
// 그대로 나열한다). 생성 시 첫 행이 들어간다. FK 없음(0033·0041 선례) — 프로젝트
// 삭제 시 리포지터리 delete 가 함께 지운다.
export const projectEngineHistory = pgTable("project_engine_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  engines: text("engines").array().notNull(),
  changedBy: uuid("changed_by"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProjectEngineHistoryRow = typeof projectEngineHistory.$inferSelect;

// project_owned_bases: canonical project-owned site bases. This is the
// authoritative project-level ownership set used by KPI ⑤ and KPI ⑥ gating.
export const projectOwnedBases = pgTable("project_owned_bases", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  baseUrl: text("base_url").notNull(),
  label: text("label"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ProjectOwnedBaseRow = typeof projectOwnedBases.$inferSelect;

// project_tracked_urls: per-project list of target URLs the project counts as
// "owned cited" for KPI ⑥ AI 타겟 URL 인용률. Replaces the prompt-level target
// labeling proposal (2026-06-22): labeling once per project is far cheaper
// operationally and matches reality — a project = one site (e.g. kia.com/it/it).
// URL is the canonical full path ("https://kia.com/it/it/ioniq"); KPI matching
// is exact-path equality (query string variants are not folded in).
// label is an optional human memo (e.g. "EV9 시승 신청").
export const projectTrackedUrls = pgTable("project_tracked_urls", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  url: text("url").notNull(),
  label: text("label"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ProjectTrackedUrlRow = typeof projectTrackedUrls.$inferSelect;

// project_custom_fields: per-project, user-defined tags for `prompts` —
// separate from the HMG fixed taxonomy (brand/listType/depth1~4/funnelStage)
// which most projects never populate in practice (only Excel-framework-
// imported projects do; 2026-07-06 audit: 2 of 9 projects). Text-only by
// design (2026-07-08 decision) — a select/bool type system with managed
// option lists was more complexity than the actual usage needed.
export const projectCustomFields = pgTable(
  "project_custom_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(),
    label: text("label").notNull(),
    archived: boolean("archived").notNull().default(false),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("project_custom_fields_project_label_unique").on(
      t.projectId,
      t.label,
    ),
  ],
);

export type ProjectCustomFieldRow = typeof projectCustomFields.$inferSelect;

// prompt_custom_field_values: one row per (prompt, field) assignment. No FK
// in DDL (matches the rest of this schema's portability stance) — the
// repository layer enforces the project_id relationship via the field row.
export const promptCustomFieldValues = pgTable(
  "prompt_custom_field_values",
  {
    promptId: uuid("prompt_id").notNull(),
    fieldId: uuid("field_id").notNull(),
    value: text("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.promptId, t.fieldId] }),
    index("prompt_custom_field_values_field_idx").on(t.fieldId),
  ],
);

export type PromptCustomFieldValueRow = typeof promptCustomFieldValues.$inferSelect;

// project_members: per-project access list. Per v22 user flow #4, an Owner
// invites Viewers by email; the invited account is looked up in `profiles`
// and a pending row is inserted. The Viewer accepts via in-app notification
// (email channel deferred), which flips status → 'active'.
//
// Schema choices:
//   - DB enum keeps both roles ('owner' | 'viewer'); UI currently only
//     creates 'viewer' invites, with the Owner row inserted at project
//     creation (or seeded). Owner-promotion is a future action.
//   - UNIQUE (project_id, user_id) prevents duplicate invites to the same
//     person; canceling deletes the row rather than soft-deleting.
//   - No FK to profiles/projects in DDL (mirrors profiles ↔ auth.users
//     decision — portable to non-Supabase Postgres). Repository layer
//     enforces referential integrity.
export const projectMemberRoleEnum = pgEnum("project_member_role", [
  "owner",
  "viewer",
]);

export const projectMemberStatusEnum = pgEnum("project_member_status", [
  "pending",
  "active",
]);

export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull(), // = projects.id
    userId: uuid("user_id").notNull(), // = profiles.id
    role: projectMemberRoleEnum("role").notNull().default("viewer"),
    status: projectMemberStatusEnum("status").notNull().default("pending"),
    invitedBy: uuid("invited_by").notNull(), // = profiles.id of the inviter
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => ({
    projectUserUnique: uniqueIndex("project_members_project_user_unique").on(
      t.projectId,
      t.userId,
    ),
  }),
);

export type ProjectMemberRow = typeof projectMembers.$inferSelect;

// member_audit_logs: append-only activity ledger for the Member tab.
// Captures who did what to whom on a project so Owners + admins can audit
// the membership history. Each row carries:
//   - actor: the user who triggered the action (always logged-in)
//   - target: the user the action was applied to (invite recipient, removed
//     member, promoted/demoted member, the actor themselves on accept/reject)
//   - action: one of 7 lifecycle events
//   - context: optional free-text (e.g. previous role on promote/demote,
//     status on cancel). Kept as text to avoid a strict schema for a UI-only
//     hint; the typed action enum is the canonical signal.
export const memberAuditActionEnum = pgEnum("member_audit_action", [
  "invite",
  "cancel_invite",
  "remove",
  "promote",
  "demote",
  "accept",
  "reject",
]);

export const memberAuditLogs = pgTable("member_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(), // = projects.id
  actorId: uuid("actor_id").notNull(), // = profiles.id of who acted
  targetUserId: uuid("target_user_id").notNull(), // = profiles.id of the affected user
  action: memberAuditActionEnum("action").notNull(),
  context: text("context"), // optional hint, e.g. "viewer -> owner"
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MemberAuditLogRow = typeof memberAuditLogs.$inferSelect;

// prompt_candidates: the rolling pool that customer-interest (Google Keyword +
// Social Scraping) feeds into. Per GGMD v22 user flow #2-4, each generated
// candidate is stamped with its source ("구글 키워드" / "Social Scraping" /
// "manual" later) and the originating keyword so the Prompt tab can surface
// provenance in the candidate list.
export const promptSourceEnum = pgEnum("prompt_source", [
  "google_keyword",
  "social_scraping",
  "manual",
]);

export const promptCandidates = pgTable("prompt_candidates", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  source: promptSourceEnum("source").notNull(),
  sourceKeyword: text("source_keyword"), // optional — keyword that generated this
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PromptCandidateRow = typeof promptCandidates.$inferSelect;

// prompts: prompts that have actually been promoted from the candidate pool
// (or added manually) for execution. Per v22 flow #3-4, each prompt receives
// a type (비교형/추천형/정보형) + category (차종/권역/토픽) before batch AI
// call. status tracks lifecycle: draft → queued → running → done/failed.
//
// `candidateId` retains the link to the originating candidate when present
// (matches "원본은 후보 풀에 유지" — editing creates a copy here without
// mutating the candidate row).
export const promptTypeEnum = pgEnum("prompt_type", [
  "comparison",
  "recommendation",
  "information",
  "other",
]);

// `paused` = 측정 중지 (migration 0038): scope active=false로 측정만 중단하고
// 이력은 보존한 행. 프롬프트 라이프사이클 액션(_actions.ts::pausePrompt)이 설정.
export const promptStatusEnum = pgEnum("prompt_status", [
  "draft",
  "queued",
  "running",
  "done",
  "failed",
  "paused",
]);

export const prompts = pgTable("prompts", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  candidateId: uuid("candidate_id"), // nullable — null for manually-added
  text: text("text").notNull(),
  promptType: promptTypeEnum("prompt_type"),
  category: text("category"), // free-text — "차종"/"권역"/"토픽" or anything
  // Corporate-framework taxonomy (HMG xlsx). Plain text by design — no separate
  // taxonomy table; values are managed free-form. All nullable so existing rows
  // and manually-added prompts without a framework slot remain valid (additive
  // ALTER, no table rewrite — cf. the 0007 outage lesson below).
  brand: text("brand"), // HMG / Hyundai / Kia / Genesis (free-text)
  // 브랜드 유무 (migration 0032): 프롬프트 "문구"에 브랜드명이 들어가는지 —
  // 'branded' | 'unbranded'. `brand`(소속 카탈로그)와는 별개 축이다. 같은 Genesis
  // 카탈로그 안에도 브랜드 무관(Generic) 문구가 다수 존재해, brand 컬럼만으로는
  // 표현할 수 없어 분리했다. 3사 framework 엑셀의 `brand 유무`(O/X)가 정본.
  // null = 값 미확정 또는 이 축이 없는 카탈로그(website 등) — 필터에서 제외된다.
  brandPresence: text("brand_presence"),
  listType: text("list_type"), // e.g. "Brand Message"
  depth1: text("depth1"), // e.g. "Innovation & Technology"
  depth2: text("depth2"), // e.g. "Autonomous car"
  depth3: text("depth3"), // e.g. "EV Driving"
  depth4: text("depth4"), // 2026-06-10: placeholder for a future 4-th level — populated null until editorial finalizes the axis.
  funnelStage: text("funnel_stage"), // CEJ bucket — "인지/탐색" / "구매/사후관리" (plain text)
  // 측정 종류 (migration 0025): 'single' = 1턴 단발, 'acr' = 2턴 AI's Choice Rate
  // (scope prompts.kind와 동일 enum). 로컬이 정본 — scope에는 push로 반영
  // (admin 카탈로그 토글 / scripts/scope/push-acr-kind.ts). CHECK는 SQL에.
  kind: text("kind").notNull().default("single"),
  // 언어·시장 축 (migration 0047, 2026-08-28 다국어 라운드). 번역 시트 3종이 정본.
  // `lang` = 시트 탭 코드(EN·KO·ES·AR·… ISO 639-1 대문자). 종전에는 `text ~ '[가-힣]'`
  // 휴리스틱으로 KO/EN 을 갈랐으나 44개 언어에서는 성립하지 않아 컬럼으로 승격했다.
  // `regions` = 그 행이 담당하는 시장. 실국가는 ISO 3166-1 alpha-2, 비국가 사이트
  // 슬롯은 `x:` 접두 의사코드(x:WW·x:EU·x:ME·x:NBRAND·x:CPO) — 접두사 없이 쓰면
  // `ME` 가 몬테네그로, `EU` 가 ISO 예약코드와 충돌한다. NULL = 미지정(상속) — scope 쪽
  // prompts.regions 와 같은 시맨틱이며, scope 발행 시 실국가로 변환한다.
  lang: text("lang"),
  regions: text("regions").array(),
  // Link to the scope-mirror prompt (scope_prompts.prompt_id) this catalog row
  // maps to, for joining measured answers. Null for brand-split rows until the
  // split is pushed to scope (then repointed to the per-brand scope prompt_id).
  scopePromptId: uuid("scope_prompt_id"),
  status: promptStatusEnum("status").notNull().default("draft"),
  // Flipped to true when tracked_competitors / tracked_vehicles change so
  // the next batch picks up these rows for re-analysis against the new
  // label set. Cleared by the analysis pipeline on success.
  needsReanalysis: boolean("needs_reanalysis").notNull().default(false),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // catalog-prompt-audit (0041): 마지막 수정자·soft-delete. 카탈로그(STANDARD_ROOT)
  // 행에서만 세팅된다 — 프로젝트 프롬프트는 기존 물리 삭제 경로 유지(후속 확장).
  updatedBy: uuid("updated_by"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type PromptRow = typeof prompts.$inferSelect;

// standard_prompts: admin-managed global prompt catalog used by 표준 dashboards
// (separate from per-project `prompts`). Admin-only CRUD via /admin/standards/prompts.
// `brand` nullable → applies to all brands; specific brand value → scope to one.
// `enabled` lets admins draft/retire without deleting history.
export const standardPrompts = pgTable("standard_prompts", {
  id: uuid("id").primaryKey().defaultRandom(),
  text: text("text").notNull(),
  promptType: promptTypeEnum("prompt_type"),
  category: text("category"),
  brand: text("brand"), // nullable — global if null
  enabled: boolean("enabled").notNull().default(true),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type StandardPromptRow = typeof standardPrompts.$inferSelect;

// standard_keywords: admin-managed customer-interest seed catalog. Each row
// represents a keyword/term to track across `source_type` (google_keyword or
// community_voc — different from `prompt_source` because the third source
// `manual` is project-level not standard). Admin-only via
// /admin/standards/customer-interest.
export const standardKeywordSourceEnum = pgEnum("standard_keyword_source", [
  "google_keyword",
  "community_voc",
]);

export const standardKeywords = pgTable("standard_keywords", {
  id: uuid("id").primaryKey().defaultRandom(),
  term: text("term").notNull(),
  sourceType: standardKeywordSourceEnum("source_type").notNull(),
  brand: text("brand"), // nullable — global if null
  enabled: boolean("enabled").notNull().default(true),
  notes: text("notes"), // optional — explains why this term is on the standard list
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type StandardKeywordRow = typeof standardKeywords.$inferSelect;

// standard_sources: admin-managed source URL allowlist for the community-VoC
// pipeline (and any other channel — see source_channel enum below). Matches
// v25 KPI ShortList's "Channel / Source" L2 (news / PR / social / community).
// Stored separately from standard_keywords because the unit is a URL/domain
// rather than a search term — different identity, different lifecycle.
export const standardSourceChannelEnum = pgEnum("standard_source_channel", [
  "news",
  "pr",
  "social",
  "community",
]);

export const standardSources = pgTable("standard_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  url: text("url").notNull(), // domain or full URL
  channel: standardSourceChannelEnum("channel").notNull(),
  brand: text("brand"), // nullable — global if null
  enabled: boolean("enabled").notNull().default(true),
  notes: text("notes"),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type StandardSourceRow = typeof standardSources.$inferSelect;

// tracked_competitors + tracked_vehicles: per-project lists of designated
// brand/model entities that AI answer analysis should match against, separate
// from the project's own brand (`projects.brand`). Table names are kept for
// compatibility, but the product meaning is no longer "store competitors" —
// competitors are derived as "mentioned brands that are not own brands".
// Adding/removing rows here invalidates prior analysis labels — see the
// Settings page reprocess confirm dialog. Until a real analysis pipeline
// exists, "재처리" only flags `prompts.needs_reanalysis` so the next batch run
// picks them up.

export const trackedCompetitors = pgTable("tracked_competitors", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  brandName: text("brand_name").notNull(),
  aliases: text("aliases").array(),
  notes: text("notes"),
  // KPI #16(SOV 비교 비율)의 비교 기준 브랜드 지정 — 프로젝트당 최대 1개
  // (partial unique index, migration 0022). 미지정이면 집계가 해당 기간 SOV 1위
  // 외부 브랜드를 자동 선택한다 (하이브리드 결정 2026-07-02).
  isTarget: boolean("is_target").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TrackedCompetitorRow = typeof trackedCompetitors.$inferSelect;

// `brand` is free-text rather than a FK to tracked_competitors so vehicles
// from the project's own brand (projects.brand) can live alongside other
// designated-brand vehicles in one table — keeps the UI a single tracked-
// vehicles panel instead of two near-identical lists.
export const trackedVehicles = pgTable("tracked_vehicles", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  brand: text("brand").notNull(),
  model: text("model").notNull(),
  segment: text("segment"), // e.g. "SUV", "Sedan" — optional
  aliases: text("aliases").array(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TrackedVehicleRow = typeof trackedVehicles.$inferSelect;

// tracked_keywords: per-project list of Google keyword terms the operator is
// tracking in the Intent > Google Keyword view. Previously the view seeded a
// hardcoded sample list and held tabs in client state only (lost on refresh);
// this table persists the tracked set under the project. `country` is the ISO
// alpha-2 market the keyword was collected for (auto-applied from the project's
// country at save time) so the same term can be tracked per-market.
export const trackedKeywords = pgTable("tracked_keywords", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  term: text("term").notNull(),
  country: text("country"), // ISO alpha-2 (e.g. "KR", "IT"); nullable for legacy rows
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TrackedKeywordRow = typeof trackedKeywords.$inferSelect;

// =====================================================================
// Answer Analysis pipeline (Phase 5.1 — migration 0008).
// =====================================================================
//
// Three new tables form the data backbone of 답변 분석 (Mentions + Citations)
// and AI Agent Funnel (ACR specifically). Designed per the v44 decision
// matrix + docs/scope-answer-analysis-data-flow.md reference:
//
//   ai_responses        ─┬─►  brand_mentions  (one answer → many mentions)
//                        └─►  citation_analysis (one answer → many citations)
//
// + supporting tables:
//   tracked_brands         (alias catalog for brand merge — TODO 1-6)
//   youtube_video_metadata (channel enrichment for youtube.com citations — TODO 1-5)
//
// Important: this section ONLY adds new tables — no ALTER TABLE on existing
// tables (lesson learned from 0007 prod outage). When migration 0008 is
// applied, queries on existing tables continue to work; only new code that
// imports these tables sees them.

export const aiProviderEnum = pgEnum("ai_provider", [
  "chatgpt",
  "claude",
  "gemini",
  "perplexity",
]);

export const funnelStageEnum = pgEnum("funnel_stage", [
  "awareness",
  "consideration",
  "purchase",
]);

// ai_responses — one row per (prompt × model) execution. Captures the
// raw AI answer + which model produced it. brand_mentions and
// citation_analysis FK here so we can re-aggregate by model or prompt
// without touching the underlying answer twice.
export const aiResponses = pgTable("ai_responses", {
  id: uuid("id").primaryKey().defaultRandom(),
  promptId: uuid("prompt_id").notNull(), // = prompts.id
  aiProvider: aiProviderEnum("ai_provider").notNull(),
  aiModel: text("ai_model").notNull(), // e.g. "gpt-5.4-mini", "claude-4-opus"
  responseText: text("response_text").notNull(),
  funnelStage: funnelStageEnum("funnel_stage"), // optional — derived from prompt
  queryCreatedAt: timestamp("query_created_at", {
    withTimezone: true,
  })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AiResponseRow = typeof aiResponses.$inferSelect;

// brand_mentions — flat row per brand occurrence in any AI answer.
// mention_position = 1-based ordinal of the brand inside the answer
// (drives ACR Top1/Top5 aggregation per Q2 decision).
export const mentionTypeEnum = pgEnum("mention_type", [
  "mention",
  "recommendation",
  "comparison",
  "definition",
]);

export const brandMentions = pgTable("brand_mentions", {
  id: uuid("id").primaryKey().defaultRandom(),
  responseId: uuid("response_id").notNull(), // = ai_responses.id
  promptId: uuid("prompt_id").notNull(), // denormalized for fast lookup
  brandName: text("brand_name").notNull(),
  mentionPosition: integer("mention_position").notNull(),
  mentionType: mentionTypeEnum("mention_type"),
  // brand_sentiment range: -1.0 (negative) ... 0.0 (neutral) ... +1.0 (positive).
  // real(4-byte float) — precision is plenty for sentiment scores.
  brandSentiment: real("brand_sentiment"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type BrandMentionRow = typeof brandMentions.$inferSelect;

// citation_analysis — flat row per URL cited in any AI answer. LLM-classified
// category / subcategory drives the 4-level Category > Subcategory > Domain
// > URL tree in the Citation Sources view.
export const citationAnalysis = pgTable("citation_analysis", {
  id: uuid("id").primaryKey().defaultRandom(),
  responseId: uuid("response_id").notNull(),
  promptId: uuid("prompt_id").notNull(),
  url: text("url").notNull(),
  domain: text("domain").notNull(), // normalized from url at insert time
  title: text("title"), // page title if available
  category: text("category"), // LLM-classified (Editorial / Community / Brand-owned ...)
  subcategory: text("subcategory"), // LLM-classified
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CitationAnalysisRow = typeof citationAnalysis.$inferSelect;

// tracked_brands — alias catalog for brand merge badges in the Mentions
// table (the "+N" hover pattern per scope doc §1-5). canonical_name is
// what the UI displays; aliases is the set of alternate spellings the
// pipeline should match.
//
// Per-project (not global) because each project tracks a different set
// of brands and may want different aliases (e.g. one project tracks
// "Genesis" as "Genesis Brand", another as "현대 제네시스").
export const trackedBrands = pgTable("tracked_brands", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  canonicalName: text("canonical_name").notNull(),
  aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TrackedBrandRow = typeof trackedBrands.$inferSelect;

// youtube_video_metadata — cache of channel info for youtube.com URLs
// cited in answers. video_id is the unique key extracted from the URL
// (handles both youtube.com/watch?v=ID and youtu.be/ID forms — extraction
// happens in the worker, not here). channelTitle/channelId drive the
// Citation Sources drill-down enrichment for the YouTube domain.
export const youtubeVideoMetadata = pgTable("youtube_video_metadata", {
  id: uuid("id").primaryKey().defaultRandom(),
  videoId: text("video_id").notNull().unique(),
  channelTitle: text("channel_title"),
  channelId: text("channel_id"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type YoutubeVideoMetadataRow = typeof youtubeVideoMetadata.$inferSelect;

// standard_snapshots (2026-06-08 ~ 2026-07-02): 무필터 표준 집계의 DB 스냅샷
// (SWR + cron 프리웜) — readSnapshot 소비처가 끝내 배선되지 않았고 계산 경로도
// 미러 이전의 레거시 HTTP였다. 미러 리드가 스냅샷 배치로 좁혀지며(300s→수 초)
// 존재 이유가 사라져 제거. 부활 검토 시 주의: D4가 사용자 scope.brands를
// 필터에 자동 주입하므로 "무필터 스냅샷 공유"는 브랜드 스코프 격리를 깬다 —
// 유효 필터가 진짜 빈 경우(scope.all)만 서빙하거나 스코프별 키가 필요하다.

// ─── scope_* — local MIRROR of scope's raw measurement surface ─────────────
// scope is a general measurement engine (no HMG-specific formulas); we mirror
// its per-answer data for the STANDARD/root project into hmg-geo's own DB and
// compute every HMG KPI here via SQL GROUP BY. That scales to 10k+ answers (a
// DB aggregation, not pulling all rows into memory like result-adapter does) and
// keeps HMG logic out of scope. Synced incrementally per measurement run (see
// lib/scope/mirror/*). NOT role-scoped — the root is enterprise-wide.

// One scope measurement run; doubles as the sync watermark (synced runs are
// skipped, runs being immutable once completed).
export const scopeRuns = pgTable(
  "scope_runs",
  {
    runId: uuid("run_id").primaryKey(), // scope measurement_run_id
    // scope project this run belongs to (= MeasurementRunSummary.project_id).
    // The project DIMENSION the flat mirror otherwise lacks: answers/mentions/
    // citations join to a run, so filtering runs by projectId scopes every
    // downstream aggregate to one project (per-project KPI, cf. answerWhere's
    // optional project predicate). Nullable — runs mirrored before this column
    // existed, and the standard/root view leaves it unfiltered. Populated by the
    // mirror sync from the run's owning project.
    projectId: uuid("project_id"),
    status: text("status"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // 회차(cycle) 앵커 — 표준 화면 `측정 기준일` 의 정본(migration 0058).
    // scope 의 measurements API 가 아직 노출하지 않아 당분간 NULL 이고, 읽기는
    // COALESCE 로 measured_at 에 폴백한다. 노출되면 싱크가 채우고 화면은 코드
    // 변경 없이 회차 기준으로 넘어간다.
    cycleAnchorAt: timestamp("cycle_anchor_at", { withTimezone: true }),
    totalJobs: integer("total_jobs"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scope_runs_project_idx").on(t.projectId),
    // 회차 확장(0077 `expanded` · 0078 `cyc_runs`)의 유일한 진입 경로 (migration 0079).
    // `cycle_anchor_at` 에 인덱스가 없어 그 프로젝트의 run 을 전부 훑고 걸러냈다.
    index("scope_runs_project_cycle_idx").on(t.projectId, t.cycleAnchorAt),
  ],
);
export type ScopeRunRow = typeof scopeRuns.$inferSelect;

// scope_sync_cursors (migration 0043) — 미러 싱크 로테이션 키.
// 한 행 = 한 scope 프로젝트의 "마지막으로 **시도한** 시각". scope_runs.syncedAt
// (= 마지막으로 run 을 **쓴** 시각)과 다르다: 쓸 게 없어 아무것도 안 쓴 패스도
// 여기엔 기록된다. 이 구분이 로테이션의 전제다 — 쓰기 시각으로 정렬하면 무작업
// 프로젝트가 앞순번에 영구 고착되어 예산 밖 뒷순번이 영영 도달하지 못한다
// (2026-08-20 실측: 대상 176개 중 매 패스 deferred 89~102).
export const scopeSyncCursors = pgTable(
  "scope_sync_cursors",
  {
    projectId: uuid("project_id").primaryKey(), // scope project id
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // 마지막 시도의 실패 사유(성공이면 null) — 삭제된 scope 프로젝트(404) 등
    // 상시 실패 대상 진단용. 실패해도 시각은 갱신되므로 로테이션은 계속 돈다.
    lastError: text("last_error"),
  },
  (t) => [index("scope_sync_cursors_attempt_idx").on(t.lastAttemptAt)],
);
export type ScopeSyncCursorRow = typeof scopeSyncCursors.$inferSelect;

// scope_sync_watermarks (migration 0082) — 미러 싱크 **증분 읽기** 워터마크.
// 한 행 = 한 scope 프로젝트. scope_sync_cursors(로테이션 키)와 테이블을 나눈 이유:
// 그 표는 매 틱 쓰이는 표라 ALTER 가 ACCESS EXCLUSIVE 로 크론과 부딪히고(additive-only
// 규율 · 0007 교훈), 의미도 다르다 — 저쪽은 "시도 시각", 이쪽은 "어디까지 읽었다고
// 믿어도 되는가"다. 판정 규칙은 lib/scope/mirror/sync.ts 의 planPromptRead ·
// computeRunFloor 주석이 정본.
export const scopeSyncWatermarks = pgTable("scope_sync_watermarks", {
  projectId: uuid("project_id").primaryKey(), // scope project id
  // 이 시각 **이전**에 갱신된 프롬프트는 전부 미러에 upsert 됐다. 다음 패스는
  // `updated_from = 이 값 − 안전 여유` 로만 읽는다. NULL = 증분 불가(전량 읽기). 단조(GREATEST).
  promptsSyncedThrough: timestamp("prompts_synced_through", { withTimezone: true }),
  // 한 틱 상한을 넘은 프롬프트 창의 **이어 읽기** 상태. 셋이 한 묶음이다 — 커서는 그 창
  // (`updated_from = resume_from`, NULL 이면 하한 없음)에서만 유효하고, 창을 끝까지 읽으면
  // 워터마크가 `resume_started_at`(그 창의 첫 읽기 시작 시각)으로 전진한 뒤 셋 다 비운다.
  promptsResumeCursor: text("prompts_resume_cursor"),
  promptsResumeFrom: timestamp("prompts_resume_from", { withTimezone: true }),
  promptsResumeStartedAt: timestamp("prompts_resume_started_at", { withTimezone: true }),
  // run 목록(created desc)의 정착 경계 **앵커** — floor run 과 그 바로 아래 run 들(최대 K개).
  // floor run 보다 오래된 run 은 전부 정착이었다. 다음 패스는 앵커 중 **하나라도** 만나면
  // floor 를 지난 것으로 본다(floor run 이 Scope 에서 지워져도 경계를 잃지 않는다).
  // 시각이 아니라 run id 인 이유: 목록 정렬 키(created_at)를 API 가 노출하지 않는다
  // (`started_at` 은 startedAt ?? createdAt). NULL/빈 배열 = 조기 종료 불가.
  runsFloorRunIds: uuid("runs_floor_run_ids").array(),
  // 그 floor 를 계산한 패스의 **목록 읽기 시작 시각**(hmg 시계). 더 새 스냅샷일 때만 덮어쓴다
  // — 긴 패스(전체 대조)의 낡은 목록이 크론이 방금 붙잡아 둔 floor 를 올려 버리지 않게.
  runsFloorSnapshotAt: timestamp("runs_floor_snapshot_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type ScopeSyncWatermarkRow = typeof scopeSyncWatermarks.$inferSelect;

// Per-run mirror progress. This is deliberately separate from the project
// rotation cursor: a run can survive a process deadline and resume at a
// source-specific cursor without changing the scheduler's fairness key.
export const scopeMirrorProgress = pgTable(
  "scope_mirror_progress",
  {
    projectId: uuid("project_id").notNull(),
    runId: uuid("run_id").notNull(),
    phase: text("phase").$type<"plan" | "write" | "finalize" | "complete" | "blocked">().notNull(),
    cursor: text("cursor"),
    state: jsonb("state").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    revision: integer("revision").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.runId] }),
    index("scope_mirror_progress_pending_idx")
      .on(t.createdAt, t.projectId, t.runId)
      .where(sql`${t.phase} NOT IN ('complete', 'blocked')`),
  ],
);
export type ScopeMirrorProgressRow = typeof scopeMirrorProgress.$inferSelect;

// One answer = one prompt × engine × region (scope job / query_run).
export const scopeAnswers = pgTable(
  "scope_answers",
  {
    jobId: uuid("job_id").primaryKey(),
    runId: uuid("run_id").notNull(),
    promptId: uuid("prompt_id"),
    target: text("target").notNull(), // engine: chatgpt / gemini
    region: text("region"), // US / KR
    status: text("status"),
    measuredAt: timestamp("measured_at", { withTimezone: true }),
    modelSlug: text("model_slug"),
    answerText: text("answer_text"),
  },
  (t) => [
    index("scope_answers_run_idx").on(t.runId),
    index("scope_answers_target_idx").on(t.target),
    index("scope_answers_region_idx").on(t.region),
  ],
);
export type ScopeAnswerRow = typeof scopeAnswers.$inferSelect;

// 회차 앵커 레지스트리 (migration 0053) — measured_at 접기의 **정본 저장소**.
//
// 모델: `scope_answers.measured_at` 은 벽시계 완료 시각이 아니라 **소속 회차의
// 앵커 날짜**를 가리킨다(시각은 보존). 정본 = internal-kb/
// hmg-website-measured-at-anchor-normalization-2026-08-25.md §3.
//
// 왜 별도 테이블인가 — 접기를 미러 행에만 하면 **어떤 재싱크도 되돌린다.**
// 2026-08-31 04:12Z 의 회수 재싱크(`replaceRun` = run 단위 delete+insert)가
// 8/25 접기 149,219행 중 18,890행을 scope 원본 measured_at 으로 되돌렸다(§9).
// force 재싱크가 아니라 **정규 경로**였다 — 즉 "force 만 조심하면 된다"는 전제가
// 틀렸고, 접기는 재싱크가 소비하는 **입력 데이터**로 승격되어야 한다.
//
// job_id 가 PK 인 이유: 접기는 답변 단위 사실이고 scope job 이 그 유일 식별자다.
// `source_measured_at` 은 원복 근거(scope 원본값) — 지우지 않는다.
export const scopeAnswerAnchors = pgTable(
  "scope_answer_anchors",
  {
    jobId: uuid("job_id").primaryKey(), // scope job = scope_answers.job_id
    // 이 답변이 속한 회차의 앵커 날짜(UTC). 재싱크 후 measured_at 의 **날짜부**를
    // 이 값으로 되돌린다(시각 보존).
    anchor: date("anchor", { mode: "string" }).notNull(),
    // 접기 직전의 scope 원본 measured_at. §5.1 가역성의 근거 — 이 값이 있어야
    // "앵커 모델을 폐기하고 원본으로 되돌린다"가 가능하다.
    sourceMeasuredAt: timestamp("source_measured_at", { withTimezone: true }),
    foldedAt: timestamp("folded_at", { withTimezone: true }).notNull().defaultNow(),
    // 어느 접기 배치에서 등록됐는지(예: `seed:_bak_anchor_fold`). 사후 감사용.
    reason: text("reason"),
  },
  (t) => [index("scope_answer_anchors_anchor_idx").on(t.anchor)],
);
export type ScopeAnswerAnchorRow = typeof scopeAnswerAnchors.$inferSelect;

// 답변 단위 회차 앵커 **전수** 테이블 (migration 0077).
// 정본 스펙: internal-kb/hmg-geo-answer-anchor-table-spec-2026-09-19.md
//
// 0053 이 "옮겨야 할 행만" 담는 레지스트리라면, 이것은 **완료 답변마다 1행**이다.
// 기간 필터가 화면마다 다른 컬럼(`started_at` / `measured_at` / 앵커 UTC 일자)에 걸려
// 값이 흔들리던 것을 `anchor_date` 하나로 모은다(실측: 측정일≠앵커일 26.6%).
//
// ⚠️ **이 테이블은 drizzle 로 쓰지 않는다.** 여기 정의를 두는 이유는 `db:drift` 의
// 기준선(schema.ts)이 이 테이블을 알아야 하기 때문뿐이다(0053·0072 와 같은 자세).
// 쓰기의 유일한 경로는 DB 함수 `refresh_answer_cycle_anchors(uuid[])` 이고,
// 읽기는 `repositories/scope-answer-anchors.ts` 의 raw SQL 이다 — drizzle insert 경로에
// 넣으면 마이그레이션 미적용 배포에서 컬럼 전부를 명시하다 42703 이 난다.
export const scopeAnswerCycleAnchors = pgTable(
  "scope_answer_cycle_anchors",
  {
    jobId: uuid("job_id").primaryKey(), // scope job = scope_answers.job_id (FK 없음)
    runId: uuid("run_id").notNull(),
    // nullable 인 이유는 0077 파일 주석 참조 — `scope_runs.project_id` 가 nullable 이라
    // NOT NULL 로 두면 레거시 run 의 답변이 전수에서 빠진다.
    projectId: uuid("project_id"),
    surface: text("surface").notNull(), // standard | website | project
    anchorAt: timestamp("anchor_at", { withTimezone: true }).notNull(),
    // 실제 앵커의 KST 일자(기록용). 기간 술어·달력·주·월은 `roundDate` 를 본다.
    anchorDate: date("anchor_date", { mode: "string" }).notNull(),
    // 주·월 버킷은 **귀속 날짜(roundDate) 기준**이다.
    anchorWeek: date("anchor_week", { mode: "string" }).notNull(),
    anchorMonth: date("anchor_month", { mode: "string" }).notNull(),
    // 대표 답변 정렬 키(스펙 §2-16) = COALESCE(0053.source_measured_at, measured_at,
    // anchor_at). 회차 안 같은 (질문, 엔진, 지역)이 여러 건이면 이 값이 최신인 1건이
    // 대표다. 리더 전환은 C 단계 — 지금은 컬럼과 인덱스 후보만 둔다.
    measuredAtOrig: timestamp("measured_at_orig", { withTimezone: true }).notNull(),
    // 엔진이 기본 타겟(ChatGPT·Gemini)인가. 정본은 `lib/scope/engines.ts`
    // `DEFAULT_AI_ENGINES` 이고 SQL 쪽 사본은 `hmg_anchor_default_engines()` 하나다.
    isDefaultEngine: boolean("is_default_engine").notNull(),
    // 정규 요일 귀속 날짜(글로벌=월·웹사이트=금, KST). 값의 정본은 매핑 표
    // `scope_cycle_rounds` 이고 이 컬럼은 기간 술어가 인덱스를 타게 하는 복사본이다.
    roundDate: date("round_date", { mode: "string" }).notNull(),
    viewAnchorDate: date("view_anchor_date", { mode: "string" }),
    // 원장이 찍은 노출일(KST 일자). upsert 의 보존 경로가 노출일을 **보존된
    // anchor_date** 로 다시 계산할 때 "원장 값이 있었는가" 를 알기 위한 컬럼이다.
    ledgerViewAnchorDate: date("ledger_view_anchor_date", { mode: "string" }),
    cycleId: uuid("cycle_id"),
    // registry(0053 수작업 접기) | ledger | run | fallback_measured.
    // `registry` 만 **고정(pinned)** — 자동 경로가 덮지도 지우지도 않는다.
    source: text("source").notNull(),
    sourceMeasuredAt: timestamp("source_measured_at", { withTimezone: true }),
    reason: text("reason"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scope_answer_cycle_anchors_round_idx").on(t.roundDate, t.jobId),
    index("scope_answer_cycle_anchors_surface_round_idx").on(t.surface, t.roundDate),
    index("scope_answer_cycle_anchors_project_date_idx").on(t.projectId, t.anchorDate),
    index("scope_answer_cycle_anchors_run_idx").on(t.runId),
    index("scope_answer_cycle_anchors_week_idx").on(t.anchorWeek),
    index("scope_answer_cycle_anchors_rep_idx").on(t.projectId, t.roundDate, t.measuredAtOrig),
    // 회차 → 답변 역방향(MoM·WoW 회차 대응 · 감사의 원장 조인). 쓰임이 전부
    // `cycle_id = <uuid>` 라 NULL 행(회차 없는 project 표면)을 싣지 않는 부분 인덱스다.
    index("scope_answer_cycle_anchors_cycle_idx")
      .on(t.cycleId)
      .where(sql`${t.cycleId} IS NOT NULL`),
  ],
);
export type ScopeAnswerCycleAnchorRow = typeof scopeAnswerCycleAnchors.$inferSelect;

// 회차 → 정규 요일 귀속 날짜 **매핑 표** (migration 0077).
//
// 회차 = (프로젝트, 최종 anchor_date). 글로벌은 월요일, 웹사이트는 금요일 자리에
// 앉히고, 자리가 차 있으면 규칙대로 옆자리로 보내거나 합친다. 규칙의 정본은 DB 함수
// `hmg_assign_cycle_rounds` 본문 주석이다.
//
// ⚠️ **drizzle 로 쓰지 않는다** — `db:drift` 기준선이 이 표를 알아야 하기 때문에만
// 정의를 둔다(위 앵커 테이블과 같은 자세). 쓰기는 DB 함수와 운영자 스크립트뿐이다.
export const scopeCycleRounds = pgTable(
  "scope_cycle_rounds",
  {
    projectId: uuid("project_id").notNull(),
    anchorDate: date("anchor_date", { mode: "string" }).notNull(),
    surface: text("surface").notNull(), // standard | website | project
    roundDate: date("round_date", { mode: "string" }).notNull(),
    // canonical | prev_empty | next_empty | nearest | merged | project
    basis: text("basis").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.anchorDate] }),
    index("scope_cycle_rounds_seat_idx").on(t.projectId, t.roundDate),
    index("scope_cycle_rounds_round_idx").on(t.surface, t.roundDate),
  ],
);
export type ScopeCycleRoundRow = typeof scopeCycleRounds.$inferSelect;

// 회차 수준 **해소 결과** (migration 0078) — 조건부 회차 확장의 판정 근거.
//
// 0077 의 `refresh_answer_cycle_anchors` 는 받은 run 을 매번 회차 전체로 넓혀
// 재계산했다(글로벌 회차 = 답변 56,383건 · run 1,304개). 이 표가 회차의 해소 결과를
// 한 행으로 들고 있어, 값이 **달라졌을 때만** 넓힌다.
//
// ⚠️ **drizzle 로도 손으로도 쓰지 않는다** — `db:drift` 기준선이 이 표를 알아야 하기
// 때문에만 정의를 둔다. 손으로 고치면 조건부 확장이 "안 바뀌었다"고 오판한다.
export const scopeCycleAnchorState = pgTable(
  "scope_cycle_anchor_state",
  {
    // `hmg_cycle_key(project_id, cycle_anchor_at, run_id)` — 세션 타임존과 무관한 키.
    cycleKey: text("cycle_key").primaryKey(),
    projectId: uuid("project_id").notNull(),
    // 회차 키의 원재료인 `scope_runs.cycle_anchor_at` 의 **사본**이다(정본이 아니다).
    runCycleAnchorAt: timestamp("run_cycle_anchor_at", { withTimezone: true }),
    // 그 값이 NULL 인 run 은 회차를 이루지 못해 단독 회차가 된다.
    soloRunId: uuid("solo_run_id"),
    // ── 여기부터가 조건부 확장의 대조 대상 ──
    surface: text("surface").notNull(), // standard | website | project
    source: text("source").notNull(), // registry | ledger | run | fallback_measured
    anchorAt: timestamp("anchor_at", { withTimezone: true }).notNull(),
    anchorDate: date("anchor_date", { mode: "string" }).notNull(),
    roundDate: date("round_date", { mode: "string" }).notNull(),
    regUtcKept: boolean("reg_utc_kept").notNull().default(false),
    ledgerViewDate: date("ledger_view_date", { mode: "string" }),
    ledgerViewVariants: integer("ledger_view_variants").notNull().default(0),
    // ── 아래는 진단용 ──
    regAnchor: date("reg_anchor", { mode: "string" }),
    regSplit: boolean("reg_split").notNull().default(false),
    ledgerAnchorAt: timestamp("ledger_anchor_at", { withTimezone: true }),
    ledgerVariants: integer("ledger_variants").notNull().default(0),
    // 이 회차를 몇 번 넓혀서 재계산했는가(평소 호출이 좁게 도는지의 실측 근거).
    expandedCount: bigint("expanded_count", { mode: "number" }).notNull().default(0),
    lastExpandedAt: timestamp("last_expanded_at", { withTimezone: true }),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("scope_cycle_anchor_state_project_date_idx").on(t.projectId, t.anchorDate)],
);
export type ScopeCycleAnchorStateRow = typeof scopeCycleAnchorState.$inferSelect;

// run 단위 **0053 레지스트리 요약** (migration 0078).
//
// 회차 앵커 우선순위 1위는 "회차 답변 중 하나라도 0053 에 있으면" 이다. 그것을 회차
// 전체 답변 조인으로 구하면 5.6만 행을 훑게 되고, 0053(156,759행) 쪽으로 돌려도 전수
// 스캔이다. 레지스트리가 **붙은 run 만** 한 행씩 두면 회차 수준 판정이 `cycle_key`
// 인덱스 조회 하나가 되고, 접기가 없는 회차는 0행이다.
//
// ⚠️ drizzle 로 쓰지 않는다(`db:drift` 기준선용). 쓰기는 DB 함수뿐이다.
export const scopeCycleRegistryRuns = pgTable(
  "scope_cycle_registry_runs",
  {
    runId: uuid("run_id").primaryKey(),
    cycleKey: text("cycle_key").notNull(),
    projectId: uuid("project_id").notNull(),
    regAnchorMin: date("reg_anchor_min", { mode: "string" }).notNull(),
    regAnchorMax: date("reg_anchor_max", { mode: "string" }).notNull(),
    regRows: integer("reg_rows").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("scope_cycle_registry_runs_cycle_idx").on(t.cycleKey)],
);
export type ScopeCycleRegistryRunRow = typeof scopeCycleRegistryRuns.$inferSelect;

// 답변 드롭 레지스트리 (migration 0054) — 앵커 레지스트리의 쌍둥이.
//
// 앵커가 "날짜를 옮긴다"면 드롭은 "미러에서 뺀다". 같은 주에 같은 사이트가 두 번
// 측정된 중복 회차(2026-08-17~19 소규모 측정 + 8/21 정규 회차, 37사이트 7,130건)나
// 함대 회차와 어긋난 단독 회차(Kia/IT 7/20)는 접어도 해결되지 않는다 — 접으면 그 주에
// 같은 사이트의 답변이 두 배가 되어 KPI 가중이 왜곡된다. 유일한 처리는 제외다.
//
// 그런데 미러 행을 그냥 DELETE 하면 `replaceRun`(run 단위 delete+insert)이 그 run 을
// 다시 훑는 순간 되살아난다 — 앵커가 2026-08-31 에 겪은 것과 정확히 같은 형태다.
// 그래서 드롭도 **재싱크가 소비하는 입력 데이터**로 둔다: 이 테이블에 있는 job 은
// `replaceRun` 이 삽입 직후 같은 트랜잭션에서 다시 지운다(`scope_answer_drop_apply()`).
//
// `source_measured_at` 은 원복 근거. 행을 여기서 지우고 그 run 을 재싱크하면
// scope 원본이 그대로 돌아온다(scope 원본은 무변경 — 미러는 파생본이다).
export const scopeAnswerDrops = pgTable("scope_answer_drops", {
  jobId: uuid("job_id").primaryKey(), // scope job = scope_answers.job_id
  // 드롭 직전의 scope 원본 measured_at(UTC 날짜가 곧 "어느 측정일을 뺐나").
  sourceMeasuredAt: timestamp("source_measured_at", { withTimezone: true }),
  droppedAt: timestamp("dropped_at", { withTimezone: true }).notNull().defaultNow(),
  // 어느 드롭 배치에서 등록됐는지(예: `drop:2026-09-03 dup-0817-0819`). 사후 감사·
  // 배치 단위 롤백의 키. NOT NULL — 사유 없는 드롭은 등록할 수 없다.
  reason: text("reason").notNull(),
});
export type ScopeAnswerDropRow = typeof scopeAnswerDrops.$inferSelect;

// One (answer × brand entity) mention rollup, with the per-mention sentiment /
// position scope's classification pass produces.
export const scopeMentions = pgTable(
  "scope_mentions",
  {
    jobId: uuid("job_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    brand: text("brand"), // display_name
    entityType: text("entity_type"),
    mentionCount: integer("mention_count").notNull().default(0),
    sentimentPositive: integer("sentiment_positive").notNull().default(0),
    sentimentNeutral: integer("sentiment_neutral").notNull().default(0),
    sentimentNegative: integer("sentiment_negative").notNull().default(0),
    sentimentMixed: integer("sentiment_mixed").notNull().default(0),
    avgPosition: real("avg_position"),
    // surface forms + the brand this entity rolls up to — drives the answer-modal
    // brand/model highlight painting (a Product highlights under its brand).
    surfaces: text("surfaces").array(),
    brandRollupEntityId: uuid("brand_rollup_entity_id"),
    // mention-type breakdown (scope classification pass) for the 멘션 유형 chart.
    typeMention: integer("type_mention").notNull().default(0),
    typeRecommendation: integer("type_recommendation").notNull().default(0),
    typeComparison: integer("type_comparison").notNull().default(0),
    typeDefinition: integer("type_definition").notNull().default(0),
    typeFinalChoice: integer("type_final_choice").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.jobId, t.entityId] }),
    index("scope_mentions_brand_idx").on(t.brand),
    index("scope_mentions_job_idx").on(t.jobId),
  ],
);
export type ScopeMentionRow = typeof scopeMentions.$inferSelect;

// scope_mention_occurrences — 답변 원문 감성 밑줄용 발생 단위 미러 (migration 0061).
// 한 행 = (답변 job × 언급 발생). scope_mentions 가 job×entity 로 접힌 카운트라면
// 이건 그 카운트를 이루는 낱개다 — "이 문장이 왜 긍정인가"는 여기서만 답할 수 있다.
// 오프셋은 **코드포인트** 기준(scope#632). replaceRun 이 job 단위로 wipe+재삽입한다.
export const scopeMentionOccurrences = pgTable(
  "scope_mention_occurrences",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    brandRollupEntityId: uuid("brand_rollup_entity_id"),
    turnIndex: integer("turn_index"),
    sourceStart: integer("source_start").notNull(),
    sourceEnd: integer("source_end").notNull(),
    surfaceText: text("surface_text").notNull(),
    sentiment: text("sentiment").notNull(), // positive | negative | mixed | neutral
    mentionRole: text("mention_role"),
    assertion: text("assertion"),
    contextSnippet: text("context_snippet"),
    descriptors: text("descriptors").array().notNull().default([]),
    criteria: text("criteria").array().notNull().default([]),
  },
  (t) => [index("scope_mention_occurrences_job_idx").on(t.jobId)],
);
export type ScopeMentionOccurrenceRow = typeof scopeMentionOccurrences.$inferSelect;

// scope_answer_stances — 답변 단위 브랜드 스탠스 미러 (migration 0072).
// 한 행 = (답변 job × 턴 × 브랜드 롤업 엔티티). scope_mentions/scope_mention_occurrences
// 가 **발생(occurrence)** 축이라면 이건 **답변(answer)** 축이다 — 같은 4어휘
// (positive/negative/mixed/neutral)를 쓰지만 세는 단위가 다르므로 두 축의 숫자를
// 한 값으로 섞지 않는다(스펙 R6 · WU8 AC4).
//
// entity_id 는 멘션 엔티티가 아니라 **브랜드 롤업 엔티티**다 — 제품 멘션 5건이 같은
// 브랜드면 스탠스는 1건. 그래서 scope_mentions 의 (job_id, entity_id) 에 turn 축을
// 더한 (job_id, turn_index, entity_id) 가 PK다.
//
// evidence_start/evidence_end 는 **코드포인트** 오프셋이고, 답변 원문에서 인용문이
// 정확히 1회 찾아졌을 때만 채워진다(코어 FR4). 즉 `evidence_start IS NOT NULL` 이
// "원문 대조됨"의 유일한 판정이다 — 파일럿 실측 완전일치 79.2% · 불일치 8.6%.
// replaceRun 이 job 단위로 wipe+재삽입한다(occurrences 와 같은 멱등 규약).
export const scopeAnswerStances = pgTable(
  "scope_answer_stances",
  {
    jobId: uuid("job_id").notNull(),
    // 코어가 turn_index 를 안 싣는 과거 응답도 있어 기본 0. PK 구성요소라 NOT NULL.
    turnIndex: integer("turn_index").notNull().default(0),
    entityId: uuid("entity_id").notNull(),
    brandLabel: text("brand_label"),
    // 코어가 판정한 tracked 여부. ⚠️ hmg 의 당사 판정(단위 컨텍스트 ∩ 자사 명부)과
    // **같지 않다** — KPI 분모는 이 컬럼이 아니라 canonRollupSql/trackedRollupPredicate
    // 로 판정한다. 여기 두는 것은 진단·대조용.
    isTracked: boolean("is_tracked").notNull().default(false),
    stance: text("stance").notNull(), // positive | negative | mixed | neutral
    confidence: real("confidence"),
    evidenceText: text("evidence_text"),
    evidenceStart: integer("evidence_start"),
    evidenceEnd: integer("evidence_end"),
    reason: text("reason"),
    modelSlug: text("model_slug"),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.turnIndex, t.entityId] })],
);
export type ScopeAnswerStanceRow = typeof scopeAnswerStances.$inferSelect;

// One (answer × citation). `domain` is the registrable host computed at sync.
// `category` is scope's domain-classifier output, mirrored so the Citation
// Sources category card/pie/badge populate on the standard (mirror) path too
// (live·mirror parity). Nullable — "—" until scope classifies (별도 트랙).
// subcategory intentionally NOT mirrored (폐기 — 4-tier tree dropped).
export const scopeCitations = pgTable(
  "scope_citations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    jobId: uuid("job_id").notNull(),
    url: text("url"),
    domain: text("domain"),
    title: text("title"),
    refIndex: integer("ref_index"),
    category: text("category"),
    // URL 정규화 승격 컬럼 (migration 0052). 조회 시점 regexp_replace 사슬을
    // **동기화 시점 1회**로 옮긴 것 — 값의 정의는 scope-aggregates.ts 의
    // citationTrackedNormSql / citationBaseNormSql 과 1:1이고, DB 쪽 정본은
    // 마이그레이션이 만드는 IMMUTABLE 함수 citation_url_norm() /
    // citation_url_base_norm() / citation_url_host() 다. 셋의 일치는
    // scope-aggregates.citation-norm-columns.test.ts 가 강제한다.
    //   url_norm      = citation_url_norm(url)       — KPI⑥ tracked 정규화(쿼리 보존)
    //   url_host      = citation_url_host(url)       = split_part(url_norm,'/',1)
    //   url_base_norm = citation_url_base_norm(url)  — KPI⑤ base 정규화(쿼리 제거)
    // NULL 허용은 백필 재개 키다(`WHERE url_norm IS NULL`). 소비처는 NULL 을
    // 종전 식으로 폴백하므로 미충전 상태에서도 값이 틀리지 않는다.
    urlNorm: text("url_norm"),
    urlHost: text("url_host"),
    urlBaseNorm: text("url_base_norm"),
  },
  (t) => [
    index("scope_citations_job_idx").on(t.jobId),
    index("scope_citations_domain_idx").on(t.domain),
  ],
);
export type ScopeCitationRow = typeof scopeCitations.$inferSelect;

// scope_acr_rollups — ACR(AI's Choice Rate) prompt-run 단위 롤업 미러
// (migration 0025). 한 행 = (ACR prompt-run × 엔티티). scope jobs 피드의
// analysis.acr_summary.rows[]에서 오며, 같은 prompt-run에 속한 반복 job들이
// 동일 rows를 반복 반환하므로 sync가 prompt_run_id로 dedup해 1회만 쓴다.
// prompt_id/target/region/measured_at은 그 prompt-run의 job에서 비정규화 —
// 표준 필터와 "최신 주기" 선택(DISTINCT ON prompt×engine×region)을 SQL로
// 돌리기 위함. brand = 엔티티 표시명, parent_brand = product 행의 소속 브랜드
// 표시명 (둘 다 sync 시 resolved_mentions 이름 사전으로 해소).
export const scopeAcrRollups = pgTable(
  "scope_acr_rollups",
  {
    promptRunId: uuid("prompt_run_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    runId: uuid("run_id").notNull(),
    promptId: uuid("prompt_id"),
    target: text("target"),
    region: text("region"),
    measuredAt: timestamp("measured_at", { withTimezone: true }),
    rollupLevel: text("rollup_level"), // 'product' | 'brand' | 'company'
    brand: text("brand"),
    parentBrand: text("parent_brand"),
    brandRollupEntityId: uuid("brand_rollup_entity_id"),
    entityType: text("entity_type"),
    plannedIterations: integer("planned_iterations").notNull().default(0),
    validTurn1Iterations: integer("valid_turn1_iterations").notNull().default(0),
    validAcrIterations: integer("valid_acr_iterations").notNull().default(0),
    appearanceCount: integer("appearance_count").notNull().default(0),
    choiceCount: integer("choice_count").notNull().default(0),
    conditionalChoiceCount: integer("conditional_choice_count").notNull().default(0),
    offShortlistChoiceCount: integer("off_shortlist_choice_count").notNull().default(0),
    unresolvedChoiceCount: integer("unresolved_choice_count").notNull().default(0),
    genericChoiceCount: integer("generic_choice_count").notNull().default(0),
    appearanceRate: real("appearance_rate"),
    acr: real("acr"),
    overallChoiceShare: real("overall_choice_share"),
    coSingleEntity: integer("co_single_entity").notNull().default(0),
    coConditionalMultiple: integer("co_conditional_multiple").notNull().default(0),
    coGenericCategory: integer("co_generic_category").notNull().default(0),
    coResolvedOffShortlist: integer("co_resolved_off_shortlist").notNull().default(0),
    coUnresolvedChoice: integer("co_unresolved_choice").notNull().default(0),
    coNone: integer("co_none").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.promptRunId, t.entityId] }),
    index("scope_acr_rollups_run_idx").on(t.runId),
    index("scope_acr_rollups_prompt_idx").on(t.promptId),
    index("scope_acr_rollups_brand_rollup_idx").on(t.brandRollupEntityId),
  ],
);
export type ScopeAcrRollupRow = typeof scopeAcrRollups.$inferSelect;

// scope prompts (text + CEJ funnel stage) for prompt drilldown + funnel filter.
export const scopePrompts = pgTable("scope_prompts", {
  promptId: uuid("prompt_id").primaryKey(),
  text: text("text"),
  funnelStage: text("funnel_stage"),
  // 한글 프롬프트 판별의 저장본 (migration 0046). 종전에는 스냅샷 술어가
  // `sp.text ~ '[가-힣]'` 를 상관 EXISTS 안에서 돌려 프로덕션 실측 92,651회
  // 재평가했다. GENERATED ALWAYS ... STORED 라 text 갱신 시 PG 가 자동
  // 재계산 → 드리프트 불가능하고, drizzle 이 INSERT 컬럼 목록에서 제외하므로
  // 미러 upsert(scope-mirror.ts::upsertPrompts)는 이 컬럼을 몰라도 된다.
  // regions 미러링(H1~H6)이 들어오면 이 언어 휴리스틱 자체가 대체 대상이다 —
  // scope-aggregates.ts::koreanNonKrExclusion 주석 참조.
  isKorean: boolean("is_korean").generatedAlwaysAs(sql`text ~ '[가-힣]'`),
  // 언어·시장 축의 미러본 (migration 0048). scope 서버가 prompts 응답에 이미
  // 싣고 있고(2026-08-29 라이브 확인), 미러 싱크가 매 패스 그대로 받아 적는다.
  // 정본은 scope 쪽이며 이 표는 읽기 전용 사본이다 — 로컬 카탈로그
  // (`prompts.lang`/`prompts.regions`)와는 **다른 축**이다: 카탈로그는 발행 전
  // 편집 정본, 여기는 "scope 가 실제로 무엇으로 측정하고 있는가"의 관측값이다.
  // 둘의 불일치 = 발행 누락 또는 어드민 편집 미전파의 지문
  // (scripts/scope/verify-prompt-regions-mirror.ts 가 센다).
  //
  //   lang    : ISO 639-1 대문자 시트 코드 (EN·KO·ES·AR·…). NULL = 미지정.
  //   regions : 그 프롬프트가 담당하는 시장 코드 배열. 실국가는 ISO 3166-1
  //             alpha-2, 비국가 사이트 슬롯은 `x:` 네임스페이스 의사코드
  //             (x:WW·x:EU·x:ME·x:NBRAND·x:CPO). NULL/빈 배열 = 미지정(상속).
  //
  // ⚠️ is_korean 은 이 컬럼들이 대체할 임시 대용물이었고, 술어 교체(H3)는
  // 2026-08-30 에 들어갔다 — scope-aggregates.ts::regionTagExclusion.
  // **그래도 is_korean 은 지우지 않는다.** 신 술어는 `regions` 가 충전된
  // 상태에서만 제외를 낸다 — 미충전 DB(신규 환경·롤백·미러 지연)에서는 아무것도
  // 제외하지 않아 2026-08-20 사고가 재발한다. 두 술어를 AND 로 겹쳐 두는 것이
  // 그 구멍을 막는 이중화다(실측상 겹쳐도 결과는 신 술어 단독과 동일 —
  // 구만 제외되는 답변이 0건이었다). 순서를 뒤집으면 술어가 무제외로
  // 퇴화하거나 전량 탈락한다(표준 화면 공백 사고 전력 2회).
  lang: text("lang"),
  regions: text("regions").array(),
});
export type ScopePromptRow = typeof scopePrompts.$inferSelect;

// entity_registry — "누가 자사인가"의 전사(워크스페이스) 공통 명부 (migration 0023).
// 경쟁사는 저장하지 않는다: 언급된 브랜드 − 자사 = 경쟁사 (결정론적 파생,
// 2026-07-03 결정). role='excluded'는 향후 노이즈 엔티티 제외용 예약.
// 명부가 비면 lib/scope/hmg-brands.ts 시드로 폴백 — 게이트웨이가 로드해 filters
// 로 주입하고, 집계는 이 명부의 entity_id 집합으로 당사를 판정한다.
export const entityRegistry = pgTable("entity_registry", {
  entityId: uuid("entity_id").primaryKey(), // scope entity id
  name: text("name").notNull(),
  role: text("role").notNull().default("own"), // 'own' | 'excluded' (CHECK in SQL)
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type EntityRegistryRow = typeof entityRegistry.$inferSelect;

// keyword_volume_cache: DataForSEO search-volume responses cached per
// (keyword, location, language, sort) so the admin keyword-tools page doesn't
// re-pay for repeat lookups. NOT scope-gated — keyword volume is public Google
// data with no brand/region/country axis, so it's a plain reference table (read
// via lib/keyword/service.ts, which treats the cache as best-effort: a missing
// table just means every lookup hits the API). Ported from aeorank's
// keyword_search_volume_cache.
export const keywordVolumeCache = pgTable(
  "keyword_volume_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    keyword: text("keyword").notNull(),
    locationCode: integer("location_code"),
    languageCode: text("language_code"),
    sortBy: text("sort_by").notNull().default("search_volume"),
    searchVolume: integer("search_volume"),
    competition: text("competition"),
    competitionIndex: integer("competition_index"),
    cpc: real("cpc"),
    lowTopOfPageBid: real("low_top_of_page_bid"),
    highTopOfPageBid: real("high_top_of_page_bid"),
    monthlySearches: jsonb("monthly_searches"),
    rawData: jsonb("raw_data"),
    success: boolean("success").notNull().default(false),
    errorMessage: text("error_message"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("keyword_volume_cache_keyword_idx").on(t.keyword),
    index("keyword_volume_cache_expires_idx").on(t.expiresAt),
  ],
);
export type KeywordVolumeCacheRow = typeof keywordVolumeCache.$inferSelect;

// keyword_cache: generic payload cache for the Google Keyword intent view so a
// page refresh doesn't re-pay DataForSEO (SERP + volume) and OpenRouter (prompt
// drafting). Keyed by an opaque string ("insight|term|loc|lang", "related|…").
// Same posture as keyword_volume_cache: NOT scope-gated (public keyword data),
// best-effort (lib/keyword/cache.ts disables itself if the table is absent).
export const keywordCache = pgTable("keyword_cache", {
  cacheKey: text("cache_key").primaryKey(),
  payload: jsonb("payload").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
export type KeywordCacheRow = typeof keywordCache.$inferSelect;

// ─── 웹사이트 오피셜 사이트 ─────────────────────────────────────────────────
//
// 집계 단위: (brand, country_code) = scope 프로젝트 1개.
// 동일 국가에 언어가 여러 개인 경우(캐나다 en/fr 등)에도 하나의 scope 프로젝트로
// 묶이며, 프롬프트 레벨에서 lang_code로 구분한다.
// 갱신(재적재) 키: website_prompts.unique(site_id, file_seq, seq_no).

export const websiteSites = pgTable(
  "website_sites",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    brand:          text("brand").notNull(),          // Hyundai | Kia | Genesis | Hyundai N
    countryCode:    text("country_code").notNull(),   // ISO alpha-2 (또는 "worldwide", "middleeast")
    scopeProjectId: text("scope_project_id"),         // scope 프로젝트 생성 후 채워짐 (uuid string)
    createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("website_sites_brand_country_idx").on(t.brand, t.countryCode),
    index("website_sites_scope_project_idx").on(t.scopeProjectId),
  ],
);
export type WebsiteSiteRow = typeof websiteSites.$inferSelect;

// 프롬프트 1행 = 1개. target_url은 KPI #6(타겟 출처인용율) 추적 기준.
// domain + lang_code는 어느 xlsx 파일에서 왔는지 추적(brand / country는 site에 있음).
export const websitePrompts = pgTable(
  "website_prompts",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    siteId:        uuid("site_id").notNull(),         // → website_sites.id
    fileSeq:       integer("file_seq").notNull(),     // xlsx 파일 번호 (1~107)
    domain:        text("domain").notNull(),          // 파일 원본 도메인 (hyundaicanada.com)
    langCode:      text("lang_code").notNull(),       // BCP-47 (en, fr, ko, it …)
    seqNo:         integer("seq_no").notNull(),       // xlsx 행 번호
    targetUrl:     text("target_url").notNull(),      // 타겟 페이지 URL — KPI #6 인용 기대값
    promptText:    text("prompt_text").notNull(),
    // KPI ⑤ 자사 판정 base (host + 경로, 정규화 형태 — 예 'hyundaicanada.com/fr').
    // 측정 유닛 = (site_id, file_seq) 이므로 같은 유닛의 행은 같은 값을 갖는다.
    // 여기에 선언하는 이유: website_sites 는 (brand × country) 단위라 **언어·URL 패턴으로
    // 갈리는 유닛을 표현할 수 없다** — 2026-09-01 전수 확인에서 언어별로 base 가 다른
    // 사이트 13곳(현대/기아/제네시스 캐나다, Kia US en/es, Kia BE fr/nl, 현대 ID·TH,
    // 중동·SA·worldwide 계열)과, 언어가 같은데 base 가 셋인 Genesis/SA(dammam·jeddah·
    // riyadh)가 나왔다. NULL 이면 카탈로그(geo-catalog) 폴백.
    ownedBaseUrl:  text("owned_base_url"),

    scopePromptId: text("scope_prompt_id"),           // scope 프롬프트 푸시 후 채워짐 (uuid string)
    createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("website_prompts_site_file_seq_idx").on(t.siteId, t.fileSeq, t.seqNo),
    index("website_prompts_site_id_idx").on(t.siteId),
    index("website_prompts_lang_idx").on(t.siteId, t.langCode),
  ],
);
export type WebsitePromptRow = typeof websitePrompts.$inferSelect;

// scope_context_* — one-time mirror of scope's Automotive-industry
// ConsumerContext/ConsumerRequirement corpus (2026-07-07, industry entity id
// 00000000-0000-0000-0000-000000000401, 236,781 utterances). scope's own
// GET /api/v1/context-map read endpoint times out at this corpus scale (a
// scope-side bug — full sequential scan per request, no index on
// utterances.metadata->>'industry_id'/'decision_context_flag'), so this
// mirrors the raw ontology pulled directly off scope's live Postgres instead
// of syncing through the HTTP API. Not scope-gated (role/brand/region) — this
// is a shared industry-wide corpus, not brand-scoped project data.
export const scopeContextEntities = pgTable(
  "scope_context_entities",
  {
    id: uuid("id").primaryKey(), // scope entity id
    type: text("type").notNull(), // 'ConsumerContext' | 'ConsumerRequirement'
    canonicalName: text("canonical_name").notNull(),
    dimension: text("dimension"), // ConsumerContext only: demographic/trait/lifestage/role/occasion/usecase/emotional
    mentionCount: integer("mention_count").notNull().default(0),
    utteranceCount: integer("utterance_count").notNull().default(0),
    sentimentPositive: integer("sentiment_positive").notNull().default(0),
    sentimentNegative: integer("sentiment_negative").notNull().default(0),
    sentimentNeutral: integer("sentiment_neutral").notNull().default(0),
  },
  (t) => [index("scope_context_entities_type_idx").on(t.type)],
);
export type ScopeContextEntityRow = typeof scopeContextEntities.$inferSelect;

// context (ConsumerContext) → requirement (ConsumerRequirement) co-mention —
// UI's "구매 맥락이 유발하는 조건" (drives) link.
export const scopeContextDrives = pgTable(
  "scope_context_drives",
  {
    contextId: uuid("context_id").notNull(),
    requirementId: uuid("requirement_id").notNull(),
    coCount: integer("co_count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.contextId, t.requirementId] }),
    index("scope_context_drives_requirement_idx").on(t.requirementId),
  ],
);
export type ScopeContextDriveRow = typeof scopeContextDrives.$inferSelect;

// requirement ↔ requirement co-mention — UI's "조합 패턴" (combinations).
export const scopeContextCombinations = pgTable(
  "scope_context_combinations",
  {
    condA: uuid("cond_a").notNull(),
    condB: uuid("cond_b").notNull(),
    coCount: integer("co_count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.condA, t.condB] })],
);
export type ScopeContextCombinationRow = typeof scopeContextCombinations.$inferSelect;

// Up to 8 sample utterances per entity (by mention confidence), for the UI's
// "근거 인용" panel.
export const scopeContextEvidence = pgTable(
  "scope_context_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId: uuid("entity_id").notNull(),
    utteranceId: uuid("utterance_id").notNull(),
    quote: text("quote").notNull(),
    sourceHost: text("source_host"),
    sourceUrl: text("source_url"),
    sentiment: text("sentiment"),
  },
  (t) => [index("scope_context_evidence_entity_idx").on(t.entityId)],
);
export type ScopeContextEvidenceRow = typeof scopeContextEvidence.$inferSelect;

// Distinct source-host counts per entity, for the UI's "소스 도메인" bars.
export const scopeContextDomains = pgTable(
  "scope_context_domains",
  {
    entityId: uuid("entity_id").notNull(),
    host: text("host").notNull(),
    n: integer("n").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.entityId, t.host] })],
);
export type ScopeContextDomainRow = typeof scopeContextDomains.$inferSelect;

// Per-project cache of the LLM-generated candidate prompts derived from the
// context map (decision B, 2026-07-09: brand/project-differentiated, generated
// in hmg-geo via OpenRouter — see lib/social-scraping/generate-context-prompts.ts).
// The matrix is a static mirror, so prompts are generated once per project on
// first visit and reused; `model` records which model produced them (for a
// future provider swap / regeneration). `prompts` is a GeneratedPrompt[] blob.
export const scopeContextPromptCache = pgTable("scope_context_prompt_cache", {
  projectId: uuid("project_id").primaryKey(),
  prompts: jsonb("prompts").notNull().default(sql`'[]'::jsonb`),
  model: text("model"),
  generatedAt: timestamp("generated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Optimistic lock token (0030). The whole prompt set is one jsonb blob that
  // "더 생성" and "선택 삭제" both read-modify-write, so without this a pair of
  // concurrent edits silently loses one of them.
  //
  // Deliberately NOT generatedAt: timestamptz keeps microseconds, a JS Date only
  // milliseconds, so a read→write round-trip changes the value and the guard
  // would never match (verified against production rows).
  version: integer("version").notNull().default(0),
});
export type ScopeContextPromptCacheRow =
  typeof scopeContextPromptCache.$inferSelect;

// ─── bff_audit_logs — real sink for the BFF audit trail ────────────────────
// Replaces the console PLACEHOLDER in lib/audit.ts (spec
// 2026-07-23-add-bff-audit-sink). Append-only; every row is one attributed BFF
// event:
//   - kind='scope_call'  → lib/scope/server.ts::enforce() (per-user attribution
//     for scope API calls — the single workspace key can't tell callers apart).
//   - kind='data_access' → hmg-geo's own DB writes (admin governance, entity
//     roster) where the app layer is the only guard (no RLS).
//
// Deliberately NO FK on actor_id → profiles.id: audit rows must OUTLIVE the
// account (a deleted user's trail stays). `actor_role` is a snapshot of the
// caller's role AT CALL TIME (a later role change must not rewrite history).
// `target` holds the table name for data_access (null for scope_call); `detail`
// carries the ScopeFilter snapshot (scope_call) or is null.
//
// Additive-only (0007 outage lesson): a brand-new table, no ALTER on existing
// tables — old code keeps working, only lib/audit.ts sees it. This table is a
// sink only; inserts into it are NOT themselves audited (no recursion).
export const bffAuditKindEnum = pgEnum("bff_audit_kind", [
  "scope_call",
  "data_access",
]);

export const bffAuditLogs = pgTable(
  "bff_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid("actor_id").notNull(), // = profiles.id (no FK — see above)
    actorRole: text("actor_role").notNull(), // role snapshot at call time
    kind: bffAuditKindEnum("kind").notNull(),
    action: text("action").notNull(),
    target: text("target"), // data_access: the table touched; scope_call: null
    detail: jsonb("detail"), // scope_call: ScopeFilter snapshot; else null
  },
  (t) => [
    index("bff_audit_logs_ts_idx").on(t.ts),
    index("bff_audit_logs_actor_ts_idx").on(t.actorId, t.ts),
  ],
);
export type BffAuditLogRow = typeof bffAuditLogs.$inferSelect;

// GA4 연동 레지스트리 (migration 0036, WBS 1.2.2) — brand × country → GA4
// property_id 매핑. 코드/env(lib/ga4/property-map MAP) 대신 DB가 정본이 되며,
// resolveProperty는 DB 우선 + 기존 env MAP 폴백으로 무중단 전환한다.
// status: active(probe 검증됨) | pending_grant(뷰어 권한 대기) | unmapped(속성ID 미정).
// 설계: docs/ga4-connection-permission-design.md.
export const ga4Properties = pgTable(
  "ga4_properties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brand: text("brand").notNull(),
    countryCode: text("country_code").notNull(), // ISO alpha-2
    propertyId: text("property_id"), // null = 속성ID 미확정
    status: text("status").notNull().default("pending_grant"),
    grantedAt: timestamp("granted_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("ga4_properties_brand_country_idx").on(t.brand, t.countryCode),
  ],
);
export type Ga4PropertyRow = typeof ga4Properties.$inferSelect;

// GA4 추적 이벤트 선택 (migration 0037) — property_id 별로 "전환으로 셀
// 이벤트"를 admin이 골라 저장한다. 비어 있으면(한 행도 없으면) 전환 KPI는 기존대로
// GA4 key events 를 그대로 쓴다(fallback). 한 행이라도 있으면 그 eventName 집합이
// 전환 분자(eventCount)의 정의가 된다. property_id 로 키를 잡아 레지스트리 매핑과
// 프로젝트 오버라이드(projects.ga4PropertyId)가 같은 선택을 공유한다.
export const ga4TrackedEvents = pgTable(
  "ga4_tracked_events",
  {
    propertyId: text("property_id").notNull(),
    eventName: text("event_name").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.propertyId, t.eventName] })],
);
export type Ga4TrackedEventRow = typeof ga4TrackedEvents.$inferSelect;

// prompt_audit_logs: 표준 카탈로그 감사 원장 (0041, catalog-prompt-audit).
// append-only — 이 테이블에는 update/delete 리포지터리 메서드를 만들지 않는다.
// changes = 바뀐 필드만 {"text":{"old":"…","new":"…"}} 형태(문자열화 저장).
// event_type/actor_type CHECK는 SQL에. FK 없음 — 이력은 프롬프트가 사라져도 남는다.
export const promptAuditLogs = pgTable("prompt_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  promptId: uuid("prompt_id").notNull(),
  projectId: uuid("project_id").notNull(),
  actorId: uuid("actor_id"),
  actorType: text("actor_type").notNull().default("user"),
  eventType: text("event_type").notNull(),
  changes: jsonb("changes").notNull().default(sql`'{}'::jsonb`),
  batchId: uuid("batch_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PromptAuditLogRow = typeof promptAuditLogs.$inferSelect;

// citation_domain_overrides: 인용 출처 카테고리 운영자 교정층 (0043,
// citation-category-override). 분류는 read-time 파생(lib/citation-categorizer)
// 이라 이 테이블에 행이 생기는 순간 백필 없이 전 이력이 재분류된다.
//
// - domain = PK. **정규화된 registrable domain** (lowercase + 선행 `www.` 제거)
//   — categorizeDomain() 이 조회 전에 같은 정규화를 하므로 키가 어긋나면 조용히
//   무시된다. 리포지토리(citation-overrides.ts)가 쓰기 시점에 정규화를 강제한다.
// - category = 택소노미 11종(lib/citation-categorizer/taxonomy.ts) 중 하나.
//   CHECK 는 걸지 않는다 — 택소노미가 코드 정본이라 값 추가 때마다 ALTER 가 필요해지고
//   (additive-only 규율 위반), 로드 시점에 isCitationCategory 로 걸러진다.
// - 행 삭제 = 원복(기본 분류로 되돌림). 별도 audit 테이블 없이 updated_by/updated_at.
export const citationDomainOverrides = pgTable("citation_domain_overrides", {
  domain: text("domain").primaryKey(),
  category: text("category").notNull(),
  note: text("note"),
  updatedBy: uuid("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CitationDomainOverrideRow = typeof citationDomainOverrides.$inferSelect;

// ─── qa_* — Raw Data QA Console (검수 콘솔) ─────────────────────────────────
// 설계 정본: docs/specs/2026-09-04-raw-data-qa-console-design.md
//
// scope_* 미러와 **FK 로 묶지 않는다.** 미러 싱크의 replaceRun 은 run 단위
// delete+insert 라, FK 가 있으면 정규 재싱크가 검수 기록을 함께 지운다 —
// scope_answer_drops(0054)가 독립 테이블인 것과 정확히 같은 논리다.

// 게이트 통과 1회 = 1행. 락 소유자 식별 + 사후 감사(누가 언제 들어왔나)의 근거.
export const qaReviewSessions = pgTable("qa_review_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  reviewerName: text("reviewer_name").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  userAgent: text("user_agent"),
  // HMAC-SHA256(RAW_DATA_QA_SECRET, ip). 원문 IP 는 저장하지 않는다.
  ipHash: text("ip_hash"),
});
export type QaReviewSessionRow = typeof qaReviewSessions.$inferSelect;

// 한 답변 = 한 행. 행이 없으면 미검수.
// status 는 **파생값**이다 — sectionFlags 에 "issue" 가 하나라도 있으면 'issue'.
// 검수자가 따로 고르지 않는다(설계 §5).
export const qaAnswerReviews = pgTable(
  "qa_answer_reviews",
  {
    jobId: uuid("job_id").primaryKey(), // = scope_answers.job_id (FK 없음)
    status: text("status").notNull(),
    // { answer|prompt|mentions|citations|acr|meta : "ok"|"issue" }
    sectionFlags: jsonb("section_flags").notNull().default(sql`'{}'::jsonb`),
    reviewerName: text("reviewer_name").notNull(),
    sessionId: uuid("session_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("qa_answer_reviews_status_idx").on(t.status),
    index("qa_answer_reviews_reviewer_idx").on(t.reviewerName),
  ],
);
export type QaAnswerReviewRow = typeof qaAnswerReviews.$inferSelect;

// 낱알 단위 노트. targetLabel 은 **스냅샷**이다 — 미러가 재싱크되면
// scope_citations.id(bigserial)가 바뀌어, 라벨이 없으면 그 노트가 무엇을
// 지목했는지 영구히 알 수 없게 된다.
export const qaReviewNotes = pgTable(
  "qa_review_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id").notNull(),
    // 'answer' | 'prompt' | 'mention' | 'citation' | 'acr' | 'meta' (CHECK 는 SQL)
    targetKind: text("target_kind").notNull(),
    targetKey: text("target_key"), // entity_id / citation id / null
    targetLabel: text("target_label"),
    severity: text("severity").notNull().default("issue"), // issue | question | info
    body: text("body").notNull(),
    reviewerName: text("reviewer_name").notNull(),
    sessionId: uuid("session_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
  },
  (t) => [
    index("qa_review_notes_job_idx").on(t.jobId),
    index("qa_review_notes_created_idx").on(t.createdAt),
  ],
);
export type QaReviewNoteRow = typeof qaReviewNotes.$inferSelect;

// 동시 검수 방지. 획득은 단일 SQL upsert 라 경쟁 조건이 구조적으로 없다
// (qa-review.ts::acquireLock — ON CONFLICT ... WHERE 가 read-then-write 의 창을 없앤다).
export const qaAnswerLocks = pgTable(
  "qa_answer_locks",
  {
    jobId: uuid("job_id").primaryKey(),
    sessionId: uuid("session_id").notNull(),
    reviewerName: text("reviewer_name").notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("qa_answer_locks_heartbeat_idx").on(t.heartbeatAt)],
);
export type QaAnswerLockRow = typeof qaAnswerLocks.$inferSelect;

// ════════════════════════════════════════════════════════════════════════════
// 0080 — 발행 리포트 사실표 (발행 회차는 발행값을 읽는다)
// ════════════════════════════════════════════════════════════════════════════
//
// 고객에게 나간 리포트 HTML 안 `<script id="sb-data">` 의 **정수 쌍을 그대로** 담는다.
// 값이 라이브에서 파생되지 않으므로 미러 재싱크·재분석·늦은 도착에도 흔들리지 않는다.
// 바뀌는 유일한 경로는 정정 발행(새 행 + 앞 행 superseded)이다.
//
// ⚠️ `summary_*` 계열과 달리 **schema.ts 에 모델링한다** — 그 표들은 스크립트만 읽지만
//    이 표는 앱 리더(lib/db/repositories/report-publications.ts)가 drizzle 로 읽는다.
//    그래서 `db:apply` → 배포 순서를 지켜야 한다(반대면 싱크 42703).
// ⚠️ FK 를 두지 않는다 — 미러 재싱크의 run 단위 delete+insert 가 발행값을 지우면
//    안 된다(0053·0054·0077 과 같은 논리). 대시보드와는 file_seq 로만 만난다.
export const reportPublications = pgTable(
  "report_publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    surface: text("surface").notNull(),
    brandScope: text("brand_scope").notNull(),
    volume: text("volume"),
    version: text("version").notNull(),
    title: text("title"),
    cycleLabel: text("cycle_label"),
    cycleLabelEn: text("cycle_label_en"),
    // 회차 귀속 날짜(sb-data asOf.curLabel). **측정일이 아니다**(asofCur 가 측정일).
    roundDate: date("round_date").notNull(),
    prevRoundDate: date("prev_round_date"),
    asofCur: date("asof_cur"),
    asofPrev: date("asof_prev"),
    publishedOn: date("published_on"),
    engines: text("engines").array(),
    excludedFs: integer("excluded_fs").array(),
    benchN: integer("bench_n"),
    benchNAll: integer("bench_n_all"),
    srcCite: text("src_cite"),
    sourceFilename: text("source_filename").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    manifestVerified: boolean("manifest_verified").notNull().default(false),
    verifyNote: text("verify_note"),
    sbDataVersion: text("sb_data_version").notNull(),
    status: text("status").notNull().default("active"),
    supersededBy: uuid("superseded_by"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("report_publications_slug_uq").on(t.slug),
    // (표면, 회차, 브랜드 범위) 당 active 는 최대 1행 — 리더가 둘 중 하나를 임의로
    // 고르는 것을 표가 막는다.
    uniqueIndex("report_publications_active_uq")
      .on(t.surface, t.roundDate, t.brandScope)
      .where(sql`${t.status} = 'active'`),
    index("report_publications_sha_idx").on(t.sourceSha256),
  ],
);
export type ReportPublicationRow = typeof reportPublications.$inferSelect;

// 사이트(유닛) 단위 정수 쌍. **백분율은 저장하지 않는다** — 동일성은 정수 쌍에 건다.
export const reportSiteFacts = pgTable(
  "report_site_facts",
  {
    publicationId: uuid("publication_id").notNull(),
    fileSeq: integer("file_seq").notNull(),
    brand: text("brand").notNull(),
    countryCode: text("country_code"),
    countryName: text("country_name"),
    regionLabel: text("region_label"),
    langCode: text("lang_code"),
    langLabel: text("lang_label"),
    agencyStatus: text("agency_status"),
    // 헤드라인 평균 모수에 드는가. 값은 적재기가 발행물에서 역산한다(하드코딩 금지).
    inHeadlinePool: boolean("in_headline_pool").notNull().default(true),
    targetHitPrompts: integer("target_hit_prompts").notNull(),
    measuredPrompts: integer("measured_prompts").notNull(),
    ownedPrompts: integer("owned_prompts").notNull(),
    ownedPromptsDen: integer("owned_prompts_den").notNull(),
    ownedAnswers: integer("owned_answers"),
    monitoredAnswers: integer("monitored_answers"),
    prompts: integer("prompts"),
    answers: integer("answers"),
    prevTargetHitPrompts: integer("prev_target_hit_prompts"),
    prevMeasuredPrompts: integer("prev_measured_prompts"),
    prevOwnedPrompts: integer("prev_owned_prompts"),
    prevOwnedPromptsDen: integer("prev_owned_prompts_den"),
    raw: jsonb("raw").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.publicationId, t.fileSeq] }),
    index("report_site_facts_fs_idx").on(t.fileSeq),
  ],
);
export type ReportSiteFactRow = typeof reportSiteFacts.$inferSelect;

// 엔진별 **분자만**. 분모가 없고 Σeng ≠ c6[0] 이라(105개 중 97개) 엔진 필터는
// 발행값으로 답할 수 없다 — 리더는 라이브로 폴백한다. 감사용으로만 싣는다.
export const reportSiteEngineFacts = pgTable(
  "report_site_engine_facts",
  {
    publicationId: uuid("publication_id").notNull(),
    fileSeq: integer("file_seq").notNull(),
    engine: text("engine").notNull(),
    targetHitPrompts: integer("target_hit_prompts").notNull(),
    prevTargetHitPrompts: integer("prev_target_hit_prompts"),
  },
  (t) => [primaryKey({ columns: [t.publicationId, t.fileSeq, t.engine] })],
);
export type ReportSiteEngineFactRow = typeof reportSiteEngineFacts.$inferSelect;
