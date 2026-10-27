// Test fixture: the citation screens' precomputed numbers for component render tests (the screen
// payloads of back/bff/screens/citation.py, `vm` and `typeChart`). The standard vm and the type chart
// were recorded once from the former client rules and are read from citation-vm.frozen.json
// (test/frozen.ts); the website / project vm keeps its few display rules here.
import type { OverviewCardDelta } from "@/lib/kpi/overview-card-values";
import type { CitationTypeCategoryRow } from "@/lib/db/repositories/scope-aggregates";
import type { CitationCategorySlice, CitationsLive, EngineCategorySlice } from "@/lib/scope/result-adapter";
import { frozen, loadFrozen } from "@/test/frozen";
import type { PrevCategories } from "@/app/[locale]/(renewal)/renewal/standard/answer-analysis/citation/_components/citation-input";
import {
  DEALER_CATEGORY,
  OFFICIAL_HMG_CATEGORY,
  type CitationDegradedFlags,
  type CitationStandardVm,
  type CitationTypeChart,
  type CitationsViewVm,
  type EngineChartView,
  type NumberedDomainRow,
} from "../_data/citation-view";

const TABLE = loadFrozen(new URL("./citation-vm.frozen.json", import.meta.url));

export function engineChartFor(data: EngineCategorySlice[] | null | undefined): EngineChartView | null {
  if (!data?.length) return null;
  const totals = new Map<string, number>();
  for (const e of data) for (const [c, v] of Object.entries(e.byCategory)) totals.set(c, (totals.get(c) ?? 0) + v);
  const series = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  return { series, rows: data.map((e) => ({ engine: e.engine, ...Object.fromEntries(series.map((s) => [s, e.byCategory[s] ?? 0])) })) };
}

export function donutPctFor(data: CitationCategorySlice[], total?: number): number | null {
  const t = total ?? data.reduce((s, c) => s + c.value, 0);
  const official = data.find((c) => c.name === OFFICIAL_HMG_CATEGORY)?.value ?? 0;
  return t > 0 ? Math.round(((100 * official) / t) * 10) / 10 : null;
}

type Row = CitationsLive["domains"][number] & { rank?: number; matchRank?: number };
const numbered = (rows: Row[], key: "rank" | "matchRank"): NumberedDomainRow[] => rows.map((r, i) => ({ ...r, no: r[key] ?? i + 1 }));

/** `citation/standard` typeChart for the type × category rows. */
export function typeChartFor(...args: [rows: CitationTypeCategoryRow[] | null]): CitationTypeChart | null {
  return frozen(TABLE, "typeChartFor", args);
}

/** `citation/standard` vm for a live fixture and the page URL (search) / Δ inputs. */
export function standardVmFor(
  ...args: [
    live: CitationsLive | null,
    opts?: { search?: string; card?: OverviewCardDelta | null; prev?: PrevCategories; sections?: Partial<CitationDegradedFlags> | null },
  ]
): CitationStandardVm | null {
  return frozen(TABLE, "standardVmFor", args);
}

/** `citation/website` / `citation/project` vm for a live fixture. */
export function viewVmFor(live: CitationsLive | null): CitationsViewVm | null {
  if (!live) return null;
  const cats = live.categories;
  const total = (cats ?? []).reduce((s, c) => s + c.value, 0);
  const dealer = cats?.find((c) => c.name === DEALER_CATEGORY)?.value ?? 0;
  return {
    dealerShare: cats?.length && total ? (100 * dealer) / total : null,
    officialPct: cats ? donutPctFor(cats) : null,
    engineChart: engineChartFor(live.engineCategories),
    domains: numbered(live.domains as Row[], "matchRank"),
  };
}
