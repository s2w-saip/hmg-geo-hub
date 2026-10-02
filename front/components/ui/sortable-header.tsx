"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

// Header cell trigger paired with `useSortableTable.headerProps(key)`.
// Renders as a button inside a <th> (or any wrapper) — caller chooses
// the wrapping element so this works for both real <table>s and the
// table-like grid layouts (div + role="grid").
//
// align="right" right-aligns numeric columns; default left-aligns.

export type SortableHeaderProps = {
  active: boolean;
  asc: boolean;
  onClick: () => void;
  align?: "right";
  className?: string;
  children: React.ReactNode;
};

export function SortableHeader({
  active,
  asc,
  onClick,
  align,
  className,
  children,
}: SortableHeaderProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-sort={active ? (asc ? "ascending" : "descending") : "none"}
      className={cn(
        "inline-flex items-center gap-1.5 text-left whitespace-nowrap transition-colors hover:text-foreground",
        active ? "text-foreground" : "text-muted-foreground",
        align === "right" && "ml-auto flex w-full justify-end",
        className,
      )}
    >
      {children}
      {active ? (
        asc ? (
          <ArrowUp className="h-3 w-3" aria-hidden />
        ) : (
          <ArrowDown className="h-3 w-3" aria-hidden />
        )
      ) : (
        <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />
      )}
    </button>
  );
}
