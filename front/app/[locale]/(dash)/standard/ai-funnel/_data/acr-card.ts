import type { AcrBrandAgg, StandardAcr } from "@/lib/db/repositories/scope-aggregates";

/**
 * ACR KPI 카드(Top1 · Top5 · 1순위 횟수)가 읽는 행 — 관점 당사 합계(API `own`: 여러 당사 브랜드 합, 상위 12 밖 당사 포함)가 있으면 그것,
 * 없으면(legacy · 옛 캐시) 종전대로 첫 당사 브랜드 행. 브랜드 행만 읽으면 HMG 관점은 첫 브랜드(예: Hyundai)만 보였다.
 */
export function acrCardRow(data: StandardAcr | null | undefined): Omit<AcrBrandAgg, "brand" | "isOurs"> | null {
  return data?.own ?? data?.brands.find((b) => b.isOurs) ?? null;
}
