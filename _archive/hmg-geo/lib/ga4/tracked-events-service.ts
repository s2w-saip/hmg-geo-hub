import "server-only";
import { revalidateTag } from "next/cache";
import { runReport, dateNDaysAgo } from "./client";
import { GA4_CACHE_TAG } from "./conversion";
import { ga4TrackedEventRepository } from "@/lib/db/repositories/ga4-tracked-events";

// GA4 추적(전환) 이벤트 선택 — 인증 없는 순수 로직. admin 레지스트리 / project 전환
// 화면 / website 전환 화면의 서버 액션이 각자 권한을 검증한 뒤 이 서비스를 호출한다.
// (권한 분기는 tracked-events-actions.ts).

export interface Ga4EventRow {
  eventName: string;
  count: number; // 최근 90일 eventCount (없으면 0 — 이미 추적 중이나 최근 미발생)
  tracked: boolean; // 현재 전환 분자로 집계되는 이벤트인지
}

const EVENT_WINDOW_DAYS = 90;

// property의 이벤트(최근 90일 볼륨) + 현재 추적 선택을 합쳐 반환. GA4 Data API로
// eventName × eventCount 를 뽑고, DB 선택 집합과 합집합(최근 미발생이라도 추적
// 중이면 포함)한다. 정렬: 추적 우선 → 볼륨 DESC. GA4 호출 실패 시 throw.
export async function loadEventsForProperty(propertyId: string): Promise<Ga4EventRow[]> {
  const tracked = new Set(await ga4TrackedEventRepository.listForProperty(propertyId));
  const counts = new Map<string, number>();
  const { start, end } = dateNDaysAgo(EVENT_WINDOW_DAYS);
  const rep = await runReport(propertyId, {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: "eventName" }],
    metrics: [{ name: "eventCount" }],
    limit: 250,
  });
  for (const r of rep.rows ?? []) {
    const name = r.dimensionValues?.[0]?.value ?? "";
    if (name) counts.set(name, Number(r.metricValues?.[0]?.value ?? 0));
  }
  const names = new Set<string>([...counts.keys(), ...tracked]);
  const rows: Ga4EventRow[] = [...names].map((eventName) => ({
    eventName,
    count: counts.get(eventName) ?? 0,
    tracked: tracked.has(eventName),
  }));
  rows.sort((a, b) => {
    if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
    if (b.count !== a.count) return b.count - a.count;
    return a.eventName.localeCompare(b.eventName);
  });
  return rows;
}

// 선택을 통째로 교체(빈 배열이면 해제 → key events fallback) + GA4 집계 캐시 무효화.
export async function saveEventsForProperty(
  propertyId: string,
  eventNames: string[],
  createdBy: string,
): Promise<void> {
  const names = (eventNames ?? []).map((n) => String(n).trim()).filter(Boolean);
  await ga4TrackedEventRepository.replaceForProperty(propertyId, names, createdBy);
  revalidateTag(GA4_CACHE_TAG);
}
