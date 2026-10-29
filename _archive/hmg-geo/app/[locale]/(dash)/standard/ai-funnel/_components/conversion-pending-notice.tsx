"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { Clock } from "lucide-react";

// Mapped GA4 property, but getAiConversionLive returned null — i.e. the property
// is wired yet there's no AI-cohort data to show (the "AI Assistant" channel
// only started 2026-06-05 on Kia/IT, so a window can legitimately be empty), or
// the active filter set matches no rows. Distinct from ConversionUnmappedNotice
// (no property at all) and from the demo sample fixture (which we must NOT show
// on a real, mapped market — that would be a false signal). `hasFilters` swaps
// the copy to "no rows for your filter" so the user knows to relax the filters.

export function ConversionPendingNotice({
  brand,
  country,
  hasFilters = false,
}: {
  brand: string;
  country: string; // ISO alpha-2
  hasFilters?: boolean;
}) {
  const t = useTranslations("aiFunnelView.conversion.pending");
  const locale = useLocale();
  const countryName = useMemo(() => {
    try {
      return new Intl.DisplayNames([locale], { type: "region" }).of(country) ?? country;
    } catch {
      return country;
    }
  }, [country, locale]);

  return (
    <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <Clock className="h-6 w-6 text-muted-foreground" aria-hidden />
        <h3 className="text-base font-semibold text-foreground">
          {t("title", { brand, country: countryName })}
        </h3>
        <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
          {hasFilters ? t("descriptionFiltered") : t("description")}
        </p>
      </div>
    </div>
  );
}
