"use client";

// 히어로 우측의 KPI 추이 차트 + 측정 커버리지 라벨.
//
// 두 가지가 이 차트의 존재 이유다:
//   1. **갭 유지** — 측정이 없는 회차는 null 이고 `connectNulls={false}` 로 선이
//      끊긴다. 직전값 연결(보간)은 "그 주에도 측정했다"는 거짓 신호다(스펙 SHALL).
//   2. **커스텀 툴팁** — 비율만 보면 표본 규모를 알 수 없다는 고객 피드백 이후의
//      규칙: 값과 함께 분자/분모와 각각의 WoW 를 같이 낸다.
//
// ⚠️ 1번만으로는 **수집 오류 회차와 미측정 회차가 같아 보인다** — 둘 다 그냥 끊긴
// 선이다. 그래서 `kpiTrendPoints` 가 얹어 둔 `gap` 마커(0070)를 여기서 그린다:
// 음영 슬롯 + 이웃 연결 보조 라인 + 툴팁 문구. 규약 정본은 lib/viz/trend-gap.ts,
// recharts 이식은 components/dash/trend-gap-overlay.tsx.

import { useTranslations } from "next-intl";
import {
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
import type { CoverageEntry, KpiMetric, KpiTrendPoint } from "../../_data/mention-screen";
import { DeltaBadge } from "./kpi-bits";
import { AUTO_PCT_DOMAIN, BandedGrid, ChartBox } from "./chart-box";

/** 버킷 시작일(ISO) → "8/3". 문자열 파싱이라 TZ/로케일 무관·하이드레이션 안전. */
export function bucketMD(iso: string): string {
  const p = String(iso).split("-");
  return p.length === 3 ? `${Number(p[1])}. ${Number(p[2])}.` : String(iso);
}

interface TooltipPayloadItem {
  payload?: KpiTrendPoint;
}

export function KpiTrendChart({
  metric,
  points,
  coverage,
  height = 220,
}: {
  metric: KpiMetric;
  points: KpiTrendPoint[];
  /** Coverage label entries (the measured slots of `points`), computed by the screen. */
  coverage: CoverageEntry[];
  height?: number;
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  // 수집 오류 회차 — 음영 + 이웃 연결(BrandTrendChart 와 같은 자세). 시리즈는 하나뿐이다.
  const gapPlan = planTrendGaps(points, { xKey: "bucketStart", seriesKeys: ["pct"], family: "mention" });

  const numeratorLabel = t(
    metric === "exposure" ? "tooltip.exposureNumerator" : "tooltip.sovNumerator",
  );
  const denominatorLabel = t(
    metric === "exposure" ? "tooltip.exposureDenominator" : "tooltip.sovDenominator",
  );

  function TooltipBody({ payload }: { payload?: readonly TooltipPayloadItem[] }) {
    // 갭 슬롯은 툴팁을 통째로 숨긴다(2026-09-11 제품 책임자 "다른 차트에도 갭 툴팁 지워줘").
    if (trendGapHidesTooltip(payload)) return null;
    const p = payload?.[0]?.payload;
    if (!p || p.pct == null) return null;
    return (
      <div style={CHART_TOOLTIP_STYLE} className="flex min-w-44 flex-col gap-1">
        <div className="text-[11px] text-muted-foreground">{bucketMD(p.bucketStart)}</div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs font-semibold">{t(`metric.${metric}`)}</span>
          <span className="text-sm font-bold tabular-nums">{p.pct.toFixed(1)}%</span>
        </div>
        <TooltipRow
          label={numeratorLabel}
          count={p.numerator}
          wow={p.numeratorWow}
          countLabel={t("tooltip.count", { n: p.numerator ?? 0 })}
        />
        <TooltipRow
          label={denominatorLabel}
          count={p.denominator}
          wow={p.denominatorWow}
          countLabel={t("tooltip.count", { n: p.denominator ?? 0 })}
        />
      </div>
    );
  }

  function TooltipRow({
    label,
    count,
    wow,
    countLabel,
  }: {
    label: string;
    count: number | null;
    wow: number | null;
    countLabel: string;
  }) {
    return (
      <div className="flex items-start justify-between gap-3">
        <span className="text-[11px] text-muted-foreground">
          {label}
          <br />
          {t("tooltip.wow")}
        </span>
        <span className="flex flex-col items-end">
          <span className="text-[11px] tabular-nums">{count == null ? "—" : countLabel}</span>
          <DeltaBadge value={wow} unit="pct" glyph="triangle" />
        </span>
      </div>
    );
  }

  return (
    <ChartBox className="flex-1">
      <div style={{ height }} className="min-w-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 640, height }}
        >
          <LineChart data={gapPlan.rows} margin={{ left: -12, right: 8, top: 8, bottom: 0 }}>
            <BandedGrid />
            {/* 음영은 라인보다 먼저 — 뒤에 깔린다. */}
            {trendGapAreas(gapPlan.areas)}
            <XAxis
              dataKey="bucketStart"
              tickFormatter={bucketMD}
              tick={{ fontSize: 11 }}
              stroke="var(--color-ink-500)"
            />
            <YAxis
              tick={{ fontSize: 11 }}
              stroke="var(--color-ink-500)"
              domain={AUTO_PCT_DOMAIN}
              tickFormatter={(v: number) => `${v}%`}
            />
            {/* filterNull={false} — 값이 null 인 갭 슬롯에서도 payload 가 살아야
                갭 마커가 툴팁까지 닿는다(GapAwareTooltip 주석). */}
            <RTooltip content={<TooltipBody />} filterNull={false} wrapperStyle={{ zIndex: 50 }} />
            <Line
              type="monotone"
              dataKey="pct"
              name={t(`metric.${metric}`)}
              stroke="var(--color-brand-700)"
              strokeWidth={2.5}
              dot={{ r: 2.5 }}
              // 갭 유지 — 측정 없는 회차를 직전값으로 잇지 않는다(스펙 SHALL).
              connectNulls={false}
            />
            {/* 이웃 잇기 — 갭 칸에 값을 만들지 않는 합성 시리즈(보간 아님). */}
            {trendGapBridgeLines(gapPlan.bridges, () => ({
              stroke: "var(--color-brand-700)",
              strokeWidth: 2.5,
            }))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <CoverageLabel entries={coverage} />
    </ChartBox>
  );
}

/** 측정 커버리지 — "그 회차에 며칠 측정했나". 결측 회차는 애초에 항목이 없다. */
export function CoverageLabel({
  entries,
}: {
  entries: { bucketStart: string; measuredDays: number }[];
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span className="font-medium">{t("hero.coverage")}</span>
      {entries.map((e) => (
        <span key={e.bucketStart} className="tabular-nums">
          {bucketMD(e.bucketStart)}{" "}
          <strong className="font-semibold text-foreground">
            {t("hero.coverageDays", { days: e.measuredDays })}
          </strong>
        </span>
      ))}
    </div>
  );
}
