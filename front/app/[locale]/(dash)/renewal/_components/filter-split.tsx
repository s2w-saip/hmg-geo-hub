"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { cx } from "@/components/renewal-ui";

// ─── layout: panel | content, collapsible ([ key) ──────────────────────────

const SplitContext = createContext<{ collapse: () => void; expand: () => void }>({ collapse: () => {}, expand: () => {} });

/** collapse / expand of the enclosing RnFilterSplit (panel and rail buttons). */
export function useRnSplit() {
  return useContext(SplitContext);
}

export function RnFilterSplit({ panel, rail, children }: { panel: ReactNode; rail: ReactNode; children: ReactNode }) {
  // null = automatic (open from 1360px wide, collapsed below) until the viewer toggles.
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpenNow = useCallback(() => (open === null ? window.matchMedia("(min-width: 1360px)").matches : open), [open]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable)) return;
      e.preventDefault();
      setOpen(!isOpenNow());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpenNow]);
  const auto = open === null;
  const split = useMemo(() => ({ collapse: () => setOpen(false), expand: () => setOpen(true) }), []);
  return (
    <SplitContext.Provider value={split}>
    <div
      data-rn-split={auto ? "auto" : open ? "open" : "closed"}
      className={cx(
        "grid items-start gap-5",
        auto ? "grid-cols-[52px_minmax(0,1fr)] min-[1360px]:grid-cols-[296px_minmax(0,1fr)]" : open ? "grid-cols-[296px_minmax(0,1fr)]" : "grid-cols-[52px_minmax(0,1fr)]",
      )}
    >
      <div className={cx(auto ? "hidden min-[1360px]:block" : open ? "block" : "hidden")}>{panel}</div>
      <div className={cx(auto ? "min-[1360px]:hidden" : open ? "hidden" : "block")}>{rail}</div>
      <div className="@container/rncontent flex min-w-0 flex-col gap-4">{children}</div>
    </div>
    </SplitContext.Provider>
  );
}

