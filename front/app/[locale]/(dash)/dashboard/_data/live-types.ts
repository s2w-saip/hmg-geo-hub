// Shapes of the former dashboard live reader (the Overview's market rows, KPI trend and composition
// slices). The overview screens (back/bff/screens/overview.py) send them inside their payloads
// (screen-types.ts) and the component test fixtures are written in them. Types only.
import type { BucketUnit } from "@/lib/db/repositories/scope-aggregates";
import type { TrendGap } from "@/lib/viz/trend-gap";
import type { KpiKey } from "./model";
import type { GeoMetrics } from "./overview-metrics";

// 브랜드 격리(boundary): "우리"의 정의는 호출 계정의 브랜드 권한(ourBrands)에 따라 좁혀진다. topBrand = ourBrands 중 그
// 시장 최강 단일 브랜드, topRival = 그 시장 최강 외부 브랜드.
export interface BrandStat {
  name: string;
  sov: number; // share of voice (% of the market's brand mentions)
}
export interface MarketCompetition {
  hmgSov: number; // OUR (scoped-brand) combined share of voice (%)
  hmgRank: number; // OUR rank among entities (us vs each external competitor), 1-based
  fieldSize: number; // number of ranked entities (us + external competitors)
  topBrand: BrandStat | null; // OUR strongest single in-scope brand here
  topRival: BrandStat | null; // strongest external (non-HMG) brand here
  /** KPI 5종(Overview). 구 캐시/테스트 픽스처엔 없을 수 있어 optional. */
  metrics?: GeoMetrics;
  /** 참 = 답변은 있는데 브랜드 언급이 0(점유율 0/0). hmgSov 0·hmgRank 는 측정값이 아니다 — 스냅샷은 "—". API 원천만 싣는다. */
  noMentions?: boolean;
  /** Completed answers in this market (country = its own, region = sum of its countries). Read only by the renewal Overview. */
  answers?: number;
}
export interface GeoCountryRow extends MarketCompetition {
  code: string; // ISO alpha-2 (scope region)
  country: string; // catalog display name (e.g. "United States")
}
export interface GeoRegionRow extends MarketCompetition {
  region: string; // RHQ 권역 id (brand-specific, e.g. "hyundai-europe")
  countries: GeoCountryRow[]; // desc by HMG SoV
}
// markets = 측정된 권역 (desc by HMG SoV); pending = 아직 측정 안 된 권역 키들.
// ourLabel = 점유율 주체 라벨 — admin(무제한)은 "HMG", 브랜드 스코프 계정은 자기
// 브랜드명. 지도/표가 "{ourLabel} 점유율"로 헤더·툴팁을 렌더.
export interface LiveGeo {
  markets: GeoRegionRow[];
  pending: string[];
  ourLabel: string;
}

// KPI 추이 — 각 버킷은 카드와 같은 산식의 값과 coverage(측정일수 · 답변수 · 마지막측정)를 싣는다.
export type TrendKpiKey = Extract<
  KpiKey,
  | "visibility"
  | "shareOfVoice"
  | "sentiment"
  | "position"
  | "citationShare"
  | "citationAccuracy"
>;

export interface LiveTrendPoint {
  bucketStart: string; // ISO date (week = 그 주 월요일 / day = 그 날)
  /**
   * 축 on 의 **x축 라벨 날짜**(귀속 날짜). 버킷 키는 주 격자라 website(금요일 귀속)
   * 에서 둘이 다르다. 축 off 면 `undefined` = 종전 라벨 규칙(`firstAt`).
   */
  roundDate?: string;
  firstAt: string | null; // 버킷 내 실제 첫 측정 시각 (주 라벨에 실측일 표기용)
  values: Partial<Record<TrendKpiKey, number>>;
  measuredDays: number; // 버킷 안 실제 측정 일수 (coverage 배지)
  answers: number;
  lastAt: string | null;
  /**
   * 회차 버킷의 대표 앵커(ISO) — **x축 라벨 전용**(표시일은 화면이 계산한다). 키(`bucketStart`)는
   * 앵커의 UTC 일이라 그대로 그리면 KST 자정 직후 앵커가 하루 앞서 보인다(2026-09-28).
   * 미러 격자 버킷은 없다(`StandardTrendBucket.cycleAnchorAt` 을 그대로 나른다).
   */
  cycleAnchorAt?: string;
  /**
   * 수집 오류 회차(2026-09-10). 값이 있으면 이 슬롯은 **측정값 전부 null** 이고
   * 화면은 음영 + 안내 문구를 낸다. 계약 정본: lib/viz/trend-gap.ts.
   */
  gap?: TrendGap;
}

export interface LiveTrend {
  unit: BucketUnit;
  /**
   * **x축 라벨의 시계**(2026-09-20). 생략·`"measured"` = 종전(주 라벨은 그 주 첫
   * 측정일 `firstAt`), `"anchor"` = 앵커 축이라 라벨이 **버킷 키 그 자체**다.
   *
   * 왜 필요한가: 축 on 에서 버킷 키는 귀속 날짜(`round_date`/`anchor_week`)인데
   * 라벨만 `firstAt` 에 머물러 있었다(`trendBucketLabel`). 그래서 website 추이의
   * x축이 목·월·화가 섞인 **측정 시작일**로 찍혔고, 두 버킷의 첫 측정일이 같은 날이면
   * 같은 라벨이 두 번 나왔다(2026-09-20 관찰 `7. 27.` × 2). 마지막 점 라벨도
   * 카드 기준일과 어긋났다(09-17 vs 09-11).
   *
   * 데이터로는 못 가른다 — 축 off 의 주 버킷도 월요일이라 값 모양이 같다. 그래서
   * 서버가 판정을 실어 보낸다(`cycleAnchorAt` 이 집계층 경로에만 있는 것과 달리
   * 이 값은 미러 경로에도 실린다).
   */
  axis?: "anchor" | "measured";
  points: LiveTrendPoint[];
  lastMeasuredAt: string | null; // 전체에서 가장 최근 측정 시각
  totalAnswers: number;
}

// 구성 분석 (#21 주제별 / #22 출처별 구성비).
export interface LiveTopicSlice {
  topic: string | null; // funnel_stage (null = 미분류)
  prompts: number;
  share: number; // % of monitored prompts
}
export interface LiveSourceSlice {
  domain: string; // "" = 기타(top-N 밖 합산 버킷)
  citations: number;
  share: number; // % of total citations
  isOurs: boolean;
}
