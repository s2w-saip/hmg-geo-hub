import "server-only";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  standardPrompts,
  standardKeywords,
  standardSources,
  prompts,
  scopePrompts,
  type StandardPromptRow,
  type StandardKeywordRow,
  type StandardSourceRow,
} from "@/lib/db/schema";
import type { PromptType } from "@/lib/db/repositories/prompts";
import type { AllowedScope } from "@/lib/auth/types";
import { UnauthorizedError } from "@/lib/auth/errors";
import { UMBRELLA_BRAND } from "@/lib/scope/brand-presence";
import { isExcludedStandardPrompt } from "@/lib/scope/standard-prompt-exclusions";
import { effectiveScopeCountries } from "@/lib/rhq";
import { normalizeMarket, isPseudoRegion } from "@/lib/standards/prompt-markets";

// HMG Standard root catalog lives in the project-level `prompts` table under
// this fixed project_id (the v0.4 cutover catalog — `name = "HMG Standard
// (root catalog)"`). The admin page joins through it to surface brand /
// listType / depth1-4 / funnel + scope_prompt_id linkage in one query.
export const STANDARD_ROOT_PROJECT_ID =
  process.env.STANDARD_ROOT_PROJECT_ID ?? "26751906-c175-485c-9e69-29fc68d0fdbb";

// Standard catalog repositories (Task L). Admin-only — the action layer
// enforces role check. These methods don't filter by brand/scope themselves
// because the admin UI shows everything; per-brand filtering happens at the
// dashboard consumer site.

// ─── standard_prompts ────────────────────────────────────────────────────

export type StandardKeywordSource = "google_keyword" | "community_voc";

export interface StandardPromptInsert {
  text: string;
  promptType?: PromptType | null;
  category?: string | null;
  brand?: string | null;
  enabled?: boolean;
  createdBy: string;
}

export interface StandardPromptUpdate {
  text?: string;
  promptType?: PromptType | null;
  category?: string | null;
  brand?: string | null;
  enabled?: boolean;
}

export interface StandardPromptRepository {
  list(): Promise<StandardPromptRow[]>;
  insert(input: StandardPromptInsert): Promise<StandardPromptRow>;
  update(id: string, patch: StandardPromptUpdate): Promise<StandardPromptRow>;
  delete(id: string): Promise<void>;
}

export const standardPromptRepository: StandardPromptRepository = {
  async list() {
    return getDb()
      .select()
      .from(standardPrompts)
      .orderBy(desc(standardPrompts.createdAt));
  },

  async insert(input) {
    const rows = await getDb()
      .insert(standardPrompts)
      .values({
        text: input.text,
        promptType: input.promptType ?? null,
        category: input.category ?? null,
        brand: input.brand ?? null,
        enabled: input.enabled ?? true,
        createdBy: input.createdBy,
      })
      .returning();
    const created = rows[0];
    if (!created) throw new Error("standardPromptRepository.insert: no row returned");
    return created;
  },

  async update(id, patch) {
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (patch.text !== undefined) set.text = patch.text;
    if (patch.promptType !== undefined) set.promptType = patch.promptType;
    if (patch.category !== undefined) set.category = patch.category;
    if (patch.brand !== undefined) set.brand = patch.brand;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const rows = await getDb()
      .update(standardPrompts)
      .set(set)
      .where(eq(standardPrompts.id, id))
      .returning();
    const updated = rows[0];
    if (!updated) throw new Error("standardPromptRepository.update: no row matched id=" + id);
    return updated;
  },

  async delete(id) {
    await getDb().delete(standardPrompts).where(eq(standardPrompts.id, id));
  },
};

// ─── standard root catalog (prompts table joined with scope_prompts) ─────
// One row per catalog entry: 7 framework labels (brand/listType/depth1-4/funnel)
// + the scope linkage (null = not yet pushed to scope → "미추적").

export interface StandardCatalogRow {
  id: string;
  text: string;
  promptType: PromptType | null;
  category: string | null;
  brand: string | null;
  // 브랜드 유무 (migration 0032) — 'branded' | 'unbranded' | null.
  // brand(소속 카탈로그)와 별개 축: 프롬프트 문구에 브랜드명이 들어가는지.
  brandPresence: string | null;
  listType: string | null;
  depth1: string | null;
  depth2: string | null;
  depth3: string | null;
  depth4: string | null;
  funnelStage: string | null;
  // 측정 종류 (migration 0025) — 'single' | 'acr'. 로컬이 정본, scope에 push.
  kind: string;
  // 대상 시장·언어 (migration 0047). `lang` = 번역 시트 탭 코드(대문자 ISO 639-1),
  // `regions` = 담당 시장(ISO alpha-2 + `x:` 접두 의사코드). NULL = 미지정(상속).
  // ⚠️ 계정 권한 스코프(region/country 롤)와 다른 축이다 — 이것은 카탈로그 속성이다.
  lang: string | null;
  regions: string[] | null;
  // Linked scope_prompts.prompt_id. null = not pushed to scope (= 미추적).
  scopePromptId: string | null;
  // From scope_prompts side, if linked — surfaced for completeness/debugging.
  scopeText: string | null;
  // soft-delete (0041, catalog-prompt-audit). null = 활성. 삭제 행은 admin의
  // "삭제됨" 뷰에서만 보이고 뷰어·집계·기본 목록에서는 제외된다.
  deletedAt: Date | null;
}

export interface StandardCatalogStats {
  total: number;
  tracked: number;   // scope_prompt_id IS NOT NULL — 사용중
  untracked: number; // catalog row without scope link — 미추적
  // Drift in the OTHER direction: scope rows the catalog doesn't claim.
  // Always read from scope_prompts side; surfaces editorial cleanup work.
  scopeOrphans: number;
  // kind='acr' 행 수 — ACR(2턴 선택 측정) 대상 규모 배지.
  acr: number;
  // soft-delete 행 수 — includeDeleted 조회일 때만 계산(아니면 0).
  deleted: number;
}

// Pull every catalog row for the root standard project + count drift.
// Sorted by depth1/depth2/depth3 then text so the table reads as the
// editorial framework would lay it out.
export async function listStandardCatalog(opts?: { includeDeleted?: boolean }): Promise<{
  rows: StandardCatalogRow[];
  stats: StandardCatalogStats;
}> {
  const db = getDb();
  const rows = await db
    .select({
      id: prompts.id,
      text: prompts.text,
      promptType: prompts.promptType,
      category: prompts.category,
      brand: prompts.brand,
      brandPresence: prompts.brandPresence,
      listType: prompts.listType,
      depth1: prompts.depth1,
      depth2: prompts.depth2,
      depth3: prompts.depth3,
      depth4: prompts.depth4,
      funnelStage: prompts.funnelStage,
      kind: prompts.kind,
      lang: prompts.lang,
      regions: prompts.regions,
      scopePromptId: prompts.scopePromptId,
      scopeText: scopePrompts.text,
      deletedAt: prompts.deletedAt,
    })
    .from(prompts)
    .leftJoin(scopePrompts, eq(prompts.scopePromptId, scopePrompts.promptId))
    .where(
      and(
        eq(prompts.projectId, STANDARD_ROOT_PROJECT_ID),
        opts?.includeDeleted ? undefined : isNull(prompts.deletedAt),
      ),
    )
    .orderBy(asc(prompts.depth1), asc(prompts.depth2), asc(prompts.depth3), asc(prompts.text));

  // Drift count from the scope side: scope_prompts not claimed by any catalog row.
  const orphanRows = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(scopePrompts)
    .leftJoin(prompts, eq(prompts.scopePromptId, scopePrompts.promptId))
    .where(sql`${prompts.id} IS NULL`);
  const scopeOrphans = orphanRows[0]?.count ?? 0;

  // stats는 활성 행 기준 — 삭제 행은 deleted 카운트로만 잡힌다.
  const active = rows.filter((r) => r.deletedAt === null);
  const tracked = active.filter((r) => r.scopePromptId !== null).length;
  return {
    rows: rows as StandardCatalogRow[],
    stats: {
      total: active.length,
      tracked,
      untracked: active.length - tracked,
      scopeOrphans,
      acr: active.filter((r) => r.kind === "acr").length,
      deleted: rows.length - active.length,
    },
  };
}

// ── 열람 스코프 ∩ 대상 시장 (B1, 제품 결정 2026-09-03) ────────────────────
// 계정 권한 스코프의 허용 국가(`effectiveScopeCountries`)와 카탈로그 행의 대상
// 시장(`prompts.regions`)의 **교집합**만 보이게 하는 SQL 술어. 순수 정본은
// `lib/standards/prompt-markets.ts::marketInScope` — 두 구현은 같은 규칙이어야
// 한다(어긋나면 "필터 옵션엔 뜨는데 고르면 0행"이 된다).
//
// 규칙 3줄:
//   ① regions NULL          → 미지정(상속) = 전 시장 → 보인다
//   ② 실국가 태그가 없다     → 의사코드(x:*)만 = 시장 귀속 없음 → 보인다
//   ③ 그 외                 → 실국가 겹침(대소문자·공백 정규화 후)
// 의사코드를 국가로 펼치지 않는 근거는 prompt-markets.ts 의 주석 참조(실측:
// 의사코드만 가진 행 0건 · 펼치면 태깅 안 된 시장까지 열람이 넓어짐).
//
// 컬럼 부재 내성이 필요 없는 이유: `regions`(0047)는 이 리포가 소유한 로컬 컬럼이고
// 같은 함수가 이미 `regions: prompts.regions` 를 무조건 select 하고 있다 — 컬럼이
// 없으면 이 술어 이전에 select 가 먼저 죽는다(미러 `scope_prompts.regions` 쪽의
// 프로브 방어와는 다른 상황).
export function catalogMarketScopeCondition(allowed: string[]): SQL | null {
  const codes = [
    ...new Set(
      allowed
        .map((c) => normalizeMarket(c))
        .filter((c): c is string => c !== null && !isPseudoRegion(c)),
    ),
  ];
  if (codes.length === 0) return null; // 허용값이 전부 무효 → 국가 스코프 미설정과 동일
  const list = sql.join(
    codes.map((c) => sql`${c}`),
    sql`, `,
  );
  return sql`(
    ${prompts.regions} IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM unnest(${prompts.regions}) AS r
      WHERE btrim(r) <> '' AND lower(btrim(r)) NOT LIKE 'x:%'
    )
    OR EXISTS (
      SELECT 1 FROM unnest(${prompts.regions}) AS r
      WHERE lower(btrim(r)) NOT LIKE 'x:%' AND upper(btrim(r)) IN (${list})
    )
  )`;
}

// Read-only viewer feed (/standard/prompts): the root standard catalog,
// BRAND-SCOPED to the caller and with multi-brand "잘못" rows excluded.
// Default-deny: a missing scope throws (mirrors scopeWhere). The brand
// condition mirrors the pure `standardPromptInScope` predicate in
// scope-policy.ts — null OR umbrella 'HMG' = 공통 (visible to all brand-scoped
// users), marque-tagged = only that brand's scope.
//
// 시장·언어 축에 대하여 (0047 이후): 카탈로그는 이제 `lang` + `regions`(대상
// 시장)를 갖는다. 옛 주석("region/country are absent from the catalog")은 거짓이
// 되었다.
//
// ⚠️ 2026-09-03 (B1, 제품 결정): **대상 시장도 열람 스코프를 좁힌다.** 종전에는
// 브랜드만 좁혔고 그래서 country 계정(Hyundai·KR)에게 스페인어 CL/CO/ES 행까지
// 보였다 — 화면의 열람 범위 칩이 `Hyundai · KR` 로 국가 스코프를 약속하는데
// 데이터가 그것을 배반했다(고객 제보). 이제 `catalogMarketScopeCondition` 이
// `effectiveScopeCountries(scope)` 와 `prompts.regions` 의 교집합으로 좁힌다.
// 프롬프트 리전 UI 플랜 §비목표("계정 권한과 대상 시장의 연동")를 뒤집는 결정이다.
//
// ⚠️ 2026-08-29 (플랜 D15): 옛 `scope_prompt_id IS NOT NULL` 게이트를 **풀었다.**
// 링크 없는 행(아직 scope 에 발행되지 않은 언어)도 보이고, 화면에서 '미측정'
// 상태 배지로 구분된다 — "왜 이 언어는 데이터가 없지"를 운영자가 바로 알게 하는
// 것이 목적이다. 이 완화는 **뷰어 피드 하나로 한정**이며, 집계·KPI 경로는 각자의
// `scope_prompt_id IS NOT NULL` 술어를 그대로 유지한다(scope-aggregates.ts) —
// 미측정 행이 지표 분모에 섞이면 값이 조용히 희석되기 때문이다.
export async function listStandardCatalogScoped(
  scope: AllowedScope | null | undefined,
): Promise<{ rows: StandardCatalogRow[] }> {
  if (!scope) throw new UnauthorizedError(); // default-deny: no context → no data
  const db = getDb();

  // Always restrict to the root catalog. 미발행(scope 링크 없음) 행은 더 이상
  // 숨기지 않는다(D15) — 화면이 '미측정' 배지로 구분한다.
  // soft-delete 행(0041)은 뷰어에서 항상 제외.
  const conds: SQL[] = [
    eq(prompts.projectId, STANDARD_ROOT_PROJECT_ID),
    isNull(prompts.deletedAt),
  ];
  if (!scope.all && scope.brands?.length) {
    const brandCond = or(
      inArray(prompts.brand, scope.brands),
      isNull(prompts.brand),
      eq(prompts.brand, UMBRELLA_BRAND),
    );
    if (brandCond) conds.push(brandCond);
  }
  // 대상 시장 ∩ 계정 국가 스코프 (B1). admin/scope.all 은 effectiveScopeCountries
  // 가 undefined 라 종전대로 전체를 본다.
  const allowedCountries = effectiveScopeCountries(scope);
  if (allowedCountries?.length) {
    const marketCond = catalogMarketScopeCondition(allowedCountries);
    if (marketCond) conds.push(marketCond);
  }
  const where = and(...conds)!;

  const rows = await db
    .select({
      id: prompts.id,
      text: prompts.text,
      promptType: prompts.promptType,
      category: prompts.category,
      brand: prompts.brand,
      brandPresence: prompts.brandPresence,
      listType: prompts.listType,
      depth1: prompts.depth1,
      depth2: prompts.depth2,
      depth3: prompts.depth3,
      depth4: prompts.depth4,
      funnelStage: prompts.funnelStage,
      kind: prompts.kind,
      lang: prompts.lang,
      regions: prompts.regions,
      scopePromptId: prompts.scopePromptId,
      scopeText: scopePrompts.text,
      deletedAt: prompts.deletedAt,
    })
    .from(prompts)
    .leftJoin(scopePrompts, eq(prompts.scopePromptId, scopePrompts.promptId))
    .where(where)
    .orderBy(asc(prompts.depth1), asc(prompts.depth2), asc(prompts.depth3), asc(prompts.text));

  // Hide hand-curated multi-brand "잘못" rows (backend-only list).
  const visible = (rows as StandardCatalogRow[]).filter(
    (r) => !isExcludedStandardPrompt(r),
  );
  return { rows: visible };
}

// ─── catalog taxonomy (cascading filter source) ──────────────────────────
// One DISTINCT row per (listType, depth1, depth2, depth3, depth4) in the
// root catalog. Drives the cascading filter dropdowns: pick listType → depth1
// narrows; pick depth1 → depth2 narrows; etc. Keep nulls — they mean "no
// further depth" for that branch, and the cascade logic treats null as
// "no children at this level".

export interface CatalogTaxonomyRow {
  // 2026-07-08 피드백: depth1(+일부 listType) 값이 브랜드마다 다른 체계라
  // (예: depth1 "2."가 Genesis="Human Centered Innovative Luxury" / Hyundai=
  // "Innovation & Technology" / Kia="Electrification & Innovation") 브랜드
  // 필터 없이 보면 하나의 분류처럼 뒤섞여 보임. brand를 캐스케이드 최상위
  // 조상으로 추가해 브랜드 선택 시 하위 옵션이 그 브랜드 것만 남도록 한다.
  brand: string | null;
  // 브랜드 유형(branded/unbranded) — 필터 패널이 값 없는 카탈로그 축을 숨길 때
  // 이 열의 값 유무로 판정한다(쿼리는 이미 select 중이었으나 타입 누락이었음).
  brandPresence: string | null;
  listType: string | null;
  depth1: string | null;
  depth2: string | null;
  depth3: string | null;
  depth4: string | null;
}

// kind='acr' 카탈로그 행 수 — ACR 화면의 측정 대기 상태 문구에 사용.
export async function countStandardAcrPrompts(): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(prompts)
    .where(
      and(
        eq(prompts.projectId, STANDARD_ROOT_PROJECT_ID),
        eq(prompts.kind, "acr"),
        isNull(prompts.deletedAt),
      )!,
    );
  return rows[0]?.count ?? 0;
}

// 프롬프트 카탈로그 taxonomy 의 DISTINCT 행 — 필터 패널의 카탈로그 축
// (brandPresence/listType/depth1-4) 옵션 소스. 기본은 표준 루트지만, projectId
// 를 주면 그 프로젝트 프롬프트의 실제 값만 낸다(프로젝트 분석에서 그 프로젝트에
// 없는 값이 죽은 필터로 뜨던 문제 해소 — 패널은 값 없는 축을 자동 숨김).
export async function listCatalogTaxonomy(
  projectId: string = STANDARD_ROOT_PROJECT_ID,
): Promise<CatalogTaxonomyRow[]> {
  const db = getDb();
  return db
    .selectDistinct({
      brand: prompts.brand,
      brandPresence: prompts.brandPresence,
      listType: prompts.listType,
      depth1: prompts.depth1,
      depth2: prompts.depth2,
      depth3: prompts.depth3,
      depth4: prompts.depth4,
    })
    .from(prompts)
    .where(and(eq(prompts.projectId, projectId), isNull(prompts.deletedAt))!)
    .orderBy(asc(prompts.listType), asc(prompts.depth1), asc(prompts.depth2), asc(prompts.depth3));
}

// ─── standard_keywords ───────────────────────────────────────────────────

export interface StandardKeywordInsert {
  term: string;
  sourceType: StandardKeywordSource;
  brand?: string | null;
  notes?: string | null;
  enabled?: boolean;
  createdBy: string;
}

export interface StandardKeywordUpdate {
  term?: string;
  sourceType?: StandardKeywordSource;
  brand?: string | null;
  notes?: string | null;
  enabled?: boolean;
}

export interface StandardKeywordRepository {
  list(): Promise<StandardKeywordRow[]>;
  insert(input: StandardKeywordInsert): Promise<StandardKeywordRow>;
  update(id: string, patch: StandardKeywordUpdate): Promise<StandardKeywordRow>;
  delete(id: string): Promise<void>;
}

export const standardKeywordRepository: StandardKeywordRepository = {
  async list() {
    return getDb()
      .select()
      .from(standardKeywords)
      .orderBy(asc(standardKeywords.sourceType), desc(standardKeywords.createdAt));
  },

  async insert(input) {
    const rows = await getDb()
      .insert(standardKeywords)
      .values({
        term: input.term,
        sourceType: input.sourceType,
        brand: input.brand ?? null,
        notes: input.notes ?? null,
        enabled: input.enabled ?? true,
        createdBy: input.createdBy,
      })
      .returning();
    const created = rows[0];
    if (!created) throw new Error("standardKeywordRepository.insert: no row returned");
    return created;
  },

  async update(id, patch) {
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (patch.term !== undefined) set.term = patch.term;
    if (patch.sourceType !== undefined) set.sourceType = patch.sourceType;
    if (patch.brand !== undefined) set.brand = patch.brand;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const rows = await getDb()
      .update(standardKeywords)
      .set(set)
      .where(eq(standardKeywords.id, id))
      .returning();
    const updated = rows[0];
    if (!updated) throw new Error("standardKeywordRepository.update: no row matched id=" + id);
    return updated;
  },

  async delete(id) {
    await getDb().delete(standardKeywords).where(eq(standardKeywords.id, id));
  },
};

// ─── standard_sources ────────────────────────────────────────────────────

export type StandardSourceChannel = "news" | "pr" | "social" | "community";

export interface StandardSourceInsert {
  url: string;
  channel: StandardSourceChannel;
  brand?: string | null;
  notes?: string | null;
  enabled?: boolean;
  createdBy: string;
}

export interface StandardSourceUpdate {
  url?: string;
  channel?: StandardSourceChannel;
  brand?: string | null;
  notes?: string | null;
  enabled?: boolean;
}

export interface StandardSourceRepository {
  list(): Promise<StandardSourceRow[]>;
  insert(input: StandardSourceInsert): Promise<StandardSourceRow>;
  update(id: string, patch: StandardSourceUpdate): Promise<StandardSourceRow>;
  delete(id: string): Promise<void>;
}

export const standardSourceRepository: StandardSourceRepository = {
  async list() {
    return getDb()
      .select()
      .from(standardSources)
      .orderBy(asc(standardSources.channel), desc(standardSources.createdAt));
  },

  async insert(input) {
    const rows = await getDb()
      .insert(standardSources)
      .values({
        url: input.url,
        channel: input.channel,
        brand: input.brand ?? null,
        notes: input.notes ?? null,
        enabled: input.enabled ?? true,
        createdBy: input.createdBy,
      })
      .returning();
    const created = rows[0];
    if (!created) throw new Error("standardSourceRepository.insert: no row returned");
    return created;
  },

  async update(id, patch) {
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (patch.url !== undefined) set.url = patch.url;
    if (patch.channel !== undefined) set.channel = patch.channel;
    if (patch.brand !== undefined) set.brand = patch.brand;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const rows = await getDb()
      .update(standardSources)
      .set(set)
      .where(eq(standardSources.id, id))
      .returning();
    const updated = rows[0];
    if (!updated) throw new Error("standardSourceRepository.update: no row matched id=" + id);
    return updated;
  },

  async delete(id) {
    await getDb().delete(standardSources).where(eq(standardSources.id, id));
  },
};
