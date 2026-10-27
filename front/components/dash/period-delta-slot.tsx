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
import type { PeriodCaptionMessage, PeriodChip } from "@/lib/kpi/period-compare-view";
import {
  PeriodDeltaCaption,
  PeriodDeltaChip,
  type DeltaChipGlyph,
  type DeltaChipSize,
} from "./delta-chip";

/** One metric's period comparison as the API built it (chip + caption). */
export interface PeriodSlotView {
  chip: PeriodChip;
  caption: PeriodCaptionMessage;
}

/** The screen's `periodSlots`: metric -> slot view; `null` = draw the earlier Δ (no closed period). */
export type PeriodSlots = Readonly<Record<string, PeriodSlotView>>;

export function PeriodDeltaSlot({
  slots,
  metric,
  fallback = null,
  withCaption = false,
  size = "sm",
  glyph = "icon",
  className,
}: {
  /** The screen's period slots. `null` = "draw the earlier Δ" (no period, before the epoch, switch off). */
  slots?: PeriodSlots | null;
  /** The metric this surface draws. Outside the contract's metrics pass `null` (= earlier Δ). */
  metric?: string | null;
  /** The earlier Δ node. When off it is rendered **as is**. */
  fallback?: ReactNode;
  /** Draw the reason caption next to the chip (narrow surfaces such as tiles pass false). */
  withCaption?: boolean;
  size?: DeltaChipSize;
  glyph?: DeltaChipGlyph;
  className?: string;
}) {
  const slot = slots && metric ? slots[metric] : undefined;
  if (!slot) return <>{fallback}</>;
  return (
    <>
      <PeriodDeltaChip chip={slot.chip} size={size} glyph={glyph} className={className} />
      {withCaption ? <PeriodDeltaCaption caption={slot.caption} /> : null}
    </>
  );
}
