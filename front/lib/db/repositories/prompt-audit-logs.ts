import "server-only";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { promptAuditLogs, prompts, profiles } from "@/lib/db/schema";
import type { AllowedScope } from "@/lib/auth/types";
import { UnauthorizedError } from "@/lib/auth/errors";
import { UMBRELLA_BRAND } from "@/lib/scope/brand-presence";
import {
  STANDARD_ROOT_PROJECT_ID,
  catalogMarketScopeCondition,
} from "@/lib/db/repositories/standards";
import { effectiveScopeCountries } from "@/lib/rhq";
import type { PromptAuditChanges, PromptAuditEventType } from "@/lib/standards/audit";

// 글로벌 카탈로그 감사 원장 (0041, catalog-prompt-audit). append-only —
// update/delete 메서드를 만들지 않는다 (0041 REVOKE + 이 파일의 표면이 그 보증).
// 쓰기의 정상 경로는 아래 composite(트랜잭션)이고, insert 단독 노출은 로컬 컬럼
// 변경이 없는 이벤트(enabled_changed)용이다. bff_audit_logs(접근 로그)와 목적이
// 다르다 — 여기는 도메인 이벤트 + 바뀐 필드의 old/new를 남기는 변경 이력이다.

export interface PromptAuditLogInsert {
  promptId: string;
  projectId: string;
  actorId: string | null;
  actorType?: "user" | "system";
  eventType: PromptAuditEventType;
  changes: PromptAuditChanges;
  batchId?: string | null;
}

export interface PromptAuditLogView {
  id: string;
  promptId: string;
  actorId: string | null;
  actorType: string;
  eventType: string;
  changes: PromptAuditChanges;
  batchId: string | null;
  createdAt: Date;
  actorEmail: string | null;
  promptText: string | null; // 현재 본문 (전역 목록 렌더용 — 삭제 행은 null 가능)
  promptBrand: string | null;
}

export interface GlobalAuditQuery {
  scope: AllowedScope | null | undefined; // 세션 파생 — default-deny
  from?: Date;
  eventTypes?: PromptAuditEventType[];
  limit?: number;
}

export interface PromptAuditDailyCount {
  day: string; // 'YYYY-MM-DD' (UTC)
  total: number;
}

const DEFAULT_LIMIT = 500;

function baseSelect(db: ReturnType<typeof getDb>) {
  const actorProfile = alias(profiles, "actor_profile");
  return db
    .select({
      id: promptAuditLogs.id,
      promptId: promptAuditLogs.promptId,
      actorId: promptAuditLogs.actorId,
      actorType: promptAuditLogs.actorType,
      eventType: promptAuditLogs.eventType,
      changes: promptAuditLogs.changes,
      batchId: promptAuditLogs.batchId,
      createdAt: promptAuditLogs.createdAt,
      actorEmail: actorProfile.email,
      promptText: prompts.text,
      promptBrand: prompts.brand,
    })
    .from(promptAuditLogs)
    .leftJoin(actorProfile, eq(actorProfile.id, promptAuditLogs.actorId))
    .leftJoin(prompts, eq(prompts.id, promptAuditLogs.promptId));
}

export const promptAuditLogRepository = {
  async listForPrompt(promptId: string, limit = 100): Promise<PromptAuditLogView[]> {
    const rows = await baseSelect(getDb())
      .where(eq(promptAuditLogs.promptId, promptId))
      .orderBy(desc(promptAuditLogs.createdAt))
      .limit(limit);
    return rows as PromptAuditLogView[];
  },

  // 전역 이력 — listStandardCatalogScoped와 **같은 술어**(브랜드 + 대상 시장).
  // 이 목록은 `promptText`(프롬프트 본문)를 그대로 렌더하고 CSV로도 내려받게
  // 하므로, 카탈로그 탭만 좁히고 여기를 두면 같은 화면의 옆 탭이 우회로가 된다
  // (B1 권한 레드팀, 2026-09-03).
  async listGlobalScoped(input: GlobalAuditQuery): Promise<PromptAuditLogView[]> {
    if (!input.scope) throw new UnauthorizedError();
    const conds: SQL[] = [eq(promptAuditLogs.projectId, STANDARD_ROOT_PROJECT_ID)];
    if (input.from) conds.push(gte(promptAuditLogs.createdAt, input.from));
    if (input.eventTypes?.length) {
      conds.push(inArray(promptAuditLogs.eventType, input.eventTypes));
    }
    if (!input.scope.all && input.scope.brands?.length) {
      const brandCond = or(
        inArray(prompts.brand, input.scope.brands),
        isNull(prompts.brand),
        eq(prompts.brand, UMBRELLA_BRAND),
      );
      if (brandCond) conds.push(brandCond);
    }
    const allowedCountries = effectiveScopeCountries(input.scope);
    if (allowedCountries?.length) {
      const marketCond = catalogMarketScopeCondition(allowedCountries);
      if (marketCond) conds.push(marketCond);
    }
    const rows = await baseSelect(getDb())
      .where(and(...conds)!)
      .orderBy(desc(promptAuditLogs.createdAt))
      .limit(input.limit ?? DEFAULT_LIMIT);
    return rows as PromptAuditLogView[];
  },

  // 차트 마커용 일 단위 집계 — 해석에 의미 있는 이벤트만 센다.
  async listDailyCounts(days = 90): Promise<PromptAuditDailyCount[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await getDb()
      .select({
        day: sql<string>`to_char(${promptAuditLogs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
        total: sql<number>`COUNT(*)::int`,
      })
      .from(promptAuditLogs)
      .where(
        and(
          eq(promptAuditLogs.projectId, STANDARD_ROOT_PROJECT_ID),
          gte(promptAuditLogs.createdAt, since),
          inArray(promptAuditLogs.eventType, ["text_updated", "created", "deleted"]),
        )!,
      )
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return rows;
  },

  async insert(input: PromptAuditLogInsert): Promise<void> {
    await getDb().insert(promptAuditLogs).values({
      promptId: input.promptId,
      projectId: input.projectId,
      actorId: input.actorId,
      actorType: input.actorType ?? "user",
      eventType: input.eventType,
      changes: input.changes,
      batchId: input.batchId ?? null,
    });
  },
};

// ─── composite writes (트랜잭션 + Scope 콜백) ────────────────────────────
// "Scope는 바뀌었는데 로그가 없다"를 구조적으로 차단: 로컬 UPDATE + 로그 INSERT +
// Scope PATCH(콜백)를 한 트랜잭션에 묶고, 콜백이 throw하면 전부 롤백한다.
// 대가: HTTP 왕복 동안 커넥션 점유 — admin 저빈도 작업이라 수용 (스펙 §3.2).
// 잔여 위험 창은 Scope 성공 직후 COMMIT 실패뿐.

export interface AuditedCatalogPatch {
  text?: string;
  promptType?: string | null;
  category?: string | null;
  brand?: string | null;
  brandPresence?: string | null;
  listType?: string | null;
  depth1?: string | null;
  depth2?: string | null;
  depth3?: string | null;
  depth4?: string | null;
  funnelStage?: string | null;
  kind?: "single" | "acr";
  /**
   * 언어·시장 축 (H5). `regions` 만 `string[]` 이라 다른 필드와 타입 계열이 다르다 —
   * `CatalogLabelsPatch`(전부 `string|null`)에 욱여넣지 않고 별도 액션으로 둔 이유가
   * 이것이다(`kind` 가 별도 액션인 것과 같은 규약).
   *
   * ⚠️ `changes` 직렬화 주의: `computeChanges` 는 `String(v)` 로 값을 문자열화하므로
   * 배열을 그대로 넘기면 `"KR,US"` 와 `"US,KR"` 이 **다른 변경으로 기록된다.**
   * 호출부가 `[...r].sort().join(",")` 로 정렬 CSV 를 만들어 넘긴다.
   */
  lang?: string | null;
  regions?: string[] | null;
  deletedAt?: Date | null;
}

export interface AuditedChangeInput {
  promptId: string;
  actorId: string;
  eventType: PromptAuditEventType;
  patch: AuditedCatalogPatch;
  changes: PromptAuditChanges;
  batchId?: string | null;
  applyScope?: () => Promise<void>;
}

export async function applyAuditedCatalogChange(input: AuditedChangeInput): Promise<void> {
  await getDb().transaction(async (tx) => {
    // restore만 삭제 행을 대상으로 하고, 그 외는 활성 행만 — 상태 불일치는 0행
    // 업데이트로 드러나 throw(전체 롤백)된다.
    const guard =
      input.eventType === "restored"
        ? sql`${prompts.deletedAt} IS NOT NULL`
        : sql`${prompts.deletedAt} IS NULL`;
    const set: Record<string, unknown> = {
      updatedBy: input.actorId,
      updatedAt: sql`now()`,
    };
    for (const [k, v] of Object.entries(input.patch)) {
      if (v !== undefined) set[k] = v;
    }
    const updated = await tx
      .update(prompts)
      .set(set)
      .where(
        and(eq(prompts.id, input.promptId), eq(prompts.projectId, STANDARD_ROOT_PROJECT_ID), guard)!,
      )
      .returning({ id: prompts.id });
    if (updated.length === 0) {
      throw new Error("catalog row not found (or delete-state mismatch): " + input.promptId);
    }
    await tx.insert(promptAuditLogs).values({
      promptId: input.promptId,
      projectId: STANDARD_ROOT_PROJECT_ID,
      actorId: input.actorId,
      actorType: "user",
      eventType: input.eventType,
      changes: input.changes,
      batchId: input.batchId ?? null,
    });
    if (input.applyScope) await input.applyScope();
  });
}

export interface AuditedCreateInput {
  actorId: string;
  values: {
    text: string;
    promptType?: string | null;
    category?: string | null;
    brand?: string | null;
  };
  // 성공 시 scope prompt_id 반환 → 행에 링크. null = 미추적(mock/미연결).
  pushScope?: () => Promise<{ scopePromptId: string } | null>;
}

export async function createAuditedCatalogPrompt(input: AuditedCreateInput): Promise<{ id: string }> {
  return getDb().transaction(async (tx) => {
    const inserted = await tx
      .insert(prompts)
      .values({
        projectId: STANDARD_ROOT_PROJECT_ID,
        text: input.values.text,
        promptType: (input.values.promptType ?? null) as never,
        category: input.values.category ?? null,
        brand: input.values.brand ?? null,
        createdBy: input.actorId,
        updatedBy: input.actorId,
      })
      .returning({ id: prompts.id });
    const row = inserted[0];
    if (!row) throw new Error("createAuditedCatalogPrompt: no row returned");
    await tx.insert(promptAuditLogs).values({
      promptId: row.id,
      projectId: STANDARD_ROOT_PROJECT_ID,
      actorId: input.actorId,
      actorType: "user",
      eventType: "created",
      changes: { text: { old: null, new: input.values.text } },
    });
    if (input.pushScope) {
      const scoped = await input.pushScope();
      if (scoped) {
        await tx
          .update(prompts)
          .set({ scopePromptId: scoped.scopePromptId })
          .where(eq(prompts.id, row.id));
      }
    }
    return { id: row.id };
  });
}
