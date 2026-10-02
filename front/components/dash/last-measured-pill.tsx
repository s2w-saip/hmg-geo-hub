// 페이지 헤더 우측의 "측정 기준일" pill — 대시보드 Overview(dashboard/page.tsx:96-102)
// 와 **같은 마크업·같은 문구**다. 2차 QA #3(제품 결정: 헤더 pill)로 언급·인용 화면이
// 같은 자리에 같은 것을 쓰게 되면서 한 곳으로 뽑았다.
//
// 날짜는 본문과 같은 집계의 asOf(요청단위 dedup)라 느리다 — pill 자체는 즉시 그리고
// 날짜 칸만 중첩 <Suspense> 로 흘려보낸다(헤더가 집계를 기다리지 않는다).

import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { SectionDoneMarker } from "@/components/perf/section-marker";
import { formatAsOfDate } from "@/lib/as-of-date";

export async function LastMeasuredPill({ asOf }: { asOf: Promise<string | null> }) {
  const t = await getTranslations("dashboard.overview");
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
      <span>{t("cadence")}</span>
      <span aria-hidden className="h-3 w-px bg-border" />
      <Suspense fallback={<span className="inline-block h-3 w-24 animate-pulse rounded bg-muted" />}>
        <LastMeasured asOf={asOf} />
      </Suspense>
    </div>
  );
}

/** 폴백 — 헤더 슬롯 자체가 서스펜드할 때 pill 크기만 잡는 **동기** 자리표시자. */
export function LastMeasuredPillSkeleton() {
  return (
    <div
      aria-busy="true"
      className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5"
    >
      <span className="inline-block h-3 w-16 animate-pulse rounded bg-muted" />
      <span aria-hidden className="h-3 w-px bg-border" />
      <span className="inline-block h-3 w-24 animate-pulse rounded bg-muted" />
    </div>
  );
}

// 프로미스를 여기서만 await 한다 — 이 컴포넌트만 서스펜드한다.
async function LastMeasured({ asOf }: { asOf: Promise<string | null> }) {
  const t = await getTranslations("dashboard.overview");
  const date = await asOf;
  // T18: 마커는 **await 뒤 반환 JSX 안**에 있어야 한다. 형제로 두면 React 19 가
  // 이 컴포넌트 자리에 `<template id="P:n">` 을 놓고 경계를 먼저 flush 하면서
  // 마커까지 셸과 함께 내보낸다(2026-09-10 T12 포렌식: 49배 과소 계측).
  // id 가 페이지별로 갈리지 않는 이유: 한 응답에 이 pill 은 하나뿐이다.
  return (
    <>
      <span className="tabular-nums">{date ? t("lastMeasured", { date: formatAsOfDate(date) }) : "—"}</span>
      <SectionDoneMarker id="last-measured-pill" />
    </>
  );
}
