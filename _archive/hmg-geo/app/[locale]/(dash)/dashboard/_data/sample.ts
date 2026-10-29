// Overview (통합 대시보드) sample fixtures — 피드백 반영 KPI v1.1
// (HMG-GEO_기준수립_KPI지표개발_피드백반영KPI_v1_1_20260625, Confluence
//  GVN/45090022). Core 7개 + Sub. 정의/산식 문구는 messages/{ko,en}.json
//  dashboard.kpi.* 가 권위 소스 — 이 fixture 는 형태만 제공.
//
// 7 Core KPIs grouped into 3 categories. No more Core/Driver tier split —
// every KPI here is a "Core KPI" with its own definition + formula +
// supporting metric examples.
//
// Numbers are plausible but fabricated; replace with real scope-API pulls
// when the backend contract lands.

// ─── Categories + KPIs ────────────────────────────────────────────────────

export type KpiCategory = "content" | "source" | "conversion";

export type KpiKey =
  // 답변의 내용
  | "visibility"
  | "shareOfVoice"
  | "sentiment"
  | "position"
  // 답변의 출처
  | "citationShare"
  | "citationAccuracy"
  // 답변의 전환
  | "trafficConversion";

export type KpiUnit = "percent" | "score" | "rank";

export interface KpiDefinition {
  key: KpiKey;
  category: KpiCategory;
  // i18n key under `dashboard.kpi.question.*` — the KPI's Core Question header
  // ("얼마나 …?"). One distinct question per KPI (HMG L2 지표 table).
  question:
    | "coverage"
    | "density"
    | "favorability"
    | "priority"
    | "citationVolume"
    | "targetSource"
    | "visit";
  unit: KpiUnit;
  // direction === "down" means a smaller value is better (e.g. average
  // position). Used to color the delta chip — declines on a "lower is
  // better" KPI are *good*.
  betterIs: "higher" | "lower";
}

export const KPI_DEFINITIONS: KpiDefinition[] = [
  // 답변의 내용
  {
    key: "visibility", // ① AI 노출률 (Visibility)
    category: "content",
    question: "coverage",
    unit: "percent",
    betterIs: "higher",
  },
  {
    key: "shareOfVoice", // ② AI 점유율 (SOV)
    category: "content",
    question: "density",
    unit: "percent",
    betterIs: "higher",
  },
  {
    key: "sentiment", // ③ AI 우호도 (Sentiment)
    category: "content",
    question: "favorability",
    unit: "percent",
    betterIs: "higher",
  },
  {
    key: "position", // ④ AI 우선 노출도 (Average Position)
    category: "content",
    question: "priority",
    unit: "rank",
    betterIs: "lower", // 순위 평균 — 낮을수록 상단 배치 = 좋음
  },
  // 답변의 출처
  {
    key: "citationShare", // ⑤ AI 인용 점유율 (Citation Share)
    category: "source",
    question: "citationVolume",
    unit: "percent",
    betterIs: "higher",
  },
  {
    key: "citationAccuracy", // ⑥ AI 타겟 URL 인용률
    category: "source",
    question: "targetSource",
    unit: "percent",
    betterIs: "higher",
  },
  // 답변의 전환
  {
    key: "trafficConversion", // ⑦ AI 유입 전환율
    category: "conversion",
    question: "visit",
    unit: "percent",
    betterIs: "higher",
  },
];

// ─── SUMMARY values — current value + period-on-period delta ──────────────

// 분자/분모 수량 — KPI 값(비율)의 근거가 되는 두 카운트. 카드에서 값 아래에
// "분자라벨 … num / 분모라벨 … den" 2줄로 노출한다(라벨은 i18n:
// dashboard.kpi.ratio.{key}.num / .den). 평균값 KPI(④ 우선 노출도)처럼
// 비율이 아닌 지표, 그리고 측정 대기(value=null) KPI는 ratio 를 비운다.
export interface KpiRatio {
  numerator: number;
  denominator: number;
}

export interface KpiSummary {
  key: KpiKey;
  // null = 측정 대기 (scope가 아직 입력을 제공하지 않는 KPI: sentiment /
  // position / citationAccuracy / trafficConversion) → 타일은 "측정 대기" 표시.
  value: number | null;
  // For percent KPIs: pp (percentage points). For score KPIs: raw delta.
  // null = 시계열 부재(라이브 단일 스냅샷) → 변화량 칩 숨김.
  delta: number | null;
  // "up" / "down" / "flat" — purely directional; the goodness is determined
  // by combining direction with `betterIs` on the definition.
  direction: "up" | "down" | "flat";
  // Region/HQ rollup KPIs surface measurement coverage as the primary
  // signal — a single weighted average over N markets is misleading on
  // its own (each market's key-events mix and traffic scale differ). When
  // present, the tile renders "N / M 측정" alongside the rate.
  coverage?: { measured: number; total: number };
  // 분자/분모 수량 — 값(비율) 아래에 두 카운트로 노출 (분자 ÷ 분모 × 100 = value).
  // 비율이 아닌 지표(④ position 평균순위)나 측정 대기 KPI는 undefined.
  ratio?: KpiRatio;
  // KPI #16 경쟁사 대비 SOV 비율 — shareOfVoice 카드 전용 부가 행 (당사 SOV ÷
  // 타겟 경쟁사 SOV × 100, 분모(전체 언급)가 약분되어 언급수 비). brand = 분모
  // 브랜드: is_target 지정 우선, 미지정이면 집계 창의 SOV 1위 외부 브랜드 자동
  // (하이브리드 결정 2026-07-02). value=null → 그 브랜드 언급 0 (측정 대기 칩).
  competitorSov?: { brand: string; value: number | null };
  // 엔진 간 일관성 (%) — 이 Core 지표의 엔진(target)별 값 중 min ÷ max × 100.
  // 카드 값 오른쪽에 배지로 노출한다. 유효 엔진이 2개 미만이면 비교 불가라
  // undefined (100% 로 오인 표기하지 않는다). 나머지 Sub KPI 의 지면은 카드가
  // 아니라 답변분석 > 언급 화면이다 (2026-07-29 결정).
  engineConsistency?: number;
  // Optional date-dimensioned series for a card sparkline. Only the
  // trafficConversion card sets it (GA4 daily 방문 수/visits), since it's the
  // one card with a true daily series — the scope-mirror KPIs use the shared
  // trend chart instead. Values only (x = sequential days).
  sparkline?: number[];
}

export const SAMPLE_KPI_SUMMARY: KpiSummary[] = [
  // ratio 는 각 value(비율)와 정합하도록 정한 예시 카운트 (num ÷ den ×100 ≈ value).
  { key: "visibility", value: 62.1, delta: 4.3, direction: "up", ratio: { numerator: 528, denominator: 850 } },
  { key: "shareOfVoice", value: 28.4, delta: -1.2, direction: "down", ratio: { numerator: 909, denominator: 3200 } },
  { key: "sentiment", value: 41.7, delta: 2.1, direction: "up", ratio: { numerator: 220, denominator: 528 } },
  { key: "position", value: 3.4, delta: -0.3, direction: "down", ratio: { numerator: 1666, denominator: 490 } }, // 순위의 합 ÷ 언급된 답변 수
  { key: "citationShare", value: 11.5, delta: 0.8, direction: "up", ratio: { numerator: 200, denominator: 1740 } },
  { key: "citationAccuracy", value: 84.2, delta: 1.4, direction: "up", ratio: { numerator: 160, denominator: 190 } },
  { key: "trafficConversion", value: 2.7, delta: 0.4, direction: "up", ratio: { numerator: 34, denominator: 1259 } },
];

// ─── Time series — for the trend chart ────────────────────────────────────

export type TrendPoint = {
  label: string; // W1..W12
} & Partial<Record<KpiKey, number>>;

const WEEKS = Array.from({ length: 12 }, (_, i) => `W${i + 1}`);

function series(values: Record<KpiKey, number[]>): TrendPoint[] {
  return WEEKS.map((label, i) => ({
    label,
    visibility: values.visibility[i],
    shareOfVoice: values.shareOfVoice[i],
    sentiment: values.sentiment[i],
    position: values.position[i],
    citationShare: values.citationShare[i],
    citationAccuracy: values.citationAccuracy[i],
    trafficConversion: values.trafficConversion[i],
  }));
}

export const SAMPLE_TREND: TrendPoint[] = series({
  visibility: [54, 55, 57, 56, 58, 59, 60, 58, 59, 61, 62, 62.1],
  shareOfVoice: [31, 30.5, 30, 29.4, 29.5, 29, 28.8, 28.5, 28, 28.2, 28.5, 28.4],
  sentiment: [38, 38.5, 39, 39.2, 39.8, 40, 40.5, 41, 41.2, 41.5, 41.6, 41.7],
  position: [3.8, 3.7, 3.7, 3.6, 3.6, 3.5, 3.5, 3.4, 3.5, 3.4, 3.4, 3.4],
  citationShare: [10, 10.2, 10.4, 10.5, 10.6, 10.8, 10.9, 11.0, 11.2, 11.3, 11.4, 11.5],
  citationAccuracy: [82, 82.4, 82.8, 83.0, 83.2, 83.5, 83.7, 83.9, 84.0, 84.0, 84.1, 84.2],
  trafficConversion: [2.0, 2.1, 2.2, 2.3, 2.3, 2.4, 2.5, 2.5, 2.6, 2.6, 2.7, 2.7],
});

// ─── Detail table — KPI 근거 (start/end/delta per KPI) ────────────────────

export interface DetailRow {
  key: KpiKey;
  start: number;
  end: number;
  delta: number;
}

export const SAMPLE_DETAIL: DetailRow[] = [
  { key: "visibility", start: 54, end: 62.1, delta: 8.1 },
  { key: "shareOfVoice", start: 31, end: 28.4, delta: -2.6 },
  { key: "sentiment", start: 38, end: 41.7, delta: 3.7 },
  { key: "position", start: 3.8, end: 3.4, delta: -0.4 },
  { key: "citationShare", start: 10, end: 11.5, delta: 1.5 },
  { key: "citationAccuracy", start: 82, end: 84.2, delta: 2.2 },
  { key: "trafficConversion", start: 2.0, end: 2.7, delta: 0.7 },
];

// ─── Competitive rankings (aeorank Overview 이식) ─────────────────────────
// 요약 진입점용 "경쟁 가시성" 랭킹. coverage = AI 답변 중 이 도메인/브랜드가
// 등장한 비율(%). isOurs 행은 본인(HMG) — 강조 표시. 상세는 답변 분석 탭으로.

export interface RankingRow {
  rank: number;
  name: string;
  coverage: number; // %
  isOurs: boolean;
}

// 도메인 인용 랭킹 — 어느 출처가 답변 근거로 자주 채택되는가.
export const SAMPLE_DOMAIN_RANKINGS: RankingRow[] = [
  { rank: 1, name: "carblog.kr", coverage: 46.6, isOurs: false },
  { rank: 2, name: "nyt.com", coverage: 42.2, isOurs: false },
  { rank: 3, name: "youtube.com", coverage: 37.9, isOurs: false },
  { rank: 4, name: "reddit.com/r/cars", coverage: 31.1, isOurs: false },
  { rank: 5, name: "hyundai.com", coverage: 24.8, isOurs: true },
  { rank: 6, name: "bobaedream.co.kr", coverage: 21.4, isOurs: false },
  { rank: 7, name: "caranddriver.com", coverage: 18.4, isOurs: false },
];

// 브랜드 언급 랭킹 — 어느 브랜드가 답변에 자주 등장하는가. coverage 내림차순.
export const SAMPLE_BRAND_RANKINGS: RankingRow[] = [
  { rank: 1, name: "Hyundai", coverage: 75.7, isOurs: true },
  { rank: 2, name: "Toyota", coverage: 72.3, isOurs: false },
  { rank: 3, name: "Tesla", coverage: 66.0, isOurs: false },
  { rank: 4, name: "Kia", coverage: 54.4, isOurs: true },
  { rank: 5, name: "BMW", coverage: 46.6, isOurs: false },
  { rank: 6, name: "Genesis", coverage: 40.8, isOurs: true },
  { rank: 7, name: "Honda", coverage: 37.9, isOurs: false },
];
