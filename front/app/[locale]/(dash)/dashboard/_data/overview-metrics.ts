// Overview(대시보드 개편, 2026-09-02) KPI 5종의 키·시장 지표 타입 — **중립 모듈**
// ("server-only"/"use client" 없음): 서버 섹션과 클라이언트 컴포넌트(지도·카드·트리표)가 같이 쓴다.
// 값은 overview 화면(back/bff/screens/overview.py)이 계산한다.

// Overview 국가별 GEO 현황(2026-09-02)의 KPI 5종. rival = 그 시장 언급 1위 경쟁사의 같은 지표
// (인용 점유율은 도메인→브랜드 매핑이 없어 null).
export type OverviewKpiKey = "visibility" | "shareOfVoice" | "sentiment" | "position" | "citationShare";
export const OVERVIEW_KPI_KEYS: readonly OverviewKpiKey[] = [
  "visibility", "shareOfVoice", "sentiment", "position", "citationShare",
];
export interface GeoMetric {
  ours: number | null;
  rival: { name: string; value: number | null } | null;
}
export type GeoMetrics = Record<OverviewKpiKey, GeoMetric>;
