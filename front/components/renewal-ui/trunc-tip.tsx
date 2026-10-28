"use client";

import { useCallback, useEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode } from "react";

const DELAY_MS = 300;
const MAX_W = 480;
const GAP = 6;

type Tip = { text: string; left: number; top: number; above: boolean };

/** Handlers to spread on the container of the tipped cells. */
export interface RnTruncTipBind {
  onPointerOver: (e: PointerEvent) => void;
  onPointerOut: (e: PointerEvent) => void;
  onFocus: (e: FocusEvent) => void;
  onBlur: () => void;
}

/**
 * One shared tooltip for the one-line cells under a container (spread `bind` on it, render `tip`).
 * Hovering or focusing an element marked `data-rn-tip` shows, after a short delay, its full text when
 * the text is cut off (…), or the attribute's value when it has one (shown whether cut off or not:
 * the market list behind "+3", a label's long form). Fixed to the viewport, so a scrolling area or
 * a card edge never clips it.
 */
export function useRnTruncTip(): { bind: RnTruncTipBind; tip: ReactNode } {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = useRef<Element | null>(null);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    current.current = null;
    setTip(null);
  }, []);

  const show = useCallback((el: HTMLElement, delay: number) => {
    const own = el.dataset.rnTip;
    const text = own || (el.scrollWidth > el.clientWidth ? (el.textContent ?? "").trim() : "");
    if (!text) return;
    if (timer.current) clearTimeout(timer.current);
    current.current = el;
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      const above = r.bottom + 160 > window.innerHeight;
      setTip({ text, left: Math.max(8, Math.min(r.left, window.innerWidth - MAX_W - 8)), top: above ? r.top - GAP : r.bottom + GAP, above });
    }, delay);
  }, []);

  // any scroll moves the cell away from the tip
  useEffect(() => {
    if (!tip) return;
    window.addEventListener("scroll", hide, true);
    return () => window.removeEventListener("scroll", hide, true);
  }, [tip, hide]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const target = (e: { target: EventTarget }) => (e.target instanceof Element ? e.target.closest<HTMLElement>("[data-rn-tip]") : null);
  const bind: RnTruncTipBind = {
    onPointerOver: (e) => {
      const el = target(e);
      if (el && el !== current.current) show(el, DELAY_MS);
    },
    onPointerOut: (e) => {
      const el = current.current;
      if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) hide();
    },
    onFocus: (e) => {
      const el = target(e);
      if (el) show(el, 0);
    },
    onBlur: hide,
  };

  return {
    bind,
    tip: tip ? (
      <div
        role="tooltip"
        className="pointer-events-none fixed z-[120] w-max rounded-[10px] bg-rn-ink px-3 py-2 text-rn-12 leading-relaxed break-words whitespace-pre-line text-white shadow-rn-3"
        style={{ left: tip.left, top: tip.top, maxWidth: MAX_W, transform: tip.above ? "translateY(-100%)" : undefined }}
      >
        {tip.text}
      </div>
    ) : null,
  };
}
