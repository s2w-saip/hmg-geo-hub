"use client";

// 측정 기간 — the filter panel's basis row of the renewal pages that read the HUB analytics store (AI Visibility,
// AI Conversion): days, not rounds. A preset (7 · 28 · 90 days) or a custom from / to, written to the URL as the
// reader takes them (days · from · to; back/bff/screens/_days.py). Changes compare with the previous period of
// the same length.

import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { RnSegmented } from "@/components/renewal-ui";
import { useRnFilterRuntime } from "./filter-runtime";

const PRESETS = [7, 28, 90] as const;

/** The period the URL asks for: a preset (7 · 28 · 90 days) or a custom from / to. */
export interface RnDaysChoice {
  preset: number | null;
  days: number | null;
  from: string | null;
  to: string | null;
}

/** The period the reader answered for (it ends at the last measured day). */
export interface RnDaysPeriodRead {
  from: string | null;
  to: string | null;
  days: number | null;
}

export function RnDaysPeriod({ choice, period }: { choice: RnDaysChoice; period: RnDaysPeriodRead }) {
  const t = useTranslations("renewal.daysPeriod");
  const sp = useSearchParams();
  const { commit } = useRnFilterRuntime();
  const custom = choice.preset == null;
  const go = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(sp.toString());
    for (const k of ["days", "from", "to"]) q.delete(k);
    for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
    commit(q.toString(), { immediate: true });
  };
  const pick = (v: string) => {
    if (v === "custom") go({ from: period.from, to: period.to });
    else go({ days: v === "28" ? null : v });
  };
  return (
    <section aria-label={t("label")} className="flex flex-col gap-2 border-b border-rn-line px-4.5 pt-3 pb-3.5">
      <div className="flex items-center gap-1.5 text-rn-13 font-bold text-rn-ink">
        <CalendarDays className="size-3.5 text-rn-muted" aria-hidden />
        {t("label")}
        {custom && choice.days == null && period.days ? <span className="ml-auto text-rn-12 font-semibold text-rn-muted">{t("days", { n: period.days })}</span> : null}
      </div>
      <RnSegmented
        label={t("label")}
        className="flex [&>button]:flex-1"
        value={custom ? "custom" : String(choice.preset)}
        onChange={pick}
        items={[...PRESETS.map((d) => ({ value: String(d), label: t("days", { n: d }) })), { value: "custom", label: t("custom") }]}
      />
      {custom ? (
        <div className="grid grid-cols-2 gap-2">
          {(["from", "to"] as const).map((k) => (
            <label key={k} className="flex flex-col gap-1 text-rn-11 font-semibold text-rn-muted">
              {t(k)}
              <input
                type="date"
                defaultValue={(k === "from" ? choice.from ?? period.from : choice.to ?? period.to) ?? ""}
                onChange={(e) => {
                  if (!e.target.value) return;
                  go({ from: k === "from" ? e.target.value : choice.from ?? period.from, to: k === "to" ? e.target.value : choice.to ?? period.to });
                }}
                className="h-8 min-w-0 rounded-lg border border-rn-line-2 bg-rn-surface px-2 text-rn-12 text-rn-ink focus:border-rn-navy focus:outline-none"
              />
            </label>
          ))}
        </div>
      ) : null}
      <p className="m-0 text-rn-11 break-keep text-rn-muted">{period.to ? t("help", { to: period.to }) : t("helpNoData")}</p>
    </section>
  );
}
