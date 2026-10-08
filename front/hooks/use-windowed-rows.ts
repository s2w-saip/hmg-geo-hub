"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { RowHeights } from "@/lib/windowed-rows";

/** Keep the existing document scroll and row markup, with at most 200 mounted rows. */
export function useWindowedRows<E extends HTMLElement = HTMLTableSectionElement>(total: number, resetKey: string, estimate = 72, enabled = true) {
  const containerRef = useRef<E>(null);
  // Measurements belong to the filter/sort order; invalidate them when that order changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const heights = useMemo(() => new RowHeights(enabled ? total : 0, estimate), [total, estimate, enabled, resetKey]);
  const [start, setStart] = useState(0);
  const [, redraw] = useState(0);
  useEffect(() => { setStart(0); }, [heights]);
  useEffect(() => {
    if (!enabled || !containerRef.current) return;
    const container = containerRef.current;
    let frame = 0;
    const update = () => {
      frame = 0;
      let changed = false;
      for (const row of container.querySelectorAll<HTMLElement>("[data-window-row]")) {
        changed = heights.measure(Number(row.dataset.windowRow), row.getBoundingClientRect().height) || changed;
      }
      if (changed) redraw(n => n + 1);
      const rect = container.getBoundingClientRect();
      let top = 0, bottom = window.innerHeight;
      for (let parent = container.parentElement; parent; parent = parent.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) {
          const box = parent.getBoundingClientRect();
          top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
        }
      }
      if (rect.top >= bottom) return;
      const index = heights.indexAt(Math.max(0, top - rect.top));
      const next = Math.max(0, Math.floor(index / 50) * 50 - 50);
      setStart(prev => prev === next ? prev : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); };
  }, [enabled, heights]);
  return { containerRef, start, limit: 200, top: (offset: number) => heights.offset(offset),
    bottom: (offset: number, count: number) => Math.max(0, heights.offset(total) - heights.offset(offset + count)) };
}
