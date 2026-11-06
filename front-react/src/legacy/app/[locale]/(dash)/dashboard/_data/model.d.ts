// Type-only snapshot; no database or server implementation is included.
export type KpiCategory = "content" | "source" | "conversion";
export type KpiKey = "visibility" | "shareOfVoice" | "sentiment" | "position" | "ownedUrlRate" | "targetUrlRate" | "citationShare" | "citationAccuracy" | "trafficConversion";
export type KpiUnit = "percent" | "score" | "rank" | "count";
export interface KpiDefinition {
    key: KpiKey;
    category: KpiCategory;
    question: "coverage" | "density" | "favorability" | "priority" | "citationVolume" | "targetSource" | "ownedUrl" | "targetUrl" | "visit";
    unit: KpiUnit;
    betterIs: "higher" | "lower";
}
export declare const KPI_DEFINITIONS: KpiDefinition[];
export interface KpiRatio {
    numerator: number;
    denominator: number;
}
export interface KpiProvenance {
    source: "published" | "live";
    cycleLabel?: string | null;
    cycleLabelEn?: string | null;
    roundDate?: string;
    siteCount?: number;
}
export interface KpiSummary {
    key: KpiKey;
    value: number | null;
    delta: number | null;
    direction: "up" | "down" | "flat";
    coverage?: {
        measured: number;
        total: number;
    };
    ratio?: KpiRatio;
    provenance?: KpiProvenance;
    competitorSov?: {
        brand: string;
        value: number | null;
    };
    engineConsistency?: number;
    copyVariant?: "api";
    sparkline?: number[];
}
export declare const EMPTY_KPI_SUMMARY: KpiSummary[];
export type TrendPoint = {
    label: string;
} & Partial<Record<KpiKey, number>>;
export declare const EMPTY_TREND: TrendPoint[];
export interface DetailRow {
    key: KpiKey;
    start: number;
    end: number;
    delta: number;
}
export declare const EMPTY_DETAIL: DetailRow[];
export interface RankingRow {
    rank: number;
    name: string;
    coverage: number;
    isOurs: boolean;
}
export declare const EMPTY_DOMAIN_RANKINGS: RankingRow[];
export declare const EMPTY_BRAND_RANKINGS: RankingRow[];
