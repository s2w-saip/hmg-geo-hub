import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { ga4Properties, type Ga4PropertyRow } from "@/lib/db/schema";

// GA4 연동 레지스트리 리포지토리 (WBS 1.2.2). brand × country → GA4 property_id
// 매핑의 유일한 DB 접근점. property-map.ts(resolver)와 admin 등록 UI가 사용.
// 설계: docs/ga4-connection-permission-design.md.

export interface Ga4PropertyInput {
  brand: string;
  countryCode: string;
  propertyId?: string | null;
  status?: string;
  createdBy: string;
}

function defaultStatus(propertyId?: string | null): string {
  return propertyId ? "pending_grant" : "unmapped";
}

export const ga4PropertyRepository = {
  async list(): Promise<Ga4PropertyRow[]> {
    return getDb()
      .select()
      .from(ga4Properties)
      .orderBy(ga4Properties.brand, ga4Properties.countryCode);
  },

  async getByBrandCountry(
    brand: string,
    countryCode: string,
  ): Promise<Ga4PropertyRow | null> {
    const rows = await getDb()
      .select()
      .from(ga4Properties)
      .where(
        and(
          eq(ga4Properties.brand, brand),
          eq(ga4Properties.countryCode, countryCode),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  // brand×country 기준 upsert(unique). status를 명시하지 않으면 propertyId
  // 유무로 기본값(pending_grant/unmapped) 결정. verify 액션이 active로 승격.
  async upsert(input: Ga4PropertyInput): Promise<Ga4PropertyRow> {
    const status = input.status ?? defaultStatus(input.propertyId);
    const [row] = await getDb()
      .insert(ga4Properties)
      .values({
        brand: input.brand,
        countryCode: input.countryCode,
        propertyId: input.propertyId ?? null,
        status,
        createdBy: input.createdBy,
      })
      .onConflictDoUpdate({
        target: [ga4Properties.brand, ga4Properties.countryCode],
        set: {
          propertyId: input.propertyId ?? null,
          status,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) throw new Error("ga4PropertyRepository.upsert: no row returned");
    return row;
  },

  async setStatus(
    id: string,
    patch: {
      status?: string;
      verifiedAt?: Date | null;
      grantedAt?: Date | null;
    },
  ): Promise<void> {
    await getDb()
      .update(ga4Properties)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(ga4Properties.id, id));
  },

  async remove(id: string): Promise<void> {
    await getDb().delete(ga4Properties).where(eq(ga4Properties.id, id));
  },
};
