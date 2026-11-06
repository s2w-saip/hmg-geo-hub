// Type-only snapshot; no database or server implementation is included.
import type { ReactNode } from "react";
import type { PeriodCaptionMessage, PeriodChip } from "@/lib/kpi/period-compare-view";
import { type DeltaChipGlyph, type DeltaChipSize } from "./delta-chip";
/** One metric's period comparison as the API built it (chip + caption). */
export interface PeriodSlotView {
    chip: PeriodChip;
    caption: PeriodCaptionMessage;
}
/** The screen's `periodSlots`: metric -> slot view; `null` = draw the earlier Δ (no closed period). */
export type PeriodSlots = Readonly<Record<string, PeriodSlotView>>;
export declare function PeriodDeltaSlot({ slots, metric, fallback, withCaption, size, glyph, className, }: {
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
}): import("react").JSX.Element;
