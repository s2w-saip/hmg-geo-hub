"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { CircleAlert, Settings } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";

// Country-leaf scope이지만 lib/ga4/property-map의 MAP에 해당 (brand, country)
// 항목이 없거나 env가 없을 때 표시. 직전엔 sample fixture가 노출돼서 마치
// 측정된 시장처럼 보이던 false signal을 막는다. 사용자에게 "이 시장은 아직
// GA4 연동 안 됨, 운영팀에 요청 필요" 라는 명시적 안내.

export function ConversionUnmappedNotice({
  brand,
  country,
  settingsHref,
}: {
  brand: string;
  country: string; // ISO alpha-2
  // 프로젝트 뷰에서만 전달 — "설정에서 GA4 연동" 바로가기(프로젝트 GA4 속성ID를
  // 그 자리에서 넣게). 표준 뷰는 시장별 설정 화면이 없어 미전달 → 링크 없음.
  settingsHref?: string;
}) {
  const t = useTranslations("aiFunnelView.conversion.unmapped");
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
        <CircleAlert className="h-6 w-6 text-muted-foreground" aria-hidden />
        <h3 className="text-base font-semibold text-foreground">
          {t("title", { brand, country: countryName })}
        </h3>
        <p className="max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
          {t("description")}
        </p>
        {settingsHref ? (
          <Button asChild size="sm" variant="outline" className="mt-1">
            <Link href={settingsHref}>
              <Settings className="h-4 w-4" aria-hidden />
              {t("settingsCta")}
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
