"use client";

// 우호도 히어로 우측 — 긍정(초록)·부정(빨강) 비율 두 라인. 디자이너 주석(327:1049):
// "긍정 신호 비율 추이 초록색으로 변경". 갭 규약·툴팁 규약은 kpi-trend-chart 와 동일
// (분자·분모와 각각의 WoW 를 함께 낸다).

import { useTranslations } from "next-intl";
import {
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import { planTrendGaps } from "@/lib/viz/trend-gap";
import {
  trendGapAreas,
  trendGapBridgeLines,
  trendGapHidesTooltip,
} from "@/components/dash/trend-gap-overlay";
import type { FavorabilityTrendPoint } from "../../_data/kpi-view";
import { favorabilityCoverage } from "../../_data/kpi-view";
import { DeltaBadge } from "./kpi-bits";
import { bucketMD, CoverageLabel } from "./kpi-trend-chart";
import { AUTO_PCT_DOMAIN, BandedGrid, ChartBox } from "./chart-box";

/** 라인 정의 — 테스트가 볼 수 있는 seam(recharts 는 정적 렌더에서 SVG 를 내지 않는다). */
export const FAVORABILITY_LINES = [
  // 피그마 327:981 감정색 토큰(globals.css): 긍정 #29a65f · 부정 #b83838.
  { dataKey: "positivePct", nameKey: "favorability.trendPositive", stroke: "var(--color-sentiment-positive-ink)", connectNulls: false },
  { dataKey: "negativePct", nameKey: "favorability.trendNegative", stroke: "var(--color-sentiment-negative-ink)", connectNulls: false },
] as const;

export function FavorabilityTrendChart({
  points,
  height = 220,
}: {
  points: FavorabilityTrendPoint[];
  height?: number;
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  // 커버리지는 **원본** points 로 센다 — 보조 키가 더해진 행을 세면 의도가 흐려진다.
  const coverage = favorabilityCoverage(points);
  // 수집 오류 회차 — 음영 + 이웃 연결(KpiTrendChart 와 같은 자세). 시리즈는 긍정·부정 둘.
  const gapPlan = planTrendGaps(points, {
    xKey: "bucketStart",
    seriesKeys: FAVORABILITY_LINES.map((l) => l.dataKey),
  });

  function TooltipBody({ payload }: { payload?: ReadonlyArray<{ payload?: FavorabilityTrendPoint }> }) {
    // 갭 슬롯은 툴팁을 통째로 숨긴다(2026-09-11 운영 "다른 차트에도 갭 툴팁 지워줘").
    if (trendGapHidesTooltip(payload)) return null;
    const p = payload?.[0]?.payload;
    if (!p || p.total == null) return null;
    return (
      <div style={CHART_TOOLTIP_STYLE} className="flex min-w-48 flex-col gap-1">
        <div className="text-[11px] text-muted-foreground">{bucketMD(p.bucketStart)}</div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs font-semibold">{t("favorability.trendPositive")}</span>
          <span className="text-sm font-bold tabular-nums">{p.positivePct == null ? "—" : `${p.positivePct.toFixed(1)}%`}</span>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs font-semibold">{t("favorability.trendNegative")}</span>
          <span className="text-sm font-bold tabular-nums">{p.negativePct == null ? "—" : `${p.negativePct.toFixed(1)}%`}</span>
        </div>
        <Row label={t("favorability.tooltipPositiveCount")} count={p.positive} wow={p.positiveWow} />
        <Row label={t("favorability.tooltipTotalCount")} count={p.total} wow={p.totalWow} />
      </div>
    );
  }
  function Row({ label, count, wow }: { label: string; count: number | null; wow: number | null }) {
    return (
      <div className="flex items-start justify-between gap-3">
        <span className="text-[11px] text-muted-foreground">
          {label}
          <br />
          {t("tooltip.wow")}
        </span>
        <span className="flex flex-col items-end">
          <span className="text-[11px] tabular-nums">{count == null ? "—" : t("tooltip.count", { n: count })}</span>
          <DeltaBadge value={wow} unit="pct" glyph="triangle" />
        </span>
      </div>
    );
  }

  return (
    <ChartBox className="flex-1">
      <div style={{ height }} className="min-w-0">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height }}>
          <LineChart data={gapPlan.rows} margin={{ left: -12, right: 8, top: 8, bottom: 0 }}>
            <BandedGrid />
            {/* 음영은 라인보다 먼저 — 뒤에 깔린다. */}
            {trendGapAreas(gapPlan.areas)}
            <XAxis dataKey="bucketStart" tickFormatter={bucketMD} tick={{ fontSize: 11 }} stroke="var(--color-ink-500)" />
            <YAxis tick={{ fontSize: 11 }} stroke="var(--color-ink-500)" domain={AUTO_PCT_DOMAIN} tickFormatter={(v: number) => `${v}%`} />
            {/* filterNull={false} — 값이 null 인 갭 슬롯에서도 payload 가 살아야
                갭 마커가 툴팁까지 닿는다(GapAwareTooltip 주석). */}
            <RTooltip content={<TooltipBody />} filterNull={false} wrapperStyle={{ zIndex: 50 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {FAVORABILITY_LINES.map((l) => (
              <Line
                key={l.dataKey}
                type="monotone"
                dataKey={l.dataKey}
                name={t(l.nameKey)}
                stroke={l.stroke}
                strokeWidth={2.5}
                dot={{ r: 2.5 }}
                connectNulls={l.connectNulls}
                isAnimationActive={false}
              />
            ))}
            {/* 이웃 잇기 — 갭 칸에 값을 만들지 않는 합성 시리즈(보간 아님). */}
            {trendGapBridgeLines(gapPlan.bridges, (key) => {
              const l = FAVORABILITY_LINES.find((x) => x.dataKey === key);
              return l ? { stroke: l.stroke, strokeWidth: 2.5 } : null;
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("favorability.trendNote")}</p>
      <CoverageLabel entries={coverage} />
    </ChartBox>
  );
}
