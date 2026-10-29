"use client";

import { useId, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { ResponsiveContainer, AreaChart, Area } from "recharts";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Direction of a period-over-period change.
//   up   = positive (brand-700 tone — "good" in monitoring context)
//   down = negative (destructive tone)
//   flat = unchanged (muted)
// Invert the direction in your data layer for a metric where "down" is good
// (e.g. error rate). KpiCard takes `direction` at face value.
export type KpiDelta = {
  value: number; // magnitude; sign is rendered from `direction`
  direction: "up" | "down" | "flat";
};

export type KpiCardProps = {
  /** Small label above the value (e.g. "측정 프롬프트"). */
  label: string;
  /** Big number; pass "—" or any string when no data. */
  value: string | number;
  /** Optional ±% change indicator. */
  delta?: KpiDelta;
  /** Small caption under the value (e.g. "지난 7일", "데이터 연결 대기"). */
  hint?: string;
  /**
   * Optional icon node shown as a small plate in the top-right corner. Pass
   * pre-rendered JSX (e.g. `<Activity className="h-4 w-4" />`) rather than a
   * component reference — this component is "use client" (recharts needs the
   * browser), and React component references aren't serializable across the
   * server→client boundary in the Next.js App Router.
   */
  icon?: ReactNode;
  /**
   * Mini sparkline data. recharts Area without axes/dots — purely decorative.
   * Requires at least 2 points; shorter arrays collapse the slot.
   */
  sparkline?: { value: number }[];
  /** "muted" dims the icon plate + value tone for empty / pending states. */
  variant?: "default" | "muted";
  className?: string;
};

// Decorative sparkline. useId() makes the gradient id unique per instance —
// otherwise multiple KpiCards on the same page collide on a static id and
// only the first chart's gradient renders.
function Sparkline({ data }: { data: { value: number }[] }) {
  const gradientId = useId();
  return (
    <div className="h-10 min-w-0" aria-hidden>
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 160, height: 40 }}
      >
        <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor="var(--color-brand-700)"
                stopOpacity={0.18}
              />
              <stop
                offset="100%"
                stopColor="var(--color-brand-700)"
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--color-brand-700)"
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Compact ±% chip. Renders sign locally so callers can pass either a signed
// value or a magnitude + direction; both yield the same visual output.
function DeltaChip({ delta }: { delta: KpiDelta }) {
  const Icon =
    delta.direction === "up"
      ? ArrowUpRight
      : delta.direction === "down"
        ? ArrowDownRight
        : Minus;
  const tone =
    delta.direction === "up"
      ? "bg-brand-50 text-brand-700"
      : delta.direction === "down"
        ? "bg-destructive/10 text-destructive"
        : "bg-muted text-muted-foreground";
  const sign =
    delta.direction === "up" ? "+" : delta.direction === "down" ? "−" : "";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
        tone,
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {sign}
      {Math.abs(delta.value)}%
    </span>
  );
}

export function KpiCard({
  label,
  value,
  delta,
  hint,
  icon,
  sparkline,
  variant = "default",
  className,
}: KpiCardProps) {
  const muted = variant === "muted";
  return (
    <Card
      aria-label={`${label} ${value}`}
      className={cn(
        // shadcn Card default is flex-col gap-6 py-6. Override to a tighter
        // compact rhythm appropriate for stat tiles in a 4-up row.
        "items-stretch gap-4 p-5",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">
            {label}
          </span>
          <span
            className={cn(
              "font-head text-3xl font-semibold tracking-tight tabular-nums",
              muted ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {value}
          </span>
        </div>
        {icon ? (
          <div
            className={cn(
              // Borderless icon plate — separation from the card surface
              // comes from the tinted background, not an outline. Default
              // variant tints toward Hyundai Blue (brand-50 wash + brand-700
              // glyph) so the plate reads as a "brand slot" when real data
              // arrives; muted variant stays on neutrals for empty states.
              "flex shrink-0 items-center justify-center rounded-md p-2 [&_svg]:h-4 [&_svg]:w-4",
              muted
                ? "bg-muted text-muted-foreground"
                : "bg-brand-50 text-brand-700",
            )}
            aria-hidden
          >
            {icon}
          </div>
        ) : null}
      </div>

      {delta || hint ? (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {delta ? <DeltaChip delta={delta} /> : null}
          {hint ? <span>{hint}</span> : null}
        </div>
      ) : null}

      {sparkline && sparkline.length >= 2 ? (
        <Sparkline data={sparkline} />
      ) : null}
    </Card>
  );
}
