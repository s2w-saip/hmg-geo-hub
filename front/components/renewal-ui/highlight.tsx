"use client";

import { createContext, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";

// Linked highlight: the brand under the pointer lights up in every chart and list of the
// page. A small store (not React state at the page root) so only the marks that read it
// re-render. Hover changes wait a moment so sweeping across rows does not flicker; a
// `flash` (e.g. after jumping from a finding) holds the key and ignores the pointer.

type Listener = () => void;
interface HighlightStore {
  get: () => string | null;
  subscribe: (l: Listener) => () => void;
  /** Pointer enter/leave of a mark carrying `key` (null = left every mark). */
  hover: (key: string | null) => void;
  /** Light `key` for `ms`, ignoring the pointer meanwhile. */
  flash: (key: string, ms?: number) => void;
}

function createStore(): HighlightStore {
  let key: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let holdUntil = 0;
  const listeners = new Set<Listener>();
  const set = (k: string | null) => {
    if (k === key) return;
    key = k;
    listeners.forEach((l) => l());
  };
  return {
    get: () => key,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    hover: (k) => {
      if (Date.now() < holdUntil) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => set(k), k ? 90 : 140);
    },
    flash: (k, ms = 2200) => {
      if (timer) clearTimeout(timer);
      holdUntil = Date.now() + ms;
      set(k);
      timer = setTimeout(() => {
        holdUntil = 0;
        set(null);
      }, ms);
    },
  };
}

const Ctx = createContext<HighlightStore | null>(null);

export function RnHighlightProvider({ children }: { children: ReactNode }) {
  const ref = useRef<HighlightStore | null>(null);
  ref.current ??= createStore();
  return <Ctx.Provider value={ref.current}>{children}</Ctx.Provider>;
}

const NOOP: HighlightStore = { get: () => null, subscribe: () => () => {}, hover: () => {}, flash: () => {} };

/** The lit key (re-renders the caller when it changes). */
export function useRnHighlightKey(): string | null {
  const s = useContext(Ctx) ?? NOOP;
  return useSyncExternalStore(s.subscribe, s.get, () => null);
}

/** hover / flash actions (stable; does not re-render on changes). */
export function useRnHighlight(): Pick<HighlightStore, "hover" | "flash"> {
  const s = useContext(Ctx) ?? NOOP;
  return useMemo(() => ({ hover: s.hover, flash: s.flash }), [s]);
}

/**
 * State of one mark inside a group (a chart, a legend, a list): `on` when it carries a
 * lit key, `dim` when the group holds a lit key but this mark does not, else `none`.
 * `lit` is the set the page derives from the lit key (e.g. 당사 → 당사 합계 + every own brand).
 */
export function rnHighlightState(lit: ReadonlyArray<string>, markKeys: ReadonlyArray<string>, groupKeys: ReadonlyArray<string>): "on" | "dim" | "none" {
  if (!lit.length) return "none";
  if (markKeys.some((k) => lit.includes(k))) return "on";
  return groupKeys.some((k) => lit.includes(k)) ? "dim" : "none";
}
