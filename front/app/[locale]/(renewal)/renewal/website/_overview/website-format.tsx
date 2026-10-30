"use client";

// Shared by the renewal Website Overview sections: the screens' view types the page adds, the number formats
// and the links to the website analysis pages. No values are computed here.

import { useLocale, useTranslations } from "next-intl";
import { ENGINE_LABEL } from "@/components/dash/dimension-filter-panel";
import type { KpiKey, KpiUnit } from "@/app/[locale]/(dash)/dashboard/_data/model";
import type { PeriodChip } from "@/lib/kpi/period-compare-view";

/** A read that failed transiently (5xx, timeout): the card says so instead of vanishing. */
export type Failed = "failed";

/** The KPI order of the website tiles (back/bff/screens/overview.py KPI_DEFINITIONS). */
export const WEBSITE_KPI_KEYS: readonly KpiKey[] = [
  "visibility", "shareOfVoice", "sentiment", "position", "ownedUrlRate", "targetUrlRate", "citationShare", "citationAccuracy", "trafficConversion",
];

/** The five KPIs the engine rows carry (website/engines). */
export const ENGINE_KPI_KEYS = ["visibility", "shareOfVoice", "sentiment", "position", "citationShare"] as const;
export type EngineKpiKey = (typeof ENGINE_KPI_KEYS)[number];

/** website/engines: the engine rows behind the 엔진 간 일관성 badge, as values. */
export interface WebsiteEnginesView {
  engines: {
    engine: string;
    answers: number;
    values: Record<EngineKpiKey, number | null>;
    ratios: Record<EngineKpiKey, { num?: number; den?: number; sum?: number; count?: number }>;
  }[];
  /** The badge's min ÷ max per KPI (two engines or more). */
  consistency: Partial<Record<EngineKpiKey, number>>;
  /** Best and worst engine per KPI by its direction (two engines or more). */
  extremes: Partial<Record<EngineKpiKey, { best: { engine: string; value: number | null }; worst: { engine: string; value: number | null } }>>;
  /** The KPI of the lowest consistency. */
  widest: EngineKpiKey | null;
  degraded: boolean;
}

export interface BrandCellView {
  unit: KpiUnit;
  value: number | null;
  pending: boolean;
  delta: number | null;
  direction: "up" | "down" | "flat";
  tone: "good" | "bad" | "flat";
  period: PeriodChip | null;
  bar: number;
  best: boolean;
}

/** website/brands: each website brand's tiles side by side (administrators without a brand pick), else null. */
export interface WebsiteBrandsView {
  brands: { brand: string; state: "ok" | "empty" | "degraded"; cells: Partial<Record<KpiKey, BrandCellView>> }[] | null;
}

export const engineLabel = (code: string) => ENGINE_LABEL[code] ?? code;

/** The website analysis page a KPI opens (the renewal Overview's rule on the website pages). */
export function websiteDetailHref(key: KpiKey, locale: string, qs: string): string {
  const base = `/${locale}/renewal/website`;
  const q = (head: string) => (qs ? `${head}${head.includes("?") ? "&" : "?"}${qs}` : head);
  switch (key) {
    case "visibility": return q(`${base}/answer-analysis/mention?kpi=exposure`);
    case "shareOfVoice": return q(`${base}/answer-analysis/mention?kpi=sov`);
    case "sentiment": return q(`${base}/answer-analysis/mention?kpi=favorability`);
    case "position": return q(`${base}/answer-analysis/mention?kpi=first-rank`);
    case "trafficConversion": return q(`${base}/ai-funnel/conversion`);
    default: return q(`${base}/answer-analysis/citation`);
  }
}

export function useFormat() {
  const tUnit = useTranslations("metricUnit");
  const locale = useLocale();
  const value = (unit: KpiUnit, v: number) =>
    unit === "percent" ? `${v.toFixed(1)}%` : unit === "rank" ? tUnit("position", { n: v.toFixed(1) }) : unit === "count" ? Math.round(v).toLocaleString(locale) : v.toFixed(1);
  // Δ shows the magnitude; the arrow carries the direction (the screen's).
  const delta = (unit: KpiUnit, d: number) =>
    unit === "percent" ? `${Math.abs(d).toFixed(1)}pp` : unit === "rank" ? tUnit("position", { n: Math.abs(d).toFixed(1) }) : unit === "count" ? Math.round(Math.abs(d)).toLocaleString(locale) : Math.abs(d).toFixed(1);
  const count = (n: number) => n.toLocaleString(locale);
  return { value, delta, count };
}

/** A Δ that shows as 0.0 at the page's one decimal: it reads 변화 없음, never "−0.0" (RnDeltaChip rounds the same way). */
export const isFlat = (d: number) => Math.round(Math.abs(d) * 10) === 0;

/** The unit of a KPI (back/bff KPI_DEFINITIONS). */
export const unitOf = (k: KpiKey): KpiUnit => (k === "position" ? "rank" : "percent");

/** Short KPI names for table heads (the renewal Overview's five, plus the website's URL rates). */
export function useShortName() {
  const tS = useTranslations("renewal.overview.short");
  const tW = useTranslations("renewal.website.overview.short");
  return (k: KpiKey) => (tS.has(k) ? tS(k as "visibility") : tW(k as "ownedUrlRate"));
}
