"use client";

import { createContext, use, useContext, useMemo, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { RnCardActions, useRnToast } from "@/components/renewal-ui";
import { downloadCsv, type CsvCell } from "@/app/[locale]/(renewal)/renewal/_components/csv";
import type { KpiTab } from "@/app/[locale]/(dash)/standard/answer-analysis/_data/kpi-tab";
import type { RnMentionInput } from "./mention-input";
import type { MentionTypeKey } from "@/lib/db/repositories/scope-aggregates";
import { OWN_KEY, type RnDrawerBrand } from "../_data/screen-types";

// Shared state of the renewal Mention body: the reads (promises), the KPI tab, the compare
// brands (colour follows the brand: 당사 navy, compare slots in pick order, the rest grey), the
// lit keys of the linked highlight, which cards show their table twin, and the brand drawer.

export const OWN_COLOR = "#002c5f";
export const COMPARE_COLORS = ["#eb6834", "#1baf7a", "#6250d6"] as const;
export const CONTEXT_COLOR = "#c9c3bb";

/** A signal the drawer lists the prompts of: a sentiment, or a mention type (renewal audit 7-3, the original type
 *  breakdown's drilldown; the signal route takes both). */
export type DrawerSignal = "positive" | "neutral" | "mixed" | "negative" | MentionTypeKey;

/** What the drawer shows: one brand (prompts · citations) or one signal (prompts). A ranking row past the
 *  shell's drawer rows passes its own `row` (renewal audit 6-1). */
export type DrawerTarget = { kind: "brand"; brand: string; row?: RnDrawerBrand } | { kind: "signal"; signal: DrawerSignal };

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
  /** the brand drawer's rows (one per brand of the first 100 body brands, server order = mentions desc) */
  drawer: RnDrawerBrand[];
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
 * Compare brands, resolved against the covered competitors (only brands with a round trend can
 * be compared; the API orders them by share of voice). Suspends on that read — call inside a
 * card's <Suspense>. The pick is UI state: auto = the first covered brand.
 */
export function useCompare(): { compare: string[]; covered: string[]; colorOf: (brand: string) => string; toggle: (brand: string) => void } {
  const { input, pick, setPick, ownBrands } = useMention();
  const { covered } = use(input.compare);
  const t = useTranslations("renewal.mention.compare");
  const toast = useRnToast();
  return useMemo(() => {
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
  }, [covered, ownBrands, pick, setPick, t, toast]);
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
