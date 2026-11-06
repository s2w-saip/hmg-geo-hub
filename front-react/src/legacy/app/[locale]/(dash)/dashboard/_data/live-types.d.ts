// Type-only snapshot; no database or server implementation is included.
import type { BucketUnit } from "@/lib/db/repositories/scope-aggregates";
import type { TrendGap } from "@/lib/viz/trend-gap";
import type { KpiKey } from "./model";
import type { GeoMetrics } from "./overview-metrics";
export interface BrandStat {
    name: string;
    sov: number;
}
export interface MarketCompetition {
    hmgSov: number;
    hmgRank: number;
    fieldSize: number;
    topBrand: BrandStat | null;
    topRival: BrandStat | null;
    /** KPI 5종(Overview). 구 캐시/테스트 픽스처엔 없을 수 있어 optional. */
    metrics?: GeoMetrics;
    /** 참 = 답변은 있는데 브랜드 언급이 0(점유율 0/0). hmgSov 0·hmgRank 는 측정값이 아니다 — 스냅샷은 "—". API 원천만 싣는다. */
    noMentions?: boolean;
    /** Completed answers in this market (country = its own, region = sum of its countries). Read only by the renewal Overview. */
    answers?: number;
}
export interface GeoCountryRow extends MarketCompetition {
    code: string;
    country: string;
}
export interface GeoRegionRow extends MarketCompetition {
    region: string;
    countries: GeoCountryRow[];
}
export interface LiveGeo {
    markets: GeoRegionRow[];
    pending: string[];
    ourLabel: string;
}
export type TrendKpiKey = Extract<KpiKey, "visibility" | "shareOfVoice" | "sentiment" | "position" | "citationShare" | "citationAccuracy">;
export interface LiveTrendPoint {
    bucketStart: string;
    /**
     * 축 on 의 **x축 라벨 날짜**(귀속 날짜). 버킷 키는 주 격자라 website(금요일 귀속)
     * 에서 둘이 다르다. 축 off 면 `undefined` = 종전 라벨 규칙(`firstAt`).
     */
    roundDate?: string;
    firstAt: string | null;
    values: Partial<Record<TrendKpiKey, number>>;
    measuredDays: number;
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
    lastMeasuredAt: string | null;
    totalAnswers: number;
}
export interface LiveTopicSlice {
    topic: string | null;
    prompts: number;
    share: number;
}
export interface LiveSourceSlice {
    domain: string;
    citations: number;
    share: number;
    isOurs: boolean;
}
