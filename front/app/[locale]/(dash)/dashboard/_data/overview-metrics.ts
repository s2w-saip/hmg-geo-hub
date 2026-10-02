// Overview(대시보드 개편, 2026-09-02) KPI 5종의 타입·접근자·산출 — **중립 모듈**
// ("server-only"/"use client" 없음). live.ts(server-only) 와 클라이언트 컴포넌트(지도·
// 카드·트리표)가 같은 정의를 써야 하는데, 클라이언트가 live.ts 를 런타임 import 하면
// 빌드가 깨진다(실측: `You're importing a component that needs "server-only"`).

import type { GeoBrandKpiRow, GeoCodeTotals } from "@/lib/db/repositories/scope-aggregates";

// Overview 국가별 GEO 현황(2026-09-02)의 KPI 5종. 값 산식은 대시보드 카드
// (buildMirrorKpis)와 같고 국가/권역으로 좁힌 것뿐이다. rival = 그 시장 언급 1위
// 경쟁사의 같은 지표(인용 점유율은 도메인→브랜드 매핑이 없어 null).
export type OverviewKpiKey = "visibility" | "shareOfVoice" | "sentiment" | "position" | "citationShare";
export const OVERVIEW_KPI_KEYS: readonly OverviewKpiKey[] = [
  "visibility", "shareOfVoice", "sentiment", "position", "citationShare",
];
export interface GeoMetric {
  ours: number | null;
  rival: { name: string; value: number | null } | null;
}
export type GeoMetrics = Record<OverviewKpiKey, GeoMetric>;

/** metricValue 가 필요로 하는 최소 형태 — MarketCompetition 이 이를 만족한다. */
export interface GeoMetricHolder {
  hmgSov: number;
  metrics?: GeoMetrics;
}

/** 시장 행에서 KPI 값 하나를 읽는다 — 지도·표·칩이 같은 접근자를 쓴다. */
export function metricValue(m: GeoMetricHolder, key: OverviewKpiKey): number | null {
  if (key === "shareOfVoice" && !m.metrics) return m.hmgSov;
  return m.metrics?.[key]?.ours ?? null;
}

// (국가 또는 권역) 브랜드 행 + 총계 → KPI 5종. 브랜드 행은 이미 그 단위로 합산된 것.
export function marketMetrics(
  brands: GeoBrandKpiRow[],
  totals: Omit<GeoCodeTotals, "code">,
  ourBrands: Set<string> | null,
): GeoMetrics {
  const isOurs = (b: GeoBrandKpiRow) =>
    b.isTracked && (ourBrands === null || ourBrands.has(b.brand));
  const ours = brands.filter(isOurs);
  // 명부 제외 엔티티(`excluded`)는 최대 경쟁사 후보에서만 뺀다: 분모(totalMentions)는 그대로.
  const competitors = brands
    .filter((b) => !b.isTracked && !b.excluded)
    .sort((a, b) => b.mentions - a.mentions);
  const rival = competitors[0] ?? null;
  const sum = (rows: GeoBrandKpiRow[], f: (b: GeoBrandKpiRow) => number) => rows.reduce((s, b) => s + f(b), 0);
  const ratio = (n: number, d: number) => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);
  const totalMentions = sum(brands, (b) => b.mentions);
  // 노출률 — 권한 무제한이면 SQL 의 distinct 당사 등장 답변 수, 브랜드 스코프면
  // 그 브랜드들의 등장 답변 수 합(복수 브랜드 동시 등장이 중복 계상될 수 있어 상한 클램프).
  const ownAnswers = ourBrands === null ? totals.ownAnswers : Math.min(totals.answers, sum(ours, (b) => b.answers));
  const posOf = (rows: GeoBrandKpiRow[]) => {
    const cnt = sum(rows, (b) => b.posCnt);
    return cnt > 0 ? Math.round((10 * sum(rows, (b) => b.posSum)) / cnt) / 10 : null;
  };
  const sentOf = (rows: GeoBrandKpiRow[]) => ratio(sum(rows, (b) => b.sentPositive), sum(rows, (b) => b.sentTotal));
  return {
    visibility: {
      ours: ratio(ownAnswers, totals.answers),
      rival: rival ? { name: rival.brand, value: ratio(rival.answers, totals.answers) } : null,
    },
    shareOfVoice: {
      ours: ratio(sum(ours, (b) => b.mentions), totalMentions),
      rival: rival ? { name: rival.brand, value: ratio(rival.mentions, totalMentions) } : null,
    },
    sentiment: {
      ours: sentOf(ours),
      rival: rival ? { name: rival.brand, value: sentOf([rival]) } : null,
    },
    position: {
      ours: posOf(ours),
      rival: rival ? { name: rival.brand, value: posOf([rival]) } : null,
    },
    citationShare: {
      // 글로벌 ⑤ = 공식(HMG) 카테고리 분자(카드와 같은 정의). 없으면 종전 base URL 분자.
      ours: ratio(totals.citOfficialHmg ?? totals.citOwned, totals.citTotal),
      rival: null,
    },
  };
}

