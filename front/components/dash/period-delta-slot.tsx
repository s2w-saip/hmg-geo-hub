"use client";

// GGMD-107 — 지면이 Δ 를 그리는 **유일한 분기 지점**.
//
// 요구: "화면 키 off / `fetchPeriodCompare` 가 null 이면 종전 Δ 경로 그대로 —
// 지면마다 if 를 퍼뜨리지 마라"(스펙「새 산식은 적용일 이후 구간에만 적용한다」의
// '분기가 1곳이다' 와 같은 규율). 그래서 지면은 자기 기존 칩 JSX 를 `fallback` 으로
// 넘기고, 켜짐/꺼짐 판정은 여기 한 곳에서만 한다.
//
// ⚠️ off(=`compare` 가 null·undefined·해당 지표 없음)일 때 이 컴포넌트는 `fallback`
//    **그대로**를 돌려준다. 래퍼 엘리먼트를 씌우면 안 된다 — off 렌더 바이트 동일
//    (`period-delta-off-parity.render.test.tsx`)이 깨진다.

import type { ReactNode } from "react";
import {
  periodCaption,
  periodChip,
  type PeriodChip,
} from "@/lib/kpi/period-compare-view";
import type {
  CompareKind,
  CompareMetricKey,
  CompareResult,
} from "@/lib/kpi/period-compare";
import {
  PeriodDeltaCaption,
  PeriodDeltaChip,
  type DeltaChipGlyph,
  type DeltaChipSize,
} from "./delta-chip";

/**
 * 그 지면이 그릴 지표의 결과를 고른다. 순수 — 테스트 대상.
 * `null` = 기간 비교를 그리지 않는다(= 종전 Δ 경로).
 */
export function selectPeriodResult(
  compare: readonly CompareResult[] | null | undefined,
  metric: CompareMetricKey | null | undefined,
): CompareResult | null {
  if (!compare || !metric) return null;
  return compare.find((r) => r.metric === metric) ?? null;
}

export function PeriodDeltaSlot({
  compare,
  metric,
  days,
  kind = "window",
  fallback = null,
  render,
  withCaption = false,
  size = "sm",
  glyph = "icon",
  className,
}: {
  /** 게이트웨이 결과. `null` = "종전 Δ 를 그려라"(기간 미선택·epoch 이전·스위치 off). */
  compare?: readonly CompareResult[] | null;
  /** 이 지면이 그리는 지표. 계약의 6지표 밖이면 `null` 을 넘긴다(= 종전 Δ). */
  metric?: CompareMetricKey | null;
  /** 창 길이(일). 억제 캡션(`noPrevWindow` 의 {days}·`noPrevYear` 분기)에 쓰인다. */
  days?: number;
  kind?: CompareKind;
  /** 종전 Δ 노드. off 에서는 이것이 **그대로** 렌더된다. */
  fallback?: ReactNode;
  /**
   * on 일 때의 렌더. 지면마다 **레이아웃이 다르므로**(카드는 라벨+값 2줄, 타일은 한 줄,
   * 히어로는 배지 하나) 모양은 지면이 정하고 **판정만 여기서** 한다. 생략하면 칩만 그린다.
   */
  render?: (chip: PeriodChip, result: CompareResult) => ReactNode;
  /** 사유 캡션을 칩 옆에 함께 그릴지(타일처럼 자리가 좁은 지면은 false). */
  withCaption?: boolean;
  size?: DeltaChipSize;
  glyph?: DeltaChipGlyph;
  className?: string;
}) {
  const result = selectPeriodResult(compare, metric);
  if (!result) return <>{fallback}</>;
  const chip = periodChip({ metric: result.metric, delta: result.delta });
  if (render) return <>{render(chip, result)}</>;
  return (
    <>
      <PeriodDeltaChip chip={chip} size={size} glyph={glyph} className={className} />
      {withCaption ? (
        <PeriodDeltaCaption caption={periodCaption(result, { days: days ?? 0, kind })} />
      ) : null}
    </>
  );
}
