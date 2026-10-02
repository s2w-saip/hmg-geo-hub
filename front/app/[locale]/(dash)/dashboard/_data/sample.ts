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
  | "ownedUrlRate"
  | "targetUrlRate"
  | "citationShare"
  | "citationAccuracy"
  // 답변의 전환
  | "trafficConversion";

// count = 건수(정수, 자릿수 구분). Δ 는 pp 가 아니라 건수 차이로 표기한다.
export type KpiUnit = "percent" | "score" | "rank" | "count";

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
    | "ownedUrl"
    | "targetUrl"
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
  // 답변의 출처 — GGMD-54(2026-09-16): 자사 URL·타겟 URL 카드 2종을 **왼쪽**에 둔다.
  // 배열 순서가 곧 화면 순서(SummaryTiles 는 이 배열을 카테고리별로 filter 한다).
  // GGMD-61(2026-09-17) — 둘 다 **프롬프트 기준 비율**이다(목업 GGMD-54 와 동일).
  // 분모는 두 카드가 공유하는 "측정 프롬프트"이고, 산출은 한 문장에서 함께 나온다
  // (scope-aggregates::aggregateWebsiteTargetHitRate). 웹사이트 화면만 값을 싣고
  // (website/_data/live.ts), 글로벌·프로젝트 화면은 키가 없어 타일이 숨는다.
  {
    key: "ownedUrlRate", // 자사 URL 인용률 (프롬프트 기준)
    category: "source",
    question: "ownedUrl",
    unit: "percent",
    betterIs: "higher",
  },
  {
    key: "targetUrlRate", // 타겟 URL 인용률 (프롬프트 기준)
    category: "source",
    question: "targetUrl",
    unit: "percent",
    betterIs: "higher",
  },
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

/**
 * KPI 값의 출처. `published` = 고객에게 나간 발행 리포트의 정수 쌍을 그대로 읽었다.
 * `live` = 실시간 집계(발행물이 답할 수 없는 조합이거나 발행물이 없는 회차).
 * 직렬화 가능한 평범한 값만 담는다(서버 → 클라 경계를 넘는다).
 */
export interface KpiProvenance {
  source: "published" | "live";
  cycleLabel?: string | null;
  cycleLabelEn?: string | null;
  roundDate?: string;
  /** 이 값에 실제로 들어간 발행 사이트 수(모수 공개용). */
  siteCount?: number;
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
  // 값의 **출처** — 발행 리포트 정본 경로(`X.reportTruth`)가 켜졌을 때만 채워진다.
  // 키가 꺼져 있으면 undefined 라 종전 타일과 같다.
  //
  // ⚠️ 이 필드가 있는 이유: 같은 화면의 다른 타일은 라이브인데 이 카드만 발행값으로
  //    바뀌면, 표식이 없을 때 다음 사람이 "왜 어제와 다른가" 를 추적할 수 없다.
  //    설계 원칙이 "조용히 섞지 않는다" 이므로 표면마다 표식이 따라가야 한다
  //    (2026-09-20 검증 차단 3: 대시보드 카드 2종이 표식을 버리고 있었다).
  provenance?: KpiProvenance;
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
  // 문구 원천(U5, 설계 3.5 부수 · DC-02 · DC-03): 새 백엔드(api)가 만든 카드 중 정의가 바뀐
  // 지표(⑦ 전환율 분모 = 세션, 자사·타겟 URL 인용률 = 측정 단위)에만 "api" 가 붙는다. 그때
  // 타일은 분자·분모 라벨과 정의·산식 툴팁을 `dashboard.kpi.api.*`(messages/units/u5)에서 고른다.
  // undefined(legacy, 롤백 경로)면 종전 키 그대로다. messages 는 전역이라 키를 덮어쓰지 않고 가른다.
  copyVariant?: "api";
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
    ownedUrlRate: values.ownedUrlRate[i],
    targetUrlRate: values.targetUrlRate[i],
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
  ownedUrlRate: [70.1, 70.8, 71.4, 71.9, 72.5, 73.0, 73.4, 73.9, 74.2, 74.6, 75.0, 75.3],
  targetUrlRate: [55.2, 55.6, 56.1, 56.4, 56.9, 57.3, 57.6, 58.0, 58.2, 58.5, 58.8, 59.1],
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
