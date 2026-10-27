"use client";

// 히어로 우측의 **브랜드별** KPI 추이 (점유율 탭).
//
// 피그마 점유율 화면(327:550)의 히어로 우측이 다중 브랜드 라인이다. 하단의
// "주별 상위 브랜드"와 중복처럼 보이지만 지표가 다르다 — 저쪽은 언급 수(절대값),
// 여기는 점유율(%). 캡션이 그 차이를 말한다.
//
// 갭 규약은 단일 라인 차트와 동일하다: 측정 없는 회차는 null 이고
// `connectNulls={false}` 로 선이 끊긴다(보간 금지, 스펙 SHALL).

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
import type { BrandTrendChartData, KpiMetric } from "../../_data/mention-screen";
import { brandColor } from "./series-colors";
import { bucketMD, CoverageLabel } from "./kpi-trend-chart";
import { BandedGrid, ChartBox } from "./chart-box";
import { trendGapAreas, trendGapBridgeLines, trendGapHidesTooltip } from "@/components/dash/trend-gap-overlay";
import { planTrendGaps } from "@/lib/viz/trend-gap";

/**
 * 라인 하나의 props — **테스트가 볼 수 있는 seam**.
 *
 * recharts 는 `renderToStaticMarkup` 에서 SVG 를 전혀 내지 않는다(2026-09-02 실측:
 * ResponsiveContainer 가 wrapper div 만 남기고 끝난다 — 폭 측정이 브라우저에만
 * 있기 때문). 그래서 "라인이 몇 개 그려지는가·갭을 잇지 않는가"를 마크업으로는
 * 단언할 수 없다. 매핑을 순수 함수로 빼서 그 계약을 직접 고정한다.
 */
export interface BrandLineProps {
  dataKey: string;
  name: string;
  stroke: string;
  strokeWidth: number;
  connectNulls: false;
}

export function brandLineProps(data: BrandTrendChartData): BrandLineProps[] {
  return data.series.map((s) => ({
    dataKey: s.brand,
    name: s.brand,
    stroke: brandColor(s.brand, s.isTracked, s.colorIndex),
    strokeWidth: s.isTracked ? 2.5 : 1.5,
    // 갭 유지 — 측정 없는 회차를 직전값으로 잇지 않는다(스펙 SHALL).
    connectNulls: false,
  }));
}

type Point = Record<string, string | number | null>;

export function BrandTrendChart({
  metric,
  data,
  height = 220,
}: {
  metric: KpiMetric;
  data: BrandTrendChartData;
  height?: number;
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const lines = brandLineProps(data);
  // 수집 오류 회차 — 음영 슬롯 + 이웃 연결 보조 라인(lib/viz/trend-gap.ts).
  const gapPlan = planTrendGaps(data.points, {
    xKey: "bucketStart",
    seriesKeys: data.series.map((x) => x.brand),
    family: "mention",
  });

  // 피그마 툴팁(제품 결정 Q22): 날짜 / 지표명 + 당사 값 굵게 / 나머지 브랜드 값 목록.
  function TooltipBody({ payload }: { payload?: ReadonlyArray<{ payload?: Point }> }) {
    // 갭 슬롯은 툴팁을 통째로 숨긴다(2026-09-11 제품 책임자 "다른 차트에도 갭 툴팁 지워줘").
    // 아래 `if (!p)` 가드로는 안 막힌다 — 갭 행도 행은 행이라, 브랜드마다 "—" 만
    // 찍힌 빈 박스가 뜬다.
    if (trendGapHidesTooltip(payload)) return null;
    const p = payload?.[0]?.payload;
    if (!p) return null;
    const fmt = (v: unknown) => (typeof v === "number" ? `${v.toFixed(1)}%` : "—");
    const own = data.series.filter((s) => s.isTracked);
    const others = data.series.filter((s) => !s.isTracked);
    return (
      <div style={CHART_TOOLTIP_STYLE} className="flex min-w-44 flex-col gap-1">
        <div className="text-[11px] text-muted-foreground">{bucketMD(String(p.bucketStart))}</div>
        {own.map((s) => (
          <div key={s.brand} className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-semibold">{own.length > 1 ? `${t(`metric.${metric}`)} · ${s.brand}` : t(`metric.${metric}`)}</span>
            <span className="text-sm font-bold tabular-nums">{fmt(p[s.brand])}</span>
          </div>
        ))}
        {others.map((s) => (
          <div key={s.brand} className="flex items-baseline justify-between gap-3 text-[11px]">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: lines.find((l) => l.dataKey === s.brand)?.stroke }}
                aria-hidden
              />
              {s.brand}
            </span>
            <span className="tabular-nums">{fmt(p[s.brand])}</span>
          </div>
        ))}
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
              domain={[0, "auto"]}
              tickFormatter={(v: number) => `${v}%`}
            />
            {/* filterNull={false} — 전 시리즈가 null 인 갭 슬롯에서도 payload 가 살아야
                갭 마커가 툴팁까지 닿는다(GapAwareTooltip 주석 참고). */}
            <RTooltip content={<TooltipBody />} filterNull={false} wrapperStyle={{ zIndex: 50 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {lines.map((p) => (
              <Line
                key={p.dataKey}
                type="monotone"
                dot={{ r: 2 }}
                isAnimationActive={false}
                {...p}
              />
            ))}
            {trendGapBridgeLines(gapPlan.bridges, (brand) => {
              const l = lines.find((x) => x.dataKey === brand);
              return l ? { stroke: l.stroke, strokeWidth: l.strokeWidth } : null;
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] text-muted-foreground">{t(`hero.brandTrendNote.${metric}`)}</p>
      <CoverageLabel entries={data.coverage} />
    </ChartBox>
  );
}
