"use client";

import { createContext, use, useContext, useMemo, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { RnCardActions, useRnToast } from "@/components/renewal-ui";
import { downloadCsv, type CsvCell } from "@/app/[locale]/(renewal)/renewal/_components/csv";
import type { KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
import type { MentionsBrandLive } from "@/lib/scope/result-adapter";
import type { RnMentionInput } from "./mention-input";
import { OWN_KEY } from "./mention-model";

// Shared state of the renewal Mention body: the reads (promises), the KPI tab, the compare
// brands (colour follows the brand: 당사 navy, compare slots in pick order, the rest grey), the
// lit keys of the linked highlight, which cards show their table twin, and the brand drawer.

export const OWN_COLOR = "#002c5f";
export const COMPARE_COLORS = ["#eb6834", "#1baf7a", "#6250d6"] as const;
export const CONTEXT_COLOR = "#c9c3bb";
export const AVG_COLOR = "#8a837b";

/** What the drawer shows: one brand (prompts · citations) or one sentiment signal (prompts). */
export type DrawerTarget = { kind: "brand"; brand: string } | { kind: "signal"; signal: "positive" | "neutral" | "mixed" | "negative" };

export interface ComparePick {
  /** auto = the covered competitor with the highest share of voice */
  auto: boolean;
  brands: string[];
}

export interface MentionCtx {
  input: RnMentionInput;
  kpi: KpiTab;
  setKpi: (k: KpiTab) => void;
  ownLabel: string;
  /** brand rows of the body aggregate (all brands, server order = mentions desc) */
  brands: MentionsBrandLive[];
  /** tracked (당사) brand names */
  ownBrands: string[];
  pick: ComparePick;
  setPick: (p: ComparePick) => void;
  lit: string[];
  hover: (key: string | null) => void;
  flash: (key: string, ms?: number) => void;
  tables: ReadonlySet<string>;
  toggleTable: (id: string) => void;
  engineLabel: (engine: string) => string;
  openDrawer: (target: DrawerTarget) => void;
}

const Ctx = createContext<MentionCtx | null>(null);
export const MentionProvider = ({ value, children }: { value: MentionCtx; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export function useMention(): MentionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("MentionProvider missing");
  return c;
}

/**
 * Compare brands, resolved against the brand-trend series (only brands with a trend can be
 * compared). Suspends on the brand trend — call inside a card's <Suspense>.
 */
export function useCompare(): { compare: string[]; covered: string[]; colorOf: (brand: string) => string; toggle: (brand: string) => void } {
  const { input, pick, setPick, brands, ownBrands } = useMention();
  const trend = use(input.brandTrend);
  const t = useTranslations("renewal.mention.compare");
  const toast = useRnToast();
  return useMemo(() => {
    const series = new Set((trend?.brands ?? []).filter((b) => !b.isTracked).map((b) => b.brand));
    // covered competitors in share-of-voice order (the body aggregate's snapshot values)
    const covered = [...brands].filter((b) => !b.isTracked && series.has(b.brand)).sort((a, b) => b.share - a.share).map((b) => b.brand);
    for (const b of series) if (!covered.includes(b)) covered.push(b);
    const compare = pick.auto ? covered.slice(0, 1) : pick.brands.filter((b) => covered.includes(b));
    const colorOf = (brand: string) => {
      if (brand === OWN_KEY || ownBrands.includes(brand)) return OWN_COLOR;
      const i = compare.indexOf(brand);
      return i >= 0 ? COMPARE_COLORS[i] : CONTEXT_COLOR;
    };
    const toggle = (brand: string) => {
      if (!covered.includes(brand)) return;
      if (compare.includes(brand)) setPick({ auto: false, brands: compare.filter((x) => x !== brand) });
      else if (compare.length >= COMPARE_COLORS.length) toast(t("max", { max: COMPARE_COLORS.length }));
      else setPick({ auto: false, brands: [...compare, brand] });
    };
    return { compare, covered, colorOf, toggle };
  }, [trend, brands, ownBrands, pick, setPick, t, toast]);
}

export const pctTxt = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(1)}%`);
export const ppTxt = (v: number | null | undefined) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}pp`);
export const deltaTxt = (v: number | null | undefined) => (v == null ? "—" : Math.abs(v) < 0.05 ? "0.0pp" : `${v > 0 ? "▲" : "▼"}${Math.abs(v).toFixed(1)}pp`);
export const posTxt = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(1));
export const numTxt = (v: number | null | undefined, locale?: string) => (v == null ? "—" : v.toLocaleString(locale));
/** "2026-10-19" → "10/19" */
export const slotLabel = (d: string) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

/** Card actions: table twin toggle (when `tableId`) + ⋯ with CSV export and a link to the section. */
export function MentionCardActions({ tableId, section, csv }: { tableId?: string; section: string; csv: () => { name: string; rows: CsvCell[][] } }) {
  const { tables, toggleTable } = useMention();
  const t = useTranslations("renewal.mention.card");
  const toast = useRnToast();
  return (
    <RnCardActions
      menuLabel={t("menu")}
      table={tableId ? { on: tables.has(tableId), onToggle: () => toggleTable(tableId), showTable: t("table"), showChart: t("chart") } : undefined}
      menu={[
        {
          key: "csv",
          label: t("csv"),
          onSelect: () => {
            const { name, rows } = csv();
            downloadCsv(name, rows);
            toast(t("csvDone"));
          },
        },
        {
          key: "link",
          label: t("link"),
          onSelect: async () => {
            try {
              await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}${window.location.search}#${section}`);
              toast(t("linkDone"));
            } catch {
              toast(t("linkFailed"));
            }
          },
        },
      ]}
    />
  );
}
