// Shared view types and explicit empty states. All values are supplied by Gold.
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
export const KPI_DEFINITIONS: KpiDefinition[] = [
    {
        key: "visibility",
        category: "content",
        question: "coverage",
        unit: "percent",
        betterIs: "higher",
    },
    {
        key: "shareOfVoice",
        category: "content",
        question: "density",
        unit: "percent",
        betterIs: "higher",
    },
    {
        key: "sentiment",
        category: "content",
        question: "favorability",
        unit: "percent",
        betterIs: "higher",
    },
    {
        key: "position",
        category: "content",
        question: "priority",
        unit: "rank",
        betterIs: "lower",
    },
    {
        key: "ownedUrlRate",
        category: "source",
        question: "ownedUrl",
        unit: "percent",
        betterIs: "higher",
    },
    {
        key: "targetUrlRate",
        category: "source",
        question: "targetUrl",
        unit: "percent",
        betterIs: "higher",
    },
    {
        key: "citationShare",
        category: "source",
        question: "citationVolume",
        unit: "percent",
        betterIs: "higher",
    },
    {
        key: "citationAccuracy",
        category: "source",
        question: "targetSource",
        unit: "percent",
        betterIs: "higher",
    },
    {
        key: "trafficConversion",
        category: "conversion",
        question: "visit",
        unit: "percent",
        betterIs: "higher",
    },
];
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
export const EMPTY_KPI_SUMMARY: KpiSummary[] = [];
export type TrendPoint = {
    label: string;
} & Partial<Record<KpiKey, number>>;
export const EMPTY_TREND: TrendPoint[] = [];
export interface DetailRow {
    key: KpiKey;
    start: number;
    end: number;
    delta: number;
}
export const EMPTY_DETAIL: DetailRow[] = [];
export interface RankingRow {
    rank: number;
    name: string;
    coverage: number;
    isOurs: boolean;
}
export const EMPTY_DOMAIN_RANKINGS: RankingRow[] = [];
export const EMPTY_BRAND_RANKINGS: RankingRow[] = [];
