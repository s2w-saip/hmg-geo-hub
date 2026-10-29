"use client";

import { CalendarClock } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatAsOfDate } from "@/lib/as-of-date";

// 측정 기준일 배지 — 필터바 최상단 단독 행에 선다(DimensionFilterPanel).
//
// 별도 파일인 이유: 답변분석 화면들이 필터바를 무거운 집계 read 밖으로 꺼내
// 먼저 그리면서, 기준일만 그 집계에서 나중에 도착한다. 배지를 서버 컴포넌트가
// <Suspense> 안에서 단독으로 그릴 수 있어야 하고, 그 사이 자리를 지킬 스켈레톤은
// **같은 크기**여야 행 높이가 안 튄다 — 그래서 실물과 스켈레톤을 한 곳에 둔다.
export function AsOfChip({ date }: { date: string }) {
  const tBasis = useTranslations("dashboard.basis");
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
      <CalendarClock className="h-3 w-3" aria-hidden />
      {tBasis("asOf", { date: formatAsOfDate(date) })}
    </span>
  );
}

// AsOfChip 과 동일한 박스(테두리 + px-2.5 py-1 + text-[11px] 한 줄)라 스왑 시
// 행 높이가 바뀌지 않는다. 폭만 대략치(측정 기준일 YYYY-MM-DD).
export function AsOfChipSkeleton() {
  return (
    <span
      className="inline-flex h-[26px] w-40 shrink-0 animate-pulse rounded-full border border-border bg-muted/40"
      aria-hidden
    />
  );
}
