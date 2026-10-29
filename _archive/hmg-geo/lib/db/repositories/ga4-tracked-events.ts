import "server-only";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { ga4TrackedEvents } from "@/lib/db/schema";

// GA4 추적 이벤트 선택(ga4_tracked_events) 리포지토리 — property_id 별로 "전환으로
// 셀 이벤트" 집합을 읽고/교체한다. 전환 KPI(lib/ga4/conversion.ts)의 분자 정의와
// admin 선택 UI가 유일하게 여기로 접근한다.
//
// 의미론: property에 행이 하나도 없으면 "선택 없음" = 전환 KPI는 GA4 key events
// 그대로(fallback). 한 행이라도 있으면 그 eventName 집합이 전환 분자가 된다.

export const ga4TrackedEventRepository = {
  // 한 property의 추적 이벤트 이름 집합.
  async listForProperty(propertyId: string): Promise<string[]> {
    const rows = await getDb()
      .select({ eventName: ga4TrackedEvents.eventName })
      .from(ga4TrackedEvents)
      .where(eq(ga4TrackedEvents.propertyId, propertyId));
    return rows.map((r) => r.eventName);
  },

  // 여러 property의 추적 이벤트를 property_id → 이름[] 로 한 번에. 롤업(HQ/권역)이
  // property별 선택을 각각 조회하지 않도록.
  async listForProperties(
    propertyIds: string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (propertyIds.length === 0) return out;
    const rows = await getDb()
      .select({
        propertyId: ga4TrackedEvents.propertyId,
        eventName: ga4TrackedEvents.eventName,
      })
      .from(ga4TrackedEvents)
      .where(inArray(ga4TrackedEvents.propertyId, propertyIds));
    for (const r of rows) {
      const arr = out.get(r.propertyId) ?? [];
      arr.push(r.eventName);
      out.set(r.propertyId, arr);
    }
    return out;
  },

  // 한 property의 선택을 통째로 교체(삭제 후 삽입)한다. 빈 배열이면 전량 삭제
  // = fallback(key events)로 되돌린다. 한 트랜잭션.
  async replaceForProperty(
    propertyId: string,
    eventNames: string[],
    createdBy: string,
  ): Promise<void> {
    const unique = [...new Set(eventNames.map((n) => n.trim()).filter(Boolean))];
    await getDb().transaction(async (tx) => {
      await tx
        .delete(ga4TrackedEvents)
        .where(eq(ga4TrackedEvents.propertyId, propertyId));
      if (unique.length > 0) {
        await tx
          .insert(ga4TrackedEvents)
          .values(unique.map((eventName) => ({ propertyId, eventName, createdBy })));
      }
    });
  },
};
