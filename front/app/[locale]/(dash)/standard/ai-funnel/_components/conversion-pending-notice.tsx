"use client";

import { useLocale, useTranslations } from "next-intl";
import { countryName } from "@/lib/geo-catalog/country-name";
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
  // 입력은 GA4 매핑 카탈로그의 국가 — 관리자 자유 입력이라 ISO 보장이 없다.
  // 정본 헬퍼(의사 코드 라벨 → Intl, 비표준은 원문, throw 없음)로 푼다.
  const countryLabel = countryName(country, locale);

  return (
    <div className="rounded-lg border border-dashed border-border bg-card px-6 py-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <Clock className="h-6 w-6 text-muted-foreground" aria-hidden />
        <h3 className="text-base font-semibold text-foreground">
          {t("title", { brand, country: countryLabel })}
        </h3>
        <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
          {hasFilters ? t("descriptionFiltered") : t("description")}
        </p>
      </div>
    </div>
  );
}
