"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { ALL_GROUPS, type DimensionGroup } from "./dimension-filter-panel";

// Demo wiring (2026-06-08): the sample dashboards carry no per-dimension
// columns, so the dimension filters can't truly slice the fixtures. Instead we
// derive a DETERMINISTIC signal from the active filter combination and use it
// to perturb the displayed numbers — selecting a filter visibly changes the
// charts/tables, and clearing it restores the exact baseline. Same filter set
// → same result (stable across re-renders). Swap for real scope query params
// when the measurement backend lands.

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export type FilterSignal = {
  active: { key: string; value: string }[];
  isActive: boolean;
  /** Scale a float by a deterministic per-(filterSet, salt) factor (~0.5–1.0). */
  scale: (n: number, salt?: string) => number;
  /** scale(), rounded to an integer. */
  scaleInt: (n: number, salt?: string) => number;
  /** Shift a 0–100 percentage by a deterministic delta (±10), clamped 0.5–99.5. */
  shiftPct: (p: number, salt?: string) => number;
};

export function useFilterSignal(): FilterSignal {
  const sp = useSearchParams();
  return useMemo(() => {
    const active = ALL_GROUPS.map((g) => ({ key: g, value: sp.get(g) })).filter(
      (a): a is { key: DimensionGroup; value: string } =>
        !!a.value && a.value !== "all",
    );
    const isActive = active.length > 0;
    const fk = active.map((a) => `${a.key}:${a.value}`).join("|");

    const scale = (n: number, salt = "") => {
      if (!isActive) return n;
      const h = hashStr(`${fk}#${salt}`);
      return n * (0.5 + (h % 50) / 100); // ×0.50 .. ×0.99
    };
    const scaleInt = (n: number, salt = "") => Math.round(scale(n, salt));
    const shiftPct = (p: number, salt = "") => {
      if (!isActive) return p;
      const h = hashStr(`${fk}%${salt}`);
      return Math.max(0.5, Math.min(99.5, p + ((h % 21) - 10)));
    };

    return { active, isActive, scale, scaleInt, shiftPct };
  }, [sp]);
}
