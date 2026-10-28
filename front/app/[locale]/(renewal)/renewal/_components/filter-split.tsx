"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { cx } from "@/components/renewal-ui";

// ─── layout: panel | content, collapsible ([ key) ──────────────────────────

const SplitContext = createContext<{ collapse: () => void; expand: () => void }>({ collapse: () => {}, expand: () => {} });

/** collapse / expand of the enclosing RnFilterSplit (panel and rail buttons). */
export function useRnSplit() {
  return useContext(SplitContext);
}

// ─── viewport frame ──────────────────────────────────────────────────────────
// The window never scrolls on a renewal page (2026-10-23): only the content area scrolls, and the
// filter panel scrolls apart from it. The frame takes the viewport next to the
// renewal shell's sidebar (app/renewal-theme.css, [data-rn-frame]); the page header stays put and
// the content area scrolls on its own, out to the right edge of the window. --rn-edge is the S급
// gutter around a 1480px column; top 24px / bottom 72px (20 / 64 up to 1279px), the
// '스크롤 영역' values of docs/design/ui/design-rules.html. Both reserve the scrollbar gutter so the header lines up with the content.

const FRAME = "@container/rnframe flex flex-col pt-6 max-xl:pt-5";
const FRAME_HEAD = "min-w-0 shrink-0 overflow-hidden px-[var(--rn-edge)] pb-3 [scrollbar-gutter:stable]";
const FRAME_SCROLL = "min-h-0 min-w-0 overflow-y-auto overscroll-contain pt-1 pr-[var(--rn-edge)] pb-18 max-xl:pb-16 [scrollbar-gutter:stable]";

/** Page layout without a filter panel: the page header on top, the content scrolling below it. */
export function RnPageFrame({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div data-rn-frame="" className={FRAME}>
      <div className={FRAME_HEAD}>{header}</div>
      <div data-rn-scroll="" className={cx(FRAME_SCROLL, "flex-1 pl-[var(--rn-edge)]")}>
        <div className="flex min-w-0 flex-col gap-5">{children}</div>
      </div>
    </div>
  );
}

/**
 * Page layout: the page header across the full width on top (2026-10-21), then the filter panel |
 * content row below it.
 * The panel and the content scroll apart (the panel card scrolls inside its own height), so
 * scrolling the content never moves the filters.
 * `top` (2026-10-27) heads the content column, right of the panel, and stays put above the
 * scrolling content: a page switch there (Mention's KPI tabs) reads as one more view under the
 * same filters, the panel standing beside every view.
 */
export function RnFilterSplit({ header, top, panel, rail, children }: { header?: ReactNode; top?: ReactNode; panel: ReactNode; rail: ReactNode; children: ReactNode }) {
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
  // pl-5 = the panel | content gap, inside the scroller so card shadows are not clipped
  const scroll = (
    <div data-rn-scroll="" className={cx(FRAME_SCROLL, "pl-5", top ? "flex-1" : "")}>
      <div className="@container/rncontent flex min-w-0 flex-col gap-4">{children}</div>
    </div>
  );
  return (
    <SplitContext.Provider value={split}>
      <div data-rn-frame="" className={FRAME}>
        {header ? <div className={FRAME_HEAD}>{header}</div> : null}
        <div
          data-rn-split={auto ? "auto" : open ? "open" : "closed"}
          className={cx(
            "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] pl-[var(--rn-edge)]",
            auto ? "grid-cols-[52px_minmax(0,1fr)] min-[1360px]:grid-cols-[296px_minmax(0,1fr)]" : open ? "grid-cols-[296px_minmax(0,1fr)]" : "grid-cols-[52px_minmax(0,1fr)]",
          )}
        >
          {/* the panel card is max-h-full: it scrolls inside the column, apart from the content */}
          <div className={cx("min-h-0 pt-1 pb-4", auto ? "hidden min-[1360px]:block" : open ? "block" : "hidden")}>{panel}</div>
          <div className={cx("pt-1", auto ? "min-[1360px]:hidden" : open ? "hidden" : "block")}>{rail}</div>
          {top ? (
            <div className="flex min-h-0 min-w-0 flex-col">
              {/* top edge = the panel card's (pt-1); the scrollbar gutter lines its right end up with the content */}
              <div data-rn-split-top="" className="min-w-0 shrink-0 overflow-hidden pt-1 pr-[var(--rn-edge)] pb-3 pl-5 [scrollbar-gutter:stable]">
                {top}
              </div>
              {scroll}
            </div>
          ) : (
            scroll
          )}
        </div>
      </div>
    </SplitContext.Provider>
  );
}

