"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { cx } from "@/components/renewal-ui";

// ─── layout: panel | content, collapsible ([ key) ──────────────────────────

const SplitContext = createContext<{ collapse: () => void; expand: () => void }>({ collapse: () => {}, expand: () => {} });

/** collapse / expand of the enclosing RnFilterSplit (panel and rail buttons). */
export function useRnSplit() {
  return useContext(SplitContext);
}

/**
 * Page layout: the page header across the full width on top (2026-10-21, user: "페이지 제목이
 * 상단을 차지하고 필터는 본 내용과 같이 하단에"), then the filter panel | content row below it.
 */
export function RnFilterSplit({ header, panel, rail, children }: { header?: ReactNode; panel: ReactNode; rail: ReactNode; children: ReactNode }) {
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
      <div className="flex flex-col gap-5">
        {header ? <div className="min-w-0">{header}</div> : null}
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
      </div>
    </SplitContext.Provider>
  );
}

