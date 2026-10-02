// Shared recharts <Tooltip contentStyle={...}> values. Recharts' default
// floats with no real background or border — on the beige page (or even on
// white cards under the soft shadow) the box dissolves into the canvas.
// One constant keeps the look consistent across every chart and gives us a
// single place to nudge contrast/elevation later.
import type { CSSProperties } from "react";

export const CHART_TOOLTIP_STYLE: CSSProperties = {
  background: "#ffffff",
  border: "1px solid rgba(0, 0, 0, 0.14)",
  borderRadius: 6,
  boxShadow: "0 4px 14px rgba(0, 0, 0, 0.10)",
  fontSize: 12,
  color: "#0a0908", // --color-ink-900
  padding: "6px 8px",
};

export const CHART_TOOLTIP_LABEL_STYLE: CSSProperties = {
  color: "#0a0908",
  fontWeight: 600,
};

export const CHART_TOOLTIP_ITEM_STYLE: CSSProperties = {
  color: "#0a0908",
};
