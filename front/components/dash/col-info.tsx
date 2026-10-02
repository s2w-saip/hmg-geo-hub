"use client";

import { useTranslations } from "next-intl";
import { Info } from "lucide-react";
import {
  Tooltip as InfoTooltip,
  TooltipContent as InfoTooltipContent,
  TooltipTrigger as InfoTooltipTrigger,
} from "@/components/ui/tooltip";

// 컬럼/지표 정의 hover 아이콘 — 대시보드 KPI 카드(summary-tiles.tsx)와 동일한
// 패턴. 정렬 헤더(SortableHeader/Th) 옆에 놓아 클릭(정렬)과 hover(정의)가
// 겹치지 않게 별도 요소로 둔다. 호출부는 TooltipProvider로 감싸야 한다.
export function ColInfo({
  title,
  definition,
  formula,
}: {
  title: string;
  definition: string;
  formula?: string;
}) {
  const t = useTranslations("dashboard.kpi");
  return (
    <InfoTooltip>
      <InfoTooltipTrigger asChild>
        <button
          type="button"
          aria-label={t("infoAriaLabel")}
          className="shrink-0 rounded-sm text-muted-foreground normal-case hover:text-foreground"
        >
          <Info className="h-3.5 w-3.5" aria-hidden />
        </button>
      </InfoTooltipTrigger>
      <InfoTooltipContent className="max-w-72 space-y-3 p-3.5 text-left text-pretty normal-case">
        <p className="text-xs font-semibold text-background">{title}</p>
        <div className="space-y-1">
          <p className="text-[10px] font-semibold tracking-wide text-background/55 uppercase">
            {t("definitionLabel")}
          </p>
          <p className="text-[11px] leading-relaxed text-background/90">{definition}</p>
        </div>
        {formula ? (
          <div className="space-y-1">
            <p className="text-[10px] font-semibold tracking-wide text-background/55 uppercase">
              {t("formulaLabel")}
            </p>
            <p className="text-[11px] leading-relaxed text-background/90">{formula}</p>
          </div>
        ) : null}
      </InfoTooltipContent>
    </InfoTooltip>
  );
}
