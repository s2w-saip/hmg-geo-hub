"use client";

import {
  createContext,
  useContext,
  useTransition,
  type ReactNode,
  type TransitionStartFunction,
} from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared transition for the filter "적용" flow. The DimensionFilterPanel commits
// its URL change through this transition, so both the Apply button (spinner) and
// the content below (dim + "재조회 중" overlay) react to the SAME pending state —
// the user gets immediate feedback that the apply is in flight even though the
// scope re-aggregation itself is slow.
//
// Pair with dropping `key` on the content Suspense so the previous result stays
// on screen (dimmed) during the reload instead of flashing to a skeleton.

type FilterTransition = {
  isPending: boolean;
  startTransition: TransitionStartFunction;
};

const FilterTransitionCtx = createContext<FilterTransition | null>(null);

export function FilterTransitionProvider({ children }: { children: ReactNode }) {
  const [isPending, startTransition] = useTransition();
  return (
    <FilterTransitionCtx.Provider value={{ isPending, startTransition }}>
      {children}
    </FilterTransitionCtx.Provider>
  );
}

// Null when no provider is mounted (e.g. the AI Funnel views render the panel
// standalone) — callers fall back to a local useTransition.
export function useFilterTransition(): FilterTransition | null {
  return useContext(FilterTransitionCtx);
}

// Dims its children + shows a "재조회 중" pill while a filter apply is in flight.
// Wrap the filter-driven content (KPI tiles / tables) below the filter bar.
export function FilterContentDim({ children }: { children: ReactNode }) {
  const ctx = useFilterTransition();
  const pending = ctx?.isPending ?? false;
  const t = useTranslations("dashboard.filters");
  return (
    <div className="relative" aria-busy={pending}>
      <div
        className={cn(
          "transition-opacity duration-200",
          pending && "pointer-events-none select-none opacity-40",
        )}
      >
        {children}
      </div>
      {pending ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center pt-12">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground shadow-soft">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-700" aria-hidden />
            {t("reloading")}
          </span>
        </div>
      ) : null}
    </div>
  );
}
