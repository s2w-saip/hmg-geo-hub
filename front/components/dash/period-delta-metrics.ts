// GGMD-107 C4 — 화면의 지표 키 ↔ 기간 비교 계약의 `CompareMetricKey` 대응표.
//
// 지면마다 자기 어휘가 다르다(`KpiKey` / `OverviewKpiKey` / `KpiMetric`). 대응을
// 지면 안에 흩으면 같은 지표가 화면마다 다른 비교를 받는다 — 표를 여기 한 곳에 둔다.
//
// `null` = **이 변경의 범위 밖**이라 그 지면은 종전 Δ 를 그대로 그린다. 두 종류가 있다:
//   ① ⑤ AI 인용 점유율(`citationShare`) — design §6-2 가 명시적으로 제외했다.
//      집계층 `own_citations`(5.30%)와 화면 정본 도메인 표(10.39%)가 다르다.
//   ② 나머지(자사/타겟 URL 인용률·타겟 URL 인용률·유입 전환율) — 계약의 6지표에 없다.
//      웹사이트 새 카드 2종(GGMD-61)은 "기간 미지정일 때만 Δ" 현행을 유지한다.

import type { CompareMetricKey } from "@/lib/kpi/period-compare";

/** 대시보드·웹사이트 타일의 KPI 키(`app/[locale]/(dash)/dashboard/_data/sample.ts::KpiKey`). */
export const KPI_KEY_TO_COMPARE_METRIC: Readonly<Record<string, CompareMetricKey | null>> = {
  visibility: "visibility",
  shareOfVoice: "share",
  sentiment: "favorability",
  position: "position",
  // ↓ 범위 밖 (위 주석 ①②)
  citationShare: null,
  ownedUrlRate: null,
  targetUrlRate: null,
  citationAccuracy: null,
  trafficConversion: null,
};

/** 4KPI 탭 히어로의 지표(`answer-analysis/_data/kpi-view.ts::KpiMetric`). */
export const KPI_TAB_METRIC_TO_COMPARE_METRIC: Readonly<
  Record<string, CompareMetricKey | null>
> = {
  exposure: "visibility",
  sov: "share",
};

export function compareMetricForKpiKey(key: string): CompareMetricKey | null {
  return KPI_KEY_TO_COMPARE_METRIC[key] ?? null;
}

export function compareMetricForKpiTab(metric: string): CompareMetricKey | null {
  return KPI_TAB_METRIC_TO_COMPARE_METRIC[metric] ?? null;
}

/** 프리셋 길이(일) — 억제 캡션의 `{days}` 와 `noPrevYear` 분기 입력. */
export const PRESET_DAYS: Readonly<Record<string, number>> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  yearly: 365,
};

/**
 * `?time=lo..hi` 로 확정된 구간의 길이(일, 양 끝 포함). 구현은 `lib/kpi` 한 곳이다 —
 * 같은 규칙이 두 벌이면 조용히 갈린다(이 리포가 반복해서 값을 튀어나가게 만든 형태).
 */
export { selectedWindowDays as windowDaysOf } from "@/lib/kpi/calendar-month-window";

/**
 * 대시보드·웹사이트 Overview 가 요청하는 지표 — 카드/타일이 그리는 코어 4개.
 * ⑤ AI 인용 점유율은 design §6-2 로 범위 밖이라 여기 없다.
 * (게이트웨이 결과는 **이 순서**를 따른다 — `PeriodCompareOptions.metrics` 계약.)
 */
export const OVERVIEW_COMPARE_METRICS = [
  "visibility",
  "share",
  "favorability",
  "position",
] as const satisfies readonly CompareMetricKey[];

/**
 * 언급 계열(`family: "mention"`) 지면이 요청하는 지표 — 달력 월 줄이 한 번에 그린다.
 * `citationsPerAnswer` 는 인용 계열이라 여기 없다(`hidden_scope='citations'` 회차 규약이
 * 달라서 **같은 읽기에 섞으면 안 된다** — design §6-3).
 */
export const MENTION_COMPARE_METRICS = [
  "visibility",
  "share",
  "favorability",
  "position",
  "mentionsPerAnswer",
] as const satisfies readonly CompareMetricKey[];

/** 인용 계열(`family: "citation"`) 지면이 요청하는 지표. */
export const CITATION_COMPARE_METRICS = [
  "citationsPerAnswer",
] as const satisfies readonly CompareMetricKey[];
