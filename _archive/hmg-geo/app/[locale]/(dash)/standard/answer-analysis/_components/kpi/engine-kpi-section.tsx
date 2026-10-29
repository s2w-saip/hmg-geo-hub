"use client";

// AI 엔진별 노출/점유율 — 좌측 최신 바(스냅샷), 우측 회차 시계열(갭 유지).
// 노출률·점유율 탭이 `metric` prop 만 바꿔 공유한다.
//
// 2026-09-11 QA(운영 스크린샷): 8/24 자리에서 선이 그냥 끊겨 보였다 — 수집 오류
// 회차인데 음영·툴팁·이웃 연결이 하나도 없었다. 다른 추이 차트와 **같은 방식**으로
// 배선한다(규약 정본 lib/viz/trend-gap.ts, recharts 이식 components/dash/trend-gap-overlay.tsx).
//
// 2026-09-10 QA 2차 #6(고객): "AI 엔진별 노출 또한 타 영역의 경쟁사 선택과는
// 별개이며, 당사·경쟁사 평균만 데이터 제공." → `competitor` prop 을 **타입에서
// 지웠다**. 값을 무시하는 것만으로는 다음 사람이 다시 배선하므로, 결합을 컴파일
// 단계에서 막는다. 막대는 항상 당사 + 경쟁사 평균 둘뿐이다.

import { useState } from "react";
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
import { planTrendGaps, type TrendGapRow } from "@/lib/viz/trend-gap";
import {
  GapAwareTooltip,
  trendGapAreas,
  trendGapBridgeLines,
} from "@/components/dash/trend-gap-overlay";
import { cn } from "@/lib/utils";
import type { EngineCompetitorBar, EngineKpiBar, KpiMetric } from "../../_data/kpi-view";
import { seriesColor } from "./series-colors";
import { pctText, ValueBar } from "./kpi-bits";
import { bucketMD, CoverageLabel } from "./kpi-trend-chart";
import { AUTO_PCT_DOMAIN, BandedGrid, ChartBox } from "./chart-box";

const ALL = "__all__";

export function EngineKpiSection({
  metric,
  bars,
  competitorBars = [],
  series,
  coverage,
  trendUnavailable = false,
}: {
  metric: KpiMetric;
  bars: EngineKpiBar[];
  /** 엔진별 당사 · 경쟁사 평균(피그마 D24). 비어 있으면 당사 바만 그린다. */
  competitorBars?: EngineCompetitorBar[];
  series: { engines: string[]; points: Array<TrendGapRow> };
  coverage: { bucketStart: string; measuredDays: number }[];
  /**
   * 시계열 단계만 실패했는가. **좌측 바는 스냅샷 스칼라라 살아 있다** — 섹션을
   * 통째로 비우지 않고 우측 차트만 대체 문구로 바꾼다(재검증 C2).
   */
  trendUnavailable?: boolean;
}) {
  const t = useTranslations("answerAnalysis.mentions.kpi");
  const [picked, setPicked] = useState<string>(ALL);
  const shownBars = picked === ALL ? bars : bars.filter((b) => b.engine === picked);
  const shownEngines = picked === ALL ? series.engines : series.engines.filter((e) => e === picked);
  // 수집 오류 회차 — 음영 + 이웃 연결. 계획은 **그릴 수 있는 엔진 전부**로 세우고,
  // 칩으로 숨긴 엔진은 아래 styleOf 가 null 을 돌려 보조선을 빼므로 칩을 눌러도
  // 계획이 다시 돌지 않는다(planTrendGaps jsdoc).
  const gapPlan = planTrendGaps(series.points, {
    xKey: "bucketStart",
    seriesKeys: series.engines,
  });

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <header className="flex flex-col gap-0.5">
        <h3 className="text-[15px] font-semibold tracking-tight text-foreground">
          {t(`engine.title.${metric}`)}
        </h3>
        <p className="text-xs text-muted-foreground">{t(`engine.hint.${metric}`)}</p>
      </header>

      {bars.length === 0 ? (
        <p className="px-2 py-8 text-center text-xs text-muted-foreground">{t("engine.empty")}</p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t("engine.engineLabel")}
              </span>
              <EngineChip active={picked === ALL} onClick={() => setPicked(ALL)}>
                {t("engine.all")}
              </EngineChip>
              {series.engines.map((e) => (
                <EngineChip key={e} active={picked === e} onClick={() => setPicked(e)}>
                  {e}
                </EngineChip>
              ))}
            </div>
            <ul className="flex flex-col gap-3">
              {shownBars.map((b) => {
                const cb = competitorBars.find((c) => c.engine === b.engine);
                const rows: Array<{ key: string; label: string; pct: number | null; color: string }> = [
                  { key: "own", label: t("engine.own"), pct: b.pct, color: "var(--color-brand-700)" },
                ];
                if (cb && cb.competitorAvgPct != null) {
                  // 운영 D8 — "무엇의 평균인가"를 라벨이 말한다. 검증자 B4 정정:
                  // n 은 경쟁사 모수가 아니라 **상위 N**(상류 ENGINE_BRAND_TOP_N 절단
                  // 안에서 평균이 실제로 센 브랜드 수)이라, 사전 문구도 "상위 {n}개사"다.
                  rows.push({
                    key: "avg",
                    label: t("engine.competitorAvgWithCount", { n: cb.competitorCount }),
                    pct: cb.competitorAvgPct,
                    color: "var(--color-ink-300)",
                  });
                }
                return (
                  <li key={b.engine} className="flex flex-col gap-1 text-xs" data-engine-bar={b.engine}>
                    <span className="font-medium text-foreground">{b.engine}</span>
                    {rows.map((r) => (
                      <span key={r.key} className="flex items-center gap-2">
                        {/* "상위 N개사" 가 붙어 라벨이 길어졌다 — 폭을 한 단계 넓히고
                            잘리는 경우에도 전문이 title 로 남게 한다(aria 는 ValueBar 가 갖는다). */}
                        <span
                          title={r.label}
                          className="w-32 shrink-0 truncate text-[11px] text-muted-foreground"
                        >
                          {r.label}
                        </span>
                        <ValueBar
                          value={r.pct}
                          max={100}
                          color={r.color}
                          label={`${b.engine} ${r.label} ${pctText(r.pct)}`}
                          className="h-3"
                        />
                        <span className="w-12 shrink-0 text-right tabular-nums">{pctText(r.pct)}</span>
                      </span>
                    ))}
                  </li>
                );
              })}
            </ul>
          </div>

          <ChartBox className="flex-1">
            {trendUnavailable ? (
              <div className="flex h-56 items-center justify-center rounded-md border border-dashed border-border px-4 text-xs text-muted-foreground">
                {t("degradedTrend")}
              </div>
            ) : (
            <div className="h-56 min-w-0">
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={{ width: 480, height: 224 }}
              >
                <LineChart data={gapPlan.rows} margin={{ left: -12, right: 8, top: 8, bottom: 0 }}>
                  <BandedGrid />
                  {/* 음영은 라인보다 먼저 — 뒤에 깔려야 값을 가리지 않는다. */}
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
                  <RTooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    labelFormatter={(v: unknown) => bucketMD(String(v))}
                    formatter={(v: unknown) => (v == null ? "—" : `${Number(v).toFixed(1)}%`)}
                    wrapperStyle={{ zIndex: 50 }}
                    // 갭 슬롯은 전 시리즈 null — filterNull 기본값이면 payload 가 비어
                    // content 가 마커를 못 본다. 마커를 본 GapAwareTooltip 은 **아무것도
                    // 안 낸다**(2026-09-11 운영 "다른 차트에도 갭 툴팁 지워줘"). null
                    // 걷어내기도 GapAwareTooltip 이 대신하므로 갭 아닌 칸은 종전 그대로다.
                    filterNull={false}
                    content={<GapAwareTooltip />}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {shownEngines.map((e) => (
                    <Line
                      key={e}
                      type="monotone"
                      dataKey={e}
                      name={e}
                      stroke={seriesColor(series.engines.indexOf(e))}
                      strokeWidth={2}
                      // 측정이 있는 날짜마다 점을 찍는다(QA #21) — null 값은 recharts 가
                      // 점을 그리지 않으므로 측정 없는 버킷에 가짜 포인트가 생기지 않는다.
                      dot={{ r: 2.5 }}
                      // 측정 없는 회차는 끊는다 — 보간 금지(스펙 SHALL).
                      connectNulls={false}
                    />
                  ))}
                  {/* 이웃 잇기 — 갭 칸에 값을 만들지 않는 합성 시리즈(보간 아님).
                      칩으로 숨긴 엔진은 null → 보조선도 안 그린다. */}
                  {trendGapBridgeLines(gapPlan.bridges, (engine) => {
                    if (!shownEngines.includes(engine)) return null;
                    return {
                      stroke: seriesColor(series.engines.indexOf(engine)),
                      strokeWidth: 2,
                    };
                  })}
                </LineChart>
              </ResponsiveContainer>
            </div>
            )}
            {trendUnavailable ? null : <CoverageLabel entries={coverage} />}
          </ChartBox>
        </div>
      )}
    </section>
  );
}

function EngineChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2.5 py-1 text-[11px] transition-colors",
        active
          ? "border-brand-700 bg-brand-700 text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
