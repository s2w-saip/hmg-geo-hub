"use client";

import { Suspense, use } from "react";
import { SummaryTiles } from "./summary-tiles";
import type { KpiSummary } from "../_data/sample";
import type { CompareResult } from "@/lib/kpi/period-compare";
import type { PeriodLabelCtx } from "@/lib/kpi/period-compare-view";

/**
 * KPI key → **늦게 도착하는 타일 필드**. 이름은 Δ 에서 왔지만 담는 것은 Δ 만이 아니다.
 *
 * 2026-09-10(PR③-a): `/website` 은 엔진 일관성 배지(`engineConsistency`)도 여기 싣는다.
 * 그 값의 원천인 Sub-KPI 가 `read_screens` 에 없는 화면 키를 쓰는 동안 **미러** 경로라
 * (프로덕션 진짜 콜드 11.5~13.5 s), 타일 값(집계층 0.1~0.3 s)이 그것에 묶여 있었다.
 * 키는 B6 에서 `S5.mention` → `S4.subkpi` 로 갈랐지만 **그 키도 off 로 머지**했으므로
 * 배지는 아직 미러다 — 이 경계는 그 상태에서도 타일을 지킨다.
 * 병합은 `{...k, ...map[k.key]}` 라 어느 필드든 그대로 덮어쓴다.
 */
export type DeferredDeltaMap = Record<
  string,
  Pick<KpiSummary, "delta" | "direction"> & Partial<Pick<KpiSummary, "engineConsistency">>
>;

/**
 * 카드는 즉시 그리고, 변화량(Δ) 칩만 추이가 도착한 뒤 채운다.
 *
 * 왜: /website 카드는 summary table(사실표, 0.1~0.3s)에서 오는데 Δ 는 아직 미러 추이
 * (admin 무필터 ~25s)에서 파생된다. 둘을 한 await 에 묶으면 카드가 추이 속도에 묶인다
 * (2026-09-06 실측). 그래서 서버 섹션은 Δ 맵을 **프로미스**로 넘기고, 여기서 `use()` 로
 * 풀되 그 경계의 폴백을 "Δ 없는 같은 타일" 로 둔다 — 사용자는 값이 먼저, 화살표가 나중.
 *
 * 폴백과 본체가 같은 SummaryTiles 라 레이아웃 점프가 없다(칩 자리만 채워진다).
 */
export function SummaryTilesDeferredDeltas({
  items,
  deltas,
  periodCompare,
  periodDays,
  periodLabelCtx,
}: {
  items: KpiSummary[];
  deltas: Promise<DeferredDeltaMap>;
  /** 기간 비교 Δ (GGMD-107 지면 #4). 폴백 타일도 **같은 값**을 받아야 칩이 깜빡이지 않는다. */
  periodCompare?: readonly CompareResult[] | null;
  periodDays?: number;
  periodLabelCtx?: PeriodLabelCtx;
}) {
  return (
    <Suspense
      fallback={
        <SummaryTiles
          items={items}
          perturb={false}
          periodCompare={periodCompare}
          periodDays={periodDays}
          periodLabelCtx={periodLabelCtx}
        />
      }
    >
      <TilesWithDeltas
        items={items}
        deltas={deltas}
        periodCompare={periodCompare}
        periodDays={periodDays}
        periodLabelCtx={periodLabelCtx}
      />
    </Suspense>
  );
}

function TilesWithDeltas({
  items,
  deltas,
  periodCompare,
  periodDays,
  periodLabelCtx,
}: {
  items: KpiSummary[];
  deltas: Promise<DeferredDeltaMap>;
  periodCompare?: readonly CompareResult[] | null;
  periodDays?: number;
  periodLabelCtx?: PeriodLabelCtx;
}) {
  const map = use(deltas);
  const merged = items.map((k) => (map[k.key] ? { ...k, ...map[k.key] } : k));
  return (
    <SummaryTiles
      items={merged}
      perturb={false}
      periodCompare={periodCompare}
      periodDays={periodDays}
      periodLabelCtx={periodLabelCtx}
    />
  );
}
