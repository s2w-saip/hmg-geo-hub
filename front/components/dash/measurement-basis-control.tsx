"use client";

import { useTranslations } from "next-intl";
import { CalendarRange } from "lucide-react";
import { DEFAULT_BUCKET } from "@/components/dash/measurement-basis";

// 측정 기준 표기 — 2026-06-22 일별 옵션 폐기 후 단일 주별로 고정. 토글
// UI 대신 현재 단위만 노출. 보간 없음(빈 버킷은 선 끊김)은 고정 정책.
//
// 일별 복귀가 필요해질 경우 measurement-basis.ts 의 BUCKET_UNITS 에 다시
// 'day' 를 추가하고 이 컴포넌트에 토글을 되살리면 된다.
//
// 측정 기준일(마지막 측정일) 배지는 DimensionFilterPanel의 asOf 슬롯(필터 최상단)
// 으로 이동 — 여기서는 basis(주/일) 표기만 담당.
export function MeasurementBasisControl() {
  const t = useTranslations("dashboard.basis");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        <CalendarRange className="h-3.5 w-3.5" aria-hidden />
        {t("label")}
      </span>
      <span className="text-xs font-medium text-foreground">
        {t(`unit.${DEFAULT_BUCKET}`)}
      </span>
      {/* 고정 정책 표기 — 측정일 기준 집계 · 보간 없음 */}
      <span className="text-[11px] text-muted-foreground">{t("note")}</span>
    </div>
  );
}
