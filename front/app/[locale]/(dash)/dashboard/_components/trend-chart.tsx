"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { cn } from "@/lib/utils";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import { useFilterSignal } from "@/components/dash/use-filter-signal";
import type { KpiKey, TrendPoint } from "../_data/sample";

// 추이 그래프 — v25에서 7개 Core KPI 모두 토글 가능.
// 칩 클릭 시 라인 표시 on/off. 단위가 다른 KPI(percent vs score)가 섞여
// 있어 동일 Y축에 그리면 시각적 비교가 어렵지만, 트렌드 자체를 보는 게
// 목적이라 그대로 둔다 — 정확한 비교는 ③ 상세 테이블에서.
const SERIES: { key: KpiKey; color: string }[] = [
  { key: "visibility", color: "#002c5f" },
  { key: "shareOfVoice", color: "#e63312" },
  { key: "sentiment", color: "#00aad2" },
  { key: "position", color: "#a36b4f" },
  { key: "citationShare", color: "#6b89b3" },
  { key: "citationAccuracy", color: "#1a4d8e" },
  { key: "trafficConversion", color: "#0d6e2f" },
];

const DEFAULT_VISIBLE: KpiKey[] = [
  "visibility",
  "shareOfVoice",
  "sentiment",
  "position",
];

export function TrendChart({ data }: { data: TrendPoint[] }) {
  const tKpi = useTranslations("dashboard.kpi.name");
  const t = useTranslations("dashboard.trend");
  const [visible, setVisible] = useState<Set<KpiKey>>(new Set(DEFAULT_VISIBLE));

  // Dimension filters perturb the fixtures via the deterministic signal.
  const sig = useFilterSignal();
  const scaled = useMemo(
    () =>
      data.map((pt) => {
        const o = { ...pt };
        for (const s of SERIES) {
          const v = o[s.key];
          if (typeof v === "number") o[s.key] = Number(sig.scale(v, s.key).toFixed(1));
        }
        return o;
      }),
    [data, sig],
  );

  function toggle(k: KpiKey) {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(k)) {
        if (next.size > 1) next.delete(k); // 최소 1개 유지
      } else {
        next.add(k);
      }
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t("selector")}
        </span>
        {SERIES.map((s) => {
          const on = visible.has(s.key);
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => toggle(s.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                on
                  ? "border-transparent text-white"
                  : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
              style={on ? { backgroundColor: s.color } : undefined}
            >
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              {tKpi(s.key)}
            </button>
          );
        })}
      </div>
      <div className="h-72 min-w-0 rounded-lg border border-border bg-card p-4">
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 640, height: 288 }}
        >
          <LineChart data={scaled} margin={{ left: -16, right: 8, top: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" />
            <YAxis tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" />
            <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemSorter={(item) => -Number(item.value ?? 0)} wrapperStyle={{ zIndex: 50 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {SERIES.filter((s) => visible.has(s.key)).map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={tKpi(s.key)}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
