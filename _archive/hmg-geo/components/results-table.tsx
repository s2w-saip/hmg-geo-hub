"use client";

import { useTranslations } from "next-intl";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import type { ResultItem } from "@/lib/scope/types";

// Recent measurements table on the unified dashboard.
//
// External interface unchanged — pages pass an array of ResultItem.
// 2026-06-04 sort pass: every column header is now clickable to sort
// (default = createdAt desc, the most-recent-first the dashboard
// expects).

type SortKey = "prompt" | "target" | "status" | "createdAt";

export function ResultsTable({ items }: { items: ResultItem[] }) {
  const t = useTranslations("results");
  const { sorted, headerProps } = useSortableTable<ResultItem, SortKey>(
    items,
    {
      prompt: (r) => r.prompt,
      target: (r) => r.target,
      status: (r) => r.status,
      createdAt: (r) => new Date(r.createdAt).getTime(),
    },
    {
      defaultKey: "createdAt",
      defaultAsc: false,
      ascByDefault: ["prompt", "target", "status"],
    },
  );

  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("empty")}</p>;
  }

  return (
    <Table>
      <TableHeader className="[&_tr]:border-foreground/10">
        <TableRow className="hover:bg-transparent">
          <TableHead className="text-xs font-semibold text-muted-foreground">
            <SortableHeader {...headerProps("prompt")}>{t("prompt")}</SortableHeader>
          </TableHead>
          <TableHead className="text-xs font-semibold text-muted-foreground">
            <SortableHeader {...headerProps("target")}>{t("target")}</SortableHeader>
          </TableHead>
          <TableHead className="text-xs font-semibold text-muted-foreground">
            <SortableHeader {...headerProps("status")}>{t("status")}</SortableHeader>
          </TableHead>
          <TableHead className="text-xs font-semibold text-muted-foreground">
            <SortableHeader {...headerProps("createdAt")}>{t("createdAt")}</SortableHeader>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((r) => (
          <TableRow key={r.id} className="border-0 odd:bg-muted/30">
            <TableCell className="text-foreground">{r.prompt}</TableCell>
            <TableCell className="text-muted-foreground">{r.target}</TableCell>
            <TableCell className="text-muted-foreground">{r.status}</TableCell>
            <TableCell className="text-muted-foreground">
              {new Date(r.createdAt).toLocaleString()}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
