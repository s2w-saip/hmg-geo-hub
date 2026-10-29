import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { entityRegistry, type EntityRegistryRow } from "@/lib/db/schema";
import type { OwnEntity } from "@/lib/scope/hmg-brands";

// 엔티티 레지스트리(자사 명부) — "누가 자사인가"의 전사 공통 정의 (2026-07-03).
// 경쟁사는 파생(언급된 브랜드 − 자사)이라 저장하지 않는다. 게이트웨이
// (lib/scope/server.ts)가 own 명부를 캐시 로드해 filters.ownEntities 로 주입하고,
// 집계 판정(trackedRollupIn / makeBrandResolver)이 그 집합을 쓴다. 명부가 비거나
// 테이블 미적용(migration 0023 전)이면 호출부가 hmg-brands 시드로 폴백한다.

export interface EntityRegistryRepository {
  /** 자사(own) 명부 — 게이트웨이 주입용. name 순 정렬. */
  listOwn(): Promise<OwnEntity[]>;
  /** 전체 명부 (admin 카탈로그 화면용). */
  listAll(): Promise<EntityRegistryRow[]>;
  upsert(input: {
    entityId: string;
    name: string;
    role: "own" | "excluded";
    updatedBy?: string | null;
  }): Promise<void>;
  remove(entityId: string): Promise<void>;
}

export const entityRegistryRepository: EntityRegistryRepository = {
  async listOwn() {
    const rows = await getDb()
      .select({ id: entityRegistry.entityId, name: entityRegistry.name })
      .from(entityRegistry)
      .where(eq(entityRegistry.role, "own"))
      .orderBy(asc(entityRegistry.name));
    return rows;
  },

  async listAll() {
    return getDb().select().from(entityRegistry).orderBy(asc(entityRegistry.name));
  },

  async upsert(input) {
    await getDb()
      .insert(entityRegistry)
      .values({
        entityId: input.entityId,
        name: input.name,
        role: input.role,
        updatedBy: input.updatedBy ?? null,
      })
      .onConflictDoUpdate({
        target: entityRegistry.entityId,
        set: {
          name: input.name,
          role: input.role,
          updatedBy: input.updatedBy ?? null,
          updatedAt: new Date(),
        },
      });
  },

  async remove(entityId) {
    await getDb().delete(entityRegistry).where(eq(entityRegistry.entityId, entityId));
  },
};

// admin 엔티티 카탈로그의 한 행 — 미러에서 발견된 Brand 엔티티(언급량 포함)와
// 명부 역할의 병합 뷰. role 미등재 = 'competitor' (파생 — 저장하지 않는 기본값).
export interface DiscoveredBrandRow {
  entityId: string;
  name: string; // 대표 표기 (미러 Brand 행 최빈 표기; 명부 등재 시 명부 name 우선)
  mentions: number; // 언급 횟수 합
  answers: number; // 등장 답변 수
  role: "own" | "excluded" | "competitor";
}

// 측정에서 발견된 전체 브랜드 카탈로그 (admin 화면 전용, 언급 많은 순).
// 명부에만 있고 아직 측정에 안 잡힌 엔티티(시드 직후 등)도 뒤에 붙인다 —
// admin이 등재 상태 전체를 한 화면에서 본다.
export async function listDiscoveredBrands(): Promise<DiscoveredBrandRow[]> {
  const db = getDb();
  type MirrorBrandRow = {
    entity_id: string;
    name: string;
    mentions: number;
    answers: number;
  };
  const rows = await db.execute(sql`
    SELECT m.entity_id,
      (array_agg(m.brand ORDER BY m.mention_count DESC))[1] AS name,
      sum(m.mention_count)::int AS mentions,
      count(DISTINCT m.job_id)::int AS answers
    FROM scope_mentions m
    WHERE m.entity_type = 'Brand' AND m.brand IS NOT NULL
    GROUP BY m.entity_id
    ORDER BY mentions DESC
  `).catch(() => [] as MirrorBrandRow[]) as MirrorBrandRow[];
  // migration 0023 미적용(테이블 없음)이어도 카탈로그는 뜨도록 — 역할은 전부
  // 파생 기본값(경쟁사)으로 표시되고, 역할 변경 액션이 첫 스키마 오류를 낸다.
  const registry = await entityRegistryRepository.listAll().catch(() => [] as EntityRegistryRow[]);
  const roleById = new Map(registry.map((r) => [r.entityId, r]));
  const out: DiscoveredBrandRow[] = rows.map((r) => {
    const reg = roleById.get(r.entity_id);
    return {
      entityId: r.entity_id,
      name: reg?.name ?? r.name,
      mentions: Number(r.mentions ?? 0),
      answers: Number(r.answers ?? 0),
      role: (reg?.role as "own" | "excluded" | undefined) ?? "competitor",
    };
  });
  const seen = new Set(rows.map((r) => r.entity_id));
  for (const reg of registry) {
    if (!seen.has(reg.entityId)) {
      out.push({
        entityId: reg.entityId,
        name: reg.name,
        mentions: 0,
        answers: 0,
        role: reg.role as "own" | "excluded",
      });
    }
  }
  return out;
}
