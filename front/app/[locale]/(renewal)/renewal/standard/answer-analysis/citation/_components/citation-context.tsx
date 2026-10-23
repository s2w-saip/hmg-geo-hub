"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { RnCardActions, useRnToast } from "@/components/renewal-ui";
import { downloadCsv, type CsvCell } from "@/app/[locale]/(renewal)/renewal/_components/csv";
import { ENGINE_LABEL } from "@/components/dash/dimension-filter-panel";
import { citationCategorySlug } from "@/lib/citation-categorizer/taxonomy";
import type { CitationDomainLive, CitationsLive } from "@/lib/scope/result-adapter";
import type { RnCitationInput } from "./citation-input";

// Shared state of the renewal Citation body: the reads, the URL axes (출처 · 경쟁사), the lit key
// of the linked highlight (a category name or a domain), the table twins, the matrix axis and
// the domain drawer. Colour only where identity matters: 공식(HMG) navy, the three biggest rank
// movers in the compare colours, a diverging pair for the matrix gaps; categories carry names.

export const OWN_COLOR = "#002c5f";
export const MOVER_COLORS = ["#eb6834", "#1baf7a", "#6250d6"] as const;
export const CONTEXT_COLOR = "#c9c3bb";
/** Matrix: cited more than 전체 (blue) / less (orange) / no gap (warm grey). */
export const DIV_MORE = [47, 109, 181] as const;
export const DIV_LESS = [217, 130, 43] as const;
export const DIV_MID = [243, 241, 238] as const;

export type MatrixAxis = "engine" | "type";

export interface CitationCtx {
  input: RnCitationInput;
  live: CitationsLive;
  /** ?competitor= picks */
  picked: ReadonlySet<string>;
  /** ?source= picks */
  active: readonly string[];
  lit: string | null;
  hover: (key: string | null) => void;
  flash: (key: string, ms?: number) => void;
  tables: ReadonlySet<string>;
  toggleTable: (id: string) => void;
  axis: MatrixAxis;
  setAxis: (a: MatrixAxis) => void;
  /** opens the domain drawer (a row of the table or of the aggregate) */
  openDomain: (row: CitationDomainLive) => void;
}

const Ctx = createContext<CitationCtx | null>(null);
export const CitationProvider = ({ value, children }: { value: CitationCtx; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export function useCitation(): CitationCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("CitationProvider missing");
  return c;
}

/** Category display name (the taxonomy value stays the key). */
export function useCatLabel(): (name: string) => string {
  const tCat = useTranslations("citationCategories");
  return useCallback(
    (name: string) => {
      const slug = citationCategorySlug(name);
      return slug ? tCat(slug) : name;
    },
    [tCat],
  );
}

export const engineLabel = (e: string) => ENGINE_LABEL[e] ?? e;

/** Matrix cell background: the gap to 전체 mixed from the warm grey towards its pole (60% at the cap). */
export function divBg(gap: number, cap: number): string {
  const t = Math.min(1, Math.abs(gap) / cap) * 0.6;
  const pole = gap >= 0 ? DIV_MORE : DIV_LESS;
  return `rgb(${DIV_MID.map((m, i) => Math.round(m + (pole[i] - m) * t)).join(",")})`;
}
export const DIV_LEGEND = `linear-gradient(90deg, ${divBg(-1, 1)}, rgb(${DIV_MID.join(",")}) 50%, ${divBg(1, 1)})`;

/** Card actions: table twin toggle (when `tableId`) + ⋯ with CSV export and a link to the section. */
export function CitationCardActions({ tableId, section, csv }: { tableId?: string; section: string; csv: () => { name: string; rows: CsvCell[][] } }) {
  const { tables, toggleTable } = useCitation();
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
