"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  ComposedChart,
  Line,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { TrendingUp, Users, Sparkles, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip as InfoTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DimensionFilterPanel,
  type DimensionGroup,
} from "@/components/dash/dimension-filter-panel";
import { useFilterSignal } from "@/components/dash/use-filter-signal";
import { cn } from "@/lib/utils";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  SAMPLE_CONVERSION_PAGES,
  SAMPLE_CONVERSION_SUMMARY,
  SAMPLE_CONVERSION_TREND,
  SAMPLE_ENGINE_BREAKDOWN,
} from "../_data/sample";
import type {
  ConversionLive,
  AiTrafficConversionRollup,
  AiVisitsTrendPoint,
  ConversionPageRow,
  EngineBreakdownRow,
} from "@/lib/ga4/conversion";
import { CountryConversionTable } from "./conversion-countries-table";
import { ConversionPeriodSelect } from "./conversion-period-select";

// 전환율 null = 그 코호트 세션(분모) 0 이라 측정값이 없다(API 원천) → "—". 격차도 한쪽 비율이 없으면 "—".
const fmtRate = (v: number | null) => (v == null ? "—" : `${v.toFixed(1)}%`);
const fmtLift = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}pp`);
const liftColor = (v: number | null) => (v == null ? "text-muted-foreground" : v >= 0 ? "text-emerald-600" : "text-destructive");

// Locale-independent proper nouns — mirrors dimension-filter-panel's
// ENGINE_LABEL (not exported there; this view only ever shows the two engines
// the conversion stage's DimensionFilterPanel exposes).
const ENGINE_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
};

// Below this many AI active users over the whole window, a rate is mostly
// noise (2026-07-03 Kia/IT finding: a single day's rate swung 12%→89%→18% on
// an 8-12 user cohort). UI-only heuristic — not a data-layer cutoff.
const LOW_SAMPLE_USERS = 50;

// Conversion exposes ONLY GA4-backed axes (probed 2026-06-23). geography is the
// country split (real at region/HQ rollup; locked to the project's country on a
// single-property view). engine/device/visitorType slice the AI cohort. Scope
// axes (promptContext/competitor/brand/depth) have no GA4 conversion mapping, so
// they're hidden here — otherwise they'd be dead filters that change nothing.
const CONVERSION_GROUPS: DimensionGroup[] = [
  "geography",
  "engine",
  "device",
  "visitorType",
];

type ConversionSortKey =
  | "url"
  | "aiUsers"
  | "humanUsers"
  | "aiRate"
  | "humanRate"
  | "lift";

// 표준 + Project 공통 view — AI Conversion.
// Q3=same-page baseline. AI 유입 vs 동일 페이지 non-AI 세션 전환율 비교.
//
// 3개 모드:
//   liveData (country-leaf 1국): GA4 라이브 페이지 split + 트렌드 + 단일 KPI.
//   rollupData (region/HQ N국):  국가별 KPI 표 + 가중 합산 KPI + 커버리지.
//                                트렌드/페이지 split 숨김 (국가 간 site 경로
//                                다르므로 합치면 의미 없음).
//   둘 다 없음: sample fixture + dimension filter signal로 perturb.

export function ConversionView({
  lockedGroups = [],
  scope,
  catalogRows,
  geographyOptions,
  liveData,
  rollupData,
  visitsTrend,
  periodDays = 90,
  emptyState,
}: {
  lockedGroups?: DimensionGroup[];
  scope?: import("@/lib/auth/types").AllowedScope;
  catalogRows?: import("@/components/dash/dimension-filter-panel").CatalogTaxonomyRow[];
  geographyOptions?: string[];
  liveData?: ConversionLive | null;
  rollupData?: AiTrafficConversionRollup | null;
  // GA4 measurement window (days) the numbers cover — drives the period label
  // + selector. The server has already fetched for this window.
  periodDays?: number;
  // 방문 수 일별 시리즈 (AI 유입 sessions). Provided in country-leaf live mode
  // so the conversion-rate trend chart overlays visit volume on a right axis —
  // the two share the date dimension. Sections stay separate; only the trend
  // is merged (per 2026-06-25 request).
  visitsTrend?: AiVisitsTrendPoint[];
  // Rendered IN PLACE of the KPI/trend/table body (filter panel stays) when a
  // mapped property returned no live data. Pages pass this only when they have a
  // real property — so the demo sample fixture never shows on a measured market.
  emptyState?: React.ReactNode;
}) {
  const t = useTranslations("aiFunnelView.conversion");

  // Dimension filters perturb the fixtures via the deterministic signal
  // (use-filter-signal). Rates scale; lift is recomputed. No filter → baseline.
  // Live mode bypasses the signal — GA4 numbers are already real.
  const sig = useFilterSignal();
  const pages = useMemo(() => {
    if (liveData) return liveData.pages;
    return SAMPLE_CONVERSION_PAGES.map((p) => {
      const aiConvRate = Number(sig.scale(p.aiConvRate, p.url + "ai").toFixed(1));
      const humanConvRate = Number(sig.scale(p.humanConvRate, p.url + "hu").toFixed(1));
      return {
        ...p,
        aiUsers: sig.scaleInt(p.aiUsers, p.url + "au"),
        humanUsers: sig.scaleInt(p.humanUsers, p.url + "hu"),
        aiConvRate,
        humanConvRate,
        lift: Number((aiConvRate - humanConvRate).toFixed(1)),
      };
    });
  }, [sig, liveData]);
  const summary = useMemo(() => {
    if (liveData) return liveData.summary;
    const aiConvRate = Number(sig.scale(SAMPLE_CONVERSION_SUMMARY.aiConvRate, "s.ai").toFixed(1));
    const humanConvRate = Number(sig.scale(SAMPLE_CONVERSION_SUMMARY.humanConvRate, "s.hu").toFixed(1));
    const aiUsersTotal = sig.scaleInt(SAMPLE_CONVERSION_SUMMARY.aiUsersTotal, "s.aut");
    const humanUsersTotal = sig.scaleInt(SAMPLE_CONVERSION_SUMMARY.humanUsersTotal, "s.hut");
    return {
      aiConvRate,
      humanConvRate,
      lift: Number((aiConvRate - humanConvRate).toFixed(1)),
      aiUsersTotal,
      humanUsersTotal,
      // Derive numerator (key events) from rate × users so the sample card can
      // show 분자/분모 like live mode. Consistent since rate = events ÷ users.
      aiKeyEvents: Math.round((aiConvRate / 100) * aiUsersTotal),
      humanKeyEvents: Math.round((humanConvRate / 100) * humanUsersTotal),
    };
  }, [sig, liveData]);
  const trend = useMemo(() => {
    if (liveData) return liveData.trend;
    return SAMPLE_CONVERSION_TREND.map((pt) => ({
      ...pt,
      ai: Number(sig.scale(pt.ai, "Tai" + pt.date).toFixed(1)),
      human: Number(sig.scale(pt.human, "Thu" + pt.date).toFixed(1)),
    }));
  }, [sig, liveData]);
  // Overlay 방문 수(sessions) on the same date axis when provided (live mode).
  // Left axis = 전환율(%), right axis = 방문 수(회).
  const hasVisitsTrend = !!(visitsTrend && visitsTrend.length);
  const mergedTrend = useMemo(() => {
    if (!hasVisitsTrend) return trend;
    const byDate = new Map(visitsTrend!.map((p) => [p.date, p.sessions]));
    return trend.map((p) => ({ ...p, sessions: byDate.get(p.date) ?? 0 }));
  }, [trend, visitsTrend, hasVisitsTrend]);
  const byEngine: EngineBreakdownRow[] = useMemo(() => {
    if (liveData) return liveData.byEngine;
    return SAMPLE_ENGINE_BREAKDOWN.map((e) => {
      const convRate = Number(sig.scale(e.convRate, e.engine + "eng").toFixed(1));
      const users = sig.scaleInt(e.users, e.engine + "engu");
      return {
        ...e,
        users,
        keyEvents: Math.round((convRate / 100) * users),
        convRate,
      };
    });
  }, [sig, liveData]);

  const { sorted: pagesSorted, headerProps } = useSortableTable<ConversionPageRow, ConversionSortKey>(
    pages,
    {
      url: (p) => p.url,
      aiUsers: (p) => p.aiUsers,
      humanUsers: (p) => p.humanUsers,
      aiRate: (p) => p.aiConvRate,
      humanRate: (p) => p.humanConvRate,
      lift: (p) => p.lift,
    },
    { defaultKey: "lift", defaultAsc: false, ascByDefault: ["url"] },
  );

  // Region/HQ rollup mode — KPI cards over the weighted aggregate, a
  // measurement-coverage strip, and the country table in place of the
  // per-page split. Trend chart is hidden: a multi-property trend would
  // mix sites that don't share URL paths.
  if (rollupData) {
    return (
      <div className="flex flex-col gap-6">
        <DimensionFilterPanel
          stage="conversion"
          onlyGroups={CONVERSION_GROUPS}
          lockedGroups={lockedGroups}
          scope={scope}
          catalogRows={catalogRows}
          geographyOptions={geographyOptions}
          basis={<ConversionPeriodSelect current={periodDays} />}
          sticky
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <RateCard
            icon={Sparkles}
            label={t("kpi.ai")}
            value={fmtRate(rollupData.aiConvRate)}
            hint={t("kpi.frac", {
              events: rollupData.totalAiKeyEvents.toLocaleString(),
              users: rollupData.totalAiUsers.toLocaleString(),
            })}
            color="text-brand-700"
          />
          <RateCard
            icon={Users}
            label={t("kpi.human")}
            value={fmtRate(rollupData.humanConvRate)}
            hint={t("kpi.frac", {
              events: rollupData.totalHumanKeyEvents.toLocaleString(),
              users: rollupData.totalHumanUsers.toLocaleString(),
            })}
            color="text-muted-foreground"
          />
          <RateCard
            icon={TrendingUp}
            label={t("kpi.lift")}
            value={fmtLift(rollupData.lift)}
            hint={t("kpi.liftHint")}
            color={liftColor(rollupData.lift)}
          />
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-[12px] text-muted-foreground">
          {t("coverage", {
            measured: rollupData.measuredMarkets,
            total: rollupData.totalMarkets,
          })}
        </div>
        <CountryConversionTable
          rows={rollupData.byCountry}
          activeBrand={
            scope && !scope.all && scope.brands?.length === 1 ? scope.brands[0] : null
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <DimensionFilterPanel
        stage="conversion"
        onlyGroups={CONVERSION_GROUPS}
        lockedGroups={lockedGroups}
        scope={scope}
        catalogRows={catalogRows}
        geographyOptions={geographyOptions}
        basis={<ConversionPeriodSelect current={periodDays} />}
        sticky
      />

      {!liveData && emptyState ? (
        emptyState
      ) : (
      <>
      <TooltipProvider delayDuration={200}>
      <div className="grid gap-3 sm:grid-cols-3">
        <RateCard
          icon={Sparkles}
          label={t("kpi.ai")}
          value={fmtRate(summary.aiConvRate)}
          hint={t("kpi.frac", {
            events: summary.aiKeyEvents.toLocaleString(),
            users: summary.aiUsersTotal.toLocaleString(),
          })}
          color="text-brand-700"
          infoContent={t("kpi.aiRateNote")}
        />
        <RateCard
          icon={Users}
          label={t("kpi.human")}
          value={fmtRate(summary.humanConvRate)}
          hint={t("kpi.frac", {
            events: summary.humanKeyEvents.toLocaleString(),
            users: summary.humanUsersTotal.toLocaleString(),
          })}
          color="text-muted-foreground"
        />
        <RateCard
          icon={TrendingUp}
          label={t("kpi.lift")}
          value={fmtLift(summary.lift)}
          hint={t("kpi.liftHint")}
          color={liftColor(summary.lift)}
        />
      </div>
      </TooltipProvider>

      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">
            {t("trend.title")}
          </h3>
          <p className="text-[11px] text-muted-foreground">{t("trend.hint")}</p>
        </div>
        <div className="h-64 min-w-0 p-3">
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 640, height: 256 }}
          >
            <ComposedChart
              data={mergedTrend}
              margin={{ left: -16, right: hasVisitsTrend ? -8 : 8, top: 4, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" />
              <YAxis
                yAxisId="rate"
                tick={{ fontSize: 11 }}
                stroke="rgba(0,0,0,0.4)"
                unit="%"
              />
              {hasVisitsTrend ? (
                <YAxis
                  yAxisId="visits"
                  orientation="right"
                  tick={{ fontSize: 11 }}
                  stroke="rgba(0,0,0,0.25)"
                  allowDecimals={false}
                />
              ) : null}
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemSorter={(item) => -Number(item.value ?? 0)} wrapperStyle={{ zIndex: 50 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {/* 일별 AI 유입 규모(방문 수) — 배경 막대. 표본이 적은 날은 막대가
                  낮아, 그 위에 겹쳐진 전환율 선이 왜 튀는지 한눈에 보인다. */}
              {hasVisitsTrend ? (
                <Bar
                  yAxisId="visits"
                  dataKey="sessions"
                  name={t("trend.visitsLabel")}
                  fill="#8aa0b6"
                  fillOpacity={0.35}
                  barSize={10}
                  radius={[2, 2, 0, 0]}
                />
              ) : null}
              <Line
                yAxisId="rate"
                type="monotone"
                dataKey="ai"
                name={t("trend.aiLabel")}
                stroke="var(--color-brand-700)"
                strokeWidth={2}
                dot={{ r: 2.5 }}
              />
              <Line
                yAxisId="rate"
                type="monotone"
                dataKey="human"
                name={t("trend.humanLabel")}
                stroke="var(--color-accent-gold)"
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={{ r: 2.5 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <EngineBreakdownCard rows={byEngine} />

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">
            {t("table.title")}
          </h3>
          <p className="text-[11px] text-muted-foreground">{t("table.hint")}</p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              <th className="px-3 py-2"><SortableHeader {...headerProps("url")}>{t("table.col.url")}</SortableHeader></th>
              <th className="px-3 py-2"><SortableHeader {...headerProps("aiUsers")} align="right">{t("table.col.aiUsers")}</SortableHeader></th>
              <th className="px-3 py-2"><SortableHeader {...headerProps("humanUsers")} align="right">{t("table.col.humanUsers")}</SortableHeader></th>
              <th className="px-3 py-2"><SortableHeader {...headerProps("aiRate")} align="right">{t("table.col.aiRate")}</SortableHeader></th>
              <th className="px-3 py-2"><SortableHeader {...headerProps("humanRate")} align="right">{t("table.col.humanRate")}</SortableHeader></th>
              <th className="px-3 py-2"><SortableHeader {...headerProps("lift")} align="right">{t("table.col.lift")}</SortableHeader></th>
            </tr>
          </thead>
          <tbody>
            {pagesSorted.map((p) => (
              <tr key={p.url} className="border-t border-border first:border-t-0">
                <td className="px-3 py-2 text-foreground">{p.url}</td>
                <td className="px-3 py-2 text-right text-foreground">
                  {p.aiUsers.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {p.humanUsers.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right font-medium text-foreground">
                  {fmtRate(p.aiConvRate)}
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">
                  {fmtRate(p.humanConvRate)}
                </td>
                <td
                  className={cn(
                    "px-3 py-2 text-right font-semibold",
                    p.lift != null && p.lift > 0
                      ? "text-emerald-600"
                      : p.lift != null && p.lift < 0
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {p.lift == null ? "—" : `${p.lift > 0 ? "+" : ""}${p.lift.toFixed(1)}pp`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}
    </div>
  );
}

function RateCard({
  icon: Icon,
  label,
  value,
  hint,
  color,
  infoContent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint: string;
  color: string;
  // Hover explainer for a metric that isn't self-evident (e.g. AI rate can
  // exceed 100% — keyEvents is an event count, not a per-user boolean).
  infoContent?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Icon className={cn("h-4 w-4", color)} aria-hidden />
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        {infoContent ? (
          <InfoTooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
              >
                <Info className="h-3 w-3" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-64 text-left text-pretty">
              <p className="text-xs text-background">{infoContent}</p>
            </TooltipContent>
          </InfoTooltip>
        ) : null}
      </div>
      <span className={cn("font-head text-2xl font-semibold tracking-tight tabular-nums", color)}>
        {value}
      </span>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </div>
  );
}

// AI 모델(엔진)별 요약 — 선택 기간 전체 합산. 표본(유입자 수)이 임계치 미만이면
// "표본 적음" 배지를 달아, 그 엔진의 전환율을 곧이곧대로 읽지 말라고 알려준다.
function EngineBreakdownCard({ rows }: { rows: EngineBreakdownRow[] }) {
  const t = useTranslations("aiFunnelView.conversion.engineBreakdown");
  if (rows.length === 0) return null;
  // 전환율은 이미 0~100% 척도 → 절대 기준(100)으로 그린다. 40%는 트랙의 40%.
  // (최댓값 정규화로 그리면 40%가 트랙 전체를 채워 100%처럼 보이는 오해가 생김.)
  // 활성사용자는 순수 카운트라 값 비교가 목적 → 최댓값 기준 상대 막대 유지.
  const maxUsers = Math.max(...rows.map((r) => r.users), 1);
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-semibold tracking-tight text-foreground">{t("title")}</h3>
      <p className="text-[11px] text-muted-foreground">{t("hint")}</p>
      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        <EngineBarGroup
          label={t("col.rate")}
          rows={rows}
          max={100}
          barClassName="bg-brand-700"
          value={(r) => r.convRate ?? 0}
          format={(r) => fmtRate(r.convRate)}
        />
        <EngineBarGroup
          label={t("col.users")}
          rows={rows}
          max={maxUsers}
          barClassName="bg-accent-gold"
          value={(r) => r.users}
          format={(r) => r.users.toLocaleString()}
        />
      </div>
    </div>
  );
}

function EngineBarGroup({
  label,
  rows,
  max,
  barClassName,
  value,
  format,
}: {
  label: string;
  rows: EngineBreakdownRow[];
  max: number;
  barClassName: string;
  value: (row: EngineBreakdownRow) => number;
  format: (row: EngineBreakdownRow) => string;
}) {
  const t = useTranslations("aiFunnelView.conversion.engineBreakdown");
  // 배지가 flex 행에서 폭을 차지하면 배지 있는 행(표본 적음)만 트랙(flex-1)이
  // 좁아져, 같은 값이라도 막대 길이가 행마다 달라진다. 그룹에 배지가 하나라도
  // 있으면 모든 행에 동일 폭의 배지 슬롯을 예약해 트랙 폭을 맞춘다 → 최댓값
  // 막대가 항상 트랙 끝까지 그려진다.
  const anyLowSample = rows.some((r) => r.users < LOW_SAMPLE_USERS);
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => {
          const lowSample = r.users < LOW_SAMPLE_USERS;
          return (
            <li key={r.engine} className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-[11px] text-foreground">
                {ENGINE_LABEL[r.engine] ?? r.engine}
              </span>
              <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("absolute top-0 left-0 h-full rounded-full", barClassName)}
                  style={{ width: `${(value(r) / max) * 100}%` }}
                  aria-hidden
                />
              </div>
              <span className="w-16 shrink-0 text-right text-[11px] font-semibold tabular-nums text-foreground">
                {format(r)}
              </span>
              {anyLowSample ? (
                <span className="w-[4.5rem] shrink-0">
                  {lowSample ? (
                    <Badge variant="outline" className="h-5 border-amber-300 text-[10px] text-amber-700">
                      {t("lowSample")}
                    </Badge>
                  ) : null}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
