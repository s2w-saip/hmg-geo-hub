"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ZAxis,
  ReferenceLine,
} from "recharts";
import { Star, AlertTriangle, Search, Skull } from "lucide-react";
import {
  ALL_GROUPS_EXCEPT_LANGUAGE,
  DimensionFilterPanel,
  type DimensionGroup,
} from "@/components/dash/dimension-filter-panel";
import { useFilterSignal } from "@/components/dash/use-filter-signal";
import { cn } from "@/lib/utils";
import { CHART_TOOLTIP_STYLE } from "@/lib/viz/chart-tooltip";
import { useSortableTable } from "@/hooks/use-sortable-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  SAMPLE_VISIBILITY_PAGES,
  SAMPLE_VISIBILITY_QUADRANT_COUNTS,
  type VisibilityPage,
} from "../_data/sample";

type VisibilitySortKey = "url" | "seo" | "ai" | "quadrant" | "priority";

// 표준 + Project 공통 view — AI Visibility (4분면 진단).
// Q1=분위수 기반. 임계값은 데이터셋 중앙값 기준으로 동적 계산.

export function VisibilityView({
  lockedGroups = [],
  scope,
  catalogRows,
  geographyOptions,
}: {
  lockedGroups?: DimensionGroup[];
  scope?: import("@/lib/auth/types").AllowedScope;
  catalogRows?: import("@/components/dash/dimension-filter-panel").CatalogTaxonomyRow[];
  geographyOptions?: string[];
}) {
  const t = useTranslations("aiFunnelView.visibility");
  const tQuadrant = useTranslations("aiFunnelView.visibility.quadrant");

  // Dimension filters perturb the fixtures via the deterministic signal
  // (use-filter-signal). No filter → exact baseline.
  const sig = useFilterSignal();
  const pages = useMemo<VisibilityPage[]>(
    () =>
      SAMPLE_VISIBILITY_PAGES.map((p) => ({
        ...p,
        seoImpressions: sig.scaleInt(p.seoImpressions, p.url + "s"),
        aiCrawls: sig.scaleInt(p.aiCrawls, p.url + "a"),
      })),
    [sig],
  );
  const quadrantCounts = useMemo(
    () => ({
      star: sig.scaleInt(SAMPLE_VISIBILITY_QUADRANT_COUNTS.star, "q.star"),
      aiGap: sig.scaleInt(SAMPLE_VISIBILITY_QUADRANT_COUNTS.aiGap, "q.aiGap"),
      seoGap: sig.scaleInt(SAMPLE_VISIBILITY_QUADRANT_COUNTS.seoGap, "q.seoGap"),
      deadZone: sig.scaleInt(SAMPLE_VISIBILITY_QUADRANT_COUNTS.deadZone, "q.deadZone"),
    }),
    [sig],
  );

  // Default sort: priority asc (1=high first), then table is operator-driven.
  const { sorted: sortedPages, headerProps } = useSortableTable<
    VisibilityPage,
    VisibilitySortKey
  >(
    pages,
    {
      url: (p) => p.url,
      seo: (p) => p.seoImpressions,
      ai: (p) => p.aiCrawls,
      quadrant: (p) => p.quadrant,
      priority: (p) => p.priority,
    },
    { defaultKey: "priority", defaultAsc: true, ascByDefault: ["url", "quadrant", "priority"] },
  );

  // 분위수 임계 — 중앙값으로 4분면 분할
  const seoMedian = [...pages]
    .map((p) => p.seoImpressions)
    .sort((a, b) => a - b)[Math.floor(pages.length / 2)];
  const aiMedian = [...pages]
    .map((p) => p.aiCrawls)
    .sort((a, b) => a - b)[Math.floor(pages.length / 2)];

  return (
    <div className="flex flex-col gap-6">
      {/* language 축 제외 (2026-09-03): 이 화면은 SAMPLE_VISIBILITY_PAGES 픽스처를
          useFilterSignal 로 흔들 뿐 DB 를 전혀 읽지 않는다 — filters.lang 이 좁힐
          데이터가 없다. 종전에는 onlyGroups 미지정이라 language 가 정적 폴백
          (en/ko/fr, 스코프 무관)으로 노출됐다. 실옵션을 주입해도 "실제 언어 목록
          위에 가짜 수치"가 되어 더 나쁘므로 축 자체를 내린다. 실데이터 화면이
          되면 그때 다시 켤 것 — 술어는 이미 표준 경로에 있다(promptAxisPreds). */}
      <DimensionFilterPanel
        stage="visibility"
        lockedGroups={lockedGroups}
        onlyGroups={ALL_GROUPS_EXCEPT_LANGUAGE}
        scope={scope}
        catalogRows={catalogRows}
        geographyOptions={geographyOptions}
        sticky
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <QuadrantCard
          icon={Star}
          label={tQuadrant("star")}
          hint={tQuadrant("starHint")}
          count={quadrantCounts.star}
          color="text-emerald-600"
        />
        <QuadrantCard
          icon={Search}
          label={tQuadrant("aiGap")}
          hint={tQuadrant("aiGapHint")}
          count={quadrantCounts.aiGap}
          color="text-amber-600"
        />
        <QuadrantCard
          icon={AlertTriangle}
          label={tQuadrant("seoGap")}
          hint={tQuadrant("seoGapHint")}
          count={quadrantCounts.seoGap}
          color="text-orange-600"
        />
        <QuadrantCard
          icon={Skull}
          label={tQuadrant("deadZone")}
          hint={tQuadrant("deadZoneHint")}
          count={quadrantCounts.deadZone}
          color="text-destructive"
        />
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">
            {t("scatter.title")}
          </h3>
          <p className="text-[11px] text-muted-foreground">
            {t("scatter.hint")}
          </p>
        </div>
        <div className="h-72 min-w-0 p-3">
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 640, height: 288 }}
          >
            <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis
                type="number"
                dataKey="seoImpressions"
                name={t("scatter.x")}
                tick={{ fontSize: 11 }}
                stroke="rgba(0,0,0,0.4)"
              />
              <YAxis
                type="number"
                dataKey="aiCrawls"
                name={t("scatter.y")}
                tick={{ fontSize: 11 }}
                stroke="rgba(0,0,0,0.4)"
              />
              <ZAxis range={[80, 200]} />
              <ReferenceLine
                x={seoMedian}
                stroke="rgba(0,0,0,0.25)"
                strokeDasharray="4 4"
                label={{ value: t("scatter.medianX"), fontSize: 10, fill: "rgba(0,0,0,0.5)" }}
              />
              <ReferenceLine
                y={aiMedian}
                stroke="rgba(0,0,0,0.25)"
                strokeDasharray="4 4"
                label={{ value: t("scatter.medianY"), fontSize: 10, fill: "rgba(0,0,0,0.5)" }}
              />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                contentStyle={CHART_TOOLTIP_STYLE} itemSorter={(item) => -Number(item.value ?? 0)} wrapperStyle={{ zIndex: 50 }}
              />
              <Scatter
                name={t("scatter.pages")}
                data={pages}
                fill="var(--color-brand-700)"
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">
            {t("table.title")}
          </h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              <th className="px-3 py-2">
                <SortableHeader {...headerProps("url")}>{t("table.col.url")}</SortableHeader>
              </th>
              <th className="px-3 py-2">
                <SortableHeader {...headerProps("seo")} align="right">{t("table.col.seo")}</SortableHeader>
              </th>
              <th className="px-3 py-2">
                <SortableHeader {...headerProps("ai")} align="right">{t("table.col.ai")}</SortableHeader>
              </th>
              <th className="px-3 py-2">
                <SortableHeader {...headerProps("quadrant")}>{t("table.col.quadrant")}</SortableHeader>
              </th>
              <th className="px-3 py-2">
                <SortableHeader {...headerProps("priority")} align="right">{t("table.col.priority")}</SortableHeader>
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedPages.map((p) => (
              <tr key={p.url} className="border-t border-border first:border-t-0">
                <td className="px-3 py-2 text-foreground">{p.url}</td>
                <td className="px-3 py-2 text-right text-foreground">
                  {p.seoImpressions.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right text-foreground">
                  {p.aiCrawls.toLocaleString()}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={cn(
                      "rounded px-2 py-0.5 text-[10px] font-semibold uppercase",
                      p.quadrant === "star" && "bg-emerald-100 text-emerald-700",
                      p.quadrant === "aiGap" && "bg-amber-100 text-amber-700",
                      p.quadrant === "seoGap" && "bg-orange-100 text-orange-700",
                      p.quadrant === "deadZone" && "bg-destructive/10 text-destructive",
                    )}
                  >
                    {tQuadrant(p.quadrant)}
                  </span>
                </td>
                <td className="px-3 py-2 text-center">
                  <span
                    className={cn(
                      "inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold",
                      p.priority === 1 && "bg-destructive/10 text-destructive",
                      p.priority === 2 && "bg-amber-100 text-amber-700",
                      p.priority === 3 && "bg-muted text-muted-foreground",
                    )}
                  >
                    {p.priority}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function QuadrantCard({
  icon: Icon,
  label,
  hint,
  count,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  count: number;
  color: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Icon className={cn("h-4 w-4", color)} aria-hidden />
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
      </div>
      <span className={cn("font-head text-2xl font-semibold tracking-tight tabular-nums", color)}>
        {count}
      </span>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </div>
  );
}
