// Display of a period-compare chip (the chip itself is built by the API screens).
import type { PeriodChip } from "@/lib/kpi/period-compare-view";

/** What a suppressed or not computable chip shows. */
export const SUPPRESSED_GLYPH = "―";

/** Chip body text (no sign; the direction draws it). Unit suffix `pp`, `%` or none (rank). */
export function periodChipText(chip: PeriodChip): string {
  if (chip.suppressed || chip.value == null) return SUPPRESSED_GLYPH;
  const n = chip.value.toFixed(1);
  if (chip.unit === "pp") return `${n}pp`;
  if (chip.unit === "pct") return `${n}%`;
  return n;
}
