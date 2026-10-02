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
import { Trophy, Hash, BarChart3, Swords, ArrowRightLeft } from "lucide-react";
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
  SAMPLE_ACR_BRANDS,
  SAMPLE_ACR_TREND,
  SAMPLE_ACR_BATTLE,
  SAMPLE_ACR_MODEL_CONVERSION,
  SAMPLE_ACR_BATTLE_SHEETS,
  BATTLE_BRAND_COLORS,
  type GridBrand,
} from "../_data/sample";

type ConvSortKey = "brand" | "model" | "conv" | "shortlist" | "top1";

// 표준 + Project 공통 view — ACR (AI Choice Rate).
// Q2=Top1 + Top5 동시 표시. 답변 분석 #1 백로그(brand_mentions)와 공동 의존.

export function AcrView({
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
  const t = useTranslations("aiFunnelView.acr");

  // Dimension filters perturb the fixtures via the deterministic signal
  // (use-filter-signal). No filter → exact baseline.
  const sig = useFilterSignal();
  const acrBrands = useMemo(
    () =>
      SAMPLE_ACR_BRANDS.map((b) => ({
        ...b,
        top1Acr: Number(sig.shiftPct(b.top1Acr, b.brand + "1").toFixed(1)),
        top5Acr: Number(sig.shiftPct(b.top5Acr, b.brand + "5").toFixed(1)),
        answerCount: sig.scaleInt(b.answerCount, b.brand + "ans"),
        rank1Count: sig.scaleInt(b.rank1Count, b.brand + "r1"),
      })),
    [sig],
  );
  const modelConversion = useMemo(
    () =>
      SAMPLE_ACR_MODEL_CONVERSION.map((r) => ({
        ...r,
        conversionRate: Number(
          sig.shiftPct(r.conversionRate, r.brand + r.model + "cv").toFixed(1),
        ),
        shortlistCount: sig.scaleInt(r.shortlistCount, r.brand + r.model + "sl"),
        top1Count: sig.scaleInt(r.top1Count, r.brand + r.model + "t1"),
      })),
    [sig],
  );
  const acrTrend = useMemo(
    () =>
      SAMPLE_ACR_TREND.map((pt) => ({
        ...pt,
        Hyundai: sig.scaleInt(pt.Hyundai, "TH"),
        Toyota: sig.scaleInt(pt.Toyota, "TT"),
        Tesla: sig.scaleInt(pt.Tesla, "TS"),
      })),
    [sig],
  );

  const ours = acrBrands.find((b) => b.isOurs) ?? acrBrands[0];
  const ranked = [...acrBrands].sort((a, b) => b.top1Acr - a.top1Acr);

  // Battle grid pivot — prompts × models
  const prompts = Array.from(new Set(SAMPLE_ACR_BATTLE.map((b) => b.prompt)));
  const models = Array.from(new Set(SAMPLE_ACR_BATTLE.map((b) => b.model)));

  // Model conversion — default sort by conversionRate desc; operator can
  // re-sort by any column via the header trigger.
  const { sorted: convRanked, headerProps: convHeader } = useSortableTable<
    (typeof SAMPLE_ACR_MODEL_CONVERSION)[number],
    ConvSortKey
  >(
    modelConversion,
    {
      brand: (r) => r.brand,
      model: (r) => r.model,
      conv: (r) => r.conversionRate,
      shortlist: (r) => r.shortlistCount,
      top1: (r) => r.top1Count,
    },
    { defaultKey: "conv", defaultAsc: false, ascByDefault: ["brand", "model"] },
  );

  // Territory map — 활성 sheet (언어 × 모델)
  const [activeSheetId, setActiveSheetId] = useState(
    SAMPLE_ACR_BATTLE_SHEETS[0].id,
  );
  const activeSheet =
    SAMPLE_ACR_BATTLE_SHEETS.find((s) => s.id === activeSheetId) ??
    SAMPLE_ACR_BATTLE_SHEETS[0];

  return (
    <div className="flex flex-col gap-6">
      <DimensionFilterPanel
        stage="acr"
        lockedGroups={lockedGroups}
        scope={scope}
        catalogRows={catalogRows}
        geographyOptions={geographyOptions}
        sticky
      />

      {/* ACR brand pills */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t("pillsLabel")}
        </span>
        {ranked.map((b) => (
          <div
            key={b.brand}
            className={cn(
              "flex items-baseline gap-2 rounded-full border px-3 py-1",
              b.isOurs
                ? "border-brand-700 bg-brand-700/5"
                : "border-border bg-card",
            )}
          >
            <span
              className={cn(
                "text-xs font-semibold",
                b.isOurs ? "text-brand-700" : "text-foreground",
              )}
            >
              {b.brand}
            </span>
            <span className="text-[10px] text-muted-foreground">
              T1 {b.top1Acr.toFixed(1)}% · T5 {b.top5Acr.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>

      {/* KPI cards — 우리 브랜드 기준 */}
      <div className="grid gap-3 sm:grid-cols-4">
        <KpiCard
          icon={Trophy}
          label={t("kpi.top1")}
          value={`${ours.top1Acr.toFixed(1)}%`}
          hint={t("kpi.top1Hint")}
        />
        <KpiCard
          icon={Trophy}
          label={t("kpi.top5")}
          value={`${ours.top5Acr.toFixed(1)}%`}
          hint={t("kpi.top5Hint")}
        />
        <KpiCard
          icon={BarChart3}
          label={t("kpi.answers")}
          value={ours.answerCount.toLocaleString()}
          hint={t("kpi.answersHint")}
        />
        <KpiCard
          icon={Hash}
          label={t("kpi.rank1")}
          value={ours.rank1Count.toLocaleString()}
          hint={t("kpi.rank1Hint")}
        />
      </div>

      {/* Trend chart */}
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
            <LineChart
              data={acrTrend}
              margin={{ left: -16, right: 8, top: 4, bottom: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" />
              <YAxis tick={{ fontSize: 11 }} stroke="rgba(0,0,0,0.4)" />
              <Tooltip contentStyle={CHART_TOOLTIP_STYLE} itemSorter={(item) => -Number(item.value ?? 0)} wrapperStyle={{ zIndex: 50 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="Hyundai" stroke={BATTLE_BRAND_COLORS.Hyundai} strokeWidth={2} dot={{ r: 2.5 }} />
              <Line type="monotone" dataKey="Toyota" stroke={BATTLE_BRAND_COLORS.Toyota} strokeWidth={2} dot={{ r: 2.5 }} />
              <Line type="monotone" dataKey="Tesla" stroke={BATTLE_BRAND_COLORS.Tesla} strokeWidth={2} dot={{ r: 2.5 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Battle grid */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">
            {t("battle.title")}
          </h3>
          <p className="text-[11px] text-muted-foreground">{t("battle.hint")}</p>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              <th className="px-3 py-2">{t("battle.col.prompt")}</th>
              {models.map((m) => (
                <th key={m} className="px-3 py-2 text-center">
                  {m}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {prompts.map((prompt) => (
              <tr key={prompt} className="border-t border-border first:border-t-0">
                <td className="px-3 py-2 text-foreground">{prompt}</td>
                {models.map((m) => {
                  const cell = SAMPLE_ACR_BATTLE.find(
                    (b) => b.prompt === prompt && b.model === m,
                  );
                  const isOurs =
                    cell?.winner === "Hyundai" ||
                    cell?.winner === "Kia" ||
                    cell?.winner === "Genesis";
                  return (
                    <td key={m} className="px-3 py-2 text-center">
                      <span
                        className={cn(
                          "rounded px-2 py-0.5 text-[10px] font-semibold",
                          isOurs
                            ? "bg-brand-700/10 text-brand-700"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {cell?.winner ?? "—"}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Model conversion table — (브랜드 × 차종) shortlist→top1 전환율 */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <ArrowRightLeft className="h-4 w-4 text-muted-foreground" aria-hidden />
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              {t("modelConversion.title")}
            </h3>
            <p className="text-[11px] text-muted-foreground">
              {t("modelConversion.hint")}
            </p>
          </div>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              <th className="w-10 px-3 py-2 text-right">#</th>
              <th className="px-3 py-2"><SortableHeader {...convHeader("brand")}>{t("modelConversion.col.brand")}</SortableHeader></th>
              <th className="px-3 py-2"><SortableHeader {...convHeader("model")}>{t("modelConversion.col.model")}</SortableHeader></th>
              <th className="px-3 py-2"><SortableHeader {...convHeader("conv")} align="right">{t("modelConversion.col.conv")}</SortableHeader></th>
              <th className="px-3 py-2">{t("modelConversion.col.bar")}</th>
              <th className="px-3 py-2"><SortableHeader {...convHeader("shortlist")} align="right">{t("modelConversion.col.shortlist")}</SortableHeader></th>
              <th className="px-3 py-2"><SortableHeader {...convHeader("top1")} align="right">{t("modelConversion.col.top1")}</SortableHeader></th>
            </tr>
          </thead>
          <tbody>
            {convRanked.map((r, i) => (
              <tr
                key={`${r.brand}-${r.model}`}
                className={cn(
                  "border-t border-border first:border-t-0",
                  r.isOurs && "bg-brand-700/[0.04]",
                )}
              >
                <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                  {i + 1}
                </td>
                <td
                  className={cn(
                    "px-3 py-2.5 font-medium",
                    r.isOurs ? "text-brand-700" : "text-foreground",
                  )}
                >
                  {r.brand}
                </td>
                <td className="px-3 py-2.5 text-foreground">{r.model}</td>
                <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-foreground">
                  {r.conversionRate.toFixed(1)}%
                </td>
                <td className="px-3 py-2.5">
                  <div className="h-2 w-full max-w-[140px] overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        r.isOurs ? "bg-brand-700" : "bg-brand-300",
                      )}
                      style={{ width: `${Math.min(100, r.conversionRate)}%` }}
                      aria-hidden
                    />
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                  {r.shortlistCount.toLocaleString()}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                  {r.top1Count.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Territory map — 언어×모델 sheet별 승자 독식 맵 */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Swords className="h-4 w-4 text-muted-foreground" aria-hidden />
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              {t("territory.title")}
            </h3>
            <p className="text-[11px] text-muted-foreground">
              {t("territory.hint")}
            </p>
          </div>
        </div>

        {/* Sheet tabs (언어 × 모델) */}
        <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2">
          {SAMPLE_ACR_BATTLE_SHEETS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveSheetId(s.id)}
              className={cn(
                "rounded-full border px-3 py-1 text-[11px] font-semibold transition-colors",
                s.id === activeSheet.id
                  ? "border-brand-700 bg-brand-700/5 text-brand-700"
                  : "border-border bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              {s.lang} · {s.model}
            </button>
          ))}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2 text-[10px] text-muted-foreground">
          {Object.entries(BATTLE_BRAND_COLORS).map(([brand, color]) => (
            <span key={brand} className="inline-flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 rounded-[2px]"
                style={{ backgroundColor: color }}
                aria-hidden
              />
              {brand}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" aria-hidden />
            {t("territory.noChoice")}
          </span>
        </div>

        {/* Grid */}
        <div className="overflow-x-auto px-4 py-3">
          <table className="text-sm">
            <thead>
              <tr className="text-left text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                <th className="px-2 py-1">{t("battle.col.prompt")}</th>
                <th className="px-2 py-1 text-center" colSpan={10}>
                  {t("territory.iterations")}
                </th>
                <th className="px-2 py-1">{t("territory.dominant")}</th>
              </tr>
            </thead>
            <tbody>
              {activeSheet.prompts.map((prompt, pi) => {
                const row = activeSheet.cells[pi];
                const dom = dominantOf(row);
                return (
                  <tr key={prompt}>
                    <td className="px-2 py-1 whitespace-nowrap text-foreground">
                      {prompt}
                    </td>
                    {row.map((cell, ci) => (
                      <td key={ci} className="px-0.5 py-1 text-center">
                        {cell ? (
                          <span
                            className="inline-block h-4 w-4 rounded-[2px] align-middle"
                            style={{ backgroundColor: BATTLE_BRAND_COLORS[cell] ?? "var(--color-ink-300)" }}
                            title={cell}
                            aria-label={cell}
                          />
                        ) : (
                          <span
                            className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/30 align-middle"
                            aria-label="NoChoice"
                          />
                        )}
                      </td>
                    ))}
                    <td className="px-2 py-1 whitespace-nowrap">
                      {dom ? (
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
                          <span
                            className="h-2.5 w-2.5 rounded-[2px]"
                            style={{ backgroundColor: BATTLE_BRAND_COLORS[dom.brand] ?? "var(--color-ink-300)" }}
                            aria-hidden
                          />
                          {dom.brand} {dom.count}
                        </span>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// 행의 셀에서 최빈 브랜드(NoChoice 제외) 산출 — 동점 시 먼저 등장한 브랜드 우선.
function dominantOf(cells: GridBrand[]): { brand: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const c of cells) {
    if (!c) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best: { brand: string; count: number } | null = null;
  for (const [brand, count] of counts) {
    if (!best || count > best.count) best = { brand, count };
  }
  return best;
}

function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-brand-700" aria-hidden />
        <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
      </div>
      <span className="font-head text-2xl font-semibold tracking-tight tabular-nums text-foreground">
        {value}
      </span>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </div>
  );
}
