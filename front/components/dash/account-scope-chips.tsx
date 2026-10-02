"use client";

import { useTranslations, useLocale } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { rhqLabel } from "@/lib/rhq";
import { geoCodeLabel } from "@/lib/geo-catalog/geo-code-label";
import type { AllowedScope } from "@/lib/auth/types";

// Inline chips showing the authorization scope granted to the logged-in
// account — Brand · 권역(Region) · 국가(Country). Surfaced inside the filter
// bar (DimensionFilterPanel `leading`) so the user always sees the data
// boundary alongside the dimensions they can narrow. Server-side enforcement
// is separate; these chips are informational only.
//
// 2026-06-10: lock icon dropped — "lock" implied a UI affordance that doesn't
// exist (chips can't be toggled). Country codes resolve to full names via
// geo-code-label (가상코드 i18n → 의사코드 → Intl, 비표준은 원문) — 필터 패널과 동일 규칙.
//
// 2026-06-18: list overflow handled. kia-hq scope reaches 80 countries, so
// joining them all into one chip blew out the filter bar. Above CHIP_INLINE_MAX
// items we summarize to a count ("80국") instead of listing every value.
// Below the threshold the original comma-joined list stays, keeping
// small-scope users seeing exactly what they have.
const CHIP_INLINE_MAX = 5;

export function AccountScopeChips({
  scope,
  className,
}: {
  scope: AllowedScope;
  className?: string;
}) {
  const t = useTranslations("dashboard.filters.scope");
  const tFilters = useTranslations("dashboard.filters");
  const locale = useLocale();

  const formatCountries = (codes?: string[]): string => {
    if (scope.all || !codes?.length) return t("all");
    if (codes.length > CHIP_INLINE_MAX) {
      return t("countSummary.country", { count: codes.length });
    }
    // 계정 원본 countries 에는 가상코드(CPO·CN-BJ·MIDDLEEAST·worldwide …)가 섞인다 —
    // Intl 에 그대로 넘기면 RangeError 로 페이지가 죽는다(2026-09-29 hyundai-cpo 실측).
    // 필터 패널과 같은 라벨 규칙(geo-code-label)으로 푼다.
    return codes
      .map((c) => geoCodeLabel(c, locale, (v) => tFilters(`value.${v}` as "value.worldwide")))
      .join(", ");
  };
  const formatRegions = (vals?: string[]): string => {
    if (scope.all || !vals?.length) return t("all");
    if (vals.length > CHIP_INLINE_MAX) {
      return t("countSummary.region", { count: vals.length });
    }
    // region 값 = RHQ 권역 id → 표시 라벨(rhqLabel)로 변환. 미매칭 시 raw fallback.
    return vals.map((r) => rhqLabel(r, locale === "en" ? "en" : "ko") ?? r).join(", ");
  };
  const formatBrands = (vals?: string[]): string => {
    if (scope.all || !vals?.length) return t("all");
    if (vals.length > CHIP_INLINE_MAX) {
      return t("countSummary.brand", { count: vals.length });
    }
    return vals.join(", ");
  };

  const items: { key: "brand" | "region" | "country"; value: string }[] = [
    { key: "brand", value: formatBrands(scope.brands) },
    { key: "region", value: formatRegions(scope.regions) },
    { key: "country", value: formatCountries(scope.countries) },
  ];

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {t("label")}
      </span>
      {items.map((it) => (
        <Badge
          key={it.key}
          variant="outline"
          className="inline-flex items-center gap-1 border-border bg-card text-foreground"
        >
          <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t(it.key)}
          </span>
          <span className="text-xs font-medium">{it.value}</span>
        </Badge>
      ))}
    </div>
  );
}
