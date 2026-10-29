"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useFilterTransition } from "@/components/dash/filter-transition";
import { CONVERSION_PERIODS, DEFAULT_CONVERSION_DAYS } from "@/lib/ga4/conversion-window";
import { cn } from "@/lib/utils";

// Measurement-window selector for the conversion / visits view. Writes
// ?period=<days> to the URL → the server page re-fetches GA4 for that window.
// This is the GA4 measurement window (7/28/90d), distinct from the dimension
// filters (which slice the cohort) and from the year-bucket `time` axis.

export function ConversionPeriodSelect({ current }: { current: number }) {
  const t = useTranslations("aiFunnelView.conversion.period");
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const shared = useFilterTransition();
  const [localPending, localStart] = useTransition();
  const isPending = shared?.isPending ?? localPending;
  const startTransition = shared?.startTransition ?? localStart;

  function select(days: number) {
    if (days === current) return;
    const params = new URLSearchParams(sp.toString());
    if (days === DEFAULT_CONVERSION_DAYS) params.delete("period");
    else params.set("period", String(days));
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {t("label")}
        {isPending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null}
      </span>
      <div className="inline-flex rounded-md border border-input p-0.5">
        {CONVERSION_PERIODS.map((d) => {
          const active = d === current;
          return (
            <button
              key={d}
              type="button"
              onClick={() => select(d)}
              aria-pressed={active}
              className={cn(
                "rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
                active
                  ? "bg-brand-700 text-white"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("days", { days: d })}
            </button>
          );
        })}
      </div>
    </div>
  );
}
