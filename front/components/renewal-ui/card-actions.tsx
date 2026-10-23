"use client";

import { useState } from "react";
import { ChartLine, Ellipsis, Table2 } from "lucide-react";
import { RnIconButton } from "./button";
import { RnMenu, RnMenuItem } from "./menu";

/**
 * Card actions: an icon toggle between the chart and its table twin, and a ⋯ menu.
 * Labels come in through props (the toggle's name follows its state).
 */
export function RnCardActions({
  table,
  menu,
  menuLabel,
}: {
  table?: { on: boolean; onToggle: () => void; showTable: string; showChart: string };
  menu?: ReadonlyArray<{ key: string; label: string; onSelect: () => void }>;
  menuLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center gap-0.5" data-rn-cacts="">
      {table ? (
        <RnIconButton
          label={table.on ? table.showChart : table.showTable}
          aria-pressed={table.on}
          data-rn-tv=""
          onClick={table.onToggle}
          className={table.on ? "bg-rn-navy/8 text-rn-navy" : undefined}
        >
          {table.on ? <ChartLine className="size-3.5" aria-hidden /> : <Table2 className="size-3.5" aria-hidden />}
        </RnIconButton>
      ) : null}
      {menu?.length ? (
        <>
          <RnIconButton label={menuLabel} aria-haspopup="menu" aria-expanded={open} data-rn-cmenu="" onClick={() => setOpen((o) => !o)}>
            <Ellipsis className="size-3.5" aria-hidden />
          </RnIconButton>
          {open ? (
            <RnMenu onClose={() => setOpen(false)} className="right-0 mt-1">
              {menu.map((m) => (
                <RnMenuItem
                  key={m.key}
                  onSelect={() => {
                    setOpen(false);
                    m.onSelect();
                  }}
                >
                  {m.label}
                </RnMenuItem>
              ))}
            </RnMenu>
          ) : null}
        </>
      ) : null}
    </span>
  );
}
