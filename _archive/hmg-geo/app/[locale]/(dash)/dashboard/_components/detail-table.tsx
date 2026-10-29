"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import { KPI_DEFINITIONS, type DetailRow } from "../_data/sample";

type SortKey = "kpi" | "start" | "end" | "delta";

function fmt(v: number, unit: "percent" | "score" | "rank"): string {
  if (unit === "percent") return `${v.toFixed(1)}%`;
  if (unit === "rank") return `${v.toFixed(1)} Rank`;
  return v.toFixed(1);
}

function fmtDelta(v: number, unit: "percent" | "score" | "rank"): string {
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  const abs = Math.abs(v);
  const unitStr = unit === "percent" ? "pp" : "";
  return `${sign}${abs.toFixed(1)}${unitStr}`;
}

export function DetailTable({ rows }: { rows: DetailRow[] }) {
  const t = useTranslations("dashboard.table");
  const tKpi = useTranslations("dashboard.kpi.name");

  const rowsWithMeta = useMemo(
    () =>
      rows.map((r) => {
        const def = KPI_DEFINITIONS.find((d) => d.key === r.key);
        return {
          ...r,
          unit: def?.unit ?? "percent",
          betterIs: def?.betterIs ?? "higher",
        };
      }),
    [rows],
  );

  const { sorted, headerProps } = useSortableTable<typeof rowsWithMeta[number], SortKey>(
    rowsWithMeta,
    {
      kpi: (r) => tKpi(r.key),
      start: (r) => r.start,
      end: (r) => r.end,
      delta: (r) => r.delta,
    },
    { defaultKey: "delta", defaultAsc: false, ascByDefault: ["kpi"] },
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            <th className="px-3 py-2 w-1/2">
              <SortableHeader {...headerProps("kpi")}>{t("kpi")}</SortableHeader>
            </th>
            <th className="px-3 py-2">
              <SortableHeader {...headerProps("start")} align="right">
                {t("start")}
              </SortableHeader>
            </th>
            <th className="px-3 py-2">
              <SortableHeader {...headerProps("end")} align="right">
                {t("end")}
              </SortableHeader>
            </th>
            <th className="px-3 py-2">
              <SortableHeader {...headerProps("delta")} align="right">
                {t("delta")}
              </SortableHeader>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const goodness =
              r.delta === 0
                ? "flat"
                : r.betterIs === "higher"
                  ? r.delta > 0
                    ? "good"
                    : "bad"
                  : r.delta < 0
                    ? "good"
                    : "bad";
            return (
              <tr key={r.key} className="border-t border-border first:border-t-0">
                <td className="px-3 py-2.5 text-foreground">{tKpi(r.key)}</td>
                <td className="px-3 py-2.5 text-right text-foreground">
                  {fmt(r.start, r.unit)}
                </td>
                <td className="px-3 py-2.5 text-right font-medium text-foreground">
                  {fmt(r.end, r.unit)}
                </td>
                <td
                  className={cn(
                    "px-3 py-2.5 text-right font-semibold",
                    goodness === "good"
                      ? "text-emerald-600"
                      : goodness === "bad"
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {fmtDelta(r.delta, r.unit)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
