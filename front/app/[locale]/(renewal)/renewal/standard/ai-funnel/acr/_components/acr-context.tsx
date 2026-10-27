"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { RnCardActions, useRnToast } from "@/components/renewal-ui";
import type { StandardAcr } from "@/lib/db/repositories/scope-aggregates";
import { downloadCsv, type CsvCell } from "@/app/[locale]/(renewal)/renewal/_components/csv";
import type { RnAcrView } from "../_data/screen-types";

// Shared state of the renewal ACR body: the view model (screen acr/renewal), the compare brands
// (colour follows the brand: 당사 navy, compare slots in pick order, the rest grey), the
// lit keys of the linked highlight, and which cards show their table twin.

export const OWN_COLOR = "#002c5f";
export const COMPARE_COLORS = ["#eb6834", "#1baf7a", "#6250d6"] as const;
export const CONTEXT_COLOR = "#c9c3bb";

export interface AcrCtx {
  view: RnAcrView;
  totals: StandardAcr["totals"];
  ownLabel: string;
  compare: string[];
  colorOf: (brand: string) => string;
  isOwn: (brand: string) => boolean;
  /** keys lit by the linked highlight (당사 ↔ every own brand) */
  lit: string[];
  hover: (key: string | null) => void;
  toggleCompare: (brand: string) => void;
  tables: ReadonlySet<string>;
  toggleTable: (id: string) => void;
  engineLabel: (engine: string) => string;
  countryLabel: (code: string | null) => string;
  /** 엔진·프롬프트 view (a finding can switch it before jumping) */
  battle: "all" | "notown" | "split";
  setBattle: (v: "all" | "notown" | "split") => void;
  /** 선택 분포 sheet (country|engine), null = the first */
  sheet: string | null;
  setSheet: (v: string | null) => void;
}

const Ctx = createContext<AcrCtx | null>(null);
export const AcrProvider = ({ value, children }: { value: AcrCtx; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export function useAcr(): AcrCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("AcrProvider missing");
  return c;
}

export function makeColorOf(compare: readonly string[], isOwn: (b: string) => boolean) {
  return (brand: string) => {
    if (brand === "__own" || isOwn(brand)) return OWN_COLOR;
    const i = compare.indexOf(brand);
    return i >= 0 ? COMPARE_COLORS[i] : CONTEXT_COLOR;
  };
}

export const pctTxt = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(1)}%`);
export const ppTxt = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}pp`;
export const deltaTxt = (v: number | null | undefined) => (v == null ? "—" : Math.abs(v) < 0.05 ? "0.0pp" : `${v > 0 ? "▲" : "▼"}${Math.abs(v).toFixed(1)}pp`);

/** Card actions: table twin toggle (when `tableId`) + ⋯ with CSV export and a link to the section. */
export function AcrCardActions({ tableId, section, csv }: { tableId?: string; section: string; csv: () => { name: string; rows: CsvCell[][] } }) {
  const { tables, toggleTable } = useAcr();
  const t = useTranslations("renewal.acr.card");
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
