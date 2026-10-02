"use client";

// 우선 노출도 히어로 우측 — 브랜드별 평균 등장 순위 시계열. **y축 반전**(1위가 위,
// 디자이너 주석 327:1140 "Y축: 순위(높은 순위가 가장 상단에 있도록)"). 갭 규약은 다른
// 추이 차트와 같다(connectNulls=false).
//
// 툴팁(피그마 1:1, 제품 결정): 날짜 / 당사 "AI 우선 노출도 N위" + "순위 답변 N개" /
// 다른 브랜드 N위. 순위 답변 수는 rankTrendChart 가 포인트에 예약 키로 넣어 준다.

import { useTranslations } from "next-intl";
import { Legend, Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import { RANK_TOOLTIP_OWN_RANKED, positionText, rankAxisTicks, type RankTrendChartData } from "../../_data/kpi-view";
import { brandLineProps } from "./brand-trend-chart";
import { bucketMD, CoverageLabel } from "./kpi-trend-chart";
import { BandedGrid, ChartBox } from "./chart-box";
import { trendGapAreas, trendGapBridgeLines, trendGapHidesTooltip } from "@/components/dash/trend-gap-overlay";
import { planTrendGaps } from "@/lib/viz/trend-gap";

type Point = Record<string, string | number | null>;

export function RankTrendChart({ data, height = 220 }: { data: RankTrendChartData; height?: number }) {
  const t = useTranslations("answerAnalysis.mentions.kpi.firstRank");
  // 값 단위는 지면 공통 정본(`metricUnit.position`)이다. 표·히어로·Overview 와 같은 키.
  const tUnit = useTranslations("metricUnit");
  const own = data.series.filter((s) => s.isTracked).map((s) => s.brand);
  const ownSet = new Set(own);
  const lines = brandLineProps(data);
  // 수집 오류 회차 — 음영 슬롯 + 이웃 연결 보조 라인(lib/viz/trend-gap.ts).
  const gapPlan = planTrendGaps(data.points, {
    xKey: "bucketStart",
    seriesKeys: data.series.map((x) => x.brand),
    family: "mention",
  });

  function TooltipBody({ payload }: { payload?: ReadonlyArray<{ payload?: Point }> }) {
    // 갭 슬롯은 툴팁을 통째로 숨긴다(2026-09-11 제품 책임자 "다른 차트에도 갭 툴팁 지워줘").
    // 아래 `if (!p)` 가드로는 안 막힌다 — 갭 행도 행은 행이라, 브랜드마다 "—" 만
    // 찍힌 빈 박스가 뜬다.
    if (trendGapHidesTooltip(payload)) return null;
    const p = payload?.[0]?.payload;
    if (!p) return null;
    const ranked = p[RANK_TOOLTIP_OWN_RANKED];
    const ownRows = data.series.filter((s) => ownSet.has(s.brand));
    const others = data.series.filter((s) => !ownSet.has(s.brand));
    return (
      <div style={CHART_TOOLTIP_STYLE} className="flex min-w-44 flex-col gap-1">
        <div className="text-[11px] text-muted-foreground">{bucketMD(String(p.bucketStart))}</div>
        {ownRows.map((s) => {
          const v = p[s.brand];
          return (
            <div key={s.brand} className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-semibold">{own.length > 1 ? `${t("title")} · ${s.brand}` : t("title")}</span>
              <span className="text-sm font-bold tabular-nums">
                {typeof v === "number" ? tUnit("position", { n: positionText(v) }) : "—"}
              </span>
            </div>
          );
        })}
        {typeof ranked === "number" ? (
          <div className="text-[11px] text-muted-foreground">{t("tooltipRankedAnswers", { n: ranked })}</div>
        ) : null}
        {others.map((s) => {
          const v = p[s.brand];
          return (
            <div key={s.brand} className="flex items-baseline justify-between gap-3 text-[11px]">
              <span className="text-muted-foreground">{s.brand}</span>
              <span className="tabular-nums">{typeof v === "number" ? tUnit("position", { n: positionText(v) }) : "—"}</span>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <ChartBox className="flex-1">
      {/* 피그마 327:1140: 축 이름은 세로 회전이 아니라 차트 좌상단 가로 텍스트. */}
      <p className="text-[11px] text-muted-foreground">{t("chartAxis")}</p>
      <div style={{ height }} className="min-w-0">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 640, height }}>
          <LineChart data={gapPlan.rows} margin={{ left: -12, right: 8, top: 8, bottom: 0 }}>
            <BandedGrid />
            {trendGapAreas(gapPlan.areas)}
            <XAxis dataKey="bucketStart" tickFormatter={bucketMD} tick={{ fontSize: 11 }} stroke="var(--color-ink-500)" />
            <YAxis
              reversed
              domain={[1, data.yMax]}
              ticks={rankAxisTicks(data.yMax)}
              interval={0}
              allowDecimals={false}
              tick={{ fontSize: 11 }}
              stroke="var(--color-ink-500)"
            />
            <RTooltip content={<TooltipBody />} filterNull={false} wrapperStyle={{ zIndex: 50 }} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {lines.map((p) => (
              <Line key={p.dataKey} type="monotone" dot={{ r: 2 }} isAnimationActive={false} {...p} />
            ))}
            {trendGapBridgeLines(gapPlan.bridges, (brand) => {
              const l = lines.find((x) => x.dataKey === brand);
              return l ? { stroke: l.stroke, strokeWidth: l.strokeWidth } : null;
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] text-muted-foreground">{t("chartNote")}</p>
      <CoverageLabel entries={data.coverage} />
    </ChartBox>
  );
}
